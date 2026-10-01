SELECT con.conname, con.contype, (con.contype = 'f' AND pc.oid IS NOT NULL) AS is_clone,
  CASE WHEN con.contype = 'f' AND pc.oid IS NOT NULL THEN
    'FOREIGN KEY (' ||
    (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
      FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
    || ') REFERENCES ' || format('%I.%I', pcn.nspname, pc.relname) || ' (' ||
    (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
      FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) || ')'
    || CASE con.confmatchtype WHEN 'f' THEN ' MATCH FULL' WHEN 'p' THEN ' MATCH PARTIAL' ELSE '' END
    || CASE con.confdeltype WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'c' THEN ' ON DELETE CASCADE'
      WHEN 'n' THEN ' ON DELETE SET NULL' WHEN 'd' THEN ' ON DELETE SET DEFAULT' ELSE '' END
    || CASE con.confupdtype WHEN 'r' THEN ' ON UPDATE RESTRICT' WHEN 'c' THEN ' ON UPDATE CASCADE'
      WHEN 'n' THEN ' ON UPDATE SET NULL' WHEN 'd' THEN ' ON UPDATE SET DEFAULT' ELSE '' END
    || CASE WHEN con.condeferrable THEN ' DEFERRABLE' ELSE '' END
    || CASE WHEN con.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END
    || CASE WHEN NOT con.convalidated THEN ' NOT VALID' ELSE '' END
  ELSE pg_get_constraintdef(con.oid) END AS def
FROM pg_constraint con LEFT JOIN pg_class rc ON rc.oid = con.confrelid
LEFT JOIN pg_inherits inh ON inh.inhrelid = rc.oid
LEFT JOIN pg_class pc ON pc.oid = inh.inhparent AND pc.relkind = 'p'
LEFT JOIN pg_namespace pcn ON pcn.oid = pc.relnamespace
WHERE con.conrelid = $1 AND con.contype IN ('p','u','f','c','x')
  AND con.conparentid = 0 AND con.coninhcount = 0 ORDER BY con.contype, conname
