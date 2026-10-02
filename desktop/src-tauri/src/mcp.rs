use pgdev_core::mcp::McpService;
use pgdev_mcp::{Endpoint, RunningServer};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Host(Mutex<Option<RunningServer>>);

#[tauri::command]
pub async fn start_mcp(
    host: tauri::State<'_, Host>,
    service: tauri::State<'_, McpService>,
) -> Result<Endpoint, String> {
    let mut host = host.0.lock().await;
    if let Some(server) = host.as_ref().filter(|server| server.is_running()) {
        return Ok(server.endpoint());
    }
    // Dropping a failed listener revokes its old token and pending requests.
    host.take();
    let server = RunningServer::start(service.inner().clone()).await?;
    let endpoint = server.endpoint();
    *host = Some(server);
    Ok(endpoint)
}

#[tauri::command]
pub async fn stop_mcp(host: tauri::State<'_, Host>) -> Result<(), String> {
    let mut host = host.0.lock().await;
    if let Some(server) = host.take() {
        server.stop().await;
    }
    Ok(())
}
