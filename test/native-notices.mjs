import assert from 'node:assert/strict'
import test from 'node:test'
import { appendNoticeOutput, errorNotices, MAX_NOTICES, MAX_NOTICE_BYTES } from '../desktop/src/lib/notices.ts'

const empty = { notices: [], noticesTruncated: false }
const notice = message => ({ severity: 'NOTICE', code: '00000', message, detail: null, hint: null, context: null })

test('paging notices preserve ordering and server truncation flags', () => {
  const first = { notices: [notice('first')], noticesTruncated: true }
  const next = { notices: [notice('second')], noticesTruncated: false }
  assert.deepEqual(appendNoticeOutput(first, next), { notices: [notice('first'), notice('second')], noticesTruncated: true })
  assert.equal(first.notices.length, 1)
})

test('accumulated notice count and UTF-8 message bytes remain bounded', () => {
  const many = Array.from({ length: MAX_NOTICES + 1 }, (_, i) => notice(String(i)))
  const count = appendNoticeOutput(empty, { notices: many, noticesTruncated: false })
  assert.equal(count.notices.length, MAX_NOTICES)
  assert.equal(count.noticesTruncated, true)
  const size = appendNoticeOutput(empty, { notices: [notice('😀'.repeat(MAX_NOTICE_BYTES / 4))], noticesTruncated: false })
  assert.deepEqual(size, { notices: [], noticesTruncated: true })
})

test('error output rejects malformed messages and retains literal database text', () => {
  assert.deepEqual(errorNotices('network error'), empty)
  assert.deepEqual(errorNotices(null), empty)
  const message = notice('<img src=x onerror=bad>')
  assert.deepEqual(errorNotices({ notices: [null, false, { message: 'missing severity' }, message], noticesTruncated: true }), { notices: [message], noticesTruncated: true })
})
