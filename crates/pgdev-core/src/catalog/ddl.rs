use super::{flag, ident, not_found, optional, qualified, text};
use crate::{CoreError, DdlKind, DdlResponse, DdlTarget};
use std::collections::HashSet;
use tokio_postgres::{Client, Row};

struct Sequence {
    kind: String,
    start: i64,
    increment: i64,
    min: i64,
    max: i64,
    cache: i64,
    cycle: bool,
}

impl Sequence {
    fn options(&self, name: Option<String>) -> Vec<String> {
        let (min, max) = match self.kind.as_str() {
            "smallint" => (i16::MIN as i64, i16::MAX as i64),
            "integer" => (i32::MIN as i64, i32::MAX as i64),
            "bigint" => (i64::MIN, i64::MAX),
            _ => return vec![],
        };
        let ascending = self.increment > 0;
        let mut parts = name.into_iter().collect::<Vec<_>>();
        if self.min != if ascending { 1 } else { min } {
            parts.push(format!("MINVALUE {}", self.min));
        }
        if self.max != if ascending { max } else { -1 } {
            parts.push(format!("MAXVALUE {}", self.max));
        }
        if self.start != if ascending { self.min } else { self.max } {
            parts.push(format!("START WITH {}", self.start));
        }
        if self.increment != 1 {
            parts.push(format!("INCREMENT BY {}", self.increment));
        }
        if self.cache != 1 {
            parts.push(format!("CACHE {}", self.cache));
        }
        if self.cycle {
            parts.push("CYCLE".to_owned());
        }
        parts
    }
}

fn number(row: &Row, field: &str) -> Result<i64, CoreError> {
    text(row, field)?
        .parse()
        .map_err(|_| CoreError::local(format!("Invalid numeric catalog field: {field}")))
}

fn owned_sequence(row: &Row) -> Result<Option<(Sequence, String, String)>, CoreError> {
    let Some(name) = optional(row, "owned_name")? else {
        return Ok(None);
    };
    Ok(Some((
        Sequence {
            kind: text(row, "sequence_type")?,
            start: number(row, "sequence_start")?,
            increment: number(row, "sequence_increment")?,
            min: number(row, "sequence_min")?,
            max: number(row, "sequence_max")?,
            cache: number(row, "sequence_cache")?,
            cycle: flag(row, "sequence_cycle")?,
        },
        text(row, "owned_schema")?,
        name,
    )))
}

async fn relation_oid(
    client: &Client,
    target: &DdlTarget,
    kinds: &[&str],
) -> Result<u32, CoreError> {
    let kinds = kinds.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let row = if let Some(oid) = target.oid.as_deref().filter(|s| !s.is_empty()) {
        let oid: u32 = oid
            .parse()
            .map_err(|_| CoreError::local("Invalid object OID"))?;
        client.query_opt("SELECT c.oid FROM pg_class c WHERE c.oid = $1 AND c.relkind::text = ANY($2::text[])", &[&oid, &kinds]).await?
    } else {
        client.query_opt("SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind::text = ANY($3::text[]) ORDER BY c.oid LIMIT 1", &[&target.schema, &target.name, &kinds]).await?
    };
    Ok(row.ok_or_else(not_found)?.try_get(0)?)
}

async fn other_oid(client: &Client, target: &DdlTarget, function: bool) -> Result<u32, CoreError> {
    if let Some(oid) = target.oid.as_deref().filter(|s| !s.is_empty()) {
        return oid
            .parse()
            .map_err(|_| CoreError::local("Invalid object OID"));
    }
    let sql = if function {
        "SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f','p','w','a') ORDER BY pg_get_function_identity_arguments(p.oid), p.oid LIMIT 1"
    } else {
        "SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype IN ('e','c','d','r') ORDER BY t.oid LIMIT 1"
    };
    Ok(client
        .query_opt(sql, &[&target.schema, &target.name])
        .await?
        .ok_or_else(not_found)?
        .try_get(0)?)
}

