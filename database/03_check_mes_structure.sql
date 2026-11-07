-- READ-ONLY. First run this in the same existing Supabase project.
-- Find the MES worker master table name and column names. Share ONLY structure, not employee records.
SELECT table_schema,table_name
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE'
  AND table_name NOT LIKE 'dnm_leave_%'
  AND (table_name ILIKE '%worker%' OR table_name ILIKE '%employee%' OR table_name ILIKE '%staff%' OR table_name ILIKE '%operator%' OR table_name ILIKE '%user%' OR table_name ILIKE '%master%')
ORDER BY table_name;

SELECT table_name,ordinal_position,column_name,data_type,is_nullable,column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name NOT LIKE 'dnm_leave_%'
  AND (table_name ILIKE '%worker%' OR table_name ILIKE '%employee%' OR table_name ILIKE '%staff%' OR table_name ILIKE '%operator%')
ORDER BY table_name,ordinal_position;

SELECT schemaname,tablename,policyname,cmd,roles
FROM pg_policies WHERE schemaname='public'
  AND (tablename ILIKE '%worker%' OR tablename ILIKE '%employee%' OR tablename ILIKE '%staff%');
