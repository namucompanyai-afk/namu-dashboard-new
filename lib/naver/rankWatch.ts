/**
 * 네이버 쇼핑 키워드 순위 점검 — 순수 함수 (광고 제외 순위, 어제 대비, 순위권 이탈).
 *
 * 입력
 *   targets: 나무_마스터 '네이버 순위 키워드' 탭 (키워드 · 우리 상품 URL · 별칭 · 검색 종류 · ON/OFF) — scripts/naver-rank-watch/run.ts --targets
 *   results: 16GB 클로드가 크롬 확장으로 검색 결과를 읽어 적은 JSON (scripts/crawler-16gb/jobs/naver-rank-check.md 형식)
 * 출력: 스냅샷(dashboard_data 'naver_rank_YYYY-MM-DD') + 슬랙 한 장. 손익 숫자 없음.
 *
 * 상품 식별은 ID 로만 (이름 매칭 금지): URL 의 products/<ID> · catalog/<ID> · nvMid=<ID> · productId=<ID>.
 * 순위 = 결과 목록에서 '광고' 항목을 뺀 순서. 2페이지(80개)까지만 보고 그 밖은 '80위 밖'.
 */

export const RANK_ID_PREFIX = 'naver_rank_'
export const rankSnapshotId = (date: string) => `${RANK_ID_PREFIX}${date}`
export const MAX_RANK = 80 // 2페이지 × 40
export const RANK_MOVE_ALERT = 3 // 어제보다 이만큼 넘게 움직이면 강조

export type RankTarget = {
  keyword: string
  url: string
  alias: string
  searchType: 'shopping' | 'total' // 쇼핑검색(기본) / 통합검색
  ids: string[] // URL 에서 뽑은 식별자들
}
export type RankItem = { rank: number | null; ad: boolean; title?: string; mall?: string; link?: string; ids: string[] }
export type RankResult = {
  keyword: string
  searchType?: string
  readAt: string
  status: 'ok' | 'captcha' | 'blocked' | 'error'
  pagesRead?: number
  items: RankItem[]
  note?: string
}
export type RankState = {
  keyword: string
  alias: string
  searchType: string
  rank: number | null // null = 80위 밖(또는 못 찾음)
  found: boolean
  title?: string
  mall?: string
  adCount: number // 읽은 범위 안의 광고 수 (참고)
  itemsRead: number
}
export type RankSnapshot = { date: string; collectedAt: string; results: RankResult[]; ranks: RankState[]; unread: string[] }

/** URL/링크에서 상품 식별자 전부 */
export function extractIds(url: string): string[] {
  const s = String(url ?? '')
  const out = new Set<string>()
  for (const re of [/\/products\/(\d+)/g, /\/catalog\/(\d+)/g, /[?&]nvMid=(\d+)/g, /[?&]productId=(\d+)/g, /[?&]catalogId=(\d+)/g]) {
    for (const m of s.matchAll(re)) out.add(m[1])
  }
  return [...out]
}

export type RankReport = {
  ranks: RankState[]
  moved: { s: RankState; from: number | null; delta: number }[] // 어제와 다름
  lost: { s: RankState; from: number }[] // 어제는 있었는데 오늘 80위 밖
  unread: string[] // 못 읽은 키워드
  total: number
}

