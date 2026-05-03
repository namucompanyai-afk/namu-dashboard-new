import { create } from 'zustand'
import type { NaverSettlementData } from './parsers/settlement'
import type { NaverOrderQueryData } from './parsers/orderQuery'
import type { NaverProductMatch } from './parsers/productMatch'
import type { NaverMarginMap, NaverMarginOption, NaverCpmConfig } from './marginNaver'
import {
  computeNaverDiagnosis,
  type NaverDiagnosisResult,
  type NaverManualInput,
} from './diagnosis'

const DEFAULT_MANUAL: NaverManualInput = {
  period: '',
  adCost: 0,
  cpmCount: 0,
  cpmDays: 0,
  shipSmall: { unit: 2243, count: 0 },
  shipMedium: { unit: 2943, count: 0 },
  shipLarge: { unit: 3443, count: 0 },
}

const DEFAULT_CPM: NaverCpmConfig = { unitPrice: 40700, baseDays: 10 }

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
  /** 주문조회 (옵션정보 + 수량) — diagnosis 정확 매칭용. PR2 부터 실제 사용. */
  orderQuery: NaverOrderQueryData | null
  orderQueryFileName: string
  orderQuerySavedAt: string | null
  productMatch: Map<string, NaverProductMatch> | null
  marginMap: NaverMarginMap | null
  cpmConfig: NaverCpmConfig
  manual: NaverManualInput
  diagnosis: NaverDiagnosisResult | null
  /** 마진마스터 자동 fetch 진행 상태 */
  marginLoading: boolean
  /** 마진마스터 자동 fetch 끝났는데 저장된 데이터가 없음 */
  marginMissing: boolean
  /** 마진마스터 fingerprint — naver_match.savedAt (변경 감지용) */
  marginSavedAt: string | null
  /** 정산파일명 (snapshot raw 메타용) */
  settlementFileName: string

  /** 명시 저장된 분석 메타 목록 */
  snapshots: NaverSnapshotMeta[]
  snapshotsLoading: boolean

  setSettlement: (data: NaverSettlementData, fileName?: string) => void
  setOrderQuery: (data: NaverOrderQueryData, fileName?: string) => void
  clearOrderQuery: () => void
  setMarginData: (productMatch: Map<string, NaverProductMatch>, marginMap: NaverMarginMap) => void
  setManual: (manual: NaverManualInput) => void
  recompute: () => void
  loadFromApi: () => Promise<void>

  /** 자동 저장 (debounce 호출) — last 슬롯에 덮어쓰기 */
  saveLast: () => Promise<void>
  /** 명시 저장 — id 반환. extra 로 monthKey/weekKey/trendType/includeInTrend/id 등 메타 부착 가능 */
  saveExplicit: (
    label: string,
    extra?: {
      monthKey?: string | null
      weekKey?: string | null
      trendType?: 'weekly' | 'monthly' | null
      includeInTrend?: boolean
      id?: string
    },
  ) => Promise<string | null>
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
  orderQuery: null,
  orderQueryFileName: '',
  orderQuerySavedAt: null,
  productMatch: null,
  marginMap: null,
  cpmConfig: { ...DEFAULT_CPM },
  manual: { ...DEFAULT_MANUAL },
  diagnosis: null,
  marginLoading: false,
  marginMissing: false,
  marginSavedAt: null,
  settlementFileName: '',
  snapshots: [],
  snapshotsLoading: false,

  setSettlement: (data, fileName) => {
    const period = periodFromDate(data.dateRange?.min)
    const manual = loadManual(period)
    set({ settlement: data, manual, settlementFileName: fileName ?? '' })
    get().recompute()
  },

  setOrderQuery: (data, fileName) => {
    set({
      orderQuery: data,
      orderQueryFileName: fileName ?? '',
      orderQuerySavedAt: new Date().toISOString(),
    })
    // PR3 에서 diagnosis 가 orderQuery 를 활용 — 일단 in-memory 만 보관
    get().recompute()
  },

  clearOrderQuery: () => {
    set({ orderQuery: null, orderQueryFileName: '', orderQuerySavedAt: null })
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
      const [matchRes, marginRes, cpmRes] = await Promise.all([
        fetch('/api/coupang-master?type=naver_match'),
        fetch('/api/coupang-master?type=naver_margin'),
        fetch('/api/coupang-master?type=naver_cpm'),
      ])
      const matchJson = await matchRes.json()
      const marginJson = await marginRes.json()
      const cpmJson = await cpmRes.json().catch(() => null)

      const matchData = matchJson?.data
      const marginData = marginJson?.data
      const marginSavedAt = (matchJson?.savedAt ?? marginJson?.savedAt ?? null) as string | null
      if (!matchData || !marginData) {
        set({ marginLoading: false, marginMissing: true, marginSavedAt })
        return
      }

      const productMatch = new Map<string, NaverProductMatch>(
        Object.entries(matchData) as [string, NaverProductMatch][],
      )
      const marginMap: NaverMarginMap = new Map<string, NaverMarginOption[]>()
      for (const [k, v] of Object.entries(marginData)) {
        if (Array.isArray(v)) marginMap.set(k, v as NaverMarginOption[])
      }
      const cpmData = cpmJson?.data as Partial<NaverCpmConfig> | null
      const cpmConfig: NaverCpmConfig = {
        unitPrice: cpmData?.unitPrice ?? DEFAULT_CPM.unitPrice,
        baseDays: cpmData?.baseDays ?? DEFAULT_CPM.baseDays,
      }
      set({
        productMatch,
        marginMap,
        cpmConfig,
        marginLoading: false,
        marginMissing: false,
        marginSavedAt,
      })
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

    const stateAuto = get()
    const snapshot = {
      ...buildSnapshot(
        diagnosis,
        settlement,
        stateAuto.manual,
        stateAuto.cpmConfig,
        stateAuto.marginSavedAt,
        stateAuto.settlementFileName,
      ),
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
    const s = get()
    if (!s.diagnosis) return
    const snapshot = buildSnapshot(
      s.diagnosis,
      s.settlement,
      s.manual,
      s.cpmConfig,
      s.marginSavedAt,
      s.settlementFileName,
    )
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

  saveExplicit: async (label, extra) => {
    const s = get()
    if (!s.diagnosis) return null
    const snapshot = {
      ...buildSnapshot(
        s.diagnosis,
        s.settlement,
        s.manual,
        s.cpmConfig,
        s.marginSavedAt,
        s.settlementFileName,
      ),
      label: label.trim() || undefined,
      monthKey: extra?.monthKey ?? null,
      weekKey: extra?.weekKey ?? null,
      trendType: extra?.trendType ?? null,
      includeInTrend: extra?.includeInTrend ?? false,
      id: extra?.id,
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
      orderQuery: null,
      orderQueryFileName: '',
      orderQuerySavedAt: null,
      productMatch: null,
      marginMap: null,
      cpmConfig: { ...DEFAULT_CPM },
      manual: { ...DEFAULT_MANUAL },
      diagnosis: null,
      marginLoading: false,
      marginMissing: false,
      marginSavedAt: null,
      settlementFileName: '',
      snapshots: [],
      snapshotsLoading: false,
    })
  },
}))

function buildSnapshot(
  diagnosis: NaverDiagnosisResult,
  settlement: NaverSettlementData | null,
  manual: NaverManualInput,
  cpmConfig: NaverCpmConfig,
  marginSavedAt: string | null,
  settlementFileName: string,
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
      unmatchedRevenue: diagnosis.unmatchedRevenue,
      totalBags: diagnosis.totalBags,
      productFeeRate: diagnosis.productFeeRate,
      shipFeeRate: diagnosis.shipFeeRate,
    },
    // 명시적으로 alias 포함해서 저장 (frozen view 시 별칭 그룹화에 사용)
    products: diagnosis.products.map((p) => ({
      productName: p.productName,
      alias: p.alias ?? '',
      count: p.count,
      revenue: p.revenue,
      cost: p.cost,
      profit: p.profit,
      matched: p.matched,
    })),
    // Raw — frozen view 재계산용 (마진마스터 최신 버전 + 그 시점 manual/cpm 결합)
    raw: {
      settlementRows: settlement?.rows ?? [],
      manual,
      cpmConfig,
      marginFingerprint: marginSavedAt ?? '',
      fileName: settlementFileName,
    },
  }
}
