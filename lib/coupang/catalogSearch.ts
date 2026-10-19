/**
 * 쿠팡 결합 감지 2단계 — 쿠팡 파트너스 오픈 API 검색 스냅샷으로 1P·3P 페이지 분리 감지 (순수 함수).
 *
 * 매일 1회 우리 상품 키워드(scripts/coupang-catalog-watch/search-keywords.json)를 products/search 로 검색해
 * 결과 중 '우리 상품'(상품명에 우리 브랜드 포함, 또는 노출상품ID 가 마진계산·윙 스냅샷 노출ID)만 저장하고
 * 지난 스냅샷들과 비교한다. 1P 옵션↔노출상품ID 공식 소스가 없어 이 검색이 유일한 직접 경로.
 *
 * 틀릴 케이스 (메시지 하단에 상시 표기):
 *   검색 상위 결과(키워드당 limit) 밖 상품은 누락 / 검색 순위 변동으로 '사라짐' 오탐 가능(2일 연속일 때만 경고)
 *   / 1P 옵션 단위 매핑은 productUrl 에 vendorItemId 가 있을 때만
 */

export type SearchItem = {
  kw: string // 검색 키워드
  rank: number
  pid: string // productId = 노출상품ID
  name: string
  rocket: boolean
  cat: string
  pageKey: string // productUrl 쿼리값 (없으면 '')
  itemId: string
  vendorItemId: string
}

export type SearchSnapshot = {
  date: string // KST YYYY-MM-DD
  collectedAt: string
  limitUsed: number
  keywords: { kw: string; count: number; ours: number; withVendorItemId: number; error?: string }[]
  items: SearchItem[] // 우리 상품만
}

export const SEARCH_ID_PREFIX = 'coupang_catalog_search_'
export const searchSnapshotId = (date: string) => `${SEARCH_ID_PREFIX}${date}`

export const SEARCH_CAVEATS = [
  '검색 상위 결과(키워드당 상한) 밖 상품은 누락',
  '검색 순위 변동으로 사라짐 오탐 가능 — 2일 연속 안 보일 때만 경고',
  '1P 옵션 단위 매핑(🔴 결합 변동)은 productUrl 에 vendorItemId 가 있을 때만',
]

/** productUrl 쿼리값 (pageKey·itemId·vendorItemId) — 파트너스 링크·쿠팡 링크 둘 다 */
export function urlIds(url: string): { pageKey: string; itemId: string; vendorItemId: string } {
  const out = { pageKey: '', itemId: '', vendorItemId: '' }
  try {
    const u = new URL(url)
    out.pageKey = u.searchParams.get('pageKey') ?? ''
    out.itemId = u.searchParams.get('itemId') ?? ''
    out.vendorItemId = u.searchParams.get('vendorItemId') ?? ''
    if (!out.pageKey) out.pageKey = /\/products\/(\d+)/.exec(u.pathname)?.[1] ?? ''
  } catch {
    /* 형식 다른 URL — 빈값 */
  }
  return out
}

export const isOurs = (it: { pid: string; name: string }, brands: string[], knownPids: Set<string>) =>
  knownPids.has(it.pid) || brands.some((b) => it.name.includes(b))

const normName = (s: string) => s.replace(/\s+/g, '').toLowerCase()

export type SearchDiff = {
  bindChanged: { item: SearchItem; fromPid: string }[] // 🔴 같은 vendorItemId 의 노출상품ID 변경
  newPages: { item: SearchItem; sameNamePids: string[] }[] // 🔴 처음 보는 우리 로켓 노출상품ID
  missing2: { pid: string; name: string }[] // 🟠 알던 노출상품ID 2일 연속 안 보임 (오늘 처음 2일째)
}

/** history = 오늘 전 스냅샷 (오래된 → 최근). knownPids = 마진계산·윙 노출ID */
export function diffSearch(history: SearchSnapshot[], cur: SearchSnapshot, knownPids: Set<string>): SearchDiff {
  const prev = history[history.length - 1]
  const prev2 = history[history.length - 2]
  const curPids = new Set(cur.items.map((x) => x.pid))
  const seen = new Set<string>()
  for (const s of history) for (const x of s.items) seen.add(x.pid)

  const bindChanged: SearchDiff['bindChanged'] = []
  if (prev) {
    const byVi = new Map(prev.items.filter((x) => x.vendorItemId).map((x) => [x.vendorItemId, x.pid]))
    const done = new Set<string>()
    for (const x of cur.items) {
      if (!x.vendorItemId || done.has(x.vendorItemId)) continue
      const from = byVi.get(x.vendorItemId)
      if (from && from !== x.pid) {
        bindChanged.push({ item: x, fromPid: from })
        done.add(x.vendorItemId)
      }
    }
  }

  const newPages: SearchDiff['newPages'] = []
  if (history.length) {
    const pidsByName = new Map<string, Set<string>>()
    for (const s of history) for (const x of s.items) pidsByName.set(normName(x.name), (pidsByName.get(normName(x.name)) ?? new Set()).add(x.pid))
    const done = new Set<string>(bindChanged.map((b) => b.item.pid)) // 결합 변동으로 이미 알린 페이지는 빼고
    for (const x of cur.items) {
      if (!x.rocket || seen.has(x.pid) || knownPids.has(x.pid) || done.has(x.pid)) continue
      done.add(x.pid)
      newPages.push({ item: x, sameNamePids: [...(pidsByName.get(normName(x.name)) ?? [])].filter((p) => p !== x.pid) })
    }
  }

  const missing2: SearchDiff['missing2'] = []
  if (prev && prev2) {
    const prevPids = new Set(prev.items.map((x) => x.pid))
    const names = new Map(prev2.items.map((x) => [x.pid, x.name]))
    for (const [pid, name] of names) if (!prevPids.has(pid) && !curPids.has(pid)) missing2.push({ pid, name })
  }
  return { bindChanged, newPages, missing2 }
}

