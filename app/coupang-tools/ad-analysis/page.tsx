'use client'

/**
 * 광고 분석 페이지 (/coupang-tools/ad-analysis)
 *
 * 데이터 소스: store 의 rawAdCampaign (parseAdCampaign 결과) + marginMaster (BEP).
 * 1차 범위: 캠페인 진단 + AI 키워드 분석 + 수동 입찰가 점검 (현재 입찰가는 사용자 직접 입력).
 * 자동 입찰 적용은 영구 안 함 — 사용자가 키워드 복사해서 쿠팡 광고센터에 직접 입력.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { useMarginStore } from '@/lib/coupang/store'
import { parseAdCampaign } from '@/lib/coupang/parsers/adCampaign'
import {
  buildAdAnalysisView,
  buildKeywordRows,
  buildManualReviewRows,
  buildBepMap,
  buildBepCpcForCampaign,
  buildActualPriceMapById,
  buildMarginRowMap,
  buildExposureMapByOptionId,
  splitRowRevenue,
  isSearchPlacement,
  type CampaignDiag,
  type KeywordRow,
  type ManualKeywordRow,
} from '@/lib/coupang/adAnalysis'
import type { AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import { ChannelBadge } from '../_lib/channel'

type Mode = 'saved' | 'live'

// ── formatters ────────────────────────────────────────────────
const fmtMan = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—'
  const man = n / 10000
  return `${Math.round(man).toLocaleString('ko-KR')}만`
}
const fmtNum = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : Math.round(n).toLocaleString('ko-KR')
const fmtPctVal = (n: number | null | undefined, digits = 0): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${n.toFixed(digits)}%`
const fmtRoas = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${Math.round(n)}%`
const fmtBid = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`
// 쿠팡 입찰가 10원 단위 정책 — 추천 입찰가 노출 우선 올림
const ceilToTen = (v: number): number => Math.ceil(v / 10) * 10

// ── Generic sort ──────────────────────────────────────────────
type SortDir = 'asc' | 'desc'
function useSort<T extends Record<string, any>>(rows: T[], defaultKey: keyof T, defaultDir: SortDir = 'desc') {
  const [key, setKey] = useState<keyof T>(defaultKey)
  const [dir, setDir] = useState<SortDir>(defaultDir)
  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      const isNumA = typeof av === 'number' && Number.isFinite(av)
      const isNumB = typeof bv === 'number' && Number.isFinite(bv)
      // null/undefined/NaN 은 정렬 방향과 무관하게 항상 맨 뒤
      if (!isNumA && !isNumB && av == null && bv == null) return 0
      if (isNumA && !isNumB) return -1
      if (!isNumA && isNumB) return 1
      let cmp = 0
      if (isNumA && isNumB) cmp = (av as number) - (bv as number)
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      return dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [rows, key, dir])
  function toggle(k: keyof T) {
    if (key === k) setDir(dir === 'asc' ? 'desc' : 'asc')
    else { setKey(k); setDir('desc') }
  }
  return { sorted, key, dir, toggle }
}

// ── Page ──────────────────────────────────────────────────────
export default function AdAnalysisPage() {
  const marginMaster = useMarginStore((s) => s.marginMaster)
  const rawAdCampaign = useMarginStore((s) => s.rawAdCampaign)
  const adPeriod = useMarginStore((s) => s.adPeriod)
  const adAnalysisLive = useMarginStore((s) => s.adAnalysisLive)
  const setMarginMaster = useMarginStore((s) => s.setMarginMaster)
  const setAdCampaign = useMarginStore((s) => s.setAdCampaign)
  const setSalesInsight = useMarginStore((s) => s.setSalesInsight)
  const setAdAnalysisLive = useMarginStore((s) => s.setAdAnalysisLive)
  const clearAdAnalysisLive = useMarginStore((s) => s.clearAdAnalysisLive)
  const [mode, setMode] = useState<Mode>('saved')
  const [openCampId, setOpenCampId] = useState<string | null>(null)
  // 캠페인 진단 표 인라인 옵션 드릴다운: 옵션 클릭 시 상세 영역 키워드도 옵션 단위로 필터링.
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [autoLoading, setAutoLoading] = useState(true)
  const [uploadError, setUploadError] = useState<string | null>(null)

  function openCampaignAndOption(campaignId: string, optionId: string | null) {
    setOpenCampId(campaignId)
    setSelectedOptionId((prev) => (prev === optionId ? null : optionId))
  }
  function toggleCampaign(id: string) {
    setOpenCampId((prev) => (prev === id ? null : id))
    // 다른 캠페인 펼치면 옵션 필터 해제
    if (openCampId !== id) setSelectedOptionId(null)
  }

  // 마운트 시점 자동 로드 — 수익 진단 페이지를 거치지 않고 직접 진입해도 동작.
  // 진단 페이지의 자동 로드 로직 중 광고 분석에 필요한 것만 발췌:
  //  1) marginMaster (BEP/단가 lookup)
  //  2) 가장 최근 주차 광고 분석 → setAdCampaign + setSalesInsight (주차 기간 + 광고 raw row)
  // settle/price/savedAnalyses 등 광고 분석에서 안 쓰는 것은 생략.
  // 이미 store 에 데이터가 있으면 fetch 안 함 (다른 페이지에서 먼저 로드된 경우).
  useEffect(() => {
    let cancelled = false
    const needMaster = !marginMaster
    const needAd = !rawAdCampaign || rawAdCampaign.length === 0 || !adPeriod

    if (!needMaster && !needAd) {
      setAutoLoading(false)
      return
    }

    ;(async () => {
      try {
        if (needMaster) {
          const masterRes = await fetch('/api/coupang-master?type=margin_master')
          const masterJson = await masterRes.json()
          if (!cancelled && masterJson?.data) {
            setMarginMaster(masterJson.data, {
              fileName: masterJson.fileName || '저장된 데이터',
              uploadedAt: masterJson.savedAt || new Date().toISOString(),
              rowCount: masterJson.data?.marginRows?.length || 0,
            })
          }
        }

        if (needAd) {
          const listRes = await fetch('/api/coupang-diagnoses?type=list')
          const listJson = await listRes.json()
          const all = listJson?.diagnoses || []
          const weeklies = all
            .filter((a: any) => a.weekKey && a._hasRaw)
            .sort((a: any, b: any) => (b.weekKey || '').localeCompare(a.weekKey || ''))
          const meta = weeklies[0]
          if (meta?.id) {
            // 메인 row 의 adRows/sellerStats 는 4.5MB Vercel limit 회피용 빈 배열 마커.
            // 실데이터는 raw 키에 분리 저장되어 있어 별도 fetch 후 머지.
            const [itemRes, rawRes] = await Promise.all([
              fetch(`/api/coupang-diagnoses?type=item&id=${meta.id}`),
              fetch(`/api/coupang-diagnoses?type=raw&id=${meta.id}`),
            ])
            const target = await itemRes.json()
            const raw = rawRes.ok ? await rawRes.json().catch(() => null) : null
            const adRows = raw?.adRows?.length ? raw.adRows : target?.adRows
            const sellerStats = raw?.sellerStats?.length ? raw.sellerStats : target?.sellerStats
            if (!cancelled && adRows?.length) {
              setAdCampaign(adRows, {
                fileName: target?.adFileName || '저장된 분석',
                uploadedAt: target?.createdAt || new Date().toISOString(),
                rowCount: adRows.length,
              }, target?.periodStartDate && target?.periodEndDate ? {
                startDate: target.periodStartDate,
                endDate: target.periodEndDate,
                days: target.periodDays || 30,
              } : null)
              if (sellerStats?.length) {
                setSalesInsight(sellerStats, {
                  fileName: target?.sellerFileName || '저장된 분석',
                  uploadedAt: target?.createdAt || new Date().toISOString(),
                  rowCount: sellerStats.length,
                })
              }
            }
          }
        }
      } catch (err) {
        console.error('[ad-analysis] 자동 로드 실패:', err)
      } finally {
        if (!cancelled) setAutoLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 모드별 source 분기
  const sourceRows = mode === 'live' ? (adAnalysisLive?.rows ?? null) : rawAdCampaign
  const sourcePeriod = mode === 'live' ? (adAnalysisLive?.period ?? null) : adPeriod
  const periodLabel = sourcePeriod
    ? `${sourcePeriod.startDate}_${sourcePeriod.endDate}`
    : new Date().toISOString().slice(0, 10)

  const view = useMemo(
    () => buildAdAnalysisView(sourceRows, marginMaster as any),
    [sourceRows, marginMaster],
  )

  // 라이브 광고 엑셀 업로드 핸들러 — store 의 rawAdCampaign 안 건드림.
  async function handleLiveUpload(file: File) {
    setUploadError(null)
    try {
      const buf = await file.arrayBuffer()
      const r = parseAdCampaign(buf, file.name)
      if (!r.rows.length) {
        setUploadError('광고 캠페인 행을 찾지 못했습니다. 파일을 확인해주세요.')
        return
      }
      const meta = { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length }
      const period = r.startDate && r.endDate
        ? { startDate: r.startDate, endDate: r.endDate, days: r.periodDays || 30 }
        : null
      setAdAnalysisLive(r.rows, meta, period)
    } catch (err: any) {
      setUploadError(`파싱 에러: ${err?.message || err}`)
    }
  }

  // 셀렉터/공통 헤더 — 어떤 분기든 항상 노출
  const headerNode = (
    <Header
      mode={mode}
      onMode={setMode}
      adPeriodLabel={sourcePeriod ? `${sourcePeriod.startDate} ~ ${sourcePeriod.endDate} (${sourcePeriod.days}일)` : undefined}
    />
  )

  // ── 라이브 모드 ──
  if (mode === 'live') {
    if (!marginMaster) {
      return (
        <div style={pageWrap}>
          <Style />
          {headerNode}
          <div style={noticeBoxOrange}>
            마진마스터가 없습니다. 「수익 진단」 페이지에서 마진분석.xlsx 를 먼저 업로드해주세요.
            <br />
            <span style={{ fontSize: 12, color: '#B45309' }}>
              (라이브 모드는 마진마스터의 옵션ID → 실판매가 룩업으로 매출을 산출합니다.)
            </span>
          </div>
        </div>
      )
    }
    if (!adAnalysisLive) {
      return (
        <div style={pageWrap}>
          <Style />
          {headerNode}
          <LiveUploadBox onFile={handleLiveUpload} error={uploadError} />
        </div>
      )
    }
    // 라이브 데이터 있음 → 정상 view
    const openCampaign = openCampId ? view.campaigns.find((c) => c.campaignId === openCampId) || null : null
    return (
      <div style={{
        fontFamily: 'Pretendard, -apple-system, sans-serif',
        color: '#1F2937', fontSize: 14, lineHeight: 1.5,
      }}>
        <Style />
        {headerNode}
        <LiveActiveBar
          meta={adAnalysisLive.meta}
          onReplace={handleLiveUpload}
          onClear={() => { clearAdAnalysisLive(); setUploadError(null) }}
        />
        {uploadError && <div style={errorBox}>{uploadError}</div>}
        <KpiSection view={view} />
        <HintBanner />
        <HistoryNotesSection />
        <CampaignSection
          view={view}
          master={marginMaster as any}
          openCampId={openCampId}
          onOpen={toggleCampaign}
          selectedOptionId={selectedOptionId}
          onSelectOption={openCampaignAndOption}
        />
        {openCampaign && (
          openCampaign.type === 'manual'
            ? <ManualSection campaign={openCampaign} master={marginMaster as any} periodLabel={periodLabel} selectedOptionId={selectedOptionId} onClearOption={() => setSelectedOptionId(null)} onClose={() => { setOpenCampId(null); setSelectedOptionId(null) }} />
            : <AiSection campaign={openCampaign} master={marginMaster as any} periodLabel={periodLabel} selectedOptionId={selectedOptionId} onClearOption={() => setSelectedOptionId(null)} onClose={() => { setOpenCampId(null); setSelectedOptionId(null) }} />
        )}
      </div>
    )
  }

  // ── 저장 모드 ──
  if (autoLoading && !view.loaded) {
    return (
      <div style={pageWrap}>
        <Style />
        {headerNode}
        <div style={loadingBox}>저장된 광고 데이터를 불러오는 중…</div>
      </div>
    )
  }

  if (!view.loaded) {
    return (
      <div style={pageWrap}>
        <Style />
        {headerNode}
        <div style={noticeBoxOrange}>
          저장된 광고 분석이 없습니다. 「수익 진단」 페이지에서 광고 엑셀을 업로드/저장하거나, 위 「라이브」 탭에서 직접 업로드하세요.
        </div>
      </div>
    )
  }

  const openCampaign = openCampId ? view.campaigns.find((c) => c.campaignId === openCampId) || null : null

  return (
    <div style={{
      fontFamily: 'Pretendard, -apple-system, sans-serif',
      color: '#1F2937', fontSize: 14, lineHeight: 1.5,
    }}>
      <Style />
      {headerNode}
      <KpiSection view={view} />
      <HintBanner />
      <HistoryNotesSection />
      <CampaignSection
        view={view}
        master={marginMaster as any}
        openCampId={openCampId}
        onOpen={toggleCampaign}
        selectedOptionId={selectedOptionId}
        onSelectOption={openCampaignAndOption}
      />
      {openCampaign && (
        openCampaign.type === 'manual'
          ? <ManualSection campaign={openCampaign} master={marginMaster as any} periodLabel={periodLabel} selectedOptionId={selectedOptionId} onClearOption={() => setSelectedOptionId(null)} onClose={() => { setOpenCampId(null); setSelectedOptionId(null) }} />
          : <AiSection campaign={openCampaign} master={marginMaster as any} periodLabel={periodLabel} selectedOptionId={selectedOptionId} onClearOption={() => setSelectedOptionId(null)} onClose={() => { setOpenCampId(null); setSelectedOptionId(null) }} />
      )}
    </div>
  )
}

const pageWrap: React.CSSProperties = { maxWidth: 1500, margin: '0 auto', padding: '32px 40px', fontFamily: 'Pretendard, sans-serif' }
const loadingBox: React.CSSProperties = { background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: 24, fontSize: 14, color: '#64748B', textAlign: 'center' }
const noticeBoxOrange: React.CSSProperties = { background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: 24, fontSize: 14, color: '#92400E', textAlign: 'center' }
const errorBox: React.CSSProperties = { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '8px 12px', margin: '8px 0', fontSize: 12, color: '#991B1B' }

// ── 라이브 모드 업로드 박스 (드래그 + 클릭) ───────────────────
function LiveUploadBox({ onFile, error }: { onFile: (f: File) => void; error: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    onFile(f)
  }

  return (
    <>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          handleFiles(e.dataTransfer.files)
        }}
        style={{
          border: `2px dashed ${dragOver ? '#FF6B35' : '#FED7AA'}`,
          background: dragOver ? '#FFF7ED' : '#FFFBF5',
          borderRadius: 8,
          padding: '40px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          color: '#92400E',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>광고 캠페인 엑셀 업로드</div>
        <div style={{ fontSize: 13, color: '#B45309' }}>
          쿠팡 광고센터 → pa_total_campaign 다운로드 파일 (.xlsx)
        </div>
        <div style={{ fontSize: 12, color: '#A16207', marginTop: 8 }}>
          파일을 끌어다 놓거나 클릭해서 선택하세요. 기간은 파일명에서 자동 인식됩니다.
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => { handleFiles(e.target.files); if (inputRef.current) inputRef.current.value = '' }}
        />
      </div>
      {error && <div style={errorBox}>{error}</div>}
    </>
  )
}

// ── 라이브 활성 상태 표시줄 (파일명 + 다시 업로드 / 닫기) ────────
function LiveActiveBar({ meta, onReplace, onClear }: {
  meta: { fileName: string; uploadedAt: string; rowCount: number } | null
  onReplace: (f: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6,
      padding: '8px 12px', margin: '8px 0 16px', fontSize: 12, color: '#92400E',
    }}>
      <div>
        📂 <strong>라이브:</strong> {meta?.fileName || '—'}
        {meta?.rowCount != null && <span style={{ marginLeft: 8, color: '#B45309' }}>· {meta.rowCount.toLocaleString()} rows</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => inputRef.current?.click()}
          style={{ padding: '4px 10px', border: '1px solid #FED7AA', background: '#FFFBF5', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#92400E' }}
        >
          다시 업로드
        </button>
        <button
          onClick={onClear}
          style={{ padding: '4px 10px', border: '1px solid #FECACA', background: '#FEF2F2', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#991B1B' }}
        >
          닫기
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onReplace(f)
            if (inputRef.current) inputRef.current.value = ''
          }}
        />
      </div>
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────
function Header({ mode, onMode, adPeriodLabel }: {
  mode: Mode
  onMode: (m: Mode) => void
  adPeriodLabel?: string
}) {
  const tabs: { id: Mode; label: string; sub: string }[] = [
    { id: 'saved', label: '저장 (7일)', sub: '진단 페이지 자동 저장' },
    { id: 'live', label: '라이브', sub: '광고 엑셀 직접 업로드' },
  ]
  return (
    <div className="aa-page-header">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="aa-title">광고 분석</div>
          <div className="aa-desc">캠페인별 효율 진단 · 제외 키워드 추출 · 수동 캠페인 입찰가 가이드 {adPeriodLabel && <span style={{ marginLeft: 8, color: '#94A3B8' }}>· {adPeriodLabel}</span>}</div>
        </div>
        <div className="aa-period-bar" title="14일 어트리뷰션 윈도우 중첩 회피 — 30/90일은 라이브 모드에서 직접 업로드">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`aa-period-btn ${mode === t.id ? 'active' : ''}`}
              onClick={() => onMode(t.id)}
              title={t.sub}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── KPI ───────────────────────────────────────────────────────
function KpiSection({ view }: { view: ReturnType<typeof buildAdAnalysisView> }) {
  const roasUnder = view.avgRoasPct != null && view.avgBepPct != null && view.avgRoasPct < view.avgBepPct
  const u = view.unmatched
  return (
    <>
      <div className="aa-kpi-grid">
        <KpiCard label="광고비 (+VAT)" value={fmtMan(view.totalAdCostVat)} sub={`캠페인 ${view.campaignCount}개`} />
        <KpiCard label="광고 매출" value={fmtMan(view.totalRevenue)} sub="광고 판매수 × 실판매가" />
        <KpiCard
          label="평균 ROAS"
          value={fmtRoas(view.avgRoasPct)}
          valueClass={roasUnder ? 'text-bad' : undefined}
          sub={view.avgBepPct != null ? `BEP 평균 ${Math.round(view.avgBepPct)}% ${roasUnder ? '미달' : '도달'}` : 'BEP 매칭 없음'}
        />
        <KpiCard
          label="광고 판매수"
          value={`${fmtNum(view.totalOrders)}건`}
          sub={view.avgUnitPrice ? `평균 단가 ${fmtNum(view.avgUnitPrice)}원` : ''}
        />
      </div>
      {u.adCount > 0 && (
        <div style={{
          margin: '8px 0 16px', padding: '8px 12px',
          background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6,
          fontSize: 12, color: '#92400E',
        }}>
          ⚠️ 마진마스터 미등록 옵션 <strong>{u.adCount}개</strong>의 광고비{' '}
          <strong>{fmtMan(u.adCostVat)}원</strong>이 매출/주문 KPI 및 표 산출에서 제외됨
          (실판매가 매칭 불가)
        </div>
      )}
    </>
  )
}

function KpiCard({ label, value, sub, valueClass }: { label: React.ReactNode; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="aa-kpi-card">
      <div className="aa-kpi-label">{label}</div>
      <div className={`aa-kpi-value ${valueClass || ''}`}>{value}</div>
      {sub && <div className="aa-kpi-sub">{sub}</div>}
    </div>
  )
}

function HintBanner() {
  return (
    <div className="aa-hint-banner">
      💡 캠페인을 클릭하면 키워드 분석(AI) 또는 입찰가 점검(수동)이 펼쳐집니다. AI 캠페인의 "수동 이동 후보" 키워드 옆에 추천 입찰가가 표시됩니다.
    </div>
  )
}

// ── 운영 메모 (영구 저장) ─────────────────────────────────────
type HistoryNote = { id: string; ts: string; text: string }

function fmtNoteTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function HistoryNotesSection() {
  const [items, setItems] = useState<HistoryNote[]>([])
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
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
  }, [])

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
        body: JSON.stringify({ text: t }),
      })
      const j = await res.json()
      if (j?.item) {
        setItems((prev) => [...prev, j.item as HistoryNote])
        setText('')
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
    if (!confirm('이 메모를 삭제할까요?')) return
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
      <div className="aa-sub-section-title" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <span>📝 운영 메모 ({loading ? '…' : `${sorted.length}건`})</span>
        <span style={{ fontSize: 12, color: '#64748B' }}>{open ? '▾ 접기' : '▸ 펼치기'}</span>
      </div>
      {open && (
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }}
              placeholder="예: 5.5일 제외 키워드 셋팅"
              disabled={busy}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
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
                  <span style={{ flex: 1, whiteSpace: 'pre-wrap', color: '#1F2937' }}>{it.text}</span>
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

// ── Campaign Section ──────────────────────────────────────────
function CampaignSection({ view, master, openCampId, onOpen, selectedOptionId, onSelectOption }: {
  view: ReturnType<typeof buildAdAnalysisView>
  master: any
  openCampId: string | null
  onOpen: (id: string) => void
  selectedOptionId: string | null
  onSelectOption: (campaignId: string, optionId: string | null) => void
}) {
  const { sorted, key, dir, toggle } = useSort(view.campaigns, 'adCostVat' as keyof CampaignDiag, 'desc')
  const [expandedCampIds, setExpandedCampIds] = useState<Set<string>>(new Set())

  function toggleExpand(id: string) {
    setExpandedCampIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const bepMap = useMemo(() => buildBepMap(master), [master])
  const priceMap = useMemo(() => buildActualPriceMapById(master), [master])
  const rowMap = useMemo(() => buildMarginRowMap(master), [master])
  const exposureMap = useMemo(() => buildExposureMapByOptionId(master), [master])

  const TH = ({ label, k, num, minWidth, sticky }: { label: React.ReactNode; k: keyof CampaignDiag; num?: boolean; minWidth?: number; sticky?: boolean }) => (
    <th
      className={[
        'sortable',
        num ? 'num' : '',
        sticky ? 'sticky-left' : '',
        key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
      ].filter(Boolean).join(' ')}
      style={minWidth ? { minWidth } : undefined}
      onClick={() => toggle(k)}
    >
      {label}
    </th>
  )

  return (
    <div className="aa-section">
      <div className="aa-section-header">
        <div>
          <div className="aa-section-title">캠페인 진단</div>
          <div className="aa-section-desc">▸ 클릭 → 옵션 펼침 · 캠페인명 클릭 → 키워드 분석 · 옵션 클릭 → 키워드 옵션 필터</div>
        </div>
      </div>
      <div className="aa-table-wrap">
        <table>
          <thead>
            <tr>
              <TH label="캠페인" k={'campaignName'} sticky minWidth={260} />
              <TH label="타입" k={'type'} />
              <TH label="광고비 (+VAT)" k={'adCostVat'} num />
              <TH label="광고 매출" k={'revenue'} num />
              <TH label={<>타상품 매출<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(다른 상품 전환)</span></>} k={'otherProductRevenue'} num minWidth={110} />
              <TH label="광고 판매수" k={'orders'} num />
              <TH label="ROAS" k={'roasPct'} num />
              <TH label="BEP" k={'bepPct'} num />
              <TH label="갭" k={'gapPct'} num />
              <TH label="전환율" k={'clicks'} num />
              <TH label="검색/비검색" k={'searchShare'} minWidth={200} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const isOpen = c.campaignId === openCampId
              const isExpanded = expandedCampIds.has(c.campaignId)
              const opts = isExpanded
                ? computeOptions(c.rows, bepMap, priceMap, rowMap, exposureMap)
                : []
              return (
                <CampaignRowGroup
                  key={c.campaignId}
                  c={c}
                  isOpen={isOpen}
                  isExpanded={isExpanded}
                  onToggle={() => onOpen(c.campaignId)}
                  onToggleExpand={() => toggleExpand(c.campaignId)}
                  options={opts}
                  selectedOptionId={isOpen ? selectedOptionId : null}
                  onSelectOption={(optId) => onSelectOption(c.campaignId, optId)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CampaignRowGroup({ c, isOpen, isExpanded, onToggle, onToggleExpand, options, selectedOptionId, onSelectOption }: {
  c: CampaignDiag
  isOpen: boolean
  isExpanded: boolean
  onToggle: () => void
  onToggleExpand: () => void
  options: OptionDiag[]
  selectedOptionId: string | null
  onSelectOption: (optionId: string) => void
}) {
  const roasUnder = c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct
  const roasClass = roasUnder ? 'text-bad' : (c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct * 1.2 ? 'text-warn' : '')
  const gapClass = c.gapPct != null && c.gapPct < 0 ? 'text-bad' : c.gapPct != null && c.gapPct > 0 ? 'text-good' : ''

  const typeBadge =
    c.type === 'ai' ? <span className="aa-badge badge-ai">🤖 AI</span> :
    c.type === 'manual' ? <span className="aa-badge badge-manual">🎯 수동</span> :
    <span className="aa-badge badge-unsorted">미분류</span>

  const searchPct = Math.round(c.searchShare * 100)
  const isManual = c.type === 'manual'
  const cvrPct = c.clicks > 0 ? (c.orders / c.clicks) * 100 : null

  return (
    <>
      <tr className={`clickable ${isOpen ? 'selected' : ''}`} onClick={onToggle}>
        <td className="sticky-left">
          <span
            className="aa-expand-toggle"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            title={isExpanded ? '옵션 접기' : '옵션 펼치기'}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
          <strong>{c.campaignName}</strong>
        </td>
        <td>{typeBadge}</td>
        <td className="num">{fmtMan(c.adCostVat)}</td>
        <td className="num">{fmtMan(c.revenue)}</td>
        <td className="num text-muted">{c.otherProductRevenue > 0 ? fmtMan(c.otherProductRevenue) : '—'}</td>
        <td className="num">{fmtNum(c.orders)}</td>
        <td className={`num ${roasClass}`}>{fmtRoas(c.roasPct)}</td>
        <td className="num" style={{ fontWeight: 700 }}>{isManual ? <span className="text-muted">—</span> : (c.bepPct != null ? `${Math.round(c.bepPct)}%` : '—')}</td>
        <td className={`num ${gapClass}`}>{isManual ? <span className="text-muted">—</span> : (c.gapPct != null ? `${c.gapPct > 0 ? '+' : ''}${Math.round(c.gapPct)}%p` : '—')}</td>
        <td className="num">{cvrPct != null ? `${cvrPct.toFixed(1)}%` : <span className="text-muted">—</span>}</td>
        <td>
          {c.adCostRaw > 0 ? (
            <div className="aa-search-bar">
              <span style={{ width: 32, color: '#3B82F6' }}>{searchPct}%</span>
              <div className="aa-search-bar-bg"><div className="aa-search-bar-fill" style={{ width: `${searchPct}%` }} /></div>
              <span style={{ width: 32, color: '#A855F7' }}>{100 - searchPct}%</span>
            </div>
          ) : <span className="text-muted">—</span>}
        </td>
      </tr>
      {isExpanded && options.map((o) => (
        <OptionInlineRow
          key={`${c.campaignId}::${o.optionId}`}
          o={o}
          isSelected={selectedOptionId === o.optionId}
          onClick={() => onSelectOption(o.optionId)}
        />
      ))}
      {isExpanded && options.length === 0 && (
        <tr className="aa-option-row">
          <td className="sticky-left aa-option-cell" colSpan={11} style={{ textAlign: 'center', color: '#94A3B8' }}>옵션 없음</td>
        </tr>
      )}
    </>
  )
}

function OptionInlineRow({ o, isSelected, onClick }: { o: OptionDiag; isSelected: boolean; onClick: () => void }) {
  const roasUnder = o.roasPct != null && o.bepPct != null && o.roasPct < o.bepPct
  const roasClass = o.roasPct == null || o.bepPct == null ? '' : (roasUnder ? 'text-bad' : 'text-good')
  const gapClass = o.gapPct == null ? '' : (o.gapPct < 0 ? 'text-bad' : 'text-good')
  const adCostRaw = o.searchAdCostRaw + o.nonSearchAdCostRaw
  const searchPct = Math.round(o.searchShare * 100)

  return (
    <tr
      className={`aa-option-row clickable ${isSelected ? 'option-selected' : ''}`}
      onClick={onClick}
    >
      <td className="sticky-left aa-option-cell">
        <span className="aa-option-prefix">└─</span>
        <span className="aa-option-text">
          {o.alias && <span className="aa-option-alias">{o.alias}</span>}
          <span className="aa-option-name">{o.optionName}</span>
          {!o.matched && <span style={{ marginLeft: 4, fontSize: 10, color: '#92400E' }}>⚠</span>}
          <ChannelBadge raw={o.channel} />
        </span>
      </td>
      <td><span className="text-muted">—</span></td>
      <td className="num">{fmtMan(o.adCostVat)}</td>
      <td className="num">{fmtMan(o.revenue)}</td>
      <td className="num text-muted">{o.otherProductRevenue > 0 ? fmtMan(o.otherProductRevenue) : '—'}</td>
      <td className="num">{fmtNum(o.sold)}</td>
      <td className={`num ${roasClass}`}>{fmtRoas(o.roasPct)}</td>
      <td className="num" style={{ fontWeight: 700 }}>{o.bepPct != null ? `${Math.round(o.bepPct)}%` : '—'}</td>
      <td className={`num ${gapClass}`}>{o.gapPct != null ? `${o.gapPct > 0 ? '+' : ''}${Math.round(o.gapPct)}%p` : '—'}</td>
      <td className="num">{o.cvrPct != null ? `${o.cvrPct.toFixed(1)}%` : <span className="text-muted">—</span>}</td>
      <td>
        {adCostRaw > 0 ? (
          <div className="aa-search-bar">
            <span style={{ width: 32, color: '#3B82F6' }}>{searchPct}%</span>
            <div className="aa-search-bar-bg"><div className="aa-search-bar-fill" style={{ width: `${searchPct}%` }} /></div>
            <span style={{ width: 32, color: '#A855F7' }}>{100 - searchPct}%</span>
          </div>
        ) : <span className="text-muted">—</span>}
      </td>
    </tr>
  )
}

// ── AI Section ────────────────────────────────────────────────
function AiSection({ campaign, master, periodLabel, selectedOptionId, onClearOption, onClose }: {
  campaign: CampaignDiag
  master: any
  periodLabel: string
  selectedOptionId: string | null
  onClearOption: () => void
  onClose: () => void
}) {
  const bepMap = useMemo(() => buildBepMap(master), [master])
  const priceMap = useMemo(() => buildActualPriceMapById(master), [master])
  const rowMap = useMemo(() => buildMarginRowMap(master), [master])
  const exposureMap = useMemo(() => buildExposureMapByOptionId(master), [master])
  const options = useMemo(() => computeOptions(campaign.rows, bepMap, priceMap, rowMap, exposureMap), [campaign.rows, bepMap, priceMap, rowMap, exposureMap])

  const filteredCampaign = useMemo(() => {
    if (!selectedOptionId) return campaign
    return { ...campaign, rows: campaign.rows.filter((r) => String(r.adOptionId || '').trim() === selectedOptionId) }
  }, [campaign, selectedOptionId])
  const selectedOptionName = selectedOptionId
    ? (options.find((o) => o.optionId === selectedOptionId)?.optionName ?? selectedOptionId)
    : null

  const { search, nonSearch } = useMemo(() => buildKeywordRows(filteredCampaign, bepMap, priceMap, exposureMap), [filteredCampaign, bepMap, priceMap, exposureMap])
  const cpcEntries = useMemo(() => buildBepCpcForCampaign(campaign, master), [campaign, master])
  const searchSold = useMemo(() => search.reduce((s, r) => s + (r.orders || 0), 0), [search])
  const nonSearchSold = useMemo(() => nonSearch.reduce((s, r) => s + (r.orders || 0), 0), [nonSearch])

  const [checked, setChecked] = useState<Set<string>>(new Set())
  const toggleCheck = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })

  const cpcLabel = cpcEntries.length > 0
    ? cpcEntries.map((e) => `${e.label} ${Math.round(e.bepPct)}% [${Math.round(e.cpc).toLocaleString('ko-KR')}원]`).join(', ')
    : '—'
  const bepRoasLabel = campaign.bepPct != null ? `${Math.round(campaign.bepPct)}%` : '—'

  return (
    <div className="aa-section" style={{ border: '2px solid #FF6B35' }}>
      <div className="aa-section-header" style={{ background: '#FFF7ED' }}>
        <div>
          <div className="aa-section-title">▼ {campaign.campaignName} · 키워드 분석</div>
          <div className="aa-section-desc">검색 영역만 키워드 단위 제어 가능 · 비검색은 통제 불가</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {cpcEntries.length > 0 && (
            <div style={{ fontSize: 11.5, color: '#64748B' }}>
              <strong style={{ color: '#1F2937' }}>BEP</strong>{' '}—{' '}
              <strong className="mono" style={{ color: '#1F2937' }}>{bepRoasLabel}</strong>{' '}/{' '}
              <span className="mono">{cpcLabel}</span>{' '}
              <span style={{ color: '#EF4444' }}>(VAT 별도)</span>
            </div>
          )}
          <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
        </div>
      </div>
      <div className="aa-section-body">
        <div className="aa-two-col">
          <div className="aa-metric-box search">
            <div className="aa-metric-box-label">🔍 검색 영역 (제어 가능)</div>
            <Row label="광고비 (+VAT)" value={fmtMan(campaign.searchAdCostVat)} sub={campaign.adCostVat > 0 ? `(${Math.round(campaign.searchShare * 100)}%)` : undefined} />
            <Row label="광고 매출" value={fmtMan(campaign.searchRevenue)} />
            <Row label="판매건수" value={`${fmtNum(searchSold)}건`} />
            <Row label="ROAS" value={fmtRoas(campaign.searchRoasPct)} valueClass={campaign.searchRoasPct != null && campaign.bepPct != null && campaign.searchRoasPct < campaign.bepPct ? 'text-bad' : ''} />
            <Row label="BEP" value={campaign.bepPct != null ? `${Math.round(campaign.bepPct)}%` : '—'} />
            <Row label="BEP 갭" value={campaign.searchRoasPct != null && campaign.bepPct != null ? `${Math.round(campaign.searchRoasPct - campaign.bepPct)}%p` : '—'} valueClass={campaign.searchRoasPct != null && campaign.bepPct != null && campaign.searchRoasPct < campaign.bepPct ? 'text-bad' : 'text-good'} />
          </div>
          <div className="aa-metric-box nonsearch">
            <div className="aa-metric-box-label">🎯 비검색 영역 (통제 불가)</div>
            <Row label="광고비 (+VAT)" value={fmtMan(campaign.nonSearchAdCostVat)} sub={campaign.adCostVat > 0 ? `(${100 - Math.round(campaign.searchShare * 100)}%)` : undefined} />
            <Row label="광고 매출" value={fmtMan(campaign.nonSearchRevenue)} />
            <Row label="판매건수" value={`${fmtNum(nonSearchSold)}건`} />
            <Row label="ROAS" value={fmtRoas(campaign.nonSearchRoasPct)} valueClass={campaign.nonSearchRoasPct != null && campaign.bepPct != null && campaign.nonSearchRoasPct < campaign.bepPct ? 'text-bad' : ''} />
            <Row label="BEP" value={campaign.bepPct != null ? `${Math.round(campaign.bepPct)}%` : '—'} />
            <Row label={<span className="text-muted">참고용</span>} value={<span style={{ fontSize: 11 }}>AI 자동 운영</span>} />
          </div>
        </div>
        {selectedOptionName && <FilterChip label={selectedOptionName} onClear={onClearOption} />}
        <KeywordTable
          rows={search}
          campaignRows={campaign.rows}
          campaignBep={campaign.bepPct}
          checked={checked}
          onToggle={toggleCheck}
          nonSearchCount={nonSearch.length}
          campaignName={campaign.campaignName || campaign.campaignId}
          periodLabel={periodLabel}
          bepMap={bepMap}
          priceMap={priceMap}
          rowMap={rowMap}
          selectedOptionName={selectedOptionName}
        />
        <NonSearchKeywordTable
          rows={nonSearch}
          campaignBep={campaign.bepPct}
          campaignName={campaign.campaignName || campaign.campaignId}
          periodLabel={periodLabel}
        />
      </div>
    </div>
  )
}

function Row({ label, value, sub, valueClass }: { label: React.ReactNode; value: React.ReactNode; sub?: string; valueClass?: string }) {
  return (
    <div className="aa-metric-row">
      <span>{label}</span>
      <span className={`mono ${valueClass || ''}`}>{value}{sub && <span style={{ marginLeft: 4, color: '#94A3B8', fontSize: 11 }}>{sub}</span>}</span>
    </div>
  )
}

// ── 옵션별 드릴다운 ───────────────────────────────────────────
interface OptionDiag {
  optionId: string
  optionName: string
  alias: string
  channel: string
  adCostVat: number
  revenue: number
  otherProductRevenue: number
  sold: number
  clicks: number
  cvrPct: number | null
  searchAdCostRaw: number
  nonSearchAdCostRaw: number
  searchShare: number
  roasPct: number | null
  bepPct: number | null
  gapPct: number | null
  matched: boolean
}

function computeOptions(
  rows: AdCampaignRow[],
  bepMap: Map<string, number>,
  priceMap: Map<string, number>,
  rowMap: Map<string, { optionName?: string; alias?: string; channel?: string }>,
  exposureByOptionId: Map<string, string>,
): OptionDiag[] {
  const grp = new Map<string, AdCampaignRow[]>()
  for (const r of rows) {
    const id = String(r.adOptionId || '').trim() || '_'
    const arr = grp.get(id) ?? []
    arr.push(r)
    grp.set(id, arr)
  }
  const out: OptionDiag[] = []
  for (const [optId, rs] of grp) {
    const adCostRaw = rs.reduce((s, r) => s + (r.adCost || 0), 0)
    const adCostVat = adCostRaw * 1.1
    const sold = rs.reduce((s, r) => s + (r.sold14d || 0), 0)
    const clicks = rs.reduce((s, r) => s + (r.clicks || 0), 0)
    let revenue = 0
    let otherProductRevenue = 0
    for (const r of rs) {
      const split = splitRowRevenue(r, priceMap, exposureByOptionId)
      revenue += split.self
      otherProductRevenue += split.other
    }
    let searchRaw = 0
    let nonSearchRaw = 0
    for (const r of rs) {
      if (isSearchPlacement(r.placement)) searchRaw += r.adCost || 0
      else nonSearchRaw += r.adCost || 0
    }
    const roasPct = adCostVat > 0 ? (revenue / adCostVat) * 100 : null
    const bepPct = bepMap.get(optId) ?? null
    const gapPct = roasPct != null && bepPct != null ? roasPct - bepPct : null
    const mr = rowMap.get(optId)
    const matched = !!mr
    const optionName = mr?.optionName || `미매칭 (${optId.slice(-8) || '없음'})`
    const cvrPct = clicks > 0 ? (sold / clicks) * 100 : null
    out.push({
      optionId: optId,
      optionName,
      alias: mr?.alias || '',
      channel: mr?.channel || '',
      adCostVat, revenue, otherProductRevenue, sold, clicks, cvrPct,
      searchAdCostRaw: searchRaw,
      nonSearchAdCostRaw: nonSearchRaw,
      searchShare: adCostRaw > 0 ? searchRaw / adCostRaw : 0,
      roasPct, bepPct, gapPct, matched,
    })
  }
  out.sort((a, b) => b.adCostVat - a.adCostVat)
  return out
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 14,
      padding: '4px 10px', fontSize: 12, color: '#1E40AF', margin: '8px 0',
    }}>
      <span>옵션 필터: <strong>{label}</strong></span>
      <button
        onClick={onClear}
        style={{ background: 'transparent', border: 'none', color: '#1E40AF', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
        title="필터 해제"
      >✕</button>
    </div>
  )
}

// ── 검색 키워드 표 옵션 드릴다운 ──────────────────────────────
interface KeywordOption {
  optionId: string
  optionName: string
  alias: string
  channel: string
  matched: boolean
  sold: number
  share: number
  clicks: number
  cvrPct: number | null
  bepCpcVatExcl: number | null
  recommendedBidVatExcl: number | null
  /** BEP CPC 산출에 쓴 CVR source. 'option' = 옵션+키워드 자체 / 'campaign' = 캠페인 평균 fallback (clicks<20). */
  cvrSource: 'option' | 'campaign' | null
}

