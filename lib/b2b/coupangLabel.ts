/**
 * 위킵 출고분 박스 부착 라벨 + 위킵 전달 안내문 (쿠팡 로켓 입고분).
 *
 * 컬리 라벨(lib/b2b/kurlyLabel.ts)과 같은 구성이되, 쿠팡 발주서에는 소비기한 데이터가
 * 없으므로 소비기한 박스가 없다. 파싱·분기·로켓 양식·매출·이력 로직은 소비만 한다.
 */
import { norm } from './kurly'
import type { RoutedItem } from './coupang'
import { groupByPo } from './coupangDiagram'

/** 박스에 필수 항목이 기표기로 인쇄돼 나오는 상품 — 라벨 생성 제외 */
export const PREPRINTED_BARCODES = [
  { code: '8800295820794', label: '즉석밥' }, // 현미 귀리 즉석밥 180g * 6
  { code: '8800295820800', label: '즉석밥' }, // 현미 귀리 즉석밥 180g * 24
]

const SUPPLIER = '농업회사법인(주) 나무컴퍼니'
const FOOTER = `${SUPPLIER} · 070-8019-0796 · 출고지: 경기도 화성시 장안면 장안공단로 161-31`

const preprintedOf = (barcode: string) =>
  PREPRINTED_BARCODES.find((p) => norm(p.code) === norm(barcode))

export type CoupangLabelRow = {
  center: string
  dueDate: string
  poNumber: string
  productName: string
  barcode: string
  unitsPerBox: number // 박스 내 입수량 (상품마스터 박스입수)
  totalUnits: number // 발주 총 수량 = 납품가능수량
  ctIndex: number
  ctTotal: number
}

export type CoupangLabelSkip = { label: string; boxes: number }

export type CoupangLabelPlan = {
  dueDate: string
  labels: CoupangLabelRow[]
  skipped: CoupangLabelSkip[]
}

/**
 * 위킵분 → 라벨 목록.
 * C/T 연번은 **발주번호 기준**. 기표기 제외분은 인쇄 대상이 아니므로 분모에서도 빠진다
 * (번호에 빈칸이 생기지 않게).
 */
export function buildCoupangLabelPlan(items: RoutedItem[]): CoupangLabelPlan {
  const printable = items.filter((it) => !preprintedOf(it.barcode) && (it.boxes ?? 0) > 0)

  const totalByPo = new Map<string, number>()
  for (const it of printable) {
    totalByPo.set(it.poNumber, (totalByPo.get(it.poNumber) || 0) + (it.boxes ?? 0))
  }

  const seq = new Map<string, number>()
  const labels: CoupangLabelRow[] = []
  for (const it of printable) {
    const ctTotal = totalByPo.get(it.poNumber) || (it.boxes ?? 0)
    for (let b = 0; b < (it.boxes ?? 0); b++) {
      const i = (seq.get(it.poNumber) || 0) + 1
      seq.set(it.poNumber, i)
      labels.push({
        center: it.center,
        dueDate: it.dueDate,
        poNumber: it.poNumber,
        productName: it.master?.alias || it.productName,
        barcode: it.barcode,
        unitsPerBox: it.master?.boxQty ?? 0,
        totalUnits: it.confirmQty,
        ctIndex: i,
        ctTotal,
      })
    }
  }

  // 제외분 안내 (라벨명 단위 합산 — 즉석밥 6입/24입을 한 줄로)
  const skipMap = new Map<string, CoupangLabelSkip>()
  for (const it of items) {
    const p = preprintedOf(it.barcode)
    if (!p) continue
    const cur = skipMap.get(p.label)
    if (cur) cur.boxes += it.boxes ?? 0
    else skipMap.set(p.label, { label: p.label, boxes: it.boxes ?? 0 })
  }

  return {
    dueDate: items.find((i) => i.dueDate)?.dueDate || '',
    labels,
    skipped: [...skipMap.values()],
  }
}

// ── 인쇄용 HTML ──────────────────────────────────────────────────
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
const cm = (v: number): string => Number(v || 0).toLocaleString('en-US')

