import * as XLSX from 'xlsx'
import JSZip from 'jszip'

/**
 * 쿠팡 1P 발주서 파서 — 서플라이어 허브 발주서리스트 (xlsx 1개 = 발주 1건, 또는 그 xlsx 들을 묶은 zip)
 *
 * 셀 위치: 발주번호 C10 · 물류센터 C13 · 입고예정일시 F13 · 하차일시 G13 (미하차면 '-')
 * 상품: 22행부터 2행 단위 (B 상품코드(=SKU) · C 상품명 · G 발주수량 · I 입고수량 · J 매입가(부가포함)), '합계' 행에서 끝
 */

export interface PurchaseOrderItem {
  sku: string
  name: string
  orderQty: number
  receivedQty: number
  /** 매입가 (부가포함, 1개당) */
  unitPrice: number
}

export interface PurchaseOrder {
  poNumber: string
  center: string
  /** 입고예정일 YYYY-MM-DD */
  dueDate: string
  /** 하차일 YYYY-MM-DD — 발주서에서 읽은 것만 키가 있음 (미하차 '-' 면 null). 로켓_세일즈 원장에서 만든 발주엔 없음 */
  unloadedAt?: string | null
  items: PurchaseOrderItem[]
  fileName: string
}

const num = (v: unknown) => {
  if (typeof v === 'number') return v
  const n = Number(String(v ?? '').replace(/[,\s원]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown) => (v == null ? '' : String(v).trim())

export function parsePurchaseOrderXlsx(buf: ArrayBuffer, fileName = ''): PurchaseOrder | null {
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return null
  const cell = (addr: string) => ws[addr]?.v
  const poNumber = str(cell('C10'))
  if (!/^\d+$/.test(poNumber)) return null
  const due = str(cell('F13')).replace(/\//g, '-').slice(0, 10)
  const unloaded = str(cell('G13')).replace(/\//g, '-').slice(0, 10)
  const items: PurchaseOrderItem[] = []
  for (let r = 22; r < 22 + 2 * 500; r += 2) {
    const a = str(cell(`A${r}`))
    if (!a || a === '합계') break
    const sku = str(cell(`B${r}`))
    if (!sku) continue
    items.push({
      sku,
      name: str(cell(`C${r}`)),
      orderQty: num(cell(`G${r}`)),
      receivedQty: num(cell(`I${r}`)),
      unitPrice: num(cell(`J${r}`)),
    })
  }
  return { poNumber, center: str(cell('C13')), dueDate: due, unloadedAt: /^\d{4}-\d{2}-\d{2}$/.test(unloaded) ? unloaded : null, items, fileName }
}

/** 파일 여러 개(xlsx 또는 zip) → 발주서 목록 (발주번호 중복은 뒤 파일 우선) */
export async function parsePurchaseOrderFiles(files: { name: string; buf: ArrayBuffer }[]): Promise<{ orders: PurchaseOrder[]; skipped: string[] }> {
  const out = new Map<string, PurchaseOrder>()
  const skipped: string[] = []
  const take = (name: string, buf: ArrayBuffer) => {
    const po = parsePurchaseOrderXlsx(buf, name)
    if (po) out.set(po.poNumber, po)
    else skipped.push(name)
  }
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f.buf)
      const entries = Object.values(zip.files).filter((e) => !e.dir && /\.xlsx$/i.test(e.name) && !/(^|\/)(__MACOSX|\._)/.test(e.name))
      for (const e of entries) take(e.name, await e.async('arraybuffer'))
    } else if (/\.xlsx?$/i.test(f.name)) take(f.name, f.buf)
    else skipped.push(f.name)
  }
  return { orders: Array.from(out.values()), skipped }
}
