use pgdev_core::{ConnectionConfig, Database, QueryRequest, QueryResponse, QueryResult};
use serde_json::json;
use std::{sync::Arc, time::Duration};

fn config(value: serde_json::Value) -> ConnectionConfig {
    serde_json::from_value(value).expect("valid connection config")
}

fn live_config() -> ConnectionConfig {
    // The ignored suite is opt-in and never prints the connection string.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    // Parse .env without mutating process-wide environment while tests run
    // concurrently. Never print the URI or modify the real configuration.
    let uri = std::env::var("PGDEV_TEST_URL")
        .ok()
        .or_else(|| {
            dotenvy::from_path_iter(path)
                .ok()?
                .filter_map(Result::ok)
                .find_map(|(name, value)| (name == "PGDEV_TEST_URL").then_some(value))
        })
        .expect("Live tests require PGDEV_TEST_URL in the environment or root .env");
    config(json!({ "connectionString": uri, "statementTimeout": 5 }))
}

#[tokio::test]
async fn rejects_invalid_timeout_before_connecting() {
    let db = Database::default();
    for seconds in [0, 601, u32::MAX] {
        let error = db
            .connect(config(json!({ "statementTimeout": seconds })))
            .await
            .err()
            .unwrap();
        assert!(error.message.contains("statementTimeout"));
    }
}

#[tokio::test]
async fn rejects_invalid_uri_without_exposing_credentials() {
    let db = Database::default();
    let error = db
        .connect(config(json!({ "connectionString": "not-a-uri-secret" })))
        .await
        .err()
        .unwrap();
    assert_eq!(error.message, "Invalid PostgreSQL connection string");
}

