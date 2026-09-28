/**
 * 광고 행(키워드 포함) 압축 저장 형식 — 쿠팡 손익 월 저장본(pnl_adkw_YYYY-MM)용.
 *
 * 행마다 반복되는 열 이름을 없애고(열 배열), 글자 열(캠페인명·상품명·키워드 등)은
 * 이름 사전 s 의 번호로 바꾼다. 숫자 열은 값 그대로 → 복원하면 원래 광고 행과 같다.
 * 9월 원본 8,119행 기준 약 1MB (JSON 4.2MB → 요청 한도 4.5MB 여유).
 */
import type { AdCampaignRow } from './parsers/adCampaign'

const STR_COLS = [
  'campaignId', 'campaignName', 'adGroup', 'adOptionId', 'convOptionId', 'placement', 'keyword',
  'convProductName', 'adProductName', 'saleMethod',
] as const
const NUM_COLS = [
  'impressions', 'clicks', 'adCost', 'orders14d', 'sold14d', 'revenue14d', 'directRevenue14d', 'indirectRevenue14d',
] as const

export interface PackedAdRows {
  v: 1
  cols: string[]
  /** 이름 사전 */
  s: string[]
  /** 행: cols 순서 — 글자 열은 s 번호, 숫자 열은 값 */
  r: number[][]
}

export function packAdRows(rows: AdCampaignRow[]): PackedAdRows {
  const s: string[] = []
  const idx = new Map<string, number>()
  const id = (v: unknown) => {
    const k = v == null ? '' : String(v)
    let i = idx.get(k)
    if (i == null) { i = s.length; s.push(k); idx.set(k, i) }
    return i
  }
  const r = rows.map((row) => {
    const x = row as unknown as Record<string, unknown>
    return [...STR_COLS.map((c) => id(x[c])), ...NUM_COLS.map((c) => Number(x[c]) || 0)]
  })
  return { v: 1, cols: [...STR_COLS, ...NUM_COLS], s, r }
}

export function unpackAdRows(p: PackedAdRows | null | undefined): AdCampaignRow[] {
  if (!p || p.v !== 1 || !Array.isArray(p.r)) return []
  const nStr = STR_COLS.length
  return p.r.map((a) => {
    const o: Record<string, unknown> = {}
    p.cols.forEach((c, i) => { o[c] = i < nStr ? (p.s[a[i]] ?? '') : a[i] })
    return o as unknown as AdCampaignRow
  })
}
