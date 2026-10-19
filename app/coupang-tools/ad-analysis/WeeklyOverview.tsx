'use client'

/**
 * 광고 분석 상단 2블록 (시안 v5, 2026-10-19 대표 지시 — 재구성 1차)
 *   ① 브레인 코멘트 — 한 줄 평(첫 문장 숫자 자동 + 브레인 판단) + 넘버링 4줄 (coupang_ad_weekly_comment_<주 시작일>)
 *   ② 이번 주 성과 — 타일 6개(최근 13주 꺾은선, 클릭 → 확대 팝업) + 도넛(광고 매출 vs 자연 매출, 클릭 → 주별 꺾은선)
 * 숫자는 저장된 값을 그대로 보여 준다 (주간 기록·백필·전체 매출 — lib/coupang/adWeekly13.ts). 계산 규칙 변경 없음.
 * 그래프는 시안과 같은 모양을 위해 SVG 로 직접 그린다 (gen_mock_v5.js 의 line·donutSvg·mixBars 를 옮김).
 * 색: 증감은 부호 기준(음수 빨강·양수 초록) — 좋고 나쁨 색이 아님 (대표 2026-10-19).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { headlineAuto, type SalesRow, type WeekPoint, type WeeklyComment } from '@/lib/coupang/adWeekly13'

type Key = 'cost' | 'rev' | 'total' | 'profit' | 'adShare' | 'roas'
type Tip = { x: number; y: number; html: React.ReactNode } | null

/** 1P/3P 토글 — 채널별 주간 자료가 생기는 2차에서 켠다 (지금은 렌더만 끔, 코드는 유지) */
const SHOW_CHANNEL_TOGGLE = false

const won = (v: number) => Math.round(v).toLocaleString('ko-KR')
const md = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`
const sgn = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('ko-KR')}`
const fmtVal = (v: number | undefined, unit: string) => (v == null ? '—' : unit === '%' ? `${Math.round(v)}%` : won(v))
/** 확대 그래프 값 라벨·눈금 — 소수 1자리. 한 그래프 안에선 단위 하나 (절댓값 최대 100만 이상이면 전부 '백만', 아니면 전부 '만') */
const fmt1 = (v: number, unit: string, mil: boolean) =>
  unit === '%' ? `${v.toFixed(1)}%` : mil ? `${(v / 1e6).toFixed(1)}백만` : `${(v / 1e4).toFixed(1)}만`
const srcText = (w: WeekPoint) =>
  `${w.src === 'daily' ? '일별 보고서 환산(쿠팡 전환매출 기준)' : w.src === 'weekly' ? '주간 기록' : '—'}${w.days && w.days < 7 ? ` · ${w.days}일치` : ''}`

