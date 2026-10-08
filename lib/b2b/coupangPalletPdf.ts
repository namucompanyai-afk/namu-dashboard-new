/**
 * 쿠팡 팔레트 적재 구성도 — A4 가로 PDF 내보내기 (표시 전용).
 *
 * 적재 계산·PLT 배정은 buildCoupangPalletPlan 결과(PlanPanel)를 읽기만 한다.
 * 화면용 SVG(renderCoupangPalletPlanSvg)와 별개로 mm 단위 페이지 SVG 를 그려
 * 캔버스로 JPG 화한 뒤 jsPDF 한 페이지에 한 장씩 넣는다(한글 폰트 임베드 불필요).
 *
 *   용지 A4 가로 · 여백 8mm · PLT 패널 4열 × 2행 (최소 글자 7pt 를 못 지키면 3열)
 *   1페이지 위: 제목 1줄 + 범례 + 택배 제외 안내 · 하단 페이지 번호 'n / 전체'
 *   패널: 센터 · PLT · 박스 · kg · 높이(굵게) / 탑뷰 + 사이드뷰 / 상품 · 박스 · 자리
 */
import {
  DEFAULT_BOX_MM,
  LIMIT_MM,
  PALLET_BOX_LIMIT,
  PALLET_MM,
  PALLET_W_MM,
  panelWarnsOf,
  type CoupangPalletPlan,
  type PlanPanel,
  type PlanSlot,
} from './coupangDiagram'
import { saveBlob } from './svgExport'

export const PDF_PAGE_W = 297 // A4 가로 (mm)
export const PDF_PAGE_H = 210
export const PDF_MARGIN = 8
export const PDF_ROWS = 2
export const PDF_MAX_COLS = 4
export const PDF_MIN_COLS = 3
export const PDF_MIN_PT = 7 // 인쇄 최소 글자
export const LOW_BOX_PLT_WARN = 5 // 박스가 이 값 미만인 PLT 는 화면 제목 줄에 경고

const PT = 0.3528 // 1pt = 0.3528mm
const MIN_FS = PDF_MIN_PT * PT // 2.47mm
const FS = 2.6 // 본문 글자(≈7.4pt)
const TITLE_FS = 2.9 // 패널 제목(≈8.2pt)
const LINE = 3.3 // 본문 줄 간격
const GAP = 3 // 패널 간격
const PAD = 2 // 패널 안쪽 여백
const DPI = 200
const FONT = "Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', -apple-system, sans-serif"

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
const n = (v: number): string => (Math.round(v * 100) / 100).toString()
const cm = (v: number): string => v.toLocaleString('en-US')

/** 대략 렌더 폭(mm) — 한글 ~1em, 그 외 ~0.55em (도면 SVG 와 같은 추정) */
const textWidth = (s: string, size: number): number => {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯　-〿＀-￯]/.test(ch) ? size : size * 0.55
  return w
}

type T = { x: number; y: number; s: string; size?: number; bold?: boolean; fill?: string; anchor?: string }
const text = ({ x, y, s, size = FS, bold, fill = '#111827', anchor }: T): string =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}"${bold ? ' font-weight="700"' : ''} fill="${fill}"${
    anchor ? ` text-anchor="${anchor}"` : ''
  }>${esc(s)}</text>`
const rect = (
  x: number, y: number, w: number, h: number,
  o: { fill?: string; stroke?: string; sw?: number; dash?: string; rx?: number } = {},
): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${o.fill ?? 'none'}"` +
  (o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 0.2}"` : '') +
  (o.dash ? ` stroke-dasharray="${o.dash}"` : '') +
  (o.rx ? ` rx="${o.rx}"` : '') + '/>'

/** 칸 안 이름 — 폭을 넘으면 공백(없으면 글자 중간)에서 2줄로. 2줄로도 안 되면 null */
function wrapName(name: string, maxW: number, size: number): string[] | null {
  if (textWidth(name, size) <= maxW) return [name]
  const sp = name.lastIndexOf(' ', Math.ceil(name.length / 2) + 2)
  const chars = [...name]
  const cut = sp > 0 ? [name.slice(0, sp), name.slice(sp + 1)] : [chars.slice(0, Math.ceil(chars.length / 2)).join(''), chars.slice(Math.ceil(chars.length / 2)).join('')]
  return cut.every((l) => textWidth(l, size) <= maxW) ? cut : null
}

// ── 패널 배치 ─────────────────────────────────────────────────────
type Geo = { pw: number; top: number; sideW: number }
const geoOf = (cols: number): Geo => {
  const pw = (PDF_PAGE_W - 2 * PDF_MARGIN - (cols - 1) * GAP) / cols
  const inner = pw - 2 * PAD - 2
  const top = inner * 0.55
  return { pw, top, sideW: inner - top }
}

