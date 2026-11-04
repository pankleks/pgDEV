// Keyboard behaviour for modal dialogs (a Svelte action): focus moves into the
// dialog when it opens, Tab and Shift+Tab cycle within it, and focus returns
// to where it was (often the editor) when it closes. `onEscape` closes
// dialogs that have no Escape handling of their own.

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function dialogFocus(node: HTMLElement, onEscape?: () => void) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const focusable = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)

  // After the dialog's content has rendered: the first field, else the first
  // control, else the dialog itself (which carries tabindex="-1").
  queueMicrotask(() => {
    if (node.contains(document.activeElement)) return
    const field = node.querySelector<HTMLElement>('input:not([disabled]):not([type="checkbox"]), textarea:not([disabled]), select:not([disabled])')
    ;(field ?? focusable()[0] ?? node).focus()
  })

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault()
      onEscape()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusable()
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  node.addEventListener('keydown', keydown)

  return {
    destroy() {
      node.removeEventListener('keydown', keydown)
      if (previous?.isConnected) previous.focus()
    },
  }
}