/** 옵션 자체 CVR 신뢰도 임계 — 클릭 < N 이면 캠페인 평균 CVR 로 fallback */
const OPTION_CVR_MIN_CLICKS = 20

function computeKeywordOptions(
  keyword: string,
  campaignRows: AdCampaignRow[],
  bepMap: Map<string, number>,
  priceMap: Map<string, number>,
  rowMap: ReturnType<typeof buildMarginRowMap>,
  campaignAvgCvr: number | null,
): KeywordOption[] {
  // 검색 영역 + 해당 키워드만
  const filtered = campaignRows.filter((r) =>
    isSearchPlacement(r.placement) && (r.keyword || '-') === keyword,
  )
  if (!filtered.length) return []
  const totalSold = filtered.reduce((s, r) => s + (r.sold14d || 0), 0)
  // 매출 발생 옵션 (convOptionId) 단위 그룹핑
  const grp = new Map<string, AdCampaignRow[]>()
  for (const r of filtered) {
    const id = String(r.convOptionId || '').trim()
    if (!id) continue
    const arr = grp.get(id) ?? []
    arr.push(r)
    grp.set(id, arr)
  }
  const out: KeywordOption[] = []
  for (const [optId, rs] of grp) {
    const sold = rs.reduce((s, r) => s + (r.sold14d || 0), 0)
    const clicks = rs.reduce((s, r) => s + (r.clicks || 0), 0)
    const cvrPct = clicks > 0 ? (sold / clicks) * 100 : null
    const mr = rowMap.get(optId)
    const matched = !!mr
    const price = priceMap.get(optId) ?? null
    const bep = bepMap.get(optId) ?? null
    let bepCpcVatExcl: number | null = null
    let recBid: number | null = null
    let cvrSource: 'option' | 'campaign' | null = null
    // 옵션 자체 CVR 신뢰도 가드 — clicks<20 이면 단발성 데이터(클릭 1→전환 1=100%) 가능성, 캠페인 평균으로 fallback
    let cvrUsedPct: number | null = null
    if (cvrPct != null && clicks >= OPTION_CVR_MIN_CLICKS) {
      cvrUsedPct = cvrPct
      cvrSource = 'option'
    } else if (campaignAvgCvr != null && campaignAvgCvr > 0) {
      cvrUsedPct = campaignAvgCvr * 100
      cvrSource = 'campaign'
    }
    if (cvrUsedPct != null && price && bep && bep > 0) {
      // BEP CPC (VAT 별도) = (CVR × 단가) / (BEP × 1.1). 추천 입찰가 = BEP CPC × 0.95 (5% 안전마진).
      const cpc = ((cvrUsedPct / 100) * price) / ((bep / 100) * 1.1)
      if (Number.isFinite(cpc) && cpc > 0) {
        bepCpcVatExcl = cpc
        recBid = cpc * 0.95
      } else {
        cvrSource = null
      }
    } else {
      cvrSource = null
    }
    out.push({
      optionId: optId,
      optionName: mr?.optionName || `미매칭 (${optId.slice(-8) || '없음'})`,
      alias: mr?.alias || '',
      channel: mr?.channel || '',
      matched,
      sold,
      share: totalSold > 0 ? sold / totalSold : 0,
      clicks,
      cvrPct,
      bepCpcVatExcl,
      recommendedBidVatExcl: recBid,
      cvrSource,
    })
  }
  out.sort((a, b) => b.sold - a.sold)
  return out
}

