/**
 * 쿠팡 B2B — 개당 운임 (트럭 vs 택배) (순수 함수, 참고용).
 *
 * 밀크런 운임이 계산된 묶음(출고지 × 센터 × 입고예정일, 발주 합산 포함)마다
 *   트럭 1봉당 = 밀크런 운임 ÷ 총 봉수 · 택배 1봉당 = 택배 단가 ÷ 박스입수(입수별)
 *   손익분기 = 가격표 차량 구간을 작은 차부터 보고, 최소 박스(내림(운임 ÷ 택배 단가) + 1)가
 *             그 차 최대 적재 박스(최대 PLT × PLT당 박스) 이하인 첫 차량.
 * 행 펼침(진도팜 10~20박스)은 9박스로 줄일 때 뺄 박스·잃는 마진(트럭 운임 차감) 참고표.
 * 팔레트 비용은 진도팜 부담이라 계산에 넣지 않는다.
 * 팔레트 수·적재 구성도·밀크런 운임 계산은 건드리지 않는다 — 결과를 읽기만 한다.
 *
 * 기준정보 (나무_마스터, /api/b2b/sheets 가 내려줌. 금액은 부가세 포함):
 *   1봉 원가 = 단가DB '소포장 공급가' · 봉투 여부 = 단가DB '봉투'(Y만 봉투비)
 *   설정 탭 J~M '항목 | 값' 표 — 봉투 단가 · 쿠팡 박스 단가 · 쿠팡 택배 단가 (없으면 아래 기본값)
 */
import { norm, resolveCols, toNum } from './kurly'
import { PALLET_BOX_LIMIT, type RoutedItem, type ShipFrom, type ShipGroup } from './coupang'
import { lookupCoupangFee, vehicleTiers, type CoupangMilkrunRow } from './coupangMilkrun'

export const PARCEL_REVIEW_MIN_BOXES = PALLET_BOX_LIMIT + 1 // 10박스부터 검토
export const PARCEL_REVIEW_MAX_BOXES = 20
export const PARCEL_KEEP_BOXES = PALLET_BOX_LIMIT // 남길 박스 수 (택배 한도)
export const DEFAULT_BAG_FEE = 150 // 봉투 1봉
export const DEFAULT_BOX_FEE = 1495 // 쿠팡 납품 박스 1개 (입수 18·16·9 공통)
export const DEFAULT_PARCEL_FEE = 4000 // 택배 1박스 (무게·크기 구분 없음)
/** PLT 1장 최대 박스 — 손익분기 차량의 최대 적재 박스 = 최대 PLT × 이 값 */
export const BOXES_PER_PLT: Partial<Record<ShipFrom, number>> = { 진도팜: 30, 곰표: 40 }

// 설정 탭 항목명
export const SETTING_BAG_FEE = '봉투 단가'
export const SETTING_BOX_FEE = '쿠팡 박스 단가'
export const SETTING_PARCEL_FEE = '쿠팡 택배 단가'

export type UnitCost = { cost: number; bag: boolean } // 1봉 원가 · 봉투비 적용 여부

/** 단가DB rows(헤더 포함) → 별칭(정규화) → 1봉 원가(소포장 공급가)·봉투 Y/N. 원가 0·빈칸 행은 뺀다 */
export function parseUnitCostByAlias(rows: unknown[][]): Record<string, UnitCost> {
  if (!rows.length) return {}
  const c = resolveCols(rows[0], { alias: ['별칭'], cost: ['소포장 공급가'], bag: ['봉투'] })
  const out: Record<string, UnitCost> = {}
  if (c.alias < 0 || c.cost < 0) return out
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const key = norm(r[c.alias])
    const cost = toNum(r[c.cost])
    if (!key || cost <= 0 || key in out) continue
    out[key] = { cost, bag: c.bag >= 0 ? norm(r[c.bag]) === 'y' : true }
  }
  return out
}

/** 설정 탭 '항목 | 값' 표에서 항목 값. 항목이 없거나 값이 비면 null */
export function settingValue(rows: unknown[][], label: string): number | null {
  const want = norm(label)
  for (const r of rows) {
    const i = (r || []).findIndex((v) => norm(v) === want)
    if (i >= 0) return String(r[i + 1] ?? '').trim() === '' ? null : toNum(r[i + 1])
  }
  return null
}