const panelTitle = (p: PlanPanel): string =>
  `${p.center} · PLT ${p.index}/${p.total} · ${cm(p.boxes)}박스 · ${cm(Math.round(p.kg))}kg${p.kgKnown ? '' : '(일부)'} · ${cm(p.heightMm)}mm`
const itemLine = (it: PlanPanel['items'][number]): string => {
  const where = [it.slots ? `${it.slots}자리` : '', ...it.scrapLabels.map((l) => `자투리 ${l}`)].filter(Boolean).join(' + ')
  return [`${it.sku} ${cm(it.boxes)}박스`, where].filter(Boolean).join(' · ')
}
const cellOf = (p: PlanPanel, g: Geo) => {
  const scale = g.top / PALLET_W_MM
  const first = p.slots.find((s) => s) || null
  return { bw: (first?.dims.w ?? DEFAULT_BOX_MM) * scale, bd: (first?.dims.d ?? DEFAULT_BOX_MM) * scale }
}
const titleSize = (p: PlanPanel, g: Geo): number =>
  Math.min(TITLE_FS, (TITLE_FS * (g.pw - 2 * PAD)) / Math.max(1, textWidth(panelTitle(p), TITLE_FS)))

/** 이 열 수에서 모든 글자가 7pt 이상으로 들어가는지 */
function fitsAt(panels: PlanPanel[], cols: number): boolean {
  const g = geoOf(cols)
  return panels.every((p) => {
    if (titleSize(p, g) < MIN_FS) return false
    if (p.items.some((it) => textWidth(itemLine(it), FS) > g.pw - 2 * PAD - 3.5)) return false
    const { bw, bd } = cellOf(p, g)
    for (const s of p.slots) {
      if (!s) continue
      const label = s.parts ? `자투리 ${s.scrapLabel ?? ''}`.trim() : s.sku
      const lines = wrapName(label, bw - 0.8, FS)
      if (!lines || (lines.length + 1) * (FS + 0.3) > bd) return false
    }
    const pitch = (g.sideW - 1) / Math.max(1, p.slotCount)
    return p.slots.every((s) => !s || textWidth(`${s.tiers}단`, FS) <= pitch + 0.4)
  })
}

const panelNeedH = (p: PlanPanel, g: Geo): number =>
  PAD + 4.6 + g.top + 3.4 + 1 + Math.max(1, p.items.length) * LINE + panelWarnsOf(p).length * LINE + PAD

// ── 탑뷰 · 사이드뷰 (mm) ──────────────────────────────────────────
function topView(p: PlanPanel, ox: number, oy: number, size: number, g: Geo): string {
  let out = rect(ox, oy, size, size, { fill: '#D7B899', stroke: '#8D6E63', sw: 0.35, rx: 0.8 })
  const { bw, bd } = cellOf(p, g)
  const padX = (size - p.cols * bw) / (p.cols + 1)
  const padY = (size - p.rows * bd) / (p.rows + 1)
  const label = (x: number, y: number, lines: string[], sub: string) => {
    const lh = FS + 0.3
    const y0 = y + bd / 2 - ((lines.length + 1) * lh) / 2 + FS
    let o = ''
    lines.forEach((l, k) => (o += text({ x: x + bw / 2, y: y0 + k * lh, s: l, bold: true, anchor: 'middle' })))
    o += text({ x: x + bw / 2, y: y0 + lines.length * lh, s: sub, fill: '#1F2937', anchor: 'middle' })
    return o
  }
  for (let i = 0; i < p.slotCount; i++) {
    const x = ox + padX + (i % p.cols) * (bw + padX)
    const y = oy + padY + Math.floor(i / p.cols) * (bd + padY)
    const s: PlanSlot | null = p.slots[i]
    if (!s) {
      out += rect(x, y, bw, bd, { stroke: '#6B7280', sw: 0.25, dash: '1 0.8', rx: 0.5 })
      out += text({ x: x + bw / 2, y: y + bd / 2 + FS / 3, s: '빈 자리', fill: '#6B7280', anchor: 'middle' })
      continue
    }
    if (s.parts) {
      const stripe = bw / s.parts.length
      s.parts.forEach((part, k) => (out += rect(x + k * stripe, y, stripe, bd, { fill: part.color, stroke: '#111827', sw: 0.15 })))
      out += rect(x, y, bw, bd, { stroke: '#111827', sw: 0.3, dash: '0.8 0.4', rx: 0.5 })
      const name = `자투리 ${s.scrapLabel ?? ''}`.trim()
      const lines = wrapName(name, bw - 0.8, FS) ?? [name]
      out += rect(x + 0.6, y + bd / 2 - ((lines.length + 1) * (FS + 0.3)) / 2 - 0.4, bw - 1.2, (lines.length + 1) * (FS + 0.3) + 0.8, { fill: '#FFFFFF', rx: 0.4 })
      out += label(x, y, lines, `${s.parts.length}종 ${s.tiers}박스`)
      continue
    }
    out += rect(x, y, bw, bd, { fill: s.color, stroke: '#111827', sw: 0.3, rx: 0.5 })
    out += label(x, y, wrapName(s.sku, bw - 0.8, FS) ?? [s.sku], `${s.tiers}단`)
  }
  return out
}

