'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { MASTER_SHEET_ID } from '@/lib/sheet-ids'
import type { ProductMaster } from '@/lib/b2b/kurly'
import {
  buildRocketRows,
  GOMPYO_BOXES_PER_PLT,
  GOMPYO_UNITS_PER_PLT,
  indexByBarcode,
  rocketAoa,
  rocketFileName,
  routeItems,
  splitRocketRows,
  summarizeCoupangFiles,
  ROCKET_SHEETS,
  summarizeCoupang,
  todayKst,
  type CenterAddress,
  type CoupangOrderItem,
  type RocketRow,
  type RoutedItem,
} from '@/lib/b2b/coupang'
import { parseCoupangFiles } from '@/lib/b2b/coupangFile'
import { buildStyledXlsxSheets, saveBlob } from '@/lib/b2b/xlsxStyled'
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
  GRAIN_MAX_TIERS,
  LIMIT_MM,
  PALLET_MM,
  pltCountOf,
  renderCoupangPalletPlanSvg,
  SCRAP_NOTE,
} from '@/lib/b2b/coupangDiagram'
import {
  buildMilkrunShipments,
  countByShipFrom,
  priceOriginByShipFrom,
  shipmentByPo,
  sumMilkrun,
  type CoupangMilkrunRow,
} from '@/lib/b2b/coupangMilkrun'
import { downloadCoupangPalletPdf, LOW_BOX_PLT_WARN } from '@/lib/b2b/coupangPalletPdf'
import { buildGompyoNotice, buildGompyoShipments, sumGompyo } from '@/lib/b2b/coupangGompyo'
import {
  compareFreight,
  isParcelReviewTarget,
  PARCEL_KEEP_BOXES,
  reviewParcel,
  type FreightCompare,
  type ParcelLine,
  type ParcelSettings,
  type ParcelReview,
  type UnitCost,
} from '@/lib/b2b/coupangParcel'

/**
 * B2B 발주 변환 — 쿠팡
 *
 * 발주서리스트_*.xlsx 여러 개 업로드 → 출고지(진도팜/위킵/곰표) 분기 →
 * 진도팜분은 쿠팡 로켓 양식(TSV/xlsx), 위킵분·곰표분은 조회용 표(곰표는 전 발주 밀크런).
 * 기준정보(상품마스터·센터 주소록)는 /api/b2b/sheets 가 read-only 로 내려준다.
 */

const num = (n: number) => n.toLocaleString('ko-KR')
/** kg — 천 단위 콤마, 소수 첫째 자리까지(정수면 소수점 없이) */
const kgFmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 1 })
type SheetState = 'idle' | 'loading' | 'loaded' | 'error'

// 로켓 양식 열 너비 (받는분성명 … 송장)
const ROCKET_WIDTHS = [14, 16, 60, 14, 40, 10, 8, 12, 14]
const TRUCK_WIDTHS = [14, 16, 60, 14, 40, 10, 8, 12, 10, 14]

