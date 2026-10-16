(function(){
'use strict';
const {buildXlsx}=window.LeaveXlsx;
const asOf=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const yn=v=>v?'예':'아니오';
function minutes(v){return Math.round(typeof v==='object'&&v!==null?Number(v.minutes??(v.hours!=null?v.hours*60:Number(v.days||0)*480)):Number(v||0)*480);}
function amount(v){const m=minutes(v),a=Math.abs(m);return [m<0?'초과/차감':'정상/가산',Math.floor(a/480),(a%480)/60];}
const amountHeaders=s=>[s+' 구분',s+' 일수(정수)',s+' 시간(나머지)'];
const statusLabel=r=>r.approval_status_label||({APPROVED:'최종승인',PENDING:'결재대기',REJECTED:'반려',CANCELLED:'취소'})[r.approval_state]||(r.status_final==='APPROVED'?'최종승인':'결재대기');
const leaveTypeLabel=t=>({FULL:'하루 / 기간',AM_HALF:'오전 반차',PM_HALF:'오후 반차',HOURLY:'시간단위',IMPORTED_SUMMARY:'기존 합계',IMPORTED:'기존자료',IMPORTED_HALF:'기존 반차',HALF_IMPORTED:'기존 반차'})[t]||t;
const line=r=>(r.approval_line||[]).map((a,i)=>`${i===(r.approval_line.length-1)?'최종':`${i+1}차`} ${a.approver_name||''} (${a.status_label||a.status})`).join(' → ');
const sheet=(name,headers,rows,subtitle='',title=name)=>({name,title,subtitle,headers,rows,widths:headers.map(h=>/사유|비고|내용|이력|주소|결재/.test(h)?40:/일자|기준일|입사일|기간|일시|시작|종료|갱신일/.test(h)?20:16)});
function requestSheet(rows=[],subtitle=''){
 return sheet('신청·사용내역',['직원명','로그인 ID','부서','사원코드','구분','시작일시','종료일시',...amountHeaders('신청'),'총 시간','분(정확한 원장 단위)','결재라인','상태','신청사유','반려사유','이관 주의사항','신청일시','최종승인일시'],rows.map(r=>[r.applicant_name,r.applicant_login,r.department,r.employee_code,leaveTypeLabel(r.leave_type),r.start_datetime||`${r.start_date} ${r.start_time||''}`,r.end_datetime||`${r.end_date} ${r.end_time||''}`,...amount(r),minutes(r)/60,minutes(r),line(r),statusLabel(r),r.reason||'',r.reject_reason||'',r.allocation_note||'',r.created_at,r.final_approved_at]),subtitle);
}
function renewalSheet(rows=[],month=''){
 const kinds=['prior_granted','prior_used','prior_adjustments','prior_balance','unused_expiring','new_entitlement'];
 return sheet('갱신·소멸 내역',['직원명','사원코드','부서','입사일','연차기준일','갱신일','이전 주기 시작','이전 주기 종료',...['이전 발생','이전 사용','이전 조정','이전 잔여','소멸대상','새 발생'].flatMap(amountHeaders),'다음 주기 이월일수','다음 주기 이월시간','새 주기 시작','새 주기 종료','상태','확인사항'],rows.map(r=>[r.employee_name,r.employee_code,r.department,r.join_date,r.leave_basis_date,r.anniversary_date,r.prior_cycle_start,r.prior_cycle_end,...kinds.flatMap(k=>amount(r.amounts?.[k]??r[k])),0,0,r.new_cycle_start,r.new_cycle_end,r.status,'휴가 사용가능 잔액만 소멸. 미사용수당·귀책 예외 별도 확인.']),`${month} · 1일=8시간 / 30분=0.5시간 / 이전 잔여 이월 없음`);
}
function buildExportXlsx(d){
 const {userSummaries=[],accountSummaries=userSummaries,requestRows=[],adjustmentRows=[],renewalRows=[],companyName='디엔엠'}=d;
 const metrics=['granted','used','pending','adjustments','remaining','projected_remaining','total_used'];
 const subtitle=`${d.asOf||asOf()} 기준 · 회사: ${companyName} · 1일=8시간 / 30분=0.5시간 · 일수와 나머지 시간을 합산해 읽습니다.`;
 return buildXlsx([
  sheet('연차현황',['직원명','로그인 ID','사원코드','부서','직책','입사일','연차기준일','퇴사일','재직구분','주기 시작','주기 종료',...['발생','승인사용','결재대기','조정','잔여','대기차감 예상잔여','전체 누적사용'].flatMap(amountHeaders),'다음 갱신일','다음 발생일수','다음 발생시간','이월일수','이월시간'],userSummaries.map(u=>[u.employee_name,u.login_id,u.employee_code,u.department,u.position,u.join_date,u.leave_basis_date,u.retire_date,u.employment_status,u.cycle_start,u.cycle_end,...metrics.flatMap(k=>amount(u.amounts?.[k]??u[k])),u.next_anniversary,...amount(u.next_entitlement).slice(1),0,0]),subtitle),
  requestSheet(requestRows,subtitle),renewalSheet(renewalRows,(d.asOf||asOf()).slice(0,7)),
  sheet('연차조정내역',['직원명','로그인 ID','적용일',...amountHeaders('조정'),'조정사유','처리자','처리일시'],adjustmentRows.map(a=>[a.employee_name,a.login_id,a.effective_date,...amount(a.minutes!=null?{minutes:a.minutes}:a.amount),a.reason,a.created_by_name,a.created_at]),subtitle),
  sheet('사용자권한',['직원명','로그인 ID','부서','직책','관리자','결재자','대표이사','계정 사용','비밀번호 변경필요'],accountSummaries.map(u=>[u.employee_name,u.login_id,u.department,u.position,yn(u.is_admin),yn(u.can_approve_first),yn(u.is_representative),yn(u.active),yn(u.must_change_password)]),subtitle+' · 비밀번호·해시·주민등록번호는 포함하지 않습니다.'),
  sheet('안내',['항목','내용'],[['표시 단위','15일 중 0.5시간을 사용하면 잔여 14일 7.5시간입니다.'],['소멸·재발생','입사기념일에 이전 잔액을 이월하지 않고 새 주기 발생량으로 시작합니다. 과거 신청·결재 기록은 삭제하지 않습니다.'],['발생 가정','1년 미만 월 개근·연 출근율 요건 충족 가정이며, 관리자 발생량 수정으로 실제 요건을 반영할 수 있습니다.'],['별도 확인','미사용수당, 사용자 귀책으로 인한 소멸 예외, 출근율, 재입사 근속 인정은 사내규정 및 법령에 따라 확인해야 합니다.'],['초과사용','잔여가 음수이면 초과 구분과 절댓값을 일수·시간으로 표시합니다.'],['기존 자료','과거 이관자료의 일자별 차감 정보가 없으면 시작일에 귀속합니다. 이관 주의사항을 확인하세요.']])
 ],{creator:'(주)디엔엠 연차관리 v8.2'});
}
function roster(d){const fields=['source_row','source_number','employee_name','position','department','gender','age_source','join_date','retire_date','phone','address','career','employment_note','note'];const headings=['원본 행','원본 번호','직원명','직책(원본)','부서','성별','나이(원본)','입사일','퇴사일','연락처','주소','이력사항','근무상태','비고(원본)'];return buildXlsx([
 sheet('직원등록',['회사','사원코드','직원명','로그인 ID','부서','직급','입사일','연차기준일','퇴사일','연락처','성별','나이(원본)','주소','이력사항','근무상태','비고','관리자(참고)','결재자(참고)','계정 사용(참고)'],d.employees.map(u=>[u.company_name,u.employee_code,u.employee_name,u.login_id,u.department,u.position,u.join_date,u.leave_basis_date,u.retire_date,u.phone,u.gender,u.age_source,u.address,u.career,u.employment_note,u.note,yn(u.is_admin),yn(u.can_approve_first),yn(u.active)]),'재업로드 시 권한·비밀번호·기존 연차기준일은 자동 변경하지 않습니다. 권한은 직원 수정 화면에서 변경하세요.'),
 ...[['retired','퇴직자 원본이력'],['hire_history','과거 입사자이력']].map(([type,title])=>sheet(title,headings,d.history.filter(r=>r.section===type).map(r=>fields.map(f=>r[f]||'')),'계정과 구분한 참고 이력입니다. 중복·누락 날짜를 원문과 확인하세요.')),
 sheet('변경이력',['처리일시','처리자','직원명','종류','변경 내용','비고'],(d.audit||[]).map(a=>[a.at,a.actor_name,a.employee_name,a.action,(a.changes||[]).map(x=>`${x.field}: ${x.before} → ${x.after}`).join('\n'),a.note||'']),`원본: ${d.source?.source_file||''} / ${d.source?.source_as_of_text||''} · 개인정보 문서로 안전하게 보관해 주세요.`)
 ],{creator:'(주)디엔엠 근로자명부 v8.2'});}
function buildUploadTemplateXlsx(){return buildXlsx([
 sheet('직원등록',['회사','사원코드','직원명','로그인 ID','부서','직급','입사일','연차기준일','퇴사일','연락처','성별','나이(원본)','주소','이력사항','근무상태','비고'],[],'(주)디엔엠 · 데이터는 5행부터 입력하세요. 날짜 YYYY-MM-DD / 주민등록번호 입력 금지.'),
 sheet('사용방법',['항목','내용'],[['필수항목','직원명, 입사일을 반드시 입력하세요.'],['기존 직원 구분','기존 로그인 ID 또는 사원코드를 정확히 입력하세요. 일치가 불명확하면 신규 생성하지 말고 확인하세요.'],['현재 항목 유지','이 양식은 선택한 직원의 명부 정보를 갱신하므로 유지할 항목은 현재 직원명부 Excel에서 복사하세요.'],['역할 지정','관리자·결재자·계정 사용 여부는 업로드 후 근로자명부의 직원 수정에서 지정합니다.'],['산정 기준일','기존 직원의 연차기준일은 자동 변경하지 않습니다. 관리자가 별도 확인 후 수정합니다.'],['업로드 순서','근로자명부 → Excel 업로드 → 변경 미리보기 → 반영할 직원 선택 → 선택사항 반영'],['미포함 직원','파일에 없는 기존 직원은 삭제하거나 퇴사 처리하지 않습니다.'],['개인정보','주민등록번호·비밀번호를 포함하지 마세요.']])
 ],{creator:'(주)디엔엠 v8.2'});}
function buildUsageTemplateXlsx(){return buildXlsx([sheet('사용내역등록',['회사','로그인 ID','직원명','구분','시작일','시작시간','종료일','종료시간','일수(정수)','시간(나머지)','사유','자료설명'],[],'데이터는 5행부터. 구분: 하루 / 오전 반차 / 오후 반차 / 시간단위. 날짜 YYYY-MM-DD. 시간 0~7.5, 0.5시간 단위. 날짜별로 1행씩 권장. 중복 키는 건너뜁니다.')],{creator:'(주)디엔엠 v8.2'});}
window.LeaveExport={buildUsageTemplateXlsx,buildExportXlsx,buildRenewalXlsx:d=>buildXlsx([renewalSheet(d.rows,d.month)]),buildUsageXlsx:d=>buildXlsx([requestSheet(d.rows)]),buildUploadTemplateXlsx,roster,statusLabel,leaveTypeLabel};
})();
