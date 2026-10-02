use futures_util::{StreamExt, TryStreamExt};
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_postgres::{
    error::ErrorPosition, AsyncMessage, CancelToken, Client, Config, SimpleQueryMessage,
};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    pub message: String,
    pub code: Option<String>,
    pub position: Option<u32>,
    pub transaction_open: Option<bool>,
    pub transaction_id: Option<String>,
    pub notices: Vec<crate::DatabaseNotice>,
    pub notices_truncated: bool,
}

impl CoreError {
    pub(crate) fn local(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            position: None,
            transaction_open: None,
            transaction_id: None,
            notices: Vec::new(),
            notices_truncated: false,
        }
    }
}

impl From<tokio_postgres::Error> for CoreError {
    fn from(error: tokio_postgres::Error) -> Self {
        let db = error.as_db_error();
        let message = match db {
            Some(error) => error.message().to_owned(),
            None => {
                let mut message = error.to_string();
                let mut source = std::error::Error::source(&error);
                while let Some(error) = source {
                    let detail = error.to_string();
                    if !message.ends_with(&detail) {
                        message.push_str(": ");
                        message.push_str(&detail);
                    }
                    source = error.source();
                }
                message
            }
        };
        Self {
            message,
            code: db.map(|e| e.code().code().to_owned()),
            position: db.and_then(|e| match e.position() {
                Some(ErrorPosition::Original(position)) => Some(*position),
                _ => None,
            }),
            transaction_open: None,
            transaction_id: None,
            notices: Vec::new(),
            notices_truncated: false,
        }
    }
}

// Do not derive Debug: this object contains credentials.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionConfig {
    pub connection_string: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub ssl: Option<bool>,
    pub tls_ca_pem: Option<String>,
    pub statement_timeout: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub id: String,
    pub pg_version: String,
}

/// Prototype text-protocol result. Deliberately separate from the final grid
/// contract: preserves server text, but does not yet expose type OIDs or cursors.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: u64,
    pub truncated: bool,
}

#[derive(Clone)]
struct Connection {
    config: Config,
    tls: MakeTlsConnector,
    timeout: u32,
    opening: Arc<Mutex<()>>,
    catalog: Arc<CatalogPool>,
}

struct CatalogPool {
    slots: Arc<Semaphore>,
    idle: std::sync::Mutex<Vec<ClientOwner>>,
    active: std::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>,
    closed: AtomicBool,
}

impl CatalogPool {
    fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
            idle: std::sync::Mutex::new(Vec::new()),
            active: std::sync::Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.slots.close();
        for driver in self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
        {
            driver.abort();
        }
        self.idle.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

pub(crate) struct CatalogLease {
    owner: Option<ClientOwner>,
    pool: Arc<CatalogPool>,
    token: String,
    reusable: bool,
    _permit: OwnedSemaphorePermit,
}

impl CatalogLease {
    pub(crate) fn capture_notices(&self) -> crate::notices::NoticeCapture {
        self.owner
            .as_ref()
            .expect("catalog lease owns a client")
            .capture_notices()
    }
    pub(crate) fn client(&self) -> &Client {
        &self
            .owner
            .as_ref()
            .expect("catalog lease owns a client")
            .client
    }
    pub(crate) fn discard(&mut self) {
        self.owner.take();
    }
    pub(crate) fn set_reusable(&mut self, reusable: bool) {
        self.reusable = reusable;
    }
}

impl Drop for CatalogLease {
    fn drop(&mut self) {
        self.pool
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.token);
        if let Some(owner) = self.owner.take() {
            let mut idle = self.pool.idle.lock().unwrap_or_else(|p| p.into_inner());
            if self.reusable
                && !self.pool.closed.load(Ordering::SeqCst)
                && !owner.client.is_closed()
            {
                idle.push(owner);
            }
        }
    }
}