export type ParcelSettings = {
  bagFee: number | null
  boxFee: number | null
  parcelFee: number | null
}

export function parseParcelSettings(rows: unknown[][]): ParcelSettings {
  return {
    bagFee: settingValue(rows, SETTING_BAG_FEE),
    boxFee: settingValue(rows, SETTING_BOX_FEE),
    parcelFee: settingValue(rows, SETTING_PARCEL_FEE),
  }
}

export type ParcelLine = {
  item: RoutedItem
  label: string // 별칭(없으면 상품명)
  boxQty: number // 박스입수
  boxes: number
  boxMargin: number // 1박스 마진(트럭 기준, 원 단위 반올림) — 봉투·박스비·트럭 1봉당 운임 차감
  lostSales: number // 잃는 매출 = 공급단가 × 입수 × 박스 (drop 행만 의미)
}

const parcelUnitOf = (s: ParcelSettings) => s.parcelFee ?? DEFAULT_PARCEL_FEE

// ── 개당 운임 (표 칸) ─────────────────────────────────────────────
export type FreightCompare = {
  bags: number // 총 봉수(납품가능수량 합)
  boxes: number // 총 박스
  truckFee: number
  truckPerBag: number
  parcelPerBag: { boxQty: number; perBag: number }[] // 입수 큰 순
  // 손익분기 — null 이면 어느 차량도 안 됨(트럭이 항상 불리). undefined 면 PLT당 박스 기준 없음
  breakeven: { boxes: number; bags: number; vehicle: string } | null | undefined
}

/**
 * 밀크런 한 건(합산 발주 포함)의 개당 운임 비교. groups 는 그 건에 속한 묶음 전부.
 */
export function compareFreight(
  groups: ShipGroup[],
  truckFee: number,
  prices: CoupangMilkrunRow[],
  priceShipFrom: string,
  center: string,
  settings: ParcelSettings,
): FreightCompare {
  const parcelUnit = parcelUnitOf(settings)
  const items = groups.flatMap((g) => g.items)
  const bags = items.reduce((sum, it) => sum + it.confirmQty, 0)
  const boxes = groups.reduce((sum, g) => sum + g.boxes, 0)
  const qtys = [...new Set(items.filter((it) => it.boxes && it.master?.boxQty).map((it) => it.master!.boxQty))]
  const parcelPerBag = qtys.sort((a, b) => b - a).map((q) => ({ boxQty: q, perBag: parcelUnit / q }))

  let breakeven: FreightCompare['breakeven']
  const perPlt = BOXES_PER_PLT[groups[0]?.shipFrom]
  if (perPlt) {
    breakeven = null
    const avgQty = boxes > 0 ? Math.round(bags / boxes) : 0
    for (const t of vehicleTiers(prices, priceShipFrom)) {
      const fee = lookupCoupangFee(prices, priceShipFrom, center, t.tons)
      if (fee === null) continue
      const minBoxes = Math.floor(fee / parcelUnit) + 1
      if (minBoxes <= t.maxPlt * perPlt) {
        breakeven = { boxes: minBoxes, bags: minBoxes * avgQty, vehicle: `${t.tons}톤` }
        break
      }
    }
  }
  return { bags, boxes, truckFee, truckPerBag: bags > 0 ? truckFee / bags : 0, parcelPerBag, breakeven }
}

/** 표 '개당 운임 (트럭 vs 택배)' 칸 문구 */
export function freightCompareText(f: FreightCompare): string {
  const won = (n: number) => Math.round(n).toLocaleString('ko-KR')
  const parcel =
    f.parcelPerBag.length === 1
      ? won(f.parcelPerBag[0].perBag)
      : f.parcelPerBag.map((p) => `${won(p.perBag)}(${p.boxQty}입)`).join('·')
  const head = `트럭 ${won(f.truckPerBag)} vs 택배 ${parcel}원/봉`
  if (f.breakeven === undefined) return head
  if (f.breakeven === null) return `${head} · 트럭이 항상 불리`
  const b = f.breakeven
  return `${head} · ${won(b.boxes)}박스(${won(b.bags)}봉)↑부터 트럭 유리 (${b.vehicle})`
}

