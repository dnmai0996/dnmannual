/**
 * DNM employee-oriented lists: company → executives → department → title → join date.
 * Unknown departments follow known departments in 가나다 order; ties use name and ID.
 * This source is shared by the browser and Netlify Functions to keep sorting identical.
 */
const KO = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });

export const DNM_DEPARTMENT_ORDER = Object.freeze([
  '대표이사', '관리', '영업', '연구개발', '생산기술', '생산', '품질', '기타'
]);

function norm(v) { return String(v ?? '').normalize('NFKC').replace(/[\s·ㆍ]/g, '').toLowerCase(); }

export function departmentGroup(person) {
  const d = norm(person?.department);
  if (!d) return { priority: 99, label: '' };
  if (/(대표이사|임원|경영진)/.test(d)) return { priority: 0, label: '대표이사' };
  if (/(관리|총무|인사|경영지원)/.test(d)) return { priority: 1, label: '관리' };
  if (/(영업|영업부)/.test(d)) return { priority: 2, label: '영업' };
  if (/(연구개발|연구소|기술연구)/.test(d)) return { priority: 3, label: '연구개발' };
  if (/(생산\/기술|생산기술|기술팀)/.test(d)) return { priority: 4, label: '생산기술' };
  if (/(생산|제조|가공)/.test(d)) return { priority: 5, label: '생산' };
  if (/(품질|검사|qc)/.test(d)) return { priority: 6, label: '품질' };
  return { priority: 7, label: d };
}

export function titleRank(person) {
  const p = norm(person?.position);
  if (person?.is_system_account || norm(person?.login_id) === 'admin') return 90;
  if (person?.is_representative || /대표이사|회장|사장$/.test(p)) return 0;
  if (p.includes('부사장')) return 1;
  if (p.includes('전무')) return 2;
  if (p.includes('상무')) return 3;
  if (p.includes('이사')) return 4;
  if (p.includes('공장장')) return 5;
  if (p.includes('본부장')) return 6;
  if (p.includes('실장')) return 7;
  if (p.includes('팀장')) return 8;
  if (p.includes('직장')) return 9;
  if (p.includes('부장')) return 10;
  if (p.includes('차장')) return 11;
  if (p.includes('과장')) return 12;
  if (p.includes('대리')) return 13;
  if (p.includes('주임')) return 14;
  if (p.includes('사원')) return 15;
  return 80;
}

function executiveFlag(u) {
  const rank = titleRank(u);
  return rank <= 5 ? 0 : 1;
}

function getDate(person) {
  const v = String(person?.join_date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '9999-12-31';
}

export function comparePeople(a, b) {
  const companyDiff = KO.compare(a?.company_name || String(a?.company_id || ''), b?.company_name || String(b?.company_id || ''));
  if (companyDiff) return companyDiff;
  const systemDiff = Number(Boolean(a?.is_system_account || norm(a?.login_id) === 'admin')) - Number(Boolean(b?.is_system_account || norm(b?.login_id) === 'admin'));
  if (systemDiff) return systemDiff;
  const execDiff = executiveFlag(a) - executiveFlag(b);
  if (execDiff) return execDiff;
  const ga = departmentGroup(a), gb = departmentGroup(b);
  const departmentDiff = ga.priority - gb.priority || KO.compare(ga.label, gb.label) || KO.compare(a?.department || '', b?.department || '');
  if (departmentDiff) return departmentDiff;
  const jobDiff = titleRank(a) - titleRank(b);
  if (jobDiff) return jobDiff;
  const dateDiff = getDate(a).localeCompare(getDate(b));
  if (dateDiff) return dateDiff;
  return KO.compare(a?.employee_name || a?.applicant_name || '', b?.employee_name || b?.applicant_name || '')
    || KO.compare(a?.employee_code || a?.login_id || String(a?.id || ''), b?.employee_code || b?.login_id || String(b?.id || ''));
}

export function sortPeople(rows) { return [...rows].sort(comparePeople); }

export const DNM_SORT_LABEL = '임원 우선 → 부서순(관리·영업·연구개발·생산기술·생산·품질) → 직책순 → 입사일 오름차순';
