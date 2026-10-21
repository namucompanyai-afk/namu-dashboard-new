/**
 * 네이버 커머스 API 상품주문 — 원본 정규화 · 일자 요약. 순수 함수(네트워크·Supabase 없음).
 *   토큰 발급·조회·업로드는 scripts/naver-sales-collect/run.ts
 *   아침 보고서 ① 칸 집계는 scripts/coupang-morning-report/run.ts 가 Supabase 에서 이 날짜의 행을 읽어 summarizeNaverOrders 로 만든다.
 *
 * 실제 응답 필드명: 브레인이 16GB 에서 실데이터(2026-10-20, 101건)로 확인(2026-10-22) — 아래가 확정값.
 *   contents[] = { productOrderId, content: { order, productOrder, delivery } }
 *   productOrder: productOrderId·quantity·totalPaymentAmount·unitPrice·productName·productId·productOrderStatus·
 *                 placeOrderDate·productDiscountAmount·deliveryFeeAmount·claimType·claimStatus·
 *                 expectedSettlementAmount·saleCommission·paymentCommission·channelCommission·
 *                 knowledgeShoppingSellingInterlockCommission·sellerBurdenStoreDiscountAmount
 *   order: orderId·orderDate·paymentDate·paymentMeans·generalPaymentAmount (+ ordererName·ordererTel·ordererId — 개인정보, 안 저장)
 *   delivery: 수취인·배송지 블록 — 안 저장(개인정보)
 */

export type NaverOrderRow = {
  productOrderId: string
  orderId: string | null
  productId: string | null
  productName: string | null
  productOption: string | null
  quantity: number | null
  totalPaymentAmount: number | null
  productOrderStatus: string | null
  claimStatus: string | null
  paymentDate: string | null // ISO, KST 오프셋 포함 — '결제 기준' 집계 키. order.paymentDate (productOrder 가 아니라 order 쪽에 있음)
  // 정산 기준 칸(2026-10-22 추가) — 보고서엔 아직 안 씀, 나중에 "결제 기준 vs 정산 기준" 비교용으로 저장만 해둔다
  expectedSettlementAmount: number | null
  saleCommission: number | null
  paymentCommission: number | null
  channelCommission: number | null
  knowledgeShoppingCommission: number | null
  sellerBurdenStoreDiscountAmount: number | null
  /** 디버그·필드 보정용 — 개인정보(수취인명·전화·주소)는 빼고 order·productOrder 중 안전한 칸만 남긴 것. delivery 블록은 통째로 제외. */
  rawSafe: unknown
}

const str = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined) return o[k]
  return undefined
}

/** order 중 개인정보(ordererName·ordererTel·ordererId) 없이 남길 칸만 — 브레인 요청대로 금액·날짜·결제수단만. */
function safeOrder(order: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['orderId', 'orderDate', 'paymentDate', 'paymentMeans', 'generalPaymentAmount']) {
    if (order[k] !== undefined) out[k] = order[k]
  }
  return out
}
/** productOrder 중 개인정보(shippingAddress·takingAddress)만 제거 — 나머지는 전부 남긴다(이름·연락처류 없음, 금액·상태값뿐). */
function safeProductOrder(po: Record<string, unknown>): Record<string, unknown> {
  const { shippingAddress, takingAddress, ...rest } = po
  return rest
}

/** data.contents[] 의 한 원소(content: {order, productOrder, delivery}) → 저장용 행. */
export function normalizeProductOrder(content: unknown): NaverOrderRow {
  const c = (content ?? {}) as Record<string, unknown>
  const order = (c.order ?? {}) as Record<string, unknown>
  const po = (c.productOrder ?? {}) as Record<string, unknown>
  return {
    productOrderId: str(pick(po, ['productOrderId'])) ?? str(pick(c, ['productOrderId'])) ?? '',
    orderId: str(pick(order, ['orderId'])),
    productId: str(pick(po, ['productId'])),
    productName: str(pick(po, ['productName'])),
    productOption: str(pick(po, ['productOption', 'optionName'])),
    quantity: num(pick(po, ['quantity'])),
    totalPaymentAmount: num(pick(po, ['totalPaymentAmount'])),
    productOrderStatus: str(pick(po, ['productOrderStatus'])),
    claimStatus: str(pick(po, ['claimStatus'])),
    paymentDate: str(pick(order, ['paymentDate'])),
    expectedSettlementAmount: num(pick(po, ['expectedSettlementAmount'])),
    saleCommission: num(pick(po, ['saleCommission'])),
    paymentCommission: num(pick(po, ['paymentCommission'])),
    channelCommission: num(pick(po, ['channelCommission'])),
    knowledgeShoppingCommission: num(pick(po, ['knowledgeShoppingSellingInterlockCommission'])),
    sellerBurdenStoreDiscountAmount: num(pick(po, ['sellerBurdenStoreDiscountAmount'])),
    rawSafe: { order: safeOrder(order), productOrder: safeProductOrder(po) }, // delivery 블록은 아예 안 넣음
  }
}

export type NaverOrderLite = {
  productName: string | null
  totalPaymentAmount: number | null
  productOrderStatus: string | null
  claimStatus: string | null
}

export type NaverSalesSummary = {
  orderCount: number
  paidAmountSum: number
  cancelCount: number
  top3: { productName: string; amount: number }[]
}

// CANCELED(productOrderStatus)·CANCEL/CANCEL_DONE(claimStatus) 은 2026-10-20 실데이터(101건 중 1건)로 확인됨.
// RETURNED/RETURN/RETURN_DONE·EXCHANGED/EXCHANGE 는 아직 실제 사례가 없어 추정 그대로 — 반품·교환 건이 생기면 실제 값으로 확인 필요.
const CANCEL_LIKE = new Set(['CANCELED', 'CANCEL', 'CANCEL_DONE', 'RETURNED', 'RETURN', 'RETURN_DONE', 'EXCHANGED', 'EXCHANGE'])
const isCancelLike = (v: string | null): boolean => !!v && CANCEL_LIKE.has(v.toUpperCase())

/**
 * 결제 기준 합계 — 취소·반품 금액은 빼지 않는다(1차 범위, 대표 확정: 차감 규칙은 나중에).
 * cancelCount 는 별도 참고용 건수일 뿐, paidAmountSum 계산에는 영향 없음.
 */
export function summarizeNaverOrders(rows: NaverOrderLite[]): NaverSalesSummary {
  const orderCount = rows.length
  const paidAmountSum = rows.reduce((a, r) => a + (r.totalPaymentAmount ?? 0), 0)
  const cancelCount = rows.filter((r) => isCancelLike(r.claimStatus) || isCancelLike(r.productOrderStatus)).length
  const byProduct = new Map<string, number>()
  for (const r of rows) {
    const key = r.productName ?? '(상품명 없음)'
    byProduct.set(key, (byProduct.get(key) ?? 0) + (r.totalPaymentAmount ?? 0))
  }
  const top3 = [...byProduct.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([productName, amount]) => ({ productName, amount }))
  return { orderCount, paidAmountSum, cancelCount, top3 }
}

/** 수집 대상일(KST, YYYY-MM-DD) → 네이버 API from/to (그날 00:00 ~ 다음날 00:00, +09:00 고정) */
export function kstDayRange(ymd: string): { from: string; to: string } {
  const [y, m, d] = ymd.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d))
  next.setUTCDate(next.getUTCDate() + 1)
  const nextYmd = next.toISOString().slice(0, 10)
  return { from: `${ymd}T00:00:00.000+09:00`, to: `${nextYmd}T00:00:00.000+09:00` }
}
