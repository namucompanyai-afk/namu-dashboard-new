/**
 * 쿠팡 광고 주간 기록(coupang_ad_weekly_snapshots) — 모양·만들기(snapshotFromView)·저장 규칙.
 * 광고 분석 화면(라이브 업로드)·/api/coupang-ad-weekly POST·맥 자동 업로드 스크립트(scripts/ad-weekly-upload)가 같이 쓴다.
 * 저장 규칙: 같은 기간(시작·끝)이면 교체, 아니면 추가 · 기간 끝 오름차순.
 */
import type { AdAnalysisView } from './adAnalysis'
import { parseCampaignTargetKey } from './weeklyActions'

export const WEEKLY_SNAPSHOTS_KEY = 'coupang_ad_weekly_snapshots'

// onePConvRevenue: revenue 중 3P 광고 → 같은 상품 1P 구매 매출 (2026-10-19 부터 기록. 그 전 기록엔 없음 = 미포함 기준)
type SnapTotals = { adCostVat: number; revenue: number; roasPct: number | null; bepPct: number | null; adProfit: number; onePConvRevenue?: number }
export type WeeklySnapshot = {
  startDate: string
  endDate: string
  savedAt?: string
  fileName?: string
  total: SnapTotals
  campaigns: (SnapTotals & { campaignId: string; campaignName: string; key: string })[]
}
/** 저장된 기록 — savedAt 은 저장할 때 붙인다 */
export type StoredWeeklySnapshot = WeeklySnapshot & { savedAt: string }

/** 주간 파일 분석 결과(기존 buildAdAnalysisView) → 주간 기록 — 값은 화면 계산 그대로 */
export function snapshotFromView(
  v: AdAnalysisView,
  period: { startDate: string; endDate: string },
  fileName: string,
): WeeklySnapshot {
  return {
    startDate: period.startDate,
    endDate: period.endDate,
    fileName,
    total: {
      adCostVat: v.totalAdCostVat,
      revenue: v.totalRevenue,
      roasPct: v.avgRoasPct,
      bepPct: v.avgBepPct,
      adProfit: v.campaigns.reduce((s, c) => s + c.adProfit, 0),
      onePConvRevenue: v.totalOnePConvRevenue,
    },
    campaigns: v.campaigns.map((c) => ({
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      key: parseCampaignTargetKey(c.campaignName)?.key ?? c.campaignName,
      adCostVat: c.adCostVat,
      revenue: c.revenue,
      roasPct: c.roasPct,
      bepPct: c.bepPct,
      adProfit: c.adProfit,
      onePConvRevenue: c.onePConvRevenue,
    })),
  }
}

/** 저장 목록 + 새 기록 → { items: 저장할 전체 목록, replaced: 같은 기간 기록을 교체했는지 } */
export function mergeWeeklySnapshot(
  items: StoredWeeklySnapshot[],
  snap: StoredWeeklySnapshot,
): { items: StoredWeeklySnapshot[]; replaced: boolean } {
  const same = (x: StoredWeeklySnapshot) => x.startDate === snap.startDate && x.endDate === snap.endDate
  const replaced = items.some(same)
  const next = items.filter((x) => !same(x))
  next.push(snap)
  next.sort((a, b) => a.endDate.localeCompare(b.endDate))
  return { items: next, replaced }
}
