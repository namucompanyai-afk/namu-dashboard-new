'use client'

import React, { useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import KpiCard from '@/components/pnl/KpiCard'
import { formatKRW } from '@/components/pnl/format'

// ─────────────────────────────────────────────────────────────
// mock 데이터
// ─────────────────────────────────────────────────────────────

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']

const BREAKDOWN_ROWS: Array<{ label: string; amount: number; tone?: 'neg' | 'total' }> = [
  { label: '일반사용',      amount:  109_693_266 },
  { label: '쿠팡입고',      amount:  102_521_860 },
  { label: '이랜드',        amount:    3_997_406 },
  { label: '샘플+대량발주', amount:      300_798 },
  { label: '반품차감',      amount:     -332_459, tone: 'neg' },
  { label: '쿠팡반출',      amount:       -7_250, tone: 'neg' },
  { label: '토탈',          amount:  237_284_183, tone: 'total' },
]

type Supply = {
  name: string
  unitPrice: number
  b2c: number
  coupang: number
  kims: number
  total: number
}
const SUPPLY_TOP: Supply[] = [
  { name: '바나듐쌀',     unitPrice: 10_400, b2c: 1_474, coupang:     0, kims:   0, total: 15_329_600 },
  { name: '귀리혼합10곡', unitPrice:  4_623, b2c: 2_072, coupang: 1_728, kims:  54, total: 17_820_000 },
  { name: '귀리',         unitPrice:  5_300, b2c: 1_712, coupang: 3_456, kims: 108, total: 28_156_000 },
  { name: '기장',         unitPrice: 15_300, b2c:   428, coupang:     0, kims:   0, total:  6_548_400 },
  { name: '서리태',       unitPrice: 15_300, b2c:   402, coupang:     0, kims:   0, total:  6_150_600 },
]

type ReturnRow = {
  date: string
  product: string
  qty: number
  amount: number
  reason: string
  burdenBy: '나무' | '진도팜'
}
const RETURNS: ReturnRow[] = [
  { date: '3/3',  product: '귀리혼합10곡', qty: 5, amount: 23_115, reason: '단순변심',   burdenBy: '나무'   },
  { date: '3/9',  product: '귀리혼합10곡', qty: 5, amount: 23_115, reason: '홍미 양 부족', burdenBy: '진도팜' },
  { date: '3/16', product: '귀리혼합10곡', qty: 1, amount:  4_623, reason: '이물질',     burdenBy: '진도팜' },
  { date: '3/30', product: '호라산밀',     qty: 1, amount:  7_600, reason: '이물질',     burdenBy: '진도팜' },
  { date: '3/30', product: '귀리',         qty: 2, amount: 10_600, reason: '품질',       burdenBy: '진도팜' },
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

// ─────────────────────────────────────────────────────────────
// 컴포넌트
// ─────────────────────────────────────────────────────────────

export default function JindopamSharedPage() {
  const [selectedMonth, setSelectedMonth] = useState('2026-03')

  const handleExportPdf = () => {
    console.log('[PDF 출력]', selectedMonth)
  }
  const handleConfirm = () => {
    console.log('[정산 확정]', selectedMonth)
  }
  const handleDispute = () => {
    console.log('[이의 제기]', selectedMonth)
  }
  const handleShowMore = () => {
    console.log('[상품 더보기]')
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">정산 확인</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                🌾 진도팜
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">2026년 3월 정산 내역</p>
          </div>
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

      {/* 확인 완료 / 이의 제기 액션 카드 */}
      <section className="rounded-lg border border-green-200 bg-gradient-to-br from-green-50 to-emerald-50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl">⏳</span>
              <h2 className="text-lg font-semibold text-green-900">3월 정산 확정 대기</h2>
            </div>
            <p className="text-sm text-green-800">
              정산 내역을 확인하시고 이상 없으면 확정해주세요.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDispute}
              className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
            >
              ⚠️ 이의 제기
            </button>
            <button
              onClick={handleConfirm}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors shadow-sm"
            >
              ✅ 확인 완료
            </button>
          </div>
        </div>
      </section>

      {/* KPI 4 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="3월 정산액"  value={formatKRW(237_284_183)} accent="green" />
        <KpiCard label="면세"        value={formatKRW(236_491_703)} />
        <KpiCard label="과세"        value={formatKRW(792_480)} />
        <KpiCard label="입금 예정일" value="4/10" sub="익월 10일 지급" />
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
              <th className="text-left  px-4 py-2 font-medium">항목</th>
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

      {/* 상품별 공급 내역 (채널 컬럼 분리) */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">상품별 공급 내역</h2>
          <span className="text-xs text-gray-500">B2C · 쿠팡입고 · 킴스</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left  px-4 py-2 font-medium">상품</th>
                <th className="text-right px-4 py-2 font-medium">단가</th>
                <th className="text-right px-4 py-2 font-medium">B2C</th>
                <th className="text-right px-4 py-2 font-medium">쿠팡입고</th>
                <th className="text-right px-4 py-2 font-medium">킴스</th>
                <th className="text-right px-4 py-2 font-medium border-l border-gray-200">합계</th>
              </tr>
            </thead>
            <tbody>
              {SUPPLY_TOP.map((p) => (
                <tr key={p.name} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium">{p.name}</td>
                  <td className="px-4 py-2 text-right font-mono">{p.unitPrice.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right font-mono">{p.b2c.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{p.coupang ? p.coupang.toLocaleString() : '-'}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{p.kims ? p.kims.toLocaleString() : '-'}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold border-l border-gray-200">
                    {p.total.toLocaleString()}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-gray-100">
                <td colSpan={6} className="px-4 py-2 text-center">
                  <button
                    onClick={handleShowMore}
                    className="text-sm text-gray-600 hover:text-gray-900 hover:underline"
                  >
                    ↓ 60개 상품 더보기
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 반품 내역 */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">반품 내역</h2>
          <span className="text-xs text-gray-500">{RETURNS.length}건</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left  px-4 py-2 font-medium">날짜</th>
                <th className="text-left  px-4 py-2 font-medium">상품</th>
                <th className="text-right px-4 py-2 font-medium">수량</th>
                <th className="text-right px-4 py-2 font-medium">금액</th>
                <th className="text-left  px-4 py-2 font-medium">사유</th>
                <th className="text-left  px-4 py-2 font-medium">택배비 부담</th>
              </tr>
            </thead>
            <tbody>
              {RETURNS.map((r, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-gray-600">{r.date}</td>
                  <td className="px-4 py-2">{r.product}</td>
                  <td className="px-4 py-2 text-right font-mono">{r.qty}</td>
                  <td className="px-4 py-2 text-right font-mono text-red-600">-{r.amount.toLocaleString()}</td>
                  <td className="px-4 py-2 text-gray-700">{r.reason}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-block px-2 py-0.5 rounded text-xs font-medium ' +
                        (r.burdenBy === '진도팜'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700')
                      }
                    >
                      {r.burdenBy}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 월별 정산 추이 */}
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
                stroke="#16a34a"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#16a34a' }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  )
}
