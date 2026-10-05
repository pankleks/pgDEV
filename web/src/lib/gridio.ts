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

/**
 * Prefix spreadsheet formula starters so a pasted cell cannot execute as a
 * formula. Applies to every export path — CSV download and clipboard TSV
 * alike — because the data comes from the database, not from the user.
 */
function neutralizeFormula(value: string): string {
  if (/^[\t\r\n ]*[=+\-@]/.test(value)) return `'${value}`
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
