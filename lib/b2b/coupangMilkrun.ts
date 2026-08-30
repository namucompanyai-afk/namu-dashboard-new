/**
 * 쿠팡 밀크런 운임 참고 계산 (진도팜 출고분).
 *
 * 시트 '쿠팡 밀크런 가격표' → 출고지 '전남진도_2' · 계산단위 '차량' 행만 쓴다.
 * 컬럼은 센터별 요금(부가포함 값 그대로)이고, 헤더가 '고양1(27)' 형식이라
 * 괄호 앞 센터명으로 매칭한다.
 *
 * ⚠️ 참고용 — 밀크런 트럭 요금표 기준값이라 실제 청구와 다를 수 있다.
 * 팔레트 산정·출고지 분기·로켓 양식 로직은 소비만 하고 건드리지 않는다.
 */
import { norm, toNum } from './kurly'
import { BOXES_PER_PLT, pltOf } from './coupang'
import type { PoPalletGroup } from './coupangDiagram'

export const JINDO_SHIP_FROM = '전남진도_2'
export { BOXES_PER_PLT, pltOf } // 단일 소스: lib/b2b/coupang.ts

/** 톤수 구간 — 최대 PLT 오름차순. 14PLT 초과는 차량 분할로 처리한다. */
export const TON_TIERS: { maxPlt: number; tons: number }[] = [
  { maxPlt: 2, tons: 1 },
  { maxPlt: 4, tons: 3.5 },
  { maxPlt: 12, tons: 5 },
  { maxPlt: 14, tons: 8 },
]

const MAX_TIER = TON_TIERS[TON_TIERS.length - 1]

/** 가격표 한 행(차량 단위) — fees 는 센터명 → 요금(빈칸이면 키 없음) */
export type CoupangMilkrunRow = {
  shipFrom: string
  label: string // '1톤 (1~2pallet)'
  tons: number
  fees: Record<string, number>
}

const UNIT_VEHICLE = '차량'
const COL_SHIP_FROM = 0
const COL_UNIT = 2
const COL_LABEL = 3
const COL_FIRST_CENTER = 4

/** '고양1(27)' → '고양1' (괄호 앞) */
export const centerKeyOf = (header: unknown): string => norm(String(header ?? '').split('(')[0])

/** '1톤 (1~2pallet)' → 1 / '2.5톤 (3pallet)' → 2.5 */
const tonsOf = (label: string): number => {
  const m = String(label).match(/([\d.]+)\s*톤/)
  return m ? Number(m[1]) : 0
}

/** 가격표 rows(헤더 1행 포함) → 전남진도_2 차량 요금 행 */
export function parseCoupangMilkrun(rows: unknown[][]): CoupangMilkrunRow[] {
  if (!rows.length) return []
  const header = rows[0] || []
  const out: CoupangMilkrunRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const shipFrom = String(r[COL_SHIP_FROM] ?? '').trim()
    if (norm(shipFrom) !== norm(JINDO_SHIP_FROM)) continue
    if (norm(r[COL_UNIT]) !== norm(UNIT_VEHICLE)) continue
    const label = String(r[COL_LABEL] ?? '').trim()
    const fees: Record<string, number> = {}
    for (let c = COL_FIRST_CENTER; c < header.length; c++) {
      const raw = r[c]
      if (raw === '' || raw === null || raw === undefined) continue
      const fee = toNum(raw)
      if (!fee) continue
      const full = norm(header[c])
      const key = centerKeyOf(header[c])
      if (full && !(full in fees)) fees[full] = fee
      if (key && !(key in fees)) fees[key] = fee
    }
    out.push({ shipFrom, label, tons: tonsOf(label), fees })
  }
  return out
}

/** 센터 × 톤수 → 요금. 미등록이면 null */
export function lookupCoupangFee(
  rows: CoupangMilkrunRow[],
  center: string,
  tons: number,
): number | null {
  const row = rows.find((r) => r.tons === tons)
  if (!row) return null
  const full = norm(center)
  const key = centerKeyOf(center)
  const fee = row.fees[full] ?? row.fees[key]
  return fee ?? null
}

