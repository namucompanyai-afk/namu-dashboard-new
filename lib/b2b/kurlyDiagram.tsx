/**
 * 컬리 팔레트 적재 구성도 (SVG).
 *
 * lib/b2b/kurly.ts 의 산출물(KurlyOrderRow · PalletGroup)을 **소비만** 한다 —
 * 파싱·팔레트·운송비 로직은 여기서 건드리지 않는다.
 *
 * buildPalletPlan()  : 발주행 + 팔레트그룹 → 도면 모델
 * renderPalletPlanSvg(): 도면 모델 → 단일 SVG 문자열 (페이지 인라인 렌더 · 다운로드 겸용)
 */
import type { KurlyOrderRow, PalletGroup, ProductMaster } from './kurly'
import { norm } from './kurly'

// ── 적재 가정 (치수 데이터 없음 → 도면에 가정값 명시) ─────────────
export const BOX_MM = 400 // 박스 높이 가정
export const PALLET_MM = 150 // 팔레트 자체 높이
export const LIMIT_MM = 1700 // 컬리 적재 한도
export const MAX_TIER = 2 // 기둥당 최대 단수
export const SAFE_MM = 50 // 이 미만 여유면 회송 위험

// ── 색 ───────────────────────────────────────────────────────────
// 지정 색은 고정, 나머지 SKU 는 팔레트에서 구분되는 색을 자동 배정
const FIXED_COLORS: { test: (s: string) => boolean; color: string }[] = [
  { test: (s) => s.includes('강황'), color: '#F5C542' },
  { test: (s) => s.includes('고춧') || s.includes('고추'), color: '#E57373' },
]
const AUTO_COLORS = [
  '#64B5F6', '#81C784', '#BA68C8', '#4DB6AC',
  '#FFB74D', '#A1887F', '#90A4AE', '#F06292',
]

// ── 도면 모델 ────────────────────────────────────────────────────
export type PlanItem = {
  masterCode: string
  sku: string // 축약 표시명 (강황 · 고춧 …)
  fullName: string // 범례/툴팁용 원래 이름
  color: string
  boxes: number
  units: number // 낱개 수 (부제 병기용)
  codeTails: string[] // 발주코드 끝 6자리
  columns: number[] // 기둥별 단수 (예: 4박스 → [2,2])
}

export type PlanPanel = {
  plt: number // PLT 번호 (1-based)
  dest: string
  viaLabel: string // '직납·경유안함' | '경유: 평택1'
  items: PlanItem[]
  boxes: number
  maxTier: number
  heightMm: number
  slackMm: number
  risky: boolean // 여유 SAFE_MM 미만
  singleBox: boolean // 1박스 단독 → 랩핑·결박 필수
}

export type PalletPlan = {
  dueDate: string // YYYY-MM-DD
  panels: PlanPanel[]
  totalBoxes: number
  totalUnits: number
  legend: { sku: string; fullName: string; color: string }[]
}

// ── 표시명 축약 ──────────────────────────────────────────────────
// '[보배마을] 농부가 만든 무농약 고춧가루 100g' → '고춧'
export function shortSkuName(raw: string): string {
  let s = String(raw || '').trim()
  s = s.replace(/\[[^\]]*\]/g, ' ') // [보배마을] 등 브랜드 대괄호 제거
  s = s.replace(/\b\d+(\.\d+)?\s*(kg|g|ml|l|개|입|팩|봉|포)\b/gi, ' ') // 용량·수량 토큰
  s = s.replace(/\s+/g, ' ').trim()
  const last = s.split(' ').filter(Boolean).pop() || s // 수식어 떼고 핵심 명사
  let core = last || s
  if (core.length > 3 && (core.endsWith('가루') || core.endsWith('분말'))) core = core.slice(0, -2)
  if (!core) core = String(raw || '').trim()
  return core.length > 8 ? core.slice(0, 8) : core
}

/** 박스 n개 → 기둥별 단수. 기둥당 최대 MAX_TIER, 앞 기둥부터 채운다. */
export function packColumns(boxes: number, maxTier = MAX_TIER): number[] {
  const out: number[] = []
  let left = Math.max(0, Math.floor(boxes))
  while (left > 0) {
    const t = Math.min(maxTier, left)
    out.push(t)
    left -= t
  }
  return out
}

/** 경유센터 표기 — '경유안함'이면 직납으로 읽는다 */
function viaLabelOf(viaCenters: string[]): string {
  const real = viaCenters.filter((v) => v && !norm(v).includes('경유안함'))
  return real.length === 0 ? '직납·경유안함' : `경유: ${real.join(', ')}`
}

