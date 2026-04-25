'use client'
import { hasCostMaster, setCostMaster } from '@/lib/coupang/costBook'

/**
 * 쿠팡 수익 진단 페이지
 *
 * 핵심 표시:
 *   1) 마진 마스터 미로드 시 → "데이터 관리"로 이동 안내
 *   2) 광고 + 판매분석 업로드 → 자동 진단
 *   3) 별칭 단위로 그룹화 (같은 별칭 = 같은 상품)
 *   4) 광고매출은 전환옵션 × 실판매가
 *
 * 매번 업로드: 광고, 판매분석 (자주 바뀜)
 * 저장 데이터: 마진 마스터, 그로스 정산 (별도 "데이터 관리" 페이지)
 */

import React, { useState, useMemo, useEffect } from 'react'
import { useMarginStore } from '@/lib/coupang/store'
import type { ProductDiagnosis, VerdictCode, DiagnosisResult, OptionDiagnosis } from '@/lib/coupang/diagnosis'
import { diagnose } from '@/lib/coupang/diagnosis'
import { parseSalesInsight } from '@/lib/coupang/parsers/salesInsight'
import { parseAdCampaign } from '@/lib/coupang/parsers/adCampaign'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'

// ─────────────────────────────────────────────────────────────
// 색상/스타일
// ─────────────────────────────────────────────────────────────

const VERDICT_STYLES: Record<VerdictCode, { dot: string; bg: string; text: string; label: string }> = {
  profitable:      { dot: '🟢', bg: 'bg-green-50',  text: 'text-green-700',  label: '흑자' },
  trap:            { dot: '🟡', bg: 'bg-yellow-50', text: 'text-yellow-700', label: '함정' },
  structural_loss: { dot: '🔴', bg: 'bg-red-50',    text: 'text-red-700',    label: '진짜 적자' },
  no_sales:        { dot: '⚫', bg: 'bg-gray-50',   text: 'text-gray-500',   label: '판매 없음' },
}

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────

function formatKRW(n: number): string {
  return Math.round(n).toLocaleString() + '원'
}

function formatMan(n: number, withSign = false): string {
  const v = Math.round(n / 10000)
  return (withSign && v >= 0 ? '+' : '') + v.toLocaleString() + '만'
}

function formatPct(n: number | null, digits = 0): string {
  if (n == null) return '–'
  return n.toFixed(digits) + '%'
}

// ─────────────────────────────────────────────────────────────
// 메인 컴포넌트
// ─────────────────────────────────────────────────────────────

