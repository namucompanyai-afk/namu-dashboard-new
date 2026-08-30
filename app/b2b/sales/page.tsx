'use client'

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  CHANNELS,
  CHANNEL_COLORS,
  CHANNEL_COLORS_SOFT,
  buildKpi,
  byChannel,
  byMonth,
  byProduct,
  channelStats,
  listMonths,
  listProducts,
  monthLabel,
  monthlyTrend,
  parseSalesHistory,
  productTrend,
  rankBy,
  recentMonths,
  shortMonth,
  sortForTable,
  type ChannelFilter,
  type ChannelStat,
  type ProductPoint,
  type RankRow,
  type SalesChannel,
  type SalesRecord,
  type TrendPoint,
} from '@/lib/b2b/salesHistory'

/**
 * B2B 세일즈 대시보드 — 구글시트 '발주 이력' 조회 전용.
 *
 * 발주 변환 화면(컬리·쿠팡)이 저장한 이력을 입고예정일 기준으로 집계한다.
 * 이 페이지는 시트에 쓰지 않는다 — GET /api/b2b/history 만 호출한다.
 */

const num = (n: number) => n.toLocaleString('ko-KR')
const won = (n: number) => `${num(n)}원`
// recharts 포매터는 ValueType/ReactNode 를 넘겨서 number·string 을 보장하지 않는다
const wonTip = (v: unknown) => won(Number(v) || 0)
const numTick = (v: unknown) => num(Number(v) || 0)
const monthTip = (v: unknown) => monthLabel(String(v ?? ''))
type LoadState = 'loading' | 'loaded' | 'error'

// 차트 클릭 시 파란 박스/포커스 outline 제거 (기존 공통 규칙)
const NOSEL =
  'focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none'

