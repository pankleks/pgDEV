import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSqlProviders } from '../desktop/src/lib/sqlProviders.ts'
import { createSqlCompletionProvider } from '../web/src/monaco/completionProvider.ts'
import { createSqlHoverProvider } from '../web/src/monaco/hoverProvider.ts'
import { createSqlSignatureProvider } from '../web/src/monaco/signatureProvider.ts'

const column = (name, type = 'integer') => ({ name, type, nullable: false, defaultValue: null })
const table = (schema, name, oid, columns) => ({ schema, name, oid, columns, indexes: [], constraints: [], triggers: [], isPartition: false, isPartitioned: false, parents: '', relkind: 'r' })
const fn = (name, oid, args, returns = 'integer', schema = 'public') => ({ name, oid, args, arguments: args, returns, typeSig: args, schema, kind: 'function', comment: `Documentation for ${name}` })
const catalog = {
  tables: [table('public', 'people', '1', [column('id'), column('name', 'text')]), table('app', 'Other Table', '2', [column('Some Name', 'varchar(20)')])],
  views: [], types: [], sequences: [],
  functions: [fn('sum_values', '3', 'x integer, y integer DEFAULT 1'), fn('sum_values', '4', 'x text', 'text'), fn('cash$flow', '5', '', 'integer', 'app')],
  builtins: [fn('coalesce', '', 'value, ...', 'any', 'pg_catalog')],
}

function model(text) {
  return {
    getValue: () => text,
    getOffsetAt: ({ lineNumber, column }) => text.split('\n').slice(0, lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + column - 1,
    getPositionAt: offset => {
      const lines = text.slice(0, offset).split('\n')
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 }
    },
    getWordUntilPosition(position) {
      const offset = this.getOffsetAt(position)
      const word = /[\w$]*$/.exec(text.slice(0, offset))[0]
      return { word, startColumn: position.column - word.length, endColumn: position.column }
    },
  }
}

function fakeMonaco() {
  const registrations = []
  const register = kind => (_language, provider) => {
    const entry = { kind, provider, disposed: false }
    registrations.push(entry)
    return { dispose: () => { entry.disposed = true } }
  }
  return {
    registrations,
    Range: class { constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }) } },
    languages: {
      CompletionItemKind: { Function: 1, Method: 2, Keyword: 3, Field: 4, Class: 5, Variable: 6 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: register('completion'),
      registerHoverProvider: register('hover'),
      registerSignatureHelpProvider: register('signature'),
    },
  }
}

function suggestions(sql, needle, getSchema = () => catalog) {
  const textModel = model(sql)
  const at = textModel.getPositionAt(needle ? sql.indexOf(needle) + needle.length : sql.length)
  return createSqlCompletionProvider(fakeMonaco(), getSchema).provideCompletionItems(textModel, at).suggestions
}
const label = suggestion => typeof suggestion.label === 'string' ? suggestion.label : suggestion.label.label

test('alias and quoted-schema completion uses the original SQL scope rules', () => {
  const aliases = suggestions('SELECT p. FROM people p', 'p.')
  assert.deepEqual(aliases.map(label), ['id', 'name'])
  const quoted = suggestions('SELECT app."Other Table". FROM app."Other Table"', 'app."Other Table".')
  assert.deepEqual(quoted.map(label), ['Some Name'])
  assert.equal(quoted[0].insertText, '"Some Name"')
})

test('CTE fields and nested query scopes remain available', () => {
  const items = suggestions('WITH chosen AS (SELECT id, name FROM people) SELECT c. FROM chosen c', 'c.')
  assert.deepEqual(items.map(label), ['id', 'name'])
})

test('routine-body completion exposes local variables and named parameters', () => {
  const prefix = 'CREATE FUNCTION public.demo(p_value integer) RETURNS integer LANGUAGE plpgsql AS $$ DECLARE counter integer; BEGIN '
  const variables = suggestions(`${prefix}cou`, null)
  const counter = variables.find(item => label(item) === 'counter')
  assert.ok(counter)
  assert.ok(counter.detail.includes('variable'))
  const parameters = suggestions(`${prefix}SELECT p_v`, null)
  assert.ok(parameters.some(item => label(item) === 'p_value' && item.detail.includes('parameter')))
})

