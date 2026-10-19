/**
 * 광고 분석 — 주간 판정 규칙 (순수 함수). 대시보드 화면(WeeklyBlocks.tsx)과 coupang-ad-weekly 스킬(weekly.ts)이
 * 이 파일 하나를 같이 쓴다 — 규칙을 바꿀 땐 여기만 바꾼다 (2026-10-19 대표 지시: 코드 한 곳).
 *
 * 규칙 (2026-10-15 대표 재정정 — 대전제: 효율 나오는 캠페인은 건드리지 않음)
 *   - 효율 ≥ BEP        : 목표를 올리지도 내리지도 않음 (그대로 둠)
 *   - 효율 < BEP 1주만    : 관찰
 *   - 효율 < BEP 2주 연속 : 할 일 — 목표가 BEP 보다 10%p 이상 낮거나 미입력이면 BEP 로 올림 + 키워드·입찰 조치
 *     '효율' = 이번 주(주간 기록) ROAS, 없으면 이 파일 ROAS. 지난주 = 이번 주 시작일의 정확히 7일 전 주간 기록
 *   - 할 일에서 빼는 것: 클릭 20건 미만(모수 부족) · 운영 메모에 OFF/끔/중지/꺼짐 · 최근 7일 안 반영(효과 확인 중)
 *   - 입찰가 10원 올림 · 인하는 한 주 최대 30% (이번 주 입찰가 = 10원 올림(max(최종 목표, 현재 × 0.7)))
 *   - AI·수동 중복 키워드는 수동 단독 기준으로 다시 봄 (AI 쪽 제외가 반영됐는지 운영 메모로 확인)
 *   - 지난주 조치 결과: 반영 기록 중 지난주 끝 이후 ~ 이번 주 끝 이전, 광고 손익 차이가 이번 주 광고비 5% 이내면 변화 없음
 * 숫자 계산(ROAS·BEP·손익·추천 입찰가)은 adAnalysis.ts·weeklyActions.ts 를 그대로 쓴다 — 여기서 새로 계산하지 않는다.
 */
import {
  buildManualReviewRows,
  hasBidSample,
  keywordGroupKey,
  MIN_CLICKS_FOR_BID,
  NON_SEARCH_KEYWORD_TOKENS,
  type AdAnalysisView,
  type CampaignType,
} from './adAnalysis'
import type { AdCampaignRow } from './parsers/adCampaign'
import { campaignStatusOf, parseCampaignTargetKey, type CampaignActions, type CampaignStatus } from './weeklyActions'
import type { WeeklySnapshot } from './weeklySnapshots'

// ── 상수 ──
export const OFF_RE = /\bOFF\b|끔|중지|꺼짐/i // 운영 메모에 이 말이 있으면 OFF 기록 — 자유 메모에 쓰면 할 일에서 빠지니 주의
export const MIN_CLICKS = MIN_CLICKS_FOR_BID // 클릭 20건 미만 = 모수 부족 (키워드 기준을 캠페인 판정에도 씀)
export const BEP_RAISE_PP = 10 // 목표를 올리는 기준 — BEP 와 10%p 이상 차이 (대시보드 BEP_CHANGE_PP 와 같은 값)
export const OBSERVE_DAYS = 7 // 반영 뒤 7일 안 = 효과 확인 중
export const NO_CHANGE_RATIO = 0.05 // 광고 손익 차이가 이번 주 광고비의 5% 이내면 변화 없음
export const BID_CUT_MAX = 0.3 // 입찰가 인하 한 주 상한
export const MIN_BID = 100 // 쿠팡 광고센터 최저 입찰가 (VAT 별도)

// ── 날짜·숫자 ──
export const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** ISO 시각 → KST 날짜 (YYYY-MM-DD) */
export const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
export const ceil10 = (v: number) => Math.ceil(v / 10) * 10
export const rnd = (v: number | null | undefined) => (v == null ? null : Math.round(v))
const wonK = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('ko-KR'))
/** 이번 주 입찰가 — 인하는 30% 상한 (10원 올림이라 상한을 지킴: 591×0.7=413.7 → 420). 인상·현재값 없음은 최종 목표 그대로 */
export const weekBid = (cur: number | null, finalBid: number) =>
  ceil10(cur != null && finalBid < cur ? Math.max(finalBid, cur * (1 - BID_CUT_MAX)) : finalBid)

