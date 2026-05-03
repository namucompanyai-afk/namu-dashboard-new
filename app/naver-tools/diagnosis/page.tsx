'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useNaverStore, type NaverSnapshotMeta } from '@/lib/naver/store'
import { parseNaverSettlement } from '@/lib/naver/parsers/settlement'
import {
  computeAliasTrend,
  computeNaverDiagnosis,
  type NaverAliasTrendPoint,
  type NaverManualInput,
} from '@/lib/naver/diagnosis'
import type { NaverSettlementData, NaverSettlementRow } from '@/lib/naver/parsers/settlement'
import KpiCard from '@/components/pnl/KpiCard'
import { formatKRW, formatMan } from '@/components/pnl/format'

/** 원 단위 그대로 (음수 보존). 1만 미만 또는 정확한 값 표시 필요할 때 사용. */
function fmtKRW(n: number): string {
  const sign = n < 0 ? '-' : ''
  return sign + formatKRW(Math.abs(n))
}

/** KPI 카드용 만 단위 표기 (음수 부호 보존). 0원 → '0만'. */
function fmtMan(n: number): string {
  if (n === 0) return '0만'
  return n < 0 ? '-' + formatMan(-n) : formatMan(n)
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%'
}

/** "YYYY-MM-DD ~ YYYY-MM-DD (N일)" — 헤더 상세 표시용 */
function fmtPeriodWithDays(start: string, end: string): string {
  if (!start || !end) return '—'
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
  return `${start} ~ ${end} (${days}일)`
}

/** "2026-01-01 ~ 01-31" — 앞 YYYY-MM-DD 풀, 뒤는 같은 연·월일 때 MM-DD 만 */
function fmtPeriodCompact(start: string, end: string): string {
  if (!start || !end) return '—'
  const [sy, sm] = start.split('-')
  const [ey, em, ed] = end.split('-')
  if (sy === ey && sm === em) return `${start} ~ ${ed}`
  if (sy === ey) return `${start} ~ ${em}-${ed}`
  return `${start} ~ ${end}`
}

