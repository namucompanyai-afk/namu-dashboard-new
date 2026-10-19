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
  /** clicks: 캠페인 클릭 수 (2026-10-19 밤부터 기록 — 모수 부족(클릭 <20) 판정용. 그 전 기록엔 없음 → 화면은 '—') */
  campaigns: (SnapTotals & { campaignId: string; campaignName: string; key: string; clicks?: number })[]
}
/** 저장된 기록 — savedAt 은 저장할 때 붙인다. prev = 같은 기간을 교체하기 직전 기록 1개(되돌리기용 보관, 읽는 쪽은 무시) */
export type StoredWeeklySnapshot = WeeklySnapshot & { savedAt: string; prev?: WeeklySnapshot & { savedAt?: string } }

// ── 같은 기간 교체 전 비교 (업로드 실수 방지, 2026-10-19) ──
/** 캠페인 수가 다르거나 광고비 합·광고 매출 합이 이만큼(10%) 넘게 다르면 바로 교체하지 않고 확인 */
export const REPLACE_WARN_RATIO = 0.1
export type SnapshotDiff = {
  period: string
  campaigns: [number, number]
  cost: [number, number]
  rev: [number, number]
  costPct: number | null
  revPct: number | null
  /** 확인이 필요한 차이인지 */
  big: boolean
  /** 확인 칸 문구 */
  text: string
}
const pctOf = (a: number, b: number): number | null => (a > 0 ? ((b - a) / a) * 100 : b > 0 ? null : 0)
const won = (v: number) => Math.round(v).toLocaleString('ko-KR')
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const pctTxt = (p: number | null) => (p == null ? '새로 생김' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(Math.round(p))}%`)
export function compareSnapshots(stored: WeeklySnapshot, incoming: WeeklySnapshot): SnapshotDiff {
  const campaigns: [number, number] = [stored.campaigns.length, incoming.campaigns.length]
  const cost: [number, number] = [stored.total.adCostVat, incoming.total.adCostVat]
  const rev: [number, number] = [stored.total.revenue, incoming.total.revenue]
  const costPct = pctOf(cost[0], cost[1])
  const revPct = pctOf(rev[0], rev[1])
  const over = (p: number | null) => p == null || Math.abs(p) > REPLACE_WARN_RATIO * 100
  const big = campaigns[0] !== campaigns[1] || over(costPct) || over(revPct)
  const period = `${md(stored.startDate)}~${md(stored.endDate)}`
  const parts = [
    campaigns[0] !== campaigns[1] ? `캠페인 ${campaigns[0]}→${campaigns[1]}개` : '',
    over(costPct) ? `광고비 ${won(cost[0])}→${won(cost[1])}(${pctTxt(costPct)})` : '',
    over(revPct) ? `광고 매출 ${won(rev[0])}→${won(rev[1])}(${pctTxt(revPct)})` : '',
  ].filter(Boolean)
  const text = big
    ? `이미 저장된 ${period} 기록과 다릅니다 — ${parts.join(', ')}. 그래도 교체할까요?`
    : `저장된 ${period} 기록과 거의 같음 (캠페인 ${campaigns[1]}개, 광고비 ${pctTxt(costPct)}, 광고 매출 ${pctTxt(revPct)}) — 바로 교체`
  return { period, campaigns, cost, rev, costPct, revPct, big, text }
}
/** 같은 기간 저장본 찾기 */
export const findSamePeriod = <T extends WeeklySnapshot>(items: T[], snap: WeeklySnapshot): T | undefined =>
  items.find((x) => x.startDate === snap.startDate && x.endDate === snap.endDate)

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
      clicks: c.clicks,
    })),
  }
}

/** 저장 목록 + 새 기록 → { items: 저장할 전체 목록, replaced: 같은 기간 기록을 교체했는지 }
 *  교체하면 직전 기록 1개를 새 기록의 prev 에 보관 (그 기록이 갖고 있던 prev 는 버림 — 항상 1개만) */
export function mergeWeeklySnapshot(
  items: StoredWeeklySnapshot[],
  snap: StoredWeeklySnapshot,
): { items: StoredWeeklySnapshot[]; replaced: boolean } {
  const same = (x: StoredWeeklySnapshot) => x.startDate === snap.startDate && x.endDate === snap.endDate
  const old = items.find(same)
  const replaced = !!old
  const next = items.filter((x) => !same(x))
  if (old) {
    const { prev: _dropped, ...keep } = old
    void _dropped
    next.push({ ...snap, prev: keep })
  } else next.push(snap)
  next.sort((a, b) => a.endDate.localeCompare(b.endDate))
  return { items: next, replaced }
}
