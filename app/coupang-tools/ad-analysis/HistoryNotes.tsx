'use client'

/**
 * 광고 분석 — 운영 메모 (영구 저장, coupang_ad_history_notes). page.tsx 에서 분리 (2026-10-19 보수 ②)
 * 종류: 반영 완료(reflect, 할 일 버튼이 자동 기록) / OFF(off — 판정에서 캠페인 제외) / 1P 이동(move1p) / 메모(note)
 * OFF 는 종류로만 판정한다. 종류 없는 옛 자유 메모는 글자(OFF_RE) 폴백.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useConfirm } from '@/components/ui/useConfirm'
import { NOTE_KINDS, NOTE_KIND_LABEL, type NoteKind } from '@/lib/coupang/weeklyJudge'

type HistoryNote = { id: string; ts: string; text: string; kind?: string; reason?: string; campaignName?: string }

function fmtNoteTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function HistoryNotesSection({ reloadKey = 0 }: { reloadKey?: number }) {
  const { confirm, confirmModal } = useConfirm()
  const [items, setItems] = useState<HistoryNote[]>([])
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<NoteKind>('note')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/coupang-ad-history')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const list = Array.isArray(j?.items) ? (j.items as HistoryNote[]) : []
        setItems(list)
      })
      .catch(() => { if (!cancelled) setItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadKey])

  const sorted = useMemo(
    () => [...items].sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    [items],
  )

  async function add() {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/coupang-ad-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 종류(kind)·이유(reason) — OFF 는 종류로만 판정. 글 앞에 캠페인 이름을 그대로 쓰면 그 캠페인 메모로 잡힘
        body: JSON.stringify({ text: t, kind: kind === 'note' ? undefined : kind, reason: reason.trim() || undefined }),
      })
      const j = await res.json()
      if (j?.item) {
        setItems((prev) => [...prev, j.item as HistoryNote])
        setText('')
        setReason('')
        setKind('note')
      } else {
        alert(`저장 실패: ${j?.error ?? '알 수 없는 오류'}`)
      }
    } catch (e) {
      alert(`저장 실패: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ message: '이 메모를 삭제할까요?' }))) return
    setBusy(true)
    try {
      const res = await fetch(`/api/coupang-ad-history?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const j = await res.json()
      if (j?.ok) {
        setItems((prev) => prev.filter((it) => it.id !== id))
      } else {
        alert(`삭제 실패: ${j?.error ?? '알 수 없는 오류'}`)
      }
    } catch (e) {
      alert(`삭제 실패: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="aa-sub-section" style={{ marginTop: 16 }}>
      {confirmModal}
      <div className="aa-sub-section-title" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <span>📝 운영 메모 ({loading ? '…' : `${sorted.length}건`})</span>
        <span style={{ fontSize: 12, color: '#64748B' }}>{open ? '▾ 접기' : '▸ 펼치기'}</span>
      </div>
      {open && (
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as NoteKind)}
              disabled={busy}
              aria-label="메모 종류"
              title="OFF 는 종류로만 판정 — 글자에 'OFF'를 써도 종류가 '메모'면 캠페인이 빠지지 않음"
              style={{ padding: '8px 8px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', background: '#fff' }}
            >
              {NOTE_KINDS.map((k) => <option key={k} value={k}>{NOTE_KIND_LABEL[k]}</option>)}
            </select>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }}
              placeholder={kind === 'off' ? '캠페인 이름 그대로 (예: [보배마을]_흑보리_AI_415/325/349/458)' : kind === 'move1p' ? '캠페인 이름 · 1P 이동' : '예: 5.5일 제외 키워드 셋팅'}
              disabled={busy}
              style={{ flex: '2 1 260px', padding: '8px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
            />
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }}
              placeholder="이유 한 줄 (선택)"
              disabled={busy}
              style={{ flex: '1 1 160px', padding: '8px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
            />
            <button
              className="aa-btn btn-sm"
              onClick={add}
              disabled={busy || !text.trim()}
              style={{ opacity: busy || !text.trim() ? 0.5 : 1 }}
            >
              추가
            </button>
          </div>
          {sorted.length === 0 ? (
            <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 4px' }}>
              {loading ? '불러오는 중…' : '등록된 메모가 없습니다.'}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sorted.map((it) => (
                <li
                  key={it.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '6px 8px',
                    borderBottom: '1px solid #F1F5F9',
                    fontSize: 13,
                  }}
                >
                  <span className="mono" style={{ color: '#64748B', fontSize: 11, minWidth: 110, paddingTop: 2 }}>
                    {fmtNoteTs(it.ts)}
                  </span>
                  <span style={{ flex: 1, whiteSpace: 'pre-wrap', color: '#1F2937' }}>
                    {it.kind && (
                      <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px', marginRight: 6, verticalAlign: 'middle',
                        background: it.kind === 'off' ? '#F3F4F6' : it.kind === 'reflect' ? '#ECFDF5' : '#EFF6FF', color: it.kind === 'off' ? '#374151' : it.kind === 'reflect' ? '#059669' : '#1D4ED8' }}>
                        {NOTE_KIND_LABEL[it.kind as NoteKind] ?? it.kind}
                      </span>
                    )}
                    {it.text}
                    {it.reason && <span style={{ color: '#64748B', fontSize: 12 }}> — {it.reason}</span>}
                  </span>
                  <button
                    onClick={() => remove(it.id)}
                    disabled={busy}
                    title="삭제"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#94A3B8',
                      cursor: 'pointer',
                      fontSize: 14,
                      padding: '0 4px',
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

