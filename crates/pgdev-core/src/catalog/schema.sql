-- Same catalog selection and DTO shape as server/src/catalog/metadata.ts.
-- One statement gives the browser a consistent MVCC snapshot.
WITH namespaces AS (
  SELECT oid, nspname FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
), columns AS (
  SELECT a.attrelid AS rel, jsonb_agg(jsonb_build_object(
    'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
    'nullable', NOT a.attnotnull, 'defaultValue', pg_get_expr(d.adbin, d.adrelid)
  ) ORDER BY a.attnum) AS items
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  JOIN namespaces n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','f','v','m')
  GROUP BY a.attrelid
), indexes AS (
  SELECT i.indrelid AS rel, jsonb_agg(jsonb_build_object(
    'name', ic.relname, 'method', am.amname,
    'type', CASE WHEN i.indisprimary THEN 'primary' WHEN i.indisexclusion THEN 'exclusion'
      WHEN i.indisunique THEN 'unique' ELSE 'normal' END
  ) ORDER BY ic.relname) AS items
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid JOIN namespaces n ON n.oid = c.relnamespace
  JOIN pg_am am ON am.oid = ic.relam GROUP BY i.indrelid
), constraints AS (
  SELECT con.conrelid AS rel, jsonb_agg(jsonb_build_object(
    'name', con.conname, 'type', con.contype::text, 'definition', pg_get_constraintdef(con.oid)
  ) ORDER BY con.conname) AS items
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
  JOIN namespaces n ON n.oid = c.relnamespace GROUP BY con.conrelid
), triggers AS (
  SELECT t.tgrelid AS rel, jsonb_agg(jsonb_build_object(
    'name', t.tgname, 'definition', pg_get_triggerdef(t.oid, true)
  ) ORDER BY t.tgname) AS items
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN namespaces n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal GROUP BY t.tgrelid
)
SELECT jsonb_build_object(
 'tables', COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', c.relname, 'oid', c.oid::text,
    'isPartition', c.relispartition, 'isPartitioned', c.relkind = 'p', 'relkind', c.relkind::text,
    'parents', COALESCE((SELECT string_agg(pn.nspname || '.' || pc.relname, ', ')
      FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid), ''),
    'columns', COALESCE(cols.items, '[]'::jsonb), 'indexes', COALESCE(idx.items, '[]'::jsonb),
    'constraints', COALESCE(cons.items, '[]'::jsonb), 'triggers', COALESCE(trig.items, '[]'::jsonb)
  ) ORDER BY n.nspname, c.relname)
  FROM pg_class c JOIN namespaces n ON n.oid = c.relnamespace
  LEFT JOIN columns cols ON cols.rel = c.oid LEFT JOIN indexes idx ON idx.rel = c.oid
  LEFT JOIN constraints cons ON cons.rel = c.oid LEFT JOIN triggers trig ON trig.rel = c.oid
  WHERE c.relkind IN ('r','p','f')
 ), '[]'::jsonb),
 'views', COALESCE((
  SELECT jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', c.relname, 'oid', c.oid::text,
    'materialized', c.relkind = 'm', 'columns', COALESCE(cols.items, '[]'::jsonb)
  ) ORDER BY n.nspname, c.relname)
  FROM pg_class c JOIN namespaces n ON n.oid = c.relnamespace
  LEFT JOIN columns cols ON cols.rel = c.oid WHERE c.relkind IN ('v','m')
 ), '[]'::jsonb),
 'functions', COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', p.proname, 'oid', p.oid::text,
    'args', COALESCE(pg_get_function_identity_arguments(p.oid), ''),
    'returns', COALESCE(pg_get_function_result(p.oid), ''),
    'typeSig', COALESCE((SELECT string_agg(format_type(t.oid, NULL), ', ') FROM unnest(p.proargtypes) AS t(oid)), ''),
    'arguments', COALESCE(pg_get_function_arguments(p.oid), ''), 'comment', obj_description(p.oid, 'pg_proc'),
    'kind', CASE WHEN p.prorettype = 'trigger'::regtype THEN 'trigger' WHEN p.prokind = 'p' THEN 'procedure'
      WHEN p.prokind = 'w' THEN 'window' WHEN p.prokind = 'a' THEN 'aggregate' ELSE 'function' END
  ) ORDER BY n.nspname, p.proname, p.oid)
  FROM pg_proc p JOIN namespaces n ON n.oid = p.pronamespace WHERE p.prokind IN ('f','p','w','a')
 ), '[]'::jsonb),
 'types', COALESCE((
  SELECT jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', t.typname, 'oid', t.oid::text,
    'kind', CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite' WHEN 'd' THEN 'domain' ELSE 'range' END,
    'detail', COALESCE(en.labels, ca.attrs, dm.base, format_type(r.rngsubtype, NULL), '')
  ) ORDER BY n.nspname, t.typname)
  FROM pg_type t JOIN namespaces n ON n.oid = t.typnamespace
  LEFT JOIN LATERAL (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_enum e WHERE e.enumtypid = t.oid) en ON t.typtype = 'e'
  LEFT JOIN LATERAL (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) AS attrs
    FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) ca ON t.typtype = 'c'
  LEFT JOIN LATERAL (SELECT format_type(t.typbasetype, t.typtypmod) AS base) dm ON t.typtype = 'd'
  LEFT JOIN pg_range r ON r.rngtypid = t.oid
  WHERE t.typtype IN ('e','c','d','r') AND (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_class c WHERE c.oid = t.typrelid))
 ), '[]'::jsonb),
 'sequences', COALESCE((
  SELECT jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', c.relname, 'oid', c.oid::text,
    'dataType', format_type(s.seqtypid, NULL),
    'detail', 'inc ' || s.seqincrement || ' · min ' || s.seqmin || ' · max ' || s.seqmax || ' · cache ' || s.seqcache
      || CASE WHEN s.seqcycle THEN ' · cycle' ELSE '' END
      || CASE WHEN own.table_name IS NOT NULL THEN ' · owned by ' ||
        CASE WHEN own.own_schema = 'public' THEN '' ELSE own.own_schema || '.' END || own.table_name || '.' || own.column_name ELSE '' END
  ) ORDER BY n.nspname, c.relname)
  FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN namespaces n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL (
    SELECT tn.nspname AS own_schema, t.relname AS table_name, a.attname AS column_name
    FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')
  ) own ON true
 ), '[]'::jsonb),
 'builtins', COALESCE((
  SELECT jsonb_agg(jsonb_build_object('schema', 'pg_catalog', 'name', p.proname, 'oid', p.oid::text,
    'args', COALESCE(pg_get_function_identity_arguments(p.oid), ''),
    'returns', COALESCE(pg_get_function_result(p.oid), ''), 'typeSig', '', 'comment', obj_description(p.oid, 'pg_proc'),
    'kind', CASE WHEN p.prokind = 'w' THEN 'window' WHEN p.prokind = 'a' THEN 'aggregate' ELSE 'function' END
  ) ORDER BY p.proname, p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'pg_catalog' AND p.prokind IN ('f','a','w') AND p.proname NOT LIKE 'pg\_%'
    AND p.prorettype NOT IN ('internal'::regtype,'cstring'::regtype,'trigger'::regtype,'event_trigger'::regtype,'void'::regtype)
    AND NOT EXISTS (SELECT 1 FROM unnest(p.proargtypes) t(oid) JOIN pg_type ty ON ty.oid = t.oid
      WHERE ty.typname IN ('internal','cstring','opaque','trigger','event_trigger','void','anynonarray'))
 ), '[]'::jsonb) || '[
  {"schema":"pg_catalog","name":"coalesce","args":"value, ...","returns":"any","typeSig":"","kind":"function","oid":"","comment":"returns the first of its arguments that is not null"},
  {"schema":"pg_catalog","name":"nullif","args":"value1, value2","returns":"any","typeSig":"","kind":"function","oid":"","comment":"returns null when value1 equals value2, otherwise value1"},
  {"schema":"pg_catalog","name":"greatest","args":"value, ...","returns":"any","typeSig":"","kind":"function","oid":"","comment":"returns the largest of its arguments"},
  {"schema":"pg_catalog","name":"least","args":"value, ...","returns":"any","typeSig":"","kind":"function","oid":"","comment":"returns the smallest of its arguments"}
 ]'::jsonb
)
