use crate::{
    contracts::*,
    postgres::{ClientOwner, CoreError, Database},
    sql::{self, TransactionControl},
};
use futures_util::TryStreamExt;
use serde_json::Value;
use std::time::Instant;
use tokio_postgres::{Client, SimpleQueryMessage};
use uuid::Uuid;

const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct Metadata {
    names: Vec<String>,
    types: Vec<String>,
    oids: Vec<u32>,
}

pub(crate) struct Cursor {
    name: String,
    metadata: Metadata,
    pending: Option<Vec<Value>>,
}

fn page_size(size: u32) -> Result<usize, CoreError> {
    if !(1..=10000).contains(&size) {
        return Err(CoreError::local("maxRows must be between 1 and 10000"));
    }
    Ok(size as usize)
}

fn cell(value: Option<&str>, oid: u32) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    match oid {
        16 => Value::Bool(value == "t"),
        21 | 23 | 26 => value
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or_else(|_| Value::String(value.to_owned())),
        700 | 701 => value
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        17 if value.starts_with("\\x") => {
            Value::String(format!("<bytea {} bytes>", (value.len() - 2) / 2))
        }
        // Preserve bigint, numeric, JSON, temporal, array and user-defined
        // values exactly as PostgreSQL emits them. Never parse them via JS.
        _ => Value::String(value.to_owned()),
    }
}

