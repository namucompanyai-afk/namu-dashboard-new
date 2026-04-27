/**
 * marginView — 마진 마스터 단독 view 빌더
 *
 * 광고/SELLER 데이터 없이 마진 마스터(.xlsx) 파싱 결과만으로
 * "별칭 그룹별 옵션 카드 + 비용 분해" view 데이터를 생성.
 */

import type { CostMaster, MarginCalcRow, CostBookRow } from './parsers/marginMaster'

export interface MasterOptionView {
  optionId: string
  optionName: string
  exposureId: string
  alias: string
  channel: string         // "윙"/"그로스"
  size: string            // "극소"/"소"/"중"/"대형1"/""
  priceBand: string       // "9,900" 등
  bagCount: number
  kgPerBag: number
  actualPrice: number
  // 결과 (마진계산 P~AB)
  costPrice: number
  bagFee: number
  boxFee: number
  shipFee: number
  warehouseFee: number
  grossShipFee: number
  inoutFee: number
  coupangFee: number
  feeRate: number
  totalCost: number
  netProfit: number | null
  marginRate: number | null
  bepRoas: number | null
}

export interface MasterAliasGroup {
  alias: string
  exposureIds: string[]
  optionCount: number
  channels: string[]      // 이 그룹에 등장하는 채널 set
  options: MasterOptionView[]
  // 그룹 통계
  totalNetProfit: number  // 옵션 순이익 합 (1봉당)
  avgMarginRate: number   // 평균 마진율
  minNetProfit: number
  maxNetProfit: number
}

export interface MasterView {
  groups: MasterAliasGroup[]
  totalOptions: number
  totalChannels: { 윙: number; 그로스: number; other: number }
  loaded: boolean
}

function aliasFromMarginRow(row: MarginCalcRow, costBookByExp: Map<string, CostBookRow>): string {
  if (row.alias) return row.alias.trim()
  const cb = costBookByExp.get(row.exposureId)
  if (cb?.alias) return cb.alias.trim()
  return row.exposureId || row.optionId
}

/** (exposureId, optionId) 합성키 — 같은 옵션이 여러 노출에 걸쳐 등장해도 고유 식별 */
export function masterOptionKey(o: { exposureId: string; optionId: string }): string {
  return `${o.exposureId || '_'}|${o.optionId}`
}

export function buildMasterView(master: CostMaster | null): MasterView {
  if (!master) {
    return { groups: [], totalOptions: 0, totalChannels: { 윙: 0, 그로스: 0, other: 0 }, loaded: false }
  }

  const costBookByExp = new Map<string, CostBookRow>()
  for (const cb of master.costBook) costBookByExp.set(cb.exposureId, cb)

  const byAlias = new Map<string, MasterAliasGroup>()
  // 합성키(exposureId|optionId) 기준 dedupe — 마진계산 시트에 같은 행이 두 번 들어가도 1개만 유지
  const seenKeys = new Set<string>()
  let cntWing = 0, cntGrowth = 0, cntOther = 0

  for (const row of master.marginRows) {
    const alias = aliasFromMarginRow(row, costBookByExp)
    const exposureId = String(row.exposureId || '').trim()
    const optionId = String(row.optionId || '').trim()
    const key = `${exposureId || '_'}|${optionId}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    if (!byAlias.has(alias)) {
      byAlias.set(alias, {
        alias,
        exposureIds: [],
        optionCount: 0,
        channels: [],
        options: [],
        totalNetProfit: 0,
        avgMarginRate: 0,
        minNetProfit: Infinity,
        maxNetProfit: -Infinity,
      })
    }
    const g = byAlias.get(alias)!

    if (exposureId && !g.exposureIds.includes(exposureId)) {
      g.exposureIds.push(exposureId)
    }
    if (row.channel && !g.channels.includes(row.channel)) {
      g.channels.push(row.channel)
    }

    if (row.channel === '윙') cntWing++
    else if (row.channel === '그로스') cntGrowth++
    else cntOther++

    const opt: MasterOptionView = {
      optionId,
      optionName: row.optionName || `${row.kgPerBag}kg ${row.bagCount}개`,
      exposureId,
      alias,
      channel: row.channel || '',
      size: row.size || '',
      priceBand: row.priceBand || '',
      bagCount: row.bagCount,
      kgPerBag: row.kgPerBag,
      actualPrice: row.actualPrice,
      costPrice: row.costPrice,
      bagFee: row.bagFee,
      boxFee: row.boxFee,
      shipFee: row.shipFee,
      warehouseFee: row.warehouseFee,
      grossShipFee: row.grossShipFee,
      inoutFee: row.inoutFee,
      coupangFee: row.coupangFee,
      feeRate: row.feeRate,
      totalCost: row.totalCost,
      netProfit: row.netProfit,
      marginRate: row.marginRate,
      bepRoas: row.bepRoas,
    }
    g.options.push(opt)

    if (row.netProfit !== null) {
      g.totalNetProfit += row.netProfit
      if (row.netProfit < g.minNetProfit) g.minNetProfit = row.netProfit
      if (row.netProfit > g.maxNetProfit) g.maxNetProfit = row.netProfit
    }
  }

  // 그룹 정리: 옵션 정렬 + 평균 마진율 계산 + 다중 노출ID 그룹 옵션명 디스앰비규에이션
  const groups: MasterAliasGroup[] = []
  for (const g of byAlias.values()) {
    // 다중 노출ID 그룹은 옵션명 끝에 [노출ID 끝4자리] 추가해 시각적으로 구분
    // (그룹 exposureIds 가 어떻게 채워지든 안전하게 — 옵션 자체에 exposureId 가 있으면 멀티 여부 재계산)
    const distinctExpInGroup = new Set<string>()
    for (const opt of g.options) {
      if (opt.exposureId) distinctExpInGroup.add(opt.exposureId)
    }
    if (distinctExpInGroup.size > 1) {
      for (const opt of g.options) {
        if (opt.exposureId) {
          const suffix = opt.exposureId.slice(-4)
          opt.optionName = `${opt.optionName} [${suffix}]`
        }
      }
    }
    g.options.sort((a, b) => {
      // 채널 (그로스 우선) → kgPerBag → bagCount → exposureId
      const chanA = a.channel === '그로스' ? 0 : 1
      const chanB = b.channel === '그로스' ? 0 : 1
      if (chanA !== chanB) return chanA - chanB
      if (a.kgPerBag !== b.kgPerBag) return a.kgPerBag - b.kgPerBag
      if (a.bagCount !== b.bagCount) return a.bagCount - b.bagCount
      return a.exposureId.localeCompare(b.exposureId)
    })
    g.optionCount = g.options.length
    const validRates = g.options.map(o => o.marginRate).filter((r): r is number => r !== null)
    g.avgMarginRate = validRates.length > 0
      ? validRates.reduce((s, x) => s + x, 0) / validRates.length
      : 0
    if (g.minNetProfit === Infinity) g.minNetProfit = 0
    if (g.maxNetProfit === -Infinity) g.maxNetProfit = 0
    groups.push(g)
  }

  // 별칭 그룹은 평균 마진율 내림차순으로
  groups.sort((a, b) => b.avgMarginRate - a.avgMarginRate)

  const totalOptions = groups.reduce((s, g) => s + g.optionCount, 0)

  return {
    groups,
    totalOptions,
    totalChannels: { 윙: cntWing, 그로스: cntGrowth, other: cntOther },
    loaded: true,
  }
}
