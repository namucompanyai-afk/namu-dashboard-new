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

  // KPI/표 표시용 — loaded 우선, 없으면 라이브
  const displayDiagnosis = useMemo(() => {
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
      }
      const products =
        ((loadedSnapshot as unknown as { products?: Array<{
          productName: string
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
        products,
        _productOrderCount: s.productOrderCount ?? 0,
      }
    }
    if (!diagnosis) return null
    return {
      ...diagnosis,
      _productOrderCount: settlement?.productOrderCount ?? 0,
    }
  }, [loadedSnapshot, diagnosis, settlement])

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
  const [adCostDraft, setAdCostDraft] = useState<string>('')
  const [shipDraft, setShipDraft] = useState<{
    s: { unit: string; count: string }
    m: { unit: string; count: string }
    l: { unit: string; count: string }
  }>({
    s: { unit: '', count: '' },
    m: { unit: '', count: '' },
    l: { unit: '', count: '' },
  })

  React.useEffect(() => {
    // 0/빈값은 ''로 둬서 화면에 빈칸으로 표시. 단가는 0이어도 그대로(고정 디폴트).
    const blankIfZero = (n: number) => (n ? String(n) : '')
    setAdCostDraft(blankIfZero(manual.adCost ?? 0))
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
      setSettlement(data)
    } catch (e) {
      setParseError('정산파일 파싱 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const onSaveManual = () => {
    if (!settlement) return
    setManual({
      period: manual.period,
      adCost: Number(adCostDraft) || 0,
      shipSmall: { unit: Number(shipDraft.s.unit) || 0, count: Number(shipDraft.s.count) || 0 },
      shipMedium: { unit: Number(shipDraft.m.unit) || 0, count: Number(shipDraft.m.count) || 0 },
      shipLarge: { unit: Number(shipDraft.l.unit) || 0, count: Number(shipDraft.l.count) || 0 },
    })
  }

  const shipTotal =
    (Number(shipDraft.s.unit) || 0) * (Number(shipDraft.s.count) || 0) +
    (Number(shipDraft.m.unit) || 0) * (Number(shipDraft.m.count) || 0) +
    (Number(shipDraft.l.unit) || 0) * (Number(shipDraft.l.count) || 0)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold">스마트스토어 수익 진단</h1>
          <p className="text-sm text-gray-500 mt-1">정산금 − 비용 − 광고비 (월별)</p>
        </div>
        <div className="flex items-end gap-3">
          {displayDiagnosis?.period.start && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">
                마지막 업데이트 데이터
              </div>
              <div className="text-sm font-mono font-medium text-gray-800 mt-0.5">
                {fmtPeriodWithDays(displayDiagnosis.period.start, displayDiagnosis.period.end)}
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
            {manual.period || '기간 미정'} 광고비 + 택배비 입력
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
          <div className="flex items-center gap-3">
            <label className="text-sm w-20 text-gray-700">광고비</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9,]*"
              value={adCostDraft === '' ? '' : Number(adCostDraft).toLocaleString('ko-KR')}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, '')
                setAdCostDraft(raw)
              }}
              className="flex-1 max-w-xs px-3 py-1.5 border rounded text-sm text-right"
              placeholder="0"
            />
            <span className="text-sm text-gray-500">원</span>
            <span className="text-sm text-gray-500 min-w-[8rem]">
              {adCostDraft === '' ? '' : numToKorean(Number(adCostDraft) || 0)}
            </span>
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
            return (
              <>
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
                    sub={`원가 ${fmtMan(d.cost)}`}
                  />
                  <KpiCard label="배송비 매출" value={fmtMan(d.shipRevenue)} sub="구매자부담−수수료" />
                  <KpiCard label="광고비" value={fmtMan(-d.adCost)} sub="수기 입력" />
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

          {/* 상품별 손익 표 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr className="text-xs text-gray-600">
                    <th className="px-3 py-2 text-left">상품명</th>
                    <th className="px-3 py-2 text-right">건수</th>
                    <th className="px-3 py-2 text-right">매출</th>
                    <th className="px-3 py-2 text-right">평균단가</th>
                    <th className="px-3 py-2 text-right">원가합계</th>
                    <th className="px-3 py-2 text-right">마진</th>
                    <th className="px-3 py-2 text-right">마진율</th>
                    <th className="px-3 py-2 text-center">매칭</th>
                  </tr>
                </thead>
                <tbody>
                  {displayDiagnosis.products.map((p) => {
                    const avg = p.count > 0 ? p.revenue / p.count : 0
                    const rate = p.revenue > 0 ? p.profit / p.revenue : 0
                    return (
                      <tr
                        key={p.productName}
                        className={'border-t ' + (p.matched ? '' : 'bg-gray-50 text-gray-500')}
                      >
                        <td className="px-3 py-2 max-w-md truncate" title={p.productName}>
                          {p.productName}
                        </td>
                        <td className="px-3 py-2 text-right">{p.count}</td>
                        <td className="px-3 py-2 text-right">{fmtKRW(p.revenue)}</td>
                        <td className="px-3 py-2 text-right text-gray-500">{fmtKRW(avg)}</td>
                        <td className="px-3 py-2 text-right">{fmtKRW(p.cost)}</td>
                        <td
                          className={
                            'px-3 py-2 text-right ' +
                            (p.profit >= 0 ? 'text-emerald-700' : 'text-red-600')
                          }
                        >
                          {fmtKRW(p.profit)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-gray-600">
                          {p.revenue > 0 ? fmtPct(rate) : '—'}
                        </td>
                        <td className="px-3 py-2 text-center text-xs">
                          {p.matched ? '✅' : <span className="text-gray-400">❌ 미매칭</span>}
                        </td>
                      </tr>
                    )
                  })}
                  {displayDiagnosis.products.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-gray-400">
                        데이터 없음
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
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

  const monthlyData = useMemo<TrendDatum[]>(() => {
    return snapshots
      .filter((a) => a.includeInTrend && a.trendType === 'monthly' && a.monthKey)
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
  }, [snapshots])

  const trendData = chartMode === 'weekly' ? weeklyData : monthlyData
  const periodLabel = chartMode === 'weekly' ? '주' : '월'

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
