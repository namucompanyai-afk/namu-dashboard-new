'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProductMaster } from '@/lib/b2b/kurly'
import {
  buildRocketRows,
  indexByBarcode,
  rocketAoa,
  rocketFileName,
  routeItems,
  summarizeCoupang,
  todayKst,
  type CenterAddress,
  type CoupangOrderItem,
} from '@/lib/b2b/coupang'
import { parseCoupangFiles } from '@/lib/b2b/coupangFile'
import { buildStyledXlsx, saveBlob } from '@/lib/b2b/xlsxStyled'
import { buildCoupangHistory, historyMessage } from '@/lib/b2b/history'
import {
  buildCoupangLabelPlan,
  buildCoupangWikeepNotice,
  openCoupangLabelPrint,
} from '@/lib/b2b/coupangLabel'
import {
  buildInvoiceBlocks,
  invoiceNosText,
  parseInvoiceFile,
  reconcileInvoices,
  type InvoiceRow,
} from '@/lib/b2b/coupangInvoice'
import {
  CoupangPalletPlanView,
  PALLET_BOX_LIMIT,
  SHIP_FROM_GUIDE,
  buildCenterAdvisories,
  buildCoupangPalletPlan,
  buildPalletGroups,
  downloadCoupangPalletPlanJpg,
  renderCoupangPalletPlanSvg,
} from '@/lib/b2b/coupangDiagram'

/**
 * B2B 발주 변환 — 쿠팡
 *
 * 발주서리스트_*.xlsx 여러 개 업로드 → 출고지(진도팜/위킵) 분기 →
 * 진도팜분은 쿠팡 로켓 양식(TSV/xlsx), 위킵분은 조회용 표.
 * 기준정보(상품마스터·센터 주소록)는 /api/b2b/sheets 가 read-only 로 내려준다.
 */

const num = (n: number) => n.toLocaleString('ko-KR')
type SheetState = 'idle' | 'loading' | 'loaded' | 'error'

// 로켓 양식 열 너비 (받는분성명 … 송장)
const ROCKET_WIDTHS = [14, 16, 60, 14, 40, 10, 8, 12, 14]

