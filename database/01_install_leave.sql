-- DNM Annual Leave / Supabase: install into the EXISTING DNM MES project.
-- Safe-by-default: all new names use dnm_leave_*. No DROP/TRUNCATE, no change to MES tables.
-- Run exactly in Supabase SQL Editor as a privileged database administrator.
BEGIN;

CREATE TABLE IF NOT EXISTS public.dnm_leave_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_companies (
  id bigint PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_employees (
  id bigint PRIMARY KEY, company_id bigint, employee_code text, employee_name text NOT NULL,
  department text, job_position text, join_date date, retire_date date,
  active boolean NOT NULL, is_system_account boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dnm_leave_employees_code_idx ON public.dnm_leave_employees(employee_code);
CREATE INDEX IF NOT EXISTS dnm_leave_employees_company_idx ON public.dnm_leave_employees(company_id, active);
CREATE TABLE IF NOT EXISTS public.dnm_leave_requests (
  id bigint PRIMARY KEY, user_id bigint NOT NULL, leave_type text, start_date date,
  end_date date, approval_state text, minutes integer, payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dnm_leave_requests_user_date_idx ON public.dnm_leave_requests(user_id, start_date);
CREATE INDEX IF NOT EXISTS dnm_leave_requests_status_idx ON public.dnm_leave_requests(approval_state);
CREATE TABLE IF NOT EXISTS public.dnm_leave_adjustments (
  id bigint PRIMARY KEY, user_id bigint NOT NULL, minutes integer, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_cycle_grants (
  source_index bigint PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_staff_audit (
  source_index bigint PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_roster_history (
  source_index bigint PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_test_clear_history (
  source_index bigint PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_custom_holidays (
  id bigint PRIMARY KEY, company_id bigint, holiday_date date, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_work_settings (
  company_id bigint PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_sessions (
  session_hash text PRIMARY KEY, payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dnm_leave_sessions_expiry_idx ON public.dnm_leave_sessions(expires_at);
CREATE TABLE IF NOT EXISTS public.dnm_leave_archives (
  backup_key text PRIMARY KEY, payload jsonb NOT NULL,
  backup_kind text NOT NULL DEFAULT 'pre-test-clear', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_mes_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leave_employee_id bigint NOT NULL, employee_code text, event_type text NOT NULL CHECK (event_type IN ('UPSERT', 'DEACTIVATE')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','error','needs_review')),
  attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS dnm_leave_mes_outbox_status_idx ON public.dnm_leave_mes_outbox(status, id);
CREATE TABLE IF NOT EXISTS public.dnm_leave_mes_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  target_table text,
  code_column text,
  name_column text,
  active_column text,
  department_column text,
  position_column text,
  active_type text NOT NULL DEFAULT 'boolean' CHECK (active_type IN ('boolean','yn')),
  active_yes text NOT NULL DEFAULT 'Y', active_no text NOT NULL DEFAULT 'N',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.dnm_leave_mes_config(id,enabled) VALUES(1,false) ON CONFLICT(id) DO NOTHING;

-- All these tables hold employee data/password hashes. No direct browser access.
DO $$ DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'dnm_leave_state','dnm_leave_companies','dnm_leave_employees','dnm_leave_requests',
    'dnm_leave_adjustments','dnm_leave_cycle_grants','dnm_leave_staff_audit',
    'dnm_leave_roster_history','dnm_leave_test_clear_history',
    'dnm_leave_custom_holidays','dnm_leave_work_settings','dnm_leave_sessions',
    'dnm_leave_archives','dnm_leave_mes_outbox','dnm_leave_mes_config'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', v_name);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.dnm_leave_mes_outbox_id_seq TO service_role;

-- Mirror the complete state into separately searchable tables IN THE SAME TRANSACTION.
CREATE OR REPLACE FUNCTION public.dnm_leave_sync_projection(p_state jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.dnm_leave_companies(id,name,active,payload)
  SELECT (v->>'id')::bigint, COALESCE(v->>'name',''), COALESCE((v->>'active')::boolean,true), v
    FROM jsonb_array_elements(COALESCE(p_state->'companies','[]'::jsonb)) AS v
  ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_companies x WHERE NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'companies','[]'::jsonb)) v WHERE v->>'id'=x.id::text);

  INSERT INTO public.dnm_leave_employees(id,company_id,employee_code,employee_name,department,job_position,join_date,retire_date,active,is_system_account,payload,updated_at)
  SELECT (v->>'id')::bigint, NULLIF(v->>'company_id','')::bigint, NULLIF(v->>'employee_code',''),
    COALESCE(v->>'employee_name',''), v->>'department', v->>'position',NULLIF(v->>'join_date','')::date,
    NULLIF(v->>'retire_date','')::date, COALESCE((v->>'active')::boolean,false),
    COALESCE((v->>'is_system_account')::boolean,false),v,now()
  FROM jsonb_array_elements(COALESCE(p_state->'users','[]'::jsonb)) AS v
  ON CONFLICT(id) DO UPDATE SET company_id=EXCLUDED.company_id,employee_code=EXCLUDED.employee_code,
    employee_name=EXCLUDED.employee_name,department=EXCLUDED.department,job_position=EXCLUDED.job_position,
    join_date=EXCLUDED.join_date,retire_date=EXCLUDED.retire_date,active=EXCLUDED.active,
    is_system_account=EXCLUDED.is_system_account,payload=EXCLUDED.payload,updated_at=now()
    WHERE public.dnm_leave_employees.payload IS DISTINCT FROM EXCLUDED.payload;
  DELETE FROM public.dnm_leave_employees x WHERE NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'users','[]'::jsonb)) v WHERE v->>'id'=x.id::text);

  INSERT INTO public.dnm_leave_requests(id,user_id,leave_type,start_date,end_date,approval_state,minutes,payload,updated_at)
  SELECT (v->>'id')::bigint,(v->>'user_id')::bigint,v->>'leave_type',NULLIF(v->>'start_date','')::date,
    NULLIF(v->>'end_date','')::date,v->>'approval_state',NULLIF(v->>'minutes','')::integer,v,now()
  FROM jsonb_array_elements(COALESCE(p_state->'requests','[]'::jsonb)) AS v
  ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,leave_type=EXCLUDED.leave_type,
    start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,approval_state=EXCLUDED.approval_state,
    minutes=EXCLUDED.minutes,payload=EXCLUDED.payload,updated_at=now()
    WHERE public.dnm_leave_requests.payload IS DISTINCT FROM EXCLUDED.payload;
  DELETE FROM public.dnm_leave_requests x WHERE NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'requests','[]'::jsonb)) v WHERE v->>'id'=x.id::text);

  INSERT INTO public.dnm_leave_adjustments(id,user_id,minutes,payload)
  SELECT (v->>'id')::bigint,(v->>'user_id')::bigint,COALESCE((v->>'minutes')::integer,0),v
  FROM jsonb_array_elements(COALESCE(p_state->'adjustments','[]'::jsonb)) AS v
  ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,minutes=EXCLUDED.minutes,payload=EXCLUDED.payload
    WHERE public.dnm_leave_adjustments.payload IS DISTINCT FROM EXCLUDED.payload;
  DELETE FROM public.dnm_leave_adjustments x WHERE NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'adjustments','[]'::jsonb)) v WHERE v->>'id'=x.id::text);

  INSERT INTO public.dnm_leave_custom_holidays(id,company_id,holiday_date,payload)
  SELECT (v->>'id')::bigint,NULLIF(v->>'company_id','')::bigint,NULLIF(v->>'date','')::date,v
  FROM jsonb_array_elements(COALESCE(p_state->'custom_holidays','[]'::jsonb)) v
  ON CONFLICT(id) DO UPDATE SET company_id=EXCLUDED.company_id,holiday_date=EXCLUDED.holiday_date,payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_custom_holidays x WHERE NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'custom_holidays','[]'::jsonb)) v WHERE v->>'id'=x.id::text);

  INSERT INTO public.dnm_leave_work_settings(company_id,payload)
  SELECT (v->>'company_id')::bigint,v FROM jsonb_array_elements(COALESCE(p_state->'work_settings','[]'::jsonb)) v
  ON CONFLICT(company_id) DO UPDATE SET payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_work_settings x WHERE NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'work_settings','[]'::jsonb)) v WHERE v->>'company_id'=x.company_id::text);

  INSERT INTO public.dnm_leave_cycle_grants(source_index,payload)
  SELECT n-1,v FROM jsonb_array_elements(COALESCE(p_state->'cycle_grants','[]'::jsonb)) WITH ORDINALITY t(v,n)
  ON CONFLICT(source_index) DO UPDATE SET payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_cycle_grants x WHERE x.source_index >= jsonb_array_length(COALESCE(p_state->'cycle_grants','[]'::jsonb));
  INSERT INTO public.dnm_leave_staff_audit(source_index,payload)
  SELECT n-1,v FROM jsonb_array_elements(COALESCE(p_state->'staff_audit','[]'::jsonb)) WITH ORDINALITY t(v,n)
  ON CONFLICT(source_index) DO UPDATE SET payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_staff_audit x WHERE x.source_index >= jsonb_array_length(COALESCE(p_state->'staff_audit','[]'::jsonb));

  INSERT INTO public.dnm_leave_roster_history(source_index,payload)
  SELECT n-1,v FROM jsonb_array_elements(COALESCE(p_state->'roster_history','[]'::jsonb)) WITH ORDINALITY t(v,n)
  ON CONFLICT(source_index) DO UPDATE SET payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_roster_history x WHERE x.source_index >= jsonb_array_length(COALESCE(p_state->'roster_history','[]'::jsonb));

  INSERT INTO public.dnm_leave_test_clear_history(source_index,payload)
  SELECT n-1,v FROM jsonb_array_elements(COALESCE(p_state->'test_clear_history','[]'::jsonb)) WITH ORDINALITY t(v,n)
  ON CONFLICT(source_index) DO UPDATE SET payload=EXCLUDED.payload;
  DELETE FROM public.dnm_leave_test_clear_history x WHERE x.source_index >= jsonb_array_length(COALESCE(p_state->'test_clear_history','[]'::jsonb));
