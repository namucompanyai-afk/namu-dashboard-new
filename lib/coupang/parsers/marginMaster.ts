import * as XLSX from 'xlsx'

/**
 * 마진마스터.xlsx 파서 (v3 — 2026-05 분리 구조 + X 포장비 신설)
 *
 * 새 엑셀 구조 (5시트, "비용테이블_옛"은 무시):
 *   1) 원가표 (헤더 R3, 데이터 R4~)
 *      A 노출ID  B 쿠팡원본명  C 별칭  D 채널  E 옵션수  F 옵션샘플
 *      G 기준용량(텍스트)  H 원곡가  I 윙작업비  J 그로스작업비  K 혼합비
 *      L 제조사  M 과세구분  N 봉투비여부  O 메모
 *      P 윙원가(자동)  Q 그로스원가(자동)  R 수수료율  S 기준kg(자동)
 *      T 별칭+kg키(자동, 네이버 매칭용 보조)
 *
 *   2) 비용테이블
 *      B2 = 봉투비 150
 *      A8:D14 = 가격대 × (0.8kg/1kg/2kg) 봉당 입출고비
 *      A23:E30 = 가격대 × (극소/소/중/대형1) 그로스 배송비
 *      A35:E37 = 윙/네이버A 공통 박스/택배 (소/중/대)
 *      A41:E44 = 창고 입고비 (제조사|단위 → 봉당 합계)
 *      A57:D63 = 위킵 즉석밥 단가표 (참고용, 마진계산_네이버 수기 입력)
 *
 *   3) 마진계산_쿠팡 (윙+그로스, 339행) — 본 파서가 사용
 *      마진계산_네이버 (네이버A, 77행) — 별칭+kg키 매칭/수기 위킵, 현 파서 미사용
 *      공통 헤더 (R4, 데이터 R5~):
 *        A 노출ID  B 옵션ID  C 별칭  D 옵션명  E 총kg
 *        F 봉투수  G 1봉kg  H 정가(VAT)  I 실판매가  J 개당가(VAT)
 *        K 가격대  L 자동채널  M 수동지정  N 최종채널
 *        O 규격  P 원가  Q 봉투  R 박스  S 택배  T 창고입고비
 *        U 그로스배송  V 입출고  W 수수료율  X 포장비(신설)  Y 수수료
 *        Z 총비용  AA 순이익  AB 마진율  AC BEP ROAS
 *        AD 별칭+kg키(자동, 네이버 시트만)
 *
 * 자동 수식 셀(P~AC): SheetJS 캐시값(.v) 우선, 비어있으면 NaN/null.
 * 가격대 라벨(K)은 "9,900"/"10,900"/.../"19,900" 텍스트 그대로 사용.
 * 노출ID/옵션ID 모두 string 으로 통일.
 */