const pageUrl = (pid: string) => `https://www.coupang.com/vp/products/${pid}`

/** 슬랙 '2단계(검색)' 블록 줄 목록. 첫 보고(이전 스냅샷 없음)엔 측정값 3가지 */
export function buildSearchBlock(o: {
  cur: SearchSnapshot
  history: SearchSnapshot[]
  knownPids: Set<string>
  masterPids: Set<string> | null // 마진계산 노출ID (커버리지 분모). 못 읽으면 null
  isMonday: boolean
}): string[] {
  const { cur } = o
  const L: string[] = [`*2단계(검색)* — 키워드 ${cur.keywords.length}개 · 우리 상품 노출상품 ${new Set(cur.items.map((x) => x.pid)).size}개`]
  const errs = cur.keywords.filter((k) => k.error)
  if (errs.length) L.push(`🟠 검색 실패 키워드 ${errs.length}개: ${errs.slice(0, 5).map((k) => k.kw).join(', ')}${errs.length > 5 ? ' 외' : ''}`)
  const coverage = () => {
    if (!o.masterPids || !o.masterPids.size) return '⚪ 커버리지: 마진계산 노출ID 목록을 못 읽어 생략'
    const found = [...o.masterPids].filter((p) => cur.items.some((x) => x.pid === p)).length
    return `⚪ 커버리지: 마진계산 노출ID ${o.masterPids.size}개 중 ${found}개가 검색에 잡힘 (${Math.round((found / o.masterPids.size) * 100)}%)`
  }
  if (!o.history.length) {
    const all = cur.keywords.reduce((a, k) => a + k.count, 0)
    const withVi = cur.keywords.reduce((a, k) => a + k.withVendorItemId, 0)
    const counts = cur.keywords.map((k) => k.count).sort((a, b) => a - b)
    const zero = cur.keywords.filter((k) => !k.error && k.count === 0)
    L.push('첫 측정 — 다음 실행부터 비교합니다')
    L.push(`• productUrl 에 vendorItemId: 결과 ${all}개 중 ${withVi}개 (${all ? Math.round((withVi / all) * 100) : 0}%) → 1P 옵션 단위 🔴 ${withVi > 0 ? '가능' : '불가 (새 페이지·사라짐만)'}`)
    L.push(`• ${coverage().replace(/^⚪ /, '')}`)
    L.push(`• 키워드당 결과 수: 최소 ${counts[0] ?? 0} · 중간 ${counts[Math.floor(counts.length / 2)] ?? 0} · 최대 ${counts[counts.length - 1] ?? 0} (상한 ${cur.limitUsed})${zero.length ? ` · 0건 ${zero.length}개: ${zero.slice(0, 5).map((k) => k.kw).join(', ')}` : ''}`)
  } else {
    const d = diffSearch(o.history, cur, o.knownPids)
    const n = d.bindChanged.length + d.newPages.length + d.missing2.length
    if (!n) L.push('변동 없음')
    if (d.bindChanged.length)
      L.push(`🔴 *결합 변동 ${d.bindChanged.length}건 — 같은 옵션(vendorItemId)의 노출상품ID 바뀜*`, ...d.bindChanged.slice(0, 15).map((b) => `• ${b.item.name}: ${b.fromPid} → ${b.item.pid} ${pageUrl(b.item.pid)}`))
    if (d.newPages.length)
      L.push(
        `🔴 *새 로켓 페이지 ${d.newPages.length}개 — 처음 보는 우리 노출상품ID*`,
        ...d.newPages.slice(0, 15).map((p) => `• ${p.item.name} (${p.item.pid}, '${p.item.kw}' ${p.item.rank}위)${p.sameNamePids.length ? ` — 같은 이름 기존 페이지 ${p.sameNamePids.join('·')}` : ''} ${pageUrl(p.item.pid)}`),
      )
    if (d.missing2.length) L.push(`🟠 알던 노출상품 ${d.missing2.length}개가 2일 연속 검색에 안 보임`, ...d.missing2.slice(0, 15).map((m) => `• ${m.name} (${m.pid})`))
  }
  if (o.history.length && o.isMonday) L.push(coverage())
  L.push(...SEARCH_CAVEATS.map((x) => `_검색 한계: ${x}_`))
  return L
}
