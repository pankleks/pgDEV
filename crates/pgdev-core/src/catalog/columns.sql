SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
  a.attnotnull AS notnull, a.attidentity AS identity, a.attgenerated AS generated,
  a.attinhcount AS inhcount, pg_get_expr(d.adbin, d.adrelid) AS default_value,
  seq.sequence_type, seq.sequence_start, seq.sequence_increment,
  seq.sequence_min, seq.sequence_max, seq.sequence_cache, seq.sequence_cycle,
  seq.owned_schema, seq.owned_name,
  CASE WHEN co.collname IS NOT NULL AND co.collname <> 'default'
    THEN ' COLLATE ' || quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
    ELSE '' END AS collation,
  (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || ' ' ||
    quote_literal(substr(o, strpos(o, '=') + 1)), ', ' ORDER BY ord)
    FROM unnest(a.attfdwoptions) WITH ORDINALITY AS opt(o, ord)) AS fdw_options,
  quote_literal(col_description(a.attrelid, a.attnum)) AS comment
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
LEFT JOIN LATERAL (
  SELECT format_type(s.seqtypid, NULL) AS sequence_type,
    s.seqstart::text AS sequence_start, s.seqincrement::text AS sequence_increment,
    s.seqmin::text AS sequence_min, s.seqmax::text AS sequence_max,
    s.seqcache::text AS sequence_cache, s.seqcycle AS sequence_cycle,
    c2.relname AS owned_name, n2.nspname AS owned_schema
  FROM pg_depend dep JOIN pg_class c2 ON c2.oid = dep.objid AND c2.relkind = 'S'
  JOIN pg_namespace n2 ON n2.oid = c2.relnamespace JOIN pg_sequence s ON s.seqrelid = c2.oid
  WHERE dep.classid = 'pg_class'::regclass AND dep.refclassid = 'pg_class'::regclass
    AND dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype IN ('a','i')
) seq ON true
WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
