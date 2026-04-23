import * as XLSX from 'xlsx'
import type { SettlementRow } from '@/types/coupang'
import { addVat } from '../money'

/**
 * 로켓그로스 정산 엑셀 파서
 *
 * 실제 구조 (2026.04 확인):
 *   시트: "입출고비", "배송비" (2개)
 *
 *   각 시트:
 *     행0~2: 정산 요약 (스킵)
 *     행3: 메인 헤더
 *     행4: 서브 헤더 (1차/2차, 발생비용(A)/할인가(B)/할인적용가(A-B)/추가비용/최종비용)
 *     행5+: 실제 데이터 (건별)
 *
 *   컬럼 인덱스 (두 시트 공통):
 *     [10] 옵션ID
 *     [13] 옵션명
 *     [14] 단품 판매가
 *
 *   입출고비 시트 (특화):
 *     [22] "쿠팡풀필먼트서비스(CFS) 입출고비 (VAT 별도)" 헤더
 *     [24] 할인적용가(A-B) ← 실제 청구액
 *
 *   배송비 시트 (특화):
 *     [22] "쿠팡풀필먼트서비스(CFS) 배송비 (VAT 별도)" 헤더
 *     [26] 최종비용 ← 추가비용 포함 최종 청구액
 *
 * 처리 규칙:
 *   1) 건별 데이터 → 옵션ID별로 "단품 판매가 최고가 행" 1개만 선택
 *   2) 그 행의 비용을 VAT 포함(x1.1) 환산
 *   3) 두 시트 결과를 옵션ID로 merge (입출고비+배송비 = 총 물류비)
 */

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return NaN
  const n = Number(String(v).replace(/[,\s원]/g, ''))
  return Number.isFinite(n) ? n : NaN
}

/** 헤더 행을 찾음: "옵션ID"가 존재하는 행 (공백 없음에 주의) */
function findHeaderRow(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const hasOptionId = row.some((c) => toStr(c) === '옵션ID')
    if (hasOptionId) return i
  }
  return -1
}

interface ColumnMap {
  optionId: number
  unitPrice: number          // [14] 단품 판매가
  /** 이 시트의 "실제 청구 비용" 컬럼 인덱스 (시트별로 다름) */
  finalFeeCol: number
  /** 이 시트가 '입출고비'인지 '배송비'인지 */
  kind: 'warehousing' | 'shipping'
}

/**
 * 시트 타입 판정 + 해당 비용 컬럼 인덱스 찾기
 *
 * 입출고비 시트: 메인 헤더[22]에 "입출고비" 포함 → 서브 헤더[24]="할인적용가(A-B)" 사용
 * 배송비 시트:   메인 헤더[22]에 "배송비" 포함 → 서브 헤더[26]="최종비용" 사용
 *
 * 서브 헤더는 메인 헤더 바로 아래 행에 있음.
 */
function resolveColumnMap(
  sheetName: string,
  mainHeaders: string[],
  subHeaders: string[],
): ColumnMap | null {
  const optionIdIdx = mainHeaders.findIndex((h) => toStr(h) === '옵션ID')
  const unitPriceIdx = mainHeaders.findIndex((h) => toStr(h) === '단품 판매가')
  if (optionIdIdx === -1 || unitPriceIdx === -1) return null

  // 시트 이름으로 1차 판정 (더 신뢰성 높음)
  const name = sheetName.toLowerCase()
  let kind: 'warehousing' | 'shipping'
  if (name.includes('입출고') || name.includes('warehousing')) {
    kind = 'warehousing'
  } else if (name.includes('배송') || name.includes('shipping')) {
    kind = 'shipping'
  } else {
    // 시트 이름으로 판정 실패 시 헤더 내용으로 2차 판정
    const hasWh = mainHeaders.some((h) => toStr(h).includes('입출고비'))
    const hasShip = mainHeaders.some((h) => toStr(h).includes('배송비'))
    if (hasWh) kind = 'warehousing'
    else if (hasShip) kind = 'shipping'
    else return null
  }

  // 서브 헤더에서 "할인적용가(A-B)" 또는 "최종비용" 찾기
  // 입출고비 시트는 "최종비용" 컬럼이 없으므로 "할인적용가(A-B)" 사용
  // 배송비 시트는 "최종비용"이 있으면 그거, 없으면 "할인적용가(A-B)"
  let finalFeeCol = -1

  if (kind === 'shipping') {
    finalFeeCol = subHeaders.findIndex((h) => toStr(h) === '최종비용')
  }
  if (finalFeeCol === -1) {
    finalFeeCol = subHeaders.findIndex((h) => {
      const s = toStr(h)
      return s.includes('할인적용가') || s === '할인적용가(A-B)'
    })
  }
  if (finalFeeCol === -1) return null

  return { optionId: optionIdIdx, unitPrice: unitPriceIdx, finalFeeCol, kind }
}

