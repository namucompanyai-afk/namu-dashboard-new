'use client'

/**
 * 광고 분석 하단 3블록 (시안 v5, 2026-10-19 대표 지시 — 재구성 2차)
 *   ③ 지난주 성과 칩 — 개선·악화·변화 없음·비교 불가·조치 없음 (누르면 목록)
 *   ④ 이번 주 할 일 — 2주 연속 BEP 미달 캠페인만 (규칙 = lib/coupang/weeklyJudge.ts, 스킬 weekly.ts 와 같은 코드)
 *   ⑤ 전체 캠페인 표 — 접기·안쪽 스크롤 없이 전부, 상태 필터 칩·정렬·BEP 미달 표시(아이콘+글자)
 * 판정·숫자는 전부 props 로 받는다 (여기서 계산하지 않음). 폰(640px 이하)은 칩까지만, 할 일·표는 "PC에서 보기".
 */

import React, { useMemo, useState } from 'react'
import {
  STATUS_TAG_LABEL,
  normName,
  statusTagOf,
  todoCopyText,
  type CampaignJudgement,
  type FollowupItem,
  type StatusTag,
  type TodoPlan,
  type Verdict,
} from '@/lib/coupang/weeklyJudge'

const won = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('ko-KR'))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`)
const md = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`
const sgn = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('ko-KR')}`
const signCls = (v: number | null | undefined) => (v == null ? '' : v < 0 ? 'neg' : v > 0 ? 'pos' : '')
/** '지난주 → 이번 주' 금액 칸 — 금액은 검정, 증감 방향 ▲▼ 만 부호색(증가 초록·감소 빨강) */
const BeforeAfter = ({ a, b, fmt = won }: { a: number | null | undefined; b: number | null | undefined; fmt?: (v: number | null | undefined) => string }) => {
  const d = a != null && b != null ? b - a : null
  // 좁은 화면에선 '→' 뒤에서만 줄바꿈 (숫자 안에서는 안 끊김)
  return (
    <>
      <span className="nw">{fmt(a)} →</span>{' '}
      <span className="nw"><b>{fmt(b)}</b>{d != null && d !== 0 && <span className={d > 0 ? 'pos' : 'neg'} aria-label={d > 0 ? '증가' : '감소'}> {d > 0 ? '▲' : '▼'}</span>}</span>
    </>
  )
}

/** 태그 아이콘 (색만으로 뜻을 전하지 않음 — 아이콘 + 글자) */
const ICON: Record<string, string> = {
  todo: 'M12 2L1 21h22L12 2z',
  wait: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5l4 2',
  watch: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  keep: 'M20 6L9 17l-5-5',
  low: 'M4 20h16M6 16v-4M12 16V8M18 16v-6',
  worse: 'M12 21L2 4h20L12 21z',
  off: 'M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10',
  none: 'M5 12h14',
}
const Ico = ({ k }: { k: string }) => (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[k] || ICON.none} /></svg>
)
const Tag = ({ k, label }: { k: string; label: string }) => <span className={`adw-tag ${k}`}><Ico k={k} />{label}</span>

/** '**굵게**' → <b> */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((s, i) => (s.startsWith('**') && s.endsWith('**') ? <b key={i}>{s.slice(2, -2)}</b> : <React.Fragment key={i}>{s}</React.Fragment>))}</>
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

// ── ③ 지난주 성과 칩 ───────────────────────────────────────────
const VERDICTS: { v: Verdict | '조치 없음'; k: string }[] = [
  { v: '개선', k: 'keep' }, { v: '악화', k: 'worse' }, { v: '변화 없음', k: 'low' }, { v: '비교 불가', k: 'wait' }, { v: '조치 없음', k: 'none' },
]
export function LastWeekChips({ followup, judged, prev, cur, clicksKnown }: {
  followup: FollowupItem[]
  judged: CampaignJudgement[]
  prev: { startDate: string; endDate: string } | null
  cur: { startDate: string; endDate: string }
  clicksKnown: boolean
}) {
  const [sel, setSel] = useState<Verdict | '조치 없음' | null>(null)
  const counts = useMemo(() => {
    const c: Record<string, number> = { 개선: 0, 악화: 0, '변화 없음': 0, '비교 불가': 0 }
    for (const f of followup) c[f.verdict] = (c[f.verdict] || 0) + 1
    return c
  }, [followup])
  // 조치 없음 = 이번 주 캠페인 중 지난주 반영 기록이 없는 것 (반영 메모 글 앞부분·캠페인명 대조)
  const adjNames = useMemo(() => new Set(followup.map((f) => normName(f.note.campaignName || f.text.split(' · ')[0]))), [followup])
  const noAct = useMemo(() => judged.filter((j) => !adjNames.has(normName(j.campaignName))).sort((a, b) => b.adCostVat - a.adCostVat), [judged, adjNames])
  const dates = followup.map((f) => f.date).sort()
  const dateLabel = dates.length ? (dates[0] === dates[dates.length - 1] ? md(dates[0]) : `${md(dates[0])}~${md(dates[dates.length - 1])}`) : ''
  if (!prev) {
    return (
      <section className="adw-card slim" aria-labelledby="adw-h-last">
        <h2 id="adw-h-last">지난주 성과 <span className="sub">지난주 기록 없음 (시작일 {md(cur.startDate)} 의 7일 전 주간 기록이 없음) — 다음 주부터 비교</span></h2>
      </section>
    )
  }
  const rows = sel === '조치 없음' ? [] : followup.filter((f) => !sel || f.verdict === sel)
  return (
    <section className="adw-card slim" aria-labelledby="adw-h-last">
      <h2 id="adw-h-last">지난주 성과 <span className="sub">
        {dateLabel ? `${dateLabel} 반영 ${followup.length}건의 1주 뒤` : '지난주 반영 기록 없음'} · 버튼 누르면 목록 · 색 = 부호(음수 빨강·양수 초록), ▲▼ = 방향
      </span></h2>
      <div className="adw-chiprow" role="group" aria-label="지난주 조치 결과">
        {VERDICTS.map(({ v, k }) => {
          const n = v === '조치 없음' ? noAct.length : counts[v] || 0
          return (
            <button key={v} type="button" className={`adw-tag ${k} chipbtn`} aria-pressed={sel === v} onClick={() => setSel((s) => (s === v ? null : v))}>
              <Ico k={k} />{v}{v === '악화' ? '▼' : ''} {n}
            </button>
          )
        })}
        <span className="muted small">ROAS·손익은 지난주({md(prev.startDate)}~{md(prev.endDate)}) → 이번 주({md(cur.startDate)}~{md(cur.endDate)}) · 반영 7일 안이라 다음 주 재판정{!clicksKnown ? ' · 클릭 20건 미만 판정은 주간 파일 올리면 표시' : ''}</span>
      </div>
      {sel && sel !== '조치 없음' && (
        <div className="adw-tw"><table className="adw-ltab adw-fu">
          <thead><tr>
            <th>캠페인 · 조치</th><th>반영일</th>
            <th className="r">광고비 지난주 → 이번 주</th><th className="r">광고 매출 지난주 → 이번 주</th>
            <th className="r">ROAS 지난주 → 이번 주</th><th className="r">BEP</th><th className="r">광고 손익 전 → 후</th><th>판정</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="muted">없음</td></tr>}
            {rows.map((f) => {
              const [camp, ...act] = f.text.split(' · ')
              const [p0, p1] = f.adProfit
              const k = VERDICTS.find((x) => x.v === f.verdict)?.k ?? 'none'
              return (
                <tr key={f.note.id}>
                  <td className="wrap"><b>{camp}</b><div className="muted small">{act.join(' · ')}</div></td>
                  <td className="num small">{md(f.date)}</td>
                  {/* 광고비·광고 매출 = 주간 기록 2주 캠페인 행 (전체 캠페인 표와 같은 값) */}
                  <td className="r num"><BeforeAfter a={f.before?.adCostVat} b={f.after?.adCostVat} /></td>
                  <td className="r num"><BeforeAfter a={f.before?.revenue} b={f.after?.revenue} /></td>
                  <td className="r num"><BeforeAfter a={f.roas[0]} b={f.roas[1]} fmt={pct} /></td>
                  <td className="r num">{pct(f.after?.bepPct)}</td>
                  <td className="r num"><span className={signCls(p0)}>{p0 == null ? '—' : sgn(p0)}</span> → <b className={signCls(p1)}>{p1 == null ? '—' : sgn(p1)}</b></td>
                  <td><Tag k={k} label={f.verdict} /></td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
      {sel === '조치 없음' && (
        <div className="adw-tw"><table className="adw-ltab">
          <thead><tr><th>캠페인</th><th className="r">광고비(VAT 포함)</th><th className="r">ROAS / BEP</th><th>이번 주 상태</th></tr></thead>
          <tbody>
            {noAct.length === 0 && <tr><td colSpan={4} className="muted">없음</td></tr>}
            {noAct.map((j) => {
              const t = statusTagOf(j)
              return (
                <tr key={j.campaignId}>
                  <td><b>{j.campaignName}</b> <span className={`adw-ch c${j.channel}`}>{j.channel}</span></td>
                  <td className="r num">{won(j.adCostVat)}</td>
                  <td className="r num">{j.lowSample ? '—' : pct(j.roasPct)} / {pct(j.bepPct)}</td>
                  <td><Tag k={t} label={STATUS_TAG_LABEL[t]} /></td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
    </section>
  )
}

// ── ④ 이번 주 할 일 ────────────────────────────────────────────
export type TodoRow = { j: CampaignJudgement; plan: TodoPlan | null; done: string | null }
export function TodoBlock({ rows, has30, file30, onReflect }: {
  rows: TodoRow[]
  /** 30일 파일이 이 화면에 있는지 (없으면 키워드 조치 생략 안내) */
  has30: boolean
  file30: { startDate: string; endDate: string } | null
  /** 관리자만 — 없으면 '쿠팡 반영 완료' 버튼을 그리지 않음 */
  onReflect?: (row: TodoRow) => Promise<void>
}) {
  const n = rows.filter((r) => !r.done).length
  return (
    <section className="adw-card adw-todo" aria-labelledby="adw-h-todo">
      <h2 id="adw-h-todo">이번 주 할 일 <span className="sub">
        2주 연속 BEP 미달 {n}개 · 효율 ≥ BEP 는 건드리지 않음 · 입찰가 VAT 별도 · 인하는 주 30% 상한 · 처리 후 쿠팡 반영 완료
        {has30 && file30 ? ` · 키워드·입찰은 30일 파일 ${md(file30.startDate)}~${md(file30.endDate)} 기준` : ''}
      </span></h2>
      {!has30 && <div className="adw-note">30일 파일 올리면 키워드 조치 표시 (지금은 목표 ROAS 판정만)</div>}
      {rows.length === 0 ? (
        <div className="muted" style={{ padding: '8px 0' }}>이번 주 할 일 없음 — 2주 연속 BEP 미달 캠페인 없음</div>
      ) : rows.map((row, i) => <TodoItem key={row.j.campaignId} i={i} row={row} has30={has30} onReflect={onReflect} />)}
    </section>
  )
}

function TodoItem({ i, row, has30, onReflect }: { i: number; row: TodoRow; has30: boolean; onReflect?: (row: TodoRow) => Promise<void> }) {
  const { j, plan, done } = row
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const copyAll = async () => {
    if (await copyText(todoCopyText(j, plan))) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    else setMsg('복사 실패 — 브라우저 권한 확인')
  }
  const reflect = async () => {
    if (!onReflect) return
    setBusy(true)
    try { await onReflect(row); setMsg('') } catch (e) { setMsg(`기록 실패: ${e instanceof Error ? e.message : String(e)}`) } finally { setBusy(false) }
  }
  const goal = !j.isAi ? '—' : `${j.applied == null ? '미입력' : `${j.applied}%`}`
  const hasKw = !!plan && (plan.movePairs.length + plan.bidLines.length + plan.extraBidLines.length > 0)
  return (
    <div className={`adw-todo-item${done ? ' done' : ''}`}>
      <div>
        <div className="t">{i + 1}. {j.campaignName}</div>
        <div className="m">ID {j.campaignId} · {j.channel === '3P' ? '윙 광고센터' : '서플라이어 허브 광고센터'}</div>
        <div className="m num">지난주 {j.prev ? pct(j.prev.roasPct) : '—'} → 이번 주 <b>{j.cur ? pct(j.cur.roasPct) : pct(j.roasPct)}</b> / BEP {pct(j.bep)}</div>
      </div>
      <div>
        <div className="m">목표 ROAS</div>
        <div className="num">{goal}{j.isAi && j.targetAction ? <> → <b>{j.targetAction}</b></> : null}</div>
        {!j.isAi && <div className="m">{j.targetAction}</div>}
      </div>
      <div>
        {!has30 && <div className="m">30일 파일 올리면 키워드 조치 표시</div>}
        {has30 && plan && !plan.inFile && <div className="m">30일 파일에 이 캠페인 없음 — 키워드 조치 생략</div>}
        {plan && plan.movePairs.length > 0 && (
          <>
            <div className="acthead">AI → 수동 이동 (두 가지를 한 쌍으로)</div>
            <ul className="actlist">{plan.movePairs.map((m, k) => <li key={k}><b>{m.keyword}</b>: ① {m.manual} ② {m.ai}</li>)}</ul>
          </>
        )}
        {plan && plan.bidLines.length > 0 && (
          <>
            <div className="acthead">수동 입찰가 (VAT 별도)</div>
            <ul className="actlist">{plan.bidLines.map((s, k) => <li key={k}><Rich text={s} /></li>)}</ul>
          </>
        )}
        {plan && plan.extraBidLines.length > 0 && (
          <>
            <div className="acthead">수동 입찰가 — 중복 키워드 수동 단독 재판정</div>
            <ul className="actlist">{plan.extraBidLines.map((s, k) => <li key={k}><Rich text={s} /></li>)}</ul>
          </>
        )}
        {plan && plan.notes.map((s, k) => <div key={k} className="m">{s}</div>)}
        {plan && plan.low && plan.low.count > 0 && (
          <div className="m">클릭 20건 미만 키워드 {plan.low.count}개 — 입찰가 &ldquo;—&rdquo; (모수 부족, 광고비 {won(plan.low.adCostVat)})</div>
        )}
        {has30 && plan && plan.inFile && !hasKw && plan.notes.length === 0 && <div className="m">키워드 조치 없음</div>}
      </div>
      <div className="actbtns">
        <button type="button" className={`adw-btn${copied ? ' copied' : ''}`} onClick={copyAll}>{copied ? '복사됨' : '전체 복사'}</button>
        {onReflect && (
          <button type="button" className="adw-btn primary" disabled={busy || !!done} onClick={reflect}>
            {done ? '반영됨' : busy ? '기록 중…' : '쿠팡 반영 완료'}
          </button>
        )}
        {done && <div className="m">반영 {done}</div>}
        {msg && <div className="m" style={{ color: 'var(--adw-danger)' }}>{msg}</div>}
      </div>
    </div>
  )
}

// ── ⑤ 전체 캠페인 표 ───────────────────────────────────────────
type SortKey = 'adCostVat' | 'revenue' | 'roasPct' | 'adProfit' | 'clicks'
const TAG_ORDER: StatusTag[] = ['todo', 'wait', 'watch', 'keep', 'low', 'off']
const TAG_RULE: Record<StatusTag, string> = {
  todo: '2주 연속 BEP 미달', wait: '반영 7일 안', watch: '1주만 미달·기록 부족', keep: '효율 ≥ BEP', low: '클릭 <20', off: '운영 메모 OFF', none: '',
}
export function CampaignTable({ judged, clicksKnown, lag, weekLabel, openId, onOpen, renderDetail }: {
  judged: CampaignJudgement[]
  clicksKnown: boolean
  /** 14일 전환 미반영 경고 (있으면 표 위에 고정 표시) */
  lag: { missingDays: number; asof: string } | null
  weekLabel: string
  openId: string | null
  onOpen: (id: string) => void
  /** 30일 파일 키워드 상세 (행 클릭) — 없으면 행 클릭 없음 */
  renderDetail?: (campaignId: string) => React.ReactNode
}) {
  const [filter, setFilter] = useState<StatusTag | null>(null)
  const [sort, setSort] = useState<{ k: SortKey; dir: 'asc' | 'desc' }>({ k: 'adCostVat', dir: 'desc' })
  const tagged = useMemo(() => judged.map((j) => ({ j, tag: statusTagOf(j) })), [judged])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of tagged) c[t.tag] = (c[t.tag] || 0) + 1
    return c
  }, [tagged])
  const rows = useMemo(() => {
    const r = filter ? tagged.filter((t) => t.tag === filter) : tagged.slice()
    const v = (x: CampaignJudgement) => (x[sort.k] ?? (sort.dir === 'desc' ? -Infinity : Infinity)) as number
    r.sort((a, b) => (sort.dir === 'desc' ? v(b.j) - v(a.j) : v(a.j) - v(b.j)))
    return r
  }, [tagged, filter, sort])
  const toggleSort = (k: SortKey) => setSort((s) => (s.k === k ? { k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { k, dir: 'desc' }))
  // 정렬 열 머리 (컴포넌트가 아니라 JSX 조각 — 렌더마다 새 컴포넌트를 만들지 않음)
  const th = (k: SortKey, label: string) => (
    <th key={k} scope="col" className="r sortable" aria-sort={sort.k === k ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'} onClick={() => toggleSort(k)}>
      {label}<span className="sort">{sort.k === k ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'}</span>
    </th>
  )
  return (
    <section className="adw-card adw-table" aria-labelledby="adw-h-all">
      <h2 id="adw-h-all">전체 캠페인 <span className="sub">{judged.length}개 · {weekLabel} · 기본 정렬 광고비 큰 순 · 열 머리 클릭으로 정렬{renderDetail ? ' · 행 클릭 → 키워드 상세·복사 (30일 파일)' : ' · 30일 파일 올리면 행 클릭으로 키워드 상세'}</span></h2>
      {lag && lag.missingDays > 0 && (
        <div className="adw-warn" role="status">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <div><b>최근 {lag.missingDays}일 클릭분 매출 미반영</b> — 효율이 낮게 보일 수 있음 (받은 날 {md(lag.asof)}). 쿠팡 광고 매출은 클릭 후 14일 전환 기준</div>
        </div>
      )}
      <div className="adw-chiprow" role="group" aria-label="상태 필터">
        <button type="button" className="adw-tag none chipbtn" aria-pressed={filter == null} onClick={() => setFilter(null)}>전체 {judged.length}</button>
        {TAG_ORDER.map((t) => (
          <button key={t} type="button" className={`adw-tag ${t} chipbtn`} aria-pressed={filter === t} onClick={() => setFilter((f) => (f === t ? null : t))}>
            <Ico k={t} />{STATUS_TAG_LABEL[t]} {counts[t] || 0}
          </button>
        ))}
      </div>
      <div className="adw-legend">
        {TAG_ORDER.map((t) => <span key={t}><Tag k={t} label={STATUS_TAG_LABEL[t]} /> {TAG_RULE[t]}</span>)}
        <span><span className="adw-under">▼ 313%</span> = BEP 미달</span>
        {!clicksKnown && <span>클릭 · 모수 부족 = 주간 파일 올리면 표시</span>}
      </div>
      <div className="adw-tw">
        <table>
          <thead>
            <tr>
              <th scope="col">캠페인</th>
              <th scope="col">채널</th>
              {th('adCostVat', '광고비(VAT 포함)')}
              {th('revenue', '광고 매출')}
              {th('roasPct', 'ROAS')}
              <th scope="col" className="r">BEP</th>
              {th('adProfit', '광고 손익')}
              {th('clicks', '클릭')}
              <th scope="col">상태</th>
              <th scope="col">마지막 조치일</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} className="muted">없음</td></tr>}
            {rows.map(({ j, tag }) => {
              const under = !j.lowSample && j.roasPct != null && j.bepPct != null && j.roasPct < j.bepPct
              const open = openId === j.campaignId
              const clickable = !!renderDetail
              return (
                <React.Fragment key={j.campaignId}>
                  <tr id={`adw-camp-${j.campaignId}`} className={`${tag}${clickable ? ' clickable' : ''}${open ? ' selected' : ''}`} tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => onOpen(j.campaignId) : undefined}
                    onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(j.campaignId) } } : undefined}>
                    <td className="l"><span className="nm">{j.campaignName}</span>{clickable && <span className="muted small"> {open ? '▾' : '▸'}</span>}</td>
                    <td><span className={`adw-ch c${j.channel}`}>{j.channel}</span></td>
                    <td className="r num">{won(j.adCostVat)}</td>
                    <td className="r num">{won(j.revenue)}</td>
                    <td className={`r num${under ? ' adw-under' : ''}`}>{j.lowSample ? '—' : under ? <><span aria-hidden="true">▼</span> {pct(j.roasPct)}<span className="sr">(BEP 미달)</span></> : pct(j.roasPct)}</td>
                    <td className="r num">{pct(j.bepPct)}</td>
                    <td className={`r num ${signCls(j.adProfit)}`}>{won(j.adProfit)}</td>
                    <td className="r num">{j.clicks == null ? '—' : won(j.clicks)}</td>
                    <td><Tag k={tag} label={STATUS_TAG_LABEL[tag]} /></td>
                    <td className="muted small num">{j.lastReflect ? md(j.lastReflect) : '—'}{j.offNote ? ' · OFF' : ''}</td>
                  </tr>
                  {open && renderDetail && (
                    <tr className="adw-detail"><td colSpan={10}><div className="adw-detailbox">{renderDetail(j.campaignId)}</div></td></tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** 폰에서 할 일·표 대신 한 줄 */
export const MobileNote = () => <div className="adw-mobile">이번 주 할 일 · 전체 캠페인 표는 PC에서 보기</div>

// 시안 v5 CSS 토큰 (WeeklyOverview 와 같은 값) — .adw 안에만
export const WEEKLY_BLOCKS_CSS = `
.adw{--adw-bg:#f6f4ef;--adw-card:#FFFFFF;--adw-fg:#111827;--adw-muted:#f1efe9;--adw-muted-fg:#6b7280;--adw-border:#e9e5dc;--adw-primary:#1E40AF;--adw-accent:#B45309;--adw-accent-soft:#D97706;--adw-danger:#DC2626;--adw-ok:#15803D;--adw-info:#1D4ED8;--adw-ring:#1E40AF;
  color:var(--adw-fg);font:14px/1.5 Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",Roboto,sans-serif;margin-top:16px}
.adw .muted{color:var(--adw-muted-fg)}.adw .small{font-size:12px}.adw .num{font-variant-numeric:tabular-nums;white-space:nowrap}.adw .neg{color:var(--adw-danger)}.adw .pos{color:var(--adw-ok)}
.adw .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.adw-card{background:var(--adw-card);border:1px solid var(--adw-border);border-radius:16px;padding:24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(17,24,39,.04),0 1px 1px rgba(17,24,39,.03)}
.adw-card.slim{padding:12px 24px}.adw-card:last-of-type{margin-bottom:0}
.adw-card h2{font-size:16px;font-weight:800;letter-spacing:-.01em;margin:0 0 12px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.adw-card h2 .sub{font-weight:400;color:var(--adw-muted-fg);font-size:12px}
.adw-card.slim h2{margin-bottom:8px}
.adw-note{font-size:12px;color:var(--adw-accent);background:#fff8ea;border:1px solid #f0dcb4;border-radius:8px;padding:6px 10px;margin-bottom:8px}
.adw-warn{display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,var(--adw-accent) 12%,var(--adw-card));border:1px solid color-mix(in srgb,var(--adw-accent) 45%,transparent);border-radius:10px;padding:8px 12px;margin-bottom:12px;font-size:13px}
.adw-chiprow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.adw-tag{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--adw-border);white-space:nowrap;background:var(--adw-card);color:var(--adw-fg)}
.adw-tag.todo,.adw-tag.worse{color:var(--adw-danger);border-color:color-mix(in srgb,var(--adw-danger) 45%,transparent);background:color-mix(in srgb,var(--adw-danger) 10%,var(--adw-card))}
.adw-tag.wait{color:var(--adw-info);border-color:color-mix(in srgb,var(--adw-info) 45%,transparent);background:color-mix(in srgb,var(--adw-info) 10%,var(--adw-card))}
.adw-tag.watch{color:var(--adw-accent);border-color:color-mix(in srgb,var(--adw-accent) 50%,transparent);background:color-mix(in srgb,var(--adw-accent) 12%,var(--adw-card))}
.adw-tag.keep{color:var(--adw-ok);border-color:color-mix(in srgb,var(--adw-ok) 45%,transparent);background:color-mix(in srgb,var(--adw-ok) 10%,var(--adw-card))}
.adw-tag.low{color:var(--adw-muted-fg)}.adw-tag.none{color:var(--adw-muted-fg);background:var(--adw-muted)}
.adw-tag.off{color:#374151;border-color:#9ca3af;background:#f3f4f6}
.chipbtn{cursor:pointer;font:inherit;font-size:12px}.chipbtn[aria-pressed=true]{outline:2px solid var(--adw-ring);outline-offset:1px;font-weight:700}.chipbtn:focus-visible{outline:2px solid var(--adw-ring);outline-offset:2px}
.adw-tw{overflow:auto;border:1px solid var(--adw-border);border-radius:12px;margin-top:8px}
.adw table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;min-width:980px}
.adw thead th{position:sticky;top:0;background:var(--adw-muted);color:var(--adw-muted-fg);font-weight:600;text-align:left;padding:8px 12px;border-bottom:1px solid var(--adw-border);white-space:nowrap}
.adw thead th.r{text-align:right}.adw th.sortable{cursor:pointer}.adw th .sort{font-size:10px;opacity:.6;margin-left:4px}
.adw tbody td{padding:7px 12px;border-bottom:1px solid var(--adw-border);vertical-align:middle}
.adw tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--adw-muted) 45%,var(--adw-card))}.adw tbody tr.clickable{cursor:pointer}.adw tbody tr.clickable:hover td{background:var(--adw-muted)}
.adw tbody tr.selected td{background:#fff7ed}.adw tbody tr:focus-visible{outline:2px solid var(--adw-ring);outline-offset:-2px}
.adw td.r{text-align:right}.adw td.l{min-width:260px}.adw .nm{font-weight:500}.adw tr.todo td.l .nm{font-weight:700}
.adw-under{color:var(--adw-danger);font-weight:700}
.adw-ch{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;border:1px solid var(--adw-border);color:var(--adw-muted-fg)}.adw-ch.c1P{color:var(--adw-primary);border-color:color-mix(in srgb,var(--adw-primary) 40%,transparent)}
.adw-ltab{min-width:0!important}.adw-ltab th{position:static!important}
/* 지난주 조치 목록 — 가로 스크롤 없이: 캠페인 칸을 줄이고 조치 요약은 줄바꿈(2줄 허용) */
.adw-fu{table-layout:fixed}.adw-fu th:first-child{width:18%}.adw-fu th:nth-child(2){width:48px}.adw-fu th:nth-child(3),.adw-fu th:nth-child(4){width:16%}.adw-fu th:nth-child(7){width:17%}.adw-fu th:nth-child(5){width:14%}.adw-fu th:nth-child(6){width:52px}.adw-fu th:last-child{width:84px}
.adw-fu th{white-space:normal;line-height:1.3}
.adw-fu td.wrap{white-space:normal;overflow-wrap:anywhere}.adw-fu td.wrap b{display:block}.adw-fu td.wrap .small{line-height:1.35}
.adw-fu td.r.num{white-space:normal}.adw-fu .nw{white-space:nowrap}
.adw tr.adw-detail td{padding:0;background:#fff!important;white-space:normal}.adw-detailbox{max-height:900px;overflow:auto;padding:4px 8px 12px;font-family:Pretendard,-apple-system,sans-serif}
.adw-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--adw-muted-fg);margin:4px 0 8px}
.adw-todo-item{display:grid;grid-template-columns:minmax(300px,1.2fr) minmax(130px,.55fr) minmax(260px,1.7fr) auto;gap:12px;align-items:start;padding:12px 0;border-top:1px solid var(--adw-border)}
.adw-todo-item:first-of-type{border-top:0}.adw-todo-item .t{font-weight:700}.adw-todo-item .m{font-size:12px;color:var(--adw-muted-fg)}
.adw-todo-item.done{opacity:.55}.adw-todo-item.done .t{text-decoration:line-through}
.adw .acthead{font-weight:600;margin:2px 0}.adw .actlist{margin:0 0 4px;padding-left:18px;line-height:1.7}.adw .actlist li{margin:0}
.actbtns{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.adw-btn{display:inline-flex;align-items:center;min-height:32px;border:1px solid var(--adw-border);border-radius:10px;padding:0 12px;font-size:12px;background:var(--adw-card);color:var(--adw-fg);cursor:pointer;font-family:inherit}
.adw-btn:hover{background:var(--adw-muted)}.adw-btn:focus-visible{outline:2px solid var(--adw-ring);outline-offset:2px}.adw-btn.primary{background:var(--adw-primary);color:#fff;border-color:var(--adw-primary)}
.adw-btn.copied{background:var(--adw-ok);color:#fff;border-color:var(--adw-ok)}.adw-btn:disabled{opacity:.5;cursor:not-allowed}
.adw-mobile{display:none;font-size:13px;color:var(--adw-muted-fg);padding:8px 0}
@media (max-width:900px){.adw-todo-item{grid-template-columns:1fr}}
@media (max-width:640px){.adw-card{padding:16px}.adw-todo,.adw-table{display:none}.adw-mobile{display:block}}
@media (prefers-reduced-motion:reduce){.adw *{transition:none!important}}
`