// ── 운영 메모 ──
export type JudgeNote = {
  id: string
  ts: string
  text: string
  kind?: string
  campaignKey?: string
  campaignName?: string
  period?: string
  items?: string[]
}
/** 캠페인에 해당하는 메모 — campaignKey(prefix::타입) 같거나, campaignName 같거나, 글에 캠페인 이름 전체가 들어 있음 */
export const notesOfCampaign = (notes: JudgeNote[], campaignName: string): JudgeNote[] => {
  const key = parseCampaignTargetKey(campaignName)?.key
  return notes.filter((n) => (key && n.campaignKey === key) || n.campaignName === campaignName || (n.text || '').includes(campaignName))
}
export type NoteInfo = {
  /** 마지막 '쿠팡 반영 완료' 날짜 (KST) */
  lastReflect: string | null
  /** 기간 마지막 7일 안에 반영 = 효과 확인 중 */
  observing: boolean
  /** OFF 기록 메모 글 (없으면 null) */
  offNote: string | null
}
export function noteInfoOf(notes: JudgeNote[], campaignName: string, periodEnd: string): NoteInfo {
  const ns = notesOfCampaign(notes, campaignName)
  const reflects = ns.filter((n) => n.kind === 'reflect').map((n) => kstDate(n.ts)).sort()
  const lastReflect = reflects[reflects.length - 1] ?? null
  const observeFrom = addDays(periodEnd, -(OBSERVE_DAYS - 1))
  return {
    lastReflect,
    observing: lastReflect != null && lastReflect >= observeFrom,
    offNote: ns.find((n) => OFF_RE.test(n.text || ''))?.text ?? null,
  }
}

// ── 주간 기록에서 캠페인 찾기 · 2주 추세 ──
export type SnapCamp = WeeklySnapshot['campaigns'][number]
export const snapFind = (s: WeeklySnapshot | null | undefined, campaignName: string): SnapCamp | null => {
  if (!s) return null
  const key = parseCampaignTargetKey(campaignName)?.key
  return s.campaigns.find((x) => (key && x.key === key) || x.campaignName === campaignName) ?? null
}
export type WeekPair = { roasPct: number | null; bepPct: number | null }
export const belowBep = (x: WeekPair | null | undefined) => x != null && x.roasPct != null && x.bepPct != null && x.roasPct < x.bepPct
export type Trend = 'both' | 'cur_only' | 'prev_only' | 'none' | 'nodata'
export const TREND_LABEL: Record<Trend, string> = {
  both: '2주 연속 BEP 미달',
  cur_only: '이번 주만 BEP 미달',
  prev_only: '지난주만 BEP 미달',
  none: 'BEP 미달 아님',
  nodata: '주간 기록 2주치 없음',
}
export function weeksOf(prevWeek: WeeklySnapshot | null, curWeek: WeeklySnapshot | null, campaignName: string): { trend: Trend; prev: WeekPair | null; cur: WeekPair | null } {
  const a = snapFind(prevWeek, campaignName)
  const b = snapFind(curWeek, campaignName)
  const t: Trend = !a || !b ? 'nodata' : belowBep(a) && belowBep(b) ? 'both' : belowBep(b) ? 'cur_only' : belowBep(a) ? 'prev_only' : 'none'
  return {
    trend: t,
    prev: a ? { roasPct: rnd(a.roasPct), bepPct: rnd(a.bepPct) } : null,
    cur: b ? { roasPct: rnd(b.roasPct), bepPct: rnd(b.bepPct) } : null,
  }
}
/** 지난주 = 이번 주 시작일의 정확히 7일 전에 시작하는 기록 (가까운 기록으로 대신하지 않음) */
export const prevWeekOf = (snaps: WeeklySnapshot[], cur: WeeklySnapshot | null): WeeklySnapshot | null =>
  cur ? snaps.find((s) => s.startDate === addDays(cur.startDate, -7)) ?? null : null

