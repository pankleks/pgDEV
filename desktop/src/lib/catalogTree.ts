import type { SchemaData, DdlTarget } from '../generated/contracts'
import { nameMatches, parseSearch, searchTerms, type SearchType } from '../../../web/src/lib/browserSearch'
import { paramRows } from '../../../web/src/lib/browserSearch'

export interface CatalogNode {
  key: string
  label: string
  name: string
  schema: string
  scopes: SearchType[]
  detail?: string
  target?: DdlTarget
  children: CatalogNode[]
}

const node = (key: string, label: string, children: CatalogNode[] = [], detail?: string): CatalogNode => ({ key, label, name: label, schema: '', scopes: [], children, detail })
const target = (type: DdlTarget['type'], schema: string, name: string, oid: string | null = null, parent: string | null = null): DdlTarget => ({ type, schema, name, oid, parent })

export function catalogTree(data: SchemaData): CatalogNode[] {
  const columns = (key: string, values: SchemaData['tables'][number]['columns']) => values.map((column) => ({ ...node(`${key}:column:${column.name}`, column.name, [], `${column.type}${column.nullable ? '' : ' · NOT NULL'}${column.defaultValue ? ` · default ${column.defaultValue}` : ''}`), scopes: ['column'] as SearchType[] }))
  const tables = data.tables.map((table) => {
    const key = `table:${table.oid}`
    return { ...node(key, `${table.schema}.${table.name}`, [
      node(`${key}:columns`, `Columns (${table.columns.length})`, columns(key, table.columns)),
      node(`${key}:indexes`, `Indexes (${table.indexes.length})`, table.indexes.map((index) => ({ ...node(`${key}:index:${index.name}`, index.name, [], `${index.type} · ${index.method}`), target: target('index', table.schema, index.name) }))),
      node(`${key}:constraints`, `Constraints (${table.constraints.length})`, table.constraints.map((constraint) => ({ ...node(`${key}:constraint:${constraint.name}`, constraint.name, [], constraint.definition), target: target('constraint', table.schema, constraint.name, null, table.name) }))),
      node(`${key}:triggers`, `Triggers (${table.triggers.length})`, table.triggers.map((trigger) => ({ ...node(`${key}:trigger:${trigger.name}`, trigger.name, [], trigger.definition), target: target('trigger', table.schema, trigger.name, null, table.name) }))),
    ], table.isPartition ? `partition of ${table.parents}` : table.isPartitioned ? 'partitioned table' : table.relkind === 'f' ? 'foreign table' : undefined),
    name: table.name, schema: table.schema, scopes: ['table'] as SearchType[], target: target('table', table.schema, table.name, table.oid) }
  })
  const views = data.views.map((view) => ({ ...node(`view:${view.oid}`, `${view.schema}.${view.name}`, columns(`view:${view.oid}`, view.columns), view.materialized ? 'materialized · read-only DDL preview' : undefined), name: view.name, schema: view.schema, scopes: ['view'] as SearchType[], target: target('view', view.schema, view.name, view.oid) }))
  const functions = data.functions.map((fn) => ({ ...node(`function:${fn.oid}`, `${fn.schema}.${fn.name}(${fn.args})`, paramRows(fn.arguments ?? fn.args, fn.returns).map((parameter, index) => ({ ...node(`function:${fn.oid}:parameter:${index}`, parameter.name, [], `${parameter.kind} · ${parameter.rest}`), scopes: parameter.kind === 'returns' ? [] : ['parameter'] as SearchType[] })), fn.kind), name: fn.name, schema: fn.schema, scopes: ['function'] as SearchType[], target: target('function', fn.schema, fn.name, fn.oid) }))
  const types = data.types.map((type) => ({ ...node(`type:${type.oid}`, `${type.schema}.${type.name}`, [node(`type:${type.oid}:detail`, type.detail)], type.kind), name: type.name, schema: type.schema, scopes: ['type'] as SearchType[], target: target('type', type.schema, type.name, type.oid) }))
  const sequences = data.sequences.map((sequence) => ({ ...node(`sequence:${sequence.oid}`, `${sequence.schema}.${sequence.name}`, [node(`sequence:${sequence.oid}:detail`, sequence.detail)], sequence.dataType), name: sequence.name, schema: sequence.schema, scopes: ['sequence'] as SearchType[], target: target('sequence', sequence.schema, sequence.name, sequence.oid) }))
  return [node('tables', 'Tables', tables), node('views', 'Views', views), node('functions', 'Functions', functions), node('types', 'Types', types), node('sequences', 'Sequences', sequences)]
}

export function filterTree(nodes: CatalogNode[], query: string): CatalogNode[] {
  if (!query.trim()) return nodes
  const parsed = parseSearch(query)
  const groups = searchTerms(parsed.term)
  function filter(node: CatalogNode): CatalogNode | null {
    const scoped = parsed.type ? node.scopes.includes(parsed.type) : node.scopes.length > 0
    if (scoped && (!groups.length || nameMatches(node.name, node.schema, groups))) return node
    const children = node.children.map(filter).filter((node): node is CatalogNode => node !== null)
    return children.length ? { ...node, children } : null
  }
  return nodes.map(filter).filter((node): node is CatalogNode => node !== null)
}