function KeywordOptionRow({ entry }: { entry: KeywordOption }) {
  return (
    <tr className="aa-keyword-option-row">
      <td colSpan={13} className="aa-keyword-option-cell">
        <div className="aa-keyword-option-flex">
          <span className="aa-option-prefix">└─</span>
          <span className="aa-option-text">
            {entry.alias && <span className="aa-option-alias">{entry.alias}</span>}
            <span className="aa-option-name">{entry.optionName}</span>
            {!entry.matched && <span style={{ marginLeft: 4, fontSize: 10, color: '#92400E' }}>⚠</span>}
            <ChannelBadge raw={entry.channel} />
          </span>
          <span className="aa-kw-opt-metric">판매 <strong className="mono">{fmtNum(entry.sold)}</strong>개 <span className="text-muted">({Math.round(entry.share * 100)}%)</span></span>
          <span className="aa-kw-opt-metric">전환율 <strong className="mono">{entry.cvrPct != null ? `${entry.cvrPct.toFixed(1)}%` : '—'}</strong></span>
          <span className="aa-kw-opt-metric">BEP CPC <strong className="mono">{entry.bepCpcVatExcl != null ? `${Math.round(entry.bepCpcVatExcl).toLocaleString('ko-KR')}원` : '—'}</strong></span>
          <span className="aa-kw-opt-metric">추천 입찰가 {entry.recommendedBidVatExcl != null
            ? <span className="bid-recommend">{ceilToTen(entry.recommendedBidVatExcl).toLocaleString('ko-KR')}원</span>
            : <span className="text-muted">—</span>}
            {entry.cvrSource === 'campaign' && (
              <span style={{ marginLeft: 4, fontSize: 10, color: '#94A3B8' }}>(캠페인 평균 CVR)</span>
            )}
          </span>
        </div>
      </td>
    </tr>
  )
}