// ── 캠페인 판정 ──
export const isAiCampaignName = (type: CampaignType | string, campaignName: string): boolean => {
  const k = parseCampaignTargetKey(campaignName)?.kind
  return type === 'ai' || k === 'AI' || k === '스마트'
}

/** 판정 입력 — 주간 파일 분석(CampaignDiag)이나 주간 기록(캠페인 행, 클릭 없음 → null) 어느 쪽이든 */
export type JudgeInput = {
  campaignId: string
  campaignName: string
  type: CampaignType
  channel: '3P' | '1P'
  clicks: number | null
  adCostVat: number
  revenue: number
  roasPct: number | null
  bepPct: number | null
  adProfit: number
}
export type Decision = 'todo' | 'keep' | 'watch' | 'skip' | 'nobep'
export type CampaignJudgement = JudgeInput & NoteInfo & {
  isAi: boolean
  key: string | null
  /** 클릭 20건 미만 (클릭을 모르면 false — clicksKnown 참고) */
  lowSample: boolean
  clicksKnown: boolean
  /** 할 일에서 뺀 이유 (모수 부족 · OFF 기록 · 최근 반영) — 없으면 null */
  skipReason: string | null
  trend: Trend
  prev: WeekPair | null
  cur: WeekPair | null
  /** 쿠팡 적용 목표 ROAS (AI 만, 저장값 없으면 null) */
  applied: number | null
  bep: number | null
  decision: Decision
  /** 할 일일 때 목표 조치 문구 */
  targetAction: string | null
  /** 관찰일 때 이유 */
  watchReason: string | null
  /** 대시보드 상태 3칸 판정 (흑자·본전·적자) */
  dashStatus: CampaignStatus | null
}
export type JudgeContext = {
  curWeek: WeeklySnapshot | null
  prevWeek: WeeklySnapshot | null
  notes: JudgeNote[]
  targets: Record<string, number>
  /** 판정 기간 끝 (파일 종료일) — 최근 반영 7일 계산 기준 */
  periodEnd: string
}
export function skipReasonOf(x: { lowSample: boolean; clicks: number | null; offNote: string | null; observing: boolean; lastReflect: string | null }): string | null {
  if (x.lowSample) return `모수 부족 (클릭 ${x.clicks})`
  if (x.offNote) return 'OFF 기록'
  if (x.observing) return `최근 반영 (${x.lastReflect}, 효과 확인 전 — 7일 안 됨)`
  return null
}
export function judgeCampaign(c: JudgeInput, ctx: JudgeContext): CampaignJudgement {
  const info = noteInfoOf(ctx.notes, c.campaignName, ctx.periodEnd)
  const clicksKnown = c.clicks != null
  const lowSample = clicksKnown && (c.clicks ?? 0) < MIN_CLICKS
  const isAi = isAiCampaignName(c.type, c.campaignName)
  const key = parseCampaignTargetKey(c.campaignName)?.key ?? null
  const applied = isAi && key ? ctx.targets[key] ?? null : null
  const w = weeksOf(ctx.prevWeek, ctx.curWeek, c.campaignName)
  const skipReason = skipReasonOf({ lowSample, clicks: c.clicks, offNote: info.offNote, observing: info.observing, lastReflect: info.lastReflect })
  const base: CampaignJudgement = {
    ...c, ...info, isAi, key, lowSample, clicksKnown, skipReason, ...w, applied,
    bep: c.bepPct == null ? null : Math.round(c.bepPct),
    decision: 'nobep', targetAction: null, watchReason: null,
    dashStatus: campaignStatusOf({ bepPct: c.bepPct, adCostVat: c.adCostVat, adProfit: c.adProfit } as Parameters<typeof campaignStatusOf>[0]),
  }
  if (skipReason) return { ...base, decision: 'skip' }
  if (c.bepPct == null) return base // BEP 없음 → 확인 필요
  const bep = Math.round(c.bepPct)
  const eff = w.cur ?? { roasPct: rnd(c.roasPct), bepPct: rnd(c.bepPct) }
  const effOk = eff.roasPct != null && eff.bepPct != null && eff.roasPct >= eff.bepPct
  if (w.trend === 'both') {
    const raise = isAi && (applied == null || bep - applied >= BEP_RAISE_PP)
    const targetAction = !isAi
      ? '수동 — 목표 없음, 키워드·입찰만'
      : raise
        ? `목표 → ${bep}%`
        : applied! >= bep
          ? `목표 유지 (${applied}% ≥ BEP ${bep}%), 키워드·입찰만`
          : `목표 유지 (${applied}%, BEP ${bep}%와 10%p 안), 키워드·입찰만`
    return { ...base, decision: 'todo', targetAction }
  }
  if (effOk) return { ...base, decision: 'keep' }
  return { ...base, decision: 'watch', watchReason: w.trend === 'nodata' ? '주간 기록 2주치 없음 (이번 주 BEP 미달)' : TREND_LABEL[w.trend] }
}
export const judgeCampaigns = (list: JudgeInput[], ctx: JudgeContext): CampaignJudgement[] => list.map((c) => judgeCampaign(c, ctx))

