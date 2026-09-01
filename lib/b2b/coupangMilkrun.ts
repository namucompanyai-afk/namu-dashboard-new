/**
 * 쿠팡 밀크런 운임 참고 계산 (진도팜·위킵 출고분).
 *
 * 시트 '쿠팡 밀크런 가격표' 전 행을 그대로 읽는다(출고지·계산단위별).
 * 컬럼은 센터별 요금(부가포함 값 그대로)이고, 헤더가 '고양1(27)' 형식이라
 * 괄호 앞 센터명으로 매칭한다. 어느 출고지 행을 쓸지는 호출부가 정한다.
 *
 * ⚠️ 참고용 — 밀크런 트럭 요금표 기준값이라 실제 청구와 다를 수 있다.
 * 팔레트 산정·출고지 분기·로켓 양식 로직은 소비만 하고 건드리지 않는다.
 */
import { norm, toNum, type ProductMaster } from './kurly'
import { shipFromOf, type ShipFrom } from './coupang'
import { pltCountOf, type PoPalletGroup } from './coupangDiagram'

export { pltCountOf } // 단일 소스: lib/b2b/coupangDiagram.tsx (실측 자리 수 × 단수)

/** 톤수 구간 — 최대 PLT 오름차순. 14PLT 초과는 차량 분할로 처리한다. */
export const TON_TIERS: { maxPlt: number; tons: number }[] = [
  { maxPlt: 2, tons: 1 },
  { maxPlt: 4, tons: 3.5 },
  { maxPlt: 12, tons: 5 },
  { maxPlt: 14, tons: 8 },
]

const MAX_TIER = TON_TIERS[TON_TIERS.length - 1]

/** 가격표 한 행 — fees 는 센터명 → 요금(빈칸이면 키 없음) */
export type CoupangMilkrunRow = {
  shipFrom: string // 출고지명 ('전남진도_2' / '시흥시_1' / '시흥시_1-1' …)
  unit: string // 계산단위 ('차량' / 'BASIC' 등 시트 표기 그대로)
  label: string // 단위 ('1톤 (1~2pallet)' 등)
  tons: number // 차량 행만 의미 있음(라벨에서 추출), 그 외 0
  fees: Record<string, number>
}

export const UNIT_VEHICLE = '차량'
export const UNIT_BASIC = 'BASIC' // 계산단위 'BASIC(1pt 당)' — 팔레트 1장당 요금
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

/** 가격표 rows(헤더 1행 포함) → 전 출고지·전 계산단위 요금 행 */
export function parseCoupangMilkrun(rows: unknown[][]): CoupangMilkrunRow[] {
  if (!rows.length) return []
  const header = rows[0] || []
  const out: CoupangMilkrunRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const shipFrom = String(r[COL_SHIP_FROM] ?? '').trim()
    if (!shipFrom) continue
    const unit = String(r[COL_UNIT] ?? '').trim()
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
    out.push({ shipFrom, unit, label, tons: tonsOf(label), fees })
  }
  return out
}

/** 행에서 센터 요금 뽑기 (전체 헤더 우선, 없으면 괄호 앞 센터명) */
const feeOf = (row: CoupangMilkrunRow, center: string): number | null =>
  row.fees[norm(center)] ?? row.fees[centerKeyOf(center)] ?? null

/**
 * 출고지명 뒤의 표 구획 번호를 떼어 같은 출고지 묶음 키를 만든다.
 *   '시흥시_1' · '시흥시_1-1' → '시흥시'   (차량 행과 BASIC 행이 갈려 있음)
 *   '시흥시(택배)_1-2' → '시흥시(택배)'    (택배 요금은 별도 묶음)
 * 접미사 번호는 출고지마다 순서가 달라(안성시_1-1=BASIC, 여주시_1=BASIC)
 * 번호가 아니라 계산단위로 행을 고른다.
 */
export const originBaseOf = (shipFrom: string): string =>
  norm(String(shipFrom ?? '').replace(/_[\d-]+$/, ''))

/** 같은 출고지 묶음 + 계산단위로 행 추리기 */
const rowsOf = (rows: CoupangMilkrunRow[], shipFrom: string, unit: string): CoupangMilkrunRow[] => {
  const base = originBaseOf(shipFrom)
  if (!base) return []
  return rows.filter((r) => originBaseOf(r.shipFrom) === base && norm(r.unit).includes(norm(unit)))
}

/** 출고지 × 센터 × 톤수 → 요금. 미등록이면 null */
export function lookupCoupangFee(
  rows: CoupangMilkrunRow[],
  shipFrom: string,
  center: string,
  tons: number,
): number | null {
  const row = rowsOf(rows, shipFrom, UNIT_VEHICLE).find((r) => r.tons === tons)
  return row ? feeOf(row, center) : null
}

