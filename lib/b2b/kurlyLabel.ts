/**
 * 컬리 박스 부착 라벨 (A4 세로 · 1장 = 1박스 · 흑백 전용).
 *
 * lib/b2b/kurly.ts 의 파싱 결과를 **소비만** 한다 — 계산 로직은 건드리지 않는다.
 * buildLabelPlan() : 발주행 + 상품마스터 → 라벨 목록(+ 제외 안내)
 * renderLabelHtml(): 라벨 목록 → 인쇄용 HTML 문서
 * openLabelPrint() : 새 탭에 HTML 열고 인쇄 다이얼로그 유도
 */
import type { KurlyOrderRow, ProductMaster } from './kurly'
import { norm } from './kurly'

/**
 * 필수 항목이 이미 인쇄돼 나오는 상품 — 라벨 생성 제외.
 * label 은 제외 안내 문구에 쓰는 짧은 이름(상품마스터 정식명 대신).
 */
export const PREPRINTED = [{ code: 'M00000910999', label: '잡곡밥' }]
export const PREPRINTED_MASTER_CODES = PREPRINTED.map((p) => p.code)

const SUPPLIER = '농업회사법인(주) 나무컴퍼니'
const FOOTER = `${SUPPLIER} · 070-8019-0796 · 출고지: 경기도 화성시 장안면 장안공단로 161-31`

export type LabelRow = {
  dest: string // 입고지
  viaCenter: string // 경유센터 ('경유안함'이면 표기 생략)
  dueDate: string // 입고예정일 YYYY-MM-DD
  orderCode: string // 발주 단위 코드 (거래명세서코드 K···, 없으면 발주코드 T···)
  productName: string
  masterCode: string
  barcode: string // 상품마스터 lookup (컬리 마스터 코드 기준)
  expiry: string // 소비기한 YYYY-MM-DD ('' 이면 경고 표시)
  unitsPerBox: number // 박스 내 입수량
  totalUnits: number // 발주 총 수량
  ctIndex: number // 박스 번호 (1-based)
  ctTotal: number // 발주 단위 합산 총 박스 수
}

export type LabelSkip = { masterCode: string; name: string; boxes: number }

export type LabelPlan = {
  dueDate: string
  labels: LabelRow[]
  skipped: LabelSkip[] // 기인쇄로 제외된 상품
}

const preprintedOf = (masterCode: string) =>
  PREPRINTED.find((p) => norm(p.code) === norm(masterCode))
const isPreprinted = (masterCode: string): boolean => !!preprintedOf(masterCode)

const isViaReal = (v: string): boolean => !!v && !norm(v).includes('경유안함')

/**
 * 라벨 목록 생성.
 *
 * C/T 연번은 **발주 단위(orderKey) 합산** — 같은 발주에 상품이 여러 개면
 * 발주 행 순서대로 이어서 매긴다(상품A 4박스 + 상품B 3박스 → 1/7 … 7/7).
 * 발주 내역 양식의 발주상품코드(P···)는 행마다 달라 분모가 상품별로 쪼개지므로
 * 거래명세서코드(K···)를 쓴다 — orderKey 가 그 판단을 이미 해 둔다.
 * 기인쇄 제외분은 인쇄 대상이 아니므로 분모에서도 빠진다(번호에 빈칸이 생기지 않게).
 */
export function buildLabelPlan(
  orders: KurlyOrderRow[],
  masterByCode: Record<string, ProductMaster>,
): LabelPlan {
  const printable = orders.filter((o) => !isPreprinted(o.masterCode))

  // 발주 단위 인쇄 대상 박스 총수 (C/T 분모)
  const totalByCode = new Map<string, number>()
  for (const o of printable) {
    totalByCode.set(o.orderKey, (totalByCode.get(o.orderKey) || 0) + o.boxCount)
  }

  const seq = new Map<string, number>()
  const labels: LabelRow[] = []
  for (const o of printable) {
    const m = masterByCode[norm(o.masterCode)]
    const ctTotal = totalByCode.get(o.orderKey) || o.boxCount
    for (let b = 0; b < o.boxCount; b++) {
      const i = (seq.get(o.orderKey) || 0) + 1
      seq.set(o.orderKey, i)
      labels.push({
        dest: o.dest,
        viaCenter: o.viaCenter,
        dueDate: o.dueDate,
        orderCode: o.orderKey,
        productName: o.productName || m?.name || m?.alias || o.masterCode,
        masterCode: o.masterCode,
        barcode: m?.barcode || '',
        expiry: o.expiry,
        unitsPerBox: o.unitsPerBox,
        totalUnits: o.totalUnits,
        ctIndex: i,
        ctTotal,
      })
    }
  }

  // 제외분 안내 (마스터코드 단위 합산)
  const skipMap = new Map<string, LabelSkip>()
  for (const o of orders) {
    if (!isPreprinted(o.masterCode)) continue
    const key = norm(o.masterCode)
    const cur = skipMap.get(key)
    if (cur) cur.boxes += o.boxCount
    else
      skipMap.set(key, {
        masterCode: o.masterCode,
        name: preprintedOf(o.masterCode)?.label || o.productName || o.masterCode,
        boxes: o.boxCount,
      })
  }

  return {
    dueDate: orders.find((o) => o.dueDate)?.dueDate || '',
    labels,
    skipped: [...skipMap.values()],
  }
}