function ChartBox({ children, height = 260 }: { children: ReactElement; height?: number }) {
  return (
    <div tabIndex={-1} className={NOSEL} style={{ outline: 'none', height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  )
}

const CHANNEL_FILTERS: ChannelFilter[] = ['전체', '쿠팡', '컬리']
type TopScope = 'month' | 'all'
const TOP_SCOPES: { key: TopScope; label: string }[] = [
  { key: 'month', label: '이번 달' },
  { key: 'all', label: '누적' },
]
const PAGE_SIZE = 50

export default function B2BSalesPage() {
  const [records, setRecords] = useState<SalesRecord[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')

  const [channel, setChannel] = useState<ChannelFilter>('전체')
  const [month, setMonth] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [topScope, setTopScope] = useState<TopScope>('month')
  // 상품별 트렌드 — 월·채널 필터와 독립 (빈 문자열 = 전체 상품 합계)
  const [product, setProduct] = useState('')
  const [productLimit, setProductLimit] = useState(PAGE_SIZE)

  const load = useCallback(async () => {
    setState('loading')
    setError('')
    try {
      const res = await fetch('/api/b2b/history', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setRecords(parseSalesHistory(json.rows || []))
      setState('loaded')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const months = useMemo(() => listMonths(records), [records])
  // 최신 월을 기본 선택 (데이터가 바뀌어 선택 월이 사라지면 최신 월로 되돌린다)
  useEffect(() => {
    if (months.length && !months.includes(month)) setMonth(months[0])
  }, [months, month])

  const channeled = useMemo(() => byChannel(records, channel), [records, channel])
  const scoped = useMemo(() => byMonth(channeled, month), [channeled, month])
  const kpi = useMemo(() => buildKpi(scoped, channeled, month), [scoped, channeled, month])
  const chStats = useMemo(() => channelStats(scoped, channeled, month), [scoped, channeled, month])

  const trend = useMemo(() => monthlyTrend(records, recentMonths(month, 6)), [records, month])
  // 이번 달 = 선택된 입고예정월, 누적 = 전체 이력(채널 필터는 그대로 적용)
  const topProducts = useMemo(
    () => rankBy(topScope === 'month' ? scoped : channeled, (r) => r.product, 5),
    [scoped, channeled, topScope],
  )
  const topCenters = useMemo(() => rankBy(scoped, (r) => r.center, 8), [scoped])
  const tableRows = useMemo(() => sortForTable(scoped), [scoped])

  // 상품 트렌드는 항상 '데이터가 있는 최신 월' 기준 최근 6개월 (월 필터와 무관)
  const productList = useMemo(() => listProducts(records), [records])
  const trendMonths = useMemo(() => recentMonths(months[0] || '', 6), [months])
  const productSeries = useMemo(
    () => productTrend(records, trendMonths, product),
    [records, trendMonths, product],
  )
  const productRows = useMemo(
    () => sortForTable(byProduct(records, product).filter((r) => trendMonths.includes(r.month))),
    [records, product, trendMonths],
  )

  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [channel, month])

  useEffect(() => {
    setProductLimit(PAGE_SIZE)
  }, [product])

  const empty = state === 'loaded' && records.length === 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">B2B 세일즈</h1>
          <p className="text-sm text-gray-500 mt-1">
            발주 이력(구글시트) 조회 전용 · 집계 기준일은 입고예정일
          </p>
        </div>
        <button
          onClick={load}
          disabled={state === 'loading'}
          className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200"
        >
          {state === 'loading' ? '불러오는 중…' : '새로고침'}
        </button>
      </div>

      {state === 'error' && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">
          발주 이력을 불러오지 못했습니다: {error}
        </div>
      )}

      {empty ? (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-16 text-center text-sm text-gray-400">
          저장된 발주 이력이 없습니다.
        </div>
      ) : state === 'loading' ? (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-16 text-center text-sm text-gray-400">
          ⏳ 불러오는 중…
        </div>
      ) : state === 'loaded' ? (
        <>
          {/* 필터 바 */}
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-1">
              {CHANNEL_FILTERS.map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  className={
                    'px-3 py-1.5 rounded-md text-xs transition-colors ' +
                    (channel === c
                      ? 'bg-gray-900 text-white'
                      : 'border border-gray-300 text-gray-600 hover:bg-gray-50')
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            <label className="text-xs text-gray-600 flex items-center gap-2">
              입고예정월
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded text-xs"
              >
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-gray-400">
              전체 이력 {num(records.length)}행 · 필터 결과 {num(scoped.length)}행
            </span>
          </div>

          {/* KPI — 총매출 + 채널별 2장 (채널 카드 합 = 총매출) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">{monthLabel(month)} 총매출</p>
              <p className="text-2xl font-semibold mt-1">{won(kpi.revenue)}</p>
              <p className="text-[11px] mt-1">
                {kpi.momPct === null ? (
                  <span className="text-gray-400">전월 데이터 없음</span>
                ) : (
                  <span className={kpi.momPct >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                    전월 대비 {kpi.momPct >= 0 ? '+' : ''}
                    {kpi.momPct}%
                  </span>
                )}
              </p>
            </div>
            {chStats.map((c) => (
              <ChannelCard key={c.channel} stat={c} />
            ))}
          </div>

          {/* 월별 매출 추이 — 채널별로 분리(각자 y축 스케일), 채널 필터와 무관 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {CHANNELS.map((c) => (
              <TrendChart key={c} channel={c} data={trend} />
            ))}
          </div>

          {/* 월별 채널 비중 — 바에 호버하면 채널별 매출액 (overflow-hidden 을 빼야 툴팁이 안 잘린다) */}
          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">월별 채널 비중 (최근 6개월)</h2>
              <span className="text-xs text-gray-500">
                {CHANNELS.map((c) => (
                  <span key={c} className="ml-3 inline-flex items-center gap-1">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm"
                      style={{ background: CHANNEL_COLORS[c] }}
                    />
                    {c}
                  </span>
                ))}
              </span>
            </div>
            <div className="p-4 space-y-3">
              {trend.map((t) => {
                const total = t.쿠팡 + t.컬리
                return (
                  <div key={t.month} className="flex items-center gap-3">
                    <span className="w-14 shrink-0 text-xs text-gray-500">{shortMonth(t.month)}</span>
                    <div className="group relative flex-1">
                      <div className="h-4 rounded-sm bg-gray-100 overflow-hidden flex">
                        {total > 0 &&
                          CHANNELS.map((c) => (
                            <div
                              key={c}
                              style={{
                                width: `${(t[c] / total) * 100}%`,
                                background: CHANNEL_COLORS[c],
                              }}
                            />
                          ))}
                      </div>
                      <div className="pointer-events-none absolute left-1/2 bottom-full z-20 hidden -translate-x-1/2 -translate-y-1 whitespace-nowrap rounded-md border border-gray-200 bg-white px-3 py-2 shadow-lg group-hover:block">
                        <p className="text-[11px] font-medium text-gray-900">
                          {monthLabel(t.month)}
                        </p>
                        {total > 0 ? (
                          <>
                            {CHANNELS.map((c) => (
                              <p
                                key={c}
                                className="mt-0.5 text-[11px] tabular-nums flex items-center gap-1.5"
                              >
                                <span
                                  className="inline-block w-2 h-2 rounded-sm shrink-0"
                                  style={{ background: CHANNEL_COLORS[c] }}
                                />
                                <span className="text-gray-500">{c}</span>
                                <span className="text-gray-900">{won(t[c])}</span>
                              </p>
                            ))}
                            <p className="mt-1 pt-1 border-t border-gray-100 text-[11px] tabular-nums text-gray-600">
                              합계 {won(total)}
                            </p>
                          </>
                        ) : (
                          <p className="mt-0.5 text-[11px] text-gray-400">데이터 없음</p>
                        )}
                      </div>
                    </div>
                    <span className="w-32 shrink-0 text-right text-[11px] text-gray-500 tabular-nums">
                      {total > 0
                        ? CHANNELS.map((c) => `${Math.round((t[c] / total) * 100)}%`).join(' · ')
                        : '데이터 없음'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 상품별 매출 트렌드 — 월·채널 필터와 독립, 항상 최근 6개월 */}
          <ProductTrendSection
            products={productList}
            product={product}
            onProduct={setProduct}
            series={productSeries}
            rows={productRows}
            limit={productLimit}
            onMore={() => setProductLimit((n) => n + PAGE_SIZE)}
            months={trendMonths}
          />

          {/* 상품 Top 5 · 센터별 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RankChart
              title="상품별 매출 Top 5"
              rows={topProducts}
              color="#0f766e"
              emptyText="선택한 조건에 해당하는 이력이 없습니다."
              toolbar={
                <div className="flex items-center gap-1">
                  {TOP_SCOPES.map((o) => (
                    <button
                      key={o.key}
                      onClick={() => setTopScope(o.key)}
                      className={
                        'px-2.5 py-1 rounded-md text-[11px] transition-colors ' +
                        (topScope === o.key
                          ? 'bg-gray-900 text-white'
                          : 'border border-gray-300 text-gray-600 hover:bg-gray-50')
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              }
            />
            <RankChart
              title="센터·입고지별 매출"
              rows={topCenters}
              color="#14b8a6"
              emptyText="선택한 조건에 해당하는 이력이 없습니다."
            />
          </div>

          {/* 발주 이력 표 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">발주 이력 ({num(tableRows.length)}행)</h2>
              <span className="text-xs text-gray-500">입고예정일 내림차순</span>
            </div>
            {tableRows.length === 0 ? (
              <p className="px-4 py-10 text-sm text-gray-400 text-center">
                선택한 조건({channel} · {monthLabel(month)})에 해당하는 이력이 없습니다.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">발주번호</th>
                        <th className="px-3 py-2 text-left font-medium">채널</th>
                        <th className="px-3 py-2 text-left font-medium">센터·입고지</th>
                        <th className="px-3 py-2 text-left font-medium">입고예정일</th>
                        <th className="px-3 py-2 text-left font-medium">상품</th>
                        <th className="px-3 py-2 text-right font-medium">박스</th>
                        <th className="px-3 py-2 text-right font-medium">낱개</th>
                        <th className="px-3 py-2 text-right font-medium">매출</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.slice(0, limit).map((r, i) => (
                        <tr key={`${r.channel}-${r.poNumber}-${r.product}-${i}`} className="border-t border-gray-100">
                          <td className="px-3 py-2 text-gray-600">{r.poNumber}</td>
                          <td className="px-3 py-2">{r.channel}</td>
                          <td className="px-3 py-2">{r.center}</td>
                          <td className="px-3 py-2 text-gray-600">{r.dueDate}</td>
                          <td className="px-3 py-2 max-w-[22rem] truncate" title={r.product}>
                            {r.product}
                          </td>
                          <td className="px-3 py-2 text-right">{r.boxes ? num(r.boxes) : '—'}</td>
                          <td className="px-3 py-2 text-right">{num(r.units)}</td>
                          <td className="px-3 py-2 text-right font-medium">{num(r.revenue)}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                        <td className="px-3 py-2" colSpan={5}>
                          합계
                        </td>
                        <td className="px-3 py-2 text-right">{num(kpi.boxes)}</td>
                        <td className="px-3 py-2 text-right">{num(kpi.units)}</td>
                        <td className="px-3 py-2 text-right">{won(kpi.revenue)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {tableRows.length > limit && (
                  <div className="px-4 py-3 border-t border-gray-100 text-center">
                    <button
                      onClick={() => setLimit((n) => n + PAGE_SIZE)}
                      className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50"
                    >
                      더보기 ({num(tableRows.length - limit)}행 남음)
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

function ChannelCard({ stat }: { stat: ChannelStat }) {
  const color = CHANNEL_COLORS[stat.channel]
  return (
    <div
      className="rounded-lg border border-gray-200 bg-white px-4 py-3 border-t-4"
      style={{ borderTopColor: color, background: CHANNEL_COLORS_SOFT[stat.channel] + '33' }}
    >
      <p className="text-xs font-medium" style={{ color }}>
        {stat.channel}
      </p>
      <p className="text-2xl font-semibold mt-1">{won(stat.revenue)}</p>
      <p className="text-[11px] mt-1 text-gray-500">
        발주 {num(stat.poCount)}건 · 비중 {stat.sharePct}%
      </p>
      <p className="text-[11px] mt-0.5">
        {stat.momPct === null ? (
          <span className="text-gray-400">전월 데이터 없음</span>
        ) : (
          <span className={stat.momPct >= 0 ? 'text-emerald-600' : 'text-red-600'}>
            전월 대비 {stat.momPct >= 0 ? '+' : ''}
            {stat.momPct}%
          </span>
        )}
      </p>
    </div>
  )
}

/** 채널 1개짜리 꺾은선 — 채널마다 독립 y축이라 저액 채널이 눌리지 않는다 */
function TrendChart({ channel, data }: { channel: SalesChannel; data: TrendPoint[] }) {
  const color = CHANNEL_COLORS[channel]
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold" style={{ color }}>
          {channel} 매출 추이
        </h2>
        <span className="text-xs text-gray-500">최근 6개월 · 채널 필터 무관</span>
      </div>
      <div className="p-4">
        <ChartBox height={260}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="month" tickFormatter={shortMonth} tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={numTick} tick={{ fontSize: 11 }} width={80} />
            <Tooltip formatter={wonTip} labelFormatter={monthTip} />
            <Line
              type="monotone"
              dataKey={channel}
              name={channel}
              stroke={color}
              strokeWidth={2}
              dot={{ r: 3, fill: color }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ChartBox>
      </div>
    </div>
  )
}

function RankChart({
  title,
  rows,
  color,
  emptyText,
  toolbar,
}: {
  title: string
  rows: { name: string; revenue: number }[]
  color: string
  emptyText: string
  toolbar?: ReactElement
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {toolbar}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-10 text-sm text-gray-400 text-center">{emptyText}</p>
      ) : (
        <div className="p-4">
          <ChartBox height={Math.max(180, rows.length * 44 + 40)}>
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" tickFormatter={numTick} tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <Tooltip content={rankTooltip} cursor={{ fill: '#f8fafc' }} />
              {/* name 을 주지 않으면 툴팁 계열명이 dataKey('revenue') 그대로 나온다 */}
              <Bar dataKey="revenue" name="매출" fill={color} radius={[0, 4, 4, 0]}>
                {rows.map((r) => (
                  <Cell key={r.name} fill={color} />
                ))}
              </Bar>
            </BarChart>
          </ChartBox>
        </div>
      )}
    </div>
  )
}

/** 수량 병기 '40박스 720낱개' — 박스가 0이면 낱개만 */
const qtyText = (boxes: number, units: number): string =>
  [boxes > 0 ? `${num(boxes)}박스` : '', units > 0 ? `${num(units)}낱개` : '']
    .filter(Boolean)
    .join(' ')

/** 순위 차트 툴팁 — 매출에 박스·낱개 수량을 병기 */
function rankTooltip(props: { active?: boolean; payload?: unknown }) {
  if (!props.active || !Array.isArray(props.payload) || props.payload.length === 0) return null
  const row = (props.payload[0] as { payload?: RankRow }).payload
  if (!row) return null
  const qty = qtyText(row.boxes, row.units)
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-[11px] font-medium text-gray-900">{row.name}</p>
      <p className="mt-0.5 text-[11px] tabular-nums text-gray-600">
        매출 {won(row.revenue)}
        {qty && ` · ${qty}`}
      </p>
    </div>
  )
}

/** 상품 트렌드 툴팁 — 매출 + 수량 */
function productTooltip(props: { active?: boolean; payload?: unknown; label?: unknown }) {
  if (!props.active || !Array.isArray(props.payload) || props.payload.length === 0) return null
  const pt = (props.payload[0] as { payload?: ProductPoint }).payload
  if (!pt) return null
  const qty = qtyText(pt.boxes, pt.units)
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-[11px] font-medium text-gray-900">{monthLabel(pt.month)}</p>
      <p className="mt-0.5 text-[11px] tabular-nums text-gray-600">
        매출 {won(pt.revenue)}
        {qty && ` · ${qty}`}
      </p>
    </div>
  )
}

/**
 * 상품별 매출 트렌드 — 상단 꺾은선(최근 6개월), 하단 해당 상품의 발주 이력.
 * 화면 상단의 채널·입고예정월 필터와 무관하게 전체 이력에서 집계한다.
 */
function ProductTrendSection({
  products,
  product,
  onProduct,
  series,
  rows,
  limit,
  onMore,
  months,
}: {
  products: string[]
  product: string
  onProduct: (p: string) => void
  series: ProductPoint[]
  rows: SalesRecord[]
  limit: number
  onMore: () => void
  months: string[]
}) {
  const label = product || '전체 상품 합계'
  const range =
    months.length > 0 ? `${monthLabel(months[0])} ~ ${monthLabel(months[months.length - 1])}` : ''
  const total = rows.reduce(
    (a, r) => ({
      boxes: a.boxes + r.boxes,
      units: a.units + r.units,
      revenue: a.revenue + r.revenue,
    }),
    { boxes: 0, units: 0, revenue: 0 },
  )
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">상품별 매출 트렌드</h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-600 flex items-center gap-2">
            상품
            <select
              value={product}
              onChange={(e) => onProduct(e.target.value)}
              className="px-2 py-1.5 border border-gray-300 rounded text-xs max-w-[16rem]"
            >
              <option value="">전체 상품 합계</option>
              {products.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-gray-500">최근 6개월 · 채널·월 필터 무관</span>
        </div>
      </div>

      <div className="p-4">
        <p className="text-xs text-gray-500 mb-2">
          {label}
          {range && <span className="text-gray-400"> · {range}</span>}
        </p>
        <ChartBox height={260}>
          <LineChart data={series} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="month" tickFormatter={shortMonth} tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={numTick} tick={{ fontSize: 11 }} width={80} />
            <Tooltip content={productTooltip} />
            <Line
              type="monotone"
              dataKey="revenue"
              name="매출"
              stroke="#0f766e"
              strokeWidth={2}
              dot={{ r: 3, fill: '#0f766e' }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ChartBox>
      </div>

      <div className="border-t border-gray-200">
        <div className="px-4 py-3 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold text-gray-700">
            매출 내역 ({num(rows.length)}행)
          </h3>
          <span className="text-xs text-gray-500">입고예정일 내림차순</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-sm text-gray-400 text-center">
            최근 6개월 내 {label} 이력이 없습니다.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">채널</th>
                    <th className="px-3 py-2 text-left font-medium">센터·입고지</th>
                    <th className="px-3 py-2 text-left font-medium">입고예정일</th>
                    {!product && <th className="px-3 py-2 text-left font-medium">상품</th>}
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-right font-medium">낱개</th>
                    <th className="px-3 py-2 text-right font-medium">매출</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((r, i) => (
                    <tr
                      key={`${r.channel}-${r.poNumber}-${r.product}-${i}`}
                      className="border-t border-gray-100"
                    >
                      <td className="px-3 py-2">{r.channel}</td>
                      <td className="px-3 py-2">{r.center}</td>
                      <td className="px-3 py-2 text-gray-600">{r.dueDate}</td>
                      {!product && (
                        <td className="px-3 py-2 max-w-[22rem] truncate" title={r.product}>
                          {r.product}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right">{r.boxes ? num(r.boxes) : '—'}</td>
                      <td className="px-3 py-2 text-right">{num(r.units)}</td>
                      <td className="px-3 py-2 text-right font-medium">{num(r.revenue)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                    <td className="px-3 py-2" colSpan={product ? 3 : 4}>
                      합계
                    </td>
                    <td className="px-3 py-2 text-right">{num(total.boxes)}</td>
                    <td className="px-3 py-2 text-right">{num(total.units)}</td>
                    <td className="px-3 py-2 text-right">{won(total.revenue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {rows.length > limit && (
              <div className="px-4 py-3 border-t border-gray-100 text-center">
                <button
                  onClick={onMore}
                  className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs hover:bg-gray-50"
                >
                  더보기 ({num(rows.length - limit)}행 남음)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
