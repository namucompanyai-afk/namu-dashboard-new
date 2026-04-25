/**
 * 상품 수익 진단 — 3중 손익 + 별칭 그룹화
 *
 * ──────────────────────────────────────────────────────────────
 * 핵심 변경점 (v2)
 *
 * 1) 광고매출 = 전환옵션 수량 × 실판매가
 *    - 검증 결과 쿠팡 광고 revenue14d는 100% 정가(VAT) 기준
 *    - 무프 옵션은 18% 부풀림 → 실판매가로 정확하게 보정
 *    - 광고비는 항상 집행옵션 기준 (돈 쓴 쪽)
 *    - 광고매출은 항상 전환옵션 기준 (실제 팔린 쪽)
 *
 * 2) 별칭 그룹화
 *    - 같은 별칭("[보배마을] 귀리") = 같은 상품
 *    - 노출ID가 여러 개여도 합산
 *    - 진단 결과는 "노출ID 단위"가 아니라 "별칭 단위"로 출력
 *
 * 3) 마진은 옵션별로 정확하게 (총합/총수량의 평균이 아님)
 *    - 각 옵션의 수량 × 옵션의 순이익 합산 → 진짜 마진
 *
 * ──────────────────────────────────────────────────────────────
 * 판정
 *   🟢 흑자:        광고도 흑자, 전체도 흑자
 *   🟡 함정:        광고는 적자, 오가닉이 받쳐서 전체 흑자
 *                  → 판매 중단 X, 광고만 최적화
 *   🔴 진짜적자:    광고도 적자, 전체도 적자
 *                  → 가격/원가/광고 다 재검토 필요
 *   ⚫ 판매없음:    매출과 광고비 모두 0
 *
 * ──────────────────────────────────────────────────────────────
 * 광고비 VAT
 *   쿠팡 광고비는 VAT 별도 청구 → ×1.1 처리
 *
 * 기간 보정
 *   광고 엑셀 기간 = 기준 기간. SELLER가 더 긴 기간이면 비례 환산.
 *   (예: 광고 30일 / SELLER 90일 → SELLER × 1/3)
 *   현재는 둘 다 30일이라 scale = 1
 */

import { getCostBook, getActualPrice, getMarginRow } from './costBook'
import type { AdCampaignRow } from './parsers/adCampaign'
import type { MarginCalcRow } from './parsers/marginMaster'

const AD_VAT_MULTIPLIER = 1.1

// ─────────────────────────────────────────────────────────────
// 입력 / 출력 타입
// ─────────────────────────────────────────────────────────────

/** SELLER_INSIGHTS에서 옵션별로 집계된 매출/수량 */
export interface SellerStat {
  optionId: string
  totalRevenue: number
  totalQuantity: number
}

export interface DiagnosisInput {
  /** SELLER 데이터 (옵션별 매출/수량) */
  sellerStats: SellerStat[]
  /** 광고 행들 */
  adRows: AdCampaignRow[]
  /** 광고 기간 (일수) */
  periodDays: number
  /** SELLER 기간 (일수) — 기본 30일 */
  sellerPeriodDays?: number
}

export type VerdictCode =
  | 'profitable'      // 🟢 흑자
  | 'trap'            // 🟡 함정
  | 'structural_loss' // 🔴 진짜적자
  | 'no_sales'        // ⚫ 판매없음

/** 별칭 그룹별 진단 결과 */
export interface ProductDiagnosis {
  /** 별칭 (그룹 키) */
  alias: string
  /** 이 별칭에 속한 노출ID들 */
  exposureIds: string[]
  /** 이 별칭에 속한 옵션들의 옵션ID */
  optionIds: string[]
  /** 옵션 수 */
  optionCount: number

  // ── 매출 (기준 기간) ──
  /** SELLER 전체 매출 */
  revenue: number
  /** SELLER 전체 수량 */
  sold: number
  /** 광고 귀속 매출 = sum(전환옵션 수량 × 실판매가) */
  adRevenue: number
  /** 광고 귀속 수량 */
  adSold: number
  /** 캠페인 매출 (참고용 = 집행옵션 기준) */
  campaignRevenue: number
  /** 오가닉 매출 = revenue - adRevenue */
  organicRevenue: number
  /** 오가닉 수량 = sold - adSold */
  organicSold: number

