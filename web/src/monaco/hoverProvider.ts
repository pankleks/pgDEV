import type * as Monaco from 'monaco-editor'
import type { SchemaData } from '../types'
import { formatColumnHover, formatFunctionHover, type HoverColumn } from '../lib/hovertext'
import { catalogFor, resolveRelation, visibleRelations, type Relation } from '../lib/catalog'
import { findFunctions } from '../lib/sqlobjects'
import { callSite, identifierAt } from './sqlcontext'
import { routineSource } from './plpgsql'
import { normIdent, relationLabel } from './sqlrefs'
import { resolveQueryScope, type QueryScope, type ScopeRelation } from './sqlscope'

// SQL hover: the identifier under the cursor is resolved against the loaded
// schema. At a call site (`name(`) the function/procedure is what the user is
// writing, so it wins over a same-named column; elsewhere a matching column
// wins, and a function still hovers when no column matches (e.g. its mention
// in DDL). All overloads of a name are listed with their signature, kind,
// schema and catalog comment.

function columnHover(
  catalog: ReturnType<typeof catalogFor>,
  synthetic: readonly ScopeRelation[],
  scope: QueryScope,
  chain: string[],
  name: string,
): HoverColumn | null {
  const qualifier = chain.slice(0, -1)
  let relation: Relation | undefined
  if (qualifier.length) {
    relation = resolveRelation(catalog, synthetic, qualifier, scope.aliases)
    // A qualifier that names no relation (a schema, say) cannot be a column.
    if (!relation) return null
  }
  const candidates = relation ? [relation] : visibleRelations(catalog, synthetic, scope)
  for (const rel of candidates) {
    const column = rel.columns.find((c) => c.name === name)
    if (!column) continue
    return {
      name: column.name,
      type: column.type,
      relation: relationLabel(rel),
      nullable: column.nullable,
      defaultValue: column.defaultValue,
    }
  }
  return null
}

export function createSqlHoverProvider(
  monaco: typeof Monaco,
  getSchema: () => SchemaData | null,
): Monaco.languages.HoverProvider {
  return {
    provideHover(model, position) {
      const data = getSchema()
      if (!data) return null
      const text = model.getValue()
      const cursor = model.getOffsetAt(position)
      // Inside a routine's dollar body the lexer sees one opaque token; rebase
      // onto the body so a column or call there still resolves.
      const source = routineSource(text, cursor)
      const ident = identifierAt(source.text, source.offset)
      if (!ident) return null
      const name = normIdent(ident.raw)
      if (!name) return null

      const scope = resolveQueryScope(text, cursor)
      const catalog = catalogFor(data)
      const isCall = callSite(source.text, ident.end)
      const functions = findFunctions(data, ident.chain, name)
      const column = columnHover(catalog, scope.relations, scope, ident.chain, name)

      const markdown =
        isCall && functions.length
          ? formatFunctionHover(functions)
          : column
            ? formatColumnHover(column)
            : functions.length
              ? formatFunctionHover(functions)
              : null
      if (!markdown) return null

      const start = model.getPositionAt(ident.start + source.shift)
      const end = model.getPositionAt(ident.end + source.shift)
      return {
        contents: [{ value: markdown }],
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      }
    },
  }
}