/**
 * 팔레트 목록 → 도면 모델.
 * pallets 는 buildPallets() 결과 그대로(입고지 등장 순서 = PLT 번호).
 */
export function buildPalletPlan(
  orders: KurlyOrderRow[],
  pallets: PalletGroup[],
  masterByCode: Record<string, ProductMaster>,
): PalletPlan {
  // 전체 SKU 색 배정 (도면 전체에서 구분되게 — 범례와 같은 색)
  const colorOf = new Map<string, string>()
  const nameOf = new Map<string, string>()
  let autoIdx = 0
  for (const o of orders) {
    const key = norm(o.masterCode)
    if (!key || colorOf.has(key)) continue
    const full = masterByCode[key]?.alias || o.productName || o.masterCode
    nameOf.set(key, full)
    const fixed = FIXED_COLORS.find((f) => f.test(full))
    colorOf.set(key, fixed ? fixed.color : AUTO_COLORS[autoIdx++ % AUTO_COLORS.length])
  }

  const panels: PlanPanel[] = pallets.map((g, gi) => {
    // 같은 팔레트 안에서 마스터코드 단위로 합산 (등장 순서 유지)
    const byCode = new Map<string, PlanItem>()
    for (const idx of g.rowIndexes) {
      const o = orders[idx]
      const key = norm(o.masterCode)
      let it = byCode.get(key)
      if (!it) {
        const full = nameOf.get(key) || o.productName || o.masterCode
        it = {
          masterCode: o.masterCode,
          sku: shortSkuName(full),
          fullName: full,
          color: colorOf.get(key) || AUTO_COLORS[0],
          boxes: 0,
          units: 0,
          codeTails: [],
          columns: [],
        }
        byCode.set(key, it)
      }
      it.boxes += o.boxCount
      it.units += o.totalUnits
      const tail = String(o.productCode || '').slice(-6)
      if (tail && !it.codeTails.includes(tail)) it.codeTails.push(tail)
    }
    const items = [...byCode.values()]
    for (const it of items) it.columns = packColumns(it.boxes)

    const maxTier = items.reduce((m, it) => Math.max(m, ...it.columns, 0), 0)
    const heightMm = PALLET_MM + maxTier * BOX_MM
    const slackMm = LIMIT_MM - heightMm
    return {
      plt: gi + 1,
      dest: g.dest,
      viaLabel: viaLabelOf(g.viaCenters),
      items,
      boxes: g.totalBoxes,
      maxTier,
      heightMm,
      slackMm,
      risky: slackMm < SAFE_MM,
      singleBox: g.totalBoxes === 1,
    }
  })

  // 범례: 도면에 실제 등장하는 SKU 만
  const seen = new Set<string>()
  const legend: PalletPlan['legend'] = []
  for (const p of panels) {
    for (const it of p.items) {
      if (seen.has(it.masterCode)) continue
      seen.add(it.masterCode)
      legend.push({ sku: it.sku, fullName: it.fullName, color: it.color })
    }
  }

  return {
    dueDate: orders.find((o) => o.dueDate)?.dueDate || '',
    panels,
    totalBoxes: orders.reduce((s, o) => s + o.boxCount, 0),
    totalUnits: orders.reduce((s, o) => s + o.totalUnits, 0),
    legend,
  }
}

// ── SVG 생성 ─────────────────────────────────────────────────────
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
// 시트·발주파일에서 온 문자열이 그대로 마크업에 들어가므로 전부 이스케이프한다
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
const n = (v: number): string => (Math.round(v * 100) / 100).toString()
const cm = (v: number): string => v.toLocaleString('en-US')

// 레이아웃 상수
const M = 28 // 바깥 여백
const PANEL_W = 344
const PANEL_GAP = 18
const ART_W = 260 // 탑뷰/사이드뷰 그림 폭
const ART_X = (PANEL_W - ART_W) / 2
const PAL = ART_W // 탑뷰 팔레트 정사각 한 변
const SIDE_H = 200
const ITEM_LH = 15
const LEGEND_W = 168

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
  (o.rx ? ` rx="${o.rx}"` : '') +
  '/>'

/** 탑뷰 격자 한 변의 칸 수 — 기둥 4개까지는 2×2(표준 배치) */
const gridSideFor = (cols: number): number => Math.max(2, Math.ceil(Math.sqrt(Math.max(1, cols))))

