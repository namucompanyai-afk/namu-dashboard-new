'use client'

import React, { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import KpiCard from '@/components/pnl/KpiCard'
import { formatKRW } from '@/components/pnl/format'

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']

const BREAKDOWN_ROWS: Array<{ label: string; amount: number; tone?: 'neg' | 'total' }> = [
  { label: '일반사용',        amount:  109_693_266 },
  { label: '쿠팡입고',        amount:  102_521_860 },
  { label: '이랜드',          amount:    3_997_406 },
  { label: '샘플+대량발주',   amount:      300_798 },
  { label: '반품차감',        amount:     -332_459, tone: 'neg' },
  { label: '쿠팡반출',        amount:       -7_250, tone: 'neg' },
  { label: '토탈',            amount:  237_284_183, tone: 'total' },
]

const TOP_PRODUCTS: Array<{ name: string; unitPrice: number; qty: number }> = [
  { name: '바나듐쌀',       unitPrice: 10_400, qty: 1_474 },
  { name: '귀리혼합10곡',   unitPrice:  4_623, qty: 2_072 },
  { name: '귀리',           unitPrice:  5_300, qty: 1_712 },
  { name: '기장',           unitPrice: 15_300, qty:   428 },
  { name: '서리태',         unitPrice: 15_300, qty:   402 },
  { name: '오트밀',         unitPrice:  3_500, qty: 1_626 },
  { name: '찰흑미',         unitPrice:  5_800, qty:   823 },
]

const MONTHLY_TREND = [
  { month: '1월', amount: 195 },
  { month: '2월', amount: 218 },
  { month: '3월', amount: 237 },
  { month: '4월', amount: 251 },
  { month: '5월', amount: 132 },
]

const formatSigned = (n: number) =>
  (n < 0 ? '-' : '') + Math.abs(n).toLocaleString() + '원'

export default function JindopamSettlementPage() {
  const [selectedMonth, setSelectedMonth] = useState('2026-05')

  const handleExportPdf = () => {
    console.log('[PDF 출력]', selectedMonth)
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">진도팜 정산</h1>
          <p className="text-sm text-gray-500 mt-1">월별 정산 내역 · 상품별 공급 · 추이</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(e.target.value)
              console.log('[월 선택]', e.target.value)
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {MONTHS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            onClick={handleExportPdf}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
          >
            📄 PDF 출력
          </button>
        </div>
      </div>

      {/* KPI 4개 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="토탈" value={formatKRW(237_284_183)} accent="green" />
        <KpiCard label="면세"  value={formatKRW(236_491_703)} />
        <KpiCard label="과세"  value={formatKRW(792_480)} />
        <KpiCard
          label="전월 대비"
          value="+8.2%"
          accent="green"
          sub="219.4백만 → 237.3백만"
        />
      </div>

      {/* 정산 분해 */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">정산 분해</h2>
          <span className="text-xs text-gray-500">{selectedMonth}</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2 font-medium">항목</th>
              <th className="text-right px-4 py-2 font-medium">금액</th>
            </tr>
          </thead>
          <tbody>
            {BREAKDOWN_ROWS.map((r) => (
              <tr
                key={r.label}
                className={
                  r.tone === 'total'
                    ? 'bg-gray-50 font-bold border-t border-gray-300'
                    : 'border-t border-gray-100'
                }
              >
                <td className="px-4 py-2">{r.label}</td>
                <td
                  className={
                    'px-4 py-2 text-right font-mono ' +
                    (r.tone === 'neg' ? 'text-red-600' : '')
                  }
                >
                  {formatSigned(r.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 상품별 공급 Top 7 */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold">상품별 공급 내역 (Top 7)</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="text-left  px-4 py-2 font-medium">상품</th>
              <th className="text-right px-4 py-2 font-medium">단가</th>
              <th className="text-right px-4 py-2 font-medium">수량</th>
              <th className="text-right px-4 py-2 font-medium">합계</th>
            </tr>
          </thead>
          <tbody>
            {TOP_PRODUCTS.map((p) => {
              const subtotal = p.unitPrice * p.qty
              return (
                <tr key={p.name} className="border-t border-gray-100">
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2 text-right font-mono">{p.unitPrice.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right font-mono">{p.qty.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold">{subtotal.toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {/* 택배비 / 박스비 (참고용) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-base font-semibold">택배비 디테일</h3>
            <span className="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">대표님 부담 · 참고</span>
          </div>
          <div className="text-2xl font-bold font-mono mb-3">{formatKRW(17_439_595)}</div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-gray-600">일반</span><span className="font-mono">{formatKRW(11_144_800)}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">스토어</span><span className="font-mono">{formatKRW(6_245_592)}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">스타</span><span className="font-mono">{formatKRW(49_203)}</span></div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-base font-semibold">박스비 디테일</h3>
            <span className="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">대표님 부담 · 참고</span>
          </div>
          <div className="text-2xl font-bold font-mono mb-3">{formatKRW(3_600_267)}</div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-gray-600">소</span><span className="font-mono">{formatKRW(2_518_348)}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">중</span><span className="font-mono">{formatKRW(1_070_219)}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">대</span><span className="font-mono">{formatKRW(11_700)}</span></div>
          </div>
        </section>
      </div>

      {/* 월별 추이 */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-base font-semibold">월별 정산 추이</h3>
          <span className="text-xs text-gray-500">단위: 백만원</span>
        </div>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <LineChart data={MONTHLY_TREND} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(v) => [`${v} 백만원`, '정산']}
                contentStyle={{ fontSize: 12 }}
              />
              <Line
                type="monotone"
                dataKey="amount"
                stroke="#0f766e"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#0f766e' }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  )
}