// ── 13주 꺾은선 (작게 = 타일, 크게 = 팝업) ───────────────────────
function Line({
  weeks, k, unit, refKey, big, label, setTip,
}: {
  weeks: WeekPoint[]; k: Key; unit: string; refKey?: 'bep' | 'target'; big?: boolean; label: string; setTip: (t: Tip) => void
}) {
  const [hot, setHot] = useState<number | null>(null)
  const n = weeks.length
  const w = big ? 760 : 200, h = big ? 280 : 56, padL = big ? 72 : 2, padR = big ? 28 : 4, top = big ? 44 : 6
  const xs = (i: number) => padL + (i * (w - padL - padR)) / Math.max(1, n - 1)
  const val = (wk: WeekPoint, key: string) => (wk as unknown as Record<string, number | undefined>)[key]
  // 기준선(목표·BEP)은 본값이 있는 주에만 — 자료 없는 왼쪽 구간엔 아무것도 안 그림 (2026-10-19 레이아웃 수정)
  const has = (wk: WeekPoint) => val(wk, k) != null
  const all = [k, ...(refKey ? [refKey] : [])].flatMap((key) => weeks.filter(has).map((wk) => val(wk, key)).filter((v): v is number => v != null))
  if (!all.length) return <div className="ado-ph">자료 없음</div>
  const rawMax = Math.max(...all), rawMin = Math.min(0, ...all), rawSpan = rawMax - rawMin || 1
  const max = big ? rawMax + rawSpan * 0.12 : rawMax
  const min = big && rawMin < 0 ? rawMin - rawSpan * 0.12 : rawMin
  const span = max - min || 1
  const ys = (v: number) => top + (h - top) - ((v - min) / span) * (h - top - 2)
  const mil = Math.max(Math.abs(min), Math.abs(max)) >= 1e6 // 이 그래프의 단위
  const pathOf = (key: string) => {
    let d = '', pen = false
    weeks.forEach((wk, i) => {
      const v = has(wk) ? val(wk, key) : undefined
      if (v == null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`
      pen = true
    })
    return d
  }
  const step = (w - padL - padR) / Math.max(1, n - 1)
  const onMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect()
    const fx = (ev.clientX - r.left) / r.width
    // viewBox 좌표로 바꿔 가장 가까운 주
    const vx = fx * w
    const i = Math.max(0, Math.min(n - 1, Math.round((vx - padL) / step)))
    setHot(i)
    const wk = weeks[i]
    const v = val(wk, k)
    if (v == null) { setTip(null); return }
    const rv = refKey ? val(wk, refKey) : undefined
    setTip({
      x: ev.clientX, y: ev.clientY,
      html: (
        <>
          <b>{md(wk.s)}~{md(wk.e)}</b><br />{label} <b>{fmtVal(v, unit)}</b>
          {rv != null && <><br />{refKey === 'bep' ? 'BEP ' : '목표 '}{Math.round(rv)}%</>}
          {wk.src === 'daily' && <><br /><span className="ado-tipmuted">{srcText(wk)}</span></>}
        </>
      ),
    })
  }
  const last = n - 1
  return (
    <svg
      className={`ado-spark${big ? ' big' : ''}`}
      viewBox={`0 0 ${w} ${h + 16}`}
      width="100%"
      height={big ? undefined : h + 16}
      preserveAspectRatio={big ? 'xMidYMid meet' : 'none'}
      role="img"
      aria-label={`최근 13주 ${label}`}
      onMouseMove={onMove}
      onMouseLeave={() => { setHot(null); setTip(null) }}
    >
      {/* 자료 없는 주는 비워 둔다 (회색 상자·안내 글자 없음 — 가로축만 다른 타일과 맞춤) */}
      {big && Array.from({ length: 5 }, (_, t) => min + (span / 4) * t).map((v, t) => (
        <g key={`t${t}`}>
          <line x1={padL} x2={w - padR} y1={ys(v).toFixed(1)} y2={ys(v).toFixed(1)} className="ado-grid" />
          <text x={padL - 8} y={(ys(v) + 4).toFixed(1)} textAnchor="end" className="ado-axl">{fmt1(v, unit, mil)}</text>
        </g>
      ))}
      {/* 0 선 — 0 이 그래프 범위 안일 때만 (값이 전부 음수면 그리지 않음 — 위 글자를 가림) */}
      {min < 0 && max > 0 && <line x1={big ? padL : 0} x2={w} y1={ys(0).toFixed(1)} y2={ys(0).toFixed(1)} className="ado-zero" />}
      {refKey && <path d={pathOf(refKey)} className="ado-ref" />}
      {/* 확대 팝업: 점선(BEP·목표) 위에도 주별 값 라벨 — 실선 라벨과 겹치면 점선 반대쪽으로 (대표 2026-10-19 "이 점선 뭐야") */}
      {big && refKey && weeks.map((wk, i) => {
        if (!has(wk)) return null
        const rv = val(wk, refKey)
        if (rv == null) return null
        const v = val(wk, k)
        let y = ys(rv) - 6 // 기본: 점선 위
        if (v != null) {
          const mainY = ys(v) - 10 // 실선 라벨 위치
          if (Math.abs(mainY - y) < 12) y = v > rv ? ys(rv) + 13 : ys(rv) - 16
        }
        return <text key={`r${i}`} x={xs(i).toFixed(1)} y={y.toFixed(1)} textAnchor="middle" className="ado-rlab">{fmt1(rv, '%', false)}</text>
      })}
      <path d={pathOf(k)} className="ado-ln" />
      {weeks.map((wk, i) => {
        const v = val(wk, k)
        if (v == null) return null
        return (
          <g key={`p${i}`}>
            <circle cx={xs(i).toFixed(1)} cy={ys(v).toFixed(1)} r={(i === last ? 3.5 : 2.2) * (big ? 2 : 1)} className={`ado-dot${i === last ? ' cur' : ''}${hot === i ? ' hot' : ''}`} />
            {big && <text x={xs(i).toFixed(1)} y={(ys(v) - 10).toFixed(1)} textAnchor="middle" className={`ado-vlab${i === last ? ' cur' : ''}`}>{fmt1(v, unit, mil)}</text>}
          </g>
        )
      })}
      {weeks.map((wk, i) => (big || i % 4 === 0 || i === last ? (
        <text key={`x${i}`} x={xs(i).toFixed(1)} y={h + 12} textAnchor={big ? 'middle' : i === last ? 'end' : i === 0 ? 'start' : 'middle'} className="ado-axl">{md(wk.s)}</text>
      ) : null))}
    </svg>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])
  return (
    <div className="ado-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ado-mbox">
        <div className="ado-mhead"><h3>{title}</h3><button type="button" className="ado-mclose" aria-label="닫기" onClick={onClose} autoFocus>✕</button></div>
        {children}
      </div>
    </div>
  )
}

/** note = 타일 각주(1줄, 넘치면 말줄임) · noteFull = 확대 팝업 하단 출처 줄(전체 문장) */
type TileDef = { key: Key; label: string; unit: string; note?: string; noteFull?: string; hero?: boolean; vclass?: 'blue' | 'amber' | 'sign'; refKey?: 'bep' | 'target'; pendingNote?: string }

/** 자료가 13주 중간부터 있으면 "MM/DD부터 기록" (앞 구간이 비어 있는 타일만) */
const sinceText = (weeks: WeekPoint[], k: Key) => {
  const i = weeks.findIndex((w) => w[k] != null)
  return i > 0 ? `${md(weeks[i].s)}부터 기록` : ''
}
const joinNote = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')

function Tile({ d, weeks, setTip, onOpen }: { d: TileDef; weeks: WeekPoint[]; setTip: (t: Tip) => void; onOpen: () => void }) {
  const cur = weeks[weeks.length - 1]?.[d.key]
  const prev = weeks[weeks.length - 2]?.[d.key]
  const pending = cur == null
  const delta = cur != null && prev != null ? cur - prev : null
  const vcls = d.vclass === 'sign' ? (cur != null && cur < 0 ? 'neg' : 'pos') : d.vclass ?? ''
  const note = pending && d.pendingNote ? d.pendingNote : joinNote(d.note, sinceText(weeks, d.key))
  return (
    <div
      className={`ado-kpi${d.hero ? ' hero' : ''}${pending ? ' pending' : ''} clickable`}
      role="button" tabIndex={0} title="클릭하면 크게"
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <div className="lb">{d.label} <span className="ado-zoom" aria-hidden="true">⤢</span></div>
      <div className={`v ${vcls}`}>{fmtVal(cur, d.unit)}</div>
      <div className="d">
        지난주 {fmtVal(prev, d.unit)}
        {delta != null && delta !== 0 && <> · <b className={delta > 0 ? 'up' : 'down'}>{delta > 0 ? '▲' : '▼'} {d.unit === '%' ? `${sgn(delta)}%p` : sgn(delta)}</b></>}
      </div>
      <Line weeks={weeks} k={d.key} unit={d.unit} refKey={d.refKey} label={d.label} setTip={setTip} />
      {note && <div className="note line1" title={note}>{note}</div>}
    </div>
  )
}

/** 출처 설명 전체 문장 — 블록 부제에서 뺀 내용 (ⓘ 말풍선·확대 팝업 하단 출처 줄) */
const sourceText = (weeks: WeekPoint[]) => {
  const daily = weeks.filter((w) => w.src === 'daily')
  const firstWeekly = weeks.find((w) => w.src === 'weekly')
  return [
    daily.length > 0 ? `${md(daily[0].s)}~${md(daily[daily.length - 1].s)} 주는 일별 보고서 환산(쿠팡 전환매출 기준)` : '',
    firstWeekly ? `${md(firstWeekly.s)}~는 주간 기록 · 손익·BEP·전체 매출·광고비 비중은 주간 기록 주만` : '',
    '마우스 올리면 값',
  ].filter(Boolean).join(' · ')
}

/** 확대 팝업 범례 — 점선이 뭔지 한 줄 (대표 2026-10-19 "이 점선 뭐야") */
const LEGEND: Record<'bep' | 'target', string> = {
  bep: '— 실선 ROAS · - - 점선 BEP ROAS(본전, 주별) · 실선이 점선 아래면 손해',
  target: '— 실선 광고비 비중 · - - 점선 12월 목표 15% · 실선이 점선 위면 목표 미달',
}
function TileModal({ d, weeks, setTip, onClose }: { d: TileDef; weeks: WeekPoint[]; setTip: (t: Tip) => void; onClose: () => void }) {
  const refCol = d.refKey === 'bep' ? 'BEP ROAS' : null
  return (
    <Modal title={`${d.label} — 최근 13주`} onClose={onClose}>
      {d.refKey && <div className="ado-legend"><span className="ln" aria-hidden="true" /><span className="ref" aria-hidden="true" />{LEGEND[d.refKey]}</div>}
      <Line weeks={weeks} k={d.key} unit={d.unit} refKey={d.refKey} label={d.label} setTip={setTip} big />
      <table className="ado-ltab">
        <thead><tr><th>주(월~일)</th><th className="r">{d.label}</th>{refCol && <th className="r">{refCol}</th>}<th className="r">전주 대비</th><th>출처</th></tr></thead>
        <tbody>
          {weeks.map((wk, i) => {
            const v = wk[d.key], pv = i > 0 ? weeks[i - 1][d.key] : undefined
            const dd = v != null && pv != null ? v - pv : null
            return (
              <tr key={wk.s}>
                <td>{md(wk.s)}~{md(wk.e)}</td>
                <td className="r num">{fmtVal(v, d.unit)}</td>
                {refCol && <td className="r num">{wk.bep != null ? `${wk.bep.toFixed(1)}%` : '—'}</td>}
                <td className={`r num ${dd == null ? '' : dd < 0 ? 'down' : dd > 0 ? 'up' : ''}`}>{dd == null ? '—' : d.unit === '%' ? `${sgn(dd)}%p` : sgn(dd)}</td>
                <td className="muted small">{srcText(wk)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="note">{joinNote(d.noteFull ?? d.note, sinceText(weeks, d.key), sourceText(weeks))}</div>
    </Modal>
  )
}

// ── 광고 매출 vs 자연 매출 도넛 ─────────────────────────────────
const AD_C = '#2563EB', NAT_C = '#D97706'
function Donut({ ad, total, size, setTip }: { ad: number; total: number; size: number; setTip: (t: Tip) => void }) {
  const nat = Math.max(0, total - ad), tot = ad + nat || 1
  const adP = (ad / tot) * 100, natP = 100 - adP
  const R = 34, C = 2 * Math.PI * R, gap = 2
  const adLen = (C * adP) / 100 - gap, natLen = (C * natP) / 100 - gap
  const tip = (html: React.ReactNode) => (ev: React.MouseEvent) => setTip({ x: ev.clientX, y: ev.clientY, html })
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={`광고 매출 ${Math.round(adP)}%, 자연 매출 ${Math.round(natP)}%`}>
      <circle cx="50" cy="50" r={R} fill="none" stroke="var(--ado-border)" strokeWidth="12" />
      <circle className="ado-seg" cx="50" cy="50" r={R} fill="none" stroke={AD_C} strokeWidth="12" strokeDasharray={`${adLen.toFixed(1)} ${(C - adLen).toFixed(1)}`} strokeDashoffset={(C / 4).toFixed(1)}
        onMouseMove={tip(<>광고 매출 {won(ad)}원 ({adP.toFixed(1)}%)</>)} onMouseLeave={() => setTip(null)} />
      <circle className="ado-seg" cx="50" cy="50" r={R} fill="none" stroke={NAT_C} strokeWidth="12" strokeDasharray={`${natLen.toFixed(1)} ${(C - natLen).toFixed(1)}`} strokeDashoffset={(C / 4 - (C * adP) / 100 - gap).toFixed(1)}
        onMouseMove={tip(<>자연 매출 {won(nat)}원 ({natP.toFixed(1)}%)</>)} onMouseLeave={() => setTip(null)} />
      <text x="50" y="47" textAnchor="middle" className="ado-dnum">{Math.round(adP)}%</text>
      <text x="50" y="60" textAnchor="middle" className="ado-dlab">광고</text>
    </svg>
  )
}

function MixLines({ weeks, setTip }: { weeks: WeekPoint[]; setTip: (t: Tip) => void }) {
  const rows = weeks.filter((w) => w.total != null && w.rev != null) as (WeekPoint & { total: number; rev: number })[]
  if (!rows.length) return null
  const w = 760, h = 260, padL = 64, padR = 24, top = 30, bottom = 34
  const max = Math.max(...rows.map((r) => r.total)) || 1
  const n = rows.length
  const xs = (i: number) => padL + (w - padL - padR) * (n > 1 ? i / (n - 1) : 0.5)
  const y = (v: number) => top + (h - top - bottom) * (1 - v / max)
  const lab = (r: WeekPoint) => `${md(r.s)}~${md(r.e)}`
  const path = (fn: (r: (typeof rows)[number]) => number) => rows.map((r, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${y(fn(r)).toFixed(1)}`).join('')
  const tip = (html: React.ReactNode) => (ev: React.MouseEvent) => setTip({ x: ev.clientX, y: ev.clientY, html })
  return (
    <>
      <svg className="ado-mix" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="주별 전체 매출·광고 매출 꺾은선">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={y(max * f).toFixed(1)} y2={y(max * f).toFixed(1)} className="ado-grid" />
            <text x={padL - 8} y={(y(max * f) + 4).toFixed(1)} textAnchor="end" className="ado-axl">{((max * f) / 1e6).toFixed(1)}백만</text>
          </g>
        ))}
        <path d={path((r) => r.total)} fill="none" stroke={NAT_C} strokeWidth="2.5" strokeLinejoin="round" />
        <path d={path((r) => r.rev)} fill="none" stroke={AD_C} strokeWidth="2.5" strokeLinejoin="round" />
        {rows.map((r, i) => (
          <g key={r.s}>
            <circle className="ado-seg" cx={xs(i).toFixed(1)} cy={y(r.total).toFixed(1)} r="5" fill="#fff" stroke={NAT_C} strokeWidth="2.5"
              onMouseMove={tip(<>{lab(r)} 전체 매출 {won(r.total)}원</>)} onMouseLeave={() => setTip(null)} />
            <circle className="ado-seg" cx={xs(i).toFixed(1)} cy={y(r.rev).toFixed(1)} r="5" fill="#fff" stroke={AD_C} strokeWidth="2.5"
              onMouseMove={tip(<>{lab(r)} 광고 매출 {won(r.rev)}원 ({Math.round((r.rev / r.total) * 100)}%)</>)} onMouseLeave={() => setTip(null)} />
            <text x={xs(i).toFixed(1)} y={(y(r.rev) - 12).toFixed(1)} textAnchor="middle" className="ado-bpct">{Math.round((r.rev / r.total) * 100)}%</text>
            <text x={xs(i).toFixed(1)} y={h - 12} textAnchor={n > 1 && i === n - 1 ? 'end' : n > 1 && i === 0 ? 'start' : 'middle'} className="ado-axl">{lab(r)}</text>
          </g>
        ))}
      </svg>
      <ul className="ado-dleg row">
        <li><i style={{ background: NAT_C }} />전체 매출(1P+3P 소비자 판매)</li>
        <li><i style={{ background: AD_C }} />광고 매출(14일 전환, 실판매가) · 점 위 % = 광고 비중</li>
      </ul>
    </>
  )
}

