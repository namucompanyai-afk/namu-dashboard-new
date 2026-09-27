/**
 * 쿠팡 1P(로켓 직매입) 판매 CSV 파서 — 서플라이어 허브 "상품별 판매 분석" (A00993784_SALES_ANALYSIS_BY_PRODUCT_*.csv)
 *
 * UTF-8(BOM) CSV. 판매 수량은 '옵션' 단위 (예: "2개" 옵션 1건 = 2봉) — 봉 환산은 onePPnl 에서.
 * 헤더: 벤더아이템 ID(=옵션ID) · 벤더아이템명 · 상품 ID · … · 매출액(GMV) · 주문건수 · 판매 수량
 */

export interface OnePSalesRow {
  optionId: string
  name: string
  productId: string
  gmv: number
  orders: number
  qty: number
}

/** 따옴표·쉼표 처리하는 최소 CSV 파서 */
function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else q = false
      } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some((c) => c.trim() !== '')) out.push(row)
      row = []
    } else cur += ch
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((c) => c.trim() !== '')) out.push(row) }
  return out
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? '').replace(/[,\s원]/g, ''))
  return Number.isFinite(n) ? n : 0
}

export function parseOnePSalesCsv(text: string): { rows: OnePSalesRow[]; error?: string } {
  const aoa = parseCsv(text.replace(/^﻿/, ''))
  if (!aoa.length) return { rows: [], error: '빈 파일입니다' }
  const h = aoa[0].map((c) => c.replace(/\s+/g, ''))
  const idx = (...names: string[]) => h.findIndex((c) => names.includes(c))
  const cOpt = idx('벤더아이템ID')
  const cName = idx('벤더아이템명')
  const cProd = idx('상품ID')
  const cGmv = idx('매출액(GMV)', '매출액')
  const cOrd = idx('주문건수')
  const cQty = idx('판매수량')
  const miss = [['벤더아이템 ID', cOpt], ['매출액(GMV)', cGmv], ['판매 수량', cQty]].filter(([, i]) => i === -1).map(([n]) => n)
  if (miss.length) return { rows: [], error: `필수 열 없음: ${miss.join(', ')}` }
  const rows: OnePSalesRow[] = []
  for (const r of aoa.slice(1)) {
    const optionId = String(r[cOpt] ?? '').trim()
    if (!/^\d+$/.test(optionId)) continue
    rows.push({
      optionId,
      name: String(r[cName] ?? '').trim(),
      productId: cProd >= 0 ? String(r[cProd] ?? '').trim() : '',
      gmv: num(r[cGmv]),
      orders: cOrd >= 0 ? num(r[cOrd]) : 0,
      qty: num(r[cQty]),
    })
  }
  return { rows }
}