// 흑백 전용 — #000/#fff 만 사용
const CSS = `
@page { size: A4 portrait; margin: 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', sans-serif; color: #000; background: #fff; }
.bar { position: sticky; top: 0; z-index: 9; background: #000; color: #fff; padding: 10px 16px;
       font-size: 13px; display: flex; align-items: center; gap: 14px; }
.bar button { font: inherit; font-weight: 700; padding: 5px 14px; background: #fff; color: #000;
              border: 0; border-radius: 4px; cursor: pointer; }
.sheet { height: 269mm; display: flex; flex-direction: column;
         page-break-after: always; break-after: page; padding: 0 0 2mm; }
.sheet:last-of-type { page-break-after: auto; break-after: auto; }
.band { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm;
        border-bottom: 3pt solid #000; padding-bottom: 4mm; }
.band-title { font-size: 25pt; font-weight: 800; line-height: 1.15; }
.band-right { text-align: right; white-space: nowrap; }
.band-date { font-size: 15pt; font-weight: 800; }
.band-sup { font-size: 11pt; margin-top: 2mm; }
.code { font-size: 28pt; font-weight: 800; margin-top: 8mm; word-break: break-all; line-height: 1.2; }
.pname { font-size: 22pt; font-weight: 800; margin-top: 5mm; line-height: 1.3; }
.bcode { font-size: 16pt; margin-top: 4mm; }
.grid { display: flex; margin-top: 9mm; border: 2pt solid #000; }
.cell { flex: 1; padding: 5mm 2mm; text-align: center; border-right: 2pt solid #000; }
.cell:last-child { border-right: 0; }
.cell-h { font-size: 12pt; font-weight: 700; }
.cell-v { font-size: 30pt; font-weight: 800; margin-top: 2mm; line-height: 1.1; }
.foot { margin-top: auto; border-top: 1pt solid #000; padding-top: 3mm; font-size: 10pt; }
@media print { .bar { display: none; } }
`

function sheetHtml(l: CoupangLabelRow): string {
  return `<section class="sheet">
  <div class="band">
    <div><div class="band-title">쿠팡 로켓 입고분 | ${esc(l.center)}</div></div>
    <div class="band-right">
      <div class="band-date">${esc(l.dueDate || '입고예정일 미상')}</div>
      <div class="band-sup">${esc(SUPPLIER)}</div>
    </div>
  </div>
  <div class="code">${esc(l.poNumber)}</div>
  <div class="pname">${esc(l.productName)}</div>
  <div class="bcode">${esc(l.barcode || '바코드 미등록')}</div>
  <div class="grid">
    <div class="cell"><div class="cell-h">박스 내 입수량</div><div class="cell-v">${cm(l.unitsPerBox)}</div></div>
    <div class="cell"><div class="cell-h">발주 총 수량</div><div class="cell-v">${cm(l.totalUnits)}</div></div>
    <div class="cell"><div class="cell-h">박스 번호 (C/T)</div><div class="cell-v">${l.ctIndex} / ${l.ctTotal}</div></div>
  </div>
  <div class="foot">${esc(FOOTER)}</div>
</section>`
}