export interface SettlementParseResult {
  rows: SettlementRow[]
  sheetCount: number
  skippedRows: number
  missingColumns: string[]
}

export function parseSettlement(buffer: ArrayBuffer): SettlementParseResult {
  const wb = XLSX.read(buffer, { type: 'array' })
  const accumulated = new Map<string, SettlementRow>()
  let sheetsParsed = 0
  let skipped = 0
  const warnings: string[] = []

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue

    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
    const headerRowIdx = findHeaderRow(aoa)
    if (headerRowIdx === -1) continue

    const mainHeaders = (aoa[headerRowIdx] as unknown[]).map(toStr)
    const subHeaders = ((aoa[headerRowIdx + 1] as unknown[]) ?? []).map(toStr)

    const colMap = resolveColumnMap(sheetName, mainHeaders, subHeaders)
    if (!colMap) continue

    sheetsParsed++

    // 데이터는 서브헤더 다음 행부터 (headerRowIdx + 2)
    const dataRows = aoa.slice(headerRowIdx + 2) as unknown[][]

    // 시트 내 옵션ID별 "단품 판매가 최고가" 행 선택
    const bestInSheet = new Map<string, { unitPrice: number; fee: number }>()

    for (const row of dataRows) {
      const optionId = toStr(row[colMap.optionId])
      if (!optionId) {
        skipped++
        continue
      }
      const unitPriceRaw = toNum(row[colMap.unitPrice])
      const feeRaw = toNum(row[colMap.finalFeeCol])
      if (!Number.isFinite(unitPriceRaw) || !Number.isFinite(feeRaw)) continue

      const prev = bestInSheet.get(optionId)
      if (!prev || unitPriceRaw > prev.unitPrice) {
        bestInSheet.set(optionId, { unitPrice: unitPriceRaw, fee: feeRaw })
      }
    }

    // 시트 결과를 전역 누적으로 merge (두 시트의 비용을 합치는 게 아니라 각각 별도 저장)
    for (const [optionId, best] of bestInSheet) {
      const unitPriceVatIn = addVat(best.unitPrice)
      const feeVatIn = addVat(best.fee)
      const prev = accumulated.get(optionId)

      const merged: SettlementRow = {
        optionId,
        maxUnitPrice: Math.max(unitPriceVatIn, prev?.maxUnitPrice ?? 0),
        warehousingFee:
          colMap.kind === 'warehousing' ? feeVatIn : (prev?.warehousingFee ?? 0),
        shippingFee: colMap.kind === 'shipping' ? feeVatIn : (prev?.shippingFee ?? 0),
      }
      accumulated.set(optionId, merged)
    }
  }

  if (sheetsParsed === 0) {
    warnings.push('입출고비/배송비 시트를 찾지 못했습니다')
  } else if (sheetsParsed < 2) {
    warnings.push(`시트 ${sheetsParsed}개만 파싱됨 (보통 2개: 입출고비 + 배송비)`)
  }

  return {
    rows: Array.from(accumulated.values()),
    sheetCount: sheetsParsed,
    skippedRows: skipped,
    missingColumns: warnings,
  }
}
