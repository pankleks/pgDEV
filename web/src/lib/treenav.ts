// Keyboard navigation for a tree drawn as a flat list of rows (a Svelte
// action on the container). Rows carry their own state, so the action needs
// no knowledge of what they show:
//   data-nav         a row the keyboard can reach
//   aria-level       depth (1 = top), used to find the parent row
//   aria-expanded    present only on rows that expand and collapse
//   data-toggle      the element whose click toggles the row (the row itself
//                    or a child such as the caret)
//   data-open        Enter double-clicks the row (open DDL, open file)
// One row at a time is in the Tab order (roving tabindex); the arrow keys move
// between rows, Right/Left expand, collapse and go to the parent, Enter opens,
// Space toggles, and Shift+F10 or the Menu key opens the row's context menu.

const ROW = '[data-nav]'

export function treeNav(container: HTMLElement) {
  let current: HTMLElement | null = null
  const rows = () => [...container.querySelectorAll<HTMLElement>(ROW)]
  const level = (row: HTMLElement | undefined) => Number(row?.getAttribute('aria-level') ?? 0)
  const expandable = (row: HTMLElement) => row.hasAttribute('aria-expanded')
  const expanded = (row: HTMLElement) => row.getAttribute('aria-expanded') === 'true'

  function setCurrent(row: HTMLElement | null) {
    if (current && current !== row && current.isConnected) current.tabIndex = -1
    current = row
    if (row) row.tabIndex = 0
  }
  // Rows come and go as the tree expands, filters and reloads: keep exactly
  // one of them reachable with Tab.
  function ensureCurrent() {
    if (!current || !current.isConnected || !container.contains(current)) setCurrent(container.querySelector<HTMLElement>(ROW))
  }
  function focusRow(row: HTMLElement | undefined) {
    if (!row) return
    setCurrent(row)
    row.focus()
    row.scrollIntoView({ block: 'nearest' })
  }
  function toggle(row: HTMLElement) {
    ;(row.matches('[data-toggle]') ? row : row.querySelector<HTMLElement>('[data-toggle]'))?.click()
  }
  function activate(row: HTMLElement) {
    if (row.hasAttribute('data-open')) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
    else if (expandable(row)) toggle(row)
  }
  function openMenu(row: HTMLElement) {
    const box = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.bottom }))
  }

  function keydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const row = (event.target as HTMLElement).closest<HTMLElement>(ROW)
    if (!row || !container.contains(row)) return
    const list = rows()
    const index = list.indexOf(row)
    // Buttons in the list (Show more) keep their own Enter and Space.
    const button = row instanceof HTMLButtonElement
    switch (event.key) {
      case 'ArrowDown': focusRow(list[index + 1]); break
      case 'ArrowUp': focusRow(list[index - 1]); break
      case 'Home': focusRow(list[0]); break
      case 'End': focusRow(list[list.length - 1]); break
      case 'ArrowRight':
        if (expandable(row) && !expanded(row)) toggle(row)
        else if (expanded(row) && level(list[index + 1]) > level(row)) focusRow(list[index + 1])
        break
      case 'ArrowLeft':
        if (expandable(row) && expanded(row)) toggle(row)
        else focusRow(list.slice(0, index).reverse().find((other) => level(other) > 0 && level(other) < level(row)))
        break
      case 'Enter':
        if (button) return
        activate(row)
        break
      case ' ':
        if (button) return
        if (expandable(row)) toggle(row)
        else activate(row)
        break
      case 'F10':
        if (!event.shiftKey) return
        openMenu(row)
        break
      case 'ContextMenu': openMenu(row); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  function focusin(event: FocusEvent) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(ROW)
    if (row && container.contains(row)) setCurrent(row)
  }

  const observer = new MutationObserver(ensureCurrent)
  observer.observe(container, { childList: true, subtree: true })
  ensureCurrent()
  container.addEventListener('keydown', keydown)
  container.addEventListener('focusin', focusin)
  return {
    destroy() {
      observer.disconnect()
      container.removeEventListener('keydown', keydown)
      container.removeEventListener('focusin', focusin)
    },
  }
}
