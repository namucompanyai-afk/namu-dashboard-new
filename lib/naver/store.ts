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

/** /api/naver-diagnoses 응답 메타 (목록 항목) */
export interface NaverSnapshotMeta {
  id?: string
  label?: string
  monthKey?: string | null
  weekKey?: string | null
  trendType?: 'weekly' | 'monthly' | null
  includeInTrend?: boolean
  period: { start: string; end: string }
  summary: NaverDiagnosisResult & { productOrderCount?: number }
  createdAt?: string
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

  /** 명시 저장된 분석 메타 목록 */
  snapshots: NaverSnapshotMeta[]
  snapshotsLoading: boolean

  setSettlement: (data: NaverSettlementData) => void
  setMarginData: (productMatch: Map<string, NaverProductMatch>, marginMap: NaverMarginMap) => void
  setManual: (manual: NaverManualInput) => void
  recompute: () => void
  loadFromApi: () => Promise<void>

  /** 자동 저장 (debounce 호출) — last 슬롯에 덮어쓰기 */
  saveLast: () => Promise<void>
  /** 명시 저장 — id 반환 */
  saveExplicit: (label: string) => Promise<string | null>
  /** 자동 explicit 저장 — trendType/monthKey/weekKey 자동 부착, 같은 키 있으면 덮어쓰기 */
  saveAuto: () => Promise<string | null>
  /** 저장된 분석 목록 로드 */
  loadList: () => Promise<void>
  /** 명시 저장 삭제 */
  deleteSnapshot: (id: string) => Promise<void>
  /** 전체 초기화 — purgeAll API + localStorage 정리 + reset */
  purgeAll: () => Promise<void>

  reset: () => void
}

/** 진단 기간으로부터 trendType 자동 판별 */
export function detectTrendType(start: string, end: string): 'weekly' | 'monthly' | 'custom' {
  if (!start || !end) return 'custom'
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
  if (days <= 7) return 'weekly'
  if (days <= 31) return 'monthly'
  return 'custom'
}

export function buildAutoKey(
  start: string,
  end: string,
  type: 'weekly' | 'monthly' | 'custom',
): string {
  if (type === 'monthly') return start.slice(0, 7)
  if (type === 'weekly') return `W-${start}`
  return `C-${start}-${end}`
}

export function buildAutoLabel(
  start: string,
  end: string,
  type: 'weekly' | 'monthly' | 'custom',
): string {
  if (type === 'monthly') return `${start.slice(0, 7)} 월별`
  if (type === 'weekly') return `${start.slice(5)} ~ ${end.slice(5)} 주별`
  return `${start} ~ ${end}`
}

export const useNaverStore = create<NaverStore>((set, get) => ({
  settlement: null,
  productMatch: null,
  marginMap: null,
  manual: { ...DEFAULT_MANUAL },
  diagnosis: null,
  marginLoading: false,
  marginMissing: false,
  snapshots: [],
  snapshotsLoading: false,

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

  saveAuto: async () => {
    const { diagnosis, settlement, snapshots } = get()
    if (!diagnosis) return null
    const { start, end } = diagnosis.period
    if (!start || !end) return null

    const trendType = detectTrendType(start, end)
    const key = buildAutoKey(start, end, trendType)
    const label = buildAutoLabel(start, end, trendType)

    const existing = snapshots.find(
      (s) =>
        (trendType === 'monthly' && s.monthKey === key) ||
        (trendType === 'weekly' && s.weekKey === key),
    )

    const snapshot = {
      ...buildSnapshot(diagnosis, settlement),
      label,
      monthKey: trendType === 'monthly' ? key : null,
      weekKey: trendType === 'weekly' ? key : null,
      trendType,
      includeInTrend: true,
      id: existing?.id,
    }

    try {
      const res = await fetch('/api/naver-diagnoses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'explicit', snapshot }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      await get().loadList()
      return (json?.id as string | undefined) ?? null
    } catch (e) {
      console.warn('스스 자동 explicit 저장 실패:', e)
      return null
    }
  },

  purgeAll: async () => {
    try {
      await fetch('/api/naver-diagnoses?purgeAll=1', { method: 'DELETE' })
    } catch (e) {
      console.warn('스스 전체 삭제 실패:', e)
    }
    if (typeof window !== 'undefined') {
      try {
        const keys: string[] = []
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i)
          if (k && k.startsWith('naver-manual-')) keys.push(k)
        }
        for (const k of keys) window.localStorage.removeItem(k)
      } catch {
        /* ignore */
      }
    }
    get().reset()
  },

  saveLast: async () => {
    const { diagnosis, settlement } = get()
    if (!diagnosis) return
    const snapshot = buildSnapshot(diagnosis, settlement)
    try {
      await fetch('/api/naver-diagnoses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'last', snapshot }),
      })
    } catch (e) {
      console.warn('스스 자동 저장 실패:', e)
    }
  },

  saveExplicit: async (label: string) => {
    const { diagnosis, settlement } = get()
    if (!diagnosis) return null
    const period = diagnosis.period
    const monthKey = period.start ? period.start.slice(0, 7) : null
    const snapshot = {
      ...buildSnapshot(diagnosis, settlement),
      label: label.trim() || undefined,
      monthKey,
    }
    try {
      const res = await fetch('/api/naver-diagnoses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'explicit', snapshot }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e?.error || `HTTP ${res.status}`)
      }
      const json = await res.json()
      const id = json?.id as string | undefined
      // 목록 갱신
      await get().loadList()
      return id ?? null
    } catch (e) {
      console.warn('스스 명시 저장 실패:', e)
      return null
    }
  },

  loadList: async () => {
    set({ snapshotsLoading: true })
    try {
      const res = await fetch('/api/naver-diagnoses?type=list')
      const json = await res.json()
      const list: NaverSnapshotMeta[] = Array.isArray(json?.diagnoses) ? json.diagnoses : []
      // createdAt 내림차순
      list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      set({ snapshots: list, snapshotsLoading: false })
    } catch (e) {
      console.warn('스스 분석 목록 로드 실패:', e)
      set({ snapshotsLoading: false })
    }
  },

  deleteSnapshot: async (id: string) => {
    try {
      await fetch(`/api/naver-diagnoses?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      set({ snapshots: get().snapshots.filter((s) => s.id !== id) })
    } catch (e) {
      console.warn('스스 분석 삭제 실패:', e)
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
      snapshots: [],
      snapshotsLoading: false,
    })
  },
}))

function buildSnapshot(
  diagnosis: NaverDiagnosisResult,
  settlement: NaverSettlementData | null,
) {
  return {
    period: diagnosis.period,
    summary: {
      revenue: diagnosis.revenue,
      settleAmount: diagnosis.settleAmount,
      settleFee: diagnosis.settleFee,
      cost: diagnosis.cost,
      bag: diagnosis.bag,
      box: diagnosis.box,
      pack: diagnosis.pack,
      shipReal: diagnosis.shipReal,
      shipRevenue: diagnosis.shipRevenue,
      adCost: diagnosis.adCost,
      netProfit: diagnosis.netProfit,
      productOrderCount: settlement?.productOrderCount ?? 0,
      matched: diagnosis.matched,
      unmatched: diagnosis.unmatched,
    },
    products: diagnosis.products,
  }
}
