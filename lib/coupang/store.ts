/**
 * 마진 관리 + 상품 수익 진단 공유 상태
 *
 * 지금은 메모리 저장 (Supabase 이관은 다음 단계).
 *
 * ──────────────────────────────────────────────────────────────
 * v2 변경 사항
 *   - "원가 엑셀(costTable)" 슬롯 → "마진 마스터(marginMaster)" 슬롯으로 교체
 *   - 마진 마스터 = 마진분석.xlsx (3시트: 원가표 + 비용테이블 + 마진계산)
 *   - 진단 함수 새 시그니처에 맞게 호출 (sellerStats 입력)
 *
 * ──────────────────────────────────────────────────────────────
 * 업로드 슬롯 (5종)
 *   1) marginMaster (마진분석.xlsx) - 원가/실판매가/순이익
 *   2) priceInventory - 재고/판매가
 *   3) settlement - 그로스 정산
 *   4) salesInsight - 판매 데이터
 *   5) adCampaign - 광고
 *   (promotion - 무프, 차후 보정용)
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
import { matchOptions } from '@/lib/coupang'
import type { AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import type { CostMaster } from '@/lib/coupang/parsers/marginMaster'
import { setCostMaster, hasCostMaster } from '@/lib/coupang/costBook'
// promotion 무프 행 (parser는 차후 추가 예정)
type PromotionRow = unknown
import { diagnose, type DiagnosisResult, type SellerStat } from '@/lib/coupang/diagnosis'

type FilterTab = 'all' | 'growth' | 'wing' | 'mixed'

/** 진단 페이지 확장 업로드 상태 */
export interface ExtendedUploadStatus extends Omit<UploadStatus, 'costTable'> {
  marginMaster: UploadMeta | null
  adCampaign: UploadMeta | null
  promotion: UploadMeta | null
}

interface MarginStore {
  // ─────────── 원본 파싱 결과 ───────────
  rawPriceInventory: PriceInventoryRow[]
  rawSettlement: SettlementRow[]
  rawSalesInsight: SalesInsightRow[]
  /** 마진 마스터 (마진분석.xlsx) 파싱 결과 */
  marginMaster: CostMaster | null
  rawAdCampaign: AdCampaignRow[]
  rawPromotion: PromotionRow[]

  // ─────────── 계산 결과 ───────────
  /** 매칭된 옵션 리스트 (마진 관리 페이지가 씀) */
  options: CoupangOption[]
  /** 진단 결과 (4종 갖춰졌을 때 자동 계산) */
  diagnosisResult: DiagnosisResult | null

  // ─────────── 메타 ───────────
  uploads: ExtendedUploadStatus
  filter: FilterTab
  selectedOptionIds: Set<string>

  /** 광고 엑셀에서 파싱된 기준 기간 */
  adPeriod: { startDate: string; endDate: string; days: number } | null
  /** SELLER_INSIGHTS 기간 (일수) — 기본 30일, 사용자가 조정 가능 */
  sellerPeriodDays: number

  // ─────────── 경고 ───────────
  warnings: {
    growthUnmatchedInSettlement: string[]
    salesOrphans: string[]
    settlementOrphans: string[]
  }

  // ─────────── 통계 ───────────
  marginMasterStats: {
    loaded: boolean
    costBookRows: number
    marginRows: number
    optionsWithActualPrice: number
  }

  // ─────────── Actions — 엑셀 업로드 ───────────
  setPriceInventory: (rows: PriceInventoryRow[], meta: UploadMeta) => void
  setSettlement: (rows: SettlementRow[], meta: UploadMeta) => void
  setSalesInsight: (rows: SalesInsightRow[], meta: UploadMeta) => void
  /** 마진 마스터 엑셀 (마진분석.xlsx) */
  setMarginMaster: (master: CostMaster, meta: UploadMeta) => void
  setAdCampaign: (
    rows: AdCampaignRow[],
    meta: UploadMeta,
    period: { startDate: string; endDate: string; days: number } | null,
  ) => void
  setPromotion: (rows: PromotionRow[], meta: UploadMeta) => void

  // ─────────── Actions — 사용자 입력 ───────────
  updateOptionCost: (optionId: string, costPrice: number | null) => void
  deleteOption: (optionId: string) => void
  deleteOptionsByListingId: (listingId: string) => void
  setSellerPeriodDays: (days: number) => void

  // ─────────── Actions — UI ───────────
  setFilter: (tab: FilterTab) => void
  toggleSelect: (optionId: string) => void
  clearSelection: () => void
  deleteSelected: () => void

  reset: () => void
}

const emptyUploads: ExtendedUploadStatus = {
  priceInventory: null,
  settlement: null,
  salesInsight: null,
  marginMaster: null,
  adCampaign: null,
  promotion: null,
}

const emptyWarnings = {
  growthUnmatchedInSettlement: [],
  salesOrphans: [],
  settlementOrphans: [],
}

const emptyStats = {
  loaded: false,
  costBookRows: 0,
  marginRows: 0,
  optionsWithActualPrice: 0,
}

/**
 * 옵션 매칭 헬퍼 (마진 마스터 의존 X — 매칭만)
 */
function recomputeOptions(
  pi: PriceInventoryRow[],
  st: SettlementRow[],
  si: SalesInsightRow[],
  previousOptions: CoupangOption[],
): {
  options: CoupangOption[]
  warnings: MarginStore['warnings']
} {
  const m = matchOptions(pi, st, si, { previousOptions })
  return {
    options: m.options,
    warnings: {
      growthUnmatchedInSettlement: m.growthUnmatchedInSettlement,
      salesOrphans: m.salesOrphans,
      settlementOrphans: m.settlementOrphans,
    },
  }
}

