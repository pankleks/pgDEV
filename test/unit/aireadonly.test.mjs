import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { isReadOnlySql } = await load('server/ai/readonly.ts')

// The agent may only run reads; the classifier exists so the common refusal is
// a clear message instead of a PostgreSQL error (the read-only transaction is
// the real guarantee, covered in api/ai.mjs).

test('plain reads pass', () => {
  for (const sql of [
    'SELECT 1',
    'select * from t where id = $1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1), (2)',
    'TABLE items',
    'SHOW search_path',
    'EXPLAIN SELECT * FROM t',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t',
    '-- comment\nSELECT 1',
    '/* c */ SELECT 1',
    "SELECT 'update t set a = 1' AS note",
    'SELECT 1 -- delete from t',
    'SELECT 1 /* drop table t */',
    'SELECT $$insert into t$$ AS x',
  ]) {
    assert.deepEqual(isReadOnlySql(sql), { ok: true }, sql)
  }
})

test('writes and DDL are refused with a readable message', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'CREATE TABLE x (a int)',
    'ALTER TABLE t ADD COLUMN b int',
    'DROP TABLE t',
    'TRUNCATE t',
    'GRANT SELECT ON t TO r',
    'VACUUM t',
    'SET search_path = public',
    'CALL p()',
    'DO $$ BEGIN END $$',
    'SELECT 1; INSERT INTO t VALUES (1)',
  ]) {
    const result = isReadOnlySql(sql)
    assert.equal(result.ok, false, sql)
    assert.match(result.reason, /read-only/, sql)
  }
})

test('a data-modifying CTE passes the classifier and is left to the database', () => {
  // Masking keywords inside a CTE is not worth it: the statement starts with
  // WITH, and `BEGIN READ ONLY` refuses the write (api/ai.mjs proves it).
  assert.deepEqual(isReadOnlySql('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'), { ok: true })
})

test('locking clauses are refused, even though they are reads', () => {
  const result = isReadOnlySql('SELECT * FROM t WHERE id = 1 FOR UPDATE')
  assert.equal(result.ok, false)
  assert.match(result.reason, /locking/i)
  // The same words inside a literal are just text.
  assert.deepEqual(isReadOnlySql("SELECT 'for update' AS note"), { ok: true })
})

test('an empty batch is refused', () => {
  assert.equal(isReadOnlySql('   -- nothing\n').ok, false)
  assert.equal(isReadOnlySql('').ok, false)
})

test('non-ASCII spaces do not open a dollar quote that hides later statements', () => {
  // PostgreSQL lexes U+00A0 as an identifier character, so " $$" is
  // not a dollar quote there; the gate must see the COMMIT and DELETE too.
  for (const space of [' ', ' ', '　']) {
    const sql = `SELECT 1 ${space}$$; COMMIT; DELETE FROM t; SELECT 1 ${space}$$`
    assert.equal(isReadOnlySql(sql).ok, false, JSON.stringify(space))
  }
})

test('calls with effects outside the read-only transaction are refused', () => {
  for (const sql of [
    'SELECT pg_terminate_backend(123)',
    'select PG_CANCEL_BACKEND(pid) from pg_stat_activity',
    'SELECT pg_catalog.pg_reload_conf()',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM pg_ls_dir('.')",
    'SELECT * FROM pg_ls_waldir()',
    "SELECT dblink_exec('dbname=x', 'DELETE FROM t')",
    "SELECT * FROM dblink('dbname=x', 'SELECT 1') AS t(a int)",
    "SELECT set_config('role', 'postgres', true)",
    'SELECT pg_stat_reset()',
    "SELECT pg_create_logical_replication_slot('s', 'pgoutput')",
    "SELECT lo_export(1, '/tmp/x')",
    'SELECT pg_terminate_backend /* c */ (1)',
    'EXPLAIN ANALYZE SELECT pg_terminate_backend(1)',
    'SELECT 1; SELECT pg_cancel_backend(1)',
    'SELECT "pg_terminate_backend"(1)',
  ]) {
    const result = isReadOnlySql(sql)
    assert.equal(result.ok, false, sql)
    assert.match(result.reason, /outside the agent's read-only transaction/, sql)
  }
})

test('the same names as data, columns or other functions are fine', () => {
  for (const sql of [
    "SELECT 'pg_terminate_backend(1)' AS note",
    'SELECT $$set_config(x)$$',
    'SELECT pg_terminate_backend FROM audit_log',
    'SELECT current_setting(\'role\')',
    'SELECT pg_sleep(0)',
    'SELECT "PG_TERMINATE_BACKEND"(1)', // a different, case-sensitive name
    'SELECT my_dblink_report()',
    '-- pg_terminate_backend(1)\nSELECT 1',
  ]) {
    assert.deepEqual(isReadOnlySql(sql), { ok: true }, sql)
  }
})

const { isAgentWriteSql } = await load('server/ai/readonly.ts')

// Write mode ("Allow AI writes"): DML/DDL pass, but nothing may end or split
// the per-call transaction or change session settings.

test('write mode allows DML, DDL, locking reads and plain EXPLAIN', () => {
  for (const sql of [
    "INSERT INTO t (a) VALUES ('x')",
    'UPDATE t SET a = 1 WHERE id = 2; DELETE FROM t WHERE id = 3',
    'CREATE TABLE t2 (id int); ALTER TABLE t2 ADD COLUMN b text; DROP TABLE t2',
    'SELECT * FROM t FOR UPDATE',
    'PREPARE p AS SELECT 1',
    'SELECT 1',
    'EXPLAIN UPDATE t SET a = 1',
    'EXPLAIN (VERBOSE, COSTS) SELECT 1',
    "SELECT 'explain analyze' AS note",
  ]) {
    assert.deepEqual(isAgentWriteSql(sql), { ok: true }, sql)
  }
})

test('write mode refuses transaction control, session settings and COPY', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1); COMMIT',
    'BEGIN; UPDATE t SET a = 1',
    'START TRANSACTION',
    'ROLLBACK',
    'END',
    'ABORT',
    'SAVEPOINT s',
    'RELEASE SAVEPOINT s',
    "PREPARE TRANSACTION 'x'",
    "COMMIT PREPARED 'x'",
    'SET ROLE postgres',
    'SET LOCAL statement_timeout = 0',
    'RESET ROLE',
    'DISCARD ALL',
    'COPY t FROM STDIN',
    "COPY t TO '/tmp/x'",
    'DO $$ BEGIN RAISE NOTICE \'x\'; END $$',
    "DO $$BEGIN EXECUTE 'SET statement_timeout = 0'; END$$",
  ]) {
    const result = isAgentWriteSql(sql)
    assert.equal(result.ok, false, sql)
    assert.match(result.reason, /not allowed for the agent/, sql)
  }
})

