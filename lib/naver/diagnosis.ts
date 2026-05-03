import type { NaverSettlementData } from './parsers/settlement'
import type { NaverProductMatch } from './parsers/productMatch'
import type { NaverMarginMap, NaverMarginOption } from './marginNaver'

/**
 * 스마트스토어(네이버) 손익 진단
 *
 * 흐름:
 *   1) settlement.rows 중 kind="상품주문" 만 처리
 *   2) 상품명 → productMatch[name].exposureId 조회 (정규화 trim)
 *   3) exposureId → marginMap (옵션 배열) 중 sellPrice 가 basePrice 와 가장 가까운 옵션 1개 선택
 *   4) 그 옵션의 cost/bag/box/pack 누적
 *   5) 매칭 실패면 unmatched++
 *   6) shipReal = manual 의 (unit×count) 합
 *   7) 순익 = settleAmount(=revenue+settleFee) - cost - bag - box - shipReal - pack
 *            + shipRevenue(= settlement.shipRevenue + settlement.shipFee)  - adCost
 */

export interface NaverManualInput {
  period: string
  adCost: number
  shipSmall: { unit: number; count: number }
  shipMedium: { unit: number; count: number }
  shipLarge: { unit: number; count: number }
}

export interface NaverProductBreakdown {
  productName: string
  /** 매칭된 마진계산_네이버 옵션의 alias. 미매칭이면 '' */
  alias: string
  count: number
  revenue: number
  cost: number
  profit: number
  matched: boolean
}

export interface NaverDiagnosisResult {
  period: { start: string; end: string }
  revenue: number
  settleFee: number
  settleAmount: number

  cost: number
  bag: number
  box: number
  pack: number
  shipReal: number

  shipRevenue: number

  adCost: number
  netProfit: number

  productCount: number
  matched: number
  unmatched: number

  products: NaverProductBreakdown[]
}

function pickClosestOption(
  options: NaverMarginOption[],
  basePrice: number,
): NaverMarginOption | null {
  if (!options || options.length === 0) return null
  let best = options[0]
  let bestDiff = Math.abs((best.sellPrice || 0) - basePrice)
  for (let i = 1; i < options.length; i++) {
    const diff = Math.abs((options[i].sellPrice || 0) - basePrice)
    if (diff < bestDiff) {
      best = options[i]
      bestDiff = diff
    }
  }
  return best
}

/** YYYY-MM-DD → 그 주의 일요일(YYYY-MM-DD) — 쿠팡과 동일 일~토 주차 */
export function startOfWeek(dateStr: string): string {
  const d = new Date(dateStr)
  if (!Number.isFinite(d.getTime())) return dateStr
  const dow = d.getDay() // 0=일, 1=월, ..., 6=토
  d.setDate(d.getDate() - dow) // 일요일까지
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** YYYY-MM-DD → 그 주의 토요일(YYYY-MM-DD) — 일~토 주차 끝 */
export function endOfWeek(dateStr: string): string {
  const start = startOfWeek(dateStr)
  const d = new Date(start)
  d.setDate(d.getDate() + 6)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface NaverAliasTrendPoint {
  key: string
  label: string
  revenue: number
  totalKg: number
}

/** 별칭별 판매 추이 — 정산행을 일자(주/월) 단위로 그룹핑하여 매출 + 총kg 시계열 산출 */
export function computeAliasTrend(
  settlement: import('./parsers/settlement').NaverSettlementData | null,
  productMatch: Map<string, NaverProductMatch> | null,
  marginMap: Map<string, NaverMarginOption[]> | null,
  alias: string,
  granularity: 'weekly' | 'monthly',
): NaverAliasTrendPoint[] {
  if (!settlement || !productMatch || !marginMap || !alias) return []

  const buckets = new Map<string, { revenue: number; totalKg: number }>()
  for (const r of settlement.rows) {
    if (r.kind !== '상품주문') continue
    if (!r.settleDate) continue
    const name = r.productName.trim()
    if (!name) continue
    const match = productMatch.get(name)
    const opts = match?.exposureId ? marginMap.get(match.exposureId) : undefined
    if (!opts || opts.length === 0) continue
    const opt = pickClosestOption(opts, r.basePrice)
    if (!opt) continue
    if (opt.alias !== alias) continue

    const key =
      granularity === 'monthly' ? r.settleDate.slice(0, 7) : startOfWeek(r.settleDate)
    const acc = buckets.get(key) ?? { revenue: 0, totalKg: 0 }
    acc.revenue += r.basePrice
    // 1주문 총kg = 1봉kg × 봉수 (마진계산_네이버 시트 G·F열)
    acc.totalKg += (opt.kgPerBag || 0) * (opt.bagCount || 1)
    buckets.set(key, acc)
  }

  const out: NaverAliasTrendPoint[] = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      key,
      label: granularity === 'monthly' ? key : key.slice(5),
      revenue: v.revenue,
      totalKg: v.totalKg,
    }))
  return out
}


export function computeNaverDiagnosis(
  settlement: NaverSettlementData,
  productMatch: Map<string, NaverProductMatch>,
  marginMap: NaverMarginMap,
  manual: NaverManualInput,
): NaverDiagnosisResult {
  const products = new Map<
    string,
    { count: number; revenue: number; cost: number; matched: boolean; alias: string }
  >()

  let cost = 0
  let bag = 0
  let box = 0
  let pack = 0
  let matched = 0
  let unmatched = 0

  for (const r of settlement.rows) {
    if (r.kind !== '상품주문') continue
    const name = r.productName.trim()
    if (!name) continue
    const acc =
      products.get(name) ?? { count: 0, revenue: 0, cost: 0, matched: false, alias: '' }
    acc.count += 1
    acc.revenue += r.basePrice

    const match = productMatch.get(name)
    const opts = match?.exposureId ? marginMap.get(match.exposureId) : undefined
    if (opts && opts.length > 0) {
      const opt = pickClosestOption(opts, r.basePrice)
      if (opt) {
        cost += opt.cost
        bag += opt.bag
        box += opt.box
        pack += opt.pack
        acc.cost += opt.cost
        acc.matched = true
        if (!acc.alias) acc.alias = opt.alias
        matched += 1
      } else {
        unmatched += 1
      }
    } else {
      unmatched += 1
    }
    products.set(name, acc)
  }

  const shipReal =
    manual.shipSmall.unit * manual.shipSmall.count +
    manual.shipMedium.unit * manual.shipMedium.count +
    manual.shipLarge.unit * manual.shipLarge.count

  const revenue = settlement.totalRevenue
  const settleFee = settlement.totalFee
  const settleAmount = revenue + settleFee

  const shipRevenue = settlement.shipRevenue + settlement.shipFee
  const adCost = manual.adCost || 0

  const netProfit =
    settleAmount - cost - bag - box - shipReal - pack + shipRevenue - adCost

  const productList: NaverProductBreakdown[] = Array.from(products.entries()).map(
    ([productName, v]) => ({
      productName,
      alias: v.alias,
      count: v.count,
      revenue: v.revenue,
      cost: v.cost,
      profit: v.revenue - v.cost,
      matched: v.matched,
    }),
  )
  productList.sort((a, b) => b.revenue - a.revenue)

  return {
    period: {
      start: settlement.dateRange?.min ?? '',
      end: settlement.dateRange?.max ?? '',
    },
    revenue,
    settleFee,
    settleAmount,
    cost,
    bag,
    box,
    pack,
    shipReal,
    shipRevenue,
    adCost,
    netProfit,
    productCount: products.size,
    matched,
    unmatched,
    products: productList,
  }
}
