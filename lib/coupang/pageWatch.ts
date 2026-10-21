/**
 * 쿠팡 상품 페이지 가격 점검 — 순수 함수 (시트 판매가 ↔ 페이지 일반 판매가 대조, 어제 대비, 품절, 후기 급감, 미등록).
 *
 * 입력
 *   targets: 나무_마스터 마진계산에서 뽑은 대상 (채널 쿠팡 1P·3P, 노출상품ID W·옵션ID X·실판매가 D·쿠팡옵션명 AD) — scripts/coupang-page-watch/run.ts --targets
 *   pages:   16GB 클로드가 크롬 확장으로 읽어 적은 페이지 결과 JSON (scripts/crawler-16gb/jobs/page-price-check.md 의 형식)
 * 출력: 스냅샷(dashboard_data 'coupang_page_YYYY-MM-DD') + 슬랙 한 장 (#쿠팡-결합, 직원 공유 채널 — 마진·손익 숫자 없음, 가격·%만)
 *
 * 기준 가격 = 페이지 '일반 판매가'(price). 와우가·쿠폰가·정가는 참고 저장·표시만.
 * 옵션 매칭: 옵션ID(vendorItemId) 우선 → 쿠팡옵션명(AD) 정규화 일치 → 'N개' 봉수 토큰 (그 페이지 안에서 유일할 때만)
 */

export const PAGE_ID_PREFIX = 'coupang_page_'
export const pageSnapshotId = (date: string) => `${PAGE_ID_PREFIX}${date}`

/** 알림 기준 — 시트가와 이 % 넘게 다를 때만 (0 = 1원이라도 다르면 전부. 대표 확정 2026-10-21) */
export const PRICE_DIFF_MIN_PCT = 0
/** 후기 급감 — 어제보다 이 % 넘게 줄고, 어제 후기가 이 개수 이상일 때 */
export const REVIEW_DROP_PCT = 20
export const REVIEW_DROP_MIN = 20

export type TargetOption = {
  oid: string // 옵션ID (vendorItemId). 1P 는 비어 있을 수 있음
  channel: '쿠팡 1P' | '쿠팡 3P'
  sheetPrice: number | null // 마진계산 AE '쿠팡 소비자가(기준)' — 비어 있으면 null (비교 안 함, '기준가 없음' 으로 셈). 1P 는 D 가 납품가라 D 를 쓰지 않는다 (대표 결정 2026-10-21)
  bagCount: number // C 봉수
  optionName: string // AD 쿠팡옵션명 (없으면 '')
}
export type TargetPage = { pid: string; alias: string; options: TargetOption[] }

export type PageOption = {
  label: string
  oid?: string // 페이지에서 읽힌 vendorItemId (있을 때만)
  price: number | null // 일반 판매가 (기준)
  listPrice?: number | null // 정가 (취소선)
  wowPrice?: number | null // 와우 가입 쿠폰가 등 와우 표시가
  couponPrice?: number | null // 쿠폰 적용가
  soldOut?: boolean
}
export type PageResult = {
  pid: string
  readAt: string
  status: 'ok' | 'notfound' | 'blocked' | 'error'
  title?: string
  seller?: string // 판매자명 (쿠팡(주) = 로켓 1P)
  rocket?: boolean
  reviews?: number | null
  soldOut?: boolean // 페이지 전체 품절
  options: PageOption[]
  note?: string
}

/** 스냅샷에 남기는 옵션 1줄 — 다음 날 '어제값·언제부터' 비교용 */
export type PageOptionState = {
  pid: string
  oid: string // 매칭된 시트 옵션ID (미등록이면 '')
  channel: '쿠팡 1P' | '쿠팡 3P' | ''
  alias: string
  label: string
  sheetPrice: number | null
  price: number | null
  listPrice: number | null
  wowPrice: number | null
  couponPrice: number | null
  soldOut: boolean
  diffSince: string | null // 시트와 다른 상태가 시작된 날 (YYYY-MM-DD). 같으면 null
}
export type PageSnapshot = {
  date: string
  collectedAt: string
  pages: PageResult[]
  options: PageOptionState[]
  unread: string[] // 못 읽은 pid
}

const norm = (s: string) => String(s ?? '').replace(/\s+/g, '').replace(/[()\[\],·]/g, '').toLowerCase()
const bagToken = (label: string) => {
  const m = /(\d+)\s*개/.exec(label)
  return m ? Number(m[1]) : null
}

/** 페이지 옵션 ↔ 시트 옵션 매칭. 반환: 시트 옵션별 페이지 옵션(없으면 null) + 시트에 없는 페이지 옵션 */
export function matchOptions(target: TargetPage, page: PageResult): { matched: Map<string, PageOption | null>; unregistered: PageOption[] } {
  const matched = new Map<string, PageOption | null>()
  const used = new Set<PageOption>()
  const pick = (t: TargetOption): PageOption | null => {
    if (t.oid) {
      const byId = page.options.find((o) => o.oid && o.oid === t.oid && !used.has(o))
      if (byId) return byId
    }
    if (t.optionName) {
      const n = norm(t.optionName)
      const byName = page.options.find((o) => norm(o.label) === n && !used.has(o))
      if (byName) return byName
    }
    const byBag = page.options.filter((o) => bagToken(o.label) === t.bagCount && !used.has(o))
    return byBag.length === 1 ? byBag[0] : null
  }
  for (const t of target.options) {
    const o = pick(t)
    if (o) used.add(o)
    matched.set(t.oid || `${target.pid}:${t.bagCount}:${t.optionName}`, o)
  }
  return { matched, unregistered: page.options.filter((o) => !used.has(o)) }
}