pub(crate) struct ClientOwner {
    pub(crate) client: Client,
    driver: JoinHandle<()>,
    pub(crate) cursor: Option<crate::query::Cursor>,
    pub(crate) transaction_id: Option<String>,
    pub(crate) transaction_failed: bool,
    pub(crate) standard_strings: bool,
    pub(crate) last_used: Instant,
    notices: crate::notices::NoticeSink,
}

impl ClientOwner {
    pub(crate) fn capture_notices(&self) -> crate::notices::NoticeCapture {
        crate::notices::NoticeCapture::begin(&self.notices)
    }
}

impl Drop for ClientOwner {
    fn drop(&mut self) {
        // Terminating the socket also rolls back an open transaction.
        self.driver.abort();
    }
}

pub(crate) struct Session {
    pub(crate) owner: Mutex<ClientOwner>,
    cancel: CancelToken,
    tls: MakeTlsConnector,
    closed: AtomicBool,
    driver_abort: tokio::task::AbortHandle,
}

impl Session {
    fn is_dead(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
            || self
                .owner
                .try_lock()
                .is_ok_and(|owner| owner.client.is_closed())
    }
    pub(crate) fn ensure_open(&self) -> Result<(), CoreError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(CoreError::local("This tab session has been closed"))
        } else {
            Ok(())
        }
    }
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.driver_abort.abort();
    }
}

#[derive(Default)]
struct State {
    connections: HashMap<String, Connection>,
    sessions: HashMap<(String, String), Arc<Session>>,
    generations: HashMap<(String, String), u64>,
}

#[derive(Default)]
pub struct Database {
    state: Arc<Mutex<State>>,
}

fn tls(ca: Option<&str>) -> Result<MakeTlsConnector, CoreError> {
    // Unlike the legacy SSL checkbox, verification is never silently disabled.
    let mut builder = native_tls::TlsConnector::builder();
    if let Some(ca) = ca {
        if ca.len() > 64 * 1024 {
            return Err(CoreError::local("Custom TLS CA is limited to 64 KiB"));
        }
        let ca = ca.trim();
        if !ca.starts_with("-----BEGIN CERTIFICATE-----")
            || !ca.ends_with("-----END CERTIFICATE-----")
            || ca.matches("-----BEGIN CERTIFICATE-----").count() != 1
            || ca.matches("-----END CERTIFICATE-----").count() != 1
        {
            return Err(CoreError::local(
                "Custom TLS CA must contain exactly one PEM certificate",
            ));
        }
        let certificate = native_tls::Certificate::from_pem(ca.as_bytes())
            .map_err(|_| CoreError::local("Invalid custom TLS CA certificate"))?;
        builder.add_root_certificate(certificate);
    }
    let connector = builder
        .build()
        .map_err(|_| CoreError::local("Could not initialize TLS trust configuration"))?;
    Ok(MakeTlsConnector::new(connector))
}

async fn open(
    config: &Config,
    timeout: u32,
    tls: MakeTlsConnector,
) -> Result<ClientOwner, CoreError> {
    let (client, mut connection) = config.connect(tls).await?;
    let notices = crate::notices::NoticeSink::default();
    let sink = notices.clone();
    let driver = tokio::spawn(async move {
        // Query callers receive connection errors through Client. Do not log
        // credentials, SQL or connection strings from driver errors.
        let messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        let mut messages = std::pin::pin!(messages);
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notice(notice)) => sink
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .record(notice),
                Err(_) => break,
                _ => {}
            }
        }
    });
    let mut owner = ClientOwner {
        client,
        driver,
        cursor: None,
        transaction_id: None,
        transaction_failed: false,
        standard_strings: true,
        last_used: Instant::now(),
        notices,
    };
    owner
        .client
        .batch_execute(&format!("SET statement_timeout = {}", timeout * 1000))
        .await?;
    let value: String = owner
        .client
        .query_one("SHOW standard_conforming_strings", &[])
        .await?
        .get(0);
    owner.standard_strings = value == "on";
    Ok(owner)
}

