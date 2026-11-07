-- DNM leave -> MES worker master integration.
-- IMPORTANT: this installs a DISABLED bridge. It never edits a MES table until
-- an operator verifies the actual table/columns and explicitly enables mapping.
BEGIN;
CREATE OR REPLACE FUNCTION public.dnm_leave_process_mes_sync(p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE
  cfg public.dnm_leave_mes_config%ROWTYPE;
  v_table regclass; v_record public.dnm_leave_mes_outbox%ROWTYPE;
  v_col text; v_columns text; v_values text; v_updates text;
  v_active_expr text; v_active_text text; v_active_bool boolean;
  v_count integer; v_name_count integer; v_existing_name text; v_done integer:=0;v_error integer:=0;v_review integer:=0;
BEGIN
  SELECT * INTO cfg FROM public.dnm_leave_mes_config WHERE id=1;
  IF NOT FOUND OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('enabled',false,'synced',0,'message','MES 매핑 확인 및 활성화 전입니다. 이벤트는 안전하게 대기합니다.');
  END IF;
  v_table := to_regclass(cfg.target_table);
  IF v_table IS NULL OR split_part(cfg.target_table,'.',1) <> 'public' OR cfg.target_table LIKE 'public.dnm_leave_%' THEN
    RAISE EXCEPTION 'MES 대상은 실제 public 작업자 테이블이어야 하며 연차 전용 테이블을 대상으로 지정할 수 없습니다.';
  END IF;
  IF cfg.code_column IS NULL OR cfg.name_column IS NULL OR cfg.active_column IS NULL THEN
    RAISE EXCEPTION '사번·이름·사용상태 컬럼 설정이 필요합니다.';
  END IF;
  FOREACH v_col IN ARRAY ARRAY[cfg.code_column,cfg.name_column,cfg.active_column,cfg.department_column,cfg.position_column] LOOP
    IF v_col IS NULL OR v_col='' THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=v_table AND attname=v_col AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'MES 대상 테이블에 % 컬럼이 존재하지 않습니다.',v_col;
    END IF;
  END LOOP;
  v_active_expr := CASE WHEN cfg.active_type='boolean' THEN '$3' ELSE '$6' END;
  v_updates := format('%I=$2,%I=%s',cfg.name_column,cfg.active_column,v_active_expr);
  v_columns := format('%I,%I,%I',cfg.code_column,cfg.name_column,cfg.active_column);
  v_values := format('$1,$2,%s',v_active_expr);
  IF cfg.department_column IS NOT NULL AND cfg.department_column <> '' THEN
    v_updates := v_updates || format(',%I=$4',cfg.department_column);
    v_columns := v_columns || format(',%I',cfg.department_column);
    v_values := v_values || ',$4';
  END IF;
  IF cfg.position_column IS NOT NULL AND cfg.position_column <> '' THEN
    v_updates := v_updates || format(',%I=$5',cfg.position_column);
    v_columns := v_columns || format(',%I',cfg.position_column);
    v_values := v_values || ',$5';
  END IF;
  FOR v_record IN
    SELECT * FROM public.dnm_leave_mes_outbox
    WHERE status IN ('pending','error') ORDER BY id FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),100)
  LOOP
    BEGIN
      IF NULLIF(btrim(v_record.employee_code),'') IS NULL THEN
        UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='MES 연계에 필요한 사원코드가 없습니다.',attempts=attempts+1 WHERE id=v_record.id;
        v_review:=v_review+1; CONTINUE;
      END IF;
      -- Do not reactivate a worker whose retirement date has already arrived.
      v_active_bool := v_record.event_type='UPSERT' AND
        (NULLIF(v_record.payload->>'retire_date','') IS NULL OR
         NULLIF(v_record.payload->>'retire_date','')::date > (now() AT TIME ZONE 'Asia/Seoul')::date);
      v_active_text := CASE WHEN v_active_bool THEN cfg.active_yes ELSE cfg.active_no END;
      EXECUTE format('SELECT count(*) FROM %s WHERE %I::text = $1',v_table,cfg.code_column)
        INTO v_count USING v_record.employee_code;
      IF v_count>1 THEN
        UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='MES에 동일 사원코드가 복수 존재합니다. 자동수정하지 않았습니다.',attempts=attempts+1 WHERE id=v_record.id;
        v_review:=v_review+1; CONTINUE;
      END IF;
      IF v_count=0 THEN
        IF NOT v_active_bool THEN
          UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='퇴사자 사원코드가 MES 작업자에 없습니다. 신규 생성하지 않았습니다.',attempts=attempts+1 WHERE id=v_record.id;
          v_review:=v_review+1; CONTINUE;
        END IF;
        EXECUTE format('SELECT count(*) FROM %s WHERE %I::text = $1',v_table,cfg.name_column)
          INTO v_name_count USING v_record.payload->>'employee_name';
        IF v_name_count>0 THEN
          UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='동일 이름의 MES 작업자가 다른 사원코드를 사용할 가능성이 있습니다. 확인 후 연결하세요.',attempts=attempts+1 WHERE id=v_record.id;
          v_review:=v_review+1; CONTINUE;
        END IF;
        EXECUTE format('INSERT INTO %s (%s) VALUES (%s)',v_table,v_columns,v_values)
          USING v_record.employee_code,v_record.payload->>'employee_name',v_active_bool,
                v_record.payload->>'department',v_record.payload->>'position',v_active_text;
      ELSE
        -- A matching code with a different person name needs human review.
        -- This prevents accidental takeover of an unrelated MES worker.
        EXECUTE format('SELECT %I::text FROM %s WHERE %I::text=$1 LIMIT 1',cfg.name_column,v_table,cfg.code_column)
          INTO v_existing_name USING v_record.employee_code;
        IF btrim(coalesce(v_existing_name,'')) <> btrim(coalesce(v_record.payload->>'employee_name','')) THEN
          UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='사원코드는 같지만 MES의 작업자 이름이 다릅니다. 기존 MES 명부와 대조한 뒤 수동 처리하세요.',attempts=attempts+1 WHERE id=v_record.id;
          v_review:=v_review+1; CONTINUE;
        END IF;
        EXECUTE format('UPDATE %s SET %s WHERE %I::text=$1',v_table,v_updates,cfg.code_column)
          USING v_record.employee_code,v_record.payload->>'employee_name',v_active_bool,
                v_record.payload->>'department',v_record.payload->>'position',v_active_text;
      END IF;
      UPDATE public.dnm_leave_mes_outbox SET status='synced',last_error=NULL,attempts=attempts+1,processed_at=now() WHERE id=v_record.id;
      v_done:=v_done+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.dnm_leave_mes_outbox SET status='error',last_error=left(SQLERRM,500),attempts=attempts+1 WHERE id=v_record.id;
      v_error:=v_error+1;
    END;
  END LOOP;
  RETURN jsonb_build_object('enabled',true,'synced',v_done,'errors',v_error,'needs_review',v_review);
