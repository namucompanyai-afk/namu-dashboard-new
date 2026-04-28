import * as XLSX from 'xlsx'

/**
 * 광고 캠페인 엑셀 (pa_total_campaign_YYYYMMDD_YYYYMMDD.xlsx) 파서
 *
 * 쿠팡 광고센터 → 리포트 → 캠페인별 성과 다운로드.
 * 파일명 포맷 예: "A00993784_pa_total_campaign_20260324_20260423.xlsx"
 *
 * 핵심 결정:
 *   1) 기간은 파일명에서 추출 — 엑셀 내부에 기간 정보가 없기 때문.
 *      파일명 규칙이 바뀌면 UI에서 수동 입력 받음 (fallback).
 *   2) 지표는 "14일 총" 기준 사용 — 쿠팡 공식 전환 기준이며 어트리뷰션 완결.
 *      1일 기준은 더 보수적이지만 주문이 다음날 확정되는 경우 빠져서 과소 집계됨.
 *   3) 행은 "광고집행 옵션ID × 지면 × 키워드" 조합으로 쪼개져 있음.
 *      진단 페이지에선 옵션ID 기준으로만 쓰므로 매칭 쉽게 하기 위해 행 단위 그대로 반환,
 *      집계는 호출측에서.
 *
 * 주의:
 *   - "광고집행 옵션ID"와 "광고전환매출발생 옵션ID"가 다를 수 있음 (교차 판매).
 *   - 우선은 "광고집행 옵션ID" 기준으로 귀속 — 광고비 주인이 누구인가에 더 관심.
 *   - 비검색 영역 행에는 "키워드"가 "-" 로 들어옴.
 */

