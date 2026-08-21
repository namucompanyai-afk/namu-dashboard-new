/**
 * 쿠팡 팔레트 필요 안내 + 적재 구성도 (SVG).
 *
 * 컬리 도면(lib/b2b/kurlyDiagram.tsx)과 같은 구성이되,
 * 쿠팡은 운송비 계산이 없고 PLT 분할도 **판정하지 않는다** — 발주당 1PLT 가정의 참고용 도면이다.
 * 파싱·분기·로켓 양식·매출·이력·라벨 로직은 소비만 한다.
 */
import React from 'react'
import { norm } from './kurly'
import type { RoutedItem, ShipFrom } from './coupang'
import { downloadSvgAsJpg } from './svgExport'

// ── 적재 가정 ────────────────────────────────────────────────────
export const PALLET_BOX_LIMIT = 9 // 초과 시 택배 불가 → 팔레트 안내
export const BOX_MM = 400 // 박스 높이 가정
export const PALLET_MM = 150
export const LIMIT_MM = 1700 // 팔레트 포함 높이 한도 (컬리와 동일)
const BASE_FOOTPRINTS = 4 // 표준 2×2 적재면 가정

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

// ── 도면 모델 ────────────────────────────────────────────────────
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

export type PlanItem = {
  sku: string
  fullName: string
  color: string
  boxes: number
  columns: number[] // 기둥별 단수
}

export type PlanPanel = {
  poNumber: string
  center: string
  dueDate: string
  shipFrom: ShipFrom
  items: PlanItem[]
  boxes: number
  maxTier: number
  heightMm: number
  slackMm: number
  over: boolean // 한도 초과 → 빨강 경고
}

export type CoupangPalletPlan = {
  dueDate: string
  panels: PlanPanel[]
  legend: { sku: string; fullName: string; color: string }[]
}

/**
 * 적재면(기둥) 배분 — SKU 마다 최소 1기둥을 주고, 남는 면은 가장 높이 쌓이는 SKU 에 준다.
 * 각 SKU 는 자기 기둥만 쓴다(세로 구분 적재).
 */
function allocateColumns(boxesPerSku: number[]): number[] {
  const cols = boxesPerSku.map(() => 1)
  let left = Math.max(0, Math.max(BASE_FOOTPRINTS, boxesPerSku.length) - boxesPerSku.length)
  while (left > 0) {
    let worst = 0
    for (let i = 1; i < cols.length; i++) {
      if (Math.ceil(boxesPerSku[i] / cols[i]) > Math.ceil(boxesPerSku[worst] / cols[worst])) worst = i
    }
    cols[worst]++
    left--
  }
  return cols
}

/** 팔레트 필요 발주만 도면 모델로 (1PLT 가정) */
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

  const panels: PlanPanel[] = need.map((g) => {
    // 같은 발주 안에서 상품 단위 합산
    const byKey = new Map<string, PlanItem>()
    for (const it of g.items) {
      const k = norm(it.barcode) || norm(it.productName)
      let p = byKey.get(k)
      if (!p) {
        const full = it.master?.alias || it.productName
        p = { sku: shortName(full), fullName: full, color: colorOf.get(k) || COLORS[0], boxes: 0, columns: [] }
        byKey.set(k, p)
      }
      p.boxes += it.boxes ?? 0
    }
    const items = [...byKey.values()].filter((i) => i.boxes > 0)

    const alloc = allocateColumns(items.map((i) => i.boxes))
    items.forEach((it, i) => {
      const c = Math.max(1, alloc[i])
      const base = Math.floor(it.boxes / c)
      const rem = it.boxes % c
      it.columns = Array.from({ length: c }, (_, k) => base + (k < rem ? 1 : 0)).filter((t) => t > 0)
    })

    const maxTier = items.reduce((m, it) => Math.max(m, ...it.columns, 0), 0)
    const heightMm = PALLET_MM + maxTier * BOX_MM
    return {
      poNumber: g.poNumber,
      center: g.center,
      dueDate: g.dueDate,
      shipFrom: g.shipFrom,
      items,
      boxes: g.boxes,
      maxTier,
      heightMm,
      slackMm: LIMIT_MM - heightMm,
      over: heightMm > LIMIT_MM,
    }
  })

  const seen = new Set<string>()
  const legend: CoupangPalletPlan['legend'] = []
  for (const p of panels) {
    for (const it of p.items) {
      if (seen.has(it.fullName)) continue
      seen.add(it.fullName)
      legend.push({ sku: it.sku, fullName: it.fullName, color: it.color })
    }
  }

  return { dueDate: need.find((g) => g.dueDate)?.dueDate || '', panels, legend }
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
const ART_W = 260
const ART_X = (PANEL_W - ART_W) / 2
const PAL = ART_W
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

