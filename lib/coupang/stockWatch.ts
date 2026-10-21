/**
 * 쿠팡 1P(로켓) 재고·현재가 점검 — 순수 함수 (광고센터 '광고 만들기 > 전체 상품' 목록 기준).
 *
 * 입력
 *   items: 16GB 클로드가 크롬 확장으로 광고센터 상품 목록을 읽어 적은 JSON (scripts/crawler-16gb/jobs/adcenter-stock-read.md 형식)
 *   oneP:  나무_마스터 마진계산에서 뽑은 1P 기준(옵션ID X · 별칭 B · 봉수 C · 쿠팡 소비자가 기준 AE, 봉수 1 행만) — scripts/coupang-stock-watch/run.ts
 * 출력: 스냅샷(dashboard_data 'coupang_1p_stock_YYYY-MM-DD') + 슬랙 한 장 (#쿠팡-결합). 손익 숫자 없음 — 가격·재고·%만.
 *
 * 1P는 쿠팡이 스스로 가격을 내리고(최저가 자동조정) 재고가 끊기는 일이 잦아 매일 아침 먼저 보는 게 목적.
 * 광고센터 '수동 상품 설정 > 전체 상품' 은 재고를 볼 수 있는 유일한 화면(대표, 2026-10-21) — 광고 등록은 하지 않고 읽기만 한다.
 */

export const STOCK_ID_PREFIX = 'coupang_1p_stock_'
export const stockSnapshotId = (date: string) => `${STOCK_ID_PREFIX}${date}`
export const LOW_STOCK_MAX = 10 // 이하면 '재고 적음'
export const STOCK_DROP_PCT = 50 // 어제보다 이만큼 넘게 줄면 '급감'
export const REVIEW_DROP_PCT = 20
export const REVIEW_DROP_MIN = 20

export type StockItem = {
  optionId: string
  title: string
  price: number | null
  stock: number | null // null = 품절(또는 못 읽음 — soldOut 으로 구분)
  soldOut: boolean
  reviews: number | null
  rating: number | null
  itemWinner: boolean | null // 못 읽었으면 null
  rocket: boolean
  badges: string[]
  note?: string
}
export type SheetOneP = { optionId: string; alias: string; bagCount: number; sheetPrice: number | null }

export type StockState = {
  optionId: string
  alias: string
  title: string
  bagCount: number | null // 제목의 'N개' 토큰 (그룹 표시용 — 광고센터가 봉수별로 재고를 따로 보여줌)
  price: number | null
  stock: number | null
  soldOut: boolean
  reviews: number | null
  itemWinner: boolean | null
  rocket: boolean
  badges: string[]
  sheetPrice: number | null // 시트에 1봉 행이 있을 때만 (1봉 옵션에만 채움)
  diffSince: string | null
}
export type StockSnapshot = { date: string; collectedAt: string; items: StockItem[]; states: StockState[] }

/** "쌀쌀쌀 프리미엄 찰흑미, 1개, 2kg" → 1 (제목의 'N개' 첫 번째 토큰) */
export function bagCountFromTitle(title: string): number | null {
  const m = /,\s*(\d+)\s*개/.exec(String(title ?? ''))
  return m ? Number(m[1]) : null
}
/** 그룹 표시용 — 'N개' 토큰을 뺀 이름 ("…찰흑미, 1개, 2kg" → "…찰흑미, 2kg") */
export function groupKeyFromTitle(title: string): string {
  return String(title ?? '').replace(/,\s*\d+\s*개/, '').replace(/\s{2,}/g, ' ').trim()
}

export type StockGroup = { key: string; alias: string; entries: { bagCount: number | null; stock: number | null; soldOut: boolean }[] }
export type StockReport = {
  soldOutGroups: StockGroup[] // 그룹 안에 품절 옵션이 하나라도 있으면 그룹 전체(봉수별 재고)를 보여준다
  lowStock: StockState[] // 품절 아니고 재고 ≤ LOW_STOCK_MAX
  stockDropped: { s: StockState; from: number }[]
  priceDiffs: { s: StockState; pct: number; prevPrice: number | null }[]
  reviewDrops: { optionId: string; alias: string; from: number; to: number }[]
  notItemWinner: StockState[]
  unmatched: number // 광고센터엔 있는데 마진계산 1P 행에 없는 옵션 수 (알림 아님, 참고)
  total: number
}

