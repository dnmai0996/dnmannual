// Server-side ONLY. Never import this file from public/.
// Preserves the existing annual-leave API while moving its durable state to Postgres.
const te = new TextEncoder();

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function snapshotHash(value) { return sha256(canonicalJson(value)); }
export function snapshotCounts(value) {
  const fields = ['companies', 'users', 'requests', 'adjustments', 'cycle_grants', 'staff_audit',
    'roster_history', 'work_settings', 'custom_holidays', 'test_clear_history'];
  return Object.fromEntries(fields.map((f) => [f, Array.isArray(value?.[f]) ? value[f].length : 0]));
}
function assertOk(result, description) {
  if (result?.error) throw new Error(`${description}: ${result.error.message || '알 수 없는 데이터베이스 오류'}`);
  return result?.data;
}

export function buildSupabaseBackend(client) {
  const stateStore = {
    async getWithMetadata(key) {
      if (key !== 'state') throw new Error(`Unexpected state key: ${key}`);
      const row = assertOk(await client.rpc('dnm_leave_get_state'), '연차 DB 읽기');
      return row ? { data: row.payload, etag: `pg:${row.revision}`, metadata: { storage: 'Supabase Postgres' } } : null;
    },
    async get(key) { return (await this.getWithMetadata(key))?.data || null; },
    async setJSON(key, payload, opts = {}) {
      if (key !== 'state') throw new Error('연차 상태 저장소 키를 확인해 주세요.');
      if (opts.onlyIfNew) {
        const result = assertOk(await client.rpc('dnm_leave_initialize', { p_state: payload }), '연차 DB 최초 이전');
        return { modified: Boolean(result?.created), etag: `pg:${result?.revision}` };
      }
      const m = /^pg:(\d+)$/.exec(String(opts.onlyIfMatch || ''));
      if (!m) throw new Error('데이터 버전이 일치하지 않습니다. 기존 자료 보호를 위해 저장을 차단했습니다.');
      const result = assertOk(await client.rpc('dnm_leave_commit', {
        p_expected_revision: Number(m[1]), p_state: payload
      }), '연차 DB 원자적 저장');
      if (result?.modified) {
        // MES changes are queued inside the same transaction; delivery failures never erase leave data.
        const sync = await client.rpc('dnm_leave_process_mes_sync', { p_limit: 20 });
        if (sync?.error) console.error('MES worker sync delayed:', sync.error.message);
      }
      return { modified: Boolean(result?.modified), etag: result?.revision ? `pg:${result.revision}` : undefined };
    }
  };
  const sessionStore = {
    async get(key) {
      const sessionHash = await sha256(`dnm-leave-session:${key}`);
      const data = assertOk(await client.from('dnm_leave_sessions').select('payload,expires_at').eq('session_hash', sessionHash).maybeSingle(), '로그인 상태 확인');
      if (!data || Date.parse(data.expires_at) <= Date.now()) return null;
      return data.payload;
    },
    async setJSON(key, payload) {
      const sessionHash = await sha256(`dnm-leave-session:${key}`);
      const exp = Number(payload?.expires_at || 0);
      if (exp <= Date.now()) throw new Error('만료된 로그인 또는 미리보기 정보입니다.');
      assertOk(await client.from('dnm_leave_sessions').upsert({
        session_hash: sessionHash, payload, expires_at: new Date(exp).toISOString(), updated_at: new Date().toISOString()
      }, { onConflict: 'session_hash' }), '로그인 정보 저장');
      return { modified: true };
    },
    async delete(key) {
      const sessionHash = await sha256(`dnm-leave-session:${key}`);
      assertOk(await client.from('dnm_leave_sessions').delete().eq('session_hash', sessionHash), '로그아웃');
    }
  };
  const resetBackupStore = {
    async get(key) {
      const row = assertOk(await client.from('dnm_leave_archives').select('payload').eq('backup_key', key).maybeSingle(), '서버 보관 백업 조회');
      return row?.payload ?? null;
    },
    async setJSON(key, payload, opts = {}) {
      if (opts.onlyIfNew !== true) throw new Error('서버 보관 백업은 새 키만 생성할 수 있습니다.');
      const { error } = await client.from('dnm_leave_archives').insert({ backup_key: key, payload });
      if (error && error.code === '23505') return { modified: false };
      if (error) throw new Error(`서버 보관 백업: ${error.message}`);
      return { modified: true };
    }
  };
  async function copyArchivesFromBlob(blobBackupStore) {
    const res = await blobBackupStore.list();
    const keys = (res?.blobs || []).map((b) => b.key);
    let copied = 0;
    for (const key of keys) {
      const payload = await blobBackupStore.get(key, { type: 'json', consistency: 'strong' });
      if (!payload) throw new Error(`기존 서버 보관 백업 ${key} 읽기 실패`);
      const { error } = await client.from('dnm_leave_archives').upsert({ backup_key: key, payload }, { onConflict: 'backup_key' });
      if (error) throw new Error(`기존 서버 보관 백업 ${key} 이전 실패: ${error.message}`);
      copied++;
    }
    return { found: keys.length, copied };
  }
  async function mesStatus() {
    const config = assertOk(await client.from('dnm_leave_mes_config').select('enabled,target_table,code_column,name_column,active_column,department_column,position_column,active_type').eq('id',1).maybeSingle(), 'MES 매핑 점검');
    const events = assertOk(await client.from('dnm_leave_mes_outbox').select('id,leave_employee_id,employee_code,event_type,status,last_error,attempts,created_at').order('id',{ascending:false}).limit(80), 'MES 연계 이력 조회');
    return { config, recent_events: events || [] };
  }
  async function mesLinkPreview() {
    return assertOk(await client.rpc('dnm_leave_mes_link_preview'),
      'MES 직원 일치 후보 조회 (SQL 06_v85_mes_json_bridge.sql 설치 확인)') || [];
  }
  async function mesApplyLinks(revision, enableSync=false) {
    const m=/^pg:(\d+)$/.exec(String(revision));
    if(!m)throw new Error('Supabase 직원정보 버전을 확인해 주세요.');
    return assertOk(await client.rpc('dnm_leave_mes_apply_links',{
      p_expected_revision:Number(m[1]),p_enable_sync:Boolean(enableSync)
    }),'MES 사원번호 연결 (SQL 06_v85_mes_json_bridge.sql 설치 확인)');
  }
  async function mesRetry() {
    return assertOk(await client.rpc('dnm_leave_process_mes_sync', { p_limit: 100 }), 'MES 연계 재시도');
  }
  return { stateStore, sessionStore, resetBackupStore, copyArchivesFromBlob, mesStatus, mesRetry, mesLinkPreview, mesApplyLinks, client };
}

export async function createSupabaseBackend(env = process.env) {
  const url = String(env.DNM_LEAVE_SUPABASE_URL || '').trim();
  const secret = String(env.DNM_LEAVE_SUPABASE_SECRET_KEY || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url) || !secret)
    throw new Error('Netlify 환경변수 DNM_LEAVE_SUPABASE_URL / DNM_LEAVE_SUPABASE_SECRET_KEY를 확인해 주세요.');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url.replace(/\/$/,''), secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'X-Client-Info': 'dnm-leave-server-v8.5' } }
  });
  return buildSupabaseBackend(client);
}
