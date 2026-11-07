import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ensureStateShape,handle} from '../netlify/functions/api.mjs';
import {INITIAL_STATE} from '../netlify/functions/_lib/initial-state.js';
import {MemoryStore} from './test-support/memory-store.mjs';
import {buildSupabaseBackend} from '../netlify/functions/_lib/supabase-store.mjs';
let passed=0;
function test(name,fn){return Promise.resolve(fn()).then(()=>console.log(`PASS ${String(++passed).padStart(2,'0')} ${name}`));}
const env={storageMode:'blobs',stateStore:new MemoryStore(),sessionStore:new MemoryStore(),resetBackupStore:new MemoryStore()};
async function request(path,opts={}){
 const req=new Request('https://dnm.test'+path,{method:opts.method||'GET',headers:{origin:'https://dnm.test',...(opts.cookie?{cookie:opts.cookie}:{})},body:opts.body?JSON.stringify(opts.body):undefined});
 let res;
 try{res=await handle({env,request:req});}catch(e){res=new Response(JSON.stringify({error:e.message}),{status:e.status||500});}
 return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
}
await test('로그인 이름 자동완성: 이상훈 동명이인을 서로 다른 로그인 계정으로 표시',async()=>{
 const r=await request('/api/login-options?name='+encodeURIComponent('이상훈'));
 assert.equal(r.status,200);
 assert.equal(r.data.options.length,2);
 const names=new Set(r.data.options.map(x=>x.employee_name));
 assert(names.has('이상훈'));assert(names.has('이상훈 (2공장)'));
 assert.equal(new Set(r.data.options.map(x=>x.login_id)).size,2);
 for(const opt of r.data.options){
  assert(!Object.keys(opt).some(k=>/password|phone|email|birth|code|join|address/i.test(k)));
 }
});
await test('빈 검색 및 한 글자 검색은 직원 목록을 공개하지 않음',async()=>{
 assert.equal((await request('/api/login-options?name='+encodeURIComponent('이'))).data.options.length,0);
 assert.equal((await request('/api/login-options?name=')).data.options.length,0);
});
await test('로그인 선택은 기존 직원 ID와 비밀번호를 변경하지 않음',async()=>{
 const selected=(await request('/api/login-options?name='+encodeURIComponent('이상훈'))).data.options[0];
 const ret=await request('/api/login',{method:'POST',body:{login_id:selected.login_id,password:'1111'}});
 assert.equal(ret.status,200);
 assert.equal(ret.data.login_id,selected.login_id);
});
await test('MES 사원번호 연결 미리보기는 비로그인 사용자에게 공개하지 않음',async()=>{
 assert.equal((await request('/api/admin/mes-link/preview')).status,401);
});
await test('MES 사원번호 적용은 Supabase가 아닌 사이트에서 차단',async()=>{
 const login=await request('/api/login',{method:'POST',body:{login_id:'admin',password:'0996'}});
 assert.equal(login.status,200);
 const res=await request('/api/admin/mes-link/apply',{method:'POST',cookie:login.cookie,body:{confirmation_phrase:'MES사번연결',backup_ack:true,password:'0996'}});
 assert.equal(res.status,409);
});
await test('Supabase 저장소 MES 링크 어댑터가 정확한 RPC와 버전만 사용',async()=>{
 const calls=[];
 const db={rpc:async(name,args)=>{calls.push({name,args});if(name==='dnm_leave_mes_link_preview')return {data:[{leave_user_id:1,decision:'ready'}]};
 if(name==='dnm_leave_mes_apply_links')return {data:{modified:true,new_links:1,revision:8}};
 return {error:new Error('unexpected RPC')};}};
 const backend=buildSupabaseBackend(db);
 assert.equal((await backend.mesLinkPreview()).length,1);
 const result=await backend.mesApplyLinks('pg:7',false);
 assert.equal(result.revision,8);
 assert.equal(calls[1].name,'dnm_leave_mes_apply_links');
 assert.deepEqual(calls[1].args,{p_expected_revision:7,p_enable_sync:false});
 await assert.rejects(()=>backend.mesApplyLinks('blobs:12',true));
});
await test('SQL v8.5은 MES JSON 테이블/이름·입사일 대조를 사용, 초기 실행 시 연계 비활성',()=>{
 const sql=readFileSync(new URL('../database/06_v85_mes_json_bridge.sql',import.meta.url),'utf8');
 assert(sql.includes("kind='employee'"));
 assert(sql.includes("m.data->>'hired'=v_hired"));
 assert(sql.includes("UPDATE public.dnm_leave_mes_config SET enabled=false WHERE id=1"));
 assert(!/DROP TABLE|TRUNCATE TABLE/i.test(sql));
 assert(!/DELETE FROM public\.dnm_v4_records/i.test(sql));
});
await test('김정배 미사용계정 정리는 opt-in SQL에만 있으며 참조 검사·백업 후 삭제',()=>{
 const sql=readFileSync(new URL('../database/07_optional_inactive_kim_cleanup.sql',import.meta.url),'utf8');
 assert(sql.includes('EMP-289315463C7E7209'));
 assert(sql.includes("v_row.data->>'active'"));
 assert(sql.includes('v_total>0'));
 assert(sql.includes('dnm_leave_mes_cleanup_archive'));
});
console.log(`DNM v8.5 RESULT: ${passed} additional tests passed`);
