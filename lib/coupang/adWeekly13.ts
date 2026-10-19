/**
 * 광고 분석 상단 '이번 주 성과' — 최근 13주(주 단위) 자료 묶기 + 한 줄 평 첫 문장(자동) (순수 함수).
 *
 * 출처 우선순위 (주 시작일 기준, 월~일):
 *   1) 주간 기록 coupang_ad_weekly_snapshots — 광고비(VAT 포함)·광고 매출(실판매가 기준)·ROAS·BEP·광고 손익 (src 'weekly')
 *   2) 백필 coupang_ad_weekly_backfill — 일별 광고 보고서를 주로 환산한 광고비·광고 매출만 (src 'daily', 손익·BEP 없음).
 *      ROAS 는 화면과 같은 기준(광고비 VAT 제외)으로 다시 계산한다. 매출은 쿠팡 전환매출 그대로라 주간 기록(실판매가)보다 조금 높음
 *   전체 매출(1P+3P 소비자 판매)은 coupang_sales_weekly — 있으면 광고비 비중·광고 매출 비중 계산
 * 자료 없는 주는 값 없이 둔다 (가짜 값 없음). 계산 규칙은 바꾸지 않고 저장된 값을 그대로 보여 준다.
 */

export type WeeklySnapLite = {
  startDate: string
  endDate: string
  fileName?: string
  total: { adCostVat: number; revenue: number; roasPct: number | null; bepPct: number | null; adProfit: number; onePConvRevenue?: number }
}
export type BackfillRow = { s: string; e?: string; cost: number; rev: number; roas?: number | null; days?: number; src?: string }
export type SalesRow = { s: string; e?: string; sales1p: number; sales3p: number; src?: string }
export type WeeklyComment = { headline: string; items: string[]; writtenAt?: string; baseFile?: string }

export type WeekPoint = {
  s: string
  e: string
  src?: 'weekly' | 'daily'
  days?: number
  cost?: number
  rev?: number
  roas?: number
  bep?: number
  profit?: number
  onePConv?: number
  sales1p?: number
  sales3p?: number
  total?: number
  adShare?: number // 광고비 ÷ 전체 매출 × 100
  adRevShare?: number // 광고 매출 ÷ 전체 매출 × 100
  target: number // 광고비 비중 12월 목표 (%)
}

export const AD_SHARE_TARGET = 15
export const WEEKS = 13

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const fin = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** 최근 13주 — 마지막 주 = 주간 기록 중 시작일이 가장 늦은 주 (없으면 백필) */
export function buildWeeks13(snaps: WeeklySnapLite[], backfill: BackfillRow[], sales: SalesRow[]): WeekPoint[] {
  const last = [...snaps.map((x) => x.startDate), ...backfill.map((x) => x.s)].sort().pop()
  if (!last) return []
  const snapBy = new Map(snaps.map((x) => [x.startDate, x]))
  const fillBy = new Map(backfill.map((x) => [x.s, x]))
  const salesBy = new Map(sales.map((x) => [x.s, x]))
  const out: WeekPoint[] = []
  for (let i = WEEKS - 1; i >= 0; i--) {
    const s = addDays(last, -7 * i)
    const w: WeekPoint = { s, e: addDays(s, 6), target: AD_SHARE_TARGET }
    const sn = snapBy.get(s)
    const bf = fillBy.get(s)
    if (sn) {
      Object.assign(w, {
        src: 'weekly',
        days: 7,
        cost: fin(sn.total.adCostVat),
        rev: fin(sn.total.revenue),
        roas: fin(sn.total.roasPct),
        bep: fin(sn.total.bepPct),
        profit: fin(sn.total.adProfit),
        onePConv: fin(sn.total.onePConvRevenue),
      })
    } else if (bf) {
      const cost = fin(bf.cost)
      const rev = fin(bf.rev)
      Object.assign(w, {
        src: 'daily',
        days: bf.days ?? 7,
        cost,
        rev,
        // 광고센터 기준(광고비 VAT 제외)으로 다시 — 백필 원본의 roas 는 VAT 포함 분모일 수 있어 쓰지 않음
        roas: cost && rev != null ? (rev / (cost / 1.1)) * 100 : undefined,
      })
    }
    const sa = salesBy.get(s)
    if (sa && fin(sa.sales1p) != null && fin(sa.sales3p) != null) {
      w.sales1p = sa.sales1p
      w.sales3p = sa.sales3p
      w.total = sa.sales1p + sa.sales3p
      if (w.total > 0) {
        if (w.cost != null) w.adShare = (w.cost / w.total) * 100
        if (w.rev != null) w.adRevShare = (w.rev / w.total) * 100
      }
    }
    out.push(w)
  }
  return out
}

/** 한 줄 평 첫 문장 — 숫자 로직(시안 v5 headlineAuto 그대로). 조각 배열: tone 'up'/'down' 은 굵게+색 */
export type Seg = { t: string; tone?: 'up' | 'down' }
export function headlineAuto(cur: WeekPoint | undefined, prev: WeekPoint | undefined): Seg[] | null {
  if (!cur || !prev || cur.cost == null || prev.cost == null || cur.rev == null || prev.rev == null || cur.profit == null || prev.profit == null) return null
  const dc = cur.cost - prev.cost
  const dr = cur.rev - prev.rev
  const dp = cur.profit - prev.profit
  const pc = (dc / prev.cost) * 100
  const pr = (dr / prev.rev) * 100
  const man = (v: number) => `${v < 0 ? '−' : '+'}${Math.round(Math.abs(v) / 1e4).toLocaleString('ko-KR')}만`
  const pct = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v))}%`
  const prof: Seg[] = [{ t: '손익 ' }, dp >= 0 ? { t: `${man(dp)} 개선`, tone: 'up' } : { t: `${man(dp)} 악화`, tone: 'down' }]
  let body: string
  if (dc < 0 && dr < 0)
    body = Math.abs(pc) >= Math.abs(pr)
      ? `광고비·매출 둘 다 줄었으나 광고비(${pct(pc)})가 매출(${pct(pr)})보다 더 줄어 `
      : `광고비(${pct(pc)})보다 매출(${pct(pr)})이 더 크게 줄어 `
  else if (dc > 0 && dr > 0)
    body = pr >= pc ? `광고비(${pct(pc)}) 늘린 만큼 이상 매출(${pct(pr)})이 따라와 ` : `광고비(${pct(pc)})는 늘었는데 매출(${pct(pr)})이 못 따라와 `
  else if (dc <= 0 && dr >= 0) body = `광고비(${pct(pc)}) 줄이고도 매출(${pct(pr)}) 늘어 `
  else body = `광고비(${pct(pc)}) 늘렸는데 매출(${pct(pr)}) 줄어 `
  return [{ t: body }, ...prof, { t: ` (광고비 ${man(dc)} · 매출 ${man(dr)})` }]
}

export const commentKey = (weekStart: string) => `coupang_ad_weekly_comment_${weekStart}`
export const BACKFILL_KEY = 'coupang_ad_weekly_backfill'
export const SALES_KEY = 'coupang_sales_weekly'
