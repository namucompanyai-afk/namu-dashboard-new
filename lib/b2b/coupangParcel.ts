/**
 * 쿠팡 B2B — 택배 전환 검토 (순수 함수, 참고용).
 *
 * 진도팜 출고 · 박스 10~20개 묶음을 9박스로 줄여 택배로 보낼 때
 *   아끼는 운임(밀크런 운임 − 남는 9박스 택배비) vs 잃는 마진(뺀 박스 1박스 마진 합계)을 비교한다.
 * 팔레트 수·적재 구성도·밀크런 운임 계산은 건드리지 않는다 — 결과를 읽기만 한다.
 *
 * 기준정보 (나무_마스터, /api/b2b/sheets 가 내려줌):
 *   1봉 원가 = 단가DB '소포장 공급가' · 봉투 여부 = 단가DB '봉투'(Y만 봉투비)
 *   봉투비 = 설정 '봉투 단가' (없으면 150) · 택배 소/중/대 = 진도팜 원가표 '규격'·'택배' 표
 */
import { norm, resolveCols, toNum } from './kurly'
import { PALLET_BOX_LIMIT, unitKgOf, type RoutedItem, type ShipGroup } from './coupang'

export const PARCEL_REVIEW_MIN_BOXES = PALLET_BOX_LIMIT + 1 // 10박스부터 검토
export const PARCEL_REVIEW_MAX_BOXES = 20
export const PARCEL_KEEP_BOXES = PALLET_BOX_LIMIT // 남길 박스 수 (택배 한도)
export const DEFAULT_BAG_FEE = 150 // 시트에 봉투 단가가 없을 때
// 진도팜 원가표에 무게 구간이 없어 고정 구간으로 크기를 정한다 (kg 이하)
export const PARCEL_SIZE_KG: { size: ParcelSize; maxKg: number }[] = [
  { size: '소', maxKg: 3 },
  { size: '중', maxKg: 10 },
  { size: '대', maxKg: 20 },
]

export type ParcelSize = '소' | '중' | '대'
export type ParcelFees = Partial<Record<ParcelSize, number>>
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

/** 설정 탭 '항목 | 값' 표에서 '봉투 단가' 값. 못 찾으면 null */
export function parseBagFee(rows: unknown[][]): number | null {
  const want = norm('봉투 단가')
  for (const r of rows) {
    const i = (r || []).findIndex((v) => norm(v) === want)
    if (i >= 0) {
      const v = toNum(r[i + 1])
      return v > 0 ? v : null
    }
  }
  return null
}

/** 진도팜 원가표 상단 참고표('규격 | 박스 | 택배') → 소/중/대 택배 단가 */
export function parseParcelFees(rows: unknown[][]): ParcelFees {
  const out: ParcelFees = {}
  for (let i = 0; i < rows.length; i++) {
    const h = (rows[i] || []).map(norm)
    const sc = h.indexOf(norm('규격'))
    const fc = h.indexOf(norm('택배'))
    if (sc < 0 || fc < 0) continue
    for (let j = i + 1; j < rows.length; j++) {
      const size = String(rows[j]?.[sc] ?? '').trim()
      if (size !== '소' && size !== '중' && size !== '대') continue
      const fee = toNum(rows[j]?.[fc])
      if (fee > 0) out[size] = fee
    }
    break
  }
  return out
}

export const parcelSizeOf = (kg: number): ParcelSize | null =>
  PARCEL_SIZE_KG.find((s) => kg <= s.maxKg)?.size ?? null

export type ParcelLine = {
  item: RoutedItem
  label: string // 별칭(없으면 상품명)
  boxes: number
  boxMargin: number // 1박스 마진
  boxKg: number | null // 1박스 무게
  size: ParcelSize | null
}

export type ParcelReview =
  | { status: 'na' } // 검토 대상 아님
  | { status: 'error'; reason: string } // 대상이지만 계산 불가
  | {
      status: 'ok'
      keep: ParcelLine[] // 남길 박스(상품별)
      drop: ParcelLine[] // 뺄 박스(상품별)
      parcelFee: number // 남는 9박스 택배비 합계
      truckFee: number // 그 행의 밀크런 운임
      saved: number // 아끼는 운임
      lost: number // 잃는 마진
      parcelWins: boolean
      diff: number // |saved − lost|
    }

export type ParcelOptions = {
  unitCostByAlias: Record<string, UnitCost>
  bagFee: number | null
  parcelFees: ParcelFees
  gramByAlias: Record<string, number>
}

export const isParcelReviewTarget = (g: ShipGroup): boolean =>
  g.shipFrom === '진도팜' && g.boxes >= PARCEL_REVIEW_MIN_BOXES && g.boxes <= PARCEL_REVIEW_MAX_BOXES

/**
 * 1박스 마진 = (발주서 공급단가 − 1봉 원가 − 봉투비) × 박스입수.
 * 마진 낮은 상품부터 빼서 9박스만 남긴다 (같으면 박스 수 많은 상품부터).
 * truckFee 가 null 이면(운임 미등록·합산 발주) 계산하지 않는다.
 */
export function reviewParcel(g: ShipGroup, truckFee: number | null, o: ParcelOptions): ParcelReview {
  if (!isParcelReviewTarget(g)) return { status: 'na' }
  if (truckFee === null) return { status: 'error', reason: '밀크런 운임 없음' }
  const bagFee = o.bagFee ?? DEFAULT_BAG_FEE

  const lines: ParcelLine[] = []
  for (const it of g.items) {
    if (!it.boxes) continue
    const m = it.master
    const label = m?.alias || it.productName
    const uc = m ? o.unitCostByAlias[norm(m.alias)] : undefined
    if (!m || !uc) return { status: 'error', reason: `원가 미등록: ${label}` }
    if (it.unitPrice <= 0) return { status: 'error', reason: `공급단가 없음: ${label}` }
    const unitKg = unitKgOf(m.alias, it.productName, o.gramByAlias)
    const boxKg = unitKg === null ? null : unitKg * m.boxQty
    lines.push({
      item: it,
      label,
      boxes: it.boxes,
      boxMargin: (it.unitPrice - uc.cost - (uc.bag ? bagFee : 0)) * m.boxQty,
      boxKg,
      size: boxKg === null ? null : parcelSizeOf(boxKg),
    })
  }

  // 빼는 순서: 1박스 마진 오름차순, 같으면 박스 수 많은 상품부터
  const order = [...lines].sort((a, b) => a.boxMargin - b.boxMargin || b.boxes - a.boxes)
  let toDrop = lines.reduce((s, l) => s + l.boxes, 0) - PARCEL_KEEP_BOXES
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

  let parcelFee = 0
  for (const l of keep) {
    if (l.boxKg === null) return { status: 'error', reason: `무게 미확인: ${l.label}` }
    if (l.size === null) return { status: 'error', reason: `택배 불가 (${l.label} 1박스 ${l.boxKg}kg · 20kg 초과)` }
    const fee = o.parcelFees[l.size]
    if (!fee) return { status: 'error', reason: `택배 ${l.size} 단가 없음` }
    parcelFee += fee * l.boxes
  }
  const saved = truckFee - parcelFee
  const lost = drop.reduce((s, l) => s + l.boxMargin * l.boxes, 0)
  return {
    status: 'ok',
    keep,
    drop,
    parcelFee,
    truckFee,
    saved,
    lost,
    parcelWins: saved > lost,
    diff: Math.abs(saved - lost),
  }
}