function DonutTile({ weeks, setTip, onOpen }: { weeks: WeekPoint[]; setTip: (t: Tip) => void; onOpen: () => void }) {
  const c = weeks[weeks.length - 1], p = weeks[weeks.length - 2]
  const ok = c?.total != null && c.rev != null
  return (
    <div className={`ado-kpi donut clickable${ok ? '' : ' pending'}`} role="button" tabIndex={0} title="클릭하면 크게" onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      <div className="lb">자연 매출 vs 광고 매출 (이번 주) <span className="ado-zoom" aria-hidden="true">⤢</span></div>
      {ok ? (
        <>
          <div className="ado-donutwrap">
            <Donut ad={c.rev!} total={c.total!} size={96} setTip={setTip} />
            <ul className="ado-dleg">
              <li><i style={{ background: AD_C }} />광고 매출 <b className="num">{won(c.rev!)}</b> · {Math.round((c.rev! / c.total!) * 100)}%</li>
              <li><i style={{ background: NAT_C }} />자연 매출 <b className="num">{won(Math.max(0, c.total! - c.rev!))}</b> · {100 - Math.round((c.rev! / c.total!) * 100)}%</li>
              {p?.total != null && p.rev != null && (
                <li className="muted">지난주 광고 비중 {Math.round((p.rev / p.total) * 100)}% → {Math.round((c.rev! / c.total!) * 100)}%</li>
              )}
            </ul>
          </div>
          <div className="note line1" title="자연 매출 = 전체 매출 − 광고 매출(14일 전환, 실판매가 기준)이라 대략치">자연 매출 = 전체 매출 − 광고 매출(14일 전환, 실판매가 기준)이라 대략치</div>
        </>
      ) : (
        <div className="note" style={{ marginTop: 8 }}>이번 주 전체 매출(1P+3P) 입력 필요 — 아래 &lsquo;전체 매출 입력&rsquo;</div>
      )}
    </div>
  )
}

