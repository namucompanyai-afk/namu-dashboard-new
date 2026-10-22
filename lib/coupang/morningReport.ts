/**
 * 아침 보고서(매일 09:05, 전원 공유 #쿠팡-결합) — 순수 함수.
 *
 * 그날 이미 각 감시 작업(2·3·5·6·8번째)이 저장해 둔 결과를 다시 모아 한 장으로 보여준다 — 새 크롤링 없음.
 * 손익·마진 숫자는 넣지 않는다(그건 C레벨 #손익 전용). 가격·재고·순위·건수만.
 * 소스가 그날 없으면(아직 등록 안 됐거나 실패) 그 칸을 "미수신"으로 표시하고 ⑧ 칸에도 모은다.
 *
 * 입력은 각 소스 스냅샷에서 꼭 필요한 값만 뽑은 가벼운 모양(아래 타입) — Supabase 읽기·env 는 scripts/coupang-morning-report/run.ts 가 맡는다.
 */
import { diffCatalog, onSaleStats, splitProducts, type CatalogRow } from './catalogWatch'
import type { AdCampaignRow } from './parsers/adCampaign'
import { buildNaverSalesLines, type NaverSalesSummary } from '../naver/salesWatch'

export type StockStateLite = {
  optionId: string
  alias: string
  label: string
  bagCount: number | null
  stock: number | null
  soldOut: boolean
  price: number | null
  sheetPrice: number | null
  itemWinner: boolean | null
}
export type PageOptionLite = { alias: string; label: string; seller: string; matchedBy: string }
export type RankLite = { keyword: string; alias: string; productNo: string; rank: number | null } // productNo: '' = 이 키워드에 우리 상품 없음(요약 행, v2)

export type MorningSources = {
  date: string // 오늘 YYYY-MM-DD
  yesterday: string
  stock: { states: StockStateLite[] } | null
  catalogToday: { rows: CatalogRow[] } | null
  catalogYesterday: { rows: CatalogRow[] } | null
  pageToday: { options: PageOptionLite[] } | null
  rankToday: { ranks: RankLite[] } | null
  rankYesterday: { ranks: RankLite[] } | null
  adDaily: { rows: AdCampaignRow[] } | null
  naverSales: NaverSalesSummary | null // 2026-10-22 추가 — 네이버 커머스 API 어제 결제완료 상품주문 집계. null 이면 그날 수집 자체가 안 됨(미수신)
  loginExpired: string[] // 예: ['윙', '허브(SUPPLIER HUB)']
}

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
const won = (n: number) => Math.round(n).toLocaleString('ko-KR')
const MAX_LINES = 8
function listLines<T>(items: T[], line: (x: T) => string): string[] {
  const out = items.slice(0, MAX_LINES).map((x) => `• ${line(x)}`)
  if (items.length > MAX_LINES) out.push(`• 외 ${items.length - MAX_LINES}개`)
  return out
}
/** 'N개' 토큰 뺀 이름 — 같은 상품 묶기 (stockWatch.groupKeyFromTitle 와 같은 규칙) */
const groupKey = (title: string) => String(title ?? '').replace(/,\s*\d+\s*개/, '').replace(/\s{2,}/g, ' ').trim()