// ── 행 펼침 — 9박스로 줄일 때 (참고) ───────────────────────────────
export type ParcelReview =
  | { status: 'na' } // 검토 대상 아님
  | { status: 'error'; reason: string } // 대상이지만 계산 제외
  | {
      status: 'ok'
      truckPerBag: number
      keep: ParcelLine[] // 남길 박스(상품별)
      drop: ParcelLine[] // 뺄 박스(상품별)
      lostSales: number // 잃는 매출 합계
      lost: number // 잃는 마진 합계
    }

export type ParcelOptions = {
  unitCostByAlias: Record<string, UnitCost>
  settings: ParcelSettings
}

export const isParcelReviewTarget = (g: ShipGroup): boolean =>
  g.shipFrom === '진도팜' && g.boxes >= PARCEL_REVIEW_MIN_BOXES && g.boxes <= PARCEL_REVIEW_MAX_BOXES

/**
 * truckPerBag 이 null 이면(운임 미등록) 계산하지 않는다.
 */
export function reviewParcel(g: ShipGroup, truckPerBag: number | null, o: ParcelOptions): ParcelReview {
  if (!isParcelReviewTarget(g)) return { status: 'na' }
  const s = o.settings
  const bagFee = s.bagFee ?? DEFAULT_BAG_FEE
  const boxFee = s.boxFee ?? DEFAULT_BOX_FEE

  const items = g.items.filter((it) => it.boxes)
  if (items.some((it) => norm(it.master?.taxType) === norm('과세'))) {
    return { status: 'error', reason: '과세 상품 포함 — 계산 제외' }
  }
  if (truckPerBag === null) return { status: 'error', reason: '밀크런 운임 없음' }
  const lines: ParcelLine[] = []
  for (const it of items) {
    const m = it.master
    const label = m?.alias || it.productName
    const uc = m ? o.unitCostByAlias[norm(m.alias)] : undefined
    if (!m || !uc) return { status: 'error', reason: `원가 미등록: ${label}` }
    if (it.unitPrice <= 0) return { status: 'error', reason: `공급단가 없음: ${label}` }
    lines.push({
      item: it,
      label,
      boxQty: m.boxQty,
      boxes: it.boxes!,
      // 원 단위로 먼저 반올림 — 화면의 1박스 마진 × 뺀 박스 = 잃는 마진이 그대로 맞게
      boxMargin: Math.round(
        (it.unitPrice - uc.cost - (uc.bag ? bagFee : 0)) * m.boxQty - boxFee - truckPerBag * m.boxQty,
      ),
      lostSales: 0,
    })
  }

  // 9박스만 남기고 1박스 마진 낮은 상품부터 뺀다 (같으면 박스 수 많은 상품부터)
  const order = [...lines].sort((a, b) => a.boxMargin - b.boxMargin || b.boxes - a.boxes)
  let toDrop = lines.reduce((sum, l) => sum + l.boxes, 0) - PARCEL_KEEP_BOXES
  const dropBy = new Map<ParcelLine, number>()
  for (const l of order) {
    if (toDrop <= 0) break
    const n = Math.min(l.boxes, toDrop)
    dropBy.set(l, n)
    toDrop -= n
  }
  const keep: ParcelLine[] = []
  const drop: ParcelLine[] = []
  for (const l of order) {
    const d = dropBy.get(l) ?? 0
    if (d > 0) drop.push({ ...l, boxes: d, lostSales: l.item.unitPrice * l.boxQty * d })
    if (l.boxes - d > 0) keep.push({ ...l, boxes: l.boxes - d })
  }
  return {
    status: 'ok',
    truckPerBag,
    keep,
    drop,
    lostSales: drop.reduce((sum, l) => sum + l.lostSales, 0),
    lost: drop.reduce((sum, l) => sum + l.boxMargin * l.boxes, 0),
  }
}
