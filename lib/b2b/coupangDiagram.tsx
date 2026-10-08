/**
 * 쿠팡 팔레트 필요 안내 + 적재 구성도 (SVG).
 *
 * 컬리 도면(lib/b2b/kurlyDiagram.tsx)과 같은 구성이되, 쿠팡은 운송비 계산이 없다.
 * 적재는 상품마스터 실측 박스 치수로 1,100×1,100 바닥 자리를 계산하고,
 * 한 자리에 한 SKU만 올린다(SKU별 더미 분리). 자리가 차면 다음 PLT 로 넘긴다.
 * 파싱·분기·로켓 양식·매출·이력·라벨·운임 로직은 소비만 한다.
 */
import React from 'react'
import { maxTiersOf as tiersByHeight, norm } from './kurly'
import {
  PALLET_BOX_LIMIT,
  unitKgOf,
  groupByCenterDue,
  shipGroupKey,
  type RoutedItem,
  type ShipFrom,
  type ShipGroup,
} from './coupang'
import { downloadSvgAsJpg } from './svgExport'

// ── 적재 가정 ────────────────────────────────────────────────────
export { PALLET_BOX_LIMIT } // 9박스 초과 → 팔레트 안내 (단일 소스: lib/b2b/coupang.ts)
export const DEFAULT_BOX_MM = 400 // 치수 미등록 상품 가정값
export const PALLET_MM = 150
export const LIMIT_MM = 1700 // 팔레트 포함 높이 한도 (컬리와 동일)
export const PALLET_W_MM = 1100 // 팔레트 바닥 가로
export const PALLET_D_MM = 1100 // 팔레트 바닥 세로
export const GRAIN_MAX_TIERS = 5 // 진도팜(곡물) 현장 캡 — 6단부터 무너져서 단수를 묶는다
export const GRAIN_MAX_BOXES_PER_PLT = 30 // 진도팜 팔레트 1장 박스 상한 — 넘으면 다음 PLT
export const SCRAP_MIN_BOXES = 5 // 진도팜 그룹 합계가 이 값 미만인 상품은 자투리 자리로
export const SCRAP_MAX_BOXES = 5 // 자투리 자리 1개 박스 상한
export const SCRAP_MAX_STACK_MM = LIMIT_MM - PALLET_MM // 자투리 자리 박스 높이 합 상한 (1,550mm)
export const SCRAP_NOTE =
  '진도팜 소량 상품(5박스 미만)은 자투리 자리에 함께 적재 — 실제 제조일자가 같은 것끼리만 묶고, 다르면 단독 자리로. 적재리스트 부착 필수'
export const PLT_KG_WARN = 1000 // 팔레트 1장 제품 중량 경고 기준(kg)

/** 출고지별 안내 — 운송수단은 자동 판정하지 않고 문구만 낸다 */
export const SHIP_FROM_GUIDE: Record<string, string> = {
  진도팜:
    '진도 출고 팔레트 건은 밀크런 트럭 배차 (접수 마감 입고 전 영업일 14:00)',
  위킵: '화성 출고는 밀크런 이용 가능 (접수 마감 D-1 영업일 14:00, 유료·매입대금 차감)',
}

// ── 센터 × 입고예정일 묶음 ───────────────────────────────────────
/** 묶음 타입·9박스 판정은 lib/b2b/coupang.ts 가 단일 소스 (로켓 양식과 같은 함수) */
export type PoPalletGroup = ShipGroup
export { groupByCenterDue, shipGroupKey }

/**
 * 발주번호 단위 묶음 — 위킵 전달 안내문의 '발주별 발송 방식' 표기 전용.
 * 택배/트럭·팔레트 판정에는 쓰지 말 것(묶음 기준은 groupByCenterDue).
 */
export function groupByPo(items: RoutedItem[]): PoPalletGroup[] {
  const map = new Map<string, PoPalletGroup>()
  for (const it of items) {
    let g = map.get(it.poNumber)
    if (!g) {
      g = {
        key: shipGroupKey(it),
        poNumber: it.poNumber,
        poNumbers: [it.poNumber],
        center: it.center,
        dueDate: it.dueDate,
        shipFrom: it.shipFrom,
        items: [],
        boxes: 0,
        needsPallet: false,
      }
      map.set(it.poNumber, g)
    }
    g.items.push(it)
    g.boxes += it.boxes ?? 0
  }
  const list = [...map.values()]
  for (const g of list) g.needsPallet = g.boxes > PALLET_BOX_LIMIT
  return list
}

/**
 * 센터 × 입고예정일 × 출고지 묶음 (미분류는 제외 — 출고지 확정 전이라 안내 대상 아님).
 * needsPallet·PLT·밀크런·로켓 양식이 모두 이 묶음 단위를 본다.
 */
export function buildPalletGroups(routed: RoutedItem[]): PoPalletGroup[] {
  const out: PoPalletGroup[] = []
  for (const sf of ['진도팜', '위킵'] as ShipFrom[]) {
    out.push(...groupByCenterDue(routed.filter((r) => r.shipFrom === sf)))
  }
  return out.sort((a, b) =>
    a.dueDate === b.dueDate ? a.poNumber.localeCompare(b.poNumber) : a.dueDate.localeCompare(b.dueDate),
  )
}

export type CenterAdvisory = {
  shipFrom: ShipFrom
  center: string
  dueDate: string
  boxes: number
  poCount: number
}

/**
 * 발주 2건 이상이 묶여 트럭(9박스 초과)으로 판정된 묶음을 문구로 알린다.
 * 판정은 묶음의 needsPallet 그대로 — 로켓 양식 시트와 항상 같은 값이다.
 */
export function buildCenterAdvisories(groups: PoPalletGroup[]): CenterAdvisory[] {
  return groups
    .filter((g) => g.poNumbers.length >= 2 && g.needsPallet)
    .map((g) => ({
      shipFrom: g.shipFrom,
      center: g.center,
      dueDate: g.dueDate,
      boxes: g.boxes,
      poCount: g.poNumbers.length,
    }))
}

// ── 자리(더미) 모델 ──────────────────────────────────────────────
// 한 도면 안에서 상품마다 다른 색 — 밝기·색상이 서로 떨어진 14색 (글자는 진한 색으로 위에 얹는다)
const COLORS = [
  '#64B5F6', '#F5C542', '#81C784', '#E57373',
  '#BA68C8', '#4DB6AC', '#FFB74D', '#90A4AE',
  '#F48FB1', '#A1887F', '#7986CB', '#D4E157',
  '#4DD0E1', '#FF8A65',
]

/** 약칭 2단계 — 용량 앞 단어 + 용량 + 뒤 단어 ('[쌀쌀쌀] 국산 귀리 2kg B급' → '귀리 2kg B급') */
function nameWithSize(raw: string): string {
  const words = String(raw || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  const i = words.findIndex((w) => /^\d+(\.\d+)?\s*(kg|g|ml|l)$/i.test(w))
  if (i < 0) return words.join(' ')
  return [words[i - 1], ...words.slice(i)].filter(Boolean).join(' ')
}
const brandOf = (raw: string): string => String(raw || '').match(/\[([^\]]*)\]/)?.[1] ?? ''

