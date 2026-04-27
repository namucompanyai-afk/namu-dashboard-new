/**
 * 광고 분석 — 캠페인/키워드 집계 + BEP/추천 입찰가 계산.
 *
 * 입력: parseAdCampaign 결과 (AdCampaignRow[]) + 마진 마스터 (CostMaster)
 * 출력: 캠페인 진단 row + AI 캠페인의 키워드 row + 수동 캠페인의 키워드 row
 *
 * BEP 가중평균 (캠페인/키워드):
 *   BEP = Σ(rev_i × bep_i) / Σ(rev_i)
 *   - 옵션 BEP 는 마진 마스터 marginRows 의 bepRoas 필드 (이미 캐시값)
 *   - bepRoas 단위는 % (예: 433 = 433%) — 그대로 사용
 *   - 매칭 안 되는 옵션은 가중평균에서 제외 (BEP=null)
 *
 * 추천 입찰가 (VAT 별도, 쿠팡 광고센터 입력값):
 *   매출 ÷ (클릭수 × BEP × 1.1) ÷ 1.1
 *   = 매출 ÷ (클릭수 × BEP × 1.21)
 *   - BEP 는 % 단위라 분모에 1/100 곱해 사용 (= BEP/100)
 *   - 클릭 < 20 → null (데이터 부족)
 *
 * BEP CPC (옵션별):
 *   옵션 단가 × 평균 CVR / (옵션 BEP × 1.21)
 *   = 마진 마스터 actualPrice × 캠페인 평균 CVR / (옵션 bepRoas × 1.21)
 *   - 단위: BEP 는 % (433 → 곱할 때 4.33 으로 환산)
 *   - 평균 CVR 은 캠페인 전체 (orders14d / clicks)
 */

import type { AdCampaignRow } from './parsers/adCampaign'
import type { CostMaster, MarginCalcRow } from './parsers/marginMaster'

export type CampaignType = 'ai' | 'manual' | 'unknown'
export type KeywordAction = 'keep' | 'move' | 'exclude'

/** 캠페인 이름 → AI/수동/미분류 */
export function classifyCampaign(name: string): CampaignType {
  const n = (name || '').toLowerCase()
  if (n.includes('수동') || /\bmanual\b/.test(n)) return 'manual'
  if (n.includes('_ai') || /\bai\b/.test(name) || /(^|[^a-z])ai([^a-z]|$)/i.test(name)) return 'ai'
  return 'unknown'
}

const SEARCH_PLACEMENT_HINTS = ['검색']
const NONSEARCH_HINTS = ['비검색']
export function isSearchPlacement(placement: string): boolean {
  if (!placement) return false
  if (NONSEARCH_HINTS.some((h) => placement.includes(h))) return false
  return SEARCH_PLACEMENT_HINTS.some((h) => placement.includes(h))
}

/** 가중평균 BEP — 옵션 매출 × 옵션 BEP / Σ 매출. 옵션 BEP 누락 행은 제외. */
function weightedBep(
  rows: AdCampaignRow[],
  bepByOptionId: Map<string, number>,
): number | null {
  let num = 0
  let den = 0
  for (const r of rows) {
    const bep = bepByOptionId.get(r.adOptionId)
    if (bep == null || !Number.isFinite(bep) || bep <= 0) continue
    if (!Number.isFinite(r.revenue14d) || r.revenue14d <= 0) continue
    num += r.revenue14d * bep
    den += r.revenue14d
  }
  if (den <= 0) return null
  return num / den
}

/** 추천 입찰가 (VAT 별도). 클릭 < 20 또는 BEP 없음이면 null. */
export function recommendedBid(revenue: number, clicks: number, bepPct: number | null): number | null {
  if (!bepPct || bepPct <= 0) return null
  if (clicks < 20) return null
  if (revenue <= 0) return null
  // BEP 는 % 단위 (예: 433 → 4.33)
  const bid = revenue / (clicks * (bepPct / 100) * 1.21)
  if (!Number.isFinite(bid) || bid <= 0) return null
  return bid
}

