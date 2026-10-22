/**
 * 네이버 쇼핑 키워드 순위 v2 — 순수 함수 (2026-10-22, 대표 설계 확정).
 *
 * v1(rankWatch.ts)과 다른 점: v1은 "키워드 1개 = 우리 상품 1개"만 추적했다(시트에 키워드·상품이 1:1로 묶여 있었음).
 * v2는 "상품 목록 × 키워드 목록" — 키워드마다 그 페이지에 있는 우리 상품을 전부 찾아 전부 저장하고,
 * 슬랙·보고서에는 추적 ON인 상품만 보여준다. 상품 식별은 네이버쇼핑 MID로 확정(2026-10-22, 브레인 확인 —
 * 스마트스토어 엑셀의 '네이버쇼핑상품번호' = 검색 결과 data-nlog-params 의 nv_mid 와 같음).
 *
 * 입력
 *   products: 나무_마스터 '네이버 상품' 탭(상품번호·상품명·별칭·MID·ON/OFF) — scripts/naver-rank-watch-v2/run.ts --targets
 *   results: 16GB 크롬으로 읽은 키워드별 검색 결과(RankResult, rankWatch.ts 와 같은 모양 — extract-naver.js 안 바뀜)
 * 출력: naver_rank_history 테이블에 쌓을 행(RankRowV2) + 키워드별 슬랙 줄.
 */
import type { RankItem, RankResult } from './rankWatch'

export type TrackedProduct = {
  productNo: string // 스마트스토어 상품번호 (시트 A열)
  name: string // 상품명 (B열)
  alias: string // 별칭 (C열, 대표 입력 — 비어 있으면 호출측이 상품명 앞 30자로 대신 채운다)
  mid: string // 네이버쇼핑 MID (D열) — 매칭 키. 비어 있으면 매칭 대상에서 빠진다
  trackOn: boolean // 추적 ON/OFF (I열)
}

/** data-nlog-params 의 slot_dtl_nv_mid 하나를 RankItem.ids[0] 에 담는 v1 그대로 재사용 (추출 코드 안 바뀜) */
export type RankRowV2 = {
  keyword: string
  productNo: string // '' = 이 키워드에 우리 상품 없음(또는 수집 실패) — 요약 행
  mid: string | null
  alias: string | null
  isTracked: boolean
  rank: number | null // null = 1페이지 밖(또는 이 노출이 광고뿐)
  isAd: boolean
  pageTotal: number // 그 페이지에서 읽은 광고 제외 상품 수(순위의 분모)
  status: 'ok' | 'captcha' | 'blocked' | 'error'
}

/**
 * 키워드 하나의 결과를 추적 상품 목록 전체와 매칭 — 매칭된 상품마다 행 1개, 하나도 없으면 요약 행 1개.
 * 같은 mid 가 여러 데이터 행에 매칭되지 않도록 products 는 mid 기준으로 유일해야 한다(호출측 책임 — 보통 시트에 중복 없음).
 */
export function matchKeywordToProducts(keyword: string, result: Pick<RankResult, 'status' | 'items'>, products: TrackedProduct[]): RankRowV2[] {
  if (result.status !== 'ok') {
    return [{ keyword, productNo: '', mid: null, alias: null, isTracked: false, rank: null, isAd: false, pageTotal: 0, status: result.status }]
  }
  const byMid = new Map<string, TrackedProduct>()
  for (const p of products) if (p.mid) byMid.set(p.mid, p)

  const pageTotal = result.items.filter((it) => !it.ad).length
  const rows: RankRowV2[] = []
  for (const it of result.items) {
    const mid = it.ids?.[0]
    if (!mid) continue
    const p = byMid.get(mid)
    if (!p) continue
    rows.push({
      keyword,
      productNo: p.productNo,
      mid,
      alias: p.alias || p.name.slice(0, 30),
      isTracked: p.trackOn,
      rank: it.rank,
      isAd: it.ad,
      pageTotal,
      status: 'ok',
    })
  }
  if (!rows.length) rows.push({ keyword, productNo: '', mid: null, alias: null, isTracked: false, rank: null, isAd: false, pageTotal, status: 'ok' })
  return rows
}

