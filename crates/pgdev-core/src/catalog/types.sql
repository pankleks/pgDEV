SELECT t.typtype, t.typnotnull, n.nspname AS schema, t.typname AS name,
  pg_get_expr(t.typdefaultbin, 0) AS typdefault, format_type(t.typbasetype, t.typtypmod) AS base,
  (SELECT quote_ident(dcn.nspname) || '.' || quote_ident(dc.collname)
    FROM pg_collation dc JOIN pg_namespace dcn ON dcn.oid = dc.collnamespace
    WHERE dc.oid = t.typcollation AND t.typcollation <> 0 AND dc.collname <> 'default') AS domain_collation,
  (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
    FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels,
  (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
    || CASE WHEN co.collname IS NOT NULL AND co.collname <> 'default'
      THEN ' COLLATE ' || quote_ident(cn.nspname) || '.' || quote_ident(co.collname) ELSE '' END,
    ', ' ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
    LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
    WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attrs,
  (SELECT string_agg('CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), ' ' ORDER BY c.oid)
    FROM pg_constraint c WHERE c.contypid = t.oid) AS cons,
  format_type(r.rngsubtype, NULL) AS subtype,
  (SELECT quote_ident(ocn.nspname) || '.' || quote_ident(oc.opcname)
    FROM pg_opclass oc JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace WHERE oc.oid = r.rngsubopc) AS subopc,
  (SELECT quote_ident(rcn.nspname) || '.' || quote_ident(rc.collname)
    FROM pg_collation rc JOIN pg_namespace rcn ON rcn.oid = rc.collnamespace
    WHERE rc.oid = r.rngcollation AND r.rngcollation <> 0 AND rc.collname <> 'default') AS collation,
  (SELECT format('%I.%I', mn.nspname, mt.typname) FROM pg_type mt
    JOIN pg_namespace mn ON mn.oid = mt.typnamespace
    WHERE mt.oid = (SELECT x.rngmultitypid FROM pg_range x WHERE x.rngtypid = t.oid)
      AND mt.typname <> t.typname || '_multirange' AND mt.typname <> '_' || t.typname) AS multirange_name,
  NULLIF(r.rngcanonical, 0)::regproc::text AS canonical,
  NULLIF(r.rngsubdiff, 0)::regproc::text AS subdiff
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_range r ON r.rngtypid = t.oid WHERE t.oid = $1::oid
