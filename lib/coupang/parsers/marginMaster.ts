import * as XLSX from 'xlsx'

/**
 * 마진분석.xlsx 마스터 파서
 *
 * 엑셀 구조 (3시트):
 *   1) 원가표: 노출ID별 원가 구성요소 (원곡가 · 작업비 · 혼합비 · 제조사 · 과세 · 봉투비여부)
 *   2) 비용테이블: 공통 상수 (봉투비·수수료율) + 그로스 1kg/2kg 배송비 테이블 + 윙 박스·택배 + 창고입고비
 *   3) 마진계산: 옵션 레벨 데이터 (옵션ID · 실판매가 · 최종 순이익 계산 결과)
 *
 * 이 파서는 3시트 모두 읽어서 `CostMaster` 하나의 객체로 리턴.
 * 시스템은 이 객체만 있으면 마진·진단 계산 가능 (하드코딩 불필요).
 *
 * ──────────────────────────────────────────────────────────────
 * 중요: 실판매가 우선순위
 *   마진계산 시트의 I열(실판매가)가 이 시스템의 "정식 판매가".
 *   price_inventory의 판매가격은 참고용 (fallback용).
 */

function normHeader(s: string): string {
  // 공백·괄호·슬래시·특수문자 제거, 소문자화
  return s.replace(/[\s()\[\]/·\n\t]+/g, '').toLowerCase()
}

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return NaN
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  const cleaned = String(v).replace(/[,\s원%]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}

// ─────────────────────────────────────────────────────────────
// 원가표 시트 타입
// ─────────────────────────────────────────────────────────────

export interface CostBookRow {
  /** 노출상품ID */
  exposureId: string
  /** 쿠팡 원본 상품명 */
  productName: string
  /** 내 별칭 (대시보드 표시용) */
  alias: string
  /** 채널 ("단일"/"그로스"/"윙"/"둘다"/"혼합") */
  channel: string
  /** 옵션수 (참고용) */
  optionCount: number
  /** 옵션 샘플 (참고용) */
  optionSample: string
  /** 기준 용량 ("1kg", "500g", "100g" 등) */
  baseVolume: string
  /** 원곡가 (기준용량 1봉당, VAT 포함) */
  rawCost: number
  /** 윙 작업비 (1봉당) */
  wingWorkFee: number
  /** 그로스 작업비 (1봉당) */
  growthWorkFee: number
  /** 혼합비 (1봉당) */
  mixFee: number
  /** 제조사 ("곰표"/"진도팜"/"녹색원"/"시목원" 등) */
  manufacturer: string
  /** 과세구분 ("과세"/"면세") */
  taxType: '과세' | '면세'
  /** 봉투비 여부 ("Y"/"N") */
  needsBag: 'Y' | 'N'
  memo?: string
}

const COST_BOOK_ALIASES = {
  exposureId:     ['노출id', '노출상품id'],
  productName:    ['쿠팡원본상품명', '상품명'],
  alias:          ['내별칭', '별칭'],
  channel:        ['채널'],
  optionCount:    ['옵션수'],
  optionSample:   ['옵션샘플'],
  baseVolume:     ['기준용량'],
  rawCost:        ['원곡가', '원재료가'],
  wingWorkFee:    ['윙작업비'],
  growthWorkFee:  ['그로스작업비'],
  mixFee:         ['혼합비'],
  manufacturer:   ['제조사'],
  taxType:        ['과세구분'],
  needsBag:       ['봉투비여부'],
  memo:           ['메모'],
} as const

type CostBookKey = keyof typeof COST_BOOK_ALIASES

// ─────────────────────────────────────────────────────────────
// 마진계산 시트 타입
// ─────────────────────────────────────────────────────────────

export interface MarginCalcRow {
  /** 노출상품ID */
  exposureId: string
  /** 옵션ID */
  optionId: string
  /** 별칭 (VLOOKUP 결과) */
  alias: string
  /** 옵션명 (예: "1개 1kg") */
  optionName: string
  /** 총 kg */
  totalKg: number
  /** 봉투수 */
  bagCount: number
  /** 1봉당 kg */
  kgPerBag: number
  /** 정가 (VAT) — 기억용, 계산에 미사용 */
  listPrice: number
  /** 실판매가 — 시스템의 공식 판매가 */
  actualPrice: number
  /** 엑셀에서 계산된 순이익 (검증용) */
  netProfit: number | null
  /** 엑셀에서 계산된 마진율 (검증용) */
  marginRate: number | null
  /** 엑셀에서 계산된 BEP ROAS (검증용) */
  bepRoas: number | null
  /** 최종 채널 */
  channel: string
}

