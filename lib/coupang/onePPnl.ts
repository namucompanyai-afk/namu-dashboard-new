/**
 * 쿠팡 1P(로켓 직매입) 월 손익 — 입고 기준 순이익 + 판매 기준 집계.
 *
 * 입고 기준 (최종 순이익):
 *   - 선택 월에 입고된 발주만 — 로켓_세일즈 원장(실제 입고일, ledgerToOrders) 또는 옛 발주서 zip(입고예정일). 입고 봉수 = 입고수량, 입고 매출 = 입고수량 × 매입가(부가포함)
 *   - 1P 마진 합 = Σ 입고 봉수 × 1봉 마진 (나무_마스터 1P 1봉 행, SKU 기준)
 *   - 밀크런 운송비: 정산(밀크런번호→금액) ↔ 접수 내역(밀크런번호→발주번호) ↔ 발주서(발주번호→SKU·입고수량)
 *     밀크런 1건 금액을 그 트럭 발주들의 입고 봉수 비율로 SKU 에 배분. 선택 월 발주에 연결 안 되면 '미배분'
 *     운송비 연결 안 된 선택 월 발주는 이번 달 평균 봉당 운송비로 '추정' (정산 파일을 다시 올리면 실제 값으로 바뀜)
 *     접수 내역이 없으면: 정산 파일 픽업일이 선택 월인 금액 합계를 그대로 사용 (상품별 배분 없음)
 *   - 1P 광고비 = 광고 분석 1P 결과의 이익 계산용 광고비 (면세 ×1.1 · 과세 ×1.0)
 *   - 1P 순이익 = 1P 마진 합 − 밀크런 운송비(배분분) − 1P 광고비
 *
 * 판매 기준 (상품 판정용 — 이번엔 계산만):
 *   - 판매 봉수 = 판매 수량 × 옵션 봉수, 판매 매출 = GMV
 *   - 옵션 → SKU·봉수: 나무_마스터 1P 행 옵션ID → 즉석밥 규칙(180g N개: 6개입 SKU N/6봉, 24개 = 24개입 SKU 1봉)
 *     → 옵션명에서 개수를 뗀 같은 상품명의 1P 연결 옵션 SKU (봉수 = 이름의 N개)
 */

import type { OnePMarginRow } from './parsers/marginMaster'
import type { OnePSalesRow } from './parsers/onePSales'
import type { PurchaseOrder } from './parsers/purchaseOrder'
import type { MilkrunListRow, MilkrunSettleRow } from './parsers/milkrun'
import type { OnePView } from './onePAnalysis'
import { normOneProductName } from './onePAnalysis'

export interface OnePInboundSku {
  sku: string
  alias: string
  bags: number
  revenue: number
  perBagMargin: number | null
  margin: number
  milkrun: number
}

export interface OnePPnl {
  month: string
  inbound: {
    poCount: number
    bags: number
    revenue: number
    margin: number
    bySku: OnePInboundSku[]
    unknownSku: { sku: string; name: string; bags: number; revenue: number }[]
  } | null
  milkrun: {
    /** list = 접수 내역으로 발주별 배분 · settle = 정산 픽업일 기준 합계만 */
    mode: 'list' | 'settle'
    total: number
    /** 확정 운송비 (list: 배분분 · settle: 픽업일 선택 월 합계) */
    allocated: number
    /** 운송비 연결 안 된 선택 월 발주 — 평균 봉당 운송비 × 입고 봉수 */
    estimated: number
    estimatedBags: number
    unallocated: number
    unallocatedList: { milkrunNo: string; pickupDate: string; center: string; amount: number; reason: string }[]
  } | null
  adCost: number | null
  adRevenue: number | null
  netProfit: number | null
  sales: {
    gmv: number
    bags: number
    unlinked: { optionId: string; name: string; gmv: number; qty: number }[]
    /** 판매 기준 참고 (최종 순이익 아님) — 판매 봉수 × 1봉 마진 */
    margin: number
    /** 판매 봉수 × 이번 달 봉당 운송비 (입고 기준 운송비(확정+추정) ÷ 입고 봉수) */
    milkrun: number | null
    /** 판매 기준 1P 순이익 = 판매 마진 − 운송비 − 1P 광고비 */
    netProfit: number | null
  } | null
}

const monthOf = (d: string) => String(d || '').slice(0, 7)

