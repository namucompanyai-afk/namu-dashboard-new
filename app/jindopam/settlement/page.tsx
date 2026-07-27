'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import KpiCard from '@/components/pnl/KpiCard'
import { formatKRW } from '@/components/pnl/format'

// ── 타입 (API /api/jindopam/settlement 응답) ──────────────────────────
type Product = { name: string; qty: number; unitPrice: number | null; subtotal: number | null }
type Delivery = {
  takbae: { total: number; bySize: Record<string, number> }
  box: { total: number; bySize: Record<string, number> }
} | null
type SettleData = {
  ok: boolean
  month: string
  status: 'complete' | 'in-progress' | 'no-file'
  fileName?: string
  products: Product[] | null
  delivery: Delivery
  breakdown: Array<{ label: string; amount: number | null }> | null
  // 접근 실패 시
  error?: string
  needsShare?: boolean
  clientEmail?: string | null
}
type FileEntry = { id: string; name: string; month: string | null }

// 미연동 배지 — 매핑/스키마 미확정 항목에 숫자 대신 표시
function Pending({ label = '미연동' }: { label?: string }) {
  return (
    <span className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
      {label}
    </span>
  )
}

const monthLabel = (m: string) => `${Number(m.slice(5, 7))}월`

export default function JindopamSettlementPage() {
  const [months, setMonths] = useState<string[]>([])
  const [selectedMonth, setSelectedMonth] = useState('')
  const [setup, setSetup] = useState<null | { error: string; clientEmail?: string | null }>(null)
  const [data, setData] = useState<SettleData | null>(null)
  const [loading, setLoading] = useState(true)

  // 사용 가능한 월 목록 로드 (Drive 폴더 스캔)
  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/jindopam/settlement?action=list', { cache: 'no-store' })
        const j = await res.json()
        if (!j.ok) {
          setSetup({ error: j.error || '폴더 접근 실패', clientEmail: j.clientEmail })
          setLoading(false)
          return
        }
        const ms = [...new Set((j.files as FileEntry[]).map((f) => f.month).filter(Boolean))].sort() as string[]
        setMonths(ms)
        setSelectedMonth(ms[ms.length - 1] || '')
        if (!ms.length) setLoading(false)
      } catch (e: any) {
        setSetup({ error: e?.message || '네트워크 오류' })
        setLoading(false)
      }
    })()
  }, [])

  // 선택 월 데이터 로드
  const loadMonth = useCallback(async (m: string) => {
    if (!m) return
    setLoading(true)
    try {
      const res = await fetch(`/api/jindopam/settlement?action=data&month=${m}`, { cache: 'no-store' })
      const j = await res.json()
      if (!j.ok) {
        setSetup({ error: j.error || '데이터 로드 실패', clientEmail: j.clientEmail })
        setData(null)
      } else {
        setData(j)
      }
    } catch (e: any) {
      setSetup({ error: e?.message || '네트워크 오류' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedMonth) loadMonth(selectedMonth)
  }, [selectedMonth, loadMonth])

  const inProgress = data?.status === 'in-progress'
  const products = data?.products || []
  const productsHavePrice = products.some((p) => p.unitPrice != null)

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">진도팜 정산</h1>
          <p className="mt-1 text-sm text-gray-500">월별 정산 내역 · 상품별 공급 · 추이 · 실데이터 연동</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            disabled={!months.length}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-50"
          >
            {months.length === 0 && <option value="">— 월 없음 —</option>}
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
                {m >= new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7) ? ' (집계 중)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 설정 필요 배너 (Drive API 미활성 / 폴더 미공유) */}
      {setup && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <div className="mb-2 font-semibold text-amber-800">⚠️ 데이터 소스 연결 설정 필요</div>
          <p className="mb-2 whitespace-pre-wrap text-amber-900">{setup.error}</p>
          <ul className="ml-4 list-disc space-y-1 text-amber-900">
            <li>Google Cloud 프로젝트에서 <b>Drive API</b> 활성화</li>
            <li>
              진도팜/2026 폴더를 서비스계정에 <b>공유</b>:{' '}
              <code className="rounded bg-white px-1 py-0.5 text-xs">
                {setup.clientEmail || 'namu-sheets-reader@…gserviceaccount.com'}
              </code>{' '}
              (뷰어 권한)
            </li>
          </ul>
        </section>
      )}

      {data?.status === 'no-file' && (
        <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
          {selectedMonth} 파일을 폴더에서 찾지 못했습니다.
        </section>
      )}

      {/* 집계 중 안내 */}
      {inProgress && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          진행 중인 달입니다 — 발주가 매일 누적되는 <b>집계 중</b> 상태로, 월말까지 값이 계속 증가합니다.
        </div>
      )}

      {/* KPI 4개 — 금액 계산은 단가·과세 매핑 확정 후 (현재 미연동) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: '토탈' },
          { label: '면세' },
          { label: '과세' },
          { label: '전월 대비' },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="mb-1 text-xs text-gray-500">{k.label}</div>
            <div className="text-xl font-bold">
              <Pending />
            </div>
            <div className="mt-1 text-[10px] text-gray-400">단가·과세 매핑 확정 후 연동</div>
          </div>
        ))}
      </div>

      {/* 정산 분해 — 채널→항목 매핑 확정 후 (현재 미연동) */}
      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-semibold">정산 분해</h2>
          <span className="text-xs text-gray-500">{selectedMonth}</span>
        </div>
        <div className="px-4 py-6 text-sm text-gray-500">
          <div className="mb-2 flex items-center gap-2">
            <Pending /> 6개 항목(일반사용·쿠팡입고·이랜드·샘플+대량발주·반품차감·쿠팡반출)
          </div>
          <p className="text-xs text-gray-400">
            발주취합 채널 → 정산 항목 매핑과 반품/반출 음수 항목 출처가 확정되면 연동됩니다.
          </p>
        </div>
      </section>

      {/* 상품별 공급 — 수량은 발주취합에서 실집계, 단가/합계는 매핑 확정 후 */}
      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-semibold">상품별 공급 내역</h2>
          <span className="text-xs text-gray-500">
            {products.length ? `${products.length}개 품목 · 수량 실집계` : '발주취합 집계'}
          </span>
        </div>
        {loading ? (
          <div className="px-4 py-6 text-sm text-gray-400">불러오는 중…</div>
        ) : products.length ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left font-medium">상품(내품명)</th>
                <th className="px-4 py-2 text-right font-medium">수량</th>
                <th className="px-4 py-2 text-right font-medium">단가</th>
                <th className="px-4 py-2 text-right font-medium">합계</th>
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 30).map((p) => (
                <tr key={p.name} className="border-t border-gray-100">
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2 text-right font-mono">{p.qty.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {p.unitPrice != null ? p.unitPrice.toLocaleString() : <Pending />}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-semibold">
                    {p.subtotal != null ? p.subtotal.toLocaleString() : <Pending />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-6 text-sm text-gray-400">데이터 없음</div>
        )}
        {products.length > 0 && !productsHavePrice && (
          <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
            단가는 내품명→단가 매핑 확정 후 연동됩니다. 현재는 <b>수량만 실집계</b>.
          </div>
        )}
      </section>

      {/* 택배비 / 박스비 — 택배 시트 스키마 확인 후 (현재 미연동) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[
          { title: '택배비 디테일', unit: '소 2,100 · 중 2,800 · 대 4,400' },
          { title: '박스비 디테일', unit: '소 427 · 중 1,291 · 대 1,495' },
        ].map((s) => (
          <section key={s.title} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-base font-semibold">{s.title}</h3>
              <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                대표님 부담 · 참고
              </span>
            </div>
            <div className="mb-2 text-2xl font-bold">
              {data?.delivery ? formatKRW(0) : <Pending />}
            </div>
            <p className="text-xs text-gray-400">단가 {s.unit} · 택배 시트 규격별 건수 집계 후 연동</p>
          </section>
        ))}
      </div>

      {/* 월별 추이 — 완료월만 실선, 집계 중(부분월)은 점선·중공 dot로 구분해 급락처럼 안 보이게 */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-base font-semibold">월별 정산 추이</h3>
          <span className="text-xs text-gray-500">단위: 백만원</span>
        </div>
        <TrendChart months={months} />
        <p className="mt-2 text-xs text-gray-400">
          정산 총액이 연동되면 완료월은 실선, 진행 중인 달은 점선·중공 표식으로 표시됩니다(부분월 급락 방지).
        </p>
      </section>
    </div>
  )
}

// 월별 추이 차트 — 총액 연동 전에는 미연동 안내, 연동 후 부분월 처리 로직 포함
function TrendChart({ months }: { months: string[] }) {
  const nowMonth = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7)
  // 총액 데이터가 아직 없으므로 값은 null → 미연동 안내만. (구조는 연동 대비)
  const data = useMemo(
    () => months.map((m) => ({ month: monthLabel(m), amount: null as number | null, partial: m >= nowMonth })),
    [months, nowMonth],
  )
  const hasValue = data.some((d) => d.amount != null)

  if (!hasValue) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg bg-gray-50 text-sm text-gray-400">
        <Pending label="추이 미연동 — 정산 총액 연동 후 표시" />
      </div>
    )
  }
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip formatter={(v) => [`${v} 백만원`, '정산']} contentStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="amount"
            stroke="#0f766e"
            strokeWidth={2.5}
            connectNulls
            dot={(props: any) => {
              const partial = props?.payload?.partial
              return (
                <circle
                  key={props.key ?? `${props.cx}-${props.cy}`}
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={partial ? '#fff' : '#0f766e'}
                  stroke="#0f766e"
                  strokeWidth={2}
                  strokeDasharray={partial ? '2 2' : undefined}
                />
              )
            }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