/**
 * 도면 하나의 상품 약칭 — shortName 이 겹치는 상품만 용량을 붙이고,
 * 그래도 겹치면 브랜드, 마지막엔 전체 이름. 범례·목록·탑뷰·사이드뷰가 모두 이 이름을 쓴다.
 */
export function uniqueShortNames(fullNames: string[]): Map<string, string> {
  const names = [...new Set(fullNames)]
  const levels = [
    shortName,
    nameWithSize,
    (f: string) => (brandOf(f) ? `${nameWithSize(f)}(${brandOf(f)})` : nameWithSize(f)),
    (f: string) => f,
  ]
  const lvl = new Map(names.map((f) => [f, 0]))
  const label = (f: string) => levels[lvl.get(f) ?? 0](f)
  for (let round = 0; round < levels.length; round++) {
    const byLabel = new Map<string, string[]>()
    for (const f of names) byLabel.set(label(f), [...(byLabel.get(label(f)) ?? []), f])
    let bumped = false
    for (const group of byLabel.values()) {
      if (group.length < 2) continue
      for (const f of group) {
        const l = lvl.get(f) ?? 0
        if (l < levels.length - 1) {
          lvl.set(f, l + 1)
          bumped = true
        }
      }
    }
    if (!bumped) break
  }
  return new Map(names.map((f) => [f, label(f)]))
}

/** '[보배마을] 즉석밥 6개' → '즉석밥' (옛 표기 '… 180g * 6' 도 동일) */
export function shortName(raw: string): string {
  let s = String(raw || '').trim()
  // 예외: 새 별칭 '[쌀쌀쌀] 저속노화 잡곡 2kg 캐귀리' 는 마지막 단어(캐귀리) 대신 기존 라벨 유지
  if (s.includes('저속노화 잡곡')) return '저속식단'
  s = s.replace(/\[[^\]]*\]/g, ' ') // 브랜드 대괄호
  s = s.replace(/[*x×]\s*\d+\s*$/i, ' ') // 낱개 묶음 표기 (* 6)
  s = s.replace(/\d+\s*(개|입|팩|봉|포)(?=\s|$)/g, ' ') // 한글 단위 수량 (6개) — \b 는 한글 뒤에서 안 걸림
  s = s.replace(/\b\d+(\.\d+)?\s*(kg|g|ml|l|개|입|팩|봉|포)\b/gi, ' ') // 용량 토큰
  s = s.replace(/\s+/g, ' ').trim()
  let core = s.split(' ').filter(Boolean).pop() || s
  if (core.length > 3 && (core.endsWith('가루') || core.endsWith('분말'))) core = core.slice(0, -2)
  if (!core) core = String(raw || '').trim()
  return core.length > 8 ? core.slice(0, 8) : core
}

/** 박스 실측 치수(mm). 마스터 미등록이면 가정값 + unknown 플래그 */
export type BoxDims = { w: number; d: number; h: number; unknown: boolean }

export const dimsOf = (m: RoutedItem['master']): BoxDims => {
  const w = m?.boxW ?? 0
  const d = m?.boxD ?? 0
  const h = m?.boxH ?? 0
  return w > 0 && d > 0 && h > 0
    ? { w, d, h, unknown: false }
    : { w: DEFAULT_BOX_MM, d: DEFAULT_BOX_MM, h: DEFAULT_BOX_MM, unknown: true }
}

/** 1,100×1,100 바닥 격자 — 한 박스가 차지하는 자리 배열 */
export function floorGrid(dims: BoxDims): { cols: number; rows: number; slots: number } {
  const cols = Math.max(1, Math.floor(PALLET_W_MM / dims.w))
  const rows = Math.max(1, Math.floor(PALLET_D_MM / dims.d))
  return { cols, rows, slots: cols * rows }
}

/**
 * SKU별 실측 단수 — 한도 1,700mm(팔레트 150mm 포함) 안에 쌓이는 단수.
 * 높이 계산은 컬리와 같은 식(kurly.maxTiersOf)을 쓰고, 진도팜(곡물) 출고만 5단으로 묶는다.
 */
export const maxTiersOf = (dims: BoxDims, shipFrom: string): number =>
  shipFrom === '진도팜' ? Math.min(GRAIN_MAX_TIERS, tiersByHeight(dims)) : tiersByHeight(dims)

export type PlanSku = {
  sku: string
  fullName: string
  color: string
  boxes: number
  dims: BoxDims
  tiersPerSlot: number // 이 박스가 이 출고지에서 쌓이는 최대 단수
  lotKey: string // 발주서 관리 구분 ('제조일자관리'만 자투리 대상, '소비기한관리'·'' 는 단독 자리)
}

/** 자투리 자리 안의 상품 한 칸 (아래 → 위 순서) */
export type SlotPart = { sku: string; fullName: string; color: string; boxes: number; dims: BoxDims }

/**
 * 자리 하나 = SKU 하나. 단, 진도팜 자투리 자리는 parts 에 여러 상품을 담는다
 * (그때 tiers = 박스 합, sku/fullName/color/dims 는 맨 아래 상품 기준).
 */
export type PlanSlot = {
  sku: string
  fullName: string
  color: string
  tiers: number
  tiersPerSlot: number // 이 SKU 의 실측 한계 단수 (펴서 쌓을 때 상한)
  dims: BoxDims
  parts?: SlotPart[]
  scrapLabel?: string // 팔레트 안 자투리 자리 이름 (A, B …) — 도면 표시용
}

/** 자리 적재 높이(mm, 팔레트 제외) */
export const slotStackMm = (s: PlanSlot): number =>
  s.parts ? s.parts.reduce((a, p) => a + p.boxes * p.dims.h, 0) : s.tiers * s.dims.h

export type PlanPanel = {
  poNumber: string
  center: string
  dueDate: string
  shipFrom: ShipFrom
  index: number // PLT 번호 (1부터)
  total: number // 발주의 PLT 수
  cols: number
  rows: number
  slotCount: number
  slots: (PlanSlot | null)[] // length = slotCount
  items: {
    sku: string
    fullName: string
    color: string
    boxes: number
    slots: number // 단독 자리 수
    scrapLabels: string[] // 들어간 자투리 자리 이름 (A, B …)
    dateText: string // 진도팜만 — '제조일자 관리' / '소비기한 관리' (못 읽으면·그 외 출고지 '')
  }[]
  boxes: number // 이 PLT 박스 수
  kg: number // 이 PLT 제품 중량 — 매출 요약과 같은 식(수량 × unitKgOf)을 박스 비율로 나눈 값
  kgKnown: boolean // 1개 무게를 못 구한 상품이 있으면 false
  centerBoxes: number // 센터 합계 (센터 × 입고예정일 × 출고지 묶음)
  centerPlt: number
  vehicle: string // 팔레트 필요 안내 표의 차량 값 그대로 ('' = 미산정)
  centerFee?: number | null // 팔레트 필요 안내 표의 운임 그대로 (null = 요금 미등록, undefined = 미산정)
  poBoxes: number // 발주 총 박스 수
  maxTier: number
  heightMm: number
  slackMm: number
  over: boolean // 한도 초과 → 빨강 경고
  dimsUnknown: boolean // 치수 미등록 상품 포함
}

