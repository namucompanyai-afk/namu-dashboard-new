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

export function computeNaverDiagnosis(
  settlement: NaverSettlementData,
  productMatch: Map<string, NaverProductMatch>,
  marginMap: NaverMarginMap,
  manual: NaverManualInput,
): NaverDiagnosisResult {
  const products = new Map<
    string,
    { count: number; revenue: number; cost: number; matched: boolean }
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
    const acc = products.get(name) ?? { count: 0, revenue: 0, cost: 0, matched: false }
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
