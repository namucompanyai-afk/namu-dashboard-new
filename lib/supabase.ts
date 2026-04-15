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
