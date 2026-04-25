import type {
  CoupangOption,
  OptionMetrics,
  ProductGroupMetrics,
} from '@/types/coupang'
import {
  getCostBook,
  getActualPrice,
  getNetProfit,
  getMarginRow,
  getCostConstants,
  getPriceBand,
  getWingBracket,
  getWarehouseFee,
  VOLUME_TO_KG,
  hasCostMaster,
} from './costBook'
import type { CostBookRow } from './parsers/marginMaster'

/**
 * 마진 계산 로직
 *
 * ──────────────────────────────────────────────────────────────
 * 두 가지 계산 모드 (enrichOption에서 자동 선택):
 *
 * 모드 A · costBook 기반 자동 계산 (우선)
 *   - 조건: 옵션의 productId(노출상품ID)가 마진 마스터 엑셀에 등록
 *   - 가격 우선순위:
 *       (1) 마진계산 시트의 실판매가 (있으면 무조건 우선) ← 핵심
 *       (2) option.sellingPrice (price_inventory 판매가, fallback)
 *   - 공식: 마진분석.xlsx와 동일
 *     - 원가 = (원곡가 + 작업비(윙/그로스) + 혼합비) × (1봉kg / 기준kg) × 봉투수
 *     - 봉투비 = 봉투수 × 150 (needsBag='N'이면 0)
 *     - 윙 박스·택배 = 총kg 구간별 고정가
 *     - 그로스 배송·입출고 = 가격대(CEILING) × 1kg/2kg 구분 × 봉투수
 *     - 그로스 창고입고비 = 제조사|기준용량 봉당 단가 × 봉투수
 *     - 수수료 = 실판매가 × 7%
 *     - 순이익 = (과세면 실판매가×10/11, 면세면 실판매가) - 총비용
 *
 * 모드 B · 사용자 수동 입력 (fallback)
 *   - costBook 매칭 실패 또는 마스터 미로드 시
 *   - 사용자가 costPrice를 직접 입력 → 기존 calculateMargin 공식
 *
 * ──────────────────────────────────────────────────────────────
 * 검증: 마진분석.xlsx 308개 옵션 모두 calcMarginFromBook과 일치 (오차 0원)
 *
 * 추가 모드 C · 엑셀 직접 참조 (가장 정확)
 *   - getNetProfitFromExcel(optionId): 마진계산 시트의 Y열 값을 그대로 반환
 *   - 엑셀 수식이 한 번이라도 계산된 적 있어야 함 (Excel/LibreOffice로 열어 저장)
 *   - enrichOption은 모드 A의 결과를 사용 (코드 검증 가능 / 엑셀 캐시 의존 안 함)
 */

export const DEFAULT_COUPANG_FEE_RATE = 0.07

// ─────────────────────────────────────────────────────────────
// 모드 B · 기존 공식 (사용자 수동 입력용)
// ─────────────────────────────────────────────────────────────

export interface MarginCalcInput {
  sellingPrice: number
  costPrice: number | null
  coupangFeeRate?: number
  warehousingFee?: number | null
  shippingFee?: number | null
}

export interface MarginCalcResult {
  coupangFee: number
  netMargin: number | null
  marginRate: number | null
  bepRoas: number | null
}

export function calculateMargin(input: MarginCalcInput): MarginCalcResult {
  const {
    sellingPrice,
    costPrice,
    coupangFeeRate = DEFAULT_COUPANG_FEE_RATE,
    warehousingFee = 0,
    shippingFee = 0,
  } = input

  const coupangFee = Math.round(sellingPrice * coupangFeeRate)

  if (costPrice == null) {
    return { coupangFee, netMargin: null, marginRate: null, bepRoas: null }
  }

  const logistics = (warehousingFee ?? 0) + (shippingFee ?? 0)
  const netMargin = sellingPrice - costPrice - coupangFee - logistics
  const marginRate = sellingPrice > 0 ? (netMargin / sellingPrice) * 100 : null
  const bepRoas = netMargin > 0 ? (sellingPrice / netMargin) * 100 : null

  return { coupangFee, netMargin, marginRate, bepRoas }
}

// ─────────────────────────────────────────────────────────────
// 모드 A · costBook 기반 자동 계산
// ─────────────────────────────────────────────────────────────

