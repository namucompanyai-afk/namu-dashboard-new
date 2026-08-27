/**
 * 쿠팡 팔레트 필요 안내 + 적재 구성도 (SVG).
 *
 * 컬리 도면(lib/b2b/kurlyDiagram.tsx)과 같은 구성이되, 쿠팡은 운송비 계산이 없다.
 * 적재는 상품마스터 실측 박스 치수로 1,100×1,100 바닥 자리를 계산하고,
 * 한 자리에 한 SKU만 올린다(SKU별 더미 분리). 자리가 차면 다음 PLT 로 넘긴다.
 * 파싱·분기·로켓 양식·매출·이력·라벨·운임 로직은 소비만 한다.
 */
import React from 'react'
import { norm } from './kurly'
import type { RoutedItem, ShipFrom } from './coupang'
import { downloadSvgAsJpg } from './svgExport'

// ── 적재 가정 ────────────────────────────────────────────────────
export const PALLET_BOX_LIMIT = 9 // 초과 시 택배 불가 → 팔레트 안내
export const DEFAULT_BOX_MM = 400 // 치수 미등록 상품 가정값
export const PALLET_MM = 150
export const LIMIT_MM = 1700 // 팔레트 포함 높이 한도 (컬리와 동일)
export const PALLET_W_MM = 1100 // 팔레트 바닥 가로
export const PALLET_D_MM = 1100 // 팔레트 바닥 세로
export const MAX_TIERS_PER_SLOT = 5 // 자리당 최대 단수 (30박스/PLT 운용 기준)

/** 출고지별 안내 — 운송수단은 자동 판정하지 않고 문구만 낸다 */
export const SHIP_FROM_GUIDE: Record<string, string> = {
  진도팜:
    '진도 출고는 밀크런 불가 — 팔레트 시 직접 화물 배차 (마감 입고 전일 18:00, 트럭 납품 시 쉽먼트 예약 필수)',
  위킵: '화성 출고는 밀크런 이용 가능 (접수 마감 D-1 영업일 16:00, 유료·매입대금 차감)',
}

// ── 발주 × 출고지 묶음 ───────────────────────────────────────────
export type PoPalletGroup = {
  poNumber: string
  center: string
  dueDate: string
  shipFrom: ShipFrom
  items: RoutedItem[]
  boxes: number
  needsPallet: boolean
}

