use crate::{
    catalog::{ident, qualified},
    contracts::*,
    postgres::{CoreError, Database},
    query::cell,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    time::Instant,
};
use tokio_postgres::Client;

#[derive(Debug, Deserialize)]
pub(crate) struct Info {
    schema: String,
    name: String,
    pk: Vec<String>,
    columns: Vec<Column>,
}
#[derive(Debug, Deserialize)]
struct Column {
    name: String,
    data_type: String,
    oid: u32,
    generated: bool,
    nullable: bool,
}

pub(crate) async fn info(client: &Client, oid: u32) -> Result<Option<Info>, CoreError> {
    let row = client.query_opt(r#"
SELECT jsonb_build_object('schema', n.nspname, 'name', c.relname,
  'pk', COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ord)
    FROM pg_constraint con CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(attnum,ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    WHERE con.conrelid = c.oid AND con.contype = 'p'), '[]'::jsonb),
  'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', a.attname,
    'data_type', format_type(a.atttypid,NULL), 'oid', a.atttypid::bigint,
    'generated', a.attgenerated <> '', 'nullable', NOT a.attnotnull) ORDER BY a.attnum)
    FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = $1 AND c.relkind IN ('r','p')
  AND (c.relkind = 'p' OR NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = c.oid))
"#, &[&oid]).await?;
    row.map(|row| {
        serde_json::from_value(row.get::<_, Value>(0))
            .map_err(|e| CoreError::local(format!("Invalid row catalog: {e}")))
    })
    .transpose()
}

pub(crate) fn editable(
    info: Info,
    names: &[String],
    allowed: Option<&[String]>,
) -> Option<EditableGrid> {
    let mut counts = HashMap::new();
    for name in names {
        *counts.entry(name.as_str()).or_insert(0) += 1;
    }
    if info.pk.is_empty()
        || info
            .pk
            .iter()
            .any(|key| counts.get(key.as_str()) != Some(&1))
    {
        return None;
    }
    let columns = info
        .columns
        .into_iter()
        .filter(|c| {
            counts.get(c.name.as_str()) == Some(&1) && allowed.is_none_or(|a| a.contains(&c.name))
        })
        .map(|c| EditableGridColumn {
            pk: info.pk.contains(&c.name),
            name: c.name,
            generated: c.generated,
            nullable: c.nullable,
        })
        .collect();
    Some(EditableGrid {
        schema: info.schema,
        table: info.name,
        pk: info.pk,
        columns,
    })
}

struct Plan {
    sql: String,
    values: Vec<Option<String>>,
}

fn value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}
fn plan(request: &RowUpdateRequest, info: &Info) -> Result<Plan, CoreError> {
    if info.pk.is_empty() {
        return Err(CoreError::local("The table has no primary key"));
    }
    if request.key.len() != info.pk.len() || info.pk.iter().any(|c| !request.key.contains_key(c)) {
        return Err(CoreError::local(format!(
            "The row key must be exactly the primary key ({})",
            info.pk.join(", ")
        )));
    }
    if request.set.is_empty() {
        return Err(CoreError::local("No values to update"));
    }
    let mut values = Vec::new();
    let mut assignments = Vec::new();
    for (name, v) in &request.set {
        let c = info
            .columns
            .iter()
            .find(|c| c.name == *name)
            .ok_or_else(|| CoreError::local(format!("Unknown column \"{name}\"")))?;
        if c.generated || info.pk.contains(name) || c.data_type == "bytea" {
            return Err(CoreError::local(format!(
                "Column \"{name}\" cannot be updated"
            )));
        }
        let v = if v.is_null() {
            None
        } else {
            Some(
                value(v)
                    .ok_or_else(|| CoreError::local(format!("Invalid value for \"{name}\"")))?,
            )
        };
        values.push(v);
        // Text input is explicitly cast by PostgreSQL. No value is ever SQL
        // interpolation; the type name comes only from the live catalog.
        assignments.push(format!(
            "{} = ${}::text::{}",
            ident(name),
            values.len(),
            c.data_type
        ));
    }
    let mut predicates = Vec::new();
    for name in &info.pk {
        let v = value(&request.key[name])
            .ok_or_else(|| CoreError::local(format!("Missing primary key value for \"{name}\"")))?;
        let c = info
            .columns
            .iter()
            .find(|c| c.name == *name)
            .ok_or_else(|| CoreError::local("Primary key column missing"))?;
        values.push(Some(v));
        predicates.push(format!(
            "{} = ${}::text::{}",
            ident(name),
            values.len(),
            c.data_type
        ));
    }
    let returning = info
        .columns
        .iter()
        .map(|c| format!("{}::text", ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(Plan {
        sql: format!(
            "UPDATE {} SET {} WHERE {} RETURNING {returning}",
            qualified(&info.schema, &info.name),
            assignments.join(", "),
            predicates.join(" AND ")
        ),
        values,
    })
}

async fn update(
    client: &Client,
    request: &RowUpdateRequest,
) -> Result<BTreeMap<String, Value>, CoreError> {
    let reference = qualified(&request.schema, &request.table);
    let oid: Option<u32> = client
        .query_one("SELECT to_regclass($1)::oid", &[&reference])
        .await?
        .get(0);
    let info = info(
        client,
        oid.ok_or_else(|| CoreError::local("Table not found or not row-editable"))?,
    )
    .await?
    .ok_or_else(|| CoreError::local("Table not found or not row-editable"))?;
    let plan = plan(request, &info)?;
    let params = plan
        .values
        .iter()
        .map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect::<Vec<_>>();
    let row = client.query_opt(&plan.sql, &params).await?.ok_or_else(|| {
        let mut e = CoreError::local("Row not found — it may have been deleted; re-run the query.");
        e.code = Some("ROW_NOT_FOUND".into());
        e
    })?;
    info.columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            Ok((
                c.name.clone(),
                cell(row.try_get::<_, Option<&str>>(i)?, c.oid),
            ))
        })
        .collect()
}