  // ── 비용 (기준 기간, VAT 포함) ──
  /** 총 광고비 (VAT 포함) */
  adCost: number

  // ── 마진 / 손익 ──
  /** 총 판매 마진 = sum(옵션 수량 × 옵션 순이익) */
  totalMargin: number
  /** 평균 마진 = totalMargin / sold */
  avgMargin: number
  /** 광고 귀속 마진 = adSold × avgMargin */
  adMargin: number
  /** 광고 순손익 = adMargin - adCost */
  adNetProfit: number
  /** 오가닉 순익 = (sold - adSold) × avgMargin */
  organicNetProfit: number
  /** 전체 순익 = totalMargin - adCost */
  totalNetProfit: number
  /** 마진율 = totalMargin / revenue */
  marginRate: number

  // ── 지표 ──
  /** ROAS (귀속) = adRevenue / adCost × 100 */
  adRoasAttr: number | null
  /** ROAS (집행) = campaignRevenue / adCost × 100 (참고) */
  adRoasCamp: number | null
  /** 교차판매 비중 = (campaignRevenue - adRevenue) / campaignRevenue × 100 */
  crossSellRate: number | null
  /** 광고 의존도 = adRevenue / revenue */
  adDependency: number

  // ── 판정 ──
  verdict: VerdictCode
  verdictLabel: string

  // ── 옵션별 상세 (드릴다운용) ──
  /** 옵션별 상세 진단. 같은 별칭 안의 옵션들 각각 */
  optionDetails?: OptionDiagnosis[]
}

/** 옵션 단위 진단 결과 — ProductDiagnosis 안에 들어감 */
export interface OptionDiagnosis {
  optionId: string
  optionName: string
  /** 옵션명에서 파싱한 봉투 개수 (정렬용) */
  bagCount: number

  revenue: number
  sold: number
  adRevenue: number
  adSold: number
  organicRevenue: number
  organicSold: number
  adCost: number

  totalMargin: number
  adMargin: number
  adNetProfit: number
  totalNetProfit: number
  marginRate: number
  adRoasAttr: number | null
  adDependency: number

  verdict: VerdictCode
  verdictLabel: string
}

export interface DiagnosisResult {
  products: ProductDiagnosis[]
  summary: {
    productCount: number
    totalRevenue: number
    totalAdRevenue: number
    totalOrganicRevenue: number
    totalAdCost: number
    totalMargin: number
    totalNetProfit: number
    marginRate: number
    adRoasAttr: number | null
    adDependency: number
    counts: Record<VerdictCode, number>
  }
  period: {
    days: number
    sellerScale: number
  }
  /** 매칭 누락 통계 (UI에서 경고 표시용) */
  unmatched: {
    /** SELLER에 있지만 마진계산 시트에 없는 옵션의 매출 합 */
    sellerRevenue: number
    /** 같은 광고비 합 */
    adCost: number
    /** 옵션 수 */
    optionCount: number
  }
  /** 광고/판매분석 기간 검증 (정상 비율: 광고매출/SELLER매출 = 40~90%) */
  periodValidation: {
    /** 광고 엑셀 광고매출 합계 (raw) */
    adRevenueRaw: number
    /** SELLER 매출 합계 (raw, scale 적용 전) */
    sellerRevenueRaw: number
    /** 비율 (0~1) */
    ratio: number
    /** 'ok' | 'too_high' | 'too_low' */
    status: 'ok' | 'too_high' | 'too_low'
    /** 정상 범위 */
    normalRange: { min: number; max: number }
  }
}

// ─────────────────────────────────────────────────────────────
// 메인 진단 함수
// ─────────────────────────────────────────────────────────────

