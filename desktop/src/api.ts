import { invoke } from '@tauri-apps/api/core'

import type { QueryRequest, QueryResponse, FetchMoreResponse, SchemaData, DdlTarget, DdlResponse, RowUpdateRequest, RowUpdateResponse, TableEditState, TableEditRequest, TableEditResponse, DatabaseNotice } from './generated/contracts'
export type { QueryResult, DataResult, SchemaData, DdlTarget } from './generated/contracts'

// Query DTOs are generated from Rust and checked by a Rust unit test.
export interface Connected { id: string; pgVersion: string }
export interface CoreError { message: string; code: string | null; position: number | null; transactionOpen?: boolean | null; transactionId?: string | null; notices?: DatabaseNotice[]; noticesTruncated?: boolean }

export function transactionFromError(error: unknown): string | null | undefined {
  if (typeof error === 'object' && error !== null && 'transactionOpen' in error && typeof error.transactionOpen === 'boolean') {
    return error.transactionOpen && 'transactionId' in error && typeof error.transactionId === 'string' ? error.transactionId : null
  }
  return undefined
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return String(error)
}

export const api = {
  connect: (connectionString: string) => invoke<Connected>('connect', { config: { connectionString } }),
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