export type CoupangPalletPlan = {
  dueDate: string
  panels: PlanPanel[]
  legend: { sku: string; fullName: string; color: string }[]
  dimsUnknown: boolean
  excluded: { center: string; boxes: number; poNumber: string }[] // 택배 발송이라 도면 제외
}

export type PlanOptions = {
  gramByAlias?: Record<string, number> // 매출 요약 kg 와 같은 단가DB g
  vehicleOf?: (g: PoPalletGroup) => string // 팔레트 필요 안내 표의 차량 값 (새로 계산하지 않음)
  feeOf?: (g: PoPalletGroup) => number | null | undefined // 같은 표의 운임 값 (새로 계산하지 않음)
}

/** 관리 구분(lotKey) → 상품 목록 표기. 발주서 날짜는 확정 전 값이라 표시하지 않는다 */
export const lotDateText = (lotKey: string): string =>
  lotKey === '제조일자관리' ? '제조일자 관리' : lotKey === '소비기한관리' ? '소비기한 관리' : ''

/**
 * 박스 많은 순 → 자리 배분. 자리당 단수는 SKU별 실측 단수(tiersPerSlot)까지,
 * 같은 SKU 는 인접 자리 연속. 팔레트 장수를 정하는 '용량 기준' 배분이다.
 * 진도팜은 소량 상품(SCRAP_MIN_BOXES 미만)을 자투리 자리로 따로 모은다(scrapSlots).
 */
export function allocateSlots(skus: PlanSku[], shipFrom?: string): PlanSlot[] {
  const out: PlanSlot[] = []
  const scrap = shipFrom === '진도팜' ? skus.filter(isScrapSku) : []
  const sorted = skus
    .filter((s) => !scrap.includes(s))
    .sort((a, b) => (b.boxes - a.boxes) || a.sku.localeCompare(b.sku))
  for (const s of sorted) {
    let left = s.boxes
    while (left > 0) {
      const tiers = Math.min(Math.max(1, s.tiersPerSlot), left)
      out.push({
        sku: s.sku,
        fullName: s.fullName,
        color: s.color,
        tiers,
        tiersPerSlot: s.tiersPerSlot,
        dims: s.dims,
      })
      left -= tiers
    }
  }
  return [...out, ...scrapSlots(scrap)]
}

/** 자투리 대상 — 소량이고, 발주서 관리 구분이 '제조일자관리'이고, 혼자 쌓아도 높이 한도 안 */
const isScrapSku = (s: PlanSku): boolean =>
  s.boxes < SCRAP_MIN_BOXES && s.lotKey === '제조일자관리' && s.boxes * s.dims.h <= SCRAP_MAX_STACK_MM

/**
 * 진도팜 자투리 자리 — 관리 구분(제조일자관리)이 같은 상품끼리만, 자리당 SCRAP_MAX_BOXES 박스·
 * 높이 합 SCRAP_MAX_STACK_MM 이하로 박스 많은 상품부터 앞 자리에 채운다(상품은 쪼개지 않음).
 * 자리 안에서는 바닥 면적이 큰 박스가 아래. 상품이 하나뿐인 자리는 일반 자리로 둔다.
 */
export function scrapSlots(skus: PlanSku[]): PlanSlot[] {
  const byLot = new Map<string, PlanSku[]>()
  for (const s of skus) byLot.set(s.lotKey, [...(byLot.get(s.lotKey) ?? []), s])
  const out: PlanSlot[] = []
  for (const lot of [...byLot.keys()].sort()) {
    const list = byLot.get(lot)!.sort((a, b) => (b.boxes - a.boxes) || a.sku.localeCompare(b.sku))
    const bins: PlanSku[][] = []
    for (const s of list) {
      const fit = bins.find(
        (b) =>
          b.reduce((a, x) => a + x.boxes, 0) + s.boxes <= SCRAP_MAX_BOXES &&
          b.reduce((a, x) => a + x.boxes * x.dims.h, 0) + s.boxes * s.dims.h <= SCRAP_MAX_STACK_MM,
      )
      if (fit) fit.push(s)
      else bins.push([s])
    }
    for (const b of bins) {
      const parts = [...b].sort((x, y) => y.dims.w * y.dims.d - x.dims.w * x.dims.d)
      const base = parts[0]
      out.push({
        sku: base.sku,
        fullName: base.fullName,
        color: base.color,
        tiers: parts.reduce((a, x) => a + x.boxes, 0),
        tiersPerSlot: base.tiersPerSlot,
        dims: base.dims,
        ...(parts.length > 1
          ? { parts: parts.map((x) => ({ sku: x.sku, fullName: x.fullName, color: x.color, boxes: x.boxes, dims: x.dims })) }
          : {}),
      })
    }
  }
  return out
}

/**
 * 자리 목록 → 팔레트별 자리 묶음. 자리 수(slotsPerPlt)가 차거나 박스 상한(maxBoxes)을
 * 넘게 되면 다음 PLT 로 넘긴다. 상한이 없으면(Infinity) 자리 수로 끊는 것과 같다.
 */
