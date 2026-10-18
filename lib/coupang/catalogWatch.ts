/**
 * 쿠팡 상품 결합(노출상품ID) 변동 감지 — 1단계: 3P 옵션 이탈 감지 (순수 함수).
 *
 * 입력: 윙 상품조회/수정 > 엑셀 다운로드 두 가지 중 하나 (대표가 아침에 받음)
 *   - Coupang_detailinfo_YYMMDD.xlsx (쿠팡상품정보, Catalog Template) — Template 시트, 헤더에 '노출상품ID'·'옵션 ID'
 *   - price_inventory_YYMMDD.xlsx (가격/재고/판매상태) — data 시트, 헤더에 'Product ID'·'옵션 ID'
 *   두 파일 모두 시트 범위 메타(!ref)가 헤더까지만 적혀 있어 repairRef 로 실제 범위를 다시 잡고 읽는다 (scripts 쪽).
 * 옵션ID 기준으로 직전 스냅샷과 비교해 결합 변동·옵션 증감·판매/승인 상태 변경·페이지 분리를 찾는다.
 * 손익 숫자 없음 — 직원 공유 채널(#쿠팡-결합) 보고용.
 *
 * 한계 (1단계): ① 1P 옵션만 다른 페이지로 분리되는 건 못 잡음(1P 노출상품ID 소스 없음)
 *   ② 다른 판매자 옵션이 우리 페이지에 합쳐지거나 빠지는 건 못 잡음 ③ 대표가 파일을 안 받은 날은 비교 없음
 */

export type CatalogRow = {
  reg: string // 등록상품ID (업체상품 ID)
  name: string // 등록상품명
  appr: string // 승인상태
  sale: string // 판매상태 (판매중 / 판매중지 …)
  pid: string // 노출상품ID (Product ID)
  oid: string // 옵션 ID
  opt: string // 등록 옵션명
}

export type CatalogSnapshot = {
  date: string // 파일명 날짜 YYYY-MM-DD
  fileName: string
  collectedAt: string // 처리 시각 ISO
  rows: CatalogRow[]
}

export const CATALOG_ID_PREFIX = 'coupang_catalog_'
export const catalogSnapshotId = (date: string) => `${CATALOG_ID_PREFIX}${date}`
export const ON_SALE = '판매중'

export const CATALOG_LIMITS = [
  '1P 옵션만 다른 페이지로 분리되는 건 못 잡음 (1P 노출상품ID 소스 없음)',
  '다른 판매자 옵션이 우리 페이지에 합쳐지거나 빠지는 건 못 잡음',
  '대표가 윙 파일을 안 받은 날은 비교 없음',
]

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toLowerCase()
const str = (v: unknown) => (v == null ? '' : String(v).trim())

const HEADERS: Record<keyof CatalogRow, string[]> = {
  reg: ['등록상품id', '업체상품id'],
  name: ['등록상품명', '업체등록상품명'],
  appr: ['승인상태'],
  sale: ['판매상태'],
  pid: ['노출상품id', 'productid'],
  oid: ['옵션id'],
  opt: ['등록옵션명'],
}

/**
 * 시트 행 → 옵션 행. 헤더 행 = '옵션 ID' 와 노출상품ID(또는 Product ID)가 같이 있는 첫 행.
 * 등록상품ID·등록상품명·승인상태는 첫 옵션 행에만 있고 아래는 빈칸(병합)일 수 있어 위 값으로 채운다.
 * 판매상태·노출상품ID·옵션명은 옵션마다 따로라 채우지 않는다. 옵션 ID 없는 행은 버린다.
 */
export function parseCatalogRows(rows: unknown[][]): CatalogRow[] {
  const hi = rows.findIndex((r) => {
    const n = (r || []).map(norm)
    return n.includes('옵션id') && (n.includes('노출상품id') || n.includes('productid'))
  })
  if (hi < 0) return []
  const head = (rows[hi] || []).map(norm)
  const col = {} as Record<keyof CatalogRow, number>
  for (const k of Object.keys(HEADERS) as (keyof CatalogRow)[]) col[k] = head.findIndex((h) => HEADERS[k].includes(h))
  if (col.oid < 0 || col.pid < 0) return []
  const out: CatalogRow[] = []
  let last = { reg: '', name: '', appr: '' }
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || []
    const at = (k: keyof CatalogRow) => (col[k] >= 0 ? str(r[col[k]]) : '')
    const oid = at('oid')
    const regRaw = at('reg')
    if (regRaw) last = { reg: regRaw, name: at('name'), appr: at('appr') }
    if (!oid || !/^\d+$/.test(oid)) continue
    out.push({
      reg: regRaw || last.reg,
      name: at('name') || last.name,
      appr: at('appr') || last.appr,
      sale: at('sale'),
      pid: at('pid'),
      oid,
      opt: at('opt'),
    })
  }
  return out
}

