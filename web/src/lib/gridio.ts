export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function formatCellForDisplay(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  return cellToText(value)
}

/** Longest text a grid cell renders. A cell shows one clipped line, so a
 * multi-megabyte value would only cost layout; copying and the value dialog
 * still use the full value. */
export const CELL_PREVIEW_CHARS = 1000

/** Grid cell text, cut to CELL_PREVIEW_CHARS (never inside a surrogate pair). */
export function formatCellPreview(value: unknown): string {
  const text = formatCellForDisplay(value)
  if (text.length <= CELL_PREVIEW_CHARS) return text
  let end = CELL_PREVIEW_CHARS
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/**
 * Prefix spreadsheet formula starters so a pasted cell cannot execute as a
 * formula. Applies to every export path — CSV download and clipboard TSV
 * alike — because the data comes from the database, not from the user.
 * A value that is exactly a numeric literal (`-12.5`, `+3`, `-1e-5`) cannot
 * run as a formula, so it is left intact: prefixing it would turn every
 * negative number into text and break round-trips.
 */
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function neutralizeFormula(value: string): string {
  if (/^[\t\r\n ]*[=+\-@]/.test(value) && !PLAIN_NUMBER.test(value)) return `'${value}`
  return value
}

export function csvEscape(value: string): string {
  value = neutralizeFormula(value)
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function csvCell(v: unknown): string {
  return csvEscape(cellToText(v))
}

/** BOM + header line for a streamed CSV file. */
export function csvHeader(columns: string[]): string {
  return '\uFEFF' + columns.map((c) => csvCell(c)).join(',') + '\n'
}

/** CSV text for one page of rows, every line newline-terminated. */
export function csvRows(rows: unknown[][]): string {
  let out = ''
  for (const row of rows) out += row.map((v) => csvCell(v)).join(',') + '\n'
  return out
}

export function toDelimited(columns: string[], rows: unknown[][], separator: ',' | '\t'): string {
  const cell = (v: unknown): string => {
    const s = cellToText(v)
    if (separator === ',') return csvEscape(s)
    // Neutralize first so the guard survives; then flatten what TSV cannot
    // carry (tabs and newlines inside a clipboard cell).
    return neutralizeFormula(s).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
  }
  const lines = [columns.map((c) => cell(c)).join(separator)]
  for (const row of rows) {
    lines.push(row.map((v) => cell(v)).join(separator))
  }
  return lines.join('\n')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await desktop().copyText(text)
    return true
  } catch {
    return false
  }
}

export async function copyGrid(columns: string[], rows: unknown[][]): Promise<boolean> {
  return copyText(toDelimited(columns, rows, '\t'))
}

import { desktop } from './desktop'