/** 1P 판매 옵션 → { sku, 봉수 } */
export function linkOnePOption(
  optionId: string,
  name: string,
  one: OnePMarginRow[],
  nameIdx: Map<string, string>,
): { sku: string; bags: number } | null {
  const byOpt = one.find((x) => x.optionId && x.optionId === optionId)
  if (byOpt?.sku) return { sku: byOpt.sku, bags: byOpt.bagCount || 1 }
  const n = Number((name.match(/(\d+)\s*개/) || [])[1] || 1)
  // 즉석밥: 180g N개 — 6개입 SKU N/6봉, 24개 = 24개입 SKU 1봉
  if (/즉석밥|현미밥/.test(name) && /180\s*g/i.test(name)) {
    const find = (k: string) => one.find((x) => x.alias.includes(`즉석밥 ${k}개`) && x.sku)?.sku
    if (n === 24) { const s = find('24'); if (s) return { sku: s, bags: 1 } }
    if (n % 6 === 0) { const s = find('6'); if (s) return { sku: s, bags: n / 6 } }
    return null
  }
  const k = normOneProductName(name)
  const sku = k ? nameIdx.get(k) : undefined
  if (sku) return { sku, bags: n }
  // 별칭 토큰: [브랜드] 품목 용량 — 브랜드·품목 글자·용량이 옵션명에 모두 있고 SKU 가 딱 1개일 때만
  const flat = name.replace(/\s+/g, '')
  const hits = new Set<string>()
  for (const x of one) {
    if (!x.sku || x.bagCount !== 1) continue
    const m = x.alias.match(/^\[(.+?)\]\s*(.*?)\s*([\d.]+\s*(?:kg|g))$/i)
    if (!m) continue
    const [, brand, item, w] = m
    if (flat.includes(brand) && flat.includes(item.replace(/\s+/g, '')) && flat.toLowerCase().includes(w.replace(/\s+/g, '').toLowerCase())) hits.add(x.sku)
  }
  return hits.size === 1 ? { sku: Array.from(hits)[0], bags: n } : null
}

