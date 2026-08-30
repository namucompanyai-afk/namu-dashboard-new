'use client'

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  CHANNELS,
  CHANNEL_COLORS,
  buildKpi,
  byChannel,
  byMonth,
  listMonths,
  monthLabel,
  monthlyTrend,
  parseSalesHistory,
  rankBy,
  recentMonths,
  shortMonth,
  sortForTable,
  type ChannelFilter,
  type SalesRecord,
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
const PAGE_SIZE = 50

export default function B2BSalesPage() {
  const [records, setRecords] = useState<SalesRecord[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')

  const [channel, setChannel] = useState<ChannelFilter>('전체')
  const [month, setMonth] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)

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

  const trend = useMemo(() => monthlyTrend(records, recentMonths(month, 6)), [records, month])
  const topProducts = useMemo(() => rankBy(scoped, (r) => r.product, 5), [scoped])
  const topCenters = useMemo(() => rankBy(scoped, (r) => r.center, 8), [scoped])
  const tableRows = useMemo(() => sortForTable(scoped), [scoped])

  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [channel, month])

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

          {/* KPI */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label={`${monthLabel(month)} 매출`}
              value={won(kpi.revenue)}
              sub={
                kpi.momPct === null ? (
                  <span className="text-gray-400">전월 데이터 없음</span>
                ) : (
                  <span className={kpi.momPct >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                    전월 대비 {kpi.momPct >= 0 ? '+' : ''}
                    {kpi.momPct}%
                  </span>
                )
              }
            />
            <KpiCard
              label="발주 건수"
              value={`${num(kpi.poCount)}건`}
              sub={
                kpi.poByChannel.length ? (
                  <span className="text-gray-500">
                    {kpi.poByChannel.map((c) => `${c.channel} ${num(c.count)}`).join(' · ')}
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )
              }
            />
            <KpiCard
              label="출고 물량"
              value={`${num(kpi.boxes)}박스`}
              sub={<span className="text-gray-500">낱개 {num(kpi.units)}</span>}
            />
            <KpiCard
              label="건당 평균 매출"
              value={won(kpi.avgPerPo)}
              sub={<span className="text-gray-500">매출 ÷ 발주 건수</span>}
            />
          </div>

          {/* 월별 매출 추이 */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">월별 매출 추이 (최근 6개월)</h2>
              <span className="text-xs text-gray-500">채널 필터와 무관하게 양채널 표시</span>
            </div>
            <div className="p-4">
              <ChartBox height={280}>
                <BarChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="month" tickFormatter={shortMonth} tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={numTick} tick={{ fontSize: 11 }} width={80} />
                  <Tooltip formatter={wonTip} labelFormatter={monthTip} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {CHANNELS.map((c) => (
                    <Bar key={c} dataKey={c} stackId="revenue" fill={CHANNEL_COLORS[c]} />
                  ))}
                </BarChart>
              </ChartBox>
            </div>
          </div>

          {/* 상품 Top 5 · 센터별 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RankChart
              title="상품별 매출 Top 5"
              rows={topProducts}
              color="#3b82f6"
              emptyText="선택한 조건에 해당하는 이력이 없습니다."
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

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub: ReactElement
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold mt-1">{value}</p>
      <p className="text-[11px] mt-1">{sub}</p>
    </div>
  )
}

function RankChart({
  title,
  rows,
  color,
  emptyText,
}: {
  title: string
  rows: { name: string; revenue: number }[]
  color: string
  emptyText: string
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold">{title}</h2>
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
              <Tooltip formatter={wonTip} />
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
