/**
 * 광고 분석 — 이번 주 할 일 판정 (30일 파일 기준, 순수 함수).
 *
 * 키워드 지표·추천 입찰가·BEP ROAS·페어 중복은 기존 함수(adAnalysis.ts)를 그대로 쓴다 — 여기서 새로 계산하지 않는다.
 *   A. BEP ROAS 바뀐 AI 캠페인 — 적용값 없음, 또는 올리기(BEP − 적용값 ≥ 10%p),
 *      또는 내리기(적용값 − BEP ≥ 10%p)인데 30일 실제 ROAS ≥ 적용값일 때만.
 *      목표를 못 맞추는 캠페인(실제 ROAS < 적용값)에서 목표를 내리면 입찰이 더 공격적이 돼 손실이 커지므로 유지(bepHold)
 *   B. AI → 수동 이동 — AI 검색 키워드, 클릭 ≥ 20 · ROAS < BEP (추천 입찰가, 100원 하한)
 *   C. 수동 입찰가 수정 — 수동 검색 키워드, 클릭 ≥ 20 · 판매 > 0 · 추천 입찰가와 현재 클릭당 비용 차이 ≥ 10%
 *   옛 '삭제'(클릭 ≥ 20 · 판매 0 또는 ROAS < BEP/2)는 지우지 않고 최저가 100원으로 — 매출 기회 유지
 *     AI → 수동 이동(B) 100원 / 수동 → 입찰가 ↓(C) 100원
 *   같은 페어 AI·수동 중복 키워드 — 합산 ROAS ≥ BEP → 수동 입찰가 ↓ 100원(AI 가 가져감) / < BEP → AI 제외 + 수동 유지(B)
 * 클릭 20 미만은 판정하지 않고 목록에도 넣지 않는다. 키워드 하나는 한 할 일에만 들어간다.
 */
import {
  buildCampaignPairAnalysis,
  buildKeywordRows,
  buildManualReviewRows,
  hasBidSample,
  recommendedBid,
  type AdAnalysisView,
  type CampaignDiag,
  type KeywordRow,
} from './adAnalysis'

export const BEP_CHANGE_PP = 10 // A — 적용값과 BEP ROAS 차이 기준 (%p)
export const BID_CHANGE_RATIO = 0.1 // C — 추천 입찰가 vs 현재 클릭당 비용 차이 기준 (10%)

// ── 목표 ROAS(쿠팡 적용값) 저장 키 — prefix + 타입(AI|수동|스마트) ──
const TARGET_KEY_RE = /^(.+)_(AI|수동|스마트|smart)_(.+)$/i
export function parseCampaignTargetKey(name: string): { key: string; kind: 'AI' | '수동' | '스마트' } | null {
  const m = (name || '').trim().match(TARGET_KEY_RE) || (name || '').trim().match(/^(.+)_(AI|수동|스마트|smart)()$/i)
  if (!m) return null
  const prefix = m[1].trim()
  const tok = m[2]
  let kind: 'AI' | '수동' | '스마트'
  if (/^ai$/i.test(tok)) kind = 'AI'
  else if (tok === '수동') kind = '수동'
  else kind = '스마트' // 'smart' or '스마트'
  if (!prefix) return null
  return { key: `${prefix}::${kind}`, kind }
}

const ceilToTen = (v: number): number => Math.ceil(v / 10) * 10
const MIN_BID = 100 // 쿠팡 광고센터 최저 입찰가 (VAT 별도) — 옛 삭제 대상·100원 미만 추천가

