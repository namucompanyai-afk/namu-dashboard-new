// ─── 공통 타입 ────────────────────────────────────────
export interface InsightData {
  impressions: string;
  clicks: string;
  spend: string;
  ctr: string;
  reach?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
}

export interface CampaignInsight {
  campaign_id: string;
  campaign_name: string;
  impressions: string;
  clicks: string;
  spend: string;
  ctr: string;
  status?: string;
  objective?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
}

export interface DailyData {
  date_start: string;
  impressions: string;
  clicks: string;
  spend: string;
  ctr: string;
}

export interface AudienceData {
  gender: string;
  age: string;
  reach?: string;
  impressions?: string;
}

export interface StoreData {
  revenue: number;
  orders: number;
  source: string;
}

export interface GoalSettings {
  roas: number;   // %
  ctr: number;    // %
  cpc: number;    // ₩
  spend: number;  // ₩
}

// ─── 유틸리티 ────────────────────────────────────────
export const fN = (n: number) => Math.round(n).toLocaleString('ko-KR');

export const iso = (d: Date) => d.toISOString().slice(0, 10);

export const fmtDate = (d: Date) =>
  `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
