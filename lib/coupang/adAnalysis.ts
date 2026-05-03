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

/** row 매출 분리: 자기 매출(self) vs 타상품 매출(other).
 *  타상품 전환 정의: ad/conv 옵션의 노출ID가 다름 (다른 상품으로 전환).
 *  같은 노출ID 내 옵션 변경(봉수/규격 등)은 self 로 인정.
 *  노출ID 매핑이 없으면 self 로 fallback (기존 동작 유지). */
export function splitRowRevenue(
  r: AdCampaignRow,
  priceMap: Map<string, number>,
  exposureByOptionId: Map<string, string>,
): { self: number; other: number } {
  const convId = String(r.convOptionId || '').trim()
  if (!convId) return { self: 0, other: 0 }
  const price = priceMap.get(convId)
  if (!price || price <= 0) return { self: 0, other: 0 }
  const fullRev = (r.sold14d || 0) * price
  const adId = String(r.adOptionId || '').trim()
  if (!adId || convId === adId) return { self: fullRev, other: 0 }
  const adExp = exposureByOptionId.get(adId)
  const convExp = exposureByOptionId.get(convId)
  if (!adExp || !convExp) return { self: fullRev, other: 0 }
  if (adExp === convExp) return { self: fullRev, other: 0 }
  return { self: 0, other: fullRev }
}

/** row 매출 (자기 매출만). ROAS/BEP 산출에 사용. 타상품 전환 분량은 별도 otherProductRevenue 로 집계. */
function rowRevenue(
  r: AdCampaignRow,
  priceMap: Map<string, number>,
  exposureByOptionId: Map<string, string>,
): number {
  return splitRowRevenue(r, priceMap, exposureByOptionId).self
}

/** 가중평균 BEP — 옵션 매출 × 옵션 BEP / Σ 매출. 매출 = self 매출만 (타상품 전환 제외). */
function weightedBep(
  rows: AdCampaignRow[],
  bepByOptionId: Map<string, number>,
  priceMap: Map<string, number>,
  exposureByOptionId: Map<string, string>,
): number | null {
  let num = 0
  let den = 0
  for (const r of rows) {
    const bep = bepByOptionId.get(r.adOptionId)
    if (bep == null || !Number.isFinite(bep) || bep <= 0) continue
    const rev = rowRevenue(r, priceMap, exposureByOptionId)
    if (rev <= 0) continue
    num += rev * bep
    den += rev
  }
  if (den <= 0) return null
  return num / den
}

/** 광고비 가중 — 매출 0 키워드용 fallback 단가/BEP 산출.
 *  weightedBep 는 매출 가중이라 매출 0 키워드에서 null 반환 → 광고비(adCost) 가중으로 보강. */
function weightedByAdCost(
  rows: AdCampaignRow[],
  bepByOptionId: Map<string, number>,
  priceMap: Map<string, number>,
): { price: number | null; bep: number | null } {
  let priceN = 0, priceD = 0
  let bepN = 0, bepD = 0
  for (const r of rows) {
    const price = priceMap.get(r.adOptionId)
    const bep = bepByOptionId.get(r.adOptionId)
    const w = Math.max(r.adCost || 0, 1)  // 광고비 0이어도 가중치 1 (단순 평균 효과)
    if (price && price > 0) {
      priceN += price * w
      priceD += w
    }
    if (bep && bep > 0 && Number.isFinite(bep)) {
      bepN += bep * w
      bepD += w
    }
  }
  return {
    price: priceD > 0 ? priceN / priceD : null,
    bep: bepD > 0 ? bepN / bepD : null,
  }
}

/** BEP CPC fallback — 옵션 단가 + 캠페인 평균 CVR + 옵션 BEP 만으로 입찰가 산출.
 *  공식: (CVR × 단가) / (BEP × 1.1) × 0.95 (옵션 표 BEP CPC 공식과 일관, 5% 안전마진).
 *  매출 0 또는 클릭 <20 인 키워드에 적용. */
function bepFallbackBid(
  unitPrice: number | null,
  avgCvr: number | null,
  optBepPct: number | null,
): number | null {
  if (!unitPrice || unitPrice <= 0) return null
  if (!avgCvr || avgCvr <= 0) return null
  if (!optBepPct || optBepPct <= 0) return null
  const bid = (avgCvr * unitPrice) / ((optBepPct / 100) * 1.1) * 0.95
  if (!Number.isFinite(bid) || bid <= 0) return null
  return bid
}

