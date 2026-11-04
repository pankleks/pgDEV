import { types } from 'pg'

// User data reaches the browser as PostgreSQL's own text, except for the few
// scalars whose driver parsers are lossless and that the grid renders natively.
// Every other driver parser changes what the row editor sends back:
// - JSON.parse loses precision on large integers, rewrites number spellings
//   and turns a JSON string scalar into a bare string.
// - date/time values become JS Dates, which serialize back as ISO UTC and
//   shift wall-clock values.
// - arrays (numeric[], uuid[], jsonb[], …), interval, geometric and range
//   types become JS arrays/objects whose JSON text PostgreSQL cannot read.
// PostgreSQL already emits canonical text, so the identity parser is lossless,
// cheaper and keeps every cell exactly round-trippable.
const PARSED_TYPE_IDS = new Set([
  16 /* bool */, 21 /* int2 */, 23 /* int4 */, 26 /* oid */,
  700 /* float4 */, 701 /* float8 */,
  // Shown as "<bytea N bytes>" from the Buffer; the row editor locks it.
  17 /* bytea */,
])

/**
 * Custom type config for query calls that return user data. Passed per query
 * (never registered globally) so catalog and DDL reads are unaffected.
 */
export const rawTextTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (PARSED_TYPE_IDS.has(oid)) return types.getTypeParser(oid, format)
    return (value: string) => value
  },
}