const gridSideFor = (cols: number): number => Math.max(2, Math.ceil(Math.sqrt(Math.max(1, cols))))

/** 대략적인 렌더 폭 — 한글은 글자당 ~1em, 그 외는 ~0.55em. 캔버스가 제목보다 좁아지지 않게 쓴다 */
function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯　-〿＀-￯]/.test(ch) ? size : size * 0.55
  return w
}

function topView(p: PlanPanel, ox: number, oy: number): string {
  const slots: (PlanItem | null)[] = []
  for (const it of p.items) for (let k = 0; k < it.columns.length; k++) slots.push(it)
  const g = gridSideFor(slots.length)
  const pad = 10
  const cell = (PAL - pad * (g + 1)) / g

  let out = rect(ox, oy, PAL, PAL, { fill: '#D7B899', stroke: '#8D6E63', sw: 2, rx: 4 })
  for (let i = 1; i < 5; i++) {
    const y = oy + (PAL / 5) * i
    out += `<line x1="${n(ox + 4)}" y1="${n(y)}" x2="${n(ox + PAL - 4)}" y2="${n(y)}" stroke="#C0A183" stroke-width="1"/>`
  }
  for (let i = 0; i < g * g; i++) {
    const r = Math.floor(i / g)
    const c = i % g
    const x = ox + pad + c * (cell + pad)
    const y = oy + pad + r * (cell + pad)
    const it = slots[i]
    if (!it) {
      out += rect(x, y, cell, cell, { stroke: '#9CA3AF', sw: 1.2, dash: '5 4', rx: 3 })
      out += text({ x: x + cell / 2, y: y + cell / 2 + 4, s: '빈 공간', size: 10, fill: '#9CA3AF', anchor: 'middle' })
      continue
    }
    const nth = slots.slice(0, i + 1).filter((s) => s === it).length
    const tiers = it.columns[nth - 1] ?? 1
    out += rect(x, y, cell, cell, { fill: it.color, stroke: '#111827', sw: 1.5, rx: 3 })
    out += text({ x: x + cell / 2, y: y + cell / 2 - 6, s: it.sku, size: 11, bold: true, anchor: 'middle' })
    out += text({ x: x + cell / 2, y: y + cell / 2 + 9, s: `${tiers}박스`, size: 9.5, fill: '#1F2937', anchor: 'middle' })
  }
  return out
}