/** 행 펼침 — 9박스로 줄일 때 SUPPLIER HUB 에 넣을 납품가능수량 (발주서 순서) */
function ParcelReduceTable({
  items,
  review,
}: {
  items: RoutedItem[]
  review: Extract<ParcelReview, { status: 'ok' }>
}) {
  const dropOf = new Map<RoutedItem, ParcelLine>(review.drop.map((l) => [l.item, l]))
  const rows = items.map((it) => {
    const d = dropOf.get(it)
    const boxQty = it.master?.boxQty ?? 0
    const keepBoxes = d && it.boxes !== null ? it.boxes - d.boxes : it.boxes
    return { it, d, boxQty, keepBoxes, input: d ? (keepBoxes ?? 0) * boxQty : it.confirmQty }
  })
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0)
  return (
    <div className="space-y-2 text-xs text-gray-700">
      <div className="font-semibold">{PARCEL_KEEP_BOXES}박스로 줄일 때 — SUPPLIER HUB 입력값</div>
      <table className="w-full text-xs">
        <thead className="text-gray-500">
          <tr>
            <th className="px-2 py-1 text-left font-medium">상품</th>
            <th className="px-2 py-1 text-right font-medium">입수</th>
            <th className="px-2 py-1 text-right font-medium">발주 수량</th>
            <th className="px-2 py-1 text-right font-medium">입력할 납품가능수량</th>
            <th className="px-2 py-1 text-right font-medium">박스</th>
            <th className="px-2 py-1 text-right font-medium">잃는 매출</th>
            <th className="px-2 py-1 text-right font-medium">잃는 마진</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ it, d, boxQty, keepBoxes, input }, i) => (
            <tr key={`${it.barcode}-${i}`} className={'border-t border-gray-200 ' + (d ? 'bg-rose-50' : '')}>
              <td className="px-2 py-1">{it.productName}</td>
              <td className="px-2 py-1 text-right">{boxQty ? num(boxQty) : '—'}</td>
              <td className="px-2 py-1 text-right">{num(it.confirmQty)}</td>
              <td className="px-2 py-1 text-right">
                {d ? (
                  <span className="text-base font-bold">{num(input)}</span>
                ) : (
                  <span className="text-gray-400">{num(input)} (그대로)</span>
                )}
              </td>
              <td className="px-2 py-1 text-right">
                {it.boxes === null ? (
                  <span className="text-amber-600">미등록</span>
                ) : d ? (
                  <>
                    {num(it.boxes)} → <span className="font-bold">{num(keepBoxes ?? 0)}</span>
                  </>
                ) : (
                  num(it.boxes)
                )}
              </td>
              <td className="px-2 py-1 text-right">
                {d ? <span className="text-rose-600 font-semibold">{num(d.lostSales)}원</span> : '—'}
              </td>
              <td className="px-2 py-1 text-right">
                {d ? (
                  <span
                    className="text-rose-600 font-semibold cursor-help"
                    title={`1박스 마진(트럭 기준) ${num(d.boxMargin)}원`}
                  >
                    {num(d.boxMargin * d.boxes)}원
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-gray-400 font-bold">
            <td className="px-2 py-1">합계</td>
            <td className="px-2 py-1" />
            <td className="px-2 py-1 text-right">{num(sum((r) => r.it.confirmQty))}</td>
            <td className="px-2 py-1 text-right">{num(sum((r) => r.input))}</td>
            <td className="px-2 py-1 text-right">
              {num(sum((r) => r.it.boxes ?? 0))} → {num(sum((r) => r.keepBoxes ?? 0))}
            </td>
            <td className="px-2 py-1 text-right text-rose-600">{num(review.lostSales)}원</td>
            <td className="px-2 py-1 text-right text-rose-600">{num(review.lost)}원</td>
          </tr>
        </tbody>
      </table>
      <div className="text-gray-500">
        빼는 기준: 1박스 마진(트럭 기준) 낮은 상품부터, 같으면 박스 많은 상품부터
      </div>
      <div className="bg-amber-50 border-l-4 border-amber-400 text-amber-900 font-semibold px-3 py-2">
        포장 전 {PARCEL_KEEP_BOXES}박스 확정 · 잡곡 포장 후 14일
      </div>
    </div>
  )
}

/** 팔레트 필요 안내 '개당 운임' 칸 — 1줄 트럭 vs 택배(최저 입수), 2줄 손익분기 · 나머지 입수 */
function FreightCell({ freight: f, parcelTarget }: { freight: FreightCompare; parcelTarget: boolean }) {
  const [best, ...others] = f.parcelPerBag // 입수 큰 순 = 1봉당 택배비 싼 순
  const truckCheaper = best ? f.truckPerBag < best.perBag : false
  const truckColor = truckCheaper ? 'text-emerald-600' : 'text-rose-600'
  const parcelColor = truckCheaper ? 'text-rose-600' : 'text-emerald-600'
  const b = f.breakeven
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className={`text-base font-bold ${truckColor}`}>트럭 {num(Math.round(f.truckPerBag))}원</span>
        <span className="text-gray-400">vs</span>
        {best && (
          <span className={`text-base font-bold ${parcelColor}`}>택배 {num(Math.round(best.perBag))}원</span>
        )}
        <span className="text-xs text-gray-400">/봉</span>
        {parcelTarget && (
          <span className="ml-1 rounded bg-blue-100 px-2 text-xs font-semibold text-blue-800">
            택배 전환 가능 · {PARCEL_KEEP_BOXES}박스
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500 whitespace-nowrap">
        {b === null
          ? '트럭이 항상 불리'
          : b && `${num(b.boxes)}박스(${num(b.bags)}봉)↑부터 트럭 유리 · ${b.vehicle}`}
        {others.length > 0 && (
          <span className="ml-1 text-gray-400">
            ({others.map((o) => `${o.boxQty}입 ${num(Math.round(o.perBag))}`).join(' · ')})
          </span>
        )}
      </div>
    </div>
  )
}

export default function CoupangB2BPage() {
  const [products, setProducts] = useState<ProductMaster[]>([])
  const [centers, setCenters] = useState<CenterAddress[]>([])
  const [milkrunPrices, setMilkrunPrices] = useState<CoupangMilkrunRow[]>([])
  const [gramByAlias, setGramByAlias] = useState<Record<string, number>>({})
  const [unitCostByAlias, setUnitCostByAlias] = useState<Record<string, UnitCost>>({})
  const [parcelSettings, setParcelSettings] = useState<ParcelSettings>({
    bagFee: null,
    boxFee: null,
    parcelFee: null,
  })
  const [sheetState, setSheetState] = useState<SheetState>('idle')
  const [sheetError, setSheetError] = useState('')

  const [items, setItems] = useState<CoupangOrderItem[]>([])
  const [fileNames, setFileNames] = useState<string[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [fileError, setFileError] = useState('')
  const [dragOver, setDragOver] = useState(false)

  // 제조일자는 대표님이 고르기 전까지 공란 — 빈 값이면 로켓 표·xlsx 제조일자 열도 공란
  const [madeDate, setMadeDate] = useState('')
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
      setMilkrunPrices(json.coupangPrices || [])
      setGramByAlias(json.gramByAlias || {})
      setUnitCostByAlias(json.unitCostByAlias || {})
      if (json.parcelSettings) setParcelSettings(json.parcelSettings)
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
      // 업로드마다 공란으로 되돌린다 — 지난 발주의 날짜가 새 발주에 따라가지 않게.
      // 업로드 뒤 고른 값은 다음 업로드 전까지 유지된다.
      setMadeDate('')
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
  const gompyo = useMemo(() => routed.filter((r) => r.shipFrom === '곰표'), [routed])
  const unknown = useMemo(() => routed.filter((r) => r.shipFrom === '미분류'), [routed])
  // 상품마스터 미등록 (바코드·쿠팡 SKU ID 둘 다 없음) — 관리자 "상품마스터에 추가" 대상
  const unregistered = useMemo(() => {
    const bc = new Set(products.map((p) => p.barcode.replace(/\s+/g, '')).filter(Boolean))
    const sku = new Set(products.map((p) => p.coupangSkuId.replace(/\s+/g, '')).filter(Boolean))
    const seen = new Set<string>()
    const out: { name: string; skuId: string; supply: number; barcode: string }[] = []
    for (const it of items) {
      const b = it.barcode.replace(/\s+/g, '')
      const k = (it.skuId || '').replace(/\s+/g, '')
      if ((!b && !k) || (b && bc.has(b)) || (k && sku.has(k))) continue
      const key = b || k
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: it.productName, skuId: it.skuId || '', supply: it.unitPrice, barcode: it.barcode })
    }
    return out
  }, [items, products])
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    try { setIsAdmin(JSON.parse(localStorage.getItem('user') || '{}')?.role === '관리자') } catch { /* 무시 */ }
  }, [])
  const [pmBusy, setPmBusy] = useState(false)
  const [pmMsg, setPmMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const addToProductMaster = async () => {
    setPmBusy(true)
    setPmMsg(null)
    try {
      const res = await fetch('/api/b2b/product-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: unregistered }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setPmMsg({ ok: true, text: j.added > 0 ? `상품마스터에 ${j.added}개 추가됨 — 별칭·출고지·박스입수 입력 필요` : '추가할 상품 없음 (이미 등록됨)' })
      await loadSheets()
    } catch (e: unknown) {
      setPmMsg({ ok: false, text: '상품마스터 추가 실패: ' + (e instanceof Error ? e.message : String(e)) })
    } finally {
      setPmBusy(false)
    }
  }
  // 납품가능 미확정 — 확정 전/구버전 발주서 업로드 방어 (있으면 이력 저장 차단)
  const unconfirmed = useMemo(() => routed.filter((r) => r.qtyUnconfirmed), [routed])
  // 발주서 매입가 미확인 — 잘못된 매출을 이력에 남기지 않도록 저장 차단
  // (미납품 행은 매출이 0이고 이력에도 안 들어가므로 차단 대상이 아니다)
  const noPrice = useMemo(
    () => routed.filter((r) => !r.notDelivered && r.unitPrice <= 0),
    [routed],
  )
  // 미납품 — 확정 발주서 안의 납품가능 0 행. 차단하지 않고 표기만 한다
  const notDelivered = useMemo(() => routed.filter((r) => r.notDelivered), [routed])
  const fileStats = useMemo(() => summarizeCoupangFiles(items), [items])

  // 팔레트 필요 안내 — 센터 × 입고예정일 × 출고지 박스 합계 기준
  const palletGroups = useMemo(() => buildPalletGroups(routed), [routed])
  // PLT 장수는 실측 적재 기준(자리 수 × SKU별 단수) — 로켓 양식 파렛트 수도 같은 값을 쓴다.
  // 키는 묶음(센터|입고예정일)이고, 로켓 양식은 진도팜분만 쓰므로 진도팜 묶음만 담는다.
  const pltByGroup = useMemo(() => {
    const m: Record<string, number> = {}
    for (const g of palletGroups) if (g.shipFrom === '진도팜') m[g.key] = pltCountOf(g)
    return m
  }, [palletGroups])

  const rocket = useMemo(
    () => buildRocketRows(jindo, centers, madeDate, pltByGroup),
    [jindo, centers, madeDate, pltByGroup],
  )
  // 센터·입고예정일 묶음 9박스 이하 = 택배 발송분 / 초과 = 트럭 발송분(밀크런)
  const { parcel: rocketParcel, truck: rocketTruck } = useMemo(() => splitRocketRows(rocket), [rocket])
  const summary = useMemo(() => summarizeCoupang(routed, gramByAlias), [routed, gramByAlias])

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

  const needPallet = useMemo(() => palletGroups.filter((g) => g.needsPallet), [palletGroups])
  const advisories = useMemo(() => buildCenterAdvisories(palletGroups), [palletGroups])
  const [openPos, setOpenPos] = useState<string[]>([]) // 팔레트 안내 펼친 발주(발주번호|출고지)
  // 요금표 출고지 매핑 — 상품마스터 '요금표 출고지' 컬럼이 단일 소스(코드 하드코딩 없음)
  const priceOrigin = useMemo(() => priceOriginByShipFrom(products), [products])
  const priceOriginMissing = products.length > 0 && Object.keys(priceOrigin).length === 0
  // 밀크런 운임(참고) — 진도팜·위킵 팔레트 발주, 출고지 × 센터 × 입고예정일 묶음
  // (진도팜은 차량 구간 요금, 위킵은 곰표와 같은 BASIC×PLT vs 차량 최저가)
  const shipments = useMemo(
    () => buildMilkrunShipments(palletGroups, milkrunPrices, priceOrigin),
    [palletGroups, milkrunPrices, priceOrigin],
  )
  const shipmentOf = useMemo(() => shipmentByPo(shipments), [shipments])
  // 구성도 센터 합계 차량은 팔레트 필요 안내 표와 같은 값(ship.method || ship.vehicleLabel)을 그대로 넘긴다
  const palletPlan = useMemo(
    () =>
      buildCoupangPalletPlan(palletGroups, {
        gramByAlias,
        vehicleOf: (g) => {
          const ship = shipmentOf[`${g.poNumber}|${g.center}|${g.dueDate}`]
          return ship ? ship.method || ship.vehicleLabel : ''
        },
        feeOf: (g) => shipmentOf[`${g.poNumber}|${g.center}|${g.dueDate}`]?.fee,
      }),
    [palletGroups, gramByAlias, shipmentOf],
  )
  const milkrunTotals = useMemo(() => sumMilkrun(shipments), [shipments])
  // 운임 합계에 들어간 발주(밀크런 운임 계산된 행)의 매출 — 매출 요약과 같은 기준(부가포함, 발주서 매입가)
  const milkrunSales = useMemo(() => {
    const priced = palletGroups.filter(
      (g) => shipmentOf[`${g.poNumber}|${g.center}|${g.dueDate}`]?.fee != null,
    )
    return summarizeCoupang(priced.flatMap((g) => g.items), gramByAlias).totalIncl
  }, [palletGroups, shipmentOf, gramByAlias])
  // 개당 운임 (트럭 vs 택배, 참고) — 밀크런 운임이 있는 건마다(합산 발주는 한 건으로)
  const freightOf = useMemo(() => {
    const m: Record<string, FreightCompare> = {}
    for (const s of shipments) {
      if (s.fee === null) continue
      const gs = palletGroups.filter((g) => shipmentOf[`${g.poNumber}|${g.center}|${g.dueDate}`] === s)
      m[s.key] = compareFreight(gs, s.fee, milkrunPrices, priceOrigin[s.shipFrom] ?? '', s.center, parcelSettings)
    }
    return m
  }, [shipments, palletGroups, shipmentOf, milkrunPrices, priceOrigin, parcelSettings])
  // 행 펼침(참고) — 진도팜 10~20박스 묶음을 9박스로 줄일 때 뺄 박스·잃는 마진(트럭 운임 차감)
  const parcelReviewOf = useMemo(() => {
    const m: Record<string, ParcelReview> = {}
    for (const g of palletGroups) {
      const ship = shipmentOf[`${g.poNumber}|${g.center}|${g.dueDate}`]
      m[`${g.poNumber}|${g.shipFrom}`] = reviewParcel(g, ship ? freightOf[ship.key]?.truckPerBag ?? null : null, {
        unitCostByAlias,
        settings: parcelSettings,
      })
    }
    return m
  }, [palletGroups, shipmentOf, freightOf, unitCostByAlias, parcelSettings])
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
  const [planOpen, setPlanOpen] = useState(false)
  const lowBoxPanels = useMemo(
    () => palletPlan.panels.filter((p) => p.boxes < LOW_BOX_PLT_WARN),
    [palletPlan],
  )
  const [planPdfBusy, setPlanPdfBusy] = useState(false)
  const savePlanPdf = useCallback(async () => {
    setPlanPdfBusy(true)
    try {
      await downloadCoupangPalletPdf(palletPlan)
    } catch (e: unknown) {
      setFileError('PDF 저장 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPlanPdfBusy(false)
    }
  }, [palletPlan])

  // 진도팜 송장 회신 대사 (한진 파일접수 상세내역)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [invoiceName, setInvoiceName] = useState('')
  const [invoiceError, setInvoiceError] = useState('')
  const [copiedCenter, setCopiedCenter] = useState('')
  const [copiedNo, setCopiedNo] = useState('')

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

  // 송장번호 1개만 복사 — 쉽먼트 화면에 한 건씩 붙여 넣을 때
  const copyInvoiceNo = useCallback(async (key: string, invoiceNo: string) => {
    try {
      await navigator.clipboard.writeText(invoiceNo)
      setCopiedNo(key)
      setTimeout(() => setCopiedNo(''), 1500)
    } catch {
      setInvoiceError('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.')
    }
  }, [])

  // 곰표분 — 전 발주 밀크런. PLT 는 봉 수 합(400봉/PLT), 운임은 BASIC×PLT vs 차량 구간 최저가
  const gompyoShipments = useMemo(
    () => buildGompyoShipments(gompyo, milkrunPrices, priceOrigin['곰표'] ?? ''),
    [gompyo, milkrunPrices, priceOrigin],
  )
  const gompyoTotals = useMemo(() => sumGompyo(gompyoShipments), [gompyoShipments])
  const [gompyoCopied, setGompyoCopied] = useState(false)

  const copyGompyoNotice = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildGompyoNotice(gompyoShipments))
      setGompyoCopied(true)
      setTimeout(() => setGompyoCopied(false), 2000)
    } catch {
      setFileError('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.')
    }
  }, [gompyoShipments])

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
      const blob = await buildStyledXlsxSheets([
        {
          name: ROCKET_SHEETS['택배'].sheetName,
          rows: rocketAoa(rocketParcel, '택배'),
          widths: ROCKET_WIDTHS,
          titleRows: 1,
        },
        {
          name: ROCKET_SHEETS['트럭'].sheetName,
          rows: rocketAoa(rocketTruck, '트럭'),
          widths: TRUCK_WIDTHS,
          titleRows: 1,
        },
      ])
      saveBlob(blob, rocketFileName(madeDate))
    } catch (e: unknown) {
      setFileError('xlsx 생성 실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [rocketParcel, rocketTruck, madeDate])

  const totalQty = routed.reduce((s, r) => s + r.confirmQty, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">B2B 발주 변환 — 쿠팡</h1>
        <p className="text-sm text-gray-500 mt-1">
          발주서 업로드 → 출고지 분기(진도팜/위킵/곰표) · 로켓 양식 · 매출 요약
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
              <ul className="mt-1 space-y-0.5 text-[11px] text-gray-500">
                {fileStats.map((f) => (
                  <li key={f.fileName} className={f.unconfirmed > 0 ? 'text-amber-700' : ''}>
                    {f.fileName} · {f.rows}행 · 발주 {num(f.orderQty)} / 납품가능 {num(f.confirmQty)}
                    {f.unconfirmed > 0 && <> · 미확정 {f.unconfirmed}행</>}
                    {f.notDelivered > 0 && <> · 미납품 {f.notDelivered}행</>}
                  </li>
                ))}
              </ul>
              <button
                onClick={saveHistory}
                disabled={
                  historySaving ||
                  routed.length === 0 ||
                  products.length === 0 ||
                  unconfirmed.length > 0 ||
                  noPrice.length > 0
                }
                className="mt-2 px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200"
              >
                {historySaving ? '저장 중…' : historySaved ? '✅ 저장됨 (다시 저장)' : '세일즈 히스토리 저장'}
              </button>
              {unconfirmed.length > 0 && (
                <p className="text-[11px] text-amber-700 mt-1">
                  납품가능 미확정 {unconfirmed.length}행이라 이력을 저장할 수 없습니다 — 확정 발주서로 다시 받아
                  업로드해 주세요.
                </p>
              )}
              {noPrice.length > 0 && (
                <p className="text-[11px] text-red-600 mt-1">
                  발주서 매입가 미확인 {noPrice.length}행이라 이력을 저장할 수 없습니다 — 매출이 0으로 기록되는
                  것을 막기 위한 차단입니다.
                </p>
              )}
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
      {isAdmin && (unregistered.length > 0 || pmMsg) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          {unregistered.length > 0 && (
            <>
              <span>상품마스터에 없는 상품 {unregistered.length}개 (바코드·쿠팡 SKU ID 기준)</span>
              <button
                onClick={addToProductMaster}
                disabled={pmBusy}
                className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {pmBusy ? '추가 중…' : `상품마스터에 추가 (${unregistered.length}개)`}
              </button>
            </>
          )}
          {pmMsg && (
            <span className={pmMsg.ok ? 'text-blue-900' : 'text-red-700'}>
              {pmMsg.text}{' '}
              {pmMsg.ok && (
                <a href={`https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/edit`} target="_blank" rel="noreferrer" className="underline">
                  나무_마스터 상품마스터 열기 ↗
                </a>
              )}
            </span>
          )}
        </div>
      )}
      {unknown.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">
          ⚠️ 출고지 미분류 {unknown.length}건 — 상품마스터 출고지 확인 필요:{' '}
          {[...new Set(unknown.map((u) => `${u.productName}(${u.barcode || '바코드 없음'})`))].join(', ')}
        </div>
      )}
      {priceOriginMissing && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 p-3 text-sm">
          ⚠️ 상품마스터에 &lsquo;요금표 출고지&rsquo; 컬럼이 없거나 비어 있어 밀크런 운임을 계산하지 못합니다 —
          컬럼을 추가하고 진도팜 행 <b>전남진도_2</b> · 위킵 행 <b>화성시_1</b> · 곰표 행 <b>시흥시_1</b> 을 채워 주세요.
        </div>
      )}
      {notDelivered.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 text-gray-600 p-3 text-sm">
          미납품 {notDelivered.length}건 — 확정 발주서의 납품가능 0 품목입니다. 로켓 양식·박스·PLT·세일즈
          히스토리에서 제외되며 저장을 막지 않습니다:{' '}
          {[...new Set(notDelivered.map((u) => `${u.poNumber} ${u.master?.alias || u.productName}`))].join(', ')}
        </div>
      )}
      {noPrice.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">
          ⚠️ 단가 미확인 {noPrice.length}건 — 발주서 매입가(공급가 &gt; 매입가)를 읽지 못했습니다. 매출·세일즈
          히스토리 저장을 막아 두었습니다:{' '}
          {[...new Set(noPrice.map((u) => `${u.poNumber} ${u.productName}`))].join(', ')}
        </div>
      )}
      {unconfirmed.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 p-3 text-sm">
          ⚠️ 납품가능 미확정 {unconfirmed.length}건 — 발주수량 기준으로 표시하며 매출·박스·PLT·양식은 납품가능수량(0)
          그대로입니다. 세일즈 히스토리 저장은 막아 두었습니다:{' '}
          {[...new Set(unconfirmed.map((u) => `${u.center} ${u.productName}(발주 ${num(u.orderQty)})`))].join(', ')}
        </div>
      )}
      {missingCenters.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">
          ⚠️ 주소 확보 실패 {missingCenters.length}곳 — 주소·전화 공란(센터 주소록·발주서 모두 없음):{' '}
          {missingCenters.join(', ')}
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
                부가포함 매출 (과세 ×1.1, 발주서 매입가 기준)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">상품</th>
                    <th className="px-3 py-2 text-right font-medium">수량</th>
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-right font-medium">kg</th>
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
                          {r.notDelivered && <span className="ml-1 text-gray-400">· 미납품</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">{num(r.qty)}</td>
                      <td className={'px-3 py-2 text-right font-semibold ' + (r.boxesKnown ? '' : 'text-amber-600')}>
                        {r.boxesKnown ? num(r.boxes) : '—'}
                      </td>
                      <td className={'px-3 py-2 text-right ' + (r.kgKnown ? '' : 'text-amber-600')}>
                        {r.kgKnown ? kgFmt(r.kg) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.unitPricesIncl.length > 0 ? (
                          r.unitPricesIncl.map((p) => num(p)).join(' / ')
                        ) : (
                          <span className="text-red-600">—</span>
                        )}
                        {!r.priceKnown && (
                          <span className="block text-[11px] text-red-600">단가 미확인</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">{num(r.totalIncl)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                    <td className="px-3 py-2">합계</td>
                    <td className="px-3 py-2 text-right">{num(summary.totalQty)}</td>
                    <td className="px-3 py-2 text-right">{num(summary.totalBoxes)}</td>
                    <td className="px-3 py-2 text-right">{kgFmt(summary.totalKg)}</td>
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
                센터 × 입고예정일 박스 합계 기준 · {PALLET_BOX_LIMIT}박스 초과 시 택배 불가 · 개당 운임 = 밀크런 운임 ÷ 봉수 vs
                택배 단가 ÷ 입수
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
                    <th className="px-3 py-2 text-right font-medium">PLT</th>
                    <th className="px-3 py-2 text-left font-medium">차량</th>
                    <th className="px-3 py-2 text-right font-medium">밀크런 운임(참고)</th>
                    <th className="px-3 py-2 text-left font-medium">판정</th>
                    <th className="px-3 py-2 text-left font-medium">개당 운임 (트럭 vs 택배)</th>
                  </tr>
                </thead>
                <tbody>
                  {palletGroups.map((g) => {
                    const key = `${g.poNumber}|${g.shipFrom}`
                    const open = openPos.includes(key)
                    const ship = shipmentOf[`${g.poNumber}|${g.center}|${g.dueDate}`]
                    const feeLead = ship && ship.poNumbers[0] === g.poNumber
                    const review = parcelReviewOf[key]
                    const freight = ship ? freightOf[ship.key] : undefined
                    return (
                      <React.Fragment key={key}>
                        <tr
                          onClick={() =>
                            setOpenPos((prev) =>
                              prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
                            )
                          }
                          aria-expanded={open}
                          className="border-t border-gray-100 cursor-pointer bg-white hover:bg-gray-50 [&>td]:align-middle"
                        >
                          <td className="px-3 py-2 text-sm text-gray-500">
                            <div className="flex items-center">
                              <span className="inline-block w-4 shrink-0 text-gray-400">{open ? '▾' : '▸'}</span>
                              <span>
                                {g.poNumber.split('/').map((po) => (
                                  <span key={po} className="block">
                                    {po}
                                  </span>
                                ))}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2 font-semibold">{g.center}</td>
                          <td className="px-3 py-2 text-gray-600">{g.dueDate}</td>
                          <td className="px-3 py-2">{g.shipFrom}</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-900">{num(g.boxes)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-900">{pltCountOf(g)}</td>
                          <td className="px-3 py-2 text-gray-600">
                            {ship ? ship.method || ship.vehicleLabel : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-900">
                            {!ship ? (
                              <span className="text-gray-400">—</span>
                            ) : !feeLead ? (
                              <span className="text-xs text-gray-400">↑ 합산</span>
                            ) : ship.fee === null ? (
                              <span className="text-xs text-amber-600">요금 미등록</span>
                            ) : (
                              num(ship.fee) + '원'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {g.needsPallet ? (
                              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-semibold">
                                팔레트 필요 ({PALLET_BOX_LIMIT}박스 초과)
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs font-semibold">
                                택배 가능
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {!freight ? (
                              <span className="text-gray-400">—</span>
                            ) : !feeLead ? (
                              <span className="text-gray-400">↑ 합산</span>
                            ) : (
                              <FreightCell freight={freight} parcelTarget={isParcelReviewTarget(g)} />
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-t border-gray-100">
                            <td colSpan={10} className="px-3 py-3 bg-gray-50">
                              {review?.status === 'ok' ? (
                                <ParcelReduceTable items={g.items} review={review} />
                              ) : (
                                <>
                                  <table className="w-full text-xs">
                                    <thead className="text-gray-500">
                                      <tr>
                                        <th className="px-2 py-1 text-left font-medium">상품명</th>
                                        <th className="px-2 py-1 text-right font-medium">납품가능수량</th>
                                        <th className="px-2 py-1 text-right font-medium">박스 수</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {g.items.map((it, i) => (
                                        <tr key={`${it.barcode}-${i}`} className="border-t border-gray-200">
                                          <td className="px-2 py-1">{it.productName}</td>
                                          <td
                                            className={
                                              'px-2 py-1 text-right ' +
                                              (it.qtyUnconfirmed ? 'text-amber-700' : '')
                                            }
                                          >
                                            {num(it.displayQty)}
                                            {it.qtyUnconfirmed && (
                                              <span className="ml-1 text-[10px]">미확정</span>
                                            )}
                                          </td>
                                          <td className="px-2 py-1 text-right">
                                            {it.boxes === null ? (
                                              <span className="text-amber-600">미등록</span>
                                            ) : (
                                              num(it.boxes)
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {review?.status === 'error' && (
                                    <div className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-700 space-y-1">
                                      <div className="font-semibold">{PARCEL_KEEP_BOXES}박스로 줄일 때 (참고)</div>
                                      <div className="text-amber-600">{review.reason}</div>
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {shipments.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 flex items-baseline justify-between text-sm">
                <span className="text-gray-600">
                  팔레트분{' '}
                  {[
                    ...countByShipFrom(shipments).map((c) => `${c.shipFrom} ${c.count}건`),
                    ...(gompyoShipments.length ? [`곰표 ${gompyoShipments.length}건`] : []),
                  ].join(' · ')}{' '}
                  · 총 {milkrunTotals.totalPlt} PLT
                  {gompyoShipments.length > 0 && (
                    <span className="text-gray-400"> (곰표 PLT·운임은 아래 곰표 표에서 합산)</span>
                  )}
                </span>
                <span className="text-right">
                  <span className="text-lg font-bold">운임 합계 {num(milkrunTotals.totalFee)}원</span>
                  {milkrunSales > 0 && (
                    <span className="ml-1 text-sm text-gray-600 font-semibold">
                      · 매출 대비 {((milkrunTotals.totalFee / milkrunSales) * 100).toFixed(1)}%
                    </span>
                  )}
                  {milkrunTotals.unpriced > 0 && (
                    <span className="ml-2 text-xs font-normal text-amber-600">
                      (요금 미등록 {milkrunTotals.unpriced}건 제외)
                    </span>
                  )}
                  {milkrunSales > 0 && (
                    <span className="block text-xs text-gray-400">분모: 해당 발주 매출 {num(milkrunSales)}원</span>
                  )}
                </span>
              </div>
            )}
            <div className="px-4 py-3 border-t border-gray-100 space-y-1 text-xs">
              {advisories.map((a) => (
                <p key={`${a.shipFrom}-${a.center}-${a.dueDate}`} className="text-amber-700 font-semibold">
                  ※ {a.center} · {a.dueDate}: 발주 {a.poCount}건 합산 {num(a.boxes)}박스 — 트럭
                  발송분(팔레트)으로 판정
                </p>
              ))}
              {needPallet.length === 0 && advisories.length === 0 && (
                <p className="text-gray-400">전 발주 {PALLET_BOX_LIMIT}박스 이하 — 택배 발송 가능</p>
              )}
              <details className="text-xs text-gray-500">
                <summary className="cursor-pointer select-none">운영 규칙 ▸</summary>
                <div className="mt-1 space-y-1">
                  {[...new Set(needPallet.map((g) => g.shipFrom))].map((sf) => (
                    <p key={sf}>
                      · {SHIP_FROM_GUIDE[sf]}
                    </p>
                  ))}
                  <p>
                    · PLT는 상품마스터 실측 박스 치수 기준 (1,100×1,100 자리 수 × 자리당 단수, 높이
                    한도 {LIMIT_MM.toLocaleString('ko-KR')}mm — 팔레트 {PALLET_MM}mm 포함) · 같은 센터·같은
                    입고예정일 발주는 PLT 합산 후 차량 배정 ({PALLET_BOX_LIMIT}박스 이하 발주는 택배라 운임 계산 제외)
                  </p>
                  <p>
                    · 운임은 참고용 — 밀크런 트럭 요금표 기준
                  </p>
                  <p>
                    · 자리당 단수는 SKU 실측 높이로 계산 — 진도팜(곡물) 출고만 {GRAIN_MAX_TIERS}단으로 묶는다
                    (위킵·곰표 출고는 실측 단수). PLT 수는 적재 구성도와 같은 기준
                  </p>
                  <p>· {SCRAP_NOTE}</p>
                </div>
              </details>
            </div>
          </div>

          {/* 팔레트 적재 구성도 — 팔레트 필요 발주만 */}
          {palletSvg && (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div
                className={
                  'px-4 py-3 flex flex-wrap items-center justify-between gap-3 ' +
                  (planOpen ? 'border-b border-gray-200' : '')
                }
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    onClick={() => setPlanOpen((v) => !v)}
                    aria-expanded={planOpen}
                    className="text-sm font-semibold hover:text-gray-600"
                  >
                    팔레트 적재 구성도 {planOpen ? '▾' : '▸'}
                  </button>
                  <span className="text-sm text-gray-600">
                    PLT {palletPlan.panels.length}장 · 총 {num(palletPlan.panels.reduce((a, p) => a + p.boxes, 0))}박스
                  </span>
                  {lowBoxPanels.length > 0 && (
                    <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-semibold">
                      ⚠{' '}
                      {lowBoxPanels.map((p) => `${p.center} PLT ${p.index}/${p.total} · ${num(p.boxes)}박스`).join(' · ')}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={savePlanPdf}
                    disabled={planPdfBusy}
                    className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                  >
                    {planPdfBusy ? '변환 중…' : 'PDF 다운로드(A4)'}
                  </button>
                  <button
                    onClick={savePlanJpg}
                    disabled={planJpgBusy}
                    className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                  >
                    {planJpgBusy ? '변환 중…' : 'JPG 다운로드'}
                  </button>
                </div>
              </div>
              {/* 접혀도 DOM 은 유지 — 내보내기는 도면 데이터에서 새로 그린다 */}
              <div className={planOpen ? 'p-4' : 'hidden'}>
                <CoupangPalletPlanView svg={palletSvg} />
              </div>
            </div>
          )}

          {/* 진도팜분 — 로켓 양식 (택배 발송분 / 트럭 발송분 2분할) */}
          <div className="space-y-4">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                진도팜분 — 쿠팡 로켓 양식 (택배 {rocketParcel.length}행 · 트럭 {rocketTruck.length}행)
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-gray-600">
                  제조일자 (선택한 날짜로 일괄 적용)
                  <input
                    type="date"
                    value={madeDate}
                    onChange={(e) => setMadeDate(e.target.value)}
                    className="ml-2 px-2 py-1 border border-gray-300 rounded text-xs"
                  />
                  {madeDate && (
                    <button
                      type="button"
                      onClick={() => setMadeDate('')}
                      className="ml-1 px-1.5 py-0.5 rounded border border-gray-300 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      지우기
                    </button>
                  )}
                  {!madeDate ? (
                    <span className="ml-2 text-[11px] text-gray-400">미선택 — 제조일자 열 공란</span>
                  ) : (
                    madeDate !== todayKst() && (
                      <span className="ml-2 text-[11px] text-amber-600">오늘 날짜가 아닙니다</span>
                    )
                  )}
                </label>
                <button
                  onClick={downloadXlsx}
                  disabled={rocket.length === 0}
                  className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:bg-gray-300"
                >
                  xlsx 다운로드 (2시트)
                </button>
              </div>
            </div>

            <RocketTable
              title={ROCKET_SHEETS['택배'].title}
              note={`${PALLET_BOX_LIMIT}박스 이하 발주 · 주소·전화는 센터 주소록 · 배송메세지1 = 발주번호 · 송장은 공란`}
              rows={rocketParcel}
              truck={false}
            />
            <RocketTable
              title={ROCKET_SHEETS['트럭'].title}
              note={`${PALLET_BOX_LIMIT}박스 초과 발주 · 주소·전화는 발주서 자동 출력값 · 파렛트 수는 실측 적재 기준(자리 수 × 단수), 발주 첫 행에만 기입`}
              rows={rocketTruck}
              truck
            />
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
                              {p.invoiceNos.map((no) => {
                                const key = b.center + '|' + p.product + '|' + no
                                return (
                                  <div key={no} className="flex items-center justify-between gap-2">
                                    <span>{no}</span>
                                    <button
                                      type="button"
                                      onClick={() => copyInvoiceNo(key, no)}
                                      title="송장번호 복사"
                                      aria-label={no + ' 복사'}
                                      className="shrink-0 px-1 text-gray-400 hover:text-gray-700"
                                    >
                                      {copiedNo === key ? '✅' : '📋'}
                                    </button>
                                  </div>
                                )
                              })}
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
                        <td
                          className={'px-3 py-2 text-right ' + (r.qtyUnconfirmed ? 'text-amber-700' : '')}
                        >
                          {num(r.displayQty)}
                          {r.qtyUnconfirmed && (
                            <span className="ml-1 text-[11px]">미확정 — 발주수량 기준</span>
                          )}
                          {r.notDelivered && (
                            <span className="ml-1 text-[11px] text-gray-400">미납품</span>
                          )}
                        </td>
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

          {/* 곰표분 — 전 발주 밀크런 (택배 판정 없음) */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">곰표분 ({gompyo.length}행)</h2>
              <button
                onClick={copyGompyoNotice}
                disabled={gompyoShipments.length === 0}
                className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200"
              >
                {gompyoCopied ? '✅ 복사됨' : '곰표 상차 안내문 복사'}
              </button>
            </div>
            {gompyo.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-400">곰표 출고 상품 없음</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">발주번호</th>
                        <th className="px-3 py-2 text-left font-medium">센터</th>
                        <th className="px-3 py-2 text-left font-medium">입고예정일</th>
                        <th className="px-3 py-2 text-left font-medium">상품명</th>
                        <th className="px-3 py-2 text-right font-medium">봉</th>
                        <th className="px-3 py-2 text-right font-medium">박스</th>
                        <th className="px-3 py-2 text-right font-medium">PLT</th>
                        <th className="px-3 py-2 text-right font-medium">운임(참고)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gompyoShipments.map((s) =>
                        s.items.map((r, i) => (
                          <tr key={`${s.key}-${r.poNumber}-${r.barcode}-${i}`} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-600">{r.poNumber}</td>
                            <td className="px-3 py-2">{r.center}</td>
                            <td className="px-3 py-2 text-gray-600">{r.dueDate}</td>
                            <td className="px-3 py-2 max-w-[24rem] truncate" title={r.productName}>
                              {r.master?.alias || r.productName}
                            </td>
                            <td
                              className={'px-3 py-2 text-right ' + (r.qtyUnconfirmed ? 'text-amber-700' : '')}
                            >
                              {num(r.displayQty)}
                              {r.qtyUnconfirmed && (
                                <span className="ml-1 text-[11px]">미확정 — 발주수량 기준</span>
                              )}
                              {r.notDelivered && (
                                <span className="ml-1 text-[11px] text-gray-400">미납품</span>
                              )}
                            </td>
                            <td className={'px-3 py-2 text-right ' + (r.boxes === null ? 'text-amber-600' : '')}>
                              {r.boxes ?? '—'}
                            </td>
                            {i === 0 && (
                              <>
                                <td
                                  rowSpan={s.items.length}
                                  className="px-3 py-2 text-right font-medium align-top border-l border-gray-100"
                                >
                                  {num(s.plt)}
                                </td>
                                <td rowSpan={s.items.length} className="px-3 py-2 text-right align-top">
                                  {s.fare.fee === null ? (
                                    <span className="text-amber-600">요금 미등록</span>
                                  ) : (
                                    <>
                                      <span className="font-medium">{num(s.fare.fee)}원</span>
                                      <span className="block text-[11px] text-gray-500">{s.fare.method}</span>
                                    </>
                                  )}
                                </td>
                              </>
                            )}
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 flex items-baseline justify-between text-sm">
                  <span className="text-gray-600">
                    밀크런 {gompyoShipments.length}건 · 총 {num(gompyoTotals.totalPlt)} PLT (
                    {num(gompyoTotals.totalUnits)}봉)
                  </span>
                  <span className="font-semibold">
                    운임 합계 {num(gompyoTotals.totalFee)}원
                    {gompyoTotals.unpriced > 0 && (
                      <span className="ml-2 text-xs font-normal text-amber-600">
                        (요금 미등록 {gompyoTotals.unpriced}건 제외)
                      </span>
                    )}
                  </span>
                </div>
                <div className="px-4 py-3 border-t border-gray-100 space-y-1 text-xs text-gray-500">
                  <p>
                    · 1PLT = {GOMPYO_UNITS_PER_PLT}봉({GOMPYO_BOXES_PER_PLT}박스) 올림 · 같은 센터·같은
                    입고예정일 발주는 봉 수를 합산해 한 건으로 묶는다
                  </p>
                  <p>· 곰표분은 전 발주 밀크런 — 택배 판정·로켓 양식·부착 라벨 대상이 아니다</p>
                  <p>
                    · 운임은 참고용 — 매 PLT 마다 BASIC(1pt 당)×PLT 와 차량 구간 요금을 계산해 싼 쪽을 적용한다
                    (적용 방식은 운임 칸에 표기)
                  </p>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 로켓 양식 표 — 택배분/트럭분 공통(트럭분만 '파렛트 수' 열이 붙는다) */
function RocketTable({
  title,
  note,
  rows,
  truck,
}: {
  title: string
  note: string
  rows: RocketRow[]
  truck: boolean
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50">
        <span className="text-sm font-semibold">{title}</span>
        <span className="ml-2 text-xs text-gray-500">{rows.length}행</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-gray-400">해당 발주 없음</p>
      ) : (
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
                {truck && <th className="px-3 py-2 text-right font-medium">파렛트 수</th>}
                <th className="px-3 py-2 text-left font-medium">송장</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.poNumber}-${r.itemName}-${i}`}
                  className={'border-t border-gray-100 ' + (r.centerKnown ? '' : 'bg-red-50')}
                >
                  <td className="px-3 py-2">
                    {r.recipient}
                    {!r.centerKnown && <span className="ml-1 text-[11px] text-red-600">주소 없음</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{r.phone}</td>
                  <td className="px-3 py-2 max-w-[26rem] truncate" title={r.address}>
                    {r.address}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{r.memo}</td>
                  <td className="px-3 py-2 max-w-[22rem] truncate" title={r.itemName}>
                    {r.itemName}
                  </td>
                  <td
                    className={'px-3 py-2 text-right ' + (r.qtyUnconfirmed ? 'text-amber-700' : '')}
                  >
                    {num(r.itemQty)}
                    {r.qtyUnconfirmed && (
                      <span className="ml-1 text-[11px]">
                        납품가능 미확정 — 발주수량 {num(r.orderQty)}
                      </span>
                    )}
                  </td>
                  <td className={'px-3 py-2 text-right ' + (r.boxes === null ? 'text-amber-600' : '')}>
                    {r.boxes ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{r.madeDate}</td>
                  {truck && <td className="px-3 py-2 text-right font-medium">{r.pallet ?? ''}</td>}
                  <td className="px-3 py-2" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-100">{note}</p>
    </div>
  )
}
