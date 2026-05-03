import * as XLSX from 'xlsx'

/**
 * 마진마스터.xlsx 의 "마진계산_네이버" 시트 파서 (네이버 진단 전용)
 * 헤더 R4, 데이터 R5~
 *   A 노출ID  C 별칭  D 옵션명  F 봉수  G 1봉kg
 *   I 실판매가  P 원가  Q 봉투  R 박스  S 택배  X 포장비(VAT)
 *
 * 자동 수식 셀(P/Q/R/S/X)은 SheetJS 캐시값(.v) 기준. 비어있으면 0.
 * 같은 노출ID에 옵션이 여러 개면 NaverMarginMap 의 array 로 묶여 반환.
 */

export interface NaverMarginOption {
  exposureId: string
  alias: string
  optionName: string
  bagCount: number
  kgPerBag: number
  sellPrice: number
  cost: number
  bag: number
  box: number
  ship: number
  pack: number
}

export type NaverMarginMap = Map<string, NaverMarginOption[]>

/** 스스 CPM 단가 (비용테이블 시트 'CPM 단가 (스스)' 영역) */
export interface NaverCpmConfig {
  unitPrice: number // VAT 포함 (예: 40700)
  baseDays: number  // 단가 기준 일수 (예: 10)
}

const DEFAULT_CPM: NaverCpmConfig = { unitPrice: 40700, baseDays: 10 }

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).replace(/,/g, '').trim()
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function findSheet(wb: XLSX.WorkBook, candidates: string[]): unknown[][] | null {
  for (const name of wb.SheetNames) {
    if (candidates.includes(name)) {
      return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false })
    }
  }
  for (const name of wb.SheetNames) {
    if (candidates.some((k) => name.includes(k))) {
      return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false })
    }
  }
  return null
}

/** 비용테이블 시트에서 'CPM 단가 (스스)' 행 찾아 unitPrice/baseDays 파싱 */
export async function parseNaverCpmConfig(buffer: ArrayBuffer): Promise<NaverCpmConfig> {
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: false })
  const aoa = findSheet(wb, ['비용테이블', '비용 테이블'])
  if (!aoa) return { ...DEFAULT_CPM }
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const a = toStr(row[0])
    if (a.includes('스스 CPM') || a.includes('네이버 CPM') || a === 'CPM') {
      const unitPrice = toNum(row[1]) || DEFAULT_CPM.unitPrice
      const baseDays = toNum(row[2]) || DEFAULT_CPM.baseDays
      return { unitPrice, baseDays }
    }
  }
  return { ...DEFAULT_CPM }
}

export async function parseNaverMarginMaster(buffer: ArrayBuffer): Promise<NaverMarginMap> {
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: false })
  const aoa = findSheet(wb, ['마진계산_네이버'])
  const map: NaverMarginMap = new Map()
  if (!aoa) return map

  // 헤더 행 탐색 (R4 가정, 노출ID/옵션ID/별칭/실판매가 키 포함 행)
  let headerIdx = -1
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const cells = row.map((c) => toStr(c).toLowerCase())
    if (cells.includes('노출id') && cells.includes('별칭') && cells.includes('실판매가')) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return map

  // 컬럼은 알파벳 고정 위치(A=0, C=2, D=3, F=5, G=6, I=8, P=15, Q=16, R=17, S=18, X=23)
  // 단, [수기] 마커 등으로 위치가 미세하게 달라질 일은 없음 (마진계산_네이버 분리 시트 고정)
  const COL = {
    exposureId: 0,
    alias: 2,
    optionName: 3,
    bagCount: 5,
    kgPerBag: 6,
    sellPrice: 8,
    cost: 15,
    bag: 16,
    box: 17,
    ship: 18,
    pack: 23,
  } as const

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const exposureId = toStr(r[COL.exposureId])
    if (!exposureId) continue

    const opt: NaverMarginOption = {
      exposureId,
      alias: toStr(r[COL.alias]),
      optionName: toStr(r[COL.optionName]),
      bagCount: toNum(r[COL.bagCount]) || 1,
      kgPerBag: toNum(r[COL.kgPerBag]) || 1,
      sellPrice: toNum(r[COL.sellPrice]),
      cost: toNum(r[COL.cost]),
      bag: toNum(r[COL.bag]),
      box: toNum(r[COL.box]),
      ship: toNum(r[COL.ship]),
      pack: toNum(r[COL.pack]),
    }
    const arr = map.get(exposureId)
    if (arr) arr.push(opt)
    else map.set(exposureId, [opt])
  }
  return map
}
