import { serviceCycle, addMonths, addDays, parseIso, todayIsoKst, completedYears } from './leave.js';

// DNM's presentation/accounting unit: 1 leave day = 8 hours, minimum new unit = 30 minutes.
export const DAY_MINUTES = 480;
export const HALF_HOUR = 30;
export function parts(minutes = 0) {
  const n = Math.round(Number(minutes) || 0), a = Math.abs(n);
  return { minutes: n, sign: n < 0 ? -1 : 1, days: Math.floor(a / DAY_MINUTES), hours: (a % DAY_MINUTES) / 60, total_hours: n / 60 };
}
export function minutesFromParts(days, hours, direction = 1) {
  const d = Number(days), h = Number(hours);
  if (!Number.isInteger(d) || d < 0 || !Number.isFinite(h) || h < 0 || h >= 8 || h * 2 !== Math.round(h * 2)) {
    throw new Error('일수는 0 이상의 정수, 시간은 0~7.5시간(0.5시간 단위)으로 입력해 주세요.');
  }
  return (d * DAY_MINUTES + h * 60) * (Number(direction) < 0 ? -1 : 1);
}
export function normalizeCharge(r) {
  if (!Number.isFinite(r.minutes)) {
    r.minutes = Math.round(r.hours != null && Number.isFinite(Number(r.hours)) ? Number(r.hours) * 60 : Number(r.days || 0) * DAY_MINUTES);
  }
  r.minutes = Math.round(r.minutes);
  r.hours = r.minutes / 60;
  r.days = r.minutes / DAY_MINUTES; // compatibility only; never round to 0.5 day
  if (!Array.isArray(r.day_charges)) {
    const map = new Map();
    if (Array.isArray(r.hourly_segments) && r.hourly_segments.length) {
      for (const seg of r.hourly_segments) {
        const m = Math.round(Number(seg.minutes ?? Number(seg.hours || 0) * 60));
        if (parseIso(seg.date) && m > 0) map.set(seg.date, (map.get(seg.date) || 0) + m);
      }
    } else if (Array.isArray(r.charge_dates) && r.charge_dates.length && r.minutes === r.charge_dates.length * DAY_MINUTES) {
      for (const date of r.charge_dates) map.set(date, DAY_MINUTES);
    } else if (r.start_date && r.end_date && r.start_date !== r.end_date && r.leave_type === 'FULL') {
      let date = r.start_date, count = 0;
      while (parseIso(date) && date <= r.end_date && count++ < 400) {
        const dow = parseIso(date).getUTCDay();
        if (dow !== 0 && dow !== 6) map.set(date, DAY_MINUTES);
        date = addDays(date, 1);
      }
    }
    if ([...map.values()].reduce((a,b)=>a+b,0) !== r.minutes || !map.size) {
      map.clear();
      if (parseIso(r.start_date)) map.set(r.start_date, r.minutes);
      if (r.start_date !== r.end_date || r.leave_type === 'IMPORTED_SUMMARY') r.allocation_note = '날짜별 차감 정보가 없는 기존자료: 시작일에 귀속합니다. 관리자가 원자료를 확인해 주세요.';
    }
    r.day_charges = [...map].map(([date,minutes])=>({date,minutes}));
  }
  r.amount_parts = parts(r.minutes);
  return r;
}
export function requestMinutesInRange(r, from = null, to = null) {
  normalizeCharge(r);
  if (!from || !to) return r.minutes;
  return r.day_charges.filter(x=>x.date >= from && x.date <= to).reduce((a,x)=>a + Number(x.minutes),0);
}
export function stateOf(r) {
  if (r.approval_state === 'CANCELLED' || r.status1 === 'CANCELLED' || r.status_final === 'CANCELLED') return 'CANCELLED';
  if (r.approval_state === 'REJECTED' || r.status1 === 'REJECTED' || r.status_final === 'REJECTED') return 'REJECTED';
  if (r.approval_state === 'APPROVED' || (r.status1 === 'APPROVED' && r.status_final === 'APPROVED')) return 'APPROVED';
  return r.source === 'APPLICATION' ? 'PENDING' : 'APPROVED';
}
export function sumRequests(s, userId, state, from = null, to = null, exclude = null) {
  return s.requests.filter(r=>r.user_id === Number(userId) && r.id !== Number(exclude) && stateOf(r) === state)
    .reduce((sum,r)=>sum+requestMinutesInRange(r,from,to),0);
}
export function sumAdjustments(s, userId, from = null, to = null) {
  return s.adjustments.filter(x=>x.user_id === Number(userId) && (!from || !to || ((x.effective_date || x.created_at?.slice(0,10)) >= from && (x.effective_date || x.created_at?.slice(0,10)) <= to)))
    .reduce((sum,x)=>sum+Math.round(Number(x.minutes ?? Number(x.amount || 0)*DAY_MINUTES)),0);
}
export function basisDate(u) { return parseIso(u.leave_basis_date) ? u.leave_basis_date : u.join_date; }
export function cycleBalance(s, u, asOf = todayIsoKst()) {
  const date = parseIso(u.retire_date) && u.retire_date <= asOf ? u.retire_date : asOf;
  const c = serviceCycle(basisDate(u), date);
  if (!c) return null;
  const from = c.cycle_start, to = c.cycle_end;
  const override = (s.cycle_grants || []).find(x=>x.user_id === u.id && x.cycle_start === from);
  const granted = override ? override.minutes : c.granted * DAY_MINUTES;
  const used = sumRequests(s,u.id,'APPROVED',from,to), pending = sumRequests(s,u.id,'PENDING',from,to);
  const adjustments = sumAdjustments(s,u.id,from,to), remaining = granted + adjustments - used;
  return {...c, base_granted: c.granted, granted:granted/DAY_MINUTES, used:used/DAY_MINUTES, pending:pending/DAY_MINUTES,
    adjustments:adjustments/DAY_MINUTES, remaining:remaining/DAY_MINUTES, projected_remaining:(remaining-pending)/DAY_MINUTES,
    amounts: {granted:parts(granted),used:parts(used),pending:parts(pending),adjustments:parts(adjustments),remaining:parts(remaining),projected_remaining:parts(remaining-pending)},
    grant_override: override || null, basis_date:basisDate(u), carryover_minutes:0};
}
export function cycleHistory(s,u,asOf=todayIsoKst()) {
  const basis = basisDate(u); if (!parseIso(basis) || basis > asOf || u.is_system_account) return [];
  const end = parseIso(u.retire_date) && u.retire_date <= asOf ? u.retire_date : asOf;
  const years = Math.min(80, completedYears(basis,end)), out=[];
  for(let year=0;year<=years;year++) {
    const start=addMonths(basis,year*12), next=addMonths(basis,(year+1)*12), finish=addDays(next,-1);
    const date=finish<end?finish:end, bal=cycleBalance(s,{...u,retire_date:''},date);
    if (!bal) continue;
    const closed=next<=asOf && (!u.retire_date || next<=u.retire_date);
    const expired=closed?Math.max(0,bal.amounts.remaining.minutes):0;
    out.push({...bal,cycle_start:start,cycle_end:finish,status:closed?'기간종료':(u.retire_date && u.retire_date<=asOf?'퇴사확인':'사용중'),
      expired:parts(expired),carryover:parts(0),settlement_status:closed?'수당·소멸예외 별도확인':'-',review_note:'휴가 잔액의 이월 차단과 미사용수당 지급의무는 별개입니다.'});
  }
  return out.reverse();
}