impl Database {
    pub async fn connect(&self, input: ConnectionConfig) -> Result<Connected, CoreError> {
        let timeout = input.statement_timeout.unwrap_or(30);
        if !(1..=600).contains(&timeout) {
            return Err(CoreError::local(
                "statementTimeout must be between 1 and 600 seconds",
            ));
        }
        let mut config = match input.connection_string.filter(|s| !s.is_empty()) {
            Some(uri) => {
                let mut config = uri
                    .parse::<Config>()
                    .map_err(|_| CoreError::local("Invalid PostgreSQL connection string"))?;
                // node-postgres defaults URI connections to plaintext unless
                // SSL is explicitly requested. tokio-postgres defaults to
                // Prefer, which would unexpectedly negotiate self-signed TLS
                // even for existing local connections. Preserve the legacy
                // default, but never downgrade an explicit sslmode.
                if let Ok(uri) = url::Url::parse(&uri) {
                    if !uri.query_pairs().any(|(name, _)| name == "sslmode") {
                        config.ssl_mode(tokio_postgres::config::SslMode::Disable);
                    }
                }
                config
            }
            None => {
                let mut config = Config::new();
                config.host(input.host.as_deref().unwrap_or("localhost"));
                config.port(input.port.unwrap_or(5432));
                if let Some(value) = input.database {
                    config.dbname(&value);
                }
                if let Some(value) = input.user {
                    config.user(&value);
                }
                if let Some(value) = input.password {
                    config.password(value);
                }
                config.ssl_mode(if input.ssl.unwrap_or(false) {
                    tokio_postgres::config::SslMode::Require
                } else {
                    tokio_postgres::config::SslMode::Disable
                });
                config
            }
        };
        config
            .application_name("pgDEV")
            .connect_timeout(Duration::from_secs(10));
        if input.tls_ca_pem.is_some()
            && config.get_ssl_mode() != tokio_postgres::config::SslMode::Require
        {
            return Err(CoreError::local("Custom TLS CA requires sslmode=require (or SSL enabled); plaintext fallback is not allowed"));
        }
        let tls = tls(input.tls_ca_pem.as_deref())?;
        let owner = open(&config, timeout, tls.clone()).await?;
        let row = owner.client.query_one("SHOW server_version", &[]).await?;
        let pg_version: String = row.get(0);
        let version = owner
            .client
            .query_one("SHOW server_version_num", &[])
            .await?;
        let version: String = version.get(0);
        if version.parse::<u32>().unwrap_or(0) < 140000 {
            return Err(CoreError::local("PostgreSQL 14 or newer is required"));
        }
        let id = Uuid::new_v4().to_string();
        self.state.lock().await.connections.insert(
            id.clone(),
            Connection {
                config,
                tls,
                timeout,
                opening: Arc::new(Mutex::new(())),
                catalog: Arc::new(CatalogPool::new()),
            },
        );
        Ok(Connected { id, pg_version })
    }

    pub(crate) async fn catalog_client(&self, id: &str) -> Result<CatalogLease, CoreError> {
        let connection = self
            .state
            .lock()
            .await
            .connections
            .get(id)
            .cloned()
            .ok_or_else(|| CoreError::local("Unknown connection"))?;
        let pool = connection.catalog;
        let permit =
            tokio::time::timeout(Duration::from_secs(10), pool.slots.clone().acquire_owned())
                .await
                .map_err(|_| CoreError::local("All catalog connections are busy"))?
                .map_err(|_| CoreError::local("The connection has been closed"))?;
        if pool.closed.load(Ordering::SeqCst) {
            return Err(CoreError::local("The connection has been closed"));
        }
        let cached = {
            let mut idle = pool.idle.lock().unwrap_or_else(|p| p.into_inner());
            let mut cached = None;
            while let Some(owner) = idle.pop() {
                if !owner.client.is_closed() {
                    cached = Some(owner);
                    break;
                }
            }
            cached
        };
        let owner = match cached {
            Some(owner) => owner,
            None => {
                open(
                    &connection.config,
                    connection.timeout,
                    connection.tls.clone(),
                )
                .await?
            }
        };
        let token = Uuid::new_v4().to_string();
        {
            let mut active = pool.active.lock().unwrap_or_else(|p| p.into_inner());
            if pool.closed.load(Ordering::SeqCst) {
                return Err(CoreError::local("The connection has been closed"));
            }
            active.insert(token.clone(), owner.driver.abort_handle());
        }
        Ok(CatalogLease {
            owner: Some(owner),
            pool,
            token,
            reusable: true,
            _permit: permit,
        })
    }

