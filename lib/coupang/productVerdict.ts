/**
 * 쿠팡 손익 — 상품(별칭)별 판정 (3P + 1P 판매 기준). 기존 계산 결과만 모아 합친다 (새 계산식 없음).
 *
 *   3P: 수익 진단 products (판매 매출·총 마진·광고비(면세 ×1.1·과세 ×1.0)·광고 순손익·전체 순익)
 *   1P: 판매 기준 참고(onePPnl.sales.bySku — 판매 봉수 × 1봉 마진, 봉수 × 봉당 운송비)
 *       + 1P 광고(build1PView.options — 광고집행 옵션 단위 이익용 광고비·광고 손익)
 *   상품 손익 = 판매 마진 − 광고비 − 1P 운송비
 *   판매 봉수 = 3P(옵션별 판매수 × 봉수) + 1P(bySku 봉수) · 광고 판매 봉수 = 3P(옵션별 광고 귀속 판매수 × 봉수) + 1P(광고 판매수 = 봉)
 *   광고 판매 비중 = 광고 판매 봉수 ÷ 판매 봉수 (14일 전환이라 100% 를 넘을 수 있다)
 *   판정: 광고 없음(광고비 0) · 진짜 적자(상품 손익 −) · 함정(상품 손익 + · 광고 손익 −) · 효자(둘 다 +)
 * 별칭 없는 광고비(3P 마진 미등록 옵션 · 1P 연결 안 된 옵션)는 따로 한 행씩 — 합계가 3P 순이익 + 판매 기준 1P 순이익과 맞게.
 */
import type { ProductDiagnosis } from './diagnosis'
import type { OnePAgg } from './onePAnalysis'
import type { OnePPnl } from './onePPnl'

export type ProductVerdict = '효자' | '함정' | '진짜 적자' | '광고 없음'

export interface VerdictPart {
  revenue: number
  margin: number
  adCost: number
  adProfit: number
  milkrun: number
  profit: number
  /** 판매 봉수 */
  bags: number
  /** 광고 판매 봉수 */
  adBags: number
}

export interface ProductVerdictRow extends VerdictPart {
  /** 광고 판매 비중 = 광고 판매 봉수 ÷ 판매 봉수 (판매 봉수 0 이면 null) */
  adShare: number | null
  alias: string
  channel: '3P' | '1P' | '둘다' | '—'
  verdict: ProductVerdict
  p3?: VerdictPart
  p1?: VerdictPart
  /** 별칭 없는 광고비 모음 행 */
  special?: boolean
}

const zero = (): VerdictPart => ({ revenue: 0, margin: 0, adCost: 0, adProfit: 0, milkrun: 0, profit: 0, bags: 0, adBags: 0 })
const add = (a: VerdictPart, b: Partial<VerdictPart>) => {
  a.revenue += b.revenue ?? 0; a.margin += b.margin ?? 0; a.adCost += b.adCost ?? 0
  a.adProfit += b.adProfit ?? 0; a.milkrun += b.milkrun ?? 0; a.profit += b.profit ?? 0
  a.bags += b.bags ?? 0; a.adBags += b.adBags ?? 0
}

export function verdictOf(p: { adCost: number; profit: number; adProfit: number }): ProductVerdict {
  if (!(p.adCost > 0)) return '광고 없음'
  if (p.profit < 0) return '진짜 적자'
  if (p.adProfit < 0) return '함정'
  return '효자'
}

export function buildProductVerdicts(args: {
  products3P: ProductDiagnosis[] | null | undefined
  /** 3P 마진 미등록 옵션 광고비 (수익 진단 unmatched.adCost) */
  unmatchedAdCost3P?: number
  sales1P: OnePPnl['sales'] | null | undefined
  adOptions1P: OnePAgg[] | null | undefined
}): ProductVerdictRow[] {
  const by = new Map<string, { p3?: VerdictPart; p1?: VerdictPart; special?: boolean }>()
  const get = (alias: string) => { let e = by.get(alias); if (!e) { e = {}; by.set(alias, e) } return e }

  for (const p of args.products3P || []) {
    const e = get(p.alias)
    const part = e.p3 || (e.p3 = zero())
    // 봉수 = 옵션별 수량 × 옵션 봉수 (옵션 상세 없으면 수량 그대로)
    const opts = p.optionDetails || []
    const bags = opts.length ? opts.reduce((s, o) => s + o.sold * (o.bagCount || 1), 0) : p.sold
    const adBags = opts.length ? opts.reduce((s, o) => s + o.adSold * (o.bagCount || 1), 0) : p.adSold
    add(part, { revenue: p.revenue, margin: p.totalMargin, adCost: p.adCost, adProfit: p.adNetProfit, milkrun: 0, profit: p.totalNetProfit, bags, adBags })
  }
  if (args.unmatchedAdCost3P && args.unmatchedAdCost3P > 0) {
    const e = get('(3P 마진 미등록 옵션 광고)')
    e.special = true
    const c = args.unmatchedAdCost3P
    add(e.p3 || (e.p3 = zero()), { revenue: 0, margin: 0, adCost: c, adProfit: -c, milkrun: 0, profit: -c })
  }
  for (const s of args.sales1P?.bySku || []) {
    const e = get(s.alias)
    const m = s.milkrun ?? 0
    add(e.p1 || (e.p1 = zero()), { revenue: s.gmv, margin: s.margin, adCost: 0, adProfit: 0, milkrun: m, profit: s.margin - m, bags: s.bags })
  }
  for (const o of args.adOptions1P || []) {
    const alias = o.alias || '(1P 연결 안 된 광고)'
    const e = get(alias)
    if (!o.alias) e.special = true
    // 1P 광고 판매수 = 봉
    add(e.p1 || (e.p1 = zero()), { revenue: 0, margin: 0, adCost: o.adCostForProfit, adProfit: o.profit, milkrun: 0, profit: -o.adCostForProfit, adBags: o.sold })
  }

  const rows: ProductVerdictRow[] = []
  for (const [alias, e] of by) {
    const t = zero()
    if (e.p3) add(t, e.p3)
    if (e.p1) add(t, e.p1)
    rows.push({
      alias, ...t,
      adShare: t.bags > 0 ? t.adBags / t.bags : null,
      channel: e.p3 && e.p1 ? '둘다' : e.p3 ? '3P' : e.p1 ? '1P' : '—',
      verdict: verdictOf(t),
      p3: e.p3, p1: e.p1, special: e.special,
    })
  }
  return rows.sort((a, b) => b.profit - a.profit)
}
