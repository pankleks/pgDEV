#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use pgdev_core::{
    Connected, ConnectionConfig, CoreError, Database, DdlResponse, DdlTarget, FetchMoreResponse,
    QueryRequest, QueryResponse, SchemaData,
};

#[tauri::command]
async fn table_edit_state(
    database: tauri::State<'_, Database>,
    id: String,
    oid: String,
) -> Result<pgdev_core::TableEditState, CoreError> {
    database.table_edit_state(&id, &oid).await
}

#[tauri::command]
async fn table_edit_ddl(
    database: tauri::State<'_, Database>,
    id: String,
    oid: String,
    request: pgdev_core::TableEditRequest,
) -> Result<pgdev_core::TableEditResponse, CoreError> {
    database.table_edit_ddl(&id, &oid, request).await
}

#[tauri::command]
async fn row_update(
    database: tauri::State<'_, Database>,
    request: pgdev_core::RowUpdateRequest,
) -> Result<pgdev_core::RowUpdateResponse, CoreError> {
    database.row_update(request).await
}

#[tauri::command]
async fn connect(
    database: tauri::State<'_, Database>,
    config: ConnectionConfig,
) -> Result<Connected, CoreError> {
    database.connect(config).await
}

#[tauri::command]
async fn disconnect(database: tauri::State<'_, Database>, id: String) -> Result<(), CoreError> {
    database.disconnect(&id).await
}

#[tauri::command]
async fn schema(database: tauri::State<'_, Database>, id: String) -> Result<SchemaData, CoreError> {
    database.schema(&id).await
}

#[tauri::command]
async fn ddl(
    database: tauri::State<'_, Database>,
    id: String,
    target: DdlTarget,
) -> Result<DdlResponse, CoreError> {
    database.ddl(&id, target).await
}

#[tauri::command]
async fn query(
    database: tauri::State<'_, Database>,
    request: QueryRequest,
) -> Result<QueryResponse, CoreError> {
    database.query(request).await
}

#[tauri::command]
async fn fetch_more(
    database: tauri::State<'_, Database>,
    id: String,
    tab_key: String,
    max_rows: u32,
) -> Result<FetchMoreResponse, CoreError> {
    database.fetch_more(&id, &tab_key, max_rows).await
}

#[tauri::command]
async fn cancel(
    database: tauri::State<'_, Database>,
    id: String,
    tab_key: String,
) -> Result<(), CoreError> {
    database.cancel(&id, &tab_key).await
}

#[tauri::command]
async fn close_session(
    database: tauri::State<'_, Database>,
    id: String,
    tab_key: String,
) -> Result<(), CoreError> {
    database.close_session(&id, &tab_key).await
}

fn main() {
    tauri::Builder::default()
        .manage(Database::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            schema,
            ddl,
            row_update,
            table_edit_state,
            table_edit_ddl,
            query,
            fetch_more,
            cancel,
            close_session
        ])
        .run(tauri::generate_context!())
        .expect("Could not start pgDEV");
}