pub(super) async fn object(client: &Client, target: &DdlTarget) -> Result<DdlResponse, CoreError> {
    let (ddl, read_only) = match target.kind {
        DdlKind::Table => (table(client, target).await?, false),
        DdlKind::View => view(client, target).await?,
        DdlKind::Function => (function(client, target).await?, false),
        DdlKind::Type => (data_type(client, target).await?, false),
        DdlKind::Sequence => (sequence(client, target).await?, false),
        DdlKind::Index | DdlKind::Constraint | DdlKind::Trigger => {
            (child(client, target).await?, false)
        }
    };
    Ok(DdlResponse { ddl, read_only })
}

async fn table(client: &Client, target: &DdlTarget) -> Result<String, CoreError> {
    let oid = relation_oid(client, target, &["r", "p", "f"]).await?;
    let cols = client.query(include_str!("columns.sql"), &[&oid]).await?;
    let cons = client
        .query(include_str!("constraints.sql"), &[&oid])
        .await?;
    let indexes = client.query("SELECT idx.relname AS indexname, pg_get_indexdef(idx.oid) AS indexdef FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = idx.oid WHERE i.indrelid = $1 AND con.oid IS NULL AND NOT EXISTS (SELECT 1 FROM pg_inherits x WHERE x.inhrelid = idx.oid) ORDER BY idx.relname", &[&oid]).await?;
    let pk = client.query("SELECT a.attname FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) WHERE con.conrelid = $1 AND con.contype = 'p'", &[&oid]).await?;
    let rel = client
        .query_opt(include_str!("relation.sql"), &[&oid])
        .await?
        .ok_or_else(not_found)?;
    let policies = client.query("SELECT polname, polcmd, NOT polpermissive AS restrictive, (SELECT string_agg(CASE WHEN pol.role_oid = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END, ', ' ORDER BY (pol.role_oid <> 0), r.rolname) FROM unnest(p.polroles) AS pol(role_oid) LEFT JOIN pg_roles r ON r.oid = pol.role_oid) AS roles, pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck FROM pg_policy p WHERE p.polrelid = $1 ORDER BY p.polname", &[&oid]).await?;
    let foreign = client.query_opt("SELECT s.srvname AS server, (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || ' ' || quote_literal(substr(o, strpos(o, '=') + 1)), ', ' ORDER BY ord) FROM unnest(ft.ftoptions) WITH ORDINALITY AS opt(o, ord)) AS options FROM pg_foreign_table ft JOIN pg_foreign_server s ON s.oid = ft.ftserver WHERE ft.ftrelid = $1", &[&oid]).await?;
    let schema = text(&rel, "schema")?;
    let name = text(&rel, "name")?;
    let table = qualified(&schema, &name);
    let mut chunks = vec![format!("-- DROP TABLE IF EXISTS {table};")];
    if flag(&rel, "relispartition")? && optional(&rel, "part_name")?.is_some() {
        let bound = optional(&rel, "partbound")?.unwrap_or_default();
        let upper = bound.trim().to_ascii_uppercase();
        let bound = if upper.starts_with("FOR VALUES") || upper.starts_with("DEFAULT") {
            bound.trim().to_owned()
        } else {
            format!("FOR VALUES {}", bound.trim())
        };
        let sub = optional(&rel, "own_partkey")?
            .map(|key| format!("\n  PARTITION BY {key}"))
            .unwrap_or_default();
        chunks.push(format!(
            "CREATE TABLE {table}\n  PARTITION OF {}\n  {bound}{sub};",
            qualified(&text(&rel, "part_schema")?, &text(&rel, "part_name")?)
        ));
        let local = cons
            .iter()
            .map(|c| {
                Ok(format!(
                    "ALTER TABLE {table} ADD CONSTRAINT {} {};",
                    ident(&text(c, "conname")?),
                    text(c, "def")?
                ))
            })
            .collect::<Result<Vec<_>, CoreError>>()?;
        if !local.is_empty() {
            chunks.push(local.join("\n"));
        }
        if !indexes.is_empty() {
            chunks.push(
                indexes
                    .iter()
                    .map(|r| Ok(format!("{};", text(r, "indexdef")?)))
                    .collect::<Result<Vec<_>, CoreError>>()?
                    .join("\n"),
            );
        }
    } else {
        let pk = pk
            .iter()
            .map(|r| text(r, "attname"))
            .collect::<Result<HashSet<_>, _>>()?;
        let kind = text(&rel, "relkind")?;
        let partkey = optional(&rel, "partkey")?;
        let inherits = if kind != "f" && partkey.is_none() {
            optional(&rel, "inherits")?
        } else {
            None
        };
        let mut creates = Vec::new();
        let mut ownership = Vec::new();
        let mut lines = Vec::new();
        for col in &cols {
            if inherits.is_some() && number(col, "inhcount")? != 0 {
                continue;
            }
            let column = text(col, "name")?;
            let data_type = text(col, "type")?;
            let identity = text(col, "identity")?;
            let generated = text(col, "generated")?;
            let owned = owned_sequence(col)?;
            let serial = if owned.is_some() && identity.is_empty() && generated.is_empty() {
                match data_type.as_str() {
                    "smallint" => Some("smallserial"),
                    "integer" => Some("serial"),
                    "bigint" => Some("bigserial"),
                    _ => None,
                }
            } else {
                None
            };
            let renamed = owned
                .as_ref()
                .is_some_and(|(_, s, n)| n != &format!("{name}_{column}_seq") || s != &schema);
            let explicit = serial.is_some()
                && owned.as_ref().is_some_and(|(seq, _, _)| {
                    !seq.options(None).is_empty() || renamed || seq.kind != data_type
                });
            if explicit {
                let (seq, s, n) = owned.as_ref().unwrap();
                let options = seq.options(None);
                creates.push(format!(
                    "CREATE SEQUENCE {} AS {}{};",
                    qualified(s, n),
                    seq.kind,
                    if options.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", options.join(" "))
                    }
                ));
                ownership.push(format!(
                    "ALTER SEQUENCE {} OWNED BY {table}.{};",
                    qualified(s, n),
                    ident(&column)
                ));
            }
            let fdw = optional(col, "fdw_options")?
                .map(|options| format!(" OPTIONS ({options})"))
                .unwrap_or_default();
            let mut parts = vec![format!(
                "{} {}{fdw}{}",
                ident(&column),
                if explicit {
                    data_type.as_str()
                } else {
                    serial.unwrap_or(&data_type)
                },
                optional(col, "collation")?.unwrap_or_default()
            )];
            let default = optional(col, "default_value")?;
            if let Some(expression) = default.as_ref().filter(|_| generated == "s") {
                parts.push(format!("GENERATED ALWAYS AS ({}) STORED", expression));
            } else if identity == "a" || identity == "d" {
                let keyword = if identity == "a" {
                    "GENERATED ALWAYS AS IDENTITY"
                } else {
                    "GENERATED BY DEFAULT AS IDENTITY"
                };
                let options = owned
                    .as_ref()
                    .map(|(seq, s, n)| {
                        seq.options(if renamed {
                            Some(format!("SEQUENCE NAME {}", qualified(s, n)))
                        } else {
                            None
                        })
                    })
                    .unwrap_or_default();
                parts.push(if options.is_empty() {
                    keyword.to_owned()
                } else {
                    format!("{keyword} ({})", options.join(" "))
                });
            } else if let Some(mut default) = default.filter(|_| serial.is_none() || explicit) {
                if explicit
                    && default.to_ascii_lowercase().starts_with("nextval('")
                    && (default.ends_with("::regclass)") || default.ends_with("')"))
                {
                    let (_, s, n) = owned.as_ref().unwrap();
                    default = format!(
                        "nextval('{}'::regclass)",
                        qualified(s, n).replace('\'', "''")
                    );
                }
                parts.push(format!("DEFAULT {default}"));
            }
            if flag(col, "notnull")? && !pk.contains(&column) {
                parts.push("NOT NULL".to_owned());
            }
            lines.push(format!("  {}", parts.join(" ")));
        }
        let mut seen = HashSet::new();
        let mut deferred = Vec::new();
        for con in &cons {
            let definition = text(con, "def")?;
            if flag(con, "is_clone")? && !seen.insert(definition.clone()) {
                continue;
            }
            if definition.to_ascii_uppercase().ends_with("NOT VALID") {
                deferred.push(format!(
                    "ALTER TABLE {table} ADD CONSTRAINT {} {definition};",
                    ident(&text(con, "conname")?)
                ));
            } else {
                lines.push(format!(
                    "  CONSTRAINT {} {definition}",
                    ident(&text(con, "conname")?)
                ));
            }
        }
        let keyword = if kind == "f" {
            "FOREIGN TABLE"
        } else if text(&rel, "relpersistence")? == "u" {
            "UNLOGGED TABLE"
        } else {
            "TABLE"
        };
        let mut create = format!("CREATE {keyword} {table} (\n{}\n)", lines.join(",\n"));
        if let Some(foreign) = foreign.filter(|_| kind == "f") {
            create.push_str(&format!("\n  SERVER {}", ident(&text(&foreign, "server")?)));
            if let Some(options) = optional(&foreign, "options")? {
                create.push_str(&format!("\n  OPTIONS ({options})"));
            }
        }
        if let Some(key) = partkey {
            create.push_str(&format!("\n  PARTITION BY {key}"));
        } else if let Some(inherits) = inherits {
            create.push_str(&format!("\n  INHERITS ({inherits})"));
        }
        if let Some(space) = optional(&rel, "tablespace")? {
            create.push_str(&format!("\n  TABLESPACE {}", ident(&space)));
        }
        if !creates.is_empty() {
            chunks.push(creates.join("\n"));
        }
        chunks.push(format!("{create};"));
        if !ownership.is_empty() {
            chunks.push(ownership.join("\n"));
        }
        if !deferred.is_empty() {
            chunks.push(deferred.join("\n"));
        }
        if !indexes.is_empty() {
            chunks.push(
                indexes
                    .iter()
                    .map(|r| Ok(format!("{};", text(r, "indexdef")?)))
                    .collect::<Result<Vec<_>, CoreError>>()?
                    .join("\n"),
            );
        }
    }
    if flag(&rel, "relrowsecurity")? || flag(&rel, "relforcerowsecurity")? {
        chunks.push(format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;"));
    }
    if flag(&rel, "relforcerowsecurity")? {
        chunks.push(format!("ALTER TABLE {table} FORCE ROW LEVEL SECURITY;"));
    }
    for policy in policies {
        let command = match text(&policy, "polcmd")?.as_str() {
            "r" => "SELECT",
            "a" => "INSERT",
            "w" => "UPDATE",
            "d" => "DELETE",
            _ => "ALL",
        };
        let mode = if flag(&policy, "restrictive")? {
            " AS RESTRICTIVE"
        } else {
            ""
        };
        let using = optional(&policy, "qual")?
            .map(|v| format!(" USING ({v})"))
            .unwrap_or_default();
        let check = optional(&policy, "withcheck")?
            .map(|v| format!(" WITH CHECK ({v})"))
            .unwrap_or_default();
        chunks.push(format!(
            "CREATE POLICY {} ON {table}{mode}\n  FOR {command} TO {}{using}{check};",
            ident(&text(&policy, "polname")?),
            optional(&policy, "roles")?.unwrap_or_else(|| "PUBLIC".to_owned())
        ));
    }
    if let Some(owner) = optional(&rel, "owner")? {
        chunks.push(format!("ALTER TABLE {table} OWNER TO {};", ident(&owner)));
    }
    if let Some(comment) = optional(&rel, "comment")? {
        chunks.push(format!("COMMENT ON TABLE {table} IS {comment};"));
    }
    for col in &cols {
        if let Some(comment) = optional(col, "comment")? {
            chunks.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {comment};",
                ident(&text(col, "name")?)
            ));
        }
    }
    Ok(chunks.join("\n\n"))
}