export interface CostBookCalcInput {
  productId: string
  optionName: string
  /** 가격: 실판매가 우선, 없으면 이 값 사용 */
  sellingPrice: number
  channel: 'growth' | 'wing'
  /** 옵션ID (실판매가 조회용) — 있으면 우선 사용 */
  optionId?: string
}

export interface CostBookCalcResult {
  ok: boolean
  reason?: 'exposure_id_not_in_book' | 'option_name_unparseable' | 'out_of_weight_range' | 'no_cost_master'
  /** 실제 사용된 가격 (실판매가 또는 fallback) */
  effectivePrice?: number
  /** 실판매가가 적용됐는지 */
  usedActualPrice?: boolean
  costPrice?: number
  bagFee?: number
  boxFee?: number
  deliveryFee?: number
  warehousingFee?: number
  growthShipFee?: number
  growthInOutFee?: number
  coupangFee?: number
  totalCost?: number
  netMargin?: number
  marginRate?: number
  bepRoas?: number | null
  matchedItem?: CostBookRow
  parsed?: { bagCount: number; kgPerBag: number; totalKg: number }
}

/**
 * 옵션명 파서 (이전 버전 그대로).
 * 여러 포맷 지원:
 *   "1개 1kg", "2개 1kg", "500g 2개", "3kg 1개", "1kg 3kg 3개"
 */
export function parseOptionName(
  optionName: string,
  baseVolumeHint?: string,
): { bagCount: number; kgPerBag: number; totalKg: number } | null {
  if (!optionName) return null

  // 패턴 A: "N개 Xkg/g/ml"
  let m = optionName.match(/(\d+)\s*개\s*([\d.]+)\s*(kg|g|ml)\b/i)
  if (m) {
    const bagCount = parseInt(m[1], 10)
    let val = parseFloat(m[2])
    const unit = m[3].toLowerCase()
    if (unit === 'g' || unit === 'ml') val = val / 1000
    return { bagCount, kgPerBag: val, totalKg: bagCount * val }
  }

  // 패턴 B: "Xkg/g/ml N개"
  m = optionName.match(/([\d.]+)\s*(kg|g|ml)\s*(\d+)\s*개\b/i)
  if (m) {
    let val = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    if (unit === 'g' || unit === 'ml') val = val / 1000
    const bagCount = parseInt(m[3], 10)
    return { bagCount, kgPerBag: val, totalKg: bagCount * val }
  }

  // fallback: 용량 토큰 여러 개면 baseVolumeHint와 일치하는 것을 1봉으로 채택
  const volTokens: Array<{ raw: string; val: number }> = []
  const volRegex = /([\d.]+)\s*(kg|g|ml)/gi
  let match: RegExpExecArray | null
  while ((match = volRegex.exec(optionName)) !== null) {
    let v = parseFloat(match[1])
    const u = match[2].toLowerCase()
    if (u === 'g' || u === 'ml') v = v / 1000
    volTokens.push({ raw: match[0].replace(/\s+/g, '').toLowerCase(), val: v })
  }
  const countMatch = optionName.match(/(\d+)\s*개/)
  if (!volTokens.length || !countMatch) return null
  const bagCount = parseInt(countMatch[1], 10)

  let pickedVol = volTokens[0]
  if (baseVolumeHint) {
    const hint = baseVolumeHint.toLowerCase().replace(/\s+/g, '')
    pickedVol = volTokens.find((t) => t.raw === hint) ?? volTokens[0]
  }
  return { bagCount, kgPerBag: pickedVol.val, totalKg: bagCount * pickedVol.val }
}