/** '**굵게**' → <b> (브레인 코멘트 항목) */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((s, i) => (s.startsWith('**') && s.endsWith('**') ? <b key={i}>{s.slice(2, -2)}</b> : <React.Fragment key={i}>{s}</React.Fragment>))}</>
}

function SalesInput({ defaultWeek, onSaved }: { defaultWeek: string; onSaved: (rows: SalesRow[]) => void }) {
  const [open, setOpen] = useState(false)
  const [s, setS] = useState(defaultWeek)
  const [p1, setP1] = useState('')
  const [p3, setP3] = useState('')
  const [msg, setMsg] = useState('')
  const save = async () => {
    setMsg('')
    const res = await fetch('/api/coupang-ad-overview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sales', s, sales1p: Number(p1.replace(/,/g, '')), sales3p: Number(p3.replace(/,/g, '')) }),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j?.ok) { setMsg(`저장 실패: ${j?.error || res.status}`); return }
    onSaved(j.sales as SalesRow[])
    setMsg('저장됨')
  }
  return (
    <div className="ado-sales">
      <button type="button" className="ado-link" onClick={() => setOpen((v) => !v)}>전체 매출 입력 {open ? '▴' : '▾'}</button>
      {open && (
        <div className="ado-salesform">
          <label>주 시작일(월) <input type="date" value={s} onChange={(e) => setS(e.target.value)} /></label>
          <label>1P 소비자 판매 <input inputMode="numeric" value={p1} onChange={(e) => setP1(e.target.value)} placeholder="서플라이어허브 판매 분석" /></label>
          <label>3P 소비자 판매 <input inputMode="numeric" value={p3} onChange={(e) => setP3(e.target.value)} placeholder="윙 판매 분석" /></label>
          <button type="button" className="ado-btn primary" onClick={save} disabled={!s || !p1 || !p3}>저장</button>
          {msg && <span className="muted small">{msg}</span>}
        </div>
      )}
    </div>
  )
}

