/**
 * 쿠팡 1P(로켓 직매입, 광고 판매방식 'Retail') 광고 분석.
 *
 * 광고 분석 화면은 augmentMasterWith1P 로 1P 옵션을 마진 마스터에 붙여 3P 와 같은 표·키워드·입찰가 흐름에 태운다.
 * build1PView 는 1P 합계·미연결 목록·쿠팡 손익(onePPnl)용 집계로 계속 쓴다.
 *
 * 규칙 (9월 광고 파일로 검증):
 *   - 판매수 = 봉 단위 (옵션 봉수와 무관하게 1건당 매출이 1봉 소비자가로 일정)
 *   - 광고 매출 = 광고센터 전환매출 그대로 (소비자가 기준)
 *   - 광고 이익 = 판매 봉수 × 1봉당 마진 − 광고비 × 1.1 (과세 상품은 × 1.0)
 *   - 필수 ROAS(광고센터 입력 기준, VAT 별도 광고비) = 1봉 소비자가 ÷ (1봉당 마진 ÷ 1.1) (과세는 ÷ 1봉당 마진)
 *
 * 광고 행 → 마진 연결 (광고전환매출발생 옵션ID 기준):
 *   1) 전환 옵션이 3P 마진 행에 있으면 → 3P 옵션 마진(netProfit)
 *   2) 1P 행 옵션ID 이면 → 그 SKU 의 1봉당 마진
 *   3) 전환 상품명(개수·중복 용량 제거)이 1P 로 연결된 다른 행과 같으면 → 그 SKU
 *   4) 광고집행 옵션ID 가 1P 행이면 → 그 SKU
 *   5) 그 외 → '1P 미연결'
 */

import type { AdCampaignRow } from './parsers/adCampaign'
import type { CostMaster, MarginCalcRow, OnePMarginRow } from './parsers/marginMaster'

/** 쿠팡 1P 광고 행인지 — 판매방식 'Retail'. 판매방식이 없는 옛 데이터는 캠페인명 '_1P_' 로 판정 */
export function isRetailRow(r: AdCampaignRow): boolean {
  const m = String(r.saleMethod || '').trim().toLowerCase()
  if (m) return m === 'retail'
  return /_1P_/i.test(String(r.campaignName || ''))
}

