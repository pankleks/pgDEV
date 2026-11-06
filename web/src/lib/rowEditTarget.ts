import type { DataResult } from '../types'

export interface RowEditTarget {
  grid: DataResult
  /** Edit: the row being changed. Insert: the row being duplicated, or null
   * for a blank new row. */
  row: unknown[] | null
  mode: 'edit' | 'insert'
  connectionId: string
  tabKey: string
  /** Captured when the dialog opens; a lost/replaced transaction must reject SAVE. */
  transactionId: string | null
}
