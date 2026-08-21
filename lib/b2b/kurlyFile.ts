/**
 * 컬리 발주 xlsx 파싱 (xlsx 의존 — 브라우저에서 실행).
 * 시트 파싱만 xlsx 를 쓰고, 도메인 계산은 lib/b2b/kurly.ts 에 있다.
 */
import * as XLSX from 'xlsx'
import { ORDER_SHEET_NAME, norm, parseKurlyOrderRows, type KurlyOrderRow } from './kurly'

/**
 * !ref(시트 범위) 재계산.
 *
 * 컬리 발주 파일은 !ref 가 헤더 행만 기록돼 있어 그대로 읽으면 데이터가 0행이 된다.
 * 실제 셀 키(A1 표기)를 전부 스캔해 실제 범위를 다시 만들어 넣는다.
 * 반환값은 재계산된 행 수(헤더 포함).
 */
export function repairRef(ws: XLSX.WorkSheet): number {
  let minR = Infinity
  let minC = Infinity
  let maxR = -1
  let maxC = -1
  for (const key of Object.keys(ws)) {
    if (key.charCodeAt(0) === 33) continue // '!' 로 시작하는 메타 키(!ref, !merges …)
    let cell: { r: number; c: number }
    try {
      cell = XLSX.utils.decode_cell(key)
    } catch {
      continue
    }
    if (!Number.isFinite(cell.r) || !Number.isFinite(cell.c)) continue
    if (cell.r < minR) minR = cell.r
    if (cell.c < minC) minC = cell.c
    if (cell.r > maxR) maxR = cell.r
    if (cell.c > maxC) maxC = cell.c
  }
  if (maxR < 0) return 0
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } })
  return maxR - minR + 1
}

/** 워크북 → 발주 행. 시트 '발주 내역'(없으면 '발주' 포함 시트)을 !ref 보정 후 파싱한다. */
export function parseKurlyWorkbook(wb: XLSX.WorkBook): KurlyOrderRow[] {
  const name =
    wb.SheetNames.find((n) => norm(n) === norm(ORDER_SHEET_NAME)) ??
    wb.SheetNames.find((n) => norm(n).includes('발주'))
  if (!name) throw new Error(`시트 '${ORDER_SHEET_NAME}' 를 찾지 못했습니다.`)
  const ws = wb.Sheets[name]
  repairRef(ws)
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
  return parseKurlyOrderRows(rows)
}

/** 업로드 File → 발주 행 */
export function parseKurlyFile(file: File): Promise<KurlyOrderRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'))
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        resolve(parseKurlyWorkbook(XLSX.read(data, { type: 'array', cellDates: true })))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}
