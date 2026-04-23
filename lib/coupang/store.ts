/**
 * 마진 관리 모듈 상태
 *
 * 지금은 메모리 저장 (Supabase는 다음 작업).
 *
 * 업로드 시 자동 처리:
 *  - 3종 엑셀 (price/settlement/sales) 재업로드 시 원가는 costTable이 있으면 자동 재적용
 *  - 원가 엑셀 업로드 시 모든 옵션의 costPrice 덮어쓰기 (사용자 선택: "엑셀이 소스 오브 트루스")
 *  - 수동 입력은 즉시 반영 (하지만 엑셀 재업로드 시 덮어씀)
 */

import { create } from 'zustand'
import type {
  CoupangOption,
  UploadStatus,
  UploadMeta,
  PriceInventoryRow,
  SettlementRow,
  SalesInsightRow,
} from '@/types/coupang'
import { matchOptions, applyCostTable } from '@/lib/coupang'
import type { CostRow } from '@/lib/coupang'

type FilterTab = 'all' | 'growth' | 'wing' | 'mixed'

interface MarginStore {
  // 원본 파싱 결과 (재매칭 시 필요)
  rawPriceInventory: PriceInventoryRow[]
  rawSettlement: SettlementRow[]
  rawSalesInsight: SalesInsightRow[]
  rawCostTable: CostRow[]

  // 계산된 옵션 리스트
  options: CoupangOption[]

  // 메타
  uploads: UploadStatus
  filter: FilterTab
  selectedOptionIds: Set<string>

  // 경고 수집
  warnings: {
    growthUnmatchedInSettlement: string[]
    salesOrphans: string[]
    settlementOrphans: string[]
    costUnmatched: string[]
  }

  // 원가 매칭 통계
  costStats: {
    matchedCount: number
    totalOptions: number
  }

  // Actions — 엑셀 업로드
  setPriceInventory: (rows: PriceInventoryRow[], meta: UploadMeta) => void
  setSettlement: (rows: SettlementRow[], meta: UploadMeta) => void
  setSalesInsight: (rows: SalesInsightRow[], meta: UploadMeta) => void
  setCostTable: (rows: CostRow[], meta: UploadMeta) => void

  // Actions — 사용자 입력
  updateOptionCost: (optionId: string, costPrice: number | null) => void
  deleteOption: (optionId: string) => void
  deleteOptionsByListingId: (listingId: string) => void

  // Actions — UI
  setFilter: (tab: FilterTab) => void
  toggleSelect: (optionId: string) => void
  clearSelection: () => void
  deleteSelected: () => void

  reset: () => void
}

const emptyUploads: UploadStatus = {
  priceInventory: null,
  settlement: null,
  salesInsight: null,
  costTable: null,
}

const emptyWarnings = {
  growthUnmatchedInSettlement: [],
  salesOrphans: [],
  settlementOrphans: [],
  costUnmatched: [],
}

/**
 * 재매칭 헬퍼.
 * price_inventory/settlement/sales_insight 중 하나가 바뀌면 전체 매칭 다시 돌림.
 * 그 후 rawCostTable이 있으면 자동 재적용.
 */
function recomputeOptions(
  pi: PriceInventoryRow[],
  st: SettlementRow[],
  si: SalesInsightRow[],
  costRows: CostRow[],
  previousOptions: CoupangOption[],
): {
  options: CoupangOption[]
  warnings: MarginStore['warnings']
  costStats: MarginStore['costStats']
} {
  const m = matchOptions(pi, st, si, { previousOptions })

  let options = m.options
  let costUnmatched: string[] = []
  let matchedCount = 0

  if (costRows.length > 0) {
    const applied = applyCostTable(options, costRows)
    options = applied.options
    matchedCount = applied.matchedCount
    costUnmatched = applied.unmatchedCostRows
  }

  return {
    options,
    warnings: {
      growthUnmatchedInSettlement: m.growthUnmatchedInSettlement,
      salesOrphans: m.salesOrphans,
      settlementOrphans: m.settlementOrphans,
      costUnmatched,
    },
    costStats: {
      matchedCount,
      totalOptions: options.length,
    },
  }
}