/** 출고지 × 센터 → BASIC 1PLT 요금. 미등록이면 null */
export function lookupBasicFee(
  rows: CoupangMilkrunRow[],
  shipFrom: string,
  center: string,
): number | null {
  const row = rowsOf(rows, shipFrom, UNIT_BASIC)[0]
  return row ? feeOf(row, center) : null
}

// ── 요금표 출고지 매핑 ───────────────────────────────────────────
/**
 * 상품마스터 '요금표 출고지' 컬럼 → 출고지별 가격표 출고지명.
 * 컬럼이 비어 있으면 키가 없고, 그러면 운임은 '요금 미등록'으로 남는다
 * (임시 하드코딩 매핑을 두지 않는다 — 매핑의 단일 소스는 시트).
 */
export function priceOriginByShipFrom(products: ProductMaster[]): Partial<Record<ShipFrom, string>> {
  const out: Partial<Record<ShipFrom, string>> = {}
  for (const p of products) {
    const sf = shipFromOf(p)
    if (sf === '미분류') continue
    const v = String(p.priceShipFrom ?? '').trim()
    if (v && !out[sf]) out[sf] = v
  }
  return out
}

// ── 차량 구간 (가격표 라벨에서 직접 읽는다) ──────────────────────
export type VehicleTier = { tons: number; label: string; minPlt: number; maxPlt: number }

/** '1톤 (1~2pallet)' → {1, 2} · '2.5톤 (3pallet)' → {3, 3} */
const rangeOf = (label: string): { minPlt: number; maxPlt: number } | null => {
  const m = String(label).match(/(\d+)\s*(?:~\s*(\d+))?\s*pallet/i)
  if (!m) return null
  const a = Number(m[1])
  return { minPlt: a, maxPlt: m[2] ? Number(m[2]) : a }
}