function normHeader(s: string): string {
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
// 타입
// ─────────────────────────────────────────────────────────────

export interface CostBookRow {
  exposureId: string
  productName: string
  alias: string
  channel: string  // "단일"/"둘다"/"그로스"/"윙"
  optionCount: number
  optionSample: string
  baseVolume: string  // "1kg"/"800g"/"100g"/"300ml" 등
  /** 원곡가 (1봉당, VAT 포함) */
  rawCost: number
  /** 윙 작업비 */
  wingWorkFee: number
  /** 그로스 작업비 */
  growthWorkFee: number
  /** 혼합비 */
  mixFee: number
  manufacturer: string
  taxType: '과세' | '면세'
  needsBag: 'Y' | 'N'
  memo?: string
  /** 자동: 윙 원가 = H+I+K */
  wingCost: number
  /** 자동: 그로스 원가 = H+J+K */
  growthCost: number
  /** 옵션별 수수료율 (수기, 0.0638 등) */
  feeRate: number
  /** 자동: 기준 kg 숫자 */
  baseKg: number
}

export interface MarginCalcRow {
  exposureId: string
  optionId: string
  alias: string
  optionName: string
  totalKg: number
  bagCount: number   // F 봉수
  kgPerBag: number   // G 1봉kg
  listPrice: number  // H 정가(VAT)
  actualPrice: number  // I 실판매가
  perUnitPrice: number  // J 개당가
  /** K 가격대 라벨 ("9,900" 등) */
  priceBand: string
  /** L 자동채널 */
  autoChannel: string
  /** M 수동지정 */
  manualChannel: string
  /** N 최종채널 ("윙"/"그로스") */
  channel: string
  /** O 규격 ("극소"/"소"/"중"/"대형1"/"") */
  size: string
  // 비용 분해 (P~Y) — 모두 자동 수식 결과
  costPrice: number       // P 원가
  bagFee: number          // Q 봉투
  boxFee: number          // R 박스
  shipFee: number         // S 택배
  warehouseFee: number    // T 창고입고비
  grossShipFee: number    // U 그로스배송
  inoutFee: number        // V 입출고
  feeRate: number         // W 수수료율
  /** X 포장비(VAT) — 위킵 즉석밥 등 수기 입력 (옛 엑셀엔 없음, optional) */
  packagingFee?: number
  coupangFee: number      // Y 수수료 (옛 X)
  // 결과 (Z~AC)
  totalCost: number       // Z 총비용 (옛 Y)
  netProfit: number | null  // AA 순이익 (옛 Z)
  marginRate: number | null  // AB 마진율 (옛 AA)
  bepRoas: number | null     // AC BEP ROAS (옛 AB)
}

/** 윙 박스/택배 분류 */
export interface WingBracket {
  minKg: number
  maxKg: number
  box: number
  ship: number
}

export interface CostTableConstants {
  /** 봉투비 (봉당) */
  bagFee: number
  /** 옵션별 수수료율 없을 때 fallback */
  defaultFeeRate: number

  // ── 신규 매트릭스 ──
  /** 입출고비: priceBandLabel("9,900") → { "0.8": n, "1": n, "2": n } */
  inoutTable: Record<string, Record<'0.8' | '1' | '2', number>>
  /** 그로스 배송비: priceBandLabel → { 극소, 소, 중, 대형1 } */
  grossShipTable: Record<string, Record<'극소' | '소' | '중' | '대형1', number>>
  /** 윙 박스/택배 분류 */
  wingBoxShipTable: {
    small: WingBracket
    mid: WingBracket
    large: WingBracket
  }
  /** 창고 입고비: '제조사|단위' → 봉당 합계 */
  warehouseFee: Record<string, number>

  // ── 옛 코드(margin.ts) 호환용 derived 필드 ──
  /** @deprecated 신규 코드는 inoutTable + grossShipTable 사용 */
  gross1kgTable: Record<string, { ship: number; inout: number }>
  /** @deprecated */
  gross2kgShipTable: Record<string, number>
}

export interface CostMaster {
  costBook: CostBookRow[]
  marginRows: MarginCalcRow[]
  constants: CostTableConstants
}

export interface MarginMasterParseResult {
  master: CostMaster | null
  error?: string
  warnings: string[]
  stats: {
    costBookRows: number
    marginRows: number
    hasConstants: boolean
  }
}

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

function findHeaderRow(aoa: unknown[][], requiredKeys: string[], minHits = 2): number {
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const normed = row.map((c) => normHeader(toStr(c)))
    const hitCount = requiredKeys.filter((k) => normed.includes(k)).length
    if (hitCount >= minHits) return i
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

function parseBaseKg(v: string): number {
  const s = String(v).trim().toLowerCase()
  // "2kg" → 2, "800g" → 0.8, "300ml" → 0.3
  const kgMatch = s.match(/^([\d.]+)\s*kg$/)
  if (kgMatch) return Number(kgMatch[1])
  const gMatch = s.match(/^([\d.]+)\s*g$/)
  if (gMatch) return Number(gMatch[1]) / 1000
  const mlMatch = s.match(/^([\d.]+)\s*ml$/)
  if (mlMatch) return Number(mlMatch[1]) / 1000
  return 1  // fallback
}

// ─────────────────────────────────────────────────────────────
// 원가표 파서
// ─────────────────────────────────────────────────────────────

const COST_BOOK_ALIASES = {
  exposureId:    ['노출id', '노출상품id'],
  productName:   ['쿠팡원본상품명', '상품명'],
  alias:         ['내별칭', '별칭'],
  channel:       ['채널'],
  optionCount:   ['옵션수'],
  optionSample:  ['옵션샘플'],
  baseVolume:    ['기준용량'],
  rawCost:       ['원곡가', '원재료가'],
  wingWorkFee:   ['윙작업비'],
  growthWorkFee: ['그로스작업비'],
  mixFee:        ['혼합비'],
  manufacturer:  ['제조사'],
  taxType:       ['과세구분'],
  needsBag:      ['봉투비여부'],
  memo:          ['메모'],
  wingCost:      ['윙원가자동', '윙원가'],
  growthCost:    ['그로스원가자동', '그로스원가'],
  feeRate:       ['수수료율수기', '수수료율'],
  baseKg:        ['기준kg자동', '기준kg'],
} as const
type CostBookKey = keyof typeof COST_BOOK_ALIASES

function parseCostBook(aoa: unknown[][]): { rows: CostBookRow[]; error?: string } {
  const headerIdx = findHeaderRow(aoa, ['노출id', '내별칭', '원곡가'])
  if (headerIdx === -1) {
    return { rows: [], error: '원가표 헤더 행을 찾지 못했습니다 (노출ID + 내별칭 + 원곡가 필요)' }
  }
  const headers = (aoa[headerIdx] as unknown[]).map(toStr)
  const { cols, missing } = resolveColumns<CostBookKey>(headers, COST_BOOK_ALIASES, [
    'exposureId', 'alias', 'baseVolume', 'rawCost', 'manufacturer',
  ])
  if (missing.length > 0) {
    return { rows: [], error: `원가표 필수 컬럼 누락: ${missing.join(', ')}` }
  }

  const rows: CostBookRow[] = []
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const exp = toStr(r[cols.exposureId])
    if (!exp || !/^\d+$/.test(exp)) continue
    const alias = toStr(r[cols.alias])
    if (!alias) continue
    const rawCost = toNum(r[cols.rawCost])
    const manufacturer = toStr(r[cols.manufacturer])
    if (!Number.isFinite(rawCost) || !manufacturer) continue

    const baseVolume = toStr(r[cols.baseVolume]) || '1kg'
    const taxTypeStr = toStr(r[cols.taxType])
    const needsBagStr = toStr(r[cols.needsBag])
    const wingFee = toNum(r[cols.wingWorkFee]) || 0
    const growthFee = toNum(r[cols.growthWorkFee]) || 0
    const mixFee = toNum(r[cols.mixFee]) || 0

    // 자동 P/Q 가 비어있으면 H+I+K / H+J+K 로 계산
    const wingCostCached = cols.wingCost !== -1 ? toNum(r[cols.wingCost]) : NaN
    const growthCostCached = cols.growthCost !== -1 ? toNum(r[cols.growthCost]) : NaN
    const wingCost = Number.isFinite(wingCostCached) ? wingCostCached : rawCost + wingFee + mixFee
    const growthCost = Number.isFinite(growthCostCached) ? growthCostCached : rawCost + growthFee + mixFee

    // S 기준kg 자동 — 비어있으면 baseVolume 파싱
    const baseKgCached = cols.baseKg !== -1 ? toNum(r[cols.baseKg]) : NaN
    const baseKg = Number.isFinite(baseKgCached) ? baseKgCached : parseBaseKg(baseVolume)

    const feeRateCached = cols.feeRate !== -1 ? toNum(r[cols.feeRate]) : NaN
    const feeRate = Number.isFinite(feeRateCached) && feeRateCached > 0 ? feeRateCached : 0.0638

    rows.push({
      exposureId: exp,
      productName: toStr(r[cols.productName]),
      alias,
      channel: toStr(r[cols.channel]) || '단일',
      optionCount: toNum(r[cols.optionCount]) || 0,
      optionSample: toStr(r[cols.optionSample]),
      baseVolume,
      rawCost,
      wingWorkFee: wingFee,
      growthWorkFee: growthFee,
      mixFee,
      manufacturer,
      taxType: (taxTypeStr === '과세' ? '과세' : '면세') as '과세' | '면세',
      needsBag: (needsBagStr === 'N' ? 'N' : 'Y') as 'Y' | 'N',
      memo: cols.memo !== -1 ? toStr(r[cols.memo]) || undefined : undefined,
      wingCost,
      growthCost,
      feeRate,
      baseKg,
    })
  }
  return { rows }
}

// ─────────────────────────────────────────────────────────────
// 마진계산 파서
// ─────────────────────────────────────────────────────────────

const MARGIN_ROW_ALIASES = {
  exposureId:    ['노출id'],
  optionId:      ['옵션id'],
  alias:         ['별칭'],
  optionName:    ['옵션명'],
  totalKg:       ['총kg'],
  bagCount:      ['봉투수'],
  kgPerBag:      ['1봉kg'],
  listPrice:     ['정가vat', '정가'],
  actualPrice:   ['실판매가'],
  perUnitPrice:  ['개당가vat', '개당가'],
  priceBand:     ['가격대'],
  autoChannel:   ['자동채널'],
  manualChannel: ['수동지정'],
  channel:       ['최종채널'],
  size:          ['규격수기', '규격'],
  costPrice:     ['원가vat', '원가'],
  bagFeeCol:     ['봉투vat', '봉투'],
  boxFee:        ['박스vat', '박스'],
  shipFee:       ['택배vat', '택배'],
  warehouseFee:  ['창고입고비vat', '창고입고비'],
  grossShipFee:  ['그로스배송vat', '그로스배송'],
  inoutFee:      ['입출고vat', '입출고'],
  feeRate:       ['수수료율'],
  packagingFee:  ['포장비vat', '포장비'],
  coupangFee:    ['수수료vat', '수수료'],
  totalCost:     ['총비용vat', '총비용'],
  netProfit:     ['순이익vat', '순이익'],
  marginRate:    ['마진율'],
  bepRoas:       ['beproas'],
} as const
type MarginRowKey = keyof typeof MARGIN_ROW_ALIASES

function parseMarginRows(aoa: unknown[][]): { rows: MarginCalcRow[]; error?: string } {
  const headerIdx = findHeaderRow(aoa, ['옵션id', '실판매가', '최종채널'])
  if (headerIdx === -1) {
    return { rows: [], error: '마진계산 헤더 행을 찾지 못했습니다' }
  }
  const headers = (aoa[headerIdx] as unknown[]).map(toStr)
  const { cols, missing } = resolveColumns<MarginRowKey>(headers, MARGIN_ROW_ALIASES, [
    'exposureId', 'optionId', 'actualPrice',
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

    const num = (key: MarginRowKey) => cols[key] !== -1 ? toNum(r[cols[key]]) : NaN
    const str = (key: MarginRowKey) => cols[key] !== -1 ? toStr(r[cols[key]]) : ''

    const netProfit = num('netProfit')
    const marginRate = num('marginRate')
    const bepRoas = num('bepRoas')

    rows.push({
      exposureId: toStr(r[cols.exposureId]),
      optionId: optId,
      alias: str('alias'),
      optionName: str('optionName'),
      totalKg: num('totalKg') || 0,
      bagCount: num('bagCount') || 1,
      kgPerBag: num('kgPerBag') || 1,
      listPrice: num('listPrice') || actualPrice,
      actualPrice,
      perUnitPrice: num('perUnitPrice') || actualPrice,
      priceBand: str('priceBand'),  // 텍스트 그대로
      autoChannel: str('autoChannel'),
      manualChannel: str('manualChannel'),
      channel: str('channel'),
      size: str('size'),
      costPrice: num('costPrice') || 0,
      bagFee: num('bagFeeCol') || 0,
      boxFee: num('boxFee') || 0,
      shipFee: num('shipFee') || 0,
      warehouseFee: num('warehouseFee') || 0,
      grossShipFee: num('grossShipFee') || 0,
      inoutFee: num('inoutFee') || 0,
      feeRate: num('feeRate') || 0,
      packagingFee: num('packagingFee') || 0,
      coupangFee: num('coupangFee') || 0,
      totalCost: num('totalCost') || 0,
      netProfit: Number.isFinite(netProfit) ? netProfit : null,
      marginRate: Number.isFinite(marginRate) ? marginRate : null,
      bepRoas: Number.isFinite(bepRoas) ? bepRoas : null,
    })
  }
  return { rows }
}

// ─────────────────────────────────────────────────────────────
// 비용테이블 파서 (신규 구조)
// ─────────────────────────────────────────────────────────────

function parseCostTable(aoa: unknown[][]): CostTableConstants {
  const result: CostTableConstants = {
    bagFee: 150,
    defaultFeeRate: 0.0638,
    inoutTable: {},
    grossShipTable: {},
    wingBoxShipTable: {
      small: { minKg: 1, maxKg: 3, box: 371, ship: 2100 },
      mid:   { minKg: 4, maxKg: 10, box: 1123, ship: 2800 },
      large: { minKg: 11, maxKg: 20, box: 1300, ship: 4400 },
    },
    warehouseFee: {},
    gross1kgTable: {},
    gross2kgShipTable: {},
  }

  // 섹션 추적: 헤더 행 패턴으로 판별 (이모지 의존 X — 컬럼 헤더 자체로 검출)
  let section: '' | 'inout' | 'gross-ship' | 'wing' | 'warehouse' = ''

  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const a = toStr(row[0])
    const b = row[1]

    // 봉투비
    if (a.includes('봉투비') && typeof b === 'number') {
      result.bagFee = b
      continue
    }

    // 헤더 행 패턴으로 섹션 결정
    const c = toStr(row[2])
    const d = toStr(row[3])
    const e = toStr(row[4])

    // 입출고 헤더: A=가격대 + B=0.8kg 봉당~ + C=1kg 봉당~ + D=2kg 봉당~
    if (a === '가격대' && b && String(b).includes('0.8kg') && c.includes('1kg') && d.includes('2kg')) {
      section = 'inout'
      continue
    }
    // 그로스 배송 헤더: A=가격대 + B=극소 + C=소 + D=중 + E=대형1
    if (a === '가격대' && b === '극소' && c === '소' && d === '중' && e.startsWith('대형')) {
      section = 'gross-ship'
      continue
    }
    // 윙 헤더: A=분류 + B=최소kg + C=최대kg + D=박스 + E=택배
    if (a === '분류' && b === '최소kg' && c === '최대kg') {
      section = 'wing'
      continue
    }
    // 창고 헤더: A=제조사 + B=단위 + ... + E=봉당 합계
    if (a === '제조사' && b === '단위' && e.includes('합계')) {
      section = 'warehouse'
      continue
    }

    // 데이터 행 파싱
    if (section === 'inout') {
      // A=가격대 라벨("9,900" 등 텍스트), B/C/D=0.8/1/2kg 입출고비
      const band = a
      if (!band || !/^[\d,]+(\~[\d,]+)?$/.test(band)) {
        // 가격대 라벨 아님 → 섹션 종료
        if (band) section = ''
        continue
      }
      const v08 = toNum(row[1])
      const v1 = toNum(row[2])
      const v2 = toNum(row[3])
      if (Number.isFinite(v08) && Number.isFinite(v1) && Number.isFinite(v2)) {
        result.inoutTable[band] = { '0.8': v08, '1': v1, '2': v2 }
        // 옛 호환: gross1kgTable 의 inout, gross2kgShipTable
        result.gross1kgTable[band] = { ship: 0, inout: v1 }
      }
    } else if (section === 'gross-ship') {
      const band = a
      if (!band || !/^[\d,]+(\~[\d,]+)?$/.test(band)) {
        if (band) section = ''
        continue
      }
      const sX = toNum(row[1])  // 극소
      const sS = toNum(row[2])  // 소
      const sM = toNum(row[3])  // 중
      const sL = toNum(row[4])  // 대형1
      if ([sX, sS, sM, sL].every(Number.isFinite)) {
        result.grossShipTable[band] = { '극소': sX, '소': sS, '중': sM, '대형1': sL }
        // 옛 호환: gross1kgTable 의 ship 은 "소" 로 설정 (1kg 기본 가정)
        if (result.gross1kgTable[band]) {
          result.gross1kgTable[band].ship = sS
        } else {
          result.gross1kgTable[band] = { ship: sS, inout: 0 }
        }
        result.gross2kgShipTable[band] = sS
      }
    } else if (section === 'wing') {
      // 분류: 소/중/대
      const cat = a
      const minKg = toNum(row[1])
      const maxKg = toNum(row[2])
      const box = toNum(row[3])
      const ship = toNum(row[4])
      if ([minKg, maxKg, box, ship].every(Number.isFinite)) {
        const bracket: WingBracket = { minKg, maxKg, box, ship }
        if (cat === '소') result.wingBoxShipTable.small = bracket
        else if (cat === '중') result.wingBoxShipTable.mid = bracket
        else if (cat === '대') result.wingBoxShipTable.large = bracket
        else section = ''  // 분류 외 = 섹션 종료
      }
    } else if (section === 'warehouse') {
      // 제조사 / 단위 / 봉당 운송비 / 봉당 박스비 / 봉당 합계
      const maker = a
      const unit = toStr(row[1])
      const total = toNum(row[4])  // E = 봉당 합계
      if (!maker || !unit || !Number.isFinite(total)) continue
      // 단위는 "1kg"/"2kg" 같은 형태
      if (!/^[\d.]+\s*(kg|g|ml)$/i.test(unit)) {
        if (maker) section = ''  // 헤더 외 row → 섹션 종료
        continue
      }
      result.warehouseFee[`${maker}|${unit}`] = total
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
      // 정확 매칭 우선 (예: '비용테이블' 이 '비용테이블_옛' 매칭 안 되도록)
      if (keywords.includes(name)) {
        return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
          header: 1, blankrows: false,
        })
      }
    }
    for (const name of wb.SheetNames) {
      if (keywords.some((k) => name === k || (name.includes(k) && !name.includes('_옛')))) {
        return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
          header: 1, blankrows: false,
        })
      }
    }
    return null
  }

  const costSheet = findSheet(['원가표'])
  if (!costSheet) {
    return {
      master: null, error: '원가표 시트를 찾지 못했습니다',
      warnings, stats: { costBookRows: 0, marginRows: 0, hasConstants: false },
    }
  }
  const costBookResult = parseCostBook(costSheet)
  if (costBookResult.error) {
    return {
      master: null, error: costBookResult.error,
      warnings, stats: { costBookRows: 0, marginRows: 0, hasConstants: false },
    }
  }

  // 새 구조('마진계산_쿠팡' 우선, 신규 분리 시트) → 옛 단일 '마진계산' 폴백
  const marginSheet = findSheet(['마진계산_쿠팡', '마진계산', '마진 계산'])
  if (!marginSheet) {
    return {
      master: null, error: '마진계산 시트를 찾지 못했습니다',
      warnings, stats: { costBookRows: costBookResult.rows.length, marginRows: 0, hasConstants: false },
    }
  }
  const marginResult = parseMarginRows(marginSheet)
  if (marginResult.error) {
    return {
      master: null, error: marginResult.error,
      warnings, stats: { costBookRows: costBookResult.rows.length, marginRows: 0, hasConstants: false },
    }
  }

  const costTableSheet = findSheet(['비용테이블', '비용 테이블'])
  let constants: CostTableConstants
  if (costTableSheet) {
    constants = parseCostTable(costTableSheet)
  } else {
    warnings.push('비용테이블 시트를 찾지 못해 기본값을 사용합니다')
    constants = parseCostTable([])
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
// 편의 helpers
// ─────────────────────────────────────────────────────────────

export function buildActualPriceMap(master: CostMaster): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of master.marginRows) {
    if (r.actualPrice > 0) map.set(r.optionId, r.actualPrice)
  }
  return map
}

export function buildMarginLookupMap(master: CostMaster): Map<string, MarginCalcRow> {
  const map = new Map<string, MarginCalcRow>()
  for (const r of master.marginRows) map.set(r.optionId, r)
  return map
}

export function buildCostBookMap(master: CostMaster): Map<string, CostBookRow> {
  const map = new Map<string, CostBookRow>()
  for (const r of master.costBook) map.set(r.exposureId, r)
  return map
}