/** YYYY-MM 의 1일/말일 반환 ("2026-01" → ["2026-01-01","2026-01-31"]) */
function monthRange(monthKey: string): { start: string; end: string } | null {
  const m = monthKey.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const lastDay = new Date(y, mo, 0).getDate() // mo는 1-base, 0일 = 전월 말일 = 해당월 말일
  const start = `${m[1]}-${m[2]}-01`
  const end = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}`
  return { start, end }
}

/** weekKey + 6일 = 토요일 */
function weekRange(weekKey: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return null
  const d = new Date(weekKey)
  if (!Number.isFinite(d.getTime())) return null
  d.setDate(d.getDate() + 6)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return { start: weekKey, end: `${y}-${m}-${day}` }
}

/** 헤더 기간 표기 — frozen view 의 trendType 에 따라 분기 */
function fmtPeriodSmart(
  loaded: { trendType?: 'weekly' | 'monthly' | null; monthKey?: string | null; weekKey?: string | null } | null,
  fallback: { start: string; end: string },
): string {
  if (loaded?.trendType === 'monthly' && loaded.monthKey) {
    const r = monthRange(loaded.monthKey)
    if (r) return fmtPeriodCompact(r.start, r.end)
  }
  if (loaded?.trendType === 'weekly' && loaded.weekKey) {
    const r = weekRange(loaded.weekKey)
    if (r) return fmtPeriodCompact(r.start, r.end)
  }
  return fmtPeriodWithDays(fallback.start, fallback.end)
}

/** 짧은 기간 표기 (KPI 카드 1줄 유지)
 *   같은 월: "MM-DD ~ DD"  (연도 생략)
 *   같은 연도 다른 월: "MM-DD ~ MM-DD"
 *   다른 연도: "YYYY-MM-DD ~ YYYY-MM-DD"
 */
function fmtPeriod(start: string, end: string): string {
  if (!start || !end) return start || end || '—'
  if (start === end) return start.slice(5)
  const [sy, sm, sd] = start.split('-')
  const [ey, em, ed] = end.split('-')
  if (sy === ey && sm === em) return `${sm}-${sd} ~ ${ed}`
  if (sy === ey) return `${sm}-${sd} ~ ${em}-${ed}`
  return `${start} ~ ${end}`
}

/** 정수 → 한글 금액 표기 ("3,600,000" → "삼백육십만원"). 0/빈값은 ''. */
function numToKorean(n: number): string {
  if (!n || !Number.isFinite(n)) return ''
  const abs = Math.floor(Math.abs(n))
  if (abs === 0) return ''
  const numStr = abs.toString()
  if (numStr.length > 16) return ''
  const units = ['', '만', '억', '조']
  const digits = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']
  const positions = ['', '십', '백', '천']

  const chunks: string[] = []
  let s = numStr
  while (s.length > 0) {
    chunks.unshift(s.slice(-4))
    s = s.slice(0, -4)
  }

  let result = ''
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const unitIdx = chunks.length - 1 - ci
    let chunkStr = ''
    for (let i = 0; i < chunk.length; i++) {
      const digit = parseInt(chunk[i], 10)
      const pos = chunk.length - 1 - i
      if (digit === 0) continue
      if (digit === 1 && pos > 0) chunkStr += positions[pos]
      else chunkStr += digits[digit] + positions[pos]
    }
    if (chunkStr) result += chunkStr + units[unitIdx]
  }
  return (n < 0 ? '-' : '') + result + '원'
}

export default function NaverDiagnosisPage() {
  const {
    settlement,
    productMatch,
    marginMap,
    manual,
    diagnosis,
    marginLoading,
    marginMissing,
    snapshots,
    marginSavedAt,
    setSettlement,
    setManual,
    loadFromApi,
    saveLast,
    saveExplicit,
    loadList,
    purgeAll,
    deleteSnapshot,
  } = useNaverStore()

  // ── frozen view (저장된 분석 보기) ──
  const [loadedSnapshot, setLoadedSnapshot] = useState<NaverSnapshotMeta | null>(null)
  const exitSnapshotView = () => setLoadedSnapshot(null)

  // raw 가 있는 snapshot + 현재 마진마스터 결합 → frozen view 재계산
  const recomputedFromSnapshot = useMemo(() => {
    if (!loadedSnapshot) return null
    const raw = (loadedSnapshot as unknown as {
      raw?: {
        settlementRows?: NaverSettlementRow[]
        manual?: NaverManualInput
        cpmConfig?: { unitPrice: number; baseDays: number }
        marginFingerprint?: string
        fileName?: string
      }
    }).raw
    if (!raw?.settlementRows || raw.settlementRows.length === 0) return null
    if (!productMatch || !marginMap) return null
    if (!raw.manual) return null

    const rows = raw.settlementRows
    const minD = rows.reduce((m, r) => (!m || r.settleDate < m ? r.settleDate : m), '')
    const maxD = rows.reduce((m, r) => (!m || r.settleDate > m ? r.settleDate : m), '')
    const subSettlement: NaverSettlementData = {
      rows,
      dateRange: minD && maxD ? { min: minD, max: maxD } : null,
      totalRevenue: rows
        .filter((r) => r.kind === '상품주문')
        .reduce((s, r) => s + r.basePrice, 0),
      totalFee: rows
        .filter((r) => r.kind === '상품주문')
        .reduce((s, r) => s + r.feeSum, 0),
      shipRevenue: rows
        .filter((r) => r.kind === '배송비')
        .reduce((s, r) => s + r.basePrice, 0),
      shipFee: rows
        .filter((r) => r.kind === '배송비')
        .reduce((s, r) => s + r.feeSum, 0),
      productOrderCount: rows.filter((r) => r.kind === '상품주문').length,
    }

    try {
      return computeNaverDiagnosis(subSettlement, productMatch, marginMap, raw.manual)
    } catch (e) {
      console.warn('frozen view 재계산 실패:', e)
      return null
    }
  }, [loadedSnapshot, productMatch, marginMap])

  const fingerprintMismatch =
    !!loadedSnapshot &&
    !!recomputedFromSnapshot &&
    !!marginSavedAt &&
    !!(loadedSnapshot as unknown as { raw?: { marginFingerprint?: string } }).raw?.marginFingerprint &&
    (loadedSnapshot as unknown as { raw?: { marginFingerprint?: string } }).raw!.marginFingerprint !==
      marginSavedAt

  // KPI/표 표시용 — loaded 우선, 없으면 라이브
  const displayDiagnosis = useMemo(() => {
    // raw + 현재 마진마스터 결합 재계산 결과 우선 (마진마스터 변경 자동 반영)
    if (recomputedFromSnapshot) {
      return {
        ...recomputedFromSnapshot,
        _productOrderCount: recomputedFromSnapshot.products.reduce((s, p) => s + p.count, 0),
      }
    }
    if (loadedSnapshot?.summary) {
      const s = loadedSnapshot.summary as unknown as {
        revenue: number
        settleAmount: number
        settleFee: number
        cost: number
        bag: number
        box: number
        pack: number
        shipReal: number
        shipRevenue: number
        adCost: number
        netProfit: number
        productOrderCount: number
        matched: number
        unmatched: number
        unmatchedRevenue?: number
      }
      const products =
        ((loadedSnapshot as unknown as { products?: Array<{
          productName: string
          alias?: string
          count: number
          revenue: number
          cost: number
          profit: number
          matched: boolean
        }> }).products) ?? []
      return {
        period: loadedSnapshot.period ?? { start: '', end: '' },
        revenue: s.revenue ?? 0,
        settleAmount: s.settleAmount ?? 0,
        settleFee: s.settleFee ?? 0,
        cost: s.cost ?? 0,
        bag: s.bag ?? 0,
        box: s.box ?? 0,
        pack: s.pack ?? 0,
        shipReal: s.shipReal ?? 0,
        shipRevenue: s.shipRevenue ?? 0,
        adCost: s.adCost ?? 0,
        netProfit: s.netProfit ?? 0,
        productCount: products.length,
        matched: s.matched ?? 0,
        unmatched: s.unmatched ?? 0,
        unmatchedRevenue: s.unmatchedRevenue ?? 0,
        products,
        _productOrderCount: s.productOrderCount ?? 0,
      }
    }
    if (!diagnosis) return null
    return {
      ...diagnosis,
      _productOrderCount: settlement?.productOrderCount ?? 0,
    }
  }, [recomputedFromSnapshot, loadedSnapshot, diagnosis, settlement])

  // 히스토리 패널
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)

  const handleLoadAnalysis = async (a: NaverSnapshotMeta) => {
    if (!a.id) return
    try {
      const res = await fetch(`/api/naver-diagnoses?type=item&id=${encodeURIComponent(a.id)}`)
      const full = await res.json()
      if (full) {
        setLoadedSnapshot(full)
        setShowHistoryPanel(false)
      }
    } catch (e) {
      console.warn('분석 불러오기 실패:', e)
    }
  }

  const handleDeleteAnalysis = async (id?: string) => {
    if (!id) return
    if (!confirm('이 분석을 삭제하시겠습니까?')) return
    await deleteSnapshot(id)
    if (loadedSnapshot?.id === id) setLoadedSnapshot(null)
  }

  const settleInputRef = useRef<HTMLInputElement>(null)

  const [settleFile, setSettleFile] = useState<string>('')
  const [parseError, setParseError] = useState<string>('')

  useEffect(() => {
    loadFromApi()
    loadList()
  }, [loadFromApi, loadList])

  // 페이지 마운트 시 가장 최근 저장 분석을 frozen view 로 자동 로드 (정산파일 없을 때만)
  const autoLoadedRef = useRef(false)
  useEffect(() => {
    if (autoLoadedRef.current) return
    if (settlement) {
      autoLoadedRef.current = true
      return
    }
    if (loadedSnapshot) {
      autoLoadedRef.current = true
      return
    }
    if (!snapshots || snapshots.length === 0) return

    const sorted = [...snapshots]
      .filter((a) => a.period?.end || a.weekKey || a.monthKey)
      .sort((a, b) => {
        const ka = a.period?.end || a.weekKey || a.monthKey || ''
        const kb = b.period?.end || b.weekKey || b.monthKey || ''
        return kb.localeCompare(ka)
      })
    const latest = sorted[0]
    if (!latest?.id) return

    autoLoadedRef.current = true
    handleLoadAnalysis(latest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots])

  // 자동 저장 (1초 debounce)
  useEffect(() => {
    if (!diagnosis) return
    const t = setTimeout(() => {
      saveLast()
    }, 1000)
    return () => clearTimeout(t)
  }, [diagnosis, saveLast])


  const onResetAll = async () => {
    if (!confirm('정말 모든 분석을 초기화하시겠습니까?\n저장된 분석도 모두 삭제됩니다 (마진마스터는 유지).')) return
    await purgeAll()
  }

  // 명시 저장 다이얼로그 (쿠팡 패턴 미러링)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')
  const [includeInTrend, setIncludeInTrend] = useState(false)
  const [trendType, setTrendType] = useState<'weekly' | 'monthly' | null>(null)
  const [savingExplicit, setSavingExplicit] = useState(false)

  const periodDays = (() => {
    const s = diagnosis?.period.start
    const e = diagnosis?.period.end
    if (!s || !e) return 0
    return Math.round((Date.parse(e) - Date.parse(s)) / 86400000) + 1
  })()

  const handleOpenSaveDialog = () => {
    if (!diagnosis) return
    const start = diagnosis.period.start
    const end = diagnosis.period.end
    if (!start || !end) return
    const endDate = new Date(end)
    const yyyy = endDate.getFullYear()
    const mm = endDate.getMonth() + 1
    const days = periodDays

    if (days >= 6 && days <= 8) {
      setTrendType('weekly')
      setIncludeInTrend(true)
      setSaveLabel(`주별: ${start} ~ ${end} (${days}일)`)
    } else if (days >= 28 && days <= 31) {
      setTrendType('monthly')
      setIncludeInTrend(true)
      setSaveLabel(`${yyyy}년 ${mm}월 진단 (${start} ~ ${end})`)
    } else {
      setTrendType(null)
      setIncludeInTrend(false)
      setSaveLabel(`${days}일치 분석 (${start} ~ ${end})`)
    }
    setShowSaveDialog(true)
  }

  const handleSaveExplicit = async () => {
    if (!diagnosis) return
    const start = diagnosis.period.start
    const end = diagnosis.period.end
    if (!start || !end) return

    setSavingExplicit(true)
    try {
      const endDate = new Date(end)
      const monthKey =
        includeInTrend && trendType === 'monthly'
          ? `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`
          : null
      const weekKey = includeInTrend && trendType === 'weekly' ? start : null

      // 같은 키 있으면 id 재사용 (덮어쓰기)
      const existing = snapshots.find(
        (s) =>
          (includeInTrend && trendType === 'monthly' && s.monthKey === monthKey) ||
          (includeInTrend && trendType === 'weekly' && s.weekKey === weekKey),
      )

      const id = await saveExplicit(saveLabel, {
        monthKey,
        weekKey,
        trendType: includeInTrend ? trendType : null,
        includeInTrend,
        id: existing?.id,
      })
      if (id) {
        setShowSaveDialog(false)
        setSaveLabel('')
      }
    } finally {
      setSavingExplicit(false)
    }
  }

  // 수기 입력 폼 로컬 상태 (저장 버튼 누를 때만 store에 반영)
  const cpmConfig = useNaverStore((s) => s.cpmConfig)
  const [cpmCountDraft, setCpmCountDraft] = useState<string>('')
  const [cpmDaysDraft, setCpmDaysDraft] = useState<string>('')
  const [shipDraft, setShipDraft] = useState<{
    s: { unit: string; count: string }
    m: { unit: string; count: string }
    l: { unit: string; count: string }
  }>({
    s: { unit: '', count: '' },
    m: { unit: '', count: '' },
    l: { unit: '', count: '' },
  })

  // CPM 운영일수 디폴트 (1주일 = 7일 고정)
  const DEFAULT_CPM_DAYS = 7

  React.useEffect(() => {
    // 0/빈값은 ''로 둬서 화면에 빈칸으로 표시. 단가는 0이어도 그대로(고정 디폴트).
    const blankIfZero = (n: number) => (n ? String(n) : '')
    setCpmCountDraft(blankIfZero(manual.cpmCount ?? 0))
    // 운영일수 디폴트: manual 에 저장된 값 우선, 없으면 7일 고정
    const days = manual.cpmDays ?? 0
    setCpmDaysDraft(days ? String(days) : String(DEFAULT_CPM_DAYS))
    setShipDraft({
      s: { unit: String(manual.shipSmall.unit), count: blankIfZero(manual.shipSmall.count) },
      m: { unit: String(manual.shipMedium.unit), count: blankIfZero(manual.shipMedium.count) },
      l: { unit: String(manual.shipLarge.unit), count: blankIfZero(manual.shipLarge.count) },
    })
  }, [manual])

  const onPickSettlement = async (file: File) => {
    try {
      setParseError('')
      const buf = await file.arrayBuffer()
      const data = await parseNaverSettlement(buf)
      setSettleFile(file.name)
      setSettlement(data, file.name)
      // 새 정산파일 업로드 → frozen view 해제, 라이브 모드
      setLoadedSnapshot(null)
    } catch (e) {
      setParseError('정산파일 파싱 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const onSaveManual = () => {
    if (!settlement) return
    const cpmCount = Number(cpmCountDraft) || 0
    const cpmDays = Number(cpmDaysDraft) || 0
    const adCost =
      cpmConfig.baseDays > 0
        ? Math.round((cpmCount * cpmConfig.unitPrice * cpmDays) / cpmConfig.baseDays)
        : 0
    setManual({
      period: manual.period,
      adCost,
      cpmCount,
      cpmDays,
      shipSmall: { unit: Number(shipDraft.s.unit) || 0, count: Number(shipDraft.s.count) || 0 },
      shipMedium: { unit: Number(shipDraft.m.unit) || 0, count: Number(shipDraft.m.count) || 0 },
      shipLarge: { unit: Number(shipDraft.l.unit) || 0, count: Number(shipDraft.l.count) || 0 },
    })
  }

  // 미리보기용 CPM 비용
  const cpmCostPreview = (() => {
    const cnt = Number(cpmCountDraft) || 0
    const days = Number(cpmDaysDraft) || 0
    if (!cpmConfig.baseDays) return 0
    return Math.round((cnt * cpmConfig.unitPrice * days) / cpmConfig.baseDays)
  })()

  const shipTotal =
    (Number(shipDraft.s.unit) || 0) * (Number(shipDraft.s.count) || 0) +
    (Number(shipDraft.m.unit) || 0) * (Number(shipDraft.m.count) || 0) +
    (Number(shipDraft.l.unit) || 0) * (Number(shipDraft.l.count) || 0)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold">스마트스토어 수익 진단</h1>
          <p className="text-sm text-gray-500 mt-1">정산금 − 비용 − 광고비</p>
        </div>
        <div className="flex items-end gap-3">
          {displayDiagnosis?.period.start && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">
                마지막 업데이트 데이터
              </div>
              <div className="text-sm font-mono font-medium text-gray-800 mt-0.5">
                {fmtPeriodSmart(loadedSnapshot, displayDiagnosis.period)}
              </div>
              <div className={'text-[10px] ' + (loadedSnapshot ? 'text-blue-600 font-medium' : 'text-gray-400')}>
                {loadedSnapshot
                  ? `📌 ${loadedSnapshot.label || '저장된 분석'} (frozen)`
                  : '현재 보고 있는 분석'}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            {loadedSnapshot && (
              <button
                onClick={exitSnapshotView}
                className="text-xs px-3 py-1.5 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100"
                title="저장된 분석 보기 종료 — 라이브 모드"
              >
                📌 라이브 모드
              </button>
            )}
            <button
              onClick={handleOpenSaveDialog}
              disabled={!diagnosis}
              className="text-sm px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300"
            >
              💾 분석 저장
            </button>
            <button
              onClick={() => setShowHistoryPanel(!showHistoryPanel)}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
            >
              📊 저장된 분석 ({snapshots.length})
            </button>
            <button
              onClick={onResetAll}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
            >
              전체 초기화
            </button>
          </div>
        </div>
      </div>

      {/* 마진마스터 변경 안내 (frozen view 재계산 시) */}
      {fingerprintMismatch && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          📌 저장 시점 이후 마진마스터가 갱신되었습니다 — 최신 매칭/원가 기준으로 재계산된 결과를 표시합니다
        </div>
      )}

      {/* 저장된 분석 히스토리 패널 */}
      {showHistoryPanel && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">저장된 분석 히스토리</h3>
            <button
              onClick={() => setShowHistoryPanel(false)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              ✕ 닫기
            </button>
          </div>

          {snapshots.length === 0 ? (
            <div className="text-center text-xs text-gray-500 py-4">
              저장된 분석이 없습니다. 「💾 분석 저장」 버튼으로 저장하세요.
            </div>
          ) : (
            <>
              {snapshots.filter((a) => a.includeInTrend && a.trendType === 'weekly').length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-blue-700 mb-1.5">📅 주별 추이 (그래프 누적)</div>
                  <div className="space-y-1">
                    {snapshots
                      .filter((a) => a.includeInTrend && a.trendType === 'weekly')
                      .sort((a, b) => (b.weekKey || '').localeCompare(a.weekKey || ''))
                      .map((a) => (
                        <AnalysisItem
                          key={a.id}
                          a={a}
                          onLoad={handleLoadAnalysis}
                          onDelete={handleDeleteAnalysis}
                        />
                      ))}
                  </div>
                </div>
              )}
              {snapshots.filter((a) => a.includeInTrend && a.trendType === 'monthly').length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-orange-700 mb-1.5">📅 월별 추이 (그래프 누적)</div>
                  <div className="space-y-1">
                    {snapshots
                      .filter((a) => a.includeInTrend && a.trendType === 'monthly')
                      .sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''))
                      .map((a) => (
                        <AnalysisItem
                          key={a.id}
                          a={a}
                          onLoad={handleLoadAnalysis}
                          onDelete={handleDeleteAnalysis}
                        />
                      ))}
                  </div>
                </div>
              )}
              {snapshots.filter((a) => !a.includeInTrend).length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-600 mb-1.5">📁 일반 분석 (그래프 미포함)</div>
                  <div className="space-y-1">
                    {snapshots
                      .filter((a) => !a.includeInTrend)
                      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                      .map((a) => (
                        <AnalysisItem
                          key={a.id}
                          a={a}
                          onLoad={handleLoadAnalysis}
                          onDelete={handleDeleteAnalysis}
                        />
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 분석 저장 다이얼로그 (쿠팡 미러링) */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold mb-4">분석 저장</h2>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                라벨 (히스토리 표시용)
              </label>
              <input
                type="text"
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                placeholder="예: 2026년 4월 진단"
              />
            </div>

            <div className="mb-6">
              <label className="flex items-start gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={includeInTrend}
                  onChange={(e) => setIncludeInTrend(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="text-sm">
                  <div className="font-medium">추이 그래프에 포함</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    체크 시 같은 키(주/월) 데이터가 있으면 덮어쓰기됩니다.
                  </div>
                </div>
              </label>

              {includeInTrend && (
                <div className="ml-6 mt-2 space-y-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={trendType === 'weekly'}
                      onChange={() => setTrendType('weekly')}
                    />
                    <span>주별 추이 (6~8일치 권장)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={trendType === 'monthly'}
                      onChange={() => setTrendType('monthly')}
                    />
                    <span>월별 추이 (28~31일치 권장)</span>
                  </label>

                  {trendType === 'weekly' && (periodDays < 6 || periodDays > 8) && (
                    <div className="text-xs text-orange-600 mt-1">
                      ⚠ {periodDays}일치 — 주별은 6~8일치 권장
                    </div>
                  )}
                  {trendType === 'monthly' && (periodDays < 28 || periodDays > 31) && (
                    <div className="text-xs text-orange-600 mt-1">
                      ⚠ {periodDays}일치 — 월별은 28~31일치 권장
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="px-4 py-2 rounded border border-gray-300 text-sm hover:bg-gray-50"
                disabled={savingExplicit}
              >
                취소
              </button>
              <button
                onClick={handleSaveExplicit}
                className="px-4 py-2 rounded bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
                disabled={savingExplicit || !saveLabel.trim()}
              >
                {savingExplicit ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 업로드 영역 — 정산파일만 (마진마스터는 데이터 관리에서 자동 로드) */}
      <div className="grid grid-cols-1 gap-4 mb-4">
        <UploadCard
          label="정산파일 (.xlsx)"
          desc="네이버 정산내역 — 수수료상세-건별 시트"
          fileName={settleFile}
          inputRef={settleInputRef}
          onPick={onPickSettlement}
          summary={
            settlement
              ? `${settlement.productOrderCount}건 / ${settlement.dateRange?.min ?? '?'} ~ ${settlement.dateRange?.max ?? '?'}`
              : ''
          }
        />
      </div>

      {/* 마진마스터 자동 로드 상태 */}
      {marginLoading && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 text-gray-600 text-sm rounded">
          마진마스터 데이터 불러오는 중…
        </div>
      )}
      {!marginLoading && marginMissing && (
        <div className="mb-4 rounded-lg border border-orange-300 bg-orange-50 p-4">
          <div className="font-semibold text-orange-700 mb-1">⚠ 마진마스터 등록이 필요합니다</div>
          <p className="text-sm text-gray-700 mb-2">
            진단을 위해서는 먼저 마진마스터(네이버상품매칭 + 마진계산_네이버 시트) 데이터가 필요합니다.<br />
            <strong>「데이터 관리」</strong> 페이지에서 한 번만 등록하면 자동으로 사용됩니다.
          </p>
          <a
            href="/coupang-tools/data-management"
            className="inline-block px-4 py-2 bg-orange-500 text-white text-sm rounded hover:bg-orange-600"
          >
            데이터 관리 페이지로 이동 →
          </a>
        </div>
      )}
      {!marginLoading && productMatch && marginMap && (
        <div className="mb-4 text-xs text-gray-500">
          마진마스터 자동 로드: 매칭 {productMatch.size}개 / 옵션{' '}
          {Array.from(marginMap.values()).reduce((s, a) => s + a.length, 0)}개
        </div>
      )}

      {parseError && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          {parseError}
        </div>
      )}

      {/* 수기 입력 */}
      <div className="bg-white border rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {manual.period || '기간 미정'} CPM + 택배비 입력
          </h2>
          <button
            onClick={onSaveManual}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:bg-gray-300"
            disabled={!settlement}
          >
            저장
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <label className="text-sm w-20 text-gray-700">CPM</label>
              <span className="text-xs text-gray-500">
                단가 {cpmConfig.unitPrice.toLocaleString('ko-KR')}원 (VAT 포함, 1건/{cpmConfig.baseDays}일)
              </span>
            </div>
            <div className="flex items-center gap-2 ml-[5.5rem] flex-wrap">
              <span className="text-xs text-gray-500">건수</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9,]*"
                value={cpmCountDraft === '' ? '' : Number(cpmCountDraft).toLocaleString('ko-KR')}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9]/g, '')
                  setCpmCountDraft(raw)
                }}
                className="w-24 px-2 py-1 border rounded text-sm text-right"
                placeholder="0"
              />
              <span className="text-xs text-gray-400">×</span>
              <span className="text-xs text-gray-500">운영일수</span>
              <input
                type="number"
                value={cpmDaysDraft}
                onChange={(e) => setCpmDaysDraft(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-20 px-2 py-1 border rounded text-sm text-right"
                placeholder={String(DEFAULT_CPM_DAYS)}
              />
              <span className="text-xs text-gray-400">일</span>
              <span className="text-xs text-gray-400">=</span>
              <span className="text-sm font-semibold text-gray-700">
                {fmtKRW(cpmCostPreview)}
              </span>
              <span className="text-xs text-gray-500">
                {cpmCostPreview ? `(${numToKorean(cpmCostPreview)})` : ''}
              </span>
            </div>
            <div className="text-[10px] text-gray-400 ml-[5.5rem] mt-1">
              총 비용 = 단가 × 건수 / {cpmConfig.baseDays}일 × 운영일수 (운영일수 디폴트=7일)
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="text-sm text-gray-700 mb-2">택배비</div>
            <ShipRow
              label="소"
              draft={shipDraft.s}
              onChange={(d) => setShipDraft((p) => ({ ...p, s: d }))}
            />
            <ShipRow
              label="중"
              draft={shipDraft.m}
              onChange={(d) => setShipDraft((p) => ({ ...p, m: d }))}
            />
            <ShipRow
              label="대"
              draft={shipDraft.l}
              onChange={(d) => setShipDraft((p) => ({ ...p, l: d }))}
            />
            <div className="text-right text-sm text-gray-600 mt-2">
              합계: <span className="font-semibold">{fmtKRW(shipTotal)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* KPI 카드 */}
      {displayDiagnosis && (
        <>
          {(() => {
            const d = displayDiagnosis
            const totalCost = d.cost + d.bag + d.box + d.pack + d.shipReal
            const feePct = d.revenue > 0
              ? ((Math.abs(d.settleFee) / d.revenue) * 100).toFixed(1)
              : '0.0'
            const marginPct = d.revenue > 0 ? fmtPct(d.netProfit / d.revenue) : ''
            const productCountSub = loadedSnapshot
              ? `매칭 ${d.matched}/${d.matched + d.unmatched}`
              : `${d.productCount}종`
            const totalRows = d.matched + d.unmatched
            const unmatchedPct = totalRows > 0 ? ((d.unmatched / totalRows) * 100).toFixed(1) : '0'
            const unmatchedRevPct = d.revenue > 0
              ? ((d.unmatchedRevenue / d.revenue) * 100).toFixed(1)
              : '0'
            return (
              <>
                {d.unmatched > 0 && (
                  <div className="bg-amber-50 border-l-4 border-amber-500 px-4 py-3 mb-4 rounded">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="text-sm text-amber-900">
                        ⚠ 원가 미매칭 <strong>{d.unmatched}건</strong>
                        {' · 매출 '}
                        <strong>{formatKRW(d.unmatchedRevenue)}원</strong>
                        {' (전체 '}
                        {unmatchedRevPct}
                        {'%)'}
                      </div>
                      <div className="text-xs text-amber-700">
                        마진마스터 매칭표에 등록되지 않은 상품 — 마진율이 부풀려져 표시될 수 있습니다
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <KpiCard label="매출" value={fmtMan(d.revenue)} sub={productCountSub} />
                  <KpiCard
                    label="정산금"
                    value={fmtMan(d.settleAmount)}
                    sub={`수수료 ${fmtMan(d.settleFee)} (${feePct}%)`}
                  />
                  <KpiCard
                    label="매출 건수"
                    value={(d._productOrderCount ?? 0).toLocaleString()}
                    sub="상품주문"
                  />
                  <KpiCard label="기간" value={fmtPeriod(d.period.start, d.period.end)} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <KpiCard
                    label="총 비용"
                    value={fmtMan(-totalCost)}
                    formula="원가 + 봉투 + 박스 + 택배 + 포장비"
                    sub={`원가 ${fmtMan(d.cost)} · 매칭 ${d.matched}건 / 미매칭 ${d.unmatched}건 (${fmtMan(d.unmatchedRevenue)}, ${unmatchedPct}%)`}
                  />
                  <KpiCard label="배송비 매출" value={fmtMan(d.shipRevenue)} sub="구매자부담−수수료" />
                  <KpiCard
                    label="CPM"
                    value={fmtMan(-d.adCost)}
                    sub={
                      manual.cpmCount && manual.cpmDays
                        ? `${cpmConfig.unitPrice.toLocaleString()}원 × ${manual.cpmCount}건 / ${cpmConfig.baseDays}일 × ${manual.cpmDays}일`
                        : '수기 입력'
                    }
                  />
                  <KpiCard
                    label="순이익"
                    value={fmtMan(d.netProfit)}
                    accent={d.netProfit >= 0 ? 'green' : 'red'}
                    sub={marginPct ? `마진율 ${marginPct}` : ''}
                  />
                </div>
              </>
            )
          })()}

          {/* 추이 그래프 */}
          <NaverTrendChart
            snapshots={snapshots}
            onPointClick={handleLoadAnalysis}
          />

          {/* 매칭 통계 */}
          <div className="text-xs text-gray-500 mb-3 mt-6">
            매칭 {displayDiagnosis.matched} / 미매칭 {displayDiagnosis.unmatched} (총{' '}
            {displayDiagnosis.matched + displayDiagnosis.unmatched}건)
          </div>

          {/* 별칭별 손익 표 */}
          <NaverAliasTable
            products={displayDiagnosis.products}
            settlement={settlement}
            productMatch={productMatch}
            marginMap={marginMap}
          />
        </>
      )}

      {!diagnosis && (
        <div className="text-center text-gray-500 py-12 text-sm">
          정산파일 + 마진마스터를 모두 업로드하면 진단 결과가 표시됩니다.
        </div>
      )}
    </div>
  )
}

function UploadCard({
  label,
  desc,
  fileName,
  summary,
  inputRef,
  onPick,
}: {
  label: string
  desc: string
  fileName: string
  summary: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onPick: (file: File) => void
}) {
  return (
    <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 hover:border-emerald-400 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-gray-500">{desc}</div>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700"
        >
          {fileName ? '재업로드' : '파일 선택'}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          if (inputRef.current) inputRef.current.value = ''
        }}
      />
      {fileName && (
        <div className="text-xs text-gray-600 mt-1">
          📎 {fileName} {summary && <span className="text-gray-400 ml-2">{summary}</span>}
        </div>
      )}
    </div>
  )
}

function ShipRow({
  label,
  draft,
  onChange,
}: {
  label: string
  draft: { unit: string; count: string }
  onChange: (d: { unit: string; count: string }) => void
}) {
  const total = (Number(draft.unit) || 0) * (Number(draft.count) || 0)
  return (
    <div className="flex items-center gap-2 mb-1.5 text-sm">
      <span className="w-6 text-gray-600">{label}</span>
      <span className="text-xs text-gray-500">단가</span>
      <input
        type="number"
        value={draft.unit}
        onChange={(e) => onChange({ ...draft, unit: e.target.value })}
        className="w-24 px-2 py-1 border rounded text-sm text-right"
      />
      <span className="text-xs text-gray-400">×</span>
      <span className="text-xs text-gray-500">수량</span>
      <input
        type="number"
        value={draft.count}
        onChange={(e) => onChange({ ...draft, count: e.target.value })}
        className="w-20 px-2 py-1 border rounded text-sm text-right"
        placeholder="0"
      />
      <span className="text-xs text-gray-400">=</span>
      <span className="text-xs text-gray-700 w-24 text-right">{fmtKRW(total)}</span>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────
// 추이 그래프 (매출 + 순이익)
// ─────────────────────────────────────────────────────────────

interface TrendDatum {
  key: string
  label: string
  매출: number
  순이익: number
  _analysis: NaverSnapshotMeta
}

interface BigHitDotProps {
  cx?: number
  cy?: number
  stroke?: string
  payload?: TrendDatum
  onPointClick?: (a: NaverSnapshotMeta) => void
}

const BigHitDot = (props: BigHitDotProps) => {
  const { cx, cy, stroke, payload, onPointClick } = props
  if (cx == null || cy == null || isNaN(cx) || isNaN(cy)) return null
  const color = stroke || '#666'
  return (
    <g tabIndex={-1} style={{ outline: 'none' }}>
      <circle
        cx={cx}
        cy={cy}
        r={14}
        fill="transparent"
        style={{ cursor: onPointClick ? 'pointer' : 'default', outline: 'none' }}
        onClick={() => {
          if (onPointClick && payload?._analysis) onPointClick(payload._analysis)
        }}
      />
      <circle cx={cx} cy={cy} r={3} fill="#fff" stroke={color} strokeWidth={2} />
    </g>
  )
}

interface TooltipPayloadItem {
  dataKey: string
  value: number
  color: string
}

const CompactTrendTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
}) => {
  if (!active || !payload?.length) return null
  const order: Record<string, number> = { 매출: 1, 순이익: 2 }
  const items = [...payload]
    .filter((p) => p.dataKey in order)
    .sort((a, b) => (order[a.dataKey] ?? 9) - (order[b.dataKey] ?? 9))
  return (
    <div className="rounded border border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm px-2 py-1.5 text-[11px]">
      <div className="font-medium text-gray-700 mb-0.5">{label}</div>
      {items.map((p) => {
        const v = p.value ?? 0
        const isProfit = p.dataKey === '순이익'
        const valueClass = isProfit
          ? v < 0
            ? 'font-mono font-bold text-red-600'
            : 'font-mono font-bold text-green-600'
          : 'font-mono text-gray-900'
        return (
          <div key={p.dataKey} className="flex items-center gap-1.5 leading-tight">
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
            <span className="text-gray-500 w-10">{p.dataKey}</span>
            <span className={valueClass}>{v.toLocaleString()}만원</span>
          </div>
        )
      })}
    </div>
  )
}

function formatWeekLabel(weekKey: string | null | undefined): string {
  if (!weekKey) return '?'
  return weekKey.slice(5)
}

function formatMonthLabel(monthKey: string | null | undefined): string {
  if (!monthKey) return '?'
  return monthKey
}

function NaverTrendChart({
  snapshots,
  onPointClick,
}: {
  snapshots: NaverSnapshotMeta[]
  onPointClick?: (a: NaverSnapshotMeta) => void
}) {
  const [chartMode, setChartMode] = useState<'weekly' | 'monthly'>('monthly')

  const weeklyData = useMemo<TrendDatum[]>(() => {
    return snapshots
      .filter((a) => a.includeInTrend && a.trendType === 'weekly' && a.weekKey)
      .sort((a, b) => (a.weekKey || '').localeCompare(b.weekKey || ''))
      .map((a) => {
        const s = a.summary as unknown as { revenue?: number; netProfit?: number }
        return {
          key: a.weekKey ?? '',
          label: formatWeekLabel(a.weekKey),
          매출: Math.round((s.revenue ?? 0) / 10000),
          순이익: Math.round((s.netProfit ?? 0) / 10000),
          _analysis: a,
        }
      })
  }, [snapshots])

  // 월별 데이터:
  //   1) trendType='monthly' snapshot 우선 사용
  //   2) 같은 monthKey 의 monthly 가 없으면 weekly snapshot 들 합산해서 1개 점 생성
  const monthlyData = useMemo<TrendDatum[]>(() => {
    const monthlyDirect = snapshots.filter(
      (a) => a.includeInTrend && a.trendType === 'monthly' && a.monthKey,
    )
    const monthlyKeys = new Set(monthlyDirect.map((a) => a.monthKey).filter(Boolean) as string[])

    // weekly snapshot 들을 monthKey(=weekKey 의 YYYY-MM)로 그룹 합산
    const weeklyByMonth = new Map<
      string,
      { revenue: number; netProfit: number; analyses: NaverSnapshotMeta[] }
    >()
    for (const a of snapshots) {
      if (!a.includeInTrend || a.trendType !== 'weekly' || !a.weekKey) continue
      const mk = a.weekKey.slice(0, 7)
      if (monthlyKeys.has(mk)) continue // monthly 직접 저장이 있으면 건너뜀
      const s = a.summary as unknown as { revenue?: number; netProfit?: number }
      const acc = weeklyByMonth.get(mk) ?? { revenue: 0, netProfit: 0, analyses: [] }
      acc.revenue += s.revenue ?? 0
      acc.netProfit += s.netProfit ?? 0
      acc.analyses.push(a)
      weeklyByMonth.set(mk, acc)
    }

    const fromMonthly: TrendDatum[] = monthlyDirect
      .sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || ''))
      .map((a) => {
        const s = a.summary as unknown as { revenue?: number; netProfit?: number }
        return {
          key: a.monthKey ?? '',
          label: formatMonthLabel(a.monthKey),
          매출: Math.round((s.revenue ?? 0) / 10000),
          순이익: Math.round((s.netProfit ?? 0) / 10000),
          _analysis: a,
        }
      })

    const fromWeekly: TrendDatum[] = Array.from(weeklyByMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mk, v]) => ({
        key: mk,
        label: formatMonthLabel(mk),
        매출: Math.round(v.revenue / 10000),
        순이익: Math.round(v.netProfit / 10000),
        // 클릭 시 가장 최근 weekly 분석을 frozen view 로 (대표값)
        _analysis: v.analyses.sort((x, y) =>
          (y.weekKey || '').localeCompare(x.weekKey || ''),
        )[0],
      }))

    return [...fromMonthly, ...fromWeekly].sort((a, b) => a.key.localeCompare(b.key))
  }, [snapshots])

  const trendData = chartMode === 'weekly' ? weeklyData : monthlyData
  const periodLabel = chartMode === 'weekly' ? '주' : '월'

  // 토글 클릭 시 가장 최근 점 자동 frozen view (초기 마운트는 page-level autoLoad 가 처리하므로 스킵)
  const didInitToggleRef = useRef(false)
  useEffect(() => {
    if (!didInitToggleRef.current) {
      didInitToggleRef.current = true
      return
    }
    if (!onPointClick) return
    if (trendData.length === 0) return
    const latest = trendData[trendData.length - 1]
    if (latest?._analysis) onPointClick(latest._analysis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode])

  const ToggleHeader = () => (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold">📈 추이 그래프</h3>
      <div className="flex rounded border border-gray-300 overflow-hidden">
        <button
          onClick={() => setChartMode('weekly')}
          className={
            'px-3 py-1 text-xs font-medium ' +
            (chartMode === 'weekly'
              ? 'bg-gray-900 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50')
          }
        >
          주별 ({weeklyData.length})
        </button>
        <button
          onClick={() => setChartMode('monthly')}
          className={
            'px-3 py-1 text-xs font-medium ' +
            (chartMode === 'monthly'
              ? 'bg-gray-900 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50')
          }
        >
          월별 ({monthlyData.length})
        </button>
      </div>
    </div>
  )

  if (trendData.length < 2) {
    return (
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <ToggleHeader />
        <div className="text-center text-sm text-gray-500 py-6">
          📈 {periodLabel}별 추이는 2{periodLabel} 이상 데이터가 누적되면 표시됩니다.
          <div className="text-xs text-gray-400 mt-1">현재 {trendData.length}{periodLabel} 데이터</div>
        </div>
      </div>
    )
  }

  // activeDot onClick — recharts 가 hover 시 그리는 큰 원이 BigHitDot 위를 덮어 클릭 가로채는 문제 해결
  const activeDotClick = onPointClick
    ? (_: unknown, ev: { index?: number; currentTarget?: { blur?: () => void } }) => {
        const idx = ev?.index
        if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
        try { ev?.currentTarget?.blur?.() } catch { /* ignore */ }
        try { (document.activeElement as HTMLElement | null)?.blur?.() } catch { /* ignore */ }
      }
    : undefined

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
      <ToggleHeader />
      <div className="text-xs text-gray-500 mb-2">
        매출 / 순이익 ({periodLabel} 환산)
        {onPointClick && (
          <span className="ml-2 text-orange-600">· 점 클릭 시 해당 시점 데이터로 진단</span>
        )}
      </div>
      <div
        tabIndex={-1}
        className="focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none"
        style={{ outline: 'none' }}
      >
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={trendData} tabIndex={-1} style={{ outline: 'none' }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (v < 0 ? '' : `${v.toLocaleString()}만`)} />
            <Tooltip
              content={<CompactTrendTooltip />}
              offset={20}
              cursor={{ stroke: '#10b981', strokeWidth: 24, strokeOpacity: 0.1 }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="매출"
              stroke="#2563eb"
              strokeWidth={2}
              dot={<BigHitDot onPointClick={onPointClick} />}
              activeDot={{
                r: 10,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: activeDotClick,
              }}
            />
            <Line
              type="monotone"
              dataKey="순이익"
              stroke="#10b981"
              strokeWidth={2}
              dot={<BigHitDot onPointClick={onPointClick} />}
              activeDot={{
                r: 10,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: activeDotClick,
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 히스토리 아이템 (저장된 분석 1개)
// ─────────────────────────────────────────────────────────────

function AnalysisItem({
  a,
  onLoad,
  onDelete,
}: {
  a: NaverSnapshotMeta
  onLoad: (a: NaverSnapshotMeta) => void
  onDelete: (id?: string) => void
}) {
  const period = a.period
  const periodText = period?.start && period?.end ? `${period.start} ~ ${period.end}` : ''
  const created = a.createdAt ? new Date(a.createdAt) : null
  const createdText = created
    ? `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(
        created.getDate(),
      ).padStart(2, '0')} ${String(created.getHours()).padStart(2, '0')}:${String(
        created.getMinutes(),
      ).padStart(2, '0')}`
    : ''
  const tag =
    a.trendType === 'weekly'
      ? '주별'
      : a.trendType === 'monthly'
        ? '월별'
        : a.includeInTrend
          ? '추이'
          : '일반'

  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-gray-50 border border-transparent hover:border-gray-200">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{tag}</span>
          <span className="font-medium truncate" title={a.label}>
            {a.label || '(라벨 없음)'}
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-0.5 truncate">
          {periodText}
          {createdText && <span className="ml-2 text-gray-400">· 저장 {createdText}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onLoad(a)}
          className="text-xs px-2 py-1 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100"
        >
          보기
        </button>
        <button
          onClick={() => onDelete(a.id)}
          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
          title="삭제"
        >
          🗑
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 별칭별 손익 표 + 클릭 시 판매 추이 펼침
// ─────────────────────────────────────────────────────────────

interface NaverAliasTableProps {
  products: Array<{
    productName: string
    alias?: string
    count: number
    revenue: number
    cost: number
    profit: number
    matched: boolean
  }>
  settlement: import('@/lib/naver/parsers/settlement').NaverSettlementData | null
  productMatch: Map<string, import('@/lib/naver/parsers/productMatch').NaverProductMatch> | null
  marginMap: Map<string, import('@/lib/naver/marginNaver').NaverMarginOption[]> | null
}

const UNMATCHED_KEY = '__UNMATCHED__'

function NaverAliasTable({ products, settlement, productMatch, marginMap }: NaverAliasTableProps) {
  // 별칭 단위 그룹화 (미매칭은 별도 그룹)
  const aliasRows = useMemo(() => {
    const map = new Map<string, { alias: string; count: number; revenue: number; matched: boolean }>()
    for (const p of products) {
      const key = p.matched && p.alias ? p.alias : UNMATCHED_KEY
      const acc = map.get(key) ?? {
        alias: key === UNMATCHED_KEY ? '미매칭' : p.alias || '',
        count: 0,
        revenue: 0,
        matched: key !== UNMATCHED_KEY,
      }
      acc.count += p.count
      acc.revenue += p.revenue
      map.set(key, acc)
    }
    return Array.from(map.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
  }, [products])

  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="overflow-x-auto max-h-[700px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr className="text-xs text-gray-600">
              <th className="px-3 py-2 text-left">별칭</th>
              <th className="px-3 py-2 text-right">건수</th>
              <th className="px-3 py-2 text-right">매출</th>
              <th className="px-3 py-2 text-center w-10"></th>
            </tr>
          </thead>
          <tbody>
            {aliasRows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-gray-400">
                  데이터 없음
                </td>
              </tr>
            )}
            {aliasRows.map((r) => {
              const isExpanded = expandedKey === r.key
              const canExpand = r.matched && r.alias && r.alias !== '미매칭'
              return (
                <React.Fragment key={r.key}>
                  <tr
                    className={
                      'border-t ' +
                      (r.matched ? '' : 'bg-gray-50 text-gray-500') +
                      (canExpand ? ' cursor-pointer hover:bg-gray-50' : '')
                    }
                    onClick={() => {
                      if (!canExpand) return
                      setExpandedKey(isExpanded ? null : r.key)
                    }}
                  >
                    <td className="px-3 py-2">
                      <span className={canExpand ? 'text-blue-700 hover:underline' : ''}>
                        {r.alias}
                      </span>
                      {!r.matched && <span className="ml-2 text-xs text-gray-400">❌ 미매칭</span>}
                    </td>
                    <td className="px-3 py-2 text-right">{r.count}</td>
                    <td className="px-3 py-2 text-right">{fmtKRW(r.revenue)}</td>
                    <td className="px-3 py-2 text-center text-xs text-gray-400">
                      {canExpand ? (isExpanded ? '▼' : '▶') : ''}
                    </td>
                  </tr>
                  {isExpanded && canExpand && (
                    <tr className="bg-gray-50">
                      <td colSpan={4} className="px-3 py-3">
                        <NaverAliasTrendChart
                          alias={r.alias}
                          settlement={settlement}
                          productMatch={productMatch}
                          marginMap={marginMap}
                          onClose={() => setExpandedKey(null)}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 별칭별 판매 추이 차트 (매출 + 총 kg, 주별/월별)
// ─────────────────────────────────────────────────────────────

function NaverAliasTrendChart({
  alias,
  settlement,
  productMatch,
  marginMap,
  onClose,
}: {
  alias: string
  settlement: NaverAliasTableProps['settlement']
  productMatch: NaverAliasTableProps['productMatch']
  marginMap: NaverAliasTableProps['marginMap']
  onClose: () => void
}) {
  const [granularity, setGranularity] = useState<'weekly' | 'monthly'>('weekly')

  const data: NaverAliasTrendPoint[] = useMemo(() => {
    return computeAliasTrend(settlement, productMatch, marginMap, alias, granularity)
  }, [settlement, productMatch, marginMap, alias, granularity])

  const periodLabel = granularity === 'weekly' ? '주' : '월'

  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold">📦 {alias} 판매 추이</h4>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-gray-300 overflow-hidden">
            <button
              onClick={() => setGranularity('weekly')}
              className={
                'px-3 py-1 text-xs font-medium ' +
                (granularity === 'weekly'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50')
              }
            >
              주별
            </button>
            <button
              onClick={() => setGranularity('monthly')}
              className={
                'px-3 py-1 text-xs font-medium ' +
                (granularity === 'monthly'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50')
              }
            >
              월별
            </button>
          </div>
          <button
            onClick={onClose}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            ✕ 닫기
          </button>
        </div>
      </div>

      {data.length < 2 ? (
        <div className="text-center text-xs text-gray-500 py-6">
          📈 {periodLabel}별 추이는 2{periodLabel} 이상 데이터가 누적되면 표시됩니다. (현재{' '}
          {data.length}{periodLabel} 데이터)
        </div>
      ) : (
        <div
          tabIndex={-1}
          className="focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none"
          style={{ outline: 'none' }}
        >
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} tabIndex={-1} style={{ outline: 'none' }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `${Math.round(v / 10000).toLocaleString()}만`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `${v.toLocaleString()}kg`}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const rev = payload.find((p) => p.dataKey === 'revenue')?.value ?? 0
                  const kg = payload.find((p) => p.dataKey === 'totalKg')?.value ?? 0
                  return (
                    <div className="rounded border border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm px-2 py-1.5 text-[11px]">
                      <div className="font-medium text-gray-700 mb-0.5">{label}</div>
                      <div className="flex items-center gap-1.5 leading-tight">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-600" />
                        <span className="text-gray-500 w-10">매출</span>
                        <span className="font-mono text-gray-900">
                          {Number(rev).toLocaleString()}원
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 leading-tight">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-600" />
                        <span className="text-gray-500 w-10">총 kg</span>
                        <span className="font-mono text-gray-900">
                          {Number(kg).toLocaleString()}kg
                        </span>
                      </div>
                    </div>
                  )
                }}
                offset={20}
                cursor={{ stroke: '#10b981', strokeWidth: 24, strokeOpacity: 0.1 }}
              />
              <Legend />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="revenue"
                name="매출"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 3, fill: '#fff', stroke: '#2563eb', strokeWidth: 2 }}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="totalKg"
                name="총 kg"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 3, fill: '#fff', stroke: '#10b981', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
