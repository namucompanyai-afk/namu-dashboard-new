import * as XLSX from 'xlsx'

/**
 * 원가 엑셀 파서
 *
 * 양식 (고정):
 *   [필수] 옵션ID       (A열) - 쿠팡 옵션ID, 매칭 키
 *   [선택] 품목명        (B열) - 사용자 확인용, 파서는 무시
 *   [필수] 공급가        (C열) - 최종 원가 (원가+작업비+혼합비+부가 합계)
 *   [선택] 원가/작업비/혼합비/부가/합계 등 - 참고용, 파서 무시
 *
 * 동작:
 *   - 한 옵션ID에 한 행. 같은 옵션ID 여러 행이면 마지막 값이 적용됨 (덮어쓰기).
 *   - 헤더는 "옵션ID"와 "공급가"만 찾으면 됨 (다른 컬럼 위치 유연).
 *   - 빈 옵션ID 행은 무시 (경고 없이 스킵).
 *   - 엑셀에 있는 공급가 = 이미 VAT 포함된 최종 원가라고 간주.
 */

function normHeader(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

const OPTION_ID_ALIASES = ['옵션id', 'optionid']
const SUPPLY_PRICE_ALIASES = [
  '공급가', '공급가total', '공급가합계', '최종공급가',
  '합계', '총공급가', '원가합계', 'totalsupply',
]

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return NaN
  if (typeof v === 'number') return v
  const cleaned = String(v).replace(/[,\s원]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}

export interface CostRow {
  optionId: string
  supplyPrice: number
  /** 참고용 품목명 (선택 컬럼) */
  itemName?: string
}

export interface CostParseResult {
  rows: CostRow[]
  /** 파싱된 전체 행 수 (중복 옵션ID 있어도 합쳐지기 전) */
  totalRows: number
  /** 건너뛴 행 수 (옵션ID 또는 공급가 빈 것) */
  skippedRows: number
  /** 헤더 누락 에러 */
  missingColumns: string[]
  /** 여러 시트면 처리한 시트 이름들 */
  sheetsProcessed: string[]
}

/**
 * 헤더 행을 찾음. "옵션ID"가 포함된 첫 번째 행.
 */
function findHeaderRow(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const hasOptionId = row.some((c) => OPTION_ID_ALIASES.includes(normHeader(toStr(c))))
    if (hasOptionId) return i
  }
  return -1
}

/**
 * 컬럼 인덱스를 찾음: 옵션ID, 공급가, (선택) 품목명
 */
function resolveColumns(
  headers: string[],
): { optionIdCol: number; supplyPriceCol: number; itemNameCol: number } | null {
  const norms = headers.map((h) => normHeader(toStr(h)))

  const optionIdCol = norms.findIndex((h) => OPTION_ID_ALIASES.includes(h))
  const supplyPriceCol = norms.findIndex((h) => SUPPLY_PRICE_ALIASES.includes(h))

  if (optionIdCol === -1 || supplyPriceCol === -1) return null

  // 품목명 컬럼: "품목" 또는 "품명" 포함. 없어도 됨.
  const itemNameCol = norms.findIndex((h) => h.includes('품목') || h.includes('품명') || h.includes('상품명'))

  return { optionIdCol, supplyPriceCol, itemNameCol }
}

export function parseCostTable(buffer: ArrayBuffer): CostParseResult {
  const wb = XLSX.read(buffer, { type: 'array' })
  const merged = new Map<string, CostRow>()
  let totalRows = 0
  let skipped = 0
  const sheetsProcessed: string[] = []
  const missingColumns: string[] = []

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue

    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
    const headerRowIdx = findHeaderRow(aoa)
    if (headerRowIdx === -1) continue

    const headers = (aoa[headerRowIdx] as unknown[]).map(toStr)
    const cols = resolveColumns(headers)
    if (!cols) {
      // 옵션ID는 있지만 공급가 없는 시트 → 다른 구조일 수 있으니 경고만 기록하고 스킵
      const norms = headers.map((h) => normHeader(toStr(h)))
      if (norms.some((h) => OPTION_ID_ALIASES.includes(h))) {
        missingColumns.push(`시트 "${sheetName}"에서 공급가 컬럼을 찾지 못함`)
      }
      continue
    }

    sheetsProcessed.push(sheetName)
    const dataRows = aoa.slice(headerRowIdx + 1) as unknown[][]

    for (const row of dataRows) {
      totalRows++
      const optionId = toStr(row[cols.optionIdCol])
      const supplyPrice = toNum(row[cols.supplyPriceCol])

      if (!optionId) {
        skipped++
        continue
      }
      if (!Number.isFinite(supplyPrice) || supplyPrice <= 0) {
        skipped++
        continue
      }

      const itemName =
        cols.itemNameCol !== -1 ? toStr(row[cols.itemNameCol]) : undefined

      // 같은 옵션ID 여러 행 → 마지막이 우선 (덮어쓰기)
      merged.set(optionId, {
        optionId,
        supplyPrice: Math.round(supplyPrice),
        itemName: itemName || undefined,
      })
    }
  }

  if (sheetsProcessed.length === 0 && missingColumns.length === 0) {
    missingColumns.push('"옵션ID" 헤더가 있는 시트를 찾지 못했습니다')
  }

  return {
    rows: Array.from(merged.values()),
    totalRows,
    skippedRows: skipped,
    missingColumns,
    sheetsProcessed,
  }
}
