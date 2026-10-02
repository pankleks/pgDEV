//! Opt-in loopback-only, authenticated MCP Streamable HTTP (JSON responses).
//! No credentials, endpoints, tokens or session identifiers are persisted/logged.
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use pgdev_core::mcp::{McpService, McpSession};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex, Semaphore},
    task::JoinHandle,
};
use uuid::Uuid;

#[cfg(test)]
mod tests;

const PROTOCOL: &str = "2025-06-18";
const MAX_BODY: usize = 64 * 1024;
const MAX_SESSIONS: usize = 8;
const IDLE_TTL: Duration = Duration::from_secs(600);

// Deliberately no Debug: contains the bearer secret.
#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

struct Slot {
    session: Mutex<McpSession>,
    touched: std::sync::Mutex<Instant>,
    cancelled: watch::Sender<bool>,
}
struct ServerState {
    service: McpService,
    authority: String,
    token: String,
    sessions: Mutex<HashMap<String, Arc<Slot>>>,
    requests: Semaphore,
    shutdown: watch::Receiver<bool>,
}

pub struct RunningServer {
    endpoint: Endpoint,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl RunningServer {
    pub async fn start(service: McpService) -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "Could not create MCP authentication token")?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "Could not bind local MCP listener")?;
        let authority = listener
            .local_addr()
            .map_err(|_| "Could not inspect local MCP listener")?
            .to_string();
        let endpoint = Endpoint {
            url: format!("http://{authority}/mcp"),
            token: token.clone(),
        };
        let (shutdown, receiver) = watch::channel(false);
        let state = Arc::new(ServerState {
            service,
            authority,
            token,
            sessions: Mutex::new(HashMap::new()),
            requests: Semaphore::new(16),
            shutdown: receiver.clone(),
        });
        let router = Router::new().fallback(handle).with_state(state);
        let task = tokio::spawn(async move {
            let mut receiver = receiver;
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = receiver.wait_for(|stopping| *stopping).await;
                })
                .await;
        });
        Ok(Self {
            endpoint,
            shutdown,
            task: Some(task),
        })
    }
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint.clone()
    }
    pub fn is_running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }
    pub async fn stop(mut self) {
        let _ = self.shutdown.send(true);
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(Duration::from_secs(5), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}
fn authenticated(headers: &HeaderMap, state: &ServerState) -> Result<(), StatusCode> {
    if *state.shutdown.borrow() {
        return Err(StatusCode::GONE);
    }
    if headers.contains_key("origin") || single_header(headers, "host") != Some(&state.authority) {
        return Err(StatusCode::FORBIDDEN);
    }
    let token =
        single_header(headers, "authorization").and_then(|value| value.strip_prefix("Bearer "));
    if !token.is_some_and(|token| bool::from(token.as_bytes().ct_eq(state.token.as_bytes()))) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if headers.contains_key("mcp-protocol-version")
        && single_header(headers, "mcp-protocol-version") != Some(PROTOCOL)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

async fn handle(State(state): State<Arc<ServerState>>, request: Request) -> Response {
    let mut shutdown = state.shutdown.clone();
    let mut response = tokio::select! {
        biased;
        _ = shutdown.wait_for(|stopping| *stopping) => status(StatusCode::GONE),
        response = tokio::time::timeout(Duration::from_secs(40), respond(state, request)) => response.unwrap_or_else(|_| status(StatusCode::REQUEST_TIMEOUT)),
    };
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if response.status() == StatusCode::UNAUTHORIZED {
        response
            .headers_mut()
            .insert("www-authenticate", HeaderValue::from_static("Bearer"));
    }
    if response.status() == StatusCode::METHOD_NOT_ALLOWED {
        response
            .headers_mut()
            .insert("allow", HeaderValue::from_static("POST, DELETE"));
    }
    response
}

fn expire_sessions(sessions: &mut HashMap<String, Arc<Slot>>, now: Instant) {
    sessions.retain(|_, slot| {
        let touched = *slot.touched.lock().unwrap_or_else(|p| p.into_inner());
        let keep = now.saturating_duration_since(touched) < IDLE_TTL;
        if !keep {
            slot.cancelled.send_replace(true);
        }
        keep
    });
}

async fn respond(state: Arc<ServerState>, request: Request) -> Response {
    if let Err(code) = authenticated(request.headers(), &state) {
        return status(code);
    }
    if request.uri().path() != "/mcp" || request.uri().query().is_some() {
        return status(StatusCode::NOT_FOUND);
    }
    let Ok(_permit) = state.requests.try_acquire() else {
        return status(StatusCode::TOO_MANY_REQUESTS);
    };
    let session_id = single_header(request.headers(), "mcp-session-id").map(str::to_owned);
    if request.headers().contains_key("mcp-session-id") && session_id.is_none() {
        return status(StatusCode::BAD_REQUEST);
    }
    let mut sessions = state.sessions.lock().await;
    expire_sessions(&mut sessions, Instant::now());
    if let Some(id) = &session_id {
        if !sessions.contains_key(id) {
            return status(StatusCode::NOT_FOUND);
        }
        if single_header(request.headers(), "mcp-protocol-version") != Some(PROTOCOL) {
            return status(StatusCode::BAD_REQUEST);
        }
    }
    if request.method() == Method::DELETE {
        let Some(id) = session_id else {
            return status(StatusCode::BAD_REQUEST);
        };
        if let Some(slot) = sessions.remove(&id) {
            slot.cancelled.send_replace(true);
        }
        return status(StatusCode::NO_CONTENT);
    }
    if request.method() != Method::POST {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let existing = match &session_id {
        Some(id) => match sessions.get(id) {
            Some(slot) => Some(slot.clone()),
            None => return status(StatusCode::NOT_FOUND),
        },
        None => None,
    };
    drop(sessions);
    if !single_header(request.headers(), "content-type")
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return status(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let accepts = single_header(request.headers(), "accept")
        .unwrap_or("")
        .split(',')
        .map(|s| s.split(';').next().unwrap_or("").trim())
        .collect::<Vec<_>>();
    if !accepts
        .iter()
        .any(|value| value.eq_ignore_ascii_case("application/json"))
        || !accepts
            .iter()
            .any(|value| value.eq_ignore_ascii_case("text/event-stream"))
    {
        return status(StatusCode::NOT_ACCEPTABLE);
    }
    let body = match tokio::time::timeout(
        Duration::from_secs(5),
        to_bytes(request.into_body(), MAX_BODY),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return status(StatusCode::PAYLOAD_TOO_LARGE),
        Err(_) => return status(StatusCode::REQUEST_TIMEOUT),
    };
    let Ok(input) = std::str::from_utf8(&body) else {
        return status(StatusCode::BAD_REQUEST);
    };
    // This catalog-only server never sends client requests. Unsolicited client
    // responses must be rejected, not answered with another JSON-RPC response.
    if serde_json::from_str::<Value>(input)
        .ok()
        .is_some_and(|value| value.get("result").is_some() || value.get("error").is_some())
    {
        return status(StatusCode::BAD_REQUEST);
    }
    if let Some(slot) = existing {
        let Ok(mut session) = slot.session.try_lock() else {
            return status(StatusCode::CONFLICT);
        };
        *slot.touched.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        let mut cancelled = slot.cancelled.subscribe();
        let reply = tokio::select! {
            biased;
            _ = cancelled.wait_for(|closed| *closed) => return status(StatusCode::NOT_FOUND),
            reply = session.handle(input) => reply,
        };
        return match reply {
            Some(response) => Json(response).into_response(),
            None => status(StatusCode::ACCEPTED),
        };
    }
    // Without a session header only an initialize request is accepted. Parsing
    // and validation happen before reserving a bounded session slot.
    let value: Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(_) => return status(StatusCode::BAD_REQUEST),
    };
    if value.get("method").and_then(Value::as_str) != Some("initialize")
        || value.get("id").is_none()
    {
        return status(StatusCode::BAD_REQUEST);
    }
    let mut session = state.service.session();
    let Some(response) = session.handle(input).await else {
        return status(StatusCode::BAD_REQUEST);
    };
    if response.get("result").is_none() {
        return Json(response).into_response();
    }
    let mut sessions = state.sessions.lock().await;
    if sessions.len() >= MAX_SESSIONS {
        return status(StatusCode::TOO_MANY_REQUESTS);
    }
    let id = Uuid::new_v4().to_string();
    let (cancelled, _) = watch::channel(false);
    sessions.insert(
        id.clone(),
        Arc::new(Slot {
            session: Mutex::new(session),
            touched: std::sync::Mutex::new(Instant::now()),
            cancelled,
        }),
    );
    let mut response = Json(response).into_response();
    response.headers_mut().insert(
        "mcp-session-id",
        HeaderValue::from_str(&id).expect("UUID is a valid header"),
    );
    response
}