async fn view(client: &Client, target: &DdlTarget) -> Result<(String, bool), CoreError> {
    let oid = relation_oid(client, target, &["v", "m"]).await?;
    let row = client.query_opt("SELECT c.relkind, n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid, true) AS def, pg_get_userbyid(c.relowner) AS owner, quote_literal(obj_description(c.oid)) AS comment, (SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace) AS tablespace, (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || '=' || quote_literal(substr(o, strpos(o, '=') + 1)), ', ' ORDER BY ord) FROM unnest(c.reloptions) WITH ORDINALITY AS opt(o, ord)) AS reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1", &[&oid]).await?.ok_or_else(not_found)?;
    let materialized = text(&row, "relkind")? == "m";
    let target = qualified(&text(&row, "schema")?, &text(&row, "name")?);
    let definition = text(&row, "def")?.trim().trim_end_matches(';').to_owned();
    let options = optional(&row, "reloptions")?
        .map(|v| format!(" WITH ({v})"))
        .unwrap_or_default();
    let space = if materialized {
        optional(&row, "tablespace")?
            .map(|v| format!("\n  TABLESPACE {}", ident(&v)))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let kind = if materialized {
        "MATERIALIZED VIEW"
    } else {
        "VIEW"
    };
    let keyword = if materialized {
        "CREATE MATERIALIZED VIEW"
    } else {
        "CREATE OR REPLACE VIEW"
    };
    let mut chunks = vec![
        format!("-- DROP {kind} IF EXISTS {target};"),
        format!("{keyword} {target}{options}{space} AS\n{definition};"),
    ];
    let indexes = client.query("SELECT pg_get_indexdef(idx.oid) AS indexdef FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid WHERE i.indrelid = $1 ORDER BY idx.relname", &[&oid]).await?;
    if materialized && !indexes.is_empty() {
        chunks.push(
            indexes
                .iter()
                .map(|r| Ok(format!("{};", text(r, "indexdef")?)))
                .collect::<Result<Vec<_>, CoreError>>()?
                .join("\n"),
        );
    }
    if let Some(owner) = optional(&row, "owner")? {
        chunks.push(format!("ALTER {kind} {target} OWNER TO {};", ident(&owner)));
    }
    if let Some(comment) = optional(&row, "comment")? {
        chunks.push(format!("COMMENT ON {kind} {target} IS {comment};"));
    }
    Ok((chunks.join("\n\n"), materialized))
}

async fn function(client: &Client, target: &DdlTarget) -> Result<String, CoreError> {
    let oid = other_oid(client, target, true).await?;
    let row = client.query_opt("SELECT p.prokind, n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = $1", &[&oid]).await?.ok_or_else(not_found)?;
    let target = format!(
        "{}({})",
        qualified(&text(&row, "schema")?, &text(&row, "name")?),
        text(&row, "args")?
    );
    if text(&row, "prokind")? == "a" {
        return aggregate(client, oid, &target).await;
    }
    let definition: String = client
        .query_one("SELECT pg_get_functiondef($1::oid)", &[&oid])
        .await?
        .try_get(0)?;
    let definition = definition.trim();
    let keyword = if text(&row, "prokind")? == "p" {
        "PROCEDURE"
    } else {
        "FUNCTION"
    };
    Ok(format!(
        "-- DROP {keyword} IF EXISTS {target};\n\n{definition}{}",
        if definition.ends_with(';') { "" } else { ";" }
    ))
}

async fn aggregate(client: &Client, oid: u32, target: &str) -> Result<String, CoreError> {
    let row = client
        .query_opt(include_str!("aggregate.sql"), &[&oid])
        .await?
        .ok_or_else(not_found)?;
    let kind = text(&row, "aggkind")?;
    let default_modify = if kind == "n" { "r" } else { "w" };
    let mut options = vec![
        format!("SFUNC = {}", text(&row, "sfunc")?),
        format!("STYPE = {}", text(&row, "stype")?),
    ];
    for (field, label) in [("transspace", "SSPACE"), ("finalfn", "FINALFUNC")] {
        if let Some(v) = optional(&row, field)? {
            options.push(format!("{label} = {v}"));
        }
    }
    if flag(&row, "aggfinalextra")? {
        options.push("FINALFUNC_EXTRA".to_owned());
    }
    modify(
        &row,
        "finalfn",
        "aggfinalmodify",
        "FINALFUNC_MODIFY",
        default_modify,
        &mut options,
    )?;
    for (field, label) in [
        ("combinefn", "COMBINEFUNC"),
        ("serialfn", "SERIALFUNC"),
        ("deserialfn", "DESERIALFUNC"),
        ("initcond", "INITCOND"),
        ("msfunc", "MSFUNC"),
        ("minvfunc", "MINVFUNC"),
        ("mstype", "MSTYPE"),
        ("mtransspace", "MSSPACE"),
        ("mfinalfn", "MFINALFUNC"),
    ] {
        if let Some(v) = optional(&row, field)? {
            options.push(format!("{label} = {v}"));
        }
    }
    if flag(&row, "aggmfinalextra")? {
        options.push("MFINALFUNC_EXTRA".to_owned());
    }
    modify(
        &row,
        "mfinalfn",
        "aggmfinalmodify",
        "MFINALFUNC_MODIFY",
        default_modify,
        &mut options,
    )?;
    for (field, label) in [("minitcond", "MINITCOND"), ("sortop", "SORTOP")] {
        if let Some(v) = optional(&row, field)? {
            options.push(format!("{label} = {v}"));
        }
    }
    match text(&row, "proparallel")?.as_str() {
        "s" => options.push("PARALLEL = SAFE".to_owned()),
        "r" => options.push("PARALLEL = RESTRICTED".to_owned()),
        _ => {}
    }
    if kind == "h" {
        options.push("HYPOTHETICAL".to_owned());
    }
    let note = if kind == "n" {
        ""
    } else {
        "-- NOTE: ordered-set/hypothetical aggregate — verify the ORDER BY direct-argument list.\n"
    };
    Ok(format!(
        "-- DROP AGGREGATE IF EXISTS {target};\n\n{note}CREATE AGGREGATE {target} (\n  {}\n);",
        options.join(",\n  ")
    ))
}

fn modify(
    row: &Row,
    function: &str,
    field: &str,
    label: &str,
    default: &str,
    options: &mut Vec<String>,
) -> Result<(), CoreError> {
    let value = text(row, field)?;
    if optional(row, function)?.is_some() && value != default {
        let value = match value.as_str() {
            "r" => Some("READ_ONLY"),
            "s" => Some("SHAREABLE"),
            "w" => Some("READ_WRITE"),
            _ => None,
        };
        if let Some(value) = value {
            options.push(format!("{label} = {value}"));
        }
    }
    Ok(())
}

async fn data_type(client: &Client, target: &DdlTarget) -> Result<String, CoreError> {
    let oid = other_oid(client, target, false).await?;
    let row = client
        .query_opt(include_str!("types.sql"), &[&oid])
        .await?
        .ok_or_else(not_found)?;
    let target = qualified(&text(&row, "schema")?, &text(&row, "name")?);
    let kind = text(&row, "typtype")?;
    let ddl = match kind.as_str() {
        "e" => format!(
            "CREATE TYPE {target} AS ENUM ({});",
            optional(&row, "labels")?.unwrap_or_default()
        ),
        "c" => format!(
            "CREATE TYPE {target} AS ({});",
            optional(&row, "attrs")?.unwrap_or_default()
        ),
        "d" => {
            let mut parts = vec![format!("CREATE DOMAIN {target} AS {}", text(&row, "base")?)];
            for (field, label) in [("domain_collation", "COLLATE"), ("typdefault", "DEFAULT")] {
                if let Some(v) = optional(&row, field)? {
                    parts.push(format!("{label} {v}"));
                }
            }
            if flag(&row, "typnotnull")? {
                parts.push("NOT NULL".to_owned());
            }
            if let Some(v) = optional(&row, "cons")? {
                parts.push(v.trim().to_owned());
            }
            format!("{};", parts.join(" "))
        }
        "r" => {
            let mut parts = vec![format!("SUBTYPE = {}", text(&row, "subtype")?)];
            for (field, label) in [
                ("subopc", "SUBTYPE_OPCLASS"),
                ("collation", "COLLATION"),
                ("canonical", "CANONICAL"),
                ("subdiff", "SUBTYPE_DIFF"),
                ("multirange_name", "MULTIRANGE_TYPE_NAME"),
            ] {
                if let Some(v) = optional(&row, field)?.filter(|v| v != "-") {
                    parts.push(format!("{label} = {v}"));
                }
            }
            format!(
                "CREATE TYPE {target} AS RANGE (\n  {}\n);",
                parts.join(",\n  ")
            )
        }
        _ => return Err(not_found()),
    };
    Ok(format!(
        "-- DROP {} IF EXISTS {target};\n\n{ddl}",
        if kind == "d" { "DOMAIN" } else { "TYPE" }
    ))
}

async fn sequence(client: &Client, target: &DdlTarget) -> Result<String, CoreError> {
    let oid = relation_oid(client, target, &["S"]).await?;
    let row = client.query_opt("SELECT s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle, c.relname AS name, n.nspname AS schema, format_type(s.seqtypid, NULL) AS data_type, (SELECT format('%I.%I.%I', tn.nspname, t.relname, a.attname) FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid JOIN pg_namespace tn ON tn.oid = t.relnamespace WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i') LIMIT 1) AS owned_by FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1", &[&oid]).await?.ok_or_else(not_found)?;
    let props = Sequence {
        kind: text(&row, "data_type")?,
        start: number(&row, "seqstart")?,
        increment: number(&row, "seqincrement")?,
        min: number(&row, "seqmin")?,
        max: number(&row, "seqmax")?,
        cache: number(&row, "seqcache")?,
        cycle: flag(&row, "seqcycle")?,
    };
    let target = qualified(&text(&row, "schema")?, &text(&row, "name")?);
    let options = props.options(None);
    let mut create = format!("CREATE SEQUENCE {target} AS {}", props.kind);
    if !options.is_empty() {
        create.push_str(&format!(" {}", options.join(" ")));
    }
    if let Some(owner) = optional(&row, "owned_by")? {
        create.push_str(&format!(" OWNED BY {owner}"));
    }
    Ok(format!("-- DROP SEQUENCE IF EXISTS {target};\n\n{create};"))
}

async fn child(client: &Client, target: &DdlTarget) -> Result<String, CoreError> {
    let parent = target.parent.as_deref().unwrap_or("");
    let (sql, params): (&str, Vec<&(dyn tokio_postgres::types::ToSql + Sync)>) = match target.kind {
        DdlKind::Index => ("SELECT pg_get_indexdef(ic.oid) AS def FROM pg_class ic JOIN pg_namespace n ON n.oid = ic.relnamespace WHERE n.nspname = $1 AND ic.relname = $2 AND ic.relkind IN ('i','I')",vec![&target.schema,&target.name]),
        DdlKind::Constraint => ("SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3",vec![&target.schema,&parent,&target.name]),
        _ => ("SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3",vec![&target.schema,&parent,&target.name]),
    };
    let row = client
        .query_opt(sql, &params)
        .await?
        .ok_or_else(not_found)?;
    let definition = text(&row, "def")?.trim().to_owned();
    let relation = qualified(&target.schema, parent);
    Ok(match target.kind {
        DdlKind::Index => format!("-- DROP INDEX IF EXISTS {};\n\n{definition};",qualified(&target.schema,&target.name)),
        DdlKind::Constraint => format!("-- ALTER TABLE {relation} DROP CONSTRAINT {};\n\nALTER TABLE {relation}\n  ADD CONSTRAINT {} {definition};",ident(&target.name),ident(&target.name)),
        _ => format!("-- DROP TRIGGER IF EXISTS {} ON {relation};\n\n{definition};",ident(&target.name)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sequence_bounds_never_round_through_floating_point() {
        let mut sequence = Sequence {
            kind: "bigint".to_owned(),
            start: 1,
            increment: 1,
            min: 1,
            max: i64::MAX,
            cache: 1,
            cycle: false,
        };
        assert!(sequence.options(None).is_empty());
        sequence.max -= 1;
        assert_eq!(sequence.options(None), ["MAXVALUE 9223372036854775806"]);
        sequence.increment = -2;
        sequence.min = i64::MIN;
        sequence.max = -1;
        sequence.start = -1;
        assert_eq!(sequence.options(None), ["INCREMENT BY -2"]);
    }
}
