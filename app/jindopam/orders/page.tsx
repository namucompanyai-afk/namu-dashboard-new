'use client'

import React, { useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts'
import KpiCard from '@/components/pnl/KpiCard'

// ─────────────────────────────────────────────────────────────
// mock 데이터
// ─────────────────────────────────────────────────────────────

const PERIODS = [
  '2026년 5월 진행 중 (5/1~5/15)',
  '2026년 4월',
  '2026년 3월',
]

// 일별 발주량 — 5/1~5/15
const DAILY_LABELS = Array.from({ length: 15 }, (_, i) => `5/${i + 1}`)
const DAILY = {
  쿠팡:   [0, 0, 0, 0, 0, 612, 420, 335, 180, 0, 491, 387, 418, 492, 425],
  스토어: [0, 0, 0, 0, 0, 432, 318, 245, 140, 0, 386, 294, 318, 365, 332],
  카메:   [0, 0, 0, 0, 0, 189,  42,  38,  15, 0,  52,  48,  55,  68,  72],
  기타:   [0, 0, 0, 0, 0,  42,  18,  14,   8, 0,  28,  22,  25,  32,  28],
}
const DAILY_SERIES = DAILY_LABELS.map((day, i) => ({
  day,
  쿠팡:   DAILY.쿠팡[i],
  스토어: DAILY.스토어[i],
  카메:   DAILY.카메[i],
  기타:   DAILY.기타[i],
}))

// 상품별 누적 Top 10
const TOP_PRODUCTS = [
  { name: '귀리',       qty: 839 },
  { name: '귀리10곡',   qty: 426 },
  { name: '호라산밀',   qty: 404 },
  { name: '오색현미',   qty: 400 },
  { name: '흑보리',     qty: 320 },
  { name: '바나듐쌀',   qty: 232 },
  { name: '오트밀',     qty: 222 },
  { name: '즉석밥',     qty: 181 },
  { name: '현미',       qty: 163 },
  { name: '찰보리',     qty: 139 },
]

// 채널별 분포
const CHANNEL_DIST = [
  { name: '쿠팡',     qty: 2452, color: '#dc2626' }, // red
  { name: '스토어',   qty: 1944, color: '#16a34a' }, // green
  { name: '카메',     qty:  357, color: '#0ea5e9' }, // sky
  { name: '오아시스', qty:   89, color: '#f59e0b' }, // amber
  { name: '기타',     qty:  263, color: '#6b7280' }, // gray
]
const CHANNEL_TOTAL = CHANNEL_DIST.reduce((s, c) => s + c.qty, 0)

// 상품 × 채널 매트릭스
const MATRIX_CHANNELS = ['쿠팡', '스토어', '카메', '오아시스', '기타'] as const
const MATRIX_ROWS: Array<{ name: string; values: number[] }> = [
  { name: '귀리',     values: [418, 312,  89, 12, 8] },
  { name: '귀리10곡', values: [210, 156,  42, 12, 6] },
  { name: '호라산밀', values: [ 98, 187, 108,  8, 3] },
  { name: '오색현미', values: [198, 142,  45, 11, 4] },
  { name: '흑보리',   values: [162, 118,  28,  8, 4] },
]
const MATRIX_MAX = Math.max(...MATRIX_ROWS.flatMap((r) => r.values))

// 라인 차트 색상 (채널별 분포와 동일 톤)
const LINE_COLORS: Record<string, string> = {
  쿠팡:   '#dc2626',
  스토어: '#16a34a',
  카메:   '#0ea5e9',
  기타:   '#6b7280',
}

// ─────────────────────────────────────────────────────────────
// 컴포넌트
// ─────────────────────────────────────────────────────────────

function heatColor(value: number, max: number): string {
  if (value <= 0) return 'transparent'
  // teal 계열 — 0 → 매우 옅은, max → 진한
  const ratio = Math.min(1, value / max)
  // 0.10 ~ 0.85 사이 알파
  const alpha = 0.10 + ratio * 0.75
  return `rgba(15, 118, 110, ${alpha.toFixed(2)})`
}

export default function JindopamOrdersPage() {
  const [period, setPeriod] = useState(PERIODS[0])

  const handleRefresh = () => {
    console.log('[새로고침]', period)
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">발주 모니터링</h1>
          <p className="text-sm text-gray-500 mt-1">2026년 5월 진행 중 (5/1~5/15)</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value)
              console.log('[기간 선택]', e.target.value)
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button
            onClick={handleRefresh}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
          >
            🔄 새로고침
          </button>
        </div>
      </div>

      {/* KPI 카드 4개 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="오늘 발주"        value="425건" />
        <KpiCard label="5월 누적"         value="5,105건" accent="green" />
        <KpiCard label="전월 동기 대비"   value="+12%" accent="green" sub="4,558 → 5,105" />
        <KpiCard label="일 평균"          value="510건" sub="가동일 기준" />
      </div>

      {/* 일별 발주량 추이 */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold">일별 발주량 추이</h2>
          <span className="text-xs text-gray-500">채널별</span>
        </div>
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <LineChart data={DAILY_SERIES} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {(['쿠팡', '스토어', '카메', '기타'] as const).map((k) => (
                <Line
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stroke={LINE_COLORS[k]}
                  strokeWidth={2}
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Top 10 가로 막대 + 채널 분포 도넛 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-semibold">상품별 누적 Top 10</h2>
            <span className="text-xs text-gray-500">5/1~5/15</span>
          </div>
          <div style={{ width: '100%', height: 360 }}>
            <ResponsiveContainer>
              <BarChart
                data={TOP_PRODUCTS}
                layout="vertical"
                margin={{ top: 4, right: 32, left: 16, bottom: 0 }}
              >
                <CartesianGrid stroke="#eee" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis dataKey="name" type="category" width={70} tick={{ fontSize: 12 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="qty" fill="#0f766e" radius={[0, 4, 4, 0]}>
                  {TOP_PRODUCTS.map((_, i) => (
                    <Cell key={i} fill="#0f766e" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-semibold">채널별 분포</h2>
            <span className="text-xs text-gray-500">총 {CHANNEL_TOTAL.toLocaleString()}건</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center">
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={CHANNEL_DIST}
                    dataKey="qty"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {CHANNEL_DIST.map((c) => (
                      <Cell key={c.name} fill={c.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1.5 text-sm">
              {CHANNEL_DIST.map((c) => {
                const pct = ((c.qty / CHANNEL_TOTAL) * 100).toFixed(1)
                return (
                  <div key={c.name} className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: c.color }} />
                    <span className="flex-1 text-gray-700">{c.name}</span>
                    <span className="font-mono text-gray-900">{c.qty.toLocaleString()}</span>
                    <span className="font-mono text-xs text-gray-500 w-12 text-right">{pct}%</span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      </div>

      {/* 상품 × 채널 매트릭스 (히트맵) */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">상품 × 채널 매트릭스</h2>
          <span className="text-xs text-gray-500">색이 진할수록 발주량 많음</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">상품</th>
                {MATRIX_CHANNELS.map((c) => (
                  <th key={c} className="text-right px-4 py-2 font-medium">{c}</th>
                ))}
                <th className="text-right px-4 py-2 font-medium border-l border-gray-200">합계</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX_ROWS.map((row) => {
                const sum = row.values.reduce((s, v) => s + v, 0)
                return (
                  <tr key={row.name} className="border-t border-gray-100">
                    <td className="px-4 py-2 font-medium">{row.name}</td>
                    {row.values.map((v, i) => (
                      <td
                        key={i}
                        className="px-4 py-2 text-right font-mono"
                        style={{ background: heatColor(v, MATRIX_MAX) }}
                      >
                        {v.toLocaleString()}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-mono font-bold border-l border-gray-200">
                      {sum.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
