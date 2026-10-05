/** Shared Svelte 5 state. Store APIs stay synchronous so database lifecycle
 * checks and native persistence keep their existing ordering contracts. */
export function createState<T extends object>(initial: T): T {
  const state = $state(initial)
  return state
}

/** Derived, read-only view over shared state. Metadata views avoid copying
 * retained query rows; their consumers copy only the visible row window. */
export function stateView<Value>(read: () => Value) {
  const current = $derived.by(read)
  return { get current() { return current } }
}
