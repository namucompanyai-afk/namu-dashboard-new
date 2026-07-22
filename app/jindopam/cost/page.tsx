'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'

// ── 구글시트 설정 ────────────────────────────────────────────────
const SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg'
// 탭 이름 공백 포함 → 작은따옴표 + encodeURIComponent
// A4:J — G까지 원곡 데이터 + H 파쇄 / I 제분 / J 혼합곡수 (init8 추가)
const RANGE = "'진도팜 원가표'!A4:J"
// 가공비(N5:O10 6항목)·배송비(N13:P15) 참고 기준표 (init8이 J→N 이동한 고정 오프셋)
const RANGE_REF = "'진도팜 원가표'!N4:P15"

// 참고표 값 (시트에서 read, 하드코딩 아님)
type RefCost = {
  작업비소포장: number
  작업비벌크: number
  파쇄비: number
  제분비: number
  혼합비기본: number
  혼합비추가: number
  물류대행비: number
}
type RefShip = { 규격: string; 박스: number; 택배: number }
// 배송비 규격별 기준(무게) 표기 — UI 라벨(값 아님)
const SHIP_STD: Record<string, string> = { 소: '1~3kg', 중: '4~10kg', 대: '11~20kg' }

// R4 헤더 순서(원곡가 중심): A 원료ID / B 구분 / C 품목 / D 품종 /
//                            E 1kg당 원곡가 / F 과세여부 / G 취급상태
type CostRow = {
  rawId: string      // A 원료ID (내부 키, 표시 안 함)
  category: string   // B 구분
  item: string       // C 품목
  variety: string    // D 품종
  price: number      // E 1kg당 원곡가
  tax: string        // F 과세여부
  status: string     // G 취급상태
  crush: boolean     // H 파쇄 (O/X, 빈칸=X)
  mill: boolean      // I 제분 (O/X, 빈칸=X)
  blend: number      // J 혼합곡수 (빈칸=0)
}

