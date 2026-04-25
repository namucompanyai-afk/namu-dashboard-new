/**
 * costBook — 원가표 + 비용 상수 in-memory 저장소
 *
 * ⚠️ 중요: 더 이상 하드코딩된 데이터 없음.
 *   대표님이 마진분석.xlsx를 업로드하면 → marginMaster 파서가 파싱 →
 *   setCostMaster()로 이 모듈에 주입 → 시스템 전체에서 이 모듈을 통해 조회.
 *
 * 흐름:
 *   1) UploadZone (page.tsx) → 마진분석.xlsx 업로드
 *   2) parseMarginMaster() → CostMaster 객체 반환
 *   3) setCostMaster(master) → 이 모듈에 저장
 *   4) margin.ts / diagnosis.ts → getCostBook(exposureId), getCostConstants() 등으로 조회
 *
 * 엑셀 안 올라간 상태에서 조회하면:
 *   - getCostBook() → undefined
 *   - getCostConstants() → 기본값 (안전장치)
 *   - hasCostMaster() → false
 *
 * UI는 hasCostMaster()로 체크해서 "마진 마스터 엑셀을 업로드해주세요" 안내해야 함.
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

/**
 * 마진 마스터를 시스템에 주입.
 * 호출 시 내부 인덱스 맵들을 재구축.
 */
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
    if (row.actualPrice > 0) {
      _actualPriceByOptionId.set(row.optionId, row.actualPrice)
    }
  }
}

/** 마진 마스터가 로드되어 있는지 */
export function hasCostMaster(): boolean {
  return _master !== null
}

/** 현재 로드된 마스터 객체 (있으면) */
export function getCostMaster(): CostMaster | null {
  return _master
}

// ─────────────────────────────────────────────────────────────
// 조회 API
// ─────────────────────────────────────────────────────────────

/** 노출ID로 원가표 행 조회 (없으면 undefined) */
export function getCostBook(exposureId: string): CostBookRow | undefined {
  return _costBookByExposureId.get(exposureId)
}

/** 옵션ID로 마진계산 행 조회 (실판매가/순이익/마진율 등 포함) */
export function getMarginRow(optionId: string): MarginCalcRow | undefined {
  return _marginRowByOptionId.get(optionId)
}

/**
 * 옵션ID로 실판매가 조회 (없으면 undefined)
 * 진단·광고매출 계산에서 핵심.
 * fallback이 필요하면 호출 측에서 price_inventory 판매가로 처리.
 */
export function getActualPrice(optionId: string): number | undefined {
  return _actualPriceByOptionId.get(optionId)
}

/** 옵션ID로 마진계산 시트의 채널 (그로스/윙) */
export function getOptionChannel(optionId: string): string | undefined {
  return _marginRowByOptionId.get(optionId)?.channel
}

/**
 * 옵션ID로 엑셀에서 계산된 옵션 순이익(원) 직접 조회.
 * - margin.ts의 동적 계산 대신 이 값을 신뢰하면 엑셀과 100% 일치.
 * - 단, 엑셀 수식이 한 번이라도 계산된 적 있어야 함 (LibreOffice/Excel로 열어서 저장).
 */
export function getNetProfit(optionId: string): number | null {
  return _marginRowByOptionId.get(optionId)?.netProfit ?? null
}

// ─────────────────────────────────────────────────────────────
// 비용 상수 (마스터 우선, 기본값 fallback)
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONSTANTS: CostTableConstants = {
  bagFee: 150,
  defaultFeeRate: 0.07,
  gross1kgTable: {
    '9900':  { ship: 1282, inout: 1034 },
    '10900': { ship: 1447, inout: 1089 },
    '11900': { ship: 1656, inout: 1100 },
    '12900': { ship: 1865, inout: 1111 },
    '13900': { ship: 2074, inout: 1122 },
    '14900': { ship: 2281, inout: 1128 },
  },
  gross2kgShipTable: {
    '9900':  1155,
    '10900': 1232,
    '11900': 1309,
    '12900': 1386,
    '13900': 1463,
    '14900': 1540,
  },
  wingBoxShipTable: {
    small: { minKg: 1,  maxKg: 3,  box: 371,  ship: 2100 },
    mid:   { minKg: 4,  maxKg: 10, box: 1123, ship: 2800 },
    large: { minKg: 11, maxKg: 20, box: 1300, ship: 4000 },
  },
  warehouseFee: {
    '곰표|2kg':   190,
    '진도팜|1kg': 247.50694444444446,
    '진도팜|2kg': 491.97241379310344,
    '진도팜|3kg': 792.6222222222223,
  },
}

/**
 * 비용 상수 (마스터 우선).
 * 마스터 안 올라가도 안전한 기본값 반환.
 */
export function getCostConstants(): CostTableConstants {
  return _master?.constants ?? DEFAULT_CONSTANTS
}

// ─────────────────────────────────────────────────────────────
// 헬퍼 (기존 유지)
// ─────────────────────────────────────────────────────────────

/**
 * 기준용량 문자열 → kg 숫자 변환
 * 마진분석 엑셀의 VLOOKUP과 동일하게 50g/300ml 등 미등록은 1로 fallback.
 */
export const VOLUME_TO_KG: Record<string, number> = {
  '1kg': 1, '2kg': 2, '3kg': 3, '6kg': 6, '10kg': 10,
  '500g': 0.5, '100g': 0.1, '300ml': 0.3, '800g': 0.8, '350g': 0.35,
}

/** 개당 판매가 → 가격대 산출 (비용테이블 조회용 키) */
export function getPriceBand(perUnitPrice: number): number {
  if (perUnitPrice <= 9900) return 9900
  if (perUnitPrice >= 14900) return 14900
  return Math.ceil(perUnitPrice / 1000) * 1000 - 100
}

/**
 * 윙 총kg → 박스/택배 구간 (소/중/대)
 * 1~3kg=소, 4~10kg=중, 11~20kg=대 (20kg 초과는 대로 처리)
 */
export function getWingBracket(totalKg: number): { box: number; ship: number } {
  const tbl = getCostConstants().wingBoxShipTable
  if (totalKg <= tbl.small.maxKg) return { box: tbl.small.box, ship: tbl.small.ship }
  if (totalKg <= tbl.mid.maxKg) return { box: tbl.mid.box, ship: tbl.mid.ship }
  return { box: tbl.large.box, ship: tbl.large.ship }
}

/** 창고 입고비 조회 (없으면 0) */
export function getWarehouseFee(manufacturer: string, baseVolume: string): number {
  const key = `${manufacturer}|${baseVolume}`
  return getCostConstants().warehouseFee[key] ?? 0
}

// ─────────────────────────────────────────────────────────────
// 진단/리포트용 통계
// ─────────────────────────────────────────────────────────────

/** 마스터 적재 통계 (UI에서 보여줄 때 사용) */
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
