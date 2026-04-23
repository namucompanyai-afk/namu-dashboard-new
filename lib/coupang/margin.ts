import type {
  CoupangOption,
  OptionMetrics,
  ProductGroupMetrics,
} from '@/types/coupang'

/**
 * 마진 계산 로직
 *
 * 기준:
 *   - 모든 금액은 VAT 포함 (파싱 단계에서 이미 ×1.1 완료)
 *   - 쿠팡 수수료율은 7% 가정 (카테고리별 차이는 향후 상품별 오버라이드 필드 추가)
 *   - 순마진 = 판매가 - 원가 - 쿠팡비 - 배송비 - 입출고비
 *   - BEP ROAS = 판매가 / 순마진 × 100 (이 숫자의 ROAS를 내야 광고비가 순마진과 같아져 본전)
 *
 * 왜 BEP ROAS? 쿠팡 광고 UI는 ROAS 기반이라 판매자가 "이 캠페인이 흑자인지" 판단하려면
 * 옵션마다 "최소 몇 % ROAS가 나와야 남는지"를 알아야 한다. 광고 분석 모듈이 이 값을 조회해서
 * 효자/제외 키워드를 자동 분류한다.
 */

/** 쿠팡 판매수수료율 (기본값, 카테고리별 override 가능하게 인자로 받음) */
export const DEFAULT_COUPANG_FEE_RATE = 0.07

export interface MarginCalcInput {
  sellingPrice: number
  costPrice: number | null
  coupangFeeRate?: number // default 0.07
  warehousingFee?: number | null
  shippingFee?: number | null
}

export interface MarginCalcResult {
  coupangFee: number
  netMargin: number | null
  marginRate: number | null
  bepRoas: number | null
}

/** 단일 옵션의 마진/BEP 계산 */
export function calculateMargin(input: MarginCalcInput): MarginCalcResult {
  const {
    sellingPrice,
    costPrice,
    coupangFeeRate = DEFAULT_COUPANG_FEE_RATE,
    warehousingFee = 0,
    shippingFee = 0,
  } = input

  const coupangFee = Math.round(sellingPrice * coupangFeeRate)

  // 원가 미입력 시 마진 계산 불가
  if (costPrice == null) {
    return { coupangFee, netMargin: null, marginRate: null, bepRoas: null }
  }

  const logistics = (warehousingFee ?? 0) + (shippingFee ?? 0)
  const netMargin = sellingPrice - costPrice - coupangFee - logistics
  const marginRate = sellingPrice > 0 ? (netMargin / sellingPrice) * 100 : null

  // 순마진 0 이하면 BEP ROAS 의미 없음 (이미 적자 → 광고 ROAS 어떻게 나와도 손해)
  const bepRoas = netMargin > 0 ? (sellingPrice / netMargin) * 100 : null

  return { coupangFee, netMargin, marginRate, bepRoas }
}

/** 옵션 하나를 파생 지표 포함 OptionMetrics로 변환 */
export function enrichOption(option: CoupangOption): OptionMetrics {
  const { coupangFee, netMargin, marginRate, bepRoas } = calculateMargin({
    sellingPrice: option.sellingPrice,
    costPrice: option.costPrice,
    warehousingFee: option.warehousingFee,
    shippingFee: option.shippingFee,
  })

  const monthlySales = option.sales90d != null ? option.sales90d / 3 : null
  const monthlyMargin =
    netMargin != null && monthlySales != null
      ? Math.round(netMargin * monthlySales)
      : null

  return {
    ...option,
    coupangFee,
    netMargin,
    marginRate,
    bepRoas,
    monthlySales,
    monthlyMargin,
  }
}

/**
 * 옵션 리스트를 노출상품ID 기준으로 묶어 그룹 집계
 *
 * 평균 마진율 / 평균 BEP ROAS는 판매량 가중 평균.
 * 왜 단순 평균 아닌가? 거의 안 팔리는 옵션이 평균을 왜곡하면 그룹 지표가 쓸모없어짐.
 * 판매량 데이터가 없으면 동가중 평균으로 fallback.
 */
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

    // 대표 이름: price_inventory에서 가져온 상품명 사용.
    // 없으면(드뭄) 첫 옵션명으로 fallback.
    const name =
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

  // 월 환산 매출 내림차순 — 상위 상품이 위로
  return groups.sort((a, b) => b.monthlyRevenue - a.monthlyRevenue)
}

/** 판매량 가중 평균. 판매량 없으면 동가중 평균 fallback. */
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

  // 판매량 미매칭 → 동가중
  return valid.reduce((s, o) => s + (o[field] as number), 0) / valid.length
}

function sumOrZero(values: (number | null)[]): number {
  return values.reduce<number>((s, v) => s + (v ?? 0), 0)
}