END $$;

-- For future-dated retirement, queue a deactivation when the effective date arrives.
-- Only identities that have ever been deliberately queued by a post-migration staff edit
-- are considered here; this cannot mass-disable people from the initial historic roster.
CREATE OR REPLACE FUNCTION public.dnm_leave_reconcile_due_retirements()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_rec record;v_queued integer:=0; v_last_type text;
BEGIN
  FOR v_rec IN
    SELECT e.id,e.employee_code,e.employee_name,e.department,e.job_position,e.retire_date
    FROM public.dnm_leave_employees e
    WHERE e.is_system_account=false AND e.retire_date IS NOT NULL
      AND e.retire_date <= (now() AT TIME ZONE 'Asia/Seoul')::date
      AND EXISTS (SELECT 1 FROM public.dnm_leave_mes_outbox o WHERE o.leave_employee_id=e.id)
  LOOP
    SELECT o.event_type INTO v_last_type FROM public.dnm_leave_mes_outbox o
    WHERE o.leave_employee_id=v_rec.id ORDER BY id DESC LIMIT 1;
    IF v_last_type = 'DEACTIVATE' THEN CONTINUE; END IF;
    INSERT INTO public.dnm_leave_mes_outbox(leave_employee_id,employee_code,event_type,payload)
    VALUES(v_rec.id,v_rec.employee_code,'DEACTIVATE',
      jsonb_build_object('leave_user_id',v_rec.id,'employee_code',v_rec.employee_code,
      'employee_name',v_rec.employee_name,'department',v_rec.department,'position',v_rec.job_position,
      'active',false,'retire_date',v_rec.retire_date,'created_at',now()::text));
    v_queued:=v_queued+1;
  END LOOP;
  RETURN jsonb_build_object('queued_retirements',v_queued);
END $$;
REVOKE ALL ON FUNCTION public.dnm_leave_reconcile_due_retirements() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dnm_leave_reconcile_due_retirements() TO service_role;

REVOKE ALL ON FUNCTION public.dnm_leave_process_mes_sync(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dnm_leave_process_mes_sync(integer) TO service_role;
COMMIT;