const MARGIN_ROW_ALIASES = {
  exposureId: ['노출id'],
  optionId: ['옵션id'],
  alias: ['별칭'],
  optionName: ['옵션명'],
  totalKg: ['총kg'],
  bagCount: ['봉투수'],
  kgPerBag: ['1봉kg'],
  listPrice: ['정가vat', '정가', '판매가vat', '판매가'],
  actualPrice: ['실판매가'],
  channel: ['최종채널'],
  netProfit: ['순이익vat', '순이익'],
  marginRate: ['마진율'],
  bepRoas: ['beproas'],
} as const

type MarginRowKey = keyof typeof MARGIN_ROW_ALIASES

// ─────────────────────────────────────────────────────────────
// 비용테이블 시트 타입
// ─────────────────────────────────────────────────────────────

export interface CostTableConstants {
  /** 봉투비 (봉당) */
  bagFee: number
  /** 기본 수수료율 (0~1) */
  defaultFeeRate: number
  /**
   * 그로스 1kg 입고 기준 가격대별 (배송비, 입출고비)
   * key: 가격대 ("9900", "10900", ...)
   */
  gross1kgTable: Record<string, { ship: number; inout: number }>
  /** 그로스 2kg 입고 기준 가격대별 (배송비 2kg 단가) */
  gross2kgShipTable: Record<string, number>
  /** 윙 박스·택배 (소/중/대) */
  wingBoxShipTable: {
    small: { minKg: number; maxKg: number; box: number; ship: number }
    mid:   { minKg: number; maxKg: number; box: number; ship: number }
    large: { minKg: number; maxKg: number; box: number; ship: number }
  }
  /** 그로스 창고 입고비 (봉당) — key = "제조사|기준용량" */
  warehouseFee: Record<string, number>
}

// ─────────────────────────────────────────────────────────────
// 최종 결과
// ─────────────────────────────────────────────────────────────

export interface CostMaster {
  /** 원가표 상품 리스트 */
  costBook: CostBookRow[]
  /** 옵션 레벨 계산 행 */
  marginRows: MarginCalcRow[]
  /** 공통 상수 + 비용 테이블 */
  constants: CostTableConstants
}

export interface MarginMasterParseResult {
  master: CostMaster | null
  /** 에러 (파싱 실패 시) */
  error?: string
  /** 경고 (일부 시트 못 읽음) */
  warnings: string[]
  /** 통계 */
  stats: {
    costBookRows: number
    marginRows: number
    hasConstants: boolean
  }
}

// ─────────────────────────────────────────────────────────────
// 원가표 시트 파서
// ─────────────────────────────────────────────────────────────

function findHeaderRow(aoa: unknown[][], requiredKeys: string[]): number {
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const normed = row.map((c) => normHeader(toStr(c)))
    const hitCount = requiredKeys.filter((k) => normed.includes(k)).length
    if (hitCount >= 2) return i
  }
  return -1
}

function resolveColumns<T extends string>(
  headers: string[],
  aliases: Record<T, readonly string[]>,
  required: T[],
): { cols: Record<T, number>; missing: string[] } {
  const normed = headers.map((h) => normHeader(toStr(h)))
  const cols = {} as Record<T, number>
  const missing: string[] = []

  for (const key of Object.keys(aliases) as T[]) {
    const aliasList = aliases[key] as readonly string[]
    const idx = normed.findIndex((h) => aliasList.includes(h))
    cols[key] = idx
    if (idx === -1 && required.includes(key)) missing.push(String(key))
  }
  return { cols, missing }
}