/** 탑뷰: 팔레트 외곽 + SKU별 전용 구역 + 빈 공간 */
function topView(p: PlanPanel, ox: number, oy: number): string {
  const slots: (PlanItem | null)[] = []
  for (const it of p.items) for (let k = 0; k < it.columns.length; k++) slots.push(it)
  const g = gridSideFor(slots.length)
  const pad = 10
  const cell = (PAL - pad * (g + 1)) / g

  let out = rect(ox, oy, PAL, PAL, { fill: '#D7B899', stroke: '#8D6E63', sw: 2, rx: 4 })
  // 팔레트 데크 결 (나무 판자 느낌)
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
    // 이 칸이 해당 SKU 의 몇 번째 기둥인지 → 단수 표기
    const nth = slots.slice(0, i + 1).filter((s) => s === it).length
    const tiers = it.columns[nth - 1] ?? 1
    out += rect(x, y, cell, cell, { fill: it.color, stroke: '#111827', sw: 1.5, rx: 3 })
    out += text({ x: x + cell / 2, y: y + cell / 2 - 8, s: it.sku, size: 11, bold: true, anchor: 'middle' })
    out += text({ x: x + cell / 2, y: y + cell / 2 + 6, s: `${tiers}박스`, size: 9.5, fill: '#1F2937', anchor: 'middle' })
    out += text({ x: x + cell / 2, y: y + cell / 2 + 20, s: '세움 ↑', size: 9.5, fill: '#1F2937', anchor: 'middle' })
  }
  return out
}

/** 사이드뷰: 팔레트 막대 위에 SKU별 기둥 (다른 SKU 를 위에 얹지 않음) */
function sideView(p: PlanPanel, ox: number, oy: number): string {
  const base = oy + SIDE_H // 바닥
  const scale = (SIDE_H - 26) / LIMIT_MM
  const palH = PALLET_MM * scale
  const boxH = BOX_MM * scale
  const palTop = base - palH

  let out = `<line x1="${n(ox - 6)}" y1="${n(base)}" x2="${n(ox + ART_W + 6)}" y2="${n(base)}" stroke="#6B7280" stroke-width="1.5"/>`

  // 한도선 1,700mm
  const limitY = base - LIMIT_MM * scale
  out += `<line x1="${n(ox - 6)}" y1="${n(limitY)}" x2="${n(ox + ART_W + 6)}" y2="${n(limitY)}" stroke="#DC2626" stroke-width="1" stroke-dasharray="6 4"/>`
  out += text({ x: ox + ART_W + 4, y: limitY - 4, s: `한도 ${cm(LIMIT_MM)}mm`, size: 9, fill: '#DC2626', anchor: 'end' })

  // 팔레트 막대
  out += rect(ox, palTop, ART_W, palH, { fill: '#B08968', stroke: '#7A5C48', sw: 1.2 })
  out += text({ x: ox + 4, y: palTop + palH / 2 + 3.5, s: `팔레트 ${PALLET_MM}mm`, size: 8.5, fill: '#3E2723' })

  // 기둥 배치 (SKU 순서대로 좌→우)
  const cols: { it: PlanItem; tiers: number }[] = []
  for (const it of p.items) for (const t of it.columns) cols.push({ it, tiers: t })
  const avail = ART_W - 12
  const slot = avail / Math.max(1, cols.length)
  const colW = Math.min(50, Math.max(18, slot - 10))

  cols.forEach((c, i) => {
    const x = ox + 6 + i * slot + (slot - colW) / 2
    for (let t = 0; t < c.tiers; t++) {
      const y = palTop - (t + 1) * boxH
      out += rect(x, y, colW, boxH, { fill: c.it.color, stroke: '#111827', sw: 1.2 })
    }
    const topY = palTop - c.tiers * boxH
    out += text({ x: x + colW / 2, y: topY - 5, s: `${c.it.sku} ${c.tiers}단`, size: 9, bold: true, anchor: 'middle' })
  })

  // SKU 경계 세로 점선 — '각 상품 자기 기둥만' 시각화
  let acc = 0
  for (let k = 0; k < p.items.length - 1; k++) {
    acc += p.items[k].columns.length
    const x = ox + 6 + acc * slot
    out += `<line x1="${n(x)}" y1="${n(palTop - SIDE_H * 0.55)}" x2="${n(x)}" y2="${n(palTop)}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3"/>`
  }
  return out
}

