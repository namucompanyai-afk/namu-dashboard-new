/**
 * 쿠팡 발주서 xlsx·zip 파싱 (xlsx·jszip 의존 — 브라우저에서 실행).
 * 시트 읽기만 여기서 하고, 도메인 로직은 lib/b2b/coupang.ts 에 있다.
 */
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
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

const readWorkbook = (buf: ArrayBuffer): XLSX.WorkBook => XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true })

/** 업로드 파일 → 발주서 xlsx 목록. 발주서리스트 zip 은 풀어서 안의 .xlsx 전부 (안쪽 파일명 깨져도 확장자로만 판별) */
async function expandFiles(files: File[]): Promise<{ name: string; buf: ArrayBuffer; zipName?: string }[]> {
  const out: { name: string; buf: ArrayBuffer; zipName?: string }[] = []
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(await f.arrayBuffer())
      const entries = Object.values(zip.files).filter((e) => !e.dir && /\.xlsx$/i.test(e.name) && !/(^|\/)(__MACOSX|\._)/.test(e.name))
      for (const e of entries) out.push({ name: e.name.split('/').pop() || e.name, buf: await e.async('arraybuffer'), zipName: f.name })
    } else {
      out.push({ name: f.name, buf: await f.arrayBuffer() })
    }
  }
  return out
}

/** 발주서 여러 개 동시 업로드(xlsx·zip 섞어도 됨) → 합친 상품 행 + 쿠팡 파일이 아니라 건너뛴 파일명.
 *  같은 발주번호가 여러 번 들어오면 뒤 파일 것만 남긴다 (쿠팡 손익 parsePurchaseOrderFiles 와 같은 규칙) */
export async function parseCoupangFiles(files: File[]): Promise<CoupangParseResult> {
  const byPo = new Map<string, CoupangOrderItem[]>()
  const skipped: string[] = []
  for (const f of await expandFiles(files)) {
    let parsed: CoupangOrderItem[]
    try {
      parsed = parseCoupangWorkbook(readWorkbook(f.buf), f.name)
    } catch (err) {
      throw new Error(`${f.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (parsed.length === 0) { skipped.push(f.zipName ? `${f.zipName} › ${f.name}` : f.name); continue }
    // zip 안 파일명은 옛 한글 인코딩이라 깨짐 — 화면 표시용 파일명을 'zip 이름 › 발주번호 · 센터 · 입고예정일' 로 (디코딩 시도 안 함)
    if (f.zipName) for (const it of parsed) it.sourceFile = `${f.zipName} › 발주번호 ${it.poNumber} · ${it.center} · ${it.dueDate}`
    const groups = new Map<string, CoupangOrderItem[]>()
    for (const it of parsed) {
      const g = groups.get(it.poNumber) || []
      g.push(it)
      groups.set(it.poNumber, g)
    }
    for (const [po, g] of groups) {
      byPo.delete(po) // 뒤 파일 우선 — 순서도 뒤 파일 위치로
      byPo.set(po, g)
    }
  }
  return { items: Array.from(byPo.values()).flat(), skipped }
}