test('write mode still refuses direct calls with effects outside the transaction', () => {
  for (const sql of [
    "UPDATE t SET a = set_config('role', 'postgres', true)",
    'SELECT pg_terminate_backend(1)',
    "SELECT dblink_exec('x', 'y')",
  ]) {
    const result = isAgentWriteSql(sql)
    assert.equal(result.ok, false, sql)
    assert.match(result.reason, /outside the agent's transaction/, sql)
  }
  assert.equal(isAgentWriteSql('  ').ok, false)
})

// Review fixes (0.7.1): disguised and string-wrapped calls, EXPLAIN ANALYZE.

test('Unicode-escaped identifiers are refused in both modes; U& strings are not', () => {
  for (const sql of [
    'SELECT U&"pg\\005fterminate\\005fbackend"(pid) FROM pg_stat_activity',
    "SELECT u&\"pg\\005fread\\005ffile\"('/etc/passwd')",
    "SELECT U&\"d!0061ta\" UESCAPE '!' FROM t",
    'SELECT * FROM U&"t"',
  ]) {
    for (const check of [isReadOnlySql, isAgentWriteSql]) {
      const result = check(sql)
      assert.equal(result.ok, false, sql)
      assert.match(result.reason, /Unicode-escaped identifiers/, sql)
    }
  }
  for (const sql of [
    "SELECT U&'d\\0061t\\+000061'",
    "SELECT 'U&\"x\"' AS note",
    'SELECT 1 -- U&"pg_read_file"(1)',
    'SELECT a FROM "U&x"',
  ]) {
    assert.deepEqual(isReadOnlySql(sql), { ok: true }, sql)
  }
})

test('functions that run SQL from a string are refused in both modes', () => {
  for (const sql of [
    "SELECT query_to_xml('select dblink_exec(''x'', ''DROP TABLE t'')', true, false, '')",
    "SELECT pg_catalog.query_to_xmlschema('select 1', true, false, '')",
    "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
    "SELECT cursor_to_xml('c', 1, true, false, '')",
    "SELECT \"cursor_to_xmlschema\"('c', true, false, '')",
  ]) {
    for (const check of [isReadOnlySql, isAgentWriteSql]) {
      const result = check(sql)
      assert.equal(result.ok, false, sql)
      assert.match(result.reason, /_xml/, sql)
    }
  }
  // Other XML functions stay available.
  assert.deepEqual(isReadOnlySql("SELECT table_to_xml('t', true, false, '')"), { ok: true })
})

test('EXPLAIN ANALYZE is refused in write mode only', () => {
  for (const sql of [
    'EXPLAIN ANALYZE UPDATE t SET a = 1',
    'explain analyse delete from t',
    'EXPLAIN (ANALYZE) INSERT INTO t VALUES (1)',
    'EXPLAIN (FORMAT JSON, ANALYZE true, BUFFERS) UPDATE t SET a = 1',
    '/* c */ EXPLAIN ANALYZE VERBOSE SELECT 1',
  ]) {
    const result = isAgentWriteSql(sql)
    assert.equal(result.ok, false, sql)
    assert.match(result.reason, /EXPLAIN ANALYZE executes the statement/, sql)
    // In read mode it runs in a rolled-back read-only transaction.
    if (/^\s*(\/\*.*\*\/\s*)?explain/i.test(sql) && !/UPDATE|DELETE|INSERT/i.test(sql)) {
      assert.deepEqual(isReadOnlySql(sql), { ok: true }, sql)
    }
  }
})