function panelSvg(p: PlanPanel, ox: number, oy: number, maxItems: number, panelH: number): string {
  const itemsBottom = 64 + (maxItems - 1) * ITEM_LH + 8
  const topLabelY = itemsBottom + 16
  const topY = topLabelY + 8
  const sideLabelY = topY + PAL + 24
  const sideY = sideLabelY + 8
  const heightY = sideY + SIDE_H + 22
  const capY = heightY + 16

  let out = rect(ox, oy, PANEL_W, panelH, { fill: '#FFFFFF', stroke: '#D1D5DB', sw: 1, rx: 6 })
  out += text({ x: ox + 14, y: oy + 26, s: `PLT ${p.plt} — ${p.dest}`, size: 14, bold: true })
  out += text({ x: ox + 14, y: oy + 44, s: p.viaLabel, size: 10.5, fill: '#4B5563' })

  p.items.forEach((it, i) => {
    const tail = it.codeTails.length ? `(…${it.codeTails.join(', …')})` : ''
    out += text({
      x: ox + 14,
      y: oy + 64 + i * ITEM_LH,
      s: `${it.sku} ${it.boxes}박스(${cm(it.units)}개)${tail}`,
      size: 10,
      fill: '#374151',
    })
    out += rect(ox + PANEL_W - 24, oy + 64 + i * ITEM_LH - 8, 10, 10, { fill: it.color, stroke: '#111827', sw: 1 })
  })

  out += text({ x: ox + 14, y: oy + topLabelY, s: '탑뷰 (위에서 본 배치)', size: 10.5, bold: true, fill: '#374151' })
  out += topView(p, ox + ART_X, oy + topY)

  out += text({ x: ox + 14, y: oy + sideLabelY, s: '사이드뷰 (옆에서 본 적재)', size: 10.5, bold: true, fill: '#374151' })
  out += sideView(p, ox + ART_X, oy + sideY)

  const ok = !p.risky
  out += text({
    x: ox + 14,
    y: oy + heightY,
    s: `총 높이 ${PALLET_MM} + ${BOX_MM}×${p.maxTier}단 = ${cm(p.heightMm)}mm · 여유 ${cm(p.slackMm)}mm`,
    size: 10,
    bold: true,
    fill: ok ? '#15803D' : '#DC2626',
  })
  if (!ok) {
    out += text({
      x: ox + 14, y: oy + capY,
      s: `⚠ 여유 ${SAFE_MM}mm 미만 — 회송 위험. 단수 조정 필요`,
      size: 10, bold: true, fill: '#DC2626',
    })
  } else if (p.singleBox) {
    out += text({ x: ox + 14, y: oy + capY, s: '※ 1박스 단독 — 랩핑·결박 필수', size: 10, bold: true, fill: '#B45309' })
  } else {
    out += text({ x: ox + 14, y: oy + capY, s: `한도 ${cm(LIMIT_MM)}mm 이내 · 적재 여유 충분`, size: 10, fill: '#15803D' })
  }
  return out
}

/** 도면 모델 → 단일 SVG 문자열 */
export function renderPalletPlanSvg(plan: PalletPlan): string {
  const panels = plan.panels
  const cols = Math.max(1, panels.length)
  const maxItems = Math.max(1, ...panels.map((p) => p.items.length))

  const itemsBottom = 64 + (maxItems - 1) * ITEM_LH + 8
  const panelH = itemsBottom + 16 + 8 + PAL + 24 + 8 + SIDE_H + 22 + 16 + 16

  const bodyW = cols * PANEL_W + (cols - 1) * PANEL_GAP
  const W = M * 2 + bodyW

  // 범례 줄바꿈
  const perRow = Math.max(1, Math.floor(bodyW / LEGEND_W))
  const legendRows = Math.max(1, Math.ceil(plan.legend.length / perRow))
  const legendY = M + 70
  const panelsY = legendY + (legendRows - 1) * 20 + 22

  const footY1 = panelsY + panelH + 26
  const footY2 = footY1 + 18
  const H = footY2 + M

  const title = `컬리 ${plan.dueDate || '(입고예정일 미상)'} 입고 — 팔레트 적재 구성도 (${panels.length}PLT · 총 ${cm(plan.totalBoxes)}박스 / ${cm(plan.totalUnits)}개)`

  let s = ''
  s += rect(0, 0, W, H, { fill: '#F9FAFB' })
  s += text({ x: M, y: M + 24, s: title, size: 16, bold: true })
  s += text({
    x: M, y: M + 46,
    s: `박스 높이 ${BOX_MM}mm 가정 · 팔레트 ${PALLET_MM}mm · 기둥당 최대 ${MAX_TIER}단 · 적재 한도 ${cm(LIMIT_MM)}mm`,
    size: 10.5, fill: '#6B7280',
  })

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

  s += text({ x: M, y: footY1, s: '각 상품 바닥부터 자기 기둥만 사용(세로 구분) — 다른 상품을 위에 얹는 가로 층 없음', size: 11, fill: '#374151' })
  s += text({
    x: M, y: footY2,
    s: `높이 계산: 팔레트 ${PALLET_MM}mm + 박스 ${BOX_MM}mm × 최대 단수 (치수 미제공으로 박스 ${BOX_MM}mm 가정) · 한도 ${cm(LIMIT_MM)}mm`,
    size: 11, fill: '#374151',
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}" font-family="${FONT}">` +
    s +
    '</svg>'
  )
}