async fn metadata(client: &Client, statement: &str) -> Result<Metadata, CoreError> {
    let words = sql::leading_words(statement, 1);
    // Preparing ROLLBACK inside an aborted transaction must not prevent the
    // user's recovery. Transaction controls never produce data columns.
    if matches!(
        words.first().map(String::as_str),
        Some("BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "END" | "ABORT" | "SAVEPOINT" | "RELEASE")
    ) {
        return Ok(Metadata {
            names: vec![],
            types: vec![],
            oids: vec![],
        });
    }
    let prepared = client.prepare(statement).await?;
    let oids = prepared
        .columns()
        .iter()
        .map(|column| column.type_().oid())
        .collect::<Vec<_>>();
    let mut type_names = std::collections::HashMap::<u32, String>::new();
    if !oids.is_empty() {
        for row in client.query("SELECT oid, pg_catalog.format_type(oid, NULL) FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])", &[&oids]).await? {
            type_names.insert(row.get(0), row.get(1));
        }
    }
    let mut result = Metadata {
        names: vec![],
        types: vec![],
        oids: vec![],
    };
    for column in prepared.columns() {
        let oid = column.type_().oid();
        let name = type_names
            .get(&oid)
            .cloned()
            .unwrap_or_else(|| column.type_().name().to_owned());
        result.names.push(column.name().to_owned());
        result.types.push(name);
        result.oids.push(oid);
    }
    Ok(result)
}

async fn read(
    client: &Client,
    sql: &str,
    metadata: &Metadata,
    cap: usize,
) -> Result<(Vec<Vec<Value>>, u64, bool), CoreError> {
    let messages = client.simple_query_raw(sql).await?;
    let mut messages = std::pin::pin!(messages);
    let mut rows = Vec::new();
    let mut count = 0;
    let mut bytes = 0;
    let mut limited = false;
    while let Some(message) = messages.try_next().await? {
        match message {
            SimpleQueryMessage::Row(row) => {
                if rows.len() >= cap {
                    limited = true;
                    continue;
                }
                let row_bytes = std::mem::size_of::<Vec<Value>>()
                    + row.len() * std::mem::size_of::<Value>()
                    + (0..row.len())
                        .filter_map(|i| row.get(i))
                        .map(str::len)
                        .sum::<usize>();
                if bytes + row_bytes > MAX_PAGE_BYTES {
                    return Err(CoreError::local(
                        "Result page exceeds 8 MiB; request fewer rows or smaller values",
                    ));
                }
                bytes += row_bytes;
                rows.push(
                    (0..row.len())
                        .map(|i| cell(row.get(i), metadata.oids.get(i).copied().unwrap_or(0)))
                        .collect(),
                );
            }
            SimpleQueryMessage::CommandComplete(value) => count = value,
            _ => {}
        }
    }
    Ok((rows, count, limited))
}

fn mapped_error(mut error: CoreError, offset: u32, prefix: u32) -> CoreError {
    error.position = error
        .position
        .and_then(|p| p.checked_sub(prefix))
        .map(|p| p + offset);
    error
}

fn with_transaction(mut error: CoreError, owner: &ClientOwner) -> CoreError {
    error.transaction_open = Some(owner.transaction_id.is_some());
    error.transaction_id = owner.transaction_id.clone();
    error
}

async fn rollback_cursor(owner: &mut ClientOwner) -> Result<(), CoreError> {
    if owner.cursor.take().is_some() {
        owner.client.batch_execute("ROLLBACK").await?;
    }
    Ok(())
}

impl Database {
    pub async fn query(&self, request: QueryRequest) -> Result<QueryResponse, CoreError> {
        let cap = page_size(request.max_rows)?;
        if request.sql.len() > 4 * 1024 * 1024 {
            return Err(CoreError::local("SQL batch exceeds 4 MiB"));
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
            error.code = Some("TRANSACTION_CHANGED".to_owned());
            return Err(with_transaction(error, &owner));
        }
        if sql::split(&request.sql, owner.standard_strings).is_empty() {
            return Err(with_transaction(
                CoreError::local("SQL batch is empty"),
                &owner,
            ));
        }
        rollback_cursor(&mut owner).await?;
        if !owner.transaction_failed {
            let row = match owner
                .client
                .query_one("SHOW standard_conforming_strings", &[])
                .await
            {
                Ok(row) => row,
                Err(error) => {
                    if owner.client.is_closed() {
                        owner.transaction_id = None;
                    }
                    return Err(with_transaction(error.into(), &owner));
                }
            };
            let value: String = row.get(0);
            owner.standard_strings = value == "on";
        }
        let statements = sql::split(&request.sql, owner.standard_strings);
        if statements.is_empty() {
            return Err(CoreError::local("SQL batch is empty"));
        }
        let manual = sql::manual_transaction(&statements);
        let autocommit = statements.iter().any(|s| sql::autocommit(s.text));
        let continuing = owner.transaction_id.is_some();
        let implicit = !continuing && !manual && !autocommit;
        let use_cursor = implicit && statements.iter().all(|s| sql::cursor_candidate(s.text));
        let start = Instant::now();
        let mut in_transaction = continuing;
        let outcome: Result<Vec<QueryResult>, CoreError> = async {
            if implicit {
                owner.client.batch_execute("BEGIN; SET LOCAL idle_in_transaction_session_timeout = '5min'").await?;
                in_transaction = true;
            }
            let mut results = Vec::new();
            for (index, statement) in statements.iter().enumerate() {
                session.ensure_open()?;
                let meta = metadata(&owner.client, statement.text).await.map_err(|e| mapped_error(e, statement.start_chars, 0))?;
                if use_cursor && in_transaction && index + 1 == statements.len() && !meta.names.is_empty() {
                    let name = format!("pgdev_cur_{}", Uuid::new_v4().simple());
                    let savepoint = format!("pgdev_sp_{}", Uuid::new_v4().simple());
                    owner.client.batch_execute(&format!("SAVEPOINT \"{savepoint}\"")).await?;
                    let prefix = format!("DECLARE \"{name}\" NO SCROLL CURSOR FOR ");
                    match owner.client.batch_execute(&format!("{prefix}{}", statement.text)).await {
                        Ok(()) => {
                            owner.client.batch_execute(&format!("RELEASE SAVEPOINT \"{savepoint}\"")).await?;
                            let (mut rows, _, _) = read(&owner.client, &format!("FETCH FORWARD {} FROM \"{name}\"", cap + 1), &meta, cap + 1).await.map_err(|mut e| { e.position = None; e })?;
                            let pending = if rows.len() > cap { rows.pop() } else { None };
                            let truncated = pending.is_some();
                            if truncated { owner.cursor = Some(Cursor { name, metadata: meta.clone(), pending }); }
                            else { owner.client.batch_execute(&format!("CLOSE \"{name}\"")).await?; }
                            results.push(QueryResult::Data(DataResult { columns: meta.names, column_types: meta.types, column_type_oids: meta.oids, row_count: rows.len() as u64, rows, truncated, limited: false, total_row_count: None }));
                            continue;
                        }
                        Err(error) if matches!(error.code().map(|code| code.code()), Some("42601" | "0A000")) => {
                            // DECLARE cannot wrap data-modifying CTEs. Recover
                            // and execute once directly. Never retry a cancel,
                            // timeout or a failure from FETCH.
                            owner.client.batch_execute(&format!("ROLLBACK TO SAVEPOINT \"{savepoint}\"; RELEASE SAVEPOINT \"{savepoint}\"")).await?;
                        }
                        Err(error) => return Err(mapped_error(error.into(), statement.start_chars, prefix.chars().count() as u32)),
                    }
                }
                let (rows, count, limited) = read(&owner.client, statement.text, &meta, cap).await.map_err(|e| mapped_error(e, statement.start_chars, 0))?;
                match sql::transaction_control(statement.text) {
                    TransactionControl::Start => {
                        in_transaction = true;
                        if owner.transaction_id.is_none() { owner.transaction_id = Some(Uuid::new_v4().to_string()); }
                    }
                    TransactionControl::End => { in_transaction = false; owner.transaction_id = None; owner.transaction_failed = false; }
                    TransactionControl::Chain => { in_transaction = true; owner.transaction_id = Some(Uuid::new_v4().to_string()); owner.transaction_failed = false; }
                    TransactionControl::Unchanged => {},
                }
                if meta.names.is_empty() {
                    results.push(QueryResult::Command(CommandResult { command: sql::leading_words(statement.text, 1).first().cloned().unwrap_or_else(|| "OK".to_owned()), row_count: count }));
                } else {
                    results.push(QueryResult::Data(DataResult { columns: meta.names, column_types: meta.types, column_type_oids: meta.oids, row_count: rows.len() as u64, rows, truncated: false, limited, total_row_count: Some(count) }));
                }
            }
            session.ensure_open()?;
            if owner.cursor.is_none() && in_transaction && owner.transaction_id.is_none() {
                owner.client.batch_execute("COMMIT").await?;
            } else if owner.transaction_id.is_some() {
                owner.client.batch_execute("SET LOCAL idle_in_transaction_session_timeout = '5min'").await?;
            }
            // An explicit BEGIN/COMMIT batch can create a temporary manual ID
            // while running under the implicit wrapper; retain only an actually
            // open user transaction, never an implicit cursor transaction.
            owner.transaction_failed = false;
            Ok(results)
        }.await;
        let results = match outcome {
            Ok(results) => results,
            Err(error) => {
                owner.last_used = Instant::now();
                owner.cursor = None;
                if session.ensure_open().is_err() || owner.client.is_closed() {
                    owner.transaction_id = None;
                }
                if owner.transaction_id.is_some() {
                    owner.transaction_failed = true;
                } else if in_transaction {
                    let _ = owner.client.batch_execute("ROLLBACK").await;
                }
                return Err(with_transaction(error, &owner));
            }
        };
        owner.last_used = Instant::now();
        Ok(QueryResponse {
            results,
            duration_ms: start.elapsed().as_millis() as u64,
            transaction_open: owner.transaction_id.is_some(),
            transaction_id: owner.transaction_id.clone(),
        })
    }

    pub async fn fetch_more(
        &self,
        id: &str,
        tab: &str,
        max_rows: u32,
    ) -> Result<FetchMoreResponse, CoreError> {
        let cap = page_size(max_rows)?;
        let session = self.existing_session(id, tab).await?;
        let mut owner = session
            .owner
            .try_lock()
            .map_err(|_| CoreError::local("This tab already has a running query"))?;
        session.ensure_open()?;
        owner.last_used = Instant::now();
        let mut cursor = owner
            .cursor
            .take()
            .ok_or_else(|| CoreError::local("No more rows are available"))?;
        let outcome: Result<FetchMoreResponse, CoreError> = async {
            let mut rows = cursor.pending.take().into_iter().collect::<Vec<_>>();
            let remaining = cap + 1 - rows.len();
            let (fetched, _, _) = read(
                &owner.client,
                &format!("FETCH FORWARD {remaining} FROM \"{}\"", cursor.name),
                &cursor.metadata,
                remaining,
            )
            .await?;
            rows.extend(fetched);
            // Pending lookahead plus fetched rows must fit the same page budget.
            let bytes = rows
                .iter()
                .map(|row| {
                    std::mem::size_of::<Vec<Value>>()
                        + row.len() * std::mem::size_of::<Value>()
                        + row
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::len)
                            .sum::<usize>()
                })
                .sum::<usize>();
            if bytes > MAX_PAGE_BYTES {
                return Err(CoreError::local(
                    "Result page exceeds 8 MiB; request fewer rows",
                ));
            }
            cursor.pending = if rows.len() > cap { rows.pop() } else { None };
            let truncated = cursor.pending.is_some();
            session.ensure_open()?;
            if truncated {
                owner.cursor = Some(cursor);
            } else {
                owner
                    .client
                    .batch_execute(&format!("CLOSE \"{}\"; COMMIT", cursor.name))
                    .await?;
            }
            Ok(FetchMoreResponse {
                row_count: rows.len() as u64,
                rows,
                truncated,
            })
        }
        .await;
        if outcome.is_err() {
            owner.cursor = None;
            let _ = owner.client.batch_execute("ROLLBACK").await;
        }
        owner.last_used = Instant::now();
        outcome.map_err(|mut error| {
            error.position = None;
            error
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_keep_lossless_text_where_required() {
        assert_eq!(
            cell(Some("9223372036854775807"), 20),
            Value::String("9223372036854775807".to_owned())
        );
        assert_eq!(
            cell(Some("12345678901234567890.123"), 1700),
            Value::String("12345678901234567890.123".to_owned())
        );
        assert_eq!(cell(Some("null"), 3802), Value::String("null".to_owned()));
        assert_eq!(cell(None, 3802), Value::Null);
        assert_eq!(cell(Some("t"), 16), Value::Bool(true));
        assert_eq!(cell(Some("42"), 23), Value::from(42));
        assert_eq!(cell(Some("NaN"), 701), Value::Null);
        assert_eq!(
            cell(Some("\\x0102"), 17),
            Value::String("<bytea 2 bytes>".to_owned())
        );
    }
}
