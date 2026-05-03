/**
 * 정산내역 + 주문조회 두 파일의 기간 매칭 검증.
 *
 * 정산기준일(정산내역) vs 주문일시(주문조회) 의 날짜(yyyy-mm-dd) 단위 비교.
 *
 * status:
 *   'match'    — 두 기간 시작/끝이 동일
 *   'partial'  — 일부 겹침 (overlapRange 있음)
 *   'mismatch' — 안 겹침 (overlapRange null)
 */

export interface DateRange {
  start: Date
  end: Date
  days: number
  rowCount: number
}

export interface PeriodOverlapResult {
  status: 'match' | 'partial' | 'mismatch'
  settleRange: DateRange
  orderRange: DateRange
  overlapRange: { start: Date; end: Date; days: number } | null
  /** 두 파일의 상품주문번호 교집합 — 매칭 가능 row 수 */
  matchedCount: number
  /** 정산내역에만 있고 주문조회에 없는 상품주문번호 수 */
  unmatchedCount: number
}

function toDayString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dayOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function diffDaysInclusive(start: Date, end: Date): number {
  const a = dayOnly(start).getTime()
  const b = dayOnly(end).getTime()
  return Math.round((b - a) / 86400000) + 1
}

export function validatePeriodOverlap(
  settle: { start: Date; end: Date; rowCount: number },
  order: { start: Date; end: Date; rowCount: number },
  settleOrderIds: Set<string>,
  orderIds: Set<string>,
): PeriodOverlapResult {
  const settleRange: DateRange = {
    start: dayOnly(settle.start),
    end: dayOnly(settle.end),
    days: diffDaysInclusive(settle.start, settle.end),
    rowCount: settle.rowCount,
  }
  const orderRange: DateRange = {
    start: dayOnly(order.start),
    end: dayOnly(order.end),
    days: diffDaysInclusive(order.start, order.end),
    rowCount: order.rowCount,
  }

  // 교집합
  let matchedCount = 0
  let unmatchedCount = 0
  for (const id of settleOrderIds) {
    if (orderIds.has(id)) matchedCount += 1
    else unmatchedCount += 1
  }

  // 기간 겹침 (날짜 단위)
  const oStart = settleRange.start > orderRange.start ? settleRange.start : orderRange.start
  const oEnd = settleRange.end < orderRange.end ? settleRange.end : orderRange.end
  const overlap =
    oStart <= oEnd
      ? { start: oStart, end: oEnd, days: diffDaysInclusive(oStart, oEnd) }
      : null

  // 상태 결정
  let status: 'match' | 'partial' | 'mismatch'
  if (
    toDayString(settleRange.start) === toDayString(orderRange.start) &&
    toDayString(settleRange.end) === toDayString(orderRange.end)
  ) {
    status = 'match'
  } else if (overlap) {
    status = 'partial'
  } else {
    status = 'mismatch'
  }

  return {
    status,
    settleRange,
    orderRange,
    overlapRange: overlap,
    matchedCount,
    unmatchedCount,
  }
}