function KeywordTable({ rows, campaignRows, campaignBep, checked, onToggle, nonSearchCount: _nsc, campaignName, periodLabel, bepMap, priceMap, rowMap, selectedOptionName }: {
  rows: KeywordRow[]
  campaignRows: AdCampaignRow[]
  campaignBep: number | null
  checked: Set<string>
  onToggle: (k: string) => void
  nonSearchCount: number
  campaignName: string
  periodLabel: string
  bepMap: Map<string, number>
  priceMap: Map<string, number>
  rowMap: ReturnType<typeof buildMarginRowMap>
  /** 옵션 필터 적용 시 옵션명. null = 전체 옵션 (캠페인명 사용) */
  selectedOptionName?: string | null
}) {
  const { sorted, key, dir, toggle } = useSort(rows, 'adCostVat' as keyof KeywordRow, 'desc')
  const [expandedKws, setExpandedKws] = useState<Set<string>>(new Set())
  function toggleKw(k: string) {
    setExpandedKws((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }

  // 캠페인 평균 CVR — 옵션 row 의 클릭<20 fallback CVR (키워드 row BEP fallback 과 동일 정의)
  const campaignAvgCvr = useMemo(() => {
    let totalOrders = 0, totalClicks = 0
    for (const r of campaignRows) {
      totalOrders += r.sold14d || 0
      totalClicks += r.clicks || 0
    }
    return totalClicks > 0 ? totalOrders / totalClicks : null
  }, [campaignRows])

  const TH = ({ label, k, num, minWidth, sticky, sticky2, width }: any) => (
    <th
      className={[
        'sortable', num ? 'num' : '',
        sticky ? 'sticky-left' : '',
        sticky2 ? 'sticky-left-2' : '',
        key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
      ].filter(Boolean).join(' ')}
      style={{ ...(minWidth ? { minWidth } : null), ...(width ? { width } : null) }}
      onClick={() => toggle(k)}
    >
      {label}
    </th>
  )

  const belowBepCount = sorted.filter((r) => campaignBep != null && r.roasPct != null && r.roasPct < campaignBep).length
  const totalCost = sorted.reduce((s, r) => s + r.adCostVat, 0)

  // 체크된 모든 키워드를 선택한 카테고리(제외/수동 이동) 텍스트로 복사 — 추천 액션 무관, 사용자 의사 우선
  function copyChecked(target: 'exclude' | 'move') {
    const list = sorted.filter((r) => checked.has(r.keyword)).map((r) => r.keyword)
    if (list.length === 0) {
      alert('선택된 키워드가 없습니다.')
      return
    }
    const text = list.join('\n')
    const label = target === 'exclude' ? '제외' : '수동 이동'
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => alert(`✓ ${list.length}개 키워드 복사 완료 (${label})`)).catch(() => {
        prompt('복사 실패 — 직접 복사해주세요:', text)
      })
    } else {
      prompt(`${label} 키워드 복사:`, text)
    }
  }

  function exportRows(scope: 'all' | 'selected') {
    const target = scope === 'selected' ? sorted.filter((r) => checked.has(r.keyword)) : sorted
    if (target.length === 0) {
      alert(scope === 'selected' ? '선택된 키워드가 없습니다.' : '내보낼 키워드가 없습니다.')
      return
    }
    const data = target.map((r) => ({
      '키워드': r.keyword,
      '추천 입찰가 (5% 안전마진, VAT 별도)':
        r.bidSource === 'low_sample' || r.recommendedBidVatExcl == null
          ? null
          : r.bidSource === 'fixed_100'
            ? 100
            : ceilToTen(r.recommendedBidVatExcl),
      '노출': r.impressions,
      '클릭': r.clicks,
      '클릭율(%)': r.ctrPct,
      '광고 판매수': r.orders,
      '전환율(%)': r.cvrPct,
      'ROAS(%)': r.roasPct,
      '현재 CPC (+VAT)': r.currentCpcVatIncl,
      '광고비 (+VAT)': r.adCostVat,
      '광고 매출': r.revenue,
      '추천 액션': ACTION_LABEL[r.action],
    }))
    // 파일명: 옵션 필터 적용 시 옵션명, 미적용 시 캠페인명
    const fileLabel = selectedOptionName ? selectedOptionName : campaignName
    const filename = `광고분석_검색키워드_${sanitizeFile(fileLabel)}_${periodLabel}.xlsx`
    exportXlsx(data, filename, '검색키워드')
  }

  return (
    <div className="aa-sub-section">
      <div className="aa-sub-section-title">
        <span>🔍 검색 키워드 ({sorted.length}개 · BEP 미달 {belowBepCount}개 · 광고비 {fmtMan(totalCost)})</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            ⬇ 전체 다운로드
          </button>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('selected')}
            disabled={checked.size === 0}
            style={{ fontSize: 11, padding: '4px 10px', opacity: checked.size === 0 ? 0.5 : 1 }}
          >
            ⬇ 선택 다운로드 ({checked.size})
          </button>
        </div>
      </div>
      <div className="aa-table-wrap shorter">
        <table>
          <thead>
            <tr>
              <th className="sticky-left" style={{ width: 32 }}></th>
              <TH label="키워드" k="keyword" sticky2 minWidth={140} />
              <TH label="노출" k="impressions" num />
              <TH label="클릭" k="clicks" num />
              <TH label="클릭율" k="ctrPct" num />
              <TH label="광고 판매수" k="orders" num />
              <TH label="전환율" k="cvrPct" num />
              <TH label="ROAS" k="roasPct" num />
              <TH label={<>현재 CPC<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(+VAT)</span></>} k="currentCpcVatIncl" num minWidth={100} />
              <TH label="광고비 (+VAT)" k="adCostVat" num />
              <TH label="광고 매출" k="revenue" num />
              <th><ActionGuideHeader /></th>
              <TH label={<>추천 입찰가<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(이대로 입력 · 5% 안전마진 · VAT 별도)</span></>} k="recommendedBidVatExcl" num minWidth={170} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const isExpanded = expandedKws.has(r.keyword)
              const opts = isExpanded
                ? computeKeywordOptions(r.keyword, campaignRows, bepMap, priceMap, rowMap, campaignAvgCvr)
                : []
              return (
                <React.Fragment key={r.keyword}>
                  <KeywordRowComp
                    r={r}
                    checked={checked.has(r.keyword)}
                    onToggle={() => onToggle(r.keyword)}
                    isExpanded={isExpanded}
                    onToggleExpand={() => toggleKw(r.keyword)}
                  />
                  {isExpanded && opts.map((opt) => (
                    <KeywordOptionRow key={`${r.keyword}::${opt.optionId}`} entry={opt} />
                  ))}
                  {isExpanded && opts.length === 0 && (
                    <tr className="aa-keyword-option-row">
                      <td colSpan={13} style={{ textAlign: 'center', color: '#94A3B8', padding: 12, fontSize: 12 }}>옵션 매출 데이터 없음</td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={13} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>검색 키워드 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="aa-bulk-action">
        <div><strong>{checked.size}개</strong> 선택됨 — 어느 카테고리로 복사할지 선택하세요 (추천 액션은 가이드일 뿐)</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="aa-btn btn-sm btn-bad" onClick={() => copyChecked('exclude')}>🚫 제외 키워드 복사 ({checked.size})</button>
          <button className="aa-btn btn-sm btn-info" onClick={() => copyChecked('move')}>➡️ 수동 이동 키워드 복사 ({checked.size})</button>
        </div>
      </div>
      <ActionLegend />
    </div>
  )
}

// 현재 CPC (+VAT) 색상: 추천(+VAT) 이하=녹 / BEP CPC(+VAT) 이하=노랑 / 초과=빨강 / 산정 불가=회색.
// BEP CPC (+VAT) = revenue / (clicks × bep/100). 추천(+VAT) = BEP CPC(+VAT) × 0.95.
function currentCpcColorClass(r: KeywordRow): string {
  if (r.currentCpcVatIncl == null) return 'text-muted'
  if (r.bepPct == null || r.bepPct <= 0 || r.clicks <= 0 || r.revenue <= 0) return ''
  const bepCpcVatIncl = r.revenue / (r.clicks * (r.bepPct / 100))
  if (!Number.isFinite(bepCpcVatIncl) || bepCpcVatIncl <= 0) return ''
  const recVatIncl = bepCpcVatIncl * 0.95
  if (r.currentCpcVatIncl <= recVatIncl) return 'text-good'
  if (r.currentCpcVatIncl <= bepCpcVatIncl) return 'text-warn'
  return 'text-bad'
}

// 추천 액션 컬럼 헤더 — ⓘ hover 시 가이드 팝업 (320px, 다크 #1F2937)
function ActionGuideHeader() {
  const [hovered, setHovered] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      추천 액션
      <span
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          background: '#94A3B8', color: '#FFFFFF',
          fontSize: 10, fontWeight: 700, fontStyle: 'italic',
          cursor: 'help', userSelect: 'none',
        }}
        aria-label="추천 액션 가이드"
      >i</span>
      {hovered && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6,
            zIndex: 1000, width: 320, padding: '12px 14px',
            background: '#1F2937', color: '#FFFFFF',
            borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontSize: 12, lineHeight: 1.6, fontFamily: 'inherit', fontWeight: 400,
            whiteSpace: 'pre-line', textAlign: 'left',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>추천 액션 가이드</div>
          <div style={{ borderTop: '1px solid #374151', margin: '4px 0 8px' }} />
          <div style={{ marginBottom: 6 }}>
            <div style={{ color: '#FCD34D', fontWeight: 600, marginBottom: 2 }}>
              클릭 &lt; 20 <span style={{ color: '#9CA3AF', fontWeight: 400, fontSize: 11 }}>(모수 쌓는 중)</span>
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>
              ROAS ≥ BEP    → 성장 중 ⭐<br />
              그 외          → 모수 부족
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: '#FCD34D', fontWeight: 600, marginBottom: 2 }}>
              클릭 ≥ 20 <span style={{ color: '#9CA3AF', fontWeight: 400, fontSize: 11 }}>(판단 가능)</span>
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>
              ROAS ≥ BEP×2  → 강화<br />
              BEP ≤ ROAS&lt;×2 → 유지<br />
              0 &lt; ROAS &lt; BEP → 입찰가 ↓<br />
              ROAS = 0      → 제외 (입찰가 100원)
            </div>
          </div>
          <div style={{ borderTop: '1px solid #374151', margin: '4px 0 6px' }} />
          <div style={{ fontSize: 11.5, color: '#D1D5DB' }}>
            💡 클릭 20 미만은 AI 캠페인이 모수 쌓는 중. 제외 추천 X.
          </div>
        </div>
      )}
    </span>
  )
}

