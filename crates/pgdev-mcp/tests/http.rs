use pgdev_core::{mcp::McpService, Database};
use pgdev_mcp::{Endpoint, RunningServer};
use reqwest::{Client, Response, StatusCode};
use serde_json::{json, Value};
use std::time::Duration;

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}
fn init() -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
}
fn request(client: &Client, endpoint: &Endpoint) -> reqwest::RequestBuilder {
    client
        .post(&endpoint.url)
        .bearer_auth(&endpoint.token)
        .header("accept", "application/json, text/event-stream")
}
async fn start() -> RunningServer {
    RunningServer::start(McpService::new(Database::default()))
        .await
        .unwrap()
}
async fn initialize(client: &Client, endpoint: &Endpoint) -> String {
    let response = request(client, endpoint)
        .json(&init())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let id = response.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        response.json::<Value>().await.unwrap()["result"]["protocolVersion"],
        "2025-06-18"
    );
    id
}
async fn call(client: &Client, endpoint: &Endpoint, session: &str, body: Value) -> Response {
    request(client, endpoint)
        .header("mcp-session-id", session)
        .header("mcp-protocol-version", "2025-06-18")
        .json(&body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn authenticated_json_mcp_lifecycle_and_catalog_only_tools_work_over_http() {
    let server = start().await;
    let endpoint = server.endpoint();
    let client = client();
    assert!(endpoint.url.starts_with("http://127.0.0.1:"));
    assert_eq!(endpoint.token.len(), 64);
    let session = initialize(&client, &endpoint).await;
    let notification = call(
        &client,
        &endpoint,
        &session,
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;
    assert_eq!(notification.status(), StatusCode::ACCEPTED);
    assert!(notification.bytes().await.unwrap().is_empty());
    let listed = call(
        &client,
        &endpoint,
        &session,
        json!({"jsonrpc": "2.0", "id": "list", "method": "tools/list"}),
    )
    .await
    .json::<Value>()
    .await
    .unwrap();
    assert_eq!(listed["id"], "list");
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 2);
    let catalog = call(&client, &endpoint, &session, json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_schema"}})).await.json::<Value>().await.unwrap();
    assert_eq!(catalog["result"]["isError"], true);
    assert!(catalog["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("not connected"));
    let query = call(&client, &endpoint, &session, json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "query", "arguments": {"sql": "DROP TABLE t"}}})).await.json::<Value>().await.unwrap();
    assert_eq!(query["error"]["code"], -32602);
    assert_eq!(
        call(
            &client,
            &endpoint,
            &session,
            json!({"jsonrpc": "2.0", "id": 5, "result": {}})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    server.stop().await;
}

#[tokio::test]
async fn tokens_origins_authority_and_duplicate_security_headers_are_checked_before_body_parsing() {
    let server = start().await;
    let endpoint = server.endpoint();
    let client = client();
    let no_token = client
        .post(&endpoint.url)
        .body("bad-json")
        .send()
        .await
        .unwrap();
    assert_eq!(no_token.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(no_token.headers()["www-authenticate"], "Bearer");
    let bad_token = client
        .post(&endpoint.url)
        .bearer_auth("wrong")
        .body("bad-json")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_token.status(), StatusCode::UNAUTHORIZED);
    for origin in ["null", "https://example.com", "http://127.0.0.1"] {
        assert_eq!(
            request(&client, &endpoint)
                .header("origin", origin)
                .json(&init())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        request(&client, &endpoint)
            .header("host", "evil.invalid")
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&client, &endpoint)
            .header("authorization", "Bearer wrong")
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{}?token={}", endpoint.url, endpoint.token))
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    server.stop().await;
}

#[tokio::test]
async fn sessions_are_isolated_bounded_and_deleted_sessions_cannot_be_reused() {
    let server = start().await;
    let endpoint = server.endpoint();
    let client = client();
    let mut sessions = Vec::new();
    for _ in 0..8 {
        sessions.push(initialize(&client, &endpoint).await);
    }
    assert_ne!(sessions[0], sessions[1]);
    assert_eq!(
        request(&client, &endpoint)
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let removed = client
        .delete(&endpoint.url)
        .bearer_auth(&endpoint.token)
        .header("mcp-session-id", &sessions[0])
        .header("mcp-protocol-version", "2025-06-18")
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        call(
            &client,
            &endpoint,
            &sessions[0],
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let replacement = initialize(&client, &endpoint).await;
    assert!(!sessions.contains(&replacement));
    assert_eq!(
        call(&client, &endpoint, &sessions[1], init())
            .await
            .json::<Value>()
            .await
            .unwrap()["error"]["code"],
        -32600
    );
    server.stop().await;
}

#[tokio::test]
async fn missing_session_protocol_media_type_and_oversized_bodies_are_rejected() {
    let server = start().await;
    let endpoint = server.endpoint();
    let client = client();
    let session = initialize(&client, &endpoint).await;
    assert_eq!(
        request(&client, &endpoint)
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&client, &endpoint)
            .header("mcp-session-id", &session)
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&client, &endpoint)
            .header("mcp-protocol-version", "wrong")
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&client, &endpoint)
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        client
            .post(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .header("accept", "application/json")
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_ACCEPTABLE
    );
    assert_eq!(
        request(&client, &endpoint)
            .header("content-type", "application/json")
            .body("x".repeat(65537))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        request(&client, &endpoint)
            .header("content-type", "application/json")
            .body(vec![0xff])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let invalid = request(&client, &endpoint)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        .send()
        .await
        .unwrap();
    assert!(invalid.headers().get("mcp-session-id").is_none());
    server.stop().await;
}

#[tokio::test]
async fn no_sse_or_cors_endpoint_is_exposed_and_restarting_revokes_tokens() {
    let server = start().await;
    let endpoint = server.endpoint();
    let client = client();
    let session = initialize(&client, &endpoint).await;
    assert_eq!(
        client
            .get(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        client
            .request(reqwest::Method::OPTIONS, &endpoint.url)
            .header("origin", "https://example.com")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    server.stop().await;
    assert!(client
        .post(&endpoint.url)
        .bearer_auth(&endpoint.token)
        .json(&init())
        .send()
        .await
        .is_err());
    let replacement = start().await;
    let new = replacement.endpoint();
    assert_ne!(new.token, endpoint.token);
    assert_eq!(
        client
            .post(&new.url)
            .bearer_auth(&endpoint.token)
            .json(&init())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &client,
            &new,
            &session,
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    replacement.stop().await;
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL server via PGDEV_TEST_URL"]
async fn http_catalog_reads_use_the_active_application_connection_and_preserve_its_transaction() {
    use pgdev_core::{ConnectionConfig, QueryRequest};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    let uri = std::env::var("PGDEV_TEST_URL")
        .ok()
        .or_else(|| {
            dotenvy::from_path_iter(root)
                .ok()?
                .filter_map(Result::ok)
                .find_map(|(key, value)| (key == "PGDEV_TEST_URL").then_some(value))
        })
        .expect("Live tests require PGDEV_TEST_URL");
    let config: ConnectionConfig =
        serde_json::from_value(json!({"connectionString": uri, "statementTimeout": 5})).unwrap();
    let database = Database::default();
    let connection = database.connect(config).await.unwrap();
    let service = McpService::new(database.clone());
    service.activate(connection.id.clone());
    let query = |sql: &str, transaction_id: Option<String>| QueryRequest {
        id: connection.id.clone(),
        tab_key: "http-owner".into(),
        sql: sql.into(),
        transaction_id,
        max_rows: 10,
    };
    let transaction = database
        .query(query("BEGIN; SELECT 1", None))
        .await
        .unwrap()
        .transaction_id
        .unwrap();
    let server = RunningServer::start(service.clone()).await.unwrap();
    let endpoint = server.endpoint();
    let client = client();
    let session = initialize(&client, &endpoint).await;
    let ddl = call(&client, &endpoint, &session, json!({"jsonrpc": "2.0", "id": "ddl", "method": "tools/call", "params": {"name": "get_ddl", "arguments": {"type": "table", "schema": "pg_catalog", "name": "pg_class"}}})).await.json::<Value>().await.unwrap();
    assert_eq!(ddl["result"]["isError"], false);
    let content: Value =
        serde_json::from_str(ddl["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(content["ddl"].as_str().unwrap().contains("CREATE TABLE"));
    let preserved = database
        .query(query("SELECT 2", Some(transaction.clone())))
        .await
        .unwrap();
    assert_eq!(
        preserved.transaction_id.as_deref(),
        Some(transaction.as_str())
    );
    service.disconnected(&connection.id);
    let result = call(&client, &endpoint, &session, json!({"jsonrpc": "2.0", "id": "disconnected", "method": "tools/call", "params": {"name": "get_schema"}})).await.json::<Value>().await.unwrap();
    assert_eq!(result["result"]["isError"], true);
    assert!(result["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("not connected"));
    server.stop().await;
    database.disconnect(&connection.id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires npm dependencies for the official MCP SDK integration oracle"]
async fn official_mcp_sdk_negotiates_lists_calls_and_terminates_a_session() {
    let server = start().await;
    let endpoint = server.endpoint();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg("test/native-mcp-http-client.mjs")
            .current_dir(root)
            .env("PGDEV_MCP_TEST_URL", endpoint.url)
            .env("PGDEV_MCP_TEST_TOKEN", endpoint.token)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    server.stop().await;
    assert!(
        output.status.success(),
        "Official MCP SDK integration failed (details suppressed to protect the token)"
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"tools": ["get_schema", "get_ddl"], "disconnected": true})
    );
}