/** 주간 기록 캠페인 행 → 판정 입력 (주간 파일이 이 화면에 없을 때 — 클릭을 모름) */
export function judgeInputFromSnapshot(s: WeeklySnapshot): JudgeInput[] {
  return s.campaigns.map((c) => {
    const kind = parseCampaignTargetKey(c.campaignName)?.kind
    return {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      type: kind === 'AI' || kind === '스마트' ? 'ai' : kind === '수동' ? 'manual' : 'unknown',
      channel: /1P/.test(c.campaignName) ? '1P' : '3P',
      clicks: null,
      adCostVat: c.adCostVat,
      revenue: c.revenue,
      roasPct: c.roasPct,
      bepPct: c.bepPct,
      adProfit: c.adProfit,
    }
  })
}

/** 캠페인 표 상태 태그 — 표시 순서: 할 일 → OFF → 모수 부족 → 효과 확인 중 → 관찰 → 그대로 둠 → — */
export type StatusTag = 'todo' | 'off' | 'low' | 'wait' | 'watch' | 'keep' | 'none'
export const STATUS_TAG_LABEL: Record<StatusTag, string> = {
  todo: '할 일', off: 'OFF', low: '모수 부족', wait: '효과 확인 중', watch: '관찰', keep: '그대로 둠', none: '—',
}
export function statusTagOf(j: CampaignJudgement): StatusTag {
  if (j.decision === 'todo') return 'todo'
  if (j.offNote) return 'off'
  if (j.lowSample) return 'low'
  if (j.observing) return 'wait'
  if (j.decision === 'watch') return 'watch'
  if (j.decision === 'keep') return 'keep'
  return 'none'
}

// ── 지난주 조치 결과 (반영 기록 1주 뒤) ──
export type Verdict = '개선' | '악화' | '변화 없음' | '비교 불가'
export type FollowupItem = {
  note: JudgeNote
  text: string
  date: string
  before: SnapCamp | null
  after: SnapCamp | null
  roas: [number | null, number | null]
  adProfit: [number | null, number | null]
  verdict: Verdict
}
export function followupLastWeek(prev: WeeklySnapshot | null, cur: WeeklySnapshot | null, notes: JudgeNote[]): FollowupItem[] {
  if (!prev || !cur) return []
  return notes
    .filter((n) => n.kind === 'reflect' && n.campaignKey)
    .filter((n) => kstDate(n.ts) > prev.endDate && kstDate(n.ts) <= cur.endDate)
    .map((n) => {
      const find = (s: WeeklySnapshot) => s.campaigns.find((c) => c.key === n.campaignKey) ?? s.campaigns.find((c) => c.campaignName === n.campaignName) ?? null
      const before = find(prev)
      const after = find(cur)
      let verdict: Verdict = '비교 불가'
      if (before && after) {
        const d = after.adProfit - before.adProfit
        verdict = Math.abs(d) <= after.adCostVat * NO_CHANGE_RATIO ? '변화 없음' : d > 0 ? '개선' : '악화'
      }
      return { note: n, text: n.text, date: kstDate(n.ts), before, after, roas: [before?.roasPct ?? null, after?.roasPct ?? null], adProfit: [before?.adProfit ?? null, after?.adProfit ?? null], verdict }
    })
}
/** 조치 이름 정규화 — 대괄호·공백 무시 (반영 메모 글 앞부분과 캠페인명 대조) */
export const normName = (n: string) => n.replace(/[\[\]\s]/g, '')