    pub(crate) async fn session(&self, id: &str, tab: &str) -> Result<Arc<Session>, CoreError> {
        if tab.is_empty() {
            return Err(CoreError::local("A tab key is required"));
        }
        let key = (id.to_owned(), tab.to_owned());
        let connection = {
            let mut state = self.state.lock().await;
            let connection = state
                .connections
                .get(id)
                .ok_or_else(|| CoreError::local("Unknown connection"))?
                .clone();
            if let Some(session) = state.sessions.get(&key) {
                if !session.is_dead() {
                    return Ok(session.clone());
                }
                session.close();
                state.sessions.remove(&key);
            }
            connection
        };
        // Serialize creation per connection, never while holding the global
        // registry lock: a slow connect must not block cancellation elsewhere.
        let _opening = connection.opening.lock().await;
        let generation = {
            let mut state = self.state.lock().await;
            if !state.connections.contains_key(id) {
                return Err(CoreError::local("Unknown connection"));
            }
            if let Some(session) = state.sessions.get(&key) {
                if !session.is_dead() {
                    return Ok(session.clone());
                }
                session.close();
                state.sessions.remove(&key);
            }
            if state
                .sessions
                .keys()
                .filter(|(connection, _)| connection == id)
                .count()
                >= 5
            {
                // Reclaim an unpinned idle slot. User transactions, cursors and
                // active operations must never be evicted to open another tab.
                let idle = state.sessions.iter().find_map(|(key, session)| {
                    if key.0 != id {
                        return None;
                    }
                    let owner = session.owner.try_lock().ok()?;
                    if owner.client.is_closed()
                        || (owner.cursor.is_none() && owner.transaction_id.is_none())
                    {
                        // Mark closed while holding its operation lock, before
                        // another caller can begin using the reclaimed client.
                        session.close();
                        Some(key.clone())
                    } else {
                        None
                    }
                });
                let Some(idle) = idle else {
                    return Err(CoreError::local(
                        "All five query sessions are pinned or busy; close a tab first",
                    ));
                };
                if let Some(session) = state.sessions.remove(&idle) {
                    session.close();
                }
            }
            *state.generations.entry(key.clone()).or_default()
        };
        let owner = open(
            &connection.config,
            connection.timeout,
            connection.tls.clone(),
        )
        .await?;
        let session = Arc::new(Session {
            cancel: owner.client.cancel_token(),
            tls: connection.tls.clone(),
            driver_abort: owner.driver.abort_handle(),
            closed: AtomicBool::new(false),
            owner: Mutex::new(owner),
        });
        let mut state = self.state.lock().await;
        if !state.connections.contains_key(id) || state.generations.get(&key) != Some(&generation) {
            session.close();
            return Err(CoreError::local(
                "The connection or tab was closed while connecting",
            ));
        }
        state.sessions.insert(key.clone(), session.clone());
        self.reap_idle(key, &session);
        Ok(session)
    }