/** 다운로드 파일명 — kurly_{YYYYMMDD}_pallet_plan.{ext} */
export function palletPlanFileName(dueDate: string, ext = 'jpg'): string {
  const ymd = String(dueDate || '').replace(/[^0-9]/g, '').slice(0, 8)
  return `kurly_${ymd || 'nodate'}_pallet_plan.${ext}`
}

/** 생성한 SVG 의 width/height 속성 (캔버스 크기 산정용) */
function svgSize(svg: string): { w: number; h: number } {
  const m = /<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/.exec(svg)
  return { w: m ? Number(m[1]) : 1200, h: m ? Number(m[2]) : 900 }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * SVG → JPG 저장 (외부 라이브러리 없이 Image + canvas).
 * JPG 는 투명을 지원하지 않으므로 흰 배경을 먼저 칠하고 그린다.
 * 한글이 기본 폰트로 대체되어 깨지지 않도록 document.fonts.ready 를 기다린 뒤 렌더한다.
 */
export async function downloadPalletPlanJpg(
  svg: string,
  dueDate: string,
  scale = 2,
  quality = 0.92,
): Promise<void> {
  try {
    await document.fonts?.ready
  } catch {
    /* 폰트 준비 실패는 무시하고 기본 폰트로 진행 */
  }
  const { w, h } = svgSize(svg)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('도면 이미지를 만들지 못했습니다.'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('캔버스를 사용할 수 없습니다.')
    ctx.fillStyle = '#FFFFFF' // JPG 투명 미지원 → 흰 배경 강제
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const jpg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('JPG 변환에 실패했습니다.'))),
        'image/jpeg',
        quality,
      ),
    )
    saveBlob(jpg, palletPlanFileName(dueDate, 'jpg'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ── 위킵 전달용 파렛 안내 텍스트 ─────────────────────────────────
/** 카톡 붙여넣기용 플레인 텍스트. 상품명은 상품마스터 별칭(없으면 발주 파일 상품명) */
export function buildWikeepNotice(plan: PalletPlan): string {
  const lines: string[] = []
  lines.push(`[컬리 ${plan.dueDate || '(입고예정일 미상)'} 입고 — 파렛 안내]`)
  lines.push(`총 ${plan.panels.length}PLT 준비 부탁드립니다.`)

  for (const p of plan.panels) {
    const via = p.viaLabel.startsWith('경유:') ? p.viaLabel : '직납'
    lines.push('')
    lines.push(`PLT ${p.plt} — ${p.dest} (${via})`)
    for (const it of p.items) {
      lines.push(`- ${it.fullName} ${cm(it.boxes)}박스 (${cm(it.units)}개)`)
    }
  }

  const wrapped = plan.panels.filter((p) => p.singleBox).map((p) => `PLT ${p.plt}`)
  lines.push('')
  lines.push('※ 팔레트당 상품별 세로 구분 적재(다른 상품 위에 얹기 금지)')
  lines.push('※ 제조·소비기한 확인 부탁드립니다 (발주서·라벨·실물 삼자 일치)')
  lines.push('※ 부착 서류 필히 부착')
  if (wrapped.length) {
    lines.push(`※ 1박스 단독 팔레트는 랩핑·결박 필수 (해당: ${wrapped.join(', ')})`)
  }
  lines.push('※ 배차 마감: 입고 전일 18:00')

  return lines.join('\n')
}

/** 인라인 렌더 — renderPalletPlanSvg 결과를 그대로 붙인다(모든 텍스트는 esc 처리됨) */
export function PalletPlanView({ svg }: { svg: string }) {
  return (
    <div className="overflow-x-auto">
      <div className="[&>svg]:h-auto [&>svg]:max-w-none" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
}