/** 추천 액션 분류 */
export function classifyKeywordAction(
  roasPct: number | null,
  bepPct: number | null,
  adCost: number,
): KeywordAction {
  if (roasPct == null || bepPct == null) {
    return adCost >= 500_000 ? 'move' : 'exclude'
  }
  if (roasPct >= bepPct) return 'keep'
  if (roasPct < bepPct * 0.5) return 'exclude'
  if (adCost >= 500_000) return 'move'
  return 'exclude'
}

export interface CampaignDiag {
  campaignId: string
  campaignName: string
  type: CampaignType
  /** 광고비 (VAT 미포함, 원본 그대로) */
  adCostRaw: number
  /** 광고비 (VAT 포함, ×1.1) */
  adCostVat: number
  revenue: number
  /** ROAS = revenue / adCostVat × 100 (%) */
  roasPct: number | null
  /** 가중 BEP (%) */
  bepPct: number | null
  /** ROAS - BEP (음수면 미달) */
  gapPct: number | null
  orders: number
  clicks: number
  /** 검색 영역 광고비 비율 (0~1) */
  searchShare: number
  /** 검색/비검색 분할 광고비 (VAT 포함) */
  searchAdCostVat: number
  nonSearchAdCostVat: number
  searchRevenue: number
  nonSearchRevenue: number
  searchRoasPct: number | null
  nonSearchRoasPct: number | null
  /** 캠페인에 포함된 raw row 들 (키워드 분석용) */
  rows: AdCampaignRow[]
}

export interface KeywordRow {
  keyword: string
  impressions: number
  clicks: number
  ctrPct: number | null  // %
  orders: number
  cvrPct: number | null  // %
  adCostRaw: number
  adCostVat: number
  revenue: number
  roasPct: number | null
  bepPct: number | null
  /** 추천 액션 — 검색 키워드만 의미 있음 */
  action: KeywordAction
  /** 추천 입찰가 (VAT 별도). null = 데이터 부족 */
  recommendedBidVatExcl: number | null
}

export interface ManualKeywordRow extends KeywordRow {
  /** 현재 입찰가 (VAT 별도) — 광고 엑셀에 없으므로 사용자 수동 입력 또는 null */
  currentBidVatExcl: number | null
  /** 차이 = 추천 - 현재 */
  bidDiff: number | null
  /** 점검 결과 */
  bidVerdict: 'ok' | 'high' | 'too_high' | 'unknown'
  /** 신뢰도 (별 갯수 1~3) */
  confidence: 1 | 2 | 3
}

export interface AdAnalysisView {
  loaded: boolean
  totalAdCostVat: number
  totalRevenue: number
  totalOrders: number
  avgRoasPct: number | null
  avgBepPct: number | null
  avgUnitPrice: number | null
  campaignCount: number
  campaigns: CampaignDiag[]
}

/** 마진 마스터 marginRows → optionId 별 BEP(%) 맵.
 * bepRoas 단위는 % (433 같은 수치). null 이거나 <= 0 이면 제외. */
export function buildBepMap(master: CostMaster | null): Map<string, number> {
  const m = new Map<string, number>()
  if (!master) return m
  for (const r of master.marginRows) {
    if (!r.optionId) continue
    if (r.bepRoas == null || !Number.isFinite(r.bepRoas) || r.bepRoas <= 0) continue
    m.set(String(r.optionId).trim(), r.bepRoas)
  }
  return m
}

/** 마진 마스터 → optionId 별 actualPrice 맵 (BEP CPC 계산용) */
export function buildActualPriceMapById(master: CostMaster | null): Map<string, number> {
  const m = new Map<string, number>()
  if (!master) return m
  for (const r of master.marginRows) {
    if (!r.optionId || !r.actualPrice || r.actualPrice <= 0) continue
    m.set(String(r.optionId).trim(), r.actualPrice)
  }
  return m
}

