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