/** 추천 입찰가 (VAT 별도). 클릭 < 20 또는 BEP 없음이면 null.
 *  공식: 매출 ÷ (클릭수 × BEP × 1.05 × 1.1) — BEP 대비 5% 여유 + VAT 환산. */
export function recommendedBid(revenue: number, clicks: number, bepPct: number | null): number | null {
  if (!bepPct || bepPct <= 0) return null
  if (clicks < 20) return null
  if (revenue <= 0) return null
  // BEP 는 % 단위 (예: 433 → 4.33). 1.155 = 1.05 (5% 여유) × 1.1 (VAT)
  const bid = revenue / (clicks * (bepPct / 100) * 1.155)
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
  /** 타상품 매출 — 다른 노출ID 로 전환된 분량 (참고용, ROAS 산출 제외) */
  otherProductRevenue: number
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
  /** 평균 현재 CPC (+VAT) = adCostVat / clicks */
  currentCpcVatIncl: number | null
  /** 추천 액션 — 검색 키워드만 의미 있음 */
  action: KeywordAction
  /** 추천 입찰가 (VAT 별도). null = 데이터 부족 */
  recommendedBidVatExcl: number | null
  /** 입찰가 산출 방식. 'revenue' = 매출 역산 / 'bep' = BEP CPC fallback (매출 0 또는 클릭<20). null = 산출 불가 */
  bidSource: 'revenue' | 'bep' | null
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

/** 마진M 미매칭 옵션 집계 — KPI/표 산출에서 제외된 분량 안내용 */
export interface UnmatchedSummary {
  /** 미매칭 unique 옵션 수 (convOptionId 우선, 없으면 adOptionId) */
  adCount: number
  /** 미매칭 옵션의 광고비 (VAT 포함) */
  adCostVat: number
  /** 미매칭 옵션의 sold14d 합 */
  sold: number
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
  unmatched: UnmatchedSummary
}

/** 마진 마스터 marginRows → optionId 별 BEP(%) 맵.
 * 마진 마스터 bepRoas 는 배율 (예: 3.06). 페이지 전반에서 ROAS(%) 와 같은 단위로 다루기 위해
 * 여기서 ×100 해서 % 단위 (예: 306) 로 저장. 후속 함수 (weightedBep / recommendedBid /
 * classifyKeywordAction / buildBepCpcForCampaign) 는 모두 % 단위 가정. */
export function buildBepMap(master: CostMaster | null): Map<string, number> {
  const m = new Map<string, number>()
  if (!master) return m
  for (const r of master.marginRows) {
    if (!r.optionId) continue
    if (r.bepRoas == null || !Number.isFinite(r.bepRoas) || r.bepRoas <= 0) continue
    m.set(String(r.optionId).trim(), r.bepRoas * 100)
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

/** 마진 마스터 → optionId 별 exposureId 맵. 타상품 전환(다른 노출ID) 판단용. */
export function buildExposureMapByOptionId(master: CostMaster | null): Map<string, string> {
  const m = new Map<string, string>()
  if (!master) return m
  for (const r of master.marginRows) {
    if (!r.optionId || !r.exposureId) continue
    m.set(String(r.optionId).trim(), String(r.exposureId).trim())
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
  const emptyUnmatched: UnmatchedSummary = { adCount: 0, adCostVat: 0, sold: 0 }
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
      unmatched: emptyUnmatched,
    }
  }

  const bepMap = buildBepMap(master)
  const priceMap = buildActualPriceMapById(master)
  const exposureMap = buildExposureMapByOptionId(master)

  // 미매칭 집계 — convOptionId(매출 기준) priceMap 에 없는 row 의 광고비/판매수 합
  let unmatchedAdCostRaw = 0
  let unmatchedSold = 0
  const unmatchedOptIds = new Set<string>()
  for (const r of adRows) {
    const convId = String(r.convOptionId || '').trim()
    const adId = String(r.adOptionId || '').trim()
    const key = convId || adId
    if (!key) continue
    if (convId && priceMap.has(convId)) continue
    unmatchedAdCostRaw += r.adCost || 0
    unmatchedSold += r.sold14d || 0
    unmatchedOptIds.add(key)
  }
  const unmatched: UnmatchedSummary = {
    adCount: unmatchedOptIds.size,
    adCostVat: unmatchedAdCostRaw * 1.1,
    sold: unmatchedSold,
  }

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
    // 매출 = Σ (sold14d × 마진M 실판매가) — self 만. 타상품 전환(다른 노출ID)은 other 로 별도.
    let revenue = 0
    let otherProductRevenue = 0
    for (const r of rows) {
      const split = splitRowRevenue(r, priceMap, exposureMap)
      revenue += split.self
      otherProductRevenue += split.other
    }
    // 주문 라벨이지만 실제 컬럼은 sold14d (수량) — 진단의 adSold 와 일관.
    const orders = rows.reduce((s, r) => s + (r.sold14d || 0), 0)
    const clicks = rows.reduce((s, r) => s + (r.clicks || 0), 0)

    let searchRaw = 0
    let nonSearchRaw = 0
    let searchRev = 0
    let nonSearchRev = 0
    for (const r of rows) {
      const rev = rowRevenue(r, priceMap, exposureMap)
      if (isSearchPlacement(r.placement)) {
        searchRaw += r.adCost || 0
        searchRev += rev
      } else {
        nonSearchRaw += r.adCost || 0
        nonSearchRev += rev
      }
    }
    const searchAdCostVat = searchRaw * 1.1
    const nonSearchAdCostVat = nonSearchRaw * 1.1

    const roasPct = safeDiv(revenue, adCostVat)
    const bepPct = weightedBep(rows, bepMap, priceMap, exposureMap)
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
      otherProductRevenue,
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
    unmatched,
  }
}

/** 캠페인 → 검색/비검색 키워드 row 집계 */
export function buildKeywordRows(
  campaign: CampaignDiag,
  bepMap: Map<string, number>,
  priceMap: Map<string, number>,
  exposureByOptionId: Map<string, string>,
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

  // 캠페인 평균 CVR — fallback 입찰가 공식의 입력 (옵션 표 BEP CPC 와 동일 정의)
  const campaignAvgCvr =
    campaign.clicks > 0 ? campaign.orders / campaign.clicks : null

  const aggregate = (key: string, rows: AdCampaignRow[]): KeywordRow => {
    const impressions = rows.reduce((s, r) => s + (r.impressions || 0), 0)
    const clicks = rows.reduce((s, r) => s + (r.clicks || 0), 0)
    // 주문 라벨이지만 sold14d (진단 일관)
    const orders = rows.reduce((s, r) => s + (r.sold14d || 0), 0)
    const adCostRaw = rows.reduce((s, r) => s + (r.adCost || 0), 0)
    const adCostVat = adCostRaw * 1.1
    // 매출 = Σ (sold14d × 마진M 실판매가)
    const revenue = rows.reduce((s, r) => s + rowRevenue(r, priceMap, exposureByOptionId), 0)
    const ctr = safeDiv(clicks, impressions)
    const cvr = safeDiv(orders, clicks)
    const roas = safeDiv(revenue, adCostVat)
    const bep = weightedBep(rows, bepMap, priceMap, exposureByOptionId)
    const roasPct = roas != null ? roas * 100 : null
    let bid = recommendedBid(revenue, clicks, bep)
    let bidSource: 'revenue' | 'bep' | null = bid != null ? 'revenue' : null
    // BEP CPC fallback — 매출 0 또는 클릭 <20 키워드에 가상 입찰가 산출
    if (bid == null) {
      const w = weightedByAdCost(rows, bepMap, priceMap)
      const optBep = w.bep ?? bep ?? null
      const fbBid = bepFallbackBid(w.price, campaignAvgCvr, optBep)
      if (fbBid != null) {
        bid = fbBid
        bidSource = 'bep'
      }
    }
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
      currentCpcVatIncl: clicks > 0 ? adCostVat / clicks : null,
      action,
      recommendedBidVatExcl: bid,
      bidSource,
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
  priceMap: Map<string, number>,
  currentBidByKeyword: Map<string, number>,
  exposureByOptionId: Map<string, string>,
): ManualKeywordRow[] {
  const { search } = buildKeywordRows(campaign, bepMap, priceMap, exposureByOptionId)
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
      // ManualReview 는 매출 역산만 사용 (기존 동작) — bidSource 도 일관 유지
      bidSource: bid != null ? 'revenue' : null,
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