// 콤마/원 제거 후 숫자화
const toNum = (v: string | undefined): number => {
  if (!v) return 0
  const n = Number(String(v).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

// O/X 셀 파싱 (빈칸·X = false, O = true)
const procOn = (v: string | undefined): boolean =>
  (v || '').trim().toUpperCase().startsWith('O')

// 혼합비 = 0곡 0 / 1~5곡 기본 / 6곡+ 기본 + (곡수-5)×추가
const calcBlendCost = (count: number, ref: RefCost): number => {
  if (count <= 0) return 0
  if (count <= 5) return ref.혼합비기본
  return ref.혼합비기본 + (count - 5) * ref.혼합비추가
}

// 톤백·물류대행은 작업비(소포장) 미적용. 그 외 구분은 기존과 동일하게 작업비 포함.
const NO_LABOR_CATEGORIES = ['톤백', '물류대행']
const hasLaborCost = (category: string): boolean =>
  !NO_LABOR_CATEGORIES.includes((category || '').trim())
// 물류대행 구분은 물류대행비 가산 (작업비는 위에서 이미 제외됨)
const isLogistics = (category: string): boolean => (category || '').trim() === '물류대행'

// 공급가 = 원곡가 + (작업비 소포장) + (파쇄) + (제분) + 혼합비 (단가 전부 참고표 참조)
// 작업비 포함 여부만 구분(category)에 따라 분기 — 표시·툴팁·미리보기·엑셀이 이 함수를 재사용
const calcSupply = (
  category: string,
  price: number,
  crush: boolean,
  mill: boolean,
  blend: number,
  ref: RefCost | null,
): number | null => {
  if (!ref) return null
  let s = price
  if (hasLaborCost(category)) s += ref.작업비소포장
  if (isLogistics(category)) s += ref.물류대행비
  if (crush) s += ref.파쇄비
  if (mill) s += ref.제분비
  s += calcBlendCost(blend, ref)
  return s
}

// 공급가 내역 한 줄 ("원곡가 8,000 + 작업비 800 + 파쇄 600 …")
const supplyBreakdown = (
  category: string,
  price: number,
  crush: boolean,
  mill: boolean,
  blend: number,
  ref: RefCost,
): string => {
  const parts = [`원곡가 ${price.toLocaleString()}`]
  if (hasLaborCost(category)) parts.push(`작업비 ${ref.작업비소포장.toLocaleString()}`)
  if (isLogistics(category)) parts.push(`물류대행비 ${ref.물류대행비.toLocaleString()}`)
  if (crush) parts.push(`파쇄 ${ref.파쇄비.toLocaleString()}`)
  if (mill) parts.push(`제분 ${ref.제분비.toLocaleString()}`)
  const bc = calcBlendCost(blend, ref)
  if (bc > 0) parts.push(`혼합 ${bc.toLocaleString()}`)
  return parts.join(' + ')
}

// 공급가 내역 라인(툴팁/팝오버용 · 한 줄씩). 값은 calcBlendCost 재사용 — 계산 로직 중복 없음
const supplyLines = (
  category: string,
  price: number,
  crush: boolean,
  mill: boolean,
  blend: number,
  ref: RefCost,
): string[] => {
  const lines = [`원곡가 ${price.toLocaleString()}`]
  if (hasLaborCost(category)) lines.push(`작업비 ${ref.작업비소포장.toLocaleString()}`)
  if (isLogistics(category)) lines.push(`물류대행비 ${ref.물류대행비.toLocaleString()}`)
  if (crush) lines.push(`파쇄 ${ref.파쇄비.toLocaleString()}`)
  if (mill) lines.push(`제분 ${ref.제분비.toLocaleString()}`)
  const bc = calcBlendCost(blend, ref)
  if (bc > 0) lines.push(`혼합비(${blend}곡) ${bc.toLocaleString()}`)
  return lines
}

// 구분 고정 정렬 순서 (그 외 맨 뒤)
const CATEGORY_ORDER = ['유기농', '무농약', '관행', '수입', '혼합', '톤백', '물류대행']
const catRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf((c || '').trim())
  return i === -1 ? CATEGORY_ORDER.length : i
}

type Device = 'pc' | 'phone'

// 컬럼 정의 (통합 원곡표 · 진도팜/나무 뷰 구분 없음)
type ColKey = 'category' | 'item' | 'variety' | 'price' | 'supply' | 'tax' | 'status'
const COL_LABEL: Record<ColKey, string> = {
  category: '구분',
  item: '품목',
  variety: '품종',
  price: '1kg당 원곡가',
  supply: '공급가',
  tax: '과세여부',
  status: '취급상태',
}
const NUM_COLS: ColKey[] = ['price', 'supply']

// 기기별 노출 컬럼 — 폰은 과세여부·취급상태 숨김 (공급가는 PC/폰 공통)
function visibleCols(device: Device): ColKey[] {
  return device === 'pc'
    ? ['category', 'item', 'variety', 'price', 'supply', 'tax', 'status']
    : ['category', 'item', 'variety', 'price', 'supply']
}

// 기기 감지 (md 브레이크포인트 768px)
function useDevice(): Device {
  const [device, setDevice] = useState<Device>('pc')
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setDevice(mq.matches ? 'phone' : 'pc')
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return device
}

// 과세 배지
function TaxBadge({ value }: { value: string }) {
  const v = (value || '').trim()
  const taxed = v.includes('과세')
  const label = taxed ? '과세' : '면세'
  return (
    <span
      className={
        'inline-block rounded px-2 py-0.5 text-xs font-medium ' +
        (taxed ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700')
      }
    >
      {label}
    </span>
  )
}

// 취급상태 O/X (빈칸이면 '-')
function StatusMark({ value }: { value: string }) {
  const v = (value || '').trim()
  if (v === '') return <span className="text-gray-300">-</span>
  const on = /^(o|취급|사용|y|1|가능|활성)/i.test(v)
  return (
    <span className={'font-bold ' + (on ? 'text-green-600' : 'text-gray-400')}>
      {on ? 'O' : 'X'}
    </span>
  )
}

// 공급가 셀 + 내역 툴팁(PC 호버) / 팝오버(모바일 탭). 표시 레이어만 (계산은 상위에서 주입)
function SupplyCell({
  value,
  lines,
  device,
  open,
  onToggle,
}: {
  value: number | null
  lines: string[]
  device: Device
  open: boolean
  onToggle: (e: React.MouseEvent) => void
}) {
  if (value == null) return <span className="text-gray-300">-</span>
  const numCls =
    'font-semibold text-red-600 underline decoration-dotted decoration-gray-300 underline-offset-2'
  const panel = (
    <div
      onClick={(e) => e.stopPropagation()}
      className="w-max max-w-[220px] rounded-lg border border-gray-200 bg-white p-2 text-left text-xs font-normal text-gray-600 shadow-lg"
    >
      {lines.map((l, i) => (
        <div key={i} className="whitespace-nowrap leading-relaxed">
          {l}
        </div>
      ))}
    </div>
  )
  if (device === 'pc') {
    return (
      <div className="group relative inline-block cursor-help">
        <span className={numCls}>{value.toLocaleString()}</span>
        <div className="invisible absolute right-0 top-full z-20 mt-1 opacity-0 transition-opacity duration-100 group-hover:visible group-hover:opacity-100">
          {panel}
        </div>
      </div>
    )
  }
  return (
    <div className="relative inline-block">
      <button type="button" onClick={onToggle} className={numCls}>
        {value.toLocaleString()}
      </button>
      {open && <div className="absolute right-0 top-full z-20 mt-1">{panel}</div>}
    </div>
  )
}

export default function JindopamCostPage() {
  const [rows, setRows] = useState<CostRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editorLabel, setEditorLabel] = useState('나무') // 변동로그 변경자 표기
  const [refCost, setRefCost] = useState<RefCost | null>(null)
  const [refShip, setRefShip] = useState<RefShip[]>([])
  const [showRef, setShowRef] = useState(false) // 참고표 펼침 (기본 접힘)
  // 참고표 항목별 수정 모달 (가공비/배송비 공용)
  const [refEdit, setRefEdit] = useState<null | {
    title: string
    kind: 'cost' | 'ship'
    fields: { item: string; label: string; current: number }[]
  }>(null)
  const device = useDevice()

  // 로그인 role로 변경자 표기만 판별 (뷰 자체는 통합, 분기 없음)
  useEffect(() => {
    try {
      const userStr = localStorage.getItem('user')
      const userRole = userStr ? JSON.parse(userStr)?.role : null
      setEditorLabel(userRole === '진도팜' ? '진도팜' : '나무')
    } catch {
      /* 파싱 실패 시 기본 '나무' */
    }
  }, [])

  // 편집 모달 상태
  const [editRow, setEditRow] = useState<CostRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  // 구분 필터 ('전체' + 고정순서 구분). 화면 필터만, 시트/데이터 무변형.
  const [catFilter, setCatFilter] = useState<string>('전체')

  // 모바일 공급가 내역 팝오버 (한 번에 하나만). 바깥 탭하면 닫힘.
  const [openSupply, setOpenSupply] = useState<number | null>(null)
  useEffect(() => {
    if (device !== 'phone' || openSupply === null) return
    const close = () => setOpenSupply(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [device, openSupply])

  // 원가표 read (저장 후 재호출용으로 함수화)
  const loadData = useCallback(async () => {
    const key = process.env.NEXT_PUBLIC_GSHEET_API_KEY
    if (!key) {
      setError('API 키가 설정되지 않았습니다. (.env.local 의 NEXT_PUBLIC_GSHEET_API_KEY)')
      setLoading(false)
      return
    }
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/`
    const url = `${base}${encodeURIComponent(RANGE)}?key=${key}`
    const refUrl = `${base}${encodeURIComponent(RANGE_REF)}?key=${key}`
    try {
      setLoading(true)
      setError(null)
      const [res, refRes] = await Promise.all([fetch(url), fetch(refUrl)])
      if (!res.ok) throw new Error(`시트 응답 오류 (${res.status})`)
      const json = await res.json()
      const values: string[][] = json.values || []
      // values[0] = R4 헤더 → 스킵, R5부터 데이터
      const data: CostRow[] = values
        .slice(1)
        .filter((r) => (r[2] || '').trim() !== '') // 품목(C) 빈 행 스킵
        .map((r) => ({
          rawId: (r[0] || '').trim(),
          category: (r[1] || '').trim(),
          item: (r[2] || '').trim(),
          variety: (r[3] || '').trim(),
          price: toNum(r[4]),
          tax: (r[5] || '').trim(),
          status: (r[6] || '').trim(),
          crush: procOn(r[7]),
          mill: procOn(r[8]),
          blend: toNum(r[9]),
        }))
      setRows(data)
      // 참고 기준표 (J4:L15 고정 오프셋: 0=가공비헤더, 1~6=가공비 6항목, 7=빈행, 8=배송비헤더, 9~11=배송비)
      if (refRes.ok) {
        const rj = await refRes.json()
        const rv: string[][] = rj.values || []
        setRefCost({
          작업비소포장: toNum(rv[1]?.[1]),
          작업비벌크: toNum(rv[2]?.[1]),
          파쇄비: toNum(rv[3]?.[1]),
          제분비: toNum(rv[4]?.[1]),
          혼합비기본: toNum(rv[5]?.[1]),
          혼합비추가: toNum(rv[6]?.[1]),
          물류대행비: toNum(rv[7]?.[1]), // N11 (옛 빈 구분행 → 물류대행비, init11)
        })
        setRefShip(
          [9, 10, 11]
            .map((i) => rv[i])
            .filter((r) => r && (r[0] || '').trim() !== '')
            .map((r) => ({ 규격: (r[0] || '').trim(), 박스: toNum(r[1]), 택배: toNum(r[2]) })),
        )
      }
      setLoading(false)
    } catch (e: any) {
      setError(e?.message || '데이터를 불러오지 못했습니다.')
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const cols = visibleCols(device)

  // 엑셀 다운로드 (필터 무관 전체 원료 · 공급가 계산 로직 재사용). PC 전용 버튼에서 호출.
  const handleDownload = () => {
    if (!refCost) return
    const header = [
      '구분', '품목', '품종', '원곡가', '작업비', '물류대행비', '파쇄비', '제분비', '혼합비', '공급가', '과세여부', '취급상태',
    ]
    const sorted = [...rows].sort((a, b) => {
      const c = catRank(a.category) - catRank(b.category)
      if (c !== 0) return c
      const it = a.item.localeCompare(b.item, 'ko')
      if (it !== 0) return it
      return a.variety.localeCompare(b.variety, 'ko')
    })
    const body = sorted.map((r) => [
      r.category,
      r.item,
      r.variety,
      r.price,
      hasLaborCost(r.category) ? refCost.작업비소포장 : 0,
      isLogistics(r.category) ? refCost.물류대행비 : 0,
      r.crush ? refCost.파쇄비 : 0,
      r.mill ? refCost.제분비 : 0,
      calcBlendCost(r.blend, refCost),
      calcSupply(r.category, r.price, r.crush, r.mill, r.blend, refCost) ?? '',
      r.tax,
      r.status,
    ])
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([header, ...body])
    XLSX.utils.book_append_sheet(wb, ws, '원가표')
    const kst = new Date(Date.now() + 9 * 3600 * 1000)
    const stamp =
      String(kst.getUTCFullYear()).slice(2) +
      String(kst.getUTCMonth() + 1).padStart(2, '0') +
      String(kst.getUTCDate()).padStart(2, '0')
    XLSX.writeFile(wb, `진도팜_원가표_${stamp}.xlsx`)
  }

  // 구분 탭별 건수 (로드된 전체 데이터 기준). 데이터 없는 구분도 0으로 노출.
  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1)
    return m
  }, [rows])

  const view = useMemo(() => {
    // 구분 필터('전체'는 전부) → 정렬: 구분(고정순서) → 품목(ko) → 품종(ko)
    return rows
      .filter((r) => catFilter === '전체' || r.category === catFilter)
      .sort((a, b) => {
        const c = catRank(a.category) - catRank(b.category)
        if (c !== 0) return c
        const it = a.item.localeCompare(b.item, 'ko')
        if (it !== 0) return it
        return a.variety.localeCompare(b.variety, 'ko')
      })
  }, [rows, catFilter])

  // 구분 rowspan 병합: 연속 같은 구분 구간의 첫 행에 span 길이, 나머지는 0(구분 td 생략)
  const catRowSpan = useMemo(() => {
    const spans = new Array<number>(view.length).fill(0)
    let i = 0
    while (i < view.length) {
      let j = i
      while (j < view.length && view[j].category === view[i].category) j++
      spans[i] = j - i
      i = j
    }
    return spans
  }, [view])

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">원가표</h1>
          <p className="text-sm text-gray-500 mt-1">진도팜 → 나무 공급 단가</p>
        </div>
        <div className="flex items-center gap-2">
          {/* 엑셀 다운로드 (PC 전용 · 필터 무관 전체) */}
          <button
            onClick={handleDownload}
            disabled={loading || !!error || !refCost}
            className="hidden rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 md:inline-flex"
          >
            ⬇ 엑셀 다운로드
          </button>
          {/* 신규 추가 (진도팜·나무 공통) */}
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700"
          >
            ＋ 신규 원료 추가
          </button>
        </div>
      </div>

      {/* 가공비·배송비 참고표 (기본 접힘) */}
      <div>
        <button
          onClick={() => setShowRef((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          <span className={'inline-block transition-transform ' + (showRef ? 'rotate-90' : '')}>▶</span>
          가공비·배송비 참고표
        </button>

        {showRef && (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* 가공비 */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-2 text-sm font-semibold">가공비</div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">항목</th>
                    <th className="px-3 py-2 text-right font-medium">단가</th>
                    <th className="px-3 py-2 text-left font-medium">단위</th>
                    <th className="px-3 py-2 text-right font-medium">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { item: '작업비(소포장)', v: refCost?.작업비소포장, unit: '원/kg' },
                    { item: '작업비(벌크)', v: refCost?.작업비벌크, unit: '원/kg' },
                    { item: '파쇄비', v: refCost?.파쇄비, unit: '원/kg' },
                    { item: '제분비', v: refCost?.제분비, unit: '원/kg' },
                    { item: '혼합비(5곡까지)', v: refCost?.혼합비기본, unit: '원/kg' },
                    { item: '혼합비(추가1곡당)', v: refCost?.혼합비추가, unit: '원/kg' },
                    { item: '물류대행비', v: refCost?.물류대행비, unit: '원/건' },
                  ].map((r) => (
                    <tr key={r.item} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-left">{r.item}</td>
                      <td className="px-3 py-2 text-right font-mono">{(r.v ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2 text-left text-gray-400">{r.unit}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() =>
                            setRefEdit({
                              title: `${r.item} 수정`,
                              kind: 'cost',
                              fields: [{ item: r.item, label: '단가', current: r.v ?? 0 }],
                            })
                          }
                          className="rounded-md border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 배송비 */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-sm font-semibold">
                배송비
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-500">참고</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">규격</th>
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-right font-medium">택배</th>
                    <th className="px-3 py-2 text-left font-medium">기준</th>
                    <th className="px-3 py-2 text-right font-medium">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {refShip.map((s) => (
                    <tr key={s.규격} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-left">{s.규격}</td>
                      <td className="px-3 py-2 text-right font-mono">{s.박스.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono">{s.택배.toLocaleString()}</td>
                      <td className="px-3 py-2 text-left text-gray-400">
                        {SHIP_STD[s.규격] || ''}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() =>
                            setRefEdit({
                              title: `배송비(${s.규격}) 수정`,
                              kind: 'ship',
                              fields: [
                                { item: `박스(${s.규격})`, label: '박스', current: s.박스 },
                                { item: `택배(${s.규격})`, label: '택배', current: s.택배 },
                              ],
                            })
                          }
                          className="rounded-md border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 본문 카드 */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {loading && (
          <div className="flex items-center justify-center gap-3 py-16 text-gray-500">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
            <span className="text-sm">원가 데이터를 불러오는 중…</span>
          </div>
        )}

        {!loading && error && (
          <div className="py-16 text-center">
            <p className="text-sm text-red-600">⚠️ {error}</p>
            <p className="mt-1 text-xs text-gray-400">시트 공개 상태와 API 키를 확인해 주세요.</p>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-100 px-4 py-2">
              {/* 구분 필터 탭 (전체 + 고정순서). 화면 필터만 */}
              <div className="flex flex-wrap gap-1.5">
                {['전체', ...CATEGORY_ORDER].map((c) => {
                  const count = c === '전체' ? rows.length : (catCounts.get(c) ?? 0)
                  const active = catFilter === c
                  return (
                    <button
                      key={c}
                      onClick={() => setCatFilter(c)}
                      className={
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                        (active
                          ? 'border-gray-900 bg-gray-900 text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')
                      }
                    >
                      {c} <span className={active ? 'text-gray-300' : 'text-gray-400'}>{count}</span>
                    </button>
                  )
                })}
              </div>
              <span className="text-sm text-gray-500">총 {view.length}건</span>
            </div>
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    {cols.map((k) => (
                      <th
                        key={k}
                        className={
                          'whitespace-nowrap px-3 py-2 font-medium ' +
                          (NUM_COLS.includes(k) ? 'text-right' : 'text-left')
                        }
                      >
                        {COL_LABEL[k]}
                      </th>
                    ))}
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {view.length === 0 && (
                    <tr>
                      <td colSpan={cols.length + 1} className="py-12 text-center text-sm text-gray-400">
                        표시할 데이터가 없습니다.
                      </td>
                    </tr>
                  )}
                  {view.map((row, i) => (
                    <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                      {cols.map((k) => {
                        // 구분: 연속 구간 첫 행만 rowSpan 병합 셀, 나머지 행은 생략
                        if (k === 'category') {
                          if (catRowSpan[i] === 0) return null
                          return (
                            <td
                              key={k}
                              rowSpan={catRowSpan[i]}
                              className="whitespace-nowrap px-3 py-2 text-left align-middle bg-gray-50 font-medium text-gray-700"
                            >
                              {row.category || '-'}
                            </td>
                          )
                        }
                        return (
                          <td
                            key={k}
                            className={
                              'whitespace-nowrap px-3 py-2 ' +
                              (NUM_COLS.includes(k) ? 'text-right font-mono' : 'text-left')
                            }
                          >
                            {k === 'tax' ? (
                              <TaxBadge value={row.tax} />
                            ) : k === 'status' ? (
                              <StatusMark value={row.status} />
                            ) : k === 'price' ? (
                              row.price.toLocaleString()
                            ) : k === 'supply' ? (
                              <SupplyCell
                                value={calcSupply(row.category, row.price, row.crush, row.mill, row.blend, refCost)}
                                lines={
                                  refCost
                                    ? supplyLines(row.category, row.price, row.crush, row.mill, row.blend, refCost)
                                    : []
                                }
                                device={device}
                                open={openSupply === i}
                                onToggle={(e) => {
                                  e.stopPropagation()
                                  setOpenSupply((prev) => (prev === i ? null : i))
                                }}
                              />
                            ) : (
                              (row[k as 'item' | 'variety'] as string) || '-'
                            )}
                          </td>
                        )
                      })}
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button
                          onClick={() => setEditRow(row)}
                          className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editRow && (
        <EditModal
          row={editRow}
          roleLabel={editorLabel}
          refCost={refCost}
          onClose={() => setEditRow(null)}
          onSaved={async () => {
            setEditRow(null)
            await loadData()
          }}
        />
      )}
      {showCreate && (
        <CreateModal
          roleLabel={editorLabel}
          refCost={refCost}
          onClose={() => setShowCreate(false)}
          onSaved={async () => {
            setShowCreate(false)
            await loadData()
          }}
        />
      )}
      {refEdit && (
        <RefEditModal
          title={refEdit.title}
          kind={refEdit.kind}
          fields={refEdit.fields}
          editor={editorLabel}
          onClose={() => setRefEdit(null)}
          onSaved={async () => {
            setRefEdit(null)
            await loadData()
          }}
        />
      )}
    </div>
  )
}

// ── 공용 모달 셸 (PC 중앙 / 폰 하단시트) ──────────────────────────
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const POST_URL = '/api/jindopam/cost'

// 가공옵션 O/X 토글 버튼
function ToggleBtn({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ' +
        (on
          ? 'border-gray-900 bg-gray-900 text-white'
          : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50')
      }
    >
      {label} {on ? 'O' : 'X'}
    </button>
  )
}

// 가공옵션 입력 묶음 (파쇄/제분 토글 · 혼합곡수 · 공급가 미리보기) — 추가/수정 모달 공용
function ProcFields({
  category,
  crush,
  mill,
  blend,
  price,
  refCost,
  setCrush,
  setMill,
  setBlend,
}: {
  category: string
  crush: boolean
  mill: boolean
  blend: number
  price: number
  refCost: RefCost | null
  setCrush: (v: boolean) => void
  setMill: (v: boolean) => void
  setBlend: (v: number) => void
}) {
  const supply = calcSupply(category, price, crush, mill, blend, refCost)
  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1 block text-gray-600">가공</span>
        <div className="flex gap-2">
          <ToggleBtn label="파쇄" on={crush} onClick={() => setCrush(!crush)} />
          <ToggleBtn label="제분" on={mill} onClick={() => setMill(!mill)} />
        </div>
      </div>
      <label className="block">
        <span className="mb-1 block text-gray-600">혼합곡수</span>
        <input
          type="number"
          min={0}
          value={Number.isFinite(blend) ? blend : 0}
          onChange={(e) => setBlend(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
        />
      </label>
      <div className="rounded-lg bg-gray-50 px-3 py-2">
        <div className="text-xs text-gray-400">공급가 미리보기</div>
        {refCost && supply != null ? (
          <>
            <div className="text-lg font-semibold text-gray-900">{supply.toLocaleString()} 원</div>
            <div className="mt-0.5 text-xs text-gray-500">
              {supplyBreakdown(category, price, crush, mill, blend, refCost)}
            </div>
          </>
        ) : (
          <div className="text-sm text-gray-400">참고표 로딩 후 표시</div>
        )}
      </div>
    </div>
  )
}

// ── 수정 모달 (원곡가·가공옵션·적용시작일) ─────────────────────────
function EditModal({
  row,
  roleLabel,
  refCost,
  onClose,
  onSaved,
}: {
  row: CostRow
  roleLabel: string
  refCost: RefCost | null
  onClose: () => void
  onSaved: () => void
}) {
  const [price, setPrice] = useState('')
  const [crush, setCrush] = useState(row.crush)
  const [mill, setMill] = useState(row.mill)
  const [blend, setBlend] = useState(row.blend)
  const [applyFrom, setApplyFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const rawId = [row.category, row.item, row.variety].filter((s) => s.trim() !== '').join('_')

  // 원곡가 입력 없으면 기존값으로 미리보기
  const newPriceNum = Number(String(price).replace(/[^0-9.-]/g, ''))
  const hasPriceInput = price.trim() !== ''
  const previewPrice = hasPriceInput && Number.isFinite(newPriceNum) ? newPriceNum : row.price

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      if (hasPriceInput && !Number.isFinite(newPriceNum)) {
        setErr('변경 후 원곡가를 올바르게 입력해 주세요.')
        setSaving(false)
        return
      }
      const priceChanged = hasPriceInput && newPriceNum !== row.price
      const procChanged = crush !== row.crush || mill !== row.mill || blend !== row.blend
      if (!priceChanged && !procChanged) {
        onClose()
        return
      }

      // 1) 원곡가 변경 (기존 저장 로직 그대로)
      if (priceChanged) {
        const res = await fetch(POST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update',
            gubun: row.category,
            item: row.item,
            variety: row.variety,
            field: '원곡가',
            oldValue: String(row.price),
            newValue: String(newPriceNum),
            applyFrom,
            role: roleLabel,
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.ok) throw new Error(json.error || '원곡가 저장 실패')
      }

      // 2) 가공옵션(파쇄/제분/혼합곡수) 변경
      if (procChanged) {
        const res = await fetch(POST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update-proc',
            gubun: row.category,
            item: row.item,
            variety: row.variety,
            crush,
            mill,
            blend,
            oldCrush: row.crush,
            oldMill: row.mill,
            oldBlend: row.blend,
            applyFrom,
            role: roleLabel,
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.ok) throw new Error(json.error || '가공옵션 저장 실패')
      }

      onSaved()
    } catch (e: any) {
      setErr(e?.message || '저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title="원료 수정" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          <div className="text-xs text-gray-400">원료ID (자동)</div>
          <div className="font-medium">{rawId}</div>
        </div>
        <div>
          <span className="mb-1 block text-gray-600">1kg당원곡가</span>
          <div className="flex items-center gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-gray-400">변경 전</span>
              <input
                type="text"
                value={row.price.toLocaleString()}
                readOnly
                className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-gray-500 focus:outline-none"
              />
            </label>
            <span className="mt-5 text-gray-400">→</span>
            <label className="flex-1">
              <span className="mb-1 block text-xs text-gray-400">변경 후</span>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="새 원곡가"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
            </label>
          </div>
        </div>
        <ProcFields
          category={row.category}
          crush={crush}
          mill={mill}
          blend={blend}
          price={previewPrice}
          refCost={refCost}
          setCrush={setCrush}
          setMill={setMill}
          setBlend={setBlend}
        />
        <label className="block">
          <span className="mb-1 block text-gray-600">적용 시작일</span>
          <input
            type="date"
            value={applyFrom}
            onChange={(e) => setApplyFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </label>
        {err && <p className="text-sm text-red-600">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── 신규 원료 추가 모달 ───────────────────────────────────────────
function CreateModal({
  roleLabel,
  refCost,
  onClose,
  onSaved,
}: {
  roleLabel: string
  refCost: RefCost | null
  onClose: () => void
  onSaved: () => void
}) {
  const GUBUN_OPTIONS = ['유기농', '무농약', '관행', '수입', '혼합', '톤백', '물류대행', '직접입력']
  const [gubunSelect, setGubunSelect] = useState('유기농')
  const [gubunCustom, setGubunCustom] = useState('')
  const [item, setItem] = useState('')
  const [variety, setVariety] = useState('')
  const [wongok, setWongok] = useState('')
  const [tax, setTax] = useState('면세')
  const [crush, setCrush] = useState(false)
  const [mill, setMill] = useState(false)
  const [blend, setBlend] = useState(0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const gubun = gubunSelect === '직접입력' ? gubunCustom : gubunSelect
  const rawId = [gubun, item, variety].filter((s) => s.trim() !== '').join('_') || '—'
  const wongokNum = wongok ? Number(String(wongok).replace(/[^0-9.-]/g, '')) : 0

  const handleSave = async () => {
    if (!gubun.trim() || !item.trim()) {
      setErr('구분과 품목은 필수입니다.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          gubun: gubun.trim(),
          item: item.trim(),
          variety: variety.trim(),
          wongok: wongok ? Number(String(wongok).replace(/[^0-9.-]/g, '')) : '',
          tax,
          crush,
          mill,
          blend,
          role: roleLabel,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || '저장 실패')
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, node: React.ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-gray-600">{label}</span>
      {node}
    </label>
  )
  const inputCls =
    'w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400'

  return (
    <ModalShell title="신규 원료 추가" onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-auto text-sm">
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          <div className="text-xs text-gray-400">원료ID (자동 · 구분_품목_품종)</div>
          <div className="font-medium">{rawId}</div>
        </div>
        {field(
          '구분 *',
          <div className="space-y-2">
            <select value={gubunSelect} onChange={(e) => setGubunSelect(e.target.value)} className={inputCls}>
              {GUBUN_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {gubunSelect === '직접입력' && (
              <input
                value={gubunCustom}
                onChange={(e) => setGubunCustom(e.target.value)}
                className={inputCls}
                placeholder="구분 직접 입력"
              />
            )}
          </div>,
        )}
        {field('품목 *', <input value={item} onChange={(e) => setItem(e.target.value)} className={inputCls} />)}
        {field('품종', <input value={variety} onChange={(e) => setVariety(e.target.value)} className={inputCls} />)}
        {field('1kg당원곡가', <input type="number" value={wongok} onChange={(e) => setWongok(e.target.value)} className={inputCls} />)}
        {field(
          '과세여부',
          <select value={tax} onChange={(e) => setTax(e.target.value)} className={inputCls}>
            <option value="면세">면세</option>
            <option value="과세">과세</option>
          </select>,
        )}
        <ProcFields
          category={gubun}
          crush={crush}
          mill={mill}
          blend={blend}
          price={wongokNum}
          refCost={refCost}
          setCrush={setCrush}
          setMill={setMill}
          setBlend={setBlend}
        />
        <p className="text-xs text-gray-400">원료ID는 시트 수식이 자동 계산합니다. 공급가는 원곡가·가공옵션·참고표 단가로 대시보드가 자동 계산합니다. 취급상태는 시트에서 직접 입력합니다.</p>
        {err && <p className="text-sm text-red-600">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {saving ? '저장 중…' : '추가'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── 참고표 항목별 수정 모달 (변경전/후·적용시작일, 원곡가 모달과 통일) ──
function RefEditModal({
  title,
  kind,
  fields,
  editor,
  onClose,
  onSaved,
}: {
  title: string
  kind: 'cost' | 'ship'
  fields: { item: string; label: string; current: number }[]
  editor: string
  onClose: () => void
  onSaved: () => void
}) {
  const [next, setNext] = useState<Record<string, string>>({})
  const [applyFrom, setApplyFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const num = (s: string) => Number(String(s).replace(/[^0-9.-]/g, ''))

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      // 값이 입력되고 현재값과 다른 항목만 개별 update (로그도 항목마다)
      const changes = fields
        .map((f) => ({ f, raw: (next[f.item] ?? '').trim() }))
        .filter(({ raw }) => raw !== '')
        .map(({ f, raw }) => ({ f, nv: num(raw) }))
        .filter(({ f, nv }) => Number.isFinite(nv) && nv !== f.current)

      if (changes.length === 0) {
        onClose()
        return
      }
      for (const { f, nv } of changes) {
        const res = await fetch(POST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update-ref',
            kind,
            item: f.item,
            oldValue: String(f.current),
            newValue: String(nv),
            applyFrom,
            editor,
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.ok) throw new Error(json.error || '저장 실패')
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {fields.map((f) => (
          <div key={f.item}>
            <span className="mb-1 block text-gray-600">{f.label}</span>
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <span className="mb-1 block text-xs text-gray-400">변경 전</span>
                <input
                  type="text"
                  value={f.current.toLocaleString()}
                  readOnly
                  className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-gray-500 focus:outline-none"
                />
              </label>
              <span className="mt-5 text-gray-400">→</span>
              <label className="flex-1">
                <span className="mb-1 block text-xs text-gray-400">변경 후</span>
                <input
                  type="number"
                  value={next[f.item] ?? ''}
                  onChange={(e) => setNext((v) => ({ ...v, [f.item]: e.target.value }))}
                  placeholder="새 값"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
              </label>
            </div>
          </div>
        ))}
        <label className="block">
          <span className="mb-1 block text-gray-600">적용 시작일</span>
          <input
            type="date"
            value={applyFrom}
            onChange={(e) => setApplyFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </label>
        {err && <p className="text-sm text-red-600">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50">
            취소
          </button>
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50">
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