// ── 비교 ─────────────────────────────────────────────────────────
export type BindChange = { row: CatalogRow; fromPid: string }
export type StateChange = { row: CatalogRow; from: string }
export type CatalogDiff = {
  bindChanged: BindChange[] // 🔴 노출상품ID 바뀜
  removed: CatalogRow[] // 🟠 옵션 사라짐 (직전 행)
  added: CatalogRow[] // 🟠 새 옵션
  saleChanged: StateChange[] // 🟠 판매상태 변경
  apprChanged: StateChange[] // 🟠 승인상태 변경
}

export function diffCatalog(prev: CatalogRow[], cur: CatalogRow[]): CatalogDiff {
  const p = new Map(prev.map((r) => [r.oid, r]))
  const c = new Map(cur.map((r) => [r.oid, r]))
  const d: CatalogDiff = { bindChanged: [], removed: [], added: [], saleChanged: [], apprChanged: [] }
  for (const r of cur) {
    const o = p.get(r.oid)
    if (!o) {
      d.added.push(r)
      continue
    }
    if (o.pid !== r.pid) d.bindChanged.push({ row: r, fromPid: o.pid })
    if (o.sale !== r.sale) d.saleChanged.push({ row: r, from: o.sale })
    if (o.appr !== r.appr) d.apprChanged.push({ row: r, from: o.appr })
  }
  for (const r of prev) if (!c.has(r.oid)) d.removed.push(r)
  return d
}

export const diffCount = (d: CatalogDiff) =>
  d.bindChanged.length + d.removed.length + d.added.length + d.saleChanged.length + d.apprChanged.length

/** 한 등록상품의 '판매중' 옵션이 노출상품ID 2개 이상으로 갈라진 것 */
export type SplitProduct = { reg: string; name: string; pids: { pid: string; opts: string[] }[] }
export function splitProducts(rows: CatalogRow[]): SplitProduct[] {
  const by = new Map<string, { name: string; pids: Map<string, string[]> }>()
  for (const r of rows) {
    if (r.sale !== ON_SALE || !r.pid) continue
    const g = by.get(r.reg) ?? { name: r.name, pids: new Map() }
    const opts = g.pids.get(r.pid) ?? []
    if (!opts.includes(r.opt)) opts.push(r.opt) // 같은 옵션명 중복은 한 번만
    g.pids.set(r.pid, opts)
    by.set(r.reg, g)
  }
  return [...by.entries()]
    .filter(([, g]) => g.pids.size >= 2)
    .map(([reg, g]) => ({ reg, name: g.name, pids: [...g.pids.entries()].map(([pid, opts]) => ({ pid, opts })) }))
}
const splitKey = (s: SplitProduct) => `${s.reg}:${s.pids.map((p) => p.pid).sort().join(',')}`

/** 판매중 옵션의 노출상품ID 중 나무_마스터 마진계산 노출ID 목록에 없는 것 (BEP 추적 밖) */
export type Untracked = { pid: string; name: string; options: number }
export function untrackedPids(rows: CatalogRow[], masterPids: Set<string>): Untracked[] {
  const by = new Map<string, Untracked>()
  for (const r of rows) {
    if (r.sale !== ON_SALE || !r.pid || masterPids.has(r.pid)) continue
    const u = by.get(r.pid) ?? { pid: r.pid, name: r.name, options: 0 }
    u.options += 1
    by.set(r.pid, u)
  }
  return [...by.values()].sort((a, b) => b.options - a.options)
}

export const onSaleStats = (rows: CatalogRow[]) => {
  const on = rows.filter((r) => r.sale === ON_SALE)
  return { options: on.length, pids: new Set(on.map((r) => r.pid).filter(Boolean)).size }
}

// ── 슬랙 메시지 (mrkdwn 텍스트) ──────────────────────────────────
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
const optLabel = (r: CatalogRow) => `${r.name} · ${r.opt || r.oid}`
const pageUrl = (pid: string) => `https://www.coupang.com/vp/products/${pid}`
const MAX_LINES = 15 // 항목별 최대 줄 — 넘으면 '외 N개'

