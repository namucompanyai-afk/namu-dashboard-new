// 임시 디버그 라우트 — 검증 후 삭제 예정.
// multipart/form-data:
//   margin: 마진 마스터 엑셀
//   seller: 판매 분석 엑셀 (VENDOR_ITEM_METRICS)
//   ad:     쿠팡 광고 엑셀 (캠페인 리포트)
//
// 마진 마스터에 없는 옵션ID 를 SELLER + 광고 union 으로 찾아 echo.
// (옵션ID, 매출, 판매수, 광고비, 채널) — 매출 큰 순 정렬.

import { NextResponse } from 'next/server'
import { parseMarginMaster } from '@/lib/coupang/parsers/marginMaster'
import { parseSalesInsight } from '@/lib/coupang/parsers/salesInsight'
import { parseAdCampaign } from '@/lib/coupang/parsers/adCampaign'

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const marginFile = form.get('margin')
    const sellerFile = form.get('seller')
    const adFile = form.get('ad')

    if (!marginFile || typeof marginFile === 'string')
      return NextResponse.json({ error: 'margin 파일 누락' }, { status: 400 })
    if (!sellerFile || typeof sellerFile === 'string')
      return NextResponse.json({ error: 'seller 파일 누락' }, { status: 400 })
    if (!adFile || typeof adFile === 'string')
      return NextResponse.json({ error: 'ad 파일 누락' }, { status: 400 })

    const [marginBuf, sellerBuf, adBuf] = await Promise.all([
      (marginFile as File).arrayBuffer(),
      (sellerFile as File).arrayBuffer(),
      (adFile as File).arrayBuffer(),
    ])

    const marginParsed = parseMarginMaster(marginBuf)
    if (!marginParsed.master) {
      return NextResponse.json(
        { error: marginParsed.error || '마진 마스터 파싱 실패', warnings: marginParsed.warnings },
        { status: 422 },
      )
    }

    const sellerParsed = parseSalesInsight(sellerBuf)
    const adParsed = parseAdCampaign(adBuf, (adFile as File).name)

    // 마진 마스터 옵션ID 집합
    const marginIds = new Set<string>()
    for (const r of marginParsed.master.marginRows) {
      marginIds.add(String(r.optionId).trim())
    }

    // SELLER row → optionId 키
    const sellerByOpt = new Map<string, { revenue: number; sales: number; channel: string | null }>()
    for (const r of sellerParsed.rows) {
      const k = String(r.optionId).trim()
      if (!k) continue
      const prev = sellerByOpt.get(k)
      sellerByOpt.set(k, {
        revenue: (prev?.revenue ?? 0) + (r.revenue90d || 0),
        sales: (prev?.sales ?? 0) + (r.sales90d || 0),
        channel: r.channel ?? prev?.channel ?? null,
      })
    }

    // AD row → adOptionId 키 (광고비 귀속)
    const adByOpt = new Map<string, { adCost: number; campaigns: Set<string> }>()
    for (const r of adParsed.rows) {
      const k = String(r.adOptionId).trim()
      if (!k) continue
      const prev = adByOpt.get(k)
      const set = prev?.campaigns ?? new Set<string>()
      if (r.campaignName) set.add(r.campaignName)
      adByOpt.set(k, {
        adCost: (prev?.adCost ?? 0) + (r.adCost || 0),
        campaigns: set,
      })
    }

    // union (SELLER ∪ AD) − margin
    const allCandidates = new Set<string>([...sellerByOpt.keys(), ...adByOpt.keys()])
    const unmatched: Array<{
      optionId: string
      revenue: number
      sales: number
      adCost: number
      channel: string | null
      inSeller: boolean
      inAd: boolean
      campaigns: string[]
    }> = []

    for (const k of allCandidates) {
      if (marginIds.has(k)) continue
      const s = sellerByOpt.get(k)
      const a = adByOpt.get(k)
      unmatched.push({
        optionId: k,
        revenue: s?.revenue ?? 0,
        sales: s?.sales ?? 0,
        adCost: a?.adCost ?? 0,
        channel: s?.channel ?? null,
        inSeller: !!s,
        inAd: !!a,
        campaigns: a ? Array.from(a.campaigns).slice(0, 5) : [],
      })
    }

    unmatched.sort((x, y) => y.revenue - x.revenue)

    const totals = {
      unmatchedCount: unmatched.length,
      totalRevenue: unmatched.reduce((s, r) => s + r.revenue, 0),
      totalAdCost: unmatched.reduce((s, r) => s + r.adCost, 0),
      totalSales: unmatched.reduce((s, r) => s + r.sales, 0),
      onlyInSeller: unmatched.filter((r) => r.inSeller && !r.inAd).length,
      onlyInAd: unmatched.filter((r) => !r.inSeller && r.inAd).length,
      inBoth: unmatched.filter((r) => r.inSeller && r.inAd).length,
    }

    return NextResponse.json({
      files: {
        margin: (marginFile as File).name,
        seller: (sellerFile as File).name,
        ad: (adFile as File).name,
      },
      counts: {
        marginRows: marginParsed.master.marginRows.length,
        marginUniqueOptionIds: marginIds.size,
        sellerOptionIds: sellerByOpt.size,
        adOptionIds: adByOpt.size,
      },
      adPeriod: {
        startDate: adParsed.startDate,
        endDate: adParsed.endDate,
        periodDays: adParsed.periodDays,
      },
      warnings: marginParsed.warnings,
      totals,
      unmatched,
    })
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
  }
}