/**
 * 진단 재계산 헬퍼.
 * 마진 마스터 + SELLER + 광고 + 광고기간 모두 있어야 돌림.
 */
function recomputeDiagnosis(
  salesInsight: SalesInsightRow[],
  adRows: AdCampaignRow[],
  adPeriod: { startDate: string; endDate: string; days: number } | null,
  sellerPeriodDays: number,
): DiagnosisResult | null {
  if (!hasCostMaster()) return null
  if (salesInsight.length === 0 || adRows.length === 0 || !adPeriod) return null

  // SalesInsightRow → SellerStat 변환
  const sellerStats: SellerStat[] = salesInsight.map((s) => ({
    optionId: s.optionId,
    totalRevenue: s.revenue90d,
    totalQuantity: s.sales90d,
  }))

  return diagnose({
    sellerStats,
    adRows,
    periodDays: adPeriod.days,
    sellerPeriodDays,
  })
}

export const useMarginStore = create<MarginStore>((set, get) => ({
  rawPriceInventory: [],
  rawSettlement: [],
  rawSalesInsight: [],
  marginMaster: null,
  rawAdCampaign: [],
  rawPromotion: [],
  options: [],
  diagnosisResult: null,
  uploads: emptyUploads,
  filter: 'all',
  selectedOptionIds: new Set(),
  adPeriod: null,
  sellerPeriodDays: 30,
  warnings: emptyWarnings,
  marginMasterStats: emptyStats,

  setPriceInventory: (rows, meta) => {
    const s = get()
    const result = recomputeOptions(rows, s.rawSettlement, s.rawSalesInsight, s.options)
    const diag = recomputeDiagnosis(s.rawSalesInsight, s.rawAdCampaign, s.adPeriod, s.sellerPeriodDays)
    set({
      rawPriceInventory: rows,
      options: result.options,
      uploads: { ...s.uploads, priceInventory: meta },
      warnings: result.warnings,
      diagnosisResult: diag,
    })
  },

  setSettlement: (rows, meta) => {
    const s = get()
    const result = recomputeOptions(s.rawPriceInventory, rows, s.rawSalesInsight, s.options)
    const diag = recomputeDiagnosis(s.rawSalesInsight, s.rawAdCampaign, s.adPeriod, s.sellerPeriodDays)
    set({
      rawSettlement: rows,
      options: result.options,
      uploads: { ...s.uploads, settlement: meta },
      warnings: result.warnings,
      diagnosisResult: diag,
    })
  },

  setSalesInsight: (rows, meta) => {
    const s = get()
    const result = recomputeOptions(s.rawPriceInventory, s.rawSettlement, rows, s.options)
    const diag = recomputeDiagnosis(rows, s.rawAdCampaign, s.adPeriod, s.sellerPeriodDays)
    set({
      rawSalesInsight: rows,
      options: result.options,
      uploads: { ...s.uploads, salesInsight: meta },
      warnings: result.warnings,
      diagnosisResult: diag,
    })
  },

  setMarginMaster: (master, meta) => {
    const s = get()
    // ★ 마진 마스터 주입 (전역 costBook 모듈에 저장)
    setCostMaster(master)
    const diag = recomputeDiagnosis(s.rawSalesInsight, s.rawAdCampaign, s.adPeriod, s.sellerPeriodDays)
    set({
      marginMaster: master,
      uploads: { ...s.uploads, marginMaster: meta },
      diagnosisResult: diag,
      marginMasterStats: {
        loaded: true,
        costBookRows: master.costBook.length,
        marginRows: master.marginRows.length,
        optionsWithActualPrice: master.marginRows.filter((r) => r.actualPrice > 0).length,
      },
    })
  },

  setAdCampaign: (rows, meta, period) => {
    const s = get()
    const nextSellerDays = period ? period.days : s.sellerPeriodDays
    // 광고 새로 올리면 SELLER도 비움 (기간 불일치 방지)
    const diag = recomputeDiagnosis([], rows, period, nextSellerDays)
    set({
      rawAdCampaign: rows,
      adPeriod: period,
      sellerPeriodDays: nextSellerDays,
      // SELLER 비움
      rawSalesInsight: [],
      uploads: { ...s.uploads, adCampaign: meta, salesInsight: null },
      diagnosisResult: diag,
    })
  },

  setPromotion: (rows, meta) => {
    const s = get()
    set({
      rawPromotion: rows,
      uploads: { ...s.uploads, promotion: meta },
    })
  },

  updateOptionCost: (optionId, costPrice) =>
    set((s) => {
      const newOptions = s.options.map((o) =>
        o.optionId === optionId ? { ...o, costPrice } : o,
      )
      return { options: newOptions }
    }),

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

  setSellerPeriodDays: (days) =>
    set((s) => {
      const safe = Math.max(1, Math.min(365, Math.round(days)))
      const diag = recomputeDiagnosis(s.rawSalesInsight, s.rawAdCampaign, s.adPeriod, safe)
      return { sellerPeriodDays: safe, diagnosisResult: diag }
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
    set((s) => {
      return {
        options: s.options.filter((o) => !s.selectedOptionIds.has(o.optionId)),
        selectedOptionIds: new Set(),
      }
    }),

  reset: () => {
    setCostMaster(null)
    set({
      rawPriceInventory: [],
      rawSettlement: [],
      rawSalesInsight: [],
      marginMaster: null,
      rawAdCampaign: [],
      rawPromotion: [],
      options: [],
      diagnosisResult: null,
      uploads: emptyUploads,
      filter: 'all',
      selectedOptionIds: new Set(),
      adPeriod: null,
      sellerPeriodDays: 30,
      warnings: emptyWarnings,
      marginMasterStats: emptyStats,
    })
  },
}))