// 추천 액션 6단 → 배지 렌더 (테이블 셀 + 엑셀 라벨 공통)
const ACTION_LABEL: Record<KeywordRow['action'], string> = {
  growing: '성장 중',
  low_sample: '모수 부족',
  enhance: '강화',
  maintain: '유지',
  lower_bid: '입찰가 ↓',
  exclude: '제외',
}
function actionBadge(action: KeywordRow['action']): React.ReactElement {
  switch (action) {
    case 'growing':    return <span className="aa-action-chip action-growing">⭐ 성장 중</span>
    case 'low_sample': return <span className="aa-action-chip action-low-sample">모수 부족</span>
    case 'enhance':    return <span className="aa-action-chip action-enhance">강화</span>
    case 'maintain':   return <span className="aa-action-chip action-maintain">유지</span>
    case 'lower_bid':  return <span className="aa-action-chip action-lower-bid">입찰가 ↓</span>
    case 'exclude':    return <span className="aa-action-chip action-exclude">🚫 제외</span>
  }
}

function KeywordRowComp({ r, checked, onToggle, isExpanded, onToggleExpand }: { r: KeywordRow; checked: boolean; onToggle: () => void; isExpanded: boolean; onToggleExpand: () => void }) {
  const roasClass =
    r.roasPct == null || r.bepPct == null ? '' :
    r.roasPct < r.bepPct ? 'text-bad' :
    r.roasPct < r.bepPct * 1.2 ? 'text-warn' : 'text-good'
  const cvrClass =
    r.cvrPct == null ? '' :
    r.cvrPct >= 10 ? 'text-good' :
    r.cvrPct < 6 ? 'text-bad' : 'text-warn'

  // 입찰가 셀 — bidSource 별 분기.
  //   low_sample        : "—"
  //   fixed_100         : "100원" (제외 권장)
  //   revenue + growing : 매출 역산 + "(참고용)" 라벨
  //   revenue + 그 외   : 매출 역산
  let bidCell: React.ReactNode
  if (r.bidSource === 'low_sample' || r.recommendedBidVatExcl == null) {
    bidCell = <span className="text-muted" style={{ fontSize: 11 }}>—</span>
  } else if (r.bidSource === 'fixed_100') {
    bidCell = <span className="bid-recommend">100원</span>
  } else {
    bidCell = (
      <>
        <span className="bid-recommend">{ceilToTen(r.recommendedBidVatExcl).toLocaleString('ko-KR')}원</span>
        <span className="bid-vat-incl">(+VAT) {ceilToTen(r.recommendedBidVatExcl * 1.1).toLocaleString('ko-KR')}원</span>
        {r.action === 'growing' && (
          <span style={{ display: 'block', fontSize: 10, color: '#94A3B8', marginTop: 2 }}>(참고용)</span>
        )}
      </>
    )
  }

  return (
    <tr>
      <td className="sticky-left"><input type="checkbox" checked={checked} onChange={onToggle} /></td>
      <td className="sticky-left-2">
        <span
          className="aa-expand-toggle"
          onClick={onToggleExpand}
          title={isExpanded ? '옵션 접기' : '옵션 펼치기'}
        >
          {isExpanded ? '▾' : '▸'}
        </span>
        <strong>{r.keyword}</strong>
      </td>
      <td className="num">{fmtNum(r.impressions)}</td>
      <td className="num">{fmtNum(r.clicks)}</td>
      <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
      <td className="num">{fmtNum(r.orders)}</td>
      <td className={`num ${cvrClass}`}>{fmtPctVal(r.cvrPct, 2)}</td>
      <td className={`num ${roasClass}`}>{fmtRoas(r.roasPct)}</td>
      <td className={`num ${currentCpcColorClass(r)}`}>{r.currentCpcVatIncl != null ? `${Math.round(r.currentCpcVatIncl).toLocaleString('ko-KR')}원` : '—'}</td>
      <td className="num">{fmtMan(r.adCostVat)}</td>
      <td className="num">{fmtMan(r.revenue)}</td>
      <td>{actionBadge(r.action)}</td>
      <td className="num">{bidCell}</td>
    </tr>
  )
}

