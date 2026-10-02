import type { DatabaseNotice } from '../generated/contracts'

export interface NoticeOutput { notices: DatabaseNotice[]; noticesTruncated: boolean }
export const MAX_NOTICES = 1000
export const MAX_NOTICE_BYTES = 1024 * 1024
const encoder = new TextEncoder()

// Bound accumulated paging output too, not only each individual IPC response.
export function appendNoticeOutput(previous: NoticeOutput, next: NoticeOutput): NoticeOutput {
  const notices: DatabaseNotice[] = []
  let bytes = 0
  let truncated = previous.noticesTruncated || next.noticesTruncated
  for (const notice of [...previous.notices, ...next.notices]) {
    const size = [notice.severity, notice.code, notice.message, notice.detail, notice.hint, notice.context]
      .reduce<number>((total, text) => total + encoder.encode(text ?? '').length, 0)
    if (notices.length >= MAX_NOTICES || bytes + size > MAX_NOTICE_BYTES) { truncated = true; break }
    notices.push(notice)
    bytes += size
  }
  return { notices, noticesTruncated: truncated }
}

export function errorNotices(error: unknown): NoticeOutput {
  const empty = { notices: [], noticesTruncated: false }
  if (typeof error !== 'object' || error === null) return empty
  const source = error as Record<string, unknown>
  if (!Array.isArray(source.notices)) return empty
  const notices: DatabaseNotice[] = []
  for (const entry of source.notices) {
    if (typeof entry !== 'object' || entry === null) continue
    const notice = entry as Record<string, unknown>
    if (typeof notice.severity !== 'string' || typeof notice.code !== 'string' || typeof notice.message !== 'string') continue
    const optional = (key: string) => typeof notice[key] === 'string' ? notice[key] as string : null
    notices.push({ severity: notice.severity, code: notice.code, message: notice.message, detail: optional('detail'), hint: optional('hint'), context: optional('context') })
  }
  return appendNoticeOutput(empty, { notices, noticesTruncated: source.noticesTruncated === true })
}