export function WeeklyOverview({
  weeks, comment, isAdmin, onSalesSaved, children,
}: {
  weeks: WeekPoint[]
  comment: WeeklyComment | null
  isAdmin: boolean
  onSalesSaved: (rows: SalesRow[]) => void
  /** 이번 주 성과 아래에 붙는 블록 (지난주 성과 칩·할 일·전체 캠페인 표 — 같은 아이보리 판 안) */
  children?: React.ReactNode
}) {
  const [tip, setTip] = useState<Tip>(null)
  const [open, setOpen] = useState<Key | 'mix' | null>(null)
  const cur = weeks[weeks.length - 1]
  const prev = weeks[weeks.length - 2]
  const auto = useMemo(() => headlineAuto(cur, prev), [cur, prev])
  if (!cur) return null
  // 각주(note)는 1줄 — 전체 문장(noteFull)은 확대 팝업 하단 출처 줄에
  const tiles: TileDef[] = [
    { key: 'cost', label: '광고비 (VAT 포함)', unit: '원', vclass: 'blue' },
    { key: 'rev', label: '광고 매출 (14일 전환, 실판매가 기준)', unit: '원' },
    { key: 'total', label: '전체 매출 (1P+3P 소비자 판매)', unit: '원', note: '1P 허브 + 3P 윙 판매 분석', noteFull: `1P 서플라이어허브 판매 분석(로켓배송) + 3P 윙 판매 분석(판매자배송+그로스)${cur.adRevShare != null ? ` · 광고 매출 비중 ${Math.round(cur.adRevShare)}%` : ''}`, pendingNote: '이번 주 값 입력 필요 — 아래 ‘전체 매출 입력’' },
    { key: 'profit', label: '광고 손익', unit: '원', hero: true, vclass: 'sign' },
    { key: 'adShare', label: '광고비 비중 (광고비 ÷ 전체 매출)', unit: '%', hero: true, vclass: 'amber', refKey: 'target', note: '점선 = 12월 목표 15%', noteFull: '수익 개선 KPI · 점선 = 12월 목표 15%', pendingNote: '전체 매출 입력 후 계산 · 점선 = 12월 목표 15%' },
    { key: 'roas', label: 'ROAS (참고)', unit: '%', refKey: 'bep', note: `점선 = BEP${cur.bep != null ? ` ${Math.round(cur.bep)}%` : ''} (분모 VAT 제외)`, noteFull: `실선 ROAS · 점선 BEP(주별)${cur.bep != null ? ` · BEP ${Math.round(cur.bep)}%` : ''} · ROAS·BEP 분모는 광고비 VAT 제외(광고센터 방식)` },
  ]
  const openTile = tiles.find((t) => t.key === open)
  const srcInfo = sourceText(weeks)
  return (
    <div className="ado">
      <style>{CSS}</style>
      {/* ① 브레인 코멘트 */}
      <section className="ado-card" aria-labelledby="ado-h-cmt">
        <h2 id="ado-h-cmt">브레인 코멘트 <span className="sub">
          {comment ? `${comment.writtenAt ? new Date(new Date(comment.writtenAt).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''}${comment.baseFile ? ` · 기준 파일 ${comment.baseFile}` : ''} · 숫자는 아래 표에서만 인용` : `주간 ${md(cur.s)}~${md(cur.e)}`}
        </span></h2>
        {comment ? (
          <>
            <p className="ado-headline">
              💬 <b>한 줄 평</b> — {auto ? auto.map((s, i) => (s.tone ? <b key={i} className={s.tone}>{s.t}</b> : <React.Fragment key={i}>{s.t}</React.Fragment>)) : '—'}
              <span className="who">← 숫자 자동</span><br />
              <Rich text={comment.headline} /> <span className="who">← 브레인 판단</span>
            </p>
            <ol className="ado-cmt">{comment.items.slice(0, 4).map((t, i) => <li key={i}><Rich text={t} /></li>)}</ol>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>이번 주 코멘트 아직 없음</p>
        )}
      </section>

      {/* ② 이번 주 성과 */}
      <section className="ado-card" aria-labelledby="ado-h-kpi">
        <h2 id="ado-h-kpi">이번 주 성과 <span className="sub">
          주간 {md(cur.s)}~{md(cur.e)} · 최근 13주 꺾은선 · 큰 점 = 이번 주
          {/* 출처·범위 설명은 ⓘ 말풍선으로 (부제 한 줄 유지) */}
          <button
            type="button" className="ado-info" aria-label={`출처: ${srcInfo}`} title={srcInfo}
            onMouseMove={(ev) => setTip({ x: ev.clientX, y: ev.clientY, html: <>{srcInfo}</> })}
            onMouseLeave={() => setTip(null)}
            onFocus={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); setTip({ x: r.left, y: r.bottom, html: <>{srcInfo}</> }) }}
            onBlur={() => setTip(null)}
            onClick={(ev) => ev.stopPropagation()}
          >ⓘ</button>
        </span>
          {SHOW_CHANNEL_TOGGLE && (
            <span className="ado-toggle" role="group" aria-label="채널">
              <button className="ado-chip" aria-pressed="true" type="button">전체</button>
              <button className="ado-chip" type="button" disabled title="채널별 주간 자료 준비 중">1P</button>
              <button className="ado-chip" type="button" disabled title="채널별 주간 자료 준비 중">3P</button>
            </span>
          )}
        </h2>
        <div className="ado-kpis">
          {tiles.map((d) => <Tile key={d.key} d={d} weeks={weeks} setTip={setTip} onOpen={() => setOpen(d.key)} />)}
          <DonutTile weeks={weeks} setTip={setTip} onOpen={() => setOpen('mix')} />
        </div>
        {isAdmin && <SalesInput defaultWeek={cur.s} onSaved={onSalesSaved} />}
      </section>
      {children}

      {openTile &&<TileModal d={openTile} weeks={weeks} setTip={setTip} onClose={() => { setOpen(null); setTip(null) }} />}
      {open === 'mix' && (
        <Modal title="자연 매출 vs 광고 매출 — 주별 흐름" onClose={() => { setOpen(null); setTip(null) }}>
          {weeks.some((w) => w.total != null) ? (
            <>
              <MixLines weeks={weeks} setTip={setTip} />
              <table className="ado-ltab">
                <thead><tr><th>주(월~일)</th><th className="r">전체 매출</th><th className="r">광고 매출</th><th className="r">자연 매출</th><th className="r">광고 비중</th></tr></thead>
                <tbody>
                  {weeks.filter((w) => w.total != null && w.rev != null).map((w) => (
                    <tr key={w.s}><td>{md(w.s)}~{md(w.e)}</td><td className="r num">{won(w.total!)}</td><td className="r num">{won(w.rev!)}</td><td className="r num">{won(w.total! - w.rev!)}</td><td className="r num"><b>{Math.round((w.rev! / w.total!) * 100)}%</b></td></tr>
                  ))}
                </tbody>
              </table>
              <div className="note">광고 매출은 14일 전환·실판매가 기준, 전체 매출은 쿠팡 판매가 기준이라 자연 매출은 대략치</div>
            </>
          ) : <p className="muted">전체 매출 자료 없음 — &lsquo;전체 매출 입력&rsquo;으로 주별 1P·3P 값을 넣으면 보임</p>}
        </Modal>
      )}
      {tip && <div className="ado-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>{tip.html}</div>}
    </div>
  )
}