test('overloads, built-ins and snippet-sensitive names are preserved', () => {
  const overloaded = suggestions('SELECT sum_', null).filter(item => label(item) === 'sum_values')
  assert.equal(overloaded.length, 2)
  assert.ok(overloaded.every(item => item.insertText === 'sum_values($0)'))
  assert.ok(overloaded.some(item => item.label.description.includes('DEFAULT 1')))
  const builtin = suggestions('SELECT coa', null).find(item => label(item) === 'coalesce')
  assert.equal(builtin.insertText, 'coalesce($0)')
  const dollar = suggestions('SELECT app.cash', null).find(item => label(item) === 'cash$flow')
  assert.equal(dollar.insertText, '"cash\\$flow"($0)')
})

test('column hover and function hover retain catalog details and safe Markdown', () => {
  const hover = createSqlHoverProvider(fakeMonaco(), () => catalog)
  const sql = 'SELECT p.name FROM people p'
  const textModel = model(sql)
  const info = hover.provideHover(textModel, textModel.getPositionAt(sql.indexOf('name') + 2))
  assert.ok(info.contents[0].value.includes('text'))
  assert.ok(info.contents[0].value.includes('people'))
  const call = model('SELECT sum_values(1)')
  const functionInfo = hover.provideHover(call, call.getPositionAt(12))
  assert.ok(functionInfo.contents[0].value.includes('DEFAULT 1'))
  assert.ok(functionInfo.contents[0].value.includes('Documentation for sum'))
  assert.equal(functionInfo.contents[0].isTrusted, undefined)
})

test('signature help tracks the active parameter and keeps all overloads', () => {
  const textModel = model('SELECT sum_values(1, ')
  const help = createSqlSignatureProvider(() => catalog).provideSignatureHelp(textModel, textModel.getPositionAt(textModel.getValue().length))
  assert.equal(help.value.signatures.length, 2)
  assert.equal(help.value.activeParameter, 1)
  assert.ok(help.value.signatures.some(signature => signature.label.includes('DEFAULT 1')))
})

test('providers resolve the latest catalog and clear object suggestions after disconnect', () => {
  let current = catalog
  const completion = createSqlCompletionProvider(fakeMonaco(), () => current)
  const textModel = model('SELECT pe')
  const position = textModel.getPositionAt(9)
  assert.ok(completion.provideCompletionItems(textModel, position).suggestions.some(item => label(item) === 'people'))
  current = { ...catalog, tables: [table('public', 'penguins', '7', [column('bird_id')])] }
  const refreshed = completion.provideCompletionItems(textModel, position).suggestions.map(label)
  assert.ok(refreshed.includes('penguins')); assert.ok(!refreshed.includes('people'))
  current = null
  assert.ok(!completion.provideCompletionItems(textModel, position).suggestions.some(item => label(item) === 'penguins'))
  assert.equal(createSqlHoverProvider(fakeMonaco(), () => current).provideHover(textModel, position), null)
  assert.equal(createSqlSignatureProvider(() => current).provideSignatureHelp(textModel, position), null)
})

test('desktop registrations are scoped to their own model and disposed on teardown', () => {
  const monaco = fakeMonaco()
  const own = model('SELECT pe')
  const other = model('SELECT sum_values(')
  const registration = registerSqlProviders(monaco, own, () => catalog)
  assert.equal(monaco.registrations.length, 3)
  const completion = monaco.registrations.find(entry => entry.kind === 'completion').provider
  assert.ok(completion.provideCompletionItems(own, own.getPositionAt(9)).suggestions.some(item => label(item) === 'people'))
  assert.deepEqual(completion.provideCompletionItems(other, other.getPositionAt(other.getValue().length)), { suggestions: [] })
  for (const entry of monaco.registrations.filter(entry => entry.kind !== 'completion')) {
    const result = entry.kind === 'hover' ? entry.provider.provideHover(other, other.getPositionAt(12)) : entry.provider.provideSignatureHelp(other, other.getPositionAt(other.getValue().length))
    assert.equal(result, null)
  }
  registration.dispose()
  assert.ok(monaco.registrations.every(entry => entry.disposed))
})
