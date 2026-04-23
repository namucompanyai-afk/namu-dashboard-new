import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import type { PriceInventoryRow } from '@/types/coupang'

/**
 * 쿠팡 상품 엑셀 (price_inventory) 파서
 *
 * 실제 구조 (2026.04 확인):
 *   시트 "data" (1개)
 *   행0: 안내문
 *   행1: 섹션 헤더 ("상품정보 조회결과" | "*변경/수정 요청")
 *   행2: 컬럼 헤더 ← 실제 헤더
 *     [0] 업체상품 ID    (공백 포함!)
 *     [1] Product ID
 *     [2] 옵션 ID        (공백 포함!)
 *     [8] 등록 옵션명
 *     [9] 판매가격
 *     ...
 *     [15~18] 변경요청 중복 컬럼 (무시)
 *   행3+: 데이터
 *
 * 🚨 쿠팡 엑셀의 고질적 버그 핸들링:
 *   이 엑셀의 <dimension ref="..."> 태그가 잘못 기록되어 있음 (예: "A1:S3").
 *   SheetJS는 dimension을 존중해서 그 뒤 행을 아예 안 읽음.
 *   → xlsx 파일을 풀어서 dimension을 실제 범위로 고친 뒤 다시 읽음.
 */

function normHeader(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

const ALIAS_NORMALIZED: Record<string, string[]> = {
  listingId:    ['업체상품id', '등록상품id', 'vendoritemid'],
  productId:    ['productid', '노출상품id', '상품id'],
  optionId:     ['옵션id', 'optionid'],
  productName:  ['쿠팡노출상품명', '노출상품명', '상품명', 'productname'],
  optionName:   ['등록옵션명', '옵션명', 'optionname'],
  sellingPrice: ['판매가격', '판매가', 'sellingprice'],
  listPrice:    ['할인율기준가', '정상가'],
  saleStatus:   ['판매상태', 'salestatus'],
  productStatus:['상품상태', 'productstatus'],
}

type AliasKey = keyof typeof ALIAS_NORMALIZED

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return NaN
  const n = Number(String(v).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : NaN
}

function resolveColumnIndices(headers: string[]): Partial<Record<AliasKey, number>> {
  const map: Partial<Record<AliasKey, number>> = {}
  const normHeaders = headers.map(normHeader)

  for (const [key, aliases] of Object.entries(ALIAS_NORMALIZED) as [AliasKey, string[]][]) {
    for (let i = 0; i < normHeaders.length; i++) {
      if (aliases.includes(normHeaders[i]!)) {
        if (map[key] == null) map[key] = i
      }
    }
  }
  return map
}

/**
 * XLSX 파일의 sheet1.xml dimension 태그를 실제 row 범위로 수정.
 * 쿠팡 엑셀이 dimension을 잘못 기록하는 버그 회피용.
 */
async function fixXlsxDimension(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    let modified = false

    // 모든 worksheet 파일 순회
    for (const path of Object.keys(zip.files)) {
      if (!path.match(/^xl\/worksheets\/sheet\d+\.xml$/)) continue

      const file = zip.file(path)
      if (!file) continue

      const xml = await file.async('string')
      const rowMatches = [...xml.matchAll(/<row[^>]*\br="(\d+)"/g)]
      if (rowMatches.length === 0) continue

      const rowNums = rowMatches.map((m) => Number(m[1]))
      const maxRow = Math.max(...rowNums)
      const minRow = Math.min(...rowNums)

      // 기존 dimension 찾기
      const dimMatch = xml.match(/<dimension\s+ref="([^"]+)"\s*\/>/)
      if (!dimMatch) continue

      const currentRef = dimMatch[1]!
      // 이미 올바른 범위면 스킵
      const currentMaxMatch = currentRef.match(/:[A-Z]+(\d+)$/)
      if (currentMaxMatch && Number(currentMaxMatch[1]) >= maxRow) continue

      // col 범위는 기존 유지 (보통 A~Z 정도)
      const colMatch = currentRef.match(/^([A-Z]+)\d+:([A-Z]+)\d+$/)
      const startCol = colMatch?.[1] ?? 'A'
      const endCol = colMatch?.[2] ?? 'Z'
      const newDim = `<dimension ref="${startCol}${minRow}:${endCol}${maxRow}"/>`

      const fixedXml = xml.replace(dimMatch[0], newDim)
      zip.file(path, fixedXml)
      modified = true
    }

    if (!modified) return buffer

    const out = await zip.generateAsync({ type: 'arraybuffer' })
    return out
  } catch {
    // zip 실패 시 원본 반환 (최악의 경우에도 파싱은 시도)
    return buffer
  }
}

export interface ParseResult<T> {
  rows: T[]
  missingColumns: string[]
  skippedRows: number
}

export async function parsePriceInventory(
  buffer: ArrayBuffer,
): Promise<ParseResult<PriceInventoryRow>> {
  // 쿠팡 엑셀 dimension 버그 회피
  const fixedBuf = await fixXlsxDimension(buffer)

  const wb = XLSX.read(fixedBuf, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]
  if (!sheet) return { rows: [], missingColumns: ['시트를 찾을 수 없음'], skippedRows: 0 }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })

  // 헤더 탐지: "Product ID" + "옵션 ID" 동시 존재하는 행
  let headerRowIdx = -1
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const norms = row.map((c) => normHeader(toStr(c)))
    if (norms.includes('productid') && norms.includes('옵션id')) {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx === -1) {
    return {
      rows: [],
      missingColumns: ['헤더 행을 찾지 못함 (Product ID + 옵션 ID)'],
      skippedRows: 0,
    }
  }

  const headers = (aoa[headerRowIdx] as unknown[]).map(toStr)
  const colMap = resolveColumnIndices(headers)

  const required: AliasKey[] = ['listingId', 'productId', 'optionId', 'optionName', 'sellingPrice']
  const missing = required.filter((k) => colMap[k] == null)
  if (missing.length > 0) {
    return { rows: [], missingColumns: missing, skippedRows: 0 }
  }

  const rows: PriceInventoryRow[] = []
  let skipped = 0
  const dataRows = aoa.slice(headerRowIdx + 1) as unknown[][]

  for (const raw of dataRows) {
    const optionId = toStr(raw[colMap.optionId!])
    const listingId = toStr(raw[colMap.listingId!])
    const productId = toStr(raw[colMap.productId!])
    const optionName = toStr(raw[colMap.optionName!])
    const productName = colMap.productName != null ? toStr(raw[colMap.productName]) : ''
    const sellingPrice = toNum(raw[colMap.sellingPrice!])

    if (!optionId || !listingId || !productId) {
      skipped++
      continue
    }
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) {
      skipped++
      continue
    }

    const listPriceRaw = colMap.listPrice != null ? toNum(raw[colMap.listPrice]) : NaN

    rows.push({
      optionId,
      listingId,
      productId,
      productName,
      optionName,
      sellingPrice: Math.round(sellingPrice),
      listPrice: Number.isFinite(listPriceRaw) && listPriceRaw > 0 ? Math.round(listPriceRaw) : null,
      saleStatus: colMap.saleStatus != null ? toStr(raw[colMap.saleStatus]) || null : null,
      productStatus: colMap.productStatus != null ? toStr(raw[colMap.productStatus]) || null : null,
    })
  }

  return { rows, missingColumns: [], skippedRows: skipped }
}
