SELECT c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
  n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
  (SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace) AS tablespace,
  quote_literal(obj_description(c.oid)) AS comment,
  (SELECT pg_get_partkeydef(p.partrelid) FROM pg_partitioned_table p WHERE p.partrelid = c.oid) AS partkey,
  (SELECT pg_get_partkeydef(pp.partrelid) FROM pg_partitioned_table pp WHERE pp.partrelid = c.oid) AS own_partkey,
  (SELECT string_agg(format('%I.%I', pn.nspname, p.relname), ', ' ORDER BY i.inhseqno)
    FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = p.relnamespace WHERE i.inhrelid = c.oid) AS inherits,
  pn.nspname AS part_schema, p.relname AS part_name,
  CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partbound
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid AND c.relispartition
LEFT JOIN pg_class p ON p.oid = i.inhparent LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace
WHERE c.oid = $1