// ── 비검색 키워드 표 ──────────────────────────────────────────
function NonSearchKeywordTable({ rows, campaignBep, campaignName, periodLabel }: {
  rows: KeywordRow[]
  campaignBep: number | null
  campaignName: string
  periodLabel: string
}) {
  const { sorted, key, dir, toggle } = useSort(rows, 'adCostVat' as keyof KeywordRow, 'desc')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const onToggle = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })

  const TH = ({ label, k, num, minWidth }: any) => (
    <th
      className={['sortable', num ? 'num' : '', key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : ''].filter(Boolean).join(' ')}
      style={minWidth ? { minWidth } : undefined}
      onClick={() => toggle(k)}
    >{label}</th>
  )

  const totalCost = sorted.reduce((s, r) => s + r.adCostVat, 0)
  const belowBepCount = sorted.filter((r) => campaignBep != null && r.roasPct != null && r.roasPct < campaignBep).length

  function exportRows(scope: 'all' | 'selected') {
    const target = scope === 'selected' ? sorted.filter((r) => checked.has(r.keyword)) : sorted
    if (target.length === 0) {
      alert(scope === 'selected' ? '선택된 항목이 없습니다.' : '내보낼 항목이 없습니다.')
      return
    }
    const data = target.map((r) => ({
      '지면': r.keyword,
      '노출': r.impressions,
      '클릭': r.clicks,
      '클릭율(%)': r.ctrPct,
      '광고 판매수': r.orders,
      '전환율(%)': r.cvrPct,
      'ROAS(%)': r.roasPct,
      '현재 CPC (+VAT)': r.currentCpcVatIncl,
      '광고비 (+VAT)': r.adCostVat,
      '광고 매출': r.revenue,
    }))
    const filename = `광고분석_비검색키워드_${sanitizeFile(campaignName)}_${periodLabel}.xlsx`
    exportXlsx(data, filename, '비검색키워드')
  }

  return (
    <div className="aa-sub-section" style={{ marginTop: 16 }}>
      <div className="aa-sub-section-title">
        <span>🎯 비검색 키워드 ({sorted.length}개 · BEP 미달 {belowBepCount}개 · 광고비 {fmtMan(totalCost)})</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >⬇ 전체 다운로드</button>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('selected')}
            disabled={checked.size === 0}
            style={{ fontSize: 11, padding: '4px 10px', opacity: checked.size === 0 ? 0.5 : 1 }}
          >⬇ 선택 다운로드 ({checked.size})</button>
        </div>
      </div>
      <div className="aa-table-wrap shorter">
        <table>
          <thead>
            <tr>
              <th className="sticky-left" style={{ width: 32 }}></th>
              <TH label="지면" k="keyword" minWidth={140} />
              <TH label="노출" k="impressions" num />
              <TH label="클릭" k="clicks" num />
              <TH label="클릭율" k="ctrPct" num />
              <TH label="광고 판매수" k="orders" num />
              <TH label="전환율" k="cvrPct" num />
              <TH label="ROAS" k="roasPct" num />
              <TH label={<>현재 CPC<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(+VAT)</span></>} k="currentCpcVatIncl" num minWidth={100} />
              <TH label="광고비 (+VAT)" k="adCostVat" num />
              <TH label="광고 매출" k="revenue" num />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const roasClass =
                r.roasPct == null || r.bepPct == null ? '' :
                r.roasPct < r.bepPct ? 'text-bad' :
                r.roasPct < r.bepPct * 1.2 ? 'text-warn' : 'text-good'
              return (
                <tr key={r.keyword}>
                  <td className="sticky-left"><input type="checkbox" checked={checked.has(r.keyword)} onChange={() => onToggle(r.keyword)} /></td>
                  <td><strong>{r.keyword}</strong></td>
                  <td className="num">{fmtNum(r.impressions)}</td>
                  <td className="num">{fmtNum(r.clicks)}</td>
                  <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
                  <td className="num">{fmtNum(r.orders)}</td>
                  <td className="num">{fmtPctVal(r.cvrPct, 2)}</td>
                  <td className={`num ${roasClass}`}>{fmtRoas(r.roasPct)}</td>
                  <td className={`num ${currentCpcColorClass(r)}`}>{r.currentCpcVatIncl != null ? `${Math.round(r.currentCpcVatIncl).toLocaleString('ko-KR')}원` : '—'}</td>
                  <td className="num">{fmtNum(r.adCostVat)}</td>
                  <td className="num">{fmtNum(r.revenue)}</td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={11} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>비검색 키워드 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── xlsx export 헬퍼 ──────────────────────────────────────────
function exportXlsx(data: Record<string, any>[], filename: string, sheetName: string) {
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  XLSX.writeFile(wb, filename)
}
function sanitizeFile(s: string): string {
  return (s || 'unnamed').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80)
}

