import * as XLSX from 'xlsx'

/**
 * 네이버 스마트스토어 주문조회 파서
 *
 * 다운로드 경로: 스마트스토어센터 → 판매관리 → 주문통합검색
 * 파일명 패턴: 스마트스토어_주문조회_*.xlsx
 *
 * ⚠ 원본 파일은 비밀번호(1111)로 암호화되어 있음.
 *   PR1 단계에서는 사용자가 미리 비번을 풀고 업로드한 평문 xlsx 만 처리.
 *
 * 헤더 row 1 기준, 컬럼:
 *   A 상품주문번호
 *   C 주문일시
 *   D 주문상태
 *   J 또는 11 상품명 (양식 변동 가능 — 헤더 텍스트로 매칭)
 *   K 옵션정보
 *   M 수량
 */

export interface NaverOrderQueryRow {
  productOrderId: string
  orderDate: Date | null
  status: string
  productName: string
  optionInfo: string
  quantity: number
}

export interface NaverOrderQueryData {
  rows: NaverOrderQueryRow[]
  /** 상품주문번호 → row (중복 시 첫 row 우선) */
  indexByOrderId: Map<string, NaverOrderQueryRow>
  /** 주문일시 min/max (전체 row 기준, 결측 제외) */
  periodStart: Date | null
  periodEnd: Date | null
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
  // 후보가 없으면 첫 시트
  if (wb.SheetNames.length > 0) {
    return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
      blankrows: false,
    })
  }
  return null
}

/** Excel 직렬 날짜(숫자) 또는 'YYYY-MM-DD ...' 문자열 → Date */
function parseDateCell(v: unknown): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return v
  if (typeof v === 'number' && Number.isFinite(v)) {
    // SheetJS 가 cellDates:false 일 때 숫자로 옴 — Excel epoch 1900-01-00
    const d = XLSX.SSF.parse_date_code(v)
    if (d) return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0)
    return null
  }
  const s = String(v).trim()
  if (!s) return null
  // '2026-01-03 14:23:45' / '2026.01.03' / '2026/01/03'
  const m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(hh ?? 0),
      Number(mm ?? 0),
      Number(ss ?? 0),
    )
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t) : null
}

export async function parseNaverOrderQuery(
  buffer: ArrayBuffer,
): Promise<NaverOrderQueryData> {
  const empty: NaverOrderQueryData = {
    rows: [],
    indexByOrderId: new Map(),
    periodStart: null,
    periodEnd: null,
  }
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: false, cellDates: true })
  const aoa = findSheet(wb, ['주문조회', '주문통합검색', '주문', 'OrderList'])
  if (!aoa) return empty

  // 헤더 행 탐색 (앞 5행)
  let headerIdx = -1
  for (let i = 0; i < Math.min(5, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const normed = row.map((c) => normHeader(toStr(c)))
    if (normed.includes('상품주문번호')) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return empty

  const headers = (aoa[headerIdx] as unknown[]).map((c) => normHeader(toStr(c)))
  const col = (...keys: string[]): number => {
    for (const k of keys) {
      const idx = headers.indexOf(k)
      if (idx >= 0) return idx
    }
    return -1
  }
  const cOrderId = col('상품주문번호')
  const cDate = col('주문일시', '결제일', '결제일시')
  const cStatus = col('주문상태')
  const cName = col('상품명')
  const cOption = col('옵션정보', '옵션')
  const cQty = col('수량')

  const rows: NaverOrderQueryRow[] = []
  const idx = new Map<string, NaverOrderQueryRow>()
  let minDate: Date | null = null
  let maxDate: Date | null = null

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const productOrderId = cOrderId >= 0 ? toStr(r[cOrderId]) : ''
    if (!productOrderId) continue

    const orderDate = cDate >= 0 ? parseDateCell(r[cDate]) : null
    const status = cStatus >= 0 ? toStr(r[cStatus]) : ''
    const productName = cName >= 0 ? toStr(r[cName]) : ''
    const optionInfo = cOption >= 0 ? toStr(r[cOption]) : ''
    const qtyRaw = cQty >= 0 ? toNum(r[cQty]) : 0
    const quantity = qtyRaw > 0 ? Math.round(qtyRaw) : 1

    const row: NaverOrderQueryRow = {
      productOrderId,
      orderDate,
      status,
      productName,
      optionInfo,
      quantity,
    }
    rows.push(row)
    if (!idx.has(productOrderId)) idx.set(productOrderId, row) // 중복 시 첫 row 우선

    if (orderDate) {
      if (!minDate || orderDate < minDate) minDate = orderDate
      if (!maxDate || orderDate > maxDate) maxDate = orderDate
    }
  }

  return {
    rows,
    indexByOrderId: idx,
    periodStart: minDate,
    periodEnd: maxDate,
  }
}