/** 모드 A · costBook 기반 자동 계산 */
export function calcMarginFromBook(input: CostBookCalcInput): CostBookCalcResult {
  if (!hasCostMaster()) {
    return { ok: false, reason: 'no_cost_master' }
  }

  const item = getCostBook(input.productId)
  if (!item) return { ok: false, reason: 'exposure_id_not_in_book' }

  const parsed = parseOptionName(input.optionName, item.baseVolume)
  if (!parsed) return { ok: false, reason: 'option_name_unparseable', matchedItem: item }

  const { bagCount, kgPerBag, totalKg } = parsed
  const { channel, optionId } = input

  // ★ 가격 결정: 실판매가 우선
  let effectivePrice = input.sellingPrice
  let usedActualPrice = false
  if (optionId) {
    const actual = getActualPrice(optionId)
    if (actual != null && actual > 0) {
      effectivePrice = actual
      usedActualPrice = true
    }
  }

  const constants = getCostConstants()

  // 원가 = (원곡가 + 작업비(채널별) + 혼합비) × (1봉kg / 기준kg) × 봉투수
  const baseVolKg = VOLUME_TO_KG[item.baseVolume] ?? 1
  const workFee = channel === 'wing' ? item.wingWorkFee : item.growthWorkFee
  const costPrice = (item.rawCost + workFee + item.mixFee) * (kgPerBag / baseVolKg) * bagCount

  // 봉투비
  const bagFee = item.needsBag === 'N' ? 0 : bagCount * constants.bagFee

  // 윙 박스·택배
  let boxFee = 0
  let deliveryFee = 0
  if (channel === 'wing') {
    const bracket = getWingBracket(totalKg)
    boxFee = bracket.box
    deliveryFee = bracket.ship
  }

  // 그로스 창고 입고비
  let warehousingFee = 0
  if (channel === 'growth') {
    warehousingFee = getWarehouseFee(item.manufacturer, item.baseVolume) * bagCount
  }

  // 그로스 배송·입출고 (가격대 × 봉투수)
  let growthShipFee = 0
  let growthInOutFee = 0
  if (channel === 'growth') {
    const perUnit = effectivePrice / bagCount
    const band = String(getPriceBand(perUnit))
    if (item.baseVolume === '2kg') {
      growthShipFee = (constants.gross2kgShipTable[band] ?? 0) * bagCount
    } else {
      growthShipFee = (constants.gross1kgTable[band]?.ship ?? 0) * bagCount
    }
    // 입출고비는 1kg 테이블 공통
    growthInOutFee = (constants.gross1kgTable[band]?.inout ?? 0) * bagCount
  }

  // 쿠팡 수수료 (실판매가 기준)
  const coupangFee = effectivePrice * constants.defaultFeeRate

  // 총비용
  const totalCost =
    costPrice + bagFee + boxFee + deliveryFee + warehousingFee + growthShipFee + growthInOutFee + coupangFee

  // 과세 보정
  const netRevenue = item.taxType === '과세' ? (effectivePrice * 10) / 11 : effectivePrice
  const netMargin = netRevenue - totalCost

  const marginRate = effectivePrice > 0 ? (netMargin / effectivePrice) * 100 : 0
  const bepRoas = netMargin > 0 ? (effectivePrice / netMargin) * 100 : null

  return {
    ok: true,
    effectivePrice,
    usedActualPrice,
    costPrice: Math.round(costPrice),
    bagFee: Math.round(bagFee),
    boxFee: Math.round(boxFee),
    deliveryFee: Math.round(deliveryFee),
    warehousingFee: Math.round(warehousingFee),
    growthShipFee: Math.round(growthShipFee),
    growthInOutFee: Math.round(growthInOutFee),
    coupangFee: Math.round(coupangFee),
    totalCost: Math.round(totalCost),
    netMargin: Math.round(netMargin),
    marginRate,
    bepRoas,
    matchedItem: item,
    parsed,
  }
}

/**
 * 모드 C · 엑셀 직접 참조 (가장 정확).
 * 마진계산 시트의 Y열 (순이익) 값을 그대로 반환.
 * 엑셀 수식이 한 번이라도 계산된 적 있어야 동작.
 * (LibreOffice/Excel로 한 번 열어 저장하면 캐시 생김)
 */
export function getNetProfitFromExcel(optionId: string): number | null {
  return getNetProfit(optionId)
}

// ─────────────────────────────────────────────────────────────
// enrichOption — 통합 진입점
// ─────────────────────────────────────────────────────────────