END $$;

-- Creates MES integration events only for FUTURE annual-leave employee changes.
-- Initial import deliberately does not push an old roster into the live MES system.
CREATE OR REPLACE FUNCTION public.dnm_leave_enqueue_mes_changes(p_old jsonb,p_new jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old jsonb;v_new jsonb;v_id bigint;v_before jsonb;v_after jsonb;v_today text;
BEGIN
  v_today := (now() AT TIME ZONE 'Asia/Seoul')::date::text;
  FOR v_new IN SELECT value FROM jsonb_array_elements(COALESCE(p_new->'users','[]'::jsonb)) LOOP
    IF COALESCE((v_new->>'is_system_account')::boolean,false) THEN CONTINUE; END IF;
    v_id := (v_new->>'id')::bigint;
    SELECT value INTO v_old FROM jsonb_array_elements(COALESCE(p_old->'users','[]'::jsonb)) WHERE value->>'id'=v_id::text LIMIT 1;
    v_before:= CASE WHEN v_old IS NULL THEN NULL ELSE jsonb_build_object('code',v_old->>'employee_code','name',v_old->>'employee_name','department',v_old->>'department','position',v_old->>'position','active',v_old->>'active','retire_date',v_old->>'retire_date','deleted',v_old->>'deleted') END;
    v_after:=jsonb_build_object('code',v_new->>'employee_code','name',v_new->>'employee_name','department',v_new->>'department','position',v_new->>'position','active',v_new->>'active','retire_date',v_new->>'retire_date','deleted',v_new->>'deleted');
    IF v_before IS DISTINCT FROM v_after THEN
      INSERT INTO public.dnm_leave_mes_outbox(leave_employee_id,employee_code,event_type,payload)
      VALUES(v_id,NULLIF(v_new->>'employee_code',''),
        CASE WHEN COALESCE((v_new->>'active')::boolean,false) AND NOT COALESCE((v_new->>'deleted')::boolean,false) AND (NULLIF(v_new->>'retire_date','') IS NULL OR v_new->>'retire_date'>v_today) THEN 'UPSERT' ELSE 'DEACTIVATE' END,
        jsonb_build_object('leave_user_id',v_id,'employee_code',v_new->>'employee_code','employee_name',v_new->>'employee_name',
        'department',v_new->>'department','position',v_new->>'position','active',
        (COALESCE((v_new->>'active')::boolean,false) AND NOT COALESCE((v_new->>'deleted')::boolean,false) AND (NULLIF(v_new->>'retire_date','') IS NULL OR v_new->>'retire_date'>v_today)),
        'retire_date',v_new->>'retire_date','created_at',now()::text));
    END IF;
    v_old:=NULL;
  END LOOP;
  -- A worker deleted from the leave register must still be marked inactive in MES.
  -- Preserve MES history: only enqueue a status change; NEVER delete a MES row.
  FOR v_old IN SELECT value FROM jsonb_array_elements(COALESCE(p_old->'users','[]'::jsonb)) LOOP
    IF COALESCE((v_old->>'is_system_account')::boolean,false) THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_new->'users','[]'::jsonb)) v
                  WHERE v->>'id' = v_old->>'id') THEN
      INSERT INTO public.dnm_leave_mes_outbox(leave_employee_id,employee_code,event_type,payload)
      VALUES((v_old->>'id')::bigint,NULLIF(v_old->>'employee_code',''),'DEACTIVATE',
        jsonb_build_object('leave_user_id',(v_old->>'id')::bigint,'employee_code',v_old->>'employee_code',
        'employee_name',v_old->>'employee_name','department',v_old->>'department',
        'position',v_old->>'position','active',false,'deleted',true,'created_at',now()::text));
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.dnm_leave_get_state()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
 SELECT jsonb_build_object('revision',revision,'payload',payload)
 FROM public.dnm_leave_state WHERE id=1;
