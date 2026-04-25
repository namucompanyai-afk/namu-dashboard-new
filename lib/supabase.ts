import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);

// 데이터 불러오기
export async function getData(id: string) {
  const { data, error } = await supabase
    .from('dashboard_data')
    .select('data')
    .eq('id', id)
    .single();
  if (error) return null;
  return data?.data;
}

// 데이터 저장하기
export async function saveData(id: string, payload: any) {
  const { error } = await supabase
    .from('dashboard_data')
    .upsert({ id, data: payload, updated_at: new Date().toISOString() });
  if (error) throw error;
  return true;
}

// 데이터 삭제
export async function deleteData(id: string) {
  const { error } = await supabase
    .from('dashboard_data')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return true;
}

// prefix로 시작하는 모든 키 조회 (id, data 함께)
export async function listByPrefix(prefix: string) {
  const { data: idRows, error: idErr } = await supabase
    .from('dashboard_data')
    .select('id, updated_at')
    .like('id', `${prefix}%`)
    .order('id', { ascending: true });
  if (idErr) {
    console.error('listByPrefix id 조회 error:', idErr);
    return [];
  }
  if (!idRows || idRows.length === 0) return [];
  const BATCH_SIZE = 5;
  const allRows: any[] = [];
  for (let i = 0; i < idRows.length; i += BATCH_SIZE) {
    const batch = idRows.slice(i, i + BATCH_SIZE);
    const ids = batch.map((r: any) => r.id);
    const { data, error } = await supabase
      .from('dashboard_data')
      .select('id, data, updated_at')
      .in('id', ids);
    if (error) {
      console.error('listByPrefix batch error:', error);
      continue;
    }
    if (data) allRows.push(...data);
  }
  allRows.sort((a: any, b: any) => a.id.localeCompare(b.id));
  return allRows;
}
