'use client'

/**
 * 광고 분석 — 주 1회 "이번 주에 바꿀 것" 화면 조각.
 * 판정은 lib/coupang/weeklyActions.ts (기존 BEP ROAS·추천 입찰가·광고 손익 재사용), 여기는 표시·복사·반영 버튼만.
 */

import React, { useMemo, useState } from 'react'
import type { AdAnalysisView, CampaignDiag } from '@/lib/coupang/adAnalysis'
import {
  campaignStatusOf,
  type CampaignActions,
  type CampaignStatus,
} from '@/lib/coupang/weeklyActions'

const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`
const man = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}만` : Math.round(n).toLocaleString('ko-KR'))
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`)
const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8 }

function ChBadge({ ch }: { ch: '3P' | '1P' }) {
  const s: React.CSSProperties = ch === '1P'
    ? { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #C4B5FD' }
    : { background: '#E0F2FE', color: '#075985', border: '1px solid #7DD3FC' }
  return <span style={{ ...s, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>{ch}</span>
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ── 2) 경고 1줄 ─────────────────────────────────────────────
export function WarningLine({
  unlinked1P,
  unmatched,
  noBep,
}: {
  unlinked1P: { optionId: string; name: string; adCostVat: number }[]
  unmatched: { optionId: string; name: string; adCostVat: number }[]
  noBep: CampaignDiag[]
}) {
  const [open, setOpen] = useState(false)
  const cost = [...unlinked1P, ...unmatched].reduce((s, x) => s + x.adCostVat, 0)
  if (!unlinked1P.length && !unmatched.length && !noBep.length) return null
  const parts = [
    unlinked1P.length ? `1P 미연결 ${unlinked1P.length}개` : '',
    unmatched.length ? `마스터 미등록 ${unmatched.length}개 옵션` : '',
    noBep.length ? `BEP ROAS 없는 캠페인 ${noBep.length}개` : '',
  ].filter(Boolean)
  return (
    <div style={{ margin: '8px 0', borderRadius: 6, border: '1px solid #FED7AA', background: '#FFF7ED', fontSize: 12.5, color: '#92400E' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ width: '100%', textAlign: 'left', padding: '8px 12px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}
      >
        ⚠ {parts.join(' · ')}{cost > 0 ? ` (광고비 ${won(cost)})` : ''} <span style={{ color: '#B45309' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 12px 10px', display: 'grid', gap: 6 }}>
          {unlinked1P.length > 0 && (
            <div><b>1P 미연결</b> — {unlinked1P.map((u) => `${u.name || u.optionId} (${won(u.adCostVat)})`).join(' · ')}</div>
          )}
          {unmatched.length > 0 && (
            <div><b>마스터 미등록</b> — {unmatched.map((u) => `${u.name || u.optionId} [${u.optionId}] (${won(u.adCostVat)})`).join(' · ')}</div>
          )}
          {noBep.length > 0 && (
            <div><b>BEP ROAS 없는 캠페인</b> (상태 3칸 제외) — {noBep.map((c) => c.campaignName).join(' · ')}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 3) 30일 손익 1줄 ─────────────────────────────────────────
export function ProfitLine({ view, days }: { view: AdAnalysisView; days: number | null }) {
  const profit = view.campaigns.reduce((s, c) => s + c.adProfit, 0)
  const under = view.avgRoasPct != null && view.avgBepPct != null && view.avgRoasPct < view.avgBepPct
  return (
    <div style={{ ...card, margin: '8px 0', padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'baseline', fontSize: 13 }}>
      <b style={{ color: '#475569' }}>{days ? `${days}일` : '기간'} 손익</b>
      <span>광고비(VAT 포함) <b>{won(view.totalAdCostVat)}</b></span>
      <span>광고 매출 <b>{won(view.totalRevenue)}</b></span>
      <span>
        ROAS <b style={{ color: under ? '#DC2626' : '#059669' }}>{pct(view.avgRoasPct)}</b> / BEP ROAS <b>{pct(view.avgBepPct)}</b>
      </span>
      <span>
        광고 손익 <b style={{ color: profit < 0 ? '#DC2626' : '#059669', fontSize: 15 }}>{won(profit)}</b>
      </span>
    </div>
  )
}

// ── 5) 캠페인 상태 3칸 ───────────────────────────────────────
const STATUS_META: Record<CampaignStatus, { title: string; color: string; bg: string; rule: string }> = {
  profit: { title: '흑자', color: '#059669', bg: '#ECFDF5', rule: 'ROAS ≥ BEP ROAS × 1.2' },
  even: { title: '본전', color: '#D97706', bg: '#FFFBEB', rule: 'BEP ROAS × 0.9 ~ 1.2' },
  loss: { title: '적자', color: '#DC2626', bg: '#FEF2F2', rule: 'ROAS < BEP ROAS × 0.9' },
}
const STATUS_LIMIT = 5

export function StatusBoxes({ campaigns, onPick }: { campaigns: CampaignDiag[]; onPick: (campaignId: string) => void }) {
  const groups = useMemo(() => {
    const g: Record<CampaignStatus, CampaignDiag[]> = { profit: [], even: [], loss: [] }
    for (const c of campaigns) {
      const s = campaignStatusOf(c)
      if (s) g[s].push(c)
    }
    g.profit.sort((a, b) => b.adProfit - a.adProfit)
    g.even.sort((a, b) => b.adProfit - a.adProfit)
    g.loss.sort((a, b) => a.adProfit - b.adProfit) // 손실 큰 순
    return g
  }, [campaigns])
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, margin: '12px 0' }}>
      {(['profit', 'even', 'loss'] as CampaignStatus[]).map((k) => (
        <StatusBox key={k} kind={k} list={groups[k]} onPick={onPick} />
      ))}
    </div>
  )
}

function StatusBox({ kind, list, onPick }: { kind: CampaignStatus; list: CampaignDiag[]; onPick: (id: string) => void }) {
  const [more, setMore] = useState(false)
  const m = STATUS_META[kind]
  const shown = more ? list : list.slice(0, STATUS_LIMIT)
  return (
    <div style={{ ...card, borderTop: `3px solid ${m.color}`, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <b style={{ color: m.color, fontSize: 15 }}>{m.title}</b>
        <b style={{ color: m.color, fontSize: 18 }}>{list.length}</b>
        <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 'auto' }}>{m.rule}</span>
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94A3B8' }}>없음</div>
      ) : (
        <div style={{ display: 'grid', gap: 3 }}>
          {shown.map((c) => (
            <button
              key={c.campaignId}
              onClick={() => onPick(c.campaignId)}
              title="전체 캠페인 표에서 보기"
              style={{ display: 'flex', gap: 6, alignItems: 'baseline', textAlign: 'left', padding: '3px 6px', borderRadius: 4, border: 'none', background: m.bg, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1F2937' }}>
                {c.campaignName}
              </span>
              <span className="mono" style={{ color: '#475569', whiteSpace: 'nowrap' }}>{pct(c.roasPct)} / {pct(c.bepPct)}</span>
              <span className="mono" style={{ color: c.adProfit < 0 ? '#DC2626' : '#059669', fontWeight: 700, whiteSpace: 'nowrap' }}>
                {Math.round(c.adProfit).toLocaleString('ko-KR')}
              </span>
            </button>
          ))}
          {list.length > STATUS_LIMIT && (
            <button onClick={() => setMore((v) => !v)} style={{ border: 'none', background: 'transparent', color: '#64748B', fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: '2px 6px' }}>
              {more ? '접기' : `더보기 (${list.length - STATUS_LIMIT}개)`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 6) 요약 카드 4개 + 7) 캠페인별 할 일 ─────────────────────
type Kind = 'bep' | 'move' | 'bid' | 'del'
const KIND_META: Record<Kind, { title: string; color: string }> = {
  bep: { title: 'BEP ROAS 바뀐 AI 캠페인', color: '#2563EB' },
  move: { title: 'AI → 수동 이동', color: '#7C3AED' },
  bid: { title: '수동 입찰가 수정', color: '#D97706' },
  del: { title: '키워드 삭제', color: '#DC2626' },
}
const hasKind = (a: CampaignActions, k: Kind) =>
  k === 'bep' ? !!a.bepChange : k === 'move' ? a.move.length > 0 : k === 'bid' ? a.bidUp.length + a.bidDown.length > 0 : a.del.length > 0

/** 운영 메모 자동 기록 문구 — 캠페인명 + 반영한 할 일 요약 */
export function reflectMemoText(a: CampaignActions): string {
  const parts = [
    a.bepChange ? `BEP ROAS ${a.bepChange.applied != null ? `${a.bepChange.applied}` : '미입력'}→${a.bepChange.next}%` : '',
    a.move.length ? `수동 이동 ${a.move.length}개` : '',
    a.bidUp.length ? `입찰가 ↑${a.bidUp.length}개` : '',
    a.bidDown.length ? `입찰가 ↓${a.bidDown.length}개` : '',
    a.del.length ? `${a.isAi ? '제외' : '삭제'} ${a.del.length}개` : '',
  ].filter(Boolean)
  return `${a.campaign.campaignName} · ${parts.join(', ')}`
}

export function WeeklyActionsSection({
  actions,
  reflected,
  onReflect,
  onSetApplied,
}: {
  actions: CampaignActions[]
  reflected: Set<string>
  onReflect: (a: CampaignActions) => Promise<void>
  onSetApplied: (key: string, value: number | null) => void
}) {
  const [kind, setKind] = useState<Kind | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const totals = useMemo(() => {
    const del = actions.flatMap((a) => a.del)
    return {
      bep: actions.filter((a) => a.bepChange).length,
      move: actions.reduce((s, a) => s + a.move.length, 0),
      bid: actions.reduce((s, a) => s + a.bidUp.length + a.bidDown.length, 0),
      del: del.length,
      delCost: del.reduce((s, d) => s + d.adCostVat, 0),
    }
  }, [actions])
  const shown = kind ? actions.filter((a) => hasKind(a, kind)) : actions
  const isOpen = (id: string) => (kind ? true : open.has(id))
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, margin: '12px 0' }}>
        {(['bep', 'move', 'bid', 'del'] as Kind[]).map((k) => {
          const m = KIND_META[k]
          const active = kind === k
          const n = totals[k]
          return (
            <button
              key={k}
              onClick={() => setKind((v) => (v === k ? null : k))}
              style={{
                ...card, textAlign: 'left', padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit',
                borderLeft: `4px solid ${m.color}`, boxShadow: active ? `0 0 0 2px ${m.color}55` : 'none',
              }}
            >
              <div style={{ fontSize: 12, color: '#64748B' }}>{m.title}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: n ? m.color : '#94A3B8' }}>
                {n}{k === 'bep' ? '개' : '건'}
              </div>
              {k === 'del' && n > 0 && <div style={{ fontSize: 11, color: '#94A3B8' }}>광고비 {won(totals.delCost)}</div>}
              {active && <div style={{ fontSize: 11, color: m.color }}>▲ 이 할 일만 보는 중 · 다시 누르면 전체</div>}
            </button>
          )
        })}
      </div>

      <div className="aa-section">
        <div className="aa-section-header">
          <div>
            <div className="aa-section-title">이번 주 할 일 {kind ? `— ${KIND_META[kind].title}` : ''}</div>
            <div className="aa-section-desc">
              검색 키워드 · 클릭 20 이상만 판정 · 광고 손익 나쁜 순 · 캠페인 클릭 → 할 일 펼침
            </div>
          </div>
        </div>
        {shown.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: '#94A3B8' }}>이번 주 할 일이 없습니다.</div>
        ) : (
          <div>
            {shown.map((a) => (
              <CampaignActionRow
                key={a.campaign.campaignId}
                a={a}
                kind={kind}
                open={isOpen(a.campaign.campaignId)}
                onToggle={() => toggle(a.campaign.campaignId)}
                done={reflected.has(a.campaign.campaignId)}
                onReflect={() => onReflect(a)}
                onSetApplied={onSetApplied}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function CampaignActionRow({
  a,
  kind,
  open,
  onToggle,
  done,
  onReflect,
  onSetApplied,
}: {
  a: CampaignActions
  kind: Kind | null
  open: boolean
  onToggle: () => void
  done: boolean
  onReflect: () => Promise<void>
  onSetApplied: (key: string, value: number | null) => void
}) {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(false)
  const [editVal, setEditVal] = useState('')
  const c = a.campaign
  const flash = (t: string) => {
    setMsg(t)
    setTimeout(() => setMsg(''), 2500)
  }
  const copy = async (label: string, lines: string[]) => {
    if (!lines.length) return
    flash((await copyText(lines.join('\n'))) ? `✓ ${label} ${lines.length}개 복사됨` : '복사 실패 — 브라우저 권한 확인')
  }
  const show = (k: Kind) => (kind ? kind === k : true) && hasKind(a, k)
  const bids = [...a.bidUp, ...a.bidDown]
  const line: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px dashed #E2E8F0', fontSize: 12.5 }
  const tag = (t: string, color: string) => (
    <span style={{ minWidth: 72, fontWeight: 700, color }}>{t}</span>
  )
  const kwList = (xs: string[]) => (
    <span style={{ flex: 1, minWidth: 200, color: '#334155' }}>{xs.join(', ')}</span>
  )

  return (
    <div style={{ borderTop: '1px solid #E2E8F0' }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', cursor: 'pointer', background: open ? '#F8FAFC' : '#fff' }}
      >
        <span style={{ color: '#94A3B8', width: 12 }}>{open ? '▾' : '▸'}</span>
        <ChBadge ch={c.channel} />
        <b style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{c.campaignName}</b>
        {done && <span style={{ fontSize: 11, fontWeight: 700, color: '#059669', background: '#ECFDF5', borderRadius: 4, padding: '1px 6px' }}>반영됨</span>}
        <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: c.adProfit < 0 ? '#DC2626' : '#059669' }}>
          {Math.round(c.adProfit).toLocaleString('ko-KR')}원
        </span>
        <span style={{ fontSize: 12, color: '#475569', minWidth: 60, textAlign: 'right' }}>할 일 {a.count}건</span>
      </div>
      {open && (
        <div style={{ padding: '2px 14px 10px 34px' }}>
          {show('bep') && a.bepChange && (
            <div style={line}>
              {tag('BEP ROAS', KIND_META.bep.color)}
              <span style={{ flex: 1 }}>
                쿠팡 목표 ROAS{' '}
                <b>{a.bepChange.applied != null ? `${a.bepChange.applied}%` : '미입력'}</b> → <b>{a.bepChange.next}%</b>
                {a.targetKey && !edit && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditVal(a.bepChange?.applied != null ? String(a.bepChange.applied) : '')
                      setEdit(true)
                    }}
                    style={{ marginLeft: 8, border: 'none', background: 'transparent', color: '#64748B', fontSize: 11, textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    수정
                  </button>
                )}
                {a.targetKey && edit && (
                  <span style={{ marginLeft: 8 }}>
                    적용값{' '}
                    <input
                      autoFocus
                      type="number"
                      value={editVal}
                      onChange={(e) => setEditVal(e.target.value)}
                      onBlur={() => {
                        const n = Number(editVal)
                        onSetApplied(a.targetKey!, editVal.trim() === '' ? null : Number.isFinite(n) && n > 0 ? Math.round(n) : null)
                        setEdit(false)
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      style={{ width: 64, padding: '1px 4px', border: '1px solid #CBD5E1', borderRadius: 4, fontSize: 12 }}
                    />
                    %
                  </span>
                )}
              </span>
            </div>
          )}
          {show('move') && (
            <div style={line}>
              {tag('수동으로', KIND_META.move.color)}
              {kwList(a.move.map((m) => `${m.keyword}${m.bid != null ? ` (${m.bid.toLocaleString('ko-KR')}원)` : ''}${m.dup ? ' *수동에 있음' : ''}`))}
              <button className="aa-btn btn-sm" onClick={() => copy('AI 제외 키워드', a.move.map((m) => m.keyword))}>AI 제외 키워드 복사</button>
              <button
                className="aa-btn btn-sm"
                onClick={() => copy('수동 키워드+입찰가', a.move.filter((m) => !m.dup).map((m) => `${m.keyword}\t${m.bid ?? ''}`))}
                disabled={!a.move.some((m) => !m.dup)}
              >
                수동 키워드+입찰가 복사
              </button>
              {a.pairManualName && <span style={{ fontSize: 11, color: '#94A3B8', width: '100%' }}>수동 캠페인: {a.pairManualName}</span>}
            </div>
          )}
          {show('bid') && a.bidUp.length > 0 && (
            <div style={line}>
              {tag('입찰가 ↑', KIND_META.bid.color)}
              {kwList(a.bidUp.map((b) => `${b.keyword} ${b.cur.toLocaleString('ko-KR')}→${b.rec.toLocaleString('ko-KR')}`))}
            </div>
          )}
          {show('bid') && a.bidDown.length > 0 && (
            <div style={line}>
              {tag('입찰가 ↓', KIND_META.bid.color)}
              {kwList(a.bidDown.map((b) => `${b.keyword} ${b.cur.toLocaleString('ko-KR')}→${b.rec.toLocaleString('ko-KR')}`))}
            </div>
          )}
          {show('bid') && bids.length > 0 && (
            <div style={{ ...line, borderTop: 'none', paddingTop: 0 }}>
              <span style={{ minWidth: 72 }} />
              <button className="aa-btn btn-sm" onClick={() => copy('수동 키워드+입찰가', bids.map((b) => `${b.keyword}\t${b.rec}`))}>
                수동 키워드+입찰가 복사
              </button>
            </div>
          )}
          {show('del') && (
            <div style={line}>
              {tag('삭제', KIND_META.del.color)}
              {kwList(
                a.del.map(
                  (d) => `${d.keyword}${d.reason === 'nosale' ? ' (판매 0)' : d.reason === 'dup' ? ' (AI와 중복)' : ` (ROAS ${pct(d.roasPct)})`}`,
                ),
              )}
              <span style={{ fontSize: 11, color: '#94A3B8' }}>광고비 {man(a.del.reduce((s, d) => s + d.adCostVat, 0))}원</span>
              <button className="aa-btn btn-sm" onClick={() => copy(a.isAi ? 'AI 제외 키워드' : '삭제 키워드', a.del.map((d) => d.keyword))}>
                {a.isAi ? 'AI 제외 키워드 복사' : '삭제 키워드 복사'}
              </button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <button
              className="aa-btn btn-sm"
              disabled={busy || done}
              onClick={async () => {
                setBusy(true)
                try {
                  await onReflect()
                  flash('✓ 운영 메모에 기록했습니다')
                } catch (e) {
                  flash('기록 실패: ' + (e instanceof Error ? e.message : String(e)))
                } finally {
                  setBusy(false)
                }
              }}
              style={{ background: done ? '#ECFDF5' : '#1F2937', color: done ? '#059669' : '#fff', borderColor: done ? '#A7F3D0' : '#1F2937' }}
            >
              {done ? '반영됨' : busy ? '기록 중…' : '쿠팡 반영 완료'}
            </button>
            {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? '#059669' : '#DC2626' }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