/** 라벨 목록 → 인쇄용 HTML (A4 세로 · 1장 = 1박스) */
export function renderCoupangLabelHtml(plan: CoupangLabelPlan): string {
  const title = `쿠팡 로켓 ${plan.dueDate || ''} 위킵 부착 라벨 (${plan.labels.length}장)`.replace(/\s+/g, ' ')
  const skipNote = plan.skipped.length
    ? ` · ${plan.skipped.map((s) => `${s.label} ${s.boxes}박스 생략(기인쇄)`).join(' · ')}`
    : ''
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>
<body>
<div class="bar">
  <strong>${esc(title)}</strong>
  <span>A4 세로 · 1장 = 1박스 · 흑백 인쇄${esc(skipNote)}</span>
  <button onclick="window.print()">인쇄</button>
  <span>인쇄 창이 안 뜨면 이 버튼을 누르세요.</span>
</div>
${plan.labels.map(sheetHtml).join('\n')}
<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},350)})</script>
</body></html>`
}

/** 새 탭에 인쇄용 HTML 열기. 팝업 차단 시 false */
export function openCoupangLabelPrint(plan: CoupangLabelPlan): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(renderCoupangLabelHtml(plan))
  w.document.close()
  return true
}

// ── 위킵 전달 안내문 ─────────────────────────────────────────────
/** 카톡 붙여넣기용 플레인 텍스트. 입고예정일·센터·발주번호가 다르면 블록을 나눈다 */
export function buildCoupangWikeepNotice(items: RoutedItem[]): string {
  const dates = [...new Set(items.map((i) => i.dueDate).filter(Boolean))].sort()
  const dateLabel = dates.length ? dates.join(', ') : '(입고예정일 미상)'
  const totalBoxes = items.reduce((s, i) => s + (i.boxes ?? 0), 0)

  // 발송 방식은 발주 단위 9박스 판정 — 초과분은 택배 불가라 팔레트로 안내한다
  const poGroups = groupByPo(items)
  const palletPos = poGroups.filter((g) => g.needsPallet)
  const parcelPos = poGroups.filter((g) => !g.needsPallet)

  const lines: string[] = []
  lines.push(`[쿠팡 로켓 ${dateLabel} 입고 — 위킵 출고 안내]`)
  if (palletPos.length === 0) {
    lines.push(`총 ${cm(totalBoxes)}박스 택배 발송 부탁드립니다.`)
  } else if (parcelPos.length === 0) {
    lines.push(`총 ${cm(totalBoxes)}박스 팔레트(KPP) 발송 부탁드립니다.`)
  } else {
    lines.push(`총 ${cm(totalBoxes)}박스 발송 부탁드립니다. (발주별 발송 방식 상이)`)
    for (const g of poGroups) {
      lines.push(`- ${g.poNumber} ${cm(g.boxes)}박스: ${g.needsPallet ? '팔레트(KPP)' : '택배'} 발송`)
    }
  }

  // 입고예정일 + 센터 + 발주번호 단위 블록 (등장 순서 유지)
  const blocks = new Map<string, RoutedItem[]>()
  for (const it of items) {
    const k = `${it.dueDate}|${it.center}|${it.poNumber}`
    const cur = blocks.get(k)
    if (cur) cur.push(it)
    else blocks.set(k, [it])
  }

  for (const group of blocks.values()) {
    const head = group[0]
    lines.push('')
    lines.push(`${head.center} (발주 ${head.poNumber})`)
    for (const it of group) {
      const name = it.master?.alias || it.productName
      lines.push(`- ${name} ${cm(it.boxes ?? 0)}박스`)
    }
  }

  // 꼬리 주의문 — 부착 서류·기표기 안내는 해당 상품이 실제로 있을 때만 낸다
  const hasLabelTarget = items.some((it) => !preprintedOf(it.barcode) && (it.boxes ?? 0) > 0)
  const has = (code: string) => items.some((it) => norm(it.barcode) === norm(code))

  lines.push('')
  lines.push('※ 쉽먼트 라벨 부착 확인')
  if (hasLabelTarget) lines.push('※ 부착 서류 필히 부착 (즉석밥은 박스 기표기로 제외)')
  if (has('8800295820794')) {
    lines.push('※ 즉석밥 6입: 겉박스 기존 바코드 가림 처리 필수 (오스캔 방지)')
  }
  if (has('8800295820800')) {
    lines.push('※ 즉석밥 24입: 겉박스 바코드 그대로 사용 (가림·부착 불필요)')
  }
  // 9박스 초과 발주는 택배 불가 → 팔레트 안내 (발주 단위)
  // 밀크런 접수는 나무가 직접 하므로 위킵 전달 사항이 아니다 — 마감 표기는 쿠팡 페이지 팔레트 안내에만
  for (const g of palletPos) {
    lines.push(`※ ${g.poNumber}: 9박스 초과 — 팔레트(KPP) 적재·랩핑`)
  }
  lines.push(`※ 입고예정일 ${dateLabel} 도착 기준 발송`)
  return lines.join('\n')
}