/** 전환 상품명 정규화 — '보배마을 국내산 유기농 귀리,1kg,1kg,4개,4개' → '보배마을 국내산 유기농 귀리|1kg' */
export function normOneProductName(name: string): string {
  const parts = String(name || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return ''
  const [head, ...rest] = parts
  const opts = Array.from(new Set(rest.filter((t) => !/^\d+\s*개$/.test(t))))
  return [head.replace(/\s+/g, ' '), ...opts].join('|')
}

type Link =
  | { kind: '3P'; unitMargin: number; taxable: boolean; key: string }
  | { kind: '1P'; unitMargin: number; taxable: boolean; key: string; sku: string; alias: string }
  | { kind: 'none' }

export type OnePVerdict = '강화' | '흑자' | '적자' | '판매 없음' | '마진 없음'

export interface OnePAgg {
  key: string
  label: string
  alias: string
  campaignName?: string
  /** 광고비 (VAT 별도, 원본) */
  adCostRaw: number
  /** 광고비 (부가포함, ×1.1) — 표시용 */
  adCostVat: number
  /** 이익 계산용 광고비 (면세 ×1.1 · 과세 ×1.0) */
  adCostForProfit: number
  revenue: number
  sold: number
  marginSum: number
  profit: number
  /** ROAS (광고센터 기준 = 매출 ÷ 광고비 VAT 별도, %) */
  roasPct: number | null
  /** 필수 ROAS (광고센터 입력 기준, %) — 쿠팡 입력용 목표 ROAS */
  requiredRoasPct: number | null
  verdict: OnePVerdict
  linked: boolean
}

export interface OnePView {
  loaded: boolean
  hasMargin: boolean
  totals: { adCostRaw: number; adCostVat: number; revenue: number; sold: number; profit: number; roasPct: number | null }
  campaigns: OnePAgg[]
  options: OnePAgg[]
  unlinked: { optionId: string; name: string; adCostVat: number; sold: number; revenue: number }[]
}

const EMPTY: OnePView = {
  loaded: false,
  hasMargin: false,
  totals: { adCostRaw: 0, adCostVat: 0, revenue: 0, sold: 0, profit: 0, roasPct: null },
  campaigns: [],
  options: [],
  unlinked: [],
}

/** Retail 광고 행 ↔ 1P 마진 연결기 (광고 분석·쿠팡 손익 공통) */
export function make1PLinker(retail: AdCampaignRow[], one: OnePMarginRow[], marginRows3P: MarginCalcRow[] | undefined) {
  const byOpt = new Map(one.filter((x) => x.optionId).map((x) => [x.optionId, x]))
  const bySku = new Map<string, OnePMarginRow>()
  for (const x of one) if (x.sku && (!bySku.has(x.sku) || x.bagCount === 1)) bySku.set(x.sku, x)
  const threeP = new Map((marginRows3P || []).map((r) => [String(r.optionId).trim(), r]))

  // 상품명 → SKU 색인 (1P 옵션ID 로 연결되는 행의 전환·집행 상품명으로 학습)
  const nameIdx = new Map<string, string>()
  for (const r of retail) {
    for (const [id, nm] of [[r.convOptionId, r.convProductName], [r.adOptionId, r.adProductName]] as const) {
      const x = byOpt.get(String(id || '').trim())
      const k = normOneProductName(nm)
      if (x?.sku && k && !nameIdx.has(k)) nameIdx.set(k, x.sku)
    }
  }
  const skuLink = (x: OnePMarginRow | undefined): Link => {
    if (!x) return { kind: 'none' }
    const base = (x.sku && bySku.get(x.sku)) || x
    if (base.perBagMargin == null) return { kind: 'none' }
    return { kind: '1P', unitMargin: base.perBagMargin, taxable: base.taxable, key: base.sku || base.optionId, sku: base.sku, alias: base.alias }
  }
  const linkOf = (r: AdCampaignRow): Link => {
    const conv = String(r.convOptionId || '').trim()
    const ad = String(r.adOptionId || '').trim()
    if (conv) {
      const t = threeP.get(conv)
      if (t && t.netProfit != null) return { kind: '3P', unitMargin: t.netProfit, taxable: false, key: conv }
      if (byOpt.has(conv)) return skuLink(byOpt.get(conv))
      const k = normOneProductName(r.convProductName)
      if (k && nameIdx.has(k)) return skuLink(bySku.get(nameIdx.get(k)!))
    }
    if (byOpt.has(ad)) return skuLink(byOpt.get(ad))
    const k2 = normOneProductName(r.adProductName)
    if (k2 && nameIdx.has(k2)) return skuLink(bySku.get(nameIdx.get(k2)!))
    return { kind: 'none' }
  }

  // _invW = Σ 매출 × (1.1 또는 1) ÷ 1봉당 마진, _revW = Σ 매출 (연결된 1P 행) → 필수 ROAS 매출 가중용
  return { byOpt, bySku, skuLink, linkOf }
}

export function build1PView(
  rows: AdCampaignRow[] | null,
  onePRows: OnePMarginRow[] | undefined,
  marginRows3P: MarginCalcRow[] | undefined,
): OnePView {
  const retail = (rows || []).filter(isRetailRow)
  if (!retail.length) return EMPTY
  const one = onePRows || []
  const { byOpt, skuLink, linkOf } = make1PLinker(retail, one, marginRows3P)

  type Acc = OnePAgg & { _invW: number; _revW: number }
  const newAcc = (key: string, label: string): Acc => ({
    key, label, alias: '', adCostRaw: 0, adCostVat: 0, adCostForProfit: 0, revenue: 0, sold: 0, marginSum: 0, profit: 0,
    roasPct: null, requiredRoasPct: null, verdict: '판매 없음', linked: false,
    _invW: 0, _revW: 0,
  })
  const camps = new Map<string, Acc>()
  const opts = new Map<string, Acc>()
  const unlinked = new Map<string, { optionId: string; name: string; adCostVat: number; sold: number; revenue: number }>()
  // 옵션 단위 1봉당 마진·과세 (광고집행 옵션 기준 — 판매 없는 옵션도 필수 ROAS 산출)
  const optBase = new Map<string, Link>()
  // SKU 별 1봉 소비자가 (판매 없는 옵션의 필수 ROAS 용)
  const skuPrice = new Map<string, { rev: number; sold: number }>()

  for (const r of retail) {
    const link = linkOf(r)
    const ad = String(r.adOptionId || '').trim() || '_'
    const adLink = byOpt.has(ad) ? skuLink(byOpt.get(ad)) : link
    if (!optBase.has(ad) && adLink.kind !== 'none') optBase.set(ad, adLink)
    const taxable = link.kind !== 'none' ? link.taxable : adLink.kind !== 'none' ? adLink.taxable : false
    const costProfit = (r.adCost || 0) * (taxable ? 1.0 : 1.1)
    const margin = link.kind !== 'none' ? (r.sold14d || 0) * link.unitMargin : 0
    if (link.kind === '1P' && (r.sold14d || 0) > 0) {
      const s = skuPrice.get(link.sku) || { rev: 0, sold: 0 }
      s.rev += r.revenue14d || 0
      s.sold += r.sold14d || 0
      skuPrice.set(link.sku, s)
    }
    if (link.kind === 'none' && adLink.kind === 'none') {
      const u = unlinked.get(ad) || { optionId: ad, name: r.adProductName || r.convProductName, adCostVat: 0, sold: 0, revenue: 0 }
      u.adCostVat += (r.adCost || 0) * 1.1
      u.sold += r.sold14d || 0
      u.revenue += r.revenue14d || 0
      unlinked.set(ad, u)
    }
    for (const [map, key, label] of [
      [camps, r.campaignId || r.campaignName, r.campaignName || r.campaignId],
      [opts, ad, r.adProductName || ad],
    ] as const) {
      const a = map.get(key) || newAcc(key, label)
      if (map === camps) a.campaignName = r.campaignName
      a.adCostRaw += r.adCost || 0
      a.adCostVat += (r.adCost || 0) * 1.1
      a.adCostForProfit += costProfit
      a.revenue += r.revenue14d || 0
      a.sold += r.sold14d || 0
      a.marginSum += margin
      if (link.kind !== 'none' || adLink.kind !== 'none') a.linked = true
      // 필수 ROAS 가중: 1봉 소비자가 × 매출 가중 (연결된 행만)
      const base = link.kind === '1P' ? link : adLink.kind === '1P' ? adLink : null
      if (base && base.unitMargin > 0) {
        if (!a.alias) a.alias = base.alias
        a._revW += r.revenue14d || 0
        a._invW += ((r.revenue14d || 0) * (base.taxable ? 1 : 1.1)) / base.unitMargin
      }
      map.set(key, a)
    }
  }

  const finish = (a: Acc): OnePAgg => {
    a.profit = a.marginSum - a.adCostForProfit
    a.roasPct = a.adCostRaw > 0 ? (a.revenue / a.adCostRaw) * 100 : null
    // 필수 ROAS = 1봉 소비자가 ÷ (1봉당 마진 ÷ 1.1) — 매출 가중 평균. 판매 없으면 SKU 1봉 소비자가로 대체
    if (a._revW > 0 && a.sold > 0) {
      const unitPrice = a.revenue / a.sold // 1봉 소비자가 (판매수 = 봉)
      a.requiredRoasPct = (a._invW / a._revW) * unitPrice * 100
    } else {
      const base = optBase.get(a.key)
      if (base && base.kind === '1P' && base.unitMargin > 0) {
        const sp = skuPrice.get(base.sku)
        if (sp && sp.sold > 0) a.requiredRoasPct = ((sp.rev / sp.sold) / (base.unitMargin / (base.taxable ? 1 : 1.1))) * 100
        if (!a.alias) a.alias = base.alias
      }
    }
    if (!a.linked) a.verdict = '마진 없음'
    else if (a.sold <= 0) a.verdict = '판매 없음'
    else if (a.profit > 0) a.verdict = a.roasPct != null && a.requiredRoasPct != null && a.roasPct >= a.requiredRoasPct * 2 ? '강화' : '흑자'
    else a.verdict = '적자'
    const { _invW, _revW, ...out } = a
    void _invW; void _revW
    return out
  }
  const campaigns = Array.from(camps.values()).map(finish).sort((x, y) => y.adCostVat - x.adCostVat)
  const options = Array.from(opts.values()).map(finish).sort((x, y) => y.adCostVat - x.adCostVat)
  const t = campaigns.reduce(
    (s, c) => ({ adCostRaw: s.adCostRaw + c.adCostRaw, adCostVat: s.adCostVat + c.adCostVat, revenue: s.revenue + c.revenue, sold: s.sold + c.sold, profit: s.profit + c.profit }),
    { adCostRaw: 0, adCostVat: 0, revenue: 0, sold: 0, profit: 0 },
  )
  return {
    loaded: true,
    hasMargin: one.length > 0,
    totals: { ...t, roasPct: t.adCostRaw > 0 ? (t.revenue / t.adCostRaw) * 100 : null },
    campaigns,
    options,
    unlinked: Array.from(unlinked.values()).sort((x, y) => y.adCostVat - x.adCostVat),
  }
}

/**
 * 광고 분석 통합용 — 마진 마스터에 1P 옵션 합성 행을 붙인다 (3P 행은 그대로).
 * 기존 3P 파이프라인(buildBepMap·buildActualPriceMapById·buildMarginRowMap)이 1P 옵션도 같은 방식으로 처리하게 하려는 것.
 *   - actualPrice = 1봉 소비자가 (전환 옵션별 Σ전환매출 ÷ Σ판매수, 판매 없는 광고 옵션은 SKU 평균)
 *   - netProfit   = 1봉 마진
 *   - bepRoas     = 필수 ROAS(광고센터 기준) ÷ 1.1  → buildBepMap 이 ×1.1 해서 광고센터 기준 필수 ROAS 가 됨
 *                   필수 ROAS = 1봉 소비자가 ÷ (1봉 마진 ÷ 1.1), 과세는 ÷ 1봉 마진
 */
export function augmentMasterWith1P(master: CostMaster | null, rows: AdCampaignRow[] | null): CostMaster | null {
  if (!master) return master
  const retail = (rows || []).filter(isRetailRow)
  const one = master.onePRows || []
  if (!retail.length || !one.length) return master
  const has3P = new Set(master.marginRows.map((r) => String(r.optionId).trim()))
  const L = make1PLinker(retail, one, master.marginRows)
  const conv = new Map<string, { rev: number; sold: number; link: Link; name: string }>()
  const skuPrice = new Map<string, { rev: number; sold: number }>()
  for (const r of retail) {
    const link = L.linkOf(r)
    const c = String(r.convOptionId || '').trim()
    if (link.kind !== '1P' || !c || (r.sold14d || 0) <= 0) continue
    const e = conv.get(c) || { rev: 0, sold: 0, link, name: r.convProductName }
    e.rev += r.revenue14d || 0
    e.sold += r.sold14d || 0
    conv.set(c, e)
    const sp = skuPrice.get(link.sku) || { rev: 0, sold: 0 }
    sp.rev += r.revenue14d || 0
    sp.sold += r.sold14d || 0
    skuPrice.set(link.sku, sp)
  }
  const extra: MarginCalcRow[] = []
  const added = new Set<string>()
  const add = (optionId: string, link: Link, price: number, name: string) => {
    if (!optionId || has3P.has(optionId) || added.has(optionId) || link.kind !== '1P' || !(price > 0)) return
    added.add(optionId)
    const f = link.taxable ? 1 : 1.1
    const unit = link.unitMargin
    const requiredAc = unit > 0 ? price / (unit / f) : null
    extra.push({
      exposureId: '', optionId, alias: link.alias, optionName: `${link.alias}, 1개`, coupangOptionName: name || undefined,
      totalKg: 0, bagCount: 1, kgPerBag: 1, listPrice: price, actualPrice: price, perUnitPrice: price,
      priceBand: '', autoChannel: '', manualChannel: '', channel: '1P', size: '',
      costPrice: 0, bagFee: 0, boxFee: 0, shipFee: 0, warehouseFee: 0, grossShipFee: 0, inoutFee: 0,
      feeRate: 0, packagingFee: 0, coupangFee: 0, totalCost: 0,
      netProfit: unit, marginRate: price > 0 ? unit / price : null,
      bepRoas: requiredAc != null ? requiredAc / 1.1 : null,
      taxable: link.taxable, saleChannel: '1P',
    })
  }
  for (const [c, e] of conv) add(c, e.link, e.rev / e.sold, e.name)
  for (const r of retail) {
    const ad = String(r.adOptionId || '').trim()
    if (!ad || added.has(ad)) continue
    const link = L.byOpt.has(ad) ? L.skuLink(L.byOpt.get(ad)) : L.linkOf(r)
    if (link.kind !== '1P') continue
    const sp = skuPrice.get(link.sku)
    add(ad, link, sp && sp.sold > 0 ? sp.rev / sp.sold : 0, r.adProductName)
  }
  return { ...master, marginRows: [...master.marginRows, ...extra] }
}