// 시안 v5 CSS 토큰 (아이보리·흰 카드·#e9e5dc 테두리·Pretendard·둥글기 16·hero 크림) — .ado 안에만
const CSS = `
.ado{--ado-bg:#f6f4ef;--ado-card:#FFFFFF;--ado-fg:#111827;--ado-muted:#f1efe9;--ado-muted-fg:#6b7280;--ado-border:#e9e5dc;--ado-primary:#1E40AF;--ado-accent:#B45309;--ado-accent-soft:#D97706;--ado-danger:#DC2626;--ado-ok:#15803D;--ado-ring:#1E40AF;
  background:var(--ado-bg);color:var(--ado-fg);font:14px/1.5 Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",Roboto,sans-serif;padding:16px;border-radius:16px;margin:8px auto 16px;max-width:1280px}
.ado .muted{color:var(--ado-muted-fg)}.ado .small{font-size:12px}.ado .num{font-variant-numeric:tabular-nums;white-space:nowrap}
.ado-card{background:var(--ado-card);border:1px solid var(--ado-border);border-radius:16px;padding:24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(17,24,39,.04),0 1px 1px rgba(17,24,39,.03)}
.ado-card:last-of-type{margin-bottom:0}
.ado-card h2{font-size:16px;font-weight:800;letter-spacing:-.01em;margin:0 0 12px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.ado-card h2 .sub{font-weight:400;color:var(--ado-muted-fg);font-size:12px}
.ado-headline{margin:0 0 12px;padding:12px 16px;border-radius:10px;background:#fff8ea;border:1px solid #f0dcb4;border-left:4px solid var(--ado-accent-soft);font-size:16px;line-height:1.6;color:#1f2937}
.ado-headline b{font-weight:800}.ado-headline b.up{color:var(--ado-ok)}.ado-headline b.down{color:var(--ado-danger)}.ado-headline .who{font-size:11px;color:var(--ado-muted-fg);margin-left:6px}
ol.ado-cmt{list-style:decimal;margin:0;padding:8px 12px 8px 28px;border-left:3px solid var(--ado-primary);background:color-mix(in srgb,var(--ado-primary) 7%,var(--ado-card));border-radius:0 16px 16px 0}
ol.ado-cmt li{margin:4px 0;font-size:15px}ol.ado-cmt li b{font-weight:800}
.ado-toggle{margin-left:auto;display:inline-flex;gap:4px}
.ado-chip{border:1px solid var(--ado-border);border-radius:999px;padding:2px 10px;font-size:12px;background:var(--ado-card);color:var(--ado-fg);cursor:pointer}
.ado-chip[aria-pressed=true]{background:var(--ado-muted);border-color:var(--ado-primary)}.ado-chip:disabled{opacity:.45;cursor:not-allowed}
.ado-info{border:0;background:none;color:var(--ado-muted-fg);cursor:help;font-size:13px;line-height:1;padding:0 2px;margin-left:4px;vertical-align:-1px}
.ado-info:hover,.ado-info:focus-visible{color:var(--ado-primary);outline:none}
/* 타일 격자: 4열 고정 (1줄 광고비·광고 매출·전체 매출·손익 / 2줄 비중·ROAS·도넛 2칸). 화면이 넓어도 4개 넘지 않음 */
.ado-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.ado-kpi.donut{grid-column:span 2}
.ado-kpi{border:1px solid var(--ado-border);border-radius:10px;padding:16px;background:var(--ado-card);min-width:0}
.ado-kpi.hero{background:linear-gradient(180deg,#fffdf8,#fff);border-color:#ead9b8}.ado-kpi.hero .lb{color:#92400e;font-weight:700}.ado-kpi.hero .v{font-size:32px}
.ado-kpi.pending{border-style:dashed}
.ado-kpi .lb{font-size:12px;color:var(--ado-muted-fg);font-weight:600;letter-spacing:.01em}
.ado-kpi .v{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.15;margin:4px 0;font-variant-numeric:tabular-nums}
.ado-kpi .v.neg{color:var(--ado-danger)}.ado-kpi .v.pos{color:var(--ado-ok)}.ado-kpi .v.amber{color:#B45309}.ado-kpi .v.blue{color:var(--ado-primary)}
.ado-kpi .d{font-size:12px;color:var(--ado-muted-fg)}.ado-kpi .d b{font-weight:600;font-size:13px}
.ado-kpi .note{font-size:11px;color:var(--ado-muted-fg);margin-top:4px}
.ado-kpi .note.line1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ado .up{color:var(--ado-ok)}.ado .down{color:var(--ado-danger)}
.ado-kpi.clickable{cursor:pointer;transition:box-shadow .2s,transform .2s}.ado-kpi.clickable:hover{box-shadow:0 4px 14px rgba(17,24,39,.08);transform:translateY(-1px)}
.ado-kpi.clickable:focus-visible{outline:2px solid var(--ado-ring);outline-offset:2px}
.ado-zoom{float:right;color:var(--ado-muted-fg);font-size:12px}
.ado-ph{height:72px;display:flex;align-items:center;justify-content:center;color:var(--ado-muted-fg);font-size:11px;background:var(--ado-muted);border-radius:8px;margin-top:6px}
.ado-spark{display:block;margin-top:6px;overflow:visible}
.ado-spark .ado-ln{fill:none;stroke:var(--ado-primary);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.ado-spark .ado-ref{fill:none;stroke:var(--ado-accent);stroke-width:1.5;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.ado-spark .ado-dot{fill:var(--ado-card);stroke:var(--ado-primary);stroke-width:2;vector-effect:non-scaling-stroke}
.ado-spark .ado-dot.cur{fill:var(--ado-primary)}.ado-spark .ado-dot.hot{stroke:var(--ado-accent-soft);stroke-width:3}
.ado-spark .ado-axl{font-size:9px;fill:var(--ado-muted-fg)}.ado-spark .ado-zero{stroke:var(--ado-muted-fg);stroke-dasharray:3 3}
.ado-spark.big{width:100%;height:auto;margin:12px 0}.ado-spark.big .ado-axl{font-size:11px}
.ado-spark.big .ado-ln{stroke-width:2.5}.ado-spark .ado-grid,.ado-mix .ado-grid{stroke:var(--ado-border);stroke-width:1}
.ado-spark.big .ado-vlab{font-size:11px;fill:var(--ado-muted-fg);font-variant-numeric:tabular-nums}.ado-spark.big .ado-vlab.cur{font-size:13px;font-weight:800;fill:var(--ado-fg)}
.ado-spark.big .ado-rlab{font-size:9.5px;fill:var(--ado-accent);font-variant-numeric:tabular-nums}
.ado-legend{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ado-muted-fg);margin:8px 0 0}
.ado-legend .ln{display:inline-block;width:18px;border-top:2.5px solid var(--ado-primary)}.ado-legend .ref{display:inline-block;width:18px;border-top:2px dashed var(--ado-accent);margin-right:2px}
.ado-donutwrap{display:flex;gap:12px;align-items:center;margin-top:6px}
.ado-dnum{font-size:18px;font-weight:700;fill:var(--ado-fg);font-variant-numeric:tabular-nums}.ado-dlab{font-size:9px;fill:var(--ado-muted-fg)}
.ado-dleg{list-style:none;margin:0;padding:0;font-size:12px;line-height:1.7}.ado-dleg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.ado-dleg .muted{font-size:11px}.ado-dleg.row{display:flex;flex-wrap:wrap;gap:16px;line-height:1.5}
.ado-seg{cursor:pointer}.ado-seg:hover{stroke-opacity:.8}
.ado-mix{display:block;margin:12px 0 8px}.ado-mix .ado-axl{font-size:11px;fill:var(--ado-muted-fg)}.ado-mix .ado-bpct{font-weight:800;font-size:14px;fill:var(--ado-fg)}
.ado-tip{position:fixed;z-index:60;background:#111827;color:#fff;font-size:12px;line-height:1.5;padding:6px 9px;border-radius:6px;pointer-events:none;max-width:260px;box-shadow:0 4px 12px rgba(0,0,0,.2)}
.ado-tip .ado-tipmuted{color:#cbd5e1}
.ado-modal{position:fixed;inset:0;z-index:50;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;padding:16px;animation:adoFade .18s ease-out}
.ado-mbox{background:var(--ado-card);border-radius:16px;padding:24px;width:min(900px,100%);max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,.25);animation:adoPop .22s cubic-bezier(.2,.8,.2,1);font:14px/1.5 Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:var(--ado-fg)}
.ado-mhead{display:flex;justify-content:space-between;align-items:center;gap:12px}.ado-mhead h3{margin:0;font-size:18px;font-weight:800}
.ado-mclose{border:1px solid var(--ado-border);background:var(--ado-card);border-radius:999px;width:34px;height:34px;cursor:pointer;font-size:14px}
.ado-ltab{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}.ado-ltab th{text-align:left;font-weight:600;color:var(--ado-muted-fg);font-size:12px;padding:6px 8px;border-bottom:1px solid var(--ado-border)}
.ado-ltab td{padding:7px 8px;border-bottom:1px solid var(--ado-border);vertical-align:top}.ado-ltab .r{text-align:right}
.ado-mbox .note{font-size:11px;color:var(--ado-muted-fg);margin-top:8px}
.ado-sales{margin-top:10px;font-size:12px}.ado-link{background:none;border:0;color:var(--ado-primary);cursor:pointer;padding:0;font-size:12px}
.ado-salesform{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-top:6px}.ado-salesform label{display:flex;gap:6px;align-items:center;color:var(--ado-muted-fg)}
.ado-salesform input{border:1px solid var(--ado-border);border-radius:8px;padding:4px 8px;font-size:12px;width:140px;background:#fff}
.ado-btn{display:inline-flex;align-items:center;min-height:30px;border:1px solid var(--ado-border);border-radius:8px;padding:0 12px;font-size:12px;background:var(--ado-card);cursor:pointer}
.ado-btn.primary{background:var(--ado-primary);color:#fff;border-color:var(--ado-primary)}.ado-btn:disabled{opacity:.5;cursor:not-allowed}
@keyframes adoFade{from{opacity:0}to{opacity:1}}@keyframes adoPop{from{transform:scale(.96);opacity:0}to{transform:scale(1);opacity:1}}
@media (prefers-reduced-motion:reduce){.ado-modal,.ado-mbox,.ado-kpi.clickable{animation:none;transition:none}}
@media (max-width:1023px){.ado-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.ado{padding:8px}.ado-card{padding:16px}.ado-kpis{grid-template-columns:minmax(0,1fr)}.ado-kpi.donut{grid-column:auto}.ado-kpi .v{font-size:22px}.ado-kpi.hero .v{font-size:26px}.ado-toggle{margin-left:0}}
`
