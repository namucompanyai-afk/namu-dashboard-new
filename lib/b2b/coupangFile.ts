/**
 * 쿠팡 발주서 xlsx 파싱 (xlsx 의존 — 브라우저에서 실행).
 * 시트 읽기만 여기서 하고, 도메인 로직은 lib/b2b/coupang.ts 에 있다.
 */
import * as XLSX from 'xlsx'
import { repairRef } from './kurlyFile'
import { isCoupangRows, parseCoupangRows, type CoupangOrderItem } from './coupang'

export type CoupangParseResult = {
  items: CoupangOrderItem[]
  skipped: string[] // 쿠팡 발주서로 보이지 않아 건너뛴 파일명
}

/** 워크북 → 발주 상품 행. 첫 시트를 !ref 보정 후 읽는다 */
export function parseCoupangWorkbook(wb: XLSX.WorkBook, fileName = ''): CoupangOrderItem[] {
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return []
  repairRef(ws) // 컬리 파일과 같은 !ref 함정 대비(있어도 없어도 안전)
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
  if (!isCoupangRows(rows)) return []
  return parseCoupangRows(rows, fileName)
}

function readFile(file: File): Promise<XLSX.WorkBook> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`${file.name}: 파일을 읽지 못했습니다.`))
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        resolve(XLSX.read(data, { type: 'array', cellDates: true }))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

/** 발주서 여러 개 동시 업로드 → 합친 상품 행 + 쿠팡 파일이 아니라 건너뛴 파일명 */
export async function parseCoupangFiles(files: File[]): Promise<CoupangParseResult> {
  const items: CoupangOrderItem[] = []
  const skipped: string[] = []
  for (const f of files) {
    const wb = await readFile(f)
    const parsed = parseCoupangWorkbook(wb, f.name)
    if (parsed.length === 0) skipped.push(f.name)
    else items.push(...parsed)
  }
  return { items, skipped }
}