export function packPallets(slots: PlanSlot[], slotsPerPlt: number, maxBoxes = Infinity): PlanSlot[][] {
  const out: PlanSlot[][] = []
  let cur: PlanSlot[] = []
  let boxes = 0
  for (const s of slots) {
    if (cur.length && (cur.length >= slotsPerPlt || boxes + s.tiers > maxBoxes)) {
      out.push(cur)
      cur = []
      boxes = 0
    }
    cur.push(s)
    boxes += s.tiers
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * 같은 상품은 한 팔레트에 — 쿠팡 입고 매뉴얼 v3.06 §4.2 (나뉘면 수량 확인 곤란 → 회송 가능).
 * 같은 상품의 연속 자리를 한 덩어리로 보고(자투리 자리는 자리 하나가 한 덩어리),
 * 팔레트 1장을 넘는 덩어리만 자리 수·박스 상한 단위로 나눈 뒤 큰 덩어리부터 들어가는 첫 팔레트에 넣는다.
 * 장수 결정은 하지 않는다 — 호출부가 packPallets 와 장수가 같을 때만 이 배치를 쓴다.
 */
export function packPalletsBySku(slots: PlanSlot[], slotsPerPlt: number, maxBoxes = Infinity): PlanSlot[][] {
  const blocks: PlanSlot[][] = []
  for (const s of slots) {
    const last = blocks[blocks.length - 1]
    if (last && !s.parts && !last[0].parts && last[0].fullName === s.fullName) last.push(s)
    else blocks.push([s])
  }
  const pieces = blocks.flatMap((b) => packPallets(b, slotsPerPlt, maxBoxes))
  const boxesOf = (xs: PlanSlot[]) => xs.reduce((a, x) => a + x.tiers, 0)
  const order = pieces.map((p, i) => ({ p, i })).sort((a, b) => (b.p.length - a.p.length) || (a.i - b.i))
  const out: PlanSlot[][] = []
  for (const { p } of order) {
    const fit = out.find((plt) => plt.length + p.length <= slotsPerPlt && boxesOf(plt) + boxesOf(p) <= maxBoxes)
    if (fit) fit.push(...p)
    else out.push([...p])
  }
  return out
}

/** 출고지별 팔레트 박스 상한 — 진도팜만 명시 상한 */
export const maxBoxesPerPlt = (shipFrom: string): number =>
  shipFrom === '진도팜' ? GRAIN_MAX_BOXES_PER_PLT : Infinity

/**
 * 팔레트 한 장 안에서 다시 펴서 쌓기 — 자리가 남으면 높이 쌓지 않고 나눠 깐다.
 * 팔레트 장수(=이 함수에 들어온 자리 묶음)는 바꾸지 않는다.
 * 예) 즉석밥 34박스·6자리·12단 → 12·12·10 대신 6·6·6·6·6·4
 */
export function spreadSlots(slots: PlanSlot[], capacity: number): PlanSlot[] {
  // 자투리 자리(여러 상품)는 펴지 않고 그대로 두고, 남은 자리 안에서만 편다
  const mixed = slots.filter((s) => s.parts)
  const cap = Math.max(1, capacity - mixed.length)
  type Bin = { s: PlanSlot; boxes: number; slots: number }
  const bins: Bin[] = []
  for (const s of slots.filter((x) => !x.parts)) {
    let b = bins.find((x) => x.s.fullName === s.fullName)
    if (!b) {
      b = { s, boxes: 0, slots: 0 }
      bins.push(b)
    }
    b.boxes += s.tiers
  }
  const tiersCap = (b: Bin) => Math.max(1, b.s.tiersPerSlot)
  for (const b of bins) b.slots = Math.max(1, Math.ceil(b.boxes / tiersCap(b)))
  let free = cap - bins.reduce((a, b) => a + b.slots, 0)
  // 남는 자리는 '지금 가장 높이 쌓인' SKU 부터 — 더 펼 수 있는 것만
  while (free > 0) {
    const able = bins.filter((b) => b.boxes > b.slots)
    if (!able.length) break
    const top = able.reduce((a, b) =>
      Math.ceil(b.boxes / b.slots) * b.s.dims.h > Math.ceil(a.boxes / a.slots) * a.s.dims.h ? b : a,
    )
    top.slots += 1
    free -= 1
  }
  const out: PlanSlot[] = []
  for (const b of bins) {
    const per = Math.min(tiersCap(b), Math.ceil(b.boxes / b.slots))
    let left = b.boxes
    while (left > 0) {
      const tiers = Math.min(per, left)
      out.push({ ...b.s, tiers })
      left -= tiers
    }
  }
  return [...out, ...mixed]
}

/**
 * 발주 → SKU 별 적재 단위. 색은 도면에서만 쓰므로 colorOf 가 없으면 기본색을 넣는다.
 * PLT 수 계산과 도면이 반드시 같은 입력을 쓰도록 한 곳에 둔다.
 */
export function planSkusOf(g: PoPalletGroup, colorOf?: Map<string, string>): PlanSku[] {
  const byKey = new Map<string, PlanSku>()
  for (const it of g.items) {
    const k = norm(it.barcode) || norm(it.productName)
    let p = byKey.get(k)
    if (!p) {
      const full = it.master?.alias || it.productName
      const dims = dimsOf(it.master)
      p = {
        sku: shortName(full),
        fullName: full,
        color: colorOf?.get(k) || COLORS[0],
        boxes: 0,
        dims,
        tiersPerSlot: maxTiersOf(dims, g.shipFrom),
        lotKey: it.lotKey ?? '',
      }
      byKey.set(k, p)
    }
    // 같은 상품인데 발주마다 관리 구분이 다르면 묶음 키를 비워 자투리에 섞지 않는다
    if (p.lotKey !== (it.lotKey ?? '')) p.lotKey = ''
    p.boxes += it.boxes ?? 0
  }
  return [...byKey.values()].filter((s) => s.boxes > 0)
}

/** 바닥 격자는 가장 큰 박스 기준(자리 수가 제일 적게 나오는 쪽) */
export const planGridOf = (skus: PlanSku[]) =>
  skus.map((s) => floorGrid(s.dims)).reduce((a, b) => (b.slots < a.slots ? b : a))

/**
 * 발주 → 실측 용량 기준 팔레트 장수.
 * 30박스 같은 고정 상수가 아니라 '바닥 자리 수 × SKU별 단수' 로 계산한다.
 * (도면의 PLT 장수와 항상 같은 값)
 */
export function pltCountOf(g: PoPalletGroup): number {
  const skus = planSkusOf(g)
  if (!skus.length) return 0
  const grid = planGridOf(skus)
  return Math.max(1, packPallets(allocateSlots(skus, g.shipFrom), grid.slots, maxBoxesPerPlt(g.shipFrom)).length)
}

/** 팔레트 필요 발주 → PLT 단위 패널 (자리 수를 넘기면 다음 PLT 로 넘긴다) */
export function buildCoupangPalletPlan(groups: PoPalletGroup[], opts: PlanOptions = {}): CoupangPalletPlan {
  const need = groups.filter((g) => g.needsPallet)
  const gramByAlias = opts.gramByAlias ?? {}


  const panels: PlanPanel[] = []
  for (const g of need) {
    // 같은 발주 안에서 상품 단위 합산
    const skus = planSkusOf(g)
    if (!skus.length) continue

    const grid = planGridOf(skus)
    const dimsUnknown = skus.some((s) => s.dims.unknown)

    // 장수는 packPallets(= pltCountOf) 기준 그대로 — 같은 상품 모으기는 장수가 같을 때만 적용
    const allocated = allocateSlots(skus, g.shipFrom)
    const seq = packPallets(allocated, grid.slots, maxBoxesPerPlt(g.shipFrom))
    const bySku = packPalletsBySku(allocated, grid.slots, maxBoxesPerPlt(g.shipFrom))
    const chunks = bySku.length === seq.length ? bySku : seq
    const total = Math.max(1, chunks.length)
    const grain = g.shipFrom === '진도팜'
    const lotOf = new Map(skus.map((x) => [x.fullName, x.lotKey]))

    // 상품별 제품 중량(매출 요약과 같은 식) → 박스당 kg 로 팔레트에 나눈다
    const kgOf = new Map<string, { kg: number; boxes: number; known: boolean }>()
    for (const it of g.items) {
      const full = it.master?.alias || it.productName
      const e = kgOf.get(full) ?? { kg: 0, boxes: 0, known: true }
      const unitKg = unitKgOf(it.master?.alias || '', it.productName, gramByAlias)
      if (unitKg === null) e.known = false
      else e.kg += it.confirmQty * unitKg
      e.boxes += it.boxes ?? 0
      kgOf.set(full, e)
    }
    const vehicle = opts.vehicleOf?.(g) ?? ''
    const centerFee = opts.feeOf?.(g)

    for (let i = 0; i < chunks.length; i++) {
      // 이 팔레트 몫을 자리 수 안에서 다시 펴서 쌓는다 (장수는 그대로)
      // 자투리 자리는 팔레트마다 A, B, C … 로 이름을 붙인다
      let scrapNo = 0
      const mine = spreadSlots(chunks[i], grid.slots).map((x) =>
        x.parts ? { ...x, scrapLabel: String.fromCharCode(65 + scrapNo++) } : x,
      )
      const padded: (PlanSlot | null)[] = Array.from(
        { length: grid.slots },
        (_, k) => mine[k] ?? null,
      )
      const items: PlanPanel['items'] = []
      for (const s of mine) {
        for (const part of s.parts ?? [{ ...s, boxes: s.tiers }]) {
          let e = items.find((x) => x.fullName === part.fullName)
          if (!e) {
            e = {
              sku: part.sku, fullName: part.fullName, color: part.color, boxes: 0, slots: 0, scrapLabels: [],
              dateText: grain ? lotDateText(lotOf.get(part.fullName) ?? '') : '',
            }
            items.push(e)
          }
          e.boxes += part.boxes
          if (s.parts) e.scrapLabels.push(s.scrapLabel ?? '')
          else e.slots += 1
        }
      }
      let kg = 0
      let kgKnown = true
      for (const e of items) {
        const k = kgOf.get(e.fullName)
        if (!k || !k.known) kgKnown = false
        if (k && k.boxes > 0) kg += (k.kg * e.boxes) / k.boxes
      }
      const maxTier = mine.reduce((m, s) => Math.max(m, s.tiers), 0)
      const stackMm = mine.reduce((m, s) => Math.max(m, slotStackMm(s)), 0)
      const heightMm = PALLET_MM + stackMm
      panels.push({
        poNumber: g.poNumber,
        center: g.center,
        dueDate: g.dueDate,
        shipFrom: g.shipFrom,
        index: i + 1,
        total,
        cols: grid.cols,
        rows: grid.rows,
        slotCount: grid.slots,
        slots: padded,
        items,
        boxes: mine.reduce((a, s) => a + s.tiers, 0),
        kg,
        kgKnown,
        centerBoxes: g.boxes,
        centerPlt: total,
        vehicle,
        centerFee,
        poBoxes: g.boxes,
        maxTier,
        heightMm,
        slackMm: LIMIT_MM - heightMm,
        over: heightMm > LIMIT_MM,
        dimsUnknown,
      })
    }
  }

  // 도면 전체 기준 약칭·색 — 상품(전체 이름)마다 하나씩, 겹치지 않게 다시 입힌다
  const order: string[] = []
  for (const p of panels) for (const it of p.items) if (!order.includes(it.fullName)) order.push(it.fullName)
  const nameOf = uniqueShortNames(order)
  const colorByName = new Map(order.map((f, i) => [f, COLORS[i % COLORS.length]]))
  const paint = <T extends { fullName: string; sku: string; color: string }>(x: T): T => ({
    ...x,
    sku: nameOf.get(x.fullName) ?? x.sku,
    color: colorByName.get(x.fullName) ?? x.color,
  })
  for (const p of panels) {
    p.items = p.items.map(paint)
    p.slots = p.slots.map((s) => (s ? { ...paint(s), ...(s.parts ? { parts: s.parts.map(paint) } : {}) } : s))
  }
  const legend: CoupangPalletPlan['legend'] = order.map((f) => ({
    sku: nameOf.get(f) ?? f,
    fullName: f,
    color: colorByName.get(f) ?? COLORS[0],
  }))

  return {
    dueDate: need.find((g) => g.dueDate)?.dueDate || '',
    panels,
    legend,
    dimsUnknown: panels.some((p) => p.dimsUnknown),
    excluded: groups
      .filter((g) => !g.needsPallet && g.boxes > 0)
      .map((g) => ({ center: g.center, boxes: g.boxes, poNumber: g.poNumber })),
  }
}

// ── SVG ──────────────────────────────────────────────────────────
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
const n = (v: number): string => (Math.round(v * 100) / 100).toString()
const cm = (v: number): string => v.toLocaleString('en-US')

const M = 28
const PANEL_W = 344
const PANEL_GAP = 18
const PANELS_PER_ROW = 4
const ART_W = 260
const ART_X = (PANEL_W - ART_W) / 2
const PAL = ART_W // 팔레트 1,100mm 을 그리는 폭
const SIDE_H = 210
const ITEM_LH = 15
const PANEL_TITLE_Y = 24 // 패널 제목 줄
const ITEMS_Y = 46 // 상품 목록 첫 줄 (한 상품 = 한 줄)
const HEIGHT_WARN_MM = 50 // 높이 여유가 이 값 미만이면 빨간 경고
const ROW_HEAD_H = 26 // 센터 제목 줄 높이
const ROW_GAP = 22
export const panelWarnsOf = (p: PlanPanel): string[] => [
  ...(p.slackMm < HEIGHT_WARN_MM
    ? [p.over ? `⚠ 높이 ${cm(p.heightMm)}mm — 한도 ${cm(LIMIT_MM)}mm 초과, 단수 조정 필요` : `⚠ 높이 여유 ${cm(p.slackMm)}mm — 한도 ${cm(LIMIT_MM)}mm 근접`]
    : []),
  ...(p.dimsUnknown ? [`⚠ 치수 미등록 — ${DEFAULT_BOX_MM}mm 가정`] : []),
  ...(p.kg > PLT_KG_WARN ? [`⚠ 제품 중량 ${PLT_KG_WARN.toLocaleString('en-US')}kg 초과 — 중량 확인 필요`] : []),
]
/** 패널 세로 배치 — 같은 센터 줄의 최대 상품 수·경고 수 기준 */
function panelLayout(nItems: number, nWarns: number) {
  const itemsBottom = ITEMS_Y + (Math.max(1, nItems) - 1) * ITEM_LH + 10
  const topY = itemsBottom + 8
  const sideLabelY = topY + PAL + 20
  const sideY = sideLabelY + 8
  const warnY = sideY + SIDE_H + 18
  const h = sideY + SIDE_H + 12 + (nWarns ? nWarns * 16 + 6 : 0)
  return { topY, sideLabelY, sideY, warnY, h }
}
const LEGEND_W = 178
const FONT = "Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', -apple-system, sans-serif"

type T = { x: number; y: number; s: string; size?: number; bold?: boolean; fill?: string; anchor?: string }
const text = ({ x, y, s, size = 11, bold, fill = '#111827', anchor }: T): string =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${size}"${bold ? ' font-weight="600"' : ''} fill="${fill}"${
    anchor ? ` text-anchor="${anchor}"` : ''
  }>${esc(s)}</text>`

const rect = (
  x: number, y: number, w: number, h: number,
  o: { fill?: string; stroke?: string; sw?: number; dash?: string; rx?: number } = {},
): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${o.fill ?? 'none'}"` +
  (o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : '') +
  (o.dash ? ` stroke-dasharray="${o.dash}"` : '') +
  (o.rx ? ` rx="${o.rx}"` : '') + '/>'

/** 대략적인 렌더 폭 — 한글은 글자당 ~1em, 그 외는 ~0.55em. 캔버스가 제목보다 좁아지지 않게 쓴다 */
function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯　-〿＀-￯]/.test(ch) ? size : size * 0.55
  return w
}

