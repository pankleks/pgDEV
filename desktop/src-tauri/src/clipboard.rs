use tauri_plugin_clipboard_manager::ClipboardExt;

const MAX_BYTES: usize = 8 * 1024 * 1024;

fn validate(content: &str) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Err("Clipboard text is limited to 8 MiB; use CSV export for larger results".into());
    }
    Ok(())
}

/// Write-only, bounded plain text. No clipboard reads or browser fallback.
#[tauri::command]
pub async fn write_clipboard_text(app: tauri::AppHandle, content: String) -> Result<(), String> {
    validate(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard()
            .write_text(content)
            .map_err(|_| "Could not write to the system clipboard".to_owned())
    })
    .await
    .map_err(|_| "Clipboard operation failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_limit_counts_utf8_bytes_not_characters() {
        assert!(validate("").is_ok());
        assert!(validate(&"x".repeat(MAX_BYTES)).is_ok());
        assert!(validate(&"x".repeat(MAX_BYTES + 1)).is_err());
        assert!(validate(&"😀".repeat(MAX_BYTES / 4 + 1)).is_err());
    }
}
