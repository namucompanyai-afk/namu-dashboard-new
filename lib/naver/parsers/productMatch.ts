import * as XLSX from 'xlsx'

/**
 * 마진마스터.xlsx 의 "네이버상품매칭" 시트 파서
 * 헤더 R1: A 상품명 / B 노출ID / C 별칭
 *
 * 반환: Map<상품명(trim), { productName, exposureId|'', alias|'' }>
 * exposureId/alias 가 비어있는 행도 포함. 그런 행은 매칭 시 unmatched 로 간주.
 */

export interface NaverProductMatch {
  productName: string
  exposureId: string
  alias: string
}

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function findSheet(wb: XLSX.WorkBook, candidates: string[]): unknown[][] | null {
  for (const name of wb.SheetNames) {
    if (candidates.includes(name)) {
      return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false })
    }
  }
  for (const name of wb.SheetNames) {
    if (candidates.some((k) => name.includes(k))) {
      return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false })
    }
  }
  return null
}

export async function parseNaverProductMatch(
  buffer: ArrayBuffer,
): Promise<Map<string, NaverProductMatch>> {
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: false })
  const aoa = findSheet(wb, ['네이버상품매칭', '네이버 상품매칭', '네이버상품 매칭'])
  const map = new Map<string, NaverProductMatch>()
  if (!aoa) return map

  // 헤더 R1 가정. 실제로 첫 행이 헤더이면 i=1부터 데이터.
  const first = (aoa[0] as unknown[]) || []
  const isHeader = toStr(first[0]).includes('상품명') || toStr(first[1]).includes('노출')
  const startIdx = isHeader ? 1 : 0

  for (let i = startIdx; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const productName = toStr(r[0])
    if (!productName) continue
    const exposureId = toStr(r[1])
    const alias = toStr(r[2])
    map.set(productName, { productName, exposureId, alias })
  }
  return map
}
