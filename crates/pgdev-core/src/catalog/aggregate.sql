SELECT a.aggkind,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggtransfn) AS sfunc,
  format_type(a.aggtranstype, NULL) AS stype, NULLIF(a.aggtransspace, 0) AS transspace,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggfinalfn) AS finalfn,
  a.aggfinalextra, a.aggfinalmodify,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggcombinefn) AS combinefn,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggserialfn) AS serialfn,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggdeserialfn) AS deserialfn,
  quote_literal(a.agginitval) AS initcond,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggmtransfn) AS msfunc,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggminvtransfn) AS minvfunc,
  CASE WHEN a.aggmtranstype <> 0 THEN format_type(a.aggmtranstype, NULL) END AS mstype,
  NULLIF(a.aggmtransspace, 0) AS mtransspace,
  (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggmfinalfn) AS mfinalfn,
  a.aggmfinalextra, a.aggmfinalmodify, quote_literal(a.aggminitval) AS minitcond,
  (SELECT 'OPERATOR(' || quote_ident(opn.nspname) || '.' || op.oprname || ')'
    FROM pg_operator op JOIN pg_namespace opn ON opn.oid = op.oprnamespace WHERE op.oid = a.aggsortop) AS sortop,
  p.proparallel
FROM pg_aggregate a JOIN pg_proc p ON p.oid = a.aggfnoid WHERE a.aggfnoid = $1::oid