export default function DiagnosisPage() {
  const {
    marginMaster, marginMasterStats, uploads,
    rawSalesInsight, rawAdCampaign, adPeriod,
    diagnosisResult,
    setSalesInsight, setAdCampaign,
    setMarginMaster, setSettlement, setPriceInventory,
    reset,
  } = useMarginStore()

  const [verdictFilter, setVerdictFilter] = useState<VerdictCode | 'all'>('all')
  const [selectedAlias, setSelectedAlias] = useState<string>('__ALL__')
  const [autoLoading, setAutoLoading] = useState(true)

  // Supabase에서 마스터 데이터 자동 로드 (마진 마스터 없으면)
  useEffect(() => {
    if (marginMaster) {
      setAutoLoading(false)
      return
    }
    ;(async () => {
      try {
        const masterRes = await fetch('/api/coupang-master?type=margin_master')
        const masterJson = await masterRes.json()
        if (masterJson.data) {
          setMarginMaster(masterJson.data, {
            fileName: masterJson.fileName || '저장된 데이터',
            uploadedAt: masterJson.savedAt || new Date().toISOString(),
            rowCount: masterJson.data?.marginRows?.length || 0,
          })
        }

        const settleRes = await fetch('/api/coupang-master?type=settlement')
        const settleJson = await settleRes.json()
        if (settleJson.data?.rows) {
          setSettlement(settleJson.data.rows, {
            fileName: settleJson.fileName || '저장된 데이터',
            uploadedAt: settleJson.savedAt || new Date().toISOString(),
            rowCount: settleJson.data.rows.length,
          })
        }

        const priceRes = await fetch('/api/coupang-master?type=price_inventory')
        const priceJson = await priceRes.json()
        if (priceJson.data?.rows) {
          setPriceInventory(priceJson.data.rows, {
            fileName: priceJson.fileName || '저장된 데이터',
            uploadedAt: priceJson.savedAt || new Date().toISOString(),
            rowCount: priceJson.data.rows.length,
          })
        }

        // 명시 저장된 분석 목록 먼저 가져오기
        const listRes = await fetch('/api/coupang-diagnoses?type=list')
        const listJson = await listRes.json()
        if (listJson?.diagnoses) {
          setSavedAnalyses(listJson.diagnoses)
        }

        // 가장 최근 주차 분석을 자동 로드
        const all = listJson?.diagnoses || []
        const weeklies = all
          .filter((a: any) => a.weekKey && a._hasRaw)
          .sort((a: any, b: any) => (b.weekKey || '').localeCompare(a.weekKey || ''))

        const meta = weeklies[0]
        let target: any = null
        if (meta?.id) {
          const itemRes = await fetch(`/api/coupang-diagnoses?type=item&id=${meta.id}`)
          target = await itemRes.json()
        }
        if (target) {
          setAdCampaign(target.adRows, {
            fileName: target.adFileName || '저장된 분석',
            uploadedAt: target.createdAt || new Date().toISOString(),
            rowCount: target.adRows.length,
          }, target.periodStartDate && target.periodEndDate ? {
            startDate: target.periodStartDate,
            endDate: target.periodEndDate,
            days: target.periodDays || 30,
          } : null)
          setSalesInsight(target.sellerStats, {
            fileName: target.sellerFileName || '저장된 분석',
            uploadedAt: target.createdAt || new Date().toISOString(),
            rowCount: target.sellerStats.length,
          })
        }
      } catch (err) {
        console.error('자동 로드 실패:', err)
      } finally {
        setAutoLoading(false)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────
  // 마이그레이션: products 필드 없는 분석 자동 채우기
  // 옛날에 저장된 분석은 products 없음 → 상품별 그래프 안 됨
  // ─────────────────────────────────────────────────────────────
  // 마이그레이션 useEffect는 savedAnalyses 선언 이후로 이동됨

  // 필터된 상품 목록
  const filteredProducts = useMemo(() => {
    if (!diagnosisResult) return []
    if (verdictFilter === 'all') return diagnosisResult.products
    return diagnosisResult.products.filter((p) => p.verdict === verdictFilter)
  }, [diagnosisResult, verdictFilter])

  // 상품별 필터 적용된 진단 결과 (KPI/그래프용)
  const displayResult = useMemo(() => {
    if (!diagnosisResult) return null
    if (selectedAlias === '__ALL__') return diagnosisResult

    const filtered = diagnosisResult.products.filter(p => p.alias === selectedAlias)
    if (filtered.length === 0) return diagnosisResult

    // 선택된 상품들의 합계로 summary 재계산
    const totalRevenue = filtered.reduce((s, p) => s + p.revenue, 0)
    const totalAdRevenue = filtered.reduce((s, p) => s + p.adRevenue, 0)
    const totalOrganicRevenue = totalRevenue - totalAdRevenue
    const totalAdCost = filtered.reduce((s, p) => s + p.adCost, 0)
    const totalMargin = filtered.reduce((s, p) => s + p.totalMargin, 0)
    const totalNetProfit = totalMargin - totalAdCost
    const marginRate = totalRevenue > 0 ? totalMargin / totalRevenue : 0
    const adRoasAttr = totalAdCost > 0 ? (totalAdRevenue / totalAdCost) * 100 : null
    const adDependency = totalRevenue > 0 ? totalAdRevenue / totalRevenue : 0

    const counts = { profitable: 0, trap: 0, structural_loss: 0, no_sales: 0 }
    for (const p of filtered) counts[p.verdict]++

    return {
      ...diagnosisResult,
      products: filtered,
      summary: {
        ...diagnosisResult.summary,
        totalRevenue,
        totalAdRevenue,
        totalOrganicRevenue,
        totalAdCost,
        totalMargin,
        totalNetProfit,
        marginRate,
        adRoasAttr,
        adDependency,
        productCount: filtered.length,
        counts,
      },
    }
  }, [diagnosisResult, selectedAlias])

  // ─────────────────────────────────────────────────────────────
  // 진단 결과 자동 저장 (마지막 분석)
  // 진단 결과가 바뀔 때마다 Supabase에 자동 저장 → 새로고침해도 유지
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!diagnosisResult || rawAdCampaign.length === 0 || rawSalesInsight.length === 0) return
    // 1초 debounce — 빠르게 변경돼도 한번만 저장
    const timeoutId = setTimeout(() => {
      const snapshot = {
        adFileName: uploads.adCampaign?.fileName,
        sellerFileName: uploads.salesInsight?.fileName,
        // raw 빼기 — 자동 저장에서는 summary만 (가벼움)
        adRows: [],
        sellerStats: [],
        periodStartDate: adPeriod?.startDate,
        periodEndDate: adPeriod?.endDate,
        periodDays: adPeriod?.days || 30,
        // sellerPeriodDays는 라이브 store 동작과 일치시킴 (setAdCampaign에서 period.days로 세팅됨).
        // 과거 하드코딩 30은 sellerScale을 깎아 매출/마진을 1/N로 줄이는 버그였음.
        sellerPeriodDays: adPeriod?.days ?? 30,
        summary: diagnosisResult.summary,
      }
      fetch('/api/coupang-diagnoses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'last', snapshot }),
      }).catch(err => console.error('자동 저장 실패:', err))
    }, 1000)
    return () => clearTimeout(timeoutId)
  }, [diagnosisResult]) // eslint-disable-line react-hooks/exhaustive-deps

  // 명시 저장 다이얼로그
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')
  const [includeInTrend, setIncludeInTrend] = useState(false)
  const [savingExplicit, setSavingExplicit] = useState(false)

  // 명시 저장된 분석 목록
  const [savedAnalyses, setSavedAnalyses] = useState<any[]>([])
  const [recalcing, setRecalcing] = useState(false)
  const [recalcProgress, setRecalcProgress] = useState({ done: 0, total: 0 })

  const handleRecalcAll = async () => {
    if (!marginMaster) { alert('마진 엑셀을 먼저 업로드하세요'); return }
    // 모듈 전역에 마진 마스터 다시 주입 (재계산 시 안전장치)
    if (!hasCostMaster()) {
      console.warn('[recalc] 모듈 전역 비어있음 - store에서 재주입')
      setCostMaster(marginMaster as any)
    }
    if (!hasCostMaster()) {
      alert('마진 마스터 로드 실패. 마진 엑셀을 다시 업로드해주세요.')
      return
    }
    if (!confirm(`저장된 ${savedAnalyses.length}개 분석을 재계산합니다. 계속하시겠습니까?`)) return
    
    setRecalcing(true)
    setRecalcProgress({ done: 0, total: savedAnalyses.length })
    let success = 0
    
    for (let i = 0; i < savedAnalyses.length; i++) {
      const meta = savedAnalyses[i]
      try {
        const itemRes = await fetch(`/api/coupang-diagnoses?type=item&id=${meta.id}`)
        const item = await itemRes.json()
        if (!item?.adRows?.length || !item?.sellerStats?.length) {
          console.warn('[recalc] skip (no raw):', meta.label)
          continue
        }
        // 저장된 sellerStats는 SalesInsightRow 형식(revenue90d/sales90d).
        // diagnose()는 SellerStat 형식(totalRevenue/totalQuantity)을 기대하므로 변환.
        const sellerStats = (item.sellerStats as any[]).map((s) => ({
          optionId: s.optionId,
          totalRevenue: s.revenue90d ?? s.totalRevenue ?? 0,
          totalQuantity: s.sales90d ?? s.totalQuantity ?? 0,
        }))
        // sellerPeriodDays는 항상 periodDays를 우선 사용 (라이브 store 동작과 동일).
        // 과거 잘못 저장된 sellerPeriodDays=30 값은 의도적으로 무시하여 마이그레이션 효과.
        const result = diagnose({
          sellerStats,
          adRows: item.adRows,
          periodDays: item.periodDays || 7,
          sellerPeriodDays: item.periodDays || item.sellerPeriodDays || 7,
        })
        const products = result.products.map(p => ({
          alias: p.alias, revenue: p.revenue, sold: p.sold,
          adRevenue: p.adRevenue, adSold: p.adSold,
          organicRevenue: p.organicRevenue, adCost: p.adCost,
          totalMargin: p.totalMargin, totalNetProfit: p.totalNetProfit,
          adRoasAttr: p.adRoasAttr, adDependency: p.adDependency,
        }))
        const updated = { ...item, products, summary: result.summary }
        await fetch('/api/coupang-diagnoses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'explicit', snapshot: updated }),
        })
        success++
      } catch (err) {
        console.error('[recalc] 실패:', meta.label, err)
      }
      setRecalcProgress({ done: i + 1, total: savedAnalyses.length })
    }
    
    const listRes = await fetch('/api/coupang-diagnoses?type=list')
    const listJson = await listRes.json()
    if (listJson?.diagnoses) setSavedAnalyses(listJson.diagnoses)
    
    setRecalcing(false)
    alert(`재계산 완료: ${success}/${savedAnalyses.length}`)
  }
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)

  // 마이그레이션: products 필드 없는 분석 자동 채우기
  const [migrationRun, setMigrationRun] = useState(false)
  useEffect(() => {
    return; if (migrationRun) return
    if (!marginMaster) return
    if (savedAnalyses.length === 0) return

    const needsMigration = savedAnalyses.filter(a =>
      a.adRows?.length > 0 && a.sellerStats?.length > 0 && (!a.products || a.products.some((p: any) => p.revenue == null))
    )
    if (needsMigration.length === 0) {
      setMigrationRun(true)
      return
    }

    setMigrationRun(true)
    console.log(`[migration] ${needsMigration.length}개 분석에 products 필드 추가 중...`)

    ;(async () => {
      let successCount = 0
      for (const a of needsMigration) {
        try {
          const sellerStats = (a.sellerStats as any[]).map((s) => ({
            optionId: s.optionId,
            totalRevenue: s.revenue90d ?? s.totalRevenue ?? 0,
            totalQuantity: s.sales90d ?? s.totalQuantity ?? 0,
          }))
          const result = diagnose({
            sellerStats,
            adRows: a.adRows,
            periodDays: a.periodDays || 7,
            sellerPeriodDays: a.periodDays || a.sellerPeriodDays || 7,
          })
          const products = result.products.map(p => ({
            alias: p.alias,
            revenue: p.revenue,
            sold: p.sold,
            adRevenue: p.adRevenue,
            adSold: p.adSold,
            organicRevenue: p.organicRevenue,
            adCost: p.adCost,
            totalMargin: p.totalMargin,
            totalNetProfit: p.totalNetProfit,
            adRoasAttr: p.adRoasAttr,
            adDependency: p.adDependency,
          }))
          const updated = { ...a, products }
          await fetch('/api/coupang-diagnoses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'explicit', snapshot: updated }),
          })
          successCount++
        } catch (err) {
          console.error('[migration] 실패:', a.label, err)
        }
      }
      console.log(`[migration] ${successCount}/${needsMigration.length} 완료`)

      const listRes = await fetch('/api/coupang-diagnoses?type=list')
      const listJson = await listRes.json()
      if (listJson?.diagnoses) setSavedAnalyses(listJson.diagnoses)
    })()
  }, [marginMaster, savedAnalyses, migrationRun])

  // 보기 모드: 실제 기간 / 월 환산
  const [viewMode, setViewMode] = useState<'actual' | 'monthly'>('actual')

  // 전월 요약 (있으면 KPI에 화살표 표시)
  const prevSummary = useMemo(() => {
    if (!adPeriod || !adPeriod.endDate) return undefined
    const endDate = new Date(adPeriod.endDate)
    const curMonthKey = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`

    // 전월 키 계산
    const prevDate = new Date(endDate)
    prevDate.setMonth(prevDate.getMonth() - 1)
    const prevMonthKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`

    const prev = savedAnalyses.find(a => a.includeInTrend && a.monthKey === prevMonthKey)
    return prev?.summary
  }, [adPeriod, savedAnalyses])

  // 저장된 분석 클릭 → 그 분석으로 로드
  // list endpoint는 raw 데이터(adRows/sellerStats)를 빼고 메타만 반환하므로,
  // raw가 없으면 ?type=item&id=... 으로 풀 데이터를 다시 가져온다.
  const handleLoadAnalysis = async (a: any) => {
    let full = a
    if (!a.adRows?.length || !a.sellerStats?.length) {
      if (!a.id) {
        alert('이 분석은 데이터가 손상되어 로드할 수 없습니다.')
        return
      }
      try {
        const res = await fetch(`/api/coupang-diagnoses?type=item&id=${a.id}`)
        full = await res.json()
      } catch {
        alert('분석 데이터를 불러오지 못했습니다.')
        return
      }
      if (!full?.adRows?.length || !full?.sellerStats?.length) {
        alert('이 분석은 데이터가 손상되어 로드할 수 없습니다.')
        return
      }
    }
    setAdCampaign(full.adRows, {
      fileName: full.adFileName || full.label,
      uploadedAt: full.createdAt || new Date().toISOString(),
      rowCount: full.adRows.length,
    }, full.periodStartDate && full.periodEndDate ? {
      startDate: full.periodStartDate,
      endDate: full.periodEndDate,
      days: full.periodDays || 30,
    } : null)
    setSalesInsight(full.sellerStats, {
      fileName: full.sellerFileName || full.label,
      uploadedAt: full.createdAt || new Date().toISOString(),
      rowCount: full.sellerStats.length,
    })
    setShowHistoryPanel(false)
  }

  // 저장된 분석 삭제
  const handleDeleteAnalysis = async (id: string) => {
    if (!confirm('이 분석을 삭제하시겠습니까?')) return
    try {
      const res = await fetch(`/api/coupang-diagnoses?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const listRes = await fetch('/api/coupang-diagnoses?type=list')
      const listJson = await listRes.json()
      if (listJson?.diagnoses) setSavedAnalyses(listJson.diagnoses)
    } catch (err: any) {
      alert('삭제 실패: ' + (err?.message || err))
    }
  }

  // trendType state (주별/월별 자동 판단 + 사용자 변경 가능)
  const [trendType, setTrendType] = useState<'weekly' | 'monthly' | null>(null)

  const handleOpenSaveDialog = () => {
    if (!diagnosisResult || !adPeriod) return
    const endDate = new Date(adPeriod.endDate)
    const yyyy = endDate.getFullYear()
    const mm = endDate.getMonth() + 1
    const days = adPeriod.days

    // 자동 판단
    if (days >= 6 && days <= 8) {
      // 주별 후보
      setTrendType('weekly')
      setIncludeInTrend(true)
      setSaveLabel(`주별: ${adPeriod.startDate} ~ ${adPeriod.endDate} (${days}일)`)
    } else if (days >= 28 && days <= 31) {
      // 월별 후보
      setTrendType('monthly')
      setIncludeInTrend(true)
      setSaveLabel(`${yyyy}년 ${mm}월 진단 (${adPeriod.startDate} ~ ${adPeriod.endDate})`)
    } else {
      // 일반 분석
      setTrendType(null)
      setIncludeInTrend(false)
      setSaveLabel(`${days}일치 분석 (${adPeriod.startDate} ~ ${adPeriod.endDate})`)
    }
    setShowSaveDialog(true)
  }

  const handleSaveExplicit = async () => {
    if (!diagnosisResult || !adPeriod) return
    setSavingExplicit(true)
    try {
      const endDate = new Date(adPeriod.endDate)
      const startDate = new Date(adPeriod.startDate)
      const monthKey = (includeInTrend && trendType === 'monthly')
        ? `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`
        : null
      // 주별 키: 시작일을 ISO 형식으로 (예: "2026-03-01")
      const weekKey = (includeInTrend && trendType === 'weekly')
        ? adPeriod.startDate
        : null

      const snapshot = {
        label: saveLabel,
        monthKey,
        weekKey,
        trendType: includeInTrend ? trendType : null,
        includeInTrend,
        adFileName: uploads.adCampaign?.fileName,
        sellerFileName: uploads.salesInsight?.fileName,
        adRows: rawAdCampaign,
        sellerStats: rawSalesInsight,
        periodStartDate: adPeriod.startDate,
        periodEndDate: adPeriod.endDate,
        periodDays: adPeriod.days,
        // 라이브 store의 setAdCampaign이 sellerPeriodDays=period.days로 설정하므로
        // 저장값도 동일하게 맞춰야 재계산 결과가 라이브와 일치.
        sellerPeriodDays: adPeriod.days,
        summary: diagnosisResult.summary,
        // 상품별 트렌드 그래프용 (별칭 필터 적용)
        products: diagnosisResult.products.map(p => ({
          alias: p.alias,
          revenue: p.revenue,
          sold: p.sold,
          adRevenue: p.adRevenue,
          adSold: p.adSold,
          organicRevenue: p.organicRevenue,
          adCost: p.adCost,
          totalMargin: p.totalMargin,
          totalNetProfit: p.totalNetProfit,
          adRoasAttr: p.adRoasAttr,
          adDependency: p.adDependency,
        })),
      }

      const res = await fetch('/api/coupang-diagnoses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'explicit', snapshot }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      
      // 목록 다시 가져오기
      const listRes = await fetch('/api/coupang-diagnoses?type=list')
      const listJson = await listRes.json()
      if (listJson?.diagnoses) setSavedAnalyses(listJson.diagnoses)

      setShowSaveDialog(false)
      alert(includeInTrend ? '✓ 저장 완료 (월별 추이 그래프에 추가됨)' : '✓ 저장 완료')
    } catch (err: any) {
      alert('저장 실패: ' + (err?.message || err))
    } finally {
      setSavingExplicit(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        {/* 헤더 */}
        <div className="mb-6 flex items-end justify-between border-b pb-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">쿠팡 수익 진단</h1>
            <p className="text-sm text-gray-500 mt-1">
              광고 · 오가닉 · 전체 3중 손익 분석 · 함정 탐지
            </p>
          </div>
          <div className="flex items-end gap-3">
            {/* 마지막 업데이트 데이터 */}
            <LastUpdateBadge analyses={savedAnalyses} adPeriod={adPeriod} />

            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHistoryPanel(!showHistoryPanel)}
                className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                📊 저장된 분석 ({savedAnalyses.length})
                </button>
                <button
                  onClick={handleRecalcAll}
                  disabled={recalcing || savedAnalyses.length === 0}
                  className="ml-2 px-3 py-1 text-xs rounded border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-50"
                  title="저장된 모든 분석을 현재 마진 엑셀로 재계산"
                >
                  {recalcing ? `🔄 ${recalcProgress.done}/${recalcProgress.total}` : '🔄 전체 재계산'}
                </button>
              <button
                onClick={() => { if (confirm('모든 데이터를 초기화합니다.')) reset() }}
                className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
              >
                전체 초기화
              </button>
            </div>
          </div>
        </div>

        {/* 저장된 분석 패널 */}
        {showHistoryPanel && (
          <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">저장된 분석 히스토리</h3>
              <button
                onClick={() => setShowHistoryPanel(false)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                ✕ 닫기
              </button>
            </div>

            {savedAnalyses.length === 0 ? (
              <div className="text-center text-xs text-gray-500 py-4">
                저장된 분석이 없습니다. 진단 결과 위 「💾 분석 저장」 버튼으로 저장하세요.
              </div>
            ) : (
              <>
                {/* 주별 추이 */}
                {savedAnalyses.filter(a => a.includeInTrend && a.trendType === 'weekly').length > 0 && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-blue-700 mb-1.5">
                      📅 주별 추이 (그래프 누적)
                    </div>
                    <div className="space-y-1">
                      {savedAnalyses
                        .filter(a => a.includeInTrend && a.trendType === 'weekly')
                        .sort((a, b) => (b.weekKey || '').localeCompare(a.weekKey || ''))
                        .map(a => (
                          <AnalysisItem key={a.id} a={a} onLoad={handleLoadAnalysis} onDelete={handleDeleteAnalysis} />
                        ))}
                    </div>
                  </div>
                )}

                {/* 월별 추이 (그래프 누적) - 기존 또는 trendType=monthly */}
                {savedAnalyses.filter(a => a.includeInTrend && (a.trendType === 'monthly' || (!a.trendType && a.monthKey))).length > 0 && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-orange-700 mb-1.5">
                      📅 월별 추이 (그래프 누적)
                    </div>
                    <div className="space-y-1">
                      {savedAnalyses
                        .filter(a => a.includeInTrend && (a.trendType === 'monthly' || (!a.trendType && a.monthKey)))
                        .sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''))
                        .map(a => (
                          <AnalysisItem key={a.id} a={a} onLoad={handleLoadAnalysis} onDelete={handleDeleteAnalysis} />
                        ))}
                    </div>
                  </div>
                )}

                {/* 일반 분석 */}
                {savedAnalyses.filter(a => !a.includeInTrend).length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-1.5">
                      📁 일반 분석 (그래프 미포함)
                    </div>
                    <div className="space-y-1">
                      {savedAnalyses
                        .filter(a => !a.includeInTrend)
                        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                        .map(a => (
                          <AnalysisItem key={a.id} a={a} onLoad={handleLoadAnalysis} onDelete={handleDeleteAnalysis} />
                        ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 마진 마스터 미로드 시 안내 */}
        {/* 자동 로딩 중 */}
        {autoLoading && (
          <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-center text-sm text-blue-700">
            서버에서 마스터 데이터 불러오는 중...
          </div>
        )}

        {/* 마진 마스터 미로드 시 안내 (자동 로드 끝났는데도 없을 때) */}
        {!autoLoading && !marginMaster && (
          <div className="mb-6 rounded-lg border border-orange-300 bg-orange-50 p-5">
            <div className="font-semibold text-orange-700 mb-2">⚠ 마진 마스터 등록이 필요합니다</div>
            <p className="text-sm text-gray-700 mb-3">
              진단을 위해서는 먼저 마진 마스터(원가·실판매가) 데이터가 필요합니다.<br />
              <strong>「데이터 관리」</strong> 페이지에서 한 번만 등록하면 매월 진단할 때 자동으로 사용됩니다.
            </p>
            <a
              href="/coupang-tools/data-management"
              className="inline-block px-4 py-2 bg-orange-500 text-white text-sm rounded hover:bg-orange-600"
            >
              데이터 관리 페이지로 이동 →
            </a>
          </div>
        )}

        {/* 업로드 영역 */}
        <UploadSection
          onSalesInsight={(rows: any, meta: any) => {
            // 광고 매출과 SELLER 매출 비율 즉시 검증
            if (rawAdCampaign.length > 0 && rows.length > 0) {
              const adRevenue = rawAdCampaign.reduce((sum: number, r: any) => sum + (r.revenue14d || 0), 0)
              const sellerRevenue = rows.reduce((sum: number, r: any) => sum + (r.revenue90d || 0), 0)
              const ratio = sellerRevenue > 0 ? adRevenue / sellerRevenue : 0

              // 광고 매출/SELLER 매출 비율 정상 범위 (40~90%) 체크
              if (sellerRevenue > 0 && (ratio < 0.40 || ratio > 0.90)) {
                const ratioPct = (ratio * 100).toFixed(0)
                const adPeriodStr = adPeriod ? `${adPeriod.startDate} ~ ${adPeriod.endDate} (${adPeriod.days}일)` : '광고 기간 미상'
                const adRev = (adRevenue / 10000).toFixed(0)
                const sellerRev = (sellerRevenue / 10000).toFixed(0)
                let issue = ''
                if (ratio > 0.90) issue = `광고 매출(${adRev}만)이 SELLER 매출(${sellerRev}만)보다 큽니다.\nSELLER가 광고보다 짧은 기간일 수 있어요.`
                else issue = `광고 매출(${adRev}만)에 비해 SELLER 매출(${sellerRev}만)이 너무 큽니다.\nSELLER가 광고보다 긴 기간일 수 있어요.`

                const ok = confirm(
                  `⚠ 기간 불일치 의심\n\n` +
                  `광고 기간: ${adPeriodStr}\n` +
                  `광고매출 / SELLER매출 비율: ${ratioPct}% (정상 40~90%)\n\n` +
                  `${issue}\n\n` +
                  `SELLER 파일이 광고와 같은 기간인지 확인하세요.\n\n` +
                  `이대로 업로드하시겠습니까?`
                )
                if (!ok) return  // 취소하면 업로드 안 함
              }
            }
            setSalesInsight(rows, meta)
          }}
          onAdCampaign={setAdCampaign}
        />

        {/* 마스터 통계 */}
        {marginMaster && (
          <div className="mb-6 grid grid-cols-3 gap-4">
            <StatCard label="원가표 상품" value={`${marginMasterStats.costBookRows}개`} />
            <StatCard label="옵션" value={`${marginMasterStats.marginRows}개`} />
            <StatCard label="실판매가 등록" value={`${marginMasterStats.optionsWithActualPrice}개`} />
          </div>
        )}

        {/* 광고 기간 안내 — 광고 업로드되면 큰 배너로 표시 */}
        {adPeriod && rawSalesInsight.length === 0 && (
          <div className="mb-6 rounded-lg border-2 border-blue-400 bg-blue-50 p-5">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-2xl">📅</span>
              <div>
                <div className="font-bold text-blue-900 text-lg">광고 기간 인식 완료</div>
                <div className="text-sm text-blue-700">
                  <strong>{adPeriod.startDate} ~ {adPeriod.endDate}</strong> ({adPeriod.days}일)
                </div>
              </div>
            </div>
            <div className="bg-white rounded p-3 text-sm text-gray-700">
              <strong className="text-blue-700">→ 다음 단계:</strong>{' '}
              SELLER_INSIGHTS를 <strong>같은 기간 ({adPeriod.startDate} ~ {adPeriod.endDate})</strong>으로 받아서 업로드하세요.
              <br />
              <span className="text-xs text-gray-500 mt-1 inline-block">
                쿠팡 셀러 → 통계 → 상품/옵션 → 기간 위 날짜 입력 후 다운로드
              </span>
            </div>
          </div>
        )}

        {/* 데이터 부족 안내 */}
        {marginMaster && !diagnosisResult && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 text-sm text-gray-700">
            진단을 실행하려면 다음 3개 엑셀이 추가로 필요합니다:
            <ul className="list-disc ml-6 mt-2 space-y-1">
              <li>SELLER_INSIGHTS (옵션별 매출/판매수)</li>
              <li>광고 캠페인 (총 캠페인)</li>
              {!adPeriod && <li className="text-orange-600">광고 기간이 자동 인식되지 않음 → 파일명 확인</li>}
            </ul>
          </div>
        )}

        {/* 진단 결과 */}
        {diagnosisResult && (
          <>
            {/* 저장 버튼 + 보기 모드 토글 */}
            <div className="mb-4 flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-center gap-3">
                <div className="text-xs text-gray-500">
                  💡 자동 저장됨
                </div>
                {/* 보기 모드 토글 */}
                <div className="flex rounded border border-gray-300 overflow-hidden">
                  <button
                    onClick={() => setViewMode('actual')}
                    className={`px-3 py-1 text-xs font-medium ${
                      viewMode === 'actual' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    실제 기간 ({adPeriod?.days || 0}일)
                  </button>
                  <button
                    onClick={() => setViewMode('monthly')}
                    className={`px-3 py-1 text-xs font-medium ${
                      viewMode === 'monthly' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    월(30일) 환산
                  </button>
                </div>
              </div>
              <button
                onClick={handleOpenSaveDialog}
                className="rounded bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600"
              >
                💾 분석 저장 (히스토리/그래프)
              </button>
            </div>

            {/* 상품 필터 드롭다운 */}
            {diagnosisResult.products.length > 0 && (
              <div className="mb-4 flex items-center gap-2">
                <span className="text-sm text-gray-600">📦 상품:</span>
                <select
                  value={selectedAlias}
                  onChange={e => setSelectedAlias(e.target.value)}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm bg-white focus:border-orange-400 focus:outline-none min-w-[280px]"
                >
                  <option value="__ALL__">전체 ({diagnosisResult.products.length}개)</option>
                  {[...diagnosisResult.products]
                    .sort((a, b) => a.alias.localeCompare(b.alias))
                    .map(p => (
                      <option key={p.alias} value={p.alias}>
                        {p.alias} ({p.optionCount}옵션)
                      </option>
                    ))}
                </select>
                {selectedAlias !== '__ALL__' && (
                  <button
                    onClick={() => setSelectedAlias('__ALL__')}
                    className="text-xs text-gray-500 hover:text-orange-600 px-2"
                  >
                    × 초기화
                  </button>
                )}
              </div>
            )}

            {/* 요약 KPI */}
            <SummarySection result={displayResult || diagnosisResult} viewMode={viewMode} prevSummary={prevSummary} />

            {/* 월별 추이 그래프 */}
            <TrendChartSection
              analyses={savedAnalyses}
              onPointClick={handleLoadAnalysis}
              selectedAlias={selectedAlias}
            />

            {/* 기간 검증 배너 */}
            {(() => {
              const v = diagnosisResult.periodValidation
              const ratioPct = (v.ratio * 100).toFixed(0)
              const minPct = (v.normalRange.min * 100).toFixed(0)
              const maxPct = (v.normalRange.max * 100).toFixed(0)

              if (v.status === 'ok') {
                return (
                  <div className="mb-6 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
                    <strong className="text-green-700">✅ 기간 검증 정상:</strong>{' '}
                    <span className="text-gray-700">
                      광고매출 비율 <strong>{ratioPct}%</strong>
                      {' '}({formatKRW(v.adRevenueRaw)} / {formatKRW(v.sellerRevenueRaw)}) ·
                      정상 범위 {minPct}~{maxPct}% 이내
                    </span>
                  </div>
                )
              }

              const isHigh = v.status === 'too_high'
              return (
                <div className="mb-6 rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm">
                  <strong className="text-orange-700">
                    ⚠ 기간 불일치 의심:
                  </strong>{' '}
                  <span className="text-gray-700">
                    광고매출 비율 <strong>{ratioPct}%</strong>
                    {' '}({formatKRW(v.adRevenueRaw)} / {formatKRW(v.sellerRevenueRaw)}) ·
                    정상 범위 {minPct}~{maxPct}%에서 벗어남
                  </span>
                  <div className="mt-2 text-xs text-gray-600">
                    {isHigh
                      ? '광고매출이 SELLER 매출보다 큽니다. 판매분석 엑셀이 광고 엑셀보다 짧은 기간일 수 있습니다.'
                      : '광고매출 비중이 낮습니다. 판매분석 엑셀이 광고 엑셀보다 긴 기간이거나 광고 안 쓴 상품이 많을 수 있습니다.'}
                  </div>
                </div>
              )
            })()}

            {/* 매칭 누락 경고 */}
            {diagnosisResult.unmatched.optionCount > 0 && (
              <div className="mb-6 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm">
                <strong className="text-yellow-700">⚠ 매칭 누락:</strong>{' '}
                <span className="text-gray-700">
                  마진 마스터에 등록되지 않은 옵션 {diagnosisResult.unmatched.optionCount}개 /
                  매출 {formatKRW(diagnosisResult.unmatched.sellerRevenue)} /
                  광고비 {formatKRW(diagnosisResult.unmatched.adCost)}
                </span>
              </div>
            )}

            {/* 판정 필터 */}
            <div className="mb-4 flex items-center gap-2">
              <FilterChip
                active={verdictFilter === 'all'}
                onClick={() => setVerdictFilter('all')}
                label={`전체 (${diagnosisResult.products.length})`}
              />
              <FilterChip
                active={verdictFilter === 'profitable'}
                onClick={() => setVerdictFilter('profitable')}
                label={`🟢 흑자 (${diagnosisResult.summary.counts.profitable})`}
              />
              <FilterChip
                active={verdictFilter === 'trap'}
                onClick={() => setVerdictFilter('trap')}
                label={`🟡 함정 (${diagnosisResult.summary.counts.trap})`}
              />
              <FilterChip
                active={verdictFilter === 'structural_loss'}
                onClick={() => setVerdictFilter('structural_loss')}
                label={`🔴 적자 (${diagnosisResult.summary.counts.structural_loss})`}
              />
            </div>

            {/* 함정 스캐너 테이블 */}
            <ProductScannerTable products={filteredProducts} />
          </>
        )}
      </div>

      {/* ───── 저장 다이얼로그 모달 ───── */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold mb-4">분석 저장</h2>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                라벨 (히스토리 표시용)
              </label>
              <input
                type="text"
                value={saveLabel}
                onChange={e => setSaveLabel(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                placeholder="예: 2026년 4월 진단"
              />
            </div>

            <div className="mb-6">
              <label className="flex items-start gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={includeInTrend}
                  onChange={e => setIncludeInTrend(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="text-sm">
                  <div className="font-medium">추이 그래프에 포함</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    체크 시 같은 키(주/월) 데이터가 있으면 덮어쓰기됩니다.
                  </div>
                </div>
              </label>

              {includeInTrend && (
                <div className="ml-6 mt-2 space-y-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={trendType === 'weekly'}
                      onChange={() => setTrendType('weekly')}
                    />
                    <span>주별 추이 (6~8일치 권장)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={trendType === 'monthly'}
                      onChange={() => setTrendType('monthly')}
                    />
                    <span>월별 추이 (28~31일치 권장)</span>
                  </label>

                  {adPeriod && (
                    <>
                      {trendType === 'weekly' && (adPeriod.days < 6 || adPeriod.days > 8) && (
                        <div className="text-xs text-orange-600 mt-1">
                          ⚠ {adPeriod.days}일치 — 주별은 6~8일치 권장
                        </div>
                      )}
                      {trendType === 'monthly' && (adPeriod.days < 28 || adPeriod.days > 31) && (
                        <div className="text-xs text-orange-600 mt-1">
                          ⚠ {adPeriod.days}일치 — 월별은 28~31일치 권장
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="px-4 py-2 rounded border border-gray-300 text-sm hover:bg-gray-50"
                disabled={savingExplicit}
              >
                취소
              </button>
              <button
                onClick={handleSaveExplicit}
                className="px-4 py-2 rounded bg-orange-500 text-white text-sm hover:bg-orange-600 disabled:opacity-50"
                disabled={savingExplicit || !saveLabel.trim()}
              >
                {savingExplicit ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 업로드 섹션
// ─────────────────────────────────────────────────────────────

function UploadSection(props: {
  onSalesInsight: (rows: any, meta: any) => void
  onAdCampaign: (rows: any, meta: any, period: any) => void
}) {
  const handle = async (
    e: React.ChangeEvent<HTMLInputElement>,
    kind: 'sales' | 'ad',
  ) => {
    const file = e.target.files?.[0]
    // 같은 파일 재업로드 가능하도록 input value 즉시 리셋
    const inputEl = e.target
    if (!file) return
    const buf = await file.arrayBuffer()

    try {
      if (kind === 'sales') {
        const r = parseSalesInsight(buf)
        const meta = { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length }
        props.onSalesInsight(r.rows, meta)
      } else if (kind === 'ad') {
        const r = parseAdCampaign(buf, file.name)
        const meta = { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length }
        const period = r.startDate && r.endDate
          ? { startDate: r.startDate, endDate: r.endDate, days: r.periodDays || 30 }
          : null
        props.onAdCampaign(r.rows, meta, period)
      }
    } catch (err: any) {
      alert(`${kind} 파싱 에러: ${err?.message || err}`)
    } finally {
      // input 리셋 — 같은 파일을 다시 선택해도 onChange 발생하도록
      if (inputEl) inputEl.value = ''
    }
  }

  return (
    <div className="mb-6 grid grid-cols-2 gap-3">
      <UploadSlot label="① 광고" hint="pa_total_campaign (기간 자동인식)" onChange={(e) => handle(e, 'ad')} highlight />
      <UploadSlot label="② 판매 분석" hint="SELLER_INSIGHTS (광고와 같은 기간)" onChange={(e) => handle(e, 'sales')} highlight2 />
    </div>
  )
}

function UploadSlot(props: {
  label: string
  hint: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  highlight?: boolean
  highlight2?: boolean
}) {
  const borderClass = props.highlight
    ? 'border-orange-300 bg-orange-50/30'
    : props.highlight2
    ? 'border-blue-300 bg-blue-50/30'
    : 'border-gray-300 bg-white'
  return (
    <label className={`block rounded-lg border-2 border-dashed p-3 cursor-pointer hover:bg-gray-50 ${borderClass}`}>
      <div className="text-sm font-medium">{props.label}</div>
      <div className="text-xs text-gray-500 mt-1">{props.hint}</div>
      <input type="file" accept=".xlsx,.xls" onChange={props.onChange} className="hidden" />
    </label>
  )
}

// ─────────────────────────────────────────────────────────────
// 요약 섹션
// ─────────────────────────────────────────────────────────────

type ViewMode = 'actual' | 'monthly'

function SummarySection({ result, viewMode, prevSummary }: {
  result: DiagnosisResult
  viewMode: ViewMode
  prevSummary?: any  // 전월 요약 (있으면 화살표 표시)
}) {
  const s = result.summary
  const days = result.period.days

  // 월환산 스케일 (실제 → 30일 환산)
  const scale = viewMode === 'monthly' && days > 0 ? 30 / days : 1
  const adj = (n: number) => n * scale

  // 전월 대비 계산
  const compare = (cur: number, prev: number | undefined): { text: string; up: boolean } | null => {
    if (prev === undefined || prev === null || !isFinite(prev) || prev === 0) return null
    const diff = ((cur - prev) / Math.abs(prev)) * 100
    if (Math.abs(diff) < 0.5) return null
    return {
      text: `${diff > 0 ? '▲' : '▼'} ${diff > 0 ? '+' : ''}${diff.toFixed(0)}% vs 전월`,
      up: diff > 0,
    }
  }

  const showCompare = !!prevSummary

  // 비교 화살표 적용 — 항목별 유리/불리 색깔 다름
  const cmpRevenue = showCompare ? compare(adj(s.totalRevenue), adj(prevSummary.totalRevenue)) : null
  const cmpAdRev = showCompare ? compare(adj(s.totalAdRevenue), adj(prevSummary.totalAdRevenue)) : null
  const cmpOrgRev = showCompare ? compare(adj(s.totalOrganicRevenue), adj(prevSummary.totalOrganicRevenue)) : null
  const cmpRoas = showCompare ? compare(s.adRoasAttr ?? 0, prevSummary.adRoasAttr ?? 0) : null
  const cmpAdCost = showCompare ? compare(adj(s.totalAdCost), adj(prevSummary.totalAdCost)) : null
  const cmpMargin = showCompare ? compare(adj(s.totalMargin), adj(prevSummary.totalMargin)) : null
  const cmpProfit = showCompare ? compare(adj(s.totalNetProfit), adj(prevSummary.totalNetProfit)) : null

  return (
    <div className="mb-6">
      {/* 1행: 매출 분해 */}
      <div className="grid grid-cols-4 gap-4 mb-3">
        <KpiCard
          label="총 매출"
          value={formatMan(adj(s.totalRevenue))}
          sub={`${s.productCount}개 상품`}
          compare={cmpRevenue}
          // 매출 ↑ 좋음
          compareGood="up"
        />
        <KpiCard
          label="광고 귀속 매출"
          value={formatMan(adj(s.totalAdRevenue))}
          sub={`${(s.adDependency*100).toFixed(0)}%`}
          compare={cmpAdRev}
          compareGood="up"
        />
        <KpiCard
          label="오가닉 매출"
          value={formatMan(adj(s.totalOrganicRevenue))}
          sub={`${((1-s.adDependency)*100).toFixed(0)}%`}
          compare={cmpOrgRev}
          compareGood="up"
        />
        <KpiCard
          label="ROAS (귀속)"
          value={formatPct(s.adRoasAttr)}
          sub="실판매가 기준"
          compare={cmpRoas}
          compareGood="up"
        />
      </div>
      {/* 2행: 손익 */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard
          label="광고비 (VAT)"
          value={formatMan(adj(s.totalAdCost))}
          accent="orange"
          compare={cmpAdCost}
          // 광고비 ↓ 좋음
          compareGood="down"
        />
        <KpiCard
          label="총 마진"
          value={formatMan(adj(s.totalMargin))}
          sub={`${(s.marginRate*100).toFixed(1)}%`}
          compare={cmpMargin}
          compareGood="up"
        />
        <KpiCard
          label="순이익 (= 마진 − 광고비)"
          value={formatMan(adj(s.totalNetProfit), true)}
          accent={adj(s.totalNetProfit) >= 0 ? 'green' : 'red'}
          compare={cmpProfit}
          compareGood="up"
        />
        <KpiCard
          label="기간"
          value={viewMode === 'monthly' ? '30일 환산' : `${days}일`}
          sub={viewMode === 'monthly' && days !== 30 ? `실제: ${days}일` : (result.period.sellerScale !== 1 ? `SELLER ×${result.period.sellerScale.toFixed(2)}` : 'SELLER 동일기간')}
        />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 월별 추이 그래프
// ─────────────────────────────────────────────────────────────

function TrendChartSection({ analyses, onPointClick, selectedAlias }: {
  analyses: any[]
  onPointClick?: (a: any) => void
  selectedAlias?: string
}) {
  const [chartMode, setChartMode] = useState<'weekly' | 'monthly'>('weekly')
  const isFiltered = selectedAlias && selectedAlias !== '__ALL__'

  // 분석 1개에서 선택된 상품 데이터만 추출하여 summary 생성
  const extractSummary = (a: any) => {
    if (!isFiltered) return a.summary || {}
    const products = a.products || []
    const found = products.find((p: any) => p.alias === selectedAlias)
    if (!found) {
      // 그 주차에 해당 상품 데이터 없음
      return null
    }
    return {
      totalRevenue: found.revenue || 0,
      totalAdRevenue: found.adRevenue || 0,
      totalAdCost: found.adCost || 0,
      totalNetProfit: found.totalNetProfit || 0,
      adRoasAttr: found.adRoasAttr || 0,
      adDependency: found.adDependency || 0,
    }
  }

  // 주별 데이터
  const weeklyData = useMemo(() => {
    return analyses
      .filter(a => a.includeInTrend && a.trendType === 'weekly' && a.weekKey)
      .sort((a, b) => (a.weekKey || '').localeCompare(b.weekKey || ''))
      .map(a => {
        const s = extractSummary(a)
        if (!s) return null
        const days = a.periodDays || 7
        const scale = 7 / Math.max(days, 1)  // 주 단위로 정규화
        return {
          key: a.weekKey,
          label: formatWeekLabel(a.weekKey),
          매출: Math.round(((s.totalRevenue || 0) * scale) / 10000),
          광고비: Math.round(((s.totalAdCost || 0) * scale) / 10000),
          순이익: Math.round(((s.totalNetProfit || 0) * scale) / 10000),
          ROAS: s.adRoasAttr ? Math.round(s.adRoasAttr) : 0,
          광고의존도: Math.round((s.adDependency || 0) * 100),
          _analysis: a,  // 클릭 시 사용
        }
      })
      .filter(Boolean) as any[]
  }, [analyses, selectedAlias])

  // 월별 데이터
  const monthlyData = useMemo(() => {
    return analyses
      .filter(a => a.includeInTrend && (a.trendType === 'monthly' || (!a.trendType && a.monthKey)) && a.monthKey)
      .sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || ''))
      .map(a => {
        const s = extractSummary(a)
        if (!s) return null
        const days = a.periodDays || 30
        const scale = 30 / Math.max(days, 1)
        return {
          key: a.monthKey,
          label: formatMonthLabel(a.monthKey),
          매출: Math.round(((s.totalRevenue || 0) * scale) / 10000),
          광고비: Math.round(((s.totalAdCost || 0) * scale) / 10000),
          순이익: Math.round(((s.totalNetProfit || 0) * scale) / 10000),
          ROAS: s.adRoasAttr ? Math.round(s.adRoasAttr) : 0,
          광고의존도: Math.round((s.adDependency || 0) * 100),
          _analysis: a,
        }
      })
      .filter(Boolean) as any[]
  }, [analyses, selectedAlias])

  const trendData = chartMode === 'weekly' ? weeklyData : monthlyData
  const periodLabel = chartMode === 'weekly' ? '주' : '월'

  // 토글 (UI는 항상 보임)
  const ToggleHeader = () => (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold">📈 추이 그래프</h3>
      <div className="flex rounded border border-gray-300 overflow-hidden">
        <button
          onClick={() => setChartMode('weekly')}
          className={`px-3 py-1 text-xs font-medium ${
            chartMode === 'weekly' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          주별 ({weeklyData.length})
        </button>
        <button
          onClick={() => setChartMode('monthly')}
          className={`px-3 py-1 text-xs font-medium ${
            chartMode === 'monthly' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          월별 ({monthlyData.length})
        </button>
      </div>
    </div>
  )

  if (trendData.length < 2) {
    return (
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <ToggleHeader />
        <div className="text-center text-sm text-gray-500 py-6">
          {chartMode === 'weekly'
            ? `📈 주별 추이는 2주 이상 데이터가 누적되면 표시됩니다.`
            : `📈 월별 추이는 2개월 이상 데이터가 누적되면 표시됩니다.`}
          <div className="text-xs text-gray-400 mt-1">
            현재 {trendData.length}{periodLabel} 데이터
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-6 space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <ToggleHeader />
        <div className="text-xs text-gray-500 mb-2">
          매출 / 광고비 / 순이익 ({chartMode === 'weekly' ? '주' : '월'} 환산)
          {onPointClick && <span className="ml-2 text-orange-600">· 점 클릭 시 해당 시점 데이터로 진단</span>}
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart
            data={trendData}
            onClick={(state: any) => {
              if (!onPointClick) return
              const a = state?.activePayload?.[0]?.payload?._analysis
              if (a) onPointClick(a)
            }}
            style={{ cursor: onPointClick ? 'pointer' : 'default' }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v.toLocaleString()}만`} />
            <Tooltip
              formatter={(v: any) => `${v.toLocaleString()}만원`}
              cursor={{ stroke: '#f97316', strokeWidth: 1, strokeDasharray: '3 3' }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="매출"
              stroke="#2563eb"
              strokeWidth={2}
              dot={{ r: 4, cursor: onPointClick ? 'pointer' : 'default' }}
              activeDot={{
                r: 7,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: (_: any, ev: any) => {
                  if (!onPointClick) return
                  const idx = ev?.index
                  if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
                },
              }}
            />
            <Line
              type="monotone"
              dataKey="광고비"
              stroke="#f97316"
              strokeWidth={2}
              dot={{ r: 4, cursor: onPointClick ? 'pointer' : 'default' }}
              activeDot={{
                r: 7,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: (_: any, ev: any) => {
                  if (!onPointClick) return
                  const idx = ev?.index
                  if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
                },
              }}
            />
            <Line
              type="monotone"
              dataKey="순이익"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ r: 4, cursor: onPointClick ? 'pointer' : 'default' }}
              activeDot={{
                r: 7,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: (_: any, ev: any) => {
                  if (!onPointClick) return
                  const idx = ev?.index
                  if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
                },
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold mb-3">📊 ROAS 추이</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip formatter={(v: any) => `${v}%`} />
              <Line type="monotone" dataKey="ROAS" stroke="#8b5cf6" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold mb-3">📊 광고 의존도</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
              <Tooltip formatter={(v: any) => `${v}%`} />
              <Line type="monotone" dataKey="광고의존도" stroke="#ef4444" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function formatWeekLabel(weekStart: string): string {
  if (!weekStart) return ''
  // "2026-03-01" → "3/1주"
  const parts = weekStart.split('-')
  if (parts.length !== 3) return weekStart
  return `${parseInt(parts[1])}/${parseInt(parts[2])}주`
}

function formatMonthLabel(monthKey: string): string {
  if (!monthKey) return ''
  const [yyyy, mm] = monthKey.split('-')
  return `${yyyy.slice(2)}.${mm}`
}

// ─────────────────────────────────────────────────────────────
// 함정 스캐너 테이블
// ─────────────────────────────────────────────────────────────

type SortKey = 'alias' | 'revenue' | 'adCost' | 'adRevenue' | 'organicRevenue' | 'adNetProfit' | 'totalNetProfit' | 'marginRate' | 'adRoasAttr' | 'verdict'
type SortDir = 'asc' | 'desc'

function ProductScannerTable({ products }: { products: ProductDiagnosis[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('totalNetProfit')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedAlias, setExpandedAlias] = useState<Set<string>>(new Set())

  const sortedProducts = useMemo(() => {
    const arr = [...products]
    arr.sort((a: any, b: any) => {
      let av: any, bv: any
      if (sortKey === 'alias') { av = a.alias; bv = b.alias }
      else if (sortKey === 'verdict') { av = a.verdict; bv = b.verdict }
      else { av = a[sortKey] ?? 0; bv = b[sortKey] ?? 0 }

      if (typeof av === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [products, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const toggleExpand = (alias: string) => {
    setExpandedAlias(prev => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  const SortHeader = ({ k, label, align = 'right' }: { k: SortKey; label: string; align?: 'left' | 'right' }) => (
    <th
      onClick={() => toggleSort(k)}
      className={`px-3 py-3 font-medium cursor-pointer hover:text-gray-900 select-none whitespace-nowrap sticky top-0 bg-gray-50 z-20 ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {label}
      {sortKey === k && (
        <span className="ml-1 text-orange-500">{sortDir === 'desc' ? '▼' : '▲'}</span>
      )}
    </th>
  )

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 flex justify-between items-center">
        <div>
          <h3 className="font-semibold">전체 상품 함정 스캐너</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            별칭 단위로 그룹화 · 행 클릭 시 옵션별 상세 표시
          </p>
        </div>
        <div className="text-xs text-gray-500">
          {products.length}개 상품
        </div>
      </div>
      <div className="relative overflow-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              {/* 코너 셀: sticky-top + sticky-left → z-30 (단순 sticky-top z-20, sticky-left body z-10보다 위) */}
              <th className="text-left px-4 py-3 font-medium sticky left-0 top-0 bg-gray-50 z-30 cursor-pointer hover:text-gray-900 select-none whitespace-nowrap min-w-[200px]"
                  onClick={() => toggleSort('alias')}>
                별칭
                {sortKey === 'alias' && (
                  <span className="ml-1 text-orange-500">{sortDir === 'desc' ? '▼' : '▲'}</span>
                )}
              </th>
              <th className="text-right px-3 py-3 font-medium sticky top-0 bg-gray-50 z-30 cursor-pointer hover:text-gray-900 select-none whitespace-nowrap"
                  style={{ left: 200 }}
                  onClick={() => toggleSort('revenue')}>
                매출
                {sortKey === 'revenue' && (
                  <span className="ml-1 text-orange-500">{sortDir === 'desc' ? '▼' : '▲'}</span>
                )}
              </th>
              <SortHeader k="adCost" label="광고비" />
              <SortHeader k="adRevenue" label="광고매출" />
              <SortHeader k="organicRevenue" label="오가닉매출" />
              <SortHeader k="adNetProfit" label="광고손익" />
              <SortHeader k="totalNetProfit" label="순이익" />
              <SortHeader k="marginRate" label="마진율" />
              <SortHeader k="adRoasAttr" label="ROAS" />
              <SortHeader k="verdict" label="판정" align="left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sortedProducts.map((p) => {
              const style = VERDICT_STYLES[p.verdict]
              const isExpanded = expandedAlias.has(p.alias)
              return (
                <React.Fragment key={p.alias}>
                  <tr
                    className={`hover:bg-blue-50 cursor-pointer ${style.bg}`}
                    onClick={() => toggleExpand(p.alias)}
                  >
                    <td className="px-4 py-3 sticky left-0 z-10 bg-inherit min-w-[200px]" style={{ background: 'inherit' }}>
                      <div className="font-medium flex items-center gap-1">
                        <span className="text-gray-400 text-xs">{isExpanded ? '▼' : '▶'}</span>
                        {p.alias}
                      </div>
                      <div className="text-xs text-gray-500 ml-4">
                        {p.optionCount}개 옵션 · 노출ID {p.exposureIds.length}개
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap min-w-[90px] sticky z-10 bg-inherit" style={{ left: 200, background: 'inherit' }}>
                      {formatMan(p.revenue)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-orange-700 whitespace-nowrap min-w-[90px]">{formatMan(p.adCost)}</td>
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap min-w-[100px]">
                      {formatMan(p.adRevenue)}
                      <div className="text-[10px] text-gray-400">({p.adSold.toLocaleString()}개)</div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap min-w-[100px]">
                      {formatMan(p.organicRevenue)}
                      <div className="text-[10px] text-gray-400">({p.organicSold.toLocaleString()}개)</div>
                    </td>
                    <td className={`px-3 py-3 text-right font-mono whitespace-nowrap min-w-[90px] ${p.adNetProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {formatMan(p.adNetProfit, true)}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono font-bold whitespace-nowrap min-w-[90px] ${p.totalNetProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {formatMan(p.totalNetProfit, true)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap min-w-[60px]">
                      {(p.marginRate * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap min-w-[60px]">
                      {p.adRoasAttr ? `${p.adRoasAttr.toFixed(0)}%` : '–'}
                    </td>
                    <td className={`px-3 py-3 ${style.text} text-xs font-medium whitespace-nowrap`}>
                      {style.dot} {style.label}
                    </td>
                  </tr>
                  {/* 옵션별 드릴다운 */}
                  {isExpanded && p.optionDetails && p.optionDetails.length > 0 && p.optionDetails.map((opt) => {
                    const optStyle = VERDICT_STYLES[opt.verdict]
                    return (
                      <tr key={`${p.alias}-${opt.optionId}`} className="bg-blue-50/50">
                        <td className="pl-12 pr-4 py-2 sticky left-0 z-10 bg-blue-50/50 min-w-[200px]">
                          <div className="text-xs text-gray-700">└ {opt.optionName}</div>
                          <div className="text-[10px] text-gray-400">옵션ID {opt.optionId}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap min-w-[90px] sticky z-10 bg-blue-50/50" style={{ left: 200 }}>
                          {formatMan(opt.revenue)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-orange-700 whitespace-nowrap min-w-[90px]">{formatMan(opt.adCost)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap min-w-[100px]">
                          {formatMan(opt.adRevenue)}
                          <div className="text-[10px] text-gray-400">({opt.adSold.toLocaleString()}개)</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap min-w-[100px]">
                          {formatMan(opt.organicRevenue)}
                          <div className="text-[10px] text-gray-400">({opt.organicSold.toLocaleString()}개)</div>
                        </td>
                        <td className={`px-3 py-2 text-right font-mono text-xs whitespace-nowrap min-w-[90px] ${opt.adNetProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {formatMan(opt.adNetProfit, true)}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono text-xs font-semibold whitespace-nowrap min-w-[90px] ${opt.totalNetProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {formatMan(opt.totalNetProfit, true)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap min-w-[60px]">
                          {(opt.marginRate * 100).toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap min-w-[60px]">
                          {opt.adRoasAttr ? `${opt.adRoasAttr.toFixed(0)}%` : '–'}
                        </td>
                        <td className={`px-3 py-2 ${optStyle.text} text-[11px] whitespace-nowrap`}>
                          {optStyle.dot} {optStyle.label}
                        </td>
                      </tr>
                    )
                  })}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {products.length === 0 && (
        <div className="p-10 text-center text-gray-400 text-sm">표시할 상품이 없습니다</div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 작은 컴포넌트들
// ─────────────────────────────────────────────────────────────

function KpiCard(props: {
  label: string
  value: string
  sub?: string
  accent?: 'green' | 'red' | 'orange'
  compare?: { text: string; up: boolean } | null
  compareGood?: 'up' | 'down'  // up: 증가가 좋음, down: 감소가 좋음
}) {
  const colorClass = props.accent === 'green' ? 'text-green-700'
    : props.accent === 'red' ? 'text-red-700'
    : props.accent === 'orange' ? 'text-orange-700'
    : 'text-gray-900'

  // 비교 색깔: 좋은 방향이면 초록, 나쁘면 빨강
  let cmpClass = ''
  if (props.compare) {
    const isGood = (props.compareGood === 'up' && props.compare.up)
      || (props.compareGood === 'down' && !props.compare.up)
    cmpClass = isGood ? 'text-green-600' : 'text-red-600'
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs text-gray-500 mb-1">{props.label}</div>
      <div className={`text-xl font-bold font-mono ${colorClass}`}>{props.value}</div>
      {props.sub && <div className="text-xs text-gray-400 mt-0.5">{props.sub}</div>}
      {props.compare && (
        <div className={`text-xs font-medium mt-1 ${cmpClass}`}>{props.compare.text}</div>
      )}
    </div>
  )
}

function StatCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs text-gray-500">{props.label}</div>
      <div className="text-lg font-semibold font-mono mt-0.5">{props.value}</div>
    </div>
  )
}

function AnalysisItem(props: {
  a: any
  onLoad: (a: any) => void
  onDelete: (id: string) => void
}) {
  const a = props.a
  const summary = a.summary || {}
  const profit = summary.totalNetProfit || 0
  const revenue = summary.totalRevenue || 0
  const dateStr = a.createdAt ? new Date(a.createdAt).toLocaleDateString('ko-KR') : ''

  return (
    <div className="flex items-center justify-between gap-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs hover:bg-gray-100">
      <button
        onClick={() => props.onLoad(a)}
        className="flex-1 text-left"
      >
        <div className="font-medium text-gray-900">{a.label || '제목 없음'}</div>
        <div className="text-gray-500 mt-0.5">
          저장: {dateStr} · 매출 {formatMan(revenue)} · 
          순이익 <span className={profit >= 0 ? 'text-green-600' : 'text-red-600'}>
            {formatMan(profit, true)}
          </span>
        </div>
      </button>
      <button
        onClick={() => props.onDelete(a.id)}
        className="text-gray-400 hover:text-red-600 px-1.5"
        title="삭제"
      >
        🗑
      </button>
    </div>
  )
}

function LastUpdateBadge({ analyses, adPeriod }: {
  analyses: any[]
  adPeriod: { startDate: string; endDate: string; days: number } | null
}) {
  // 1) 가장 최근 누적된 주별 데이터 찾기
  const latestWeekly = useMemo(() => {
    return analyses
      .filter(a => a.includeInTrend && a.trendType === 'weekly' && a.weekKey)
      .sort((a, b) => (b.weekKey || '').localeCompare(a.weekKey || ''))[0]
  }, [analyses])

  // 2) 가장 최근 누적된 월별 데이터 찾기
  const latestMonthly = useMemo(() => {
    return analyses
      .filter(a => a.includeInTrend && (a.trendType === 'monthly' || (!a.trendType && a.monthKey)) && a.monthKey)
      .sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''))[0]
  }, [analyses])

  // 표시할 정보 결정 — 누적 데이터 있으면 그걸로, 없으면 현재 진단 광고 기간
  let label = ''
  let detail = ''

  if (latestWeekly || latestMonthly) {
    // 더 최근 종료일 사용
    const wEnd = latestWeekly?.periodEndDate || ''
    const mEnd = latestMonthly?.periodEndDate || ''
    const useWeekly = wEnd >= mEnd

    if (useWeekly && latestWeekly) {
      label = '최신 주별 데이터'
      detail = `${latestWeekly.periodStartDate} ~ ${latestWeekly.periodEndDate}`
    } else if (latestMonthly) {
      label = '최신 월별 데이터'
      detail = `${latestMonthly.periodStartDate} ~ ${latestMonthly.periodEndDate}`
    }
  } else if (adPeriod) {
    label = '현재 진단 데이터'
    detail = `${adPeriod.startDate} ~ ${adPeriod.endDate} (${adPeriod.days}일)`
  } else {
    return null
  }

  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">마지막 업데이트 데이터</div>
      <div className="text-sm font-mono font-medium text-gray-800 mt-0.5">{detail}</div>
      <div className="text-[10px] text-gray-400">{label}</div>
    </div>
  )
}

function FilterChip(props: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={props.onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
        props.active
          ? 'bg-orange-500 text-white border-orange-500'
          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
      }`}
    >
      {props.label}
    </button>
  )
}
