-- One MVCC snapshot, including stable catalog-order key badge numbering.
WITH target AS (
  SELECT c.oid, c.relkind, c.relispartition, n.nspname, c.relname,
    obj_description(c.oid) AS description
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1
), unique_keys AS (
  SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition,
    con.conkey AS keys, con.oid AS ord
  FROM pg_constraint con WHERE con.conrelid = $1 AND con.contype = 'u'
  UNION ALL
  SELECT idx.relname, pg_get_indexdef(idx.oid), (i.indkey)[0:i.indnkeyatts-1], idx.oid
  FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
  WHERE i.indrelid = $1 AND i.indisunique AND NOT i.indisprimary
    AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = idx.oid)
), numbered_unique AS (
  SELECT *, row_number() OVER (ORDER BY ord) AS num FROM unique_keys
), foreign_keys AS (
  SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition,
    con.conkey AS keys, row_number() OVER (ORDER BY con.oid) AS num
  FROM pg_constraint con WHERE con.conrelid = $1 AND con.contype = 'f'
), attributes AS (
  SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
    NOT a.attnotnull AS nullable,
    CASE WHEN a.attidentity <> '' THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END AS default_value,
    col_description(a.attrelid,a.attnum) AS description,
    CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated'
      WHEN pg_get_serial_sequence(format('%I.%I', t.nspname,t.relname),a.attname) IS NOT NULL
        AND format_type(a.atttypid,a.atttypmod) IN ('smallint','integer','bigint') THEN 'serial'
      ELSE NULL END AS lock_kind,
    EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = a.attrelid
      AND con.contype = 'p' AND a.attnum = ANY(con.conkey)) AS pk
  FROM pg_attribute a JOIN target t ON t.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND t.relkind IN ('r','p')
)
SELECT t.relkind::text, t.relispartition,
  jsonb_build_object('oid',t.oid::text,'schema',t.nspname,'name',t.relname,
    'relkind',t.relkind::text,'description',t.description,
    'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',a.attnum::text,'name',a.attname,'type',a.type,'nullable',a.nullable,
      'defaultValue',a.default_value,'description',a.description,'pk',a.pk,
      'locked',a.lock_kind IS NOT NULL,'lockKind',a.lock_kind,
      'fks',(SELECT jsonb_agg(jsonb_build_object('label','FK' || f.num,'name',f.name,
        'definition',f.definition) ORDER BY f.num) FROM foreign_keys f WHERE a.attnum = ANY(f.keys)),
      'uks',(SELECT jsonb_agg(jsonb_build_object('label','UK' || u.num,'name',u.name,
        'definition',u.definition) ORDER BY u.num) FROM numbered_unique u WHERE a.attnum = ANY(u.keys))
    ) ORDER BY a.attnum) FROM attributes a),'[]'::jsonb)) AS state
FROM target t