#[tokio::test]
async fn unknown_connections_and_sessions_fail_cleanly() {
    let db = Database::default();
    assert!(db.query_text("missing", "tab", "SELECT 1").await.is_err());
    assert!(db.cancel("missing", "tab").await.is_err());
    assert!(db.disconnect("missing").await.is_err());
    db.close_session("missing", "tab").await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn raw_values_empty_results_and_batch_framing() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let results = db.query_text(&connection.id, "values", "SELECT 9223372036854775807::bigint AS big, 12345678901234567890.123::numeric AS precise, NULL::text AS absent, '{\"value\":9223372036854775807}'::json AS doc, ARRAY[1,2] AS numbers; SELECT 1 AS empty WHERE false;").await.unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[0].rows[0][0].as_deref(),
        Some("9223372036854775807")
    );
    assert_eq!(
        results[0].rows[0][1].as_deref(),
        Some("12345678901234567890.123")
    );
    assert_eq!(results[0].rows[0][2], None);
    assert_eq!(
        results[0].rows[0][3].as_deref(),
        Some("{\"value\":9223372036854775807}")
    );
    assert_eq!(results[0].rows[0][4].as_deref(), Some("{1,2}"));
    assert_eq!(results[1].columns, ["empty"]);
    assert!(results[1].rows.is_empty());
    db.disconnect(&connection.id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn transaction_survives_runs_and_tabs_are_isolated() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    // Temporary tables avoid creating or modifying persistent user objects.
    db.query_text(
        id,
        "first",
        "CREATE TEMP TABLE pgdev_native_probe (value integer)",
    )
    .await
    .unwrap();
    db.query_text(
        id,
        "first",
        "BEGIN; INSERT INTO pgdev_native_probe VALUES (7);",
    )
    .await
    .unwrap();
    let rows = db
        .query_text(id, "first", "SELECT value FROM pgdev_native_probe")
        .await
        .unwrap();
    assert_eq!(rows[0].rows[0][0].as_deref(), Some("7"));
    let error = db
        .query_text(id, "other", "SELECT value FROM pgdev_native_probe")
        .await
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("42P01"));
    db.query_text(id, "first", "ROLLBACK").await.unwrap();
    let rows = db
        .query_text(id, "first", "SELECT value FROM pgdev_native_probe")
        .await
        .unwrap();
    assert!(rows[0].rows.is_empty());
    db.close_session(id, "first").await.unwrap();
    let error = db
        .query_text(id, "first", "SELECT value FROM pgdev_native_probe")
        .await
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("42P01"));
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn preview_limits_and_error_position() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let results = db
        .query_text(&connection.id, "limits", "SELECT generate_series(1, 501)")
        .await
        .unwrap();
    assert_eq!(results[0].rows.len(), 500);
    assert_eq!(results[0].row_count, 501);
    assert!(results[0].truncated);
    let error = db
        .query_text(&connection.id, "limits", "SELECT FROM")
        .await
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("42601"));
    assert!(error.position.is_some());
    db.disconnect(&connection.id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn cancellation_does_not_wait_for_query_mutex() {
    let db = Arc::new(Database::default());
    let connection = db.connect(live_config()).await.unwrap();
    let id = connection.id;
    // Create the session before starting the cancellable operation.
    db.query_text(&id, "cancel", "SELECT 1").await.unwrap();
    let query_db = db.clone();
    let query_id = id.clone();
    let task = tokio::spawn(async move {
        query_db
            .query_text(&query_id, "cancel", "SELECT pg_sleep(30)")
            .await
    });
    // Observe the server, rather than relying on a fixed timing assumption.
    let mut started = false;
    for _ in 0..100 {
        let status = db.query_text(&id, "observer", "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pgDEV' AND query = 'SELECT pg_sleep(30)' AND wait_event = 'PgSleep'").await.unwrap();
        if status[0].rows[0][0].as_deref() != Some("0") {
            started = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(started, "query did not reach pg_sleep");
    let busy = db
        .query_text(&id, "cancel", "SELECT 2")
        .await
        .err()
        .unwrap();
    assert!(busy.message.contains("running query"));
    db.cancel(&id, "cancel").await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.err().unwrap().code.as_deref(), Some("57014"));
    db.query_text(&id, "cancel", "SELECT 3").await.unwrap();
    db.disconnect(&id).await.unwrap();
}

fn request(
    id: &str,
    tab: &str,
    sql: &str,
    transaction_id: Option<&str>,
    max_rows: u32,
) -> QueryRequest {
    QueryRequest {
        id: id.to_owned(),
        tab_key: tab.to_owned(),
        sql: sql.to_owned(),
        transaction_id: transaction_id.map(str::to_owned),
        max_rows,
    }
}

fn data(response: &QueryResponse, index: usize) -> &pgdev_core::DataResult {
    match &response.results[index] {
        QueryResult::Data(data) => data,
        _ => panic!("expected data result"),
    }
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn notices_preserve_order_fields_errors_and_transaction_identity() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db.query(request(id,"notices",r#"DO $$ BEGIN
      RAISE NOTICE 'first ą😀';
      RAISE WARNING USING MESSAGE = 'second', ERRCODE = '01000', DETAIL = 'diagnostic detail', HINT = 'diagnostic hint';
    END $$; SELECT 7 AS value"#,None,500)).await.unwrap();
    assert_eq!(response.notices.len(), 2);
    assert_eq!(response.notices[0].message, "first ą😀");
    assert_eq!(response.notices[0].severity, "NOTICE");
    assert_eq!(response.notices[1].severity, "WARNING");
    assert_eq!(response.notices[1].code, "01000");
    assert_eq!(
        response.notices[1].detail.as_deref(),
        Some("diagnostic detail")
    );
    assert_eq!(response.notices[1].hint.as_deref(), Some("diagnostic hint"));
    assert!(response.notices[1]
        .context
        .as_ref()
        .unwrap()
        .contains("PL/pgSQL"));
    assert!(!response.notices_truncated);
    assert_eq!(data(&response, 1).rows[0][0], json!(7));
    let response = db
        .query(request(id, "notices", "SELECT 8", None, 500))
        .await
        .unwrap();
    assert!(response.notices.is_empty());
    let transaction = db
        .query(request(id, "notices", "BEGIN", None, 500))
        .await
        .unwrap()
        .transaction_id
        .unwrap();
    let error = db
        .query(request(
            id,
            "notices",
            r#"DO $$ BEGIN RAISE NOTICE 'before failure'; RAISE EXCEPTION 'broken'; END $$"#,
            Some(&transaction),
            500,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("P0001"));
    assert_eq!(error.notices.len(), 1);
    assert_eq!(error.notices[0].message, "before failure");
    assert_eq!(error.transaction_id.as_deref(), Some(transaction.as_str()));
    assert_eq!(error.transaction_open, Some(true));
    db.query(request(id, "notices", "ROLLBACK", Some(&transaction), 500))
        .await
        .unwrap();
    let (a,b) = tokio::join!(
        db.query(request(id,"notice_a","DO $$ BEGIN RAISE NOTICE 'alpha'; PERFORM pg_sleep(0.05); RAISE NOTICE 'alpha second'; END $$",None,500)),
        db.query(request(id,"notice_b","DO $$ BEGIN RAISE NOTICE 'beta'; END $$",None,500))
    );
    assert_eq!(
        a.unwrap()
            .notices
            .iter()
            .map(|n| n.message.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "alpha second"]
    );
    assert_eq!(b.unwrap().notices[0].message, "beta");
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn cursor_fetches_capture_only_new_notices_and_floods_are_bounded() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    db.query(request(id,"notice_pages",r#"CREATE TEMP TABLE pgdev_notice_fixture(n integer);
      CREATE FUNCTION pg_temp.notice_row(i integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'row %',i; RETURN i; END $$"#,None,500)).await.unwrap();
    let response = db
        .query(request(
            id,
            "notice_pages",
            "SELECT pg_temp.notice_row(i) FROM generate_series(1,5) AS g(i)",
            None,
            1,
        ))
        .await
        .unwrap();
    let mut rows = data(&response, 0).rows.clone();
    let mut messages = response
        .notices
        .into_iter()
        .map(|n| n.message)
        .collect::<Vec<_>>();
    assert!(db
        .query(request(id, "other_notice_tab", "SELECT 1", None, 1))
        .await
        .unwrap()
        .notices
        .is_empty());
    let mut more = true;
    while more {
        let page = db.fetch_more(id, "notice_pages", 1).await.unwrap();
        more = page.truncated;
        rows.extend(page.rows);
        messages.extend(page.notices.into_iter().map(|n| n.message));
    }
    assert_eq!(messages, ["row 1", "row 2", "row 3", "row 4", "row 5"]);
    assert_eq!(rows.len(), 5);
    let flood = db
        .query(request(
            id,
            "notice_pages",
            "DO $$ BEGIN FOR i IN 1..1005 LOOP RAISE NOTICE 'item %',i; END LOOP; END $$",
            None,
            500,
        ))
        .await
        .unwrap();
    assert_eq!(flood.notices.len(), 1000);
    assert!(flood.notices_truncated);
    let clean = db
        .query(request(id, "notice_pages", "SELECT 1", None, 500))
        .await
        .unwrap();
    assert!(clean.notices.is_empty());
    assert!(!clean.notices_truncated);
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn typed_cursor_pages_have_no_gaps_and_preserve_types() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db
        .query(request(
            id,
            "paged",
            "SELECT generate_series(1, 7) AS n",
            None,
            3,
        ))
        .await
        .unwrap();
    let grid = data(&response, 0);
    assert_eq!(grid.column_types, ["integer"]);
    assert_eq!(grid.column_type_oids, [23]);
    assert_eq!(
        grid.rows,
        vec![vec![json!(1)], vec![json!(2)], vec![json!(3)]]
    );
    assert!(grid.truncated);
    assert!(!response.transaction_open);
    let more = db.fetch_more(id, "paged", 2).await.unwrap();
    assert_eq!(more.rows, vec![vec![json!(4)], vec![json!(5)]]);
    assert!(more.truncated);
    let last = db.fetch_more(id, "paged", 4).await.unwrap();
    assert_eq!(last.rows, vec![vec![json!(6)], vec![json!(7)]]);
    assert!(!last.truncated);
    assert!(db.fetch_more(id, "paged", 2).await.is_err());
    let empty = db
        .query(request(
            id,
            "paged",
            "SELECT 1::integer AS empty WHERE false",
            None,
            2,
        ))
        .await
        .unwrap();
    assert_eq!(data(&empty, 0).columns, ["empty"]);
    assert_eq!(data(&empty, 0).column_types, ["integer"]);
    assert!(data(&empty, 0).rows.is_empty());
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn only_last_result_is_pageable_and_rerun_closes_old_cursor() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db
        .query(request(
            id,
            "batch",
            "SELECT generate_series(1, 5); SELECT generate_series(10, 14)",
            None,
            2,
        ))
        .await
        .unwrap();
    assert!(data(&response, 0).limited);
    assert!(!data(&response, 0).truncated);
    assert_eq!(data(&response, 0).total_row_count, Some(5));
    assert!(data(&response, 1).truncated);
    let response = db
        .query(request(id, "batch", "SELECT 99 AS n", None, 2))
        .await
        .unwrap();
    assert_eq!(data(&response, 0).rows, vec![vec![json!(99)]]);
    assert!(db.fetch_more(id, "batch", 2).await.is_err());
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn manual_transaction_requires_identity_and_recovers_after_error() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db.query(request(id, "manual", "CREATE TEMP TABLE pgdev_typed_probe (n integer); BEGIN; INSERT INTO pgdev_typed_probe VALUES (7)", None, 2)).await.unwrap();
    let transaction = response.transaction_id.as_deref().unwrap();
    let mismatch = db
        .query(request(
            id,
            "manual",
            "INSERT INTO pgdev_typed_probe VALUES (8)",
            None,
            2,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(mismatch.code.as_deref(), Some("TRANSACTION_CHANGED"));
    assert_eq!(mismatch.transaction_id.as_deref(), Some(transaction));
    let response = db
        .query(request(
            id,
            "manual",
            "SELECT n FROM pgdev_typed_probe; SELECT generate_series(1, 4)",
            Some(transaction),
            2,
        ))
        .await
        .unwrap();
    assert_eq!(data(&response, 0).rows, vec![vec![json!(7)]]);
    assert!(data(&response, 1).limited);
    assert!(!data(&response, 1).truncated);
    let error = db
        .query(request(id, "manual", "SELECT 1 / 0", Some(transaction), 2))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("22012"));
    assert_eq!(error.transaction_open, Some(true));
    assert_eq!(error.transaction_id.as_deref(), Some(transaction));
    let rollback = db
        .query(request(id, "manual", "ROLLBACK", Some(transaction), 2))
        .await
        .unwrap();
    assert!(!rollback.transaction_open);
    let response = db
        .query(request(
            id,
            "manual",
            "SELECT n FROM pgdev_typed_probe",
            None,
            2,
        ))
        .await
        .unwrap();
    assert!(data(&response, 0).rows.is_empty());
    let mismatch = db
        .query(request(id, "manual", "SELECT 1", Some(transaction), 2))
        .await
        .err()
        .unwrap();
    assert_eq!(mismatch.code.as_deref(), Some("TRANSACTION_CHANGED"));
    assert_eq!(mismatch.transaction_open, Some(false));
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn failed_implicit_batch_rolls_back_and_global_positions_count_unicode() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    db.query(request(
        id,
        "atomic",
        "CREATE TEMP TABLE pgdev_atomic_probe (n integer)",
        None,
        2,
    ))
    .await
    .unwrap();
    let error = db
        .query(request(
            id,
            "atomic",
            "INSERT INTO pgdev_atomic_probe VALUES (1); SELECT 1 / 0",
            None,
            2,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(error.transaction_open, Some(false));
    let response = db
        .query(request(
            id,
            "atomic",
            "SELECT n FROM pgdev_atomic_probe",
            None,
            2,
        ))
        .await
        .unwrap();
    assert!(data(&response, 0).rows.is_empty());
    let error = db
        .query(request(
            id,
            "atomic",
            "SELECT 'ą😀';\n SELECT nonexistent_pgdev_native_probe",
            None,
            2,
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(
        error.position,
        Some("SELECT 'ą😀';\n SELECT ".chars().count() as u32 + 1)
    );
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn user_types_and_data_modifying_ctes_execute_once() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db.query(request(id, "types", "CREATE TEMP TABLE pgdev_cte_probe (n integer); CREATE TYPE pg_temp.pgdev_native_enum AS ENUM ('x', 'y'); SELECT 'x'::pg_temp.pgdev_native_enum AS item", None, 2)).await.unwrap();
    assert!(data(&response, 2).column_types[0].ends_with("pgdev_native_enum"));
    assert_eq!(data(&response, 2).rows, vec![vec![json!("x")]]);
    let response = db.query(request(id, "types", "WITH added AS (INSERT INTO pgdev_cte_probe VALUES (1) RETURNING n) SELECT n FROM added", None, 2)).await.unwrap();
    assert_eq!(data(&response, 0).rows, vec![vec![json!(1)]]);
    let response = db
        .query(request(
            id,
            "types",
            "SELECT count(*) FROM pgdev_cte_probe",
            None,
            2,
        ))
        .await
        .unwrap();
    assert_eq!(data(&response, 0).rows, vec![vec![json!("1")]]);
    db.query(request(id, "types", "VACUUM pgdev_cte_probe", None, 2))
        .await
        .unwrap();
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn pinned_sessions_are_not_evicted_and_closed_transactions_are_rolled_back() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    for tab in 0..5 {
        db.query(request(id, &format!("pinned{tab}"), "BEGIN", None, 2))
            .await
            .unwrap();
    }
    let error = db
        .query(request(id, "sixth", "SELECT 1", None, 2))
        .await
        .err()
        .unwrap();
    assert!(error.message.contains("pinned"));
    db.close_session(id, "pinned0").await.unwrap();
    db.query(request(id, "sixth", "SELECT 1", None, 2))
        .await
        .unwrap();
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn settings_batches_page_and_empty_runs_do_not_drop_the_cursor() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db
        .query(request(
            id,
            "settings",
            "SET application_name = 'pgDEV'; SELECT generate_series(1, 3)",
            None,
            1,
        ))
        .await
        .unwrap();
    assert!(data(&response, 1).truncated);
    assert!(db
        .query(request(id, "settings", "-- empty", None, 1))
        .await
        .is_err());
    assert_eq!(
        db.fetch_more(id, "settings", 2).await.unwrap().rows,
        vec![vec![json!(2)], vec![json!(3)]]
    );
    let response = db
        .query(request(
            id,
            "settings",
            "SET standard_conforming_strings = off; SELECT 'a\\\';b' AS value; SELECT 1",
            None,
            1,
        ))
        .await
        .unwrap();
    assert_eq!(data(&response, 1).rows, vec![vec![json!("a';b")]]);
    db.query(request(
        id,
        "settings",
        "RESET standard_conforming_strings",
        None,
        1,
    ))
    .await
    .unwrap();
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn commit_and_chain_rotates_transaction_identity() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let first = db
        .query(request(id, "chain", "BEGIN", None, 1))
        .await
        .unwrap();
    let first_id = first.transaction_id.unwrap();
    let next = db
        .query(request(id, "chain", "COMMIT AND CHAIN", Some(&first_id), 1))
        .await
        .unwrap();
    let next_id = next.transaction_id.unwrap();
    assert_ne!(first_id, next_id);
    let error = db
        .query(request(id, "chain", "SELECT 1", Some(&first_id), 1))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("TRANSACTION_CHANGED"));
    db.query(request(id, "chain", "ROLLBACK", Some(&next_id), 1))
        .await
        .unwrap();
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn cancellation_of_typed_fetch_recovers_the_session() {
    let db = Arc::new(Database::default());
    let connection = db.connect(live_config()).await.unwrap();
    let id = connection.id;
    let response = db
        .query(request(
            &id,
            "typed_cancel",
            "SELECT pg_backend_pid() AS pid",
            None,
            1,
        ))
        .await
        .unwrap();
    let pid = data(&response, 0).rows[0][0].as_i64().unwrap();
    let query_db = db.clone();
    let query_id = id.clone();
    let task = tokio::spawn(async move {
        query_db
            .query(request(
                &query_id,
                "typed_cancel",
                "SELECT pg_sleep(30)",
                None,
                1,
            ))
            .await
    });
    let mut started = false;
    for _ in 0..100 {
        let response = db.query(request(&id, "typed_observer", &format!("SELECT count(*) FROM pg_stat_activity WHERE pid = {pid} AND wait_event = 'PgSleep'"), None, 1)).await.unwrap();
        if data(&response, 0).rows[0][0] != json!("0") {
            started = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(started);
    db.cancel(&id, "typed_cancel").await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.code.as_deref(), Some("57014"));
    assert_eq!(error.transaction_open, Some(false));
    assert!(error.position.is_none());
    db.query(request(&id, "typed_cancel", "SELECT 1", None, 1))
        .await
        .unwrap();
    db.disconnect(&id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn backend_termination_invalidates_old_transaction_identity() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db
        .query(request(
            id,
            "terminated",
            "BEGIN; SELECT pg_backend_pid() AS pid",
            None,
            1,
        ))
        .await
        .unwrap();
    let pid = data(&response, 1).rows[0][0].as_i64().unwrap();
    let transaction = response.transaction_id.unwrap();
    db.query(request(
        id,
        "terminator",
        &format!("SELECT pg_terminate_backend({pid})"),
        None,
        1,
    ))
    .await
    .unwrap();
    let mut ended = false;
    for _ in 0..100 {
        let error = db
            .query(request(id, "terminated", "SELECT 1", Some(&transaction), 1))
            .await
            .err()
            .unwrap();
        if error.transaction_open == Some(false) {
            ended = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ended);
    db.query(request(id, "terminated", "SELECT 1", None, 1))
        .await
        .unwrap();
    db.disconnect(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn utility_results_and_parameter_templates_keep_their_columns() {
    let db = Database::default();
    let connection = db.connect(live_config()).await.unwrap();
    let id = &connection.id;
    let response = db
        .query(request(
            id,
            "utilities",
            "SHOW server_version; EXPLAIN SELECT 1",
            None,
            5,
        ))
        .await
        .unwrap();
    assert_eq!(data(&response, 0).column_types, ["text"]);
    assert_eq!(data(&response, 1).columns, ["QUERY PLAN"]);
    assert!(!data(&response, 1).rows.is_empty());
    let response = db.query(request(id, "utilities", "PREPARE pgdev_native_template(integer) AS SELECT $1 AS n; EXECUTE pgdev_native_template(42); DEALLOCATE pgdev_native_template", None, 5)).await.unwrap();
    assert_eq!(data(&response, 1).column_types, ["integer"]);
    assert_eq!(data(&response, 1).rows, vec![vec![json!(42)]]);
    let response = db.query(request(id, "utilities", "BEGIN; DECLARE pgdev_user_cursor CURSOR FOR SELECT 99 AS n; FETCH FORWARD 1 FROM pgdev_user_cursor; CLOSE pgdev_user_cursor; ROLLBACK", None, 5)).await.unwrap();
    assert_eq!(data(&response, 2).rows, vec![vec![json!(99)]]);
    db.disconnect(id).await.unwrap();
}