function listLines<T>(items: T[], line: (x: T) => string): string[] {
  const out = items.slice(0, MAX_LINES).map((x) => `• ${line(x)}`)
  if (items.length > MAX_LINES) out.push(`• 외 ${items.length - MAX_LINES}개`)
  return out
}

export function buildCatalogMessage(o: {
  cur: CatalogSnapshot
  prev: CatalogSnapshot | null
  masterPids: Set<string> | null // 못 읽었으면 null → ⚪ 줄에 '못 읽음'
  isMonday: boolean
}): string {
  const { cur, prev } = o
  const stat = onSaleStats(cur.rows)
  const splitsNow = splitProducts(cur.rows)
  const L: string[] = []
  const untrackedLine = () => {
    if (!o.masterPids) return '⚪ 마진계산 노출ID 목록을 못 읽어 BEP 추적 밖 노출상품은 이번엔 생략'
    const u = untrackedPids(cur.rows, o.masterPids)
    return u.length
      ? `⚪ 판매중인데 마진계산 노출ID에 없는 노출상품 ${u.length}개 (BEP 추적 밖): ${u
          .slice(0, 8)
          .map((x) => `${x.name}(${x.pid}, 옵션 ${x.options})`)
          .join(', ')}${u.length > 8 ? ` 외 ${u.length - 8}개` : ''}`
      : '⚪ 판매중 노출상품 모두 마진계산 노출ID에 있음'
  }
  const splitLines = (list: SplitProduct[]) =>
    listLines(list, (s) => `${s.name} (${s.reg}): ${s.pids.map((p) => `${p.pid}[${p.opts.join('·')}]`).join(' / ')}`)
  const limits = ['_1단계(3P 옵션 이탈 감지) 한계_', ...CATALOG_LIMITS.map((x, i) => `_${'①②③'[i]} ${x}_`)]

  if (!prev) {
    L.push(`*[쿠팡 결합 점검 ${md(cur.date)}] 기준선 저장 — 판매중 옵션 ${stat.options} · 노출상품 ${stat.pids}*`)
    L.push(`다음 파일부터 오늘과 비교합니다 (${cur.fileName}, 옵션 ${cur.rows.length}행)`)
    if (splitsNow.length) L.push('', `🟠 *판매중 옵션이 노출상품 여러 개로 갈라진 등록상품 ${splitsNow.length}개 (현재 상태)*`, ...splitLines(splitsNow))
    L.push('', untrackedLine(), '', ...limits)
    return L.join('\n')
  }

  const d = diffCatalog(prev.rows, cur.rows)
  const splitsPrev = new Set(splitProducts(prev.rows).map(splitKey))
  const newSplits = splitsNow.filter((s) => !splitsPrev.has(splitKey(s)))
  const n = diffCount(d) + newSplits.length
  L.push(`*[쿠팡 결합 점검 ${md(cur.date)}] 판매중 옵션 ${stat.options} · 변동 ${n}건* (비교: ${md(prev.date)})`)
  if (n === 0) {
    L.push(`변동 없음 — 판매중 ${stat.options}옵션·${stat.pids}노출상품`)
  } else {
    if (d.bindChanged.length)
      L.push('', `🔴 *결합 변동 ${d.bindChanged.length}건 — 노출상품ID 바뀜*`, ...listLines(d.bindChanged, (b) => `${optLabel(b.row)}: ${b.fromPid} → ${b.row.pid} ${pageUrl(b.row.pid)}`))
    if (d.removed.length) L.push('', `🟠 옵션 사라짐 ${d.removed.length}건`, ...listLines(d.removed, (r) => `${optLabel(r)} (${r.pid}, ${r.sale})`))
    if (d.added.length) L.push('', `🟠 새 옵션 ${d.added.length}건`, ...listLines(d.added, (r) => `${optLabel(r)} (${r.pid}, ${r.sale})`))
    if (d.saleChanged.length) L.push('', `🟠 판매상태 변경 ${d.saleChanged.length}건`, ...listLines(d.saleChanged, (s) => `${optLabel(s.row)}: ${s.from} → ${s.row.sale}`))
    if (d.apprChanged.length) L.push('', `🟠 승인상태 변경 ${d.apprChanged.length}건`, ...listLines(d.apprChanged, (s) => `${optLabel(s.row)}: ${s.from} → ${s.row.appr}`))
    if (newSplits.length) L.push('', `🟠 새로 갈라진 등록상품 ${newSplits.length}개 (판매중 옵션이 노출상품 여러 개)`, ...splitLines(newSplits))
  }
  if (o.isMonday) L.push('', untrackedLine())
  return L.join('\n')
}
