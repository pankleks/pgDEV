//! An ephemeral PostgreSQL SSL-negotiation probe, not a database emulator.
//! A deliberate authentication error proves that verified TLS reached startup.
//! No external database, trust-store modification or persisted keys are needed.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const PROBE_MESSAGE: &str = "pgdev TLS probe reached PostgreSQL startup";

async fn probe(hostname: &str, trusted: bool, expired: bool) -> (CoreError, bool) {
    let key_pair = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(vec![hostname.to_owned()]).unwrap();
    if expired {
        params.not_before = rcgen::date_time_ymd(2019, 1, 1);
        params.not_after = rcgen::date_time_ymd(2020, 1, 1);
    }
    let cert = params.self_signed(&key_pair).unwrap();
    let pem = cert.pem();
    // Use an independent, portable server implementation; the client under
    // test still uses native-tls and each platform's certificate verifier.
    use tokio_rustls::rustls::{self, pki_types::PrivatePkcs8KeyDer};
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivatePkcs8KeyDer::from(key_pair.serialize_der()).into(),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut ssl_request = [0u8; 8];
            socket.read_exact(&mut ssl_request).await.unwrap();
            assert_eq!(ssl_request, [0, 0, 0, 8, 4, 210, 22, 47]);
            socket.write_all(b"S").await.unwrap();
            let Ok(mut socket) = acceptor.accept(socket).await else {
                return false;
            };
            let Ok(length) = socket.read_u32().await else {
                return false;
            };
            assert!((8..=4096).contains(&length));
            let mut startup = vec![0u8; length as usize - 4];
            if socket.read_exact(&mut startup).await.is_err() {
                return false;
            }
            assert_eq!(&startup[..4], &[0, 3, 0, 0]);
            let fields = format!("SFATAL\0VFATAL\0C28000\0M{PROBE_MESSAGE}\0\0");
            socket.write_u8(b'E').await.unwrap();
            socket.write_u32(fields.len() as u32 + 4).await.unwrap();
            socket.write_all(fields.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            let _ = socket.shutdown().await;
            true
        })
        .await
        .expect("TLS probe server timed out")
    });
    let db = Database::default();
    let input = serde_json::from_value(serde_json::json!({
        "connectionString": format!("postgresql://pgdev_probe@localhost:{port}/pgdev_probe?sslmode=require&hostaddr=127.0.0.1"),
        "tlsCaPem": if trusted { Some(pem) } else { None },
    }))
    .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(10), db.connect(input))
        .await
        .expect("TLS probe client timed out")
        .err()
        .expect("probe must reject authentication");
    (error, server.await.unwrap())
}

#[tokio::test]
async fn custom_ca_accepts_a_matching_self_signed_server_without_disabling_verification() {
    let (error, reached_startup) = probe("localhost", true, false).await;
    assert!(reached_startup);
    assert_eq!(error.code.as_deref(), Some("28000"), "{}", error.message);
    assert_eq!(error.message, PROBE_MESSAGE);
}

#[tokio::test]
async fn custom_ca_does_not_bypass_hostname_verification() {
    let (error, reached_startup) = probe("wrong-host.invalid", true, false).await;
    assert!(!reached_startup);
    assert_ne!(error.message, PROBE_MESSAGE);
    assert!(error.code.is_none());
}

#[tokio::test]
async fn system_trust_rejects_an_untrusted_self_signed_server() {
    let (error, reached_startup) = probe("localhost", false, false).await;
    assert!(!reached_startup);
    assert_ne!(error.message, PROBE_MESSAGE);
    assert!(error.code.is_none());
}

#[tokio::test]
async fn custom_ca_does_not_bypass_certificate_expiry() {
    let (error, reached_startup) = probe("localhost", true, true).await;
    assert!(!reached_startup);
    assert_ne!(error.message, PROBE_MESSAGE);
    assert!(error.code.is_none());
}
