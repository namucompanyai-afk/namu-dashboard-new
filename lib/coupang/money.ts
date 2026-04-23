/**
 * VAT / 금액 유틸
 *
 * 쿠팡 WING의 모든 수치는 VAT 제외(공급가액) 기준. 실제 지출액은 ×1.1.
 * 이 도구는 "셀러가 보는 진짜 숫자"가 목적이므로 전 화면 VAT 포함 기준으로 통일.
 */

export const VAT_RATE = 0.1

/** 공급가액(VAT 제외) → 부가세 포함 금액 */
export function addVat(supplyPrice: number): number {
  return Math.round(supplyPrice * (1 + VAT_RATE))
}

/** 부가세 포함 금액 → 공급가액 */
export function removeVat(totalPrice: number): number {
  return Math.round(totalPrice / (1 + VAT_RATE))
}

/** KRW 포맷: 1234567 → "1,234,567" */
export function formatKrw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('ko-KR').format(Math.round(value))
}

/**
 * 만/천만 단위 축약:
 *   99_300_000 → "9,930만"
 *   1_500_000  → "150만"
 *   8_500      → "8,500"
 */
export function formatKrwShort(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const n = Math.round(value)
  if (Math.abs(n) < 10_000) return formatKrw(n)
  const man = Math.round(n / 10_000)
  return `${formatKrw(man)}만`
}

/** 퍼센트 포맷. value는 이미 % 단위 (예: 23.5 → "23.5%") */
export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(digits)}%`
}

/** 0~1 비율 → 퍼센트 표시 */
export function formatRatio(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(digits)}%`
}