export function computeOnePPnl(args: {
  month: string
  onePRows: OnePMarginRow[] | undefined
  orders: PurchaseOrder[] | null
  settle: MilkrunSettleRow[] | null
  list: MilkrunListRow[] | null
  adView: OnePView | null
  sales: OnePSalesRow[] | null
  /** 상품명 학습용 (1P 옵션ID 로 연결된 행의 이름) — 광고 행 상품명 등 */
  extraNames?: { optionId: string; name: string }[]
}): OnePPnl {
  const one = args.onePRows || []
  const bySku = new Map<string, OnePMarginRow>()
  for (const x of one) if (x.sku && (!bySku.has(x.sku) || x.bagCount === 1)) bySku.set(x.sku, x)

  // ── 입고 기준 ──
  let inbound: OnePPnl['inbound'] = null
  const monthPOs = (args.orders || []).filter((o) => monthOf(o.dueDate) === args.month)
  const poBags = new Map<string, Map<string, number>>() // 발주번호 → sku → 입고봉수
  if (args.orders) {
    const agg = new Map<string, OnePInboundSku>()
    const unknown = new Map<string, { sku: string; name: string; bags: number; revenue: number }>()
    for (const po of monthPOs) {
      const m = new Map<string, number>()
      for (const it of po.items) {
        if (it.receivedQty <= 0) continue
        m.set(it.sku, (m.get(it.sku) || 0) + it.receivedQty)
        const base = bySku.get(it.sku)
        const rev = it.receivedQty * it.unitPrice
        if (!base) {
          const u = unknown.get(it.sku) || { sku: it.sku, name: it.name, bags: 0, revenue: 0 }
          u.bags += it.receivedQty
          u.revenue += rev
          unknown.set(it.sku, u)
        }
        const a = agg.get(it.sku) || { sku: it.sku, alias: base?.alias || it.name, bags: 0, revenue: 0, perBagMargin: base?.perBagMargin ?? null, margin: 0, milkrun: 0 }
        a.bags += it.receivedQty
        a.revenue += rev
        a.margin += it.receivedQty * (base?.perBagMargin ?? 0)
        agg.set(it.sku, a)
      }
      poBags.set(po.poNumber, m)
    }
    const bySkuArr = Array.from(agg.values()).sort((x, y) => y.revenue - x.revenue)
    inbound = {
      poCount: monthPOs.length,
      bags: bySkuArr.reduce((s, x) => s + x.bags, 0),
      revenue: bySkuArr.reduce((s, x) => s + x.revenue, 0),
      margin: bySkuArr.reduce((s, x) => s + x.margin, 0),
      bySku: bySkuArr,
      unknownSku: Array.from(unknown.values()),
    }
  }

  // ── 밀크런 운송비 ──
  let milkrun: OnePPnl['milkrun'] = null
  if (args.settle && inbound && !args.list) {
    const total = args.settle.reduce((a, s) => a + s.amount, 0)
    const inMonth = args.settle.filter((s) => monthOf(s.pickupDate) === args.month)
    const allocated = inMonth.reduce((a, s) => a + s.amount, 0)
    milkrun = {
      mode: 'settle', total, allocated, estimated: 0, estimatedBags: 0, unallocated: total - allocated,
      unallocatedList: args.settle.filter((s) => monthOf(s.pickupDate) !== args.month).map((s) => ({ ...s, reason: '픽업일이 선택 월 아님' })),
    }
  } else if (args.settle && args.list && inbound) {
    const listBy = new Map(args.list.filter((l) => l.status === '정상').map((l) => [l.milkrunNo, l]))
    const cancelled = new Set(args.list.filter((l) => l.status !== '정상').map((l) => l.milkrunNo))
    const skuAgg = new Map(inbound.bySku.map((x) => [x.sku, x]))
    let allocated = 0
    let allocatedBags = 0
    const linkedPo = new Set<string>()
    const unalloc: NonNullable<OnePPnl['milkrun']>['unallocatedList'] = []
    for (const s of args.settle) {
      const l = listBy.get(s.milkrunNo)
      if (!l) { unalloc.push({ ...s, reason: cancelled.has(s.milkrunNo) ? '취소 건 (취소 수수료)' : '접수 내역에 없음' }); continue }
      const skuBags = new Map<string, number>()
      for (const po of l.poNumbers) for (const [sku, b] of poBags.get(po) || []) skuBags.set(sku, (skuBags.get(sku) || 0) + b)
      const total = Array.from(skuBags.values()).reduce((a, b) => a + b, 0)
      if (total <= 0) {
        const anyPo = l.poNumbers.some((p) => (args.orders || []).some((o) => o.poNumber === p))
        unalloc.push({ ...s, reason: !l.poNumbers.length ? '발주번호 없음' : anyPo ? '선택 월 입고 발주 아님 또는 입고 0' : '발주서 파일에 없음' })
        continue
      }
      for (const po of l.poNumbers) if (poBags.has(po)) linkedPo.add(po)
      for (const [sku, b] of skuBags) {
        const a = skuAgg.get(sku)
        if (a) a.milkrun += (s.amount * b) / total
      }
      allocated += s.amount
      allocatedBags += total
    }
    // 운송비 연결 안 된 선택 월 발주 → 이번 달 평균 봉당 운송비로 추정
    const perBag = allocatedBags > 0 ? allocated / allocatedBags : 0
    let estimated = 0
    let estimatedBags = 0
    for (const [po, m] of poBags) {
      if (linkedPo.has(po)) continue
      for (const [sku, b] of m) {
        estimatedBags += b
        estimated += b * perBag
        const a = skuAgg.get(sku)
        if (a) a.milkrun += b * perBag
      }
    }
    const total = args.settle.reduce((a, s) => a + s.amount, 0)
    milkrun = { mode: 'list', total, allocated, estimated, estimatedBags, unallocated: total - allocated, unallocatedList: unalloc }
  }

  // ── 광고비 (이익 계산용: 면세 ×1.1 · 과세 ×1.0) ──
  const adCost = args.adView?.loaded ? args.adView.campaigns.reduce((s, c) => s + c.adCostForProfit, 0) : null
  const adRevenue = args.adView?.loaded ? args.adView.totals.revenue : null

  const netProfit = inbound && milkrun && adCost != null ? inbound.margin - milkrun.allocated - milkrun.estimated - adCost : null

  // ── 판매 기준 ──
  let sales: OnePPnl['sales'] = null
  if (args.sales) {
    const nameIdx = new Map<string, string>()
    const learn = (optionId: string, name: string) => {
      const x = one.find((o) => o.optionId && o.optionId === optionId)
      const k = normOneProductName(name)
      if (x?.sku && k && !nameIdx.has(k)) nameIdx.set(k, x.sku)
    }
    for (const r of args.sales) learn(r.optionId, r.name)
    for (const r of args.extraNames || []) learn(r.optionId, r.name)
    let bags = 0
    let margin = 0
    const unlinked: NonNullable<OnePPnl['sales']>['unlinked'] = []
    for (const r of args.sales) {
      const l = linkOnePOption(r.optionId, r.name, one, nameIdx)
      if (!l) { unlinked.push({ optionId: r.optionId, name: r.name, gmv: r.gmv, qty: r.qty }); continue }
      bags += r.qty * l.bags
      margin += r.qty * l.bags * (bySku.get(l.sku)?.perBagMargin ?? 0)
    }
    // 판매 기준 참고 — 운송비는 입고 기준 봉당 운송비 재사용, 광고비는 입고 기준과 같은 값
    const perBagMilkrun = inbound && milkrun && inbound.bags > 0 ? (milkrun.allocated + milkrun.estimated) / inbound.bags : null
    const salesMilkrun = perBagMilkrun != null ? bags * perBagMilkrun : null
    sales = {
      gmv: args.sales.reduce((s, r) => s + r.gmv, 0), bags, unlinked: unlinked.sort((a, b) => b.gmv - a.gmv),
      margin, milkrun: salesMilkrun,
      netProfit: salesMilkrun != null && adCost != null ? margin - salesMilkrun - adCost : null,
    }
  }

  return { month: args.month, inbound, milkrun, adCost, adRevenue, netProfit, sales }
}