export function buildRankSnapshot(o: { date: string; targets: RankTarget[]; results: RankResult[]; prev: RankSnapshot | null }): { snapshot: RankSnapshot; report: RankReport } {
  const { date, targets, results, prev } = o
  const byKw = new Map(results.map((r) => [`${r.keyword}|${r.searchType || 'shopping'}`, r]))
  const prevBy = new Map((prev?.ranks ?? []).map((s) => [`${s.keyword}|${s.searchType}`, s]))
  const ranks: RankState[] = []
  const report: RankReport = { ranks, moved: [], lost: [], unread: [], total: targets.length }
  for (const t of targets) {
    const r = byKw.get(`${t.keyword}|${t.searchType}`) ?? byKw.get(`${t.keyword}|`) ?? results.find((x) => x.keyword === t.keyword)
    if (!r || r.status !== 'ok') {
      report.unread.push(t.keyword)
      continue
    }
    // 광고 뺀 순서로 다시 센다 (클로드가 적은 rank 는 참고만)
    let n = 0
    let hit: RankItem | null = null
    let hitRank: number | null = null
    for (const it of r.items) {
      if (it.ad) continue
      n += 1
      const ids = it.ids?.length ? it.ids : extractIds(it.link || '')
      if (!hit && ids.some((id) => t.ids.includes(id))) {
        hit = it
        hitRank = n
      }
    }
    const s: RankState = {
      keyword: t.keyword,
      alias: t.alias,
      searchType: t.searchType,
      rank: hitRank != null && hitRank <= MAX_RANK ? hitRank : null,
      found: !!hit,
      title: hit?.title,
      mall: hit?.mall,
      adCount: r.items.filter((x) => x.ad).length,
      itemsRead: n,
    }
    ranks.push(s)
    const p = prevBy.get(`${t.keyword}|${t.searchType}`)
    if (p) {
      if (p.rank != null && s.rank == null) report.lost.push({ s, from: p.rank })
      else if (p.rank !== s.rank && s.rank != null) report.moved.push({ s, from: p.rank, delta: p.rank == null ? 0 : p.rank - s.rank })
    }
  }
  return { snapshot: { date, collectedAt: new Date().toISOString(), results, ranks, unread: report.unread }, report }
}

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
const rk = (n: number | null) => (n == null ? `${MAX_RANK}위 밖` : `${n}위`)
const st = (s: string) => (s === 'total' ? '통검' : '쇼핑')

export function buildRankMessage(date: string, r: RankReport, prevDate: string | null): string {
  const L: string[] = []
  const big = r.moved.filter((m) => Math.abs(m.delta) >= RANK_MOVE_ALERT)
  L.push(`*[네이버 순위 ${md(date)}] 키워드 ${r.total}개 · 변동 ${r.moved.length}건 (±${RANK_MOVE_ALERT} 이상 ${big.length}) · 순위권 이탈 ${r.lost.length} · 못 읽음 ${r.unread.length}*` + (prevDate ? ` (비교: ${md(prevDate)})` : ' (첫 기록 — 어제 비교 없음)'))
  L.push('_광고 제외 순위 · 2페이지(80개)까지_')
  if (r.lost.length) L.push('', `🔴 *순위권 이탈 ${r.lost.length}건*`, ...r.lost.map((x) => `• ${x.s.keyword} · ${x.s.alias}: ${MAX_RANK}위 밖 (어제 ${x.from}위)`))
  L.push('', '*오늘 순위*')
  for (const s of r.ranks) {
    const m = r.moved.find((x) => x.s === s)
    const arrow = m ? (m.delta > 0 ? ` ↑${m.delta} (어제 ${rk(m.from)})` : m.delta < 0 ? ` ↓${-m.delta} (어제 ${rk(m.from)})` : '') : ''
    const mark = m && Math.abs(m.delta) >= RANK_MOVE_ALERT ? (m.delta > 0 ? '🟢' : '🟠') : '•'
    L.push(`${mark} ${s.keyword}${s.searchType === 'total' ? '(통검)' : ''} · ${s.alias}: *${rk(s.rank)}*${arrow}${s.adCount ? ` · 광고 ${s.adCount}` : ''}`)
  }
  if (r.unread.length) L.push('', `_못 읽은 키워드 ${r.unread.length}개: ${r.unread.join(', ')}_`)
  L.push('', `_한계: 로그인 없는 16GB 크롬 기준(개인화 차이 가능) · 하루 1회 · ${st('shopping')}검색 기준, 통검은 따로 표시_`)
  return L.join('\n')
}