// ── HTML 생성 ────────────────────────────────────────────────────
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
// 시트·발주파일에서 온 문자열이 그대로 마크업에 들어가므로 전부 이스케이프한다
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
const cm = (v: number): string => Number(v || 0).toLocaleString('en-US')

// 흑백 전용 — 색상 지정 없이 #000/#fff 만 사용
const CSS = `
@page { size: A4 portrait; margin: 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', sans-serif;
  color: #000; background: #fff;
}
.bar {
  position: sticky; top: 0; z-index: 9;
  background: #000; color: #fff; padding: 10px 16px;
  font-size: 13px; display: flex; align-items: center; gap: 14px;
}
.bar button {
  font: inherit; font-weight: 700; padding: 5px 14px;
  background: #fff; color: #000; border: 0; border-radius: 4px; cursor: pointer;
}
.sheet {
  height: 269mm; display: flex; flex-direction: column;
  page-break-after: always; break-after: page;
  padding: 0 0 2mm;
}
.sheet:last-of-type { page-break-after: auto; break-after: auto; }
.band { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm;
        border-bottom: 3pt solid #000; padding-bottom: 4mm; }
.band-title { font-size: 25pt; font-weight: 800; line-height: 1.15; }
.band-via { font-size: 14pt; font-weight: 700; margin-top: 2.5mm; }
.band-right { text-align: right; white-space: nowrap; }
.band-date { font-size: 15pt; font-weight: 800; }
.band-sup { font-size: 11pt; margin-top: 2mm; }
.code { font-size: 28pt; font-weight: 800; margin-top: 7mm; word-break: break-all; line-height: 1.2; }
.pname { font-size: 22pt; font-weight: 800; margin-top: 4mm; line-height: 1.3; }
.mcode { font-size: 16pt; margin-top: 3.5mm; }
.exp { border: 3pt solid #000; margin-top: 7mm; padding: 4mm 5mm; text-align: center; }
.exp-h { font-size: 13pt; font-weight: 700; letter-spacing: 3px; }
.exp-v { font-size: 44pt; font-weight: 800; line-height: 1.1; margin-top: 2mm; }
.exp-miss { font-size: 19pt; font-weight: 800; line-height: 1.35; margin-top: 2mm; }
.grid { display: flex; margin-top: 7mm; border: 2pt solid #000; }
.cell { flex: 1; padding: 4mm 2mm; text-align: center; border-right: 2pt solid #000; }
.cell:last-child { border-right: 0; }
.cell-h { font-size: 12pt; font-weight: 700; }
.cell-v { font-size: 30pt; font-weight: 800; margin-top: 2mm; line-height: 1.1; }
.foot { margin-top: auto; border-top: 1pt solid #000; padding-top: 3mm; font-size: 10pt; }
@media print { .bar { display: none; } }
`

function sheetHtml(l: LabelRow): string {
  const via = isViaReal(l.viaCenter) ? `<div class="band-via">경유: ${esc(l.viaCenter)}</div>` : ''
  const mline = l.barcode
    ? `${esc(l.masterCode)} (${esc(l.barcode)})`
    : `${esc(l.masterCode)} (바코드 미등록)`
  const expBody = l.expiry
    ? `<div class="exp-v">${esc(l.expiry)}</div>`
    : `<div class="exp-miss">소비기한 미입력 — 부착 전 실물 확인</div>`

  return `<section class="sheet">
  <div class="band">
    <div>
      <div class="band-title">컬리 입고분 | ${esc(l.dest)}</div>
      ${via}
    </div>
    <div class="band-right">
      <div class="band-date">${esc(l.dueDate || '입고예정일 미상')}</div>
      <div class="band-sup">${esc(SUPPLIER)}</div>
    </div>
  </div>
  <div class="code">${esc(l.orderCode)}</div>
  <div class="pname">${esc(l.productName)}</div>
  <div class="mcode">${mline}</div>
  <div class="exp">
    <div class="exp-h">소비기한</div>
    ${expBody}
  </div>
  <div class="grid">
    <div class="cell"><div class="cell-h">박스 내 입수량</div><div class="cell-v">${cm(l.unitsPerBox)}</div></div>
    <div class="cell"><div class="cell-h">발주 총 수량</div><div class="cell-v">${cm(l.totalUnits)}</div></div>
    <div class="cell"><div class="cell-h">박스 번호 (C/T)</div><div class="cell-v">${l.ctIndex} / ${l.ctTotal}</div></div>
  </div>
  <div class="foot">${esc(FOOTER)}</div>
</section>`
}

/** 라벨 목록 → 인쇄용 HTML 문서 (A4 세로 · 박스 수만큼 페이지) */
export function renderLabelHtml(plan: LabelPlan): string {
  const title = `컬리 ${plan.dueDate || ''} 부착 라벨 (${plan.labels.length}장)`.replace(/\s+/g, ' ')
  const skipNote = plan.skipped.length
    ? ` · ${plan.skipped.map((s) => `${s.name} ${s.boxes}박스 생략(기인쇄)`).join(' · ')}`
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

/** 새 탭에 인쇄용 HTML 열기. 팝업 차단 시 false 반환 */
export function openLabelPrint(plan: LabelPlan): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(renderLabelHtml(plan))
  w.document.close()
  return true
}
