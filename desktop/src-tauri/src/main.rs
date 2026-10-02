#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn start_csv_export(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("CSV result", &["csv"])
            .set_file_name("result.csv")
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "Unsupported CSV path")?;
        app.state::<pgdev_core::CsvExports>().start(&path).map(Some)
    })
    .await
    .map_err(|_| "CSV export operation failed".to_owned())?
}

#[tauri::command]
async fn append_csv_export(
    app: tauri::AppHandle,
    token: String,
    chunk: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<pgdev_core::CsvExports>().append(&token, &chunk)
    })
    .await
    .map_err(|_| "CSV export operation failed".to_owned())?
}

#[tauri::command]
async fn finish_csv_export(app: tauri::AppHandle, token: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<pgdev_core::CsvExports>().finish(&token)
    })
    .await
    .map_err(|_| "CSV export operation failed".to_owned())?
}

#[tauri::command]
async fn abort_csv_export(app: tauri::AppHandle, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<pgdev_core::CsvExports>().abort(&token)
    })
    .await
    .map_err(|_| "CSV export operation failed".to_owned())
}

#[tauri::command]
async fn open_sql_file(app: tauri::AppHandle) -> Result<Option<pgdev_core::OpenSqlFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("SQL/text script", &["sql", "txt", "ddl"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "Unsupported SQL file path")?;
        app.state::<pgdev_core::SqlFiles>().open(&path).map(Some)
    })
    .await
    .map_err(|_| "SQL file operation failed".to_owned())?
}

#[tauri::command]
async fn save_sql_file(
    app: tauri::AppHandle,
    token: Option<String>,
    content: String,
) -> Result<Option<pgdev_core::SqlFileInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(token) = token {
            return app
                .state::<pgdev_core::SqlFiles>()
                .save(&token, &content)
                .map(Some);
        }
        let selected = app
            .dialog()
            .file()
            .add_filter("SQL script", &["sql"])
            .set_file_name("query.sql")
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "Unsupported SQL file path")?;
        app.state::<pgdev_core::SqlFiles>()
            .save_as(&path, &content)
            .map(Some)
    })
    .await
    .map_err(|_| "SQL file operation failed".to_owned())?
}

#[tauri::command]
async fn release_sql_file(app: tauri::AppHandle, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<pgdev_core::SqlFiles>().release(&token)
    })
    .await
    .map_err(|_| "SQL file operation failed".to_owned())
}

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
        .plugin(tauri_plugin_dialog::init())
        .manage(pgdev_core::SqlFiles::default())
        .manage(pgdev_core::CsvExports::default())
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
            close_session,
            open_sql_file,
            save_sql_file,
            release_sql_file,
            start_csv_export,
            append_csv_export,
            finish_csv_export,
            abort_csv_export
        ])
        .run(tauri::generate_context!())
        .expect("Could not start pgDEV");
}
