'use client'

import React, { useState } from 'react'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import KpiCard from '@/components/pnl/KpiCard'

// ─────────────────────────────────────────────────────────────
// mock 데이터
// ─────────────────────────────────────────────────────────────

const SEGMENTS = ['전체', '단발', '재구매', 'VIP', '휴면'] as const
type Segment = typeof SEGMENTS[number]

const SEGMENT_DIST = [
  { name: '단발',           qty: 14_683, color: '#9ca3af' },
  { name: '재구매 (2-4회)', qty:  6_852, color: '#0f766e' },
  { name: 'VIP (5회+)',     qty:  2_312, color: '#7c3aed' },
  { name: '휴면',           qty:  4_328, color: '#f59e0b' },
]
const SEGMENT_TOTAL = SEGMENT_DIST.reduce((s, c) => s + c.qty, 0)

const REPURCHASE_CYCLE = [
  { product: '귀리 1kg',     days: 28 },
  { product: '오트밀 1kg',   days: 35 },
  { product: '흑미 1kg',     days: 32 },
  { product: '찰보리 1kg',   days: 38 },
  { product: '호라산밀 1kg', days: 42 },
  { product: '강황가루 1봉', days: 45 },
]

type DueTone = 'today' | 'soon'
const REMINDERS: Array<{
  name: string
  phone: string
  lastOrder: string
  ago: string
  due: string
  dueTone: DueTone
  product: string
  tier: string
  tierTone: 'vip' | 'repeat'
}> = [
  { name: '김지혜', phone: '010-****-5847', lastOrder: '4/18', ago: '28일 전', due: '오늘',  dueTone: 'today', product: '귀리 1kg × 3',     tier: 'VIP (8회)',    tierTone: 'vip'    },
  { name: '박영자', phone: '010-****-3128', lastOrder: '4/15', ago: '31일 전', due: '오늘',  dueTone: 'today', product: '흑미 1kg × 2',     tier: '재구매 (5회)', tierTone: 'repeat' },
  { name: '이정민', phone: '010-****-9482', lastOrder: '4/12', ago: '34일 전', due: '+3일',  dueTone: 'soon',  product: '오트밀 1kg',       tier: '재구매 (3회)', tierTone: 'repeat' },
  { name: '최순희', phone: '010-****-2741', lastOrder: '4/13', ago: '33일 전', due: '+1일',  dueTone: 'soon',  product: '찰보리 1kg',       tier: '재구매 (4회)', tierTone: 'repeat' },
  { name: '강미선', phone: '010-****-6235', lastOrder: '4/4',  ago: '42일 전', due: '오늘',  dueTone: 'today', product: '호라산밀 1kg × 2', tier: '재구매 (2회)', tierTone: 'repeat' },
  { name: '윤혜경', phone: '010-****-1958', lastOrder: '4/16', ago: '30일 전', due: '오늘',  dueTone: 'today', product: '귀리 1kg',         tier: 'VIP (12회)',   tierTone: 'vip'    },
]

const MONTHLY = [
  { month: '1월', 신규: 3284, 재구매: 1842 },
  { month: '2월', 신규: 2918, 재구매: 2241 },
  { month: '3월', 신규: 3105, 재구매: 2615 },
  { month: '4월', 신규: 3812, 재구매: 2982 },
  { month: '5월', 신규: 1864, 재구매: 1485 },
]

const VIP_TOP = [
  { name: '이*경', count: 21 },
  { name: '김*혜', count: 18 },
  { name: '박*수', count: 15 },
  { name: '윤*경', count: 12 },
  { name: '최*숙', count: 11 },
  { name: '김*지', count: 10 },
]

// ─────────────────────────────────────────────────────────────
// 컴포넌트
// ─────────────────────────────────────────────────────────────

