// Invoked by Netlify once each morning at 09:10 Korea time (00:10 UTC).
// This function is scheduled-only: no public API route and no browser secrets.
import { createSupabaseBackend } from './_lib/supabase-store.mjs';

export default async function dailyWorkerSync() {
  if (process.env.DNM_LEAVE_STORAGE !== 'supabase') return;
  const db = await createSupabaseBackend(process.env);
  const due = await db.client.rpc('dnm_leave_reconcile_due_retirements');
  if (due.error) throw new Error(`퇴사일 확인 실패: ${due.error.message}`);
  const result = await db.client.rpc('dnm_leave_process_mes_sync', { p_limit: 100 });
  if (result.error) throw new Error(`MES 작업자 연계 실패: ${result.error.message}`);
  console.log('DNM annual leave MES sync:', due.data, result.data);
}

export const config = { schedule: '10 0 * * *' };
