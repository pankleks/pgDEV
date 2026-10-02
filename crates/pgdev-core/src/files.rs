use crate::{OpenSqlFile, SqlFileInfo};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_HANDLES: usize = 128;

struct Document {
    path: PathBuf,
    fingerprint: [u8; 32],
    bom: bool,
}

/// Only the native dialog layer supplies paths. The WebView receives opaque,
/// process-local tokens; it cannot authorize arbitrary file access by path.
#[derive(Default)]
pub struct SqlFiles {
    documents: Mutex<HashMap<String, Document>>,
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Could not read SQL file")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("SQL file must be a regular file, not a symbolic link".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Could not open SQL file")?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read SQL file")?;
    if bytes.len() > MAX_BYTES {
        return Err("SQL files are limited to 8 MiB".into());
    }
    Ok(bytes)
}

fn fingerprint(path: &Path) -> Result<Option<[u8; 32]>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not inspect SQL file".into()),
        Ok(_) => Ok(Some(Sha256::digest(read(path)?).into())),
    }
}

fn info(token: &str, path: &Path) -> SqlFileInfo {
    SqlFileInfo {
        token: token.into(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        display_path: path.to_string_lossy().into(),
    }
}

fn write(
    path: &Path,
    content: &str,
    bom: bool,
    expected: Option<[u8; 32]>,
) -> Result<[u8; 32], String> {
    if content.len() + if bom { 3 } else { 0 } > MAX_BYTES {
        return Err("SQL files are limited to 8 MiB".into());
    }
    let conflict = "SQL file changed on disk. Use Save As or reopen it before saving.";
    if fingerprint(path)? != expected {
        return Err(conflict.into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid SQL file path")?)
            .map_err(|_| "Could not create temporary SQL file")?;
    if bom {
        temporary
            .write_all(b"\xef\xbb\xbf")
            .map_err(|_| "Could not write SQL file")?;
    }
    temporary
        .write_all(content.as_bytes())
        .map_err(|_| "Could not write SQL file")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Could not flush SQL file")?;
    if expected.is_some() {
        let permissions = fs::metadata(path)
            .map_err(|_| "Could not inspect SQL file")?
            .permissions();
        if permissions.readonly() {
            return Err("SQL file is read-only".into());
        }
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|_| "Could not preserve SQL file permissions")?;
    }
    // Best-effort external-change detection immediately before replacement.
    // Filesystems do not provide a portable compare-and-swap for file content.
    if fingerprint(path)? != expected {
        return Err(conflict.into());
    }
    if expected.is_none() {
        temporary
            .persist_noclobber(path)
            .map_err(|_| "Could not create SQL file; the target may already exist")?;
    } else {
        temporary
            .persist(path)
            .map_err(|_| "Could not replace SQL file")?;
    }
    let mut hash = Sha256::new();
    if bom {
        hash.update(b"\xef\xbb\xbf");
    }
    hash.update(content.as_bytes());
    Ok(hash.finalize().into())
}

impl SqlFiles {
    pub fn open(&self, selected: &Path) -> Result<OpenSqlFile, String> {
        let path = selected
            .canonicalize()
            .map_err(|_| "Could not locate SQL file")?;
        let bytes = read(&path)?;
        let content = String::from_utf8(bytes.clone())
            .map_err(|_| "SQL file must contain valid UTF-8 text")?;
        let bom = content.starts_with('\u{feff}');
        let content = content
            .strip_prefix('\u{feff}')
            .unwrap_or(&content)
            .to_owned();
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "SQL file registry is unavailable")?;
        if documents.len() >= MAX_HANDLES {
            return Err("Too many open SQL files; close a file tab first".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let file = info(&token, &path);
        documents.insert(
            token,
            Document {
                path,
                fingerprint: Sha256::digest(&bytes).into(),
                bom,
            },
        );
        Ok(OpenSqlFile { file, content })
    }

    pub fn save(&self, token: &str, content: &str) -> Result<SqlFileInfo, String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "SQL file registry is unavailable")?;
        let document = documents
            .get_mut(token)
            .ok_or("Unknown or expired SQL file token")?;
        document.fingerprint = write(
            &document.path,
            content,
            document.bom,
            Some(document.fingerprint),
        )?;
        Ok(info(token, &document.path))
    }

    /// This path must come from a native save dialog, never directly from IPC.
    pub fn save_as(&self, selected: &Path, content: &str) -> Result<SqlFileInfo, String> {
        let parent = selected
            .parent()
            .ok_or("Invalid SQL file path")?
            .canonicalize()
            .map_err(|_| "Could not locate SQL file directory")?;
        let path = parent.join(selected.file_name().ok_or("Invalid SQL file name")?);
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "SQL file registry is unavailable")?;
        if documents.len() >= MAX_HANDLES {
            return Err("Too many open SQL files; close a file tab first".into());
        }
        let expected = fingerprint(&path)?;
        let fingerprint = write(&path, content, false, expected)?;
        let token = uuid::Uuid::new_v4().to_string();
        let file = info(&token, &path);
        documents.insert(
            token,
            Document {
                path,
                fingerprint,
                bom: false,
            },
        );
        Ok(file)
    }

    pub fn release(&self, token: &str) {
        if let Ok(mut documents) = self.documents.lock() {
            documents.remove(token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_bom_and_line_endings_survive_save_and_tokens_expire() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("query.sql");
        fs::write(&path, b"\xef\xbb\xbfSELECT 1;\r\n").unwrap();
        let files = SqlFiles::default();
        let opened = files.open(&path).unwrap();
        assert_eq!(opened.content, "SELECT 1;\r\n");
        files.save(&opened.file.token, "SELECT '😀';\r\n").unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            "\u{feff}SELECT '😀';\r\n".as_bytes()
        );
        files.release(&opened.file.token);
        assert!(files.save(&opened.file.token, "lost").is_err());
    }

    #[test]
    fn external_changes_deletion_and_failed_saves_preserve_disk_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("query.sql");
        fs::write(&path, "original").unwrap();
        let files = SqlFiles::default();
        let opened = files.open(&path).unwrap();
        fs::write(&path, "external").unwrap();
        assert!(files
            .save(&opened.file.token, "overwrite")
            .unwrap_err()
            .contains("changed on disk"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        fs::remove_file(&path).unwrap();
        assert!(files.save(&opened.file.token, "recreate").is_err());
        assert!(!path.exists());
    }

    #[test]
    fn save_as_creates_utf8_and_rejects_invalid_input_without_truncating() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new.sql");
        let files = SqlFiles::default();
        let saved = files.save_as(&path, "SELECT 'ą😀';").unwrap();
        assert_eq!(saved.file_name, "new.sql");
        assert_eq!(fs::read_to_string(&path).unwrap(), "SELECT 'ą😀';");
        assert!(files
            .save(&saved.token, &"x".repeat(MAX_BYTES + 1))
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "SELECT 'ą😀';");
        fs::write(directory.path().join("bad.sql"), [0xff]).unwrap();
        assert!(files
            .open(&directory.path().join("bad.sql"))
            .unwrap_err()
            .contains("UTF-8"));
    }

    #[test]
    fn read_only_files_are_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("readonly.sql");
        fs::write(&path, "original").unwrap();
        let permissions = fs::metadata(&path).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let files = SqlFiles::default();
        let opened = files.open(&path).unwrap();
        let result = files.save(&opened.file.token, "overwrite");
        fs::set_permissions(&path, permissions).unwrap();
        assert!(result.unwrap_err().contains("read-only"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn replacement_symlinks_do_not_redirect_existing_file_tokens() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opened.sql");
        let other = directory.path().join("other.sql");
        fs::write(&path, "opened").unwrap();
        fs::write(&other, "other").unwrap();
        let files = SqlFiles::default();
        let opened = files.open(&path).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(files.save(&opened.file.token, "overwrite").is_err());
        assert_eq!(fs::read_to_string(&other).unwrap(), "other");
    }
}