export function buildStockSnapshot(o: { date: string; items: StockItem[]; oneP: SheetOneP[]; prev: StockSnapshot | null }): { snapshot: StockSnapshot; report: StockReport } {
  const { date, items, oneP, prev } = o
  // 1봉(bagCount===1) 행만 가격 비교 기준으로 — 봉수별 재고 표시는 모든 항목에
  const sheetByOid = new Map(oneP.map((x) => [x.optionId, x]))
  const sheet1BagByOid = new Map(oneP.filter((x) => x.bagCount === 1).map((x) => [x.optionId, x]))
  const prevByOid = new Map((prev?.states ?? []).map((s) => [s.optionId, s]))

  const states: StockState[] = []
  let unmatched = 0
  for (const it of items) {
    const base = sheetByOid.get(it.optionId)
    if (!base) unmatched += 1
    const sheet1 = sheet1BagByOid.get(it.optionId)
    const prevS = prevByOid.get(it.optionId)
    const differs = it.price != null && sheet1?.sheetPrice != null && it.price !== sheet1.sheetPrice
    const s: StockState = {
      optionId: it.optionId,
      alias: base?.alias || groupKeyFromTitle(it.title),
      title: it.title,
      bagCount: bagCountFromTitle(it.title),
      price: it.price,
      stock: it.stock,
      soldOut: it.soldOut,
      reviews: it.reviews,
      itemWinner: it.itemWinner,
      rocket: it.rocket,
      badges: it.badges,
      sheetPrice: sheet1?.sheetPrice ?? null,
      diffSince: differs ? (prevS?.diffSince && prevS.price === it.price ? prevS.diffSince : date) : null,
    }
    states.push(s)
  }

  const report: StockReport = { soldOutGroups: [], lowStock: [], stockDropped: [], priceDiffs: [], reviewDrops: [], notItemWinner: [], unmatched, total: states.length }

  // 품절 그룹 — 같은 상품(그룹키)의 봉수별 재고를 한 줄로
  const groups = new Map<string, StockGroup>()
  for (const s of states) {
    const key = groupKeyFromTitle(s.title)
    const g = groups.get(key) ?? { key, alias: s.alias, entries: [] }
    g.entries.push({ bagCount: s.bagCount, stock: s.stock, soldOut: s.soldOut })
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    g.entries.sort((a, b) => (a.bagCount ?? 0) - (b.bagCount ?? 0))
    if (g.entries.some((e) => e.soldOut)) report.soldOutGroups.push(g)
  }

  for (const s of states) {
    if (!s.soldOut && s.stock != null && s.stock <= LOW_STOCK_MAX) report.lowStock.push(s)
    if (s.itemWinner === false) report.notItemWinner.push(s)
    const diffPrice = s.sheetPrice
    if (diffPrice != null && s.price != null && s.price !== diffPrice) {
      report.priceDiffs.push({ s, pct: ((s.price - diffPrice) / diffPrice) * 100, prevPrice: prevByOid.get(s.optionId)?.price ?? null })
    }
    const prevS = prevByOid.get(s.optionId)
    if (prevS && !s.soldOut && s.stock != null && prevS.stock != null && prevS.stock > 0 && s.stock <= prevS.stock * (1 - STOCK_DROP_PCT / 100)) {
      report.stockDropped.push({ s, from: prevS.stock })
    }
    if (prevS?.reviews != null && s.reviews != null && prevS.reviews >= REVIEW_DROP_MIN && s.reviews < prevS.reviews * (1 - REVIEW_DROP_PCT / 100)) {
      report.reviewDrops.push({ optionId: s.optionId, alias: s.alias, from: prevS.reviews, to: s.reviews })
    }
  }

  return { snapshot: { date, collectedAt: new Date().toISOString(), items, states }, report }
}

