-- DNM Annual v8.5: Existing DNM MES JSON worker-master integration.
-- Run AFTER 01_install_leave.sql and 02_mes_sync.sql on the SAME Supabase project.
-- SAFE ON INSTALL: creates mapping and preview functions. NO employee numbers or MES rows
-- change until the annual-leave super administrator explicitly approves linking in the UI.
-- Important: this is for public.dnm_v4_records(kind='employee',data jsonb) ONLY.
BEGIN;

DO $$
BEGIN
 IF to_regclass('public.dnm_v4_records') IS NULL THEN
   RAISE EXCEPTION 'MES table public.dnm_v4_records not found. Do not install on a different project.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='dnm_v4_records'
   AND column_name='data' AND data_type='jsonb') THEN
   RAISE EXCEPTION 'MES JSON data field not found. Stop and verify MES schema.';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.dnm_leave_mes_links (
 leave_user_id bigint PRIMARY KEY,
 mes_record_id uuid NOT NULL UNIQUE,
 mes_code text NOT NULL UNIQUE,
 former_leave_code text,
 linked_at timestamptz NOT NULL DEFAULT now(),
 link_method text NOT NULL DEFAULT 'name_hired_active',
 CONSTRAINT dnm_leave_mes_record_ref FOREIGN KEY (mes_record_id)
   REFERENCES public.dnm_v4_records(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS public.dnm_leave_mes_cleanup_archive (
 mes_record_id uuid PRIMARY KEY,
 mes_code text NOT NULL,
 snapshot jsonb NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL
);
ALTER TABLE public.dnm_leave_mes_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dnm_leave_mes_cleanup_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dnm_leave_mes_links,public.dnm_leave_mes_cleanup_archive FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.dnm_leave_mes_links,public.dnm_leave_mes_cleanup_archive TO service_role;

-- Preview based on normalized name + EXACT hire date + MES active flag.
-- It deliberately distinguishes 이상훈(2공장)/2016 from 이상훈(품질팀)/2023,
-- and active 김정배/2015 from inactive 김정배/2022.
CREATE OR REPLACE FUNCTION public.dnm_leave_mes_link_preview()
RETURNS TABLE(leave_user_id bigint,leave_name text,leave_code text,leave_hired text,
              match_count bigint,mes_record_id uuid,mes_code text,mes_name text,decision text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp STABLE AS $$
WITH leave_list AS (
 SELECT e.id, e.employee_name, e.employee_code, e.join_date::text AS hired,
        btrim(regexp_replace(e.employee_name,'[[:space:]]*\([^)]*\)$','','g')) AS nm
 FROM public.dnm_leave_employees e
 WHERE NOT e.is_system_account AND e.active AND e.retire_date IS NULL
), mes_list AS (
 SELECT r.id,r.code,r.title,r.data->>'hired' AS hired,
   btrim(regexp_replace(r.title,'[[:space:]]*\([^)]*\)$','','g')) AS nm
 FROM public.dnm_v4_records r
 WHERE r.kind='employee' AND COALESCE((r.data->>'active')::boolean,false)=true
), candidates AS (
 SELECT l.id AS leave_id, COUNT(m.id)::bigint AS n, MIN(m.id::text)::uuid AS candidate_id,
        MIN(m.code) AS candidate_code,MIN(m.title) AS candidate_name
 FROM leave_list l LEFT JOIN mes_list m ON l.nm=m.nm AND l.hired=m.hired
 GROUP BY l.id
), leave_dupes AS (
 SELECT nm,hired,COUNT(*) AS n FROM leave_list GROUP BY nm,hired
)
SELECT l.id,l.employee_name,l.employee_code,l.hired,c.n,c.candidate_id,c.candidate_code,c.candidate_name,
 CASE WHEN lk.leave_user_id IS NOT NULL THEN 'linked'
      WHEN ld.n>1 THEN 'duplicate_leave_identity'
      WHEN c.n=1 AND NOT EXISTS (SELECT 1 FROM public.dnm_leave_mes_links other
                              WHERE other.mes_record_id=c.candidate_id AND other.leave_user_id<>l.id) THEN 'ready'
      WHEN c.n=0 THEN 'needs_review_no_mes_match'
      ELSE 'needs_review_multiple' END
FROM leave_list l
JOIN candidates c ON c.leave_id=l.id
JOIN leave_dupes ld ON ld.nm=l.nm AND ld.hired=l.hired
LEFT JOIN public.dnm_leave_mes_links lk ON lk.leave_user_id=l.id
ORDER BY l.employee_name,l.id;
$$;

-- Called from the server after verifying the super-admin password and exact phrase.
-- Lock state so concurrent leave transactions cannot be overwritten. No MES row is edited.
CREATE OR REPLACE FUNCTION public.dnm_leave_mes_apply_links(p_expected_revision bigint,p_enable_sync boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_state jsonb; v_updated jsonb; v_users jsonb; v_rev bigint; v_count integer:=0; v_link record;
BEGIN
 SELECT revision,payload INTO v_rev,v_state FROM public.dnm_leave_state WHERE id=1 FOR UPDATE;
 IF NOT FOUND OR v_rev IS DISTINCT FROM p_expected_revision THEN
   RETURN jsonb_build_object('modified',false,'message','동시에 연차정보가 변경되었습니다. 다시 미리보기를 실행하세요.');
 END IF;
 -- Scan only unique confirmed pairs; leave unrelated or ambiguous employees untouched.
 FOR v_link IN SELECT * FROM public.dnm_leave_mes_link_preview() WHERE decision='ready' LOOP
   IF EXISTS (SELECT 1 FROM public.dnm_leave_mes_links
              WHERE mes_record_id=v_link.mes_record_id OR mes_code=v_link.mes_code) THEN
     CONTINUE;
   END IF;
   IF EXISTS (SELECT 1 FROM public.dnm_leave_employees e WHERE e.id<>v_link.leave_user_id AND e.employee_code=v_link.mes_code) THEN
     CONTINUE;
   END IF;
   INSERT INTO public.dnm_leave_mes_links(leave_user_id,mes_record_id,mes_code,former_leave_code)
   VALUES(v_link.leave_user_id,v_link.mes_record_id,v_link.mes_code,v_link.leave_code)
   ON CONFLICT DO NOTHING;
   IF FOUND THEN v_count:=v_count+1; END IF;
 END LOOP;
 IF v_count>0 THEN
   SELECT coalesce(jsonb_agg(CASE WHEN link.leave_user_id IS NULL THEN t.elem
              ELSE t.elem || jsonb_build_object('employee_code',link.mes_code,
                'former_employee_code',coalesce(t.elem->>'former_employee_code',t.elem->>'employee_code'),
                'mes_record_id',link.mes_record_id::text,'mes_linked_at',now()::text)
           END ORDER BY t.ord),'[]'::jsonb)
   INTO v_users FROM jsonb_array_elements(v_state->'users') WITH ORDINALITY t(elem,ord)
   LEFT JOIN public.dnm_leave_mes_links link ON link.leave_user_id=(t.elem->>'id')::bigint;
   v_updated=jsonb_set(v_state,'{users}',v_users,true);
   UPDATE public.dnm_leave_state SET payload=v_updated,revision=revision+1,updated_at=now()
   WHERE id=1 RETURNING revision INTO v_rev;
   PERFORM public.dnm_leave_sync_projection(v_updated);
 END IF;
 IF p_enable_sync THEN
   UPDATE public.dnm_leave_mes_config SET enabled=true,target_table='public.dnm_v4_records',
   code_column='code',name_column='title',active_column='data',
   department_column=NULL,position_column=NULL,updated_at=now() WHERE id=1;
 END IF;
 RETURN jsonb_build_object('modified',true,'new_links',v_count,'revision',v_rev,
   'sync_enabled',p_enable_sync,
   'note','연차 내부 사용자 ID와 기존 MES 데이터는 유지했습니다. 미일치 직원은 자동 병합하지 않습니다.');
END $$;

-- DNM MES JSON worker sync: never deletes MES records, never merges people by name alone.
CREATE OR REPLACE FUNCTION public.dnm_leave_process_mes_sync(p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.dnm_leave_mes_config%ROWTYPE; ev public.dnm_leave_mes_outbox%ROWTYPE;
 link public.dnm_leave_mes_links%ROWTYPE; actor jsonb; snap jsonb; v_users jsonb;
 v_live boolean;v_name text;v_dept text;v_pos text;v_hired text;v_code text;v_uuid uuid;
 v_dup integer; v_rev bigint;v_state_name text;
 v_ok integer:=0;v_review integer:=0;v_err integer:=0;v_created integer:=0;
BEGIN
 SELECT * INTO cfg FROM public.dnm_leave_mes_config WHERE id=1;
 IF NOT FOUND OR NOT cfg.enabled THEN
   RETURN jsonb_build_object('enabled',false,'synced',0,'message','MES 연계 승인 전입니다.');
 END IF;
 IF cfg.target_table IS DISTINCT FROM 'public.dnm_v4_records' THEN
   RAISE EXCEPTION '잘못된 MES 매핑 설정입니다. 기대값: public.dnm_v4_records';
 END IF;
 FOR ev IN SELECT * FROM public.dnm_leave_mes_outbox
   WHERE status IN ('pending','error') ORDER BY id FOR UPDATE SKIP LOCKED
   LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),100)
 LOOP
  BEGIN
   -- All decisions are based on CURRENT leave state (never a stale event payload).
   SELECT revision,payload INTO v_rev,snap FROM public.dnm_leave_state WHERE id=1 FOR UPDATE;
   SELECT x.value INTO actor FROM jsonb_array_elements(snap->'users') x
     WHERE x.value->>'id'=ev.leave_employee_id::text LIMIT 1;
   IF actor IS NULL THEN
     -- A previously linked no-history employee may have been physically removed
     -- from leave manager. The immutable MES link still permits a safe deactivation.
     SELECT * INTO link FROM public.dnm_leave_mes_links WHERE leave_user_id=ev.leave_employee_id;
     IF FOUND AND ev.event_type='DEACTIVATE' THEN
       UPDATE public.dnm_v4_records m SET
         data=jsonb_set(jsonb_set(coalesce(m.data,'{}'::jsonb),'{active}','false'::jsonb,true),
                          '{login_enabled}','false'::jsonb,true), updated_at=now()
       WHERE m.id=link.mes_record_id AND m.kind='employee' AND m.code=link.mes_code;
       IF FOUND THEN
         UPDATE public.dnm_leave_mes_outbox SET status='synced',last_error=NULL,attempts=attempts+1,processed_at=now() WHERE id=ev.id;
         v_ok:=v_ok+1; CONTINUE;
       END IF;
     END IF;
     UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='현재 연차관리 직원정보가 없거나 연결을 확인할 수 없습니다.',attempts=attempts+1 WHERE id=ev.id;
     v_review:=v_review+1;CONTINUE;
   END IF;
   IF COALESCE((actor->>'is_system_account')::boolean,false) THEN
     UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='시스템 계정은 MES 작업자로 등록하지 않습니다.',attempts=attempts+1 WHERE id=ev.id;
     v_review:=v_review+1;CONTINUE;
   END IF;
   v_name=btrim(regexp_replace(coalesce(actor->>'employee_name',''),'[[:space:]]*\([^)]*\)$','','g'));
   v_hired=actor->>'join_date';v_dept=actor->>'department';v_pos=actor->>'position';
   v_live=COALESCE((actor->>'active')::boolean,false)
     AND NOT COALESCE((actor->>'deleted')::boolean,false)
     AND (NULLIF(actor->>'retire_date','') IS NULL OR (actor->>'retire_date')::date>(now() AT TIME ZONE 'Asia/Seoul')::date);
   SELECT * INTO link FROM public.dnm_leave_mes_links WHERE leave_user_id=ev.leave_employee_id;
   IF FOUND THEN
     -- Strict, immutable physical MES record id; do not modify a look-alike or same-name worker.
     SELECT id INTO v_uuid FROM public.dnm_v4_records
       WHERE id=link.mes_record_id AND kind='employee' AND code=link.mes_code;
     IF v_uuid IS NULL THEN
       UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='연결된 MES 작업자를 찾을 수 없습니다. 작업자 ID/코드를 확인하세요.',attempts=attempts+1 WHERE id=ev.id;
       v_review:=v_review+1;CONTINUE;
     END IF;
     UPDATE public.dnm_v4_records m SET
       data=jsonb_set(jsonb_set(jsonb_set(jsonb_set(coalesce(m.data,'{}'::jsonb),'{active}',to_jsonb(v_live),true),
         '{department}',to_jsonb(coalesce(v_dept,'')),true),'{position}',to_jsonb(coalesce(v_pos,'')),true),
         '{login_enabled}',to_jsonb(CASE WHEN v_live THEN COALESCE((m.data->>'login_enabled')::boolean,false) ELSE false END),true),
       updated_at=now()
       WHERE m.id=link.mes_record_id;
   ELSIF v_live THEN
     -- Never duplicate a pre-existing worker with the same canonical name & hire date.
     SELECT COUNT(*) INTO v_dup FROM public.dnm_v4_records m
       WHERE m.kind='employee' AND btrim(regexp_replace(m.title,'[[:space:]]*\([^)]*\)$','','g'))=v_name
             AND m.data->>'hired'=v_hired;
     IF v_dup>0 OR v_name='' OR coalesce(v_hired,'')='' THEN
       UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='MES에 동일 인적사항이 있거나 입사일이 없습니다. 기존 작업자와의 연결을 먼저 확인하세요.',attempts=attempts+1 WHERE id=ev.id;
       v_review:=v_review+1;CONTINUE;
     END IF;
     -- New personnel get a NEW MES-style code. The legacy numeric leave code is preserved.
     LOOP
       v_code='EMP-'||upper(encode(gen_random_bytes(8),'hex'));
       EXIT WHEN NOT EXISTS (SELECT 1 FROM public.dnm_v4_records WHERE code=v_code);
     END LOOP;
     SELECT m.state INTO v_state_name FROM public.dnm_v4_records m
       WHERE m.kind='employee' AND m.data->>'active'='true' ORDER BY m.created_at DESC LIMIT 1;
     v_uuid=gen_random_uuid();
     INSERT INTO public.dnm_v4_records(id,kind,code,title,state,data,version)
       VALUES(v_uuid,'employee',v_code,v_name,coalesce(v_state_name,'active'),
         jsonb_build_object('active',true,'login_enabled',false,'verified',false,'review_required',true,
                            'department',coalesce(v_dept,''),'position',coalesce(v_pos,''),
                            'hired',v_hired,'site',coalesce(actor->>'site','')),
         1);
     INSERT INTO public.dnm_leave_mes_links(leave_user_id,mes_record_id,mes_code,former_leave_code,link_method)
       VALUES(ev.leave_employee_id,v_uuid,v_code,actor->>'employee_code','new_worker') ;
     SELECT coalesce(jsonb_agg(CASE WHEN x.value->>'id'=ev.leave_employee_id::text
          THEN x.value || jsonb_build_object('employee_code',v_code,
            'former_employee_code',coalesce(x.value->>'former_employee_code',x.value->>'employee_code'),
            'mes_record_id',v_uuid::text,'mes_linked_at',now()::text)
          ELSE x.value END ORDER BY x.n),'[]'::jsonb)
       INTO v_users FROM jsonb_array_elements(snap->'users') WITH ORDINALITY x(value,n);
     UPDATE public.dnm_leave_state SET revision=revision+1,
       payload=jsonb_set(snap,'{users}',v_users,true),updated_at=now() WHERE id=1;
     PERFORM public.dnm_leave_sync_projection(jsonb_set(snap,'{users}',v_users,true));
     v_created:=v_created+1;
   ELSE
     UPDATE public.dnm_leave_mes_outbox SET status='needs_review',last_error='MES에 아직 연결된 작업자가 없어 퇴사/미사용 처리를 건너뛰었습니다.',attempts=attempts+1 WHERE id=ev.id;
     v_review:=v_review+1;CONTINUE;
   END IF;
   UPDATE public.dnm_leave_mes_outbox SET status='synced',last_error=NULL,attempts=attempts+1,processed_at=now() WHERE id=ev.id;
   v_ok:=v_ok+1;
  EXCEPTION WHEN OTHERS THEN
   UPDATE public.dnm_leave_mes_outbox SET status='error',last_error=left(SQLERRM,500),attempts=attempts+1 WHERE id=ev.id;
   v_err:=v_err+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('enabled',true,'synced',v_ok,'created_workers',v_created,'needs_review',v_review,'errors',v_err);
END $$;

-- Keep bridge default DISABLED on installation. Prior MES version using generic table mapping
-- is not switched automatically. Only the admin-confirmed apply_links() activates it.
UPDATE public.dnm_leave_mes_config SET enabled=false WHERE id=1;

REVOKE ALL ON FUNCTION public.dnm_leave_mes_link_preview() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dnm_leave_mes_apply_links(bigint,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dnm_leave_process_mes_sync(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dnm_leave_mes_link_preview() TO service_role;
GRANT EXECUTE ON FUNCTION public.dnm_leave_mes_apply_links(bigint,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.dnm_leave_process_mes_sync(integer) TO service_role;
COMMIT;
