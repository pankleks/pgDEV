export interface NamedObject {
  schema: string
  name: string
  oid?: string
}

export interface NamedObjectEntry<T extends NamedObject> {
  kind: 'group' | 'item'
  key: string
  schema: string
  name: string
  /** Every object under the entry: one for an item, all descendants for a group. */
  objects: T[]
  /** A group's own entries (items and nested groups); empty for an item. */
  children: NamedObjectEntry<T>[]
}

interface PrefixNode<T> {
  count: number
  prefix: string
  children: Map<string, PrefixNode<T>>
  /** Objects whose whole name is this prefix (several for overloads). */
  ends: { object: T; index: number }[]
}

function prefixNode<T>(prefix: string): PrefixNode<T> {
  return { count: 0, prefix, children: new Map(), ends: [] }
}

function groupKey(namespace: string, schema: string, prefix: string): string {
  return `group\u0000${namespace}\u0000${schema}\u0000${prefix}`
}

function itemKey<T extends NamedObject>(namespace: string, object: T, index: number): string {
  return `${namespace}\u0000item\u0000${object.oid ?? index}`
}

function item<T extends NamedObject>(namespace: string, object: T, index: number): NamedObjectEntry<T> {
  return { kind: 'item', key: itemKey(namespace, object, index), schema: object.schema, name: object.name, objects: [object], children: [] }
}

/** `employee` < `employee_get` < `employee_skill` < `employees`: word by word, so a folder sorts before its own longer names. */
function compareNames(a: string, b: string): number {
  const left = a.split('_')
  const right = b.split('_')
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = left[i].localeCompare(right[i])
    if (order) return order
  }
  return left.length - right.length
}

/**
 * Groups objects into folders by their underscore-separated name prefix, as a
 * tree: `employee_skill_get` sits in `employee` → `employee_skill` when other
 * names share those prefixes. A prefix becomes a folder when at least two
 * objects share it; a folder holding nothing but one subfolder is skipped in
 * favour of that subfolder, so no level is a lone pass-through. Same-named
 * overloads share a folder named after them.
 */
export function groupNamedObjects<T extends NamedObject>(
  objects: T[],
  enabled: boolean,
  namespace: string,
): NamedObjectEntry<T>[] {
  if (!enabled) return objects.map((object, index) => item(namespace, object, index))

  const roots = new Map<string, PrefixNode<T>>()
  for (const [index, object] of objects.entries()) {
    let node = roots.get(object.schema)
    if (!node) roots.set(object.schema, node = prefixNode(''))
    node.count++
    for (const [depth, part] of object.name.split('_').entries()) {
      const prefix: string = depth ? `${node.prefix}_${part}` : part
      let child = node.children.get(part)
      if (!child) node.children.set(part, child = prefixNode(prefix))
      child.count++
      node = child
    }
    node.ends.push({ object, index })
  }

  function collect(node: PrefixNode<T>, into: T[] = []): T[] {
    for (const end of node.ends) into.push(end.object)
    for (const child of node.children.values()) collect(child, into)
    return into
  }
  function single(node: PrefixNode<T>): { object: T; index: number } {
    while (!node.ends.length) node = node.children.values().next().value!
    return node.ends[0]
  }
  function entriesUnder(node: PrefixNode<T>, schema: string): NamedObjectEntry<T>[] {
    const entries = node.ends.map(({ object, index }) => item(namespace, object, index))
    for (let child of node.children.values()) {
      if (child.count === 1) {
        const { object, index } = single(child)
        entries.push(item(namespace, object, index))
        continue
      }
      while (!child.ends.length && child.children.size === 1) child = child.children.values().next().value!
      // A leading underscore gives an empty prefix: no nameless folder.
      if (!child.prefix) { entries.push(...entriesUnder(child, schema)); continue }
      entries.push({
        kind: 'group', key: groupKey(namespace, schema, child.prefix), schema, name: child.prefix,
        objects: collect(child), children: entriesUnder(child, schema),
      })
    }
    // Stable: overloads keep their catalog order.
    return entries.sort((a, b) => compareNames(a.name, b.name))
  }

  return [...roots].flatMap(([schema, root]) => entriesUnder(root, schema))
}

/** Every group key at any depth, for collapsing a whole section. */
export function groupKeysOf<T extends NamedObject>(entries: readonly NamedObjectEntry<T>[]): string[] {
  return entries.flatMap((entry) => entry.kind === 'group' ? [entry.key, ...groupKeysOf(entry.children)] : [])
}

/** Rows an entry renders: one per item, a group's header plus its open contents. */
export function entryRows<T extends NamedObject>(entry: NamedObjectEntry<T>, isOpen: (group: NamedObjectEntry<T>) => boolean): number {
  if (entry.kind === 'item') return 1
  return 1 + (isOpen(entry) ? entry.children.reduce((sum, child) => sum + entryRows(child, isOpen), 0) : 0)
}

/**
 * How many leading entries fit a rendering budget of `limit` rows, where
 * `rows(entry)` is what one entry renders (a group header plus its children
 * while open). The first entry always fits, so a huge group still shows.
 */
export function entriesWithin<E>(entries: readonly E[], rows: (entry: E) => number, limit: number): number {
  let used = 0
  let count = 0
  for (const entry of entries) {
    const size = rows(entry)
    if (count && used + size > limit) break
    used += size
    count++
  }
  return count
}
