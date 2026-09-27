/**
 * 서식 있는 엑셀 다운로드 (광고 분석 등).
 *
 * 값은 숫자 그대로 두고 셀 서식(z)만 입힌다 → 엑셀에서 계산·정렬 가능.
 *   pct   : 입력은 퍼센트 숫자(5.85) → 비율(0.0585) 저장, 서식 0.0%
 *   roas  : 입력은 퍼센트 숫자(1208.9) → 비율 저장, 서식 #,##0%
 *   won   : 정수 반올림, 서식 #,##0 (음수 -#,##0)
 *   count : 정수, 서식 #,##0
 *   text  : 그대로
 * null/undefined/NaN 은 빈칸. 첫 행 고정 · 필터 · 열 너비 자동.
 */
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

export type XlsxColKind = 'pct' | 'roas' | 'won' | 'count' | 'text'
export interface XlsxCol<T> {
  header: string
  kind: XlsxColKind
  get: (r: T) => unknown
}

const FMT: Record<XlsxColKind, string | null> = {
  pct: '0.0%',
  roas: '#,##0%',
  won: '#,##0;-#,##0',
  count: '#,##0',
  text: null,
}

function cellValue(kind: XlsxColKind, v: unknown): string | number | null {
  if (v == null || v === '') return null
  if (kind === 'text') return typeof v === 'number' ? v : String(v)
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  if (kind === 'pct' || kind === 'roas') return n / 100
  return Math.round(n)
}

/** 화면 폭 기준 글자 너비 (한글·이모지 2칸) */
function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u0000-ÿ]/.test(ch) ? 1 : 2
  return w
}

function displayText(kind: XlsxColKind, v: string | number | null): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (kind === 'pct') return `${(v * 100).toFixed(1)}%`
  if (kind === 'roas') return `${Math.round(v * 100).toLocaleString('en-US')}%`
  return Math.round(v).toLocaleString('en-US')
}

export function buildFormattedSheet<T>(cols: XlsxCol<T>[], rows: T[]): XLSX.WorkSheet {
  const aoa: (string | number | null)[][] = [cols.map((c) => c.header)]
  for (const r of rows) aoa.push(cols.map((c) => cellValue(c.kind, c.get(r))))
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  cols.forEach((c, ci) => {
    const z = FMT[c.kind]
    if (!z) return
    for (let ri = 1; ri < aoa.length; ri++) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })]
      if (cell && cell.t === 'n') cell.z = z
    }
  })
  ws['!cols'] = cols.map((c, ci) => {
    let w = textWidth(c.header)
    for (let ri = 1; ri < aoa.length; ri++) w = Math.max(w, textWidth(displayText(c.kind, aoa[ri][ci])))
    return { wch: Math.min(Math.max(w + 2, 8), 60) }
  })
  if (aoa.length > 0 && cols.length > 0) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length - 1 } }) }
  }
  return ws
}

/** SheetJS 무료판은 틀 고정을 안 써서, 저장된 xlsx 의 sheetView 에 첫 행 고정 pane 을 넣는다 */
async function freezeTopRow(buf: ArrayBuffer): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(buf)
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue
    const xml = await zip.file(name)!.async('string')
    const pane = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    const out = xml.replace(/<sheetView([^>]*?)\/>/, `<sheetView$1>${pane}</sheetView>`)
    zip.file(name, out)
  }
  return zip.generateAsync({ type: 'uint8array' })
}

export async function buildFormattedXlsx<T>(cols: XlsxCol<T>[], rows: T[], sheetName: string): Promise<Uint8Array> {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, buildFormattedSheet(cols, rows), sheetName.slice(0, 31))
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return freezeTopRow(buf)
}

export async function downloadFormattedXlsx<T>(cols: XlsxCol<T>[], rows: T[], filename: string, sheetName: string) {
  const bytes = await buildFormattedXlsx(cols, rows, sheetName)
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
