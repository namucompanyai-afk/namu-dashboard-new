/**
 * costBook — 마진 마스터 in-memory 저장소 + 비용 lookup 헬퍼
 *
 * v2 (2026-04): 새 비용테이블 구조 반영
 *  - 입출고비: 가격대 × (0.8/1/2)kg 매트릭스
 *  - 그로스 배송비: 가격대 × (극소/소/중/대형1) 매트릭스
 *  - 윙 박스/택배: 분류(소/중/대) 그대로
 *  - 창고 입고비: 제조사|단위 매트릭스
 *
 * 가격대 라벨은 "9,900"/"10,900"/.../"19,900" 텍스트 그대로 키로 사용.
 */

import type {
  CostMaster,
  CostBookRow,
  CostTableConstants,
  MarginCalcRow,
} from './parsers/marginMaster'

// ─────────────────────────────────────────────────────────────
// In-memory 저장소
// ─────────────────────────────────────────────────────────────

let _master: CostMaster | null = null
let _costBookByExposureId: Map<string, CostBookRow> = new Map()
let _marginRowByOptionId: Map<string, MarginCalcRow> = new Map()
let _actualPriceByOptionId: Map<string, number> = new Map()

export function setCostMaster(master: CostMaster | null): void {
  _master = master
  _costBookByExposureId = new Map()
  _marginRowByOptionId = new Map()
  _actualPriceByOptionId = new Map()
  if (!master) return
  for (const row of master.costBook) {
    _costBookByExposureId.set(row.exposureId, row)
  }
  for (const row of master.marginRows) {
    _marginRowByOptionId.set(row.optionId, row)
    if (row.actualPrice > 0) _actualPriceByOptionId.set(row.optionId, row.actualPrice)
  }
}

export function hasCostMaster(): boolean { return _master !== null }
export function getCostMaster(): CostMaster | null { return _master }

export function getCostBook(exposureId: string): CostBookRow | undefined {
  return _costBookByExposureId.get(exposureId)
}

export function getMarginRow(optionId: string): MarginCalcRow | undefined {
  return _marginRowByOptionId.get(optionId)
}

export function getActualPrice(optionId: string): number | undefined {
  return _actualPriceByOptionId.get(optionId)
}

export function getOptionChannel(optionId: string): string | undefined {
  return _marginRowByOptionId.get(optionId)?.channel
}

export function getNetProfit(optionId: string): number | null {
  return _marginRowByOptionId.get(optionId)?.netProfit ?? null
}

// ─────────────────────────────────────────────────────────────
// DEFAULT_CONSTANTS — 마스터 안 올라간 상태에서 안전 fallback
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONSTANTS: CostTableConstants = {
  bagFee: 150,
  defaultFeeRate: 0.0638,
  inoutTable: {
    '9,900':  { '0.8': 1089, '1': 1034, '2': 1155 },
    '10,900': { '0.8': 1089, '1': 1089, '2': 1232 },
    '11,900': { '0.8': 1100, '1': 1100, '2': 1309 },
    '12,900': { '0.8': 1111, '1': 1111, '2': 1386 },
    '13,900': { '0.8': 1122, '1': 1122, '2': 1463 },
    '14,900': { '0.8': 1128, '1': 1128, '2': 1540 },
    '19,900': { '0.8': 1128, '1': 1128, '2': 1540 },
  },
  grossShipTable: {
    '9,900':  { '극소': 1282, '소': 1375, '중': 1650, '대형1': 1870 },
    '10,900': { '극소': 1447, '소': 1617, '중': 1931, '대형1': 2261 },
    '11,900': { '극소': 1656, '소': 1859, '중': 2211, '대형1': 2651 },
    '12,900': { '극소': 1865, '소': 2101, '중': 2492, '대형1': 3042 },
    '13,900': { '극소': 2074, '소': 2343, '중': 2772, '대형1': 3432 },
    '14,900': { '극소': 2281, '소': 2585, '중': 3053, '대형1': 3823 },
    '19,900': { '극소': 2310, '소': 2640, '중': 3053, '대형1': 3823 },
  },
  wingBoxShipTable: {
    small: { minKg: 1,  maxKg: 3,  box: 371,  ship: 2100 },
    mid:   { minKg: 4,  maxKg: 10, box: 1123, ship: 2800 },
    large: { minKg: 11, maxKg: 20, box: 1300, ship: 4400 },
  },
  warehouseFee: {
    '곰표|2kg':   190,
    '진도팜|1kg': 260,
    '진도팜|2kg': 516,
  },
  // 옛 코드 호환
  gross1kgTable: {
    '9,900':  { ship: 1375, inout: 1034 },
    '10,900': { ship: 1617, inout: 1089 },
    '11,900': { ship: 1859, inout: 1100 },
    '12,900': { ship: 2101, inout: 1111 },
    '13,900': { ship: 2343, inout: 1122 },
    '14,900': { ship: 2585, inout: 1128 },
    '19,900': { ship: 2640, inout: 1128 },
  },
  gross2kgShipTable: {
    '9,900':  1375,
    '10,900': 1617,
    '11,900': 1859,
    '12,900': 2101,
    '13,900': 2343,
    '14,900': 2585,
    '19,900': 2640,
  },
}