function sideView(p: PlanPanel, ox: number, oy: number, w: number, h: number): string {
  const base = oy + h
  const scale = (h - FS - 1.5) / LIMIT_MM
  const palH = PALLET_MM * scale
  const palTop = base - palH
  const limitY = base - LIMIT_MM * scale
  let out = `<line x1="${n(ox)}" y1="${n(base)}" x2="${n(ox + w)}" y2="${n(base)}" stroke="#6B7280" stroke-width="0.3"/>`
  out += `<line x1="${n(ox)}" y1="${n(limitY)}" x2="${n(ox + w)}" y2="${n(limitY)}" stroke="#DC2626" stroke-width="0.25" stroke-dasharray="1.2 0.8"/>`
  out += text({ x: ox + w, y: limitY - 0.6, s: `한도 ${cm(LIMIT_MM)}`, fill: '#DC2626', anchor: 'end' })
  out += rect(ox, palTop, w, palH, { fill: '#B08968', stroke: '#7A5C48', sw: 0.25 })
  const pitch = (w - 1) / Math.max(1, p.slotCount)
  const colW = Math.max(1.5, pitch - 0.8)
  p.slots.forEach((s, i) => {
    const x = ox + 0.5 + i * pitch + (pitch - colW) / 2
    if (!s) {
      out += rect(x, palTop - 1.5, colW, 1.5, { stroke: '#6B7280', sw: 0.2, dash: '0.8 0.6' })
      return
    }
    let y = palTop
    if (s.parts) {
      for (const part of s.parts) {
        const bh = part.dims.h * scale
        for (let t = 0; t < part.boxes; t++) {
          y -= bh
          out += rect(x, y, colW, bh, { fill: part.color, stroke: '#111827', sw: 0.2 })
        }
      }
    } else {
      const bh = s.dims.h * scale
      for (let t = 0; t < s.tiers; t++) {
        y -= bh
        out += rect(x, y, colW, bh, { fill: s.color, stroke: '#111827', sw: 0.2 })
      }
    }
    out += text({ x: x + colW / 2, y: Math.max(oy + FS, y - 0.6), s: `${s.tiers}단`, bold: true, anchor: 'middle' })
  })
  return out
}

function panelSvg(p: PlanPanel, ox: number, oy: number, ph: number, g: Geo): string {
  let out = rect(ox, oy, g.pw, ph, { fill: '#FFFFFF', stroke: '#9CA3AF', sw: 0.25, rx: 1 })
  const ts = titleSize(p, g)
  const rest = panelTitle(p).slice(p.center.length)
  out += `<text x="${n(ox + PAD)}" y="${n(oy + PAD + ts)}" font-size="${n(ts)}" font-weight="700" fill="#111827">` +
    `<tspan fill="#1D4ED8">${esc(p.center)}</tspan>${esc(rest)}</text>`
  const vy = oy + PAD + 4.6
  out += topView(p, ox + PAD, vy, g.top, g)
  out += sideView(p, ox + PAD + g.top + 2, vy, g.sideW, g.top)
  out += text({ x: ox + PAD, y: vy + g.top + 3, s: '탑뷰', fill: '#6B7280' })
  out += text({ x: ox + PAD + g.top + 2, y: vy + g.top + 3, s: '사이드뷰', fill: '#6B7280' })
  let y = vy + g.top + 3.4 + 1 + FS
  for (const it of p.items) {
    out += rect(ox + PAD, y - FS + 0.2, 2.4, 2.4, { fill: it.color, stroke: '#111827', sw: 0.2 })
    out += text({ x: ox + PAD + 3.5, y, s: itemLine(it), fill: '#111827' })
    y += LINE
  }
  for (const w of panelWarnsOf(p)) {
    out += text({ x: ox + PAD, y, s: w, bold: true, fill: w.includes('치수') ? '#B45309' : '#DC2626' })
    y += LINE
  }
  return out
}

// ── 페이지 ─────────────────────────────────────────────────────────
export type PalletPdfLayout = { cols: number; rows: number; pages: string[]; minPt: number }