/** 탑뷰 — 자리를 실측 치수 비율 그대로 1,100×1,100 위에 놓는다 */
function topView(p: PlanPanel, ox: number, oy: number): string {
  const scale = PAL / PALLET_W_MM
  let out = rect(ox, oy, PAL, PAL, { fill: '#D7B899', stroke: '#8D6E63', sw: 2, rx: 4 })
  for (let i = 1; i < 5; i++) {
    const y = oy + (PAL / 5) * i
    out += `<line x1="${n(ox + 4)}" y1="${n(y)}" x2="${n(ox + PAL - 4)}" y2="${n(y)}" stroke="#C0A183" stroke-width="1"/>`
  }

  const first = p.slots.find((s) => s) || null
  const bw = (first?.dims.w ?? DEFAULT_BOX_MM) * scale
  const bd = (first?.dims.d ?? DEFAULT_BOX_MM) * scale
  const padX = (PAL - p.cols * bw) / (p.cols + 1)
  const padY = (PAL - p.rows * bd) / (p.rows + 1)

  for (let i = 0; i < p.slotCount; i++) {
    const r = Math.floor(i / p.cols)
    const c = i % p.cols
    const x = ox + padX + c * (bw + padX)
    const y = oy + padY + r * (bd + padY)
    const s = p.slots[i]
    if (!s) {
      out += rect(x, y, bw, bd, { stroke: '#9CA3AF', sw: 1.2, dash: '5 4', rx: 3 })
      out += text({ x: x + bw / 2, y: y + bd / 2 + 4, s: '빈 자리', size: 10, fill: '#9CA3AF', anchor: 'middle' })
      continue
    }
    if (s.parts) {
      // 자투리 자리 — 상품별 색 띠로 나눠 보여 준다
      const stripe = bw / s.parts.length
      s.parts.forEach((part, k) => {
        out += rect(x + k * stripe, y, stripe, bd, { fill: part.color, stroke: '#111827', sw: 0.8 })
      })
      out += rect(x, y, bw, bd, { stroke: '#111827', sw: 1.5, dash: '4 2', rx: 3 })
      out += rect(x + bw / 2 - 36, y + bd / 2 - 17, 72, 32, { fill: '#FFFFFF', stroke: '#111827', sw: 0.8, rx: 3 })
      out += text({ x: x + bw / 2, y: y + bd / 2 - 4, s: `자투리 ${s.scrapLabel ?? ''}`.trim(), size: 10.5, bold: true, anchor: 'middle' })
      out += text({ x: x + bw / 2, y: y + bd / 2 + 10, s: `${s.parts.length}종 ${s.tiers}박스`, size: 9.5, fill: '#1F2937', anchor: 'middle' })
      continue
    }
    out += rect(x, y, bw, bd, { fill: s.color, stroke: '#111827', sw: 1.5, rx: 3 })
    out += text({ x: x + bw / 2, y: y + bd / 2 - 4, s: s.sku, size: 10.5, bold: true, anchor: 'middle' })
    out += text({ x: x + bw / 2, y: y + bd / 2 + 10, s: `${s.tiers}단`, size: 9.5, fill: '#1F2937', anchor: 'middle' })
  }
  return out
}