export function buildMorningReport(s: MorningSources): { text: string; missing: string[] } {
  const L: string[] = []
  const missing: string[] = []
  L.push(`*[아침 보고서 ${md(s.date)}]*`)

  // ① 어제 매출 — 쿠팡은 2차(허브 1일 판매 소스 아직 없음), 네이버는 커머스 API(2026-10-22 추가)
  L.push('', '*① 어제 매출*', '쿠팡: 준비 중')
  if (!s.naverSales) {
    L.push('네이버: 미수신')
    missing.push('네이버 주문')
  } else {
    L.push(...buildNaverSalesLines(s.naverSales))
  }

  // ② 어제 광고
  L.push('', '*② 어제 광고*')
  if (!s.adDaily) {
    L.push('미수신')
    missing.push('어제 광고 보고서')
  } else {
    const rows = s.adDaily.rows
    const adCost = rows.reduce((a, r) => a + (r.adCost || 0), 0)
    const clicks = rows.reduce((a, r) => a + (r.clicks || 0), 0)
    const camps = new Set(rows.map((r) => r.campaignName)).size
    L.push(`광고비 ${won(adCost)}원 · 클릭 ${clicks}건 · 캠페인 ${camps}개 (1일 전환매출은 14일 뒤까지 더 늘어남 — 주간 판정은 월요일 7일 기준 유지)`)
    if (s.stock) {
      const soldOutOid = new Map(s.stock.states.filter((x) => x.soldOut).map((x) => [x.optionId, x.alias]))
      const hitAlias = new Map<string, number>()
      for (const r of rows) {
        const alias = soldOutOid.get(r.adOptionId)
        if (alias && r.adCost > 0) hitAlias.set(alias, (hitAlias.get(alias) || 0) + r.adCost)
      }
      if (hitAlias.size) L.push(`⚠️ 품절인데 광고 ON ${hitAlias.size}건: ${[...hitAlias.keys()].slice(0, 5).join(', ')}`)
    }
  }

  // ③ 재고·품절
  L.push('', '*③ 재고·품절*')
  if (!s.stock) {
    L.push('미수신')
    missing.push('광고센터 1P 재고')
  } else {
    const groups = new Map<string, { bagCount: number | null; stock: number | null; soldOut: boolean }[]>()
    for (const st of s.stock.states) {
      const k = groupKey(st.label ? `${st.alias}, ${st.label}` : st.alias)
      const g = groups.get(k) ?? []
      g.push({ bagCount: st.bagCount, stock: st.stock, soldOut: st.soldOut })
      groups.set(k, g)
    }
    const soldOutGroups = [...groups.entries()].filter(([, v]) => v.some((x) => x.soldOut))
    if (!soldOutGroups.length) L.push('품절 없음')
    else L.push(...listLines(soldOutGroups, ([k, v]) => `${k}: ${v.map((e) => `${e.bagCount ?? '?'}개 ${e.soldOut ? '품절' : `재고${e.stock}`}`).join(' · ')}`))
  }

  // ④ 1P 가격 변동
  L.push('', '*④ 1P 가격 변동(쿠팡가≠시트 기준가)*')
  if (!s.stock) {
    L.push('미수신')
  } else {
    const diffs = s.stock.states.filter((x) => x.price != null && x.sheetPrice != null && x.price !== x.sheetPrice)
    if (!diffs.length) L.push('변동 없음')
    else L.push(...listLines(diffs, (x) => `${x.alias} ${x.bagCount ?? '?'}개: 시트 ${won(x.sheetPrice!)} → 쿠팡 ${won(x.price!)}`))
  }

  // ⑤ 결합·점유
  L.push('', '*⑤ 결합·점유*')
  const gLines: string[] = []
  if (s.catalogToday && s.catalogYesterday) {
    const d = diffCatalog(s.catalogYesterday.rows, s.catalogToday.rows)
    const splits = splitProducts(s.catalogToday.rows)
    if (d.bindChanged.length) gLines.push(`결합 바뀜 ${d.bindChanged.length}건`)
    if (d.removed.length) gLines.push(`옵션 사라짐 ${d.removed.length}건`)
    if (d.added.length) gLines.push(`새 옵션 ${d.added.length}건`)
    if (splits.length) gLines.push(`페이지 분리 ${splits.length}개`)
  } else if (s.catalogToday) {
    gLines.push(`결합 감시 기준선(어제 비교 없음, 판매중 ${onSaleStats(s.catalogToday.rows).options}옵션)`)
  } else {
    missing.push('결합 감시(윙 쿠팡상품정보)')
    gLines.push('결합 감시: 미수신')
  }
  if (s.pageToday) {
    const foreign = s.pageToday.options.filter((o) => o.matchedBy === '' && o.seller && !/나무컴퍼니|보배마을|쌀쌀쌀|토지랑/i.test(o.seller))
    gLines.push(foreign.length ? `남의 판매자 옵션 ${foreign.length}건: ${foreign.slice(0, 3).map((o) => `${o.alias}(${o.seller})`).join(', ')}` : '남의 판매자 옵션 없음')
  } else {
    gLines.push('페이지 순회(남의 옵션): 미수신')
  }
  if (s.stock) {
    const notWinner = s.stock.states.filter((x) => x.itemWinner === false)
    gLines.push(notWinner.length ? `아이템위너 아님 ${notWinner.length}건` : '아이템위너 전부 정상')
  }
  L.push(...gLines)

  // ⑥ 후기
  L.push('', '*⑥ 후기*', '준비 중')

  // ⑦ 네이버 순위
  L.push('', '*⑦ 네이버 순위*')
  if (!s.rankToday) {
    L.push('미수신')
    missing.push('네이버 순위')
  } else {
    // v2(2026-10-22)부터 키워드당 상품 여러 개가 있을 수 있어 비교 키를 키워드+상품번호로 묶는다(이전엔 키워드 1개=상품 1개라 키워드만으로 충분했음).
    // 오늘 아예 안 나온(= 그 상품 행 자체가 없는) 것도 "이탈"로 잡으려면 오늘·어제 상품번호를 합쳐서 봐야 한다 — 오늘 쪽만 보면 이탈이 통째로 빠진다.
    const key = (r: RankLite) => `${r.keyword}|${r.productNo}`
    const curByKey = new Map(s.rankToday.ranks.filter((r) => r.productNo).map((r) => [key(r), r]))
    const prevByKey = new Map((s.rankYesterday?.ranks ?? []).filter((r) => r.productNo).map((r) => [key(r), r]))
    const keywordCount = new Set(s.rankToday.ranks.map((r) => r.keyword)).size
    let outOf = 0
    const big: { keyword: string; alias: string; from: number; to: number | null }[] = []
    for (const k of new Set([...curByKey.keys(), ...prevByKey.keys()])) {
      const cur = curByKey.get(k)
      const prev = prevByKey.get(k)
      if ((cur?.rank ?? null) == null) outOf += 1
      if (prev?.rank != null && (cur?.rank != null ? Math.abs(prev.rank - cur.rank) >= 3 : true)) {
        const label = cur ?? prev!
        big.push({ keyword: label.keyword, alias: label.alias, from: prev.rank, to: cur?.rank ?? null })
      }
    }
    L.push(`${keywordCount}개 키워드 · 순위권 밖 ${outOf}건 · 큰 변동(±3↑)·이탈 ${big.length}건`)
    if (big.length) L.push(...listLines(big, (b) => `${b.keyword}(${b.alias}): 어제 ${b.from}위 → 오늘 ${b.to == null ? '1페이지 밖' : `${b.to}위`}`))
  }

  // ⑧ 오늘 할 일 / 미수신
  L.push('', '*⑧ 오늘 할 일*')
  const todo: string[] = []
  const dow = new Date(`${s.date}T00:00:00+09:00`).getDay() // 0=일 ... 2=화 4=목
  if (dow === 2 || dow === 4) todo.push('오늘 화/목 — 쿠팡 로켓 발주 확인')
  if (s.loginExpired.length) todo.push(`로그인 풀림: ${s.loginExpired.join(', ')}`)
  if (missing.length) todo.push(`못 받은 소스: ${missing.join(', ')}`)
  L.push(...(todo.length ? todo.map((x) => `• ${x}`) : ['• 특이사항 없음']))

  return { text: L.join('\n'), missing }
}
