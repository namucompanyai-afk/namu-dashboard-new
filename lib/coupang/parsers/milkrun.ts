/**
 * 쿠팡 밀크런 파서 — 서플라이어 허브에서 받는 .xls 는 실제로 HTML 표.
 *   - 밀크런 정산 (milkrun_sales_YYYY-MM.xls): 밀크런 번호 · 센터 · 픽업일 · 총 합계 금액
 *   - 밀크런 접수 내역 (milkrun_list_*.xls): 상태 · 밀크런번호 · 박스수 · 출고지 · 발주번호(" / " 로 여러 개)
 */

export interface MilkrunSettleRow {
  milkrunNo: string
  center: string
  pickupDate: string
  /** 총 합계 금액 (부가포함) */
  amount: number
}

export interface MilkrunListRow {
  milkrunNo: string
  status: string
  boxes: number
  shipFrom: string
  poNumbers: string[]
}

function htmlRows(html: string): string[][] {
  const decode = (s: string) =>
    s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
  const out: string[][] = []
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(decode)
    if (cells.length) out.push(cells)
  }
  return out
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? '').replace(/[,\s원]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function table(html: string, must: string[]): { header: string[]; body: string[][] } | null {
  const rows = htmlRows(html)
  const hi = rows.findIndex((r) => must.every((m) => r.some((c) => c.replace(/\s+/g, '') === m)))
  if (hi < 0) return null
  return { header: rows[hi].map((c) => c.replace(/\s+/g, '')), body: rows.slice(hi + 1) }
}

/** total = 표 행 합계 · headerTotal = 파일 상단 '총 금액' (표 행 일부만 포함할 수 있음 — 다르면 화면에 둘 다 표시) */
export function parseMilkrunSettlement(html: string): { rows: MilkrunSettleRow[]; total: number; headerTotal: number | null; error?: string } {
  const t = table(html, ['밀크런번호', '총합계금액'])
  if (!t) return { rows: [], total: 0, headerTotal: null, error: '밀크런 정산 표(밀크런 번호·총 합계 금액)를 찾지 못했습니다' }
  const top = htmlRows(html).find((r) => r.some((c) => c.replace(/\s+/g, '') === '총금액'))
  const headerTotal = top ? num(top[top.findIndex((c) => c.replace(/\s+/g, '') === '총금액') + 1]) : null
  const c = (n: string) => t.header.indexOf(n)
  const rows = t.body
    .filter((r) => /^\d+$/.test(String(r[c('밀크런번호')] ?? '').trim()))
    .map((r) => ({
      milkrunNo: r[c('밀크런번호')].trim(),
      center: String(r[c('센터')] ?? '').trim(),
      pickupDate: String(r[c('픽업일')] ?? '').trim(),
      amount: num(r[c('총합계금액')]),
    }))
  return { rows, total: rows.reduce((s, r) => s + r.amount, 0), headerTotal }
}

export function parseMilkrunList(html: string, onlyNormal = false): { rows: MilkrunListRow[]; error?: string } {
  const t = table(html, ['밀크런번호', '발주번호'])
  if (!t) return { rows: [], error: '밀크런 접수 내역 표(밀크런번호·발주번호)를 찾지 못했습니다' }
  const c = (n: string) => t.header.indexOf(n)
  const rows = t.body
    .filter((r) => /^\d+$/.test(String(r[c('밀크런번호')] ?? '').trim()))
    .map((r) => ({
      milkrunNo: r[c('밀크런번호')].trim(),
      status: String(r[c('상태')] ?? '').trim(),
      boxes: num(r[c('박스수')]),
      shipFrom: String(r[c('출고지')] ?? '').trim(),
      poNumbers: String(r[c('발주번호')] ?? '').split('/').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)),
    }))
    .filter((r) => !onlyNormal || r.status === '정상')
  return { rows }
}