/** 마진 마스터 → optionId 별 marginRow 전체 (BEP CPC 라벨에 봉수/봉kg 활용) */
export function buildMarginRowMap(master: CostMaster | null): Map<string, MarginCalcRow> {
  const m = new Map<string, MarginCalcRow>()
  if (!master) return m
  for (const r of master.marginRows) {
    if (!r.optionId) continue
    m.set(String(r.optionId).trim(), r)
  }
  return m
}

function safeDiv(a: number, b: number): number | null {
  if (!Number.isFinite(b) || b === 0) return null
  return a / b
}

/** AdCampaignRow[] → 캠페인 단위 진단 row */
export function buildAdAnalysisView(
  adRows: AdCampaignRow[] | null,
  master: CostMaster | null,
): AdAnalysisView {
  if (!adRows || adRows.length === 0) {
    return {
      loaded: false,
      totalAdCostVat: 0,
      totalRevenue: 0,
      totalOrders: 0,
      avgRoasPct: null,
      avgBepPct: null,
      avgUnitPrice: null,
      campaignCount: 0,
      campaigns: [],
    }
  }

  const bepMap = buildBepMap(master)

  const byCamp = new Map<string, AdCampaignRow[]>()
  for (const r of adRows) {
    const key = r.campaignId || r.campaignName || '_'
    const arr = byCamp.get(key) ?? []
    arr.push(r)
    byCamp.set(key, arr)
  }

  const campaigns: CampaignDiag[] = []

  for (const [, rows] of byCamp) {
    const first = rows[0]
    const adCostRaw = rows.reduce((s, r) => s + (r.adCost || 0), 0)
    const adCostVat = adCostRaw * 1.1
    const revenue = rows.reduce((s, r) => s + (r.revenue14d || 0), 0)
    const orders = rows.reduce((s, r) => s + (r.orders14d || 0), 0)
    const clicks = rows.reduce((s, r) => s + (r.clicks || 0), 0)

    let searchRaw = 0
    let nonSearchRaw = 0
    let searchRev = 0
    let nonSearchRev = 0
    for (const r of rows) {
      if (isSearchPlacement(r.placement)) {
        searchRaw += r.adCost || 0
        searchRev += r.revenue14d || 0
      } else {
        nonSearchRaw += r.adCost || 0
        nonSearchRev += r.revenue14d || 0
      }
    }
    const searchAdCostVat = searchRaw * 1.1
    const nonSearchAdCostVat = nonSearchRaw * 1.1

    const roasPct = safeDiv(revenue, adCostVat)
    const bepPct = weightedBep(rows, bepMap)
    const gapPct = roasPct != null && bepPct != null ? roasPct * 100 - bepPct : null

    const searchRoas = safeDiv(searchRev, searchAdCostVat)
    const nonSearchRoas = safeDiv(nonSearchRev, nonSearchAdCostVat)

    campaigns.push({
      campaignId: first.campaignId,
      campaignName: first.campaignName || first.campaignId,
      type: classifyCampaign(first.campaignName),
      adCostRaw,
      adCostVat,
      revenue,
      roasPct: roasPct != null ? roasPct * 100 : null,
      bepPct,
      gapPct,
      orders,
      clicks,
      searchShare: adCostRaw > 0 ? searchRaw / adCostRaw : 0,
      searchAdCostVat,
      nonSearchAdCostVat,
      searchRevenue: searchRev,
      nonSearchRevenue: nonSearchRev,
      searchRoasPct: searchRoas != null ? searchRoas * 100 : null,
      nonSearchRoasPct: nonSearchRoas != null ? nonSearchRoas * 100 : null,
      rows,
    })
  }

  campaigns.sort((a, b) => b.adCostVat - a.adCostVat)

  const totalAdCostVat = campaigns.reduce((s, c) => s + c.adCostVat, 0)
  const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0)
  const totalOrders = campaigns.reduce((s, c) => s + c.orders, 0)
  const avgRoasPct = totalAdCostVat > 0 ? (totalRevenue / totalAdCostVat) * 100 : null
  // 평균 BEP — 매출 가중
  let bepNum = 0, bepDen = 0
  for (const c of campaigns) {
    if (c.bepPct == null) continue
    bepNum += c.revenue * c.bepPct
    bepDen += c.revenue
  }
  const avgBepPct = bepDen > 0 ? bepNum / bepDen : null
  const avgUnitPrice = totalOrders > 0 ? totalRevenue / totalOrders : null

  return {
    loaded: true,
    totalAdCostVat,
    totalRevenue,
    totalOrders,
    avgRoasPct,
    avgBepPct,
    avgUnitPrice,
    campaignCount: campaigns.length,
    campaigns,
  }
}

