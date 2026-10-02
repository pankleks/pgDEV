use super::*;
use pgdev_core::Database;

fn slot(service: &McpService, touched: Instant) -> Arc<Slot> {
    let (cancelled, _) = watch::channel(false);
    Arc::new(Slot {
        session: Mutex::new(service.session()),
        touched: std::sync::Mutex::new(touched),
        cancelled,
    })
}

#[test]
fn lazy_idle_expiry_revokes_removed_sessions_even_without_existing_watchers() {
    let service = McpService::new(Database::default());
    let start = Instant::now();
    let old = slot(&service, start);
    let fresh = slot(&service, start + Duration::from_secs(1));
    let mut sessions =
        HashMap::from([("old".into(), old.clone()), ("fresh".into(), fresh.clone())]);
    expire_sessions(&mut sessions, start + IDLE_TTL);
    assert!(!sessions.contains_key("old"));
    assert!(sessions.contains_key("fresh"));
    assert!(*old.cancelled.subscribe().borrow());
    assert!(!*fresh.cancelled.subscribe().borrow());
}

fn state(permits: usize) -> (Arc<ServerState>, watch::Sender<bool>) {
    let (shutdown, receiver) = watch::channel(false);
    (
        Arc::new(ServerState {
            service: McpService::new(Database::default()),
            authority: "127.0.0.1:12345".into(),
            token: "test-token".into(),
            sessions: Mutex::new(HashMap::new()),
            requests: Semaphore::new(permits),
            shutdown: receiver,
        }),
        shutdown,
    )
}
fn request() -> Request {
    Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "127.0.0.1:12345")
        .header("authorization", "Bearer test-token")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", "test-session")
        .header("mcp-protocol-version", PROTOCOL)
        .body(axum::body::Body::from(
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        ))
        .unwrap()
}

#[tokio::test]
async fn concurrent_work_on_one_session_is_rejected_without_waiting() {
    let (state, _shutdown) = state(16);
    let slot = slot(&state.service, Instant::now());
    state
        .sessions
        .lock()
        .await
        .insert("test-session".into(), slot.clone());
    let _held = slot.session.lock().await;
    assert_eq!(
        respond(state, request()).await.status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn global_request_limit_rejects_excess_work_before_reading_a_body() {
    let (state, _shutdown) = state(0);
    assert_eq!(
        respond(state, request()).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn stopping_revokes_auth_and_interrupts_an_accepted_slow_upload() {
    let (state, shutdown) = state(16);
    state
        .sessions
        .lock()
        .await
        .insert("test-session".into(), slot(&state.service, Instant::now()));
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    let stream = futures_util::stream::poll_fn(move |_| {
        signal.notify_one();
        std::task::Poll::Pending::<Option<Result<axum::body::Bytes, std::io::Error>>>
    });
    let (parts, _) = request().into_parts();
    let request = Request::from_parts(parts, axum::body::Body::from_stream(stream));
    let running_state = state.clone();
    let task = tokio::spawn(async move { handle(State(running_state), request).await });
    tokio::time::timeout(Duration::from_secs(1), started.notified())
        .await
        .unwrap();
    shutdown.send_replace(true);
    let response = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
    assert_eq!(state.requests.available_permits(), 16);
    assert_eq!(
        authenticated(&HeaderMap::new(), &state),
        Err(StatusCode::GONE)
    );
}
