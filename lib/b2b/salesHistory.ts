/**
 * B2B 세일즈 대시보드 — '발주 이력' 탭 집계 (순수 함수, 조회 전용).
 *
 * 시트 행은 lib/b2b/history.ts 의 HISTORY_HEADERS 순서로 내려온다.
 * 집계 기준일은 **입고예정일**이다(업로드일시가 아님 — 언제 저장했는지가 아니라
 * 언제 나가는 물량인지가 매출 귀속 기준).
 *
 * 쓰기는 하지 않는다. 발주 변환·팔레트·운임 로직은 건드리지 않는다.
 */
import { fmtDate, toNum } from './kurly'

export type SalesChannel = '쿠팡' | '컬리'
export type ChannelFilter = '전체' | SalesChannel

export const CHANNELS: SalesChannel[] = ['쿠팡', '컬리']
// 채널 아이덴티티 색 — 쿠팡 빨강, 컬리 보라 (차트·범례·비중바·카드 공통)
export const CHANNEL_COLORS: Record<SalesChannel, string> = {
  쿠팡: '#E5432E',
  컬리: '#5F0080',
}
/** 카드 상단 보더 등 옅게 쓰는 보조 색 */
export const CHANNEL_COLORS_SOFT: Record<SalesChannel, string> = {
  쿠팡: '#FBE9E6',
  컬리: '#F0E6F5',
}

export type SalesRecord = {
  uploadedAt: string
  channel: string
  poNumber: string
  center: string
  dueDate: string // YYYY-MM-DD
  month: string // YYYY-MM (입고예정일 기준, 비면 '')
  product: string
  shipFrom: string
  boxes: number
  units: number
  revenue: number // 부가포함매출
}

const COL = {
  uploadedAt: 0,
  channel: 1,
  poNumber: 2,
  center: 3,
  dueDate: 4,
  product: 5,
  shipFrom: 6,
  boxes: 7,
  units: 8,
  revenue: 9,
} as const

const str = (r: unknown[], i: number): string => String(r[i] ?? '').trim()

/** 이력 rows(헤더 제외) → 레코드. 발주번호·상품이 모두 비면 빈 행으로 보고 버린다 */
export function parseSalesHistory(rows: unknown[][]): SalesRecord[] {
  const out: SalesRecord[] = []
  for (const r of rows || []) {
    if (!r) continue
    const poNumber = str(r, COL.poNumber)
    const product = str(r, COL.product)
    if (!poNumber && !product) continue
    const dueDate = fmtDate(r[COL.dueDate])
    out.push({
      uploadedAt: str(r, COL.uploadedAt),
      channel: str(r, COL.channel),
      poNumber,
      center: str(r, COL.center),
      dueDate,
      month: dueDate.slice(0, 7),
      product,
      shipFrom: str(r, COL.shipFrom),
      boxes: toNum(r[COL.boxes]),
      units: toNum(r[COL.units]),
      revenue: toNum(r[COL.revenue]),
    })
  }
  return out
}

/** 데이터가 있는 월만 내림차순 (입고예정일 없는 행은 제외) */
export function listMonths(recs: SalesRecord[]): string[] {
  return [...new Set(recs.map((r) => r.month).filter(Boolean))].sort((a, b) => b.localeCompare(a))
}

/** 'YYYY-MM' 한 달 앞 */
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return ''
  const d = m === 1 ? [y - 1, 12] : [y, m - 1]
  return `${d[0]}-${String(d[1]).padStart(2, '0')}`
}

export const byChannel = (recs: SalesRecord[], ch: ChannelFilter): SalesRecord[] =>
  ch === '전체' ? recs : recs.filter((r) => r.channel === ch)

export const byMonth = (recs: SalesRecord[], month: string): SalesRecord[] =>
  month ? recs.filter((r) => r.month === month) : recs

const sum = (recs: SalesRecord[], pick: (r: SalesRecord) => number): number =>
  recs.reduce((a, r) => a + pick(r), 0)