/** 캠페인 → 검색/비검색 키워드 row 집계 */
export function buildKeywordRows(
  campaign: CampaignDiag,
  bepMap: Map<string, number>,
): { search: KeywordRow[]; nonSearch: KeywordRow[] } {
  const search = new Map<string, AdCampaignRow[]>()
  const nonSearch = new Map<string, AdCampaignRow[]>()

  for (const r of campaign.rows) {
    const isSearch = isSearchPlacement(r.placement)
    const target = isSearch ? search : nonSearch
    const key = isSearch ? (r.keyword || '-') : (r.placement || '비검색')
    const arr = target.get(key) ?? []
    arr.push(r)
    target.set(key, arr)
  }

  const aggregate = (key: string, rows: AdCampaignRow[]): KeywordRow => {
    const impressions = rows.reduce((s, r) => s + (r.impressions || 0), 0)
    const clicks = rows.reduce((s, r) => s + (r.clicks || 0), 0)
    const orders = rows.reduce((s, r) => s + (r.orders14d || 0), 0)
    const adCostRaw = rows.reduce((s, r) => s + (r.adCost || 0), 0)
    const adCostVat = adCostRaw * 1.1
    const revenue = rows.reduce((s, r) => s + (r.revenue14d || 0), 0)
    const ctr = safeDiv(clicks, impressions)
    const cvr = safeDiv(orders, clicks)
    const roas = safeDiv(revenue, adCostVat)
    const bep = weightedBep(rows, bepMap)
    const roasPct = roas != null ? roas * 100 : null
    const bid = recommendedBid(revenue, clicks, bep)
    const action: KeywordAction = classifyKeywordAction(roasPct, bep, adCostVat)
    return {
      keyword: key,
      impressions,
      clicks,
      ctrPct: ctr != null ? ctr * 100 : null,
      orders,
      cvrPct: cvr != null ? cvr * 100 : null,
      adCostRaw,
      adCostVat,
      revenue,
      roasPct,
      bepPct: bep,
      action,
      recommendedBidVatExcl: action === 'move' ? bid : null,
    }
  }

  const searchRows: KeywordRow[] = []
  for (const [k, arr] of search) {
    if (k === '-' || !k) continue  // 키워드 없는 검색 행은 제외
    searchRows.push(aggregate(k, arr))
  }
  const nonSearchRows: KeywordRow[] = []
  for (const [k, arr] of nonSearch) nonSearchRows.push(aggregate(k, arr))

  searchRows.sort((a, b) => b.adCostVat - a.adCostVat)
  nonSearchRows.sort((a, b) => b.adCostVat - a.adCostVat)
  return { search: searchRows, nonSearch: nonSearchRows }
}

/** 수동 캠페인 점검 row — 현재 입찰가는 광고 엑셀에 없으므로 별도 입력 받음.
 *  점검 룰:
 *    - 클릭 < 20 → unknown (평가 보류)
 *    - 추천 없음(BEP 또는 클릭 부족) → unknown
 *    - 현재 ≤ 추천 → ok
 *    - 추천 < 현재 ≤ 추천 × 1.5 → high
 *    - 현재 > 추천 × 1.5 → too_high
 *  신뢰도: 클릭 50+ ★★★ / 20~49 ★★ / <20 ★
 */
