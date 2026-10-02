import { invoke } from '@tauri-apps/api/core'
import type { OpenSqlFile, SqlFileInfo } from './generated/contracts'

import type { QueryRequest, QueryResponse, FetchMoreResponse, SchemaData, DdlTarget, DdlResponse, RowUpdateRequest, RowUpdateResponse, TableEditState, TableEditRequest, TableEditResponse, DatabaseNotice } from './generated/contracts'
export type { QueryResult, DataResult, SchemaData, DdlTarget } from './generated/contracts'

// Query DTOs are generated from Rust and checked by a Rust unit test.
export interface Connected { id: string; pgVersion: string }
export interface CoreError { message: string; code: string | null; position: number | null; transactionOpen?: boolean | null; transactionId?: string | null; notices?: DatabaseNotice[]; noticesTruncated?: boolean }

export { errorMessage, transactionFromError } from './lib/errors'

export const api = {
  writeClipboardText: (content: string) => invoke<void>('write_clipboard_text', { content }),
  startCsvExport: () => invoke<string | null>('start_csv_export'),
  appendCsvExport: (token: string, chunk: string) => invoke<void>('append_csv_export', { token, chunk }),
  finishCsvExport: (token: string) => invoke<string>('finish_csv_export', { token }),
  abortCsvExport: (token: string) => invoke<void>('abort_csv_export', { token }),
  openSqlFile: () => invoke<OpenSqlFile | null>('open_sql_file'),
  saveSqlFile: (content: string, token: string | null) => invoke<SqlFileInfo | null>('save_sql_file', { content, token }),
  releaseSqlFile: (token: string) => invoke<void>('release_sql_file', { token }),
  connect: (connectionString: string, statementTimeout = 30, tlsCaPem?: string) => invoke<Connected>('connect', { config: { connectionString, statementTimeout, tlsCaPem } }),
  disconnect: (id: string) => invoke<void>('disconnect', { id }),
  schema: (id: string) => invoke<SchemaData>('schema', { id }),
  ddl: (id: string, target: DdlTarget) => invoke<DdlResponse>('ddl', { id, target }),
  closeSession: (id: string, tabKey: string) => invoke<void>('close_session', { id, tabKey }),
  query: (request: QueryRequest) => invoke<QueryResponse>('query', { request }),
  rowUpdate: (request: RowUpdateRequest) => invoke<RowUpdateResponse>('row_update', { request }),
  tableEditState: (id: string, oid: string) => invoke<TableEditState>('table_edit_state', { id, oid }),
  tableEditDdl: (id: string, oid: string, request: TableEditRequest) => invoke<TableEditResponse>('table_edit_ddl', { id, oid, request }),
  fetchMore: (id: string, tabKey: string, maxRows = 500) => invoke<FetchMoreResponse>('fetch_more', { id, tabKey, maxRows }),
  cancel: (id: string, tabKey: string) => invoke<void>('cancel', { id, tabKey }),
}
