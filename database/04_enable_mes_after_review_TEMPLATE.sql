-- DO NOT EXECUTE THIS FILE UNCHANGED.
-- Only AFTER verifying actual live MES worker table, required columns, their types,
-- and whether table INSERT requires extra mandatory columns.
-- Make a backup of MES workers BEFORE enabling the bridge.
-- EXAMPLE only (names below are NOT confirmed existing schema):
-- UPDATE public.dnm_leave_mes_config
-- SET target_table = 'public.YOUR_VERIFIED_WORKER_TABLE',
--     code_column = 'YOUR_EMPLOYEE_CODE_COLUMN',
--     name_column = 'YOUR_WORKER_NAME_COLUMN',
--     active_column = 'YOUR_BOOLEAN_IS_ACTIVE_COLUMN',
--     department_column = NULL, -- or 'YOUR_DEPARTMENT_COLUMN'
--     position_column = NULL, -- or 'YOUR_POSITION_COLUMN'
--     active_type = 'boolean', -- or 'yn' for Y/N text columns
--     enabled = true, updated_at = now()
-- WHERE id = 1;
-- Important: this bridge synchronizes MES worker master data only; MES login credentials
-- (dnm-accounts Edge Function) are managed by the existing MES login workflow.
SELECT enabled,target_table,code_column,name_column,active_column,department_column,position_column,active_type
FROM public.dnm_leave_mes_config WHERE id=1;
