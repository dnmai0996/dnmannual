-- OPTIONAL ONLY. DOES NOT RUN DURING v8.5 INSTALL/DEPLOY.
-- Explicitly requested removal candidate:
--   김정배 (임원, active=false, hired=2022-02-07),
--   MES code EMP-289315463C7E7209.
-- Pre-conditions: download backups of MES and annual leave. Use at a quiet time.
-- Any linked record or reference (JSON, UUID, text), or a changed identity => ABORT.
-- The row is archived in dnm_leave_mes_cleanup_archive before removal.
-- NOTE: this is the *only* script that may delete one MES worker. Other scripts never do.
BEGIN;
DO $$
DECLARE v_row public.dnm_v4_records%ROWTYPE;
 v_ref record; v_count bigint; v_total bigint:=0;
BEGIN
 SELECT * INTO v_row FROM public.dnm_v4_records
 WHERE kind='employee' AND code='EMP-289315463C7E7209' AND title='김정배'
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE NOTICE '삭제 대상 미사용 김정배가 존재하지 않아 변경 없이 종료합니다.';
   RETURN;
 END IF;
 IF coalesce((v_row.data->>'active')::boolean,true) <> false
    OR coalesce(v_row.data->>'hired','') <> '2022-02-07' THEN
   RAISE EXCEPTION '미사용 계정 확인에 실패했습니다. 삭제하지 않았습니다.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.dnm_leave_mes_links WHERE mes_record_id=v_row.id OR mes_code=v_row.code) THEN
   RAISE EXCEPTION '연차관리와 연결된 MES 작업자는 삭제하지 않습니다.';
 END IF;
 FOR v_ref IN SELECT table_name,column_name,data_type FROM information_schema.columns
  WHERE table_schema='public' AND table_name LIKE 'dnm_%'
   AND table_name NOT LIKE 'dnm_leave_%'
   AND data_type IN ('text','jsonb','uuid')
 LOOP
  IF v_ref.table_name='dnm_v4_records' THEN
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id <> $1 AND (%I::text LIKE $2 OR %I::text LIKE $3)',
     v_ref.table_name,v_ref.column_name,v_ref.column_name)
     INTO v_count USING v_row.id,'%'||v_row.code||'%','%'||v_row.id::text||'%';
  ELSE
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I::text LIKE $1 OR %I::text LIKE $2',
     v_ref.table_name,v_ref.column_name,v_ref.column_name)
     INTO v_count USING '%'||v_row.code||'%','%'||v_row.id::text||'%';
  END IF;
  v_total:=v_total+coalesce(v_count,0);
 END LOOP;
 IF v_total>0 THEN
   RAISE EXCEPTION '다른 MES 테이블에서 해당 코드 또는 UUID 참조 %건 발견. 삭제하지 않았습니다.',v_total;
 END IF;
 INSERT INTO public.dnm_leave_mes_cleanup_archive(mes_record_id,mes_code,snapshot,reason)
 VALUES(v_row.id,v_row.code,to_jsonb(v_row),'김정배 미사용 계정, 사용자 승인 및 참조검사 통과')
 ON CONFLICT(mes_record_id) DO NOTHING;
 DELETE FROM public.dnm_v4_records
 WHERE id=v_row.id AND kind='employee' AND code='EMP-289315463C7E7209'
   AND coalesce((data->>'active')::boolean,true)=false;
 IF NOT FOUND THEN RAISE EXCEPTION '삭제 대상이 변경되었습니다. 전체 작업 취소'; END IF;
 RAISE NOTICE '미사용 김정배 1건을 기록 보존 후 정리했습니다.';
END $$;
COMMIT;