export function enrichOption(option: CoupangOption): OptionMetrics {
  const book = calcMarginFromBook({
    productId: option.productId,
    optionName: option.optionName,
    sellingPrice: option.sellingPrice,
    channel: option.channel,
    optionId: option.optionId,
  })

  let coupangFee: number | null
  let netMargin: number | null
  let marginRate: number | null
  let bepRoas: number | null
  let effectiveCostPrice: number | null = option.costPrice
  let effectiveWarehousingFee: number | null = option.warehousingFee
  let effectiveShippingFee: number | null = option.shippingFee
  let effectivePrice = option.sellingPrice

  if (book.ok) {
    // 모드 A 성공
    coupangFee = book.coupangFee ?? null
    netMargin = book.netMargin ?? null
    marginRate = book.marginRate ?? null
    bepRoas = book.bepRoas ?? null
    effectiveCostPrice = book.costPrice ?? null
    effectivePrice = book.effectivePrice ?? option.sellingPrice
    if (option.channel === 'growth') {
      effectiveWarehousingFee = book.warehousingFee ?? null
      effectiveShippingFee = (book.growthShipFee ?? 0) + (book.growthInOutFee ?? 0)
    } else {
      effectiveWarehousingFee = 0
      effectiveShippingFee = (book.boxFee ?? 0) + (book.deliveryFee ?? 0)
    }
  } else {
    // 모드 B · 기존 공식
    const result = calculateMargin({
      sellingPrice: option.sellingPrice,
      costPrice: option.costPrice,
      warehousingFee: option.warehousingFee,
      shippingFee: option.shippingFee,
    })
    coupangFee = result.coupangFee
    netMargin = result.netMargin
    marginRate = result.marginRate
    bepRoas = result.bepRoas
  }

  const monthlySales = option.sales90d != null ? option.sales90d / 3 : null
  const monthlyMargin =
    netMargin != null && monthlySales != null
      ? Math.round(netMargin * monthlySales)
      : null

  return {
    ...option,
    sellingPrice: effectivePrice,  // ★ 실판매가로 덮어씀 (UI 표시용)
    costPrice: effectiveCostPrice,
    warehousingFee: effectiveWarehousingFee,
    shippingFee: effectiveShippingFee,
    coupangFee,
    netMargin,
    marginRate,
    bepRoas,
    monthlySales,
    monthlyMargin,
  }
}

// ─────────────────────────────────────────────────────────────
// groupByProduct — 상품 그룹 집계
// ─────────────────────────────────────────────────────────────

export function groupByProduct(
  options: CoupangOption[],
): ProductGroupMetrics[] {
  const enriched = options.map(enrichOption)
  const byProduct = new Map<string, OptionMetrics[]>()

  for (const opt of enriched) {
    const arr = byProduct.get(opt.productId) ?? []
    arr.push(opt)
    byProduct.set(opt.productId, arr)
  }

  const groups: ProductGroupMetrics[] = []

  for (const [productId, opts] of byProduct) {
    const listingIds = new Set(opts.map((o) => o.listingId))
    const growthCount = opts.filter((o) => o.channel === 'growth').length
    const wingCount = opts.filter((o) => o.channel === 'wing').length

    const bookItem = getCostBook(productId)
    const name =
      bookItem?.alias ||
      opts.find((o) => o.productName)?.productName ||
      opts[0]?.optionName ||
      productId

    groups.push({
      productId,
      name,
      hasSplitListings: listingIds.size > 1,
      listingCount: listingIds.size,
      options: opts,
      optionCount: opts.length,
      growthCount,
      wingCount,
      avgMarginRate: weightedAverage(opts, 'marginRate'),
      avgBepRoas: weightedAverage(opts, 'bepRoas'),
      revenue90d: sumOrZero(opts.map((o) => o.revenue90d)),
      monthlyRevenue: Math.round(sumOrZero(opts.map((o) => o.revenue90d)) / 3),
      monthlySales: Math.round(sumOrZero(opts.map((o) => o.sales90d)) / 3),
    })
  }

  return groups.sort((a, b) => b.monthlyRevenue - a.monthlyRevenue)
}

function weightedAverage(
  opts: OptionMetrics[],
  field: 'marginRate' | 'bepRoas',
): number | null {
  const valid = opts.filter((o) => o[field] != null)
  if (valid.length === 0) return null

  const haveSales = valid.every((o) => (o.sales90d ?? 0) > 0)
  if (haveSales) {
    const totalSales = valid.reduce((s, o) => s + (o.sales90d ?? 0), 0)
    if (totalSales === 0) return null
    const weighted = valid.reduce(
      (s, o) => s + (o[field] as number) * (o.sales90d ?? 0),
      0,
    )
    return weighted / totalSales
  }

  return valid.reduce((s, o) => s + (o[field] as number), 0) / valid.length
}

function sumOrZero(values: (number | null | undefined)[]): number {
  return values.reduce<number>((s, v) => s + (v ?? 0), 0)
}
