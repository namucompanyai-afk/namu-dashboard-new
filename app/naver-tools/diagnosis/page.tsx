'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useNaverStore } from '@/lib/naver/store'
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
  } = useNaverStore()

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

  // 명시 저장 다이얼로그
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')
  const [saving, setSaving] = useState(false)

  const onSaveExplicit = async () => {
    if (!diagnosis) return
    setSaving(true)
    const id = await saveExplicit(saveLabel)
    setSaving(false)
    if (id) {
      setShowSaveDialog(false)
      setSaveLabel('')
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">스마트스토어 수익 진단</h1>
          <p className="text-sm text-gray-500 mt-1">정산금 − 비용 − 광고비 (월별)</p>
        </div>
        <div className="flex items-center gap-3">
          {diagnosis?.period.start && (
            <div className="text-sm text-gray-600">
              기간: {fmtPeriod(diagnosis.period.start, diagnosis.period.end)}
            </div>
          )}
          <button
            onClick={() => setShowSaveDialog(true)}
            disabled={!diagnosis}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:bg-gray-300"
          >
            분석 저장 ({snapshots.length})
          </button>
        </div>
      </div>

      {/* 명시 저장 다이얼로그 */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-5 w-full max-w-md shadow-lg">
            <h3 className="text-lg font-semibold mb-3">분석 저장</h3>
            <p className="text-sm text-gray-600 mb-3">
              이번 진단 결과를 저장합니다. 라벨을 입력하면 나중에 알아보기 쉬워요.
            </p>
            <input
              type="text"
              value={saveLabel}
              onChange={(e) => setSaveLabel(e.target.value)}
              placeholder="예: 4월 정산 마감"
              className="w-full px-3 py-2 border rounded text-sm mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowSaveDialog(false)
                  setSaveLabel('')
                }}
                className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
                disabled={saving}
              >
                취소
              </button>
              <button
                onClick={onSaveExplicit}
                className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:bg-gray-300"
                disabled={saving}
              >
                {saving ? '저장 중…' : '저장'}
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
      {diagnosis && (
        <>
          {(() => {
            const totalCost =
              diagnosis.cost + diagnosis.bag + diagnosis.box + diagnosis.pack + diagnosis.shipReal
            const feePct = diagnosis.revenue > 0
              ? ((Math.abs(diagnosis.settleFee) / diagnosis.revenue) * 100).toFixed(1)
              : '0.0'
            const marginPct = diagnosis.revenue > 0
              ? fmtPct(diagnosis.netProfit / diagnosis.revenue)
              : ''
            return (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <KpiCard label="매출" value={fmtMan(diagnosis.revenue)} sub={`${diagnosis.productCount}종`} />
                  <KpiCard
                    label="정산금"
                    value={fmtMan(diagnosis.settleAmount)}
                    sub={`수수료 ${fmtMan(diagnosis.settleFee)} (${feePct}%)`}
                  />
                  <KpiCard
                    label="매출 건수"
                    value={(settlement?.productOrderCount ?? 0).toLocaleString()}
                    sub="상품주문"
                  />
                  <KpiCard label="기간" value={fmtPeriod(diagnosis.period.start, diagnosis.period.end)} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <KpiCard
                    label="총 비용"
                    value={fmtMan(-totalCost)}
                    formula="원가 + 봉투 + 박스 + 택배 + 포장비"
                    sub={`원가 ${fmtMan(diagnosis.cost)}`}
                  />
                  <KpiCard label="배송비 매출" value={fmtMan(diagnosis.shipRevenue)} sub="구매자부담−수수료" />
                  <KpiCard label="광고비" value={fmtMan(-diagnosis.adCost)} sub="수기 입력" />
                  <KpiCard
                    label="순이익"
                    value={fmtMan(diagnosis.netProfit)}
                    accent={diagnosis.netProfit >= 0 ? 'green' : 'red'}
                    sub={marginPct ? `마진율 ${marginPct}` : ''}
                  />
                </div>
              </>
            )
          })()}

          {/* 매칭 통계 */}
          <div className="text-xs text-gray-500 mb-3">
            매칭 {diagnosis.matched} / 미매칭 {diagnosis.unmatched} (총 {diagnosis.matched + diagnosis.unmatched}건)
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
                  {diagnosis.products.map((p) => {
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
                  {diagnosis.products.length === 0 && (
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

