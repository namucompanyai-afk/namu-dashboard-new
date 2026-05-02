import * as XLSX from 'xlsx'

/**
 * 네이버 정산파일 파서 — 정산내역_건별정산내역_수수료상세.xlsx
 * 시트명: "수수료상세-건별"
 * 헤더(R1):
 *   A No / B 주문번호 / C 상품주문번호 / D 구분 / E 상품명 / F 구매자명
 *   G 정산예정일 / H 정산완료일 / I 정산기준일 / J 세금신고기준일
 *   K 정산상태 / L 수수료기준금액 / M 수수료구분 / N 결제수단
 *   O 매출연동수수료상세 / P 수수료상한액 / Q 수수료금액
 *
 * 동일 C(상품주문번호) 묶기 → 1행. L의 max = 그 주문 판매가, Q 합계 = 정산수수료(음수).
 * 날짜는 I(정산기준일) 사용, "YYYY.MM.DD" → "YYYY-MM-DD" 정규화.
 */

export type SettlementKind = '상품주문' | '배송비'

export interface NaverSettlementRow {
  productOrderId: string
  orderId: string
  productName: string
  kind: SettlementKind
  settleDate: string
  basePrice: number
  feeSum: number
}

export interface NaverSettlementData {
  rows: NaverSettlementRow[]
  dateRange: { min: string; max: string } | null
  totalRevenue: number
  totalFee: number
  shipRevenue: number
  shipFee: number
  productOrderCount: number
}

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).replace(/,/g, '').trim()
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function normHeader(s: string): string {
  return s.replace(/[\s()\[\]/·\n\t]+/g, '').toLowerCase()
}

/** "2025.12.30" / "2025-12-30" / "2025/12/30" → "2025-12-30". 빈 입력은 ''. */
function normalizeDate(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const m = t.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/)
  if (!m) return ''
  const [, y, mo, d] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
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

export async function parseNaverSettlement(buffer: ArrayBuffer): Promise<NaverSettlementData> {
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: false })
  const aoa = findSheet(wb, ['수수료상세-건별', '수수료상세', 'SettleCaseByCase'])
  if (!aoa) {
    return emptyResult()
  }

  // 헤더 행 탐색 (앞 5행 내)
  let headerIdx = -1
  for (let i = 0; i < Math.min(5, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const normed = row.map((c) => normHeader(toStr(c)))
    if (normed.includes('상품주문번호') && (normed.includes('정산기준일') || normed.includes('수수료기준금액'))) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return emptyResult()

  const headers = (aoa[headerIdx] as unknown[]).map((c) => normHeader(toStr(c)))
  const col = (key: string) => headers.indexOf(key)
  const cOrderId = col('주문번호')
  const cProductOrderId = col('상품주문번호')
  const cKind = col('구분')
  const cName = col('상품명')
  const cSettleDate = col('정산기준일') >= 0 ? col('정산기준일') : col('정산예정일')
  const cBase = col('수수료기준금액')
  const cFee = col('수수료금액')
  // 일부 양식에는 컬럼명이 다를 수 있음 — 폴백
  const cBase2 = col('정산기준금액')
  const cFee2 = col('정산예정금액')

  // 같은 상품주문번호 묶기 (max basePrice, sum feeSum)
  const grouped = new Map<string, NaverSettlementRow>()
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const productOrderId = toStr(r[cProductOrderId])
    if (!productOrderId) continue
    const kindRaw = toStr(r[cKind])
    const kind: SettlementKind = kindRaw === '배송비' ? '배송비' : '상품주문'
    const orderId = toStr(r[cOrderId])
    const productName = toStr(r[cName])
    const settleDate = normalizeDate(toStr(r[cSettleDate]))
    const basePrice =
      cBase >= 0 ? toNum(r[cBase]) : cBase2 >= 0 ? toNum(r[cBase2]) : 0
    const feeRaw = cFee >= 0 ? toNum(r[cFee]) : cFee2 >= 0 ? toNum(r[cFee2]) : 0

    const key = `${productOrderId}|${kind}`
    const prev = grouped.get(key)
    if (prev) {
      if (basePrice > prev.basePrice) prev.basePrice = basePrice
      prev.feeSum += feeRaw
      if (!prev.settleDate && settleDate) prev.settleDate = settleDate
      if (!prev.productName && productName) prev.productName = productName
    } else {
      grouped.set(key, {
        productOrderId,
        orderId,
        productName,
        kind,
        settleDate,
        basePrice,
        feeSum: feeRaw,
      })
    }
  }

  const rows = Array.from(grouped.values())
  let minD = ''
  let maxD = ''
  let totalRevenue = 0
  let totalFee = 0
  let shipRevenue = 0
  let shipFee = 0
  let productOrderCount = 0
  for (const r of rows) {
    if (r.settleDate) {
      if (!minD || r.settleDate < minD) minD = r.settleDate
      if (!maxD || r.settleDate > maxD) maxD = r.settleDate
    }
    if (r.kind === '상품주문') {
      totalRevenue += r.basePrice
      totalFee += r.feeSum
      productOrderCount += 1
    } else {
      shipRevenue += r.basePrice
      shipFee += r.feeSum
    }
  }

  return {
    rows,
    dateRange: minD && maxD ? { min: minD, max: maxD } : null,
    totalRevenue,
    totalFee,
    shipRevenue,
    shipFee,
    productOrderCount,
  }
}

function emptyResult(): NaverSettlementData {
  return {
    rows: [],
    dateRange: null,
    totalRevenue: 0,
    totalFee: 0,
    shipRevenue: 0,
    shipFee: 0,
    productOrderCount: 0,
  }
}
