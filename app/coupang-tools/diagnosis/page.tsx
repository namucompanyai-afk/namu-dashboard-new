'use client'

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
import { parseSalesInsight } from '@/lib/coupang/parsers/salesInsight'
import { parseAdCampaign } from '@/lib/coupang/parsers/adCampaign'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import MasterDiagnosisView from '@/components/coupang/MasterDiagnosisView'
import KpiCard from '@/components/pnl/KpiCard'
import { ChannelBadge, ChannelDistribution } from '../_lib/channel'

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
    reset, resetExceptMargin,
  } = useMarginStore()

  const [verdictFilter, setVerdictFilter] = useState<VerdictCode | 'all'>('all')
  const [selectedAlias, setSelectedAlias] = useState<string>('__ALL__')
  const [autoLoading, setAutoLoading] = useState(true)

  // ── 저장된 분석 보기 모드 (frozen view) ──
  // 점 클릭 또는 자동 로드 시 setLoadedSnapshot 만 호출. store recomputeDiagnosis 우회.
  // 저장 시점 summary/products/optionDetails/marginSnapshot 그대로 표시 — 마진M 갱신 영향 X.
  const [loadedSnapshot, setLoadedSnapshot] = useState<any | null>(null)
  const exitSnapshotView = () => setLoadedSnapshot(null)

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

        // 가장 최근 저장 분석을 frozen view 로 자동 로드 (재계산 없음)
        const all = listJson?.diagnoses || []
        const sorted = all
          .filter((a: any) => a.periodEndDate || a.weekKey || a.monthKey)
          .sort((a: any, b: any) => (b.periodEndDate || b.weekKey || b.monthKey || '').localeCompare(a.periodEndDate || a.weekKey || a.monthKey || ''))
        const meta = sorted[0]
        if (meta?.id) {
          try {
            const itemRes = await fetch(`/api/coupang-diagnoses?type=item&id=${meta.id}`)
            const target = await itemRes.json()
            if (target?.summary) setLoadedSnapshot(target)
          } catch (e) { console.warn('자동 로드 실패:', e) }
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

  // ── 화면 표시용 진단 결과: loadedSnapshot 우선, 없으면 라이브 diagnosisResult ──
  // loadedSnapshot 는 저장 시점 summary/products/optionDetails 를 그대로 가짐 → frozen view.
  const baseResult: DiagnosisResult | null = useMemo(() => {
    if (loadedSnapshot?.summary) {
      return {
        products: (loadedSnapshot.products || []) as any,
        summary: loadedSnapshot.summary,
        period: { days: loadedSnapshot.periodDays || 7, sellerScale: 1 },
        unmatched: loadedSnapshot.unmatched || { sellerRevenue: 0, adCost: 0, optionCount: 0, estimatedMargin: 0, adOptions: [] },
        periodValidation: loadedSnapshot.periodValidation || { adRevenueRaw: 0, sellerRevenueRaw: 0, ratio: 0, status: 'ok', normalRange: { min: 0.4, max: 0.9 } },
      } as any
    }
    return diagnosisResult
  }, [loadedSnapshot, diagnosisResult])

  // 필터된 상품 목록 (loadedSnapshot 또는 라이브)
  const filteredProducts = useMemo(() => {
    const src = baseResult
    if (!src) return []
    if (verdictFilter === 'all') return src.products
    return src.products.filter((p) => p.verdict === verdictFilter)
  }, [baseResult, verdictFilter])

  // 상품별 필터 적용된 진단 결과 (KPI/그래프용)
  const displayResult = useMemo(() => {
    if (!baseResult) return null
    if (selectedAlias === '__ALL__') return baseResult

    const filtered = baseResult.products.filter(p => p.alias === selectedAlias)
    if (filtered.length === 0) return baseResult

    // 선택된 상품들의 합계로 summary 재계산
    const totalRevenue = filtered.reduce((s, p) => s + p.revenue, 0)
    const totalAdRevenue = filtered.reduce((s, p) => s + p.adRevenue, 0)
    const totalOrganicRevenue = totalRevenue - totalAdRevenue
    const totalAdCost = filtered.reduce((s, p) => s + p.adCost, 0)
    const totalMargin = filtered.reduce((s, p) => s + p.totalMargin, 0)
    const totalNetProfit = totalMargin - totalAdCost
    const marginRate = totalRevenue > 0 ? totalMargin / totalRevenue : 0
    const adRoasAttr = totalAdCost > 0 ? (totalAdRevenue / totalAdCost) * 100 : null
    const totalCampaignRevenue = filtered.reduce((s, p: any) => s + (p.campaignRevenue || 0), 0)
    const adRoasCamp = totalAdCost > 0 ? (totalCampaignRevenue / totalAdCost) * 100 : null
    const adDependency = totalRevenue > 0 ? totalAdRevenue / totalRevenue : 0

    const counts = { profitable: 0, trap: 0, structural_loss: 0, no_sales: 0 }
    for (const p of filtered) counts[p.verdict]++

    return {
      ...baseResult,
      products: filtered,
      summary: {
        ...baseResult.summary,
        totalRevenue,
        totalAdRevenue,
        totalOrganicRevenue,
        totalCampaignRevenue,
        totalAdCost,
        totalMargin,
        totalNetProfit,
        marginRate,
        adRoasAttr,
        adRoasCamp,
        adDependency,
        productCount: filtered.length,
        counts,
      },
    }
  }, [baseResult, selectedAlias])

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
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)

  // 보기 모드: 실제 기간 / 월 환산
  const [viewMode, setViewMode] = useState<'actual' | 'monthly'>('actual')

  // 직전 동일 기간 요약 (있으면 KPI에 화살표 표시)
  // 규칙:
  //   - 현재 분석 periodDays = N → 같은 N(±1일) 길이의 저장된 분석 중
  //     periodEndDate 가 현재 periodStartDate 직전(0~2일 전)인 가장 최근 1개를 찾음
  //   - 7일 → 직전 7일, 30일 → 직전 30일 비교가 자동으로 매칭됨
  const prevSummary = useMemo(() => {
    // frozen view 일 땐 loadedSnapshot, 아니면 라이브 adPeriod 기준
    const baseStart = loadedSnapshot ? loadedSnapshot.periodStartDate : adPeriod?.startDate
    const baseDays = loadedSnapshot ? loadedSnapshot.periodDays : adPeriod?.days
    const baseId = loadedSnapshot?.id  // 자기 자신 제외용
    if (!baseStart || !baseDays) return undefined
    const curStartMs = new Date(baseStart).getTime()
    if (!Number.isFinite(curStartMs)) return undefined

    type Cand = { summary: any; endMs: number }
    const candidates: Cand[] = []
    for (const a of savedAnalyses) {
      if (baseId && a?.id === baseId) continue  // 자기 자신 비교 안 함
      if (!a?.periodEndDate || !a?.periodDays) continue
      if (Math.abs((a.periodDays || 0) - baseDays) > 1) continue
      const endMs = new Date(a.periodEndDate).getTime()
      if (!Number.isFinite(endMs)) continue
      const gapDays = (curStartMs - endMs) / (1000 * 60 * 60 * 24)
      // 현재 시작일 직전 0~2일 사이에 끝난 분석
      if (gapDays < 0 || gapDays > 2) continue
      if (a.summary) candidates.push({ summary: a.summary, endMs })
    }
    candidates.sort((x, y) => y.endMs - x.endMs)
    return candidates[0]?.summary
  }, [loadedSnapshot, adPeriod, savedAnalyses])

  // 저장된 분석 클릭 → frozen view 로 로드 (재계산 없이 저장 시점 데이터 그대로 표시)
  // list endpoint 는 raw 빼고 메타/summary 만 반환 → summary 없으면 ?type=item&id 로 풀 가져옴
  const handleLoadAnalysis = async (a: any) => {
    let full = a
    if (!a.summary || !a.products) {
      if (!a.id) { alert('이 분석은 ID가 없어 로드할 수 없습니다.'); return }
      try {
        const res = await fetch(`/api/coupang-diagnoses?type=item&id=${a.id}`)
        full = await res.json()
      } catch {
        alert('분석 데이터를 불러오지 못했습니다.'); return
      }
      if (!full?.summary) { alert('이 분석은 summary 가 없어 표시할 수 없습니다.'); return }
    }
    setLoadedSnapshot(full)
    setShowHistoryPanel(false)
  }

  // 저장된 분석 삭제
  const handleDeleteAnalysis = async (id: string) => {
    if (!confirm('이 분석을 삭제하시겠습니까?')) return
    try {
      const res = await fetch(`/api/coupang-diagnoses?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if ((json?.deletedCount ?? 0) === 0 && !json?.oldRemoved) {
        alert('삭제 실패: 매칭되는 항목을 찾지 못했습니다 (id=' + id + ')')
        return
      }
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

      // 마진M 스냅샷: 이 분석에 등장한 옵션ID 한정 — frozen view 시 마스터 갱신 영향 없게
      const marginSnapshot: Record<string, any> = {}
      const masterRows = (marginMaster as any)?.marginRows || []
      const masterByOptId = new Map(masterRows.map((r: any) => [String(r.optionId).trim(), r]))
      const collectOptIds = new Set<string>()
      for (const p of diagnosisResult.products) {
        for (const oid of p.optionIds || []) collectOptIds.add(String(oid).trim())
      }
      for (const oid of collectOptIds) {
        const r: any = masterByOptId.get(oid)
        if (!r) continue
        marginSnapshot[oid] = {
          actualPrice: r.actualPrice ?? 0,
          totalCost: r.totalCost ?? 0,
          netProfit: r.netProfit ?? 0,
          bepRoas: r.bepRoas ?? null,
          alias: r.alias ?? '',
          optionName: r.optionName ?? '',
          kgPerBag: r.kgPerBag ?? 0,
          channel: r.channel ?? '',
        }
      }

      const snapshot = {
        label: saveLabel,
        monthKey,
        weekKey,
        trendType: includeInTrend ? trendType : null,
        includeInTrend,
        adFileName: uploads.adCampaign?.fileName,
        sellerFileName: uploads.salesInsight?.fileName,
        // raw 는 메인 row 에 박지 않음 — 별도 type='raw' POST 로 분리 저장 (Vercel 4.5MB body limit 회피)
        adRows: [],
        sellerStats: [],
        periodStartDate: adPeriod.startDate,
        periodEndDate: adPeriod.endDate,
        periodDays: adPeriod.days,
        sellerPeriodDays: adPeriod.days,
        savedAt: new Date().toISOString(),
        summary: diagnosisResult.summary,
        products: diagnosisResult.products,
        unmatched: diagnosisResult.unmatched,
        periodValidation: diagnosisResult.periodValidation,
        period: diagnosisResult.period,
        marginSnapshot,
      }

      // 1차: 메인 row 저장 (raw 제외 → 가벼움)
      const res = await fetch('/api/coupang-diagnoses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'explicit', snapshot }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const newId = json?.id

      // 2차: raw 별도 row 저장 (있으면). 실패해도 frozen view 는 메인만으로 동작 → 경고만 출력.
      if (newId && (rawAdCampaign.length > 0 || rawSalesInsight.length > 0)) {
        try {
          const rawRes = await fetch('/api/coupang-diagnoses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'raw', id: newId, adRows: rawAdCampaign, sellerStats: rawSalesInsight }),
          })
          if (!rawRes.ok) {
            console.warn(`[save] raw 저장 실패 (HTTP ${rawRes.status}) — frozen view 는 정상 동작`)
          }
        } catch (e) {
          console.warn('[save] raw 저장 예외 — frozen view 는 정상 동작:', e)
        }
      }

      // optimistic 업데이트: GET list 왕복 생략
      // 서버 POST 와 동일한 충돌 규칙으로 기존 항목 교체/추가
      if (json?.snapshotMeta) {
        const meta = json.snapshotMeta
        setSavedAnalyses((prev) => {
          const filtered = prev.filter((a) => {
            if (a.id === meta.id) return false
            if (!meta.includeInTrend || !a.includeInTrend) return true
            if (meta.weekKey && a.weekKey === meta.weekKey) return false
            if (
              meta.monthKey &&
              a.monthKey === meta.monthKey &&
              a.trendType !== 'weekly' &&
              meta.trendType !== 'weekly'
            ) return false
            return true
          })
          return [...filtered, meta]
        })
      }

      setShowSaveDialog(false)
      alert(
        includeInTrend
          ? (trendType === 'weekly'
              ? '✓ 저장 완료 (주별 추이 그래프에 추가됨)'
              : '✓ 저장 완료 (월별 추이 그래프에 추가됨)')
          : '✓ 저장 완료'
      )
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
            {/* 마지막 업데이트 데이터 (loadedSnapshot 우선 표시) */}
            <LastUpdateBadge
              analyses={savedAnalyses}
              adPeriod={loadedSnapshot ? {
                startDate: loadedSnapshot.periodStartDate || loadedSnapshot.weekKey || '',
                endDate: loadedSnapshot.periodEndDate || '',
                days: loadedSnapshot.periodDays || 7,
              } : adPeriod}
              snapshotMode={!!loadedSnapshot}
              snapshotSavedAt={loadedSnapshot?.savedAt || loadedSnapshot?.createdAt}
            />

            <div className="flex items-center gap-2">
              {loadedSnapshot && (
                <button
                  onClick={exitSnapshotView}
                  className="text-xs px-3 py-1.5 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100"
                  title="저장된 분석 보기 종료 — 라이브 모드 (현재 업로드된 광고/SELLER 기준)"
                >
                  📌 라이브 모드
                </button>
              )}
              <button
                onClick={() => setShowHistoryPanel(!showHistoryPanel)}
                className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                📊 저장된 분석 ({savedAnalyses.length})
              </button>
              <button
                onClick={() => { if (confirm('광고 + SELLER 데이터를 초기화합니다. (마진마스터는 유지)')) { setLoadedSnapshot(null); resetExceptMargin() } }}
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

        {/* 마진 마스터 단독 view (광고/SELLER 없이 옵션별 마진 분석) */}
        {marginMaster && <MasterDiagnosisView />}

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
            setLoadedSnapshot(null)  // 새 SELLER 업로드 → frozen view 해제, LIVE 모드로
            setSalesInsight(rows, meta)
          }}
          onAdCampaign={(rows: any, meta: any, period: any) => {
            setLoadedSnapshot(null)  // 새 광고 업로드 → frozen view 해제
            setAdCampaign(rows, meta, period)
          }}
        />

        {/* 마스터 통계 */}
        {marginMaster && (
          <div className="mb-6 grid grid-cols-3 gap-4">
            <StatCard label="원가표 상품" value={`${marginMasterStats.costBookRows}개`} />
            <StatCard label="옵션" value={`${marginMasterStats.marginRows}개`} />
            <StatCard label="실판매가 등록" value={`${marginMasterStats.optionsWithActualPrice}개`} />
          </div>
        )}

        {/* 광고 기간 안내 — LIVE 모드에서 광고 업로드 후 SELLER 미업로드 시. frozen view 일 땐 숨김 */}
        {!loadedSnapshot && adPeriod && rawSalesInsight.length === 0 && (
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

        {/* 데이터 부족 안내 — frozen view (loadedSnapshot) 일 땐 baseResult 가 채워지므로 안내 미노출 */}
        {marginMaster && !baseResult && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 text-sm text-gray-700">
            진단을 실행하려면 다음 3개 엑셀이 추가로 필요합니다:
            <ul className="list-disc ml-6 mt-2 space-y-1">
              <li>SELLER_INSIGHTS (옵션별 매출/판매수)</li>
              <li>광고 캠페인 (총 캠페인)</li>
              {!adPeriod && <li className="text-orange-600">광고 기간이 자동 인식되지 않음 → 파일명 확인</li>}
            </ul>
          </div>
        )}

        {/* 진단 결과 — frozen view 또는 LIVE */}
        {baseResult && (
          <>
            {/* 저장 버튼 + 보기 모드 토글 */}
            <div className="mb-4 flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-center gap-3">
                <div className="text-xs text-gray-500">
                  {loadedSnapshot ? '📌 저장된 분석 (frozen view)' : '💡 자동 저장됨'}
                </div>
                {/* 보기 모드 토글 */}
                <div className="flex rounded border border-gray-300 overflow-hidden">
                  <button
                    onClick={() => setViewMode('actual')}
                    className={`px-3 py-1 text-xs font-medium ${
                      viewMode === 'actual' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    실제 기간 ({(loadedSnapshot ? loadedSnapshot.periodDays : adPeriod?.days) || 0}일)
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
            {baseResult.products.length > 0 && (
              <div className="mb-4 flex items-center gap-2">
                <span className="text-sm text-gray-600">📦 상품:</span>
                <select
                  value={selectedAlias}
                  onChange={e => setSelectedAlias(e.target.value)}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm bg-white focus:border-orange-400 focus:outline-none min-w-[280px]"
                >
                  <option value="__ALL__">전체 ({baseResult.products.length}개)</option>
                  {[...baseResult.products]
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
            <SummarySection
              result={displayResult || baseResult}
              viewMode={viewMode}
              prevSummary={prevSummary}
              periodStart={loadedSnapshot ? loadedSnapshot.periodStartDate : adPeriod?.startDate}
              periodEnd={loadedSnapshot ? loadedSnapshot.periodEndDate : adPeriod?.endDate}
              periodDays={loadedSnapshot ? loadedSnapshot.periodDays : adPeriod?.days}
            />

            {/* 월별 추이 그래프 */}
            <TrendChartSection
              analyses={savedAnalyses}
              onPointClick={handleLoadAnalysis}
              selectedAlias={selectedAlias}
              liveResult={displayResult || baseResult}
              liveAdPeriod={adPeriod}
            />

            {/* 기간 검증 배너 */}
            {(() => {
              const v = baseResult.periodValidation
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
            {baseResult.unmatched.optionCount > 0 && (
              <div className="mb-6 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm">
                <strong className="text-yellow-700">⚠ 매칭 누락:</strong>{' '}
                <span className="text-gray-700">
                  마진 마스터에 등록되지 않은 옵션 {baseResult.unmatched.optionCount}개 /
                  매출 {formatKRW(baseResult.unmatched.sellerRevenue)} /
                  광고비 {formatKRW(baseResult.unmatched.adCost)}
                </span>
              </div>
            )}

            {/* 판정 필터 */}
            <div className="mb-4 flex items-center gap-2">
              <FilterChip
                active={verdictFilter === 'all'}
                onClick={() => setVerdictFilter('all')}
                label={`전체 (${baseResult.products.length})`}
              />
              <FilterChip
                active={verdictFilter === 'profitable'}
                onClick={() => setVerdictFilter('profitable')}
                label={`🟢 흑자 (${baseResult.summary.counts.profitable})`}
              />
              <FilterChip
                active={verdictFilter === 'trap'}
                onClick={() => setVerdictFilter('trap')}
                label={`🟡 함정 (${baseResult.summary.counts.trap})`}
              />
              <FilterChip
                active={verdictFilter === 'structural_loss'}
                onClick={() => setVerdictFilter('structural_loss')}
                label={`🔴 적자 (${baseResult.summary.counts.structural_loss})`}
              />
            </div>

            {/* 함정 스캐너 테이블 */}
            <ProductScannerTable products={filteredProducts} />

            {/* 마진 마스터 미매칭 옵션 (광고비 누수) */}
            <UnmatchedAdOptionsSection result={baseResult} />
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

// "2026-04-19" ~ "2026-04-25" → "2026.04.19 ~ 04.25" (같은 달이면 뒤는 MM.DD).
// 다른 달/년은 풀 포맷. 입력 누락이면 null.
function formatPeriodRange(start?: string | null, end?: string | null): string | null {
  if (!start || !end) return null
  const s = new Date(start), e = new Date(end)
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const sy = s.getFullYear(), sm = s.getMonth()+1, sd = s.getDate()
  const ey = e.getFullYear(), em = e.getMonth()+1, ed = e.getDate()
  const startStr = `${sy}.${pad(sm)}.${pad(sd)}`
  if (sy === ey && sm === em) return `${startStr} ~ ${pad(ed)}`
  if (sy === ey) return `${startStr} ~ ${pad(em)}.${pad(ed)}`
  return `${startStr} ~ ${ey}.${pad(em)}.${pad(ed)}`
}

function SummarySection({ result, viewMode, prevSummary, periodStart, periodEnd, periodDays }: {
  result: DiagnosisResult
  viewMode: ViewMode
  prevSummary?: any
  periodStart?: string | null
  periodEnd?: string | null
  periodDays?: number | null
}) {
  const s = result.summary
  // 우선순위: prop periodDays (loadedSnapshot 또는 adPeriod) > result.period.days
  const days = (periodDays && periodDays > 0) ? periodDays : result.period.days

  // 월환산 스케일 (실제 → 30일 환산)
  const scale = viewMode === 'monthly' && days > 0 ? 30 / days : 1
  const adj = (n: number) => n * scale

  // 직전 동일 기간 라벨 ("vs 직전 7일" / "vs 직전 30일" 등)
  const compareLabel = days > 0 ? `vs 직전 ${days}일` : 'vs 직전 기간'

  // 직전 동일 기간 대비 계산
  const compare = (cur: number, prev: number | undefined): { text: string; up: boolean } | null => {
    if (prev === undefined || prev === null || !isFinite(prev) || prev === 0) return null
    const diff = ((cur - prev) / Math.abs(prev)) * 100
    if (Math.abs(diff) < 0.5) return null
    return {
      text: `${diff > 0 ? '▲' : '▼'} ${diff > 0 ? '+' : ''}${diff.toFixed(0)}% ${compareLabel}`,
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

  // 새 KPI 8장 (4×2):
  //  [1행]  총 매출 · 광고 매출 · 오가닉 매출 · 기간
  //  [2행]  광고비 (+VAT) · 총 마진 · 순이익 · ROAS (귀속)
  const adShare = s.totalRevenue > 0 ? (s.totalAdRevenue / s.totalRevenue) * 100 : 0
  const organicShare = s.totalRevenue > 0 ? (s.totalOrganicRevenue / s.totalRevenue) * 100 : 0
  const fmtCount = (n: number) => `${Math.round(adj(n)).toLocaleString('ko-KR')}건`

  return (
    <div className="mb-6">
      {/* 1행: 매출 분해 + 기간 */}
      <div className="grid grid-cols-4 gap-4 mb-3">
        <KpiCard
          label="총 매출"
          value={formatMan(adj(s.totalRevenue))}
          formula="Σ (옵션 판매수 × 마진M 실판매가)"
          sub={fmtCount(s.totalSold ?? 0)}
          compare={cmpRevenue}
          compareGood="up"
        />
        <KpiCard
          label="광고 매출"
          value={formatMan(adj(s.totalAdRevenue))}
          formula="Σ (광고 14일 판매수 × 마진M 실판매가)"
          sub={`${fmtCount(s.totalAdSold ?? 0)} (${adShare.toFixed(1)}%)`}
          compare={cmpAdRev}
          compareGood="up"
        />
        <KpiCard
          label="오가닉 매출"
          value={formatMan(adj(s.totalOrganicRevenue))}
          formula="총 매출 − 광고 매출"
          sub={`${fmtCount(s.totalOrganicSold ?? 0)} (${organicShare.toFixed(1)}%)`}
          compare={cmpOrgRev}
          compareGood="up"
        />
        <KpiCard
          label="기간"
          value={(() => {
            if (viewMode === 'monthly') return '30일 환산'
            const range = formatPeriodRange(periodStart, periodEnd)
            return range || `${days}일`
          })()}
          formula="분석 기간"
          sub={(() => {
            const scaleNote = result.period.sellerScale !== 1 ? `SELLER ×${result.period.sellerScale.toFixed(2)}` : 'SELLER 동일기간'
            if (viewMode === 'monthly') return days !== 30 ? `실제: ${days}일` : scaleNote
            return `${days}일 · ${scaleNote}`
          })()}
        />
      </div>
      {/* 2행: 손익 + ROAS */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard
          label="광고비 (+VAT)"
          value={formatMan(adj(s.totalAdCost))}
          formula="Σ 쿠팡 광고비 × 1.1"
          sub={(() => {
            const u = (result as any).unmatched?.adCost
            if (u && Number.isFinite(u) && u > 0) {
              return `쿠팡 청구 기준 · 매칭 누락 ${formatMan(adj(u))} 포함`
            }
            return '쿠팡 청구 기준'
          })()}
          accent="orange"
          compare={cmpAdCost}
          compareGood="down"
        />
        <KpiCard
          label="총 마진"
          value={formatMan(adj(s.totalMargin))}
          formula="Σ (옵션 판매수 × 마진M 건당순이익)"
          sub={`마진율 ${(s.marginRate*100).toFixed(1)}%`}
          compare={cmpMargin}
          compareGood="up"
        />
        <KpiCard
          label="순이익"
          value={formatMan(adj(s.totalNetProfit), true)}
          formula="총 마진 − 광고비 (+VAT)"
          sub="총 마진 − 광고비"
          accent={adj(s.totalNetProfit) >= 0 ? 'green' : 'red'}
          compare={cmpProfit}
          compareGood="up"
        />
        <KpiCard
          label="ROAS (귀속)"
          value={formatPct(s.adRoasAttr)}
          formula="광고 매출 ÷ 광고비 × 100"
          sub="실판매가 기준"
          compare={cmpRoas}
          compareGood="up"
        />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 추이 차트 헬퍼 — hit area 큰 dot, 컴팩트한 툴팁
// ─────────────────────────────────────────────────────────────

// 투명 r=14 hit area + 시각 r=3 원 (ROAS 추이 default dot 과 동일 스타일: 흰 fill + 라인색 테두리).
// 17점 빽빽한 차트도 점 클릭 쉬움.
const BigHitDot = (props: any) => {
  const { cx, cy, stroke, onPointClick, payload } = props
  if (cx == null || cy == null || isNaN(cx) || isNaN(cy)) return null
  const color = stroke || '#666'
  const handleClick = (e: any) => {
    if (onPointClick && payload?._analysis) onPointClick(payload._analysis)
    try { (e?.currentTarget as any)?.blur?.() } catch {}
    try { (document.activeElement as HTMLElement | null)?.blur?.() } catch {}
  }
  return (
    <g tabIndex={-1} style={{ outline: 'none' }}>
      <circle
        cx={cx}
        cy={cy}
        r={14}
        fill="transparent"
        style={{ cursor: onPointClick ? 'pointer' : 'default', outline: 'none' }}
        tabIndex={-1}
        onClick={onPointClick ? handleClick : undefined}
      />
      <circle cx={cx} cy={cy} r={3} fill="#fff" stroke={color} strokeWidth={2} style={{ outline: 'none' }} tabIndex={-1} />
    </g>
  )
}

// 컴팩트 툴팁 — 폰트/padding 축소, 항목 순서 강제 (매출 → 광고비 → 순이익)
const CompactTrendTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const order: Record<string, number> = { '매출': 1, '광고비': 2, '순이익': 3 }
  const items = [...payload]
    .filter(p => p.dataKey in order)
    .sort((a, b) => (order[a.dataKey] ?? 9) - (order[b.dataKey] ?? 9))
  return (
    <div className="rounded border border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm px-2 py-1.5 text-[11px]">
      <div className="font-medium text-gray-700 mb-0.5">{label}</div>
      {items.map((p: any) => {
        const v = p.value ?? 0
        const isProfit = p.dataKey === '순이익'
        const valueClass = isProfit
          ? (v < 0 ? 'font-mono font-bold text-red-600' : 'font-mono font-bold text-green-600')
          : 'font-mono text-gray-900'
        return (
          <div key={p.dataKey} className="flex items-center gap-1.5 leading-tight">
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
            <span className="text-gray-500 w-10">{p.dataKey}</span>
            <span className={valueClass}>{v.toLocaleString()}만원</span>
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 월별 추이 그래프
// ─────────────────────────────────────────────────────────────

function TrendChartSection({ analyses, onPointClick, selectedAlias, liveResult, liveAdPeriod }: {
  analyses: any[]
  onPointClick?: (a: any) => void
  selectedAlias?: string
  /** 현재 진단 결과 — 그래프 마지막 점이 같은 기간이면 frozen 대신 이걸로 사용 */
  liveResult?: any
  /** 현재 분석 기간 — 매칭 키 (weekKey/monthKey) 산출용 */
  liveAdPeriod?: { startDate: string; endDate: string; days: number } | null
}) {
  const [chartMode, setChartMode] = useState<'weekly' | 'monthly'>('weekly')
  const isFiltered = selectedAlias && selectedAlias !== '__ALL__'

  // 현재 진단 기간의 weekKey / monthKey 계산 (saved analysis 와 같은 규칙)
  const liveWeekKey = liveAdPeriod?.startDate || null
  const liveMonthKey = (() => {
    if (!liveAdPeriod?.endDate) return null
    const d = new Date(liveAdPeriod.endDate)
    if (!Number.isFinite(d.getTime())) return null
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })()

  // 현재 진단 결과를 saved-analysis 와 같은 형태의 summary 로 변환
  const liveSummary = (() => {
    if (!liveResult?.summary) return null
    if (!isFiltered) return liveResult.summary
    const found = (liveResult.products || []).find((p: any) => p.alias === selectedAlias)
    if (!found) return null
    return {
      totalRevenue: found.revenue || 0,
      totalAdRevenue: found.adRevenue || 0,
      totalCampaignRevenue: found.campaignRevenue || 0,
      totalAdCost: found.adCost || 0,
      totalNetProfit: found.totalNetProfit || 0,
      adRoasAttr: found.adRoasAttr || 0,
      adRoasCamp: found.adRoasCamp || 0,
      adDependency: found.adDependency || 0,
    }
  })()

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
      totalCampaignRevenue: found.campaignRevenue || 0,
      totalAdCost: found.adCost || 0,
      totalNetProfit: found.totalNetProfit || 0,
      adRoasAttr: found.adRoasAttr || 0,
      adRoasCamp: found.adRoasCamp || 0,
      adDependency: found.adDependency || 0,
    }
  }

  // 주별 데이터 — 항상 saved summary 그대로 (LIVE swap 제거. frozen view 와 hover/click 일관)
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
          _analysis: a,
          _isLive: false,
        }
      })
      .filter(Boolean) as any[]
  }, [analyses, selectedAlias])

  // 월별 데이터 — 항상 saved summary 그대로
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
          _isLive: false,
        }
      })
      .filter(Boolean) as any[]
  }, [analyses, selectedAlias])

  const trendData = chartMode === 'weekly' ? weeklyData : monthlyData
  const periodLabel = chartMode === 'weekly' ? '주' : '월'
  // frozen(LIVE 가 아닌) 점이 하나라도 있으면 사용자에게 재계산 안내
  const frozenCount = trendData.filter((d: any) => !d._isLive).length
  const hasLivePoint = trendData.some((d: any) => d._isLive)

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
        <div
          tabIndex={-1}
          className="focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none"
          style={{ outline: 'none' }}
        >
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={trendData} tabIndex={-1} style={{ outline: 'none' }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v < 0 ? '' : `${v.toLocaleString()}만`} />
            <Tooltip
              content={<CompactTrendTooltip />}
              offset={20}
              cursor={{ stroke: '#f97316', strokeWidth: 24, strokeOpacity: 0.10 }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="매출"
              stroke="#2563eb"
              strokeWidth={2}
              dot={<BigHitDot onPointClick={onPointClick} />}
              activeDot={{
                r: 10,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: (_: any, ev: any) => {
                  if (!onPointClick) return
                  const idx = ev?.index
                  if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
                  try { (ev?.currentTarget as any)?.blur?.() } catch {}
                  try { (document.activeElement as HTMLElement | null)?.blur?.() } catch {}
                },
              }}
            />
            <Line
              type="monotone"
              dataKey="광고비"
              stroke="#f97316"
              strokeWidth={2}
              dot={<BigHitDot onPointClick={onPointClick} />}
              activeDot={{
                r: 10,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: (_: any, ev: any) => {
                  if (!onPointClick) return
                  const idx = ev?.index
                  if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
                  try { (ev?.currentTarget as any)?.blur?.() } catch {}
                  try { (document.activeElement as HTMLElement | null)?.blur?.() } catch {}
                },
              }}
            />
            <Line
              type="monotone"
              dataKey="순이익"
              stroke="#10b981"
              strokeWidth={2}
              dot={<BigHitDot onPointClick={onPointClick} />}
              activeDot={{
                r: 10,
                cursor: onPointClick ? 'pointer' : 'default',
                onClick: (_: any, ev: any) => {
                  if (!onPointClick) return
                  const idx = ev?.index
                  if (idx != null && trendData[idx]?._analysis) onPointClick(trendData[idx]._analysis)
                  try { (ev?.currentTarget as any)?.blur?.() } catch {}
                  try { (document.activeElement as HTMLElement | null)?.blur?.() } catch {}
                },
              }}
            />
          </LineChart>
        </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold mb-3">📊 ROAS 추이</h3>
          <div
            tabIndex={-1}
            className="focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none"
            style={{ outline: 'none' }}
          >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData} tabIndex={-1} style={{ outline: 'none' }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip formatter={(v: any) => `${v}%`} />
              <Line type="monotone" dataKey="ROAS" stroke="#8b5cf6" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold mb-3">📊 광고 의존도</h3>
          <div
            tabIndex={-1}
            className="focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none"
            style={{ outline: 'none' }}
          >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData} tabIndex={-1} style={{ outline: 'none' }}>
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

type SortKey = 'alias' | 'revenue' | 'adCost' | 'adRevenue' | 'organicRevenue' | 'adNetProfit' | 'totalNetProfit' | 'marginRate' | 'bepRoas' | 'adRoasAttr' | 'gap' | 'verdict'
type SortDir = 'asc' | 'desc'

// gap_pp = ROAS(%) − BEP_ROAS(배율) × 100. ±5%p 이내 노랑 (광고 ON/OFF 경계). 광고 미집행이면 null.
function computeGapPp(adRoasAttr: number | null | undefined, bepRoasRatio: number | null | undefined): number | null {
  if (adRoasAttr == null || !Number.isFinite(adRoasAttr)) return null
  if (bepRoasRatio == null || !Number.isFinite(bepRoasRatio)) return null
  return adRoasAttr - bepRoasRatio * 100
}
function gapToneClass(g: number | null): string {
  if (g == null) return 'text-gray-400'
  if (g >= 5) return 'text-green-700'
  if (g <= -5) return 'text-red-700'
  return 'text-amber-600'
}
function formatGap(g: number | null): string {
  if (g == null) return '–'
  const sign = g > 0 ? '+' : ''
  return `${sign}${g.toFixed(0)}%p`
}

function ProductScannerTable({ products }: { products: ProductDiagnosis[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('totalNetProfit')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedAlias, setExpandedAlias] = useState<Set<string>>(new Set())

  const sortedProducts = useMemo(() => {
    const arr = [...products]
    // gap_pp = adRoasAttr(%) − bepRoas(배율) × 100. 둘 중 하나라도 없으면 정렬 시 가장 뒤로
    const gapOf = (p: any) => {
      if (p.adRoasAttr == null || p.bepRoas == null) return Number.NEGATIVE_INFINITY
      return p.adRoasAttr - p.bepRoas * 100
    }
    arr.sort((a: any, b: any) => {
      let av: any, bv: any
      if (sortKey === 'alias') { av = a.alias; bv = b.alias }
      else if (sortKey === 'verdict') { av = a.verdict; bv = b.verdict }
      else if (sortKey === 'gap') { av = gapOf(a); bv = gapOf(b) }
      else if (sortKey === 'bepRoas') { av = a.bepRoas ?? Number.NEGATIVE_INFINITY; bv = b.bepRoas ?? Number.NEGATIVE_INFINITY }
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
              <th className="text-left px-4 py-3 font-medium sticky left-0 top-0 bg-gray-50 z-30 cursor-pointer hover:text-gray-900 select-none whitespace-nowrap min-w-[200px] border-r border-gray-200 shadow-[2px_0_4px_rgba(0,0,0,0.05)]"
                  onClick={() => toggleSort('alias')}>
                별칭
                {sortKey === 'alias' && (
                  <span className="ml-1 text-orange-500">{sortDir === 'desc' ? '▼' : '▲'}</span>
                )}
              </th>
              <th className="text-left px-3 py-3 font-medium sticky top-0 bg-gray-50 z-20 select-none whitespace-nowrap min-w-[120px]">
                채널
              </th>
              <th className="text-right px-3 py-3 font-medium sticky top-0 bg-gray-50 z-20 cursor-pointer hover:text-gray-900 select-none whitespace-nowrap"
                  onClick={() => toggleSort('revenue')}>
                매출
                {sortKey === 'revenue' && (
                  <span className="ml-1 text-orange-500">{sortDir === 'desc' ? '▼' : '▲'}</span>
                )}
              </th>
              <SortHeader k="adCost" label="광고비 (+VAT)" />
              <SortHeader k="adRevenue" label="광고매출" />
              <SortHeader k="organicRevenue" label="오가닉매출" />
              <SortHeader k="adNetProfit" label="광고손익" />
              <SortHeader k="totalNetProfit" label="순이익" />
              <SortHeader k="marginRate" label="마진율" />
              <SortHeader k="bepRoas" label="BEP ROAS" />
              <SortHeader k="adRoasAttr" label="ROAS" />
              <SortHeader k="gap" label="갭" />
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
                    className={`group hover:bg-blue-50 cursor-pointer ${style.bg}`}
                    onClick={() => toggleExpand(p.alias)}
                  >
                    <td className={`px-4 py-3 sticky left-0 z-10 min-w-[200px] ${style.bg} group-hover:bg-blue-50 border-r border-gray-200 shadow-[2px_0_4px_rgba(0,0,0,0.05)]`}>
                      <div className="font-medium flex items-center gap-1">
                        <span className="text-gray-400 text-xs">{isExpanded ? '▼' : '▶'}</span>
                        {p.alias}
                      </div>
                      <div className="text-xs text-gray-500 ml-4">
                        {p.optionCount}개 옵션 · 노출ID {p.exposureIds.length}개
                      </div>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap min-w-[120px]">
                      <ChannelDistribution channels={(p.optionDetails ?? []).map((o) => o.channel ?? '')} />
                    </td>
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap min-w-[90px]">
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
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap min-w-[70px] text-gray-600">
                      {p.bepRoas != null ? `${(p.bepRoas * 100).toFixed(0)}%` : '–'}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap min-w-[60px]">
                      {p.adRoasAttr ? `${p.adRoasAttr.toFixed(0)}%` : '–'}
                    </td>
                    {(() => {
                      const g = computeGapPp(p.adRoasAttr, p.bepRoas)
                      return (
                        <td className={`px-3 py-3 text-right font-mono text-xs font-semibold whitespace-nowrap min-w-[70px] ${gapToneClass(g)}`}>
                          {formatGap(g)}
                        </td>
                      )
                    })()}
                    <td className={`px-3 py-3 ${style.text} text-xs font-medium whitespace-nowrap`}>
                      {style.dot} {style.label}
                    </td>
                  </tr>
                  {/* 옵션별 드릴다운 */}
                  {isExpanded && p.optionDetails && p.optionDetails.length > 0 && p.optionDetails.map((opt) => {
                    const optStyle = VERDICT_STYLES[opt.verdict]
                    return (
                      <tr key={`${p.alias}-${opt.optionId}`} className="bg-blue-50/50">
                        <td className="pl-12 pr-4 py-2 sticky left-0 z-10 bg-blue-50 min-w-[200px] border-r border-gray-200 shadow-[2px_0_4px_rgba(0,0,0,0.05)]">
                          <div className="text-xs text-gray-700">└ {opt.optionName}</div>
                          <div className="text-[10px] text-gray-400">옵션ID {opt.optionId}</div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap min-w-[120px]">
                          <ChannelBadge raw={opt.channel} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap min-w-[90px]">
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
                        <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap min-w-[70px] text-gray-600">
                          {opt.bepRoas != null ? `${(opt.bepRoas * 100).toFixed(0)}%` : '–'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap min-w-[60px]">
                          {opt.adRoasAttr ? `${opt.adRoasAttr.toFixed(0)}%` : '–'}
                        </td>
                        {(() => {
                          const g = computeGapPp(opt.adRoasAttr, opt.bepRoas)
                          return (
                            <td className={`px-3 py-2 text-right font-mono text-[11px] font-semibold whitespace-nowrap min-w-[70px] ${gapToneClass(g)}`}>
                              {formatGap(g)}
                            </td>
                          )
                        })()}
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

function LastUpdateBadge({ analyses, adPeriod, snapshotMode, snapshotSavedAt }: {
  analyses: any[]
  adPeriod: { startDate: string; endDate: string; days: number } | null
  snapshotMode?: boolean
  snapshotSavedAt?: string
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

  // 표시할 정보 결정 — snapshot 모드면 frozen 라벨, adPeriod 있으면 라이브, 없으면 누적 fallback
  let label = ''
  let detail = ''
  let savedLine: string | null = null

  if (adPeriod) {
    label = snapshotMode ? '📌 저장된 분석 (frozen view)' : '현재 보고 있는 분석'
    detail = `${adPeriod.startDate} ~ ${adPeriod.endDate} (${adPeriod.days}일)`
    if (snapshotMode && snapshotSavedAt) {
      const d = new Date(snapshotSavedAt)
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0')
        savedLine = `저장: ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      }
    }
  } else if (latestWeekly || latestMonthly) {
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
  } else {
    return null
  }

  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">마지막 업데이트 데이터</div>
      <div className="text-sm font-mono font-medium text-gray-800 mt-0.5">{detail}</div>
      <div className="text-[10px] text-gray-400">{label}</div>
      {savedLine && <div className="text-[10px] text-blue-600 font-mono">{savedLine}</div>}
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

// 마진 마스터 미매칭 옵션 — 광고비가 발생 중인데 마스터에 없는 옵션 추적
function UnmatchedAdOptionsSection({ result }: { result: any }) {
  const list: any[] = result?.unmatched?.adOptions || []
  const totalAdCost = result?.unmatched?.adCost || 0
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  if (list.length === 0) return null

  const TOP_N = 10
  const display = showAll ? list : list.slice(0, TOP_N)

  function copyOptionId(id: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(id).then(() => {
        setCopied(id)
        setTimeout(() => setCopied(null), 1200)
      }).catch(() => {})
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50/40">
      <div className="px-4 py-3 border-b border-amber-200 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-amber-900">🔍 마진 마스터 미매칭 옵션 (광고비 누수)</div>
          <div className="text-xs text-amber-800 mt-0.5">
            마진 마스터에 등록 안 된 옵션에 광고비가 발생 중. 단종이면 쿠팡 광고센터에서 광고 끄거나, 신규/변경 옵션이면 마진 마스터에 추가하세요.
          </div>
        </div>
        <div className="text-xs text-amber-900 text-right whitespace-nowrap">
          <div>옵션 <strong>{list.length}</strong>개</div>
          <div>광고비 <strong>{Math.round(totalAdCost / 10000).toLocaleString('ko-KR')}만</strong></div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-amber-100/60">
            <tr>
              <th className="px-3 py-2 text-left text-amber-900">옵션ID</th>
              <th className="px-3 py-2 text-left text-amber-900">캠페인명</th>
              <th className="px-3 py-2 text-left text-amber-900">상품명</th>
              <th className="px-3 py-2 text-left text-amber-900">옵션</th>
              <th className="px-3 py-2 text-right text-amber-900">광고비 (+VAT)</th>
              <th className="px-3 py-2 text-right text-amber-900">광고매출</th>
              <th className="px-3 py-2 text-right text-amber-900">ROAS</th>
              <th className="px-3 py-2 text-center text-amber-900">복사</th>
            </tr>
          </thead>
          <tbody>
            {display.map((o: any, i: number) => {
              const roas = o.adCost > 0 ? (o.adRevenue / o.adCost) * 100 : null
              return (
                <tr key={o.optionId} className={`border-t border-amber-100 ${i % 2 ? 'bg-amber-50/30' : ''}`}>
                  <td className="px-3 py-1.5 font-mono text-gray-800">{o.optionId}</td>
                  <td className="px-3 py-1.5 text-gray-700">{(o.campaigns || []).join(' / ') || '—'}</td>
                  <td className="px-3 py-1.5 text-gray-800">{o.productName || '—'}</td>
                  <td className="px-3 py-1.5 text-gray-600">{o.optionLabel || '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-900">{Math.round(o.adCost).toLocaleString('ko-KR')}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-700">{Math.round(o.adRevenue).toLocaleString('ko-KR')}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-700">{roas != null ? `${Math.round(roas)}%` : '—'}</td>
                  <td className="px-3 py-1.5 text-center">
                    <button
                      onClick={() => copyOptionId(o.optionId)}
                      className="text-[11px] px-1.5 py-0.5 rounded border border-amber-300 bg-white text-amber-800 hover:bg-amber-100"
                    >
                      {copied === o.optionId ? '✓ 복사됨' : '📋 ID 복사'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {list.length > TOP_N && (
        <div className="px-4 py-2 border-t border-amber-200 text-center">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-amber-800 hover:underline"
          >
            {showAll ? `상위 ${TOP_N}개만 보기` : `전체 ${list.length}개 보기 (현재 ${TOP_N}개 표시)`}
          </button>
        </div>
      )}
    </div>
  )
}
