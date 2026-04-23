import type {
  CoupangChannel,
  CoupangOption,
  PriceInventoryRow,
  SalesInsightRow,
  SettlementRow,
} from '@/types/coupang'

/**
 * 3종 엑셀 → CoupangOption[] 매칭
 *
 * 핵심 결정:
 *   1) price_inventory가 모든 옵션의 진실(source of truth) — 등록상품ID/노출상품ID/판매가 제공
 *   2) sales_insight는 "판매방식" 컬럼으로 channel 결정. 없으면 settlement 매칭 여부로 추정.
 *   3) settlement는 그로스 옵션에만 매칭됨. 윙 옵션은 settlement 매칭 시도조차 안 함.
 *
 * 채널 판정 우선순위:
 *   (a) sales_insight.channel (엑셀에 명시된 "판매방식") > (b) settlement 매칭 여부 fallback > (c) 기본값 'wing'
 *
 * 왜 wing 기본값? 그로스는 settlement에 반드시 비용 기록이 있어야 정상. 비용 매칭 안 됐는데
 * grow로 추정하면 마진 계산 망가짐. 반대로 wing으로 잘못 찍혀도 최소한 조용히 넘어감(비용 null).
 * 사용자가 UI에서 수동 수정 가능.
 */

export interface MatchResult {
  options: CoupangOption[]
  /** price_inventory에 있지만 settlement에 없는 그로스 추정 옵션들 (사용자 확인 필요) */
  growthUnmatchedInSettlement: string[]
  /** settlement엔 있지만 price_inventory에 없는 옵션들 (의미 없으므로 로그만) */
  settlementOrphans: string[]
  /** sales_insight에 있지만 price_inventory에 없는 옵션들 (품절/단종 후 판매 기록만 남음) */
  salesOrphans: string[]
}

export interface MatchOptions {
  /** 이전 업로드에서 사용자가 수동 입력한 cost_price를 보존하기 위해 넘김 */
  previousOptions?: CoupangOption[]
}

export function matchOptions(
  priceInventory: PriceInventoryRow[],
  settlement: SettlementRow[],
  salesInsight: SalesInsightRow[],
  matchOpts: MatchOptions = {},
): MatchResult {
  const settlementMap = new Map(settlement.map((r) => [r.optionId, r]))
  const salesMap = new Map(salesInsight.map((r) => [r.optionId, r]))
  const previousMap = new Map(
    (matchOpts.previousOptions ?? []).map((o) => [o.optionId, o]),
  )

  const growthUnmatchedInSettlement: string[] = []
  const options: CoupangOption[] = []

  for (const pi of priceInventory) {
    const sales = salesMap.get(pi.optionId)
    const settle = settlementMap.get(pi.optionId)
    const prev = previousMap.get(pi.optionId)

    // 채널 결정
    //   우선순위: settlement 매칭 > sales_insight > 기본값
    //   이유: settlement(정산)에 비용 기록이 있으면 실제로 그로스로 거래된 것이므로
    //         판매분석의 라벨보다 신뢰성이 높다.
    //         (쿠팡 WING에서 같은 옵션ID가 두 채널에 등록되는 경우,
    //          판매분석은 건별로 섞여 기록되지만 정산은 그로스 건만 나옴)
    let channel: CoupangChannel
    if (settle) {
      channel = 'growth'
    } else if (sales?.channel) {
      channel = sales.channel
    } else {
      channel = 'wing'
    }

    // 그로스인데 settlement 매칭 실패 → 경고 리스트에 수집
    // (이제 channel === 'growth'는 settle 있을 때만이니, 이 조건은 남겨두되
    //  sales_insight에서 growth라고 했는데 settlement가 없는 케이스만 수집)
    const salesSaysGrowth = sales?.channel === 'growth'
    if (salesSaysGrowth && !settle) {
      growthUnmatchedInSettlement.push(pi.optionId)
    }

    const option: CoupangOption = {
      optionId: pi.optionId,
      listingId: pi.listingId,
      productId: pi.productId,
      channel,
      optionName: pi.optionName,
      productName: pi.productName,
      sellingPrice: pi.sellingPrice,
      listPrice: pi.listPrice,
      saleStatus: pi.saleStatus,

      // 원가는 사용자 수동 입력 영역 — 이전 업로드에서 입력한 값 보존
      costPrice: prev?.costPrice ?? null,

      warehousingFee: channel === 'growth' ? settle?.warehousingFee ?? null : null,
      shippingFee: channel === 'growth' ? settle?.shippingFee ?? null : null,

      sales90d: sales?.sales90d ?? null,
      revenue90d: sales?.revenue90d ?? null,
      winnerRate: sales?.winnerRate ?? null,
    }

    options.push(option)
  }

  // Orphan 추적 (UI 경고용)
  const priceOptionIds = new Set(priceInventory.map((r) => r.optionId))
  const settlementOrphans = settlement
    .filter((r) => !priceOptionIds.has(r.optionId))
    .map((r) => r.optionId)
  const salesOrphans = salesInsight
    .filter((r) => !priceOptionIds.has(r.optionId))
    .map((r) => r.optionId)

  return {
    options,
    growthUnmatchedInSettlement,
    settlementOrphans,
    salesOrphans,
  }
}

/**
 * 원가 엑셀을 옵션 리스트에 적용.
 *
 * 정책 (사용자 선택): "엑셀이 소스 오브 트루스"
 *   - 엑셀에 있는 옵션 → 엑셀 값으로 덮어쓰기 (기존 수동 입력도 덮어씀)
 *   - 엑셀에 없는 옵션 → costPrice 변경 없음 (기존 값 유지)
 *
 * 반환:
 *   - options: 원가가 반영된 새 배열
 *   - matchedCount: 매칭된 옵션 수
 *   - unmatchedCostRows: 엑셀엔 있는데 쿠팡 옵션에 없는 옵션ID들 (경고용)
 */
export interface ApplyCostTableResult {
  options: CoupangOption[]
  matchedCount: number
  unmatchedCostRows: string[]
}

export function applyCostTable(
  options: CoupangOption[],
  costRows: Array<{ optionId: string; supplyPrice: number }>,
): ApplyCostTableResult {
  const costMap = new Map(costRows.map((r) => [r.optionId, r.supplyPrice]))
  let matchedCount = 0

  const updated = options.map((opt) => {
    const cost = costMap.get(opt.optionId)
    if (cost != null) {
      matchedCount++
      return { ...opt, costPrice: cost }
    }
    return opt
  })

  // 엑셀엔 있지만 옵션 리스트에 없는 옵션 (옵션ID 오타 또는 단종 옵션일 가능성)
  const optionIdSet = new Set(options.map((o) => o.optionId))
  const unmatchedCostRows = costRows
    .filter((r) => !optionIdSet.has(r.optionId))
    .map((r) => r.optionId)

  return {
    options: updated,
    matchedCount,
    unmatchedCostRows,
  }
}
