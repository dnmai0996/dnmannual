-- READ-ONLY. Run after migration; adjust expected counts to the JSON export.
SELECT 'dnm_leave_state' AS section,count(*) AS rows FROM public.dnm_leave_state
UNION ALL SELECT 'dnm_leave_employees',count(*) FROM public.dnm_leave_employees
UNION ALL SELECT 'dnm_leave_requests',count(*) FROM public.dnm_leave_requests
UNION ALL SELECT 'dnm_leave_adjustments',count(*) FROM public.dnm_leave_adjustments
UNION ALL SELECT 'dnm_leave_cycle_grants',count(*) FROM public.dnm_leave_cycle_grants
UNION ALL SELECT 'dnm_leave_staff_audit',count(*) FROM public.dnm_leave_staff_audit
UNION ALL SELECT 'dnm_leave_roster_history',count(*) FROM public.dnm_leave_roster_history
UNION ALL SELECT 'dnm_leave_test_clear_history',count(*) FROM public.dnm_leave_test_clear_history
UNION ALL SELECT 'dnm_leave_custom_holidays',count(*) FROM public.dnm_leave_custom_holidays
UNION ALL SELECT 'dnm_leave_work_settings',count(*) FROM public.dnm_leave_work_settings
UNION ALL SELECT 'dnm_leave_archives',count(*) FROM public.dnm_leave_archives
UNION ALL SELECT 'dnm_leave_mes_outbox',count(*) FROM public.dnm_leave_mes_outbox;
SELECT revision,updated_at,payload->>'schema_version' AS data_schema,
       jsonb_array_length(payload->'users') AS user_count,
       jsonb_array_length(payload->'requests') AS request_count,
       jsonb_array_length(COALESCE(payload->'staff_audit','[]'::jsonb)) AS staff_audit_count
FROM public.dnm_leave_state WHERE id=1;
SELECT status,count(*) FROM public.dnm_leave_mes_outbox GROUP BY status ORDER BY status;