export default function JindopamCrmPage() {
  const [segment, setSegment] = useState<Segment>('전체')

  const handleSearch = () => {
    console.log('[고객 검색 열기]')
  }

  const handleKakao = (name: string) => {
    console.log('[카톡 발송]', name)
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">CRM</h1>
          <p className="text-sm text-gray-500 mt-1">고객 분석 · 재구매 리마인드</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={segment}
            onChange={(e) => {
              const v = e.target.value as Segment
              setSegment(v)
              console.log('[세그먼트 필터]', v)
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            onClick={handleSearch}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
          >
            🔍 고객 검색
          </button>
        </div>
      </div>

      {/* KPI 4 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="총 고객"           value="23,847명" />
        <KpiCard label="재구매 고객"        value="9,164명"  accent="green" />
        <KpiCard label="재구매율"           value="38.4%"    accent="green" sub="9,164 / 23,847" />
        <KpiCard label="휴면 (90일+)"       value="4,328명"  accent="orange" />
      </div>

      {/* 세그먼트 도넛 + VIP Top 6 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-semibold">고객 세그먼트</h2>
            <span className="text-xs text-gray-500">총 {SEGMENT_TOTAL.toLocaleString()}명</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center">
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={SEGMENT_DIST}
                    dataKey="qty"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {SEGMENT_DIST.map((c) => (
                      <Cell key={c.name} fill={c.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1.5 text-sm">
              {SEGMENT_DIST.map((c) => {
                const pct = ((c.qty / SEGMENT_TOTAL) * 100).toFixed(1)
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

        <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
            <h2 className="text-base font-semibold">VIP 고객 Top 6</h2>
            <span className="text-xs text-gray-500">누적 구매 횟수 기준</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left  px-4 py-2 font-medium w-12">#</th>
                <th className="text-left  px-4 py-2 font-medium">고객</th>
                <th className="text-right px-4 py-2 font-medium">구매 횟수</th>
              </tr>
            </thead>
            <tbody>
              {VIP_TOP.map((v, i) => (
                <tr key={v.name} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-500 font-mono">{i + 1}</td>
                  <td className="px-4 py-2 font-medium">{v.name}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    <span className="text-purple-700 font-semibold">{v.count}회</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* 상품별 평균 재구매 주기 */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold">상품별 평균 재구매 주기</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="text-left  px-4 py-2 font-medium">상품</th>
              <th className="text-right px-4 py-2 font-medium">평균 주기</th>
            </tr>
          </thead>
          <tbody>
            {REPURCHASE_CYCLE.map((r) => (
              <tr key={r.product} className="border-t border-gray-100">
                <td className="px-4 py-2">{r.product}</td>
                <td className="px-4 py-2 text-right font-mono font-semibold">{r.days}일</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 오늘 리마인드 대상 */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">오늘 리마인드 대상</h2>
          <span className="text-xs text-gray-500">{REMINDERS.length}명 · 평균 주기 기준 도래</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="text-left  px-4 py-2 font-medium">고객</th>
                <th className="text-left  px-4 py-2 font-medium">연락처</th>
                <th className="text-left  px-4 py-2 font-medium">최근 주문</th>
                <th className="text-left  px-4 py-2 font-medium">예상 도래</th>
                <th className="text-left  px-4 py-2 font-medium">자주 구매</th>
                <th className="text-left  px-4 py-2 font-medium">등급</th>
                <th className="text-right px-4 py-2 font-medium">액션</th>
              </tr>
            </thead>
            <tbody>
              {REMINDERS.map((r) => (
                <tr key={r.name} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-4 py-2 font-mono text-gray-600">{r.phone}</td>
                  <td className="px-4 py-2">
                    {r.lastOrder} <span className="text-xs text-gray-500">({r.ago})</span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-block px-2 py-0.5 rounded text-xs font-medium ' +
                        (r.dueTone === 'today'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-amber-100 text-amber-700')
                      }
                    >
                      {r.due}
                    </span>
                  </td>
                  <td className="px-4 py-2">{r.product}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-block px-2 py-0.5 rounded text-xs font-medium ' +
                        (r.tierTone === 'vip'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-teal-100 text-teal-700')
                      }
                    >
                      {r.tier}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleKakao(r.name)}
                      className="rounded-md bg-yellow-300 hover:bg-yellow-400 text-gray-900 text-xs font-medium px-3 py-1 transition-colors"
                    >
                      💬 카톡
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 월별 신규 vs 재구매 */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold">월별 신규 vs 재구매</h2>
          <span className="text-xs text-gray-500">누적 막대</span>
        </div>
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <BarChart data={MONTHLY} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="신규"   stackId="a" fill="#9ca3af" />
              <Bar dataKey="재구매" stackId="a" fill="#0f766e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  )
}
