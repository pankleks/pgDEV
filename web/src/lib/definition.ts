// "Open Definition" for a name selected in the editor: which catalog object(s)
// the selected text names, if any. Pure (no Monaco/UI), so it is unit-tested.
//
// The selection must be exactly one name, optionally schema-qualified:
// `orders`, `sales.orders`, `"Order Lines"`, `sales . "Order Lines"`. Unquoted
// parts fold to lower case like PostgreSQL. An unqualified name prefers the
// `public` schema and otherwise must be unique (completion metadata carries no
// search_path, so several non-public matches are never guessed between).
import type { FunctionInfo, SchemaData, TableInfo } from '../types'
import { catalogFor, findCatalogRelation } from './catalog'
import { normIdent } from '../monaco/sqlrefs'

export type DefinitionType = 'table' | 'view' | 'function' | 'type' | 'sequence' | 'index' | 'constraint' | 'trigger'

export interface DefinitionTarget {
  type: DefinitionType
  schema: string
  name: string
  /** Pins the exact object (and function overload) when known. */
  oid?: string
  /** Owning table for an index, constraint or trigger. */
  parent?: string
}

/** Longest selection considered: a qualified name of two maximal quoted parts. */
const MAX_SELECTION = 300
const PART = String.raw`(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)`
const QUALIFIED = new RegExp(String.raw`^\s*(${PART})(?:\s*\.\s*(${PART}))?\s*$`, 'u')

/** The selection as [schema, name] (schema '' when unqualified), or null. */
export function parseSelectedName(text: string): [string, string] | null {
  if (!text || text.length > MAX_SELECTION) return null
  const match = QUALIFIED.exec(text)
  if (!match) return null
  const first = normIdent(match[1] as string)
  if (match[2] === undefined) return ['', first]
  return [first, normIdent(match[2])]
}

/** One match from candidates: the given schema, else public, else a unique one. */
function pick<T extends { schema: string }>(candidates: T[], schema: string): T | undefined {
  if (schema) return candidates.find((c) => c.schema === schema)
  return candidates.find((c) => c.schema === 'public') ?? (candidates.length === 1 ? candidates[0] : undefined)
}

/** Every overload of the name in one schema (given, public, or the only one). */
function pickFunctions(data: SchemaData, schema: string, name: string): FunctionInfo[] {
  const named = data.functions.filter((f) => f.name === name)
  if (schema) return named.filter((f) => f.schema === schema)
  const schemas = new Set(named.map((f) => f.schema))
  const chosen = schemas.has('public') ? 'public' : schemas.size === 1 ? [...schemas][0] : undefined
  return chosen === undefined ? [] : named.filter((f) => f.schema === chosen)
}

/** A table-owned object (index, constraint, trigger) by name. */
function pickOwned(
  data: SchemaData,
  schema: string,
  name: string,
  type: 'index' | 'constraint' | 'trigger',
): DefinitionTarget | undefined {
  const list = (table: TableInfo) =>
    type === 'index' ? table.indexes : type === 'constraint' ? table.constraints : table.triggers
  const owners = data.tables.filter((t) => list(t).some((item) => item.name === name))
  const owner = pick(owners, schema)
  return owner ? { type, schema: owner.schema, name, parent: owner.name } : undefined
}

/**
 * The object(s) the selected text names, most specific kind first: a table or
 * view, then a sequence, type, function (all overloads in the chosen schema),
 * and finally a constraint, index or trigger by name. Empty when the text is
 * not a single name or names nothing in the loaded catalog.
 */
export function resolveDefinition(data: SchemaData | null | undefined, text: string): DefinitionTarget[] {
  if (!data) return []
  const parsed = parseSelectedName(text)
  if (!parsed) return []
  const [schema, name] = parsed

  const relation = findCatalogRelation(catalogFor(data), { schema, name })
  if (relation) {
    const type = 'materialized' in relation ? 'view' : 'table'
    return [{ type, schema: relation.schema, name: relation.name, oid: relation.oid }]
  }
  const sequence = pick(data.sequences.filter((s) => s.name === name), schema)
  if (sequence) return [{ type: 'sequence', schema: sequence.schema, name, oid: sequence.oid }]
  const type = pick(data.types.filter((t) => t.name === name), schema)
  if (type) return [{ type: 'type', schema: type.schema, name, oid: type.oid }]
  const functions = pickFunctions(data, schema, name)
  if (functions.length) return functions.map((f) => ({ type: 'function', schema: f.schema, name, oid: f.oid }))
  for (const owned of ['constraint', 'index', 'trigger'] as const) {
    const target = pickOwned(data, schema, name, owned)
    if (target) return [target]
  }
  return []
}