export default function CoupangB2BPage() {
  const [products, setProducts] = useState<ProductMaster[]>([])
  const [centers, setCenters] = useState<CenterAddress[]>([])
  const [sheetState, setSheetState] = useState<SheetState>('idle')
  const [sheetError, setSheetError] = useState('')

  const [items, setItems] = useState<CoupangOrderItem[]>([])
  const [fileNames, setFileNames] = useState<string[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [fileError, setFileError] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const [madeDate, setMadeDate] = useState(todayKst())
  const [copied, setCopied] = useState(false)

  const loadSheets = useCallback(async () => {
    setSheetState('loading')
    setSheetError('')
    try {
      const res = await fetch('/api/b2b/sheets', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setProducts(json.products || [])
      setCenters(json.centers || [])
      setSheetState('loaded')
    } catch (e: unknown) {
      setSheetError(e instanceof Error ? e.message : String(e))
      setSheetState('error')
    }
  }, [])

  useEffect(() => {
    loadSheets()
  }, [loadSheets])

  const parseFiles = useCallback(async (files: File[]) => {
    setFileError('')
    try {
      const { items: parsed, skipped: skip } = await parseCoupangFiles(files)
      if (parsed.length === 0) {
        throw new Error('쿠팡 발주서에서 상품 행을 찾지 못했습니다. (발주서리스트_*.xlsx 인지 확인)')
      }
      setItems(parsed)
      setFileNames(files.map((f) => f.name))
      setSkipped(skip)
      setHistoryMsg('')
      setHistorySaved(false)
    } catch (err: unknown) {
      setItems([])
      setFileNames([])
      setSkipped([])
      setFileError('발주서 파싱 실패: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const productByBarcode = useMemo(() => indexByBarcode(products), [products])
  const routed = useMemo(() => routeItems(items, productByBarcode), [items, productByBarcode])

  const jindo = useMemo(() => routed.filter((r) => r.shipFrom === '진도팜'), [routed])
  const wikeep = useMemo(() => routed.filter((r) => r.shipFrom === '위킵'), [routed])
  const unknown = useMemo(() => routed.filter((r) => r.shipFrom === '미분류'), [routed])

  const rocket = useMemo(
    () => buildRocketRows(jindo, centers, madeDate),
    [jindo, centers, madeDate],
  )
  const summary = useMemo(() => summarizeCoupang(routed), [routed])

  // 발주 이력 저장 — 버튼을 눌렀을 때만 기록한다(업로드만으로는 시트에 쓰지 않음).
  // 실패해도 변환 기능은 그대로 동작해야 하므로 비차단(작은 문구만).
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
        body: JSON.stringify({ rows: buildCoupangHistory(routed) }),
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
  }, [routed])

  const missingCenters = useMemo(
    () => [...new Set(rocket.filter((r) => !r.centerKnown).map((r) => r.recipient))],
    [rocket],
  )
  const missingBoxes = useMemo(
    () => [...new Set(rocket.filter((r) => r.boxes === null).map((r) => r.itemName))],
    [rocket],
  )

  // 팔레트 필요 안내 — 발주번호 × 출고지 박스 합계 기준(운송수단 자동 판정 없음)
  const palletGroups = useMemo(() => buildPalletGroups(routed), [routed])
  const needPallet = useMemo(() => palletGroups.filter((g) => g.needsPallet), [palletGroups])
  const advisories = useMemo(() => buildCenterAdvisories(palletGroups), [palletGroups])
  const palletPlan = useMemo(() => buildCoupangPalletPlan(palletGroups), [palletGroups])
  const palletSvg = useMemo(
    () => (palletPlan.panels.length ? renderCoupangPalletPlanSvg(palletPlan) : ''),
    [palletPlan],
  )
  const [planJpgBusy, setPlanJpgBusy] = useState(false)
  const savePlanJpg = useCallback(async () => {
    setPlanJpgBusy(true)
    try {
      await downloadCoupangPalletPlanJpg(palletSvg, palletPlan.dueDate)
    } catch (e: unknown) {
      setFileError('JPG 저장 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPlanJpgBusy(false)
    }
  }, [palletSvg, palletPlan.dueDate])

  // 진도팜 송장 회신 대사 (한진 파일접수 상세내역)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [invoiceName, setInvoiceName] = useState('')
  const [invoiceError, setInvoiceError] = useState('')
  const [copiedCenter, setCopiedCenter] = useState('')

  const parseInvoices = useCallback(async (file: File) => {
    setInvoiceError('')
    try {
      const rows = await parseInvoiceFile(file)
      if (rows.length === 0) throw new Error('송장 행을 찾지 못했습니다.')
      setInvoices(rows)
      setInvoiceName(file.name)
    } catch (err: unknown) {
      setInvoices([])
      setInvoiceName('')
      setInvoiceError('송장 회신 파싱 실패: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const recon = useMemo(() => reconcileInvoices(jindo, invoices), [jindo, invoices])
  const invoiceBlocks = useMemo(() => buildInvoiceBlocks(invoices), [invoices])

  const copyInvoiceNos = useCallback(async (center: string, textValue: string) => {
    try {
      await navigator.clipboard.writeText(textValue)
      setCopiedCenter(center)
      setTimeout(() => setCopiedCenter(''), 2000)
    } catch {
      setInvoiceError('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.')
    }
  }, [])

  // 위킵분 — 부착 라벨(즉석밥은 박스 기표기라 제외) + 전달 안내문
  const labelPlan = useMemo(() => buildCoupangLabelPlan(wikeep), [wikeep])

  const printLabels = useCallback(() => {
    if (!openCoupangLabelPrint(labelPlan)) {
      setFileError('팝업이 차단되어 인쇄 창을 열지 못했습니다. 브라우저 팝업 허용 후 다시 시도해 주세요.')
    }
  }, [labelPlan])

  const copyNotice = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildCoupangWikeepNotice(wikeep))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setFileError('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.')
    }
  }, [wikeep])

  const downloadXlsx = useCallback(async () => {
    try {
      const blob = await buildStyledXlsx('대', rocketAoa(rocket), ROCKET_WIDTHS)
      saveBlob(blob, rocketFileName(madeDate))
    } catch (e: unknown) {
      setFileError('xlsx 생성 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [rocket, madeDate])

  const totalQty = routed.reduce((s, r) => s + r.confirmQty, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">B2B 발주 변환 — 쿠팡</h1>
        <p className="text-sm text-gray-500 mt-1">
          발주서 업로드 → 출고지 분기(진도팜/위킵) · 로켓 양식 · 매출 요약
        </p>
      </div>

      {/* 기준정보 + 업로드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="text-sm font-medium mb-1">① 기준정보 (구글시트 · 읽기 전용)</div>
          <p className="text-xs text-gray-500 mb-3">상품마스터(출고지·박스입수·공급가) · 쿠팡 센터 주소록</p>
          {sheetState === 'loading' && <p className="text-xs text-gray-500">⏳ 불러오는 중…</p>}
          {sheetState === 'loaded' && (
            <p className="text-xs text-gray-700">
              ✅ 상품마스터 {products.length}행 · 센터 주소록 {centers.length}행
            </p>
          )}
          {sheetState === 'error' && <p className="text-xs text-red-600 break-all">⚠️ {sheetError}</p>}
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
            const fs = Array.from(e.dataTransfer.files || [])
            if (fs.length) parseFiles(fs)
          }}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            dragOver ? 'border-teal-500 bg-teal-50' : 'border-gray-300 bg-white'
          }`}
        >
          <div className="text-sm font-medium mb-1">② 쿠팡 발주서 (.xlsx · 여러 개)</div>
          <p className="text-xs text-gray-500 mb-3">발주서리스트_*.xlsx 드래그앤드롭 또는 클릭</p>
          <label className="inline-block px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs cursor-pointer hover:bg-gray-700">
            파일 선택
            <input
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="hidden"
              onChange={(e) => {
                const fs = Array.from(e.target.files || [])
                if (fs.length) parseFiles(fs)
                e.target.value = ''
              }}
            />
          </label>
          {fileNames.length > 0 && (
            <>
              <p className="text-xs text-gray-700 mt-3">
                📄 {fileNames.length}개 파일 · {routed.length}행 · 납품가능 {num(totalQty)}
              </p>
              <button
                onClick={saveHistory}
                disabled={historySaving || routed.length === 0 || products.length === 0}
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
      {skipped.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 p-3 text-sm">
          쿠팡 발주서가 아니어서 건너뛴 파일: {skipped.join(', ')}
        </div>
      )}
      {unknown.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">
          ⚠️ 출고지 미분류 {unknown.length}건 — 상품마스터 출고지 확인 필요:{' '}
          {[...new Set(unknown.map((u) => `${u.productName}(${u.barcode || '바코드 없음'})`))].join(', ')}
        </div>
      )}
      {missingCenters.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">
          ⚠️ 센터 주소록 미등록 {missingCenters.length}곳 — 주소·전화 공란: {missingCenters.join(', ')}
        </div>
      )}
      {missingBoxes.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 p-3 text-sm">
          ⚠️ 상품마스터 미등록(박스 수 공란): {missingBoxes.join(', ')}
        </div>
      )}

      {routed.length > 0 && (
        <>
          {/* 매출 요약 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">이번 발주 매출 요약</h2>
              <span className="text-xs text-gray-500">
                부가포함 매출 (과세 상품 ×1.1, 시트 쿠팡 공급가 기준)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">상품</th>
                    <th className="px-3 py-2 text-right font-medium">수량</th>
                    <th className="px-3 py-2 text-right font-medium">공급단가</th>
                    <th className="px-3 py-2 text-right font-medium">매출 합계</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((r) => (
                    <tr key={r.barcode || r.name} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <div>{r.name}</div>
                        <div className="text-[11px] text-gray-400">
                          {r.barcode}
                          {r.taxKnown ? (
                            <span className="ml-1">· {r.taxType}</span>
                          ) : (
                            <span className="ml-1 text-amber-600">· 과세구분 미확인(면세 처리)</span>
                          )}
                          {!r.masterKnown && <span className="ml-1 text-red-600">· 마스터 미등록</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">{num(r.qty)}</td>
                      <td className="px-3 py-2 text-right">{num(r.unitPriceIncl)}</td>
                      <td className="px-3 py-2 text-right">{num(r.totalIncl)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                    <td className="px-3 py-2">합계</td>
                    <td className="px-3 py-2 text-right">{num(summary.totalQty)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">—</td>
                    <td className="px-3 py-2 text-right">{num(summary.totalIncl)}원</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 팔레트 필요 안내 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">팔레트 필요 안내</h2>
              <span className="text-xs text-gray-500">
                발주 × 출고지 박스 합계 기준 · {PALLET_BOX_LIMIT}박스 초과 시 택배 불가
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">발주번호</th>
                    <th className="px-3 py-2 text-left font-medium">센터</th>
                    <th className="px-3 py-2 text-left font-medium">입고예정일</th>
                    <th className="px-3 py-2 text-left font-medium">출고지</th>
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-left font-medium">판정</th>
                  </tr>
                </thead>
                <tbody>
                  {palletGroups.map((g) => (
                    <tr
                      key={`${g.poNumber}-${g.shipFrom}`}
                      className={'border-t border-gray-100 ' + (g.needsPallet ? 'bg-amber-50' : '')}
                    >
                      <td className="px-3 py-2 text-gray-600">{g.poNumber}</td>
                      <td className="px-3 py-2">{g.center}</td>
                      <td className="px-3 py-2 text-gray-600">{g.dueDate}</td>
                      <td className="px-3 py-2">{g.shipFrom}</td>
                      <td className="px-3 py-2 text-right">{num(g.boxes)}</td>
                      <td className="px-3 py-2">
                        {g.needsPallet ? (
                          <span className="px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-semibold">
                            팔레트 필요 ({PALLET_BOX_LIMIT}박스 초과)
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">택배 가능</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 space-y-1 text-xs">
              {advisories.map((a) => (
                <p key={`${a.center}-${a.dueDate}`} className="text-amber-700">
                  ※ {a.center} · {a.dueDate}: 동일 센터·동일 입고일 합산 {num(a.boxes)}박스 — 팔레트 여부 확인 권장
                </p>
              ))}
              {[...new Set(needPallet.map((g) => g.shipFrom))].map((sf) => (
                <p key={sf} className="text-gray-600">
                  · {SHIP_FROM_GUIDE[sf]}
                </p>
              ))}
              {needPallet.length === 0 && advisories.length === 0 && (
                <p className="text-gray-400">전 발주 {PALLET_BOX_LIMIT}박스 이하 — 택배 발송 가능</p>
              )}
            </div>
          </div>

          {/* 팔레트 적재 구성도 — 팔레트 필요 발주만 */}
          {palletSvg && (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">팔레트 적재 구성도</h2>
                <button
                  onClick={savePlanJpg}
                  disabled={planJpgBusy}
                  className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                >
                  {planJpgBusy ? '변환 중…' : 'JPG 다운로드'}
                </button>
              </div>
              <div className="p-4">
                <CoupangPalletPlanView svg={palletSvg} />
              </div>
            </div>
          )}

          {/* 진도팜분 — 로켓 양식 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">진도팜분 — 쿠팡 로켓 양식 ({rocket.length}행)</h2>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-gray-600">
                  제조일자
                  <input
                    type="date"
                    value={madeDate}
                    onChange={(e) => setMadeDate(e.target.value)}
                    className="ml-2 px-2 py-1 border border-gray-300 rounded text-xs"
                  />
                </label>
                <button
                  onClick={downloadXlsx}
                  disabled={rocket.length === 0}
                  className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                >
                  xlsx 다운로드
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">받는분성명</th>
                    <th className="px-3 py-2 text-left font-medium">받는분전화번호</th>
                    <th className="px-3 py-2 text-left font-medium">받는분주소</th>
                    <th className="px-3 py-2 text-left font-medium">배송메세지1</th>
                    <th className="px-3 py-2 text-left font-medium">내품명</th>
                    <th className="px-3 py-2 text-right font-medium">내품수량</th>
                    <th className="px-3 py-2 text-right font-medium">박스 수</th>
                    <th className="px-3 py-2 text-left font-medium">제조일자</th>
                    <th className="px-3 py-2 text-left font-medium">송장</th>
                  </tr>
                </thead>
                <tbody>
                  {rocket.map((r, i) => (
                    <tr
                      key={`${r.poNumber}-${r.itemName}-${i}`}
                      className={'border-t border-gray-100 ' + (r.centerKnown ? '' : 'bg-red-50')}
                    >
                      <td className="px-3 py-2">
                        {r.recipient}
                        {!r.centerKnown && <span className="ml-1 text-[11px] text-red-600">미등록</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.phone}</td>
                      <td className="px-3 py-2 max-w-[26rem] truncate" title={r.address}>
                        {r.address}
                      </td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 max-w-[22rem] truncate" title={r.itemName}>
                        {r.itemName}
                      </td>
                      <td className="px-3 py-2 text-right">{num(r.itemQty)}</td>
                      <td className={'px-3 py-2 text-right ' + (r.boxes === null ? 'text-amber-600' : '')}>
                        {r.boxes ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.madeDate}</td>
                      <td className="px-3 py-2" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-100">
              정렬: 입고예정일 → 발주번호 · 박스 수 = 올림(납품가능수량 ÷ 박스입수) · 배송메세지1·송장은 공란
            </p>
          </div>

          {/* 진도팜 송장 회신 대사 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">진도팜 송장 회신</h2>
              <div className="flex flex-wrap items-center gap-3">
                {invoiceName && (
                  <span className="text-xs text-gray-500">
                    📄 {invoiceName} · 송장 {num(recon.totalInvoices)}건 / 발주 {num(recon.totalBoxes)}박스
                    {invoices.length > 0 && (
                      <span className={recon.allMatch ? ' text-green-700' : ' text-red-600'}>
                        {' '}· {recon.allMatch ? '전건 일치' : '불일치 있음'}
                      </span>
                    )}
                  </span>
                )}
                <label
                  className={
                    'inline-block px-3 py-1.5 rounded-md text-xs ' +
                    (jindo.length === 0
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-gray-900 text-white cursor-pointer hover:bg-gray-700')
                  }
                >
                  회신 파일 (.xlsx)
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    disabled={jindo.length === 0}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) parseInvoices(f)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
            </div>

            {invoiceError && (
              <p className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{invoiceError}</p>
            )}

            {invoices.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-400">
                {jindo.length === 0
                  ? '쿠팡 발주서를 먼저 업로드하세요.'
                  : '한진 파일접수 상세내역 xlsx 를 올리면 발주와 대사합니다.'}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">센터</th>
                        <th className="px-3 py-2 text-left font-medium">상품</th>
                        <th className="px-3 py-2 text-right font-medium">발주 박스</th>
                        <th className="px-3 py-2 text-right font-medium">송장 수</th>
                        <th className="px-3 py-2 text-right font-medium">내품수량 / 납품가능</th>
                        <th className="px-3 py-2 text-left font-medium">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recon.rows.map((r) => (
                        <tr
                          key={`${r.center}-${r.product}`}
                          className={'border-t border-gray-100 ' + (r.ok ? '' : 'bg-red-50')}
                        >
                          <td className="px-3 py-2">{r.center}</td>
                          <td className="px-3 py-2 max-w-[24rem] truncate" title={r.product}>
                            {r.product}
                          </td>
                          <td className="px-3 py-2 text-right">{r.inOrder ? num(r.orderBoxes) : '—'}</td>
                          <td
                            className={
                              'px-3 py-2 text-right ' +
                              (r.inOrder && r.invoiceCount !== r.orderBoxes ? 'text-red-600 font-semibold' : '')
                            }
                          >
                            {r.inInvoice ? num(r.invoiceCount) : '—'}
                          </td>
                          <td
                            className={
                              'px-3 py-2 text-right ' +
                              (r.inOrder && r.inInvoice && r.invoiceUnits !== r.orderUnits
                                ? 'text-red-600 font-semibold'
                                : '')
                            }
                          >
                            {r.inInvoice ? num(r.invoiceUnits) : '—'} / {r.inOrder ? num(r.orderUnits) : '—'}
                          </td>
                          <td className="px-3 py-2">
                            {r.ok ? (
                              <span className="text-green-700">✅ 일치</span>
                            ) : !r.inOrder ? (
                              <span className="text-red-600">❌ 발주에 없는 송장</span>
                            ) : !r.inInvoice ? (
                              <span className="text-red-600">❌ 송장 없음</span>
                            ) : (
                              <span className="text-red-600">
                                ❌ 불일치 ({num(r.invoiceCount)}/{num(r.orderBoxes)})
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 쉽먼트 등록용 송장 정리 */}
                <div className="px-4 py-3 border-t border-gray-200">
                  <div className="text-xs font-semibold text-gray-700 mb-2">쉽먼트 등록용 송장</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {invoiceBlocks.map((b) => (
                      <div key={b.center} className="rounded border border-gray-200 p-3">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-xs font-semibold">
                            {b.center} · {num(b.count)}건
                          </span>
                          <button
                            onClick={() => copyInvoiceNos(b.center, invoiceNosText(b))}
                            className="px-2 py-1 rounded border border-gray-300 text-gray-700 text-[11px] hover:bg-gray-50"
                          >
                            {copiedCenter === b.center ? '✅ 복사됨' : '송장번호 복사'}
                          </button>
                        </div>
                        {b.products.map((p) => (
                          <div key={p.product} className="mb-2 last:mb-0">
                            <div className="text-[11px] text-gray-500 truncate" title={p.product}>
                              {p.product} ({p.invoiceNos.length})
                            </div>
                            <div className="text-[11px] text-gray-700 font-mono leading-relaxed">
                              {p.invoiceNos.map((no) => (
                                <div key={no}>{no}</div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 위킵분 — 조회용 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">위킵분 ({wikeep.length}행)</h2>
              <div className="flex flex-wrap items-center gap-3">
                {labelPlan.skipped.map((s) => (
                  <span key={s.label} className="text-xs text-amber-700">
                    {s.label} {num(s.boxes)}박스 라벨 생략(기인쇄)
                  </span>
                ))}
                <button
                  onClick={copyNotice}
                  disabled={wikeep.length === 0}
                  className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200"
                >
                  {copied ? '✅ 복사됨' : '위킵 안내문 복사'}
                </button>
                <button
                  onClick={printLabels}
                  disabled={labelPlan.labels.length === 0}
                  className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                >
                  부착 라벨 인쇄 ({labelPlan.labels.length}장)
                </button>
              </div>
            </div>
            {wikeep.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-400">위킵 출고 상품 없음</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">발주번호</th>
                      <th className="px-3 py-2 text-left font-medium">센터</th>
                      <th className="px-3 py-2 text-left font-medium">입고예정일</th>
                      <th className="px-3 py-2 text-left font-medium">상품명</th>
                      <th className="px-3 py-2 text-right font-medium">납품가능수량</th>
                      <th className="px-3 py-2 text-right font-medium">박스 수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wikeep.map((r, i) => (
                      <tr key={`${r.poNumber}-${r.barcode}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2 text-gray-600">{r.poNumber}</td>
                        <td className="px-3 py-2">{r.center}</td>
                        <td className="px-3 py-2 text-gray-600">{r.dueDate}</td>
                        <td className="px-3 py-2 max-w-[24rem] truncate" title={r.productName}>
                          {r.productName}
                        </td>
                        <td className="px-3 py-2 text-right">{num(r.confirmQty)}</td>
                        <td className={'px-3 py-2 text-right ' + (r.boxes === null ? 'text-amber-600' : '')}>
                          {r.boxes ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