    fn reap_idle(&self, key: (String, String), session: &Arc<Session>) {
        let session = Arc::downgrade(session);
        let state = Arc::downgrade(&self.state);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(300)).await;
                let (Some(session), Some(state)) = (session.upgrade(), state.upgrade()) else {
                    return;
                };
                let Ok(owner) = session.owner.try_lock() else {
                    continue;
                };
                if owner.last_used.elapsed() < Duration::from_secs(300) {
                    continue;
                }
                let mut state = state.lock().await;
                if state
                    .sessions
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    state.sessions.remove(&key);
                    session.close();
                }
                return;
            }
        });
    }

    pub(crate) async fn existing_session(
        &self,
        id: &str,
        tab: &str,
    ) -> Result<Arc<Session>, CoreError> {
        self.state
            .lock()
            .await
            .sessions
            .get(&(id.to_owned(), tab.to_owned()))
            .cloned()
            .ok_or_else(|| CoreError::local("Unknown query session"))
    }

    pub async fn query_text(
        &self,
        id: &str,
        tab: &str,
        sql: &str,
    ) -> Result<Vec<TextResult>, CoreError> {
        let session = self.session(id, tab).await?;
        let mut owner = session
            .owner
            .try_lock()
            .map_err(|_| CoreError::local("This tab already has a running query"))?;
        session.ensure_open()?;
        owner.last_used = Instant::now();
        if owner.cursor.is_some() || owner.transaction_id.is_some() {
            return Err(CoreError::local(
                "Use the typed query API for this active transaction or cursor",
            ));
        }
        let messages = owner.client.simple_query_raw(sql).await?;
        let mut messages = std::pin::pin!(messages);
        let mut results = Vec::new();
        let mut current = TextResult {
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
        };
        let mut retained_rows = 0;
        let mut retained_bytes = 0;
        while let Some(message) = messages.try_next().await? {
            match message {
                SimpleQueryMessage::RowDescription(columns) => {
                    current.columns = columns.iter().map(|c| c.name().to_owned()).collect();
                }
                SimpleQueryMessage::Row(row) => {
                    let bytes: usize = (0..row.len())
                        .filter_map(|i| row.get(i))
                        .map(str::len)
                        .sum();
                    if retained_rows < 500 && retained_bytes + bytes <= 8 * 1024 * 1024 {
                        current.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(str::to_owned))
                                .collect(),
                        );
                        retained_rows += 1;
                        retained_bytes += bytes;
                    } else {
                        current.truncated = true;
                    }
                }
                SimpleQueryMessage::CommandComplete(count) => {
                    current.row_count = count;
                    results.push(current);
                    current = TextResult {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        row_count: 0,
                        truncated: false,
                    };
                }
                _ => {}
            }
        }
        Ok(results)
    }

    pub async fn cancel(&self, id: &str, tab: &str) -> Result<(), CoreError> {
        let session = self
            .state
            .lock()
            .await
            .sessions
            .get(&(id.to_owned(), tab.to_owned()))
            .cloned()
            .ok_or_else(|| CoreError::local("Unknown query session"))?;
        // Separate socket: cancellation must not wait for the query mutex.
        session.cancel.cancel_query(session.tls.clone()).await?;
        Ok(())
    }

    pub async fn close_session(&self, id: &str, tab: &str) -> Result<(), CoreError> {
        let key = (id.to_owned(), tab.to_owned());
        let session = {
            let mut state = self.state.lock().await;
            *state.generations.entry(key.clone()).or_default() += 1;
            state.sessions.remove(&key)
        };
        if let Some(session) = session {
            session.close();
        }
        Ok(())
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), CoreError> {
        let sessions = {
            let mut state = self.state.lock().await;
            let connection = state
                .connections
                .remove(id)
                .ok_or_else(|| CoreError::local("Unknown connection"))?;
            connection.catalog.close();
            state
                .generations
                .retain(|(connection, _), _| connection != id);
            let keys: Vec<_> = state
                .sessions
                .keys()
                .filter(|(connection, _)| connection == id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| state.sessions.remove(&key))
                .collect::<Vec<_>>()
        };
        for session in sessions {
            session.close();
        }
        Ok(())
    }
}
