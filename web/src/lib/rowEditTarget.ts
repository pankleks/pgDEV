import type { DataResult } from '../types'

export interface RowEditTarget {
  grid: DataResult
  row: unknown[]
  connectionId: string
  tabKey: string
  /** Captured when the dialog opens; a lost/replaced transaction must reject SAVE. */
  transactionId: string | null
}