export type PriceDiff = { s: PageOptionState; pct: number; prevPrice: number | null }
export type Report = {
  diffs: PriceDiff[] // 시트와 다름
  changed: { s: PageOptionState; from: number | null }[] // 어제와 달라진 페이지가 (시트와 같든 다르든)
  soldOut: PageOptionState[]
  reviewDrops: { pid: string; alias: string; from: number; to: number }[]
  unregistered: PageOptionState[]
  unread: string[]
  unmatched: { pid: string; alias: string; channel: string; bagCount: number; optionName: string }[] // 시트엔 있는데 페이지에서 못 찾음
  noBase: PageOptionState[] // 시트 AE(기준가)가 비어 있어 비교 못 한 옵션
  pagesTotal: number
  optionsTotal: number
}

export function buildSnapshot(o: { date: string; targets: TargetPage[]; pages: PageResult[]; prev: PageSnapshot | null }): { snapshot: PageSnapshot; report: Report } {
  const { date, targets, pages, prev } = o
  const byPid = new Map(pages.map((p) => [p.pid, p]))
  const prevByKey = new Map((prev?.options ?? []).map((s) => [`${s.pid}|${s.oid || s.label}`, s]))
  const prevPage = new Map((prev?.pages ?? []).map((p) => [p.pid, p]))
  const options: PageOptionState[] = []
  const report: Report = { diffs: [], changed: [], soldOut: [], reviewDrops: [], unregistered: [], unread: [], unmatched: [], noBase: [], pagesTotal: targets.length, optionsTotal: 0 }

  for (const t of targets) {
    const p = byPid.get(t.pid)
    if (!p || p.status !== 'ok') {
      report.unread.push(t.pid)
      continue
    }
    const { matched, unregistered } = matchOptions(t, p)
    for (const to of t.options) {
      report.optionsTotal += 1
      const key = to.oid || `${t.pid}:${to.bagCount}:${to.optionName}`
      const po = matched.get(key) ?? null
      if (!po) {
        report.unmatched.push({ pid: t.pid, alias: t.alias, channel: to.channel, bagCount: to.bagCount, optionName: to.optionName })
        continue
      }
      const price = po.price ?? null
      const differs = price != null && to.sheetPrice != null && (Math.abs(price - to.sheetPrice) / to.sheetPrice) * 100 > PRICE_DIFF_MIN_PCT
      const prevS = prevByKey.get(`${t.pid}|${to.oid || po.label}`)
      const s: PageOptionState = {
        pid: t.pid,
        oid: to.oid,
        channel: to.channel,
        alias: t.alias,
        label: po.label,
        sheetPrice: to.sheetPrice,
        price,
        listPrice: po.listPrice ?? null,
        wowPrice: po.wowPrice ?? null,
        couponPrice: po.couponPrice ?? null,
        soldOut: !!(po.soldOut || p.soldOut),
        diffSince: differs ? (prevS?.diffSince && prevS.price === price ? prevS.diffSince : date) : null,
      }
      options.push(s)
      if (to.sheetPrice == null) report.noBase.push(s)
      if (differs) report.diffs.push({ s, pct: ((price! - to.sheetPrice!) / to.sheetPrice!) * 100, prevPrice: prevS?.price ?? null })
      if (prevS && prevS.price != null && price != null && prevS.price !== price) report.changed.push({ s, from: prevS.price })
      if (s.soldOut) report.soldOut.push(s)
    }
    for (const u of unregistered) {
      const s: PageOptionState = {
        pid: t.pid, oid: '', channel: '', alias: t.alias, label: u.label, sheetPrice: null, price: u.price ?? null,
        listPrice: u.listPrice ?? null, wowPrice: u.wowPrice ?? null, couponPrice: u.couponPrice ?? null, soldOut: !!u.soldOut, diffSince: null,
      }
      options.push(s)
      report.unregistered.push(s)
    }
    const pr = prevPage.get(t.pid)
    if (pr?.reviews != null && p.reviews != null && pr.reviews >= REVIEW_DROP_MIN && p.reviews < pr.reviews * (1 - REVIEW_DROP_PCT / 100))
      report.reviewDrops.push({ pid: t.pid, alias: t.alias, from: pr.reviews, to: p.reviews })
  }
  const snapshot: PageSnapshot = { date, collectedAt: new Date().toISOString(), pages, options, unread: report.unread }
  return { snapshot, report }
}

