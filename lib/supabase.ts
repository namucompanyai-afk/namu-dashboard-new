import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Lazy 초기화 — 모듈 import 시점에 즉시 createClient를 호출하면
// 빌드의 page-data-collection 단계에서 환경변수 부재 시 throw 됨.
// 함수 호출 시에만 클라이언트를 만들어 빌드 단계와 런타임을 분리.
let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase 환경변수 누락: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }
  _client = createClient(url, key);
  return _client;
}

// 데이터 불러오기
export async function getData(id: string) {
  const { data, error } = await getClient()
    .from('dashboard_data')
    .select('data')
    .eq('id', id)
    .single();
  if (error) return null;
  return data?.data;
}

// 데이터 저장하기
export async function saveData(id: string, payload: any) {
  const { error } = await getClient()
    .from('dashboard_data')
    .upsert({ id, data: payload, updated_at: new Date().toISOString() });
  if (error) throw error;
  return true;
}

// 데이터 삭제 (실제로 지워진 row 수 반환)
export async function deleteData(id: string): Promise<number> {
  const { error, count } = await getClient()
    .from('dashboard_data')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) throw error;
  return count ?? 0;
}

// ─────────────────────────────────────────────────────────────
// 개인별 대시보드 페이지 핀 (user_dashboard_pages)
// ─────────────────────────────────────────────────────────────
export async function getUserDashboardPages(email: string): Promise<string[] | null> {
  const { data, error } = await getClient()
    .from('user_dashboard_pages')
    .select('page_ids')
    .eq('user_email', email)
    .maybeSingle();
  if (error) {
    console.error('getUserDashboardPages error:', error);
    return null;
  }
  if (!data) return null;
  return Array.isArray(data.page_ids) ? (data.page_ids as string[]) : [];
}

export async function saveUserDashboardPages(email: string, pageIds: string[]): Promise<boolean> {
  const { error } = await getClient()
    .from('user_dashboard_pages')
    .upsert({ user_email: email, page_ids: pageIds, updated_at: new Date().toISOString() });
  if (error) throw error;
  return true;
}

// ─────────────────────────────────────────────────────────────
// 스마트스토어 고객분석 (ss_customer_demographics)
// ─────────────────────────────────────────────────────────────
export interface DemographicRow {
  user_email: string;
  period: string;
  cat_l: string;
  cat_m: string;
  cat_s: string;
  cat_d: string;
  product_name: string;
  product_id: string;
  gender: string;
  age_band: string;
  pay_amount: number;
  pay_count: number;
  pay_qty: number;
  refund_amount: number;
  refund_count: number;
  refund_qty: number;
}

const SS_DEMO_TABLE = 'ss_customer_demographics';

// 저장된 period 목록 (최신 우선).
export async function listDemographicPeriods(email: string): Promise<string[]> {
  const { data, error } = await getClient()
    .from(SS_DEMO_TABLE)
    .select('period')
    .eq('user_email', email);
  if (error) {
    console.error('listDemographicPeriods error:', error);
    return [];
  }
  const uniq = Array.from(new Set((data ?? []).map((r: any) => r.period as string)));
  uniq.sort((a, b) => b.localeCompare(a));
  return uniq;
}

// 특정 period 행 조회 (페이지네이션 — Supabase 기본 1000행 제한 회피).
export async function getDemographics(email: string, period: string): Promise<DemographicRow[]> {
  const client = getClient();
  const out: DemographicRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from(SS_DEMO_TABLE)
      .select('*')
      .eq('user_email', email)
      .eq('period', period)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('getDemographics error:', error);
      break;
    }
    out.push(...((data ?? []) as DemographicRow[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// 같은 period 행 delete 후 insert(교체).
export async function replaceDemographics(
  email: string,
  period: string,
  rows: Omit<DemographicRow, 'user_email' | 'period'>[],
): Promise<number> {
  const client = getClient();
  const { error: delErr } = await client
    .from(SS_DEMO_TABLE)
    .delete()
    .eq('user_email', email)
    .eq('period', period);
  if (delErr) throw delErr;

  const payload = rows.map((r) => ({ ...r, user_email: email, period }));
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < payload.length; i += BATCH) {
    const batch = payload.slice(i, i + BATCH);
    const { error } = await client.from(SS_DEMO_TABLE).insert(batch);
    if (error) throw error;
    inserted += batch.length;
  }
  return inserted;
}

// prefix로 시작하는 키만 조회 (data 미포함 — 존재 여부 체크 등 가벼운 용도)
export async function listIdsByPrefix(prefix: string): Promise<string[]> {
  const client = getClient();
  const { data, error } = await client
    .from('dashboard_data')
    .select('id')
    .like('id', `${prefix}%`)
    .order('id', { ascending: true });
  if (error) {
    console.error('listIdsByPrefix error:', error);
    return [];
  }
  return (data ?? []).map((r: any) => r.id);
}

// prefix로 시작하는 모든 키 조회 (id, data 함께)
export async function listByPrefix(prefix: string) {
  const client = getClient();
  const { data: idRows, error: idErr } = await client
    .from('dashboard_data')
    .select('id, updated_at')
    .like('id', `${prefix}%`)
    .order('id', { ascending: true });
  if (idErr) {
    console.error('listByPrefix id 조회 error:', idErr);
    return [];
  }
  if (!idRows || idRows.length === 0) return [];
  const BATCH_SIZE = 100;
  const batches: { id: string }[][] = [];
  for (let i = 0; i < idRows.length; i += BATCH_SIZE) {
    batches.push(idRows.slice(i, i + BATCH_SIZE) as { id: string }[]);
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const ids = batch.map((r) => r.id);
      const { data, error } = await client
        .from('dashboard_data')
        .select('id, data, updated_at')
        .in('id', ids);
      if (error) {
        console.error('listByPrefix batch error:', error);
        return [];
      }
      return data ?? [];
    }),
  );
  const allRows = results.flat();
  allRows.sort((a: any, b: any) => a.id.localeCompare(b.id));
  return allRows;
}
