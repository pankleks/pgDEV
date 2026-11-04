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