function sideView(p: PlanPanel, ox: number, oy: number): string {
  const base = oy + SIDE_H
  const scale = (SIDE_H - 26) / LIMIT_MM
  const palH = PALLET_MM * scale
  const boxH = BOX_MM * scale
  const palTop = base - palH

  let out = `<line x1="${n(ox - 6)}" y1="${n(base)}" x2="${n(ox + ART_W + 6)}" y2="${n(base)}" stroke="#6B7280" stroke-width="1.5"/>`
  const limitY = base - LIMIT_MM * scale
  out += `<line x1="${n(ox - 6)}" y1="${n(limitY)}" x2="${n(ox + ART_W + 6)}" y2="${n(limitY)}" stroke="#DC2626" stroke-width="1" stroke-dasharray="6 4"/>`
  out += text({ x: ox + ART_W + 4, y: limitY - 4, s: `한도 ${cm(LIMIT_MM)}mm`, size: 9, fill: '#DC2626', anchor: 'end' })
  out += rect(ox, palTop, ART_W, palH, { fill: '#B08968', stroke: '#7A5C48', sw: 1.2 })
  out += text({ x: ox + 4, y: palTop + palH / 2 + 3.5, s: `팔레트 ${PALLET_MM}mm`, size: 8.5, fill: '#3E2723' })

  const cols: { it: PlanItem; tiers: number }[] = []
  for (const it of p.items) for (const t of it.columns) cols.push({ it, tiers: t })
  const avail = ART_W - 12
  const slot = avail / Math.max(1, cols.length)
  const colW = Math.min(50, Math.max(16, slot - 8))

  cols.forEach((c, i) => {
    const x = ox + 6 + i * slot + (slot - colW) / 2
    for (let t = 0; t < c.tiers; t++) {
      out += rect(x, palTop - (t + 1) * boxH, colW, boxH, { fill: c.it.color, stroke: '#111827', sw: 1.2 })
    }
    out += text({
      x: x + colW / 2, y: palTop - c.tiers * boxH - 5,
      s: `${c.it.sku} ${c.tiers}단`, size: 8.5, bold: true, anchor: 'middle',
    })
  })

  let acc = 0
  for (let k = 0; k < p.items.length - 1; k++) {
    acc += p.items[k].columns.length
    const x = ox + 6 + acc * slot
    out += `<line x1="${n(x)}" y1="${n(palTop - SIDE_H * 0.6)}" x2="${n(x)}" y2="${n(palTop)}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3"/>`
  }
  return out
}

function panelSvg(p: PlanPanel, ox: number, oy: number, maxItems: number, panelH: number): string {
  const itemsBottom = 78 + (maxItems - 1) * ITEM_LH + 8
  const topLabelY = itemsBottom + 16
  const topY = topLabelY + 8
  const sideLabelY = topY + PAL + 24
  const sideY = sideLabelY + 8
  const heightY = sideY + SIDE_H + 22

  let out = rect(ox, oy, PANEL_W, panelH, { fill: '#FFFFFF', stroke: '#D1D5DB', sw: 1, rx: 6 })
  out += text({ x: ox + 14, y: oy + 26, s: `발주 ${p.poNumber}`, size: 14, bold: true })
  out += text({ x: ox + 14, y: oy + 44, s: `${p.center} · ${p.dueDate}`, size: 10.5, fill: '#4B5563' })
  out += text({ x: ox + 14, y: oy + 60, s: `출고지 ${p.shipFrom} · 총 ${cm(p.boxes)}박스`, size: 10.5, bold: true, fill: '#374151' })

  p.items.forEach((it, i) => {
    out += text({ x: ox + 14, y: oy + 78 + i * ITEM_LH, s: `${it.sku} ${cm(it.boxes)}박스`, size: 10, fill: '#374151' })
    out += rect(ox + PANEL_W - 24, oy + 78 + i * ITEM_LH - 8, 10, 10, { fill: it.color, stroke: '#111827', sw: 1 })
  })

  out += text({ x: ox + 14, y: oy + topLabelY, s: '탑뷰 (위에서 본 배치)', size: 10.5, bold: true, fill: '#374151' })
  out += topView(p, ox + ART_X, oy + topY)
  out += text({ x: ox + 14, y: oy + sideLabelY, s: '사이드뷰 (옆에서 본 적재)', size: 10.5, bold: true, fill: '#374151' })
  out += sideView(p, ox + ART_X, oy + sideY)

  out += text({
    x: ox + 14, y: oy + heightY,
    s: `총 높이 ${PALLET_MM} + ${BOX_MM}×${p.maxTier}단 = ${cm(p.heightMm)}mm · 여유 ${cm(p.slackMm)}mm`,
    size: 10, bold: true, fill: p.over ? '#DC2626' : '#15803D',
  })
  out += text({
    x: ox + 14, y: oy + heightY + 16,
    s: p.over ? `⚠ 한도 ${cm(LIMIT_MM)}mm 초과 — 팔레트 분할 필요` : `한도 ${cm(LIMIT_MM)}mm 이내`,
    size: 10, bold: p.over, fill: p.over ? '#DC2626' : '#15803D',
  })
  return out
}