function parseCostBook(aoa: unknown[][]): { rows: CostBookRow[]; error?: string } {
  const headerIdx = findHeaderRow(aoa, ['노출id', '내별칭', '원곡가'])
  if (headerIdx === -1) {
    return { rows: [], error: '원가표 헤더 행을 찾지 못했습니다' }
  }
  const headers = (aoa[headerIdx] as unknown[]).map(toStr)
  const { cols, missing } = resolveColumns<CostBookKey>(headers, COST_BOOK_ALIASES, [
    'exposureId', 'alias', 'baseVolume', 'rawCost', 'manufacturer', 'taxType', 'needsBag',
  ])
  if (missing.length > 0) {
    return { rows: [], error: `원가표 필수 컬럼 누락: ${missing.join(', ')}` }
  }

  const rows: CostBookRow[] = []
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const exp = toStr(r[cols.exposureId])
    if (!exp || !/^\d+$/.test(exp)) continue  // 숫자 노출ID만 (메모 행 필터)

    const alias = toStr(r[cols.alias])
    if (!alias) continue

    const rawCost = toNum(r[cols.rawCost])
    const manufacturer = toStr(r[cols.manufacturer])
    const taxTypeStr = toStr(r[cols.taxType])
    const needsBagStr = toStr(r[cols.needsBag])
    if (!Number.isFinite(rawCost) || !manufacturer) continue

    rows.push({
      exposureId: exp,
      productName: toStr(r[cols.productName]),
      alias,
      channel: toStr(r[cols.channel]) || '단일',
      optionCount: toNum(r[cols.optionCount]) || 0,
      optionSample: toStr(r[cols.optionSample]),
      baseVolume: toStr(r[cols.baseVolume]) || '1kg',
      rawCost,
      wingWorkFee: toNum(r[cols.wingWorkFee]) || 0,
      growthWorkFee: toNum(r[cols.growthWorkFee]) || 0,
      mixFee: toNum(r[cols.mixFee]) || 0,
      manufacturer,
      taxType: (taxTypeStr === '과세' ? '과세' : '면세') as '과세' | '면세',
      needsBag: (needsBagStr === 'N' ? 'N' : 'Y') as 'Y' | 'N',
      memo: cols.memo !== -1 ? toStr(r[cols.memo]) || undefined : undefined,
    })
  }
  return { rows }
}

// ─────────────────────────────────────────────────────────────
// 마진계산 시트 파서
// ─────────────────────────────────────────────────────────────

function parseMarginRows(aoa: unknown[][]): { rows: MarginCalcRow[]; error?: string } {
  const headerIdx = findHeaderRow(aoa, ['옵션id', '실판매가'])
  if (headerIdx === -1) {
    return { rows: [], error: '마진계산 시트 헤더를 찾지 못했습니다 (옵션ID + 실판매가 필요)' }
  }
  const headers = (aoa[headerIdx] as unknown[]).map(toStr)
  const { cols, missing } = resolveColumns<MarginRowKey>(headers, MARGIN_ROW_ALIASES, [
    'exposureId', 'optionId', 'optionName', 'actualPrice',
  ])
  if (missing.length > 0) {
    return { rows: [], error: `마진계산 필수 컬럼 누락: ${missing.join(', ')}` }
  }

  const rows: MarginCalcRow[] = []
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const optId = toStr(r[cols.optionId])
    if (!optId || !/^\d+$/.test(optId)) continue

    const actualPrice = toNum(r[cols.actualPrice])
    if (!Number.isFinite(actualPrice) || actualPrice <= 0) continue

    const listPrice = toNum(r[cols.listPrice])
    const netProfit = toNum(r[cols.netProfit])
    const marginRate = toNum(r[cols.marginRate])
    const bepRoas = toNum(r[cols.bepRoas])

    rows.push({
      exposureId: toStr(r[cols.exposureId]),
      optionId: optId,
      alias: toStr(r[cols.alias]),
      optionName: toStr(r[cols.optionName]),
      totalKg: toNum(r[cols.totalKg]) || 0,
      bagCount: toNum(r[cols.bagCount]) || 1,
      kgPerBag: toNum(r[cols.kgPerBag]) || 1,
      listPrice: Number.isFinite(listPrice) ? listPrice : actualPrice,
      actualPrice,
      netProfit: Number.isFinite(netProfit) ? netProfit : null,
      marginRate: Number.isFinite(marginRate) ? marginRate : null,
      bepRoas: Number.isFinite(bepRoas) ? bepRoas : null,
      channel: toStr(r[cols.channel]) || '',
    })
  }
  return { rows }
}

// ─────────────────────────────────────────────────────────────
// 비용테이블 시트 파서
// ─────────────────────────────────────────────────────────────