export type MoveItem = {
  keyword: string
  clicks: number
  orders: number
  roasPct: number | null
  bepPct: number | null
  adCostVat: number
  bid: number | null // 수동 입찰가 (VAT 별도, 10원 올림)
  dup: boolean // 수동에 이미 있는 중복 키워드 — AI 제외만, 수동 유지
}
export type BidItem = { keyword: string; clicks: number; cur: number; rec: number; up: boolean; roasPct: number | null }
export type CampaignActions = {
  campaign: CampaignDiag
  targetKey: string | null
  isAi: boolean
  bepChange: { applied: number | null; next: number } | null
  /** 내리기 대상이지만 실제 ROAS 가 적용값 미만이라 뺀 경우 — 펼침에 안내만 */
  bepHold: { applied: number; next: number; roasPct: number | null } | null
  move: MoveItem[]
  bidUp: BidItem[]
  bidDown: BidItem[]
  pairManualName: string | null // 수동 이동 대상 수동 캠페인 (같은 prefix)
  count: number
}

export type WeeklyOptions = {
  bepMap: Map<string, number>
  priceMap: Map<string, number>
  exposureMap: Map<string, string>
  marginOff: boolean
  targets: Record<string, number>
}

const isAiCampaign = (c: CampaignDiag): boolean => {
  const k = parseCampaignTargetKey(c.campaignName)?.kind
  return c.type === 'ai' || k === 'AI' || k === '스마트'
}
const isManualCampaign = (c: CampaignDiag): boolean =>
  !isAiCampaign(c) && (c.type === 'manual' || parseCampaignTargetKey(c.campaignName)?.kind === '수동')

const kwKey = (k: string) => String(k || '').trim()