// ── 할 일 캠페인의 키워드·입찰 계획 (30일 파일 기준 — 대시보드 할 일 함수 buildWeeklyActions 결과를 가공) ──
export type MoveSummary = { keyword: string; variants: string[]; bid: number | null; dup: boolean; clicks: number; roasPct: number | null }
export type BidSummary = { keyword: string; cur: number | null; rec: number; week: number; up: boolean; clicks: number; variants: { keyword: string; cur: number | null }[] }
export type ActionSummary = { campaign: string; campaignId: string; move: MoveSummary[]; bids: BidSummary[]; pairManualName: string | null }
/** buildWeeklyActions 결과 → 10원 단위·30% 상한 적용한 요약 (키워드 조치가 하나라도 있는 캠페인만) */
export function summarizeActions(acts: CampaignActions[]): ActionSummary[] {
  return acts
    .map((a) => ({
      campaign: a.campaign.campaignName,
      campaignId: a.campaign.campaignId,
      move: a.move.map((m) => ({ keyword: m.keyword, variants: m.variants, bid: m.bid != null ? ceil10(m.bid) : null, dup: m.dup, clicks: m.clicks, roasPct: rnd(m.roasPct) })),
      // rec = 최종 목표, week = 이번 주 입력값(인하 30% 상한) — 둘 다 10원 단위
      bids: [...a.bidUp, ...a.bidDown].map((b) => ({ keyword: b.keyword, cur: b.cur || null, rec: ceil10(b.rec), week: b.up ? ceil10(b.rec) : weekBid(b.cur || null, ceil10(b.rec)), up: b.up, clicks: b.clicks, variants: b.variants })),
      pairManualName: a.pairManualName,
    }))
    .filter((a) => a.move.length || a.bids.length)
}
/** 입찰가 한 줄 — '키워드 현재 → 이번 주 **값** (최종 목표 값)' (인하 30% 상한에 걸리면 두 값, 아니면 한 값) */
export function fmtBidLine(b: { keyword: string; cur: number | null; rec: number; up: boolean; variants: { keyword: string; cur: number | null }[] }): string {
  const curs = new Set(b.variants.map((v) => v.cur))
  const one = (kw: string, cur: number | null) => {
    const rec = ceil10(b.rec)
    if (b.up || cur == null) return `${kw} ${cur != null ? `${wonK(cur)} → ` : ''}${wonK(rec)} (↑)`
    const wk = weekBid(cur, rec)
    return wk === rec ? `${kw} ${wonK(cur)} → ${wonK(rec)}` : `${kw} ${wonK(cur)} → 이번 주 **${wonK(wk)}** (최종 목표 ${wonK(rec)})`
  }
  return b.variants.length > 1 && curs.size > 1 ? b.variants.map((v) => one(v.keyword, v.cur)).join(' / ') : one(b.variants.map((v) => v.keyword).join(' · '), b.cur)
}
export type MovePair = { keyword: string; manual: string; ai: string }
export type KwTableRow = { keyword: string; clicks: number; adCostVat: number; cpc: number | null; revenue: number; roasPct: number | null; bepPct: number | null; recBid: number | null; deleteCandidate: boolean }
export type LowKw = { count: number; adCostVat: number; top: { keyword: string; clicks: number; adCostVat: number }[] }
export type TodoPlan = {
  campaign: string
  /** 30일 파일에 이 캠페인이 있는지 (없으면 키워드 조치 생략) */
  inFile: boolean
  isAi: boolean
  movePairs: MovePair[]
  bidLines: string[]
  extraBidLines: string[]
  notes: string[]
  kwTable: KwTableRow[] | null
  low: LowKw | null
}
export type PlanContext = {
  actions: ActionSummary[]
  kwView: AdAnalysisView
  kwRows: AdCampaignRow[]
  bepMap: Map<string, number>
  priceMap: Map<string, number>
  exposureMap: Map<string, string>
  notes: JudgeNote[]
}
export function buildTodoPlans(todos: { campaign: string; isAi: boolean }[], ctx: PlanContext): TodoPlan[] {
  const { actions, kwView, kwRows, bepMap, priceMap, exposureMap, notes } = ctx
  // 운영 메모에서 AI 캠페인별 이미 반영한 이동(move:<키워드>) — 중복 키워드의 AI 쪽 제외가 끝났는지 확인용
  const reflectedMoves = new Map<string, { date: string; kws: Set<string> }>()
  for (const n of notes) {
    if (n.kind !== 'reflect' || !n.campaignName) continue
    const kws = (n.items || []).filter((x) => x.startsWith('move:')).map((x) => keywordGroupKey(x.slice(5)))
    if (!kws.length) continue
    const e = reflectedMoves.get(n.campaignName) ?? { date: kstDate(n.ts), kws: new Set<string>() }
    kws.forEach((k) => e.kws.add(k))
    if (kstDate(n.ts) > e.date) e.date = kstDate(n.ts)
    reflectedMoves.set(n.campaignName, e)
  }
  const pairAiOf = (manualName: string) => {
    const k = parseCampaignTargetKey(manualName)
    if (!k || k.kind !== '수동') return null
    const prefix = k.key.split('::')[0]
    return kwView.campaigns.find((c) => parseCampaignTargetKey(c.campaignName)?.key === `${prefix}::AI`)?.campaignName ?? null
  }
  const nameIn = new Set(kwView.campaigns.map((c) => c.campaignName))
  const out: TodoPlan[] = []
  for (const t of todos) {
    const c30 = kwView.campaigns.find((c) => c.campaignName === t.campaign)
    const act = actions.find((a) => a.campaign === t.campaign) ?? null
    const plan: TodoPlan = { campaign: t.campaign, inFile: nameIn.has(t.campaign), isAi: t.isAi, movePairs: [], bidLines: [], extraBidLines: [], notes: [], kwTable: null, low: null }
    if (act) {
      for (const m of act.move) {
        plan.movePairs.push({
          keyword: m.variants.join(' · '),
          manual: m.dup
            ? `수동 [${act.pairManualName ?? '짝 수동 캠페인'}]에 이미 있음 — 유지`
            : act.pairManualName
              ? `수동 [${act.pairManualName}] 등록 — ${m.bid != null ? wonK(m.bid) + '원' : '입찰가 —'}`
              : `수동 캠페인 없음 — 새로 만들어 등록 (${m.bid != null ? wonK(m.bid) + '원' : '입찰가 —'})`,
          ai: `AI [${t.campaign}] 제외 키워드 등록`,
        })
      }
      for (const b of act.bids) plan.bidLines.push(fmtBidLine(b))
    }
    if (c30 && !t.isAi) {
      // 수동 캠페인: 키워드 전체 표 + 중복 키워드 수동 단독 재판정
      const mr = buildManualReviewRows(c30, bepMap, priceMap, new Map(), exposureMap, false)
      const aiName = pairAiOf(t.campaign)
      const refl = aiName ? reflectedMoves.get(aiName) : undefined
      const covered = new Set((act?.bids ?? []).flatMap((b) => [keywordGroupKey(b.keyword), ...b.variants.map((v) => keywordGroupKey(v.keyword))]))
      plan.kwTable = mr
        .slice()
        .sort((x, y) => y.adCostRaw - x.adCostRaw)
        .map((k) => {
          const recBid = k.recommendedBidVatExcl != null ? Math.max(ceil10(k.recommendedBidVatExcl), MIN_BID) : null
          return { keyword: k.keyword, clicks: k.clicks, adCostVat: Math.round(k.adCostVat), cpc: k.avgCpcVatExcl, revenue: Math.round(k.revenue), roasPct: rnd(k.roasPct), bepPct: rnd(k.bepPct), recBid, deleteCandidate: k.deleteCandidate }
        })
      for (const k of mr) {
        if (covered.has(k.groupKey) || !hasBidSample(k.clicks)) continue
        const recBid = k.recommendedBidVatExcl != null ? Math.max(ceil10(k.recommendedBidVatExcl), MIN_BID) : null
        const cur = k.avgCpcVatExcl
        if (recBid == null || cur == null) continue
        const need = k.deleteCandidate ? cur > MIN_BID : Math.abs(recBid - cur) / cur >= 0.1
        if (!need) continue
        const done = refl?.kws.has(k.groupKey)
        const line = fmtBidLine({ keyword: k.keyword, cur, rec: recBid, up: recBid > cur, variants: k.variantCpc.map((v) => ({ keyword: v.keyword, cur: v.avgCpcVatExcl })) })
        plan.extraBidLines.push(done
          ? `${line} — 수동 단독 기준 (AI [${aiName}] 쪽 제외는 ${refl!.date} 반영됨)`
          : `${line} — 수동 단독 기준 (AI·수동 중복 키워드: AI [${aiName ?? '짝 AI'}] 제외 키워드 등록도 같이)`)
      }
      if (!act && !plan.extraBidLines.length) plan.notes.push('클릭 20건 이상 키워드 중 조정 대상 없음 (추천 입찰가와 현재 클릭당 비용 차이 10% 미만)')
    } else if (!act) plan.notes.push('클릭 20건 이상 키워드 중 조정 대상 없음')
    // 클릭 20건 미만 키워드 — 입찰가 "—" (모수 부족)
    if (c30) {
      const low = new Map<string, { keyword: string; clicks: number; adCostVat: number }>()
      for (const r of kwRows) {
        if (r.campaignId !== c30.campaignId) continue
        const kwd = String(r.keyword ?? '').trim()
        if (NON_SEARCH_KEYWORD_TOKENS.has(kwd)) continue
        const g = keywordGroupKey(kwd)
        const e = low.get(g) ?? { keyword: kwd, clicks: 0, adCostVat: 0 }
        e.clicks += r.clicks || 0
        e.adCostVat += (r.adCost || 0) * 1.1
        low.set(g, e)
      }
      const lowList = [...low.values()].filter((x) => x.clicks < MIN_CLICKS).sort((x, y) => y.adCostVat - x.adCostVat)
      plan.low = { count: lowList.length, adCostVat: Math.round(lowList.reduce((s, x) => s + x.adCostVat, 0)), top: lowList.slice(0, 5).map((x) => ({ keyword: x.keyword, clicks: x.clicks, adCostVat: Math.round(x.adCostVat) })) }
    }
    out.push(plan)
  }
  return out
}

/** 할 일 한 건 복사용 문장 (광고센터 입력용 — 리포트·화면 공통) */
export function todoCopyText(j: CampaignJudgement, plan: TodoPlan | null): string {
  const L: string[] = [j.campaignName]
  if (j.targetAction) L.push(`목표 ROAS: ${j.applied == null ? (j.isAi ? '미입력' : '—') : `${j.applied}%`} → ${j.targetAction}`)
  if (plan) {
    for (const m of plan.movePairs) L.push(`- ${m.keyword}: ① ${m.manual} ② ${m.ai}`)
    for (const s of plan.bidLines) L.push(`- ${s.replace(/\*\*/g, '')}`)
    for (const s of plan.extraBidLines) L.push(`- ${s.replace(/\*\*/g, '')}`)
    for (const s of plan.notes) L.push(`- ${s}`)
  }
  return L.join('\n')
}