function normHeader(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

function toStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function toNum(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const cleaned = String(v).replace(/[,\s원%]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

/** 헤더명 → 필드 매핑. 공백/대소문자 무시 정규화 후 비교. */
const COLUMN_ALIASES = {
  campaignId:       ['캠페인id', 'campaignid'],
  campaignName:     ['캠페인명', 'campaignname'],
  adGroup:          ['광고그룹', 'adgroup'],
  adOptionId:       ['광고집행옵션id', '집행옵션id'],
  convOptionId:     ['광고전환매출발생옵션id', '전환옵션id'],
  placement:        ['광고노출지면', '노출지면', '지면'],
  keyword:          ['키워드', 'keyword'],
  impressions:      ['노출수', 'impressions'],
  clicks:           ['클릭수', 'clicks'],
  adCost:           ['광고비', 'cost'],
  orders14d:        ['총주문수(14일)', '총주문수14일', 'orders14d'],
  sold14d:          ['총판매수량(14일)', '총판매수량14일', 'sold14d'],
  revenue14d:       ['총전환매출액(14일)', '총전환매출액14일', 'revenue14d'],
  directRevenue14d: ['직접전환매출액(14일)', '직접전환매출액14일'],
  indirectRevenue14d:['간접전환매출액(14일)', '간접전환매출액14일'],
  convProductName:  ['광고전환매출발생상품명', '전환매출발생상품명', '전환상품명'],
  adProductName:    ['광고집행상품명', '집행상품명'],
} as const

type AliasKey = keyof typeof COLUMN_ALIASES

export interface AdCampaignRow {
  campaignId: string
  campaignName: string
  adGroup: string
  /** 광고집행 옵션ID — 광고비가 이 옵션에 귀속됨 */
  adOptionId: string
  /** 광고전환매출발생 옵션ID — 실제로 팔린 옵션 (교차판매 시 다를 수 있음) */
  convOptionId: string
  /** 광고 노출 지면 (예: "검색 영역", "비검색 영역") */
  placement: string
  /** 키워드 (비검색 영역이면 "-") */
  keyword: string
  impressions: number
  clicks: number
  /** 광고비 (원, VAT 미포함 — 쿠팡 광고비는 VAT별도 청구) */
  adCost: number
  /** 14일 전환 기준 총 주문수 */
  orders14d: number
  sold14d: number
  /** 14일 전환 기준 총 매출 (원) — 판매가 기준이라 무프/쿠폰 반영 안 됨 */
  revenue14d: number
  directRevenue14d: number
  indirectRevenue14d: number
  /** 광고전환매출발생 상품명 (없으면 광고집행 상품명). 포맷: "상품명,옵션,옵션,..." */
  convProductName: string
  adProductName: string
}

export interface AdCampaignParseResult {
  rows: AdCampaignRow[]
  /** 파일명에서 추출한 시작일 (YYYY-MM-DD). 추출 실패 시 null. */
  startDate: string | null
  /** 파일명에서 추출한 종료일 (YYYY-MM-DD). 추출 실패 시 null. */
  endDate: string | null
  /** 기간 일수 (종료일 - 시작일 + 1). 추출 실패 시 null. */
  periodDays: number | null
  missingColumns: string[]
  /** 읽은 행 수 (반환된 rows 길이와 같음, 필터 전 원본 수) */
  totalRows: number
  skippedRows: number
}

/**
 * 파일명에서 기간 추출.
 * "A00993784_pa_total_campaign_20260324_20260423.xlsx" → ["2026-03-24", "2026-04-23"]
 * 파일명 규칙이 달라지면 null 반환 (호출측에서 수동 입력 유도).
 */
export function extractPeriodFromFileName(
  fileName: string,
): { startDate: string; endDate: string; periodDays: number } | null {
  const m = fileName.match(/(\d{8})[_-](\d{8})/)
  if (!m) return null

  const parse = (yyyymmdd: string): string | null => {
    if (yyyymmdd.length !== 8) return null
    const y = parseInt(yyyymmdd.slice(0, 4), 10)
    const mo = parseInt(yyyymmdd.slice(4, 6), 10)
    const d = parseInt(yyyymmdd.slice(6, 8), 10)
    if (!(y >= 2020 && y <= 2100)) return null
    if (!(mo >= 1 && mo <= 12)) return null
    if (!(d >= 1 && d <= 31)) return null
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  const startDate = parse(m[1])
  const endDate = parse(m[2])
  if (!startDate || !endDate) return null

  const msPerDay = 86400000
  const diff = (new Date(endDate).getTime() - new Date(startDate).getTime()) / msPerDay
  if (!Number.isFinite(diff) || diff < 0) return null
  const periodDays = Math.round(diff) + 1 // 종료일 포함

  return { startDate, endDate, periodDays }
}

/** 헤더 행 찾기 — "캠페인ID" 또는 "광고비" 포함 첫 행 */
function findHeaderRow(aoa: unknown[][]): number {
  const campaignAliases: readonly string[] = COLUMN_ALIASES.campaignId
  const costAliases: readonly string[] = COLUMN_ALIASES.adCost
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const normed = row.map((c) => normHeader(toStr(c)))
    const hasCampaign = normed.some((h) => campaignAliases.includes(h))
    const hasCost = normed.some((h) => costAliases.includes(h))
    if (hasCampaign && hasCost) return i
  }
  return -1
}

/** 컬럼 인덱스 매핑 */
function resolveColumns(
  headers: string[],
): { cols: Record<AliasKey, number>; missing: string[] } {
  const normed = headers.map((h) => normHeader(toStr(h)))
  const cols = {} as Record<AliasKey, number>
  const missing: string[] = []

  const required: AliasKey[] = [
    'campaignId', 'adOptionId', 'adCost', 'revenue14d',
  ]

  for (const key of Object.keys(COLUMN_ALIASES) as AliasKey[]) {
    const aliases = COLUMN_ALIASES[key] as readonly string[]
    const idx = normed.findIndex((h) => aliases.includes(h))
    cols[key] = idx
    if (idx === -1 && required.includes(key)) {
      missing.push(key)
    }
  }
  return { cols, missing }
}

/**
 * 파서 메인
 * @param buffer xlsx 파일의 ArrayBuffer
 * @param fileName 기간 추출용 파일명 (선택)
 */
export function parseAdCampaign(
  buffer: ArrayBuffer,
  fileName?: string,
): AdCampaignParseResult {
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) {
    return {
      rows: [], startDate: null, endDate: null, periodDays: null,
      missingColumns: ['시트를 찾지 못했습니다'], totalRows: 0, skippedRows: 0,
    }
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1, blankrows: false,
  })

  const headerIdx = findHeaderRow(aoa)
  if (headerIdx === -1) {
    return {
      rows: [], startDate: null, endDate: null, periodDays: null,
      missingColumns: ['헤더 행을 찾지 못했습니다 (캠페인ID + 광고비 필요)'],
      totalRows: 0, skippedRows: 0,
    }
  }

  const headers = (aoa[headerIdx] as unknown[]).map(toStr)
  const { cols, missing } = resolveColumns(headers)
  if (missing.length > 0) {
    return {
      rows: [], startDate: null, endDate: null, periodDays: null,
      missingColumns: missing, totalRows: 0, skippedRows: 0,
    }
  }

  const period = fileName ? extractPeriodFromFileName(fileName) : null

  const rows: AdCampaignRow[] = []
  let skipped = 0

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    const campaignId = toStr(r[cols.campaignId])
    if (!campaignId) {
      skipped++
      continue
    }

    rows.push({
      campaignId,
      campaignName: toStr(r[cols.campaignName]),
      adGroup: toStr(r[cols.adGroup]),
      adOptionId: toStr(r[cols.adOptionId]),
      convOptionId: toStr(r[cols.convOptionId]),
      placement: toStr(r[cols.placement]),
      keyword: toStr(r[cols.keyword]),
      impressions: toNum(r[cols.impressions]),
      clicks: toNum(r[cols.clicks]),
      adCost: toNum(r[cols.adCost]),
      orders14d: toNum(r[cols.orders14d]),
      sold14d: toNum(r[cols.sold14d]),
      revenue14d: toNum(r[cols.revenue14d]),
      directRevenue14d: toNum(r[cols.directRevenue14d]),
      indirectRevenue14d: toNum(r[cols.indirectRevenue14d]),
      convProductName: toStr(r[cols.convProductName]),
      adProductName: toStr(r[cols.adProductName]),
    })
  }

  return {
    rows,
    startDate: period?.startDate ?? null,
    endDate: period?.endDate ?? null,
    periodDays: period?.periodDays ?? null,
    missingColumns: [],
    totalRows: rows.length + skipped,
    skippedRows: skipped,
  }
}