function ActionLegend() {
  return (
    <div style={{ fontSize: 11.5, color: '#64748B', padding: '10px 12px', background: '#F8FAFC', borderRadius: 6, lineHeight: 1.7, marginTop: 8 }}>
      <strong style={{ color: '#1F2937' }}>추천 액션 기준 (클릭 기준 6단):</strong>
      <br /><span style={{ color: '#1F2937', fontWeight: 600 }}>클릭 &lt; 20 (모수 쌓는 중)</span>
      <br />• <span className="aa-action-chip action-growing">⭐ 성장 중</span> ROAS ≥ BEP — AI 캠페인에서 모수 쌓는 중 (참고용 입찰가)
      <br />• <span className="aa-action-chip action-low-sample">모수 부족</span> 그 외 — 입찰가 노출 안 함
      <br /><span style={{ color: '#1F2937', fontWeight: 600 }}>클릭 ≥ 20 (판단 가능)</span>
      <br />• <span className="aa-action-chip action-enhance">강화</span> ROAS ≥ BEP × 2
      <br />• <span className="aa-action-chip action-maintain">유지</span> BEP ≤ ROAS &lt; BEP × 2
      <br />• <span className="aa-action-chip action-lower-bid">입찰가 ↓</span> 0 &lt; ROAS &lt; BEP — 매출 역산값으로 인하
      <br />• <span className="aa-action-chip action-exclude">🚫 제외</span> ROAS = 0 — 입찰가 100원 강제
      <br /><br />
      <strong style={{ color: '#1F2937' }}>추천 입찰가 공식 (매출 역산):</strong> 매출 ÷ (클릭수 × BEP × 1.05 × 1.1) = 매출 ÷ (클릭수 × BEP × 1.155){' '}
      <span style={{ fontSize: 11 }}>— BEP 대비 5% 여유 / VAT 별도 = 쿠팡 광고센터 입력값</span>
    </div>
  )
}

// ── Manual Section ────────────────────────────────────────────
function ManualSection({ campaign, master, periodLabel, selectedOptionId, onClearOption, onClose }: {
  campaign: CampaignDiag
  master: any
  periodLabel: string
  selectedOptionId: string | null
  onClearOption: () => void
  onClose: () => void
}) {
  const bepMap = useMemo(() => buildBepMap(master), [master])
  const priceMap = useMemo(() => buildActualPriceMapById(master), [master])
  const rowMap = useMemo(() => buildMarginRowMap(master), [master])
  const exposureMap = useMemo(() => buildExposureMapByOptionId(master), [master])
  const options = useMemo(() => computeOptions(campaign.rows, bepMap, priceMap, rowMap, exposureMap), [campaign.rows, bepMap, priceMap, rowMap, exposureMap])

  const filteredCampaign = useMemo(() => {
    if (!selectedOptionId) return campaign
    return { ...campaign, rows: campaign.rows.filter((r) => String(r.adOptionId || '').trim() === selectedOptionId) }
  }, [campaign, selectedOptionId])
  const selectedOptionName = selectedOptionId
    ? (options.find((o) => o.optionId === selectedOptionId)?.optionName ?? selectedOptionId)
    : null

  const [bidByKeyword, setBidByKeyword] = useState<Map<string, number>>(new Map())
  const rows = useMemo(() => buildManualReviewRows(filteredCampaign, bepMap, priceMap, bidByKeyword, exposureMap), [filteredCampaign, bepMap, priceMap, bidByKeyword, exposureMap])
  const { sorted, key, dir, toggle } = useSort(rows, 'recommendedBidVatExcl' as keyof ManualKeywordRow, 'desc')

  const TH = ({ label, k, num, minWidth, sticky, sticky2 }: any) => (
    <th
      className={[
        'sortable', num ? 'num' : '',
        sticky ? 'sticky-left' : '',
        sticky2 ? 'sticky-left-2' : '',
        key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
      ].filter(Boolean).join(' ')}
      style={minWidth ? { minWidth } : undefined}
      onClick={() => toggle(k)}
    >{label}</th>
  )

  function setBid(kw: string, value: string) {
    const n = Number(value.replace(/[^\d]/g, ''))
    setBidByKeyword((prev) => {
      const next = new Map(prev)
      if (Number.isFinite(n) && n > 0) next.set(kw, n)
      else next.delete(kw)
      return next
    })
  }

  const [checked, setChecked] = useState<Set<string>>(new Set())
  function onToggle(kw: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(kw)) next.delete(kw); else next.add(kw)
      return next
    })
  }
  const allChecked = sorted.length > 0 && sorted.every((r) => checked.has(r.keyword))
  function onToggleAll() {
    setChecked((prev) => {
      if (sorted.every((r) => prev.has(r.keyword))) return new Set()
      const next = new Set(prev)
      for (const r of sorted) next.add(r.keyword)
      return next
    })
  }

  const VERDICT_LABEL: Record<ManualKeywordRow['bidVerdict'], string> = {
    ok: '🟢 여유',
    high: '🟡 살짝 높음',
    too_high: '🔴 너무 높음',
    unknown: '⚪ 평가 보류',
  }

  function exportRows(scope: 'all' | 'selected') {
    const target = scope === 'selected' ? sorted.filter((r) => checked.has(r.keyword)) : sorted
    if (target.length === 0) {
      alert(scope === 'selected' ? '선택된 키워드가 없습니다.' : '내보낼 키워드가 없습니다.')
      return
    }
    const data = target.map((r) => {
      const effective = r.currentBidVatExcl ?? r.avgCpcVatExcl
      const stars = r.confidence === 3 ? '⭐⭐⭐' : r.confidence === 2 ? '⭐⭐' : '⭐'
      return {
        '키워드': r.keyword,
        '추천 입찰가 (5% 안전마진, VAT 별도)':
          r.bidSource === 'low_sample' || r.recommendedBidVatExcl == null
            ? null
            : r.bidSource === 'fixed_100'
              ? 100
              : ceilToTen(r.recommendedBidVatExcl),
        '노출': r.impressions,
        '클릭': r.clicks,
        '클릭율(%)': r.ctrPct,
        '광고 판매수': r.orders,
        '전환율(%)': r.cvrPct,
        'ROAS(%)': r.roasPct,
        '현재 CPC (+VAT)': r.currentCpcVatIncl,
        '광고비 (+VAT)': r.adCostVat,
        '광고 매출': r.revenue,
        '현재 입찰가 (VAT 별도)': effective,
        '차이': r.bidDiff != null ? Math.round(r.bidDiff) : null,
        '신뢰도': stars,
        '점검': VERDICT_LABEL[r.bidVerdict],
      }
    })
    const fileLabel = selectedOptionName ? selectedOptionName : campaign.campaignName
    const filename = `광고분석_수동키워드_${sanitizeFile(fileLabel)}_${periodLabel}.xlsx`
    exportXlsx(data, filename, '수동키워드')
  }

  return (
    <div className="aa-section" style={{ border: '2px solid #A855F7' }}>
      <div className="aa-section-header" style={{ background: '#FAF5FF' }}>
        <div>
          <div className="aa-section-title">▼ {campaign.campaignName} · 입찰가 점검</div>
          <div className="aa-section-desc">현재 입찰가 = 광고비/클릭수 (평균 CPC, VAT 별도) · 편집 가능</div>
        </div>
        <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
      </div>
      <div className="aa-section-body">
        {selectedOptionName && <FilterChip label={selectedOptionName} onClear={onClearOption} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >⬇ 전체 다운로드</button>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('selected')}
            disabled={checked.size === 0}
            style={{ fontSize: 11, padding: '4px 10px', opacity: checked.size === 0 ? 0.5 : 1 }}
          >⬇ 선택 다운로드 ({checked.size})</button>
        </div>
        <div className="aa-table-wrap shorter">
          <table>
            <thead>
              <tr>
                <th className="sticky-left" style={{ width: 32 }}>
                  <input type="checkbox" checked={allChecked} onChange={onToggleAll} aria-label="전체 선택" />
                </th>
                <TH label="키워드" k="keyword" sticky2 minWidth={140} />
                <TH label="노출" k="impressions" num />
                <TH label="클릭" k="clicks" num />
                <TH label="클릭율" k="ctrPct" num />
                <TH label="광고 판매수" k="orders" num />
                <TH label="전환율" k="cvrPct" num />
                <TH label="매출" k="revenue" num />
                <TH label={<>광고비<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(VAT 별도)</span></>} k="adCostSum" num />
                <TH label="ROAS" k="roas" num />
                <th className="num">현재 입찰가<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(VAT 별도)</span></th>
                <TH label={<>추천 입찰가<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(이대로 입력 · 5% 안전마진 · VAT 별도)</span></>} k="recommendedBidVatExcl" num minWidth={170} />
                <TH label="차이" k="bidDiff" num />
                <th>신뢰도</th>
                <th>점검</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <ManualKeywordRowComp
                  key={r.keyword}
                  r={r}
                  checked={checked.has(r.keyword)}
                  onToggle={() => onToggle(r.keyword)}
                  onChangeBid={setBid}
                />
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={15} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>검색 키워드 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12, padding: '12px 14px', background: '#F8FAFC', borderRadius: 6, fontSize: 12, color: '#64748B', lineHeight: 1.7 }}>
          <strong style={{ color: '#1F2937' }}>💡 점검 기준:</strong>
          <br />• <span className="aa-badge badge-good">🟢 여유</span> 현재 ≤ 추천
          <br />• <span className="aa-badge badge-warn">🟡 살짝 높음</span> 추천 &lt; 현재 ≤ 추천 × 1.5
          <br />• <span className="aa-badge badge-bad">🔴 너무 높음</span> 현재 &gt; 추천 × 1.5
          <br />• <span className="aa-badge badge-unsorted">⚪ 평가 보류</span> 클릭 20건 미만
          <br /><strong style={{ color: '#1F2937' }}>신뢰도:</strong> ⭐⭐⭐ 50건+ / ⭐⭐ 20~49건 / ⭐ &lt;20건
        </div>
      </div>
    </div>
  )
}

