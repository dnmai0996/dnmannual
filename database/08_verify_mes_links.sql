-- Read-only, safe verification AFTER linking. Copy and Run in Supabase SQL Editor.
SELECT '연차관리 직원' AS measure, COUNT(*)::text AS result FROM public.dnm_leave_employees WHERE NOT is_system_account
UNION ALL SELECT 'MES 직원',COUNT(*)::text FROM public.dnm_v4_records WHERE kind='employee'
UNION ALL SELECT 'MES 사번 연결',COUNT(*)::text FROM public.dnm_leave_mes_links
UNION ALL SELECT '자동연계 처리',COUNT(*)::text FROM public.dnm_leave_mes_outbox WHERE status='synced'
UNION ALL SELECT '자동연계 검토 필요',COUNT(*)::text FROM public.dnm_leave_mes_outbox WHERE status='needs_review'
UNION ALL SELECT '자동연계 오류',COUNT(*)::text FROM public.dnm_leave_mes_outbox WHERE status='error';
-- Avoid displaying personal data. List only worker status counts:
SELECT kind, count(*) AS cnt FROM public.dnm_v4_records WHERE kind='employee' GROUP BY kind;
