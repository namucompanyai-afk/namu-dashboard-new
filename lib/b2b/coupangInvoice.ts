/**
 * 진도팜 송장 회신 대사 (한진 파일접수 상세내역 xlsx).
 *
 * 발주서 파싱·분기·로켓 양식·라벨·이력 로직은 소비만 한다.
 * 매칭 키는 (받는분=센터, 단품명=내품명) — 상품명은 공백 정규화 후 비교한다
 * (발주서 상품명에 이중 공백이 섞여 있어 원문 그대로는 안 맞음).
 */
import * as XLSX from 'xlsx'
import { resolveCols, toNum } from './kurly'
import { repairRef } from './kurlyFile'
import type { RoutedItem } from './coupang'

export type InvoiceRow = {
  invoiceNo: string // 운송장번호 (하이픈 포함 텍스트 그대로)
  recipient: string // 받는분 = 센터명
  itemName: string // 단품명 = 내품명
  itemQty: number // 내품수량
  qty: number // 수량
}

// 헤더에 개행이 섞인 컬럼("접수\r\n순서")이 있어 정규화 매칭에 맡긴다(resolveCols 가 공백·개행 제거)
const INVOICE_COLS = {
  invoiceNo: ['운송장번호'],
  recipient: ['받는분'],
  itemName: ['단품명'],
  itemQty: ['내품수량'],
  qty: ['수량'],
}

const txt = (v: unknown): string => String(v ?? '').trim()

/** 연속 공백 1개로 — 상품명·센터명 비교용 */
export const squash = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim()

/** 헤더 1행 + 박스당 1행 */
export function parseInvoiceRows(rows: unknown[][]): InvoiceRow[] {
  if (!rows.length) return []
  const c = resolveCols(rows[0], INVOICE_COLS)
  if (c.invoiceNo < 0 || c.recipient < 0 || c.itemName < 0) {
    throw new Error('회신 파일에서 운송장번호/받는분/단품명 컬럼을 찾지 못했습니다.')
  }
  const out: InvoiceRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const invoiceNo = txt(r[c.invoiceNo])
    const recipient = txt(r[c.recipient])
    const itemName = txt(r[c.itemName])
    if (!invoiceNo && !recipient && !itemName) continue
    out.push({
      invoiceNo,
      recipient,
      itemName,
      itemQty: toNum(c.itemQty >= 0 ? r[c.itemQty] : 0),
      qty: toNum(c.qty >= 0 ? r[c.qty] : 0),
    })
  }
  return out
}

/** 업로드 File → 회신 행 (첫 시트) */
export function parseInvoiceFile(file: File): Promise<InvoiceRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'))
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        if (!ws) throw new Error('시트를 찾지 못했습니다.')
        repairRef(ws)
        resolve(parseInvoiceRows(XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

// ── 대사 ─────────────────────────────────────────────────────────
const keyOf = (center: string, product: string) => `${squash(center)}${squash(product)}`

export type ReconRow = {
  center: string
  product: string
  orderBoxes: number // 발주 박스 수
  orderUnits: number // 납품가능수량
  invoiceCount: number // 송장 수
  invoiceUnits: number // 내품수량 합
  invoiceNos: string[]
  inOrder: boolean
  inInvoice: boolean
  ok: boolean
}

export type ReconResult = {
  rows: ReconRow[]
  onlyInvoice: ReconRow[] // 발주에 없는 송장
  onlyOrder: ReconRow[] // 송장 없는 발주
  totalInvoices: number
  totalBoxes: number
  allMatch: boolean
}

/** 진도팜분 발주 × 회신 송장 대사 */
export function reconcileInvoices(jindo: RoutedItem[], invoices: InvoiceRow[]): ReconResult {
  type Agg = { center: string; product: string; boxes: number; units: number }
  const orders = new Map<string, Agg>()
  for (const it of jindo) {
    const k = keyOf(it.center, it.productName)
    const cur = orders.get(k)
    if (cur) {
      cur.boxes += it.boxes ?? 0
      cur.units += it.confirmQty
    } else {
      orders.set(k, {
        center: squash(it.center),
        product: squash(it.productName),
        boxes: it.boxes ?? 0,
        units: it.confirmQty,
      })
    }
  }

  type Inv = { center: string; product: string; count: number; units: number; nos: string[] }
  const invs = new Map<string, Inv>()
  for (const r of invoices) {
    const k = keyOf(r.recipient, r.itemName)
    let cur = invs.get(k)
    if (!cur) {
      cur = { center: squash(r.recipient), product: squash(r.itemName), count: 0, units: 0, nos: [] }
      invs.set(k, cur)
    }
    cur.count++
    cur.units += r.itemQty
    if (r.invoiceNo) cur.nos.push(r.invoiceNo)
  }

  const keys = [...new Set([...orders.keys(), ...invs.keys()])]
  const rows: ReconRow[] = keys.map((k) => {
    const o = orders.get(k)
    const v = invs.get(k)
    const orderBoxes = o?.boxes ?? 0
    const orderUnits = o?.units ?? 0
    const invoiceCount = v?.count ?? 0
    const invoiceUnits = v?.units ?? 0
    return {
      center: o?.center || v?.center || '',
      product: o?.product || v?.product || '',
      orderBoxes,
      orderUnits,
      invoiceCount,
      invoiceUnits,
      invoiceNos: v?.nos ?? [],
      inOrder: !!o,
      inInvoice: !!v,
      ok: !!o && !!v && invoiceCount === orderBoxes && invoiceUnits === orderUnits,
    }
  })

  rows.sort((a, b) =>
    a.center === b.center ? a.product.localeCompare(b.product) : a.center.localeCompare(b.center),
  )

  return {
    rows,
    onlyInvoice: rows.filter((r) => !r.inOrder),
    onlyOrder: rows.filter((r) => !r.inInvoice),
    totalInvoices: invoices.length,
    totalBoxes: [...orders.values()].reduce((s, o) => s + o.boxes, 0),
    allMatch: rows.length > 0 && rows.every((r) => r.ok),
  }
}

// ── 쉽먼트 등록용 송장 정리 ──────────────────────────────────────
export type CenterInvoiceBlock = {
  center: string
  products: { product: string; invoiceNos: string[] }[]
  count: number
}

/** 센터별 → 상품별 송장번호 목록 (회신 파일 등장 순서 유지) */
export function buildInvoiceBlocks(invoices: InvoiceRow[]): CenterInvoiceBlock[] {
  const byCenter = new Map<string, CenterInvoiceBlock>()
  for (const r of invoices) {
    const c = squash(r.recipient)
    let blk = byCenter.get(c)
    if (!blk) {
      blk = { center: c, products: [], count: 0 }
      byCenter.set(c, blk)
    }
    const p = squash(r.itemName)
    let prod = blk.products.find((x) => x.product === p)
    if (!prod) {
      prod = { product: p, invoiceNos: [] }
      blk.products.push(prod)
    }
    if (r.invoiceNo) {
      prod.invoiceNos.push(r.invoiceNo)
      blk.count++
    }
  }
  return [...byCenter.values()]
}

/** 블록의 송장번호 — 줄바꿈 구분 플레인 텍스트 */
export function invoiceNosText(block: CenterInvoiceBlock): string {
  return block.products.flatMap((p) => p.invoiceNos).join('\n')
}