function ManualKeywordRowComp({ r, checked, onToggle, onChangeBid }: { r: ManualKeywordRow; checked: boolean; onToggle: () => void; onChangeBid: (k: string, v: string) => void }) {
  const stars = r.confidence === 3 ? '⭐⭐⭐' : r.confidence === 2 ? '⭐⭐' : '⭐'
  const starsClass = r.confidence === 3 ? 'high' : r.confidence === 2 ? 'mid' : 'low'

  const verdictBadge =
    r.bidVerdict === 'ok' ? <span className="aa-badge badge-good">🟢 여유</span> :
    r.bidVerdict === 'high' ? <span className="aa-badge badge-warn">🟡 살짝 높음</span> :
    r.bidVerdict === 'too_high' ? <span className="aa-badge badge-bad">🔴 너무 높음</span> :
    <span className="aa-badge badge-unsorted">⚪ 평가 보류</span>

  const diffClass = r.bidDiff != null ? (r.bidDiff >= 0 ? 'text-good' : 'text-bad') : ''
  const isLowClick = r.clicks < 20

  // ROAS 색상: BEP 미산정/매출 0 → 회색 "—". ≥ BEP 녹 · ≥ BEP×0.7 노 · 그 외 빨.
  const roasShow = r.bepRoas != null && r.revenue > 0 && r.roas != null
  const roasClass = roasShow
    ? (r.roas! >= r.bepRoas! ? 'text-good'
      : r.roas! >= r.bepRoas! * 0.7 ? 'text-warn'
      : 'text-bad')
    : 'text-muted'
  const roasTitle = r.bepRoas != null ? `BEP ${Math.round(r.bepRoas)}%` : undefined

  return (
    <tr style={isLowClick ? { opacity: 0.6 } : undefined}>
      <td className="sticky-left"><input type="checkbox" checked={checked} onChange={onToggle} /></td>
      <td className="sticky-left-2"><strong>{r.keyword}</strong></td>
      <td className="num">{fmtNum(r.impressions)}</td>
      <td className="num">{fmtNum(r.clicks)}</td>
      <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
      <td className="num">{fmtNum(r.orders)}</td>
      <td className="num">{fmtPctVal(r.cvrPct, 2)}</td>
      <td className="num">{fmtNum(r.revenue)}</td>
      <td className="num">{fmtNum(r.adCostSum)}</td>
      <td className={`num ${roasClass}`} title={roasTitle}>{roasShow ? fmtRoas(r.roas) : '—'}</td>
      <td className="num">
        <input
          key={`${r.keyword}|${r.avgCpcVatExcl ?? ''}`}
          type="text"
          inputMode="numeric"
          placeholder={r.avgCpcVatExcl != null ? r.avgCpcVatExcl.toLocaleString('ko-KR') : '—'}
          defaultValue={r.currentBidVatExcl ?? r.avgCpcVatExcl ?? ''}
          onBlur={(e) => onChangeBid(r.keyword, e.target.value)}
          title="평균 CPC = 광고비/클릭수 (VAT 별도) · 비우면 자동값으로 복귀"
          style={{ width: 64, textAlign: 'right', padding: '2px 6px', border: '1px solid #E2E8F0', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
        />
      </td>
      <td className="num">
        {r.recommendedBidVatExcl != null
          ? <span className="bid-recommend">{Math.round(r.recommendedBidVatExcl).toLocaleString('ko-KR')}</span>
          : <span className="text-muted">데이터 부족</span>}
      </td>
      <td className={`num ${diffClass}`}>{r.bidDiff != null ? `${r.bidDiff > 0 ? '+' : ''}${Math.round(r.bidDiff).toLocaleString('ko-KR')}` : '—'}</td>
      <td><span className={`aa-stars ${starsClass}`}>{stars}</span></td>
      <td>{verdictBadge}</td>
    </tr>
  )
}

// ── Inline styles (가안 v3 CSS 차용) ───────────────────────────
function Style() {
  return (
    <style jsx global>{`
      .aa-page-header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #E2E8F0; }
      .aa-title { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
      .aa-desc { color: #64748B; font-size: 13px; margin-top: 4px; }
      .mono { font-family: 'JetBrains Mono', monospace; }
      .aa-vat-tag { display: inline-block; font-size: 10px; background: #F1F5F9; color: #94A3B8; padding: 1px 5px; border-radius: 3px; font-weight: 500; }
      .aa-section { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
      .aa-section-header { padding: 16px 20px; border-bottom: 1px solid #E2E8F0; display: flex; justify-content: space-between; align-items: center; }
      .aa-section-title { font-size: 15px; font-weight: 600; }
      .aa-section-desc { font-size: 12px; color: #64748B; margin-top: 2px; }
      .aa-section-body { padding: 16px 20px; }
      .aa-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
      .aa-kpi-card { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px 18px; }
      .aa-kpi-label { font-size: 12px; color: #64748B; margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
      .aa-kpi-value { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; font-family: 'JetBrains Mono', monospace; }
      .aa-kpi-sub { font-size: 11px; color: #94A3B8; margin-top: 4px; }
      .aa-period-bar { display: flex; gap: 4px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 3px; width: fit-content; }
      .aa-period-btn { padding: 6px 12px; border: none; background: transparent; color: #64748B; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 500; }
      .aa-period-btn.active { background: #FFFFFF; color: #1F2937; box-shadow: 0 0 0 1px #E2E8F0; }
      .aa-table-wrap { position: relative; overflow: auto; max-height: 480px; border-top: 1px solid #E2E8F0; }
      .aa-table-wrap.shorter { max-height: 380px; }
      .aa-table-wrap table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
      .aa-table-wrap thead th { position: sticky; top: 0; z-index: 3; background: #F8FAFC; }
      .aa-table-wrap th.sticky-left, .aa-table-wrap td.sticky-left { position: sticky; left: 0; background: #FFFFFF; z-index: 1; border-right: 1px solid #E2E8F0; }
      .aa-table-wrap thead th.sticky-left { z-index: 4; background: #F8FAFC; }
      .aa-table-wrap tr.selected td.sticky-left, .aa-table-wrap tr:hover td.sticky-left { background: #FFF7ED; }
      .aa-table-wrap th.sticky-left-2, .aa-table-wrap td.sticky-left-2 { position: sticky; left: 36px; background: #FFFFFF; z-index: 1; border-right: 1px solid #E2E8F0; }
      .aa-table-wrap thead th.sticky-left-2 { z-index: 4; background: #F8FAFC; }
      .aa-table-wrap tr:hover td.sticky-left-2 { background: #FFF7ED; }
      .aa-table-wrap th { text-align: left; padding: 10px 14px; color: #64748B; font-weight: 500; font-size: 11.5px; border-bottom: 1px solid #E2E8F0; white-space: nowrap; user-select: none; }
      .aa-table-wrap th.sortable { cursor: pointer; }
      .aa-table-wrap th.sortable::after { content: ' ⇅'; font-size: 9px; opacity: 0.4; }
      .aa-table-wrap th.sorted-asc::after { content: ' ↑'; opacity: 1; color: #FF6B35; }
      .aa-table-wrap th.sorted-desc::after { content: ' ↓'; opacity: 1; color: #FF6B35; }
      .aa-table-wrap td { padding: 12px 14px; border-bottom: 1px solid #E2E8F0; white-space: nowrap; }
      .aa-table-wrap tr:last-child td { border-bottom: none; }
      .aa-table-wrap tr.clickable { cursor: pointer; }
      .aa-table-wrap tr.clickable:hover td { background: #FFF7ED; }
      .aa-table-wrap tr.selected td { background: #FFF7ED; }
      .aa-table-wrap td.num, .aa-table-wrap th.num { text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }
      .text-good { color: #10B981; font-weight: 600; }
      .text-bad { color: #EF4444; font-weight: 600; }
      .text-warn { color: #F59E0B; font-weight: 600; }
      .text-muted { color: #94A3B8; }
      .aa-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
      .aa-badge.badge-ai { background: #EFF6FF; color: #3B82F6; }
      .aa-badge.badge-manual { background: #FDF4FF; color: #A855F7; }
      .aa-badge.badge-unsorted { background: #F3F4F6; color: #94A3B8; }
      .aa-badge.badge-good { background: #D1FAE5; color: #065F46; }
      .aa-badge.badge-warn { background: #FEF3C7; color: #92400E; }
      .aa-badge.badge-bad { background: #FEE2E2; color: #991B1B; }
      .aa-badge.badge-info { background: #DBEAFE; color: #1E40AF; }
      .aa-search-bar { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-family: 'JetBrains Mono', monospace; }
      .aa-search-bar-bg { width: 70px; height: 6px; background: #DBEAFE; border-radius: 3px; position: relative; overflow: hidden; }
      .aa-search-bar-fill { height: 100%; background: #3B82F6; border-radius: 3px; }
      .aa-action-chip { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; white-space: nowrap; }
      .aa-action-chip.action-exclude { background: #FEE2E2; color: #991B1B; }
      .aa-action-chip.action-growing { background: #D1FAE5; color: #065F46; }
      .aa-action-chip.action-enhance { background: #D1FAE5; color: #065F46; }
      .aa-action-chip.action-maintain { background: #F1F5F9; color: #475569; }
      .aa-action-chip.action-lower-bid { background: #FFEDD5; color: #9A3412; }
      .aa-action-chip.action-low-sample { background: #F3F4F6; color: #6B7280; }
      .aa-btn { padding: 8px 14px; border: 1px solid #E2E8F0; background: #FFFFFF; color: #1F2937; border-radius: 6px; font-size: 13px; cursor: pointer; font-family: inherit; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
      .aa-btn:hover { background: #F8FAFC; }
      .aa-btn.btn-sm { padding: 5px 10px; font-size: 12px; }
      .aa-btn.btn-bad { background: #EF4444; border-color: #EF4444; color: white; }
      .aa-btn.btn-info { background: #3B82F6; border-color: #3B82F6; color: white; }
      .aa-sub-section { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 14px 16px; margin-bottom: 12px; }
      .aa-sub-section-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
      .aa-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
      .aa-metric-box { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 6px; padding: 12px 14px; }
      .aa-metric-box.search { border-left: 3px solid #3B82F6; }
      .aa-metric-box.nonsearch { border-left: 3px solid #A855F7; }
      .aa-metric-box-label { font-size: 11px; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
      .aa-metric-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12.5px; }
      .bid-recommend { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 13.5px; color: #FF6B35; }
      .bid-vat-incl { display: block; font-size: 9.5px; color: #94A3B8; font-family: 'JetBrains Mono', monospace; margin-top: 1px; font-weight: 400; }
      .aa-bulk-action { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 6px; margin-top: 12px; font-size: 12.5px; }
      .aa-hint-banner { background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #1E40AF; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
      .aa-stars { font-size: 12px; letter-spacing: 1px; }
      .aa-stars.high { color: #F59E0B; }
      .aa-stars.mid { color: #FCD34D; }
      .aa-stars.low { color: #94A3B8; }
      .aa-kpi-value.text-bad { color: #EF4444; }
      .aa-expand-toggle { display: inline-block; width: 18px; color: #94A3B8; font-size: 12px; cursor: pointer; user-select: none; margin-right: 4px; }
      .aa-expand-toggle:hover { color: #FF6B35; }
      .aa-table-wrap tr.aa-option-row td { background: #F8FAFC; font-size: 12.5px; padding: 8px 14px; }
      .aa-table-wrap tr.aa-option-row.clickable:hover td { background: #FEF3C7; }
      .aa-table-wrap tr.aa-option-row.option-selected td { background: #DBEAFE; }
      .aa-table-wrap tr.aa-option-row.option-selected td.sticky-left { background: #DBEAFE; border-left: 3px solid #3B82F6; }
      .aa-option-cell { padding-left: 36px !important; }
      .aa-option-prefix { color: #CBD5E1; margin-right: 6px; font-size: 11px; }
      .aa-option-text { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .aa-option-alias { color: #1E40AF; font-weight: 600; font-size: 12.5px; }
      .aa-option-name { color: #475569; font-size: 12px; }
      .aa-table-wrap tr.aa-keyword-option-row td.aa-keyword-option-cell { background: #F8FAFC; padding: 8px 14px 8px 56px; border-bottom: 1px solid #E2E8F0; }
      .aa-keyword-option-flex { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; font-size: 12px; }
      .aa-kw-opt-metric { color: #475569; }
      .aa-kw-opt-metric strong { color: #1F2937; }
    `}</style>
  )
}
