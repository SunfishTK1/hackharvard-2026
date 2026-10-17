-- Read-only structural checks and aggregate inventory. No record contents.
BEGIN READ ONLY;
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname IN ('public','private','audit')) <> 24 THEN
    RAISE EXCEPTION 'Expected 23 project tables plus schema_migrations';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_views WHERE schemaname='analytics') <> 6 THEN
    RAISE EXCEPTION 'Expected six analytics views';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('trial','clinical','core','patient_agent','manager_agent')) THEN
    RAISE EXCEPTION 'Old application schemas remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','audit','analytics') AND NOT i.indisvalid
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname IN ('public','private','audit') AND NOT c.convalidated
  ) THEN
    RAISE EXCEPTION 'Invalid index or unvalidated constraint';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='001_consent_first_platform') THEN
    RAISE EXCEPTION 'Migration version missing';
  END IF;
  IF has_schema_privilege('analyst','private','USAGE')
    OR has_table_privilege('analyst','public.messages','SELECT')
    OR has_table_privilege('patient_agent','public.participants','SELECT') THEN
    RAISE EXCEPTION 'Unexpected access to private or unscoped participant data';
  END IF;
END $$;
SELECT current_database() AS database, current_setting('server_version') AS postgres_version;
SELECT n.nspname AS schema, count(*) AS tables
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','private','audit')
  GROUP BY n.nspname ORDER BY n.nspname;
SELECT string_agg(format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I',
  n.nspname||'.'||c.relname,n.nspname,c.relname),' UNION ALL ' ORDER BY n.nspname,c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','private','audit')
\gexec
SELECT extname,extversion FROM pg_extension ORDER BY extname;
COMMIT;
