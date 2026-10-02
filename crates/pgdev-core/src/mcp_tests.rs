use super::*;

async fn call(session: &mut McpSession, method: &str, params: Value) -> Value {
    session
        .handle(
            &json!({"jsonrpc": "2.0", "id": "test", "method": method, "params": params})
                .to_string(),
        )
        .await
        .unwrap()
}
async fn initialize(session: &mut McpSession) -> Value {
    call(session, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})).await
}

#[tokio::test]
async fn protocol_lifecycle_is_client_scoped_and_negotiates_a_supported_version() {
    let service = McpService::new(Database::default());
    let mut first = service.session();
    let mut second = service.session();
    assert_eq!(
        call(&mut first, "tools/list", json!({})).await["error"]["code"],
        -32600
    );
    assert_eq!(
        call(&mut first, "ping", json!({})).await["result"],
        json!({})
    );
    assert_eq!(
        call(&mut first, "initialize", json!({})).await["error"]["code"],
        -32602
    );
    let negotiated = call(&mut first, "initialize", json!({"protocolVersion": "unknown", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})).await;
    assert_eq!(negotiated["result"]["protocolVersion"], PROTOCOL);
    assert_eq!(negotiated["id"], "test");
    assert_eq!(initialize(&mut first).await["error"]["code"], -32600);
    assert_eq!(
        call(&mut second, "tools/list", json!({})).await["error"]["code"],
        -32600
    );
    assert_eq!(
        initialize(&mut second).await["result"]["capabilities"],
        json!({"tools": {}})
    );
}

#[tokio::test]
async fn notifications_never_execute_tools_or_initialize_a_session() {
    let mut session = McpService::new(Database::default()).session();
    for method in [
        "initialize",
        "notifications/initialized",
        "tools/call",
        "notifications/cancelled",
        "unknown",
    ] {
        assert!(session
            .handle(
                &json!({"jsonrpc": "2.0", "method": method, "params": {"name": "get_schema"}})
                    .to_string()
            )
            .await
            .is_none());
    }
    assert!(!session.initialized);
}

#[tokio::test]
async fn malformed_requests_and_batches_are_bounded_and_do_not_echo_input() {
    let mut session = McpService::new(Database::default()).session();
    assert_eq!(
        session.handle("secret malformed").await.unwrap()["error"]["code"],
        -32700
    );
    for input in [
        "[]",
        "null",
        "{}",
        r#"{"jsonrpc":"2.0","method":"ping","id":null}"#,
        r#"{"jsonrpc":"2.0","method":"ping","id":true}"#,
    ] {
        assert_eq!(
            session.handle(input).await.unwrap()["error"]["code"],
            -32600
        );
    }
    let response = session.handle(&"x".repeat(MAX_REQUEST + 1)).await.unwrap();
    assert_eq!(response["error"]["code"], -32600);
    assert!(response.to_string().len() < 200);
    initialize(&mut session).await;
    assert_eq!(
        call(&mut session, "tools/call", json!([])).await["error"]["code"],
        -32602
    );
    assert_eq!(
        call(&mut session, "unknown", json!({})).await["error"]["code"],
        -32601
    );
}

#[tokio::test]
async fn only_catalog_tools_are_advertised_and_connection_arguments_are_rejected() {
    let mut session = McpService::new(Database::default()).session();
    initialize(&mut session).await;
    let listed = call(&mut session, "tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["get_schema", "get_ddl"]
    );
    assert!(tools
        .iter()
        .all(|t| t["annotations"]["readOnlyHint"] == true));
    for (name, args) in [
        ("query", json!({"sql": "DROP TABLE t"})),
        ("get_schema", json!({"id": "secret"})),
        ("get_schema", json!({"connectionString": "secret"})),
        ("get_schema", json!({"schema": 1})),
        ("get_ddl", json!({"type": "table", "schema": "public"})),
        (
            "get_ddl",
            json!({"type": "bad", "schema": "public", "name": "t"}),
        ),
        (
            "get_ddl",
            json!({"type": "table", "schema": "public", "name": "t", "oid": "1;DROP"}),
        ),
    ] {
        let response = call(
            &mut session,
            "tools/call",
            json!({"name": name, "arguments": args}),
        )
        .await;
        assert_eq!(response["error"]["code"], -32602);
        assert!(!response.to_string().contains("secret"));
    }
    let disconnected = call(&mut session, "tools/call", json!({"name": "get_schema"})).await;
    assert_eq!(disconnected["result"]["isError"], true);
    assert!(disconnected["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("not connected"));
}

#[test]
fn active_connection_revisions_detect_switches_even_back_to_the_same_connection() {
    let service = McpService::new(Database::default());
    service.activate("first".into());
    let before = service.active.read().unwrap().clone();
    service.activate("second".into());
    service.disconnected("first");
    assert_eq!(service.active.read().unwrap().id.as_deref(), Some("second"));
    service.activate("first".into());
    assert_ne!(service.active.read().unwrap().revision, before.revision);
    service.disconnected("first");
    assert!(service.active.read().unwrap().id.is_none());
}

#[test]
fn schema_projection_matches_original_filters_and_excludes_internal_metadata() {
    let data: SchemaData = serde_json::from_value(json!({
        "tables": [{"schema": "public", "name": "t", "oid": "1", "columns": [{"name": "id", "type": "integer", "nullable": false, "defaultValue": "7"}], "indexes": [], "constraints": [], "triggers": [], "isPartition": false, "isPartitioned": false, "parents": "", "relkind": "r"}],
        "views": [], "functions": [], "types": [], "sequences": [], "builtins": []
    })).unwrap();
    let result = schema_result(
        data,
        json!({"schema": "public", "table": "t"})
            .as_object()
            .unwrap(),
    );
    assert_eq!(
        result["tables"][0],
        json!({"schema": "public", "name": "t", "columns": [{"name": "id", "type": "integer", "nullable": false, "default": "7"}]})
    );
    assert_eq!(result["truncated"], false);
    assert_eq!(tool_result(result)["isError"], false);
    assert_eq!(
        tool_result(json!({"large": "😀".repeat(MAX_RESULT / 4)}))["isError"],
        true
    );
}
