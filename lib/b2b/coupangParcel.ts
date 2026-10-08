/**
 * 쿠팡 B2B — 택배 전환 검토 (순수 함수, 참고용).
 *
 * 진도팜 출고 · 박스 10~20개 묶음을 트럭(밀크런) 대신 택배로 보낼 수 있는지 본다.
 *   1단계: 1봉당 운임 비교 — 트럭 밀크런 운임 ÷ 총 봉수 vs 택배 (박스 수 × 택배 단가) ÷ 총 봉수.
 *          트럭이 같거나 싸면 "트럭 유리 (1봉당 운임이 더 쌈)"으로 끝.
 *   2단계: 트럭이 더 비쌀 때만 — 택배는 9박스까지라 마진 낮은 상품부터 빼고,
 *          아끼는 비용(밀크런 운임 − 9박스 택배비) vs 잃는 마진(뺀 박스 1박스 마진 합계).
 * 팔레트 비용은 진도팜 부담이라 계산에 넣지 않는다.
 * 팔레트 수·적재 구성도·밀크런 운임 계산은 건드리지 않는다 — 결과를 읽기만 한다.
 *
 * 기준정보 (나무_마스터, /api/b2b/sheets 가 내려줌. 금액은 부가세 포함):
 *   1봉 원가 = 단가DB '소포장 공급가' · 봉투 여부 = 단가DB '봉투'(Y만 봉투비)
 *   설정 탭 J~M '항목 | 값' 표 — 봉투 단가 · 쿠팡 박스 단가 · 쿠팡 택배 단가 (없으면 아래 기본값)
 */
import { norm, resolveCols, toNum } from './kurly'
import { PALLET_BOX_LIMIT, type RoutedItem, type ShipGroup } from './coupang'

export const PARCEL_REVIEW_MIN_BOXES = PALLET_BOX_LIMIT + 1 // 10박스부터 검토
export const PARCEL_REVIEW_MAX_BOXES = 20
export const PARCEL_KEEP_BOXES = PALLET_BOX_LIMIT // 남길 박스 수 (택배 한도)
export const DEFAULT_BAG_FEE = 150 // 봉투 1봉
export const DEFAULT_BOX_FEE = 1495 // 쿠팡 납품 박스 1개 (입수 18·16·9 공통)
export const DEFAULT_PARCEL_FEE = 4000 // 택배 1박스 (무게·크기 구분 없음)

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
  boxes: number
  boxMargin: number // 1박스 마진 (봉투·박스비 차감, 운송비 미차감)
}

export type ParcelReview =
  | { status: 'na' } // 검토 대상 아님
  | { status: 'error'; reason: string } // 대상이지만 계산 제외
  | {
      status: 'ok'
      bags: number // 그 행 총 봉수
      truckFee: number // 밀크런 운임
      truckPerBag: number
      parcelPerBag: number
      truckCheaper: boolean // 1단계에서 트럭이 같거나 쌈 → 2단계 없음
      stage2: null | {
        keep: ParcelLine[] // 남길 박스(상품별)
        drop: ParcelLine[] // 뺄 박스(상품별)
        parcelFee: number // 남는 9박스 택배비
        saved: number // 아끼는 비용
        lost: number // 잃는 마진
        parcelWins: boolean
        diff: number // |saved − lost|
      }
    }

export type ParcelOptions = {
  unitCostByAlias: Record<string, UnitCost>
  settings: ParcelSettings
}

export const isParcelReviewTarget = (g: ShipGroup): boolean =>
  g.shipFrom === '진도팜' && g.boxes >= PARCEL_REVIEW_MIN_BOXES && g.boxes <= PARCEL_REVIEW_MAX_BOXES

/** 표 '택배 전환' 칸 문구 */
export function parcelVerdictText(r: ParcelReview): string {
  if (r.status === 'na') return '—'
  if (r.status === 'error') return r.reason
  if (!r.stage2) return '트럭 유리 (1봉당 운임이 더 쌈)'
  return `${r.stage2.parcelWins ? '택배가' : '트럭이'} ${r.stage2.diff.toLocaleString('ko-KR')}원 유리`
}

/**
 * truckFee 가 null 이면(운임 미등록·합산 발주) 계산하지 않는다.
 */
export function reviewParcel(g: ShipGroup, truckFee: number | null, o: ParcelOptions): ParcelReview {
  if (!isParcelReviewTarget(g)) return { status: 'na' }
  const s = o.settings
  const bagFee = s.bagFee ?? DEFAULT_BAG_FEE
  const boxFee = s.boxFee ?? DEFAULT_BOX_FEE
  const parcelUnit = s.parcelFee ?? DEFAULT_PARCEL_FEE

  const items = g.items.filter((it) => it.boxes)
  if (items.some((it) => norm(it.master?.taxType) === norm('과세'))) {
    return { status: 'error', reason: '과세 상품 포함 — 계산 제외' }
  }
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
      boxes: it.boxes!,
      boxMargin: (it.unitPrice - uc.cost - (uc.bag ? bagFee : 0)) * m.boxQty - boxFee,
    })
  }
  if (truckFee === null) return { status: 'error', reason: '밀크런 운임 없음' }

  // 1단계 — 1봉당 운임
  const bags = items.reduce((sum, it) => sum + it.confirmQty, 0)
  const totalBoxes = lines.reduce((sum, l) => sum + l.boxes, 0)
  const base = {
    status: 'ok' as const,
    bags,
    truckFee,
    truckPerBag: bags > 0 ? truckFee / bags : 0,
    parcelPerBag: bags > 0 ? (totalBoxes * parcelUnit) / bags : 0,
  }
  if (base.truckPerBag <= base.parcelPerBag) return { ...base, truckCheaper: true, stage2: null }

  // 2단계 — 9박스만 남기고 1박스 마진 낮은 상품부터 뺀다 (같으면 박스 수 많은 상품부터)
  const order = [...lines].sort((a, b) => a.boxMargin - b.boxMargin || b.boxes - a.boxes)
  let toDrop = totalBoxes - PARCEL_KEEP_BOXES
  const dropBy = new Map<ParcelLine, number>()
  for (const l of order) {
    if (toDrop <= 0) break
    const n = Math.min(l.boxes, toDrop)
    dropBy.set(l, n)
    toDrop -= n
  }
  const keep: ParcelLine[] = []
  const drop: ParcelLine[] = []
  for (const l of lines) {
    const d = dropBy.get(l) ?? 0
    if (d > 0) drop.push({ ...l, boxes: d })
    if (l.boxes - d > 0) keep.push({ ...l, boxes: l.boxes - d })
  }
  const parcelFee = keep.reduce((sum, l) => sum + l.boxes, 0) * parcelUnit
  const saved = truckFee - parcelFee
  const lost = drop.reduce((sum, l) => sum + l.boxMargin * l.boxes, 0)
  return {
    ...base,
    truckCheaper: false,
    stage2: { keep, drop, parcelFee, saved, lost, parcelWins: saved - lost > 0, diff: Math.abs(saved - lost) },
  }
}
