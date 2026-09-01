/**
 * 쿠팡 곰표 출고분 — 팔레트 산정 + 밀크런 운임 최저가 선택 + 상차 안내문.
 *
 * 곰표는 전 발주 밀크런이라 택배/트럭 판정이 없고, 팔레트는 박스가 아니라
 * **봉 수**로 센다(1PLT = 400봉 = 40박스). 같은 센터·같은 입고예정일 발주는
 * 합산해 한 건으로 묶는다.
 *
 * 운임은 가격표의 두 방식을 매번 계산해 싼 쪽을 쓴다 — 고정 경계 없이
 * 시트 값이 바뀌면 선택도 따라 바뀐다.
 *   ① BASIC(1pt 당) × PLT
 *   ② 해당 PLT 를 커버하는 차량 구간 요금 (구간은 가격표 라벨에서 읽는다)
 *
 * 파싱·출고지 분기·진도팜 로켓 양식·위킵 라벨 로직은 소비만 하고 건드리지 않는다.
 */
import { GOMPYO_BOXES_PER_PLT, GOMPYO_UNITS_PER_PLT, gompyoPltOf, type RoutedItem } from './coupang'
import {
  chooseFare,
  type CoupangMilkrunRow,
  type FareChoice,
} from './coupangMilkrun'

export { chooseFare, type FareChoice } // 단일 소스: lib/b2b/coupangMilkrun.ts

// ── 센터 × 입고예정일 묶음 ───────────────────────────────────────
export type GompyoShipment = {
  key: string // `${center}|${dueDate}`
  center: string
  dueDate: string
  poNumbers: string[]
  items: RoutedItem[]
  units: number // 납품가능수량 합 (봉)
  boxes: number // 박스 합 (마스터 미등록 행은 0)
  plt: number
  fare: FareChoice
}

const EMPTY_FARE: FareChoice = {
  fee: null,
  method: '요금 미등록',
  basicFee: null,
  vehicleFee: null,
  vehicleLabel: '',
}

/**
 * 곰표 출고 행 → 센터·입고예정일 묶음. PLT 는 봉 수 합에서 올림한다.
 * priceShipFrom 이 비면(상품마스터 '요금표 출고지' 미입력) 운임은 전부 '요금 미등록'.
 */
export function buildGompyoShipments(
  items: RoutedItem[],
  prices: CoupangMilkrunRow[],
  priceShipFrom: string,
): GompyoShipment[] {
  const map = new Map<string, GompyoShipment>()
  for (const it of items) {
    const key = `${it.center}|${it.dueDate}`
    let s = map.get(key)
    if (!s) {
      s = {
        key,
        center: it.center,
        dueDate: it.dueDate,
        poNumbers: [],
        items: [],
        units: 0,
        boxes: 0,
        plt: 0,
        fare: EMPTY_FARE,
      }
      map.set(key, s)
    }
    s.items.push(it)
    if (!s.poNumbers.includes(it.poNumber)) s.poNumbers.push(it.poNumber)
    s.units += it.confirmQty
    s.boxes += it.boxes ?? 0
  }
  const list = [...map.values()]
  for (const s of list) {
    s.plt = gompyoPltOf(s.units)
    s.fare = priceShipFrom
      ? chooseFare(prices, priceShipFrom, s.center, s.plt)
      : EMPTY_FARE
  }
  return list.sort((a, b) =>
    a.dueDate === b.dueDate ? a.center.localeCompare(b.center) : a.dueDate.localeCompare(b.dueDate),
  )
}

export type GompyoTotals = { totalPlt: number; totalUnits: number; totalFee: number; unpriced: number }

export function sumGompyo(shipments: GompyoShipment[]): GompyoTotals {
  return {
    totalPlt: shipments.reduce((a, s) => a + s.plt, 0),
    totalUnits: shipments.reduce((a, s) => a + s.units, 0),
    totalFee: shipments.reduce((a, s) => a + (s.fare.fee ?? 0), 0),
    unpriced: shipments.filter((s) => s.fare.fee === null).length,
  }
}

// ── 상차 안내문 ──────────────────────────────────────────────────
const num = (n: number) => n.toLocaleString('ko-KR')

/** 입고예정일별 블록 — 곰표에 그대로 붙여넣는 상차 안내 */
export function buildGompyoNotice(shipments: GompyoShipment[]): string {
  const dates = [...new Set(shipments.map((s) => s.dueDate))]
  return dates
    .map((date) => {
      const day = shipments.filter((s) => s.dueDate === date)
      const plt = day.reduce((a, s) => a + s.plt, 0)
      const units = day.reduce((a, s) => a + s.units, 0)
      const boxes = day.reduce((a, s) => a + s.boxes, 0)
      const lines = day.flatMap((s) =>
        s.items.map(
          (it) =>
            `${s.center} (발주 ${it.poNumber}) - ${it.master?.alias || it.productName} ` +
            `${num(it.confirmQty)}봉(${num(it.boxes ?? 0)}박스)`,
        ),
      )
      return [
        `[쿠팡 로켓 ${date} 입고 — 곰표 상차 안내]`,
        `총 ${num(plt)}PLT (${num(units)}봉/${num(boxes)}박스) 밀크런 상차 부탁드립니다.`,
        ...lines,
        `※ 1팔레트 = ${GOMPYO_UNITS_PER_PLT}봉(${GOMPYO_BOXES_PER_PLT}박스) / ※ 밀크런 접수 D-1 16:00`,
      ].join('\n')
    })
    .join('\n\n')
}
