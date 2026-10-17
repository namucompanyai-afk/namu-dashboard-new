/**
 * 쿠팡 로켓 발주 — 입고예정일 촉박 경고 (순수 함수, 경고만 — 수량·입고예정일은 바꾸지 않는다).
 *
 * 발주서에는 '발주 일시' 칸이 없다. 그래서 발주서 xlsx 를 SUPPLIER HUB 에서 받은 시각
 * (파일 생성 시각, CoupangOrderItem.receivedAt)을 발주 시점으로 본다. 파일에 생성 시각이 없으면 업로드 시각.
 * 여유 일수 = 입고예정일 − 받은 날 (KST 달력 날짜 차이).
 *
 * 2026-10-17 대표 지시 — PO 143132327(고양1 오색현미 648개): 9/22 리오더 → 9/23 입고예정, 진도에서 D+1 못 맞춰 미납.
 * 발주 확정 단계(SUPPLIER HUB)에서 입고예정일을 바꿔야 하는 발주를 화면 위에서 바로 보이게 한다.
 * 운영 판단용 — 슬랙 매출 보고·카톡 멘트에는 넣지 않는다.
 */
import type { RoutedItem, ShipFrom } from './coupang'

/** 기준값 — 여유 일수가 이 값 이하면 표시. 진도팜은 수도권까지 D+1 불가라 한 단계(주의) 더 본다 */
export const LEAD_URGENT_DAYS = 1 // 전 출고지: D+1 이하 = 촉박 (입고예정일 변경 필요)
export const LEAD_CAUTION_DAYS_JINDO = 2 // 진도팜: D+2 = 주의

export type LeadLevel = 'urgent' | 'caution'

export type LeadAlert = {
  poNumber: string
  center: string
  shipFrom: ShipFrom
  receivedDate: string // 발주서 받은 날 (YYYY-MM-DD, KST)
  dueDate: string
  days: number // 입고예정일 − 받은 날
  level: LeadLevel
  basis: 'file' | 'upload' // 받은 시각 출처 — 파일 생성 시각 / 업로드 시각
  qty: number // 표시 수량 (확정 전이면 발주수량)
  boxes: number | null // 올림(수량 ÷ 박스입수). 입수 모르는 행이 있으면 null
  amount: number // 수량 × 매입가 (= 발주서 발주금액)
  products: string[]
}

/** ISO 시각 → KST 날짜 */
export const kstDateOf = (iso: string): string =>
  new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)

const dayDiff = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000)

export function levelOf(shipFrom: ShipFrom, days: number): LeadLevel | null {
  if (days <= LEAD_URGENT_DAYS) return 'urgent'
  if (shipFrom === '진도팜' && days <= LEAD_CAUTION_DAYS_JINDO) return 'caution'
  return null
}

/**
 * 발주(발주번호 × 출고지)별 촉박 경고 — 촉박 먼저, 같은 단계면 금액 큰 순.
 * 미납품 확정 행(notDelivered)은 뺀다. 입고예정일이 이미 받은 날보다 앞이면(옛 발주서를 나중에 받은 경우) 경고 대상 아님.
 */
export function buildLeadAlerts(items: RoutedItem[]): { alerts: LeadAlert[]; pastCount: number } {
  const map = new Map<string, { items: RoutedItem[] }>()
  for (const it of items) {
    if (it.notDelivered || !it.dueDate || !it.receivedAt) continue
    const key = `${it.poNumber}|${it.shipFrom}`
    const g = map.get(key) ?? { items: [] }
    g.items.push(it)
    map.set(key, g)
  }
  const alerts: LeadAlert[] = []
  const past = new Set<string>()
  for (const { items: g } of map.values()) {
    const first = g[0]
    const receivedDate = kstDateOf(first.receivedAt)
    const days = dayDiff(first.dueDate, receivedDate)
    if (days < 0) {
      past.add(first.poNumber)
      continue
    }
    const level = levelOf(first.shipFrom, days)
    if (!level) continue
    let boxes: number | null = 0
    for (const it of g) {
      const q = it.master?.boxQty ?? 0
      boxes = boxes === null || q <= 0 ? null : boxes + Math.ceil(it.displayQty / q)
    }
    alerts.push({
      poNumber: first.poNumber,
      center: first.center,
      shipFrom: first.shipFrom,
      receivedDate,
      dueDate: first.dueDate,
      days,
      level,
      basis: first.receivedBasis,
      qty: g.reduce((a, it) => a + it.displayQty, 0),
      boxes,
      amount: g.reduce((a, it) => a + it.displayQty * it.unitPrice, 0),
      products: [...new Set(g.map((it) => it.master?.alias || it.productName))],
    })
  }
  alerts.sort((a, b) => (a.level === b.level ? b.amount - a.amount : a.level === 'urgent' ? -1 : 1))
  return { alerts, pastCount: past.size }
}

/** 'YYYY-MM-DD' → '9/22' */
export const mdOf = (ymd: string): string => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
