/**
 * 쿠팡 1P 입고 원장 (로켓_세일즈 .xlsx) 파서 — 실제 입고 시각이 찍힌 발주별·SKU별 입고 내역.
 *
 * 열: 구분 · 번호(발주번호) · SKU번호 · SKU명 · 입고/반출시각 · 물류센터 · 세금타입 · 수량 · 단가(부가포함)
 *     · 공급가액 · 세액 · 총단가(= 수량 × 단가, 부가포함) · 총공급가액 · 총세액 · 계산서번호 · 지급일
 * 구분 '발주' 행만 입고로 읽는다 (그 외 구분은 skipped 로 개수만).
 *
 * 쿠팡 손익 1P 계산(computeOnePPnl)은 발주서 형식(PurchaseOrder)을 받으므로
 * ledgerToOrders 로 (발주번호 × 입고 월) 단위 발주로 바꿔 넘긴다 — dueDate = 그 달 첫 실제 입고일.
 */
import * as XLSX from 'xlsx'
import type { PurchaseOrder } from './purchaseOrder'

export interface RocketLedgerRow {
  poNumber: string
  sku: string
  name: string
  /** 실제 입고 시각 'YYYY-MM-DD HH:mm:ss' */
  receivedAt: string
  center: string
  taxType: string
  qty: number
  /** 매입 단가 (부가포함) */
  unitPrice: number
  /** 총단가 (부가포함 합계) */
  total: number
}

const num = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = Number(String(v ?? '').replace(/[,\s원]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown) => (v == null ? '' : String(v).trim())
const norm = (s: string) => s.replace(/\s+/g, '')

export function parseRocketLedger(buf: ArrayBuffer): { rows: RocketLedgerRow[]; skipped: number; error?: string } {
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return { rows: [], skipped: 0, error: '시트를 찾지 못했습니다' }
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' })
  const hi = aoa.findIndex((r) => r.some((c) => norm(str(c)) === 'SKU번호') && r.some((c) => norm(str(c)).startsWith('입고')))
  if (hi < 0) return { rows: [], skipped: 0, error: '로켓_세일즈 머리글(SKU번호·입고/반출시각)을 찾지 못했습니다' }
  const h = aoa[hi].map((c) => norm(str(c)))
  const col = (name: string) => h.indexOf(norm(name))
  const C = {
    kind: col('구분'), po: col('번호'), sku: col('SKU번호'), name: col('SKU명'), at: col('입고/반출시각'),
    center: col('물류센터'), tax: col('세금타입'), qty: col('수량'), unit: col('단가'), total: col('총단가'),
  }
  const missing = Object.entries(C).filter(([, i]) => i < 0).map(([k]) => k)
  if (missing.length) return { rows: [], skipped: 0, error: `로켓_세일즈 열 누락: ${missing.join(', ')}` }

  const rows: RocketLedgerRow[] = []
  let skipped = 0
  for (const r of aoa.slice(hi + 1)) {
    const kind = str(r[C.kind])
    if (!kind && !str(r[C.po])) continue
    if (kind !== '발주') { skipped++; continue }
    const qty = num(r[C.qty])
    const unitPrice = num(r[C.unit])
    const at = str(r[C.at]).replace(/\//g, '-')
    rows.push({
      poNumber: str(r[C.po]),
      sku: str(r[C.sku]),
      name: str(r[C.name]),
      receivedAt: at,
      center: str(r[C.center]),
      taxType: str(r[C.tax]),
      qty,
      unitPrice,
      total: num(r[C.total]) || qty * unitPrice,
    })
  }
  return { rows, skipped }
}

/** 원장 행 → (발주번호 × 입고 월) 발주. 입고 봉수 = 수량, 매입가 = 부가포함 단가 */
export function ledgerToOrders(rows: RocketLedgerRow[]): PurchaseOrder[] {
  const by = new Map<string, PurchaseOrder>()
  for (const r of rows) {
    const month = r.receivedAt.slice(0, 7)
    const k = `${r.poNumber}|${month}`
    let o = by.get(k)
    if (!o) {
      o = { poNumber: r.poNumber, center: r.center, dueDate: r.receivedAt.slice(0, 10), items: [], fileName: '로켓_세일즈' } as PurchaseOrder
      by.set(k, o)
    }
    if (r.receivedAt.slice(0, 10) < o.dueDate) o.dueDate = r.receivedAt.slice(0, 10)
    const it = o.items.find((x) => x.sku === r.sku && x.unitPrice === r.unitPrice)
    if (it) { it.receivedQty += r.qty; it.orderQty += r.qty }
    else o.items.push({ sku: r.sku, name: r.name, orderQty: r.qty, receivedQty: r.qty, unitPrice: r.unitPrice } as PurchaseOrder['items'][number])
  }
  return Array.from(by.values())
}

/** 원장 행을 입고 월별로 나눔 { 'YYYY-MM': rows } */
export function splitLedgerByMonth(rows: RocketLedgerRow[]): Record<string, RocketLedgerRow[]> {
  const out: Record<string, RocketLedgerRow[]> = {}
  for (const r of rows) (out[r.receivedAt.slice(0, 7)] ||= []).push(r)
  return out
}
