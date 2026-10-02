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