export function buildManualReviewRows(
  campaign: CampaignDiag,
  bepMap: Map<string, number>,
  currentBidByKeyword: Map<string, number>,
): ManualKeywordRow[] {
  const { search } = buildKeywordRows(campaign, bepMap)
  return search.map<ManualKeywordRow>((k) => {
    const bid = recommendedBid(k.revenue, k.clicks, k.bepPct)
    const cur = currentBidByKeyword.get(k.keyword) ?? null
    const conf: 1 | 2 | 3 = k.clicks >= 50 ? 3 : k.clicks >= 20 ? 2 : 1
    let verdict: ManualKeywordRow['bidVerdict'] = 'unknown'
    if (k.clicks >= 20 && bid != null && cur != null) {
      if (cur <= bid) verdict = 'ok'
      else if (cur <= bid * 1.5) verdict = 'high'
      else verdict = 'too_high'
    }
    return {
      ...k,
      recommendedBidVatExcl: bid,
      currentBidVatExcl: cur,
      bidDiff: bid != null && cur != null ? bid - cur : null,
      bidVerdict: verdict,
      confidence: conf,
    }
  })
}

/** 캠페인의 옵션별 BEP CPC 단가 (헤더 우측 표시용).
 *  옵션 단가 × 평균 CVR / (옵션 BEP × 1.21)
 *  - 평균 CVR 은 캠페인 전체 (orders/clicks)
 *  - 옵션은 캠페인에 등장한 adOptionId 들
 *  - 작은 옵션(낮은 봉수) 우선 정렬
 */
export interface BepCpcEntry {
  optionId: string
  label: string  // 표시용 ("1봉" / "2봉" / "0.8kg 1봉" 등)
  cpc: number    // VAT 별도
  bagCount: number
  kgPerBag: number
}

export function buildBepCpcForCampaign(
  campaign: CampaignDiag,
  master: CostMaster | null,
): BepCpcEntry[] {
  if (!master) return []
  const priceMap = buildActualPriceMapById(master)
  const bepMap = buildBepMap(master)
  const rowMap = buildMarginRowMap(master)

  const totalClicks = campaign.clicks
  const totalOrders = campaign.orders
  const avgCvr = totalClicks > 0 ? totalOrders / totalClicks : null
  if (avgCvr == null || avgCvr <= 0) return []

  const seen = new Set<string>()
  for (const r of campaign.rows) {
    if (r.adOptionId) seen.add(String(r.adOptionId).trim())
  }

  const out: BepCpcEntry[] = []
  for (const optId of seen) {
    const price = priceMap.get(optId)
    const bep = bepMap.get(optId)
    const row = rowMap.get(optId)
    if (!price || !bep || !row) continue
    const cpc = (price * avgCvr) / (bep / 100 * 1.21)
    if (!Number.isFinite(cpc) || cpc <= 0) continue
    const label =
      row.bagCount > 0 && row.kgPerBag > 0
        ? `${row.bagCount}봉`
        : (row.optionName || `${optId.slice(-4)}`)
    out.push({
      optionId: optId,
      label,
      cpc,
      bagCount: row.bagCount,
      kgPerBag: row.kgPerBag,
    })
  }

  // 봉수 작은 순 → 그 다음 1봉당 kg 작은 순
  out.sort((a, b) => {
    if (a.bagCount !== b.bagCount) return a.bagCount - b.bagCount
    return a.kgPerBag - b.kgPerBag
  })

  // 같은 라벨 dedupe (1봉 여러 옵션이면 첫 1개만)
  const seenLabel = new Set<string>()
  return out.filter((e) => {
    if (seenLabel.has(e.label)) return false
    seenLabel.add(e.label)
    return true
  })
}
