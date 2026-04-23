/**
 * 쿠팡 도메인 타입
 *
 * DB 스키마와 1:1로 대응합니다. Supabase 연동 시 이 파일의 타입들이
 * Database['public']['Tables']['xxx']['Row'] 형태로 자동 생성되어
 * 이 파일은 삭제/대체될 수 있습니다. 그 전까지는 수기 관리.
 */

// ─────────────────────────────────────────────────────────────
// 마스터 데이터 (엑셀 업로드로 채워짐)
// ─────────────────────────────────────────────────────────────

/** 쿠팡 WING 채널 구분 */
export type CoupangChannel = 'growth' | 'wing'

/** 상품 그룹 = 노출상품ID (Product ID). 쿠팡 고객이 보는 단위. */
export interface CoupangProduct {
  /** 노출상품ID (Product ID) */
  productId: string
  /** 대표 상품명 */
  name: string
  /** 마지막 업로드 시각 */
  updatedAt: string
}

/** 등록상품ID 단위. 셀러가 WING에서 등록한 단위. 한 productId 아래 여러 개 가능. */
export interface CoupangListing {
  /** 업체상품ID (등록상품ID) */
  listingId: string
  /** 소속 노출상품ID */
  productId: string
  channel: CoupangChannel
}

/** 옵션 단위. 실제 판매되는 최소 단위 (1kg 1개, 1kg 2개 등). */
export interface CoupangOption {
  /** 옵션ID */
  optionId: string
  /** 소속 등록상품ID */
  listingId: string
  /** 소속 노출상품ID (denormalized, 빠른 그룹핑용) */
  productId: string
  channel: CoupangChannel
  /** 옵션명 (예: "1개 1kg") */
  optionName: string
  /** 상품명 (예: "[보배마을] 흑보리 햇곡"). price_inventory의 "쿠팡 노출 상품명". */
  productName: string
  /** 현재 판매가 (VAT 포함, KRW) */
  sellingPrice: number
  /** 할인율 기준가 (페이퍼 정상가, VAT 포함) */
  listPrice: number | null
  /** 판매 상태 (판매중/품절 등) */
  saleStatus: string | null

  // ── 마진 계산을 위한 사용자 입력 값 (엑셀에 없음) ──
  /** 원가 (VAT 포함 기준으로 통일) - 수동 입력 */
  costPrice: number | null

  // ── 그로스 정산 엑셀에서 매칭 ──
  /** 입출고비 (VAT 포함, KRW) - 그로스 옵션만 해당 */
  warehousingFee: number | null
  /** 배송비 (VAT 포함, KRW) - 그로스 옵션만 해당 */
  shippingFee: number | null

  // ── 판매 분석 엑셀에서 매칭 ──
  /** 90일 판매량 (건) */
  sales90d: number | null
  /** 90일 매출 (KRW) */
  revenue90d: number | null
  /** 아이템위너 비율 (%, 0-100) */
  winnerRate: number | null
}

// ─────────────────────────────────────────────────────────────
// 계산 결과 (원본 데이터 + 파생 지표)
// ─────────────────────────────────────────────────────────────

/** 옵션 단위 계산 결과 — 원본 CoupangOption에 파생 지표 덧붙임 */
export interface OptionMetrics extends CoupangOption {
  /** 쿠팡 수수료 (판매가의 일정 %, 일단 7% 가정) */
  coupangFee: number | null
  /** 순마진 = 판매가 - 원가 - 쿠팡비 - 물류비 (VAT 포함 일관 기준) */
  netMargin: number | null
  /** 마진율 = 순마진 / 판매가 */
  marginRate: number | null
  /** BEP ROAS = 판매가 / 순마진 × 100 (%). 순마진 0 이하면 null. */
  bepRoas: number | null
  /** 월 환산 판매량 (sales90d / 3) */
  monthlySales: number | null
  /** 월 환산 마진 (netMargin × monthlySales) */
  monthlyMargin: number | null
}

/** 상품 그룹 (노출상품ID) 집계 결과 */
export interface ProductGroupMetrics {
  productId: string
  name: string
  /** 같은 productId 아래 등록상품ID가 2개 이상이면 true (경고 표시) */
  hasSplitListings: boolean
  listingCount: number
  options: OptionMetrics[]
  optionCount: number
  growthCount: number
  wingCount: number
  /** 판매량 가중 평균 마진율 */
  avgMarginRate: number | null
  /** 판매량 가중 평균 BEP ROAS */
  avgBepRoas: number | null
  revenue90d: number
  monthlyRevenue: number
  monthlySales: number
}

// ─────────────────────────────────────────────────────────────
// 엑셀 파싱 중간 결과물
// ─────────────────────────────────────────────────────────────

/** price_inventory 엑셀 행 */
export interface PriceInventoryRow {
  listingId: string
  productId: string
  optionId: string
  /** 상품명 (쿠팡 노출 상품명). 그룹 헤더에 표시. */
  productName: string
  optionName: string
  sellingPrice: number
  listPrice: number | null
  saleStatus: string | null
  productStatus: string | null
}

/** 그로스 정산 엑셀 행 (배송비/입출고비 합쳐서 옵션ID별 집계) */
export interface SettlementRow {
  optionId: string
  /** 최고가 기준 개당 판매가 (여러 행 중 최고) */
  maxUnitPrice: number
  /** 개당 입출고비 (VAT 포함) */
  warehousingFee: number
  /** 개당 배송비 (VAT 포함) */
  shippingFee: number
}

/** 판매 분석 엑셀 행 */
export interface SalesInsightRow {
  optionId: string
  sales90d: number
  revenue90d: number
  winnerRate: number
  channel: CoupangChannel | null
}

// ─────────────────────────────────────────────────────────────
// 업로드 상태 추적
// ─────────────────────────────────────────────────────────────

export interface UploadStatus {
  priceInventory: UploadMeta | null
  settlement: UploadMeta | null
  salesInsight: UploadMeta | null
  costTable: UploadMeta | null
}

export interface UploadMeta {
  fileName: string
  uploadedAt: string
  rowCount: number
}