$$;
CREATE OR REPLACE FUNCTION public.dnm_leave_initialize(p_state jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_inserted integer;
BEGIN
 IF jsonb_typeof(p_state) <> 'object' OR jsonb_typeof(p_state->'users') <> 'array'
     OR jsonb_typeof(p_state->'requests') <> 'array' THEN RAISE EXCEPTION 'invalid annual leave snapshot'; END IF;
 INSERT INTO public.dnm_leave_state(id,revision,payload) VALUES(1,1,p_state) ON CONFLICT(id) DO NOTHING;
 GET DIAGNOSTICS v_inserted=ROW_COUNT;
 IF v_inserted=1 THEN
   PERFORM public.dnm_leave_sync_projection(p_state);
   RETURN jsonb_build_object('created',true,'revision',1);
 END IF;
 RETURN jsonb_build_object('created',false,'revision',(SELECT revision FROM public.dnm_leave_state WHERE id=1));
END $$;
CREATE OR REPLACE FUNCTION public.dnm_leave_commit(p_expected_revision bigint,p_state jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old jsonb;v_revision bigint;
BEGIN
 IF jsonb_typeof(p_state) <> 'object' OR jsonb_typeof(p_state->'users') <> 'array'
     OR jsonb_typeof(p_state->'requests') <> 'array' THEN RAISE EXCEPTION 'invalid annual leave snapshot'; END IF;
 SELECT payload INTO v_old FROM public.dnm_leave_state WHERE id=1 AND revision=p_expected_revision FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('modified',false); END IF;
 UPDATE public.dnm_leave_state SET revision=revision+1,payload=p_state,updated_at=now() WHERE id=1 RETURNING revision INTO v_revision;
 PERFORM public.dnm_leave_sync_projection(p_state);
 PERFORM public.dnm_leave_enqueue_mes_changes(v_old,p_state);
 RETURN jsonb_build_object('modified',true,'revision',v_revision);
END $$;

-- No browser or unauthenticated access to functions, even though they are in public schema.
REVOKE ALL ON FUNCTION public.dnm_leave_sync_projection(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dnm_leave_enqueue_mes_changes(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dnm_leave_get_state() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dnm_leave_initialize(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dnm_leave_commit(bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dnm_leave_get_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.dnm_leave_initialize(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.dnm_leave_commit(bigint,jsonb) TO service_role;

COMMIT;
