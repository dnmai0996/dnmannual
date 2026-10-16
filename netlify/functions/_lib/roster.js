import { parseIso } from './leave.js';
export const ROSTER_FIELDS = ['employee_code','employee_name','department','position','join_date','leave_basis_date','retire_date','phone','note','gender','age_source','address','career','employment_note'];
export const text = (v, max=2000) => String(v ?? '').trim().slice(0,max);
function cell(c) { const v=c?.value; if(v==null)return ''; if(v instanceof Date)return v.toISOString().slice(0,10); if(typeof v==='object'){ if('result' in v)return v.result; if(v.richText)return v.richText.map(x=>x.text||'').join(''); if(v.text)return v.text; return '';}return v; }
export function rosterDate(value) {
 if(typeof value==='number' && value>20000 && value<80000) return new Date(Date.UTC(1899,11,30)+value*86400000).toISOString().slice(0,10);
 const m=/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(text(value)); if(!m)return '';
 const date=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; return parseIso(date)?date:'';
}
const key=s=>text(s).replace(/\s+/g,'');
export function parseRosterWorkbook(wb,filename) {
 const current=[], history=[], errors=[]; let sourceDate='';
 for(const ws of wb.worksheets) {
  const raw=[]; ws.eachRow({includeEmpty:true},(row,i)=>{raw[i-1]=Array.from({length:Math.max(15,ws.columnCount)},(_,j)=>cell(row.getCell(j+1)));});
  let section='current', headers=null, rawMode=false;
  for(let i=0;i<raw.length;i++) {
   const r=raw[i]||[], markers=r.slice(0,4).map(key).join('');
   if(/현재/.test(markers)&&!sourceDate)sourceDate=r.map(x=>text(x)).join(' ').trim();
   if(markers.includes('퇴직자'))section='retired';
   if(markers.includes('입사자명부')||markers.includes('【입사자】'))section='hire_history';
   if(key(r[3])==='성명' && key(r[11])==='입사일자') {rawMode=true;headers=null;continue;}
   const h=r.map(key); if(h.includes('직원명')&&h.includes('입사일')){headers=h;rawMode=false;continue;}
   let rec=null;
   if(rawMode && text(r[3]) && rosterDate(r[11])) {
    const next=raw[i+1]&&!text(raw[i+1][3])?raw[i+1]:[];
    const note=[text(r[14]),text(next[14])].filter(Boolean).join('\n');
    rec={employee_name:key(r[3]),display_name_source:text(r[3]),employee_code:'',department:text(r[5]),position:text(r[4]).replace(/\s+/g,' '),gender:text(r[6]),age_source:text(r[7]),address:[text(r[9]),text(next[9])].filter(Boolean).join(' '),career:[text(r[10]),text(next[10])].filter(Boolean).join('\n'),join_date:rosterDate(r[11]),tenure_source:text(r[12]),phone:text(r[13]),note,retire_date:'',source_number:text(r[2]),employment_note:/육아/.test(text(r[3])+note)?'육아휴직':(/촉탁/.test(note)?'촉탁근로':''),review_notes:[]};
    if(note.includes('승진'))rec.review_notes.push('직책란과 비고의 승진 내용을 확인해 주세요.');
    if(/촉탁|정년|재입사|휴직/.test(note)&&section==='current')rec.review_notes.push('재입사·촉탁·휴직의 연차 산정 기준일과 근속 인정은 관리자 확인이 필요합니다.');
    if(section==='retired'){
     const m=[...note.matchAll(/(?<!\d)(\d{2,4})[./-](\d{1,2})[./-](\d{1,2})\s*일?\s*\(?퇴사/g)].at(-1);
     if(m)rec.retire_date=rosterDate(`${Number(m[1])<100?2000+Number(m[1]):m[1]}-${m[2]}-${m[3]}`);
     if(!rec.retire_date)rec.review_notes.push('퇴직자 구역에 있으나 퇴사일이 명확하지 않아 원문 확인이 필요합니다.');
    }
   } else if(headers) {
    const get=(...names)=>{for(const n of names){const p=headers.indexOf(key(n));if(p>=0)return r[p];}return '';};
    if(!text(get('직원명')))continue;
    const join=rosterDate(get('입사일')); if(!join){errors.push(`${ws.name} ${i+1}행: 입사일을 확인해 주세요.`);continue;}
    rec={employee_name:text(get('직원명')),employee_code:text(get('사원코드','사번')),login_id:text(get('로그인ID')),department:text(get('부서')),position:text(get('직책','직급')),join_date:join,leave_basis_date:rosterDate(get('연차기준일')),retire_date:rosterDate(get('퇴사일')),phone:text(get('연락처')),gender:text(get('성별')),age_source:text(get('나이(원본)','나이')),address:text(get('주소')),career:text(get('이력사항')),note:text(get('비고')),employment_note:text(get('근무상태')),review_notes:[]};
   }
   if(rec){Object.assign(rec,{section,source_row:i+1,source_sheet:ws.name,source_file:filename});(section==='current'?current:history).push(rec);}
  }
 }
 if(!current.length)throw new Error('재직자 명단을 찾지 못했습니다. 근로자명부 원본 또는 직원등록 표준양식을 사용해 주세요.');
 return {current,history,errors,source_file:filename,source_as_of_text:sourceDate,counts:{current:current.length,retired:history.filter(x=>x.section==='retired').length,hire_history:history.filter(x=>x.section==='hire_history').length},privacy_note:'주민등록번호는 등록 항목에서 제외하며 저장하지 않습니다.'};
}
export function matchEmployee(users, rec) {
 const live=users.filter(u=>!u.is_system_account&&!u.deleted&&!u.legacy_hidden);
 const code=rec.employee_code||rec.suggested_employee_code;
 const idMatch=rec.login_id ? live.filter(u=>u.login_id===rec.login_id):[];
 if(idMatch.length===1)return idMatch[0];
 const codeMatches=code ? live.filter(u=>u.employee_code===code):[];if(codeMatches.length===1)return codeMatches[0];
 const names=live.filter(u=>key(u.employee_name)===key(rec.employee_name));
 if(names.length===1)return names[0];
 const byDate=names.filter(u=>u.join_date===rec.join_date);return byDate.length===1?byDate[0]:null;
}
export function importChanges(u,r){return ROSTER_FIELDS.filter(f=>f!=='leave_basis_date' && f!=='employee_code' && String(u?.[f]||'')!==String(r[f]||'')).map(f=>({field:f,before:text(u?.[f]),after:text(r[f])}));}
export function auditStaff(s,actor,u,before,action='UPDATE',extra='') {
 s.staff_audit ||= [];
 const changes=before?ROSTER_FIELDS.concat(['is_admin','can_approve_first','active']).filter(k=>JSON.stringify(before[k]??'')!==JSON.stringify(u[k]??'')).map(k=>({field:k,before:before[k]??'',after:u[k]??''})):[];
 s.staff_audit.push({id:crypto.randomUUID(),at:new Date().toISOString(),actor_id:actor.id,actor_name:actor.employee_name,user_id:u.id,employee_name:u.employee_name,action,changes,note:extra});
}