export function getCostConstants(): CostTableConstants {
  return _master?.constants ?? DEFAULT_CONSTANTS
}

// ─────────────────────────────────────────────────────────────
// 신규 lookup helpers (v2)
// ─────────────────────────────────────────────────────────────

const PRICE_BAND_LABELS = ['9,900', '10,900', '11,900', '12,900', '13,900', '14,900', '19,900'] as const
type PriceBandLabel = typeof PRICE_BAND_LABELS[number]

const BAND_BOUNDARIES: { max: number; label: PriceBandLabel }[] = [
  { max: 9900,  label: '9,900' },
  { max: 10900, label: '10,900' },
  { max: 11900, label: '11,900' },
  { max: 12900, label: '12,900' },
  { max: 13900, label: '13,900' },
  { max: 14900, label: '14,900' },
  { max: Infinity, label: '19,900' },
]

/** 1봉당 가격(개당가) → 가격대 라벨 (예: 10800 → "10,900") */
export function getPriceBandLabel(perUnitPrice: number): string {
  for (const b of BAND_BOUNDARIES) {
    if (perUnitPrice <= b.max) return b.label
  }
  return '19,900'
}

/**
 * 그로스 + 봉용량 + 봉수 → 규격 라벨.
 * - G=0.8 또는 G=1: F=1 → 극소, F<=4 → 소, else 중
 * - G=2: F<=2 → 소, F<=4 → 중, else 대형1
 * - 그 외 → ""
 */
export function getOptionSizeLabel(channel: string, kgPerBag: number, bagCount: number): string {
  if (channel !== '그로스') return ''
  if (kgPerBag === 0.8 || kgPerBag === 1) {
    if (bagCount === 1) return '극소'
    if (bagCount <= 4) return '소'
    return '중'
  }
  if (kgPerBag === 2) {
    if (bagCount <= 2) return '소'
    if (bagCount <= 4) return '중'
    return '대형1'
  }
  return ''
}

/** 입출고비 lookup (가격대 라벨 + 1봉kg). 못 찾으면 0 */
export function getInoutFee(priceBandLabel: string, kgPerBag: number): number {
  if (kgPerBag !== 0.8 && kgPerBag !== 1 && kgPerBag !== 2) return 0
  const key = String(kgPerBag) as '0.8' | '1' | '2'
  return getCostConstants().inoutTable[priceBandLabel]?.[key] ?? 0
}

/** 그로스 배송비 lookup (가격대 라벨 + 규격 라벨). 못 찾으면 0 */
export function getGrossShipFee(priceBandLabel: string, sizeLabel: string): number {
  const tbl = getCostConstants().grossShipTable[priceBandLabel]
  if (!tbl) return 0
  if (sizeLabel === '극소' || sizeLabel === '소' || sizeLabel === '중' || sizeLabel === '대형1') {
    return tbl[sizeLabel] ?? 0
  }
  return 0
}

// ─────────────────────────────────────────────────────────────
// 옛 helpers (margin.ts 호환 유지)
// ─────────────────────────────────────────────────────────────

/** 기준용량 문자열 → kg 숫자 — 옛 매핑 + fallback 파싱 */
export const VOLUME_TO_KG: Record<string, number> = {
  '1kg': 1, '2kg': 2, '3kg': 3, '6kg': 6, '10kg': 10,
  '500g': 0.5, '100g': 0.1, '300ml': 0.3, '800g': 0.8, '350g': 0.35,
}

/** @deprecated — 신규 코드는 getPriceBandLabel() 사용 */
export function getPriceBand(perUnitPrice: number): number {
  if (perUnitPrice <= 9900) return 9900
  if (perUnitPrice >= 14900) return 14900
  return Math.ceil(perUnitPrice / 1000) * 1000 - 100
}

export function getWingBracket(totalKg: number): { box: number; ship: number } {
  const tbl = getCostConstants().wingBoxShipTable
  if (totalKg <= tbl.small.maxKg) return { box: tbl.small.box, ship: tbl.small.ship }
  if (totalKg <= tbl.mid.maxKg) return { box: tbl.mid.box, ship: tbl.mid.ship }
  return { box: tbl.large.box, ship: tbl.large.ship }
}

export function getWarehouseFee(manufacturer: string, baseVolume: string): number {
  const key = `${manufacturer}|${baseVolume}`
  return getCostConstants().warehouseFee[key] ?? 0
}

// ─────────────────────────────────────────────────────────────
// 통계
// ─────────────────────────────────────────────────────────────

export function getCostMasterStats(): {
  loaded: boolean
  costBookRows: number
  marginRows: number
  optionsWithActualPrice: number
} {
  return {
    loaded: _master !== null,
    costBookRows: _costBookByExposureId.size,
    marginRows: _marginRowByOptionId.size,
    optionsWithActualPrice: _actualPriceByOptionId.size,
  }
}
