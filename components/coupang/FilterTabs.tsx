'use client'

import type { CoupangOption } from '@/types/coupang'
import { useMarginStore } from '@/lib/coupang/store'

interface FilterTabsProps {
  options: CoupangOption[]
}

export function FilterTabs({ options }: FilterTabsProps) {
  const filter = useMarginStore((s) => s.filter)
  const setFilter = useMarginStore((s) => s.setFilter)

  const listingsByProduct = new Map<string, { growth: number; wing: number }>()
  for (const o of options) {
    const prev = listingsByProduct.get(o.productId) ?? { growth: 0, wing: 0 }
    if (o.channel === 'growth') prev.growth++
    else prev.wing++
    listingsByProduct.set(o.productId, prev)
  }

  let growthOnly = 0
  let wingOnly = 0
  let mixed = 0
  for (const { growth, wing } of listingsByProduct.values()) {
    if (growth > 0 && wing > 0) mixed++
    else if (growth > 0) growthOnly++
    else if (wing > 0) wingOnly++
  }

  const tabs: Array<{ key: typeof filter; label: string; count: number }> = [
    { key: 'all', label: '전체', count: listingsByProduct.size },
    { key: 'growth', label: '그로스만', count: growthOnly },
    { key: 'wing', label: '윙만', count: wingOnly },
    { key: 'mixed', label: '혼합 채널', count: mixed },
  ]

  return (
    <div className="flex gap-1 border-b border-gray-200">
      {tabs.map((t) => {
        const active = filter === t.key
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(t.key)}
            className={`relative flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
              active ? 'font-semibold text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {t.count}
            </span>
            {active && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gray-900" />
            )}
          </button>
        )
      })}
    </div>
  )
}

export function applyFilter(
  options: CoupangOption[],
  filter: 'all' | 'growth' | 'wing' | 'mixed',
): CoupangOption[] {
  if (filter === 'all') return options

  const stats = new Map<string, { growth: number; wing: number }>()
  for (const o of options) {
    const prev = stats.get(o.productId) ?? { growth: 0, wing: 0 }
    if (o.channel === 'growth') prev.growth++
    else prev.wing++
    stats.set(o.productId, prev)
  }

  return options.filter((o) => {
    const s = stats.get(o.productId)!
    if (filter === 'mixed') return s.growth > 0 && s.wing > 0
    if (filter === 'growth') return s.growth > 0 && s.wing === 0
    if (filter === 'wing') return s.wing > 0 && s.growth === 0
    return true
  })
}

export function WarningBanner() {
  const warnings = useMarginStore((s) => s.warnings)
  const items: Array<{ kind: 'warn' | 'info'; text: string }> = []

  if (warnings.growthUnmatchedInSettlement.length > 0) {
    items.push({
      kind: 'warn',
      text: `그로스 추정 ${warnings.growthUnmatchedInSettlement.length}개 옵션이 정산 엑셀에 없습니다. 비용 계산이 누락될 수 있습니다.`,
    })
  }
  if (warnings.salesOrphans.length > 0) {
    items.push({
      kind: 'info',
      text: `판매 분석 엑셀에만 있는 옵션 ${warnings.salesOrphans.length}개 (단종/품절 이력 추정). 계산에서 제외됨.`,
    })
  }
  if (warnings.settlementOrphans.length > 0) {
    items.push({
      kind: 'info',
      text: `정산 엑셀에만 있는 옵션 ${warnings.settlementOrphans.length}개. 현재 상품 엑셀에 없음.`,
    })
  }
  if (warnings.costUnmatched.length > 0) {
    items.push({
      kind: 'warn',
      text: `원가 엑셀에 있는 옵션 ${warnings.costUnmatched.length}개가 현재 쿠팡 옵션 목록에 없습니다. 옵션ID 오타 또는 단종 품목일 수 있습니다.`,
    })
  }

  if (items.length === 0) return null

  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div
          key={i}
          className={`rounded-xl border p-3 text-xs ${
            item.kind === 'warn'
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-gray-200 bg-gray-50 text-gray-600'
          }`}
        >
          {item.kind === 'warn' ? '⚠' : 'ⓘ'} {item.text}
        </div>
      ))}
    </div>
  )
}