/** 발주 건수 = 발주번호 distinct (같은 발주의 여러 상품 행은 1건) */
export const poCount = (recs: SalesRecord[]): number =>
  new Set(recs.map((r) => r.poNumber).filter(Boolean)).size

export type SalesKpi = {
  revenue: number
  poCount: number
  poByChannel: { channel: SalesChannel; count: number }[]
  boxes: number
  units: number
  avgPerPo: number
  prevRevenue: number | null // 전월 데이터가 없으면 null → 증감 미표시
  momPct: number | null
}

/**
 * KPI — scoped 는 채널·월 필터가 모두 적용된 행, channeled 는 채널만 적용된 전체 기간 행.
 * 전월 대비는 같은 채널 필터에서 직전 달과 비교한다.
 */
export function buildKpi(
  scoped: SalesRecord[],
  channeled: SalesRecord[],
  month: string,
): SalesKpi {
  const revenue = sum(scoped, (r) => r.revenue)
  const count = poCount(scoped)
  const prev = month ? byMonth(channeled, prevMonth(month)) : []
  const prevRevenue = prev.length ? sum(prev, (r) => r.revenue) : null
  return {
    revenue,
    poCount: count,
    poByChannel: CHANNELS.map((c) => ({
      channel: c,
      count: poCount(scoped.filter((r) => r.channel === c)),
    })).filter((c) => c.count > 0),
    boxes: sum(scoped, (r) => r.boxes),
    units: sum(scoped, (r) => r.units),
    avgPerPo: count > 0 ? Math.round(revenue / count) : 0,
    prevRevenue,
    momPct:
      prevRevenue === null || prevRevenue === 0
        ? null
        : Math.round(((revenue - prevRevenue) / prevRevenue) * 1000) / 10,
  }
}

export type ChannelStat = {
  channel: SalesChannel
  revenue: number
  poCount: number
  sharePct: number // 선택 월 총매출 대비 비중
  prevRevenue: number | null
  momPct: number | null
}

/**
 * 채널별 KPI 카드용 집계 — scoped(채널·월 필터 적용) 기준이라
 * 채널 카드 매출의 합은 항상 총매출 카드와 일치한다.
 * 전월 대비는 같은 채널의 직전 달과 비교한다.
 */
export function channelStats(
  scoped: SalesRecord[],
  channeled: SalesRecord[],
  month: string,
): ChannelStat[] {
  const total = sum(scoped, (r) => r.revenue)
  const prevRows = month ? byMonth(channeled, prevMonth(month)) : []
  return CHANNELS.map((c) => {
    const cur = scoped.filter((r) => r.channel === c)
    const prev = prevRows.filter((r) => r.channel === c)
    const revenue = sum(cur, (r) => r.revenue)
    const prevRevenue = prev.length ? sum(prev, (r) => r.revenue) : null
    return {
      channel: c,
      revenue,
      poCount: poCount(cur),
      sharePct: total > 0 ? Math.round((revenue / total) * 1000) / 10 : 0,
      prevRevenue,
      momPct:
        prevRevenue === null || prevRevenue === 0
          ? null
          : Math.round(((revenue - prevRevenue) / prevRevenue) * 1000) / 10,
    }
  })
}

/** 선택 월을 끝으로 하는 최근 n개월 라벨 (데이터가 없는 달도 0으로 채운다) */
export function recentMonths(month: string, n = 6): string[] {
  if (!month) return []
  const out = [month]
  for (let i = 1; i < n; i++) out.unshift(prevMonth(out[0]))
  return out.filter(Boolean)
}

export type TrendPoint = { month: string; 쿠팡: number; 컬리: number }

/** 월별 매출 추이 — 채널 필터와 무관하게 항상 양채널을 쌓는다 */
export function monthlyTrend(all: SalesRecord[], months: string[]): TrendPoint[] {
  return months.map((m) => {
    const rows = all.filter((r) => r.month === m)
    return {
      month: m,
      쿠팡: sum(rows.filter((r) => r.channel === '쿠팡'), (r) => r.revenue),
      컬리: sum(rows.filter((r) => r.channel === '컬리'), (r) => r.revenue),
    }
  })
}

