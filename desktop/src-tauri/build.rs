fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect",
            "disconnect",
            "schema",
            "ddl",
            "row_update",
            "table_edit_state",
            "table_edit_ddl",
            "query",
            "fetch_more",
            "cancel",
            "close_session",
            "open_sql_file",
            "save_sql_file",
            "release_sql_file",
        ]),
    ))
    .expect("Could not generate desktop permissions");
}