/** 사이드뷰 — 자리별 실측 단수 × 실측 박스 높이 */
function sideView(p: PlanPanel, ox: number, oy: number): string {
  const base = oy + SIDE_H
  const scale = (SIDE_H - 26) / LIMIT_MM
  const palH = PALLET_MM * scale
  const palTop = base - palH

  let out = `<line x1="${n(ox - 6)}" y1="${n(base)}" x2="${n(ox + ART_W + 6)}" y2="${n(base)}" stroke="#6B7280" stroke-width="1.5"/>`
  const limitY = base - LIMIT_MM * scale
  out += `<line x1="${n(ox - 6)}" y1="${n(limitY)}" x2="${n(ox + ART_W + 6)}" y2="${n(limitY)}" stroke="#DC2626" stroke-width="1" stroke-dasharray="6 4"/>`
  out += text({ x: ox + ART_W + 4, y: limitY - 4, s: `한도 ${cm(LIMIT_MM)}mm`, size: 9, fill: '#DC2626', anchor: 'end' })
  out += rect(ox, palTop, ART_W, palH, { fill: '#B08968', stroke: '#7A5C48', sw: 1.2 })
  out += text({ x: ox + 4, y: palTop + palH / 2 + 3.5, s: `팔레트 ${PALLET_MM}mm`, size: 8.5, fill: '#3E2723' })

  // 자리 전부를 열(row) 단위로 끊어 나란히 세운다 — 뒷줄도 실제 단수 그대로 보이게
  const avail = ART_W - 12
  const slot = avail / Math.max(1, p.slotCount)
  const colW = Math.min(56, Math.max(14, slot - 6))

  p.slots.forEach((s, i) => {
    const x = ox + 6 + i * slot + (slot - colW) / 2
    if (i > 0 && i % p.cols === 0) {
      const sx = ox + 6 + i * slot - 1
      out += `<line x1="${n(sx)}" y1="${n(palTop - (SIDE_H - 40))}" x2="${n(sx)}" y2="${n(palTop)}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3"/>`
    }
    if (!s) {
      out += rect(x, palTop - 10, colW, 10, { stroke: '#9CA3AF', sw: 1, dash: '4 3' })
      return
    }
    if (s.parts) {
      // 자투리 자리 — 아래(바닥 면적 큰 박스)부터 상품별 색·실측 높이로 쌓는다
      let y = palTop
      for (const part of s.parts) {
        const h = part.dims.h * scale
        for (let t = 0; t < part.boxes; t++) {
          y -= h
          out += rect(x, y, colW, h, { fill: part.color, stroke: '#111827', sw: 1.2 })
        }
      }
      out += text({ x: x + colW / 2, y: y - 5, s: `자투리 ${s.scrapLabel ?? ''} ${s.tiers}`.replace(/\s+/g, ' '), size: 8.5, bold: true, anchor: 'middle' })
      return
    }
    const boxH = s.dims.h * scale
    for (let t = 0; t < s.tiers; t++) {
      out += rect(x, palTop - (t + 1) * boxH, colW, boxH, { fill: s.color, stroke: '#111827', sw: 1.2 })
    }
    // 자리가 많으면 라벨이 겹치므로 단수만 — SKU 는 색과 탑뷰로 읽는다
    out += text({
      x: x + colW / 2, y: palTop - s.tiers * boxH - 5,
      s: p.slotCount > 4 ? `${s.tiers}단` : `${s.sku} ${s.tiers}단`,
      size: 8.5, bold: true, anchor: 'middle',
    })
  })
  return out
}

