/**
 * 손익 진단 공용 포맷 함수 (쿠팡 + 스스 진단 페이지에서 공유)
 *
 * 쿠팡 page 의 inline 함수와 동일 시그니처/동작:
 *   formatKRW : 원 단위 그대로 ("1,234,567원")
 *   formatMan : 만 단위 환산 + 천단위 콤마 ("3,125만"), withSign 옵션
 *   formatPct : 퍼센트 (n.toFixed(digits) + '%'), null → '–'
 */

export function formatKRW(n: number): string {
  return Math.round(n).toLocaleString() + '원'
}

export function formatMan(n: number, withSign = false): string {
  const v = Math.round(n / 10000)
  return (withSign && v >= 0 ? '+' : '') + v.toLocaleString() + '만'
}

export function formatPct(n: number | null, digits = 0): string {
  if (n == null) return '–'
  return n.toFixed(digits) + '%'
}