/**
 * PLT → 차량 배정. 14PLT 이하는 한 대, 초과분은 큰 차부터 분할한다.
 * 예) 16PLT → 8톤(14PLT) + 1톤(2PLT)
 */
export function assignVehicles(plt: number): { tons: number; plt: number }[] {
  const out: { tons: number; plt: number }[] = []
  let left = Math.max(0, plt)
  while (left > MAX_TIER.maxPlt) {
    out.push({ tons: MAX_TIER.tons, plt: MAX_TIER.maxPlt })
    left -= MAX_TIER.maxPlt
  }
  if (left > 0) {
    const tier = TON_TIERS.find((t) => left <= t.maxPlt) ?? MAX_TIER
    out.push({ tons: tier.tons, plt: left })
  }
  return out
}

/** 센터 × 입고예정일 묶음 = 차량 1건(또는 분할 여러 대) */
export type MilkrunShipment = {
  key: string // `${center}|${dueDate}`
  center: string
  dueDate: string
  poNumbers: string[]
  plt: number
  vehicles: { tons: number; plt: number }[]
  vehicleLabel: string // '8톤 + 1톤'
  fee: number | null // 시트에 조합 요금 없으면 null → '요금 미등록'
}

export const vehicleLabelOf = (vs: { tons: number }[]): string =>
  vs.map((v) => `${v.tons}톤`).join(' + ')

/**
 * 진도팜 출고 + 팔레트 필요(9박스 초과) 발주만 모아 센터·입고예정일별 차량/운임 산정.
 * 9박스 이하는 택배라 운임 계산에서 제외한다.
 */
export function buildMilkrunShipments(
  groups: PoPalletGroup[],
  prices: CoupangMilkrunRow[],
): MilkrunShipment[] {
  const map = new Map<string, MilkrunShipment>()
  for (const g of groups) {
    if (g.shipFrom !== '진도팜' || !g.needsPallet) continue
    const key = `${g.center}|${g.dueDate}`
    let s = map.get(key)
    if (!s) {
      s = {
        key,
        center: g.center,
        dueDate: g.dueDate,
        poNumbers: [],
        plt: 0,
        vehicles: [],
        vehicleLabel: '',
        fee: null,
      }
      map.set(key, s)
    }
    s.poNumbers.push(g.poNumber)
    s.plt += pltOf(g.boxes)
  }
  const list = [...map.values()]
  for (const s of list) {
    s.vehicles = assignVehicles(s.plt)
    s.vehicleLabel = vehicleLabelOf(s.vehicles)
    const fees = s.vehicles.map((v) => lookupCoupangFee(prices, s.center, v.tons))
    s.fee = fees.some((f) => f === null) ? null : fees.reduce((a: number, b) => a + (b ?? 0), 0)
  }
  return list.sort((a, b) =>
    a.dueDate === b.dueDate ? a.center.localeCompare(b.center) : a.dueDate.localeCompare(b.dueDate),
  )
}

/** 발주 → 소속 차량 건 인덱스 */
export function shipmentByPo(shipments: MilkrunShipment[]): Record<string, MilkrunShipment> {
  const m: Record<string, MilkrunShipment> = {}
  for (const s of shipments) for (const po of s.poNumbers) m[`${po}|${s.center}|${s.dueDate}`] = s
  return m
}

export type MilkrunTotals = { totalPlt: number; totalFee: number; unpriced: number }

export function sumMilkrun(shipments: MilkrunShipment[]): MilkrunTotals {
  return {
    totalPlt: shipments.reduce((a, s) => a + s.plt, 0),
    totalFee: shipments.reduce((a, s) => a + (s.fee ?? 0), 0),
    unpriced: shipments.filter((s) => s.fee === null).length,
  }
}
