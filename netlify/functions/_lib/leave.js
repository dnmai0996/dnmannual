const DAY_MS = 24 * 60 * 60 * 1000;

function parseIso(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt;
}

function isoFromDate(dt) {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function todayIsoKst(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(iso, amount) {
  const dt = parseIso(iso);
  if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(amount));
  return isoFromDate(dt);
}

function addMonths(iso, amount) {
  const dt = parseIso(iso);
  if (!dt) return null;
  const originalDay = dt.getUTCDate();
  const total = dt.getUTCFullYear() * 12 + dt.getUTCMonth() + Number(amount);
  const year = Math.floor(total / 12);
  const monthIndex = ((total % 12) + 12) % 12;
  const day = Math.min(originalDay, daysInMonth(year, monthIndex + 1));
  return isoFromDate(new Date(Date.UTC(year, monthIndex, day)));
}

function completedMonths(joinDate, asOfDate) {
  const join = parseIso(joinDate);
  const asOf = parseIso(asOfDate);
  if (!join || !asOf || asOf < join) return 0;
  let months = (asOf.getUTCFullYear() - join.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - join.getUTCMonth());
  if (addMonths(joinDate, months) > asOfDate) months -= 1;
  return Math.max(0, months);
}

function completedYears(joinDate, asOfDate) {
  return Math.floor(completedMonths(joinDate, asOfDate) / 12);
}

function annualEntitlementForServiceYear(serviceYear) {
  if (serviceYear < 1) return 0;
  return Math.min(25, 15 + Math.floor((serviceYear - 1) / 2));
}

// 과거자료 확인용 누적 발생량입니다. 현재 잔여 계산에는 사용하지 않습니다.
function cumulativeGranted(joinDate, asOfDate = todayIsoKst()) {
  const months = completedMonths(joinDate, asOfDate);
  if (months < 1) return 0;
  const years = completedYears(joinDate, asOfDate);
  if (years < 1) return Math.min(11, months);
  let total = 11;
  for (let serviceYear = 1; serviceYear <= years; serviceYear += 1) {
    total += annualEntitlementForServiceYear(serviceYear);
  }
  return total;
}

function currentEntitlement(joinDate, asOfDate = todayIsoKst()) {
  const months = completedMonths(joinDate, asOfDate);
  const years = completedYears(joinDate, asOfDate);
  if (months < 1) return 0;
  if (years < 1) return Math.min(11, months);
  return annualEntitlementForServiceYear(years);
}

// 입사일 기준 1년 단위 연차 주기입니다.
// 1년 미만: 입사일~첫 입사기념일 전날, 매월 1일씩(최대 11일)
// 1년 이상: 매 입사기념일에 해당 근속연도의 연차를 새로 생성합니다.
function serviceCycle(joinDate, asOfDate = todayIsoKst()) {
  if (!parseIso(joinDate) || !parseIso(asOfDate)) return null;
  if (asOfDate < joinDate) {
    return {
      service_year: 0,
      cycle_start: joinDate,
      cycle_end: addDays(addMonths(joinDate, 12), -1),
      next_anniversary: addMonths(joinDate, 12),
      granted: 0,
      next_entitlement: 15
    };
  }
  const years = completedYears(joinDate, asOfDate);
  if (years < 1) {
    return {
      service_year: 0,
      cycle_start: joinDate,
      cycle_end: addDays(addMonths(joinDate, 12), -1),
      next_anniversary: addMonths(joinDate, 12),
      granted: Math.min(11, completedMonths(joinDate, asOfDate)),
      next_entitlement: 15
    };
  }
  const cycleStart = addMonths(joinDate, years * 12);
  const nextAnniversary = addMonths(joinDate, (years + 1) * 12);
  return {
    service_year: years,
    cycle_start: cycleStart,
    cycle_end: addDays(nextAnniversary, -1),
    next_anniversary: nextAnniversary,
    granted: annualEntitlementForServiceYear(years),
    next_entitlement: annualEntitlementForServiceYear(years + 1)
  };
}

function anniversaryInYear(joinDate, year) {
  const join = parseIso(joinDate);
  const targetYear = Number(year);
  if (!join || !Number.isInteger(targetYear) || targetYear <= join.getUTCFullYear()) return null;
  return addMonths(joinDate, (targetYear - join.getUTCFullYear()) * 12);
}

function priorCycleForAnniversary(joinDate, anniversaryDate) {
  if (!parseIso(joinDate) || !parseIso(anniversaryDate) || anniversaryDate <= joinDate) return null;
  const serviceYearsAtAnniversary = completedYears(joinDate, anniversaryDate);
  if (serviceYearsAtAnniversary < 1) return null;
  const previousServiceYear = serviceYearsAtAnniversary - 1;
  const cycleStart = previousServiceYear === 0 ? joinDate : addMonths(joinDate, previousServiceYear * 12);
  return {
    anniversary_date: anniversaryDate,
    completed_years: serviceYearsAtAnniversary,
    prior_service_year: previousServiceYear,
    prior_cycle_start: cycleStart,
    prior_cycle_end: addDays(anniversaryDate, -1),
    prior_granted: previousServiceYear === 0 ? 11 : annualEntitlementForServiceYear(previousServiceYear),
    new_entitlement: annualEntitlementForServiceYear(serviceYearsAtAnniversary)
  };
}

function tenureLabel(joinDate, asOfDate = todayIsoKst()) {
  const months = completedMonths(joinDate, asOfDate);
  return `${Math.floor(months / 12)}년 ${months % 12}개월`;
}

function isWeekday(iso) {
  const dt = parseIso(iso);
  if (!dt) return false;
  const day = dt.getUTCDay();
  return day !== 0 && day !== 6;
}

function countBusinessDays(startDate, endDate) {
  const start = parseIso(startDate);
  const end = parseIso(endDate);
  if (!start || !end || end < start) return 0;
  let count = 0;
  for (let current = start.getTime(); current <= end.getTime(); current += DAY_MS) {
    const day = new Date(current).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function datesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

function normalizeLoginBase(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/\(\d+\)$/u, '') || '사용자';
}

function roundHalf(value) {
  return Math.round((Number(value) + Number.EPSILON) * 2) / 2;
}

export { parseIso, todayIsoKst, addDays, addMonths, completedMonths, completedYears, annualEntitlementForServiceYear, cumulativeGranted, currentEntitlement, serviceCycle, anniversaryInYear, priorCycleForAnniversary, tenureLabel, isWeekday, countBusinessDays, datesOverlap, normalizeLoginBase, roundHalf };