const rk = (n: number | null) => (n == null ? '1페이지 밖' : `${n}위`)

/**
 * 키워드 한 줄 — 추적 ON 상품만, 오늘(current)·이전(previous, 같은 키워드) 비교.
 * "이전에 있었는데 오늘 없는" 상품도 보여준다(없어진 걸 알아야 하므로) — current ∪ previous 의 추적 ON 상품 전체.
 * 둘 다 비어 있으면(추적 ON 상품이 이 키워드에 전혀 없음) "1페이지에 우리 상품 없음".
 */
export function buildKeywordLine(keyword: string, current: RankRowV2[], previous: RankRowV2[]): string {
  const curBy = new Map(current.filter((r) => r.productNo && r.isTracked).map((r) => [r.productNo, r]))
  const prevBy = new Map(previous.filter((r) => r.productNo && r.isTracked).map((r) => [r.productNo, r]))
  const productNos = [...new Set([...curBy.keys(), ...prevBy.keys()])]
  if (!productNos.length) return `${keyword} — 1페이지에 우리 상품 없음`

  const parts = productNos
    .map((pn) => {
      const c = curBy.get(pn)
      const p = prevBy.get(pn)
      const alias = c?.alias ?? p?.alias ?? pn
      if (c && c.rank != null) {
        if (p && p.rank != null) {
          const delta = p.rank - c.rank
          const sym = delta === 0 ? '(=)' : delta > 0 ? `(↑${delta})` : `(↓${-delta})`
          return { sortRank: c.rank, text: `${alias} ${c.rank}위${sym}` }
        }
        return { sortRank: c.rank, text: `${alias} ${c.rank}위` }
      }
      const prevNote = p && p.rank != null ? `(어제 ${p.rank}위)` : ''
      return { sortRank: Infinity, text: `${alias} ${rk(null)}${prevNote}` }
    })
    .sort((a, b) => a.sortRank - b.sortRank)
    .map((x) => x.text)
  return `${keyword} — ${parts.join(' · ')}`
}

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`

/** 08:55 전체 — 수집된(ON) 키워드마다 한 줄씩, 전부 보여준다 */
export function buildRankV2Message(date: string, keywords: string[], currentByKeyword: Map<string, RankRowV2[]>, previousByKeyword: Map<string, RankRowV2[]>): string {
  const lines = keywords.map((kw) => buildKeywordLine(kw, currentByKeyword.get(kw) ?? [], previousByKeyword.get(kw) ?? []))
  return `*[네이버 순위 ${md(date)} 08:55]*\n${lines.join('\n')}`
}

/** 추적 ON 상품 기준으로, 이 키워드의 순위가 하나라도 바뀌었는지(진입·이탈 포함) */
function keywordChanged(current: RankRowV2[], previous: RankRowV2[]): boolean {
  const curBy = new Map(current.filter((r) => r.productNo && r.isTracked).map((r) => [r.productNo, r.rank]))
  const prevBy = new Map(previous.filter((r) => r.productNo && r.isTracked).map((r) => [r.productNo, r.rank]))
  for (const pn of new Set([...curBy.keys(), ...prevBy.keys()])) {
    if ((curBy.get(pn) ?? null) !== (prevBy.get(pn) ?? null)) return true
  }
  return false
}

/** 12:30 — 아침(previous) 대비 바뀐 키워드 줄만. changed 가 false 면 호출측이 아예 슬랙을 안 보낸다 */
export function buildRankV2DeltaMessage(date: string, keywords: string[], currentByKeyword: Map<string, RankRowV2[]>, previousByKeyword: Map<string, RankRowV2[]>): { text: string; changed: boolean } {
  const changedKeywords = keywords.filter((kw) => keywordChanged(currentByKeyword.get(kw) ?? [], previousByKeyword.get(kw) ?? []))
  if (!changedKeywords.length) return { text: '', changed: false }
  const lines = changedKeywords.map((kw) => buildKeywordLine(kw, currentByKeyword.get(kw) ?? [], previousByKeyword.get(kw) ?? []))
  return { text: `*[네이버 순위 변동 ${md(date)} 낮]*\n${lines.join('\n')}`, changed: true }
}