export function buildWeeklyActions(view: AdAnalysisView, o: WeeklyOptions): CampaignActions[] {
  const rowsOf = new Map<string, KeywordRow[]>() // campaignId → 검색 키워드 행
  const manualRowsOf = new Map<string, ReturnType<typeof buildManualReviewRows>>()
  for (const c of view.campaigns) {
    if (isManualCampaign(c)) {
      const rows = buildManualReviewRows(c, o.bepMap, o.priceMap, new Map(), o.exposureMap, o.marginOff)
      manualRowsOf.set(c.campaignId, rows)
      rowsOf.set(c.campaignId, rows)
    } else {
      rowsOf.set(c.campaignId, buildKeywordRows(c, o.bepMap, o.priceMap, o.exposureMap, o.marginOff).search)
    }
  }
  const byName = new Map(view.campaigns.map((c) => [c.campaignName, c]))
  const out = new Map<string, CampaignActions>()
  const slot = (c: CampaignDiag): CampaignActions => {
    let a = out.get(c.campaignId)
    if (!a) {
      a = {
        campaign: c,
        targetKey: parseCampaignTargetKey(c.campaignName)?.key ?? null,
        isAi: isAiCampaign(c),
        bepChange: null,
        bepHold: null,
        move: [],
        bidUp: [],
        bidDown: [],
        pairManualName: null,
        count: 0,
      }
      out.set(c.campaignId, a)
    }
    return a
  }
  const handled = new Set<string>() // `${campaignId}|${keyword}`

  // 같은 페어 AI·수동 중복 키워드 (기존 페어 분석 결과 그대로) — 합산 지표로 한 번만 판정
  const pairs = buildCampaignPairAnalysis(view)
  const manualOfPrefix = new Map<string, string>()
  for (const d of pairs.duplicateKeywords) manualOfPrefix.set(d.prefix, d.manualCampaignName)
  for (const d of pairs.duplicateKeywords) {
    const ai = byName.get(d.aiCampaignName)
    const man = byName.get(d.manualCampaignName)
    if (!ai || !man) continue
    for (const kw of d.keywords) {
      const ar = (rowsOf.get(ai.campaignId) || []).find((r) => kwKey(r.keyword) === kwKey(kw))
      const mr = (rowsOf.get(man.campaignId) || []).find((r) => kwKey(r.keyword) === kwKey(kw))
      if (!ar || !mr) continue
      handled.add(`${ai.campaignId}|${kwKey(kw)}`)
      handled.add(`${man.campaignId}|${kwKey(kw)}`)
      const clicks = ar.clicks + mr.clicks
      if (!hasBidSample(clicks)) continue
      const revenue = ar.revenue + mr.revenue
      const cost = ar.adCostRaw + mr.adCostRaw
      const beps = [ar, mr].filter((r) => r.bepPct != null)
      const bepW = beps.reduce((s, r) => s + r.adCostRaw, 0)
      const bep = beps.length
        ? bepW > 0
          ? beps.reduce((s, r) => s + (r.bepPct as number) * r.adCostRaw, 0) / bepW
          : (beps[0].bepPct as number)
        : null
      if (bep == null || cost <= 0) continue
      const roas = (revenue / cost) * 100
      if (roas >= bep) {
        // 수동 쪽은 지우지 않고 최저가 — AI 가 가져가게 (이미 100원 이하면 할 일 없음)
        const cur = (manualRowsOf.get(man.campaignId) || []).find((x) => x.keyword === mr.keyword)?.avgCpcVatExcl ?? null
        if (cur == null || cur > MIN_BID) slot(man).bidDown.push({ keyword: mr.keyword, clicks, cur: cur ?? 0, rec: MIN_BID, up: false, roasPct: roas })
      } else {
        const bid = recommendedBid(revenue, clicks, bep)
        slot(ai).move.push({
          keyword: ar.keyword, clicks, orders: ar.orders + mr.orders, roasPct: roas, bepPct: bep, adCostVat: ar.adCostVat,
          bid: bid != null ? Math.max(ceilToTen(bid), MIN_BID) : null, dup: true,
        })
      }
    }
  }

  for (const c of view.campaigns) {
    const ai = isAiCampaign(c)
    const manual = !ai && isManualCampaign(c)
    if (!ai && !manual) continue
    // A — BEP ROAS 바뀐 AI 캠페인
    if (ai && c.bepPct != null) {
      const key = parseCampaignTargetKey(c.campaignName)?.key
      const next = Math.round(c.bepPct)
      const applied = key ? (o.targets[key] ?? null) : null
      if (applied == null || next - applied >= BEP_CHANGE_PP) slot(c).bepChange = { applied, next }
      else if (applied - next >= BEP_CHANGE_PP) {
        // 내리기 — 30일 실제 ROAS 가 지금 목표를 맞출 때만. 못 맞추면 목표 유지 (키워드 정리 먼저)
        if (c.roasPct != null && c.roasPct >= applied) slot(c).bepChange = { applied, next }
        else slot(c).bepHold = { applied, next, roasPct: c.roasPct }
      }
    }
    const rows = rowsOf.get(c.campaignId) || []
    const manualRows = manualRowsOf.get(c.campaignId)
    for (const r of rows) {
      if (handled.has(`${c.campaignId}|${kwKey(r.keyword)}`)) continue
      if (!hasBidSample(r.clicks)) continue
      const bep = r.bepPct
      const roas = r.roasPct
      // 옛 삭제 대상 — 판매 0, 또는 ROAS < BEP/2 → 지우지 않고 최저가 100원 (AI 는 수동으로, 수동은 입찰가 ↓)
      if (r.orders === 0 || (roas != null && bep != null && roas < bep / 2)) {
        if (ai) {
          slot(c).move.push({
            keyword: r.keyword, clicks: r.clicks, orders: r.orders, roasPct: roas, bepPct: bep, adCostVat: r.adCostVat, bid: MIN_BID, dup: false,
          })
        } else if (manualRows) {
          const cur = manualRows.find((x) => x.keyword === r.keyword)?.avgCpcVatExcl ?? null
          if (cur == null || cur > MIN_BID) slot(c).bidDown.push({ keyword: r.keyword, clicks: r.clicks, cur: cur ?? 0, rec: MIN_BID, up: false, roasPct: roas })
        }
        continue
      }
      if (roas == null || bep == null) continue
      if (ai) {
        // B — BEP/2 ≤ ROAS < BEP
        if (roas < bep) {
          const bid = recommendedBid(r.revenue, r.clicks, bep)
          slot(c).move.push({
            keyword: r.keyword, clicks: r.clicks, orders: r.orders, roasPct: roas, bepPct: bep, adCostVat: r.adCostVat,
            bid: bid != null ? Math.max(ceilToTen(bid), MIN_BID) : null, dup: false,
          })
        }
      } else if (manualRows) {
        // C — 추천 입찰가(10원 올림) vs 현재 클릭당 비용(VAT 별도) 차이 ≥ 10%
        const m = manualRows.find((x) => x.keyword === r.keyword)
        const rec = m?.recommendedBidVatExcl != null ? ceilToTen(m.recommendedBidVatExcl) : null
        const cur = m?.avgCpcVatExcl ?? null
        if (rec != null && cur != null && cur > 0 && Math.abs(rec - cur) / cur >= BID_CHANGE_RATIO) {
          const item: BidItem = { keyword: r.keyword, clicks: r.clicks, cur, rec, up: rec > cur, roasPct: roas }
          if (item.up) slot(c).bidUp.push(item)
          else slot(c).bidDown.push(item)
        }
      }
    }
  }

  const list = [...out.values()]
  for (const a of list) {
    const prefix = a.targetKey?.split('::')[0]
    a.pairManualName = a.isAi && prefix ? manualOfPrefix.get(prefix) ?? pairManualOf(view, a.campaign) : null
    a.count = (a.bepChange ? 1 : 0) + a.move.length + a.bidUp.length + a.bidDown.length
  }
  return list.filter((a) => a.count > 0).sort((x, y) => x.campaign.adProfit - y.campaign.adProfit)
}