export const useMarginStore = create<MarginStore>((set, get) => ({
  rawPriceInventory: [],
  rawSettlement: [],
  rawSalesInsight: [],
  rawCostTable: [],
  options: [],
  uploads: emptyUploads,
  filter: 'all',
  selectedOptionIds: new Set(),
  warnings: emptyWarnings,
  costStats: { matchedCount: 0, totalOptions: 0 },

  setPriceInventory: (rows, meta) => {
    const { rawSettlement, rawSalesInsight, rawCostTable, options: prev } = get()
    const result = recomputeOptions(rows, rawSettlement, rawSalesInsight, rawCostTable, prev)
    set({
      rawPriceInventory: rows,
      options: result.options,
      uploads: { ...get().uploads, priceInventory: meta },
      warnings: result.warnings,
      costStats: result.costStats,
    })
  },

  setSettlement: (rows, meta) => {
    const { rawPriceInventory, rawSalesInsight, rawCostTable, options: prev } = get()
    const result = recomputeOptions(rawPriceInventory, rows, rawSalesInsight, rawCostTable, prev)
    set({
      rawSettlement: rows,
      options: result.options,
      uploads: { ...get().uploads, settlement: meta },
      warnings: result.warnings,
      costStats: result.costStats,
    })
  },

  setSalesInsight: (rows, meta) => {
    const { rawPriceInventory, rawSettlement, rawCostTable, options: prev } = get()
    const result = recomputeOptions(rawPriceInventory, rawSettlement, rows, rawCostTable, prev)
    set({
      rawSalesInsight: rows,
      options: result.options,
      uploads: { ...get().uploads, salesInsight: meta },
      warnings: result.warnings,
      costStats: result.costStats,
    })
  },

  setCostTable: (rows, meta) => {
    const { rawPriceInventory, rawSettlement, rawSalesInsight, options: prev } = get()
    const result = recomputeOptions(rawPriceInventory, rawSettlement, rawSalesInsight, rows, prev)
    set({
      rawCostTable: rows,
      options: result.options,
      uploads: { ...get().uploads, costTable: meta },
      warnings: result.warnings,
      costStats: result.costStats,
    })
  },

  updateOptionCost: (optionId, costPrice) =>
    set((s) => ({
      options: s.options.map((o) => (o.optionId === optionId ? { ...o, costPrice } : o)),
    })),

  deleteOption: (optionId) =>
    set((s) => {
      const next = new Set(s.selectedOptionIds)
      next.delete(optionId)
      return {
        options: s.options.filter((o) => o.optionId !== optionId),
        selectedOptionIds: next,
      }
    }),

  deleteOptionsByListingId: (listingId) =>
    set((s) => {
      const removed = new Set(
        s.options.filter((o) => o.listingId === listingId).map((o) => o.optionId),
      )
      const nextSelected = new Set(
        [...s.selectedOptionIds].filter((id) => !removed.has(id)),
      )
      return {
        options: s.options.filter((o) => o.listingId !== listingId),
        selectedOptionIds: nextSelected,
      }
    }),

  setFilter: (filter) => set({ filter }),

  toggleSelect: (optionId) =>
    set((s) => {
      const next = new Set(s.selectedOptionIds)
      if (next.has(optionId)) next.delete(optionId)
      else next.add(optionId)
      return { selectedOptionIds: next }
    }),

  clearSelection: () => set({ selectedOptionIds: new Set() }),

  deleteSelected: () =>
    set((s) => ({
      options: s.options.filter((o) => !s.selectedOptionIds.has(o.optionId)),
      selectedOptionIds: new Set(),
    })),

  reset: () =>
    set({
      rawPriceInventory: [],
      rawSettlement: [],
      rawSalesInsight: [],
      rawCostTable: [],
      options: [],
      uploads: emptyUploads,
      filter: 'all',
      selectedOptionIds: new Set(),
      warnings: emptyWarnings,
      costStats: { matchedCount: 0, totalOptions: 0 },
    }),
}))
