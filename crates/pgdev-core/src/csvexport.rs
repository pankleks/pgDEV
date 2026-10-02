use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const CHUNK_BYTES: usize = 1024 * 1024;
struct Pending {
    path: PathBuf,
    temporary: tempfile::NamedTempFile,
    expected: Option<[u8; 32]>,
    bytes: u64,
}

/// Streaming, process-local export destinations authorized by native dialogs.
/// The destination is untouched until finish; dropping/aborting removes staging.
#[derive(Default)]
pub struct CsvExports(Mutex<HashMap<String, Pending>>);

fn fingerprint(path: &Path) -> Result<Option<[u8; 32]>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect CSV destination".into()),
        Ok(metadata) => metadata,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        return Err("CSV destination must be a regular file no larger than 1 GiB".into());
    }
    let mut source = fs::File::open(path)
        .map_err(|_| "Could not read CSV destination")?
        .take(MAX_BYTES + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0;
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|_| "Could not read CSV destination")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_BYTES {
            return Err("CSV destination exceeds 1 GiB".into());
        }
        hash.update(&buffer[..count]);
    }
    Ok(Some(hash.finalize().into()))
}

impl CsvExports {
    /// Selected paths come only from the shell's native save dialog.
    pub fn start(&self, selected: &Path) -> Result<String, String> {
        let parent = selected
            .parent()
            .ok_or("Invalid CSV path")?
            .canonicalize()
            .map_err(|_| "Could not locate CSV directory")?;
        let path = parent.join(selected.file_name().ok_or("Invalid CSV file name")?);
        let mut exports = self
            .0
            .lock()
            .map_err(|_| "CSV export registry unavailable")?;
        if exports.len() >= 8 {
            return Err("Too many concurrent CSV exports".into());
        }
        let expected = fingerprint(&path)?;
        let temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "Could not stage CSV export")?;
        let token = uuid::Uuid::new_v4().to_string();
        exports.insert(
            token.clone(),
            Pending {
                path,
                temporary,
                expected,
                bytes: 0,
            },
        );
        Ok(token)
    }

    pub fn append(&self, token: &str, chunk: &str) -> Result<(), String> {
        if chunk.len() > CHUNK_BYTES {
            return Err("CSV chunks are limited to 1 MiB".into());
        }
        let mut exports = self
            .0
            .lock()
            .map_err(|_| "CSV export registry unavailable")?;
        let export = exports
            .get_mut(token)
            .ok_or("Unknown or expired CSV export token")?;
        if export.bytes + chunk.len() as u64 > MAX_BYTES {
            return Err("CSV exports are limited to 1 GiB".into());
        }
        export
            .temporary
            .write_all(chunk.as_bytes())
            .map_err(|_| "Could not write CSV export")?;
        export.bytes += chunk.len() as u64;
        Ok(())
    }

    pub fn finish(&self, token: &str) -> Result<String, String> {
        let mut exports = self
            .0
            .lock()
            .map_err(|_| "CSV export registry unavailable")?;
        let export = exports
            .remove(token)
            .ok_or("Unknown or expired CSV export token")?;
        export
            .temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Could not flush CSV export")?;
        if fingerprint(&export.path)? != export.expected {
            return Err("CSV destination changed during export; it was not overwritten".into());
        }
        if export.expected.is_some() {
            let permissions = fs::metadata(&export.path)
                .map_err(|_| "Could not inspect CSV destination")?
                .permissions();
            if permissions.readonly() {
                return Err("CSV destination is read-only".into());
            }
            export
                .temporary
                .as_file()
                .set_permissions(permissions)
                .map_err(|_| "Could not preserve CSV permissions")?;
            export
                .temporary
                .persist(&export.path)
                .map_err(|_| "Could not replace CSV destination")?;
        } else {
            export
                .temporary
                .persist_noclobber(&export.path)
                .map_err(|_| "Could not create CSV destination; it may already exist")?;
        }
        Ok(export.path.to_string_lossy().into())
    }

    pub fn abort(&self, token: &str) {
        if let Ok(mut exports) = self.0.lock() {
            exports.remove(token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_finish_is_atomic_and_abort_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.csv");
        fs::write(&path, "old").unwrap();
        let exports = CsvExports::default();
        let token = exports.start(&path).unwrap();
        exports.append(&token, "\u{feff}column\n").unwrap();
        exports.append(&token, "😀\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        exports.finish(&token).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}column\n😀\n");
        let token = exports.start(&path).unwrap();
        exports.append(&token, "partial").unwrap();
        exports.abort(&token);
        assert!(exports.append(&token, "late").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}column\n😀\n");
    }
    #[test]
    fn external_changes_and_failed_chunks_do_not_truncate_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.csv");
        let exports = CsvExports::default();
        let token = exports.start(&path).unwrap();
        assert!(exports
            .append(&token, &"x".repeat(CHUNK_BYTES + 1))
            .is_err());
        fs::write(&path, "external").unwrap();
        assert!(exports.finish(&token).unwrap_err().contains("changed"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    }
}
