import { create } from 'zustand'
import type { NaverSettlementData } from './parsers/settlement'
import type { NaverProductMatch } from './parsers/productMatch'
import type { NaverMarginMap, NaverMarginOption } from './marginNaver'
import {
  computeNaverDiagnosis,
  type NaverDiagnosisResult,
  type NaverManualInput,
} from './diagnosis'

const DEFAULT_MANUAL: NaverManualInput = {
  period: '',
  adCost: 0,
  shipSmall: { unit: 2243, count: 0 },
  shipMedium: { unit: 2943, count: 0 },
  shipLarge: { unit: 3443, count: 0 },
}

function manualKey(period: string): string {
  return `naver-manual-${period || 'default'}`
}

function loadManual(period: string): NaverManualInput {
  if (typeof window === 'undefined') return { ...DEFAULT_MANUAL, period }
  try {
    const raw = window.localStorage.getItem(manualKey(period))
    if (!raw) return { ...DEFAULT_MANUAL, period }
    const parsed = JSON.parse(raw) as Partial<NaverManualInput>
    return {
      ...DEFAULT_MANUAL,
      ...parsed,
      period,
      shipSmall: { ...DEFAULT_MANUAL.shipSmall, ...(parsed.shipSmall ?? {}) },
      shipMedium: { ...DEFAULT_MANUAL.shipMedium, ...(parsed.shipMedium ?? {}) },
      shipLarge: { ...DEFAULT_MANUAL.shipLarge, ...(parsed.shipLarge ?? {}) },
    }
  } catch {
    return { ...DEFAULT_MANUAL, period }
  }
}

function saveManual(manual: NaverManualInput) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(manualKey(manual.period), JSON.stringify(manual))
  } catch {
    // ignore quota
  }
}

/** "2026-04-30" → "2026-04" */
function periodFromDate(date: string | undefined): string {
  if (!date) return ''
  return date.slice(0, 7)
}

interface NaverStore {
  settlement: NaverSettlementData | null
  productMatch: Map<string, NaverProductMatch> | null
  marginMap: NaverMarginMap | null
  manual: NaverManualInput
  diagnosis: NaverDiagnosisResult | null
  /** 마진마스터 자동 fetch 진행 상태 */
  marginLoading: boolean
  /** 마진마스터 자동 fetch 끝났는데 저장된 데이터가 없음 */
  marginMissing: boolean

  setSettlement: (data: NaverSettlementData) => void
  setMarginData: (productMatch: Map<string, NaverProductMatch>, marginMap: NaverMarginMap) => void
  setManual: (manual: NaverManualInput) => void
  recompute: () => void
  loadFromApi: () => Promise<void>
  reset: () => void
}

export const useNaverStore = create<NaverStore>((set, get) => ({
  settlement: null,
  productMatch: null,
  marginMap: null,
  manual: { ...DEFAULT_MANUAL },
  diagnosis: null,
  marginLoading: false,
  marginMissing: false,

  setSettlement: (data) => {
    const period = periodFromDate(data.dateRange?.min)
    const manual = loadManual(period)
    set({ settlement: data, manual })
    get().recompute()
  },

  setMarginData: (productMatch, marginMap) => {
    set({ productMatch, marginMap })
    get().recompute()
  },

  setManual: (manual) => {
    saveManual(manual)
    set({ manual })
    get().recompute()
  },

  recompute: () => {
    const { settlement, productMatch, marginMap, manual } = get()
    if (!settlement || !productMatch || !marginMap) {
      set({ diagnosis: null })
      return
    }
    const diagnosis = computeNaverDiagnosis(settlement, productMatch, marginMap, manual)
    set({ diagnosis })
  },

  loadFromApi: async () => {
    if (get().productMatch && get().marginMap) return
    set({ marginLoading: true, marginMissing: false })
    try {
      const [matchRes, marginRes] = await Promise.all([
        fetch('/api/coupang-master?type=naver_match'),
        fetch('/api/coupang-master?type=naver_margin'),
      ])
      const matchJson = await matchRes.json()
      const marginJson = await marginRes.json()

      const matchData = matchJson?.data
      const marginData = marginJson?.data
      if (!matchData || !marginData) {
        set({ marginLoading: false, marginMissing: true })
        return
      }

      const productMatch = new Map<string, NaverProductMatch>(
        Object.entries(matchData) as [string, NaverProductMatch][],
      )
      const marginMap: NaverMarginMap = new Map<string, NaverMarginOption[]>()
      for (const [k, v] of Object.entries(marginData)) {
        if (Array.isArray(v)) marginMap.set(k, v as NaverMarginOption[])
      }
      set({ productMatch, marginMap, marginLoading: false, marginMissing: false })
      get().recompute()
    } catch (e) {
      console.warn('네이버 마진마스터 자동 로드 실패:', e)
      set({ marginLoading: false, marginMissing: true })
    }
  },

  reset: () => {
    set({
      settlement: null,
      productMatch: null,
      marginMap: null,
      manual: { ...DEFAULT_MANUAL },
      diagnosis: null,
      marginLoading: false,
      marginMissing: false,
    })
  },
}))