// ── 슬랙 메시지 (마진·손익 없음 — 가격·재고·% 만) ──────────────────
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
const won = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('ko-KR'))
const MAX_LINES = 15
function listLines<T>(items: T[], line: (x: T) => string): string[] {
  const out = items.slice(0, MAX_LINES).map((x) => `• ${line(x)}`)
  if (items.length > MAX_LINES) out.push(`• 외 ${items.length - MAX_LINES}개`)
  return out
}

export function buildStockMessage(date: string, r: StockReport, prevDate: string | null): string {
  const L: string[] = []
  L.push(
    `*[쿠팡 1P 재고·가격 점검 ${md(date)}] 상품 ${r.total}개 · 품절 ${r.soldOutGroups.length}그룹 · 재고 적음 ${r.lowStock.length} · 가격 다름 ${r.priceDiffs.length} · 아이템위너 아님 ${r.notItemWinner.length}*` +
      (prevDate ? ` (비교: ${md(prevDate)})` : ' (첫 기록 — 어제 비교 없음)'),
  )
  if (r.soldOutGroups.length) {
    L.push('', `🔴 *품절 ${r.soldOutGroups.length}그룹*`)
    L.push(...listLines(r.soldOutGroups, (g) => `${g.alias}: ${g.entries.map((e) => `${e.bagCount ?? '?'}개 ${e.soldOut ? '품절' : `재고${e.stock}`}`).join(' · ')}`))
  }
  if (r.lowStock.length) {
    L.push('', `🟠 *재고 적음(${LOW_STOCK_MAX}개 이하) ${r.lowStock.length}건*`)
    L.push(...listLines(r.lowStock, (s) => `${s.alias} ${s.bagCount ?? '?'}개: 재고 ${s.stock}`))
  }
  if (r.stockDropped.length) {
    L.push('', `🟡 *재고 급감(어제 대비 ${STOCK_DROP_PCT}% 넘게 줄어듦) ${r.stockDropped.length}건*`)
    L.push(...listLines(r.stockDropped, (d) => `${d.s.alias} ${d.s.bagCount ?? '?'}개: ${d.from} → ${d.s.stock}`))
  }
  if (r.priceDiffs.length) {
    L.push('', `🔵 *1P 가격이 시트 기준가와 다름 ${r.priceDiffs.length}건* (1봉 옵션만 비교)`)
    L.push(
      ...listLines(
        [...r.priceDiffs].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)),
        (d) =>
          `${d.s.alias}: 시트 ${won(d.s.sheetPrice)} → 쿠팡 ${won(d.s.price)} (${d.pct > 0 ? '+' : ''}${d.pct.toFixed(1)}%)` +
          (d.prevPrice != null && d.prevPrice !== d.s.price ? ` · 어제 ${won(d.prevPrice)}` : '') +
          (d.s.diffSince ? ` · ${md(d.s.diffSince)}부터` : ''),
      ),
    )
  }
  if (r.reviewDrops.length) {
    L.push('', `🟡 *후기 급감 ${r.reviewDrops.length}건* (어제보다 ${REVIEW_DROP_PCT}% 넘게 줄어듦)`)
    L.push(...listLines(r.reviewDrops, (x) => `${x.alias}: ${x.from} → ${x.to}`))
  }
  if (r.notItemWinner.length) {
    L.push('', `⚪ 아이템위너 아님 ${r.notItemWinner.length}건`)
    L.push(...listLines(r.notItemWinner, (s) => `${s.alias} ${s.bagCount ?? '?'}개`))
  }
  if (!r.soldOutGroups.length && !r.lowStock.length && !r.stockDropped.length && !r.priceDiffs.length) L.push('', `변동 없음 — 상품 ${r.total}개 모두 정상`)
  if (r.unmatched) L.push('', `_마진계산 1P 행에 없는 옵션 ${r.unmatched}개 (신상품이거나 시트 미등록 — 알림 아님)_`)
  L.push('', '_기준: 광고센터 "광고 만들기 > 전체 상품" 목록(1페이지, 최대 2페이지). 가격 비교는 1봉 옵션만, 2봉 이상은 재고만 표시_')
  return L.join('\n')
}
