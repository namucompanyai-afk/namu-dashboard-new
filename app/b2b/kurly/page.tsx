'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ORDER_SHEET_NAME,
  MAX_SKU_PER_PLT,
  buildPallets,
  calcTransportCost,
  indexByMasterCode,
  norm,
  palletInputValues,
  type KurlyOrderRow,
  type MilkrunPrice,
  type ProductMaster,
} from '@/lib/b2b/kurly'
import { parseKurlyFile } from '@/lib/b2b/kurlyFile'
import {
  PalletPlanView,
  buildPalletPlan,
  buildWikeepNotice,
  downloadPalletPlanJpg,
  renderPalletPlanSvg,
} from '@/lib/b2b/kurlyDiagram'
import { buildLabelPlan, openLabelPrint } from '@/lib/b2b/kurlyLabel'
import { summarizeOrders } from '@/lib/b2b/kurlySummary'
import { buildKurlyHistory, historyMessage } from '@/lib/b2b/history'

/**
 * B2B 발주 변환 — 컬리
 *
 * 구글시트(상품마스터 · 컬리 밀크런 가격표)는 /api/b2b/sheets 가 서비스 계정으로 read-only 로드.
 * 컬리 발주 xlsx 는 브라우저에서 파싱한다(!ref 함정 보정은 lib/b2b/kurlyFile).
 */

const won = (n: number) => n.toLocaleString('ko-KR')

// 화면 표시 라벨만 교체 — 시트 구분값('이고비_김포') 매칭은 lib/b2b/kurly.ts 그대로 둔다
const costLabel = (label: string) => label.replace('이고비', '물류대행비')

type SheetState = 'idle' | 'loading' | 'loaded' | 'error'