// ── 슬랙 메시지 (마진·손익 없음 — 가격·% 만) ──────────────────────
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
const won = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('ko-KR'))
const pageUrl = (pid: string, oid?: string) => `https://www.coupang.com/vp/products/${pid}${oid ? `?vendorItemId=${oid}` : ''}`
const ch = (c: string) => (c === '쿠팡 1P' ? '1P' : c === '쿠팡 3P' ? '3P' : '?')
const MAX_LINES = 15
function listLines<T>(items: T[], line: (x: T) => string): string[] {
  const out = items.slice(0, MAX_LINES).map((x) => `• ${line(x)}`)
  if (items.length > MAX_LINES) out.push(`• 외 ${items.length - MAX_LINES}개`)
  return out
}

export function buildPageMessage(date: string, r: Report, prevDate: string | null): string {
  const L: string[] = []
  const head = `*[쿠팡 가격 점검 ${md(date)}] 시트와 다름 ${r.diffs.length}건 · 어제와 달라짐 ${r.changed.length}건 · 품절 ${r.soldOut.length} · 못 읽음 ${r.unread.length}/${r.pagesTotal}페이지*`
  L.push(head + (prevDate ? ` (비교: ${md(prevDate)})` : ' (첫 기록 — 어제 비교 없음)'))
  if (r.diffs.length) {
    L.push('', `🔴 *시트 판매가와 다른 옵션 ${r.diffs.length}건*`)
    L.push(
      ...listLines(
        [...r.diffs].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)),
        (d) =>
          `[${ch(d.s.channel)}] ${d.s.alias} · ${d.s.label}: 시트 ${won(d.s.sheetPrice)} → 쿠팡 ${won(d.s.price)} (${d.pct > 0 ? '+' : ''}${d.pct.toFixed(1)}%)` +
          (d.prevPrice != null ? ` · 어제 ${won(d.prevPrice)}` : '') +
          (d.s.diffSince ? ` · ${md(d.s.diffSince)}부터` : '') +
          (d.s.wowPrice != null && d.s.wowPrice > 0 ? ` · 와우 ${won(d.s.wowPrice)}` : '') +
          ` ${pageUrl(d.s.pid, d.s.oid)}`,
      ),
    )
  }
  if (r.changed.length) {
    L.push('', `🟠 *어제와 달라진 페이지 가격 ${r.changed.length}건*`)
    L.push(...listLines(r.changed, (c) => `[${ch(c.s.channel)}] ${c.s.alias} · ${c.s.label}: ${won(c.from)} → ${won(c.s.price)}${c.s.sheetPrice != null && c.s.price === c.s.sheetPrice ? ' (시트와 같아짐)' : ''}`))
  }
  if (r.soldOut.length) {
    L.push('', `⚫ *품절 ${r.soldOut.length}건*`)
    L.push(...listLines(r.soldOut, (s) => `[${ch(s.channel)}] ${s.alias} · ${s.label} ${pageUrl(s.pid)}`))
  }
  if (r.reviewDrops.length) {
    L.push('', `🟡 *후기 급감 ${r.reviewDrops.length}건* (어제보다 ${REVIEW_DROP_PCT}% 넘게 줄어듦)`)
    L.push(...listLines(r.reviewDrops, (x) => `${x.alias}: ${x.from} → ${x.to} ${pageUrl(x.pid)}`))
  }
  if (r.unregistered.length) {
    L.push('', `⚪ 시트에 없는 페이지 옵션(미등록) ${r.unregistered.length}건`)
    L.push(...listLines(r.unregistered, (s) => `${s.alias} 페이지 · ${s.label}: ${won(s.price)}${s.soldOut ? ' (품절)' : ''}`))
  }
  if (r.noBase.length) L.push('', `⚪ 시트 AE(기준가)가 비어 있어 비교 못 한 옵션 ${r.noBase.length}건: ${r.noBase.slice(0, 8).map((s) => `${s.alias} ${s.label}`).join(', ')}${r.noBase.length > 8 ? ` 외 ${r.noBase.length - 8}개` : ''}`)
  if (r.unmatched.length) L.push('', `⚪ 시트엔 있는데 페이지에서 못 찾은 옵션 ${r.unmatched.length}건: ${r.unmatched.slice(0, 8).map((u) => `${u.alias} ${u.bagCount}개(${ch(u.channel)})`).join(', ')}${r.unmatched.length > 8 ? ` 외 ${r.unmatched.length - 8}개` : ''}`)
  if (r.unread.length) L.push('', `_못 읽은 페이지 ${r.unread.length}개: ${r.unread.slice(0, 10).join(', ')}${r.unread.length > 10 ? ' …' : ''}_`)
  if (!r.diffs.length && !r.changed.length && !r.soldOut.length && !r.reviewDrops.length) L.push('', `변동 없음 — 옵션 ${r.optionsTotal}개 모두 시트와 같음`)
  L.push('', '_기준: 페이지 일반 판매가. 카드·장바구니 쿠폰 등 페이지에 안 보이는 할인, 하루 1회 이후 변동, 시트 미등록 신상품은 못 잡음_')
  return L.join('\n')
}
