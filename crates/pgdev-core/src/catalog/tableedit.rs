use super::{ident, not_found, qualified};
use crate::{
    CoreError, Database, TableEditLockKind, TableEditRequest, TableEditResponse, TableEditState,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn fingerprint(state: &TableEditState) -> String {
    let mut parts = vec![
        state.oid.clone(),
        state.schema.clone(),
        state.name.clone(),
        state.relkind.clone(),
        state.description.clone().unwrap_or_default(),
    ];
    for c in &state.columns {
        let labels = c
            .uks
            .as_ref()
            .map(|keys| {
                keys.iter()
                    .map(|k| k.label.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let lock = match c.lock_kind {
            Some(TableEditLockKind::Identity) => "identity",
            Some(TableEditLockKind::Generated) => "generated",
            Some(TableEditLockKind::Serial) => "serial",
            None => "",
        };
        parts.push(
            [
                c.id.as_str(),
                c.name.as_str(),
                c.data_type.as_str(),
                if c.nullable { "1" } else { "0" },
                c.default_value.as_deref().unwrap_or(""),
                c.description.as_deref().unwrap_or(""),
                if c.pk { "1" } else { "0" },
                labels.as_str(),
                if c.locked { "1" } else { "0" },
                lock,
            ]
            .join("\u{1}"),
        );
    }
    format!("{:x}", Sha256::digest(parts.join("\0").as_bytes()))
}

/// Preserve literals, quoted names, dollar bodies and comments byte-for-byte.
/// Only whitespace outside those regions is normalized for comparison.
fn normalize(expression: Option<&str>) -> String {
    let sql = expression.unwrap_or("");
    let mut out = String::new();
    let mut at = 0;
    while at < sql.len() {
        let ch = sql[at..].chars().next().unwrap();
        if ch.is_whitespace() {
            while at < sql.len() && sql[at..].chars().next().is_some_and(char::is_whitespace) {
                at += sql[at..].chars().next().unwrap().len_utf8();
            }
            out.push(' ');
        } else {
            let (mut next, _) = crate::sql::token(sql, at, true);
            if sql[at..].starts_with("--") && sql.as_bytes().get(next) == Some(&b'\n') {
                next += 1;
            }
            out.push_str(&sql[at..next]);
            at = next;
        }
    }
    out.trim().to_owned()
}
fn description(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.trim().is_empty())
}
fn literal(value: Option<&str>) -> String {
    value
        .map(|v| format!("'{}'", v.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".into())
}
fn invalid(message: impl Into<String>) -> CoreError {
    let mut e = CoreError::local(message);
    e.code = Some("INVALID_TABLE_EDIT".into());
    e
}
fn conflict() -> CoreError {
    let mut e = CoreError::local(
        "This table changed on the server since the editor loaded — close and reopen it",
    );
    e.code = Some("TABLE_CHANGED".into());
    e
}

fn rename_steps(
    mut pending: Vec<(String, String)>,
    mut taken: HashSet<String>,
) -> Vec<(String, String)> {
    pending.retain(|(from, to)| from != to);
    let mut steps = Vec::new();
    let mut counter = 0;
    while !pending.is_empty() {
        if let Some(index) = pending.iter().position(|(_, to)| !taken.contains(to)) {
            let (from, to) = pending.remove(index);
            taken.remove(&from);
            taken.insert(to.clone());
            steps.push((from, to));
        } else {
            let (from, to) = pending.remove(0);
            let temp = loop {
                counter += 1;
                let temp = format!("pgdev_rename_{counter}");
                if !taken.contains(&temp) {
                    break temp;
                }
            };
            taken.remove(&from);
            taken.insert(temp.clone());
            steps.push((from, temp.clone()));
            pending.push((temp, to));
        }
    }
    steps
}

fn diff(state: &TableEditState, request: &TableEditRequest) -> Result<Option<String>, CoreError> {
    if request.fingerprint != state.fingerprint {
        return Err(conflict());
    }
    if request.columns.len() > 1000
        || request.description.as_ref().is_some_and(|v| v.len() > 5000)
        || request.fingerprint.is_empty()
        || request.fingerprint.len() > 128
    {
        return Err(invalid("Invalid table edit request"));
    }
    let table = qualified(&state.schema, &state.name);
    let mut statements = Vec::new();
    let live: HashMap<_, _> = state.columns.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut edits = HashMap::new();
    let mut names = HashSet::new();
    for c in &request.columns {
        if c.id.is_empty()
            || c.id.len() > 255
            || c.name.len() > 255
            || c.data_type.len() > 2000
            || c.default_value.as_ref().is_some_and(|v| v.len() > 5000)
            || c.description.as_ref().is_some_and(|v| v.len() > 5000)
        {
            return Err(invalid("Invalid column row"));
        }
        if edits.insert(c.id.as_str(), c).is_some() {
            return Err(invalid(format!("Duplicate column \"{}\"", c.id)));
        }
        let name = c.name.trim();
        if name.is_empty() {
            return Err(invalid("Every column needs a name"));
        }
        if c.added == Some(true) {
            if live.contains_key(c.id.as_str()) {
                return Err(invalid(format!(
                    "Column \"{name}\" already exists — edit its existing row instead"
                )));
            }
        } else if !live.contains_key(c.id.as_str()) {
            return Err(invalid(
                "A column no longer matches the table — please reload",
            ));
        }
        if !names.insert(name) {
            return Err(invalid(format!(
                "Column name \"{name}\" is used more than once"
            )));
        }
    }
    for c in &state.columns {
        if edits.contains_key(c.id.as_str()) {
            continue;
        }
        if c.pk {
            return Err(invalid(format!(
                "Column \"{}\" is part of the primary key and cannot be dropped",
                c.name
            )));
        }
        statements.push(format!(
            "ALTER TABLE {table}\n  DROP COLUMN {}",
            ident(&c.name)
        ));
    }
    let kept = state
        .columns
        .iter()
        .filter(|c| edits.contains_key(c.id.as_str()))
        .map(|c| c.name.clone())
        .collect();
    let renames = state
        .columns
        .iter()
        .filter_map(|c| {
            edits
                .get(c.id.as_str())
                .map(|e| (c.name.clone(), e.name.trim().to_owned()))
        })
        .collect();
    for (from, to) in rename_steps(renames, kept) {
        statements.push(format!(
            "ALTER TABLE {table}\n  RENAME COLUMN {} TO {}",
            ident(&from),
            ident(&to)
        ));
    }
    for c in &state.columns {
        let Some(e) = edits.get(c.id.as_str()) else {
            continue;
        };
        let type_changed = normalize(Some(&e.data_type)) != normalize(Some(&c.data_type));
        let default_changed =
            normalize(e.default_value.as_deref()) != normalize(c.default_value.as_deref());
        if c.locked
            && (type_changed
                || default_changed
                || (c.lock_kind != Some(TableEditLockKind::Serial) && c.nullable != e.nullable))
        {
            return Err(invalid(format!("Column \"{}\" is an identity/generated/serial column — its type, default and nullability cannot be changed here",c.name)));
        }
        if c.pk && e.nullable {
            return Err(invalid(format!(
                "Column \"{}\" is part of the primary key and must remain NOT NULL",
                c.name
            )));
        }
        let name = ident(e.name.trim());
        if !c.locked && type_changed {
            let data_type = e.data_type.trim();
            if data_type.is_empty() {
                return Err(invalid(format!("Column \"{}\" needs a type", c.name)));
            }
            statements.push(format!(
                "ALTER TABLE {table}\n  ALTER COLUMN {name} TYPE {data_type}"
            ));
        }
        if c.nullable != e.nullable {
            statements.push(format!(
                "ALTER TABLE {table}\n  ALTER COLUMN {name} {} NOT NULL",
                if e.nullable { "DROP" } else { "SET" }
            ));
        }
        if default_changed {
            let default = e.default_value.as_deref().unwrap_or("").trim();
            statements.push(format!(
                "ALTER TABLE {table}\n  ALTER COLUMN {name} {}",
                if default.is_empty() {
                    "DROP DEFAULT".into()
                } else {
                    format!("SET DEFAULT {default}")
                }
            ));
        }
    }
    for c in request.columns.iter().filter(|c| c.added == Some(true)) {
        if normalize(Some(&c.data_type)).is_empty() {
            return Err(invalid(format!(
                "Column \"{}\" needs a type",
                c.name.trim()
            )));
        }
        let mut parts = vec![format!(
            "ADD COLUMN {} {}",
            ident(c.name.trim()),
            c.data_type.trim()
        )];
        let default = c.default_value.as_deref().unwrap_or("").trim();
        if !default.is_empty() {
            parts.push(format!("DEFAULT {default}"));
        }
        if !c.nullable {
            parts.push("NOT NULL".into());
        }
        statements.push(format!("ALTER TABLE {table}\n  {}", parts.join(" ")));
    }
    for c in &state.columns {
        let Some(e) = edits.get(c.id.as_str()) else {
            continue;
        };
        let desc = description(e.description.as_deref());
        if desc != description(c.description.as_deref()) {
            statements.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                ident(e.name.trim()),
                literal(desc)
            ));
        }
    }
    for c in request.columns.iter().filter(|c| c.added == Some(true)) {
        if let Some(desc) = description(c.description.as_deref()) {
            statements.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                ident(c.name.trim()),
                literal(Some(desc))
            ));
        }
    }
    let desc = description(request.description.as_deref());
    if desc != description(state.description.as_deref()) {
        statements.push(format!("COMMENT ON TABLE {table} IS {}", literal(desc)));
    }
    Ok(if statements.is_empty() {
        None
    } else {
        Some(format!("{};\n", statements.join(";\n\n")))
    })
}

impl Database {
    pub async fn table_edit_state(&self, id: &str, oid: &str) -> Result<TableEditState, CoreError> {
        let parsed: u32 = oid.parse().map_err(|_| invalid("Invalid object id"))?;
        if oid.is_empty() || !oid.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("Invalid object id"));
        }
        let lease = self.catalog_client(id).await?;
        let row = lease
            .client()
            .query_opt(include_str!("tableedit.sql"), &[&parsed])
            .await?
            .ok_or_else(not_found)?;
        let kind: &str = row.try_get(0)?;
        if !matches!(kind, "r" | "p") || row.try_get::<_, bool>(1)? {
            return Err(invalid(
                "Only ordinary tables and partitioned parents can be edited",
            ));
        }
        let mut state: TableEditState = serde_json::from_value(row.try_get(2)?)
            .map_err(|e| CoreError::local(format!("Invalid table catalog: {e}")))?;
        // Preserve the transport spelling for fingerprint parity with the
        // original read endpoint (including a leading-zero OID).
        state.oid = oid.to_owned();
        state.fingerprint = fingerprint(&state);
        Ok(state)
    }

    pub async fn table_edit_ddl(
        &self,
        id: &str,
        oid: &str,
        request: TableEditRequest,
    ) -> Result<TableEditResponse, CoreError> {
        let state = self.table_edit_state(id, oid).await?;
        Ok(TableEditResponse {
            ddl: diff(&state, &request)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expressions_preserve_literal_and_comment_whitespace() {
        assert_eq!(normalize(Some("  now(  )  ")), "now( )");
        for sql in [
            "'North  America'",
            "\"a  b\"",
            "$x$a  b$x$",
            "E'a\\'  b'",
            "/* a  /* b */ c */",
            "-- a  b\n1",
        ] {
            assert_eq!(normalize(Some(sql)), sql);
        }
        assert_ne!(
            normalize(Some("'North  America'")),
            normalize(Some("'North America'"))
        );
    }
    #[test]
    fn rename_cycles_and_chains_use_free_names() {
        let steps = rename_steps(
            vec![("a".into(), "b".into()), ("b".into(), "a".into())],
            HashSet::from(["a".into(), "b".into(), "pgdev_rename_1".into()]),
        );
        assert_eq!(
            steps,
            vec![
                ("a".into(), "pgdev_rename_2".into()),
                ("b".into(), "a".into()),
                ("pgdev_rename_2".into(), "b".into())
            ]
        );
        assert_eq!(
            rename_steps(
                vec![("a".into(), "b".into()), ("b".into(), "c".into())],
                HashSet::from(["a".into(), "b".into()])
            ),
            vec![("b".into(), "c".into()), ("a".into(), "b".into())]
        );
    }
}