function parseCostTable(aoa: unknown[][]): CostTableConstants {
  // 이 시트는 섹션이 여러 개라 전체 훑어서 패턴 매칭:
  //   - "봉투비" 라벨 다음 셀 = bagFee
  //   - "수수료율" 라벨 다음 셀 = defaultFeeRate
  //   - "그로스 1kg" 섹션 헤더 다음에 [가격대, 배송비, 입출고비] 테이블
  //   - "그로스 2kg" 섹션 헤더 다음에 [가격대, 2kg단가, 입출고비] 테이블
  //   - "윙 박스·택배" 섹션 헤더 다음에 [분류, 최소kg, 최대kg, 박스, 택배] 테이블
  //   - "그로스 창고 입고비" 섹션에 [제조사, 단위, ..., 봉당합계] 테이블
  //
  // 결과 없으면 기본값 fallback.

  const result: CostTableConstants = {
    bagFee: 150,
    defaultFeeRate: 0.07,
    gross1kgTable: {},
    gross2kgShipTable: {},
    wingBoxShipTable: {
      small: { minKg: 1, maxKg: 3, box: 371, ship: 2100 },
      mid:   { minKg: 4, maxKg: 10, box: 1123, ship: 2800 },
      large: { minKg: 11, maxKg: 20, box: 1300, ship: 4000 },
    },
    warehouseFee: {},
  }

  let section: '' | 'gross1kg' | 'gross2kg' | 'wing' | 'warehouse' = ''

  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const a = toStr(row[0])
    const b = row[1]

    // 공통 상수
    if (a.includes('봉투비') && typeof b === 'number') {
      result.bagFee = b
      continue
    }
    if (a.includes('수수료율') && typeof b === 'number') {
      result.defaultFeeRate = b
      continue
    }

    // 섹션 전환 — 섹션 헤더는 보통 이모지(📦🚚🏭)로 시작
    // 메모성 행("💡 ... 윙 박스·택배 참조 ...")이 다시 wing으로 빠지지 않도록 정확한 패턴 매칭
    if (/^📦.*그로스.*1kg/.test(a)) { section = 'gross1kg'; continue }
    if (/^📦.*그로스.*2kg/.test(a)) { section = 'gross2kg'; continue }
    if (/^🚚.*윙.*박스/.test(a)) { section = 'wing'; continue }
    if (/^🏭.*창고.*입고/.test(a)) { section = 'warehouse'; continue }

    // 테이블 행 파싱
    if (section === 'gross1kg') {
      const priceBand = toStr(row[0])
      const ship = toNum(row[1])
      const inout = toNum(row[2])
      if (/^\d+$/.test(priceBand) && Number.isFinite(ship) && Number.isFinite(inout)) {
        result.gross1kgTable[priceBand] = { ship, inout }
      }
    } else if (section === 'gross2kg') {
      const priceBand = toStr(row[0])
      const ship2kg = toNum(row[1])
      // 입출고비는 gross1kgTable과 공유되므로 여기선 배송만 저장
      if (/^\d+$/.test(priceBand) && Number.isFinite(ship2kg)) {
        result.gross2kgShipTable[priceBand] = ship2kg
      }
    } else if (section === 'wing') {
      const cat = a
      const minKg = toNum(row[1])
      const maxKg = toNum(row[2])
      const box = toNum(row[3])
      const ship = toNum(row[4])
      if (Number.isFinite(minKg) && Number.isFinite(maxKg) && Number.isFinite(box) && Number.isFinite(ship)) {
        const bracket = { minKg, maxKg, box, ship }
        if (cat === '소') result.wingBoxShipTable.small = bracket
        else if (cat === '중') result.wingBoxShipTable.mid = bracket
        else if (cat === '대') result.wingBoxShipTable.large = bracket
      }
    } else if (section === 'warehouse') {
      // 헤더: 제조사 · 단위 · 1파렛봉수 · 운송비(봉당) · 박스비(봉당·수식) · 봉당합계
      // 이 섹션에는 "곰표 1파렛 박스비" 같은 메타 행도 섞여 있음 → 엄격히 6컬럼 모두 있는 행만 처리
      const maker = a
      const unit = toStr(row[1])
      const total = toNum(row[5])
      // 유효 데이터 조건: 제조사(a) · 단위(kg/g/ml 포함) · 봉당합계(숫자) 모두 있어야 함
      // 또한 첫 글자가 제조사 이름 (곰표/진도팜/녹색원 등) — 빈칸/이모지/공백 시작 제외
      const isValidMaker = maker.length > 0 && !maker.startsWith(' ')
        && !maker.includes('파렛') && !maker.includes('박스수')
        && !maker.includes('대박스') && !maker.includes('중박스')
        && maker !== '제조사'
      const isValidUnit = /^\d+(\.\d+)?\s*(kg|g|ml)$/i.test(unit)
      if (isValidMaker && isValidUnit && Number.isFinite(total)) {
        result.warehouseFee[`${maker}|${unit}`] = total
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────────────────────
// 메인 파서
// ─────────────────────────────────────────────────────────────

export function parseMarginMaster(buffer: ArrayBuffer): MarginMasterParseResult {
  const warnings: string[] = []
  let wb
  try {
    wb = XLSX.read(buffer, { type: 'array', cellFormula: false })
  } catch (e) {
    return {
      master: null,
      error: `엑셀을 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`,
      warnings: [],
      stats: { costBookRows: 0, marginRows: 0, hasConstants: false },
    }
  }

  const findSheet = (keywords: string[]): unknown[][] | null => {
    for (const name of wb.SheetNames) {
      if (keywords.some((k) => name.includes(k))) {
        return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
          header: 1, blankrows: false,
        })
      }
    }
    return null
  }

  // 1) 원가표
  const costSheet = findSheet(['원가표'])
  if (!costSheet) {
    return {
      master: null,
      error: '원가표 시트를 찾지 못했습니다',
      warnings,
      stats: { costBookRows: 0, marginRows: 0, hasConstants: false },
    }
  }
  const costBookResult = parseCostBook(costSheet)
  if (costBookResult.error) {
    return {
      master: null,
      error: costBookResult.error,
      warnings,
      stats: { costBookRows: 0, marginRows: 0, hasConstants: false },
    }
  }

  // 2) 마진계산
  const marginSheet = findSheet(['마진계산', '마진 계산'])
  if (!marginSheet) {
    return {
      master: null,
      error: '마진계산 시트를 찾지 못했습니다',
      warnings,
      stats: { costBookRows: costBookResult.rows.length, marginRows: 0, hasConstants: false },
    }
  }
  const marginResult = parseMarginRows(marginSheet)
  if (marginResult.error) {
    return {
      master: null,
      error: marginResult.error,
      warnings,
      stats: { costBookRows: costBookResult.rows.length, marginRows: 0, hasConstants: false },
    }
  }

  // 3) 비용테이블 (없으면 기본값 사용)
  const costTableSheet = findSheet(['비용테이블', '비용 테이블'])
  let constants: CostTableConstants
  if (costTableSheet) {
    constants = parseCostTable(costTableSheet)
  } else {
    warnings.push('비용테이블 시트를 찾지 못해 기본값을 사용합니다')
    constants = parseCostTable([]) // 빈 배열 → 기본값만
  }

  return {
    master: {
      costBook: costBookResult.rows,
      marginRows: marginResult.rows,
      constants,
    },
    warnings,
    stats: {
      costBookRows: costBookResult.rows.length,
      marginRows: marginResult.rows.length,
      hasConstants: !!costTableSheet,
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 편의 헬퍼: 옵션ID → 실판매가 Map
// ─────────────────────────────────────────────────────────────

export function buildActualPriceMap(master: CostMaster): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of master.marginRows) {
    if (r.actualPrice > 0) map.set(r.optionId, r.actualPrice)
  }
  return map
}

/** 옵션ID → 검증용 순이익/마진율/BEP 저장. UI에서 엑셀 계산값과 일치 확인용 */
export function buildMarginLookupMap(master: CostMaster): Map<string, MarginCalcRow> {
  const map = new Map<string, MarginCalcRow>()
  for (const r of master.marginRows) {
    map.set(r.optionId, r)
  }
  return map
}

/** 노출ID → 원가표 상품 */
export function buildCostBookMap(master: CostMaster): Map<string, CostBookRow> {
  const map = new Map<string, CostBookRow>()
  for (const r of master.costBook) {
    map.set(r.exposureId, r)
  }
  return map
}