/** 발주번호 단위 묶음 (호출부가 이미 출고지로 걸러 넘긴다) */
export function groupByPo(items: RoutedItem[]): PoPalletGroup[] {
  const map = new Map<string, PoPalletGroup>()
  for (const it of items) {
    let g = map.get(it.poNumber)
    if (!g) {
      g = {
        poNumber: it.poNumber,
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

/** 발주번호 × 출고지 묶음 (미분류는 제외 — 출고지 확정 전이라 안내 대상 아님) */
export function buildPalletGroups(routed: RoutedItem[]): PoPalletGroup[] {
  const out: PoPalletGroup[] = []
  for (const sf of ['진도팜', '위킵'] as ShipFrom[]) {
    out.push(...groupByPo(routed.filter((r) => r.shipFrom === sf)))
  }
  return out.sort((a, b) =>
    a.dueDate === b.dueDate ? a.poNumber.localeCompare(b.poNumber) : a.dueDate.localeCompare(b.dueDate),
  )
}

export type CenterAdvisory = { center: string; dueDate: string; boxes: number; poCount: number }

/**
 * 같은 센터·같은 입고예정일에 발주가 여러 건이고 합산 9박스 초과면 참고 문구만 낸다.
 * (확정 판정 아님 — 발주별 배지는 발주 단위 박스 수 그대로)
 */
export function buildCenterAdvisories(groups: PoPalletGroup[]): CenterAdvisory[] {
  const map = new Map<string, { center: string; dueDate: string; boxes: number; pos: Set<string> }>()
  for (const g of groups) {
    const k = `${g.center}|${g.dueDate}`
    let e = map.get(k)
    if (!e) {
      e = { center: g.center, dueDate: g.dueDate, boxes: 0, pos: new Set() }
      map.set(k, e)
    }
    e.boxes += g.boxes
    e.pos.add(g.poNumber)
  }
  return [...map.values()]
    .filter((e) => e.pos.size >= 2 && e.boxes > PALLET_BOX_LIMIT)
    .map((e) => ({ center: e.center, dueDate: e.dueDate, boxes: e.boxes, poCount: e.pos.size }))
}

// ── 자리(더미) 모델 ──────────────────────────────────────────────
const COLORS = [
  '#64B5F6', '#F5C542', '#81C784', '#E57373',
  '#BA68C8', '#4DB6AC', '#FFB74D', '#90A4AE',
]

/** '[보배마을] 현미 귀리 즉석밥 180g * 6' → '즉석밥' */
export function shortName(raw: string): string {
  let s = String(raw || '').trim()
  s = s.replace(/\[[^\]]*\]/g, ' ') // 브랜드 대괄호
  s = s.replace(/[*x×]\s*\d+\s*$/i, ' ') // 낱개 묶음 표기 (* 6)
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

export type PlanSku = {
  sku: string
  fullName: string
  color: string
  boxes: number
  dims: BoxDims
}

/** 자리 하나 = SKU 하나(한 자리에 한 SKU만) */
export type PlanSlot = {
  sku: string
  fullName: string
  color: string
  tiers: number
  dims: BoxDims
}

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
  items: { sku: string; fullName: string; color: string; boxes: number; slots: number }[]
  boxes: number // 이 PLT 박스 수
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
}

/** 박스 많은 순 → 자리 배분(자리당 최대 MAX_TIERS_PER_SLOT단), 같은 SKU 는 인접 자리 연속 */
export function allocateSlots(skus: PlanSku[]): PlanSlot[] {
  const out: PlanSlot[] = []
  const sorted = [...skus].sort((a, b) => (b.boxes - a.boxes) || a.sku.localeCompare(b.sku))
  for (const s of sorted) {
    let left = s.boxes
    while (left > 0) {
      const tiers = Math.min(MAX_TIERS_PER_SLOT, left)
      out.push({ sku: s.sku, fullName: s.fullName, color: s.color, tiers, dims: s.dims })
      left -= tiers
    }
  }
  return out
}

/** 팔레트 필요 발주 → PLT 단위 패널 (자리 수를 넘기면 다음 PLT 로 넘긴다) */
export function buildCoupangPalletPlan(groups: PoPalletGroup[]): CoupangPalletPlan {
  const need = groups.filter((g) => g.needsPallet)

  const colorOf = new Map<string, string>()
  let ci = 0
  for (const g of need) {
    for (const it of g.items) {
      const k = norm(it.barcode) || norm(it.productName)
      if (!colorOf.has(k)) colorOf.set(k, COLORS[ci++ % COLORS.length])
    }
  }

  const panels: PlanPanel[] = []
  for (const g of need) {
    // 같은 발주 안에서 상품 단위 합산
    const byKey = new Map<string, PlanSku>()
    for (const it of g.items) {
      const k = norm(it.barcode) || norm(it.productName)
      let p = byKey.get(k)
      if (!p) {
        const full = it.master?.alias || it.productName
        p = {
          sku: shortName(full),
          fullName: full,
          color: colorOf.get(k) || COLORS[0],
          boxes: 0,
          dims: dimsOf(it.master),
        }
        byKey.set(k, p)
      }
      p.boxes += it.boxes ?? 0
    }
    const skus = [...byKey.values()].filter((s) => s.boxes > 0)
    if (!skus.length) continue

    // 바닥 격자는 가장 큰 박스 기준(자리 수가 제일 적게 나오는 쪽)으로 잡는다
    const grids = skus.map((s) => floorGrid(s.dims))
    const grid = grids.reduce((a, b) => (b.slots < a.slots ? b : a))
    const dimsUnknown = skus.some((s) => s.dims.unknown)

    const slots = allocateSlots(skus)
    const total = Math.max(1, Math.ceil(slots.length / grid.slots))

    for (let i = 0; i < total; i++) {
      const mine = slots.slice(i * grid.slots, (i + 1) * grid.slots)
      const padded: (PlanSlot | null)[] = Array.from(
        { length: grid.slots },
        (_, k) => mine[k] ?? null,
      )
      const items: PlanPanel['items'] = []
      for (const s of mine) {
        let e = items.find((x) => x.fullName === s.fullName)
        if (!e) {
          e = { sku: s.sku, fullName: s.fullName, color: s.color, boxes: 0, slots: 0 }
          items.push(e)
        }
        e.boxes += s.tiers
        e.slots += 1
      }
      const maxTier = mine.reduce((m, s) => Math.max(m, s.tiers), 0)
      const stackMm = mine.reduce((m, s) => Math.max(m, s.tiers * s.dims.h), 0)
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
        poBoxes: g.boxes,
        maxTier,
        heightMm,
        slackMm: LIMIT_MM - heightMm,
        over: heightMm > LIMIT_MM,
        dimsUnknown,
      })
    }
  }

  const seen = new Set<string>()
  const legend: CoupangPalletPlan['legend'] = []
  for (const p of panels) {
    for (const it of p.items) {
      if (seen.has(it.fullName)) continue
      seen.add(it.fullName)
      legend.push({ sku: it.sku, fullName: it.fullName, color: it.color })
    }
  }

  return {
    dueDate: need.find((g) => g.dueDate)?.dueDate || '',
    panels,
    legend,
    dimsUnknown: panels.some((p) => p.dimsUnknown),
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
    if (i % p.cols === 0) {
      out += text({
        x: ox + 6 + i * slot + (p.cols * slot) / 2, y: base + 11,
        s: `${Math.floor(i / p.cols) + 1}열`, size: 8.5, fill: '#6B7280', anchor: 'middle',
      })
    }
    if (!s) {
      out += rect(x, palTop - 10, colW, 10, { stroke: '#9CA3AF', sw: 1, dash: '4 3' })
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

function panelSvg(p: PlanPanel, ox: number, oy: number, maxItems: number, panelH: number): string {
  const itemsBottom = 78 + (maxItems - 1) * ITEM_LH + 8
  const topLabelY = itemsBottom + 16
  const topY = topLabelY + 8
  const sideLabelY = topY + PAL + 24
  const sideY = sideLabelY + 8
  const heightY = sideY + SIDE_H + 22

  const dims = (p.slots.find((s) => s) || null)?.dims
  let out = rect(ox, oy, PANEL_W, panelH, { fill: '#FFFFFF', stroke: '#D1D5DB', sw: 1, rx: 6 })
  out += text({ x: ox + 14, y: oy + 26, s: `발주 ${p.poNumber} — PLT ${p.index}/${p.total}`, size: 14, bold: true })
  out += text({ x: ox + 14, y: oy + 44, s: `${p.center} · ${p.dueDate}`, size: 10.5, fill: '#4B5563' })
  out += text({
    x: ox + 14, y: oy + 60,
    s: `출고지 ${p.shipFrom} · 이 PLT ${cm(p.boxes)}박스 / 발주 ${cm(p.poBoxes)}박스 · 자리 ${p.slots.filter((s) => s).length}/${p.slotCount}`,
    size: 10.5, bold: true, fill: '#374151',
  })

  p.items.forEach((it, i) => {
    out += text({
      x: ox + 14, y: oy + 78 + i * ITEM_LH,
      s: `${it.sku} ${cm(it.boxes)}박스 · ${it.slots}자리`, size: 10, fill: '#374151',
    })
    out += rect(ox + PANEL_W - 24, oy + 78 + i * ITEM_LH - 8, 10, 10, { fill: it.color, stroke: '#111827', sw: 1 })
  })

  out += text({
    x: ox + 14, y: oy + topLabelY,
    s: `탑뷰 — ${p.cols}×${p.rows} = ${p.slotCount}자리 (박스 ${dims ? `${dims.w}×${dims.d}` : '—'}mm)`,
    size: 10.5, bold: true, fill: '#374151',
  })
  out += topView(p, ox + ART_X, oy + topY)
  out += text({ x: ox + 14, y: oy + sideLabelY, s: '사이드뷰 (옆에서 본 적재)', size: 10.5, bold: true, fill: '#374151' })
  out += sideView(p, ox + ART_X, oy + sideY)

  out += text({
    x: ox + 14, y: oy + heightY,
    s: `총 높이 ${PALLET_MM} + ${cm(p.heightMm - PALLET_MM)} = ${cm(p.heightMm)}mm · 여유 ${cm(p.slackMm)}mm`,
    size: 10, bold: true, fill: p.over ? '#DC2626' : '#15803D',
  })
  out += text({
    x: ox + 14, y: oy + heightY + 16,
    s: p.over ? `⚠ 한도 ${cm(LIMIT_MM)}mm 초과 — 단수 조정 필요` : `한도 ${cm(LIMIT_MM)}mm 이내 (최대 ${p.maxTier}단)`,
    size: 10, bold: p.over, fill: p.over ? '#DC2626' : '#15803D',
  })
  if (p.dimsUnknown) {
    out += text({
      x: ox + 14, y: oy + heightY + 32,
      s: `⚠ 치수 미등록 — ${DEFAULT_BOX_MM}mm 가정`, size: 10, bold: true, fill: '#B45309',
    })
  }
  return out
}

export function renderCoupangPalletPlanSvg(plan: CoupangPalletPlan): string {
  const panels = plan.panels
  if (!panels.length) return ''
  const perRow = Math.min(PANELS_PER_ROW, panels.length)
  const panelRows = Math.ceil(panels.length / perRow)
  const maxItems = Math.max(1, ...panels.map((p) => p.items.length))

  const itemsBottom = 78 + (maxItems - 1) * ITEM_LH + 8
  const panelH = itemsBottom + 16 + 8 + PAL + 24 + 8 + SIDE_H + 22 + 16 + 14 + (plan.dimsUnknown ? 16 : 0)

  const bodyW = perRow * PANEL_W + (perRow - 1) * PANEL_GAP
  const legendPerRow = Math.max(1, Math.floor(bodyW / LEGEND_W))
  const legendRows = Math.max(1, Math.ceil(plan.legend.length / legendPerRow))
  const legendY = M + 70
  const panelsY = legendY + (legendRows - 1) * 20 + 22

  const bodyBottom = panelsY + panelRows * panelH + (panelRows - 1) * PANEL_GAP
  const foots = [
    'KPP/AJ 팔레트 사용 (목재·일회용 금지)',
    '랩핑 필수',
    'SKU별 자리(더미) 분리 — 더미 외부에 품목 스티커 부착',
    '같은 SKU 블록은 현장에서 교차 적재 + 랩핑',
    '부착물: 적재리스트(2면) + 쉽먼트 라벨(앞·옆면), 발주서·거래명세서는 기사 전달',
    `자리당 최대 ${MAX_TIERS_PER_SLOT}단 · 높이 = 팔레트 ${PALLET_MM}mm + 박스높이 × 단수`,
  ]
  if (plan.dimsUnknown) foots.push(`치수 미등록 상품은 ${DEFAULT_BOX_MM}mm 가정 — 마스터에 박스 치수 등록 필요`)
  const footY0 = bodyBottom + 26
  const H = footY0 + (foots.length - 1) * 18 + M

  const totalBoxes = panels.reduce((s, p) => s + p.boxes, 0)
  const poCount = new Set(panels.map((p) => p.poNumber)).size
  const title = `쿠팡 로켓 ${plan.dueDate || ''} 입고 — 팔레트 적재 구성도 (발주 ${poCount}건 · ${panels.length}PLT · 총 ${cm(totalBoxes)}박스)`.replace(/\s+/g, ' ')
  const subtitle = `실측 치수 기준 — 팔레트 ${cm(PALLET_W_MM)}×${cm(PALLET_D_MM)}mm · 자리당 최대 ${MAX_TIERS_PER_SLOT}단 · 팔레트 ${PALLET_MM}mm · 한도 ${cm(LIMIT_MM)}mm`

  // 패널이 적을 때 제목·캡션이 캔버스 밖으로 잘리지 않도록 폭을 넓혀 준다
  const textW = Math.max(
    textWidth(title, 16),
    textWidth(subtitle, 10.5),
    ...foots.map((f) => textWidth(f, 11)),
  )
  const W = M * 2 + Math.max(bodyW, textW)

  let s = rect(0, 0, W, H, { fill: '#F9FAFB' })
  s += text({ x: M, y: M + 24, s: title, size: 16, bold: true })
  s += text({ x: M, y: M + 46, s: subtitle, size: 10.5, fill: '#6B7280' })

  plan.legend.forEach((l, i) => {
    const r = Math.floor(i / legendPerRow)
    const c = i % legendPerRow
    const x = M + c * LEGEND_W
    const y = legendY + r * 20
    s += rect(x, y - 10, 13, 13, { fill: l.color, stroke: '#111827', sw: 1, rx: 2 })
    s += text({ x: x + 19, y, s: `${l.sku} — ${l.fullName}`, size: 10, fill: '#374151' })
  })

  panels.forEach((p, i) => {
    const r = Math.floor(i / perRow)
    const c = i % perRow
    s += panelSvg(p, M + c * (PANEL_W + PANEL_GAP), panelsY + r * (panelH + PANEL_GAP), maxItems, panelH)
  })

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
