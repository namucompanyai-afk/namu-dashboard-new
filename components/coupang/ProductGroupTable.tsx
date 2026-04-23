'use client'

import { useState } from 'react'
import type { CoupangOption } from '@/types/coupang'
import {
  enrichOption,
  groupByProduct,
  formatKrw,
  formatKrwShort,
} from '@/lib/coupang'
import {
  ChannelBadge,
  WinnerRateCell,
  MarginRateCell,
  BepRoasCell,
  aggregateChannel,
} from './atoms'
import { CostCell } from './CostCell'
import { useMarginStore } from '@/lib/coupang/store'

interface ProductGroupTableProps {
  options: CoupangOption[]
}

export function ProductGroupTable({ options }: ProductGroupTableProps) {
  const groups = groupByProduct(options)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const selectedIds = useMarginStore((s) => s.selectedOptionIds)
  const toggleSelect = useMarginStore((s) => s.toggleSelect)
  const updateCost = useMarginStore((s) => s.updateOptionCost)
  const deleteOption = useMarginStore((s) => s.deleteOption)
  const deleteByListing = useMarginStore((s) => s.deleteOptionsByListingId)

  const toggle = (productId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      return next
    })

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center shadow-sm">
        <div className="mb-2 text-3xl">📊</div>
        <p className="text-sm text-gray-400">엑셀을 업로드하면 상품 목록이 여기에 표시됩니다</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="w-10 border-b border-gray-100 px-3 py-2.5"></th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 text-left text-xs font-semibold text-gray-400">
                상품 (노출상품ID)
              </th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 text-right text-xs font-semibold text-gray-400">
                옵션수
              </th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 text-right text-xs font-semibold text-gray-400">
                평균 마진율
              </th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 text-right text-xs font-semibold text-gray-400">
                평균 BEP ROAS
              </th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 text-right text-xs font-semibold text-gray-400">
                90일 매출
              </th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 text-right text-xs font-semibold text-gray-400">
                월 환산 매출
              </th>
              <th className="whitespace-nowrap border-b border-gray-100 px-4 py-2.5 pr-5 text-right text-xs font-semibold text-gray-400">
                월 건수
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const isOpen = expanded.has(group.productId)
              return (
                <>
                  <tr
                    key={group.productId}
                    onClick={() => toggle(group.productId)}
                    className="cursor-pointer border-b border-gray-50 transition-colors hover:bg-gray-50"
                  >
                    <td className="px-3 py-3">
                      <span
                        className={`inline-block text-[10px] text-gray-400 transition-transform ${
                          isOpen ? 'rotate-90' : ''
                        }`}
                      >
                        ▶
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">
                          {group.name}
                        </span>
                        {group.hasSplitListings && (
                          <span
                            title={`등록상품ID ${group.listingCount}개로 분산 — 쿠팡 문의 필요`}
                            className="rounded-lg border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600"
                          >
                            ⚠ 분산 {group.listingCount}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-400">
                        ID {group.productId} · 그로스 {group.growthCount} + 윙{' '}
                        {group.wingCount}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-700">
                      {group.optionCount}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <MarginRateCell rate={group.avgMarginRate} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <BepRoasCell roas={group.avgBepRoas} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-700">
                      ₩{formatKrwShort(group.revenue90d)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-700">
                      ₩{formatKrwShort(group.monthlyRevenue)}
                    </td>
                    <td className="px-4 py-3 pr-5 text-right font-mono text-xs text-gray-700">
                      {formatKrw(group.monthlySales)}
                    </td>
                  </tr>

                  {isOpen && (
                    <tr key={`${group.productId}-exp`} className="bg-gray-50">
                      <td colSpan={8} className="p-0">
                        <OptionDetailTable
                          options={group.options}
                          selectedIds={selectedIds}
                          onToggleSelect={toggleSelect}
                          onUpdateCost={updateCost}
                          onDeleteOption={deleteOption}
                          onDeleteListing={deleteByListing}
                        />
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Option detail (expanded)
// ─────────────────────────────────────────────────────────────
interface OptionDetailTableProps {
  options: ReturnType<typeof enrichOption>[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onUpdateCost: (id: string, cost: number | null) => void
  onDeleteOption: (id: string) => void
  onDeleteListing: (listingId: string) => void
}

function OptionDetailTable({
  options,
  selectedIds,
  onToggleSelect,
  onUpdateCost,
  onDeleteOption,
  onDeleteListing,
}: OptionDetailTableProps) {
  const byListing = new Map<string, typeof options>()
  for (const opt of options) {
    const arr = byListing.get(opt.listingId) ?? []
    arr.push(opt)
    byListing.set(opt.listingId, arr)
  }

  return (
    <div className="space-y-3 p-4">
      {[...byListing].map(([listingId, opts]) => (
        <div
          key={listingId}
          className="overflow-hidden rounded-xl border border-gray-200 bg-white"
        >
          <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>등록상품ID</span>
              <span className="font-mono text-gray-700">{listingId}</span>
              <ChannelBadge channel={aggregateChannel(opts)} />
              <span className="text-gray-300">·</span>
              <span>{opts.length}개 옵션</span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (confirm(`${listingId}의 옵션 ${opts.length}개를 모두 삭제하시겠어요?`)) {
                  onDeleteListing(listingId)
                }
              }}
              className="rounded-lg border border-red-100 px-2 py-0.5 text-[10px] text-red-400 transition-colors hover:border-red-200 hover:bg-red-50"
            >
              등록상품 삭제
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="w-8 p-2"></th>
                  <th className="p-2 text-left text-[10px] font-semibold text-gray-400">
                    옵션명
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    위너
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    판매가
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    원가
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    쿠팡비
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    물류비
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    순마진
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    마진율
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    BEP ROAS
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    90일
                  </th>
                  <th className="p-2 text-right text-[10px] font-semibold text-gray-400">
                    월 마진
                  </th>
                  <th className="w-10 p-2"></th>
                </tr>
              </thead>
              <tbody>
                {opts.map((o) => {
                  const logistics = (o.warehousingFee ?? 0) + (o.shippingFee ?? 0)
                  const netClass =
                    o.netMargin != null && o.netMargin > 0
                      ? 'text-emerald-600'
                      : o.netMargin != null
                        ? 'text-red-500'
                        : 'text-gray-300'
                  return (
                    <tr
                      key={o.optionId}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                    >
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(o.optionId)}
                          onChange={() => onToggleSelect(o.optionId)}
                          className="cursor-pointer accent-emerald-600"
                        />
                      </td>
                      <td className="p-2">
                        <div className="text-xs text-gray-900">{o.optionName}</div>
                        <div className="font-mono text-[10px] text-gray-400">
                          {o.optionId}
                        </div>
                      </td>
                      <td className="p-2 text-right">
                        <WinnerRateCell rate={o.winnerRate} />
                      </td>
                      <td className="p-2 text-right font-mono text-gray-700">
                        {formatKrw(o.sellingPrice)}
                      </td>
                      <td className="p-2 text-right">
                        <CostCell
                          value={o.costPrice}
                          onChange={(v) => onUpdateCost(o.optionId, v)}
                        />
                      </td>
                      <td className="p-2 text-right font-mono text-gray-500">
                        {formatKrw(o.coupangFee)}
                      </td>
                      <td className="p-2 text-right font-mono text-gray-500">
                        {o.channel === 'growth' ? formatKrw(logistics) : '—'}
                      </td>
                      <td className={`p-2 text-right font-mono font-bold ${netClass}`}>
                        {o.netMargin != null ? formatKrw(o.netMargin) : '—'}
                      </td>
                      <td className="p-2 text-right">
                        <MarginRateCell rate={o.marginRate} />
                      </td>
                      <td className="p-2 text-right">
                        <BepRoasCell roas={o.bepRoas} />
                      </td>
                      <td className="p-2 text-right font-mono text-gray-600">
                        {o.sales90d != null ? formatKrw(o.sales90d) : '—'}
                      </td>
                      <td className="p-2 text-right font-mono text-gray-600">
                        {o.monthlyMargin != null ? formatKrw(o.monthlyMargin) : '—'}
                      </td>
                      <td className="p-2 text-right">
                        <button
                          type="button"
                          onClick={() => onDeleteOption(o.optionId)}
                          title="옵션 삭제"
                          className="rounded px-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