export function renderCoupangPalletPlanSvg(plan: CoupangPalletPlan): string {
  const panels = plan.panels
  if (!panels.length) return ''
  const cols = panels.length
  const maxItems = Math.max(1, ...panels.map((p) => p.items.length))

  const itemsBottom = 78 + (maxItems - 1) * ITEM_LH + 8
  const panelH = itemsBottom + 16 + 8 + PAL + 24 + 8 + SIDE_H + 22 + 16 + 14

  const bodyW = cols * PANEL_W + (cols - 1) * PANEL_GAP
  const perRow = Math.max(1, Math.floor(bodyW / LEGEND_W))
  const legendRows = Math.max(1, Math.ceil(plan.legend.length / perRow))
  const legendY = M + 70
  const panelsY = legendY + (legendRows - 1) * 20 + 22

  const foot1 = panelsY + panelH + 26
  const foot2 = foot1 + 18
  const foot3 = foot2 + 18
  const foot4 = foot3 + 18
  const H = foot4 + M

  const totalBoxes = panels.reduce((s, p) => s + p.boxes, 0)
  const title = `쿠팡 로켓 ${plan.dueDate || ''} 입고 — 팔레트 적재 구성도 (팔레트 필요 발주 ${panels.length}건 · 총 ${cm(totalBoxes)}박스)`.replace(/\s+/g, ' ')
  const subtitle = `참고용 — 발주당 1PLT 가정, 실제 팔레트 수는 부피 확인 · 박스 높이 ${BOX_MM}mm 가정 · 팔레트 ${PALLET_MM}mm · 한도 ${cm(LIMIT_MM)}mm`
  const footer3 = '부착물: 적재리스트(2면) + 쉽먼트 라벨(앞·옆면), 발주서·거래명세서는 기사 전달'
  const footer4 = `각 상품 바닥부터 자기 기둥만 사용(세로 구분) · 높이 = 팔레트 ${PALLET_MM}mm + 박스 ${BOX_MM}mm × 단수`

  // 패널이 1개일 때 제목·캡션이 캔버스 밖으로 잘리지 않도록 폭을 넓혀 준다
  const textW = Math.max(
    textWidth(title, 16),
    textWidth(subtitle, 10.5),
    textWidth(footer3, 11),
    textWidth(footer4, 11),
  )
  const W = M * 2 + Math.max(bodyW, textW)

  let s = rect(0, 0, W, H, { fill: '#F9FAFB' })
  s += text({ x: M, y: M + 24, s: title, size: 16, bold: true })
  s += text({ x: M, y: M + 46, s: subtitle, size: 10.5, fill: '#6B7280' })

  plan.legend.forEach((l, i) => {
    const r = Math.floor(i / perRow)
    const c = i % perRow
    const x = M + c * LEGEND_W
    const y = legendY + r * 20
    s += rect(x, y - 10, 13, 13, { fill: l.color, stroke: '#111827', sw: 1, rx: 2 })
    s += text({ x: x + 19, y, s: `${l.sku} — ${l.fullName}`, size: 10, fill: '#374151' })
  })

  panels.forEach((p, i) => {
    s += panelSvg(p, M + i * (PANEL_W + PANEL_GAP), panelsY, maxItems, panelH)
  })

  s += text({ x: M, y: foot1, s: 'KPP/AJ 팔레트 사용 (목재·일회용 금지)', size: 11, bold: true, fill: '#111827' })
  s += text({ x: M, y: foot2, s: '랩핑 필수', size: 11, bold: true, fill: '#111827' })
  s += text({ x: M, y: foot3, s: footer3, size: 11, fill: '#374151' })
  s += text({ x: M, y: foot4, s: footer4, size: 11, fill: '#374151' })

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