/** 글자가 패널 폭을 넘지 않게 줄이는 크기 */
const fitSize = (str: string, size: number, maxW: number): number =>
  Math.max(8, Math.min(size, (size * maxW) / Math.max(1, textWidth(str, size))))

function panelSvg(p: PlanPanel, ox: number, oy: number, nItems: number, nWarns: number): string {
  const L = panelLayout(nItems, nWarns)
  let out = rect(ox, oy, PANEL_W, L.h, { fill: '#FFFFFF', stroke: '#D1D5DB', sw: 1, rx: 6 })
  const title =
    `PLT ${p.index}/${p.total} · ${cm(p.boxes)}박스 · 제품 약 ${cm(Math.round(p.kg))}kg${p.kgKnown ? '' : '(일부 미확인)'}` +
    ` · 높이 ${cm(p.heightMm)}mm`
  out += text({ x: ox + 14, y: oy + PANEL_TITLE_Y, s: title, size: fitSize(title, 12.5, PANEL_W - 28), bold: true })

  p.items.forEach((it, i) => {
    const y = oy + ITEMS_Y + i * ITEM_LH
    const where = [it.slots ? `${it.slots}자리` : '', ...it.scrapLabels.map((l) => `자투리 ${l}`)].filter(Boolean).join(' + ')
    const line = [`${it.sku} ${cm(it.boxes)}박스`, where, it.dateText].filter(Boolean).join(' · ')
    out += text({ x: ox + 14, y, s: line, size: fitSize(line, 10, PANEL_W - 52), fill: '#374151' })
    out += rect(ox + PANEL_W - 24, y - 8, 10, 10, { fill: it.color, stroke: '#111827', sw: 1 })
  })

  out += topView(p, ox + ART_X, oy + L.topY)
  out += text({ x: ox + 14, y: oy + L.sideLabelY, s: '사이드뷰 (옆에서 본 적재)', size: 10.5, bold: true, fill: '#374151' })
  out += sideView(p, ox + ART_X, oy + L.sideY)
  panelWarnsOf(p).forEach((w, k) => {
    out += text({ x: ox + 14, y: oy + L.warnY + k * 16, s: w, size: 10, bold: true, fill: w.includes('치수') ? '#B45309' : '#DC2626' })
  })
  return out
}

/**
 * 부착물 안내 — 진도팜(밀크런 트럭)은 밀크런 접수 내역에서 출력하는 팔레트 부착리스트(밀크런 접수 가이드 ver8),
 * 직접 배차(트럭 쉽먼트) 출고지는 쉽먼트 라벨. 한 도면에 둘 다 있으면 출고지를 붙여 두 줄.
 */
const ATTACH_MILKRUN =
  '부착물: 적재리스트 2면 + 밀크런 팔레트 부착리스트(서플라이어 허브 → 물류 → 밀크런 → 접수 내역에서 출력)'
const ATTACH_SHIPMENT = '부착물: 적재리스트(2면) + 쉽먼트 라벨(앞·옆면), 발주서·거래명세서는 기사 전달'
function attachLinesOf(panels: PlanPanel[]): string[] {
  const milkrun = panels.some((p) => p.shipFrom === '진도팜')
  const others = [...new Set(panels.filter((p) => p.shipFrom !== '진도팜').map((p) => p.shipFrom))]
  if (milkrun && !others.length) return [ATTACH_MILKRUN]
  if (!milkrun) return [ATTACH_SHIPMENT]
  return [`[진도팜] ${ATTACH_MILKRUN}`, `[${others.join('·')}] ${ATTACH_SHIPMENT}`]
}

