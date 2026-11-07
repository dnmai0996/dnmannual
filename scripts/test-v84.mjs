import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INITIAL_STATE } from '../netlify/functions/_lib/initial-state.js';
import { addDays, todayIsoKst } from '../netlify/functions/_lib/leave.js';
import { ensureStateShape, earliestRetroactiveLeaveDate, handle } from '../netlify/functions/api.mjs';
import { buildSupabaseBackend, snapshotHash, snapshotCounts } from '../netlify/functions/_lib/supabase-store.mjs';
import { MemoryStore } from './test-support/memory-store.mjs';

let n = 0;
const test = async (name, fn) => { await fn(); console.log(`PASS ${String(++n).padStart(2,'0')} ${name}`); };
const mkState = () => ensureStateShape(structuredClone(INITIAL_STATE));
const sample = mkState();
await test('토요일 기준 2영업일 소급: 토·일 제외', () => {
  assert.equal(earliestRetroactiveLeaveDate(sample, 1, '2026-11-07'), '2026-11-05');
  assert.equal(earliestRetroactiveLeaveDate(sample, 1, '2026-11-09'), '2026-11-05');
  assert.equal(earliestRetroactiveLeaveDate(sample, 1, '2026-11-10'), '2026-11-06');
});
await test('회사 지정휴일에 따른 신청 허용 하한 조정', () => {
  const s = mkState();
  s.custom_holidays.push({ id: 9999, company_id: 1, date: '2026-11-06', active: true, name: '사내휴무' });
  assert.equal(earliestRetroactiveLeaveDate(s, 1, '2026-11-09'), '2026-11-04');
});
await test('날짜별 원장 전체 건수 체크 및 JSONB 키 순서에 독립적인 무결성', async () => {
  const hash1 = await snapshotHash({ a: [1, { x: true, y: false }], b: '원문' });
  const hash2 = await snapshotHash({ b: '원문', a: [1, { y: false, x: true }] });
  assert.equal(hash1, hash2);
  assert.equal(snapshotCounts(sample).users, sample.users.length);
  assert.equal(snapshotCounts(sample).roster_history, sample.roster_history.length);
});
const env = { storageMode:'blobs', stateStore:new MemoryStore(),sessionStore:new MemoryStore(),resetBackupStore:new MemoryStore() };
async function call(path,method='GET',body=null,cookie='',status=200) {
  let r;
  try { r=await handle({env,request:new Request('https://dnm.test'+path, {
    method, headers:{origin:'https://dnm.test',...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},
    ...(method==='GET'?{}:{body:JSON.stringify(body||{})})
  })}); } catch(e){r=new Response(JSON.stringify({error:e.message}),{status:e.status||500});}
  const text=await r.text();const data=JSON.parse(text);
  assert.equal(r.status,status,`${path}: ${text}`);
  return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};
}
let admin,employee,approver,backdate;
await test('서버 연차 소급 기준 API 및 권한 검사',async()=>{
  admin=await call('/api/login','POST',{login_id:'admin',password:'0996'});
  await call('/api/leave-request-policy','GET',null,'',401);
  const s=await env.stateStore.get('state');
  const worker=s.users.find(u=>!u.is_system_account&&!u.can_approve_first&&!u.is_admin&&u.active);
  approver=s.users.find(u=>u.can_approve_first && u.company_id===worker.company_id&&u.id!==worker.id);
  assert(worker && approver);
  employee=await call('/api/login','POST',{login_id:worker.login_id,password:'1111'});
  const policy=(await call('/api/leave-request-policy','GET',null,employee.cookie)).data;
  assert.equal(policy.retroactive_business_days,2);
  backdate=policy.earliest_date;
  assert(backdate<=todayIsoKst());
});
await test('최대 2영업일 전 사용분 신청 가능, 더 오래된 일자는 차단',async()=>{
  const ok=(await call('/api/leave-requests','POST',{
    leave_type:'FULL',start_date:backdate,end_date:backdate,approver_ids:[approver.id],reason:'사후 신청 테스트'
  },employee.cookie)).data;
  assert(ok.id>0);
  await call('/api/leave-requests','POST',{
    leave_type:'FULL',start_date:addDays(backdate,-1),end_date:addDays(backdate,-1),approver_ids:[approver.id],reason:'범위 초과'
  },employee.cookie,400);
});
await test('이관 중 Blobs 동결 시 기존 승인·신청 쓰기 차단(423)',async()=>{
  const row=await env.stateStore.getWithMetadata('state');
  const s=row.data;
  s.dnm_migration={ frozen:true, backup_sha256:'0'.repeat(64) };
  await env.stateStore.setJSON('state',s,{onlyIfMatch:row.etag});
  let workDay=addDays(todayIsoKst(),7);
  while ([0,6].includes(new Date(`${workDay}T00:00:00Z`).getUTCDay())) workDay=addDays(workDay,1);
  await call('/api/leave-requests','POST',{
    leave_type:'FULL',start_date:workDay,end_date:workDay,
    approver_ids:[approver.id],reason:'동결 시 쓰기'
  },employee.cookie,423);
});
await test('미설정 MES 연계 상태는 안전하게 비활성 표시',async()=>{
  const r=await call('/api/admin/mes-sync/status','GET',null,admin.cookie);
  assert.equal(r.data.active,false);
});
await test('Supabase 어댑터: 조건부 원자적 쓰기, 버전 충돌 감지',async()=>{
  let row=null;
  const rpc=async(name,args={})=>{
    if(name==='dnm_leave_get_state')return {data:row};
    if(name==='dnm_leave_initialize'){
      if(row)return {data:{created:false,revision:row.revision}};
      row={revision:1,payload:structuredClone(args.p_state)};
      return {data:{created:true,revision:1}};
    }
    if(name==='dnm_leave_commit'){
      if(!row||row.revision!==args.p_expected_revision)return {data:{modified:false}};
      row={revision:row.revision+1,payload:structuredClone(args.p_state)};
      return {data:{modified:true,revision:row.revision}};
    }
    if(name==='dnm_leave_process_mes_sync')return {data:{enabled:false,synced:0}};
    throw Error('Unexpected RPC '+name);
  };
  const {stateStore}=buildSupabaseBackend({rpc});
  const init=await stateStore.setJSON('state',sample,{onlyIfNew:true});assert(init.modified);
  const a=await stateStore.getWithMetadata('state');assert.equal(a.etag,'pg:1');
  const b=structuredClone(a.data);b.memo='변경';
  assert((await stateStore.setJSON('state',b,{onlyIfMatch:a.etag})).modified);
  assert.equal((await stateStore.getWithMetadata('state')).etag,'pg:2');
  assert.equal((await stateStore.setJSON('state',b,{onlyIfMatch:a.etag})).modified,false);
  assert.equal((await stateStore.getWithMetadata('state')).data.memo,'변경');
});
await test('SQL은 MES 대상 DROP/DELETE 없이 연차 전용 네임스페이스만 생성',()=>{
  const schema=readFileSync(new URL('../database/01_install_leave.sql',import.meta.url),'utf8');
  assert(schema.includes('dnm_leave_state')&&schema.includes('dnm_leave_mes_outbox'));
  assert(schema.includes('ROW LEVEL SECURITY'));
  assert(schema.includes('p_expected_revision'));
  assert(!/\bDROP\s+TABLE\b/i.test(schema));
  const bridge=readFileSync(new URL('../database/02_mes_sync.sql',import.meta.url),'utf8');
  assert(bridge.includes('cfg.enabled'));
  assert(bridge.includes('dnm_leave_reconcile_due_retirements'));
  assert(bridge.includes('btrim(coalesce(v_existing_name'));
  assert(readFileSync(new URL('../netlify/functions/leave-daily-sync.mjs',import.meta.url),'utf8').includes("schedule: '10 0 * * *'"));
});
console.log(`DNM v8.4 RESULT: ${n} extended tests passed`);
