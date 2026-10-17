/**
 * 쿠팡 곰표 출고분 — 팔레트 산정 + 밀크런 운임 최저가 선택 + 상차 안내문.
 *
 * 곰표는 전 발주 밀크런. 같은 센터·같은 입고예정일 발주는 합산해 한 건으로 묶고,
 * 묶음 박스 합이 9박스(PALLET_BOX_LIMIT) 이하면 **밀크런택배**(박스 단위, 팔레트 없음),
 * 넘거나 박스입수 미등록 행이 섞이면 밀크런 트럭(팔레트) (2026-10-16 대표 결정 — 이전엔 트럭만).
 * 곰표 박스 450×280×240mm(세변합 970) · 9개입 18kg → 밀크런택배 1호 규격(1,000mm·20kg) 안.
 * 트럭분 팔레트는 박스가 아니라 **봉 수**로 센다(1PLT = 360봉 = 40박스 × 9개입).
 *
 * 밀크런택배 운임 = 박스 수 × 입고택배 곰표 단가(설정 탭, 부가세 포함).
 * 트럭 운임은 가격표의 두 방식을 매번 계산해 싼 쪽을 쓴다 — 고정 경계 없이
 * 시트 값이 바뀌면 선택도 따라 바뀐다.
 *   ① BASIC(1pt 당) × PLT
 *   ② 해당 PLT 를 커버하는 차량 구간 요금 (구간은 가격표 라벨에서 읽는다)
 *
 * 곰표는 엑셀 없이 카톡 전달 멘트로만 넘긴다(buildGompyoMessage).
 * 파싱·출고지 분기·진도팜 로켓 양식·위킵 라벨 로직은 소비만 하고 건드리지 않는다.
 */
import { findCenter, formatKrPhone, gompyoPltOf, PALLET_BOX_LIMIT, type CenterAddress, type RoutedItem } from './coupang'
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
  boxesKnown: boolean // 박스입수 미등록 행(boxes=null)이 섞이면 false → 트럭으로 본다
  parcel: boolean // 밀크런택배 (박스 합 9 이하, 박스 수를 다 알 때)
  plt: number // 트럭분만. 밀크런택배는 0
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
 * 곰표 출고 행 → 센터·입고예정일 묶음. 9박스 이하는 밀크런택배(박스 × parcelFee),
 * 나머지는 트럭 — PLT 는 봉 수 합에서 올림한다.
 * priceShipFrom 이 비면(상품마스터 '요금표 출고지' 미입력) 트럭 운임은 '요금 미등록'.
 */
export function buildGompyoShipments(
  items: RoutedItem[],
  prices: CoupangMilkrunRow[],
  priceShipFrom: string,
  parcelFee: number,
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
        boxesKnown: true,
        parcel: false,
        plt: 0,
        fare: EMPTY_FARE,
      }
      map.set(key, s)
    }
    s.items.push(it)
    if (!s.poNumbers.includes(it.poNumber)) s.poNumbers.push(it.poNumber)
    s.units += it.confirmQty
    s.boxes += it.boxes ?? 0
    if (it.boxes === null && it.confirmQty > 0) s.boxesKnown = false
  }
  const list = [...map.values()]
  for (const s of list) {
    s.parcel = s.boxesKnown && s.boxes > 0 && s.boxes <= PALLET_BOX_LIMIT
    if (s.parcel) {
      s.plt = 0
      s.fare = { ...EMPTY_FARE, fee: s.boxes * parcelFee, method: '밀크런택배' }
      continue
    }
    s.plt = gompyoPltOf(s.units)
    s.fare = priceShipFrom
      ? chooseFare(prices, priceShipFrom, s.center, s.plt)
      : EMPTY_FARE
  }
  return list.sort((a, b) =>
    a.dueDate === b.dueDate ? a.center.localeCompare(b.center) : a.dueDate.localeCompare(b.dueDate),
  )
}

export type GompyoTotals = {
  totalPlt: number
  totalUnits: number
  totalFee: number
  truckFee: number // 밀크런 트럭분 운임 합
  parcelFee: number // 밀크런택배분 운임 합
  parcelCount: number // 밀크런택배 건수
  unpriced: number
}

export function sumGompyo(shipments: GompyoShipment[]): GompyoTotals {
  const fee = (list: GompyoShipment[]) => list.reduce((a, s) => a + (s.fare.fee ?? 0), 0)
  const parcel = shipments.filter((s) => s.parcel)
  const truck = shipments.filter((s) => !s.parcel)
  return {
    totalPlt: shipments.reduce((a, s) => a + s.plt, 0),
    totalUnits: shipments.reduce((a, s) => a + s.units, 0),
    totalFee: fee(shipments),
    truckFee: fee(truck),
    parcelFee: fee(parcel),
    parcelCount: parcel.length,
    unpriced: shipments.filter((s) => s.fare.fee === null).length,
  }
}

// ── 전달 멘트 (카톡) ─────────────────────────────────────────────
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** 'YYYY-MM-DD' → '10월 12일' (미지정 '○월 ○일') */
const mdOf = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : '○월 ○일'
}
/** 'YYYY-MM-DD' → '월' (미지정 '○') */
const weekdayOf = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : '○'
}

/** 별칭에서 [브랜드]·용량·원산지(…산) 를 뺀 짧은 이름. 남는 게 없으면 별칭 그대로 */
export function gompyoShortName(alias: string): string {
  const short = String(alias || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:kg|g|ml|l|개|입|봉)\b/gi, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^\S+산$/.test(w))
    .join(' ')
    .trim()
  return short || String(alias || '').trim()
}

/**
 * 곰표 전달 멘트 — 하차지(센터 × 입고예정일)마다 블록. 상차일은 대표 지정값, 제조일자는 확정 발주서 값 우선
 * (없으면 대표 지정값, 둘 다 없으면 ○).
 * 주소·전화는 트럭 규칙(발주서 주소 → 없으면 주소록), 우편번호는 주소록 '밀크런 우편번호'.
 */
export function buildGompyoMessage(
  shipments: GompyoShipment[],
  o: { loadDate: string; madeDate: string; centers: CenterAddress[] },
): string {
  const totalPlt = shipments.reduce((a, s) => a + s.plt, 0)
  const load = mdOf(o.loadDate)
  return shipments
    .map((s) => {
      const c = findCenter(o.centers, s.center)
      const first = s.items[0]
      const names = [...new Set(s.items.map((it) => gompyoShortName(it.master?.alias || it.productName)))].join('·')
      const address = first?.centerAddress || c?.address || ''
      const phone = formatKrPhone(first?.centerPhone || c?.phone || '')
      return [
        `${load} ${names} 상차건`,
        `상차일 ${load} ${weekdayOf(o.loadDate)}요일`,
        `제조일자 ${mdOf(s.items.find((it) => it.madeDate)?.madeDate || o.madeDate)}`,
        s.parcel
          ? `수량 밀크런택배 ${s.boxes}박스 / ${s.units}봉`
          : `수량 ${s.plt}P /  ${s.units}봉 ${s.boxes}박스 / 총 ${totalPlt}P`,
        `하차지 : ${s.center}`,
        '',
        `주소   ${address}`,
        `우편번호   ${c?.truckZip ?? ''}`,
        `전화번호   ${phone}`,
      ].join('\n')
    })
    .join('\n\n')
}
