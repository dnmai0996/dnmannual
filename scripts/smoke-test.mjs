import { INITIAL_STATE } from '../netlify/functions/_lib/initial-state.js';

const employees = INITIAL_STATE.users.filter((u) => !u.is_system_account && !u.deleted);
const admin = INITIAL_STATE.users.find((u) => u.login_id === 'admin' && u.is_admin && u.is_system_account);
const ceo = INITIAL_STATE.users.find((u) => u.employee_name === '김정배');
if (!admin) throw new Error('admin system account missing');
if (!admin.password_hash?.startsWith('pbkdf2$100000$')) throw new Error('admin password hash invalid');
if (employees.length < 40) throw new Error(`employee seed too small: ${employees.length}`);
if (!ceo?.is_admin) throw new Error('CEO admin authority missing');
if (!employees.some((u) => u.can_approve_first)) throw new Error('approver seed missing');
console.log(`DNM smoke test OK: employees=${employees.length}, admin=${admin.login_id}, CEO=${ceo.login_id}`);