export type RankRow = { name: string; revenue: number; boxes: number; units: number }

/** 키별 매출 순위 (내림차순, 상위 n개) */
export function rankBy(
  recs: SalesRecord[],
  pick: (r: SalesRecord) => string,
  n: number,
): RankRow[] {
  const map = new Map<string, RankRow>()
  for (const r of recs) {
    const name = pick(r) || '(미지정)'
    let e = map.get(name)
    if (!e) {
      e = { name, revenue: 0, boxes: 0, units: 0 }
      map.set(name, e)
    }
    e.revenue += r.revenue
    e.boxes += r.boxes
    e.units += r.units
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, n)
}

export type ProductOption = { key: string; channel: string; product: string; label: string }

/** 채널×상품 키 구분자 — 상품명·채널명에 나올 수 없는 제어문자 */
const PRODUCT_SEP = '\u0001'
export const productKey = (channel: string, product: string): string =>
  `${channel}${PRODUCT_SEP}${product}`

/** 트렌드 드롭다운 채널 묶음 순서 — 컬리 먼저, 그다음 쿠팡, 나머지는 뒤 */
const PRODUCT_CHANNEL_ORDER: string[] = ['컬리', '쿠팡']
const channelRank = (c: string): number => {
  const i = PRODUCT_CHANNEL_ORDER.indexOf(c)
  return i === -1 ? PRODUCT_CHANNEL_ORDER.length : i
}

/**
 * 발주 이력에 등장한 채널×상품 조합 — 채널 묶음(컬리→쿠팡) 안에서 상품명 오름차순.
 * 양채널 판매 상품은 채널별로 각각 항목이 생긴다.
 */
export function listProductOptions(recs: SalesRecord[]): ProductOption[] {
  const map = new Map<string, ProductOption>()
  for (const r of recs) {
    if (!r.product) continue
    const key = productKey(r.channel, r.product)
    if (!map.has(key)) {
      map.set(key, {
        key,
        channel: r.channel,
        product: r.product,
        label: `${r.channel} · ${r.product}`,
      })
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      channelRank(a.channel) - channelRank(b.channel) ||
      a.channel.localeCompare(b.channel, 'ko') ||
      a.product.localeCompare(b.product, 'ko'),
  )
}

/** 채널×상품 필터 — 빈 문자열이면 전체 */
export const byProductKey = (recs: SalesRecord[], key: string): SalesRecord[] => {
  if (!key) return recs
  const [channel, product] = key.split(PRODUCT_SEP)
  return recs.filter((r) => r.channel === channel && r.product === product)
}

export type ProductPoint = { month: string; revenue: number; boxes: number; units: number }

/**
 * 채널×상품별 월별 매출 — key 가 비면 전체 상품 합계.
 * 채널·월 필터와 무관하게 전체 이력에서 집계한다(상품 트렌드 섹션 전용).
 */
export function productTrend(
  all: SalesRecord[],
  months: string[],
  key: string,
): ProductPoint[] {
  const rows = byProductKey(all, key)
  return months.map((m) => {
    const mr = rows.filter((r) => r.month === m)
    return {
      month: m,
      revenue: sum(mr, (r) => r.revenue),
      boxes: sum(mr, (r) => r.boxes),
      units: sum(mr, (r) => r.units),
    }
  })
}

/** 표 정렬 — 입고예정일 내림차순, 같으면 발주번호 */
export const sortForTable = (recs: SalesRecord[]): SalesRecord[] =>
  [...recs].sort((a, b) =>
    a.dueDate === b.dueDate ? b.poNumber.localeCompare(a.poNumber) : b.dueDate.localeCompare(a.dueDate),
  )

/** 'YYYY-MM' → '2026년 6월' */
export const monthLabel = (m: string): string => {
  const [y, mm] = m.split('-')
  return y && mm ? `${y}년 ${Number(mm)}월` : m
}

/** 차트 x축용 짧은 라벨 '6월' */
export const shortMonth = (m: string): string => `${Number(m.split('-')[1] ?? 0)}월`
