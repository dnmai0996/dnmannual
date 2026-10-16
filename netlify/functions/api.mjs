import { getStore } from '@netlify/blobs';
import Holidays from 'date-holidays';
import ExcelJS from 'exceljs';
import { comparePeople, sortPeople } from '../../public/org-sort.js';
import { INITIAL_STATE } from './_lib/initial-state.js';
import { ROSTER_2026 } from './_lib/roster-2026.js';
import { DAY_MINUTES, parts, minutesFromParts, normalizeCharge, requestMinutesInRange, sumRequests, sumAdjustments, cycleBalance, cycleHistory, basisDate } from './_lib/balance.js';
import { ROSTER_FIELDS, parseRosterWorkbook, matchEmployee, importChanges, auditStaff } from './_lib/roster.js';
import {
  parseIso, todayIsoKst, addDays, cumulativeGranted, currentEntitlement, serviceCycle,
  anniversaryInYear, priorCycleForAnniversary, tenureLabel, countBusinessDays,
  normalizeLoginBase, roundHalf
} from './_lib/leave.js';

const SESSION_SECONDS = 10 * 60 * 60;
const DEFAULT_HASH = 'pbkdf2$100000$7a8e927109f2b5d4c8a18fd3418f9352$fcfbf0d30d90aefca3e450e6bee44a9e50b9e5f364e105d80db5b69b98d3a5ac';
const ADMIN_HASH_0996 = 'pbkdf2$100000$4d47c197f9d5488c9daaa3960e20b273$4e3110edeabe1590d55a8ef78dea96877c6225d0f1e7c206e207f80a66cf20d5';
const DEFAULT_WORK = { work_start: '08:30', lunch_start: '12:30', lunch_end: '13:30', work_end: '17:30' };
const SCHEMA_VERSION = 11;
const APP_VERSION = '8.3.0-dnm';
const SYSTEM_ADMIN_LOGIN = 'admin';
const REPRESENTATIVE_LOGIN = '대표이사';
const RESERVED_LOGINS = new Set(['admin', '통합관리자', '관리자', '대표이사', '대표자']);
const enc = new TextEncoder();
const krHolidays = new Holidays('KR');
try { krHolidays.setLanguages('ko'); } catch { /* package fallback language */ }

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const cleanText = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const boolValue = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === '예' || v === 'Y';
const numberId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const nowIso = () => new Date().toISOString();
const matchPath = (pathname, pattern) => { const m = pattern.exec(pathname); return m ? m.slice(1).map(decodeURIComponent) : null; };

function hex(bytes) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out; }
function randomHex(bytes = 32) { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return hex(b); }
async function passwordHash(password, saltHex = null, iterations = 100000) {
  if (String(password) === '1111' && !saltHex) return DEFAULT_HASH;
  if (String(password) === '0996' && !saltHex) return ADMIN_HASH_0996;
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${iterations}$${hex(salt)}$${hex(bits)}`;
}
async function verifyPassword(password, encoded) {
  try {
    const [scheme, it, saltHex, hashHex] = String(encoded || '').split('$');
    if (scheme !== 'pbkdf2') return false;
    const actual = await passwordHash(password, saltHex, Number(it));
    const a = fromHex(actual.split('$')[3]); const b = fromHex(hashHex);
    if (a.length !== b.length) return false;
    let diff = 0; for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
function fileResponse(bytes, type, filename) {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="leave-manager"; filename*=UTF-8''${encodeURIComponent(filename)}` } });
}
function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return '';
}
function validTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')); }

function timeToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function minutesToTime(minutes) {
  const value = Math.max(0, Math.min(24 * 60, Number(minutes) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
function isThirtyMinuteTime(value) {
  const minutes = timeToMinutes(value);
  return minutes != null && minutes % 30 === 0;
}
function roundLeaveDays(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000; }
function roundHours(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10; }
function workMinutesPerDay(settings = DEFAULT_WORK) {
  const start = timeToMinutes(settings.work_start), lunchStart = timeToMinutes(settings.lunch_start), lunchEnd = timeToMinutes(settings.lunch_end), end = timeToMinutes(settings.work_end);
  if ([start, lunchStart, lunchEnd, end].some((v) => v == null) || !(start < lunchStart && lunchStart <= lunchEnd && lunchEnd < end)) return 8 * 60;
  return Math.max(30, (lunchStart - start) + (end - lunchEnd));
}
function parseLocalDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match || !parseIso(match[1])) return null;
  return { raw: `${match[1]}T${match[2]}:${match[3]}`, date: match[1], time: `${match[2]}:${match[3]}`, minutes: Number(match[2]) * 60 + Number(match[3]) };
}
function cmpDateTime(a, b) { return String(a || '').localeCompare(String(b || '')); }
function requestHoursFromDays(s, userId, days) {
  const u = userById(s, userId);
  const settings = getWorkSettings(s, u?.company_id);
  return roundHours(Number(days || 0) * workMinutesPerDay(settings) / 60);
}

function loginKey(v) { return cleanText(v, 80).normalize('NFKC'); }
function hasRetireDate(u) { return Boolean(parseIso(cleanText(u?.retire_date, 10))); }
function isRetiredAsOf(u, asOf = todayIsoKst()) { const d = cleanText(u?.retire_date, 10); return Boolean(parseIso(d) && d <= asOf); }
function employmentMatches(u, mode = 'current') { if (u?.is_system_account) return true; const has = hasRetireDate(u); if (mode === 'all') return true; if (mode === 'retired') return has; return !has; }
function userAvailable(u, asOf = todayIsoKst()) { return Boolean(u && !u.deleted && u.active && !isRetiredAsOf(u, asOf)); }

function approvalStatusLabel(status) {
  return ({ PENDING: '승인대기', WAITING: '순서대기', APPROVED: '승인', REJECTED: '반려', CANCELLED: '취소' })[status] || status || '';
}
function ensureSystemAccounts(s,t=nowIso()) {
  s.counters ||= {};
  let admin=s.users.find(u=>u.is_system_account&&u.login_id===SYSTEM_ADMIN_LOGIN&&!u.deleted);
  if(!admin) {
    const id=Math.max(Number(s.counters.user||1),...s.users.map(x=>Number(x.id)+1));s.counters.user=id+1;
    admin={id,company_id:null,employee_name:'관리자',employee_code:'',login_id:SYSTEM_ADMIN_LOGIN,password_hash:ADMIN_HASH_0996,is_system_account:true,is_admin:true,is_representative:false,active:true,deleted:false,legacy_hidden:false,must_change_password:true,join_date:todayIsoKst(),created_at:t,updated_at:t};s.users.push(admin);
  }
  admin.is_admin=true;
  if(!admin.password_hash){admin.password_hash=ADMIN_HASH_0996;admin.must_change_password=true;}
  // Preserve employee IDs, credentials, privileges, and actual CEO employee identity.
  // Never turn a real employee into a synthetic representative account.
  const representative=s.users.find(u=>!u.deleted&&!u.legacy_hidden&&!u.is_system_account&&u.is_representative)
    ||s.users.find(u=>!u.deleted&&!u.legacy_hidden&&u.is_representative)||null;
  if(representative)representative.is_admin=true;
  return {admin,representative};
}
function ensureRepresentativeAccount(s, t = nowIso()) { return ensureSystemAccounts(s, t).representative; }
function normalizeRequestApproval(s, r, representativeId) {
  if (r.source !== 'APPLICATION') {
    if (!Array.isArray(r.approval_steps)) r.approval_steps = [];
    r.approval_state = r.status1 === 'APPROVED' && r.status_final === 'APPROVED' ? 'APPROVED' : (r.status1 === 'REJECTED' || r.status_final === 'REJECTED' ? 'REJECTED' : 'IMPORTED');
    return;
  }
  if (!Array.isArray(r.approval_steps) || !r.approval_steps.length) {
    const steps = [];
    if (r.approver1_id) {
      const status = r.status1 === 'APPROVED' ? 'APPROVED' : r.status1 === 'REJECTED' ? 'REJECTED' : r.status1 === 'CANCELLED' ? 'CANCELLED' : 'PENDING';
      steps.push({ order: 1, approver_id: Number(r.approver1_id), role: 'APPROVER', status, action_at: status === 'PENDING' ? null : (r.approved1_at || r.updated_at || null), comment: status === 'REJECTED' ? (r.reject_reason || '') : '' });
    }
    // 과거 자료의 지정된 최종 결재자를 보존합니다. 최종자 정보 자체가 없을 때만 대표자에게 연결합니다.
    const finalDone = ['APPROVED', 'REJECTED'].includes(r.status_final);
    const finalId = Number(r.final_approver_id || representativeId || 0) || null;
    if (finalId) {
      let status = r.status_final === 'APPROVED' ? 'APPROVED' : r.status_final === 'REJECTED' ? 'REJECTED' : r.status_final === 'CANCELLED' ? 'CANCELLED' : 'WAITING';
      if (r.status1 === 'APPROVED' && status === 'WAITING') status = 'PENDING';
      steps.push({ order: steps.length + 1, approver_id: finalId, role: 'REPRESENTATIVE', status, action_at: ['APPROVED', 'REJECTED', 'CANCELLED'].includes(status) ? (r.final_approved_at || r.updated_at || null) : null, comment: status === 'REJECTED' ? (r.reject_reason || '') : '' });
    }
    r.approval_steps = steps;
  }
  r.approval_steps = r.approval_steps.map((step, index) => ({
    order: index + 1,
    approver_id: Number(step.approver_id),
    role: step.role === 'REPRESENTATIVE' ? 'REPRESENTATIVE' : 'APPROVER',
    status: ['PENDING', 'WAITING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(step.status) ? step.status : 'WAITING',
    action_at: step.action_at || null,
    comment: cleanText(step.comment || '', 500)
  }));
  if (!['CANCELLED', 'APPROVED', 'REJECTED'].includes(r.approval_state)) {
    const unresolved = r.approval_steps.filter((x) => ['PENDING', 'WAITING'].includes(x.status));
    if (unresolved.length && !unresolved.some((x) => x.status === 'PENDING')) unresolved[0].status = 'PENDING';
  }
  syncLegacyApprovalFields(r);
}
function syncLegacyApprovalFields(r) {
  if (r.source !== 'APPLICATION' || !Array.isArray(r.approval_steps)) return;
  const firstSteps = r.approval_steps.filter((x) => x.role !== 'REPRESENTATIVE');
  const repStep = [...r.approval_steps].reverse().find((x) => x.role === 'REPRESENTATIVE') || null;
  const rejected = r.approval_steps.find((x) => x.status === 'REJECTED');
  const cancelled = r.approval_steps.some((x) => x.status === 'CANCELLED') || r.status1 === 'CANCELLED' || r.status_final === 'CANCELLED';
  if (cancelled) {
    r.approval_state = 'CANCELLED'; r.status1 = 'CANCELLED'; r.status_final = 'CANCELLED';
  } else if (rejected) {
    r.approval_state = 'REJECTED';
    if (rejected.role === 'REPRESENTATIVE') { r.status1 = 'APPROVED'; r.status_final = 'REJECTED'; }
    else { r.status1 = 'REJECTED'; r.status_final = 'WAITING'; }
    r.reject_reason = rejected.comment || r.reject_reason || '';
  } else {
    const firstApproved = firstSteps.every((x) => x.status === 'APPROVED');
    r.status1 = firstApproved ? 'APPROVED' : 'PENDING';
    r.status_final = repStep?.status === 'APPROVED' ? 'APPROVED' : repStep?.status === 'REJECTED' ? 'REJECTED' : 'WAITING';
    r.approval_state = firstApproved && repStep?.status === 'APPROVED' ? 'APPROVED' : 'PENDING';
    if (r.approval_state !== 'REJECTED') r.reject_reason = '';
  }
  r.approver1_id = firstSteps[0]?.approver_id || r.approver1_id || null;
  r.final_approver_id = repStep?.approver_id || r.final_approver_id || null;
  if (firstSteps.length && firstSteps.every((x) => x.status === 'APPROVED')) r.approved1_at = firstSteps[firstSteps.length - 1].action_at || r.approved1_at || null;
  if (repStep && ['APPROVED', 'REJECTED'].includes(repStep.status)) r.final_approved_at = repStep.action_at || r.final_approved_at || null;
}
function currentApprovalStep(r) {
  if (r.source !== 'APPLICATION' || !Array.isArray(r.approval_steps)) return null;
  if (['APPROVED','REJECTED','CANCELLED'].includes(r.approval_state)) return null;
  return r.approval_steps.find((x) => x.status === 'PENDING') || null;
}
function approvalStateOf(r) {
  if (r.status1 === 'CANCELLED' || r.status_final === 'CANCELLED' || r.approval_state === 'CANCELLED') return 'CANCELLED';
  if (r.approval_state === 'REJECTED' || r.status1 === 'REJECTED' || r.status_final === 'REJECTED') return 'REJECTED';
  if (r.status1 === 'APPROVED' && r.status_final === 'APPROVED') return 'APPROVED';
  return r.source === 'APPLICATION' ? 'PENDING' : 'APPROVED';
}


function ensureStateShape(s) {
  s.schema_version = SCHEMA_VERSION;
  s.seed_version = s.seed_version || 'excel-seed';
  s.companies = Array.isArray(s.companies) ? s.companies : [];
  s.users = Array.isArray(s.users) ? s.users : [];
  s.requests = Array.isArray(s.requests) ? s.requests : [];
  s.adjustments = Array.isArray(s.adjustments) ? s.adjustments : [];
  s.work_settings = Array.isArray(s.work_settings) ? s.work_settings : [];
  s.custom_holidays = Array.isArray(s.custom_holidays) ? s.custom_holidays : [];
  s.counters = s.counters || {};
  s.counters.company = Number(s.counters.company || Math.max(0, ...s.companies.map((x) => Number(x.id) || 0)) + 1);
  s.counters.user = Number(s.counters.user || Math.max(0, ...s.users.map((x) => Number(x.id) || 0)) + 1);
  s.counters.request = Number(s.counters.request || Math.max(0, ...s.requests.map((x) => Number(x.id) || 0)) + 1);
  s.counters.adjustment = Number(s.counters.adjustment || Math.max(0, ...s.adjustments.map((x) => Number(x.id) || 0)) + 1);
  s.counters.holiday = Number(s.counters.holiday || Math.max(0, ...s.custom_holidays.map((x) => Number(x.id) || 0)) + 1);
  const t = nowIso();
  for (const u of s.users) {
    if (u.is_representative == null) u.is_representative = false;
    if (u.retire_date == null) u.retire_date = '';
    if (u.deleted == null) u.deleted = false;
    if (u.legacy_hidden == null) u.legacy_hidden = false;
    if (!u.is_system_account && isRetiredAsOf(u)) u.active = false;
  }
  s.staff_audit ||= []; s.cycle_grants ||= []; s.test_clear_history ||= [];
  s.roster_history ||= structuredClone(ROSTER_2026.history);
  s.roster_source ||= {source_file:ROSTER_2026.source_file,source_as_of_text:ROSTER_2026.source_as_of_text,counts:ROSTER_2026.counts};
  for(const u of s.users){
    if(!u.is_system_account){
      u.leave_basis_date ||= u.join_date;
      const rec=ROSTER_2026.current.find(r=>r.employee_name.replace(/\s/g,'')===String(u.employee_name).replace(/\s/g,''));
      if(rec){
        u.roster_source_record ||= structuredClone(rec);
        for(const field of ['address','career','gender','age_source','employment_note','review_notes'])if(u[field]==null)u[field]=rec[field];
        if(!s.dnm82_migrated && rec.department==='대표이사'){u.is_representative=true;u.is_admin=true;}
      }
    }
  }
  s.dnm82_migrated=true;
  for(const a of s.adjustments){if(!Number.isFinite(a.minutes))a.minutes=Math.round(Number(a.amount||0)*DAY_MINUTES);a.amount=a.minutes/DAY_MINUTES;}
  const { representative } = ensureSystemAccounts(s, t);
  for (const c of s.companies) {
    if (!s.work_settings.some((w) => Number(w.company_id) === Number(c.id))) s.work_settings.push({ company_id: c.id, ...DEFAULT_WORK, updated_at: t });
  }
  for (const r of s.requests) {
    if (!Array.isArray(r.charge_dates)) r.charge_dates = null;
    if (r.start_time == null) r.start_time = '';
    if (r.end_time == null) r.end_time = '';
    if (r.start_datetime == null) r.start_datetime = r.start_date && r.start_time ? `${r.start_date}T${r.start_time}` : '';
    if (r.end_datetime == null) r.end_datetime = r.end_date && r.end_time ? `${r.end_date}T${r.end_time}` : '';
    if (r.hours == null || !Number.isFinite(Number(r.hours))) r.hours = Number(r.days || 0)*8;
    normalizeCharge(r);
    if (r.leave_type !== 'HOURLY' && !Array.isArray(r.hourly_segments)) r.hourly_segments = null;
    normalizeRequestApproval(s, r, representative?.id || null);
    const current = currentApprovalStep(r);
    const currentUser = current ? userById(s, current.approver_id) : null;
    if (r.source === 'APPLICATION' && approvalStateOf(r) === 'PENDING' && currentUser?.legacy_hidden) {
      current.status = 'REJECTED'; current.action_at = t; current.comment = '승인체계 변경으로 기존 시스템 승인자 계정이 종료되었습니다. 승인자를 다시 선택하여 재신청해 주세요.';
      r.updated_at = t; syncLegacyApprovalFields(r);
    }
  }
  return s;
}
async function initDb(env) {
  const existing = await env.stateStore.getWithMetadata('state', { consistency: 'strong', type: 'json' });
  if (!existing) {
    const initial = ensureStateShape(structuredClone(INITIAL_STATE));
    initial.updated_at = nowIso();
    await env.stateStore.setJSON('state', initial, { onlyIfNew: true, metadata: { schema: 'leave-manager-v8.3' } });
  }
}
async function loadState(env) {
  const row = await env.stateStore.getWithMetadata('state', { consistency: 'strong', type: 'json' });
  if (!row || !row.data) throw new HttpError(500, 'Netlify 저장자료를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return { version: row.etag, state: ensureStateShape(row.data) };
}
async function saveState(env, version, state) {
  ensureStateShape(state);
  state.updated_at = nowIso();
  const r = await env.stateStore.setJSON('state', state, { onlyIfMatch: version, metadata: { schema: 'leave-manager-v8.3', updated_at: state.updated_at } });
  if (!r?.modified) throw new HttpError(409, '다른 사용자가 동시에 자료를 처리했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.');
}
async function createSession(env, token, userId, expiresAt) { await env.sessionStore.setJSON(token, { user_id: Number(userId), expires_at: Number(expiresAt) }, { metadata: { expires_at: Number(expiresAt) } }); }
async function readSession(env, token) { return await env.sessionStore.get(token, { consistency: 'strong', type: 'json' }); }
async function deleteSession(env, token) { if (token) await env.sessionStore.delete(token); }

function companyById(s, id) { return s.companies.find((c) => c.id === Number(id)) || null; }
function activeCompany(s, id) { const c = companyById(s, id); return c && c.active ? c : null; }
function userById(s, id) { return s.users.find((u) => u.id === Number(id)) || null; }
function userByLogin(s, login) {
  const key = loginKey(login);
  if (!key) return null;
  const exact = s.users.find((u) => !u.deleted && !u.legacy_hidden && loginKey(u.login_id) === key);
  if (exact) return exact;
  const byName = s.users.filter((u) => !u.deleted && !u.legacy_hidden && !u.is_system_account && loginKey(u.employee_name) === key);
  return byName.length === 1 ? byName[0] : null;
}
function companyName(s, id) { return companyById(s, id)?.name || '전체 회사'; }
function getWorkSettings(s, companyId) { return s.work_settings.find((w) => Number(w.company_id) === Number(companyId)) || { company_id: Number(companyId), ...DEFAULT_WORK }; }

function requestDaysInRange(request,a,b){return requestMinutesInRange(request,a,b)/DAY_MINUTES;}
function approvedUsedDays(s,userId,a=null,b=null){return sumRequests(s,userId,'APPROVED',a,b)/DAY_MINUTES;}
function pendingDays(s,userId,exclude=null,a=null,b=null){return sumRequests(s,userId,'PENDING',a,b,exclude)/DAY_MINUTES;}
function adjustmentEffectiveDate(a) { return cleanText(a.effective_date || String(a.created_at || '').slice(0, 10), 10); }
function adjustmentTotal(s,userId,a=null,b=null){return sumAdjustments(s,userId,a,b)/DAY_MINUTES;}
function currentCycleBalance(s,user,asOf=todayIsoKst()){return cycleBalance(s,user,asOf);}
function roleLabel(u) {
  if (u.is_admin && u.is_representative) return '대표이사/관리자';
  if (u.is_admin) return '관리자';
  if (u.is_representative) return '대표이사';
  if (u.can_approve_first) return '결재자';
  return '직원';
}
function userSummary(s, u, asOf = todayIsoKst()) {
  if (!u) return null;
  const system = Boolean(u.is_system_account), retired = !system && hasRetireDate(u), calcAsOf = retired && isRetiredAsOf(u, asOf) ? u.retire_date : asOf;
  const cycle = system ? null : currentCycleBalance(s, u, calcAsOf);
  const settings = system ? DEFAULT_WORK : getWorkSettings(s, u.company_id);
  const workHoursPerDay = 8;
  const toHours = (days) => Number(days || 0) * workHoursPerDay;
  const granted = system ? 0 : Number(cycle?.granted || 0), current = system ? 0 : currentEntitlement(basisDate(u), calcAsOf), used = system ? 0 : Number(cycle?.used || 0), pending = system ? 0 : Number(cycle?.pending || 0), adjustments = system ? 0 : Number(cycle?.adjustments || 0), remaining = system ? 0 : Number(cycle?.remaining || 0), projected = system ? 0 : Number(cycle?.projected_remaining || 0);
  const totalUsed = system ? 0 : approvedUsedDays(s, u.id);
  const employmentStatus = system ? '시스템' : (!hasRetireDate(u) ? '재직' : (isRetiredAsOf(u, asOf) ? '퇴사' : '퇴사예정'));
  return {
    id: u.id, company_id: u.company_id, company_name: companyName(s, u.company_id), employee_code: u.employee_code || '', employee_name: u.employee_name, phone: u.phone || '', note: u.note || '',
    login_id: u.original_login_id && u.deleted ? u.original_login_id : u.login_id, department: u.department || '', position: u.position || '', join_date: u.join_date,
    retire_date: u.retire_date || '', employment_status: employmentStatus, deleted: Boolean(u.deleted), is_admin: Boolean(u.is_admin),
    is_representative: Boolean(u.is_representative), can_manage: Boolean(u.is_admin || u.is_representative),
    can_approve_first: Boolean(u.can_approve_first), can_approve_final: Boolean(u.can_approve_final), is_system_account: system, active: Boolean(u.active && !u.deleted && !isRetiredAsOf(u, asOf)),
    must_change_password: Boolean(u.must_change_password), source_accrued: u.source_accrued, source_used: u.source_used, source_remaining: u.source_remaining,
    role_label: roleLabel(u), tenure: system ? '-' : tenureLabel(u.join_date, calcAsOf), current_entitlement: current,
    cumulative_granted: system ? 0 : cumulativeGranted(basisDate(u), calcAsOf), total_used: totalUsed, total_adjustments: system ? 0 : adjustmentTotal(s, u.id),
    service_year: system ? null : cycle?.service_year, cycle_start: system ? '' : cycle?.cycle_start, cycle_end: system ? '' : cycle?.cycle_end,
    next_anniversary: system || retired ? '' : cycle?.next_anniversary, next_entitlement: system || retired ? 0 : cycle?.next_entitlement,
    work_hours_per_day: workHoursPerDay, granted_hours: toHours(granted), used_hours: toHours(used), pending_hours: toHours(pending), adjustments_hours: toHours(adjustments), remaining_hours: toHours(remaining), projected_remaining_hours: toHours(projected), total_used_hours: toHours(totalUsed),
    leave_basis_date: basisDate(u), amounts: {granted:parts(granted*DAY_MINUTES),used:parts(used*DAY_MINUTES),pending:parts(pending*DAY_MINUTES),adjustments:parts(adjustments*DAY_MINUTES),remaining:parts(remaining*DAY_MINUTES),projected_remaining:parts(projected*DAY_MINUTES),total_used:parts(totalUsed*DAY_MINUTES)}, carryover_minutes:0,
    granted, used, pending, adjustments, remaining, available: projected, projected_remaining: projected, over_request_allowed: true, as_of: asOf
  };
}
function requestRow(s, r) {
  normalizeCharge(r);
  const a = userById(s, r.user_id), f = userById(s, r.approver1_id), z = userById(s, r.final_approver_id);
  const workHoursPerDay = 8;
  const hours = r.minutes / 60;
  const approvalLine = Array.isArray(r.approval_steps) ? r.approval_steps.map((step) => {
    const u = userById(s, step.approver_id);
    return {
      ...step,
      approver_name: u?.employee_name || '',
      approver_login: u?.login_id || '',
      department: u?.department || '',
      position: u?.position || '',
      status_label: approvalStatusLabel(step.status),
      role_label: step.role === 'REPRESENTATIVE' ? '최종 결재' : `${step.order}차 결재`
    };
  }) : [];
  const current = ['APPROVED','CANCELLED','REJECTED'].includes(approvalStateOf(r)) ? null : (approvalLine.find((step) => step.status === 'PENDING') || null);
  const approvedCount = approvalLine.filter((step) => step.status === 'APPROVED').length;
  const state = approvalStateOf(r);
  let statusLabel = '승인대기';
  if (state === 'APPROVED') statusLabel = '최종승인';
  else if (state === 'REJECTED') statusLabel = '반려';
  else if (state === 'CANCELLED') statusLabel = '취소';
  else if (current?.role === 'REPRESENTATIVE') statusLabel = '최종 결재 대기';
  else if (current) statusLabel = `${current.order}차 승인 대기`;
  return {
    ...r,
    approval_state: state,
    approval_status_label: statusLabel,
    approval_line: approvalLine,
    approval_progress: { approved: approvedCount, total: approvalLine.length },
    current_approval: current,
    company_id: a?.company_id ?? null, company_name: companyName(s, a?.company_id), department: a?.department || '',
    employee_code: a?.employee_code || '', applicant_name: a?.employee_name || '', applicant_login: a?.login_id || '',
    position: a?.position || '', join_date: a?.join_date || '', is_representative: Boolean(a?.is_representative), is_system_account: Boolean(a?.is_system_account),
    approver1_name: f?.employee_name || '', approver1_login: f?.login_id || '',
    final_approver_name: z?.employee_name || '', final_approver_login: z?.login_id || '',
    hours, work_hours_per_day: workHoursPerDay
  };
}
function allRequestRows(s) { return s.requests.map((r) => requestRow(s, r)).sort((a, b) => comparePeople(a, b) || String(b.start_date).localeCompare(String(a.start_date)) || b.id - a.id); }
function sortUsers(s, users) { return sortPeople(users.map((u) => ({ ...u, company_name: companyName(s, u.company_id) }))); }
function generateLoginId(s, name, excluded = null) {
  let base = normalizeLoginBase(name).normalize('NFKC');
  if (RESERVED_LOGINS.has(base)) base = `${base}2`;
  const exists = (x) => s.users.some((u) => !u.deleted && !u.legacy_hidden && loginKey(u.login_id) === loginKey(x) && u.id !== Number(excluded));
  if (!exists(base)) return base; let n = 2; while (exists(`${base}${n}`)) n += 1; return `${base}${n}`;
}
function rejectPendingForUnavailableApprover(s, userId, reason) {
  const t = nowIso();
  for (const r of s.requests) {
    if (r.source !== 'APPLICATION' || approvalStateOf(r) !== 'PENDING') continue;
    const step = currentApprovalStep(r);
    if (!step || Number(step.approver_id) !== Number(userId)) continue;
    step.status = 'REJECTED'; step.action_at = t; step.comment = reason;
    r.updated_at = t; syncLegacyApprovalFields(r);
  }
}
function requestSegments(s, request) {
  const applicant = userById(s, request.user_id);
  const settings = getWorkSettings(s, applicant?.company_id);
  const fullStart = settings.work_start || DEFAULT_WORK.work_start;
  const fullEnd = settings.work_end || DEFAULT_WORK.work_end;
  const dates = Array.isArray(request.charge_dates) && request.charge_dates.length
    ? request.charge_dates
    : (request.start_date && request.end_date ? (() => { const out = []; let d = request.start_date; while (d <= request.end_date) { out.push(d); d = addDays(d, 1); } return out; })() : []);
  if (request.leave_type === 'FULL' || request.leave_type === 'IMPORTED') return dates.map((date) => ({ date, start_time: fullStart, end_time: fullEnd, full: true }));
  if (Array.isArray(request.hourly_segments) && request.hourly_segments.length) return request.hourly_segments.map((x) => ({ date: x.date, start_time: x.start_time, end_time: x.end_time, full: false }));
  if (request.leave_type === 'HOURLY' && request.start_datetime && request.end_datetime) {
    const start = parseLocalDateTime(request.start_datetime), end = parseLocalDateTime(request.end_datetime);
    if (!start || !end) return [];
    const out = [];
    let d = start.date;
    while (d <= end.date) {
      out.push({ date: d, start_time: d === start.date ? start.time : fullStart, end_time: d === end.date ? end.time : fullEnd, full: false });
      d = addDays(d, 1);
    }
    return out;
  }
  if (['AM_HALF', 'PM_HALF', 'IMPORTED_HALF', 'HALF_IMPORTED'].includes(request.leave_type)) {
    return dates.map((date) => ({ date, start_time: request.start_time || (request.leave_type === 'AM_HALF' ? settings.work_start : settings.lunch_end), end_time: request.end_time || (request.leave_type === 'AM_HALF' ? settings.lunch_start : settings.work_end), full: false }));
  }
  return dates.map((date) => ({ date, start_time: request.start_time || fullStart, end_time: request.end_time || fullEnd, full: false }));
}
function timeSegmentsOverlap(a, b) {
  if (a.date !== b.date) return false;
  if (a.full || b.full) return true;
  const as = timeToMinutes(a.start_time), ae = timeToMinutes(a.end_time), bs = timeToMinutes(b.start_time), be = timeToMinutes(b.end_time);
  if ([as, ae, bs, be].some((v) => v == null)) return true;
  return as < be && bs < ae;
}
function hasLeaveConflict(s, userId, type, start, end, calc = null) {
  const existing = s.requests.filter((r) => r.user_id === Number(userId) && !['REJECTED', 'CANCELLED'].includes(r.status1) && !['REJECTED', 'CANCELLED'].includes(r.status_final) && r.leave_type !== 'IMPORTED_SUMMARY' && r.start_date <= end && r.end_date >= start);
  if (!existing.length) return null;
  // FULL still compares actual charge dates; a weekend in a date range is not a conflict.

  const candidate = calc?.hourly_segments?.length
    ? calc.hourly_segments.map((x) => ({ date: x.date, start_time: x.start_time, end_time: x.end_time, full: false }))
    : requestSegments(s, { user_id: Number(userId), leave_type: type, start_date: start, end_date: end, import_key:importKey, start_time: calc?.start_time || cleanText(pick(row,['시작시간']),5), end_time: calc?.end_time || cleanText(pick(row,['종료시간']),5), charge_dates: calc?.charge_dates || null });
  for (const r of existing) {
    const segments = requestSegments(s, r);
    if (segments.some((x) => candidate.some((y) => timeSegmentsOverlap(x, y)))) return r;
  }
  return null;
}

function fixedSubstitute(map, date, name) {
  if (!parseIso(date)) return;
  // 패키지가 이미 이 공휴일을 알고 있으면 패키지의 대체공휴일 계산을 신뢰합니다.
  if (map.has(date)) return;
  map.set(date, { date, name, type: 'public', source: '국가공휴일' });
  const dt = new Date(`${date}T00:00:00Z`);
  const weekend = [0, 6].includes(dt.getUTCDay());
  if (!weekend) return;
  let next = addDays(date, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00Z`).getUTCDay()) || map.has(next)) next = addDays(next, 1);
  if (!map.has(next)) map.set(next, { date: next, name: `${name} 대체공휴일`, type: 'public', source: '국가공휴일', substitute: true });
}
function nationalHolidaysForYear(year) {
  const map = new Map();
  try {
    for (const h of krHolidays.getHolidays(Number(year)) || []) {
      if (h.type !== 'public') continue;
      const date = String(h.date || '').slice(0, 10);
      if (parseIso(date)) map.set(date, { date, name: h.name || '공휴일', type: 'public', source: '국가공휴일', substitute: Boolean(h.substitute) });
    }
  } catch { /* fixed/manual holidays below remain available */ }
  // 2026년 개정: 노동절(5/1), 제헌절(7/17) 공휴일 및 대체공휴일을 보완합니다.
  if (Number(year) >= 2026) {
    fixedSubstitute(map, `${year}-05-01`, '노동절');
    fixedSubstitute(map, `${year}-07-17`, '제헌절');
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function holidayRows(s, companyId, start, end) {
  const years = new Set();
  const a = parseIso(start), b = parseIso(end);
  if (!a || !b) return [];
  for (let y = a.getUTCFullYear(); y <= b.getUTCFullYear(); y += 1) years.add(y);
  const map = new Map();
  for (const y of years) for (const h of nationalHolidaysForYear(y)) if (h.date >= start && h.date <= end) map.set(h.date, h);
  for (const h of s.custom_holidays.filter((x) => x.active !== false && (!x.company_id || Number(x.company_id) === Number(companyId)) && x.date >= start && x.date <= end)) {
    map.set(h.date, { date: h.date, name: h.name, type: 'custom', source: h.company_id ? '회사휴일' : '공통휴일', custom_id: h.id });
  }
  return [...map.values()].sort((x, y) => x.date.localeCompare(y.date));
}
function workingDateDetails(s, companyId, start, end) {
  const holidays = holidayRows(s, companyId, start, end); const holidayMap = new Map(holidays.map((h) => [h.date, h]));
  const chargeDates = [], excluded = [];
  let d = start;
  while (d <= end) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) excluded.push({ date: d, reason: dow === 0 ? '일요일' : '토요일' });
    else if (holidayMap.has(d)) excluded.push({ date: d, reason: holidayMap.get(d).name });
    else chargeDates.push(d);
    d = addDays(d, 1);
  }
  return { charge_dates: chargeDates, excluded_dates: excluded, holidays };
}
function validateDnmWork(settings) {
 const a=timeToMinutes(settings.work_start),b=timeToMinutes(settings.lunch_start),c=timeToMinutes(settings.lunch_end),d=timeToMinutes(settings.work_end);
 if([a,b,c,d].some(x=>x==null||x%30!==0)||b-a!==240||d-c!==240||c<b)throw new HttpError(400,'근무기준을 확인해 주세요. 디엔엠은 오전·오후 각각 4시간, 하루 8시간 기준입니다. 관리자 → 근무·휴일 기준에서 조정해 주세요.');
}
function calculateHourlyLeave(s, user, startDateTime, endDateTime) {
  const start = parseLocalDateTime(startDateTime), end = parseLocalDateTime(endDateTime);
  if (!start || !end || cmpDateTime(end.raw, start.raw) <= 0) throw new HttpError(400, '시간단위 신청은 시작일시와 종료일시를 정확히 입력해 주세요.');
  if (parseIso(end.date)-parseIso(start.date)>366*86400000)throw new HttpError(400,'신청 기간은 366일 이내로 나누어 주세요.');
  if (!isThirtyMinuteTime(start.time) || !isThirtyMinuteTime(end.time)) throw new HttpError(400, '시간단위 연차는 30분 단위로만 신청할 수 있습니다. 예: 09:00, 09:30');
  const settings = getWorkSettings(s, user.company_id);validateDnmWork(settings);
  const workStart = timeToMinutes(settings.work_start), lunchStart = timeToMinutes(settings.lunch_start), lunchEnd = timeToMinutes(settings.lunch_end), workEnd = timeToMinutes(settings.work_end);
  const workMinutes = workMinutesPerDay(settings);
  const details = workingDateDetails(s, user.company_id, start.date, end.date);
  const workingSet = new Set(details.charge_dates);
  const hourlySegments = [];
  let totalMinutes = 0;
  let d = start.date;
  while (d <= end.date) {
    if (workingSet.has(d)) {
      const dayStart = d === start.date ? start.minutes : workStart;
      const dayEnd = d === end.date ? end.minutes : workEnd;
      const blocks = [[workStart, lunchStart], [lunchEnd, workEnd]];
      for (const [bs, be] of blocks) {
        const segStart = Math.max(dayStart, bs), segEnd = Math.min(dayEnd, be);
        if (segEnd > segStart) {
          const minutes = segEnd - segStart;
          totalMinutes += minutes;
          hourlySegments.push({ date: d, start_time: minutesToTime(segStart), end_time: minutesToTime(segEnd), minutes, hours: roundHours(minutes / 60) });
        }
      }
    }
    d = addDays(d, 1);
  }
  if (totalMinutes <= 0) throw new HttpError(400, '근무시간 안에서 계산되는 시간단위 연차가 없습니다. 근무시간·휴일·점심시간을 확인해 주세요.');
  if (totalMinutes % 30 !== 0) throw new HttpError(400, '시간단위 연차는 30분 단위로만 신청할 수 있습니다.');
  const hours = roundHours(totalMinutes / 60);
  return {
    days: totalMinutes / DAY_MINUTES, minutes:totalMinutes, amount_parts:parts(totalMinutes), hours,
    start_date: start.date, end_date: end.date, start_time: start.time, end_time: end.time,
    start_datetime: start.raw, end_datetime: end.raw,
    charge_dates: [...new Set(hourlySegments.map((x) => x.date))], hourly_segments: hourlySegments,
    excluded_dates: details.excluded_dates, work_settings: settings, work_hours_per_day: 8
  };
}
function calculateLeave(s, user, type, start, end, startDateTime = '', endDateTime = '') {
  if (!['FULL', 'AM_HALF', 'PM_HALF', 'HOURLY'].includes(type)) throw new HttpError(400, '연차 신청 구분을 확인해 주세요.');
  if (type === 'HOURLY') return calculateHourlyLeave(s, user, startDateTime, endDateTime);
  if (!parseIso(start) || !parseIso(end) || end < start) throw new HttpError(400, '신청 날짜를 정확히 입력해 주세요.');
  if (parseIso(end)-parseIso(start)>366*86400000)throw new HttpError(400,'신청 기간은 366일 이내로 나누어 주세요.');
  const settings = getWorkSettings(s, user.company_id);validateDnmWork(settings);
  const workHours = roundHours(workMinutesPerDay(settings) / 60);
  if (type !== 'FULL') end = start;
  const details = workingDateDetails(s, user.company_id, start, end);
  if (type !== 'FULL') {
    if (!details.charge_dates.includes(start)) throw new HttpError(400, '토·일요일 또는 휴일에는 반차를 신청할 수 없습니다.');
    const startTime = type === 'AM_HALF' ? settings.work_start : settings.lunch_end;
    const endTime = type === 'AM_HALF' ? settings.lunch_start : settings.work_end;
    return { days: 0.5, minutes:240, amount_parts:parts(240), hours:4, start_date: start, end_date: start, start_time: startTime, end_time: endTime, start_datetime: `${start}T${startTime}`, end_datetime: `${start}T${endTime}`, charge_dates: [start], hourly_segments: [{ date: start, start_time: startTime, end_time: endTime, minutes:240, hours:4 }], excluded_dates: [], work_settings: settings, work_hours_per_day: workHours };
  }
  if (!details.charge_dates.length) throw new HttpError(400, '선택한 기간에 연차 사용일로 계산되는 근무일이 없습니다.');
  return { days: details.charge_dates.length, minutes:details.charge_dates.length*DAY_MINUTES, amount_parts:parts(details.charge_dates.length*DAY_MINUTES), hours:details.charge_dates.length*8, start_date: start, end_date: end, start_time: settings.work_start, end_time: settings.work_end, start_datetime: `${start}T${settings.work_start}`, end_datetime: `${end}T${settings.work_end}`, charge_dates: details.charge_dates, hourly_segments: null, excluded_dates: details.excluded_dates, work_settings: settings, work_hours_per_day: workHours };
}

function renewalRows(s,ym,companyId=null,asOf=todayIsoKst()) {
 const m=/^(\d{4})-(\d{2})$/.exec(String(ym||''));if(!m||Number(m[2])<1||Number(m[2])>12)throw new HttpError(400,'조회 월을 확인해 주세요.');
 return sortUsers(s,s.users.filter(u=>!u.is_system_account&&!u.deleted&&(!companyId||u.company_id===companyId))).map(u=>{
  const ad=anniversaryInYear(basisDate(u),Number(m[1]));if(!ad||ad.slice(0,7)!==ym||(u.retire_date&&u.retire_date<=ad))return null;
  const prev=cycleBalance(s,u,addDays(ad,-1)), next=cycleBalance(s,u,ad); if(!prev||!next)return null;
  const unused=Math.max(0,prev.amounts.remaining.minutes),over=Math.max(0,-prev.amounts.remaining.minutes);
  return {user_id:u.id,company_id:u.company_id,company_name:companyName(s,u.company_id),department:u.department,employee_code:u.employee_code,employee_name:u.employee_name,login_id:u.login_id,position:u.position,join_date:u.join_date,leave_basis_date:basisDate(u),anniversary_date:ad,completed_years:next.service_year,
    prior_cycle_start:prev.cycle_start,prior_cycle_end:prev.cycle_end,prior_granted:prev.granted,prior_used:prev.used,prior_adjustments:prev.adjustments,prior_balance:prev.remaining,unused_expiring:unused/DAY_MINUTES,overused:over/DAY_MINUTES,new_entitlement:next.granted,new_cycle_start:next.cycle_start,new_cycle_end:next.cycle_end,
    amounts:{prior_granted:prev.amounts.granted,prior_used:prev.amounts.used,prior_adjustments:prev.amounts.adjustments,prior_balance:prev.amounts.remaining,unused_expiring:parts(unused),overused:parts(over),new_entitlement:next.amounts.granted},
    status:ad<asOf?'갱신완료':ad===asOf?'오늘 갱신':'갱신예정',settlement_due:ad<=asOf,settlement_status:'수당·소멸예외 별도확인',carryover_minutes:0};
 }).filter(Boolean).sort(comparePeople);
}
async function sessionUser(request, env, s) {
  const token = getCookie(request, 'leave.sid'); if (!token) return null;
  const row = await readSession(env, token); if (!row || Number(row.expires_at) < Date.now()) { if (row) await deleteSession(env, token); return null; }
  const u = userById(s, row.user_id); if (!userAvailable(u) || u.legacy_hidden || (u.company_id != null && !activeCompany(s, u.company_id))) { await deleteSession(env, token); return null; }
  return u;
}
async function requireAuth(request, env, s) { const u = await sessionUser(request, env, s); if (!u) throw new HttpError(401, '로그인이 필요합니다.'); return u; }
async function requireAdmin(request, env, s) { const u = await requireAuth(request, env, s); if (!(u.is_admin || u.is_representative)) throw new HttpError(403, '관리자 또는 대표이사 권한이 필요합니다.'); return u; }
async function requireSuperAdmin(request, env, s) { const u = await requireAuth(request, env, s); if (!(u.is_admin && u.is_system_account)) throw new HttpError(403, '통합관리자만 삭제할 수 있습니다.'); return u; }
async function parseBody(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return {};
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) return {};
  try { return await request.json(); } catch { return {}; }
}

function filterAdminRequests(s, url) {
  const cid = numberId(url.searchParams.get('company_id')), uid = numberId(url.searchParams.get('user_id')),
    employment = cleanText(url.searchParams.get('employment') || 'all', 20);
  const from = cleanText(url.searchParams.get('from'), 10), to = cleanText(url.searchParams.get('to'), 10), status = cleanText(url.searchParams.get('status'), 20), source = cleanText(url.searchParams.get('source'), 30);
  return allRequestRows(s).filter((r) => {
    const applicant = userById(s, r.user_id);
    if (!applicant || applicant.deleted) return false;
    if (!employmentMatches(applicant, employment)) return false;
    if (cid && r.company_id !== cid) return false; if (uid && r.user_id !== uid) return false;
    if (from && r.start_date < from) return false; if (to && r.start_date > to) return false;
    if (status === 'PENDING' && approvalStateOf(r) !== 'PENDING') return false;
    if (status === 'APPROVED' && approvalStateOf(r) !== 'APPROVED') return false;
    if (status === 'REJECTED' && approvalStateOf(r) !== 'REJECTED') return false;
    if (source && r.source !== source) return false;
    return true;
  });
}

function cellValue(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v) return v.text;
    if ('result' in v) return v.result;
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('');
  }
  return v;
}
function worksheetRows(ws) {
  const rows = []; let headers = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
    const vals = []; for (let c = 1; c <= row.cellCount; c += 1) vals.push(cellValue(row.getCell(c)));
    if (!headers.length) {const candidate=vals.map(x=>cleanText(x,100));if(candidate.some(x=>['직원명','성명','로그인 ID','로그인ID'].includes(x)))headers=candidate;return;}
    const obj = {}; headers.forEach((h, i) => { if (h) obj[h] = vals[i] ?? ''; });
    if (Object.values(obj).some((x) => String(x).trim() !== '')) rows.push({ rowNo, ...obj });
  });
  return rows;
}
function pick(row, names) { for (const n of names) if (row[n] != null && String(row[n]).trim() !== '') return row[n]; return ''; }
function excelDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = cleanText(v, 20).replaceAll('.', '-').replaceAll('/', '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}
function findCompanyIdByName(s, name) { const t = cleanText(name, 100); return s.companies.find((c) => c.name === t)?.id || null; }

function staffExtras(body) {
  const result={};
  for(const f of ['gender','age_source','address','career','employment_note'])if(Object.hasOwn(body,f))result[f]=cleanText(body[f],f==='career'?2000:500);
  if(Object.hasOwn(body,'leave_basis_date')) {
    const date=cleanText(body.leave_basis_date,10);if(date&&!parseIso(date))throw new HttpError(400,'연차 산정 기준일을 확인해 주세요.');result.leave_basis_date=date;
  }
  return result;
}
function staffRow(s,u) {
 return {...userSummary(s,u),...Object.fromEntries(['gender','age_source','address','career','employment_note','review_notes','roster_source_record'].map(f=>[f,u[f]??''])),updated_at:u.updated_at};
}
async function rosterRoutes({request,env,s,version,url,pathname,method,body}) {
 if(method==='GET'&&pathname==='/api/leave-ledger') {
  const actor=await requireAuth(request,env,s),uid=numberId(url.searchParams.get('user_id'))||actor.id;
  if(uid!==actor.id&&!(actor.is_admin||actor.is_representative))throw new HttpError(403,'본인의 연차대장만 조회할 수 있습니다.');
  const u=userById(s,uid);if(!u||u.is_system_account)throw new HttpError(400,'직원을 선택해 주세요.');
  const asOf=cleanText(url.searchParams.get('as_of')||todayIsoKst(),10);if(!parseIso(asOf))throw new HttpError(400,'조회 기준일을 확인해 주세요.');
  return json({employee:userSummary(s,u,asOf),cycles:cycleHistory(s,u,asOf),adjustments:s.adjustments.filter(x=>x.user_id===uid).map(x=>({...x,amount_parts:parts(x.minutes),created_by_name:userById(s,x.created_by)?.employee_name||''})),grant_overrides:s.cycle_grants.filter(x=>x.user_id===uid),policy:{day_minutes:480,unit_minutes:30,rollover:'NO_CARRYOVER',automatic_grant_assumption:'월 개근 및 연 출근율 요건 충족 가정. 실제 출근율·소멸 예외는 관리자 확인.'}});
 }
 if(!pathname.startsWith('/api/roster')&&!pathname.startsWith('/api/admin/cycle-grant'))return null;
 const actor=await requireAdmin(request,env,s);
 if(method==='GET'&&pathname==='/api/roster') {
  const source=s.roster_source||{};
  const matchingPerson=(r)=>s.users.find((u)=>!u.is_system_account&&(u.employee_name===r.employee_name||u.id===r.employee_id));
  const auditSorted=[...(s.staff_audit||[])].sort((a,b)=>{
    const ua=matchingPerson(a)||{employee_name:a.employee_name,department:a.department,position:a.position,join_date:a.join_date};
    const ub=matchingPerson(b)||{employee_name:b.employee_name,department:b.department,position:b.position,join_date:b.join_date};
    return comparePeople(ua,ub)||String(b.at||'').localeCompare(String(a.at||''));
  });
  return json({employees:sortUsers(s,s.users.filter(x=>!x.is_system_account&&!x.deleted&&!x.legacy_hidden)).map(x=>staffRow(s,x)),history:sortPeople(s.roster_history||[]),audit:auditSorted,source});
 }
 if(method==='POST'&&pathname==='/api/roster/preview') {
  let source;
  if(body.source==='bundled')source=structuredClone(ROSTER_2026);
  else {
   const form=await request.formData(), file=form.get('file');
   if(!file||typeof file.arrayBuffer!=='function')throw new HttpError(400,'Excel 파일을 선택해 주세요.');
   if(file.size>4*1024*1024)throw new HttpError(400,'Excel 파일은 4MB 이하로 업로드해 주세요.');
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await file.arrayBuffer()));
   try{source=parseRosterWorkbook(wb,cleanText(file.name,120));}catch(e){throw new HttpError(400,e.message);}
  }
  const entries=source.current.map((r,index)=>{
   const u=matchEmployee(s.users,r), changes=importChanges(u,r);
   return {index,user_id:u?.id||null,name:r.employee_name,department:r.department,action:u?'UPDATE':'CREATE',changes,review_notes:r.review_notes||[],join_date:r.join_date};
  });
  const token=crypto.randomUUID();await env.sessionStore.setJSON(`roster-preview:${token}`,{actor_id:actor.id,expires_at:Date.now()+15*60*1000,source,entries,state_version:version});
  return json({token,source_file:source.source_file,source_as_of_text:source.source_as_of_text,entries,counts:source.counts,history_count:source.history.length,errors:source.errors||[],privacy_note:source.privacy_note});
 }
 if(method==='POST'&&pathname==='/api/roster/commit') {
  const token=cleanText(body.token,60),key=`roster-preview:${token}`,preview=await env.sessionStore.get(key,{type:'json',consistency:'strong'});
  if(!preview||preview.actor_id!==actor.id||preview.expires_at<Date.now())throw new HttpError(400,'미리보기가 만료되었습니다. 다시 불러와 주세요.');
  if(preview.state_version!==version)throw new HttpError(409,'미리보기 이후 운영자료가 변경되었습니다. 다시 미리보기를 확인해 주세요.');
  const indices=[...new Set((Array.isArray(body.indices)?body.indices:[]).map(Number))];
  if(!indices.length&&!body.include_history)throw new HttpError(400,'적용할 직원을 선택해 주세요.');
  const result={created:0,updated:0,history_saved:0,new_accounts:[]};
  for(const i of indices) {
   if(!Number.isInteger(i)||i<0||i>=preview.source.current.length)throw new HttpError(400,'선택한 행을 확인해 주세요.');
   const r=preview.source.current[i], entry=preview.entries[i];let u=entry.user_id?userById(s,entry.user_id):null;
   if(!parseIso(r.join_date)||!r.employee_name)throw new HttpError(400,'이름과 입사일을 확인해 주세요.');
   if(r.retire_date&&(!parseIso(r.retire_date)||r.retire_date<r.join_date))throw new HttpError(400,'명부의 퇴사일을 확인해 주세요.');
   if(u) {
    const before=structuredClone(u);u.leave_basis_date ||= u.join_date;
    // Do not reset passwords, roles, account status, or previous leave basis date during a roster import.
    for(const f of ROSTER_FIELDS)if(!['employee_code','leave_basis_date','retire_date'].includes(f)&&r[f]!==undefined)u[f]=cleanText(r[f],f==='career'?2000:500);
    if(r.retire_date){u.retire_date=r.retire_date;if(isRetiredAsOf(u)){u.active=false;rejectPendingForUnavailableApprover(s,u.id,'명부 반영으로 결재자가 퇴사 처리되었습니다. 결재자를 다시 지정해 주세요.');}}
    u.roster_source_record=structuredClone(r);u.review_notes=r.review_notes||[];u.updated_at=nowIso();
    auditStaff(s,actor,u,before,'EXCEL_UPDATE',`${preview.source.source_file} / ${r.source_row}행`);result.updated++;
   } else {
    const t=nowIso(),login=generateLoginId(s,r.login_id||r.suggested_login||r.employee_name),cid=s.companies.find(c=>c.active)?.id;
    u={id:s.counters.user++,company_id:cid,employee_code:cleanText(r.employee_code||r.suggested_employee_code||'',40),employee_name:r.employee_name,login_id:login,password_hash:await passwordHash('1111'),is_system_account:false,is_admin:false,is_representative:false,can_approve_first:false,can_approve_final:false,active:!r.retire_date,deleted:false,legacy_hidden:false,must_change_password:true,created_at:t,updated_at:t};
    for(const f of ROSTER_FIELDS)if(!['employee_code','employee_name'].includes(f)&&r[f]!==undefined)u[f]=cleanText(r[f],f==='career'?2000:500);
    u.leave_basis_date ||= u.join_date;u.roster_source_record=structuredClone(r);u.review_notes=r.review_notes||[];
    s.users.push(u);auditStaff(s,actor,u,null,'EXCEL_CREATE');result.created++;result.new_accounts.push({login_id:login,employee_name:u.employee_name});
   }
  }
  if(body.include_history){
   const map=new Map((s.roster_history||[]).map(x=>[`${x.source_sheet}:${x.section}:${x.source_row}`,x]));
   for(const r of preview.source.history){const k=`${r.source_sheet}:${r.section}:${r.source_row}`;if(!map.get(k)?.admin_updated){map.set(k,r);result.history_saved++;}}
   s.roster_history=[...map.values()];
  }
  s.roster_source={source_file:preview.source.source_file,source_as_of_text:preview.source.source_as_of_text,counts:preview.source.counts,imported_at:nowIso(),imported_by:actor.employee_name};
  await saveState(env,version,s);await env.sessionStore.delete(key);return json(result);
 }
 const hm=/^\/api\/roster\/history\/(\d+)$/.exec(pathname);
 if(method==='PUT'&&hm){
  const index=Number(hm[1]),r=s.roster_history[index];if(!r)throw new HttpError(404,'명부 이력을 찾을 수 없습니다.');
  const before=structuredClone(r);
  for(const f of ['note','retire_date','department','position','address','career','phone'])if(Object.hasOwn(body,f))r[f]=cleanText(body[f],2000);
  if(r.retire_date&&!parseIso(r.retire_date))throw new HttpError(400,'퇴사일 형식을 확인해 주세요.');
  r.admin_updated=true;r.updated_at=nowIso();auditStaff(s,actor,{...r,id:null},before,'HISTORY_EDIT',`명부 ${r.source_row}행`);await saveState(env,version,s);return json({ok:true});
 }
 if(method==='POST'&&pathname==='/api/admin/cycle-grant') {
  const u=userById(s,body.user_id),date=cleanText(body.cycle_start,10),reason=cleanText(body.reason,500);
  if(!u||u.is_system_account||!parseIso(date)||!reason)throw new HttpError(400,'직원·주기 시작일·확인 사유를 입력해 주세요.');
  const cyc=cycleBalance(s,u,date);if(!cyc||cyc.cycle_start!==date)throw new HttpError(400,'직원의 연차주기 시작일이 아닙니다.');
  let minutes;try{minutes=minutesFromParts(body.days_whole,body.hours_remainder||0);}catch(e){throw new HttpError(400,e.message);}
  const record={user_id:u.id,cycle_start:date,minutes,reason,created_by:actor.id,updated_at:nowIso()};
  s.cycle_grants=s.cycle_grants.filter(x=>!(x.user_id===u.id&&x.cycle_start===date));s.cycle_grants.push(record);
  auditStaff(s,actor,u,null,'GRANT_CONFIRM',`${date} / ${minutes}분 / ${reason}`);await saveState(env,version,s);return json({ok:true});
 }
 return null;
}

async function handle(context) {
  const { request, env } = context;
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){const origin=request.headers.get('origin');if(origin && origin!==new URL(request.url).origin)throw new HttpError(403,'다른 사이트에서의 변경 요청은 허용하지 않습니다.');}
  await initDb(env); const { version, state: s } = await loadState(env);
  const url = new URL(request.url), pathname = url.pathname, method = request.method, body = await parseBody(request);

  if (method === 'GET' && pathname === '/api/health') return json({ ok: true, service: 'dnm-annual-leave-manager', version: APP_VERSION, date: todayIsoKst(), storage: 'Netlify Blobs' });
  if (method === 'GET' && pathname === '/api/initial-info') return json({ company_count: s.companies.filter((c) => c.active).length, employee_count: s.users.filter((u) => !u.is_system_account && !u.deleted && !hasRetireDate(u)).length, version: APP_VERSION });

  if (method === 'POST' && pathname === '/api/login') {
    const loginId = loginKey(body.login_id), password = String(body.password || ''), u = userByLogin(s, loginId);
    if (!u || u.deleted || u.legacy_hidden) throw new HttpError(401, '로그인 ID 또는 비밀번호가 올바르지 않습니다.');
    if (isRetiredAsOf(u)) throw new HttpError(401, '퇴사 처리된 계정입니다. 관리자에게 문의해 주세요.');
    if (!u.active) throw new HttpError(401, '사용이 중지된 계정입니다. 관리자에게 문의해 주세요.');
    let ok = await verifyPassword(password, u.password_hash);
    if (!ok) throw new HttpError(401, '로그인 ID 또는 비밀번호가 올바르지 않습니다.');
    const token = randomHex(32), exp = Date.now() + SESSION_SECONDS * 1000; await createSession(env, token, u.id, exp);
    return json(userSummary(s, u), 200, { 'Set-Cookie': `leave.sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}` });
  }
  if (method === 'POST' && pathname === '/api/logout') { const token = getCookie(request, 'leave.sid'); if (token) await deleteSession(env, token); return json({ ok: true }, 200, { 'Set-Cookie': 'leave.sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' }); }
  if (method === 'GET' && pathname === '/api/me') return json(userSummary(s, await requireAuth(request, env, s)));
  if (method === 'POST' && pathname === '/api/change-password') {
    const u = await requireAuth(request, env, s), cur = String(body.current_password || ''), np = String(body.new_password || ''), cp = String(body.confirm_password || '');
    if (!await verifyPassword(cur, u.password_hash)) throw new HttpError(400, '현재 비밀번호가 일치하지 않습니다.');
    if (np.length < 8 || np.length > 100) throw new HttpError(400, '새 비밀번호는 8자 이상 100자 이하로 입력해 주세요.');
    if (np !== cp) throw new HttpError(400, '새 비밀번호 확인이 일치하지 않습니다.'); if (['1111','0996'].includes(np)) throw new HttpError(400, '초기 비밀번호 1111과 다른 비밀번호를 사용해 주세요.');
    u.password_hash = await passwordHash(np); u.must_change_password = false; u.updated_at = nowIso(); await saveState(env, version, s); return json({ ok: true });
  }

  const rosterResponse=await rosterRoutes({request,env,s,version,url,pathname,method,body});if(rosterResponse)return rosterResponse;

  if (method === 'GET' && pathname === '/api/companies') { await requireAuth(request, env, s); return json([...s.companies].sort((a, b) => a.name.localeCompare(b.name, 'ko'))); }
  if (method === 'POST' && pathname === '/api/companies') {
    await requireAdmin(request, env, s); const name = cleanText(body.name, 100); if (!name) throw new HttpError(400, '회사명을 입력해 주세요.'); if (s.companies.some((c) => c.name === name)) throw new HttpError(400, '동일한 회사명이 이미 등록되어 있습니다.');
    const t = nowIso(), rec = { id: s.counters.company++, name, active: true, created_at: t, updated_at: t }; s.companies.push(rec); s.work_settings.push({ company_id: rec.id, ...DEFAULT_WORK, updated_at: t }); await saveState(env, version, s); return json(rec);
  }
  let p = matchPath(pathname, /^\/api\/companies\/(\d+)$/);
  if (method === 'PUT' && p) {
    await requireAdmin(request, env, s); const c = companyById(s, p[0]); if (!c) throw new HttpError(404, '회사를 찾을 수 없습니다.'); const name = cleanText(body.name, 100); if (!name) throw new HttpError(400, '회사명을 입력해 주세요.'); if (s.companies.some((x) => x.name === name && x.id !== c.id)) throw new HttpError(400, '동일한 회사명이 이미 등록되어 있습니다.');
    c.name = name; c.active = boolValue(body.active); c.updated_at = nowIso(); await saveState(env, version, s); return json({ ok: true });
  }

  if (method === 'GET' && pathname === '/api/approvers') {
    const u = await requireAuth(request, env, s);
    if (u.company_id == null) return json({ first: [], representative: null });
    const simp = (x) => ({ id: x.id, employee_name: x.employee_name, login_id: x.login_id, department: x.department || '', position: x.position || '', join_date: x.join_date || '', is_representative: Boolean(x.is_representative), company_id:x.company_id });
    const first = s.users
      .filter((x) => x.company_id === u.company_id && userAvailable(x) && !x.is_system_account && x.id !== u.id && x.can_approve_first)
      .sort(comparePeople)
      .map(simp);
    return json({ first, representative: null, final_mode: 'LAST_APPROVER' });
  }
  if (method === 'POST' && pathname === '/api/calculate-leave') {
    const u = await requireAuth(request, env, s); if (u.is_system_account || u.company_id == null) throw new HttpError(400, '직원 본인 계정만 계산할 수 있습니다.');
    const type = cleanText(body.leave_type, 30), start = cleanText(body.start_date, 10), end = cleanText(body.end_date || body.start_date, 10);
    return json(calculateLeave(s, u, type, start, end, cleanText(body.start_datetime, 16), cleanText(body.end_datetime, 16)));
  }
  if (method === 'POST' && pathname === '/api/leave-requests') {
    const u = await requireAuth(request, env, s);
    if (u.is_system_account || u.company_id == null) throw new HttpError(400, '직원 본인 계정만 연차를 신청할 수 있습니다.');
    const type = cleanText(body.leave_type, 30);
    let start = cleanText(body.start_date, 10), end = cleanText(body.end_date, 10);
    const startDateTime = cleanText(body.start_datetime, 16), endDateTime = cleanText(body.end_datetime, 16);
    const reason = cleanText(body.reason, 500);
    const rawIds = Array.isArray(body.approver_ids) ? body.approver_ids : (body.approver1_id ? [body.approver1_id] : []);
    const approverIds = [...new Set(rawIds.map(numberId).filter(Boolean))];
    if (!approverIds.length) throw new HttpError(400, '1명 이상의 승인자를 선택해 주세요.');
    if (approverIds.length > 10) throw new HttpError(400, '승인자는 최대 10명까지 지정할 수 있습니다.');
    const requestedStartDate = type === 'HOURLY' ? (parseLocalDateTime(startDateTime)?.date || '') : start;
    if (!requestedStartDate) throw new HttpError(400, '신청 시작일 또는 시작일시를 확인해 주세요.');
    if (requestedStartDate < todayIsoKst()) throw new HttpError(400, '지난 날짜는 새로 신청할 수 없습니다.');
    const calc = calculateLeave(s, u, type, start, end, startDateTime, endDateTime); start = calc.start_date; end = calc.end_date;
    const approvers = approverIds.map((id) => userById(s, id));
    if (approvers.some((a) => !userAvailable(a) || a.is_system_account || a.company_id !== u.company_id || !a.can_approve_first)) throw new HttpError(400, '승인자는 관리자 메뉴에서 “연차 승인자”로 체크된 같은 회사 재직 직원만 선택할 수 있습니다.');
    if (approvers.some((a) => a.id === u.id)) throw new HttpError(400, '신청자 본인을 승인자로 선택할 수 없습니다.');
    if (hasLeaveConflict(s, u.id, type, start, end, calc)) throw new HttpError(400, '같은 날짜 또는 시간대에 이미 등록되거나 신청 중인 연차가 있습니다.');
    const t = nowIso();
    const approvalSteps = approvers.map((a, index) => ({ order: index + 1, approver_id: a.id, role: index === approvers.length - 1 ? 'REPRESENTATIVE' : 'APPROVER', status: index === 0 ? 'PENDING' : 'WAITING', action_at: null, comment: '' }));
    const finalApprover = approvers[approvers.length - 1];
    const rec = {
      id: s.counters.request++, user_id: u.id, approver1_id: approvers[0].id, final_approver_id: finalApprover.id,
      approval_steps: approvalSteps, approval_state: 'PENDING',
      leave_type: type, start_date: start, end_date: end, start_time: calc.start_time, end_time: calc.end_time,
      start_datetime: calc.start_datetime || '', end_datetime: calc.end_datetime || '',
      charge_dates: calc.charge_dates, hourly_segments: calc.hourly_segments || null, minutes:calc.minutes, days: calc.days, hours: calc.hours, reason, status1: 'PENDING', status_final: 'WAITING',
      reject_reason: '', source: 'APPLICATION', source_note: '', created_at: t, updated_at: t,
      approved1_at: null, final_approved_at: null, cancelled_at: null
    };
    normalizeCharge(rec); s.requests.push(rec); await saveState(env, version, s);
    return json({ ok: true, id: rec.id, days: rec.days, hours: rec.hours, excluded_dates: calc.excluded_dates, start_time: rec.start_time, end_time: rec.end_time, start_datetime: rec.start_datetime, end_datetime: rec.end_datetime, approval_steps: requestRow(s, rec).approval_line });
  }
  if (method === 'GET' && pathname === '/api/my-requests') {
    const u = await requireAuth(request, env, s); return json(allRequestRows(s).filter((r) => r.user_id === u.id));
  }
  p = matchPath(pathname, /^\/api\/requests\/(\d+)\/cancel$/);
  if (method === 'POST' && p) {
    const u = await requireAuth(request, env, s), r = s.requests.find((x) => x.id === Number(p[0]));
    if (!r || r.user_id !== u.id) throw new HttpError(404, '신청내역을 찾을 수 없습니다.');
    if (r.source !== 'APPLICATION') throw new HttpError(400, '기존 엑셀 이관자료는 취소할 수 없습니다.');
    if (approvalStateOf(r) === 'APPROVED') throw new HttpError(400, '최종 승인된 신청은 사용자가 취소할 수 없습니다. 관리자에게 문의해 주세요.');
    if (['REJECTED', 'CANCELLED'].includes(approvalStateOf(r))) throw new HttpError(400, '이미 처리된 신청입니다.');
    for (const step of r.approval_steps || []) if (['PENDING', 'WAITING'].includes(step.status)) step.status = 'CANCELLED';
    r.approval_state = 'CANCELLED'; r.status1 = 'CANCELLED'; r.status_final = 'CANCELLED';
    r.cancelled_at = nowIso(); r.updated_at = r.cancelled_at;
    await saveState(env, version, s); return json({ ok: true });
  }
  if (method === 'GET' && pathname === '/api/inbox') {
    const u = await requireAuth(request, env, s);
    const rows = allRequestRows(s).filter((r) => r.source === 'APPLICATION' && r.current_approval?.approver_id === u.id);
    return json(rows.map((r) => ({ ...r, stage: r.current_approval?.role === 'REPRESENTATIVE' ? 'REPRESENTATIVE' : 'APPROVER', stage_order: r.current_approval?.order || 0 })));
  }
  if (method === 'GET' && pathname === '/api/inbox/history') {
    const u = await requireAuth(request, env, s);
    const rows = allRequestRows(s).map((r) => {
      const mine = (r.approval_line || []).filter((step) => step.approver_id === u.id && ['APPROVED', 'REJECTED'].includes(step.status));
      if (!mine.length) return null;
      const last = mine[mine.length - 1];
      return { ...r, my_step: last, my_action: last.status, my_action_at: last.action_at, my_comment: last.comment || '' };
    }).filter(Boolean).sort((a, b) => comparePeople(a,b) || String(b.my_action_at || '').localeCompare(String(a.my_action_at || '')));
    return json(rows);
  }
  p = matchPath(pathname, /^\/api\/requests\/(\d+)\/action$/);
  if (method === 'POST' && p) {
    const u = await requireAuth(request, env, s), r = s.requests.find((x) => x.id === Number(p[0]));
    if (!r || r.source !== 'APPLICATION') throw new HttpError(404, '처리할 신청을 찾을 수 없습니다.');
    const action = cleanText(body.action, 20), reason = cleanText(body.reason, 500), t = nowIso();
    if (!['approve', 'reject'].includes(action)) throw new HttpError(400, '처리 구분을 확인해 주세요.');
    const step = currentApprovalStep(r);
    if (!step) throw new HttpError(400, '현재 처리할 승인단계가 없습니다.');
    if (step.approver_id !== u.id) throw new HttpError(403, '현재 승인순서의 승인자가 아닙니다.');
    if (!(u.can_approve_first || u.is_admin)) {
      throw new HttpError(403, '결재자 권한이 필요합니다.');
    }
    if (action === 'reject' && !reason) throw new HttpError(400, '반려 사유를 입력해 주세요.');
    step.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
    step.action_at = t; step.comment = action === 'reject' ? reason : '';
    if(action==='reject')for(const x of r.approval_steps)if(x.order>step.order&&['WAITING','PENDING'].includes(x.status))x.status='WAITING';
    if (action === 'approve') {
      const next = r.approval_steps.find((x) => x.order === step.order + 1);
      if (next && next.status === 'WAITING') next.status = 'PENDING';
    }
    r.updated_at = t; syncLegacyApprovalFields(r);
    await saveState(env, version, s);
    return json({ ok: true, request: requestRow(s, r) });
  }

  if (method === 'GET' && pathname === '/api/admin/stats') {
    await requireAdmin(request, env, s);
    const cid = numberId(url.searchParams.get('company_id')), employment = cleanText(url.searchParams.get('employment') || 'current', 20);
    const users = s.users.filter((u) => !u.is_system_account && !u.deleted && employmentMatches(u, employment) && (!cid || u.company_id === cid));
    const ids = new Set(users.map((u) => u.id)), rs = s.requests.filter((r) => ids.has(r.user_id)), cy = todayIsoKst().slice(0, 4);
    return json({ employee_count: ids.size, pending_count: rs.filter((r) => r.source === 'APPLICATION' && approvalStateOf(r) === 'PENDING').length,
      approved_this_year: rs.filter(r=>approvalStateOf(r)==='APPROVED').reduce((sum,r)=>sum+requestMinutesInRange(r,`${cy}-01-01`,`${cy}-12-31`),0)/DAY_MINUTES,
      total_used: users.reduce((sum, u) => sum + approvedUsedDays(s, u.id), 0) });
  }
  if (method === 'GET' && pathname === '/api/users') {
    await requireAdmin(request, env, s);
    const cid = numberId(url.searchParams.get('company_id')), inc = boolValue(url.searchParams.get('include_system')),
      employment = cleanText(url.searchParams.get('employment') || 'current', 20), search = cleanText(url.searchParams.get('search'), 80).toLowerCase();
    const rows = sortUsers(s, s.users.filter((u) => {
      if (u.deleted || u.legacy_hidden) return false;
      if (u.is_system_account) return inc && [SYSTEM_ADMIN_LOGIN, REPRESENTATIVE_LOGIN].includes(u.login_id);
      if (cid && u.company_id !== cid) return false;
      if (!employmentMatches(u, employment)) return false;
      return !search || [u.employee_name, u.login_id, u.employee_code, u.department, u.position, u.retire_date].some((v) => String(v || '').toLowerCase().includes(search));
    }));
    return json(rows.map((u) => userSummary(s, u)));
  }
  if (method === 'POST' && pathname === '/api/users') {
    const actor = await requireAdmin(request, env, s);
    const cid = numberId(body.company_id), company = activeCompany(s, cid), name = cleanText(body.employee_name, 100), join = cleanText(body.join_date, 10), retire = cleanText(body.retire_date, 10);
    if (!company || !name || !parseIso(join)) throw new HttpError(400, '회사, 직원명, 입사일을 정확히 입력해 주세요.');
    if (retire && (!parseIso(retire) || retire < join)) throw new HttpError(400, '퇴사일은 입사일 이후 날짜로 입력해 주세요.');
    const requested = loginKey(body.login_id), login = requested || generateLoginId(s, name);
    if (RESERVED_LOGINS.has(login)) throw new HttpError(400, '통합관리자/대표이사 전용 로그인 ID는 직원에게 사용할 수 없습니다.');
    if (userByLogin(s, login)) throw new HttpError(400, '이미 사용 중인 로그인 ID입니다.');
    const t = nowIso(), retiredNow = Boolean(retire && retire <= todayIsoKst()), u = {
      id: s.counters.user++, company_id: cid, employee_code: cleanText(body.employee_code, 40), employee_name: name, login_id: login,
      password_hash: await passwordHash('1111'), department: cleanText(body.department, 100), position: cleanText(body.position, 100), join_date: join, retire_date: retire, phone: cleanText(body.phone, 50), note: cleanText(body.note, 500),
      is_admin: boolValue(body.is_admin), is_representative: false, can_approve_first: boolValue(body.can_approve_first), can_approve_final: false, is_system_account: false,
      active: retiredNow ? false : (body.active == null ? true : boolValue(body.active)), deleted: false, legacy_hidden: false, must_change_password: true,
      source_accrued: null, source_used: null, source_remaining: null, created_at: t, updated_at: t
    };
    Object.assign(u,staffExtras(body));u.leave_basis_date ||= join;auditStaff(s,actor,u,null,'CREATE');
    s.users.push(u); await saveState(env, version, s);
    return json({ id: u.id, login_id: u.login_id, default_password: '1111' });
  }
  p = matchPath(pathname, /^\/api\/users\/(\d+)$/);
  if (method === 'PUT' && p) {
    const actor=await requireAdmin(request, env, s); const u = userById(s, p[0]);
    const before=u?structuredClone(u):null;
    if (!u || u.deleted) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
    if (u.is_system_account) throw new HttpError(400, '관리자 시스템 계정은 직원정보 수정 대상이 아닙니다. 비밀번호 변경 또는 PW초기화를 사용해 주세요.');
    const cid = numberId(body.company_id || u.company_id); if (!activeCompany(s, cid)) throw new HttpError(400, '회사를 확인해 주세요.');
    const name = cleanText(body.employee_name, 100), login = loginKey(body.login_id), join = cleanText(body.join_date, 10), retire = cleanText(body.retire_date, 10);
    if (!name || !login || !parseIso(join)) throw new HttpError(400, '직원명, 로그인 ID, 입사일은 필수입니다.');
    if (retire && (!parseIso(retire) || retire < join)) throw new HttpError(400, '퇴사일은 입사일 이후 날짜로 입력해 주세요.');
    if (RESERVED_LOGINS.has(login)) throw new HttpError(400, '통합관리자/대표이사 전용 로그인 ID는 직원에게 사용할 수 없습니다.');
    if (s.users.some((x) => !x.deleted && !x.legacy_hidden && loginKey(x.login_id) === login && x.id !== u.id)) throw new HttpError(400, '이미 사용 중인 로그인 ID입니다.');
    const retiredNow = Boolean(retire && retire <= todayIsoKst()), requestedActive = body.active == null ? u.active : boolValue(body.active), newActive = retiredNow ? false : requestedActive;
    const wasAvailableApprover = userAvailable(u) && u.can_approve_first;
    if(actor.id===u.id && (u.is_admin||u.is_representative) && !boolValue(body.is_admin))throw new HttpError(400,'본인의 관리자 권한은 직접 해제할 수 없습니다.');
    if(u.is_representative && !boolValue(body.is_admin))throw new HttpError(400,'대표이사 계정은 관리자 권한을 유지합니다.');
    Object.assign(u, { company_id: cid, employee_code: cleanText(body.employee_code, 40), employee_name: name, login_id: login,
      department: cleanText(body.department, 100), position: cleanText(body.position, 100), join_date: join, retire_date: retire, phone: cleanText(body.phone, 50), note: cleanText(body.note, 500),
      is_admin: boolValue(body.is_admin), is_representative: Boolean(u.is_representative), can_approve_first: boolValue(body.can_approve_first), can_approve_final: Boolean(u.can_approve_final),
      is_system_account: false, active: newActive, updated_at: nowIso() });
    Object.assign(u,staffExtras(body));auditStaff(s,actor,u,before,'UPDATE');
    if (wasAvailableApprover && (!userAvailable(u) || !u.can_approve_first)) rejectPendingForUnavailableApprover(s, u.id, '승인자가 퇴사·비활성화되었거나 승인권한이 해제되어 반려 처리되었습니다. 승인자를 다시 선택하여 재신청해 주세요.');
    await saveState(env, version, s); return json({ ok: true, login_id: u.login_id, active: u.active, retire_date: u.retire_date });
  }
  if (method === 'DELETE' && p) {
    const admin = await requireSuperAdmin(request, env, s), u = userById(s, p[0]);
    if (!u || u.deleted) throw new HttpError(404, '삭제할 직원을 찾을 수 없습니다.');
    if (u.is_system_account || u.id === admin.id) throw new HttpError(400, '관리자 시스템 계정은 삭제할 수 없습니다.');
    rejectPendingForUnavailableApprover(s, u.id, '승인자가 삭제되어 반려 처리되었습니다. 승인자를 다시 선택하여 재신청해 주세요.');
    const hasHistory = s.requests.some((r) => r.user_id === u.id || (r.approval_steps || []).some((x) => Number(x.approver_id) === u.id)) || s.adjustments.some((a) => a.user_id === u.id || a.created_by === u.id);
    if (hasHistory) {
      u.deleted = true; u.deleted_at = nowIso(); u.active = false; u.can_approve_first = false; u.original_login_id = u.original_login_id || u.login_id;
      u.login_id = `__deleted__${u.id}__${u.original_login_id}`; u.updated_at = u.deleted_at;
    } else {
      s.users = s.users.filter((x) => x.id !== u.id);
    }
    await saveState(env, version, s); return json({ ok: true, mode: hasHistory ? 'archived' : 'deleted', employee_name: u.employee_name });
  }
  p = matchPath(pathname, /^\/api\/users\/(\d+)\/reset-password$/);
  if (method === 'POST' && p) {
    await requireAdmin(request, env, s); const u = userById(s, p[0]); if (!u || u.deleted || u.legacy_hidden) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
    u.password_hash = await passwordHash('1111'); u.must_change_password = true; u.updated_at = nowIso(); await saveState(env, version, s);
    return json({ ok: true, login_id: u.login_id, password: '1111' });
  }
  p = matchPath(pathname, /^\/api\/users\/(\d+)\/adjustments$/);
  if (method === 'POST' && p) {
    const admin=await requireAdmin(request,env,s),u=userById(s,p[0]);if(!u||u.is_system_account)throw new HttpError(400,'대상 직원을 확인해 주세요.');
    let minutes;try {minutes=body.days_whole!=null?minutesFromParts(body.days_whole,body.hours_remainder||0,body.direction||1):Math.round(Number(body.amount)*DAY_MINUTES);}catch(e){throw new HttpError(400,e.message);}
    if(!Number.isFinite(minutes)||minutes===0||minutes%30!==0)throw new HttpError(400,'조정은 0이 아닌 0.5시간 단위로 입력해 주세요.');
    const reason=cleanText(body.reason,500),date=cleanText(body.effective_date||todayIsoKst(),10);if(!reason||!parseIso(date))throw new HttpError(400,'적용일과 조정 사유를 확인해 주세요.');
    const rec={id:s.counters.adjustment++,user_id:u.id,minutes,amount:minutes/DAY_MINUTES,reason,effective_date:date,created_by:admin.id,created_at:nowIso()};s.adjustments.push(rec);auditStaff(s,admin,u,null,'LEAVE_ADJUST',`${date} / ${minutes}분 / ${reason}`);await saveState(env,version,s);return json({ok:true,id:rec.id,summary:userSummary(s,u)});
  }
  if (method === 'GET' && p) { await requireAdmin(request, env, s); const uid = Number(p[0]); return json(s.adjustments.filter((x) => x.user_id === uid).sort((a, b) => b.id - a.id).map((x) => { const u = userById(s, x.user_id), m = userById(s, x.created_by); return { ...x, employee_name: u?.employee_name || '', login_id: u?.login_id || '', company_name: companyName(s, u?.company_id), created_by_name: m?.employee_name || '' }; })); }

  if (method === 'GET' && pathname === '/api/admin/renewals') {
    await requireAdmin(request, env, s); const cid = numberId(url.searchParams.get('company_id')), company = cid ? activeCompany(s, cid) : null; if (cid && !company) throw new HttpError(400, '회사를 확인해 주세요.'); const asOf = cleanText(url.searchParams.get('as_of') || todayIsoKst(), 10); if (!parseIso(asOf)) throw new HttpError(400, '기준일을 확인해 주세요.'); const month = cleanText(url.searchParams.get('month') || asOf.slice(0, 7), 7), only = boolValue(url.searchParams.get('only_unused')), dueOnly = boolValue(url.searchParams.get('due_only')); let rows = renewalRows(s, month, cid, asOf); if (only) rows = rows.filter((r) => r.unused_expiring > 0); if (dueOnly) rows = rows.filter((r) => r.anniversary_date <= asOf); return json({ month, as_of: asOf, company_name: company?.name || '전체회사', count: rows.length, rows });
  }
  if (method === 'GET' && pathname === '/api/admin/requests') { await requireAdmin(request, env, s); return json(filterAdminRequests(s, url)); }

  if (method === 'GET' && pathname === '/api/admin/work-settings') {
    await requireAdmin(request, env, s); const cid = numberId(url.searchParams.get('company_id')); if (cid) return json(getWorkSettings(s, cid)); return json(s.companies.filter((c) => c.active).map((c) => ({ company_id: c.id, company_name: c.name, ...getWorkSettings(s, c.id) })));
  }
  if (method === 'PUT' && pathname === '/api/admin/work-settings') {
    await requireAdmin(request, env, s); const cid = numberId(body.company_id); if (!activeCompany(s, cid)) throw new HttpError(400, '회사를 확인해 주세요.'); const vals = { work_start: cleanText(body.work_start, 5), lunch_start: cleanText(body.lunch_start, 5), lunch_end: cleanText(body.lunch_end, 5), work_end: cleanText(body.work_end, 5) }; if (!Object.values(vals).every(validTime)) throw new HttpError(400, '근무시간은 HH:MM 형식으로 입력해 주세요.'); if (!(vals.work_start < vals.lunch_start && vals.lunch_start < vals.lunch_end && vals.lunch_end < vals.work_end)) throw new HttpError(400, '근무 시작 < 점심 시작 < 점심 종료 < 근무 종료 순서로 입력해 주세요.'); if(!Object.values(vals).every(isThirtyMinuteTime)||timeToMinutes(vals.lunch_start)-timeToMinutes(vals.work_start)!==240||timeToMinutes(vals.work_end)-timeToMinutes(vals.lunch_end)!==240)throw new HttpError(400,'디엔엠은 1일 8시간(오전·오후 각 4시간), 30분 경계의 근무기준으로 관리합니다.'); const w = getWorkSettings(s, cid); Object.assign(w, vals, { company_id: cid, updated_at: nowIso() }); if (!s.work_settings.some((x) => Number(x.company_id) === cid)) s.work_settings.push(w); await saveState(env, version, s); return json(w);
  }
  if (method === 'GET' && pathname === '/api/admin/holidays') {
    await requireAdmin(request, env, s); const cid = numberId(url.searchParams.get('company_id')); const year = Number(url.searchParams.get('year') || todayIsoKst().slice(0, 4)); const start = `${year}-01-01`, end = `${year}-12-31`; return json({ year, rows: holidayRows(s, cid, start, end), custom: s.custom_holidays.filter((h) => !cid || !h.company_id || Number(h.company_id) === cid).sort((a, b) => a.date.localeCompare(b.date)) });
  }
  if (method === 'POST' && pathname === '/api/admin/holidays') {
    await requireAdmin(request, env, s); const cid = numberId(body.company_id), date = cleanText(body.date, 10), name = cleanText(body.name, 100); if (!parseIso(date) || !name) throw new HttpError(400, '휴일 날짜와 휴일명을 입력해 주세요.'); if (cid && !activeCompany(s, cid)) throw new HttpError(400, '회사를 확인해 주세요.'); if (s.custom_holidays.some((h) => Number(h.company_id || 0) === Number(cid || 0) && h.date === date && h.active !== false)) throw new HttpError(400, '같은 범위와 날짜의 추가휴일이 이미 등록되어 있습니다.'); const rec = { id: s.counters.holiday++, company_id: cid, date, name, active: true, created_at: nowIso(), updated_at: nowIso() }; s.custom_holidays.push(rec); await saveState(env, version, s); return json(rec);
  }
  p = matchPath(pathname, /^\/api\/admin\/holidays\/(\d+)$/);
  if (method === 'DELETE' && p) { await requireAdmin(request, env, s); const h = s.custom_holidays.find((x) => x.id === Number(p[0])); if (!h) throw new HttpError(404, '추가휴일을 찾을 수 없습니다.'); h.active = false; h.updated_at = nowIso(); await saveState(env, version, s); return json({ ok: true }); }

  if (method === 'GET' && pathname === '/api/admin/export-data') {
    await requireAdmin(request, env, s);
    const cid = numberId(url.searchParams.get('company_id')), company = cid ? activeCompany(s, cid) : null,
      employment = cleanText(url.searchParams.get('employment') || 'all', 20);
    if (cid && !company) throw new HttpError(400, '회사를 확인해 주세요.');
    const selected = sortUsers(s, s.users.filter((u) => !u.is_system_account && !u.deleted && employmentMatches(u, employment) && (!cid || u.company_id === cid)));
    const accounts = sortUsers(s, s.users.filter((u) => !u.deleted && !u.legacy_hidden && (u.is_system_account ? [SYSTEM_ADMIN_LOGIN, REPRESENTATIVE_LOGIN].includes(u.login_id) : employmentMatches(u, employment)) && (!cid || u.company_id === cid || u.company_id == null)));
    const userSummaries = selected.map((u) => userSummary(s, u)), accountSummaries = accounts.map((u) => userSummary(s, u)), ids = new Set(selected.map((u) => u.id));
    const requestRows = allRequestRows(s).filter((r) => ids.has(r.user_id));
    const adjustmentRows = s.adjustments.filter((r) => ids.has(r.user_id)).map((r) => { const u = userById(s, r.user_id), m = userById(s, r.created_by); return { ...r, employee_name: u?.employee_name || '', login_id: u?.original_login_id || u?.login_id || '', company_name: companyName(s, u?.company_id), department: u?.department || '', position: u?.position || '', join_date: u?.join_date || '', is_representative: Boolean(u?.is_representative), created_by_name: m?.employee_name || '' }; }).sort((a,b)=>comparePeople(a,b)||b.id-a.id);
    const companyNameValue = company?.name || '전체회사', asOf = todayIsoKst(), currentMonth = asOf.slice(0, 7), renewalRowsValue = renewalRows(s, currentMonth, cid, asOf);
    return json({ userSummaries, accountSummaries, requestRows, adjustmentRows, renewalRows: renewalRowsValue, workSettings: cid ? [getWorkSettings(s, cid)] : s.work_settings,
      customHolidays: s.custom_holidays, companyName: companyNameValue, employment, asOf });
  }

  if (method === 'POST' && pathname === '/api/admin/import-excel') {
    await requireAdmin(request, env, s); const form = await request.formData(); const file = form.get('file'); if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, '업로드할 Excel 파일을 선택해 주세요.'); if (Number(file.size || 0) > 8 * 1024 * 1024) throw new HttpError(400, 'Excel 파일은 8MB 이하로 업로드해 주세요.');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await file.arrayBuffer()));
    const result = { users_created: 0, users_updated: 0, usage_created: 0, skipped:0, errors: [] };
    const wsUsers = wb.getWorksheet('직원등록') || wb.worksheets.find((x) => x.name.includes('직원'));
    if (wsUsers) for (const row of worksheetRows(wsUsers)) {
      try {
        const cname = cleanText(pick(row, ['회사', '회사명']), 100), cid = findCompanyIdByName(s, cname), name = cleanText(pick(row, ['직원명', '성명', '이름']), 100), join = excelDate(pick(row, ['입사일'])), retire = excelDate(pick(row, ['퇴사일']));
        if (!cid || !name || !parseIso(join)) throw new Error('회사·직원명·입사일 확인');
        if (retire && retire < join) throw new Error('퇴사일 확인');
        const requested = loginKey(pick(row, ['로그인 ID', '로그인ID', 'ID'])); let u = requested ? userByLogin(s, requested) : null;
        if (!u) {
          const login = requested || generateLoginId(s, name), t = nowIso();
          if (RESERVED_LOGINS.has(login)) throw new Error('시스템 전용 로그인 ID');
          u = { id: s.counters.user++, company_id: cid, employee_code: cleanText(pick(row, ['사원코드', '사번']), 40), employee_name: name, login_id: login,
            password_hash: await passwordHash('1111'), department: cleanText(pick(row, ['부서']), 100), position: cleanText(pick(row, ['직급', '직책']), 100), join_date: join, retire_date: retire || '',
            is_admin: false, can_approve_first: boolValue(pick(row, ['승인자', '연차 승인자', '1차 승인자', '1차승인자'])), can_approve_final: false, is_representative: false, is_system_account: false,
            active: retire && retire <= todayIsoKst() ? false : (pick(row, ['사용여부', '계정상태']) === '' ? true : !['중지', 'N', '아니오', '0'].includes(String(pick(row, ['사용여부', '계정상태'])).trim())),
            deleted: false, legacy_hidden: false, must_change_password: true, source_accrued: null, source_used: null, source_remaining: null, created_at: t, updated_at: t };
          s.users.push(u); result.users_created += 1;
        } else {
          Object.assign(u, { company_id: cid, employee_code: cleanText(pick(row, ['사원코드', '사번']) || u.employee_code, 40), employee_name: name,
            department: cleanText(pick(row, ['부서']) || u.department, 100), position: cleanText(pick(row, ['직급', '직책']) || u.position, 100), join_date: join, retire_date: retire || '',
            is_admin: Boolean(u.is_admin), can_approve_first: pick(row, ['승인자','연차 승인자'])==='' ? Boolean(u.can_approve_first) : boolValue(pick(row,['승인자','연차 승인자'])), can_approve_final: Boolean(u.can_approve_final), is_representative: Boolean(u.is_representative),
            active: retire && retire <= todayIsoKst() ? false : u.active, updated_at: nowIso() }); result.users_updated += 1;
        }
      } catch (e) { result.errors.push(`직원등록 ${row.rowNo}행: ${e.message}`); }
    }
    const wsUsage = wb.getWorksheet('사용내역등록') || wb.worksheets.find((x) => x.name.includes('사용내역'));
    if (wsUsage) for (const row of worksheetRows(wsUsage)) {
      try {
        const cname = cleanText(pick(row, ['회사', '회사명']), 100), cid = findCompanyIdByName(s, cname); if (!cid) throw new Error('회사 확인'); const login = cleanText(pick(row, ['로그인 ID', '로그인ID', 'ID']), 80), ename = cleanText(pick(row, ['직원명', '성명', '이름']), 100); let u = login ? userByLogin(s, login) : s.users.find((x) => x.company_id === cid && x.employee_name === ename && !x.is_system_account); if (!u) throw new Error('직원 확인');
        const label = cleanText(pick(row, ['구분', '사용구분']), 30), map = { '오전 반차': 'AM_HALF', '오전반차': 'AM_HALF', '오후 반차': 'PM_HALF', '오후반차': 'PM_HALF', '반차': 'HALF_IMPORTED', '연차': 'FULL', '하루': 'FULL', '기간': 'FULL', '시간단위':'HOURLY', '시간 연차':'HOURLY' }; const type = map[label] || 'FULL'; const start = excelDate(pick(row, ['시작일', '사용일', '일자'])), end = excelDate(pick(row, ['종료일'])) || start; if (!parseIso(start) || !parseIso(end)) throw new Error('사용일 확인'); let days;let calc=null;
        if(Object.hasOwn(row,'일수(정수)')||Object.hasOwn(row,'시간(나머지)'))days=minutesFromParts(pick(row,['일수(정수)'])||0,pick(row,['시간(나머지)'])||0)/DAY_MINUTES;
        else days=Number(pick(row,['일수','사용일수']));
        if(!Number.isFinite(days)||days<=0){calc=calculateLeave(s,u,type==='HALF_IMPORTED'?'AM_HALF':type,start,end,`${start}T${pick(row,['시작시간'])}`,`${end}T${pick(row,['종료시간'])}`);days=calc.days;}
        if(days<=0||Math.round(days*DAY_MINUTES)%30!==0)throw new Error('사용량은 0보다 큰 0.5시간 단위여야 합니다.');
        const importKey=`${u.id}|${type}|${start}|${end}|${Math.round(days*DAY_MINUTES)}|${pick(row,['시작시간'])}|${pick(row,['종료시간'])}`;
        if(s.requests.some(r=>r.import_key===importKey)){result.skipped++;continue;}
        const t = nowIso(), rec = { id: s.counters.request++, user_id: u.id, approver1_id: null, final_approver_id: null, leave_type: type, start_date: start, end_date: type.includes('HALF') ? start : end, import_key:importKey, start_time: calc?.start_time || cleanText(pick(row,['시작시간']),5), end_time: calc?.end_time || cleanText(pick(row,['종료시간']),5), charge_dates: calc?.charge_dates || null, days: Number(days), minutes:Math.round(Number(days)*DAY_MINUTES), reason: cleanText(pick(row, ['사유', '신청사유']) || 'Excel 업로드 이관', 500), status1: 'APPROVED', status_final: 'APPROVED', reject_reason: '', source: 'EXCEL_UPLOAD', source_note: cleanText(pick(row, ['자료설명', '비고']) || file.name, 300), created_at: t, updated_at: t, approved1_at: t, final_approved_at: t, cancelled_at: null }; s.requests.push(rec); result.usage_created += 1;
      } catch (e) { result.errors.push(`사용내역등록 ${row.rowNo}행: ${e.message}`); }
    }
    if (!wsUsers && !wsUsage) throw new HttpError(400, 'Excel에 “직원등록” 또는 “사용내역등록” 시트가 없습니다. 시스템의 업로드 양식을 사용해 주세요.');
    await saveState(env, version, s); return json(result);
  }

  // Do not leave a legacy endpoint that replaces the workforce, passwords and approvals
  // with bundled seed data. All test cleanups use the backup-verified workflow below.
  if (method === 'POST' && pathname === '/api/admin/reset-initial') {
    await requireAdmin(request, env, s);
    throw new HttpError(410, '전체 초기자료 재설정은 비활성화되었습니다. Excel·백업 → 테스트자료 일괄삭제를 이용해 직원명부를 보존해 주세요.');
  }

  if (method === 'GET' && pathname === '/api/admin/test-clear/preview') {
    await requireAdmin(request, env, s);
    return json({
      count: { requests: s.requests.length, adjustments: s.adjustments.length, cycle_grants: s.cycle_grants.length },
      retained: {
        employees: s.users.filter((u) => !u.is_system_account && !u.deleted).length,
        companies: s.companies.length, work_settings: s.work_settings.length,
        holidays: s.custom_holidays.length, staff_audit: s.staff_audit.length
      },
      reset_history: (s.test_clear_history || []).slice(-5).reverse(),
      note: '연차신청·결재와 사용내역 이관, 연차 가감조정만 기본 삭제합니다. 확정 발생량은 별도 선택 시 삭제하며 직원·계정·명부·근무시간·휴일은 보존합니다.'
    });
  }

  if (method === 'POST' && pathname === '/api/admin/test-clear') {
    const actor = await requireAdmin(request, env, s);
    if (body.confirmation_phrase !== '테스트자료삭제' || body.confirm_data_loss !== true)
      throw new HttpError(400, '삭제 확인 문구와 자료삭제 동의를 모두 입력해 주세요.');
    if (!await verifyPassword(String(body.password || ''), actor.password_hash))
      throw new HttpError(403, '관리자 본인 비밀번호가 일치하지 않습니다.');
    const downloadedHash = String(body.backup_sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(downloadedHash))
      throw new HttpError(400, '반드시 운영자료 JSON 백업을 다운로드하여 다시 선택한 후 진행해 주세요.');
    const serialized = JSON.stringify(s, null, 2);
    const originalHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(serialized)));
    if (downloadedHash !== originalHash)
      throw new HttpError(409, '검증한 백업파일이 현재 운영자료와 다릅니다. 새 JSON 백업을 받아 다시 확인해 주세요.');

    const counts = { requests: s.requests.length, adjustments: s.adjustments.length, cycle_grants: s.cycle_grants.length };
    const clearGrants = body.clear_cycle_grants === true;
    if (!counts.requests && !counts.adjustments && !(clearGrants && counts.cycle_grants))
      throw new HttpError(400, '선택한 삭제 대상에 데이터가 없습니다.');
    // A second, site-scoped recovery copy is made BEFORE any destructive state change.
    // The downloadable backup selected by the user is also independently retained.
    if (!env.resetBackupStore || typeof env.resetBackupStore.setJSON !== 'function')
      throw new HttpError(503, '서버 안전 백업 저장소를 이용할 수 없어 삭제 작업을 중단했습니다.');
    const snapshotKey = `pre-test-clear-${nowIso().replace(/[:.]/g, '-')}-${randomHex(8)}`;
    const recordedAt = nowIso();
    const saved = await env.resetBackupStore.setJSON(snapshotKey, s, {
      onlyIfNew: true,
      metadata: { created_at: recordedAt, actor_id: actor.id, kind: 'pre-test-clear' }
    });
    if (!saved?.modified) throw new HttpError(503, '삭제 전 서버 안전 백업에 실패했습니다. 자료는 삭제되지 않았습니다.');
    s.requests = [];
    s.adjustments = [];
    if (clearGrants) s.cycle_grants = [];
    const audit = {
      at: recordedAt, actor_id: actor.id, actor_name: actor.employee_name,
      backup_key: snapshotKey, counts, cycle_grants_deleted: clearGrants, backup_sha256: originalHash
    };
    s.test_clear_history ||= [];
    s.test_clear_history.push(audit);
    await saveState(env, version, s);
    return json({ ok: true, deleted: { requests: counts.requests, adjustments: counts.adjustments, cycle_grants: clearGrants ? counts.cycle_grants : 0 },
      preserved: { employees: s.users.filter((u) => !u.is_system_account && !u.deleted).length, companies: s.companies.length },
      backup_key: snapshotKey, completed_at: recordedAt });
  }

  if (method === 'GET' && pathname === '/api/admin/test-clear/recovery') {
    await requireAdmin(request, env, s);
    const key = cleanText(url.searchParams.get('key'), 140);
    if (!(s.test_clear_history || []).some((r) => r.backup_key === key))
      throw new HttpError(404, '서버 보관 백업을 찾을 수 없습니다.');
    const snapshot = await env.resetBackupStore.get(key, { type: 'json', consistency: 'strong' });
    if (!snapshot) throw new HttpError(404, '서버에 보관된 백업을 찾을 수 없습니다.');
    return fileResponse(enc.encode(JSON.stringify(snapshot, null, 2)), 'application/json; charset=utf-8', `DNM_삭제전_서버백업_${key}.json`);
  }

  if (method === 'GET' && (pathname === '/api/admin/backup.json' || pathname === '/api/admin/backup.db')) { await requireAdmin(request, env, s); return fileResponse(enc.encode(JSON.stringify(s, null, 2)), 'application/json; charset=utf-8', `연차관리_자료백업_${todayIsoKst()}.json`); }
  if (method === 'POST' && pathname === '/api/admin/restore') {
    await requireAdmin(request, env, s); const incoming = body.state; if (!incoming || !Array.isArray(incoming.users) || !Array.isArray(incoming.requests) || !Array.isArray(incoming.companies)) throw new HttpError(400, '올바른 연차관리 백업 JSON 파일이 아닙니다.'); const restored = ensureStateShape(structuredClone(incoming)); await saveState(env, version, restored); return json({ ok: true, users: restored.users.length, requests: restored.requests.length });
  }

  throw new HttpError(404, 'API 주소를 찾을 수 없습니다.');
}

export default async function handler(request, context) {
  const env = {
    stateStore: getStore({ name: 'leave-manager-data', consistency: 'strong' }),
    sessionStore: getStore({ name: 'leave-manager-sessions', consistency: 'strong' }),
    resetBackupStore: getStore({ name: 'leave-manager-reset-backups', consistency: 'strong' })
  };
  try { return await handle({ request, env }); }
  catch (error) { const status = error instanceof HttpError ? error.status : 500; if (status >= 500) console.error(error); return json({ error: error?.message || '서버 처리 중 오류가 발생했습니다.' }, status); }
}

export const config = { path: '/api/*' };

export { handle, ensureStateShape, userSummary, calculateLeave, renewalRows, passwordHash };
