'use client'

/**
 * 쿠팡 손익 — 상품(별칭)별 판정 표 (3P + 1P 판매 기준). 계산은 lib/coupang/productVerdict.ts (기존 결과 재사용).
 * 행 클릭 → 3P / 1P 나눠 보기 · "광고 보기" → 광고 분석(?alias=) 그 상품 캠페인만
 */
import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import type { ProductVerdict, ProductVerdictRow, VerdictPart } from '@/lib/coupang/productVerdict'
import { downloadFormattedXlsx, type XlsxCol } from '@/lib/xlsxExport'

const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}`
const tone = (n: number) => (n < 0 ? 'text-red-600' : n > 0 ? 'text-gray-900' : 'text-gray-400')

const VERDICT_STYLE: Record<ProductVerdict, string> = {
  효자: 'bg-green-100 text-green-800',
  함정: 'bg-amber-100 text-amber-800',
  '진짜 적자': 'bg-red-100 text-red-700',
  '광고 없음': 'bg-gray-100 text-gray-600',
}
const FILTERS: (ProductVerdict | '전체')[] = ['전체', '효자', '함정', '진짜 적자', '광고 없음']

type SortKey = 'profit' | 'revenue' | 'margin' | 'adCost' | 'bags' | 'adBags' | 'adShare' | 'adProfit' | 'milkrun'
/** 광고 판매 비중 — 14일 전환이라 100% 를 넘으면 '100%+' */
const shareText = (v: number | null | undefined) => (v == null ? '—' : v > 1 ? '100%+' : `${Math.round(v * 100)}%`)
const shareOf = (p: { bags: number; adBags: number }) => (p.bags > 0 ? p.adBags / p.bags : null)

export default function ProductVerdictTable({ rows, monthLabel }: { rows: ProductVerdictRow[]; monthLabel: string }) {
  const [filter, setFilter] = useState<ProductVerdict | '전체'>('전체')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'profit', dir: -1 })
  const [open, setOpen] = useState<Set<string>>(new Set())

  const counts = useMemo(() => {
    const c: Record<string, number> = { 전체: rows.length }
    for (const r of rows) c[r.verdict] = (c[r.verdict] || 0) + 1
    return c
  }, [rows])
  const shown = useMemo(() => {
    const list = filter === '전체' ? rows : rows.filter((r) => r.verdict === filter)
    const val = (r: ProductVerdictRow) => (sort.key === 'adShare' ? r.adShare ?? -1 : r[sort.key])
    return [...list].sort((a, b) => (val(a) - val(b)) * sort.dir)
  }, [rows, filter, sort])
  const total = useMemo(() => shown.reduce((a, r) => a + r.profit, 0), [shown])

  const toggle = (alias: string) => setOpen((prev) => {
    const n = new Set(prev)
    if (n.has(alias)) n.delete(alias); else n.add(alias)
    return n
  })
  const TH = ({ k, label }: { k: SortKey; label: React.ReactNode }) => (
    <th className="cursor-pointer select-none whitespace-nowrap px-2 py-2 text-right font-medium" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}>
      {label}{sort.key === k ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  )

  const exportXlsx = () => {
    const cols: XlsxCol<ProductVerdictRow>[] = [
      { header: '별칭', kind: 'text', get: (r) => r.alias },
      { header: '채널', kind: 'text', get: (r) => r.channel },
      { header: '판매 매출', kind: 'won', get: (r) => r.revenue },
      { header: '판매 마진', kind: 'won', get: (r) => r.margin },
      { header: '광고비 (부가포함, 과세 ×1.0)', kind: 'won', get: (r) => r.adCost },
      { header: '판매 봉수', kind: 'count', get: (r) => r.bags },
      { header: '광고 판매 봉수', kind: 'count', get: (r) => r.adBags },
      { header: '광고 판매 비중', kind: 'text', get: (r) => shareText(r.adShare) },
      { header: '광고 손익', kind: 'won', get: (r) => r.adProfit },
      { header: '1P 운송비', kind: 'won', get: (r) => (r.p1 ? r.milkrun : null) },
      { header: '상품 손익', kind: 'won', get: (r) => r.profit },
      { header: '판정', kind: 'text', get: (r) => r.verdict },
      { header: '3P 상품 손익', kind: 'won', get: (r) => r.p3?.profit ?? null },
      { header: '1P 상품 손익', kind: 'won', get: (r) => r.p1?.profit ?? null },
    ]
    void downloadFormattedXlsx(cols, shown, `쿠팡손익_상품별판정_${monthLabel}${filter === '전체' ? '' : `_${filter}`}.xlsx`, '상품별 판정')
  }

  const partRow = (label: string, p: VerdictPart, hasMilkrun: boolean) => (
    <tr className="bg-gray-50 text-[11.5px] text-gray-600">
      <td className="py-1 pl-8 pr-2">└ {label}</td>
      <td />
      <td className="px-2 text-right tabular-nums">{won(p.revenue)}</td>
      <td className="px-2 text-right tabular-nums">{won(p.margin)}</td>
      <td className="px-2 text-right tabular-nums">{won(p.adCost)}</td>
      <td className="px-2 text-right tabular-nums">{won(p.bags)}</td>
      <td className="px-2 text-right tabular-nums">{won(p.adBags)}</td>
      <td className="px-2 text-right tabular-nums">{shareText(shareOf(p))}</td>
      <td className={`px-2 text-right tabular-nums ${tone(p.adProfit)}`}>{won(p.adProfit)}</td>
      <td className="px-2 text-right tabular-nums">{hasMilkrun ? won(p.milkrun) : '—'}</td>
      <td className={`px-2 text-right tabular-nums ${tone(p.profit)}`}>{won(p.profit)}</td>
      <td colSpan={2} />
    </tr>
  )

  return (
    <div className="mt-4 rounded-xl border bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-700">{monthLabel} 상품별 판정 (3P + 1P, 판매 기준)</div>
          <div className="text-[11px] text-gray-400">상품 손익 = 판매 마진 − 광고비(부가포함, 과세 ×1.0) − 1P 운송비 · 광고 판매 비중 = 광고 판매 봉수 ÷ 판매 봉수(14일 전환이라 100%+ 가능) · 효자: 상품·광고 손익 모두 + · 함정: 상품 + · 광고 − · 진짜 적자: 상품 − · 행 클릭 → 3P/1P 나눠 보기</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === f ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>
              {f} {counts[f] ?? 0}
            </button>
          ))}
          <button onClick={exportXlsx} className="ml-1 rounded border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-50">⬇ 엑셀</button>
        </div>
      </div>
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500">
            <tr>
              <th className="px-2 py-2 text-left font-medium">별칭</th>
              <th className="px-2 py-2 text-left font-medium">채널</th>
              <TH k="revenue" label="판매 매출" />
              <TH k="margin" label="판매 마진" />
              <TH k="adCost" label="광고비" />
              <TH k="bags" label="판매 봉수" />
              <TH k="adBags" label="광고 판매 봉수" />
              <TH k="adShare" label="광고 판매 비중" />
              <TH k="adProfit" label="광고 손익" />
              <TH k="milkrun" label="1P 운송비" />
              <TH k="profit" label="상품 손익" />
              <th className="px-2 py-2 text-left font-medium">판정</th>
              <th className="px-2 py-2 text-left font-medium">광고</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const isOpen = open.has(r.alias)
              const canSplit = !!(r.p3 && r.p1)
              return (
                <React.Fragment key={r.alias}>
                  <tr className={`border-t ${canSplit ? 'cursor-pointer hover:bg-orange-50' : ''} ${r.special ? 'text-gray-500' : ''}`} onClick={() => canSplit && toggle(r.alias)}>
                    <td className="px-2 py-1.5 font-medium text-gray-800">{canSplit ? (isOpen ? '▾ ' : '▸ ') : ''}{r.alias}</td>
                    <td className="px-2 text-gray-600">{r.channel}</td>
                    <td className="px-2 text-right tabular-nums">{won(r.revenue)}</td>
                    <td className="px-2 text-right tabular-nums">{won(r.margin)}</td>
                    <td className="px-2 text-right tabular-nums">{won(r.adCost)}</td>
                    <td className="px-2 text-right tabular-nums">{won(r.bags)}</td>
                    <td className="px-2 text-right tabular-nums">{won(r.adBags)}</td>
                    <td className="px-2 text-right tabular-nums">{shareText(r.adShare)}</td>
                    <td className={`px-2 text-right tabular-nums ${tone(r.adProfit)}`}>{won(r.adProfit)}</td>
                    <td className="px-2 text-right tabular-nums">{r.p1 ? won(r.milkrun) : '—'}</td>
                    <td className={`px-2 text-right font-semibold tabular-nums ${tone(r.profit)}`}>{won(r.profit)}</td>
                    <td className="px-2"><span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] ${VERDICT_STYLE[r.verdict]}`}>{r.verdict}</span></td>
                    <td className="px-2" onClick={(e) => e.stopPropagation()}>
                      {!r.special && r.adCost > 0 && (
                        <Link href={`/coupang-tools/ad-analysis?alias=${encodeURIComponent(r.alias)}`} className="whitespace-nowrap text-blue-600 hover:underline">광고 보기 →</Link>
                      )}
                    </td>
                  </tr>
                  {isOpen && r.p3 && partRow('3P', r.p3, false)}
                  {isOpen && r.p1 && partRow('1P', r.p1, true)}
                </React.Fragment>
              )
            })}
          </tbody>
          <tfoot className="sticky bottom-0 bg-white">
            <tr className="border-t-2 text-gray-700">
              <td className="px-2 py-2 font-semibold" colSpan={10}>합계 ({shown.length}개{filter === '전체' ? ' = 3P 순이익 + 판매 기준 1P 순이익' : ''})</td>
              <td className={`px-2 text-right font-semibold tabular-nums ${tone(total)}`}>{won(total)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