export function renderCoupangPalletPlanSvg(plan: CoupangPalletPlan): string {
  const panels = plan.panels
  if (!panels.length) return ''
  // 센터 × 입고예정일 × 출고지(발주 묶음) 한 줄 — 센터가 바뀌면 줄 바꿈, 4장 넘으면 같은 센터 안에서 줄 바꿈
  const groups: PlanPanel[][] = []
  for (const p of panels) {
    const last = groups[groups.length - 1]
    if (last && last[0].poNumber === p.poNumber && last[0].center === p.center &&
        last[0].dueDate === p.dueDate && last[0].shipFrom === p.shipFrom) last.push(p)
    else groups.push([p])
  }
  const rowsOf = (g: PlanPanel[]) => Array.from({ length: Math.ceil(g.length / PANELS_PER_ROW) }, (_, k) => g.slice(k * PANELS_PER_ROW, (k + 1) * PANELS_PER_ROW))
  const headOf = (g: PlanPanel[]) => {
    const p = g[0]
    const kg = g.reduce((a, x) => a + x.kg, 0)
    const fee = p.centerFee === undefined ? '' : p.centerFee === null ? ' · 운임 요금 미등록' : ` · 운임(참고) ${cm(p.centerFee)}원`
    return `${p.center} · ${p.dueDate} · ${cm(p.centerBoxes)}박스 · ${p.centerPlt} PLT · ${p.vehicle || '차량 —'} · 제품 약 ${cm(Math.round(kg))}kg${g.every((x) => x.kgKnown) ? '' : '(일부 미확인)'}${fee}`
  }
  const sizeOf = (g: PlanPanel[]) => ({
    nItems: Math.max(...g.map((x) => x.items.length)),
    nWarns: Math.max(...g.map((x) => panelWarnsOf(x).length)),
  })
  const rowW = (n: number) => n * PANEL_W + (n - 1) * PANEL_GAP
  const groupH = (g: PlanPanel[]) => {
    const z = sizeOf(g)
    const lines = rowsOf(g).length
    return ROW_HEAD_H + lines * panelLayout(z.nItems, z.nWarns).h + (lines - 1) * PANEL_GAP
  }
  const perRowMax = Math.max(...groups.map((g) => Math.min(PANELS_PER_ROW, g.length)))
  const headW = Math.max(...groups.map((g) => textWidth(headOf(g), 13) + 10 + textWidth(`발주 ${g[0].poNumber}`, 10)))
  const gridDesc = [...new Set(panels.map((p) => {
    const d = p.slots.find((x) => x)?.dims
    return `${p.shipFrom} ${p.cols}×${p.rows} = ${p.slotCount}자리 (박스 ${d ? `${d.w}×${d.d}` : '—'}mm)`
  }))].join(' · ')
  const descLine = `탑뷰 자리: ${gridDesc} · 높이 한도 ${cm(LIMIT_MM)}mm (팔레트 ${PALLET_MM}mm 포함) — 패널 제목 = PLT · 박스 · 제품 중량 · 높이, 여유 ${HEIGHT_WARN_MM}mm 미만만 경고`

  const bodyW = Math.max(rowW(perRowMax), headW)
  // 범례는 글자 폭만큼 흘려 배치 — 긴 상품명이 옆 칸과 겹치지 않게
  const legendPos: { x: number; r: number }[] = []
  {
    let x = 0
    let r = 0
    for (const l of plan.legend) {
      const w = Math.max(LEGEND_W, 19 + textWidth(`${l.sku} — ${l.fullName}`, 10) + 16)
      if (x > 0 && x + w > bodyW) {
        x = 0
        r += 1
      }
      legendPos.push({ x, r })
      x += w
    }
  }
  const legendRows = Math.max(1, (legendPos[legendPos.length - 1]?.r ?? 0) + 1)
  const excludedLine = plan.excluded.length
    ? `택배 발송(${PALLET_BOX_LIMIT}박스 이하)이라 도면 제외: ` +
      plan.excluded.map((e) => `${e.center} ${cm(e.boxes)}박스 (발주 ${e.poNumber})`).join(' · ')
    : ''
  const legendY = M + 90 + (excludedLine ? 20 : 0)
  const panelsY = legendY + (legendRows - 1) * 20 + 22

  const bodyBottom = panelsY + groups.reduce((a, g) => a + groupH(g), 0) + (groups.length - 1) * ROW_GAP
  const foots = [
    'KPP 팔레트 사용 (목재·일회용 금지)',
    '랩핑 필수',
    'SKU별 자리(더미) 분리 — 더미 외부에 품목 스티커 부착',
    '같은 SKU 블록은 현장에서 교차 적재 + 랩핑',
    ...attachLinesOf(panels),
    '거래명세서 2부 출력 — 1부 기사 전달, 1부 물류센터 제출',
    `자리당 단수는 SKU 실측 높이 기준 (진도팜 곡물만 ${GRAIN_MAX_TIERS}단 캡) · 높이 = 팔레트 ${PALLET_MM}mm + 박스높이 × 단수`,
  ]
  foots.push(
    '수축포장지 3회 이상 감기, 테이프 사용 금지',
    'KPP·AJ 이동전표 2·3·4번은 기사 전달 (1번은 업체 보관)',
    '밀크런 접수 총 중량은 제품 중량에 박스·팔레트 무게를 더해 입력',
  )
  if (panels.some((p) => p.slots.some((s) => s?.parts))) foots.push(SCRAP_NOTE)
  if (plan.dimsUnknown) foots.push(`치수 미등록 상품은 ${DEFAULT_BOX_MM}mm 가정 — 마스터에 박스 치수 등록 필요`)
  const footY0 = bodyBottom + 26
  const H = footY0 + (foots.length - 1) * 18 + M

  const totalBoxes = panels.reduce((s, p) => s + p.boxes, 0)
  const poCount = new Set(panels.map((p) => p.poNumber)).size
  const title = `쿠팡 로켓 ${plan.dueDate || ''} 입고 — 팔레트 적재 구성도 (발주 ${poCount}건 · ${panels.length}PLT · 총 ${cm(totalBoxes)}박스)`.replace(/\s+/g, ' ')
  const subtitle = `실측 치수 기준 — 팔레트 ${cm(PALLET_W_MM)}×${cm(PALLET_D_MM)}mm · 자리당 단수 = 실측 (진도팜 곡물 ${GRAIN_MAX_TIERS}단 캡) · 팔레트 ${PALLET_MM}mm · 한도 ${cm(LIMIT_MM)}mm`

  // 패널이 적을 때 제목·캡션이 캔버스 밖으로 잘리지 않도록 폭을 넓혀 준다
  const textW = Math.max(
    textWidth(title, 16),
    textWidth(subtitle, 10.5),
    textWidth(descLine, 10.5),
    textWidth(excludedLine, 11),
    ...foots.map((f) => textWidth(f, 11)),
  )
  const W = M * 2 + Math.max(bodyW, textW)

  let s = rect(0, 0, W, H, { fill: '#F9FAFB' })
  s += text({ x: M, y: M + 24, s: title, size: 16, bold: true })
  s += text({ x: M, y: M + 46, s: subtitle, size: 10.5, fill: '#6B7280' })
  s += text({ x: M, y: M + 66, s: descLine, size: 10.5, fill: '#6B7280' })
  if (excludedLine) s += text({ x: M, y: M + 86, s: excludedLine, size: 11, bold: true, fill: '#B45309' })

  plan.legend.forEach((l, i) => {
    const x = M + legendPos[i].x
    const y = legendY + legendPos[i].r * 20
    s += rect(x, y - 10, 13, 13, { fill: l.color, stroke: '#111827', sw: 1, rx: 2 })
    s += text({ x: x + 19, y, s: `${l.sku} — ${l.fullName}`, size: 10, fill: '#374151' })
  })

  let y = panelsY
  for (const g of groups) {
    const head = headOf(g)
    // 발주번호는 같은 줄 끝에 작게 — tspan 으로 이어 붙여 폭 추정 오차와 무관하게 바로 뒤에 온다
    s += `<text x="${n(M)}" y="${n(y + 16)}" font-size="13" font-weight="600" fill="#1D4ED8">${esc(head)}` +
      `<tspan font-size="10" font-weight="400" fill="#9CA3AF">  · 발주 ${esc(g[0].poNumber)}</tspan></text>`
    const z = sizeOf(g)
    const ph = panelLayout(z.nItems, z.nWarns).h
    rowsOf(g).forEach((line, r) => {
      line.forEach((p, c) => {
        s += panelSvg(p, M + c * (PANEL_W + PANEL_GAP), y + ROW_HEAD_H + r * (ph + PANEL_GAP), z.nItems, z.nWarns)
      })
    })
    y += groupH(g) + ROW_GAP
  }

  foots.forEach((f, i) => {
    s += text({ x: M, y: footY0 + i * 18, s: f, size: 11, bold: i < 2, fill: i < 2 ? '#111827' : '#374151' })
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}" font-family="${FONT}">` +
    s + '</svg>'
  )
}

/** coupang_{YYYYMMDD}_pallet_plan.jpg */
export function coupangPlanFileName(dueDate: string): string {
  const ymd = String(dueDate || '').replace(/[^0-9]/g, '').slice(0, 8)
  return `coupang_${ymd || 'nodate'}_pallet_plan.jpg`
}

export async function downloadCoupangPalletPlanJpg(svg: string, dueDate: string): Promise<void> {
  await downloadSvgAsJpg(svg, coupangPlanFileName(dueDate))
}

/** 인라인 렌더 — 생성한 SVG 는 모든 텍스트가 esc 처리됨 */
export function CoupangPalletPlanView({ svg }: { svg: string }) {
  return (
    <div className="overflow-x-auto">
      <div className="[&>svg]:h-auto [&>svg]:max-w-none" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
}