export default function B2BPage() {
  // 구글시트
  const [products, setProducts] = useState<ProductMaster[]>([])
  const [prices, setPrices] = useState<MilkrunPrice[]>([])
  const [sheetState, setSheetState] = useState<SheetState>('idle')
  const [sheetError, setSheetError] = useState('')

  // 업로드
  const [orders, setOrders] = useState<KurlyOrderRow[]>([])
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [openDests, setOpenDests] = useState<string[]>([]) // 팔레트 요약 펼친 입고지

  const loadSheets = useCallback(async () => {
    setSheetState('loading')
    setSheetError('')
    try {
      const res = await fetch('/api/b2b/sheets', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setProducts(json.products || [])
      setPrices(json.prices || [])
      setSheetState('loaded')
    } catch (e: unknown) {
      setSheetError(e instanceof Error ? e.message : String(e))
      setSheetState('error')
    }
  }, [])

  useEffect(() => {
    loadSheets()
  }, [loadSheets])

  const parseFile = useCallback(async (file: File) => {
    setFileError('')
    try {
      const parsed = await parseKurlyFile(file)
      if (parsed.length === 0) throw new Error('발주 행을 찾지 못했습니다.')
      setOrders(parsed)
      setFileName(file.name)
      setOpenDests([])
      setHistoryMsg('')
      setHistorySaved(false)
    } catch (err: unknown) {
      setOrders([])
      setFileName('')
      setFileError('발주 파일 파싱 실패: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const masterByCode = useMemo(() => indexByMasterCode(products), [products])
  // 팔레트 장수는 실측 박스 치수로 계산한다 — 상품마스터가 로드된 뒤 확정된다
  const pallets = useMemo(() => buildPallets(orders, masterByCode), [orders, masterByCode])
  const pltInputs = useMemo(() => palletInputValues(orders, pallets), [orders, pallets])
  const cost = useMemo(() => calcTransportCost(pallets, prices), [pallets, prices])

  // 상품마스터에 없는 마스터코드 (매칭 키는 컬리 마스터 코드 — 상품명 매칭 안 함)
  const unmatched = useMemo(
    () => [...new Set(orders.filter((o) => !masterByCode[norm(o.masterCode)]).map((o) => o.masterCode))],
    [orders, masterByCode],
  )

  const totals = useMemo(
    () => ({
      boxes: orders.reduce((s, o) => s + o.boxCount, 0),
      units: orders.reduce((s, o) => s + o.totalUnits, 0),
    }),
    [orders],
  )

  const costLines = [cost.vehicle, cost.via, cost.moveKimpo, cost.moveChangwon]

  // 발주 요약 — 금액은 발주 파일 값 그대로(시트 공급가로 재계산 안 함)
  const summary = useMemo(() => summarizeOrders(orders, masterByCode), [orders, masterByCode])

  // 발주 이력 저장 — 버튼을 눌렀을 때만 기록한다(업로드만으로는 시트에 쓰지 않음).
  // 실패해도 변환 기능은 그대로 동작해야 하므로 비차단(에러 배너 대신 작은 문구만).
  const [historyMsg, setHistoryMsg] = useState('')
  const [historySaving, setHistorySaving] = useState(false)
  const [historySaved, setHistorySaved] = useState(false)

  const saveHistory = useCallback(async () => {
    setHistorySaving(true)
    setHistoryMsg('이력 저장 중…')
    try {
      const res = await fetch('/api/b2b/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: buildKurlyHistory(orders, masterByCode) }),
      })
      const j = await res.json()
      if (!j?.ok) throw new Error(j?.error || '실패')
      setHistoryMsg(historyMessage(j.added ?? 0, j.updated ?? 0))
      setHistorySaved(true)
    } catch {
      setHistoryMsg('이력 저장 실패 — 변환 기능에는 영향 없음')
      setHistorySaved(false)
    } finally {
      setHistorySaving(false)
    }
  }, [orders, masterByCode])

  // 적재 구성도 — 위 팔레트 산정 결과를 소비만 한다(계산 로직 재구현 없음)
  const plan = useMemo(
    () => buildPalletPlan(orders, pallets, masterByCode),
    [orders, pallets, masterByCode],
  )
  const planSvg = useMemo(() => (plan.panels.length ? renderPalletPlanSvg(plan) : ''), [plan])

  const [jpgBusy, setJpgBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const saveJpg = useCallback(async () => {
    setJpgBusy(true)
    try {
      await downloadPalletPlanJpg(planSvg, plan.dueDate)
    } catch (e: unknown) {
      setFileError('JPG 저장 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setJpgBusy(false)
    }
  }, [planSvg, plan.dueDate])

  const copyNotice = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildWikeepNotice(plan))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setFileError('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.')
    }
  }, [plan])

  // 박스 부착 라벨 (잡곡밥 등 기인쇄 상품은 제외)
  const labelPlan = useMemo(() => buildLabelPlan(orders, masterByCode), [orders, masterByCode])
  const printLabels = useCallback(() => {
    if (!openLabelPrint(labelPlan)) {
      setFileError('팝업이 차단되어 인쇄 창을 열지 못했습니다. 브라우저 팝업 허용 후 다시 시도해 주세요.')
    }
  }, [labelPlan])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">B2B 발주 변환 — 컬리</h1>
        <p className="text-sm text-gray-500 mt-1">
          컬리 발주 xlsx 업로드 → 팔레트 산정 · 포털 입력값 · 밀크런 운송비 자동 계산
        </p>
      </div>

      {/* 시트 연동 + 업로드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="text-sm font-medium mb-1">① 기준정보 (구글시트 · 읽기 전용)</div>
          <p className="text-xs text-gray-500 mb-3">상품마스터 · 컬리 밀크런 가격표</p>
          {sheetState === 'loading' && <p className="text-xs text-gray-500">⏳ 불러오는 중…</p>}
          {sheetState === 'loaded' && (
            <p className="text-xs text-gray-700">
              ✅ 상품마스터 {products.length}행 · 가격표 {prices.length}행
            </p>
          )}
          {sheetState === 'error' && (
            <p className="text-xs text-red-600 break-all">⚠️ {sheetError}</p>
          )}
          <button
            onClick={loadSheets}
            className="mt-3 px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700"
          >
            새로고침
          </button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) parseFile(f)
          }}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            dragOver ? 'border-teal-500 bg-teal-50' : 'border-gray-300 bg-white'
          }`}
        >
          <div className="text-sm font-medium mb-1">② 컬리 발주 파일 (.xlsx)</div>
          <p className="text-xs text-gray-500 mb-3">드래그앤드롭 또는 클릭 · 시트 &lsquo;{ORDER_SHEET_NAME}&rsquo;</p>
          <label className="inline-block px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs cursor-pointer hover:bg-gray-700">
            파일 선택
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) parseFile(f)
                e.target.value = ''
              }}
            />
          </label>
          {fileName && (
            <>
              <p className="text-xs text-gray-700 mt-3">
                📄 {fileName} · {orders.length}행 · {won(totals.boxes)}박스 / {won(totals.units)}낱개
              </p>
              <button
                onClick={saveHistory}
                disabled={historySaving || orders.length === 0 || products.length === 0}
                className="mt-2 px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200"
              >
                {historySaving ? '저장 중…' : historySaved ? '✅ 저장됨 (다시 저장)' : '세일즈 히스토리 저장'}
              </button>
            </>
          )}
          {historyMsg && (
            <p
              className={
                'text-[11px] mt-1 ' +
                (historyMsg.includes('실패') ? 'text-amber-600' : 'text-gray-400')
              }
            >
              {historyMsg}
            </p>
          )}
        </div>
      </div>

      {fileError && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">{fileError}</div>
      )}

      {unmatched.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 p-3 text-sm">
          상품마스터에 없는 컬리 마스터 코드 {unmatched.length}건: {unmatched.join(', ')}
        </div>
      )}

      {cost.warnings.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm space-y-1">
          {cost.warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      )}

      {orders.length > 0 && (
        <>
          {/* 이번 발주 요약 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">이번 발주 요약</h2>
              <span className="text-xs text-gray-500">
                부가포함 매출 (과세 상품 ×1.1, 발주 파일 공급가 기준)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">상품</th>
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-right font-medium">낱개</th>
                    <th className="px-3 py-2 text-right font-medium">공급단가</th>
                    <th className="px-3 py-2 text-right font-medium">공급가 합계</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((r) => (
                    <tr key={r.masterCode} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <div>{r.name}</div>
                        <div className="text-[11px] text-gray-400">
                          {r.masterCode}
                          {r.taxKnown ? (
                            <span className="ml-1">· {r.taxType}</span>
                          ) : (
                            <span className="ml-1 text-amber-600">· 과세구분 미확인(면세 처리)</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">{won(r.boxes)}</td>
                      <td className="px-3 py-2 text-right">{won(r.units)}</td>
                      <td className="px-3 py-2 text-right">
                        {r.unitPricesIncl.length === 0 ? '—' : r.unitPricesIncl.map(won).join(' / ')}
                      </td>
                      <td className="px-3 py-2 text-right">{won(r.supplyTotalIncl)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                    <td className="px-3 py-2">합계</td>
                    <td className="px-3 py-2 text-right">{won(summary.totalBoxes)}</td>
                    <td className="px-3 py-2 text-right">{won(summary.totalUnits)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">—</td>
                    <td className="px-3 py-2 text-right">{won(summary.totalSupplyIncl)}원</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 팔레트 요약 + 운송비 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">팔레트 요약</h2>
                <span className="text-xs text-gray-500">
                  총 {cost.totalPlt} PLT · 입고지 {pallets.length}곳
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">입고지</th>
                      <th className="px-3 py-2 text-left font-medium">권역</th>
                      <th className="px-3 py-2 text-right font-medium">PLT</th>
                      <th className="px-3 py-2 text-right font-medium">SKU</th>
                      <th className="px-3 py-2 text-right font-medium">박스</th>
                      <th className="px-3 py-2 text-right font-medium">낱개</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pallets.map((g) => {
                      const open = openDests.includes(g.dest)
                      return (
                        <React.Fragment key={g.dest}>
                          <tr
                            onClick={() =>
                              setOpenDests((prev) =>
                                prev.includes(g.dest) ? prev.filter((d) => d !== g.dest) : [...prev, g.dest],
                              )
                            }
                            aria-expanded={open}
                            className={
                              'border-t border-gray-100 cursor-pointer hover:bg-gray-50 ' +
                              (g.overSku ? 'bg-red-50' : '')
                            }
                          >
                            <td className="px-3 py-2">
                              <span className="inline-block w-4 text-gray-400">{open ? '▾' : '▸'}</span>
                              {g.dest}
                            </td>
                            <td className="px-3 py-2 text-gray-600">{g.region}</td>
                            <td className="px-3 py-2 text-right">{g.plt}</td>
                            <td className={'px-3 py-2 text-right ' + (g.overSku ? 'text-red-600 font-semibold' : '')}>
                              {g.skuCodes.length}
                              {g.overSku && <span className="ml-1 text-xs">⚠️ 3초과</span>}
                            </td>
                            <td className="px-3 py-2 text-right">{won(g.totalBoxes)}</td>
                            <td className="px-3 py-2 text-right">{won(g.totalUnits)}</td>
                          </tr>
                          {open && (
                            <tr className="border-t border-gray-100">
                              <td colSpan={6} className="px-3 py-3 bg-gray-50">
                                <table className="w-full text-xs">
                                  <thead className="text-gray-500">
                                    <tr>
                                      <th className="px-2 py-1 text-left font-medium">발주상품코드</th>
                                      <th className="px-2 py-1 text-left font-medium">상품명</th>
                                      <th className="px-2 py-1 text-right font-medium">박스</th>
                                      <th className="px-2 py-1 text-right font-medium">낱개</th>
                                      <th className="px-2 py-1 text-left font-medium">소비기한</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {g.rowIndexes.map((ri) => {
                                      const o = orders[ri]
                                      return (
                                        <tr key={`${o.productCode}-${ri}`} className="border-t border-gray-200">
                                          <td className="px-2 py-1 text-gray-600">{o.productCode}</td>
                                          <td className="px-2 py-1">
                                            {masterByCode[norm(o.masterCode)]?.alias || o.productName}
                                          </td>
                                          <td className="px-2 py-1 text-right">{won(o.boxCount)}</td>
                                          <td className="px-2 py-1 text-right">{won(o.totalUnits)}</td>
                                          <td className="px-2 py-1 text-gray-600">
                                            {o.expiry || <span className="text-amber-600">미입력</span>}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-100">
                최종 입고지 기준 분리 · 실측 박스 치수로 바닥 자리를 계산해 한 장을 넘으면 자동 분할 (PLT당 최대{' '}
                {MAX_SKU_PER_PLT} SKU)
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200">
                <h2 className="text-sm font-semibold">운송비 (부가포함)</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">항목</th>
                      <th className="px-3 py-2 text-right font-medium">단가</th>
                      <th className="px-3 py-2 text-right font-medium">수량</th>
                      <th className="px-3 py-2 text-right font-medium">금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costLines.map((l, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-2">
                          {costLabel(l.label)}
                          {l.note && <div className="text-[11px] text-gray-400">{l.note}</div>}
                        </td>
                        <td className="px-3 py-2 text-right">{won(l.unit)}</td>
                        <td className="px-3 py-2 text-right">{l.qty}</td>
                        <td className="px-3 py-2 text-right">{won(l.amount)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                      <td className="px-3 py-2" colSpan={3}>
                        합계
                      </td>
                      <td className="px-3 py-2 text-right">{won(cost.total)}원</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* 발주 목록 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">발주 목록</h2>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-gray-500">
                  파렛트수 = 포털 입력값 (같은 입고지 첫 행만 1)
                </span>
                {labelPlan.skipped.map((s) => (
                  <span key={s.masterCode} className="text-xs text-amber-700">
                    {s.name} {won(s.boxes)}박스 라벨 생략(기인쇄)
                  </span>
                ))}
                <button
                  onClick={printLabels}
                  disabled={labelPlan.labels.length === 0}
                  className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                >
                  부착 라벨 인쇄 ({labelPlan.labels.length}장)
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">발주상품코드</th>
                    <th className="px-3 py-2 text-left font-medium">입고지</th>
                    <th className="px-3 py-2 text-left font-medium">경유센터</th>
                    <th className="px-3 py-2 text-left font-medium">상품</th>
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-right font-medium">낱개</th>
                    <th className="px-3 py-2 text-left font-medium">소비기한</th>
                    <th className="px-3 py-2 text-right font-medium">파렛트수</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o, i) => {
                    const m = masterByCode[norm(o.masterCode)]
                    return (
                      <tr key={`${o.productCode}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2 text-gray-600">{o.productCode}</td>
                        <td className="px-3 py-2">{o.dest}</td>
                        <td className="px-3 py-2 text-gray-600">{o.viaCenter}</td>
                        <td className="px-3 py-2">
                          <div>{m?.alias || o.productName}</div>
                          <div className="text-[11px] text-gray-400">
                            {o.masterCode}
                            {!m && <span className="text-amber-600"> · 마스터 미매칭</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">{won(o.boxCount)}</td>
                        <td className="px-3 py-2 text-right">{won(o.totalUnits)}</td>
                        <td className="px-3 py-2 text-gray-600">{o.expiry}</td>
                        <td
                          className={
                            'px-3 py-2 text-right font-semibold ' +
                            (pltInputs[i] ? 'text-teal-700' : 'text-gray-300')
                          }
                        >
                          {pltInputs[i]}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 팔레트 적재 구성도 */}
          {planSvg && (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">팔레트 적재 구성도</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={copyNotice}
                    className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50"
                  >
                    {copied ? '✅ 복사됨' : '위킵 안내문 복사'}
                  </button>
                  <button
                    onClick={saveJpg}
                    disabled={jpgBusy}
                    className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                  >
                    {jpgBusy ? '변환 중…' : 'JPG 다운로드'}
                  </button>
                </div>
              </div>
              <div className="p-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_260px] gap-4">
                <PalletPlanView svg={planSvg} />
                <div className="text-xs text-gray-600 space-y-2 xl:border-l xl:border-gray-100 xl:pl-4">
                  <p>① 3PLT 이상 → 2.5톤 이상 배차</p>
                  <p>② 포털 파렛트수: 같은 입고지 첫 발주만 1, 나머지 0</p>
                  <p>③ 배차 마감 입고 전일 18:00 / 변경 불가 전일 17:00 / 배차 문자 전일 21:30경</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