/** 출고지의 차량 구간표 — 커버 PLT 오름차순. 시트 라벨이 기준이라 고정 경계가 없다 */
export function vehicleTiers(rows: CoupangMilkrunRow[], shipFrom: string): VehicleTier[] {
  const out: VehicleTier[] = []
  for (const r of rowsOf(rows, shipFrom, UNIT_VEHICLE)) {
    const range = rangeOf(r.label)
    if (range) out.push({ tons: r.tons, label: r.label, ...range })
  }
  return out.sort((a, b) => a.maxPlt - b.maxPlt)
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

// ── 운임 최저가 선택 (곰표·위킵 공통) ──────────────────────────
/**
 * 가격표의 두 방식을 매번 계산해 싼 쪽을 쓴다 — 고정 경계 없이 시트 값이 바뀌면 선택도 바뀐다.
 *   ① BASIC(1pt 당) × PLT   ② 해당 PLT 를 커버하는 차량 구간 요금
 * 진도팜(트럭)은 종전대로 차량 구간만 쓴다.
 */
export type FareChoice = {
  fee: number | null // 최저가. 두 방식 모두 요금이 없으면 null → '요금 미등록'
  method: string // 적용 방식 표기 ('BASIC×2' / '3.5톤 차량')
  basicFee: number | null // ① BASIC × PLT
  vehicleFee: number | null // ② 차량 구간
  vehicleLabel: string // 배정된 차량 ('3.5톤' / '8톤 + 1톤')
}

/** PLT → 차량 배정. 가격표 구간을 벗어나면 가장 큰 구간부터 나눠 싣는다 */
export function assignByTiers(tiers: VehicleTier[], plt: number): VehicleTier[] {
  if (!tiers.length || plt <= 0) return []
  const top = tiers[tiers.length - 1]
  const out: VehicleTier[] = []
  let left = plt
  while (left > top.maxPlt) {
    out.push(top)
    left -= top.maxPlt
  }
  const tier = tiers.find((t) => left <= t.maxPlt)
  if (tier) out.push(tier)
  return out
}

/** 합산 PLT 한 건의 운임 — ①BASIC×PLT 와 ②차량 구간 중 싼 쪽 */
export function chooseFare(
  prices: CoupangMilkrunRow[],
  priceShipFrom: string,
  center: string,
  plt: number,
): FareChoice {
  const basicUnit = lookupBasicFee(prices, priceShipFrom, center)
  const basicFee = basicUnit === null || plt <= 0 ? null : basicUnit * plt

  const vehicles = assignByTiers(vehicleTiers(prices, priceShipFrom), plt)
  const fees = vehicles.map((v) => lookupCoupangFee(prices, priceShipFrom, center, v.tons))
  const vehicleFee =
    vehicles.length === 0 || fees.some((f) => f === null)
      ? null
      : fees.reduce((a: number, b) => a + (b ?? 0), 0)
  const vehicleLabel = vehicles.map((v) => `${v.tons}톤`).join(' + ')

  const useBasic =
    basicFee !== null && (vehicleFee === null || basicFee <= vehicleFee)
  if (useBasic) {
    return { fee: basicFee, method: `BASIC×${plt}`, basicFee, vehicleFee, vehicleLabel }
  }
  if (vehicleFee !== null) {
    return { fee: vehicleFee, method: `${vehicleLabel} 차량`, basicFee, vehicleFee, vehicleLabel }
  }
  return { fee: null, method: '요금 미등록', basicFee, vehicleFee, vehicleLabel }
}

/** 센터 × 입고예정일 묶음 = 차량 1건(또는 분할 여러 대) */
export type MilkrunShipment = {
  key: string // `${shipFrom}|${center}|${dueDate}`
  shipFrom: ShipFrom
  center: string
  dueDate: string
  poNumbers: string[]
  plt: number
  vehicles: { tons: number; plt: number }[]
  vehicleLabel: string // '8톤 + 1톤'
  method: string // 적용 방식 — 진도팜은 차량 라벨, 위킵은 'BASIC×1' / '1톤'
  fee: number | null // 시트에 조합 요금 없으면 null → '요금 미등록'
}

/** 운임을 계산하는 출고지 — 곰표는 전용 모듈(coupangGompyo)에서 따로 센다 */
export const MILKRUN_SHIP_FROMS: ShipFrom[] = ['진도팜', '위킵']

export const vehicleLabelOf = (vs: { tons: number }[]): string =>
  vs.map((v) => `${v.tons}톤`).join(' + ')

/**
 * 진도팜·위킵 출고 + 팔레트 필요(9박스 초과) 발주를 출고지 × 센터 × 입고예정일로 묶어 운임 산정.
 * 9박스 이하는 택배라 운임 계산에서 제외한다. PLT 는 실측 적재 기준(pltCountOf).
 *
 * 요금 방식은 출고지마다 다르다 —
 *   진도팜: 차량 구간 요금 (종전 그대로)
 *   위킵  : 곰표와 같은 규칙 = min(BASIC 단가 × PLT, 차량 구간 요금)
 * 가격표 출고지명은 상품마스터 '요금표 출고지'(priceOrigin) 에서만 온다(하드코딩 없음).
 */
export function buildMilkrunShipments(
  groups: PoPalletGroup[],
  prices: CoupangMilkrunRow[],
  priceOrigin: Partial<Record<ShipFrom, string>>,
): MilkrunShipment[] {
  const map = new Map<string, MilkrunShipment>()
  for (const g of groups) {
    if (!MILKRUN_SHIP_FROMS.includes(g.shipFrom) || !g.needsPallet) continue
    const key = `${g.shipFrom}|${g.center}|${g.dueDate}`
    let s = map.get(key)
    if (!s) {
      s = {
        key,
        shipFrom: g.shipFrom,
        center: g.center,
        dueDate: g.dueDate,
        poNumbers: [],
        plt: 0,
        vehicles: [],
        vehicleLabel: '',
        method: '',
        fee: null,
      }
      map.set(key, s)
    }
    s.poNumbers.push(g.poNumber)
    s.plt += pltCountOf(g)
  }
  const list = [...map.values()]
  for (const s of list) {
    const origin = priceOrigin[s.shipFrom] ?? ''
    if (s.shipFrom === '진도팜') {
      s.vehicles = assignVehicles(s.plt)
      s.vehicleLabel = vehicleLabelOf(s.vehicles)
      s.method = s.vehicleLabel
      const fees = s.vehicles.map((v) => lookupCoupangFee(prices, origin, s.center, v.tons))
      s.fee = fees.some((f) => f === null) ? null : fees.reduce((a: number, b) => a + (b ?? 0), 0)
      continue
    }
    // 위킵 — 곰표와 같은 최저가 선택
    const fare = chooseFare(prices, origin, s.center, s.plt)
    s.vehicles = assignByTiers(vehicleTiers(prices, origin), s.plt).map((t) => ({
      tons: t.tons,
      plt: Math.min(s.plt, t.maxPlt),
    }))
    s.vehicleLabel = fare.vehicleLabel
    s.method = fare.method
    s.fee = fare.fee
  }
  return list.sort((a, b) =>
    a.dueDate === b.dueDate ? a.center.localeCompare(b.center) : a.dueDate.localeCompare(b.dueDate),
  )
}

/** 출고지별 차량 건수 — 하단 합계 문구용 */
export function countByShipFrom(shipments: MilkrunShipment[]): { shipFrom: ShipFrom; count: number }[] {
  return MILKRUN_SHIP_FROMS.map((sf) => ({
    shipFrom: sf,
    count: shipments.filter((s) => s.shipFrom === sf).length,
  })).filter((x) => x.count > 0)
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
