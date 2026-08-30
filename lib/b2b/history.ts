/**
 * B2B 발주 이력 — 구글시트 '발주 이력' 탭 기록용 모델.
 *
 * 화면에 이미 계산된 값(파싱·매출 요약)을 **행 단위로 옮겨 담기만** 한다 —
 * 파싱·팔레트·운송비·라벨·도면 로직은 건드리지 않는다.
 *
 * 쓰기는 app/api/b2b/history 가 '발주 이력' 탭에만 수행한다(다른 탭은 읽기 전용).
 */
import { norm, type KurlyOrderRow, type ProductMaster } from './kurly'
import { withVat } from './kurlySummary'
import type { RoutedItem } from './coupang'

/** 쓰기가 허용된 유일한 탭 (공백 포함 — 범위 문자열은 반드시 따옴표로 감쌀 것) */
export const HISTORY_TAB = '발주 이력'

export const HISTORY_HEADERS = [
  '업로드일시',
  '채널',
  '발주번호',
  '센터·입고지',
  '입고예정일',
  '상품(별칭)',
  '출고지',
  '박스',
  '낱개',
  '부가포함매출',
] as const

export const HISTORY_COL_COUNT = HISTORY_HEADERS.length

export type HistoryRow = {
  channel: '컬리' | '쿠팡'
  poNumber: string // 컬리=발주상품코드 · 쿠팡=발주번호
  center: string // 센터·입고지
  dueDate: string
  product: string // 별칭 우선, 없으면 파일 상품명
  shipFrom: string // 상품마스터 출고지. 미등록이면 '미분류'
  boxes: number | null
  units: number
  revenue: number // 부가포함매출
}

export const UNCLASSIFIED = '미분류'

/** 중복 판정 키 — 채널 + 발주번호 + 상품 */
export function historyKey(channel: string, poNumber: string, product: string): string {
  return [channel, poNumber, product].map((s) => String(s ?? '').trim()).join('')
}

export const keyOfRow = (r: HistoryRow): string => historyKey(r.channel, r.poNumber, r.product)

/** HistoryRow → 시트 한 줄 (업로드일시는 서버가 채운다) */
export function toSheetRow(r: HistoryRow, uploadedAt: string): (string | number)[] {
  return [
    uploadedAt,
    r.channel,
    r.poNumber,
    r.center,
    r.dueDate,
    r.product,
    r.shipFrom,
    r.boxes ?? '',
    r.units,
    r.revenue,
  ]
}

const taxableOf = (m: ProductMaster | undefined): boolean => (m?.taxType || '').includes('과세')

/**
 * 컬리 — 발주상품코드 단위 1행.
 * 매출은 발주 파일의 공급가(프로모션 반영분)에 과세면 ×1.1.
 */
export function buildKurlyHistory(
  orders: KurlyOrderRow[],
  masterByCode: Record<string, ProductMaster>,
): HistoryRow[] {
  return orders.map((o) => {
    const m = masterByCode[norm(o.masterCode)]
    return {
      channel: '컬리',
      poNumber: o.productCode,
      center: o.dest,
      dueDate: o.dueDate,
      product: m?.alias || o.productName || o.masterCode,
      shipFrom: m?.shipFrom || UNCLASSIFIED,
      boxes: o.boxCount,
      units: o.totalUnits,
      revenue: withVat(o.supplyTotal, taxableOf(m)),
    }
  })
}

/**
 * 쿠팡 — 발주번호 × 상품 단위 1행.
 * 매출은 **발주서 매입가** × 납품가능수량, 과세면 ×1.1 (화면 매출 요약과 같은 소스).
 * 시트 쿠팡 공급가는 쓰지 않는다 — 발주서마다 단가가 바뀌기 때문.
 */
export function buildCoupangHistory(items: RoutedItem[]): HistoryRow[] {
  return items.map((it) => ({
    channel: '쿠팡',
    poNumber: it.poNumber,
    center: it.center,
    dueDate: it.dueDate,
    product: it.master?.alias || it.productName,
    shipFrom: it.master?.shipFrom || UNCLASSIFIED,
    boxes: it.boxes,
    units: it.confirmQty,
    revenue: withVat(it.confirmQty * it.unitPrice, taxableOf(it.master)),
  }))
}

/** 화면 표시용 결과 문구 */
export function historyMessage(added: number, updated: number): string {
  return `이력 저장됨 ${added}건${updated > 0 ? `(갱신 ${updated}건)` : ''}`
}
