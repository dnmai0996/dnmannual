'use strict';

const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const toastEl = document.querySelector('#toast');
let me = null;
let companies = [];
let currentPage = 'dashboard';
let toastTimer = null;
let pageRequestId = 0;
let adminTabRequestId = 0;

function isCurrentPage(page, requestId = pageRequestId) {
  return currentPage === page && requestId === pageRequestId && !!qs('#page');
}

function isCurrentAdminTab(tab, requestId = adminTabRequestId) {
  return currentPage === 'admin' && currentAdminTabV6 === tab && requestId === adminTabRequestId && !!qs('#admin-content');
}

const esc = (value) => String(value == null ? '' : value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const fmt = (value) => Number(value || 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const today = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadFullExport(companyId = '', employment = 'all') {
  const params = new URLSearchParams(); if (companyId) params.set('company_id', companyId); if (employment) params.set('employment', employment); const q = `?${params}`;
  toast('Excel 파일을 만드는 중입니다.');
  const data = await api(`/api/admin/export-data${q}`);
  const bytes = window.LeaveExport.buildExportXlsx(data);
  downloadBytes(bytes, `${data.companyName}_연차관리_${data.asOf}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

async function downloadRenewalExport(params) {
  toast('갱신대상 Excel 파일을 만드는 중입니다.');
  const result = await api(`/api/admin/renewals?${params}`);
  const bytes = window.LeaveExport.buildRenewalXlsx({ rows: result.rows, companyName: result.company_name, month: result.month, asOf: today() });
  downloadBytes(bytes, `${result.company_name}_${result.month}_연차갱신대상.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function toast(message, type = 'success') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast show ${type}`;
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3200);
}

async function api(url, options = {}) {
  const config = { credentials: 'same-origin', ...options };
  if (config.body && typeof config.body !== 'string') {
    config.headers = { 'Content-Type': 'application/json', ...(config.headers || {}) };
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(url, config);
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (response.status === 401) {
    me = null;
    renderLogin();
    throw new Error(data.error || '로그인이 필요합니다.');
  }
  if (!response.ok) throw new Error(data.error || '처리 중 오류가 발생했습니다.');
  return data;
}

function loading() {
  const page = qs('#page');
  if (page) page.innerHTML = '<div class="loading"><span class="spinner"></span>자료를 불러오는 중입니다.</div>';
}

function statusInfo(row) {
  const state = row.approval_state || '';
  if (state === 'CANCELLED' || row.status1 === 'CANCELLED' || row.status_final === 'CANCELLED') return ['취소', 'gray'];
  if (state === 'REJECTED' || row.status1 === 'REJECTED' || row.status_final === 'REJECTED') return ['반려', 'red'];
  if (state === 'APPROVED' || (row.status1 === 'APPROVED' && row.status_final === 'APPROVED')) return ['최종승인', 'green'];
  if (row.approval_status_label) return [row.approval_status_label, row.current_approval?.role === 'REPRESENTATIVE' ? 'amber' : 'blue'];
  if (row.status1 === 'APPROVED') return ['최종 결재 대기', 'amber'];
  return ['승인대기', 'blue'];
}

function leaveTypeLabel(type) {
  return ({
    FULL: '연차/기간', AM_HALF: '오전 반차', PM_HALF: '오후 반차',
    IMPORTED_HALF: '반차(기존자료)', HALF_IMPORTED: '반차(기존자료)', IMPORTED_SUMMARY: '연도합계(기존자료)',
    IMPORTED: '기존자료'
  })[type] || type;
}

function roleBadges(user) {
  const badges = [];
  if (user.is_admin) badges.push('<span class="badge red">관리자</span>');
  if (user.is_representative) badges.push('<span class="badge green">대표이사</span>');
  if (user.can_approve_first) badges.push('<span class="badge blue">승인자</span>');
  if (!badges.length) badges.push('<span class="badge gray">직원</span>');
  return `<div class="badges">${badges.join('')}</div>`;
}

function openModal(title, body, footer = '') {
  modal.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" type="button" aria-label="닫기">×</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${footer || '<button class="btn secondary modal-cancel" type="button">닫기</button>'}</div>`;
  qs('.modal-close', modal).onclick = () => modal.close();
  const cancel = qs('.modal-cancel', modal);
  if (cancel) cancel.onclick = () => modal.close();
  modal.showModal();
}

function pageTitle(title, description, actions = '') {
  return `<div class="page-title"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><div class="actions">${actions}</div></div>`;
}

async function renderLogin() {
  let info = null;
  try { info = await api('/api/initial-info'); } catch { /* 화면은 계속 표시 */ }
  app.innerHTML = `
    <main class="login-page">
      <section class="login-visual">
        <div class="login-copy">
          <div class="logo-large">연</div>
          <h1>(주)디엔엠<br>연차관리 시스템</h1>
          <p>(주)디엔엠 근로자 명부의 직원명, 부서, 직책, 입사일이 초기 데이터로 반영되어 있습니다.</p>
          <div class="feature-list">
            <div class="feature">✓ 입사일 기준 1년 자동 갱신</div><div class="feature">✓ 잔여 0 이하도 신청</div>
            <div class="feature">✓ 다단계 순차 전자결재</div><div class="feature">✓ 회사별 Excel 다운로드</div>
            <div class="feature">✓ 본인 사용내역 확인</div><div class="feature">✓ 관리자 연차 조정</div>
          </div>
        </div>
      </section>
      <section class="login-panel">
        <form class="login-card" id="login-form">
          <h2>로그인</h2>
          <div class="subtitle">직원은 본인 이름 기반 로그인 ID, 관리자는 admin 계정을 입력합니다.</div>
          <label class="field"><span>로그인 ID</span><input id="login-id" type="text" autocomplete="username" placeholder="예: admin 또는 김정배" required autofocus></label>
          <label class="field"><span>비밀번호</span><input id="login-password" type="password" autocomplete="current-password" value="" required></label>
          <button class="btn" type="submit">로그인</button>
          <div class="login-default">
            <div class="strong">최초 관리자</div>
            <div>ID <code>admin</code> / 비밀번호 <code>0996</code></div>
            <div class="muted small-text" style="margin-top:6px">${info ? `${info.company_count}개 회사 · 직원 ${info.employee_count}명 초기 등록 완료` : '최초 실행 시 엑셀 명단이 자동 등록됩니다.'}</div>
          </div>
        </form>
      </section>
    </main>`;
  qs('#login-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = qs('button[type=submit]', event.currentTarget);
    button.disabled = true;
    try {
      me = await api('/api/login', { method: 'POST', body: { login_id: qs('#login-id').value.trim(), password: qs('#login-password').value } });
      await renderShellV7();
    } catch (error) {
      toast(error.message, 'error');
    } finally { button.disabled = false; }
  };
}

async function renderShell() {
  me = await api('/api/me');
  companies = me.is_admin ? await api('/api/companies') : [];
  const navItems = [
    ['dashboard', '⌂', '대시보드'], ['apply', '✎', '연차 신청'], ['history', '▤', '나의 사용내역']
  ];
  if (me.can_approve_first || me.can_approve_final || me.is_admin) navItems.push(['inbox', '✓', '승인함']);
  if (me.is_admin) navItems.push(['admin', '⚙', '관리자']);
  navItems.push(['password', '●', '비밀번호 변경']);
  app.innerHTML = `
    <header class="app-header"><div class="header-inner">
      <div class="brand"><div class="brand-mark">연</div><div><h1>디엔엠 연차관리</h1><small>(주)디엔엠</small></div></div>
      <div class="user-box"><div class="user-meta"><strong>${esc(me.employee_name)}</strong><span>${esc(me.company_name)} · ${esc(me.login_id)} · ${esc(me.role_label)}</span></div><button id="logout" class="btn outline small">로그아웃</button></div>
    </div></header>
    <div class="layout">
      <aside class="sidebar"><nav class="nav-card">${navItems.map(([key, icon, label]) => `<button class="nav-button" data-page="${key}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}</nav></aside>
      <main class="content"><div id="page"></div></main>
    </div>`;
  qs('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; renderLogin(); };
  qsa('.nav-button').forEach((button) => { button.onclick = () => go(button.dataset.page); });
  await go(currentPage === 'admin' && !me.is_admin ? 'dashboard' : currentPage);
}

async function go(page) {
  currentPage = page;
  qsa('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const handlers = { dashboard: dashboardPage, apply: applyPage, history: historyPage, inbox: inboxPage, admin: adminPage, password: passwordPage };
  loading();
  try { await handlers[page](); } catch (error) { qs('#page').innerHTML = `<div class="notice danger">${esc(error.message)}</div>`; }
}

async function refreshMe() { me = await api('/api/me'); return me; }

async function dashboardPage() {
  await refreshMe();
  qs('#page').innerHTML = `
    ${pageTitle('대시보드', `${me.as_of} 기준 · 입사일 기준 현재 1년 주기의 연차 현황입니다.`)}
    ${me.must_change_password ? '<div class="notice warning"><strong>최초 비밀번호 1111을 사용 중입니다.</strong> 안전한 사용을 위해 “비밀번호 변경” 메뉴에서 본인만의 비밀번호로 바꾸세요.</div>' : ''}
    <section class="stats">
      <div class="stat-card"><div class="stat-label">현재 주기 발생</div><div class="stat-value">${fmt(me.granted)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card"><div class="stat-label">현재 주기 사용</div><div class="stat-value">${fmt(me.used)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card"><div class="stat-label">승인 대기 중</div><div class="stat-value">${fmt(me.pending)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card primary"><div class="stat-label">현재 잔여</div><div class="stat-value ${me.remaining < 0 ? 'negative' : ''}">${fmt(me.remaining)}<span class="stat-unit">일</span></div></div>
    </section>
    <div class="notice ${me.remaining <= 0 ? 'warning' : ''}"><strong>잔여 연차가 0일 또는 음수여도 연차 신청은 가능합니다.</strong> 승인 대기까지 포함한 예상 잔여는 ${fmt(me.projected_remaining)}일입니다.</div>
    <div class="grid cols-2">
      <section class="card"><h3>입사일 기준 연차 주기</h3>
        <div class="table-wrap"><table class="data-table" style="min-width:0"><tbody>
          <tr><td class="muted">회사 / 부서</td><td class="right strong">${esc(me.company_name)} / ${esc(me.department || '-')}</td></tr>
          <tr><td class="muted">입사일 / 근속</td><td class="right strong">${esc(me.join_date)} / ${esc(me.tenure)}</td></tr>
          <tr><td class="muted">현재 연차 주기</td><td class="right strong">${esc(me.cycle_start)} ~ ${esc(me.cycle_end)}</td></tr>
          <tr><td class="muted">현재 주기 발생</td><td class="right strong">${fmt(me.granted)}일</td></tr>
          <tr><td class="muted">관리자 조정</td><td class="right strong ${me.adjustments < 0 ? 'negative' : me.adjustments > 0 ? 'positive' : ''}">${fmt(me.adjustments)}일</td></tr>
          <tr><td class="muted">현재 잔여</td><td class="right strong ${me.remaining < 0 ? 'negative' : ''}">${fmt(me.remaining)}일</td></tr>
          <tr><td class="muted">다음 갱신일</td><td class="right strong">${esc(me.next_anniversary)} / ${fmt(me.next_entitlement)}일 새로 생성</td></tr>
        </tbody></table></div>
      </section>
      <section class="card"><h3>연차 운영 방식</h3><div class="help-steps">
        <div class="help-step"><strong>1년 미만</strong><div class="muted small-text">입사 후 완료한 매월 1일씩 발생하며 최대 11일입니다.</div></div>
        <div class="help-step"><strong>입사기념일 자동 갱신</strong><div class="muted small-text">1년이 되면 15일을 새로 생성하고, 이후 2년마다 1일씩 증가하여 최대 25일입니다.</div></div>
        <div class="help-step"><strong>이전 주기 잔여 소멸</strong><div class="muted small-text">입사일 기준 1년 주기가 끝나면 사용하지 않은 잔여는 다음 주기로 이월하지 않습니다.</div></div>
        <div class="help-step"><strong>잔여 부족 신청 허용</strong><div class="muted small-text">잔여가 0 또는 음수여도 신청·승인할 수 있으며 잔여는 관리 참고값으로 계속 표시됩니다.</div></div>
      </div></section>
    </div>`;
}

function businessDays(start, end) {
  if (!start || !end || end < start) return 0;
  let count = 0;
  const current = new Date(`${start}T00:00:00Z`);
  const finish = new Date(`${end}T00:00:00Z`);
  while (current <= finish) {
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}

async function applyPage() {
  if (me.is_system_account) {
    qs('#page').innerHTML = `${pageTitle('연차 신청', '승인용·관리자 계정은 신청할 수 없습니다.')}<div class="notice warning">직원 본인 계정으로 로그인해 주세요.</div>`;
    return;
  }
  const approvers = await api('/api/approvers');
  const noApprover = !approvers.first.length || !approvers.final.length;
  qs('#page').innerHTML = `
    ${pageTitle('연차 신청', '잔여일수와 관계없이 신청할 수 있으며 토요일·일요일은 기간 일수에서 자동 제외됩니다.')}
    ${noApprover ? '<div class="notice danger"><strong>승인자가 등록되지 않았습니다.</strong> 관리자에게 실제 사원의 연차 승인자 지정을 요청하세요.</div>' : ''}
    <section class="card">
      <form id="leave-form">
        <div class="grid cols-3">
          <label class="field"><span>신청 구분</span><select id="leave-type"><option value="FULL">연차 / 기간</option><option value="AM_HALF">오전 반차</option><option value="PM_HALF">오후 반차</option></select></label>
          <label class="field"><span>시작일</span><input id="start-date" type="date" min="${today()}" required></label>
          <label class="field"><span>종료일</span><input id="end-date" type="date" min="${today()}" required></label>
          <label class="field"><span>연차 승인자</span><select id="approver-first" required><option value="">선택</option>${approvers.first.map((a) => `<option value="${a.id}">${esc(a.employee_name)} (${esc(a.login_id)}) · ${esc(a.position || a.department || '')}</option>`).join('')}</select></label>
          <label class="field"><span>최종 결재</span><select id="approver-final" required><option value="">선택</option>${approvers.final.map((a) => `<option value="${a.id}">${esc(a.employee_name)} (${esc(a.login_id)}) · ${esc(a.position || a.department || '')}</option>`).join('')}</select></label>
          <div class="field"><span>신청 일수</span><div class="notice" id="day-preview" style="margin:0">날짜를 선택하세요.</div></div>
        </div>
        <label class="field" style="margin-top:15px"><span>신청 사유</span><textarea id="leave-reason" placeholder="업무 인수인계나 참고사항을 입력합니다."></textarea></label>
        <div class="actions" style="justify-content:flex-end;margin-top:15px"><button class="btn" type="submit" ${noApprover ? 'disabled' : ''}>승인 요청</button></div>
      </form>
    </section>
    <div class="notice warning">현재 주기 잔여는 <strong>${fmt(me.remaining)}일</strong>입니다. <strong>잔여가 0일 또는 음수여도 신청 가능합니다.</strong> 기간 신청은 평일만 계산하며, 공휴일은 자동 제외되지 않습니다.</div>`;
  const type = qs('#leave-type'); const start = qs('#start-date'); const end = qs('#end-date'); const preview = qs('#day-preview');
  const update = () => {
    const half = type.value !== 'FULL';
    end.disabled = half;
    if (half && start.value) end.value = start.value;
    const days = half ? (start.value ? 0.5 : 0) : businessDays(start.value, end.value);
    preview.innerHTML = days ? `<strong>${fmt(days)}일</strong> 신청 예정` : '날짜를 선택하세요.';
  };
  [type, start, end].forEach((el) => el.addEventListener('change', update));
  start.value = today(); end.value = today(); update();
  qs('#leave-form').onsubmit = async (event) => {
    event.preventDefault();
    const submit = qs('button[type=submit]', event.currentTarget); submit.disabled = true;
    try {
      const result = await api('/api/leave-requests', { method: 'POST', body: {
        leave_type: type.value, start_date: start.value, end_date: end.value,
        approver1_id: qs('#approver-first').value, final_approver_id: qs('#approver-final').value,
        reason: qs('#leave-reason').value
      } });
      toast(`${fmt(result.days)}일 연차가 신청되었습니다.`);
      await refreshMe();
      go('history');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  };
}

async function historyPage() {
  const rows = await api('/api/my-requests');
  const years = [...new Set(rows.map((r) => r.start_date.slice(0, 4)))].sort().reverse();
  qs('#page').innerHTML = `
    ${pageTitle('나의 사용내역', '엑셀에서 이관된 기존자료와 시스템 신청자료를 함께 확인합니다.')}
    <section class="card"><div class="toolbar">
      <label class="field"><span>연도</span><select id="history-year"><option value="">전체</option>${years.map((y) => `<option>${y}</option>`).join('')}</select></label>
      <label class="field"><span>상태</span><select id="history-status"><option value="">전체</option><option value="APPROVED">최종승인</option><option value="PENDING">승인대기</option><option value="REJECTED">반려·취소</option></select></label>
      <label class="field"><span>자료</span><select id="history-source"><option value="">전체</option><option value="APPLICATION">시스템 신청</option><option value="EXCEL">기존 엑셀</option></select></label>
    </div></section><div id="history-table"></div>`;
  const render = () => {
    const year = qs('#history-year').value; const status = qs('#history-status').value; const source = qs('#history-source').value;
    const filtered = rows.filter((r) => {
      if (year && !r.start_date.startsWith(year)) return false;
      const info = statusInfo(r)[0];
      if (status === 'APPROVED' && info !== '최종승인') return false;
      if (status === 'PENDING' && !info.includes('대기')) return false;
      if (status === 'REJECTED' && !['반려', '취소'].includes(info)) return false;
      if (source === 'APPLICATION' && r.source !== 'APPLICATION') return false;
      if (source === 'EXCEL' && r.source === 'APPLICATION') return false;
      return true;
    });
    qs('#history-table').innerHTML = `<section class="card"><div class="card-header"><h3>총 ${filtered.length}건</h3><span class="muted">최종 승인 사용 합계 ${fmt(filtered.filter((r) => statusInfo(r)[0] === '최종승인').reduce((s, r) => s + Number(r.days), 0))}일</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>구분</th><th>기간</th><th>일수</th><th>승인자</th><th>상태</th><th>사유</th><th>자료구분</th><th>처리</th></tr></thead><tbody>
      ${filtered.length ? filtered.map((r) => { const [label, color] = statusInfo(r); const cancellable = r.source === 'APPLICATION' && !['최종승인', '반려', '취소'].includes(label); return `<tr>
        <td class="center"><span class="badge blue">${esc(leaveTypeLabel(r.leave_type))}</span></td><td class="center nowrap">${esc(r.start_date)}${r.end_date !== r.start_date ? ` ~ ${esc(r.end_date)}` : ''}</td><td class="right strong">${fmt(r.days)}</td>
        <td><div>1차: ${esc(r.approver1_name || '-')}</div><div>최종: ${esc(r.final_approver_name || '-')}</div></td><td class="center"><span class="badge ${color}">${label}</span>${r.reject_reason ? `<div class="small-text negative" style="margin-top:4px">${esc(r.reject_reason)}</div>` : ''}</td>
        <td>${esc(r.reason || '-')}</td><td class="center"><span class="badge ${r.source === 'APPLICATION' ? 'blue' : 'gray'}">${r.source === 'APPLICATION' ? '시스템 신청' : '엑셀 이관'}</span></td>
        <td class="center">${cancellable ? `<button class="btn red small cancel-request" data-id="${r.id}">취소</button>` : '-'}</td></tr>`; }).join('') : '<tr><td colspan="8" class="empty">조건에 맞는 내역이 없습니다.</td></tr>'}
      </tbody></table></div></section>`;
    qsa('.cancel-request').forEach((button) => { button.onclick = async () => { if (!confirm('이 연차 신청을 취소하시겠습니까?')) return; try { await api(`/api/requests/${button.dataset.id}/cancel`, { method: 'POST' }); toast('신청이 취소되었습니다.'); historyPage(); } catch (e) { toast(e.message, 'error'); } }; });
  };
  ['#history-year', '#history-status', '#history-source'].forEach((s) => qs(s).onchange = render); render();
}

async function inboxPage() {
  const rows = await api('/api/inbox');
  qs('#page').innerHTML = `
    ${pageTitle('승인함', '본인에게 지정되어 현재 처리할 수 있는 신청만 표시됩니다.')}
    <section class="card"><div class="card-header"><h3>처리 대기 ${rows.length}건</h3></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>승인단계</th><th>회사·신청자</th><th>구분</th><th>기간</th><th>일수</th><th>사유</th><th>처리</th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => `<tr><td class="center"><span class="badge ${r.stage === 'FIRST' ? 'blue' : 'green'}">${r.stage === 'FIRST' ? '1차 승인' : '최종 승인'}</span></td>
        <td><div class="name">${esc(r.applicant_name)}</div><div class="muted small-text">${esc(r.company_name)} · ${esc(r.department || '-')}</div></td><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td>
        <td class="center nowrap">${esc(r.start_date)}${r.end_date !== r.start_date ? ` ~ ${esc(r.end_date)}` : ''}</td><td class="right strong">${fmt(r.days)}</td><td>${esc(r.reason || '-')}</td>
        <td class="center"><div class="actions" style="justify-content:center"><button class="btn green small approve" data-id="${r.id}">승인</button><button class="btn red small reject" data-id="${r.id}">반려</button></div></td></tr>`).join('') : '<tr><td colspan="7" class="empty">현재 처리할 신청이 없습니다.</td></tr>'}
      </tbody></table></div></section>`;
  qsa('.approve').forEach((button) => { button.onclick = async () => { if (!confirm('이 신청을 승인하시겠습니까?')) return; try { await api(`/api/requests/${button.dataset.id}/action`, { method: 'POST', body: { action: 'approve' } }); toast('승인 처리되었습니다.'); inboxPage(); } catch (e) { toast(e.message, 'error'); } }; });
  qsa('.reject').forEach((button) => { button.onclick = () => {
    openModal('연차 신청 반려', '<label class="field"><span>반려 사유</span><textarea id="reject-reason" placeholder="신청자에게 전달할 반려 사유를 입력하세요."></textarea></label>', '<button class="btn secondary modal-cancel">취소</button><button id="confirm-reject" class="btn red">반려 처리</button>');
    qs('#confirm-reject', modal).onclick = async () => { try { await api(`/api/requests/${button.dataset.id}/action`, { method: 'POST', body: { action: 'reject', reason: qs('#reject-reason', modal).value } }); modal.close(); toast('반려 처리되었습니다.'); inboxPage(); } catch (e) { toast(e.message, 'error'); } };
  }; });
}

async function adminPage() {
  if (!me.can_manage) throw new Error('관리자 또는 대표이사 권한이 필요합니다.');
  qs('#page').innerHTML = `
    ${pageTitle('관리자', '(주)디엔엠의 직원·결재권한·연차·신청내역을 통합 관리합니다.', '<button id="admin-backup" class="btn outline">자료 백업</button>')}
    <div class="tabs"><button class="tab active" data-tab="users">사용자 관리</button><button class="tab" data-tab="renewals">연차 갱신대상</button><button class="tab" data-tab="requests">신청·사용내역</button><button class="tab" data-tab="companies">회사 설정</button></div>
    <div id="admin-content"></div>`;
  qs('#admin-backup').onclick = () => { window.location.href = '/api/admin/backup.json'; };
  qsa('.tab').forEach((tab) => { tab.onclick = () => { qsa('.tab').forEach((t) => t.classList.toggle('active', t === tab)); loadAdminTab(tab.dataset.tab); }; });
  await loadAdminTab('users');
}

async function loadAdminTab(tab) {
  qs('#admin-content').innerHTML = '<div class="loading"><span class="spinner"></span>관리 자료를 불러오는 중입니다.</div>';
  if (tab === 'users') return adminUsers();
  if (tab === 'renewals') return adminRenewals();
  if (tab === 'requests') return adminRequests();
  return adminCompanies();
}

function companyOptions(selected = '', allLabel = null) {
  return `${allLabel != null ? `<option value="">${esc(allLabel)}</option>` : ''}${companies.filter((c) => c.active).map((c) => `<option value="${c.id}" ${Number(selected) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
}

async function adminUsers(tabRequestId = adminTabRequestId) {
  if (!isCurrentAdminTab('users', tabRequestId)) return;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  adminContent.innerHTML = `
    <section class="stats" id="admin-stats"><div class="stat-card"><div class="stat-label">조회 직원</div><div class="stat-value">-</div></div><div class="stat-card"><div class="stat-label">승인 대기</div><div class="stat-value">-</div></div><div class="stat-card"><div class="stat-label">금년 승인 사용</div><div class="stat-value">-</div></div><div class="stat-card primary"><div class="stat-label">회사</div><div class="stat-value">${companies.filter((c) => c.active).length}<span class="stat-unit">개</span></div></div></section>
    <section class="card"><div class="toolbar">
      <label class="field"><span>회사</span><select id="user-company">${companyOptions('', '전체 회사')}</select></label>
      <label class="field"><span>재직 구분</span><select id="user-employment"><option value="current">재직자 (퇴사일 없음)</option><option value="retired">퇴사일 등록자</option><option value="all">전체</option></select></label>
      <label class="field search"><span>직원 검색</span><input id="user-search" type="text" placeholder="이름, ID, 부서, 사원코드"></label>
      <label class="check" style="padding-bottom:10px"><input id="include-system" type="checkbox">관리자/대표이사 포함</label>
      <div class="actions" style="padding-bottom:1px"><button id="add-user" class="btn">직원 등록</button><button id="export-all" class="btn outline">Excel 다운로드</button></div>
    </div></section><div id="user-table"></div>`;
  const load = async () => {
    if (!isCurrentAdminTab('users', tabRequestId)) return;
    const companyEl = qs('#user-company'), employmentEl = qs('#user-employment'), searchEl = qs('#user-search'), includeEl = qs('#include-system');
    if (!companyEl || !employmentEl || !searchEl || !includeEl) return;
    const companyId = companyEl.value, employment = employmentEl.value, search = searchEl.value.trim(), include = includeEl.checked;
    const params = new URLSearchParams({ employment }); if (companyId) params.set('company_id', companyId); if (search) params.set('search', search); if (include) params.set('include_system', '1');
    const statParams = new URLSearchParams({ employment }); if (companyId) statParams.set('company_id', companyId);
    const [users, stats] = await Promise.all([api(`/api/users?${params}`), api(`/api/admin/stats?${statParams}`)]);
    if (!isCurrentAdminTab('users', tabRequestId)) return;
    const statEls = qsa('#admin-stats .stat-value');
    const userTable = qs('#user-table');
    if (statEls.length < 3 || !userTable) return;
    statEls[0].innerHTML = `${stats.employee_count}<span class="stat-unit">명</span>`;
    statEls[1].innerHTML = `${stats.pending_count}<span class="stat-unit">건</span>`;
    statEls[2].innerHTML = `${fmt(stats.approved_this_year)}<span class="stat-unit">일</span>`;
    userTable.innerHTML = `<section class="card"><div class="card-header"><h3>사용자 ${users.length}명</h3><span class="muted">퇴사일이 입력된 직원은 “퇴사일 등록자”로 분리 조회합니다.</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>부서·사번</th><th>직원명 / 로그인 ID</th><th>입사일 / 퇴사일</th><th>주기발생</th><th>주기사용</th><th>현재잔여</th><th>권한·상태</th><th>관리</th></tr></thead><tbody>
      ${users.length ? users.map((u) => `<tr><td class="center">${esc(u.company_name)}</td><td><div>${esc(u.department || '-')}</div><div class="muted small-text">${esc(u.employee_code || '-')} · ${esc(u.position || '-')}</div></td><td><div class="name">${esc(u.employee_name)}${u.is_representative ? ' <span class="badge green">대표이사</span>' : (u.is_admin ? ' <span class="badge red">관리자</span>' : '')}</div><div class="muted small-text">ID: ${esc(u.login_id)}${u.phone ? ` · ${esc(u.phone)}` : ''}</div></td><td class="center"><div>${esc(u.join_date || '-')}</div><div class="small-text ${u.retire_date ? 'negative' : 'muted'}">퇴사 ${esc(u.retire_date || '-')}</div></td><td class="right strong">${fmt(u.granted)}</td><td class="right">${fmt(u.used)}</td><td class="right strong ${u.remaining < 0 ? 'negative' : ''}">${fmt(u.remaining)}</td><td>${roleBadges(u)} <span class="badge ${u.employment_status === '재직' ? 'green' : u.employment_status === '시스템' ? 'gray' : 'amber'}">${esc(u.employment_status)}</span></td><td><div class="actions">${!u.is_system_account ? `<button class="btn outline small edit-user" data-id="${u.id}">수정</button><button class="btn amber small adjust-user" data-id="${u.id}" data-name="${esc(u.employee_name)}">연차조정</button>${me.is_admin ? `<button class="btn red small delete-user" data-id="${u.id}" data-name="${esc(u.employee_name)}">삭제</button>` : ''}` : '<span class="muted small-text">시스템계정</span>'}<button class="btn secondary small reset-pw" data-id="${u.id}" data-login="${esc(u.login_id)}">PW초기화</button></div></td></tr>`).join('') : '<tr><td colspan="9" class="empty">조회 결과가 없습니다.</td></tr>'}
      </tbody></table></div></section>`;
    qsa('.edit-user').forEach((b) => b.onclick = () => editUser(users.find((u) => u.id === Number(b.dataset.id)), load));
    qsa('.adjust-user').forEach((b) => b.onclick = () => adjustUser(b.dataset.id, b.dataset.name, load));
    qsa('.delete-user').forEach((b) => b.onclick = async () => { if (!confirm(`${b.dataset.name} 직원을 삭제하시겠습니까?\n연차 이력이 있으면 기록 보존을 위해 목록에서 숨김 처리됩니다.`)) return; try { const r = await api(`/api/users/${b.dataset.id}`, { method: 'DELETE' }); toast(`${r.employee_name} 삭제 처리가 완료되었습니다.`); await load(); } catch (e) { toast(e.message, 'error'); } });
    qsa('.reset-pw').forEach((b) => b.onclick = async () => { if (!confirm(`로그인 ID ${b.dataset.login}의 비밀번호를 1111로 초기화하시겠습니까?`)) return; try { const r = await api(`/api/users/${b.dataset.id}/reset-password`, { method: 'POST' }); alert(`비밀번호 초기화 완료\n\n로그인 ID: ${r.login_id}\n비밀번호: 1111`); } catch (e) { toast(e.message, 'error'); } });
  };
  let searchTimer;
  qs('#user-company').onchange = load; qs('#user-employment').onchange = load; qs('#include-system').onchange = load;
  qs('#user-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); };
  qs('#add-user').onclick = () => editUser(null, load);
  qs('#export-all').onclick = async () => { try { await downloadFullExport(qs('#user-company').value, qs('#user-employment').value); } catch (e) { toast(e.message, 'error'); } };
  await load();
}

function editUser(user, reload) {
  const isNew = !user;
  openModal(isNew ? '직원 신규 등록' : '사용자 정보 수정', `
    <div class="grid cols-2">
      <label class="field"><span>회사</span><select id="edit-company">${companyOptions(user?.company_id || '')}</select></label>
      <label class="field"><span>사원코드</span><input id="edit-code" value="${esc(user?.employee_code || '')}"></label>
      <label class="field"><span>직원명</span><input id="edit-name" value="${esc(user?.employee_name || '')}" required></label>
      <label class="field"><span>로그인 ID</span><input id="edit-login" value="${esc(user?.login_id || '')}" placeholder="비워두면 직원명으로 자동 생성" ${isNew ? '' : 'required'}><div class="field-help">동명이인은 이름 뒤에 2, 3… 숫자로 자동 구분합니다.</div></label>
      <label class="field"><span>부서</span><input id="edit-dept" value="${esc(user?.department || '')}"></label>
      <label class="field"><span>직급</span><input id="edit-position" value="${esc(user?.position || '')}"></label>
      <label class="field"><span>연락처</span><input id="edit-phone" value="${esc(user?.phone || '')}"></label>
      <label class="field"><span>입사일</span><input id="edit-join" type="date" value="${esc(user?.join_date || today())}" required></label>
      <label class="field"><span>퇴사일</span><input id="edit-retire" type="date" value="${esc(user?.retire_date || '')}"><div class="field-help">퇴사일을 입력하면 재직자 조회에서 제외됩니다. 퇴사일이 지나면 로그인도 중지됩니다.</div></label>
      <label class="field"><span>비고</span><input id="edit-note" value="${esc(user?.note || '')}"></label>
    </div>
    <div class="check-row"><label class="check"><input id="edit-first" type="checkbox" ${user?.can_approve_first ? 'checked' : ''}>연차 승인자</label><label class="check"><input id="edit-admin" type="checkbox" ${user?.is_admin ? 'checked' : ''}>관리자 권한</label><label class="check"><input id="edit-active" type="checkbox" ${user ? (user.active ? 'checked' : '') : 'checked'}>사용 계정</label></div>
    <div class="notice"><strong>연차 승인자</strong>로 체크한 실제 재직 사원만 연차 신청의 결재자 목록에 나타납니다. 신청자가 선택한 결재라인의 마지막 사람이 최종 결정권자가 됩니다.</div>
    ${isNew ? '<div class="notice success"><strong>신규 직원 최초 비밀번호는 1111</strong>입니다. 저장 후 로그인 ID와 비밀번호를 다시 안내합니다.</div>' : ''}`,
    '<button class="btn secondary modal-cancel">취소</button><button id="save-user" class="btn">저장</button>');
  qs('#save-user', modal).onclick = async () => {
    const body = { company_id: qs('#edit-company', modal).value, employee_code: qs('#edit-code', modal).value,
      employee_name: qs('#edit-name', modal).value, login_id: qs('#edit-login', modal).value,
      department: qs('#edit-dept', modal).value, position: qs('#edit-position', modal).value, phone: qs('#edit-phone', modal).value, note: qs('#edit-note', modal).value,
      join_date: qs('#edit-join', modal).value, retire_date: qs('#edit-retire', modal).value,
      can_approve_first: qs('#edit-first', modal).checked, is_admin: qs('#edit-admin', modal).checked, active: qs('#edit-active', modal).checked };
    try {
      const result = await api(isNew ? '/api/users' : `/api/users/${user.id}`, { method: isNew ? 'POST' : 'PUT', body });
      modal.close();
      if (isNew) alert(`직원 등록 완료\n\n로그인 ID: ${result.login_id}\n최초 비밀번호: 1111\n\n직원에게 이 ID와 비밀번호를 알려주세요.`);
      else toast('사용자 정보가 저장되었습니다.');
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  };
}

function adjustUser(id, name, reload) {
  openModal(`${name} 연차 조정`, `<div class="notice">양수는 연차 추가, 음수는 연차 차감입니다. 0.5일 단위이며 등록일이 속한 현재 1년 주기에만 반영됩니다.</div><div class="grid cols-2"><label class="field"><span>조정 일수</span><input id="adjust-amount" type="number" step="0.5" placeholder="예: 1 또는 -0.5"></label><label class="field"><span>조정 사유</span><input id="adjust-reason" placeholder="예: 이관자료 보정"></label></div>`, '<button class="btn secondary modal-cancel">취소</button><button id="save-adjust" class="btn amber">조정 등록</button>');
  qs('#save-adjust', modal).onclick = async () => { try { await api(`/api/users/${id}/adjustments`, { method: 'POST', body: { amount: qs('#adjust-amount', modal).value, reason: qs('#adjust-reason', modal).value } }); modal.close(); toast('연차 조정이 등록되었습니다.'); await reload(); } catch (e) { toast(e.message, 'error'); } };
}

async function adminRenewals() {
  const currentMonth = today().slice(0, 7);
  qs('#admin-content').innerHTML = `
    <section class="card"><div class="toolbar">
      <label class="field"><span>회사</span><select id="renew-company">${companyOptions('', '전체 회사')}</select></label>
      <label class="field"><span>입사기념일 대상 월</span><input id="renew-month" type="month" value="${currentMonth}"></label>
      <label class="check" style="padding-bottom:10px"><input id="renew-only-unused" type="checkbox">미사용 잔여가 있는 사람만</label>
      <div class="actions" style="padding-bottom:1px"><button id="renew-search" class="btn">조회</button><button id="renew-export" class="btn outline">Excel 다운로드</button></div>
    </div></section>
    <div class="notice"><strong>입사일 기준 1년 갱신 대상자 조회</strong> · 선택한 월에 입사기념일이 있는 직원을 보여줍니다. 이전 주기 미사용 잔여는 갱신일에 이월하지 않고, 새 연차가 자동 생성됩니다.</div>
    <div id="renew-table"></div>`;
  const params = () => {
    const p = new URLSearchParams();
    const companyId = qs('#renew-company').value;
    if (companyId) p.set('company_id', companyId);
    p.set('month', qs('#renew-month').value || currentMonth);
    if (qs('#renew-only-unused').checked) p.set('only_unused', '1');
    return p;
  };
  const load = async () => {
    const result = await api(`/api/admin/renewals?${params()}`);
    const rows = result.rows;
    const unusedTotal = rows.reduce((sum, r) => sum + Number(r.unused_expiring || 0), 0);
    qs('#renew-table').innerHTML = `<section class="card"><div class="card-header"><h3>${esc(result.month)} 갱신 대상 ${rows.length}명</h3><span class="muted">소멸 잔여 합계 ${fmt(unusedTotal)}일</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>직원</th><th>입사일</th><th>갱신일</th><th>이전 주기</th><th>발생</th><th>사용</th><th>조정</th><th>최종잔여</th><th>소멸잔여</th><th>새 연차</th><th>상태</th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => `<tr><td class="center">${esc(r.company_name)}</td><td><div class="name">${esc(r.employee_name)}</div><div class="muted small-text">${esc(r.department || '-')} · ${esc(r.login_id)}</div></td><td class="center">${esc(r.join_date)}</td><td class="center strong">${esc(r.anniversary_date)}</td><td class="center nowrap">${esc(r.prior_cycle_start)} ~ ${esc(r.prior_cycle_end)}</td><td class="right">${fmt(r.prior_granted)}</td><td class="right">${fmt(r.prior_used)}</td><td class="right">${fmt(r.prior_adjustments)}</td><td class="right strong ${r.prior_balance < 0 ? 'negative' : ''}">${fmt(r.prior_balance)}</td><td class="right strong ${r.unused_expiring > 0 ? 'positive' : ''}">${fmt(r.unused_expiring)}</td><td class="right strong">${fmt(r.new_entitlement)}</td><td class="center"><span class="badge ${r.status === '갱신예정' ? 'amber' : 'green'}">${esc(r.status)}</span></td></tr>`).join('') : '<tr><td colspan="12" class="empty">선택한 월의 갱신 대상자가 없습니다.</td></tr>'}
      </tbody></table></div></section>`;
  };
  qs('#renew-search').onclick = load;
  qs('#renew-company').onchange = load;
  qs('#renew-month').onchange = load;
  qs('#renew-only-unused').onchange = load;
  qs('#renew-export').onclick = async () => { try { await downloadRenewalExport(params()); } catch (e) { toast(e.message, 'error'); } };
  await load();
}

async function adminRequests() {
  qs('#admin-content').innerHTML = `<section class="card"><div class="toolbar"><label class="field"><span>회사</span><select id="req-company">${companyOptions('', '전체 회사')}</select></label><label class="field"><span>시작일 이후</span><input id="req-from" type="date"></label><label class="field"><span>시작일 이전</span><input id="req-to" type="date"></label><label class="field"><span>상태</span><select id="req-status"><option value="">전체</option><option value="PENDING">승인대기</option><option value="APPROVED">최종승인</option><option value="REJECTED">반려</option></select></label><label class="field"><span>자료</span><select id="req-source"><option value="">전체</option><option value="APPLICATION">시스템 신청</option><option value="EXCEL">엑셀 상세</option><option value="EXCEL_SUMMARY">엑셀 합계</option></select></label><div class="actions"><button id="req-search" class="btn">조회</button><button id="req-export" class="btn outline">Excel</button></div></div></section><div id="request-table"></div>`;
  const load = async () => {
    const p = new URLSearchParams(); const values = [['company_id', '#req-company'], ['from', '#req-from'], ['to', '#req-to'], ['status', '#req-status'], ['source', '#req-source']]; values.forEach(([k, s]) => { if (qs(s).value) p.set(k, qs(s).value); });
    const rows = await api(`/api/admin/requests?${p}`);
    const shown = rows.slice(0, 500);
    qs('#request-table').innerHTML = `<section class="card"><div class="card-header"><h3>조회 ${rows.length}건</h3><span class="muted">${rows.length > 500 ? '화면에는 최근 500건만 표시합니다. Excel에는 전체가 포함됩니다.' : ''}</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>직원</th><th>구분</th><th>기간</th><th>일수</th><th>상태</th><th>승인라인</th><th>사유·반려사유</th><th>자료</th></tr></thead><tbody>${shown.length ? shown.map((r) => { const [label, color] = statusInfo(r); return `<tr><td class="center">${esc(r.company_name)}</td><td><div class="name">${esc(r.applicant_name)}</div><div class="muted small-text">${esc(r.applicant_login)}</div></td><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td><td class="center nowrap">${esc(r.start_date)}${r.end_date !== r.start_date ? ` ~ ${esc(r.end_date)}` : ''}</td><td class="right strong">${fmt(r.days)}</td><td class="center"><span class="badge ${color}">${label}</span></td><td>${approvalLineHtml(r, true)}</td><td>${esc(r.reason || '-')}${r.reject_reason ? `<div class="negative small-text">반려: ${esc(r.reject_reason)}</div>` : ''}</td><td class="center"><span class="badge gray">${r.source === 'APPLICATION' ? '시스템' : '엑셀'}</span></td></tr>`; }).join('') : '<tr><td colspan="9" class="empty">조회 결과가 없습니다.</td></tr>'}</tbody></table></div></section>`;
  };
  qs('#req-search').onclick = load;
  qs('#req-export').onclick = async () => { try { await downloadFullExport(qs('#req-company').value); } catch (e) { toast(e.message, 'error'); } };
  await load();
}

async function adminCompanies(tabRequestId = adminTabRequestId) {
  const render = () => {
    if (!isCurrentAdminTab('companies', tabRequestId)) return;
    const adminContent = qs('#admin-content');
    if (!adminContent) return;
    adminContent.innerHTML = `<div class="grid cols-2"><section class="card"><h3>회사 등록</h3><div class="actions"><input id="new-company" type="text" placeholder="회사명"><button id="add-company" class="btn">등록</button></div></section><section class="card"><h3>운영 안내</h3><div class="notice">하나의 시스템에서 여러 회사를 추가할 수 있습니다. 회사별 직원과 승인자를 각각 등록하세요.</div></section></div><section class="card"><h3>회사 목록</h3><div class="table-wrap"><table class="data-table" style="min-width:600px"><thead><tr><th>회사명</th><th>상태</th><th>등록일</th><th>수정</th></tr></thead><tbody>${companies.map((c) => `<tr><td><input id="company-name-${c.id}" value="${esc(c.name)}"></td><td class="center"><label class="check" style="justify-content:center"><input id="company-active-${c.id}" type="checkbox" ${c.active ? 'checked' : ''}>사용</label></td><td class="center">${esc(c.created_at || '')}</td><td class="center"><button class="btn outline small save-company" data-id="${c.id}">저장</button></td></tr>`).join('')}</tbody></table></div></section>`;
    qs('#add-company').onclick = async () => { try { await api('/api/companies', { method: 'POST', body: { name: qs('#new-company').value } }); companies = await api('/api/companies'); toast('회사가 등록되었습니다.'); render(); } catch (e) { toast(e.message, 'error'); } };
    qsa('.save-company').forEach((b) => b.onclick = async () => { try { await api(`/api/companies/${b.dataset.id}`, { method: 'PUT', body: { name: qs(`#company-name-${b.dataset.id}`).value, active: qs(`#company-active-${b.dataset.id}`).checked } }); companies = await api('/api/companies'); toast('회사 정보가 저장되었습니다.'); render(); } catch (e) { toast(e.message, 'error'); } });
  }; render();
}

async function passwordPage() {
  qs('#page').innerHTML = `${pageTitle('비밀번호 변경', '초기 비밀번호 1111을 본인만의 비밀번호로 변경합니다.')}<section class="card" style="max-width:650px"><form id="password-form"><div class="grid"><label class="field"><span>현재 비밀번호</span><input id="current-password" type="password" required></label><label class="field"><span>새 비밀번호</span><input id="new-password" type="password" minlength="4" required></label><label class="field"><span>새 비밀번호 확인</span><input id="confirm-password" type="password" minlength="4" required></label></div><div class="actions" style="justify-content:flex-end;margin-top:16px"><button class="btn" type="submit">비밀번호 변경</button></div></form></section>`;
  qs('#password-form').onsubmit = async (event) => { event.preventDefault(); try { await api('/api/change-password', { method: 'POST', body: { current_password: qs('#current-password').value, new_password: qs('#new-password').value, confirm_password: qs('#confirm-password').value } }); toast('비밀번호가 변경되었습니다.'); await renderShellV7(); } catch (e) { toast(e.message, 'error'); } };
}


// ===== v6.0 UI overrides =====
let currentAdminTabV6 = 'users';

function requestPeriodLabel(r) {
  const datePart = r.end_date && r.end_date !== r.start_date ? `${esc(r.start_date)} ~ ${esc(r.end_date)}` : esc(r.start_date || '');
  const timePart = r.start_time && r.end_time ? `<div class="muted small-text">${esc(r.start_time)} ~ ${esc(r.end_time)}</div>` : '';
  return `${datePart}${timePart}`;
}

function helpContent() {
  const common = '<div class="notice">화면의 입력값을 변경한 뒤 저장/조회 버튼을 누릅니다. 오류가 나면 메시지 내용을 확인하고 다시 시도하세요.</div>';
  if (currentPage === 'apply') return `${common}<div class="help-steps"><div class="help-step"><strong>반차/하루/기간 선택</strong><div class="muted">오전 반차와 오후 반차는 회사 기준 근무시간으로 자동 계산합니다.</div></div><div class="help-step"><strong>날짜 선택</strong><div class="muted">기간 신청은 토·일요일, 국가공휴일, 대체공휴일, 관리자가 추가한 휴일을 자동 제외합니다.</div></div><div class="help-step"><strong>결재자 선택</strong><div class="muted">실제 직원 승인자를 선택하고 최종 결재 단계까지 승인 요청을 누릅니다.</div></div></div>`;
  if (currentPage === 'history') return `${common}<div class="help-steps"><div class="help-step"><strong>나의 사용내역</strong><div class="muted">기존 Excel 이관자료와 새 시스템 신청자료를 함께 조회합니다.</div></div><div class="help-step"><strong>누적 사용</strong><div class="muted">대시보드의 누적 사용에는 기존 Excel 사용일수도 포함됩니다.</div></div></div>`;
  if (currentPage === 'inbox') return `${common}<div class="help-steps"><div class="help-step"><strong>승인</strong><div class="muted">본인에게 지정된 현재 승인단계의 신청만 나타납니다.</div></div><div class="help-step"><strong>반려</strong><div class="muted">반려 사유를 입력하면 신청자와 관리자 내역에 함께 남습니다.</div></div></div>`;
  if (currentPage === 'admin') {
    const map = {
      users: '직원 등록·수정, 승인권한 지정, 비밀번호 초기화, 개인별 연차조정을 합니다.',
      requests: '승인대기·승인완료·반려 내역을 회사/직원/기간별로 조회합니다.',
      usage: '회사별 최종 승인 사용내역을 조회하고 Excel로 저장합니다.',
      settlement: '기준일이 속한 달의 입사기념일 대상자와 이전 1년 미사용 연차를 조회하여 연차비 정산자료로 사용합니다.',
      excel: '전체 자료 Excel 다운로드, 표준 Excel 업로드, JSON 백업/복원을 합니다.',
      standards: '회사별 근무 시작·점심·종료시간과 추가 휴일을 관리합니다.',
      companies: '회사명과 사용여부를 관리합니다.'
    };
    return `${common}<div class="notice success"><strong>${esc(map[currentAdminTabV6] || '관리자 화면')}</strong></div>`;
  }
  if (currentPage === 'password') return `${common}<div class="notice warning">초기 비밀번호 1111은 가능한 빨리 본인만의 비밀번호로 변경하세요.</div>`;
  return `${common}<div class="help-steps"><div class="help-step"><strong>대시보드</strong><div class="muted">일반직원은 본인 연차, 관리자는 전체 직원 현황을 확인합니다.</div></div><div class="help-step"><strong>Help</strong><div class="muted">현재 페이지별 사용방법은 언제든지 상단 Help 버튼을 누르면 확인할 수 있습니다.</div></div></div>`;
}

function showHelp() { openModal('현재 페이지 사용방법', helpContent()); }

async function renderShellV6() {
  me = await api('/api/me');
  companies = me.is_admin ? await api('/api/companies') : [];
  let navItems;
  if (me.is_admin) {
    navItems = [['dashboard', '⌂', '대시보드']];
    if (me.can_approve_first || me.can_approve_final) navItems.push(['inbox', '✓', '승인함']);
    navItems.push(['admin', '⚙', '관리자'], ['password', '●', '비밀번호 변경']);
  } else {
    navItems = [['dashboard', '⌂', '대시보드'], ['apply', '✎', '연차 신청'], ['history', '▤', '나의 사용내역']];
    if (me.can_approve_first || me.can_approve_final) navItems.push(['inbox', '✓', '승인함']);
    navItems.push(['password', '●', '비밀번호 변경']);
  }
  app.innerHTML = `
    <header class="app-header"><div class="header-inner">
      <div class="brand"><div class="brand-mark">연</div><div><h1>디엔엠 연차관리</h1><small>(주)디엔엠 · v6.0</small></div></div>
      <div class="user-box"><div class="user-meta"><strong>${esc(me.employee_name)}</strong><span>${esc(me.company_name)} · ${esc(me.login_id)} · ${esc(me.role_label)}</span></div><button id="help-button" class="btn outline small">Help</button><button id="logout" class="btn outline small">로그아웃</button></div>
    </div></header>
    <div class="layout"><aside class="sidebar"><nav class="nav-card">${navItems.map(([key, icon, label]) => `<button class="nav-button" data-page="${key}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}</nav></aside><main class="content"><div id="page"></div></main></div>`;
  qs('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; renderLogin(); };
  qs('#help-button').onclick = showHelp;
  qsa('.nav-button').forEach((button) => { button.onclick = () => goV6(button.dataset.page); });
  const safePage = me.is_admin && ['apply', 'history'].includes(currentPage) ? 'dashboard' : currentPage;
  await goV6(safePage);
}

async function goV6(page) {
  currentPage = page;
  qsa('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const handlers = { dashboard: dashboardPageV6, apply: applyPageV6, history: historyPageV6, inbox: inboxPageV6, admin: adminPageV6, password: passwordPage };
  loading();
  try { await handlers[page](); } catch (error) { qs('#page').innerHTML = `<div class="notice danger">${esc(error.message)}</div>`; }
}

async function dashboardPageV6(requestId = pageRequestId, alreadyRefreshed = false) {
  if (!alreadyRefreshed) await refreshMe();
  if (!isCurrentPage('dashboard', requestId)) return;
  if (me.is_admin) return adminDashboardPage(requestId);
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `
    ${pageTitle('대시보드', `${me.as_of} 기준 · 기존 Excel 사용자료와 현재 1년 주기를 함께 보여줍니다.`)}
    ${me.must_change_password ? '<div class="notice warning"><strong>최초 비밀번호 1111을 사용 중입니다.</strong> “비밀번호 변경” 메뉴에서 변경하세요.</div>' : ''}
    <section class="stats stats-5">
      <div class="stat-card"><div class="stat-label">현재 주기 발생</div><div class="stat-value">${fmt(me.granted)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card"><div class="stat-label">현재 주기 사용</div><div class="stat-value">${fmt(me.used)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card"><div class="stat-label">누적 사용(Excel 포함)</div><div class="stat-value">${fmt(me.total_used)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card"><div class="stat-label">승인 대기</div><div class="stat-value">${fmt(me.pending)}<span class="stat-unit">일</span></div></div>
      <div class="stat-card primary"><div class="stat-label">현재 잔여</div><div class="stat-value ${me.remaining < 0 ? 'negative' : ''}">${fmt(me.remaining)}<span class="stat-unit">일</span></div></div>
    </section>
    <div class="notice ${me.remaining <= 0 ? 'warning' : ''}"><strong>잔여가 0일 또는 음수여도 신청할 수 있습니다.</strong> 승인대기 포함 예상 잔여는 ${fmt(me.projected_remaining)}일입니다.</div>
    <div class="grid cols-2">
      <section class="card"><h3>입사일 기준 연차 주기</h3><div class="table-wrap"><table class="data-table compact-table"><tbody>
        <tr><td class="muted">회사 / 부서</td><td class="right strong">${esc(me.company_name)} / ${esc(me.department || '-')}</td></tr>
        <tr><td class="muted">입사일 / 근속</td><td class="right strong">${esc(me.join_date)} / ${esc(me.tenure)}</td></tr>
        <tr><td class="muted">현재 연차 주기</td><td class="right strong">${esc(me.cycle_start)} ~ ${esc(me.cycle_end)}</td></tr>
        <tr><td class="muted">현재 주기 사용</td><td class="right strong">${fmt(me.used)}일</td></tr>
        <tr><td class="muted">기존 Excel 누적 사용</td><td class="right strong">${fmt(me.source_used ?? me.total_used)}일</td></tr>
        <tr><td class="muted">현재 잔여</td><td class="right strong ${me.remaining < 0 ? 'negative' : ''}">${fmt(me.remaining)}일</td></tr>
        <tr><td class="muted">다음 갱신일</td><td class="right strong">${esc(me.next_anniversary)} / ${fmt(me.next_entitlement)}일 생성</td></tr>
      </tbody></table></div></section>
      <section class="card"><h3>연차 운영 방식</h3><div class="help-steps"><div class="help-step"><strong>반차</strong><div class="muted small-text">오전/오후를 선택하면 기준정보의 근무시간으로 0.5일 자동 계산합니다.</div></div><div class="help-step"><strong>기간</strong><div class="muted small-text">토·일요일, 국가공휴일, 대체공휴일, 회사 추가휴일을 자동 제외합니다.</div></div><div class="help-step"><strong>입사기념일 갱신</strong><div class="muted small-text">1년이 되면 15일, 이후 2년마다 1일 증가하여 최대 25일입니다.</div></div></div></section>
    </div>`;
}

async function adminDashboardPage(requestId = pageRequestId) {
  if (!isCurrentPage('dashboard', requestId)) return;
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `${pageTitle(me.is_representative ? '대표이사 대시보드' : '관리자 대시보드', '전체 직원의 연차와 승인 현황을 한 화면에서 확인합니다.', '<button id="open-admin" class="btn">관리 상세</button>')}
    <section class="card"><div class="toolbar"><label class="field"><span>직원 범위</span><select id="dash-employment"><option value="current">재직자 (퇴사일 없음)</option><option value="retired">퇴사일 등록자</option><option value="all">전체 직원</option></select></label><div class="notice" style="margin:0;flex:1">퇴사일이 입력된 직원은 별도로 조회할 수 있습니다.</div></div></section>
    <div id="dash-body"></div>`;
  qs('#open-admin').onclick = () => goV7('admin');
  const load = async () => {
    const employment = qs('#dash-employment').value;
    const [users, stats, pending, approved] = await Promise.all([
      api(`/api/users?employment=${employment}`), api(`/api/admin/stats?employment=${employment}`),
      api(`/api/admin/requests?status=PENDING&employment=${employment}`), api(`/api/admin/requests?status=APPROVED&from=${today().slice(0, 4)}-01-01&employment=${employment}`)
    ]);
    if (!isCurrentPage('dashboard', requestId)) return;
    const dashBody = qs('#dash-body');
    if (!dashBody) return;
    const totalRemaining = users.reduce((sum, u) => sum + Number(u.remaining || 0), 0);
    dashBody.innerHTML = `
      <section class="stats"><div class="stat-card"><div class="stat-label">조회 직원</div><div class="stat-value">${stats.employee_count}<span class="stat-unit">명</span></div></div><div class="stat-card"><div class="stat-label">승인 대기</div><div class="stat-value">${stats.pending_count}<span class="stat-unit">건</span></div></div><div class="stat-card"><div class="stat-label">금년 승인 사용</div><div class="stat-value">${fmt(stats.approved_this_year)}<span class="stat-unit">일</span></div></div><div class="stat-card primary"><div class="stat-label">현재잔여 합계</div><div class="stat-value">${fmt(totalRemaining)}<span class="stat-unit">일</span></div></div></section>
      <section class="card"><div class="card-header"><h3>직원 연차 현황</h3><span class="muted">기존 Excel 누적 사용일수 포함</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>직원</th><th>입사일</th><th>퇴사일</th><th>상태</th><th>현재주기</th><th>발생</th><th>주기사용</th><th>누적사용</th><th>잔여</th><th>대기</th></tr></thead><tbody>${users.map((u) => `<tr><td class="center">${esc(u.company_name)}</td><td><div class="name">${esc(u.employee_name)}</div><div class="muted small-text">${esc(u.department || '-')} · ${esc(u.login_id)}</div></td><td class="center">${esc(u.join_date)}</td><td class="center ${u.retire_date ? 'negative' : ''}">${esc(u.retire_date || '-')}</td><td class="center"><span class="badge ${u.employment_status === '재직' ? 'green' : 'amber'}">${esc(u.employment_status)}</span></td><td class="center nowrap">${esc(u.cycle_start)} ~ ${esc(u.cycle_end)}</td><td class="right">${fmt(u.granted)}</td><td class="right">${fmt(u.used)}</td><td class="right strong">${fmt(u.total_used)}</td><td class="right strong ${u.remaining < 0 ? 'negative' : ''}">${fmt(u.remaining)}</td><td class="right">${fmt(u.pending)}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">조회 직원이 없습니다.</td></tr>'}</tbody></table></div></section>
      <div class="grid cols-2"><section class="card"><div class="card-header"><h3>승인 대기 최근 ${Math.min(8, pending.length)}건</h3></div>${pending.slice(0, 8).map((r) => `<div class="summary-row"><div><strong>${esc(r.applicant_name)}</strong> · ${esc(leaveTypeLabel(r.leave_type))}<div class="muted small-text">${requestPeriodLabel(r)} · ${fmt(r.days)}일</div></div><span class="badge amber">대기</span></div>`).join('') || '<div class="empty">승인 대기가 없습니다.</div>'}</section><section class="card"><div class="card-header"><h3>금년 승인 최근 ${Math.min(8, approved.length)}건</h3></div>${approved.slice(0, 8).map((r) => `<div class="summary-row"><div><strong>${esc(r.applicant_name)}</strong> · ${esc(leaveTypeLabel(r.leave_type))}<div class="muted small-text">${requestPeriodLabel(r)} · ${fmt(r.days)}일</div></div><span class="badge green">승인</span></div>`).join('') || '<div class="empty">승인내역이 없습니다.</div>'}</section></div>`;
  };
  qs('#dash-employment').onchange = load; await load();
}

async function applyPageV6() {
  if (me.is_system_account) { qs('#page').innerHTML = `${pageTitle('연차 신청', '승인용 계정은 신청할 수 없습니다.')}<div class="notice warning">직원 본인 계정으로 로그인해 주세요.</div>`; return; }
  const approvers = await api('/api/approvers'); const noApprover = !approvers.first.length || !approvers.final.length;
  qs('#page').innerHTML = `
    ${pageTitle('연차 신청', '휴대폰에서도 오전반차·오후반차·하루·기간을 빠르게 신청할 수 있습니다.')}
    ${noApprover ? '<div class="notice danger"><strong>승인자가 등록되지 않았습니다.</strong> 관리자에게 승인권한 설정을 요청하세요.</div>' : ''}
    <section class="card mobile-apply"><form id="leave-form">
      <label class="field"><span>신청 구분</span><div class="leave-type-pills"><label><input type="radio" name="leave-type-radio" value="FULL" checked><span>하루 / 기간</span></label><label><input type="radio" name="leave-type-radio" value="AM_HALF"><span>오전 반차</span></label><label><input type="radio" name="leave-type-radio" value="PM_HALF"><span>오후 반차</span></label></div></label>
      <div class="grid cols-2 date-grid"><label class="field"><span>시작일</span><input id="start-date" type="date" min="${today()}" required></label><label class="field" id="end-field"><span>종료일</span><input id="end-date" type="date" min="${today()}" required></label></div>
      <div id="day-preview" class="calc-preview">날짜를 계산하는 중입니다.</div>
      <div class="grid cols-2"><label class="field"><span>연차 승인자</span><select id="approver-first" required><option value="">선택</option>${approvers.first.map((a) => `<option value="${a.id}">${esc(a.employee_name)} · ${esc(a.position || a.department || '')}</option>`).join('')}</select></label><label class="field"><span>최종 결재</span><select id="approver-final" required><option value="">선택</option>${approvers.final.map((a) => `<option value="${a.id}">${esc(a.employee_name)} · ${esc(a.position || a.department || '')}</option>`).join('')}</select></label></div>
      <label class="field" style="margin-top:14px"><span>신청 사유</span><textarea id="leave-reason" placeholder="간단한 사유 또는 업무 인수인계 사항"></textarea></label>
      <button class="btn mobile-submit" type="submit" ${noApprover ? 'disabled' : ''}>승인 요청</button>
    </form></section>
    <div class="notice warning"><strong>잔여 ${fmt(me.remaining)}일이어도 신청 가능합니다.</strong> 기간 신청의 토·일요일, 국가공휴일·대체공휴일 및 관리자가 등록한 추가휴일은 자동 제외됩니다.</div>`;
  const start = qs('#start-date'), end = qs('#end-date'), preview = qs('#day-preview'); start.value = today(); end.value = today();
  const selectedType = () => qs('input[name="leave-type-radio"]:checked').value;
  let calcTimer; let lastCalc = null;
  const update = () => {
    clearTimeout(calcTimer); const type = selectedType(); const half = type !== 'FULL'; qs('#end-field').style.display = half ? 'none' : ''; end.disabled = half; if (half) end.value = start.value;
    calcTimer = setTimeout(async () => {
      if (!start.value || !end.value) return;
      preview.innerHTML = '<span class="spinner mini"></span> 자동 계산 중';
      try {
        lastCalc = await api('/api/calculate-leave', { method: 'POST', body: { leave_type: type, start_date: start.value, end_date: end.value } });
        const excluded = lastCalc.excluded_dates?.length ? `<div class="excluded-list">제외: ${lastCalc.excluded_dates.map((x) => `${esc(x.date)} ${esc(x.reason)}`).join(', ')}</div>` : '';
        preview.innerHTML = `<strong>${fmt(lastCalc.days)}일</strong> · ${esc(lastCalc.start_time)} ~ ${esc(lastCalc.end_time)}${excluded}`;
      } catch (e) { lastCalc = null; preview.innerHTML = `<span class="negative">${esc(e.message)}</span>`; }
    }, 180);
  };
  qsa('input[name="leave-type-radio"]').forEach((el) => el.onchange = update); [start, end].forEach((el) => el.onchange = update); update();
  qs('#leave-form').onsubmit = async (event) => {
    event.preventDefault(); const submit = qs('button[type=submit]', event.currentTarget); submit.disabled = true;
    try {
      const result = await api('/api/leave-requests', { method: 'POST', body: { leave_type: selectedType(), start_date: start.value, end_date: end.value, approver1_id: qs('#approver-first').value, final_approver_id: qs('#approver-final').value, reason: qs('#leave-reason').value } });
      toast(`${fmt(result.days)}일 연차가 신청되었습니다.`); await refreshMe(); goV6('history');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  };
}

async function historyPageV6() {
  const rows = await api('/api/my-requests'); const years = [...new Set(rows.map((r) => r.start_date.slice(0, 4)))].sort().reverse();
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `${pageTitle('나의 사용내역', '기존 Excel 자료와 시스템 신청자료를 함께 확인합니다.')}<div class="notice success"><strong>누적 최종승인 사용 ${fmt(me.total_used)}일</strong> · 기존 Excel 사용일수도 포함됩니다.</div><section class="card"><div class="toolbar"><label class="field"><span>연도</span><select id="history-year"><option value="">전체</option>${years.map((y) => `<option>${y}</option>`).join('')}</select></label><label class="field"><span>상태</span><select id="history-status"><option value="">전체</option><option value="APPROVED">최종승인</option><option value="PENDING">승인대기</option><option value="REJECTED">반려·취소</option></select></label><label class="field"><span>자료</span><select id="history-source"><option value="">전체</option><option value="APPLICATION">시스템 신청</option><option value="EXCEL">기존 Excel</option></select></label></div></section><div id="history-table"></div>`;
  const render = () => {
    const year = qs('#history-year').value, status = qs('#history-status').value, source = qs('#history-source').value;
    const filtered = rows.filter((r) => { if (year && !r.start_date.startsWith(year)) return false; const info = statusInfo(r)[0]; if (status === 'APPROVED' && info !== '최종승인') return false; if (status === 'PENDING' && !info.includes('대기')) return false; if (status === 'REJECTED' && !['반려', '취소'].includes(info)) return false; if (source === 'APPLICATION' && r.source !== 'APPLICATION') return false; if (source === 'EXCEL' && r.source === 'APPLICATION') return false; return true; });
    qs('#history-table').innerHTML = `<section class="card"><div class="card-header"><h3>총 ${filtered.length}건</h3><span class="muted">선택조건 승인합계 ${fmt(filtered.filter((r) => statusInfo(r)[0] === '최종승인').reduce((s, r) => s + Number(r.days), 0))}일</span></div><div class="table-wrap desktop-table"><table class="data-table"><thead><tr><th>구분</th><th>기간/시간</th><th>일수</th><th>승인자</th><th>상태</th><th>사유</th><th>자료</th><th>처리</th></tr></thead><tbody>${filtered.map((r) => { const [label, color] = statusInfo(r); const cancellable = r.source === 'APPLICATION' && !['최종승인', '반려', '취소'].includes(label); return `<tr><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td><td class="center">${requestPeriodLabel(r)}</td><td class="right strong">${fmt(r.days)}</td><td>1차 ${esc(r.approver1_name || '-')}<br>최종 ${esc(r.final_approver_name || '-')}</td><td class="center"><span class="badge ${color}">${label}</span>${r.reject_reason ? `<div class="negative small-text">${esc(r.reject_reason)}</div>` : ''}</td><td>${esc(r.reason || '-')}</td><td class="center">${r.source === 'APPLICATION' ? '시스템' : 'Excel'}</td><td class="center">${cancellable ? `<button class="btn red small cancel-request" data-id="${r.id}">취소</button>` : '-'}</td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">내역이 없습니다.</td></tr>'}</tbody></table></div><div class="mobile-list">${filtered.map((r) => { const [label, color] = statusInfo(r); return `<article class="mobile-record"><div class="record-head"><strong>${esc(leaveTypeLabel(r.leave_type))}</strong><span class="badge ${color}">${label}</span></div><div>${requestPeriodLabel(r)} · <strong>${fmt(r.days)}일</strong></div><div class="muted small-text">${esc(r.reason || '-')}</div></article>`; }).join('')}</div></section>`;
    qsa('.cancel-request').forEach((button) => { button.onclick = async () => { if (!confirm('이 연차 신청을 취소하시겠습니까?')) return; try { await api(`/api/requests/${button.dataset.id}/cancel`, { method: 'POST' }); toast('신청이 취소되었습니다.'); historyPageV6(); } catch (e) { toast(e.message, 'error'); } }; });
  };
  ['#history-year', '#history-status', '#history-source'].forEach((sel) => qs(sel).onchange = render); render();
}

async function inboxPageV6() {
  const rows = await api('/api/inbox');
  const cards = rows.map((r) => `<article class="approval-card"><div class="record-head"><span class="badge ${r.stage === 'FIRST' ? 'blue' : 'green'}">${r.stage === 'FIRST' ? '1차 승인' : '최종 승인'}</span><strong>${esc(r.applicant_name)}</strong></div><div class="approval-type">${esc(leaveTypeLabel(r.leave_type))} · ${fmt(r.days)}일</div><div>${requestPeriodLabel(r)}</div><div class="muted">${esc(r.reason || '-')}</div><div class="approval-actions"><button class="btn green approve" data-id="${r.id}">승인</button><button class="btn red reject" data-id="${r.id}">반려</button></div></article>`).join('');
  qs('#page').innerHTML = `${pageTitle('승인함', '휴대폰에서 바로 승인/반려할 수 있도록 신청별 카드로 표시합니다.')}<section class="card"><div class="card-header"><h3>처리 대기 ${rows.length}건</h3></div><div class="approval-grid">${cards || '<div class="empty">현재 처리할 신청이 없습니다.</div>'}</div></section>`;
  qsa('.approve').forEach((button) => { button.onclick = async () => { if (!confirm('이 신청을 승인하시겠습니까?')) return; try { await api(`/api/requests/${button.dataset.id}/action`, { method: 'POST', body: { action: 'approve' } }); toast('승인 처리되었습니다.'); inboxPageV6(); } catch (e) { toast(e.message, 'error'); } }; });
  qsa('.reject').forEach((button) => { button.onclick = () => { openModal('연차 신청 반려', '<label class="field"><span>반려 사유</span><textarea id="reject-reason" placeholder="반려 사유"></textarea></label>', '<button class="btn secondary modal-cancel">취소</button><button id="confirm-reject" class="btn red">반려 처리</button>'); qs('#confirm-reject', modal).onclick = async () => { try { await api(`/api/requests/${button.dataset.id}/action`, { method: 'POST', body: { action: 'reject', reason: qs('#reject-reason', modal).value } }); modal.close(); toast('반려 처리되었습니다.'); inboxPageV6(); } catch (e) { toast(e.message, 'error'); } }; }; });
}

async function adminPageV6(requestId = pageRequestId) {
  if (!me.can_manage) throw new Error('관리자 또는 대표이사 권한이 필요합니다.');
  if (!isCurrentPage('admin', requestId)) return;
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `${pageTitle(me.is_representative ? '대표이사 관리' : '관리자', '직원·승인·미사용정산·Excel·기준정보를 통합 관리합니다.')}<div class="tabs"><button class="tab active" data-tab="users">사용자 관리</button><button class="tab" data-tab="requests">승인·신청내역</button><button class="tab" data-tab="usage">회사별 사용현황</button><button class="tab" data-tab="settlement">미사용 연차정산</button><button class="tab" data-tab="excel">Excel·백업</button><button class="tab" data-tab="standards">기준정보·휴일</button><button class="tab" data-tab="companies">회사 설정</button></div><div id="admin-content"></div>`;
  qsa('.tab').forEach((tab) => {
    tab.onclick = () => {
      if (!isCurrentPage('admin', requestId)) return;
      qsa('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      currentAdminTabV6 = tab.dataset.tab;
      loadAdminTabV6(tab.dataset.tab, requestId);
    };
  });
  currentAdminTabV6 = 'users';
  await loadAdminTabV6('users', requestId);
}

async function loadAdminTabV6(tab, pageId = pageRequestId) {
  if (!isCurrentPage('admin', pageId)) return;
  currentAdminTabV6 = tab;
  const tabRequestId = ++adminTabRequestId;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  adminContent.innerHTML = '<div class="loading"><span class="spinner"></span>관리 자료를 불러오는 중입니다.</div>';
  if (tab === 'users') return adminUsers(tabRequestId);
  if (tab === 'requests') return adminRequestsV6(tabRequestId);
  if (tab === 'usage') return adminUsageV6(tabRequestId);
  if (tab === 'settlement') return adminSettlementV6(tabRequestId);
  if (tab === 'excel') return adminExcelV6(tabRequestId);
  if (tab === 'standards') return adminStandardsV6(tabRequestId);
  return adminCompanies(tabRequestId);
}

async function adminRequestsV6(tabRequestId = adminTabRequestId) {
  const users = await api('/api/users?employment=all');
  if (!isCurrentAdminTab('requests', tabRequestId)) return;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  adminContent.innerHTML = `<section class="card"><div class="toolbar"><label class="field"><span>재직 구분</span><select id="req-employment"><option value="all">전체</option><option value="current">재직자</option><option value="retired">퇴사일 등록자</option></select></label><label class="field"><span>회사</span><select id="req-company">${companyOptions('', '전체 회사')}</select></label><label class="field"><span>직원</span><select id="req-user"><option value="">전체 직원</option>${users.map((u) => `<option value="${u.id}" data-company="${u.company_id}">${esc(u.employee_name)} (${esc(u.login_id)})</option>`).join('')}</select></label><label class="field"><span>시작일 이후</span><input id="req-from" type="date"></label><label class="field"><span>시작일 이전</span><input id="req-to" type="date"></label><label class="field"><span>상태</span><select id="req-status"><option value="">전체</option><option value="PENDING">승인대기</option><option value="APPROVED">최종승인</option><option value="REJECTED">반려</option></select></label><div class="actions"><button id="req-search" class="btn">조회</button></div></div></section><div id="request-table"></div>`;
  const load = async () => {
    const p = new URLSearchParams({employment: qs('#req-employment').value}); [['company_id','#req-company'],['user_id','#req-user'],['from','#req-from'],['to','#req-to'],['status','#req-status']].forEach(([k,s]) => { if (qs(s).value) p.set(k, qs(s).value); }); const rows = await api(`/api/admin/requests?${p}`); const shown = rows.slice(0, 700);
    if (!isCurrentAdminTab('requests', tabRequestId)) return;
    const requestTable = qs('#request-table');
    if (!requestTable) return;
    requestTable.innerHTML = `<section class="card"><div class="card-header"><h3>조회 ${rows.length}건</h3><span class="muted">승인자·처리시간·사유까지 확인</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>직원</th><th>구분</th><th>기간/시간</th><th>일수</th><th>상태</th><th>승인라인</th><th>현재단계</th><th>사유/반려</th><th>신청/처리일시</th></tr></thead><tbody>${shown.map((r) => { const [label,color]=statusInfo(r); return `<tr><td class="center">${esc(r.company_name)}</td><td><div class="name">${esc(r.applicant_name)}</div><div class="muted small-text">${esc(r.applicant_login)}</div></td><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td><td class="center">${requestPeriodLabel(r)}</td><td class="right strong">${fmt(r.days)}</td><td class="center"><span class="badge ${color}">${label}</span></td><td>${approvalLineHtml(r, true)}</td><td>${r.current_approval ? `<strong>${esc(r.current_approval.role === 'REPRESENTATIVE' ? '최종' : `${r.current_approval.order}차`)}</strong><div class="muted small-text">${esc(r.current_approval.approver_name || '')}</div>` : '-'}</td><td>${esc(r.reason || '-')}${r.reject_reason ? `<div class="negative small-text">반려: ${esc(r.reject_reason)}</div>` : ''}</td><td class="small-text">신청 ${esc(r.created_at || '')}<br>수정 ${esc(r.updated_at || '')}</td></tr>`; }).join('') || '<tr><td colspan="10" class="empty">조회 결과가 없습니다.</td></tr>'}</tbody></table></div></section>`;
  };
  qs('#req-employment').onchange=load; qs('#req-company').onchange = () => { const cid=qs('#req-company').value; qsa('#req-user option').forEach((o) => { if (!o.value) return; o.hidden = cid && o.dataset.company !== cid; }); if (qs('#req-user').selectedOptions[0]?.hidden) qs('#req-user').value=''; load(); }; qs('#req-user').onchange=load; qs('#req-status').onchange=load; qs('#req-search').onclick=load; await load();
}

async function adminUsageV6(tabRequestId = adminTabRequestId) {
  const users = await api('/api/users?employment=all'); const year = today().slice(0,4);
  if (!isCurrentAdminTab('usage', tabRequestId)) return;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  adminContent.innerHTML = `<section class="card"><div class="toolbar"><label class="field"><span>재직 구분</span><select id="usage-employment"><option value="all">전체</option><option value="current">재직자</option><option value="retired">퇴사일 등록자</option></select></label><label class="field"><span>회사</span><select id="usage-company">${companyOptions('', '전체 회사')}</select></label><label class="field"><span>직원</span><select id="usage-user"><option value="">전체 직원</option>${users.map((u)=>`<option value="${u.id}" data-company="${u.company_id}">${esc(u.employee_name)} (${esc(u.login_id)})</option>`).join('')}</select></label><label class="field"><span>시작일</span><input id="usage-from" type="date" value="${year}-01-01"></label><label class="field"><span>종료일</span><input id="usage-to" type="date" value="${today()}"></label><div class="actions"><button id="usage-search" class="btn">조회</button><button id="usage-export" class="btn outline">Excel 다운로드</button></div></div></section><div id="usage-result"></div>`;
  const params=()=>{const p=new URLSearchParams({status:'APPROVED',employment:qs('#usage-employment').value}); if(qs('#usage-company').value)p.set('company_id',qs('#usage-company').value); if(qs('#usage-user').value)p.set('user_id',qs('#usage-user').value); if(qs('#usage-from').value)p.set('from',qs('#usage-from').value); if(qs('#usage-to').value)p.set('to',qs('#usage-to').value); return p;};
  let current=[]; const load=async()=>{current=await api(`/api/admin/requests?${params()}`); if (!isCurrentAdminTab('usage', tabRequestId)) return; const usageResult=qs('#usage-result'); if(!usageResult)return; const total=current.reduce((s,r)=>s+Number(r.days||0),0); usageResult.innerHTML=`<section class="card"><div class="card-header"><h3>최종승인 사용 ${current.length}건</h3><strong>합계 ${fmt(total)}일</strong></div><div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>직원</th><th>구분</th><th>기간/시간</th><th>일수</th><th>사유</th><th>자료구분</th></tr></thead><tbody>${current.map(r=>`<tr><td class="center">${esc(r.company_name)}</td><td>${esc(r.applicant_name)}</td><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td><td class="center">${requestPeriodLabel(r)}</td><td class="right strong">${fmt(r.days)}</td><td>${esc(r.reason||'-')}</td><td class="center">${r.source==='APPLICATION'?'시스템':'Excel'}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">조회 결과가 없습니다.</td></tr>'}</tbody></table></div></section>`;};
  qs('#usage-employment').onchange=load; qs('#usage-company').onchange=()=>{const cid=qs('#usage-company').value;qsa('#usage-user option').forEach(o=>{if(o.value)o.hidden=cid&&o.dataset.company!==cid;});qs('#usage-user').value='';load();}; qs('#usage-user').onchange=load;qs('#usage-search').onclick=load;qs('#usage-export').onclick=()=>{const bytes=window.LeaveExport.buildUsageXlsx({rows:current,companyName:qs('#usage-company').selectedOptions[0].text,from:qs('#usage-from').value,to:qs('#usage-to').value});downloadBytes(bytes,`연차사용현황_${today()}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');}; await load();
}

async function adminSettlementV6(tabRequestId = adminTabRequestId) {
  if (!isCurrentAdminTab('settlement', tabRequestId)) return;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  const now=today(); adminContent.innerHTML=`<section class="card"><div class="toolbar"><label class="field"><span>회사</span><select id="settle-company">${companyOptions('', '전체 회사')}</select></label><label class="field"><span>기준일</span><input id="settle-asof" type="date" value="${now}"></label><label class="check"><input id="settle-unused" type="checkbox" checked>미사용 잔여만</label><label class="check"><input id="settle-due" type="checkbox" checked>기준일까지 경과자만</label><div class="actions"><button id="settle-search" class="btn">조회</button><button id="settle-export" class="btn outline">Excel 다운로드</button></div></div></section><div class="notice"><strong>연차비 정산용</strong> · 기준일이 속한 달의 입사기념일 대상자 중 이전 1년 주기에 남은 미사용 연차를 조회합니다.</div><div id="settle-result"></div>`;
  const params=()=>{const asof=qs('#settle-asof').value||now,p=new URLSearchParams({as_of:asof,month:asof.slice(0,7)});if(qs('#settle-company').value)p.set('company_id',qs('#settle-company').value);if(qs('#settle-unused').checked)p.set('only_unused','1');if(qs('#settle-due').checked)p.set('due_only','1');return p;}; let result;
  const load=async()=>{result=await api(`/api/admin/renewals?${params()}`);if(!isCurrentAdminTab('settlement',tabRequestId))return;const settleResult=qs('#settle-result');if(!settleResult)return;const total=result.rows.reduce((s,r)=>s+Number(r.unused_expiring||0),0);settleResult.innerHTML=`<section class="card"><div class="card-header"><h3>${esc(result.month)} 정산대상 ${result.rows.length}명</h3><strong>미사용 합계 ${fmt(total)}일</strong></div><div class="table-wrap"><table class="data-table"><thead><tr><th>회사</th><th>직원</th><th>입사일</th><th>갱신일</th><th>이전주기</th><th>발생</th><th>사용</th><th>조정</th><th>잔여</th><th>미사용 정산일수</th><th>새 연차</th><th>상태</th></tr></thead><tbody>${result.rows.map(r=>`<tr><td class="center">${esc(r.company_name)}</td><td><div class="name">${esc(r.employee_name)}</div><div class="muted small-text">${esc(r.department||'-')}</div></td><td class="center">${esc(r.join_date)}</td><td class="center strong">${esc(r.anniversary_date)}</td><td class="center nowrap">${esc(r.prior_cycle_start)} ~ ${esc(r.prior_cycle_end)}</td><td class="right">${fmt(r.prior_granted)}</td><td class="right">${fmt(r.prior_used)}</td><td class="right">${fmt(r.prior_adjustments)}</td><td class="right">${fmt(r.prior_balance)}</td><td class="right strong positive">${fmt(r.unused_expiring)}</td><td class="right">${fmt(r.new_entitlement)}</td><td class="center"><span class="badge ${r.settlement_due?'green':'amber'}">${esc(r.status)}</span></td></tr>`).join('')||'<tr><td colspan="12" class="empty">대상자가 없습니다.</td></tr>'}</tbody></table></div></section>`;};
  ['#settle-company','#settle-asof','#settle-unused','#settle-due'].forEach(sel=>qs(sel).onchange=load);qs('#settle-search').onclick=load;qs('#settle-export').onclick=async()=>{const bytes=window.LeaveExport.buildRenewalXlsx({rows:result.rows,companyName:result.company_name,month:result.month,asOf:result.as_of});downloadBytes(bytes,`${result.company_name}_${result.month}_미사용연차정산.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');};await load();
}

async function adminExcelV6(tabRequestId = adminTabRequestId) {
  if (!isCurrentAdminTab('excel', tabRequestId)) return;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  adminContent.innerHTML=`<div class="grid cols-2"><section class="card"><h3>Excel 다운로드</h3><label class="field"><span>회사</span><select id="excel-company">${companyOptions('', '전체 회사')}</select></label><label class="field"><span>직원 범위</span><select id="excel-employment"><option value="all">전체</option><option value="current">재직자</option><option value="retired">퇴사일 등록자</option></select></label><div class="actions" style="margin-top:14px"><button id="excel-full" class="btn">전체 관리자료 Excel</button><button id="excel-template" class="btn outline">업로드 표준양식</button></div></section><section class="card"><h3>Excel 업로드</h3><div class="notice">표준양식의 <strong>직원등록</strong>, <strong>사용내역등록</strong> 시트를 사용하세요. 기존 로그인 ID가 있으면 직원정보를 갱신합니다.</div><input id="excel-file" type="file" accept=".xlsx"><button id="excel-upload" class="btn" style="margin-top:12px">Excel 업로드</button><div id="excel-upload-result" class="muted small-text" style="margin-top:10px"></div></section></div><div class="grid cols-2"><section class="card"><h3>자료 백업</h3><p class="muted">Netlify Blobs의 모든 운영자료를 JSON으로 내려받습니다.</p><button id="backup-json" class="btn outline">JSON 백업 다운로드</button><button id="reset-initial" class="btn red" style="margin-top:12px">디엔엠 초기자료 재설정</button><p class="muted small-text" style="margin-top:8px">기존 Netlify 사이트에 배포한 경우 이전 회사 데이터가 남아 있으면 초기자료 재설정을 실행하세요.</p></section><section class="card"><h3>백업 복원</h3><p class="muted">이 시스템에서 받은 JSON 백업파일만 사용하세요. 복원 전 현재자료를 먼저 백업하는 것을 권장합니다.</p><input id="restore-file" type="file" accept=".json"><button id="restore-json" class="btn red" style="margin-top:12px">백업자료 복원</button></section></div>`;
  qs('#excel-full').onclick=()=>downloadFullExport(qs('#excel-company').value, qs('#excel-employment').value);const resetBtn=qs('#reset-initial');if(resetBtn)resetBtn.onclick=async()=>{if(!confirm('현재 운영자료를 디엔엠 근로자명부 초기자료로 교체하시겠습니까?\n복원 전 JSON 백업을 권장합니다.'))return;try{const r=await api('/api/admin/reset-initial',{method:'POST'});toast(`초기자료로 재설정되었습니다. 직원 ${r.employee_count}명`);await api('/api/logout',{method:'POST'});me=null;renderLogin();}catch(e){toast(e.message,'error');}};qs('#excel-template').onclick=()=>{const bytes=window.LeaveExport.buildUploadTemplateXlsx({companies});downloadBytes(bytes,'연차관리_Excel업로드_표준양식.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');};qs('#backup-json').onclick=()=>{window.location.href='/api/admin/backup.json';};
  qs('#excel-upload').onclick=async()=>{const file=qs('#excel-file').files[0];if(!file)return toast('Excel 파일을 선택해 주세요.','error');const fd=new FormData();fd.append('file',file);const btn=qs('#excel-upload');btn.disabled=true;try{const res=await fetch('/api/admin/import-excel',{method:'POST',body:fd,credentials:'same-origin'});const data=await res.json();if(!res.ok)throw new Error(data.error||'업로드 실패');if(!isCurrentAdminTab('excel',tabRequestId))return;const resultEl=qs('#excel-upload-result');if(resultEl)resultEl.innerHTML=`신규 직원 ${data.users_created}명 · 수정 ${data.users_updated}명 · 사용내역 ${data.usage_created}건${data.errors.length?`<br><span class="negative">확인필요 ${esc(data.errors.slice(0,10).join(' / '))}</span>`:''}`;toast('Excel 업로드를 완료했습니다.');}catch(e){toast(e.message,'error');}finally{btn.disabled=false;}};
  qs('#restore-json').onclick=async()=>{const file=qs('#restore-file').files[0];if(!file)return toast('백업 JSON 파일을 선택해 주세요.','error');if(!confirm('현재 운영자료를 백업파일의 내용으로 교체하시겠습니까?'))return;try{const state=JSON.parse(await file.text());await api('/api/admin/restore',{method:'POST',body:{state}});toast('복원되었습니다. 다시 로그인합니다.');await api('/api/logout',{method:'POST'});me=null;renderLogin();}catch(e){toast(e.message,'error');}};
}

async function adminStandardsV6(tabRequestId = adminTabRequestId) {
  if (!isCurrentAdminTab('standards', tabRequestId)) return;
  const adminContent = qs('#admin-content');
  if (!adminContent) return;
  const firstCompany=companies.find(c=>c.active)?.id||''; adminContent.innerHTML=`<div class="grid cols-2"><section class="card"><h3>근무시간 기준정보</h3><label class="field"><span>회사</span><select id="std-company">${companyOptions(firstCompany)}</select></label><div class="grid cols-2" style="margin-top:14px"><label class="field"><span>근무 시작</span><input id="std-work-start" type="time"></label><label class="field"><span>점심 시작</span><input id="std-lunch-start" type="time"></label><label class="field"><span>점심 종료</span><input id="std-lunch-end" type="time"></label><label class="field"><span>근무 종료</span><input id="std-work-end" type="time"></label></div><button id="std-save" class="btn" style="margin-top:14px">근무시간 저장</button><div class="notice" style="margin-top:14px">오전 반차 = 근무시작~점심시작, 오후 반차 = 점심종료~근무종료로 자동 계산합니다.</div></section><section class="card"><h3>추가 휴일 등록</h3><label class="field"><span>적용범위</span><select id="holiday-company"><option value="">전체 회사 공통</option>${companyOptions('')}</select></label><div class="grid cols-2" style="margin-top:14px"><label class="field"><span>휴일 날짜</span><input id="holiday-date" type="date"></label><label class="field"><span>휴일명</span><input id="holiday-name" placeholder="예: 창립기념일"></label></div><button id="holiday-add" class="btn" style="margin-top:14px">추가 휴일 등록</button><div class="notice warning" style="margin-top:14px">국가공휴일·대체공휴일은 자동 반영합니다. 임시공휴일·회사휴일 등 달력에 없는 날만 추가하세요.</div></section></div><section class="card"><div class="toolbar"><label class="field"><span>휴일 조회 연도</span><input id="holiday-year" type="number" min="2020" max="2100" value="${today().slice(0,4)}"></label><label class="field"><span>회사</span><select id="holiday-view-company">${companyOptions(firstCompany)}</select></label><button id="holiday-search" class="btn outline">조회</button></div><div id="holiday-list" style="margin-top:14px"></div></section>`;
  const loadSettings=async()=>{const company=qs('#std-company');if(!company)return;const w=await api(`/api/admin/work-settings?company_id=${company.value}`);if(!isCurrentAdminTab('standards',tabRequestId))return;const workStart=qs('#std-work-start'),lunchStart=qs('#std-lunch-start'),lunchEnd=qs('#std-lunch-end'),workEnd=qs('#std-work-end');if(!workStart||!lunchStart||!lunchEnd||!workEnd)return;workStart.value=w.work_start;lunchStart.value=w.lunch_start;lunchEnd.value=w.lunch_end;workEnd.value=w.work_end;};
  const loadHolidays=async()=>{const yearEl=qs('#holiday-year'),companyEl=qs('#holiday-view-company');if(!yearEl||!companyEl)return;const res=await api(`/api/admin/holidays?year=${yearEl.value}&company_id=${companyEl.value}`);if(!isCurrentAdminTab('standards',tabRequestId))return;const holidayList=qs('#holiday-list');if(!holidayList)return;holidayList.innerHTML=`<div class="holiday-grid">${res.rows.map(h=>`<div class="holiday-item"><div><strong>${esc(h.date)}</strong> ${esc(h.name)}<div class="muted small-text">${esc(h.source)}</div></div>${h.custom_id?`<button class="btn red small delete-holiday" data-id="${h.custom_id}">삭제</button>`:''}</div>`).join('')}</div>`;qsa('.delete-holiday').forEach(b=>b.onclick=async()=>{if(!confirm('이 추가휴일을 삭제하시겠습니까?'))return;await api(`/api/admin/holidays/${b.dataset.id}`,{method:'DELETE'});toast('추가휴일을 삭제했습니다.');loadHolidays();});};
  qs('#std-company').onchange=loadSettings;qs('#std-save').onclick=async()=>{try{await api('/api/admin/work-settings',{method:'PUT',body:{company_id:qs('#std-company').value,work_start:qs('#std-work-start').value,lunch_start:qs('#std-lunch-start').value,lunch_end:qs('#std-lunch-end').value,work_end:qs('#std-work-end').value}});toast('근무시간 기준을 저장했습니다.');}catch(e){toast(e.message,'error');}};qs('#holiday-add').onclick=async()=>{try{await api('/api/admin/holidays',{method:'POST',body:{company_id:qs('#holiday-company').value,date:qs('#holiday-date').value,name:qs('#holiday-name').value}});toast('추가휴일을 등록했습니다.');qs('#holiday-name').value='';loadHolidays();}catch(e){toast(e.message,'error');}};qs('#holiday-search').onclick=loadHolidays;qs('#holiday-view-company').onchange=loadHolidays;await loadSettings();await loadHolidays();
}


// ===== v8.0 DNM 전자결재 다단계 승인 UI + 안전한 페이지 전환 =====
function roleTypeV7(user) {
  if (user.is_admin) return 'ADMIN';
  if (user.is_representative) return 'REPRESENTATIVE';
  if (user.can_approve_first) return 'APPROVER';
  return 'EMPLOYEE';
}

function approvalLineHtml(row, compact = false) {
  const steps = row.approval_line || [];
  if (!steps.length) return row.source === 'APPLICATION' ? '<span class="muted">승인라인 없음</span>' : '<span class="muted">기존 Excel 승인완료 자료</span>';
  return `<div class="approval-line ${compact ? 'compact' : ''}">${steps.map((step, index) => {
    const color = step.status === 'APPROVED' ? 'green' : step.status === 'REJECTED' ? 'red' : step.status === 'PENDING' ? 'blue' : 'gray';
    const role = step.role === 'REPRESENTATIVE' ? '최종' : `${index + 1}차`; 
    return `<div class="approval-step ${step.status === 'PENDING' ? 'current' : ''}">
      <div class="approval-step-head"><span class="approval-order">${role}</span><strong>${esc(step.approver_name || step.approver_login || '-')}</strong><span class="badge ${color}">${esc(step.status_label || step.status)}</span></div>
      ${!compact ? `<div class="muted small-text">${esc(step.department || '')}${step.position ? ` · ${esc(step.position)}` : ''}${step.action_at ? ` · ${esc(step.action_at)}` : ''}</div>${step.comment ? `<div class="negative small-text">반려사유: ${esc(step.comment)}</div>` : ''}` : ''}
    </div>`;
  }).join('<span class="approval-arrow">→</span>')}</div>`;
}

function helpContentV7() {
  const common = '<div class="notice">현재 로그인 역할에 따라 필요한 메뉴만 표시됩니다. 화면의 저장·조회 버튼을 누른 뒤 안내 메시지를 확인하세요.</div>';
  if (currentPage === 'apply') return `${common}<div class="help-steps"><div class="help-step"><strong>승인라인 구성</strong><div class="muted">관리자가 사원정보에서 “연차 승인자”로 체크한 직원만 목록에 나타납니다. 1명 이상 추가하고 위/아래 버튼으로 순서를 정하며, 마지막 결재자가 최종 결정권자가 됩니다.</div></div><div class="help-step"><strong>순차 승인</strong><div class="muted">1차 → 2차 → 최종 순서대로 처리되며 앞 결재자가 승인해야 다음 결재자에게 표시됩니다.</div></div><div class="help-step"><strong>최종 결재</strong><div class="muted">대표이사 자동지정 없이 신청자가 선택한 결재라인의 마지막 사람이 최종 결재자가 됩니다.</div></div></div>`;
  if (currentPage === 'approvalPending') return `${common}<div class="help-steps"><div class="help-step"><strong>승인대기</strong><div class="muted">현재 순서가 본인에게 도착한 신청만 표시됩니다. 승인 또는 반려를 처리하면 다음 승인자에게 자동으로 넘어갑니다.</div></div><div class="help-step"><strong>반려</strong><div class="muted">반려 사유는 필수이며 이후 승인라인은 진행되지 않습니다.</div></div></div>`;
  if (currentPage === 'approvalHistory') return `${common}<div class="notice success"><strong>본인이 직접 처리한 승인·반려 내역만 조회합니다.</strong> 처리시간과 전체 승인라인을 함께 확인할 수 있습니다.</div>`;
  if (currentPage === 'admin') return `${common}<div class="help-steps"><div class="help-step"><strong>연차 승인자 지정</strong><div class="muted">사용자 관리 → 직원 수정 → “연차 승인자” 체크 후 저장합니다.</div></div><div class="help-step"><strong>대표이사/관리자</strong><div class="muted">대표이사는 관리자와 동일하게 전체 직원현황, 결재, 기준정보를 관리할 수 있습니다.</div></div><div class="help-step"><strong>관리·백업</strong><div class="muted">대표이사와 관리자는 전체 직원현황, 승인·신청내역, 회사별 사용현황, 미사용 정산, Excel·백업 메뉴를 사용할 수 있습니다.</div></div></div>`;
  if (currentPage === 'history') return `${common}<div class="notice">나의 신청별 승인라인에서 어느 승인자까지 처리되었는지 실시간으로 확인할 수 있습니다.</div>`;
  return `${common}<div class="help-steps"><div class="help-step"><strong>직원</strong><div class="muted">대시보드 · 연차신청 · 나의 사용내역 · 비밀번호 변경</div></div><div class="help-step"><strong>승인자</strong><div class="muted">직원 메뉴 + 승인대기 · 처리내역</div></div><div class="help-step"><strong>대표이사</strong><div class="muted">전체 관리현황 + 결재대기 · 처리내역 · 비밀번호 변경</div></div><div class="help-step"><strong>관리자</strong><div class="muted">전체 직원·기준정보·Excel·백업 등 시스템 관리 메뉴</div></div></div>`;
}
function showHelpV7() { openModal('현재 페이지 사용방법', helpContentV7()); }

async function renderShellV7() {
  me = await api('/api/me');
  const role = roleTypeV7(me);
  companies = me.can_manage ? await api('/api/companies') : [];
  let navItems = [];
  if (role === 'ADMIN') {
    navItems = [['dashboard', '⌂', '관리자 대시보드'], ['admin', '⚙', '관리자 메뉴']];
    if (me.can_approve_first) navItems.push(['approvalPending', '✓', '승인대기'], ['approvalHistory', '▤', '처리내역']);
  } else if (role === 'REPRESENTATIVE') {
    navItems = [['dashboard', '⌂', '대표이사 대시보드'], ['approvalPending', '✓', '최종 결재대기'], ['approvalHistory', '▤', '결재 처리내역'], ['admin', '⚙', '관리현황']];
  } else if (role === 'APPROVER') {
    navItems = [['dashboard', '⌂', '대시보드'], ['apply', '✎', '연차 신청'], ['history', '▤', '나의 사용내역'], ['approvalPending', '✓', '승인대기'], ['approvalHistory', '▤', '처리내역']];
  } else {
    navItems = [['dashboard', '⌂', '대시보드'], ['apply', '✎', '연차 신청'], ['history', '▤', '나의 사용내역']];
  }
  navItems.push(['password', '●', '비밀번호 변경']);
  app.innerHTML = `
    <header class="app-header"><div class="header-inner">
      <div class="brand"><div class="brand-mark">연</div><div><h1>디엔엠 연차관리</h1><small>(주)디엔엠 · v8.0 DNM</small></div></div>
      <div class="user-box"><div class="user-meta"><strong>${esc(me.employee_name)}</strong><span>${esc(me.company_name)} · ${esc(me.login_id)} · ${esc(me.role_label)}</span></div><button id="help-button" class="btn outline small">Help</button><button id="logout" class="btn outline small">로그아웃</button></div>
    </div></header>
    <div class="layout"><aside class="sidebar"><nav class="nav-card">${navItems.map(([key, icon, label]) => `<button class="nav-button" data-page="${key}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}</nav></aside><main class="content"><div id="page"></div></main></div>`;
  qs('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; renderLogin(); };
  qs('#help-button').onclick = showHelpV7;
  qsa('.nav-button').forEach((button) => { button.onclick = () => goV7(button.dataset.page); });
  const allowed = new Set(navItems.map((x) => x[0]));
  await goV7(allowed.has(currentPage) ? currentPage : 'dashboard');
}

async function goV7(page) {
  currentPage = page;
  const requestId = ++pageRequestId;
  qsa('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const handlers = {
    dashboard: dashboardPageV7, apply: applyPageV7, history: historyPageV7,
    approvalPending: approvalPendingPageV7, approvalHistory: approvalHistoryPageV7,
    admin: adminPageV6, password: passwordPage
  };
  loading();
  try {
    await handlers[page]?.(requestId);
  } catch (error) {
    if (!isCurrentPage(page, requestId)) return;
    const pageEl = qs('#page');
    if (pageEl) pageEl.innerHTML = `<div class="notice danger">${esc(error.message)}</div>`;
  }
}

async function dashboardPageV7(requestId = pageRequestId) {
  await refreshMe();
  if (!isCurrentPage('dashboard', requestId)) return;
  if (me.can_manage) return adminDashboardPage(requestId);
  return dashboardPageV6(requestId, true);
}

async function applyPageV7(requestId = pageRequestId) {
  if (!isCurrentPage('apply', requestId)) return;
  if (me.is_system_account) {
    qs('#page').innerHTML = `${pageTitle('연차 신청', '관리자 전용 계정은 연차를 신청하지 않습니다.')}<div class="notice warning">직원 본인 계정으로 로그인해 주세요.</div>`;
    return;
  }
  const approvers = await api('/api/approvers');
  if (!isCurrentPage('apply', requestId)) return;
  const noApprover = !approvers.first.length;
  const selectedApprovers = [];
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `
    ${pageTitle('연차 신청', '반차·하루·기간을 선택하고 전자결재 방식의 승인라인을 구성합니다.')}
    ${noApprover ? '<div class="notice danger"><strong>승인자가 등록되지 않았습니다.</strong> 관리자 → 사용자 관리에서 실제 사원에게 “연차 승인자”를 체크해 주세요.</div>' : ''}
    <section class="card mobile-apply"><form id="leave-form">
      <label class="field"><span>신청 구분</span><div class="leave-type-pills"><label><input type="radio" name="leave-type-radio" value="FULL" checked><span>하루 / 기간</span></label><label><input type="radio" name="leave-type-radio" value="AM_HALF"><span>오전 반차</span></label><label><input type="radio" name="leave-type-radio" value="PM_HALF"><span>오후 반차</span></label></div></label>
      <div class="grid cols-2 date-grid"><label class="field"><span>시작일</span><input id="start-date" type="date" min="${today()}" required></label><label class="field" id="end-field"><span>종료일</span><input id="end-date" type="date" min="${today()}" required></label></div>
      <div id="day-preview" class="calc-preview">날짜를 계산하는 중입니다.</div>
      <section class="approval-builder">
        <div class="card-header"><div><h3>승인라인</h3><div class="muted small-text">결재자 1명 이상을 추가하세요. 마지막 결재자가 최종 결정권자입니다.</div></div></div>
        <div class="approval-add-row"><select id="approver-picker"><option value="">결재자 선택</option>${approvers.first.map((a) => `<option value="${a.id}">${esc(a.employee_name)} · ${esc(a.department || '-')} · ${esc(a.position || '-')}</option>`).join('')}</select><button id="add-approver" type="button" class="btn outline">결재자 추가</button></div>
        <div id="approval-builder-list"></div>
      </section>
      <label class="field" style="margin-top:14px"><span>신청 사유</span><textarea id="leave-reason" placeholder="간단한 사유 또는 업무 인수인계 사항"></textarea></label>
      <button class="btn mobile-submit" type="submit" ${noApprover ? 'disabled' : ''}>승인 요청</button>
    </form></section>
    <div class="notice warning"><strong>잔여 ${fmt(me.remaining)}일이어도 신청 가능합니다.</strong> 토·일요일, 국가공휴일·대체공휴일 및 추가휴일은 기간 일수에서 자동 제외됩니다.</div>`;

  const renderApprovalBuilder = () => {
    const reps = selectedApprovers.map((id) => approvers.first.find((a) => a.id === id)).filter(Boolean);
    qs('#approval-builder-list').innerHTML = `<div class="approval-builder-list">
      ${reps.map((a, index) => {
        const isLast = index === reps.length - 1;
        const label = isLast ? '최종' : `${index + 1}차`;
        const badge = isLast ? '<span class="badge green">최종결재자</span>' : '<span class="badge blue">순차결재</span>';
        return `<div class="approval-builder-item"><div><span class="approval-order">${label}</span><strong>${esc(a.employee_name)}</strong>${badge}<span class="muted small-text">${esc(a.department || '')} ${esc(a.position || '')}</span></div><div class="actions"><button type="button" class="btn secondary small move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn secondary small move-down" data-index="${index}" ${index === reps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn red small remove-approver" data-index="${index}">삭제</button></div></div>`;
      }).join('') || '<div class="notice warning">결재자를 1명 이상 선택하세요. 마지막 결재자가 최종 결정권자입니다.</div>'}
    </div>`;
    qsa('.remove-approver').forEach((b) => b.onclick = () => { selectedApprovers.splice(Number(b.dataset.index), 1); renderApprovalBuilder(); });
    qsa('.move-up').forEach((b) => b.onclick = () => { const i = Number(b.dataset.index); [selectedApprovers[i - 1], selectedApprovers[i]] = [selectedApprovers[i], selectedApprovers[i - 1]]; renderApprovalBuilder(); });
    qsa('.move-down').forEach((b) => b.onclick = () => { const i = Number(b.dataset.index); [selectedApprovers[i + 1], selectedApprovers[i]] = [selectedApprovers[i], selectedApprovers[i + 1]]; renderApprovalBuilder(); });
  };
  qs('#add-approver').onclick = () => {
    const id = Number(qs('#approver-picker').value);
    if (!id) return toast('추가할 결재자를 선택해 주세요.', 'error');
    if (selectedApprovers.includes(id)) return toast('이미 결재라인에 추가된 결재자입니다.', 'error');
    selectedApprovers.push(id); qs('#approver-picker').value = ''; renderApprovalBuilder();
  };
  renderApprovalBuilder();

  const start = qs('#start-date'), end = qs('#end-date'), preview = qs('#day-preview'); start.value = today(); end.value = today();
  const selectedType = () => qs('input[name="leave-type-radio"]:checked').value;
  let calcTimer;
  const update = () => {
    clearTimeout(calcTimer); const type = selectedType(); const half = type !== 'FULL'; qs('#end-field').style.display = half ? 'none' : ''; end.disabled = half; if (half) end.value = start.value;
    calcTimer = setTimeout(async () => {
      if (!start.value || !end.value) return;
      preview.innerHTML = '<span class="spinner mini"></span> 자동 계산 중';
      try {
        const calc = await api('/api/calculate-leave', { method: 'POST', body: { leave_type: type, start_date: start.value, end_date: end.value } });
        const excluded = calc.excluded_dates?.length ? `<div class="excluded-list">제외: ${calc.excluded_dates.map((x) => `${esc(x.date)} ${esc(x.reason)}`).join(', ')}</div>` : '';
        preview.innerHTML = `<strong>${fmt(calc.days)}일</strong> · ${esc(calc.start_time)} ~ ${esc(calc.end_time)}${excluded}`;
      } catch (e) { preview.innerHTML = `<span class="negative">${esc(e.message)}</span>`; }
    }, 180);
  };
  qsa('input[name="leave-type-radio"]').forEach((el) => el.onchange = update); [start, end].forEach((el) => el.onchange = update); update();

  qs('#leave-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!selectedApprovers.length) return toast('결재자를 1명 이상 추가해 주세요.', 'error');
    const submit = qs('button[type=submit]', event.currentTarget); submit.disabled = true;
    try {
      const result = await api('/api/leave-requests', { method: 'POST', body: { leave_type: selectedType(), start_date: start.value, end_date: end.value, approver_ids: selectedApprovers, reason: qs('#leave-reason').value } });
      toast(`${fmt(result.days)}일 연차가 신청되었습니다.`); await refreshMe(); goV7('history');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  };
}

async function historyPageV7(requestId = pageRequestId) {
  await refreshMe();
  if (!isCurrentPage('history', requestId)) return;
  const rows = await api('/api/my-requests');
  if (!isCurrentPage('history', requestId)) return;
  const years = [...new Set(rows.map((r) => r.start_date?.slice(0, 4)).filter(Boolean))].sort().reverse();
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `${pageTitle('나의 사용내역', '신청별 승인 진행상태와 기존 Excel 사용자료를 함께 확인합니다.')}<div class="notice success"><strong>누적 최종승인 사용 ${fmt(me.total_used)}일</strong> · 기존 Excel 사용일수도 포함됩니다.</div><section class="card"><div class="toolbar"><label class="field"><span>연도</span><select id="history-year"><option value="">전체</option>${years.map((y) => `<option>${y}</option>`).join('')}</select></label><label class="field"><span>상태</span><select id="history-status"><option value="">전체</option><option value="APPROVED">최종승인</option><option value="PENDING">승인대기</option><option value="REJECTED">반려·취소</option></select></label></div></section><div id="history-table"></div>`;
  const render = () => {
    const year = qs('#history-year').value, filterStatus = qs('#history-status').value;
    const filtered = rows.filter((r) => {
      if (year && !r.start_date.startsWith(year)) return false;
      const state = r.approval_state || (statusInfo(r)[0] === '최종승인' ? 'APPROVED' : 'PENDING');
      if (filterStatus === 'APPROVED' && state !== 'APPROVED') return false;
      if (filterStatus === 'PENDING' && state !== 'PENDING') return false;
      if (filterStatus === 'REJECTED' && !['REJECTED', 'CANCELLED'].includes(state)) return false;
      return true;
    });
    qs('#history-table').innerHTML = `<section class="card"><div class="card-header"><h3>총 ${filtered.length}건</h3></div><div class="table-wrap desktop-table"><table class="data-table"><thead><tr><th>구분</th><th>기간/시간</th><th>일수</th><th>승인라인</th><th>상태</th><th>사유</th><th>처리</th></tr></thead><tbody>${filtered.map((r) => {
      const [label, color] = statusInfo(r); const cancellable = r.source === 'APPLICATION' && !['APPROVED', 'REJECTED', 'CANCELLED'].includes(r.approval_state);
      return `<tr><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td><td class="center">${requestPeriodLabel(r)}</td><td class="right strong">${fmt(r.days)}</td><td>${approvalLineHtml(r, true)}</td><td class="center"><span class="badge ${color}">${esc(label)}</span>${r.reject_reason ? `<div class="negative small-text">${esc(r.reject_reason)}</div>` : ''}</td><td>${esc(r.reason || '-')}</td><td class="center">${cancellable ? `<button class="btn red small cancel-request" data-id="${r.id}">취소</button>` : '-'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">내역이 없습니다.</td></tr>'}</tbody></table></div><div class="mobile-list">${filtered.map((r) => { const [label,color]=statusInfo(r); return `<article class="mobile-record"><div class="record-head"><strong>${esc(leaveTypeLabel(r.leave_type))}</strong><span class="badge ${color}">${esc(label)}</span></div><div>${requestPeriodLabel(r)} · <strong>${fmt(r.days)}일</strong></div>${approvalLineHtml(r,true)}<div class="muted small-text">${esc(r.reason||'-')}</div></article>`; }).join('')}</div></section>`;
    qsa('.cancel-request').forEach((button) => { button.onclick = async () => { if (!confirm('이 연차 신청을 취소하시겠습니까?')) return; try { await api(`/api/requests/${button.dataset.id}/cancel`, { method: 'POST' }); toast('신청이 취소되었습니다.'); historyPageV7(); } catch (e) { toast(e.message, 'error'); } }; });
  };
  qs('#history-year').onchange = render; qs('#history-status').onchange = render; render();
}

async function approvalPendingPageV7(requestId = pageRequestId) {
  const rows = await api('/api/inbox');
  if (!isCurrentPage('approvalPending', requestId)) return;
  const cards = rows.map((r) => {
    const isFinal = r.stage === 'REPRESENTATIVE';
    const label = isFinal ? '최종 결재' : `${r.stage_order}차 결재`;
    return `<article class="approval-card"><div class="record-head"><span class="badge ${isFinal ? 'green' : 'blue'}">${label}</span><strong>${esc(r.applicant_name)}</strong></div><div class="approval-type">${esc(leaveTypeLabel(r.leave_type))} · ${fmt(r.days)}일</div><div>${requestPeriodLabel(r)}</div><div class="muted">${esc(r.reason || '-')}</div>${approvalLineHtml(r)}<div class="approval-actions"><button class="btn green approve" data-id="${r.id}">승인</button><button class="btn red reject" data-id="${r.id}">반려</button></div></article>`;
  }).join('');
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `${pageTitle('결재대기', '현재 결재순서가 본인에게 도착한 신청만 표시됩니다.')}<section class="card"><div class="card-header"><h3>처리 대기 ${rows.length}건</h3></div><div class="approval-grid">${cards || '<div class="empty">현재 처리할 신청이 없습니다.</div>'}</div></section>`;
  qsa('.approve').forEach((button) => { button.onclick = async () => { if (!confirm('이 신청을 승인하시겠습니까?')) return; try { await api(`/api/requests/${button.dataset.id}/action`, { method: 'POST', body: { action: 'approve' } }); toast('승인 처리되었습니다.'); approvalPendingPageV7(); } catch (e) { toast(e.message, 'error'); } }; });
  qsa('.reject').forEach((button) => { button.onclick = () => { openModal('연차 신청 반려', '<label class="field"><span>반려 사유</span><textarea id="reject-reason" placeholder="반려 사유를 반드시 입력하세요."></textarea></label>', '<button class="btn secondary modal-cancel">취소</button><button id="confirm-reject" class="btn red">반려 처리</button>'); qs('#confirm-reject', modal).onclick = async () => { try { await api(`/api/requests/${button.dataset.id}/action`, { method: 'POST', body: { action: 'reject', reason: qs('#reject-reason', modal).value } }); modal.close(); toast('반려 처리되었습니다.'); approvalPendingPageV7(); } catch (e) { toast(e.message, 'error'); } }; }; });
}

async function approvalHistoryPageV7(requestId = pageRequestId) {
  const rows = await api('/api/inbox/history');
  if (!isCurrentPage('approvalHistory', requestId)) return;
  const pageEl = qs('#page');
  if (!pageEl) return;
  pageEl.innerHTML = `${pageTitle('나의 결재 처리내역', '본인이 직접 승인 또는 반려한 내역을 확인합니다.')}<section class="card"><div class="card-header"><h3>처리내역 ${rows.length}건</h3></div><div class="table-wrap desktop-table"><table class="data-table"><thead><tr><th>처리일시</th><th>신청자</th><th>구분</th><th>기간</th><th>일수</th><th>내 처리</th><th>전체 승인라인</th><th>사유</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="center">${esc(r.my_action_at || '-')}</td><td>${esc(r.applicant_name)}</td><td class="center">${esc(leaveTypeLabel(r.leave_type))}</td><td class="center">${requestPeriodLabel(r)}</td><td class="right strong">${fmt(r.days)}</td><td class="center"><span class="badge ${r.my_action === 'APPROVED' ? 'green' : 'red'}">${r.my_action === 'APPROVED' ? '승인' : '반려'}</span>${r.my_comment ? `<div class="negative small-text">${esc(r.my_comment)}</div>` : ''}</td><td>${approvalLineHtml(r,true)}</td><td>${esc(r.reason || '-')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">처리한 승인내역이 없습니다.</td></tr>'}</tbody></table></div><div class="mobile-list">${rows.map((r)=>`<article class="mobile-record"><div class="record-head"><strong>${esc(r.applicant_name)}</strong><span class="badge ${r.my_action==='APPROVED'?'green':'red'}">${r.my_action==='APPROVED'?'승인':'반려'}</span></div><div>${requestPeriodLabel(r)} · ${fmt(r.days)}일</div><div class="muted small-text">${esc(r.my_action_at||'')}</div>${approvalLineHtml(r,true)}</article>`).join('')}</div></section>`;
}


(async () => {
  try { me = await api('/api/me'); await renderShellV7(); }
  catch { await renderLogin(); }
})();
