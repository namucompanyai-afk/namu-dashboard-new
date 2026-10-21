/**
 * 쿠팡 상품 페이지 가격 점검 — 순수 함수 (시트 기준가 ↔ 페이지 일반 판매가 대조, 어제 대비, 품절, 후기 급감, 남의 옵션, 미등록).
 *
 * 입력
 *   targets: 나무_마스터 마진계산에서 뽑은 대상 (채널 쿠팡 1P·3P, 노출상품ID W·옵션ID X·기준가 AE·봉수 C·쿠팡옵션명 AD) — scripts/coupang-page-watch/run.ts --targets
 *   pages:   16GB 클로드가 크롬 확장으로 읽어 적은 페이지 결과 JSON (scripts/crawler-16gb/jobs/page-price-check.md 의 형식)
 * 출력: 스냅샷(dashboard_data 'coupang_page_YYYY-MM-DD') + 슬랙 한 장 (#쿠팡-결합, 직원 공유 채널 — 마진·손익 숫자 없음, 가격·%만)
 *
 * 기준 가격 = 페이지 '일반 판매가'(price). 와우가·쿠폰가·정가는 참고 저장·표시만.
 * 옵션 매칭 (2026-10-21 10페이지 시험 뒤 확정): ① 옵션ID(vendorItemId) 일치만 정식. ② 이름 맞추기는 그 옵션의 판매자가 우리(나무컴퍼니·보배마을·쌀쌀쌀·토지랑)이고
 *   용량·개수 표기(1kg×1개 등)가 같고 짝이 하나뿐일 때만. 남의 판매자 옵션엔 절대 붙이지 않는다 (10/21 홍미 페이지에서 '74트리' 옵션에 붙어 가짜 알림 난 사례).
 */

export const PAGE_ID_PREFIX = 'coupang_page_'
export const pageSnapshotId = (date: string) => `${PAGE_ID_PREFIX}${date}`

/** 알림 기준 — 시트가와 이 % 넘게 다를 때만 (0 = 1원이라도 다르면 전부. 대표 확정 2026-10-21) */
export const PRICE_DIFF_MIN_PCT = 0
/** 후기 급감 — 어제보다 이 % 넘게 줄고, 어제 후기가 이 개수 이상일 때 */
export const REVIEW_DROP_PCT = 20
export const REVIEW_DROP_MIN = 20
/** 우리 판매자 표기 */
export const OUR_SELLER_RE = /나무컴퍼니|보배마을|쌀쌀쌀|토지랑|namucompany/i
const ROCKET_SELLER_RE = /쿠팡\s*\(주\)|쿠팡㈜|로켓/

export type TargetOption = {
  oid: string // 옵션ID (vendorItemId). 1P 는 비어 있을 수 있음
  channel: '쿠팡 1P' | '쿠팡 3P'
  sheetPrice: number | null // 마진계산 AE '쿠팡 소비자가(기준)' — 비어 있으면 null (비교 안 함, '기준가 없음' 으로 셈)
  bagCount: number // C 봉수
  optionName: string // AD 쿠팡옵션명 (없으면 '')
}
export type TargetPage = { pid: string; alias: string; options: TargetOption[] }

export type PageOption = {
  label: string
  oid?: string // 페이지에서 읽힌 vendorItemId (있을 때만)
  seller?: string // 그 옵션의 판매자 (보이면). 없으면 페이지 판매자로 봄
  price: number | null // 일반 판매가 (기준)
  listPrice?: number | null
  wowPrice?: number | null
  couponPrice?: number | null
  soldOut?: boolean
}
export type PageResult = {
  pid: string
  readAt: string
  status: 'ok' | 'notfound' | 'blocked' | 'error'
  title?: string
  seller?: string // 페이지 대표 판매자 (쿠팡(주) = 로켓)
  rocket?: boolean
  reviews?: number | null
  soldOut?: boolean
  vendorItemIds?: string[] // 페이지(링크·내장 데이터)에 있는 옵션ID 전부 — 시트 옵션이 '페이지에 있는지' 판단용
  options: PageOption[]
  note?: string
}