/** AI 캠페인과 같은 prefix 의 수동 캠페인 이름 (없으면 null) */
function pairManualOf(view: AdAnalysisView, ai: CampaignDiag): string | null {
  const p = parseCampaignTargetKey(ai.campaignName)?.key.split('::')[0]
  if (!p) return null
  const m = view.campaigns.find((c) => isManualCampaign(c) && parseCampaignTargetKey(c.campaignName)?.key.split('::')[0] === p)
  return m?.campaignName ?? null
}

// ── 캠페인 상태 3칸 (비율 = 광고 손익 ÷ 광고비(VAT 포함)) ──
// BEP ROAS 없는 캠페인은 광고 손익을 믿을 수 없어 3칸에서 빼고 경고 줄로 보낸다
export type CampaignStatus = 'profit' | 'even' | 'loss'
export const STATUS_BAND = 0.05 // 흑자 > +5% / 본전 −5% ~ +5% / 적자 < −5%
export function campaignStatusOf(c: CampaignDiag): CampaignStatus | null {
  if (c.bepPct == null || c.bepPct <= 0 || c.adCostVat <= 0) return null
  const ratio = c.adProfit / c.adCostVat
  return ratio > STATUS_BAND ? 'profit' : ratio >= -STATUS_BAND ? 'even' : 'loss'
}

// ── 쿠팡 반영 완료 기록 비교 — 할 일 항목 키 (키워드 단위. 입찰가 값은 파일마다 조금씩 달라 키에 넣지 않음) ──
export type ActionItem = { key: string; label: string }
export function actionItems(a: CampaignActions): ActionItem[] {
  const won = (n: number) => n.toLocaleString('ko-KR')
  const out: ActionItem[] = []
  if (a.bepChange) out.push({ key: 'bep', label: `BEP ROAS ${a.bepChange.applied ?? '미입력'}→${a.bepChange.next}%` })
  for (const m of a.move) out.push({ key: `move:${kwKey(m.keyword)}`, label: `${m.keyword}${m.bid != null ? ` (${won(m.bid)}원)` : ''}` })
  for (const b of [...a.bidUp, ...a.bidDown]) {
    out.push({ key: `bid:${kwKey(b.keyword)}`, label: `${b.keyword} ${b.up ? '↑' : '↓'} ${b.cur ? `${won(b.cur)}→` : ''}${won(b.rec)}` })
  }
  return out
}