export function diagnose(input: DiagnosisInput): DiagnosisResult {
  const { sellerStats, adRows, periodDays } = input
  const sellerPeriodDays = input.sellerPeriodDays ?? 30
  const sellerScale = sellerPeriodDays > 0 ? periodDays / sellerPeriodDays : 1

  // ── 기간 검증용 raw 합계 (scale 적용 전)
  const sellerRevenueRaw = sellerStats.reduce((sum, s) => sum + (s.totalRevenue || 0), 0)
  const adRevenueRaw = adRows.reduce((sum, r) => sum + (r.revenue14d || 0), 0)

  // 1) SELLER → 옵션별 매출/수량 맵 (기준 기간 환산)
  const sellerByOpt = new Map<string, { revenue: number; quantity: number }>()
  for (const s of sellerStats) {
    sellerByOpt.set(s.optionId, {
      revenue: s.totalRevenue * sellerScale,
      quantity: s.totalQuantity * sellerScale,
    })
  }

  // 2) 광고 → 옵션별 집계
  //    - adExecByOpt: 광고비 + 캠페인 매출 (집행옵션 기준)
  //    - adConvByOpt: 전환 매출 + 전환 수량 (전환옵션 기준)
  const adExecByOpt = new Map<string, { cost: number; campRevenue: number }>()
  const adConvByOpt = new Map<string, { sold: number }>()
  for (const r of adRows) {
    if (r.adOptionId) {
      const prev = adExecByOpt.get(r.adOptionId) ?? { cost: 0, campRevenue: 0 }
      prev.cost += (r.adCost ?? 0) * AD_VAT_MULTIPLIER
      prev.campRevenue += r.revenue14d ?? 0
      adExecByOpt.set(r.adOptionId, prev)
    }
    if (r.convOptionId) {
      const prev = adConvByOpt.get(r.convOptionId) ?? { sold: 0 }
      prev.sold += r.sold14d ?? 0
      adConvByOpt.set(r.convOptionId, prev)
    }
  }

  // 3) 마진 마스터에서 모든 옵션 가져와서 별칭별로 그룹화
  //    (정확히는 노출ID → 별칭으로 맵핑)
  type GroupAccum = {
    alias: string
    exposureIds: Set<string>
    optionIds: Set<string>
    revenue: number
    sold: number
    adRevenue: number
    adSold: number
    campaignRevenue: number
    adCost: number
    totalMargin: number
  }
  const groups = new Map<string, GroupAccum>()

  // 마진 마스터 옵션을 1차 인덱스로 사용 (별칭 알기 위해)
  // costBook 모듈에서 직접 참조할 수가 없으니, 옵션ID → 별칭 lookup 만들어야 함.
  // 다행히 getMarginRow 가 alias 직접 안 갖고 있어도 exposureId로 getCostBook → alias 가능.
  const knownOptIds = new Set<string>()

  // sellerStats + adExec/Conv 의 옵션들 모두 순회 (한 번이라도 등장한 옵션)
  const allOpts = new Set<string>()
  for (const s of sellerStats) allOpts.add(s.optionId)
  for (const oid of adExecByOpt.keys()) allOpts.add(oid)
  for (const oid of adConvByOpt.keys()) allOpts.add(oid)

  let unmatchedSellerRev = 0
  let unmatchedAdCost = 0
  const unmatchedOpts = new Set<string>()

  for (const optId of allOpts) {
    const marginRow = getMarginRow(optId)
    if (!marginRow) {
      // 마진 마스터에 없는 옵션 — 매칭 누락으로 카운트
      const seller = sellerByOpt.get(optId)
      const adExec = adExecByOpt.get(optId)
      if (seller) unmatchedSellerRev += seller.revenue
      if (adExec) unmatchedAdCost += adExec.cost
      unmatchedOpts.add(optId)
      continue
    }
    knownOptIds.add(optId)

    const cost = getCostBook(marginRow.exposureId)
    // alias 우선순위: costBook.alias > marginRow.alias (수식 결과)
    const alias = cost?.alias?.trim() || marginRow.alias?.trim() || marginRow.exposureId
    const groupKey = alias

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        alias,
        exposureIds: new Set(),
        optionIds: new Set(),
        revenue: 0,
        sold: 0,
        adRevenue: 0,
        adSold: 0,
        campaignRevenue: 0,
        adCost: 0,
        totalMargin: 0,
        // 옵션별 데이터 (드릴다운용)
        optionMap: new Map(),
      })
    }
    const g = groups.get(groupKey)!
    g.exposureIds.add(marginRow.exposureId)
    g.optionIds.add(optId)

    // 옵션별 누적 (옵션ID 기준)
    if (!g.optionMap.has(optId)) {
      g.optionMap.set(optId, {
        optionId: optId,
        optionName: marginRow.optionName || optId,
        netProfitPerUnit: marginRow.netProfit ?? 0,
        revenue: 0,
        sold: 0,
        adRevenue: 0,
        adSold: 0,
        adCost: 0,
        totalMargin: 0,
      })
    }
    const optAcc = g.optionMap.get(optId)!

    const seller = sellerByOpt.get(optId)
    if (seller) {
      g.revenue += seller.revenue
      g.sold += seller.quantity
      // 마진 = 수량 × 옵션의 순이익
      const netProfit = marginRow.netProfit ?? 0
      g.totalMargin += seller.quantity * netProfit
      // 옵션별
      optAcc.revenue += seller.revenue
      optAcc.sold += seller.quantity
      optAcc.totalMargin += seller.quantity * netProfit
    }

    const adExec = adExecByOpt.get(optId)
    if (adExec) {
      g.adCost += adExec.cost
      g.campaignRevenue += adExec.campRevenue
      optAcc.adCost += adExec.cost
    }

    const adConv = adConvByOpt.get(optId)
    if (adConv) {
      // 광고매출 = 전환 수량 × 실판매가
      const actualPrice = getActualPrice(optId) ?? marginRow.actualPrice ?? 0
      g.adRevenue += adConv.sold * actualPrice
      g.adSold += adConv.sold
      optAcc.adRevenue += adConv.sold * actualPrice
      optAcc.adSold += adConv.sold
    }
  }

  // 4) 그룹 → ProductDiagnosis 변환
  const products: ProductDiagnosis[] = []
  for (const g of groups.values()) {
    const organicRevenue = g.revenue - g.adRevenue
    const organicSold = g.sold - g.adSold
    const avgMargin = g.sold > 0 ? g.totalMargin / g.sold : 0
    const adMargin = g.adSold * avgMargin
    const adNetProfit = adMargin - g.adCost
    const organicNetProfit = organicSold * avgMargin
    const totalNetProfit = g.totalMargin - g.adCost
    const marginRate = g.revenue > 0 ? g.totalMargin / g.revenue : 0
    const adRoasAttr = g.adCost > 0 ? (g.adRevenue / g.adCost) * 100 : null
    const adRoasCamp = g.adCost > 0 ? (g.campaignRevenue / g.adCost) * 100 : null
    const crossSellRate = g.campaignRevenue > 0
      ? ((g.campaignRevenue - g.adRevenue) / g.campaignRevenue) * 100
      : null
    const adDependency = g.revenue > 0 ? g.adRevenue / g.revenue : 0

    let verdict: VerdictCode
    let verdictLabel: string
    if (g.revenue === 0 && g.adCost === 0) {
      verdict = 'no_sales'
      verdictLabel = '판매 없음'
    } else if (totalNetProfit > 0 && adNetProfit > 0) {
      verdict = 'profitable'
      verdictLabel = '🟢 흑자'
    } else if (totalNetProfit > 0 && adNetProfit <= 0) {
      verdict = 'trap'
      verdictLabel = '🟡 함정 (광고 적자 / 전체 흑자)'
    } else {
      verdict = 'structural_loss'
      verdictLabel = '🔴 진짜 적자'
    }

    // 옵션별 진단 변환 (드릴다운용)
    const optionDetails: OptionDiagnosis[] = Array.from(g.optionMap.values()).map((o: any) => {
      const optOrgRevenue = o.revenue - o.adRevenue
      const optOrgSold = o.sold - o.adSold
      const optAvgMargin = o.sold > 0 ? o.totalMargin / o.sold : 0
      const optAdMargin = o.adSold * optAvgMargin
      const optAdNetProfit = optAdMargin - o.adCost
      const optTotalNetProfit = o.totalMargin - o.adCost
      const optMarginRate = o.revenue > 0 ? o.totalMargin / o.revenue : 0
      const optAdRoasAttr = o.adCost > 0 ? (o.adRevenue / o.adCost) * 100 : null
      const optAdDependency = o.revenue > 0 ? o.adRevenue / o.revenue : 0
      // 봉투 개수 파싱: "X개" 또는 끝의 숫자
      const bagMatch = (o.optionName || '').match(/(\d+)\s*개/)
      const bagCount = bagMatch ? parseInt(bagMatch[1]) : 0

      let optVerdict: VerdictCode
      let optVerdictLabel: string
      if (o.revenue === 0 && o.adCost === 0) {
        optVerdict = 'no_sales'
        optVerdictLabel = '판매 없음'
      } else if (optTotalNetProfit > 0 && optAdNetProfit > 0) {
        optVerdict = 'profitable'
        optVerdictLabel = '🟢 흑자'
      } else if (optTotalNetProfit > 0 && optAdNetProfit <= 0) {
        optVerdict = 'trap'
        optVerdictLabel = '🟡 함정'
      } else {
        optVerdict = 'structural_loss'
        optVerdictLabel = '🔴 적자'
      }

      return {
        optionId: o.optionId,
        optionName: o.optionName,
        bagCount,
        revenue: o.revenue,
        sold: o.sold,
        adRevenue: o.adRevenue,
        adSold: o.adSold,
        organicRevenue: optOrgRevenue,
        organicSold: optOrgSold,
        adCost: o.adCost,
        totalMargin: o.totalMargin,
        adMargin: optAdMargin,
        adNetProfit: optAdNetProfit,
        totalNetProfit: optTotalNetProfit,
        marginRate: optMarginRate,
        adRoasAttr: optAdRoasAttr,
        adDependency: optAdDependency,
        verdict: optVerdict,
        verdictLabel: optVerdictLabel,
      }
    })
    // 봉투 개수 오름차순 정렬
    optionDetails.sort((a, b) => a.bagCount - b.bagCount || a.optionName.localeCompare(b.optionName))

    products.push({
      alias: g.alias,
      exposureIds: Array.from(g.exposureIds),
      optionIds: Array.from(g.optionIds),
      optionCount: g.optionIds.size,
      revenue: g.revenue,
      sold: g.sold,
      adRevenue: g.adRevenue,
      adSold: g.adSold,
      campaignRevenue: g.campaignRevenue,
      organicRevenue,
      organicSold,
      adCost: g.adCost,
      totalMargin: g.totalMargin,
      avgMargin,
      adMargin,
      adNetProfit,
      organicNetProfit,
      totalNetProfit,
      marginRate,
      adRoasAttr,
      adRoasCamp,
      crossSellRate,
      adDependency,
      verdict,
      verdictLabel,
      optionDetails,
    })
  }

  // 5) 정렬: 순이익 내림차순
  products.sort((a, b) => b.totalNetProfit - a.totalNetProfit)

  // 6) summary
  const totalRevenue = sum(products, 'revenue')
  const totalAdRevenue = sum(products, 'adRevenue')
  const totalOrganicRevenue = totalRevenue - totalAdRevenue
  const totalAdCost = sum(products, 'adCost')
  const totalMargin = sum(products, 'totalMargin')
  const totalNetProfit = totalMargin - totalAdCost
  const marginRateOverall = totalRevenue > 0 ? totalMargin / totalRevenue : 0
  const adRoasAttrOverall = totalAdCost > 0 ? (totalAdRevenue / totalAdCost) * 100 : null
  const adDependencyOverall = totalRevenue > 0 ? totalAdRevenue / totalRevenue : 0

  const counts: Record<VerdictCode, number> = {
    profitable: 0, trap: 0, structural_loss: 0, no_sales: 0,
  }
  for (const p of products) counts[p.verdict]++

  return {
    products,
    summary: {
      productCount: products.length,
      totalRevenue,
      totalAdRevenue,
      totalOrganicRevenue,
      totalAdCost,
      totalMargin,
      totalNetProfit,
      marginRate: marginRateOverall,
      adRoasAttr: adRoasAttrOverall,
      adDependency: adDependencyOverall,
      counts,
    },
    period: {
      days: periodDays,
      sellerScale,
    },
    unmatched: {
      sellerRevenue: unmatchedSellerRev,
      adCost: unmatchedAdCost,
      optionCount: unmatchedOpts.size,
    },
    periodValidation: (() => {
      const NORMAL_MIN = 0.40
      const NORMAL_MAX = 0.90
      const ratio = sellerRevenueRaw > 0 ? adRevenueRaw / sellerRevenueRaw : 0
      let status: 'ok' | 'too_high' | 'too_low' = 'ok'
      if (ratio > NORMAL_MAX) status = 'too_high'
      else if (ratio < NORMAL_MIN) status = 'too_low'
      return {
        adRevenueRaw,
        sellerRevenueRaw,
        ratio,
        status,
        normalRange: { min: NORMAL_MIN, max: NORMAL_MAX },
      }
    })(),
  }
}

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

function sum<T>(arr: T[], key: keyof T): number {
  return arr.reduce<number>((s, x) => s + (x[key] as unknown as number), 0)
}
