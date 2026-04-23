import * as XLSX from 'xlsx'
import type { SalesInsightRow, CoupangChannel } from '@/types/coupang'

/**
 * 판매 분석 엑셀 (VENDOR_ITEM_METRICS) 파서
 *
 * 실제 구조 (2026.04 확인):
 *   시트 "vendor item metrics" (1개)
 *   행0: 컬럼 헤더 (바로 헤더!)
 *     [0]  옵션 ID          (공백 포함!)
 *     [1]  옵션명
 *     [2]  상품명
 *     [3]  등록상품ID
 *     [4]  카테고리
 *     [5]  판매방식          ← "판매자배송" / "로켓그로스"
 *     [6]  매출(원)
 *     [7]  주문
 *     [8]  판매량
 *     [13] 아이템위너 비율(%)
 *     [14] 총 매출(원)
 *     [15] 총 판매수
 *   행1+: 데이터
 *
 * 주의:
 *  - 매출은 이미 VAT 포함 (고객 결제가)
 *  - 위너비율은 문자열 "0.00%" 형태 또는 숫자 양쪽 다 올 수 있음
 *  - 같은 옵션ID 여러 행 가능 (카테고리/기간 split) → 누적 합산
 */

function normHeader(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

const ALIAS_NORMALIZED: Record<string, string[]> = {
  optionId:    ['옵션id'],
  revenue:     ['매출(원)', '매출'],
  totalRevenue:['총매출(원)', '총매출'],
  sales:       ['판매량'],
  totalSales:  ['총판매수'],
  winnerRate:  ['아이템위너비율(%)', '아이템위너비율'],
  saleMethod:  ['판매방식'],
}

type AliasKey = keyof typeof ALIAS_NORMALIZED

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

/** 숫자 변환. "0.00%" 같은 퍼센트 문자열도 숫자로 변환. */
function toNum(v: unknown): number {
  if (v == null || v === '') return NaN
  if (typeof v === 'number') return v
  const cleaned = String(v).replace(/[,\s%원]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}

function mapChannel(saleMethod: string): CoupangChannel | null {
  if (!saleMethod) return null
  const s = saleMethod.toLowerCase()
  if (s.includes('그로스') || s.includes('rocket growth')) return 'growth'
  if (s.includes('판매자') || s.includes('wing') || s.includes('셀러')) return 'wing'
  return null
}

function resolveColumnIndices(headers: string[]): Partial<Record<AliasKey, number>> {
  const norms = headers.map(normHeader)
  const map: Partial<Record<AliasKey, number>> = {}

  for (const [key, aliases] of Object.entries(ALIAS_NORMALIZED) as [AliasKey, string[]][]) {
    for (let i = 0; i < norms.length; i++) {
      if (aliases.includes(norms[i]!)) {
        if (map[key] == null) map[key] = i
        break
      }
    }
  }
  return map
}

export interface SalesInsightParseResult {
  rows: SalesInsightRow[]
  skippedRows: number
  missingColumns: string[]
}

export function parseSalesInsight(buffer: ArrayBuffer): SalesInsightParseResult {
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]
  if (!sheet) return { rows: [], skippedRows: 0, missingColumns: ['시트 없음'] }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })

  // 헤더 탐지: "옵션 ID" 포함된 첫 행
  let headerRowIdx = -1
  for (let i = 0; i < Math.min(5, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const norms = row.map((c) => normHeader(toStr(c)))
    if (norms.includes('옵션id')) {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx === -1) {
    return { rows: [], skippedRows: 0, missingColumns: ['옵션 ID 헤더를 찾지 못함'] }
  }

  const headers = (aoa[headerRowIdx] as unknown[]).map(toStr)
  const colMap = resolveColumnIndices(headers)

  const missing: string[] = []
  if (colMap.optionId == null) missing.push('옵션 ID')
  if (colMap.revenue == null && colMap.totalRevenue == null) missing.push('매출')
  if (colMap.sales == null && colMap.totalSales == null) missing.push('판매량')
  if (colMap.optionId == null) {
    return { rows: [], skippedRows: 0, missingColumns: missing }
  }

  // 옵션ID별 누적
  const acc = new Map<string, SalesInsightRow>()
  const dataRows = aoa.slice(headerRowIdx + 1) as unknown[][]
  let skipped = 0

  for (const row of dataRows) {
    const optionId = toStr(row[colMap.optionId!])
    if (!optionId) {
      skipped++
      continue
    }

    // 매출: "총 매출"을 우선 사용 (기간 전체), 없으면 "매출"
    const revenueCol = colMap.totalRevenue ?? colMap.revenue
    const salesCol = colMap.totalSales ?? colMap.sales
    const revenue = revenueCol != null ? toNum(row[revenueCol]) : NaN
    const sales = salesCol != null ? toNum(row[salesCol]) : NaN
    const winnerRate = colMap.winnerRate != null ? toNum(row[colMap.winnerRate]) : NaN
    const saleMethod = colMap.saleMethod != null ? toStr(row[colMap.saleMethod]) : ''

    const prev = acc.get(optionId)
    acc.set(optionId, {
      optionId,
      revenue90d: (prev?.revenue90d ?? 0) + (Number.isFinite(revenue) ? revenue : 0),
      sales90d: (prev?.sales90d ?? 0) + (Number.isFinite(sales) ? sales : 0),
      // 위너비율은 합산 아님 → 마지막 값 유지
      winnerRate: Number.isFinite(winnerRate) ? winnerRate : (prev?.winnerRate ?? 0),
      channel: mapChannel(saleMethod) ?? prev?.channel ?? null,
    })
  }

  const rows: SalesInsightRow[] = []
  for (const row of acc.values()) {
    rows.push({
      ...row,
      revenue90d: Math.round(row.revenue90d),
      sales90d: Math.round(row.sales90d),
    })
  }

  return { rows, skippedRows: skipped, missingColumns: missing }
}