impl Database {
    pub async fn row_update(
        &self,
        request: RowUpdateRequest,
    ) -> Result<RowUpdateResponse, CoreError> {
        if request.schema.is_empty()
            || request.table.is_empty()
            || request.schema.len() > 255
            || request.table.len() > 255
            || request
                .key
                .keys()
                .chain(request.set.keys())
                .any(|c| c.len() > 255)
            || serde_json::to_vec(&request.set).map_or(true, |v| v.len() > 4 * 1024 * 1024)
            || serde_json::to_vec(&request.key).map_or(true, |v| v.len() > 4 * 1024 * 1024)
        {
            return Err(CoreError::local("Invalid row update request"));
        }
        let session = self.session(&request.id, &request.tab_key).await?;
        let mut owner = session
            .owner
            .try_lock()
            .map_err(|_| CoreError::local("This tab already has a running query"))?;
        session.ensure_open()?;
        owner.last_used = Instant::now();
        if owner.transaction_id != request.transaction_id {
            let mut error = CoreError::local("The tab transaction ended or changed. Nothing was executed; review the transaction state before retrying.");
            error.code = Some("TRANSACTION_CHANGED".into());
            return Err(crate::query::with_transaction(error, &owner));
        }
        let manual = owner.transaction_id.is_some();
        let (result, (notices, notices_truncated)) = if manual {
            let capture = owner.capture_notices();
            let result = update(&owner.client, &request).await;
            (result, capture.finish())
        } else {
            // A pageable result owns an implicit transaction on the tab client.
            // Use another socket so an autocommit edit cannot join that snapshot.
            let lease = self.catalog_client(&request.id).await?;
            let capture = lease.capture_notices();
            let result = update(lease.client(), &request).await;
            (result, capture.finish())
        };
        owner.last_used = Instant::now();
        match result {
            Ok(row) => Ok(RowUpdateResponse {
                row,
                transaction_open: manual,
                transaction_id: owner.transaction_id.clone(),
                notices,
                notices_truncated,
            }),
            Err(mut error) => {
                error.notices = notices;
                error.notices_truncated = notices_truncated;
                if owner.client.is_closed() || session.ensure_open().is_err() {
                    owner.transaction_id = None;
                } else if manual && error.code.as_ref().is_some_and(|c| c.len() == 5) {
                    owner.transaction_failed = true;
                }
                Err(crate::query::with_transaction(error, &owner))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Info {
        serde_json::from_value(serde_json::json!({"schema":"s", "name":"t", "pk":["id"], "columns":[{"name":"id","data_type":"integer","oid":23,"generated":false,"nullable":false},{"name":"note","data_type":"text","oid":25,"generated":false,"nullable":true},{"name":"computed","data_type":"integer","oid":23,"generated":true,"nullable":true}]})).unwrap()
    }
    fn request() -> RowUpdateRequest {
        serde_json::from_value(serde_json::json!({"id":"c","tabKey":"t","schema":"s","table":"t","key":{"id":1},"set":{"note":"'; DROP TABLE t; --"}})).unwrap()
    }
    #[test]
    fn planner_validates_live_columns_and_parameterizes_values() {
        let mut r = request();
        let p = plan(&r, &fixture()).unwrap();
        assert_eq!(p.sql,"UPDATE \"s\".\"t\" SET \"note\" = $1::text::text WHERE \"id\" = $2::text::integer RETURNING \"id\"::text, \"note\"::text, \"computed\"::text");
        assert_eq!(p.values[0].as_deref(), Some("'; DROP TABLE t; --"));
        for name in ["id", "computed", "missing"] {
            r.set = BTreeMap::from([(name.into(), Value::from(1))]);
            assert!(plan(&r, &fixture()).is_err());
        }
        r = request();
        r.key.insert("extra".into(), Value::from(1));
        assert!(plan(&r, &fixture()).is_err());
        r = request();
        r.set.insert("note".into(), serde_json::json!({"x":1}));
        assert!(plan(&r, &fixture()).is_err());
    }
    #[test]
    fn incomplete_or_duplicate_keys_never_enable_editing() {
        assert!(editable(fixture(), &["note".into()], None).is_none());
        assert!(editable(fixture(), &["id".into(), "id".into()], None).is_none());
        let grid = editable(fixture(), &["id".into(), "note".into()], None).unwrap();
        assert_eq!(grid.columns.len(), 2);
    }
}
