//! Per-socket, per-operation notice capture. Notices are user output, never
//! logs, and a server emitting unbounded messages cannot grow retained memory.
use crate::{CoreError, DatabaseNotice};
use std::sync::{Arc, Mutex};
use tokio_postgres::error::DbError;

const MAX_NOTICES: usize = 1000;
const MAX_NOTICE_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(crate) struct NoticeBuffer {
    active: bool,
    notices: Vec<DatabaseNotice>,
    bytes: usize,
    truncated: bool,
}

pub(crate) type NoticeSink = Arc<Mutex<NoticeBuffer>>;
pub(crate) struct NoticeCapture {
    sink: NoticeSink,
}

impl NoticeBuffer {
    pub(crate) fn record(&mut self, error: DbError) {
        if !self.active {
            return;
        }
        let notice = DatabaseNotice {
            severity: error.severity().to_owned(),
            code: error.code().code().to_owned(),
            message: error.message().to_owned(),
            detail: error.detail().map(str::to_owned),
            hint: error.hint().map(str::to_owned),
            context: error.where_().map(str::to_owned),
        };
        self.push(notice);
    }
    fn push(&mut self, notice: DatabaseNotice) {
        let bytes = std::mem::size_of::<DatabaseNotice>()
            + notice.severity.len()
            + notice.code.len()
            + notice.message.len()
            + notice.detail.as_ref().map_or(0, String::len)
            + notice.hint.as_ref().map_or(0, String::len)
            + notice.context.as_ref().map_or(0, String::len);
        if self.truncated
            || self.notices.len() >= MAX_NOTICES
            || self.bytes + bytes > MAX_NOTICE_BYTES
        {
            self.truncated = true;
            return;
        }
        self.bytes += bytes;
        self.notices.push(notice);
    }
}

impl NoticeCapture {
    pub(crate) fn begin(sink: &NoticeSink) -> Self {
        *sink.lock().unwrap_or_else(|p| p.into_inner()) = NoticeBuffer {
            active: true,
            ..Default::default()
        };
        Self { sink: sink.clone() }
    }
    pub(crate) fn finish(self) -> (Vec<DatabaseNotice>, bool) {
        let mut buffer = self.sink.lock().unwrap_or_else(|p| p.into_inner());
        let output = (std::mem::take(&mut buffer.notices), buffer.truncated);
        *buffer = NoticeBuffer::default();
        drop(buffer);
        output
    }
    pub(crate) fn error(self, mut error: CoreError) -> CoreError {
        (error.notices, error.notices_truncated) = self.finish();
        error
    }
}
impl Drop for NoticeCapture {
    fn drop(&mut self) {
        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = NoticeBuffer::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notice(message: String) -> DatabaseNotice {
        DatabaseNotice {
            severity: "NOTICE".into(),
            code: "00000".into(),
            message,
            detail: None,
            hint: None,
            context: None,
        }
    }
    #[test]
    fn count_and_memory_limits_are_explicit_and_reset_per_operation() {
        let sink = NoticeSink::default();
        let capture = NoticeCapture::begin(&sink);
        for i in 0..1002 {
            sink.lock().unwrap().push(notice(i.to_string()));
        }
        let (notices, truncated) = capture.finish();
        assert_eq!(notices.len(), 1000);
        assert!(truncated);
        let capture = NoticeCapture::begin(&sink);
        sink.lock()
            .unwrap()
            .push(notice("x".repeat(MAX_NOTICE_BYTES)));
        let (notices, truncated) = capture.finish();
        assert!(notices.is_empty());
        assert!(truncated);
        let capture = NoticeCapture::begin(&sink);
        sink.lock().unwrap().push(notice("clean".into()));
        let (notices, truncated) = capture.finish();
        assert_eq!(notices[0].message, "clean");
        assert!(!truncated);
    }
    #[test]
    fn dropped_capture_cannot_leak_messages_to_next_operation() {
        let sink = NoticeSink::default();
        let capture = NoticeCapture::begin(&sink);
        sink.lock().unwrap().push(notice("abandoned".into()));
        drop(capture);
        assert!(!sink.lock().unwrap().active);
        let capture = NoticeCapture::begin(&sink);
        assert!(capture.finish().0.is_empty());
    }
}
