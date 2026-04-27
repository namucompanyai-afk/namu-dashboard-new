'use client'

// 임시 디버그 페이지 — 검증 후 삭제 예정.
// 마진 마스터 + SELLER + 광고 엑셀 3개 업로드 → 매칭 누락 옵션ID 리스트.

import { useState } from 'react'

type UnmatchedRow = {
  optionId: string
  revenue: number
  sales: number
  adCost: number
  channel: string | null
  inSeller: boolean
  inAd: boolean
  campaigns: string[]
}

type ApiResult = {
  files: { margin: string; seller: string; ad: string }
  counts: { marginRows: number; marginUniqueOptionIds: number; sellerOptionIds: number; adOptionIds: number }
  adPeriod: { startDate: string | null; endDate: string | null; periodDays: number | null }
  warnings: string[]
  totals: {
    unmatchedCount: number
    totalRevenue: number
    totalAdCost: number
    totalSales: number
    onlyInSeller: number
    onlyInAd: number
    inBoth: number
  }
  unmatched: UnmatchedRow[]
}

const fmt = (n: number) => n.toLocaleString('ko-KR')

export default function DebugUnmatchedFormPage() {
  const [margin, setMargin] = useState<File | null>(null)
  const [seller, setSeller] = useState<File | null>(null)
  const [ad, setAd] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!margin || !seller || !ad) {
      setError('3개 파일 모두 선택하세요 (margin, seller, ad)')
      return
    }
    setError(null)
    setResult(null)
    setLoading(true)
    try {
      const fd = new FormData()
      fd.append('margin', margin)
      fd.append('seller', seller)
      fd.append('ad', ad)
      const res = await fetch('/api/debug-unmatched', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) {
        setError(`HTTP ${res.status}: ${JSON.stringify(json)}`)
      } else {
        setResult(json)
      }
    } catch (err: any) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }

  function downloadCsv() {
    if (!result) return
    const header = ['optionId', 'channel', 'revenue', 'sales', 'adCost', 'inSeller', 'inAd', 'campaigns']
    const lines = [header.join(',')]
    for (const r of result.unmatched) {
      lines.push(
        [
          r.optionId,
          r.channel ?? '',
          r.revenue,
          r.sales,
          r.adCost,
          r.inSeller ? 1 : 0,
          r.inAd ? 1 : 0,
          `"${r.campaigns.join(' | ').replace(/"/g, '""')}"`,
        ].join(','),
      )
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `unmatched_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>매칭 누락 옵션 디버그 (임시)</h1>
      <p style={{ color: '#666', marginBottom: 16 }}>
        검증 후 <code>app/api/debug-unmatched/</code> 와 <code>app/debug-unmatched/</code> 를 함께 삭제 예정.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FileField label="마진 마스터 엑셀 (margin)" onPick={setMargin} file={margin} />
        <FileField label="판매 분석 엑셀 / SELLER (seller)" onPick={setSeller} file={seller} />
        <FileField label="광고 캠페인 엑셀 (ad)" onPick={setAd} file={ad} />

        <button
          type="submit"
          disabled={loading || !margin || !seller || !ad}
          style={{
            padding: '8px 16px',
            background: loading ? '#999' : '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: loading ? 'wait' : 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          {loading ? '분석 중…' : '매칭 누락 분석'}
        </button>
      </form>

      {error && (
        <pre style={{ marginTop: 16, padding: 12, background: '#fee', border: '1px solid #f99', borderRadius: 4, whiteSpace: 'pre-wrap' }}>
          {error}
        </pre>
      )}

      {result && (
        <div style={{ marginTop: 24 }}>
          <section style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, margin: '8px 0' }}>요약</h2>
            <div style={{ background: '#f6f8fa', border: '1px solid #ddd', borderRadius: 4, padding: 12, fontSize: 13 }}>
              <div>
                마진엑셀 <b>{fmt(result.counts.marginUniqueOptionIds)}</b>개 옵션 ·
                SELLER <b>{fmt(result.counts.sellerOptionIds)}</b>개 ·
                광고 <b>{fmt(result.counts.adOptionIds)}</b>개
              </div>
              <div style={{ marginTop: 4 }}>
                광고 기간: {result.adPeriod.startDate ?? '?'} ~ {result.adPeriod.endDate ?? '?'} ({result.adPeriod.periodDays ?? '?'}일)
              </div>
              <div style={{ marginTop: 8, fontWeight: 600 }}>
                <span style={{ color: '#d00' }}>매칭 누락 {fmt(result.totals.unmatchedCount)}개</span>
                {' · '}매출 합계 {fmt(result.totals.totalRevenue)}원
                {' · '}광고비 합계 {fmt(result.totals.totalAdCost)}원
                {' · '}판매수 {fmt(result.totals.totalSales)}
              </div>
              <div style={{ marginTop: 4, color: '#666' }}>
                SELLER만 {result.totals.onlyInSeller} · 광고만 {result.totals.onlyInAd} · 둘다 {result.totals.inBoth}
              </div>
              {result.warnings.length > 0 && (
                <div style={{ marginTop: 8, color: '#c70' }}>
                  warnings: {result.warnings.join(' / ')}
                </div>
              )}
            </div>
          </section>

          <section style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            <button onClick={downloadCsv} style={{ padding: '6px 12px', background: '#28a745', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              CSV 다운로드
            </button>
          </section>

          <section>
            <h2 style={{ fontSize: 16, margin: '8px 0' }}>누락 옵션 (매출 큰 순)</h2>
            <div style={{ overflow: 'auto', maxHeight: '60vh', border: '1px solid #ddd', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#f0f0f0' }}>
                  <tr>
                    <th style={th}>#</th>
                    <th style={th}>옵션ID</th>
                    <th style={th}>채널</th>
                    <th style={{ ...th, textAlign: 'right' }}>매출(원)</th>
                    <th style={{ ...th, textAlign: 'right' }}>판매수</th>
                    <th style={{ ...th, textAlign: 'right' }}>광고비(원)</th>
                    <th style={th}>S</th>
                    <th style={th}>A</th>
                    <th style={th}>대표 캠페인</th>
                  </tr>
                </thead>
                <tbody>
                  {result.unmatched.map((r, i) => (
                    <tr key={r.optionId} style={{ background: i % 2 ? '#fafafa' : 'white' }}>
                      <td style={td}>{i + 1}</td>
                      <td style={{ ...td, fontFamily: 'monospace' }}>{r.optionId}</td>
                      <td style={td}>{r.channel ?? '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmt(r.revenue)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmt(r.sales)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmt(r.adCost)}</td>
                      <td style={{ ...td, textAlign: 'center' }}>{r.inSeller ? '✓' : ''}</td>
                      <td style={{ ...td, textAlign: 'center' }}>{r.inAd ? '✓' : ''}</td>
                      <td style={{ ...td, color: '#666' }}>{r.campaigns.join(' / ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #ccc', fontWeight: 600 }
const td: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid #eee' }

function FileField({ label, onPick, file }: { label: string; onPick: (f: File | null) => void; file: File | null }) {
  return (
    <label>
      <div style={{ marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <input type="file" accept=".xlsx,.xls" onChange={(e) => onPick(e.target.files?.[0] || null)} />
      {file && <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>{file.name} ({(file.size / 1024).toFixed(0)} KB)</span>}
    </label>
  )
}