/** 페이지별 SVG(mm viewBox) — 테스트·미리보기용으로 분리 */
export function buildCoupangPalletPdfPages(plan: CoupangPalletPlan): PalletPdfLayout {
  const panels = plan.panels
  const cols = fitsAt(panels, PDF_MAX_COLS) ? PDF_MAX_COLS : PDF_MIN_COLS
  const g = geoOf(cols)
  const contentW = PDF_PAGE_W - 2 * PDF_MARGIN
  const totalBoxes = panels.reduce((a, p) => a + p.boxes, 0)
  const title = `쿠팡 로켓 ${plan.dueDate || ''} 입고 — 팔레트 적재 구성도 (PLT ${panels.length}장 · ${cm(totalBoxes)}박스)`.replace(/\s+/g, ' ')

  // 1페이지 머리 — 제목 · 범례(흘려 배치) · 택배 제외 안내
  let head = text({ x: PDF_MARGIN, y: PDF_MARGIN + 4, s: title, size: 4.2, bold: true })
  let lx = 0
  let lr = 0
  const ly0 = PDF_MARGIN + 9
  for (const l of plan.legend) {
    const s = `${l.sku} — ${l.fullName}`
    const w = 3.4 + textWidth(s, FS) + 4
    if (lx > 0 && lx + w > contentW) {
      lx = 0
      lr += 1
    }
    const y = ly0 + lr * 3.6
    head += rect(PDF_MARGIN + lx, y - 2.2, 2.4, 2.4, { fill: l.color, stroke: '#111827', sw: 0.2 })
    head += text({ x: PDF_MARGIN + lx + 3.4, y, s, fill: '#374151' })
    lx += w
  }
  let headBottom = ly0 + lr * 3.6 + 1.5
  if (plan.excluded.length) {
    headBottom += 3.6
    head += text({
      x: PDF_MARGIN, y: headBottom,
      s: `택배 발송(${PALLET_BOX_LIMIT}박스 이하)이라 도면 제외: ` + plan.excluded.map((e) => `${e.center} ${cm(e.boxes)}박스 (발주 ${e.poNumber})`).join(' · '),
      bold: true, fill: '#B45309',
    })
  }
  const bodyTop = headBottom + 2.5
  const footH = 5 // 페이지 번호
  const bodyH = PDF_PAGE_H - PDF_MARGIN - footH - bodyTop
  const need = Math.max(...panels.map((p) => panelNeedH(p, g)))
  const rows = (bodyH - GAP) / PDF_ROWS >= need ? PDF_ROWS : 1
  const ph = Math.max(need, (bodyH - (rows - 1) * GAP) / rows)
  const perPage = cols * rows
  const pageCount = Math.max(1, Math.ceil(panels.length / perPage))

  const pages: string[] = []
  for (let pg = 0; pg < pageCount; pg++) {
    let s = rect(0, 0, PDF_PAGE_W, PDF_PAGE_H, { fill: '#FFFFFF' })
    if (pg === 0) s += head
    panels.slice(pg * perPage, (pg + 1) * perPage).forEach((p, k) => {
      const c = k % cols
      const r = Math.floor(k / cols)
      s += panelSvg(p, PDF_MARGIN + c * (g.pw + GAP), bodyTop + r * (ph + GAP), ph, g)
    })
    s += text({ x: PDF_PAGE_W / 2, y: PDF_PAGE_H - PDF_MARGIN + 1, s: `${pg + 1} / ${pageCount}`, fill: '#6B7280', anchor: 'middle' })
    const px = (mm: number) => Math.round((mm / 25.4) * DPI)
    pages.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${px(PDF_PAGE_W)}" height="${px(PDF_PAGE_H)}" viewBox="0 0 ${PDF_PAGE_W} ${PDF_PAGE_H}" font-family="${FONT}">` +
        s + '</svg>',
    )
  }
  return { cols, rows, pages, minPt: Math.round((Math.min(FS, ...panels.map((p) => titleSize(p, g))) / PT) * 10) / 10 }
}

/** coupang_pallet_YYYYMMDD.pdf */
export function coupangPalletPdfName(dueDate: string): string {
  const ymd = String(dueDate || '').replace(/[^0-9]/g, '').slice(0, 8)
  return `coupang_pallet_${ymd || 'nodate'}.pdf`
}

async function svgToJpegDataUrl(svg: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('도면 이미지를 만들지 못했습니다.'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('캔버스를 사용할 수 없습니다.')
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.88)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function downloadCoupangPalletPdf(plan: CoupangPalletPlan): Promise<PalletPdfLayout> {
  try {
    await document.fonts?.ready
  } catch {
    /* 폰트 준비 실패는 무시 */
  }
  const layout = buildCoupangPalletPdfPages(plan)
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
  for (let i = 0; i < layout.pages.length; i++) {
    if (i > 0) pdf.addPage('a4', 'landscape')
    pdf.addImage(await svgToJpegDataUrl(layout.pages[i]), 'JPEG', 0, 0, PDF_PAGE_W, PDF_PAGE_H)
  }
  saveBlob(pdf.output('blob'), coupangPalletPdfName(plan.dueDate))
  return layout
}