export type PageOptionState = {
  pid: string
  oid: string // 매칭된 시트 옵션ID (미등록이면 '')
  channel: '쿠팡 1P' | '쿠팡 3P' | ''
  alias: string
  label: string
  seller: string
  sheetPrice: number | null
  price: number | null
  listPrice: number | null
  wowPrice: number | null
  couponPrice: number | null
  soldOut: boolean
  matchedBy: 'oid' | 'name' | '' // 어떻게 짝 맞췄나 ('' = 시트에 없는 페이지 옵션)
  ambiguous: boolean // 이름으로 맞췄는데 시트에 같은 표기 행이 여럿 (옵션ID로 확정 필요)
  diffSince: string | null // 시트와 다른 상태가 시작된 날. 같으면 null
}
export type PageSnapshot = {
  date: string
  collectedAt: string
  pages: PageResult[]
  options: PageOptionState[]
  unread: string[]
}

// ── 표기 서명: "1kg (1kgx3봉) × 1개" → 1kg·3봉·1개 처럼 용량·봉·개수 토큰만 ──
export function sizeSig(label: string): string {
  const s = String(label ?? '').toLowerCase().replace(/\s+/g, '')
  const tok = new Set<string>()
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(kg|g|ml|l)(?![a-z])/g)) tok.add(`${Number(m[1])}${m[2]}`)
  for (const m of s.matchAll(/(\d+)(개|봉|박스|팩|입)/g)) tok.add(`${Number(m[1])}${m[2]}`)
  return [...tok].sort().join('|')
}
export type SellerKind = 'ours' | 'rocket' | 'foreign' | 'unknown'
export function sellerKind(s: string | undefined): SellerKind {
  const t = String(s ?? '').trim()
  if (!t) return 'unknown'
  if (OUR_SELLER_RE.test(t)) return 'ours'
  if (ROCKET_SELLER_RE.test(t)) return 'rocket'
  return 'foreign'
}

export type UnmatchedKind = 'absent' | 'taken' | 'noOid' | 'dup' | 'unread'
export type Unmatched = { pid: string; alias: string; channel: string; oid: string; bagCount: number; optionName: string; kind: UnmatchedKind }
export const UNMATCHED_LABEL: Record<UnmatchedKind, string> = {
  absent: '페이지에 없음',
  taken: '그 자리에 남의 옵션',
  noOid: '옵션ID 못 읽음',
  dup: '시트 중복 행(짝은 있음)',
  unread: '페이지에 있는데 값 못 읽음',
}

/** 페이지 옵션 ↔ 시트 옵션 매칭 */
export type Match = { opt: PageOption; by: 'oid' | 'name'; ambiguous?: boolean } // ambiguous = 시트에 같은 표기 행이 여럿이라 옵션ID로 확정 필요
export function matchOptions(target: TargetPage, page: PageResult): { matched: Map<string, Match | null>; rest: PageOption[] } {
  const matched = new Map<string, Match | null>()
  const used = new Set<PageOption>()
  const key = (t: TargetOption) => t.oid || `${target.pid}:${t.bagCount}:${t.optionName}`
  const optSeller = (o: PageOption) => sellerKind(o.seller || page.seller)
  // ① 옵션ID 일치
  for (const t of target.options) {
    if (!t.oid) continue
    const o = page.options.find((x) => x.oid && x.oid === t.oid && !used.has(x))
    if (o) {
      used.add(o)
      matched.set(key(t), { opt: o, by: 'oid' })
    }
  }
  // ② 이름(용량·개수 서명) — 우리 판매자(1P 대상은 쿠팡(주) 도) 옵션 중 옵션ID 없는 것, 짝이 하나뿐일 때만
  //    시트에 같은 표기 행이 둘(옛 옵션ID·새 옵션ID)이고 페이지 옵션이 하나면 첫 행에 붙이고 나머지는 '시트 중복 행' 으로 센다
  for (const t of target.options) {
    if (matched.get(key(t))) continue
    const sig = sizeSig(t.optionName || `${t.bagCount}개`)
    const group = target.options.filter((x) => !matched.get(key(x)) && sizeSig(x.optionName || `${x.bagCount}개`) === sig)
    const cands = page.options.filter((o) => !used.has(o) && !o.oid && sizeSig(o.label) === sig && (optSeller(o) === 'ours' || (t.channel === '쿠팡 1P' && optSeller(o) === 'rocket')))
    //    중복 행 중 기준가(AE)가 페이지 가격과 같은 행이 있으면 그 행에 붙인다 (가짜 '다름' 방지), 없으면 첫 행
    const pick = cands.length === 1 ? group.find((x) => x.sheetPrice != null && x.sheetPrice === cands[0].price) ?? group[0] : null
    if (pick === t) {
      used.add(cands[0])
      matched.set(key(t), { opt: cands[0], by: 'name', ambiguous: group.length > 1 })
    } else matched.set(key(t), null)
  }
  return { matched, rest: page.options.filter((o) => !used.has(o)) }
}

