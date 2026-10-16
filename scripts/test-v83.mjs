import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import vm from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const outputDir=process.env.DNM_TEST_OUTPUT_DIR||join(tmpdir(),'dnm-v83-tests');
import {INITIAL_STATE} from '../netlify/functions/_lib/initial-state.js';
import {ROSTER_2026} from '../netlify/functions/_lib/roster-2026.js';
import {parts,minutesFromParts,cycleBalance,cycleHistory,normalizeCharge,requestMinutesInRange} from '../netlify/functions/_lib/balance.js';
import {serviceCycle,addDays,todayIsoKst} from '../netlify/functions/_lib/leave.js';
import {parseRosterWorkbook} from '../netlify/functions/_lib/roster.js';
import {handle,ensureStateShape,calculateLeave,userSummary,passwordHash} from '../netlify/functions/api.mjs';
import {MemoryStore} from './test-support/memory-store.mjs';
import { comparePeople, sortPeople, titleRank, DNM_SORT_LABEL } from '../public/org-sort.js';
import {PAGE_GUIDES} from '../public/help-pages.js';
let tests=0;
async function test(name,fn){await fn();tests++;console.log(`PASS ${String(tests).padStart(2,'0')} ${name}`);}
const fresh=()=>ensureStateShape(structuredClone(INITIAL_STATE));
const person={id:1000,join_date:'2024-10-16',leave_basis_date:'2024-10-16'};
const approved=(m,date,extra={})=>({id:1,user_id:1000,source:'APPLICATION',approval_state:'APPROVED',status1:'APPROVED',status_final:'APPROVED',minutes:m,leave_type:'HOURLY',start_date:date,end_date:date,...extra});
const empty=()=>({requests:[],adjustments:[],cycle_grants:[]});
await test('0.5시간 단위 및 정수 일수 분해',()=>{assert.deepEqual([parts(30).days,parts(30).hours],[0,.5]);assert.deepEqual([parts(480).days,parts(480).hours],[1,0]);assert.deepEqual([parts(15*480-30).days,parts(15*480-30).hours],[14,7.5]);assert.equal(minutesFromParts(2,7.5),1410);assert.throws(()=>minutesFromParts(.5,0));assert.throws(()=>minutesFromParts(0,.3));assert.throws(()=>minutesFromParts(0,8));});
await test('모든 30분 값의 역변환 (0~250일)',()=>{for(let m=0;m<=250*480;m+=30){const p=parts(m);assert(Number.isInteger(p.days));assert(p.hours>=0&&p.hours<8);assert.equal(minutesFromParts(p.days,p.hours),m);}assert.equal(parts(-30).sign,-1);});
await test('0.5시간 승인 후 잔여가 소실되지 않음',()=>{const s=empty();s.requests.push(approved(30,'2026-10-15'));assert.equal(cycleBalance(s,person,'2026-10-15').amounts.remaining.minutes,7170);});
await test('입사기념일 이전 잔여 소멸 / 새 주기 발생',()=>{const s=empty();s.requests.push(approved(30,'2026-10-15'));assert.equal(cycleBalance(s,person,'2026-10-16').amounts.remaining.minutes,7200);const hist=cycleHistory(s,person,'2026-10-16');assert.equal(hist[1].expired.minutes,7170);assert.equal(hist[0].carryover.minutes,0);assert.equal(s.requests.length,1);});
await test('1년 미만 11일 및 첫 주년 15일 재발생',()=>{const p={...person,join_date:'2025-10-16',leave_basis_date:'2025-10-16'},s=empty();assert.equal(cycleBalance(s,p,'2026-10-15').granted,11);assert.equal(cycleBalance(s,p,'2026-10-16').granted,15);assert.equal(cycleBalance(s,p,'2025-10-20').granted,0);assert.equal(cycleBalance(s,p,'2025-11-16').granted,1);});
await test('근속가산 및 25일 한도',()=>{assert.equal(serviceCycle('2023-10-16','2026-10-16').granted,16);assert.equal(serviceCycle('2000-10-16','2026-10-16').granted,25);});
await test('윤년 2월29일 및 말일 주기',()=>{assert.equal(serviceCycle('2024-02-29','2025-02-27').service_year,0);assert.equal(serviceCycle('2024-02-29','2025-02-28').cycle_start,'2025-02-28');assert.equal(serviceCycle('2024-02-29','2028-02-29').cycle_start,'2028-02-29');assert.equal(serviceCycle('2024-01-31','2025-01-30').cycle_end,'2025-01-30');});
await test('주년을 걸친 요청을 날짜별로 분배',()=>{const s=empty();s.requests.push(approved(60,'2026-10-15',{end_date:'2026-10-16',hourly_segments:[{date:'2026-10-15',minutes:30},{date:'2026-10-16',minutes:30}]}));assert.equal(cycleBalance(s,person,'2026-10-15').used,.0625);assert.equal(cycleBalance(s,person,'2026-10-16').used,.0625);});
await test('다일 하루 신청 분배 및 이전 합계 자료 주의표시',()=>{const r=approved(960,'2026-10-15',{end_date:'2026-10-16',leave_type:'FULL',charge_dates:['2026-10-15','2026-10-16']});normalizeCharge(r);assert.equal(requestMinutesInRange(r,'2026-10-16','2027-10-15'),480);const legacy=approved(720,'2026-01-01',{end_date:'2026-12-31',leave_type:'IMPORTED_SUMMARY'});normalizeCharge(legacy);assert(legacy.allocation_note);assert.equal(legacy.minutes,720);});
await test('반려·취소는 사용량 제외 / 결재대기 별도',()=>{const s=empty();s.requests=[approved(30,'2026-10-16',{approval_state:'REJECTED',status_final:'REJECTED'}),approved(60,'2026-10-16',{approval_state:'CANCELLED',status_final:'CANCELLED'}),approved(90,'2026-10-16',{approval_state:'PENDING',status1:'PENDING',status_final:'WAITING'})];const b=cycleBalance(s,person,'2026-10-16');assert.equal(b.used,0);assert.equal(b.amounts.pending.minutes,90);assert.equal(b.amounts.projected_remaining.minutes,7110);});
await test('가감조정 귀속 및 관리자 발생량 수정',()=>{const s=empty();s.adjustments=[{user_id:1000,effective_date:'2026-10-15',minutes:30},{user_id:1000,effective_date:'2026-10-16',minutes:-30}];s.cycle_grants=[{user_id:1000,cycle_start:'2026-10-16',minutes:4800}];const b=cycleBalance(s,person,'2026-10-16');assert.equal(b.granted,10);assert.equal(b.amounts.remaining.minutes,4770);});
await test('퇴사 이후 발생량 고정',()=>{const p={...person,retire_date:'2026-10-15'};assert.equal(cycleBalance(empty(),p,'2027-12-01').cycle_start,'2025-10-16');});
await test('새 명부 47명 + 퇴직57행 + 과거입사50행 분리',()=>{assert.equal(ROSTER_2026.current.length,47);assert.equal(ROSTER_2026.history.filter(r=>r.section==='retired').length,57);assert.equal(ROSTER_2026.history.filter(r=>r.section==='hire_history').length,50);assert(!/\b\d{6}-[1-4]\d{6}\b/.test(JSON.stringify(INITIAL_STATE)));assert(!/\b\d{6}-[1-4]\d{6}\b/.test(JSON.stringify(ROSTER_2026)));const s=fresh();assert.equal(s.users.filter(u=>!u.is_system_account).length,47);assert(s.users.find(u=>u.employee_name==='김정배').is_admin);});
await test('v8.1 기존 직원 ID·비밀번호·신청 이력 보존',async()=>{const s=fresh(),u=s.users.find(x=>!x.is_system_account);const hash=await passwordHash('existing-pass-xyz');u.password_hash=hash;u.join_date='2020-01-15';u.leave_basis_date='2020-01-15';s.dnm82_migrated=false;s.requests.push({id:222,user_id:u.id,leave_type:'HOURLY',days:.0625,hours:.5,source:'EXCEL_UPLOAD',start_date:'2026-10-15',end_date:'2026-10-15',status1:'APPROVED',status_final:'APPROVED'});const updated=ensureStateShape(s);assert.equal(updated.users.find(x=>x.id===u.id).password_hash,hash);assert.equal(updated.users.find(x=>x.id===u.id).leave_basis_date,'2020-01-15');assert.equal(updated.requests[0].minutes,30);});
const state=fresh(),worker=state.users.find(x=>!x.is_system_account&&!x.is_admin);
await test('신청 계산: 30분·반차·하루·점심 제외',()=>{const calc=(a,b)=>calculateLeave(state,worker,'HOURLY','','',`2026-10-19T${a}`,`2026-10-19T${b}`);assert.equal(calc('09:00','09:30').minutes,30);assert.equal(calc('12:00','14:00').minutes,60);assert.equal(calc('08:30','17:30').minutes,480);assert.equal(calculateLeave(state,worker,'AM_HALF','2026-10-19','2026-10-19').minutes,240);assert.equal(calculateLeave(state,worker,'FULL','2026-10-19','2026-10-20').minutes,960);});
await test('15분·역방향·휴일·과대기간 신청 거절',()=>{assert.throws(()=>calculateLeave(state,worker,'HOURLY','','','2026-10-19T09:15','2026-10-19T09:30'));assert.throws(()=>calculateLeave(state,worker,'HOURLY','','','2026-10-19T10:00','2026-10-19T09:30'));assert.throws(()=>calculateLeave(state,worker,'FULL','2026-10-18','2026-10-18'));assert.throws(()=>calculateLeave(state,worker,'FULL','2026-10-09','2026-10-09'));assert.throws(()=>calculateLeave(state,worker,'FULL','2026-01-01','2028-01-01'));});
await test('추가휴일 제외',()=>{const s=fresh();s.custom_holidays=[{id:1,company_id:worker.company_id,date:'2026-10-19',name:'테스트휴일',active:true}];const r=calculateLeave(s,worker,'FULL','2026-10-19','2026-10-20');assert.equal(r.minutes,480);assert.equal(r.charge_dates[0],'2026-10-20');});
await test('Excel 파서 원본 2줄·주민등록번호 제외·구역 구분',()=>{const rows=[];rows[1]=['','* 2026년 07월20일 현재'];rows[2]=['','','','성명','','','','','','','','입사일자'];rows[3]=['','',1,'테스트직원','사원','생산','남',25,'TEST_SENSITIVE_FIELD','주소1','이력1','2024.10.16','','010-0000-0000','승진 참고'];rows[4]=['','','','','','','','','','주소2','이력2'];rows[5]=['','퇴직자'];rows[6]=['','',1,'퇴직직원','사원','생산','','','','','','2022-01-01','','','퇴사일 미상'];rows[7]=['','【입사자】'];rows[8]=['','',1,'과거직원','사원','생산','','','','','','2021-01-01'];const ws={name:'2026',columnCount:15,eachRow(o,fn){rows.forEach((r,i)=>fn({getCell:j=>({value:r?.[j-1]})},i+1));}};const d=parseRosterWorkbook({worksheets:[ws]},'fixture.xlsx');assert.equal(d.current.length,1);assert.equal(d.history.length,2);assert(d.source_as_of_text.includes('07월20일'));assert.equal(d.current[0].address,'주소1 주소2');assert(!JSON.stringify(d).includes('TEST_SENSITIVE_FIELD'));});
const env={stateStore:new MemoryStore(),sessionStore:new MemoryStore(),resetBackupStore:new MemoryStore()};
async function call(path,method='GET',body=null,cookie='',expected=200){let r;try{r=await handle({env,request:new Request('https://dnm.test'+path,{method,headers:{...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),origin:'https://dnm.test'},...(method==='GET'?{}:{body:body instanceof FormData?body:JSON.stringify(body||{})})})});}catch(e){r=new Response(JSON.stringify({error:e.message}),{status:e.status||500,headers:{'content-type':'application/json'}});}const data=await r.json();assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};}
let admin,emp,ceo,ap1,ap2,empRow,originalHash;
await test('관리자·대표이사·직원 로그인 및 권한 분리',async()=>{admin=await call('/api/login','POST',{login_id:'admin',password:'0996'});assert(admin.data.can_manage);ceo=await call('/api/login','POST',{login_id:'김정배',password:'1111'});assert(ceo.data.can_manage);const roster=(await call('/api/roster','GET',null,admin.cookie)).data;empRow=roster.employees.find(u=>!u.is_admin&&!u.can_approve_first);emp=await call('/api/login','POST',{login_id:empRow.login_id,password:'1111'});await call('/api/roster','GET',null,emp.cookie,403);await call('/api/leave-ledger?user_id='+roster.employees.find(u=>u.id!==empRow.id).id,'GET',null,emp.cookie,403);assert(!JSON.stringify(roster).includes('password_hash'));});
await test('직원을 관리자·결재자로 독립 지정 및 변경 이력',async()=>{const d=(await call('/api/roster','GET',null,admin.cookie)).data;ap1=d.employees.find(u=>u.id!==empRow.id&&!u.is_admin);ap2=d.employees.find(u=>u.id!==ap1.id&&u.id!==empRow.id&&!u.is_admin);await call('/api/users/'+ap1.id,'PUT',{...ap1,is_admin:true,can_approve_first:true},admin.cookie);const a=await call('/api/login','POST',{login_id:ap1.login_id,password:'1111'});assert(a.data.can_manage);await call('/api/roster','GET',null,a.cookie);ap1.cookie=a.cookie;await call('/api/users/'+ap2.id,'PUT',{...ap2,can_approve_first:true},admin.cookie);ap2.cookie=(await call('/api/login','POST',{login_id:ap2.login_id,password:'1111'})).cookie;const audits=(await call('/api/roster','GET',null,admin.cookie)).data.audit;assert(audits.some(x=>x.changes.some(c=>c.field==='is_admin')));await call('/api/users/'+ap1.id,'PUT',{...ap1,is_admin:false},ap1.cookie,400);});
let req;
let date=addDays(todayIsoKst(),3);while([0,6].includes(new Date(date+'T00:00Z').getUTCDay())||['01-01','03-01','05-01','05-05','06-06','07-17','08-15','10-03','10-09','12-25'].includes(date.slice(5)))date=addDays(date,1);
const hourly={leave_type:'HOURLY',start_datetime:date+'T09:00',end_datetime:date+'T09:30',approver_ids:[],reason:'자동검증'};
await test('결재자 1명인 시간연차 최종승인',async()=>{req=(await call('/api/leave-requests','POST',{...hourly,approver_ids:[ap1.id]},emp.cookie)).data;assert.equal(req.days,.0625);const r=(await call(`/api/requests/${req.id}/action`,'POST',{action:'approve'},ap1.cookie)).data.request;assert.equal(r.approval_state,'APPROVED');assert.equal(r.minutes,30);const rows=(await call('/api/inbox','GET',null,ap1.cookie)).data;assert(!rows.some(x=>x.id===req.id));});
await test('겹치는 시간 중복 신청 차단 / 인접 시간 허용',async()=>{await call('/api/leave-requests','POST',{...hourly,approver_ids:[ap1.id]},emp.cookie,400);req=(await call('/api/leave-requests','POST',{...hourly,start_datetime:date+'T09:30',end_datetime:date+'T10:00',approver_ids:[ap1.id,ap2.id]},emp.cookie)).data;});
await test('2단계 순차결재: 최종자 선승인 차단',async()=>{await call(`/api/requests/${req.id}/action`,'POST',{action:'approve'},ap2.cookie,403);await call(`/api/requests/${req.id}/action`,'POST',{action:'approve'},ap1.cookie);const r=(await call(`/api/requests/${req.id}/action`,'POST',{action:'approve'},ap2.cookie)).data.request;assert.equal(r.approval_state,'APPROVED');const mine=(await call('/api/my-requests','GET',null,emp.cookie)).data;assert.equal(mine.filter(x=>x.approval_state==='APPROVED').reduce((a,x)=>a+x.minutes,0),60);});
await test('비승인자 관리권한 우회 승인 차단',async()=>{await call(`/api/requests/${req.id}/action`,'POST',{action:'approve'},admin.cookie,400);});
await test('0.5시간 가감 및 발생량 수동확정 API',async()=>{await call(`/api/users/${empRow.id}/adjustments`,'POST',{days_whole:0,hours_remainder:.5,direction:1,effective_date:date,reason:'확인'},admin.cookie);const u=(await call('/api/me','GET',null,emp.cookie)).data;await call('/api/admin/cycle-grant','POST',{user_id:empRow.id,cycle_start:u.cycle_start,days_whole:15,hours_remainder:0,reason:'출근율 확인'},admin.cookie);const after=(await call('/api/me','GET',null,emp.cookie)).data;assert.equal(after.granted,15);});
await test('취소 및 반려 내역 보존',async()=>{const mk=(a,b)=>({...hourly,start_datetime:date+'T'+a,end_datetime:date+'T'+b,approver_ids:[ap1.id,ap2.id]});let r=(await call('/api/leave-requests','POST',mk('10:00','10:30'),emp.cookie)).data;await call(`/api/requests/${r.id}/cancel`,'POST',{},emp.cookie);r=(await call('/api/leave-requests','POST',mk('10:30','11:00'),emp.cookie)).data;await call(`/api/requests/${r.id}/action`,'POST',{action:'reject',reason:'검증 반려'},ap1.cookie);const mine=(await call('/api/my-requests','GET',null,emp.cookie)).data;assert(mine.some(x=>x.approval_state==='CANCELLED'));assert(mine.some(x=>x.approval_state==='REJECTED'));assert.equal((await call('/api/inbox','GET',null,ap2.cookie)).data.length,0);});
await test('명부 비교·선택 반영: 비밀번호와 결재·관리자 권한 유지',async()=>{const before=await env.stateStore.get('state');originalHash=before.users.find(u=>u.id===ap1.id).password_hash;const preview=(await call('/api/roster/preview','POST',{source:'bundled'},admin.cookie)).data;assert.equal(preview.entries.length,47);assert.equal(preview.history_count,107);const idx=preview.entries.find(e=>e.user_id===ap1.id).index;const result=(await call('/api/roster/commit','POST',{token:preview.token,indices:[idx],include_history:true},admin.cookie)).data;assert.equal(result.created,0);const after=await env.stateStore.get('state');const u=after.users.find(u=>u.id===ap1.id);assert(u.is_admin&&u.can_approve_first);assert.equal(u.password_hash,originalHash);assert.equal(after.requests.length,4);assert.equal(after.roster_history.length,107);});
await test('명부 미리보기 후 변경 충돌 409 차단',async()=>{const preview=(await call('/api/roster/preview','POST',{source:'bundled'},admin.cookie)).data;await call(`/api/users/${empRow.id}/adjustments`,'POST',{days_whole:0,hours_remainder:.5,direction:1,effective_date:date,reason:'동시 수정'},admin.cookie);await call('/api/roster/commit','POST',{token:preview.token,indices:[0]},admin.cookie,409);});
await test('비밀번호 변경·로그아웃·재로그인',async()=>{await call('/api/change-password','POST',{current_password:'1111',new_password:'TEST-Changed-2026!',confirm_password:'TEST-Changed-2026!'},emp.cookie);await call('/api/logout','POST',{},emp.cookie);await call('/api/me','GET',null,emp.cookie,401);await call('/api/login','POST',{login_id:empRow.login_id,password:'1111'},'',401);emp=await call('/api/login','POST',{login_id:empRow.login_id,password:'TEST-Changed-2026!'});assert(!emp.data.must_change_password);});
await test('Excel 내보내기 전체 함수 / 계정 비밀정보 없음',async()=>{const data=(await call('/api/admin/export-data?employment=all','GET',null,admin.cookie)).data;const sandbox={window:{},TextEncoder,Uint8Array,Uint32Array,DataView,ArrayBuffer,Date,Intl,Set,Map};vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../public/xlsx-browser.js',import.meta.url),'utf8'),sandbox);vm.runInContext(readFileSync(new URL('../public/export-browser.js',import.meta.url),'utf8'),sandbox);const b=sandbox.window.LeaveExport.buildExportXlsx(data);assert.equal(b[0],80);assert.equal(b[1],75);mkdirSync(outputDir,{recursive:true});writeFileSync(join(outputDir,'leave.xlsx'),b);const roster=(await call('/api/roster','GET',null,admin.cookie)).data;writeFileSync(join(outputDir,'roster.xlsx'),sandbox.window.LeaveExport.roster(roster));writeFileSync(join(outputDir,'template.xlsx'),sandbox.window.LeaveExport.buildUploadTemplateXlsx());assert(!JSON.stringify(data).includes('password_hash'));});
await test('갱신·대장·근무기준 조회 API',async()=>{const ym=todayIsoKst().slice(0,7);const r=(await call('/api/admin/renewals?month='+ym,'GET',null,admin.cookie)).data;assert(Array.isArray(r.rows));assert(r.rows.every(x=>x.carryover_minutes===0));const ledger=(await call('/api/leave-ledger','GET',null,emp.cookie)).data;assert(Array.isArray(ledger.cycles));await call('/api/admin/work-settings?company_id=1','GET',null,admin.cookie);await call('/api/admin/holidays?company_id=1&year=2026','GET',null,admin.cookie);});
await test('대표이사 관리자 API 접근',async()=>{await call('/api/roster','GET',null,ceo.cookie);await call('/api/admin/export-data?employment=all','GET',null,ceo.cookie);});
await test('정수일수·나머지시간 기존 Excel 이관 및 중복 방지',async()=>{
 const rows=[['DNM 과거 자료'],[],[],['회사','로그인 ID','직원명','구분','시작일','시작시간','종료일','종료시간','일수(정수)','시간(나머지)','사유','자료설명'],['(주)디엔엠',empRow.login_id,empRow.employee_name,'시간단위','2026-10-01','09:00','2026-10-01','09:30',0,.5,'이관검증','시험용']];
 const make=()=>{const fd=new FormData();fd.append('file',new Blob([JSON.stringify({sheets:[{name:'사용내역등록',rows}]})]),'fixture.xlsx');return fd;};
 const a=(await call('/api/admin/import-excel','POST',make(),admin.cookie)).data;assert.equal(a.errors.length,0);assert.equal(a.usage_created,1);
 const b=(await call('/api/admin/import-excel','POST',make(),admin.cookie)).data;assert.equal(b.skipped,1);assert.equal(b.usage_created,0);
 const mine=(await call('/api/my-requests','GET',null,emp.cookie)).data;assert.equal(mine.find(x=>x.source==='EXCEL_UPLOAD').minutes,30);
});
await test('올바르지 않은 기존 근무기준은 계산 전 확인 요청',()=>{
 const s=fresh();s.work_settings[0].work_end='18:00';assert.throws(()=>calculateLeave(s,worker,'HOURLY','','','2026-10-19T09:00','2026-10-19T09:30'));
});

await test('v8.3 shared personnel sorting: executives → departments → positions → hire date',async()=>{
  assert(DNM_SORT_LABEL.includes('임원'));
  const people=[
    {employee_name:'최근입사',department:'생산팀',position:'사원',join_date:'2026-01-01'},
    {employee_name:'오래된입사',department:'생산팀',position:'사원',join_date:'2021-01-01'},
    {employee_name:'팀장',department:'생산팀',position:'팀장',join_date:'2022-01-01'},
    {employee_name:'품질부장',department:'품질팀',position:'부장',join_date:'2000-01-01'},
    {employee_name:'영업이사',department:'영 업',position:'전무',join_date:'2022-01-01'},
    {employee_name:'대표',department:'대표이사',position:'사장',join_date:'2015-01-01'}
  ];
  assert.deepEqual(sortPeople(people).map(x=>x.employee_name),['대표','영업이사','팀장','오래된입사','최근입사','품질부장']);
  const a=(await call('/api/users?employment=all','GET',null,admin.cookie)).data;
  assert(a.every((u,i)=>i===0||comparePeople(a[i-1],u)<=0));
  const r=(await call('/api/roster','GET',null,admin.cookie)).data;
  assert(r.employees.every((u,i)=>i===0||comparePeople(r.employees[i-1],u)<=0));
  assert(r.history.every((u,i)=>i===0||comparePeople(r.history[i-1],u)<=0));
  const x=(await call('/api/admin/export-data?employment=all','GET',null,admin.cookie)).data;
  assert(x.userSummaries.every((u,i)=>i===0||comparePeople(x.userSummaries[i-1],u)<=0));
  assert(x.requestRows.every((u,i)=>i===0||comparePeople(x.requestRows[i-1],u)<=0));
  assert(x.adjustmentRows.every((u,i)=>i===0||comparePeople(x.adjustmentRows[i-1],u)<=0));
  const approver=(await call('/api/approvers','GET',null,emp.cookie)).data.first;
  assert(approver.every((u,i)=>i===0||comparePeople(approver[i-1],u)<=0));
});
await test('각 페이지 도움말: 로그인/신청/결재/명부/대시보드/백업 등',()=>{
 const names=['login','dashboard','apply','history','ledger','approvals','employees','manage','standards','backup','password'];
 for(const name of names){assert(PAGE_GUIDES[name]?.steps.length>=3,`${name}: 도움말 누락`);assert(PAGE_GUIDES[name].intro);}
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert(html.includes('type="module"'));
 const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert(js.includes('data-help=')&&js.includes('showPageHelp'));
});
const sha=async x=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))).map(b=>b.toString(16).padStart(2,'0')).join('');
let preState;
await test('초기화 미리보기는 직원·명부·운영설정과 삭제대상 건수를 분리',async()=>{
 const preview=(await call('/api/admin/test-clear/preview','GET',null,admin.cookie)).data;
 assert(preview.count.requests>0);
 assert(preview.count.adjustments>0);
 assert(preview.count.cycle_grants>0);
 assert.equal(preview.retained.employees,47);
 preState=(await call('/api/admin/backup.json','GET',null,admin.cookie)).data;
 assert.equal(preState.requests.length,preview.count.requests);
});
await test('백업 없이 초기화 거절/잘못된 암호 거절/일반 직원 거절/기존 전체 초기화 차단',async()=>{
 const original=await sha(JSON.stringify(preState,null,2));
 const confirm={confirmation_phrase:'테스트자료삭제',confirm_data_loss:true,password:'0996',backup_sha256:original};
 await call('/api/admin/test-clear','POST',{...confirm,backup_sha256:''},admin.cookie,400);
 await call('/api/admin/test-clear','POST',{...confirm,password:'wrong-password'},admin.cookie,403);
 await call('/api/admin/test-clear','POST',{...confirm,confirmation_phrase:'삭제'},admin.cookie,400);
 await call('/api/admin/test-clear','POST',confirm,emp.cookie,403);
 await call('/api/admin/reset-initial','POST',{},admin.cookie,410);
 const after=(await call('/api/admin/test-clear/preview','GET',null,admin.cookie)).data;
 assert.equal(after.count.requests,preState.requests.length);
});
await test('백업 이후 다른 사용자가 수정하면 해시 불일치(409)로 초기화 차단',async()=>{
 const oldHash=await sha(JSON.stringify(preState,null,2));
 await call(`/api/users/${empRow.id}/adjustments`,'POST',{days_whole:0,hours_remainder:.5,direction:1,effective_date:date,reason:'백업 후 동시변경'},admin.cookie);
 await call('/api/admin/test-clear','POST',{confirmation_phrase:'테스트자료삭제',confirm_data_loss:true,password:'0996',backup_sha256:oldHash},admin.cookie,409);
 assert((await call('/api/admin/test-clear/preview','GET',null,admin.cookie)).data.count.requests>0);
});
let backupKey='';
await test('백업 검증 후 삭제: 신청·결재·조정만 삭제, 직원·계정·권한·근무기준 보존',async()=>{
 const before=(await call('/api/admin/backup.json','GET',null,admin.cookie)).data;
 const fingerprint=await sha(JSON.stringify(before,null,2));
 const result=(await call('/api/admin/test-clear','POST',{confirmation_phrase:'테스트자료삭제',confirm_data_loss:true,password:'0996',backup_sha256:fingerprint,clear_cycle_grants:false},admin.cookie)).data;
 backupKey=result.backup_key;
 assert(result.ok);
 assert(result.deleted.requests>0&&result.deleted.adjustments>0);
 assert.equal(result.deleted.cycle_grants,0);
 const after=(await call('/api/admin/backup.json','GET',null,admin.cookie)).data;
 assert.equal(after.requests.length,0);
 assert.equal(after.adjustments.length,0);
 assert.equal(after.cycle_grants.length,before.cycle_grants.length);
 assert.deepEqual(after.users,before.users);
 assert.deepEqual(after.companies,before.companies);
 assert.deepEqual(after.work_settings,before.work_settings);
 assert.deepEqual(after.custom_holidays,before.custom_holidays);
 assert.deepEqual(after.roster_history,before.roster_history);
 assert.equal(after.test_clear_history.length,1);
 const user=(await call('/api/me','GET',null,emp.cookie)).data;
 assert.equal(user.id,empRow.id);
 const recovery=(await call(`/api/admin/test-clear/recovery?key=${encodeURIComponent(backupKey)}`,'GET',null,admin.cookie)).data;
 assert.equal(recovery.requests.length,before.requests.length);
 assert.deepEqual(recovery.users,before.users);
});
await test('최종 갱신 발생량도 백업 검증 후 선택 삭제; 백업 보존',async()=>{
 let s=(await call('/api/admin/backup.json','GET',null,ceo.cookie)).data;
 assert(s.cycle_grants.length>0);
 await call('/api/admin/test-clear','POST',{confirmation_phrase:'테스트자료삭제',confirm_data_loss:true,password:'1111',backup_sha256:await sha(JSON.stringify(s,null,2)),clear_cycle_grants:true},ceo.cookie);
 s=(await call('/api/admin/backup.json','GET',null,admin.cookie)).data;
 assert.equal(s.cycle_grants.length,0);
 assert.equal(s.requests.length,0);
 assert.equal(s.test_clear_history.length,2);
 const preview=(await call('/api/admin/test-clear/preview','GET',null,admin.cookie)).data;
 assert.equal(preview.count.requests,0);
 assert.equal(preview.count.cycle_grants,0);
 await call('/api/admin/test-clear','POST',{confirmation_phrase:'테스트자료삭제',confirm_data_loss:true,password:'0996',backup_sha256:await sha(JSON.stringify(s,null,2))},admin.cookie,400);
 const backup=(await call('/api/admin/test-clear/recovery?key='+encodeURIComponent(backupKey),'GET',null,admin.cookie)).data;
 assert(backup.requests.length>0);
});

console.log(`\nRESULT: ${tests} test groups passed (memory Blobs / fixture calendar / parser interface). Real Netlify deployment and real XLSX decoder require deployment verification.`);
