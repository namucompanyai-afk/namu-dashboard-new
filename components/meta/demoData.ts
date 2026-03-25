import type { InsightData, CampaignInsight, DailyData, AudienceData } from './types';

export function generateDemoData() {
  const totalImp = 4820000, totalClk = 176894;
  const totalSpend = 18340000, totalReach = 1420000;
  const totalPurchases = 8340, purchaseValue = 77231400;

  const days = 30;
  const daily: DailyData[] = Array.from({ length: days }, (_, i) => {
    const d = new Date('2026-02-24'); d.setDate(d.getDate() + i);
    const wave = Math.sin(i / 4) * 0.25 + 1;
    const trend = 1 + (i / days) * 0.15;
    return {
      date_start: d.toISOString().slice(0, 10),
      impressions: String(Math.round(totalImp / days * wave * trend)),
      clicks: String(Math.round(totalClk / days * wave * trend)),
      spend: String(Math.round(totalSpend / days * wave * trend)),
      ctr: (3.2 + Math.random() * 0.9).toFixed(2),
    };
  });

  const campNames = ['봄 신상 런칭', '리타겟팅 - 장바구니', '신규 유입 - 관심사', '앱 설치 캠페인 v2', '브랜드 인지도', '여름 프리뷰 세일'];
  const campObjs = ['CONVERSIONS', 'CONVERSIONS', 'REACH', 'APP_INSTALLS', 'BRAND_AWARENESS', 'CONVERSIONS'];
  const campStatus = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'PAUSED', 'ACTIVE', 'ACTIVE'];
  const campDist = [0.29, 0.21, 0.18, 0.12, 0.11, 0.09];

  const campInsights: CampaignInsight[] = campNames.map((name, i) => {
    const s = Math.round(totalSpend * campDist[i]);
    const r = Math.round(purchaseValue * campDist[i] * (0.7 + i * 0.06));
    const imp = Math.round(totalImp * campDist[i]);
    const clk = Math.round(totalClk * campDist[i]);
    return {
      campaign_id: `c${i + 1}`,
      campaign_name: name,
      impressions: String(imp),
      clicks: String(clk),
      spend: String(s),
      ctr: (clk / imp * 100).toFixed(2),
      status: campStatus[i],
      objective: campObjs[i],
      actions: [{ action_type: 'purchase', value: String(Math.round(totalPurchases * campDist[i])) }],
      action_values: [{ action_type: 'purchase', value: String(r) }],
    };
  });

  const insights: { data: InsightData[] } = {
    data: [{
      impressions: String(totalImp),
      clicks: String(totalClk),
      spend: String(totalSpend),
      ctr: '3.67',
      reach: String(totalReach),
      actions: [
        { action_type: 'add_to_cart', value: '24120' },
        { action_type: 'purchase', value: String(totalPurchases) },
        { action_type: 'landing_page_view', value: '98400' },
      ],
      action_values: [{ action_type: 'purchase', value: String(purchaseValue) }],
    }],
  };

  const audSegs = [
    { gender: 'female', age: '18-24' }, { gender: 'female', age: '25-34' },
    { gender: 'male', age: '18-24' }, { gender: 'male', age: '25-34' },
    { gender: 'female', age: '35-44' }, { gender: 'male', age: '35-44' },
  ];
  const audDist = [0.22, 0.21, 0.16, 0.17, 0.13, 0.11];
  const audience: AudienceData[] = audSegs.map((a, i) => ({
    ...a,
    reach: String(Math.round(totalReach * audDist[i])),
    impressions: String(Math.round(totalImp * audDist[i])),
  }));

  return { insights, daily, campInsights, audience };
}