export type PriceDiff = { s: PageOptionState; pct: number; prevPrice: number | null }
export type Report = {
  diffs: PriceDiff[]
  changed: { s: PageOptionState; from: number | null }[]
  soldOut: PageOptionState[]
  reviewDrops: { pid: string; alias: string; from: number; to: number }[]
  foreign: PageOptionState[] // 우리 페이지에 붙은 남의 판매자 옵션 (결합 감시 신호)
  rocket: PageOptionState[] // 쿠팡(주) 옵션인데 시트 1P 행에 없음
  unregistered: PageOptionState[] // 우리 판매자로 확인된 옵션인데 시트에 없음
  unreadOptions: PageOptionState[] // 옵션ID도 판매자도 못 읽은 페이지 옵션 (읽기 실패 — 미등록 아님)
  blocked: string[] // Access Denied 로 못 읽은 pid (그날 전체 중단 신호)
  unmatched: Unmatched[] // 시트엔 있는데 페이지에서 못 찾음 (종류별)
  noBase: PageOptionState[]
  unread: string[]
  pagesTotal: number
  optionsTotal: number
}

export function buildSnapshot(o: { date: string; targets: TargetPage[]; pages: PageResult[]; prev: PageSnapshot | null }): { snapshot: PageSnapshot; report: Report } {
  const { date, targets, pages, prev } = o
  const byPid = new Map(pages.map((p) => [p.pid, p]))
  const prevByKey = new Map((prev?.options ?? []).map((s) => [`${s.pid}|${s.oid || s.label}`, s]))
  const prevPage = new Map((prev?.pages ?? []).map((p) => [p.pid, p]))
  const options: PageOptionState[] = []
  const report: Report = { diffs: [], changed: [], soldOut: [], reviewDrops: [], foreign: [], rocket: [], unregistered: [], unreadOptions: [], unmatched: [], noBase: [], unread: [], blocked: pages.filter((p) => p.status === 'blocked').map((p) => p.pid), pagesTotal: targets.length, optionsTotal: 0 }
  const mk = (t: TargetPage, po: PageOption, p: PageResult, to: TargetOption | null, by: 'oid' | 'name' | ''): PageOptionState => ({
    pid: t.pid,
    oid: to?.oid ?? '',
    channel: to?.channel ?? '',
    alias: t.alias,
    label: po.label,
    seller: po.seller || p.seller || '',
    sheetPrice: to?.sheetPrice ?? null,
    price: po.price ?? null,
    listPrice: po.listPrice ?? null,
    wowPrice: po.wowPrice ?? null,
    couponPrice: po.couponPrice ?? null,
    soldOut: !!(po.soldOut || p.soldOut),
    matchedBy: by,
    ambiguous: false,
    diffSince: null,
  })

  for (const t of targets) {
    const p = byPid.get(t.pid)
    if (!p || p.status !== 'ok') {
      report.unread.push(t.pid)
      continue
    }
    const { matched, rest } = matchOptions(t, p)
    const onPage = new Set(p.vendorItemIds ?? [])
    const key = (x: TargetOption) => x.oid || `${t.pid}:${x.bagCount}:${x.optionName}`
    for (const to of t.options) {
      report.optionsTotal += 1
      const m = matched.get(key(to)) ?? null
      if (!m) {
        const sig = sizeSig(to.optionName || `${to.bagCount}개`)
        const sibling = t.options.some((x) => x !== to && matched.get(key(x)) && sizeSig(x.optionName || `${x.bagCount}개`) === sig)
        const sameSigRest = rest.filter((r) => sizeSig(r.label) === sig)
        let kind: UnmatchedKind = 'absent'
        if (to.oid && onPage.has(to.oid)) kind = 'unread'
        else if (sibling) kind = 'dup'
        else if (sameSigRest.some((r) => sellerKind(r.seller || p.seller) === 'foreign')) kind = 'taken'
        else if (sameSigRest.some((r) => !r.oid)) kind = 'noOid'
        report.unmatched.push({ pid: t.pid, alias: t.alias, channel: to.channel, oid: to.oid, bagCount: to.bagCount, optionName: to.optionName, kind })
        continue
      }
      const s = mk(t, m.opt, p, to, m.by)
      s.ambiguous = !!m.ambiguous
      const differs = s.price != null && to.sheetPrice != null && (Math.abs(s.price - to.sheetPrice) / to.sheetPrice) * 100 > PRICE_DIFF_MIN_PCT
      const prevS = prevByKey.get(`${t.pid}|${to.oid || s.label}`)
      s.diffSince = differs ? (prevS?.diffSince && prevS.price === s.price ? prevS.diffSince : date) : null
      options.push(s)
      if (to.sheetPrice == null) report.noBase.push(s)
      if (differs) report.diffs.push({ s, pct: ((s.price! - to.sheetPrice!) / to.sheetPrice!) * 100, prevPrice: prevS?.price ?? null })
      if (prevS && prevS.price != null && s.price != null && prevS.price !== s.price) report.changed.push({ s, from: prevS.price })
      if (s.soldOut) report.soldOut.push(s)
    }
    for (const r of rest) {
      const s = mk(t, r, p, null, '')
      options.push(s)
      // 시트에 없는 페이지 옵션은 그 옵션에 적힌 판매자로만 판단 (페이지 판매자를 물려받지 않음 — '1개' 같은 남의 옵션이 우리 것으로 보이지 않게)
      const k = sellerKind(r.seller)
      if (k === 'foreign') report.foreign.push(s)
      else if (k === 'rocket') report.rocket.push(s)
      else if (k === 'ours') report.unregistered.push(s)
      else if (r.oid) report.unregistered.push(s) // 옵션ID는 있는데 판매자 미표시 — 시트에 없는 건 맞음
      else report.unreadOptions.push(s)
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
  if (r.blocked.length) L.push(`🚫 *차단 발생 (Access Denied) — ${r.blocked[0]} 에서 멈춤. 16GB 크롬 완전 종료 후 다시 열어야 함*`)
  const head = `*[쿠팡 가격 점검 ${md(date)}] 시트와 다름 ${r.diffs.length}건 · 어제와 달라짐 ${r.changed.length}건 · 품절 ${r.soldOut.length} · 남의 옵션 ${r.foreign.length} · 못 읽음 ${r.unread.length}/${r.pagesTotal}페이지*`
  L.push(head + (prevDate ? ` (비교: ${md(prevDate)})` : ' (첫 기록 — 어제 비교 없음)'))
  if (r.diffs.length) {
    L.push('', `🔴 *시트 기준가와 다른 옵션 ${r.diffs.length}건*`)
    L.push(
      ...listLines(
        [...r.diffs].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)),
        (d) =>
          `[${ch(d.s.channel)}] ${d.s.alias} · ${d.s.label}: 시트 ${won(d.s.sheetPrice)} → 쿠팡 ${won(d.s.price)} (${d.pct > 0 ? '+' : ''}${d.pct.toFixed(1)}%)` +
          (d.prevPrice != null ? ` · 어제 ${won(d.prevPrice)}` : '') +
          (d.s.diffSince ? ` · ${md(d.s.diffSince)}부터` : '') +
          (d.s.wowPrice != null && d.s.wowPrice > 0 ? ` · 와우 ${won(d.s.wowPrice)}` : '') +
          (d.s.matchedBy === 'name' ? (d.s.ambiguous ? ' · (이름으로 짝 맞춤, 시트 중복 행 — 옵션ID 확인 필요)' : ' · (이름으로 짝 맞춤)') : '') +
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
  if (r.foreign.length) {
    L.push('', `⚠️ *우리 페이지에 남의 판매자 옵션 ${r.foreign.length}개* (결합 감시 신호)`)
    L.push(...listLines(r.foreign, (s) => `${s.alias} 페이지 · ${s.label}: 판매자 ${s.seller} · ${won(s.price)}${s.soldOut ? ' (품절)' : ''} ${pageUrl(s.pid)}`))
  }
  if (r.reviewDrops.length) {
    L.push('', `🟡 *후기 급감 ${r.reviewDrops.length}건* (어제보다 ${REVIEW_DROP_PCT}% 넘게 줄어듦)`)
    L.push(...listLines(r.reviewDrops, (x) => `${x.alias}: ${x.from} → ${x.to} ${pageUrl(x.pid)}`))
  }
  if (r.rocket.length) L.push('', `⚪ 쿠팡(주) 로켓 옵션인데 시트 1P 행에 없음 ${r.rocket.length}개: ${[...new Set(r.rocket.map((s) => s.alias))].slice(0, 8).join(', ')}`)
  if (r.unregistered.length) {
    L.push('', `⚪ 시트에 없는 우리 페이지 옵션(미등록) ${r.unregistered.length}건`)
    L.push(...listLines(r.unregistered, (s) => `${s.alias} 페이지 · ${s.label}: ${won(s.price)}${s.seller ? ` · ${s.seller}` : ' · 판매자 미표시'}${s.soldOut ? ' (품절)' : ''}`))
  }
  if (r.unreadOptions.length) L.push('', `⚪ 옵션ID·판매자를 못 읽은 페이지 옵션 ${r.unreadOptions.length}개 (읽기 실패, 미등록 아님): ${[...new Set(r.unreadOptions.map((s) => s.alias))].slice(0, 8).join(', ')}`)
  if (r.noBase.length) L.push('', `⚪ 시트 AE(기준가)가 비어 있어 비교 못 한 옵션 ${r.noBase.length}건: ${r.noBase.slice(0, 8).map((s) => `${s.alias} ${s.label}`).join(', ')}${r.noBase.length > 8 ? ` 외 ${r.noBase.length - 8}개` : ''}`)
  if (r.unmatched.length) {
    const cnt = (k: UnmatchedKind) => r.unmatched.filter((u) => u.kind === k).length
    const parts = (Object.keys(UNMATCHED_LABEL) as UnmatchedKind[]).filter((k) => cnt(k)).map((k) => `${UNMATCHED_LABEL[k]} ${cnt(k)}`)
    L.push('', `⚪ 시트엔 있는데 페이지에서 못 찾은 옵션 ${r.unmatched.length}건 — ${parts.join(' · ')}`)
    const show = r.unmatched.filter((u) => u.kind !== 'dup')
    if (show.length) L.push(...listLines(show.slice(0, 8), (u) => `${u.alias} ${u.bagCount}개(${ch(u.channel)}) — ${UNMATCHED_LABEL[u.kind]}`))
  }
  if (r.unread.length) L.push('', `_못 읽은 페이지 ${r.unread.length}개: ${r.unread.slice(0, 10).join(', ')}${r.unread.length > 10 ? ' …' : ''}_`)
  if (!r.diffs.length && !r.changed.length && !r.soldOut.length && !r.reviewDrops.length && !r.foreign.length) L.push('', `변동 없음 — 짝 맞춘 옵션 ${r.optionsTotal - r.unmatched.length}개 모두 시트와 같음`)
  L.push('', '_기준: 페이지 일반 판매가. 카드·장바구니 쿠폰 등 페이지에 안 보이는 할인, 하루 1회 이후 변동, 시트 미등록 신상품은 못 잡음_')
  return L.join('\n')
}
