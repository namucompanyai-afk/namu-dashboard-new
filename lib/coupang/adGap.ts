/**
 * "팔리는데 광고 없는 1P" 판정 — 순수 함수.
 *
 * 문제: 옵션ID 하나하나를 '30일 광고 보고서(클릭 키워드만)'의 광고집행 옵션ID 로만 맞추면,
 *   같은 상품의 봉수별 옵션 중 클릭이 한 번도 없었던 옵션은 캠페인이 분명히 켜져 있어도 "광고 없음"으로 오판된다(약 90%).
 * 해법: **별칭(상품) 단위로 광고 연결 여부를 본다.** ① 옵션ID가 광고 행에 직접 나오면 그 옵션의 별칭을 "광고 있음" ②
 *   1P 캠페인 이름(판매방식 Retail)에서 브랜드·모드(AI/수동/스마트)·숫자를 뺀 "상품 토큰"이 별칭과 겹치면 그 별칭 전체를 "광고 있음"
 *   (캠페인 하나가 보통 같은 상품의 여러 봉수를 함께 묶으므로, 봉수 하나만 클릭 있어도 나머지 봉수까지 전부 커버됨).
 * 입력: 나무_마스터 1P 행(옵션ID·별칭) · 최근 30일 광고 행(coupang_ad_live_30d) · 허브 판매 분석(4주, 판매 수량>0) · 광고센터 재고(task 6, coupang_1p_stock)
 * 출력: 판매는 있는데 광고 연결이 안 된 옵션 목록(품절은 따로) — 월요일 슬랙 1줄 + out/ad_gap.json(옵션별 근거)
 *
 * 한계: 캠페인 이름이 실제 상품명과 많이 다르면(마케팅용 별명 등) 못 잡는다. 클릭이 전혀 없던 상품은 캠페인 자체가 광고 행에
 *   한 번도 안 잡혀 완전히 놓칠 수 있다(광고센터 캠페인 목록 화면을 읽기 전까진 못 메움 — 다음 단계 숙제).
 */

export type MarginOneP = { optionId: string; alias: string }
export type AdRowLite = { campaignName: string; saleMethod?: string; adOptionId: string }
export type SalesRow = { optionId: string; name: string; qty: number }
export type StockInfo = { stock: number | null; soldOut: boolean }

const norm = (s: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase()
const DROP_TOKENS = new Set(['ai', '수동', '스마트', '1p', '3p'])

/** 캠페인명에서 브랜드 괄호·모드(AI/수동/스마트)·숫자 나열을 빼고 남는 "상품 토큰" */
export function campaignProductToken(name: string): string {
  const parts = String(name ?? '').split(/[_\s]+/).filter(Boolean)
  const out: string[] = []
  parts.forEach((p, i) => {
    if (i === 0 && /^\[.*\]$/.test(p)) return // 맨 앞 [브랜드]
    if (DROP_TOKENS.has(p.toLowerCase())) return
    if (/^[\d%/]+$/.test(p)) return // 숫자·퍼센트·캠페인번호 나열
    out.push(p)
  })
  return out.join('')
}

export type AdGapItem = {
  optionId: string
  alias: string
  name: string
  qty: number
  matched: boolean
  matchedBy: 'optionId' | 'name' | ''
  stock: number | null
  soldOut: boolean
}
export type AdGapReport = { totalSold: number; items: AdGapItem[]; noAd: AdGapItem[]; noAdSoldOut: AdGapItem[] }

export function buildAdGapReport(o: { oneP: MarginOneP[]; adRows: AdRowLite[]; sales: SalesRow[]; stock: Map<string, StockInfo> }): AdGapReport {
  const oneByOid = new Map(o.oneP.map((x) => [x.optionId, x]))
  const retailRows = o.adRows.filter((r) => r.saleMethod === 'Retail')
  const directHitOid = new Set(retailRows.map((r) => r.adOptionId).filter(Boolean))

  const aliasPool = [...new Set(o.oneP.map((x) => x.alias).filter(Boolean))]
  const normAlias = new Map(aliasPool.map((a) => [a, norm(a)]))
  const nameHitAlias = new Set<string>()
  for (const r of retailRows) {
    const tok = norm(campaignProductToken(r.campaignName))
    if (!tok || tok.length < 2) continue // 너무 짧은 토큰(브랜드만 남는 등)은 오매칭 위험이라 건너뜀
    for (const alias of aliasPool) {
      if (nameHitAlias.has(alias)) continue
      const na = normAlias.get(alias)!
      if (na.length >= 2 && (na.includes(tok) || tok.includes(na))) nameHitAlias.add(alias)
    }
  }

  const items: AdGapItem[] = []
  for (const s of o.sales) {
    if (!(s.qty > 0)) continue
    const base = oneByOid.get(s.optionId)
    const alias = base?.alias || s.name
    const byOid = directHitOid.has(s.optionId)
    const byName = nameHitAlias.has(alias)
    const matchedBy: AdGapItem['matchedBy'] = byOid ? 'optionId' : byName ? 'name' : ''
    const st = o.stock.get(s.optionId)
    items.push({ optionId: s.optionId, alias, name: s.name, qty: s.qty, matched: !!matchedBy, matchedBy, stock: st?.stock ?? null, soldOut: !!st?.soldOut })
  }
  const noAd = items.filter((x) => !x.matched && !x.soldOut)
  const noAdSoldOut = items.filter((x) => !x.matched && x.soldOut)
  return { totalSold: items.length, items, noAd, noAdSoldOut }
}

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`

/** 슬랙 1줄(요청: 딱 1줄) — 상세는 ad_gap.json 에 */
export function buildAdGapMessage(date: string, r: AdGapReport): string {
  const names = [...new Set(r.noAd.map((x) => x.alias))]
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` 외 ${names.length - 6}개` : '')
  const soldOutNote = r.noAdSoldOut.length ? ` (품절이라 뺀 것 ${r.noAdSoldOut.length}개 별도)` : ''
  if (!r.totalSold) return `*[1P 광고 점검 ${md(date)}]* 4주 판매 데이터 없음 — 허브 판매 분석 확인 필요`
  if (!r.noAd.length) return `*[1P 광고 점검 ${md(date)}]* 4주 판매 ${r.totalSold}개 중 광고 없음 0개${soldOutNote}`
  return `*[1P 광고 점검 ${md(date)}]* 4주 판매 ${r.totalSold}개 중 광고 없음 ${r.noAd.length}개: ${shown}${soldOutNote}`
}
