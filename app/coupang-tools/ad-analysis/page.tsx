'use client'

/**
 * 광고 분석 페이지 (/coupang-tools/ad-analysis)
 *
 * 데이터 소스: store 의 rawAdCampaign (parseAdCampaign 결과) + marginMaster (BEP).
 * 1차 범위: 캠페인 진단 + AI 키워드 분석 + 수동 입찰가 점검 (현재 입찰가는 사용자 직접 입력).
 * 자동 입찰 적용은 영구 안 함 — 사용자가 키워드 복사해서 쿠팡 광고센터에 직접 입력.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getDefaultConstants } from '@/lib/coupang/costBook'
import { build1PView, isRetailRow, augmentMasterWith1P, type OnePView } from '@/lib/coupang/onePAnalysis'
import { downloadFormattedXlsx, type XlsxCol } from '@/lib/xlsxExport'
import { unpackAdRows } from '@/lib/coupang/adRowsPack'
import { extractPeriodFromFileName } from '@/lib/coupang/parsers/adCampaign'
import { useConfirm } from '@/components/ui/useConfirm'
import { useMarginStore } from '@/lib/coupang/store'
import { parseAdCampaign } from '@/lib/coupang/parsers/adCampaign'
import {
  buildAdAnalysisView,
  buildKeywordRows,
  buildManualReviewRows,
  buildBepMap,
  buildBepCpcForCampaign,
  buildActualPriceMapById,
  buildMarginRowMap,
  buildExposureMapByOptionId,
  splitRowRevenue,
  isSearchPlacement,
  type CampaignDiag,
  type KeywordRow,
  type ManualKeywordRow,
  hasBidSample,
  bepCpcLabel,
} from '@/lib/coupang/adAnalysis'
import type { AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import { ChannelBadge } from '../_lib/channel'
import { buildWeeklyActions, campaignStatusOf, parseCampaignTargetKey, type CampaignActions } from '@/lib/coupang/weeklyActions'
import {
  ProfitLine,
  StatusBoxes,
  WarningLine,
  WeekCompareBox,
  WeeklyActionsSection,
  ProductNote,
  reflectMemoText,
  type ProductMonthNote,
  snapshotFromView,
  type ReflectNote,
  type WeeklySnapshot,
} from './WeeklyPanel'

type Mode = 'saved' | 'live'

// ── formatters ────────────────────────────────────────────────
const fmtMan = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—'
  const man = n / 10000
  return `${Math.round(man).toLocaleString('ko-KR')}만`
}
const fmtNum = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : Math.round(n).toLocaleString('ko-KR')
const fmtPctVal = (n: number | null | undefined, digits = 0): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${n.toFixed(digits)}%`
const fmtRoas = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${Math.round(n)}%`
const fmtBid = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`
// 쿠팡 입찰가 10원 단위 정책 — 추천 입찰가 노출 우선 올림
const ceilToTen = (v: number): number => Math.ceil(v / 10) * 10

// ── Generic sort ──────────────────────────────────────────────
type SortDir = 'asc' | 'desc'
function useSort<T extends Record<string, any>>(rows: T[], defaultKey: keyof T, defaultDir: SortDir = 'desc') {
  const [key, setKey] = useState<keyof T>(defaultKey)
  const [dir, setDir] = useState<SortDir>(defaultDir)
  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      const isNumA = typeof av === 'number' && Number.isFinite(av)
      const isNumB = typeof bv === 'number' && Number.isFinite(bv)
      // null/undefined/NaN 은 정렬 방향과 무관하게 항상 맨 뒤
      if (!isNumA && !isNumB && av == null && bv == null) return 0
      if (isNumA && !isNumB) return -1
      if (!isNumA && isNumB) return 1
      let cmp = 0
      if (isNumA && isNumB) cmp = (av as number) - (bv as number)
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      return dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [rows, key, dir])
  function toggle(k: keyof T) {
    if (key === k) setDir(dir === 'asc' ? 'desc' : 'asc')
    else { setKey(k); setDir('desc') }
  }
  return { sorted, key, dir, toggle }
}

// 셀 내 목표 ROAS 입력 — debounce 500ms + onBlur 즉시 flush
function TargetRoasInput({
  value,
  onChange,
}: {
  value: number | null
  onChange: (v: number | null) => void
}) {
  const [local, setLocal] = useState<string>(value != null ? String(value) : '')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocal(value != null ? String(value) : '')
  }, [value])

  const flush = (raw: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    const trimmed = raw.trim()
    if (trimmed === '') { onChange(null); return }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n <= 0) return
    onChange(Math.round(n))
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <input
        type="number"
        min={0}
        inputMode="numeric"
        placeholder="예: 400"
        value={local}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value
          setLocal(v)
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => flush(v), 500)
        }}
        onBlur={() => flush(local)}
        style={{
          width: 58, padding: '2px 4px',
          border: '1px solid #CBD5E1', borderRadius: 4,
          fontSize: 12, textAlign: 'right',
          fontFamily: 'inherit',
        }}
      />
      <span style={{ fontSize: 11, color: '#94A3B8' }}>%</span>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────
export default function AdAnalysisPage() {
  const marginMaster = useMarginStore((s) => s.marginMaster)
  // 마진 출처 — 나무_마스터가 아니면(예비 경로: Supabase 옛 저장본) 경고
  const marginMeta = useMarginStore((s) => s.uploads.marginMaster)
  const rawAdCampaign = useMarginStore((s) => s.rawAdCampaign)
  const adPeriod = useMarginStore((s) => s.adPeriod)
  const adMeta = useMarginStore((s) => s.uploads.adCampaign)
  const adAnalysisLive = useMarginStore((s) => s.adAnalysisLive)
  const setMarginMaster = useMarginStore((s) => s.setMarginMaster)
  const setAdCampaign = useMarginStore((s) => s.setAdCampaign)
  const setSalesInsight = useMarginStore((s) => s.setSalesInsight)
  const setAdAnalysisLive = useMarginStore((s) => s.setAdAnalysisLive)
  const clearAdAnalysisLive = useMarginStore((s) => s.clearAdAnalysisLive)
  const [mode, setMode] = useState<Mode>('saved')
  const [openCampId, setOpenCampId] = useState<string | null>(null)
  // 캠페인 진단 표 인라인 옵션 드릴다운: 옵션 클릭 시 상세 영역 키워드도 옵션 단위로 필터링.
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [autoLoading, setAutoLoading] = useState(true)
  // 쿠팡 손익 월 저장본 — 광고가 저장된 달 목록 (최신순) · 불러오는 중인 달
  const [pnlMonths, setPnlMonths] = useState<string[]>([])
  const [monthLoading, setMonthLoading] = useState<string | null>(null)
  // 지금 저장 탭 데이터가 어느 달 저장본인지 (쿠팡 손익 화면에서 주입한 경우 포함 — 파일명 표식)
  const srcMonth = String(adMeta?.fileName || '').match(/\((\d{4}-\d{2}) 월 저장본\)/)?.[1] ?? null

  /** 쿠팡 손익 월 저장본(키워드 포함 광고 행 + 기간 + 3P 판매) → 저장 탭 데이터 */
  const loadPnlMonth = async (m: string) => {
    setMonthLoading(m)
    try {
      const get = async (k: string) => {
        try { return await (await fetch(`/api/coupang-master?type=pnl_${k}_${m}`)).json() } catch { return null }
      }
      const [ad, kw, seller] = await Promise.all([get('ad'), get('adkw'), get('seller')])
      const kwRows = unpackAdRows(kw?.data)
      const rows: AdCampaignRow[] = kwRows.length ? kwRows : (ad?.data?.rows || [])
      if (!rows.length) return false
      const fromName = extractPeriodFromFileName(ad?.fileName || kw?.fileName || '')
      const start: string | null = ad?.data?.startDate || fromName?.startDate || null
      const end: string | null = ad?.data?.endDate || fromName?.endDate || null
      const days = start && end ? Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1 : null
      setAdCampaign(rows, {
        fileName: `${ad?.fileName || kw?.fileName || '광고'} (${m} 월 저장본)`,
        uploadedAt: ad?.savedAt || new Date().toISOString(),
        rowCount: rows.length,
      }, start && end && days ? { startDate: start, endDate: end, days } : null)
      if (seller?.data?.rows?.length) {
        setSalesInsight(seller.data.rows, { fileName: seller.fileName || '저장본', uploadedAt: seller.savedAt, rowCount: seller.data.rows.length })
      }
      setOpenCampId(null)
      setSelectedOptionId(null)
      return true
    } finally {
      setMonthLoading(null)
    }
  }
  const [uploadError, setUploadError] = useState<string | null>(null)

  // 게스트 계정(role='게스트'): 라이브 탭만 사용. 저장 탭·추세차트·저장데이터 로드 전부 차단.
  const [isGuest, setIsGuest] = useState(false)
  useEffect(() => {
    try {
      if (JSON.parse(localStorage.getItem('user') || '{}')?.role === '게스트') {
        setIsGuest(true)
        setMode('live') // 라이브 고정
      }
    } catch {
      /* 파싱 실패 무시 */
    }
  }, [])

  // 목표 ROAS — 사용자 입력값 (prefix::타입 → %). 분석 갱신과 무관하게 유지.
  const [targets, setTargets] = useState<Record<string, number>>({})
  useEffect(() => {
    // 게스트는 회사 저장데이터(목표 ROAS 포함) 미조회
    try { if (JSON.parse(localStorage.getItem('user') || '{}')?.role === '게스트') return } catch {}
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/campaign-targets')
        const json = await res.json()
        if (!cancelled && json?.targets && typeof json.targets === 'object') {
          setTargets(json.targets as Record<string, number>)
        }
      } catch {
        // 로드 실패는 무시 — 빈 상태로 시작.
      }
    })()
    return () => { cancelled = true }
  }, [])
  const setTargetForKey = (key: string, value: number | null) => {
    setTargets((prev) => {
      const next = { ...prev }
      if (value == null) delete next[key]
      else next[key] = value
      return next
    })
    // 백엔드 저장 — 응답 안 기다림 (낙관적 업데이트)
    fetch('/api/campaign-targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    }).catch((err) => console.error('[campaign-targets] save 실패:', err))
  }

  function openCampaignAndOption(campaignId: string, optionId: string | null) {
    setOpenCampId(campaignId)
    setSelectedOptionId((prev) => (prev === optionId ? null : optionId))
  }
  function toggleCampaign(id: string) {
    setOpenCampId((prev) => (prev === id ? null : id))
    // 다른 캠페인 펼치면 옵션 필터 해제
    if (openCampId !== id) setSelectedOptionId(null)
  }

  // 마운트 시점 자동 로드 — 수익 진단 페이지를 거치지 않고 직접 진입해도 동작.
  // 진단 페이지의 자동 로드 로직 중 광고 분석에 필요한 것만 발췌:
  //  1) marginMaster (BEP/단가 lookup)
  //  2) 가장 최근 주차 광고 분석 → setAdCampaign + setSalesInsight (주차 기간 + 광고 raw row)
  // settle/price/savedAnalyses 등 광고 분석에서 안 쓰는 것은 생략.
  // 이미 store 에 데이터가 있으면 fetch 안 함 (다른 페이지에서 먼저 로드된 경우).
  useEffect(() => {
    // 게스트는 저장 분석(마진마스터·주차 진단) 자동 로드 차단 — 라이브 업로드만 사용
    try {
      if (JSON.parse(localStorage.getItem('user') || '{}')?.role === '게스트') {
        setAutoLoading(false)
        return
      }
    } catch {}
    let cancelled = false
    const needMaster = !marginMaster
    const needAd = !rawAdCampaign || rawAdCampaign.length === 0 || !adPeriod


    ;(async () => {
      try {
        if (needMaster) {
          // 1차: 나무_마스터 마진계산(쿠팡 3P 행) · 2차(폴백): 엑셀 업로드 저장본(Supabase)
          let marginLoaded = false
          try {
            const res = await fetch('/api/coupang-margin-master')
            const json = await res.json()
            if (!cancelled && json?.ok && Array.isArray(json.marginRows) && json.marginRows.length > 0) {
              setMarginMaster(
                { costBook: [], marginRows: json.marginRows, constants: getDefaultConstants(), onePRows: json.onePRows || [] },
                {
                  fileName: '나무_마스터 마진계산(쿠팡 3P)',
                  uploadedAt: new Date().toISOString(),
                  rowCount: json.marginRows.length,
                },
              )
              marginLoaded = true
            }
          } catch (err) {
            console.error('나무_마스터 마진계산 로드 실패, 업로드 저장본으로 폴백:', err)
          }
          if (!marginLoaded && !cancelled) {
            const masterRes = await fetch('/api/coupang-master?type=margin_master')
            const masterJson = await masterRes.json()
            if (!cancelled && masterJson?.data) {
              setMarginMaster(masterJson.data, {
                fileName: masterJson.fileName || '저장된 데이터',
                uploadedAt: masterJson.savedAt || new Date().toISOString(),
                rowCount: masterJson.data?.marginRows?.length || 0,
              })
            }
          }
        }

        // 쿠팡 손익 월 저장본 목록 — 이번 달, 없으면 가장 최근 달을 불러온다.
        // (주간 저장본은 자동으로 열지 않음 — 추이 차트/저장된 분석에서 직접 고를 때만)
        let months: string[] = []
        try {
          const mj = await (await fetch('/api/coupang-master?type=pnl_months')).json()
          months = Object.entries((mj?.months || {}) as Record<string, string[]>)
            .filter(([, kinds]) => kinds.includes('ad') || kinds.includes('adkw'))
            .map(([m]) => m)
            .sort((x, y) => y.localeCompare(x))
        } catch { /* 목록 없음 */ }
        if (!cancelled) setPnlMonths(months)
        if (needAd && !cancelled && months.length) {
          const thisMonth = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)
          await loadPnlMonth(months.includes(thisMonth) ? thisMonth : months[0])
        }
      } catch (err) {
        console.error('[ad-analysis] 자동 로드 실패:', err)
      } finally {
        if (!cancelled) setAutoLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 모드별 source 분기
  const sourceRows = mode === 'live' ? (adAnalysisLive?.rows ?? null) : rawAdCampaign
  const sourcePeriod = mode === 'live' ? (adAnalysisLive?.period ?? null) : adPeriod
  const periodLabel = sourcePeriod
    ? `${sourcePeriod.startDate}_${sourcePeriod.endDate}`
    : new Date().toISOString().slice(0, 10)

  // 마진마스터 없으면 광고 전용 렌더(매출=revenue14d). 옵션별 수기 BEP 입력 시 판정 복원.
  const marginOff = !marginMaster
  const [manualBep, setManualBep] = useState<Record<string, number>>({})
  const manualBepMap = useMemo(() => {
    const m = new Map<string, number>()
    if (marginOff) {
      for (const [k, v] of Object.entries(manualBep)) {
        if (Number.isFinite(v) && v > 0) m.set(String(k).trim(), v)
      }
    }
    return m
  }, [manualBep, marginOff])
  // BEP 판정/추천입찰가를 숨길지 — 마진 없고 수기 BEP도 하나도 없을 때만 숨김
  const hideBep = marginOff && manualBepMap.size === 0

  // 채널 분리 — 3P 는 기존 계산 그대로(rows3P), 쿠팡 1P(판매방식 Retail)는 별도 1P 계산
  const rows3P = useMemo(() => (sourceRows ? sourceRows.filter((r) => !isRetailRow(r)) : null), [sourceRows])
  const onePView: OnePView = useMemo(
    () => build1PView(sourceRows, (marginMaster as any)?.onePRows, (marginMaster as any)?.marginRows),
    [sourceRows, marginMaster],
  )
  const [chFilter, setChFilter] = useState<'all' | '3P' | '1P'>('all')
  // 1P 캠페인도 3P 와 같은 표·키워드·입찰가 흐름으로 — 마진 마스터에 1P 옵션 합성 행을 붙여 같은 계산에 태운다
  const masterAug = useMemo(() => augmentMasterWith1P(marginMaster as any, sourceRows), [marginMaster, sourceRows])
  // 상품 필터 (?alias= — 쿠팡 손익 상품별 판정 "광고 보기") — 그 별칭 옵션을 광고하거나 전환한 캠페인만
  const [aliasFilter, setAliasFilter] = useState<string | null>(null)
  useEffect(() => {
    try { setAliasFilter(new URLSearchParams(window.location.search).get('alias') || null) } catch { /* 무시 */ }
  }, [])
  const clearAliasFilter = () => {
    setAliasFilter(null)
    try { window.history.replaceState(null, '', window.location.pathname) } catch { /* 무시 */ }
  }
  const aliasCampaignIds = useMemo(() => {
    if (!aliasFilter || !sourceRows) return null
    const aliasOf = new Map(((masterAug as any)?.marginRows || []).map((r: any) => [String(r.optionId).trim(), r.alias as string]))
    const ids = new Set<string>()
    for (const r of sourceRows) {
      if (aliasOf.get(String(r.adOptionId || '').trim()) === aliasFilter || aliasOf.get(String(r.convOptionId || '').trim()) === aliasFilter) ids.add(r.campaignId)
    }
    return ids
  }, [aliasFilter, sourceRows, masterAug])
  const filteredRows = useMemo(() => {
    if (!sourceRows) return null
    let rs = chFilter === 'all' ? sourceRows : sourceRows.filter((r) => (chFilter === '1P' ? isRetailRow(r) : !isRetailRow(r)))
    if (aliasCampaignIds) rs = rs.filter((r) => aliasCampaignIds.has(r.campaignId))
    return rs
  }, [sourceRows, chFilter, aliasCampaignIds])

  const view = useMemo(
    () => buildAdAnalysisView(filteredRows, masterAug as any, marginOff ? manualBepMap : undefined),
    [filteredRows, masterAug, marginOff, manualBepMap],
  )
  // 주간 판정·상태 3칸·손익 줄은 채널 필터와 무관하게 전체(상품 필터만 적용) 기준 — 채널 필터는 아래 전체 캠페인 표 전용
  const rowsAllCh = useMemo(
    () => (sourceRows && aliasCampaignIds ? sourceRows.filter((r) => aliasCampaignIds.has(r.campaignId)) : sourceRows),
    [sourceRows, aliasCampaignIds],
  )
  const viewAll = useMemo(
    () => (chFilter === 'all' ? view : buildAdAnalysisView(rowsAllCh, masterAug as any, marginOff ? manualBepMap : undefined)),
    [chFilter, view, rowsAllCh, masterAug, marginOff, manualBepMap],
  )
  const weeklyActions: CampaignActions[] = useMemo(() => {
    if (!viewAll.loaded || hideBep) return []
    return buildWeeklyActions(viewAll, {
      bepMap: marginOff ? manualBepMap : buildBepMap(masterAug as any),
      priceMap: buildActualPriceMapById(masterAug as any),
      exposureMap: buildExposureMapByOptionId(masterAug as any),
      marginOff,
      targets,
    })
  }, [viewAll, hideBep, marginOff, manualBepMap, masterAug, targets])
  // 쿠팡 반영 완료 — 운영 메모 자동 기록 + (BEP ROAS 바뀐 AI 캠페인이면) 적용값 저장
  const [reflected, setReflected] = useState<Set<string>>(new Set())
  const [notesReload, setNotesReload] = useState(0)
  const reflectCampaign = async (a: CampaignActions) => {
    const res = await fetch('/api/coupang-ad-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: reflectMemoText(a),
        kind: 'reflect',
        campaignKey: a.targetKey ?? a.campaign.campaignName,
        campaignName: a.campaign.campaignName,
      }),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j?.item) throw new Error(j?.error || `HTTP ${res.status}`)
    // 저장 직후 GET 은 옛 값이 읽힐 수 있어 응답 메모를 바로 붙인다 (조정 결과 표용)
    setNotes((prev) => [...prev, j.item as ReflectNote])
    if (a.bepChange && a.targetKey) setTargetForKey(a.targetKey, a.bepChange.next)
    setReflected((prev) => new Set(prev).add(a.campaign.campaignId))
    setNotesReload((n) => n + 1)
  }
  // 주간 기록(지난주 대비) · 운영 메모(지난주 조정 결과) — 30일 판정과 별개
  const [weekly, setWeekly] = useState<WeeklySnapshot[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/coupang-ad-weekly', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && Array.isArray(j?.items)) setWeekly(j.items as WeeklySnapshot[]) })
      .catch(() => { /* 없으면 빈 기록 */ })
    return () => { cancelled = true }
  }, [])
  const [notes, setNotes] = useState<ReflectNote[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/coupang-ad-history', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && Array.isArray(j?.items)) setNotes(j.items as ReflectNote[]) })
      .catch(() => { /* 없으면 빈 메모 */ })
    return () => { cancelled = true }
  }, [notesReload])
  /** 주간 파일 → 캠페인별 요약(기존 광고 분석 계산 그대로) → 주간 기록 저장 */
  async function saveWeeklySnapshot(rows: AdCampaignRow[], period: { startDate: string; endDate: string }, fileName: string) {
    const aug = augmentMasterWith1P(marginMaster as Parameters<typeof augmentMasterWith1P>[0], rows)
    const v = buildAdAnalysisView(rows, aug as Parameters<typeof buildAdAnalysisView>[1], marginOff ? manualBepMap : undefined)
    const snapshot = snapshotFromView(v, period, fileName)
    const res = await fetch('/api/coupang-ad-weekly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j?.ok) throw new Error(`주간 기록 저장 실패: ${j?.error || res.status}`)
    // 저장 직후 GET 은 옛 값이 읽힐 수 있어 POST 응답의 전체 목록을 그대로 쓴다
    if (Array.isArray(j.items)) setWeekly(j.items as WeeklySnapshot[])
  }

  // 상품 월 손익 — 쿠팡 손익이 저장한 가장 최근 달 상품별 판정 요약(pnl_verdict_YYYY-MM, 관리자만)
  const [productMonth, setProductMonth] = useState<{ month: string; byAlias: Map<string, { profit: number; adShare: number | null }> } | null>(null)
  useEffect(() => {
    if (isGuest) return
    let cancelled = false
    ;(async () => {
      try {
        const mj = await (await fetch('/api/coupang-master?type=pnl_months')).json()
        const months = Object.entries((mj?.months || {}) as Record<string, string[]>)
          .filter(([, kinds]) => kinds.includes('verdict'))
          .map(([m]) => m)
          .sort((x, y) => y.localeCompare(x))
        if (!months.length) return
        const vj = await (await fetch(`/api/coupang-master?type=pnl_verdict_${months[0]}`)).json()
        const rows = (vj?.data?.rows || []) as { alias: string; profit: number; adShare: number | null }[]
        if (!cancelled && rows.length) {
          setProductMonth({ month: months[0], byAlias: new Map(rows.map((r) => [r.alias, { profit: r.profit, adShare: r.adShare }])) })
        }
      } catch { /* 없으면 표시 안 함 */ }
    })()
    return () => { cancelled = true }
  }, [isGuest])
  // 캠페인 → 별칭: 광고 행 광고집행 옵션ID → 3P/1P 행 별칭 (상품 필터와 같은 연결), 여러 개면 광고비 가장 큰 별칭
  const campaignAlias = useMemo(() => {
    const m = new Map<string, string>()
    if (!productMonth) return m
    const mrows = ((masterAug as unknown as { marginRows?: { optionId: string; alias: string }[] } | null)?.marginRows) || []
    const aliasOf = new Map(mrows.map((r) => [String(r.optionId).trim(), r.alias]))
    for (const c of viewAll.campaigns) {
      const cost = new Map<string, number>()
      for (const r of c.rows) {
        const a = aliasOf.get(String(r.adOptionId || '').trim()) as string | undefined
        if (a) cost.set(a, (cost.get(a) || 0) + (r.adCost || 0))
      }
      let best = ''
      let bestCost = -1
      for (const [a, v] of cost) if (v > bestCost) { best = a; bestCost = v }
      if (best) m.set(c.campaignId, best)
    }
    return m
  }, [productMonth, viewAll, masterAug])
  const productNoteOf = (campaignId: string): ProductMonthNote | null => {
    const alias = campaignAlias.get(campaignId)
    const v = alias && productMonth ? productMonth.byAlias.get(alias) : undefined
    return v && productMonth && alias ? { month: productMonth.month, alias, profit: v.profit, adShare: v.adShare } : null
  }

  // 상태 3칸 캠페인명 클릭 → 전체 캠페인 표에서 그 행으로 스크롤 + 펼침
  const pickCampaign = (id: string) => {
    setChFilter('all')
    setSelectedOptionId(null)
    setOpenCampId(id)
    setTimeout(() => document.getElementById(`aa-camp-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
  }

  // 옵션 목록(수기 BEP 입력용) — raw 를 광고집행 옵션ID 로 group
  const optionList = useMemo(() => {
    if (!marginOff || !rows3P) return [] as { adOptionId: string; name: string; clicks: number; adCostVat: number; revenue: number }[]
    const map = new Map<string, { names: Map<string, number>; clicks: number; adCostRaw: number; revenue: number }>()
    for (const r of rows3P) {
      const id = String(r.adOptionId || '').trim()
      if (!id) continue
      let e = map.get(id)
      if (!e) { e = { names: new Map(), clicks: 0, adCostRaw: 0, revenue: 0 }; map.set(id, e) }
      const nm = String(r.adProductName || '').trim()
      if (nm) e.names.set(nm, (e.names.get(nm) || 0) + 1)
      e.clicks += r.clicks || 0
      e.adCostRaw += r.adCost || 0
      e.revenue += r.revenue14d || 0
    }
    return Array.from(map.entries()).map(([adOptionId, e]) => {
      let best = '', bestN = -1
      for (const [nm, n] of e.names) if (n > bestN) { best = nm; bestN = n }
      return { adOptionId, name: best || adOptionId, clicks: e.clicks, adCostVat: e.adCostRaw * 1.1, revenue: e.revenue }
    }).sort((a, b) => b.adCostVat - a.adCostVat)
  }, [marginOff, rows3P])

  const marginOffBanner = marginOff ? (
    <div style={{ ...noticeBoxOrange, fontSize: 13 }}>
      마진마스터 없이 광고 지표만 표시 중 · ROAS는 쿠팡 표기 매출(14일 전환) 기준이라 무프/쿠폰·오가닉 미보정
      {hideBep && <> · 아래 옵션별 <strong>BEP ROAS(%)</strong>를 입력하면 키워드 판정·추천입찰가가 표시됩니다</>}
    </div>
  ) : null
  const optionBepNode = marginOff ? (
    <OptionBepInputCard options={optionList} manualBep={manualBep} onChange={(id, v) => setManualBep((prev) => ({ ...prev, [id]: v }))} />
  ) : null

  // 라이브 광고 엑셀 업로드 핸들러 — store 의 rawAdCampaign 안 건드림.
  // 라이브 광고 엑셀 업로드 — 여러 파일. 파일명 기간으로 구분: 10일 이하 = 주간 기록 저장, 25일 이상 = 30일 분석 화면
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  async function handleLiveFiles(files: File[]) {
    setUploadError(null)
    setUploadNote(null)
    const notes: string[] = []
    const warns: string[] = []
    let monthly: { rows: AdCampaignRow[]; meta: { fileName: string; uploadedAt: string; rowCount: number }; period: { startDate: string; endDate: string; days: number } | null; end: string } | null = null
    for (const file of files) {
      try {
        const r = parseAdCampaign(await file.arrayBuffer(), file.name)
        if (!r.rows.length) {
          warns.push(`${file.name}: 광고 캠페인 행 없음`)
          continue
        }
        const fp = extractPeriodFromFileName(file.name)
        const startDate = fp?.startDate ?? r.startDate ?? null
        const endDate = fp?.endDate ?? r.endDate ?? null
        const days = fp?.periodDays ?? r.periodDays ?? null
        const period = startDate && endDate && days ? { startDate, endDate, days } : null
        const label = period ? `${fmtMd(period.startDate)}~${fmtMd(period.endDate)}(${period.days}일)` : file.name
        if (period && period.days <= WEEKLY_MAX_DAYS) {
          await saveWeeklySnapshot(r.rows, period, file.name)
          notes.push(`주간 기록 저장 ${label}`)
        } else if (period && period.days >= MONTHLY_MIN_DAYS) {
          // 30일 파일이 여러 개면 기간 끝이 가장 늦은 것
          if (!monthly || period.endDate > monthly.end) {
            monthly = { rows: r.rows, meta: { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length }, period, end: period.endDate }
          }
          notes.push(`30일 분석 ${label}`)
        } else {
          warns.push(`${label}: 기간이 ${period ? `${period.days}일` : '불명'} — 주간(10일 이하)도 30일(25일 이상)도 아니라 건너뜀`)
        }
      } catch (err) {
        warns.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (monthly) setAdAnalysisLive(monthly.rows, monthly.meta, monthly.period)
    if (notes.length) setUploadNote(notes.join(' · '))
    if (warns.length) setUploadError(warns.join(' / '))
  }

  // 셀렉터/공통 헤더 — 어떤 분기든 항상 노출
  const headerNode = (
    <>
      <Header
        mode={mode}
        onMode={setMode}
        isGuest={isGuest}
        adPeriodLabel={sourcePeriod ? `${sourcePeriod.startDate} ~ ${sourcePeriod.endDate} (${sourcePeriod.days}일)` : undefined}
      />
      {aliasFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px', padding: '8px 14px', borderRadius: 8, border: '1px solid #FDBA74', background: '#FFF7ED', fontSize: 13, color: '#9A3412' }}>
          <span>🔎 상품 필터: <b>{aliasFilter}</b> — 이 상품을 광고·전환한 캠페인 {aliasCampaignIds?.size ?? 0}개만 표시</span>
          <button onClick={clearAliasFilter} style={{ marginLeft: 'auto', border: '1px solid #FDBA74', borderRadius: 6, background: '#fff', padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}>필터 해제</button>
        </div>
      )}
      {mode === 'saved' && !isGuest && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 12px', padding: '8px 14px', borderRadius: 8, border: '1px solid #BFDBFE', background: '#EFF6FF', fontSize: 13, color: '#1E3A8A' }}>
          <span>📅 월</span>
          <select
            value={srcMonth || ''}
            onChange={(e) => { if (e.target.value) loadPnlMonth(e.target.value) }}
            disabled={!!monthLoading}
            style={{ border: '1px solid #93C5FD', borderRadius: 6, padding: '2px 6px', background: '#fff' }}
          >
            {!srcMonth && <option value="">— 선택 —</option>}
            {pnlMonths.map((m) => <option key={m} value={m}>{m.slice(0, 4)}년 {Number(m.slice(5, 7))}월</option>)}
          </select>
          <span>
            {monthLoading ? `${Number(monthLoading.slice(5, 7))}월 저장본 불러오는 중…`
              : srcMonth ? <><b>{Number(srcMonth.slice(5, 7))}월 광고 (쿠팡 손익 저장본)</b>{adPeriod ? ` · 기간 ${fmtMd(adPeriod.startDate)}~${fmtMd(adPeriod.endDate)}` : ''}</>
              : rawAdCampaign.length ? <>저장된 분석 데이터 보는 중{adPeriod ? ` · 기간 ${fmtMd(adPeriod.startDate)}~${fmtMd(adPeriod.endDate)}` : ''} — 월을 고르면 쿠팡 손익 저장본으로 바뀝니다</>
              : pnlMonths.length ? '월을 고르세요' : '쿠팡 손익에 저장된 광고 파일이 없습니다 — 쿠팡 손익 화면에서 광고 파일을 올려 주세요'}
          </span>
        </div>
      )}
    </>
  )

  // ── 본문 (라이브·저장 공통) — 경고 · 30일 손익 · 상태 3칸 · 할 일 · 전체 캠페인 표 · 운영 메모 ──
  const renderBody = () => (
    <>
      {marginMaster && marginMeta && !String(marginMeta.fileName || '').startsWith('나무_마스터') && (
        <div style={{ margin: '8px 0', padding: '8px 14px', borderRadius: 8, border: '1px solid #FCD34D', background: '#FFFBEB', color: '#92400E', fontSize: 13 }}>
          ⚠ 나무_마스터 연결 실패 — 옛 저장본(저장일 {String(marginMeta.uploadedAt || '').slice(0, 10) || '알 수 없음'})으로 계산 중
        </div>
      )}
      {onePView.loaded && !onePView.hasMargin && (
        <div style={{ ...errorBox, fontSize: 13 }}>1P 마진 데이터 없음 — 나무_마스터 연결 확인 (1P 캠페인 손익·BEP ROAS 계산 불가)</div>
      )}
      {marginOffBanner}
      {optionBepNode}
      {/* 2) 경고 1줄 — 1P 미연결 · 마스터 미등록 옵션 · BEP ROAS 없는 캠페인 */}
      <WarningLine
        unlinked1P={onePView.unlinked}
        unmatched={hideBep ? [] : viewAll.unmatched.list ?? []}
        noBep={hideBep ? [] : viewAll.campaigns.filter((c) => campaignStatusOf(c) == null)}
      />
      {!hideBep && viewAll.loaded && (
        <>
          {/* 3) 30일 손익 1줄 */}
          <ProfitLine view={viewAll} days={sourcePeriod?.days ?? null} />
          {/* 4) 지난주 대비 · 지난주 조정 결과 (주간 기록 기준) */}
          <WeekCompareBox snapshots={weekly} notes={notes} />
          {/* 5) 캠페인 상태 3칸 */}
          <StatusBoxes campaigns={viewAll.campaigns} onPick={pickCampaign} noteOf={productNoteOf} />
          {/* 6) 요약 카드 4개 + 7) 이번 주 할 일 */}
          <WeeklyActionsSection
            actions={weeklyActions}
            reflected={reflected}
            onReflect={reflectCampaign}
            onSetApplied={setTargetForKey}
            noteOf={productNoteOf}
          />
        </>
      )}
      {/* 8) 전체 캠페인 표 — 채널 필터는 이 표 전용 */}
      <ChannelFilterBar value={chFilter} onChange={setChFilter} has1P={onePView.loaded} />
      {chFilter === '1P' && !onePView.loaded && <div style={{ ...noticeBoxOrange, padding: 12, fontSize: 13, margin: '12px 0' }}>이 광고 데이터에는 1P(판매방식 Retail) 광고 행이 없습니다.</div>}
      <CampaignSection
        view={view}
        master={masterAug as any}
        marginOff={marginOff}
        hideBep={hideBep}
        manualBep={manualBepMap}
        openCampId={openCampId}
        onOpen={toggleCampaign}
        selectedOptionId={selectedOptionId}
        onSelectOption={openCampaignAndOption}
        targets={targets}
        onTargetChange={setTargetForKey}
        noteOf={productNoteOf}
        renderDetail={(c) => c.type === 'manual'
          ? <ManualSection campaign={c} master={masterAug as any} marginOff={marginOff} hideBep={hideBep} manualBep={manualBepMap} periodLabel={periodLabel} selectedOptionId={selectedOptionId} onClearOption={() => setSelectedOptionId(null)} onSelectOption={(id) => openCampaignAndOption(c.campaignId, id)} onClose={() => { setOpenCampId(null); setSelectedOptionId(null) }} />
          : <AiSection campaign={c} master={masterAug as any} marginOff={marginOff} hideBep={hideBep} manualBep={manualBepMap} periodLabel={periodLabel} selectedOptionId={selectedOptionId} onClearOption={() => setSelectedOptionId(null)} onSelectOption={(id) => openCampaignAndOption(c.campaignId, id)} onClose={() => { setOpenCampId(null); setSelectedOptionId(null) }} targets={targets} onTargetChange={setTargetForKey} />}
      />
      {/* 9) 운영 메모 (접힌 상태) */}
      <HistoryNotesSection reloadKey={notesReload} />
    </>
  )

  // ── 라이브 모드 ──
  if (mode === 'live') {
    if (!adAnalysisLive) {
      return (
        <div style={pageWrap}>
          <Style />
          {headerNode}
          <LiveUploadBox onFiles={handleLiveFiles} error={uploadError} />
          {uploadNote && <div style={{ ...noticeBoxOrange, padding: '8px 12px', fontSize: 12, textAlign: 'left', marginTop: 8 }}>✓ {uploadNote}</div>}
        </div>
      )
    }
    // 라이브 데이터 있음 → 정상 view
    return (
      <div style={{
        fontFamily: 'Pretendard, -apple-system, sans-serif',
        color: '#1F2937', fontSize: 14, lineHeight: 1.5,
      }}>
        <Style />
        {headerNode}
        <LiveActiveBar
          meta={adAnalysisLive.meta}
          onReplace={handleLiveFiles}
          onClear={() => { clearAdAnalysisLive(); setUploadError(null) }}
        />
        {uploadNote && <div style={{ ...noticeBoxOrange, padding: '8px 12px', fontSize: 12, textAlign: 'left', margin: '0 0 8px' }}>✓ {uploadNote}</div>}
        {uploadError && <div style={errorBox}>{uploadError}</div>}
        {/* 게스트: 저장 히스토리 기반 추세차트 숨김(회사 저장데이터) */}
        {renderBody()}
      </div>
    )
  }

  // ── 저장 모드 ──
  if (autoLoading && !view.loaded && !onePView.loaded) {
    return (
      <div style={pageWrap}>
        <Style />
        {headerNode}
        <div style={loadingBox}>저장된 광고 데이터를 불러오는 중…</div>
      </div>
    )
  }

  if (!view.loaded && !onePView.loaded) {
    return (
      <div style={pageWrap}>
        <Style />
        {headerNode}
        <div style={noticeBoxOrange}>
          저장된 광고 분석이 없습니다. 「수익 진단」 페이지에서 광고 엑셀을 업로드/저장하거나, 위 「라이브」 탭에서 직접 업로드하세요.
        </div>
      </div>
    )
  }

  return (
    <div style={{
      fontFamily: 'Pretendard, -apple-system, sans-serif',
      color: '#1F2937', fontSize: 14, lineHeight: 1.5,
    }}>
      <Style />
      {headerNode}
      {renderBody()}
    </div>
  )
}

// ── 채널 필터 (전체 / 3P / 1P) + 배지 ─────────────────────────
function SaleChBadge({ ch }: { ch: '3P' | '1P' }) {
  const s: React.CSSProperties = ch === '1P'
    ? { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #C4B5FD' }
    : { background: '#E0F2FE', color: '#075985', border: '1px solid #7DD3FC' }
  return <span style={{ ...s, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px', marginRight: 6, verticalAlign: 'middle' }}>{ch}</span>
}

function ChannelFilterBar({ value, onChange, has1P }: { value: 'all' | '3P' | '1P'; onChange: (v: 'all' | '3P' | '1P') => void; has1P: boolean }) {
  const opts: { v: 'all' | '3P' | '1P'; label: string }[] = [{ v: 'all', label: '전체' }, { v: '3P', label: '3P (윙)' }, { v: '1P', label: '1P (로켓 직매입)' }]
  return (
    <div style={{ display: 'flex', gap: 6, margin: '12px 0' }}>
      {opts.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} disabled={o.v === '1P' && !has1P}
          style={{ padding: '6px 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer', border: '1px solid ' + (value === o.v ? '#1F2937' : '#CBD5E1'),
            background: value === o.v ? '#1F2937' : '#fff', color: value === o.v ? '#fff' : '#334155', opacity: o.v === '1P' && !has1P ? 0.4 : 1 }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const fmtMd = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const WEEKLY_MAX_DAYS = 10 // 이하 = 주간 파일 (지난주 대비 기록)
const MONTHLY_MIN_DAYS = 25 // 이상 = 30일 파일 (할 일·상태·손익)

const pageWrap: React.CSSProperties = { maxWidth: 1500, margin: '0 auto', padding: '32px 40px', fontFamily: 'Pretendard, sans-serif' }
const loadingBox: React.CSSProperties = { background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: 24, fontSize: 14, color: '#64748B', textAlign: 'center' }
const noticeBoxOrange: React.CSSProperties = { background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: 24, fontSize: 14, color: '#92400E', textAlign: 'center' }
const errorBox: React.CSSProperties = { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '8px 12px', margin: '8px 0', fontSize: 12, color: '#991B1B' }

// ── 라이브 모드 업로드 박스 (드래그 + 클릭) ───────────────────
function LiveUploadBox({ onFiles, error }: { onFiles: (fs: File[]) => void; error: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleFiles = (files: FileList | null) => {
    const fs = files ? Array.from(files) : []
    if (fs.length) onFiles(fs)
  }

  return (
    <>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          handleFiles(e.dataTransfer.files)
        }}
        style={{
          border: `2px dashed ${dragOver ? '#FF6B35' : '#FED7AA'}`,
          background: dragOver ? '#FFF7ED' : '#FFFBF5',
          borderRadius: 8,
          padding: '40px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          color: '#92400E',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>광고 캠페인 엑셀 업로드</div>
        <div style={{ fontSize: 13, color: '#B45309' }}>
          쿠팡 광고센터 → pa_total_campaign 다운로드 파일 (.xlsx)
        </div>
        <div style={{ fontSize: 12, color: '#A16207', marginTop: 8 }}>
          파일을 끌어다 놓거나 클릭해서 선택하세요 (여러 개 가능). 기간은 파일명에서 자동 인식 — 10일 이하 = 주간 기록, 25일 이상 = 30일 분석
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => { handleFiles(e.target.files); if (inputRef.current) inputRef.current.value = '' }}
        />
      </div>
      {error && <div style={errorBox}>{error}</div>}
    </>
  )
}

// ── 라이브 활성 상태 표시줄 (파일명 + 다시 업로드 / 닫기) ────────
function LiveActiveBar({ meta, onReplace, onClear }: {
  meta: { fileName: string; uploadedAt: string; rowCount: number } | null
  onReplace: (fs: File[]) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6,
      padding: '8px 12px', margin: '8px 0 16px', fontSize: 12, color: '#92400E',
    }}>
      <div>
        📂 <strong>라이브:</strong> {meta?.fileName || '—'}
        {meta?.rowCount != null && <span style={{ marginLeft: 8, color: '#B45309' }}>· {meta.rowCount.toLocaleString()} rows</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => inputRef.current?.click()}
          style={{ padding: '4px 10px', border: '1px solid #FED7AA', background: '#FFFBF5', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#92400E' }}
        >
          다시 업로드
        </button>
        <button
          onClick={onClear}
          style={{ padding: '4px 10px', border: '1px solid #FECACA', background: '#FEF2F2', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#991B1B' }}
        >
          닫기
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => {
            const fs = e.target.files ? Array.from(e.target.files) : []
            if (fs.length) onReplace(fs)
            if (inputRef.current) inputRef.current.value = ''
          }}
        />
      </div>
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────
function Header({ mode, onMode, adPeriodLabel, isGuest }: {
  mode: Mode
  onMode: (m: Mode) => void
  adPeriodLabel?: string
  isGuest?: boolean
}) {
  const allTabs: { id: Mode; label: string; sub: string }[] = [
    { id: 'saved', label: '저장 (월)', sub: '쿠팡 손익 월 저장본' },
    { id: 'live', label: '라이브', sub: '광고 엑셀 직접 업로드' },
  ]
  // 게스트는 라이브 탭만 노출 (저장 탭 숨김)
  const tabs = isGuest ? allTabs.filter((t) => t.id === 'live') : allTabs
  return (
    <div className="aa-page-header">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="aa-title">광고 분석</div>
          <div className="aa-desc">캠페인별 효율 진단 · 제외 키워드 추출 · 수동 캠페인 입찰가 가이드 {adPeriodLabel && <span style={{ marginLeft: 8, color: '#94A3B8' }}>· {adPeriodLabel}</span>}</div>
        </div>
        <div className="aa-period-bar" title="14일 어트리뷰션 윈도우 중첩 회피 — 30/90일은 라이브 모드에서 직접 업로드">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`aa-period-btn ${mode === t.id ? 'active' : ''}`}
              onClick={() => onMode(t.id)}
              title={t.sub}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── 옵션별 BEP 입력 (마진마스터 대체) ─────────────────────────
function OptionBepInputCard({ options, manualBep, onChange }: {
  options: { adOptionId: string; name: string; clicks: number; adCostVat: number; revenue: number }[]
  manualBep: Record<string, number>
  onChange: (adOptionId: string, bepPct: number) => void
}) {
  const entered = options.filter((o) => (manualBep[o.adOptionId] ?? 0) > 0).length
  return (
    <div className="aa-section">
      <div className="aa-section-header">
        <div>
          <div className="aa-section-title">옵션별 BEP ROAS 입력 (마진마스터 대체)</div>
          <div className="aa-section-desc">광고집행 옵션ID 별 손익분기 ROAS(%)를 입력하면 키워드 판정·추천입찰가가 계산됩니다 · 입력 {entered}/{options.length}</div>
        </div>
      </div>
      <div className="aa-table-wrap shorter">
        <table>
          <thead>
            <tr>
              <th className="sticky-left" style={{ minWidth: 130 }}>옵션ID</th>
              <th style={{ minWidth: 220 }}>상품명</th>
              <th className="num">클릭</th>
              <th className="num">광고비 (+VAT)</th>
              <th className="num">매출 (쿠팡표기)</th>
              <th className="num" style={{ minWidth: 120 }}>BEP ROAS(%)</th>
            </tr>
          </thead>
          <tbody>
            {options.map((o) => (
              <tr key={o.adOptionId}>
                <td className="sticky-left mono">{o.adOptionId}</td>
                <td>{o.name}</td>
                <td className="num">{fmtNum(o.clicks)}</td>
                <td className="num">{fmtMan(o.adCostVat)}</td>
                <td className="num">{fmtMan(o.revenue)}</td>
                <td className="num">
                  <input
                    type="number"
                    value={manualBep[o.adOptionId] ?? ''}
                    placeholder="예: 340"
                    onChange={(e) => onChange(o.adOptionId, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)}
                    style={{ width: 90, textAlign: 'right', padding: '4px 8px', border: '1px solid #CBD5E1', borderRadius: 6 }}
                  />
                </td>
              </tr>
            ))}
            {options.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>옵션 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 운영 메모 (영구 저장) ─────────────────────────────────────
type HistoryNote = { id: string; ts: string; text: string }

function fmtNoteTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function HistoryNotesSection({ reloadKey = 0 }: { reloadKey?: number }) {
  const { confirm, confirmModal } = useConfirm()
  const [items, setItems] = useState<HistoryNote[]>([])
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/coupang-ad-history')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const list = Array.isArray(j?.items) ? (j.items as HistoryNote[]) : []
        setItems(list)
      })
      .catch(() => { if (!cancelled) setItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadKey])

  const sorted = useMemo(
    () => [...items].sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    [items],
  )

  async function add() {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/coupang-ad-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      })
      const j = await res.json()
      if (j?.item) {
        setItems((prev) => [...prev, j.item as HistoryNote])
        setText('')
      } else {
        alert(`저장 실패: ${j?.error ?? '알 수 없는 오류'}`)
      }
    } catch (e) {
      alert(`저장 실패: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ message: '이 메모를 삭제할까요?' }))) return
    setBusy(true)
    try {
      const res = await fetch(`/api/coupang-ad-history?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const j = await res.json()
      if (j?.ok) {
        setItems((prev) => prev.filter((it) => it.id !== id))
      } else {
        alert(`삭제 실패: ${j?.error ?? '알 수 없는 오류'}`)
      }
    } catch (e) {
      alert(`삭제 실패: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="aa-sub-section" style={{ marginTop: 16 }}>
      {confirmModal}
      <div className="aa-sub-section-title" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <span>📝 운영 메모 ({loading ? '…' : `${sorted.length}건`})</span>
        <span style={{ fontSize: 12, color: '#64748B' }}>{open ? '▾ 접기' : '▸ 펼치기'}</span>
      </div>
      {open && (
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }}
              placeholder="예: 5.5일 제외 키워드 셋팅"
              disabled={busy}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
            />
            <button
              className="aa-btn btn-sm"
              onClick={add}
              disabled={busy || !text.trim()}
              style={{ opacity: busy || !text.trim() ? 0.5 : 1 }}
            >
              추가
            </button>
          </div>
          {sorted.length === 0 ? (
            <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 4px' }}>
              {loading ? '불러오는 중…' : '등록된 메모가 없습니다.'}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sorted.map((it) => (
                <li
                  key={it.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '6px 8px',
                    borderBottom: '1px solid #F1F5F9',
                    fontSize: 13,
                  }}
                >
                  <span className="mono" style={{ color: '#64748B', fontSize: 11, minWidth: 110, paddingTop: 2 }}>
                    {fmtNoteTs(it.ts)}
                  </span>
                  <span style={{ flex: 1, whiteSpace: 'pre-wrap', color: '#1F2937' }}>{it.text}</span>
                  <button
                    onClick={() => remove(it.id)}
                    disabled={busy}
                    title="삭제"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#94A3B8',
                      cursor: 'pointer',
                      fontSize: 14,
                      padding: '0 4px',
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── Campaign Section ──────────────────────────────────────────
function CampaignSection({ view, master, marginOff = false, hideBep = false, manualBep, openCampId, onOpen, selectedOptionId, onSelectOption, targets, onTargetChange, renderDetail, noteOf }: {
  view: ReturnType<typeof buildAdAnalysisView>
  master: any
  marginOff?: boolean
  hideBep?: boolean
  manualBep?: Map<string, number>
  openCampId: string | null
  onOpen: (id: string) => void
  selectedOptionId: string | null
  onSelectOption: (campaignId: string, optionId: string | null) => void
  targets: Record<string, number>
  onTargetChange: (key: string, value: number | null) => void
  /** 펼친 캠페인의 키워드 분석(AI)·입찰가 점검(수동) — 옵션 행 바로 아래 표 안에 표시 */
  renderDetail?: (c: CampaignDiag) => React.ReactNode
  /** 상품 월 손익 (쿠팡 손익 상품별 판정 저장본) — 캠페인명 아래 */
  noteOf?: (campaignId: string) => ProductMonthNote | null
}) {
  const { sorted, key, dir, toggle } = useSort(view.campaigns, 'adCostVat' as keyof CampaignDiag, 'desc')

  const bepMap = useMemo(() => marginOff ? (manualBep ?? new Map<string, number>()) : buildBepMap(master), [marginOff, manualBep, master])
  const priceMap = useMemo(() => buildActualPriceMapById(master), [master])
  const rowMap = useMemo(() => buildMarginRowMap(master), [master])
  const exposureMap = useMemo(() => buildExposureMapByOptionId(master), [master])

  const TH = ({ label, k, num, minWidth, sticky }: { label: React.ReactNode; k: keyof CampaignDiag; num?: boolean; minWidth?: number; sticky?: boolean }) => (
    <th
      className={[
        'sortable',
        num ? 'num' : '',
        sticky ? 'sticky-left' : '',
        key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
      ].filter(Boolean).join(' ')}
      style={minWidth ? { minWidth } : undefined}
      onClick={() => toggle(k)}
    >
      {label}
    </th>
  )

  return (
    <div className="aa-section">
      <div className="aa-section-header">
        <div>
          <div className="aa-section-title">캠페인 진단</div>
          <div className="aa-section-desc">캠페인 클릭 → 옵션·키워드(AI) / 입찰가 점검(수동) 함께 펼침 · 옵션 클릭 → 그 옵션만 · 다시 클릭 → 닫기</div>
        </div>
      </div>
      {/* 캠페인을 펼치면 표 높이 제한·자체 스크롤을 풀어 제목 행이 페이지 스크롤 기준으로 고정 (키워드 표는 자체 박스 안에서 고정) */}
      <div className={`aa-table-wrap aa-camp-wrap${openCampId && renderDetail ? ' expanded' : ''}`}>
        <table>
          <thead>
            <tr>
              <TH label="캠페인" k={'campaignName'} sticky minWidth={260} />
              <TH label="타입" k={'type'} />
              <TH label="광고비 (+VAT)" k={'adCostVat'} num />
              <TH label="광고 매출" k={'revenue'} num />
              <TH label={marginOff ? <>ROAS<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(쿠팡표기)</span></> : <>ROAS<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(광고센터)</span></>} k={'roasPct'} num />
              {!hideBep && <TH label={<>BEP ROAS<br /><span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400 }}>AI 캠페인은 쿠팡 목표 ROAS 에 이 값 입력</span></>} k={'bepPct'} num minWidth={130} />}
              {!hideBep && <TH label={<>광고 손익<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(원)</span></>} k={'adProfit'} num />}
              <TH label={<>광고 판매수<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(1P = 봉)</span></>} k={'orders'} num />
              <TH label={<>타상품 매출<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(다른 상품 전환)</span></>} k={'otherProductRevenue'} num minWidth={110} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const isOpen = c.campaignId === openCampId
              const isExpanded = isOpen
              const opts = !marginOff && isExpanded
                ? computeOptions(c.rows, bepMap, priceMap, rowMap, exposureMap)
                : []
              return (
                <CampaignRowGroup
                  key={c.campaignId}
                  c={c}
                  marginOff={marginOff}
                  hideBep={hideBep}
                  isOpen={isOpen}
                  isExpanded={isExpanded}
                  onToggle={() => onOpen(c.campaignId)}
                  onToggleExpand={() => onOpen(c.campaignId)}
                  options={opts}
                  selectedOptionId={isOpen ? selectedOptionId : null}
                  onSelectOption={(optId) => onSelectOption(c.campaignId, optId)}
                  targets={targets}
                  onTargetChange={onTargetChange}
                  detail={isOpen && renderDetail ? renderDetail(c) : null}
                  note={noteOf?.(c.campaignId) ?? null}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CampaignRowGroup({ c, marginOff = false, hideBep = false, isOpen, isExpanded, onToggle, onToggleExpand, options, selectedOptionId, onSelectOption, targets, onTargetChange, detail, note }: {
  detail?: React.ReactNode
  note?: ProductMonthNote | null
  c: CampaignDiag
  marginOff?: boolean
  hideBep?: boolean
  isOpen: boolean
  isExpanded: boolean
  onToggle: () => void
  onToggleExpand: () => void
  options: OptionDiag[]
  selectedOptionId: string | null
  onSelectOption: (optionId: string) => void
  targets: Record<string, number>
  onTargetChange: (key: string, value: number | null) => void
}) {
  const roasUnder = c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct
  // BEP 숨김이면 색상 없이 중립
  const roasClass = hideBep ? '' : (roasUnder ? 'text-bad' : (c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct * 1.2 ? 'text-warn' : ''))
  const gapClass = c.gapPct != null && c.gapPct < 0 ? 'text-bad' : c.gapPct != null && c.gapPct > 0 ? 'text-good' : ''

  const typeBadge =
    c.type === 'ai' ? <span className="aa-badge badge-ai">🤖 AI</span> :
    c.type === 'manual' ? <span className="aa-badge badge-manual">🎯 수동</span> :
    <span className="aa-badge badge-unsorted">미분류</span>

  const searchPct = Math.round(c.searchShare * 100)
  const isManual = c.type === 'manual'
  const cvrPct = c.clicks > 0 ? (c.orders / c.clicks) * 100 : null

  // 목표 ROAS — 캠페인명에서 prefix+타입 추출. 수동 또는 비표준 네이밍이면 입력 비활성화.
  const targetInfo = parseCampaignTargetKey(c.campaignName)
  const targetEditable = targetInfo != null && (targetInfo.kind === 'AI' || targetInfo.kind === '스마트')
  const targetValue = targetInfo ? (targets[targetInfo.key] ?? null) : null

  return (
    <>
      <tr id={`aa-camp-${c.campaignId}`} className={`clickable ${isOpen ? 'selected' : ''}`} onClick={onToggle} style={{ scrollMarginTop: 80 }}>
        <td className="sticky-left">
          <span
            className="aa-expand-toggle"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            title={isExpanded ? '옵션 접기' : '옵션 펼치기'}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
          <strong><SaleChBadge ch={c.channel} />{c.campaignName}</strong>
          {note && <div style={{ paddingLeft: 22 }}><ProductNote note={note} /></div>}
        </td>
        <td>{typeBadge}</td>
        <td className="num">{fmtMan(c.adCostVat)}</td>
        <td className="num">{fmtMan(c.revenue)}</td>
        <td className={`num ${roasClass}`}>{fmtRoas(c.roasPct)}</td>
        {!hideBep && (
          <td className="num" style={{ fontWeight: 700 }}>
            {c.bepPct != null ? `${Math.round(c.bepPct)}%` : '—'}
            {isManual && <div style={{ fontSize: 10, fontWeight: 400, color: '#94A3B8' }}>키워드별 입찰가</div>}
          </td>
        )}
        {!hideBep && <td className={`num ${c.adProfit < 0 ? 'text-bad' : 'text-good'}`} style={{ fontWeight: 600 }}>{Math.round(c.adProfit).toLocaleString('ko-KR')}</td>}
        <td className="num">{fmtNum(c.orders)}</td>
        <td className="num text-muted">{c.otherProductRevenue > 0 ? fmtMan(c.otherProductRevenue) : '—'}</td>
      </tr>
      {!marginOff && isExpanded && options.map((o) => (
        <OptionInlineRow
          key={`${c.campaignId}::${o.optionId}`}
          o={o}
          isSelected={selectedOptionId === o.optionId}
          onClick={() => onSelectOption(o.optionId)}
          hideBep={hideBep}
        />
      ))}
      {!marginOff && isExpanded && options.length === 0 && (
        <tr className="aa-option-row">
          <td className="sticky-left aa-option-cell" colSpan={hideBep ? 7 : 9} style={{ textAlign: 'center', color: '#94A3B8' }}>옵션 없음</td>
        </tr>
      )}
      {detail && (
        <tr className="aa-detail-row">
          <td colSpan={hideBep ? 7 : 9} style={{ padding: 0, background: '#fff', whiteSpace: 'normal' }}>
            <div style={{ maxHeight: 900, overflowY: 'auto', padding: '4px 8px 12px' }}>{detail}</div>
          </td>
        </tr>
      )}
      {marginOff && isExpanded && (
        <tr className="aa-option-row">
          <td className="sticky-left aa-option-cell" colSpan={hideBep ? 7 : 9} style={{ textAlign: 'center', color: '#94A3B8' }}>옵션 상세는 마진마스터 필요 (옵션 판정은 상단 BEP ROAS 입력값 기준)</td>
        </tr>
      )}
    </>
  )
}

function OptionInlineRow({ o, isSelected, onClick, hideBep = false }: { o: OptionDiag; isSelected: boolean; onClick: () => void; hideBep?: boolean }) {
  const roasUnder = o.roasPct != null && o.bepPct != null && o.roasPct < o.bepPct
  const roasClass = o.roasPct == null || o.bepPct == null ? '' : (roasUnder ? 'text-bad' : 'text-good')
  const gapClass = o.gapPct == null ? '' : (o.gapPct < 0 ? 'text-bad' : 'text-good')
  const adCostRaw = o.searchAdCostRaw + o.nonSearchAdCostRaw
  const searchPct = Math.round(o.searchShare * 100)

  return (
    <tr
      className={`aa-option-row clickable ${isSelected ? 'option-selected' : ''}`}
      onClick={onClick}
    >
      <td className="sticky-left aa-option-cell">
        <span className="aa-option-prefix">└─</span>
        <span className="aa-option-text">
          {o.alias && <span className="aa-option-alias">{o.alias}</span>}
          <span className="aa-option-name"><SaleChBadge ch={o.saleCh} />{o.optionName}</span>
          {!o.matched && <span style={{ marginLeft: 4, fontSize: 10, color: '#92400E' }}>⚠</span>}
          <ChannelBadge raw={o.channel} />
        </span>
      </td>
      <td><span className="text-muted">—</span></td>
      <td className="num">{fmtMan(o.adCostVat)}</td>
      <td className="num">{fmtMan(o.revenue)}</td>
      <td className={`num ${roasClass}`}>{fmtRoas(o.roasPct)}</td>
      {!hideBep && <td className="num" style={{ fontWeight: 700 }}>{o.bepPct != null ? `${Math.round(o.bepPct)}%` : '—'}</td>}
      {!hideBep && <td className={`num ${o.adProfit < 0 ? 'text-bad' : 'text-good'}`}>{Math.round(o.adProfit).toLocaleString('ko-KR')}</td>}
      <td className="num">{fmtNum(o.sold)}</td>
      <td className="num text-muted">{o.otherProductRevenue > 0 ? fmtMan(o.otherProductRevenue) : '—'}</td>
    </tr>
  )
}

// ── AI Section ────────────────────────────────────────────────
function AiSection({ campaign, master, marginOff = false, hideBep = false, manualBep, periodLabel, selectedOptionId, onClearOption, onClose, targets, onTargetChange, onSelectOption }: {
  onSelectOption?: (optionId: string | null) => void
  targets?: Record<string, number>
  onTargetChange?: (key: string, v: number | null) => void
  campaign: CampaignDiag
  master: any
  marginOff?: boolean
  hideBep?: boolean
  manualBep?: Map<string, number>
  periodLabel: string
  selectedOptionId: string | null
  onClearOption: () => void
  onClose: () => void
}) {
  const bepMap = useMemo(() => marginOff ? (manualBep ?? new Map<string, number>()) : buildBepMap(master), [marginOff, manualBep, master])
  const priceMap = useMemo(() => buildActualPriceMapById(master), [master])
  const rowMap = useMemo(() => buildMarginRowMap(master), [master])
  const exposureMap = useMemo(() => buildExposureMapByOptionId(master), [master])
  const options = useMemo(() => computeOptions(campaign.rows, bepMap, priceMap, rowMap, exposureMap), [campaign.rows, bepMap, priceMap, rowMap, exposureMap])

  const filteredCampaign = useMemo(() => {
    if (!selectedOptionId) return campaign
    return { ...campaign, rows: campaign.rows.filter((r) => String(r.adOptionId || '').trim() === selectedOptionId) }
  }, [campaign, selectedOptionId])
  const selectedOptionName = selectedOptionId
    ? (options.find((o) => o.optionId === selectedOptionId)?.optionName ?? selectedOptionId)
    : null

  const { search, nonSearch } = useMemo(() => buildKeywordRows(filteredCampaign, bepMap, priceMap, exposureMap, marginOff), [filteredCampaign, bepMap, priceMap, exposureMap, marginOff])
  const cpcEntries = useMemo(() => marginOff ? [] : buildBepCpcForCampaign(campaign, master), [campaign, master, marginOff])
  // 검색/비검색 요약 — 옵션 필터가 걸리면 같은 필터 기준 (키워드 없는 검색 행 포함)
  const areaSum = useMemo(() => {
    const acc = { sRaw: 0, nRaw: 0, sRev: 0, nRev: 0, sSold: 0, nSold: 0 }
    for (const r of filteredCampaign.rows) {
      const rev = marginOff ? (r.revenue14d || 0) : splitRowRevenue(r, priceMap, exposureMap).self
      if (isSearchPlacement(r.placement)) { acc.sRaw += r.adCost || 0; acc.sRev += rev; acc.sSold += r.sold14d || 0 }
      else { acc.nRaw += r.adCost || 0; acc.nRev += rev; acc.nSold += r.sold14d || 0 }
    }
    return acc
  }, [filteredCampaign, priceMap, exposureMap, marginOff])
  const searchSold = areaSum.sSold
  const nonSearchSold = areaSum.nSold
  const soldLabel = campaign.channel === '1P' ? '판매 봉수' : '판매건수'
  const soldUnit = campaign.channel === '1P' ? '봉' : '건'
  const totalRaw = areaSum.sRaw + areaSum.nRaw
  const sRoas = areaSum.sRaw > 0 ? (areaSum.sRev / areaSum.sRaw) * 100 : null
  const nRoas = areaSum.nRaw > 0 ? (areaSum.nRev / areaSum.nRaw) * 100 : null
  const targetInfo = parseCampaignTargetKey(campaign.campaignName)
  const targetEditable = !!targets && !!onTargetChange && targetInfo != null && (targetInfo.kind === 'AI' || targetInfo.kind === '스마트')

  const [checked, setChecked] = useState<Set<string>>(new Set())
  const toggleCheck = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })

  return (
    <div className="aa-section" style={{ border: '2px solid #FF6B35' }}>
      <div className="aa-section-header" style={{ background: '#FFF7ED' }}>
        <div>
          <div className="aa-section-title">▼ {campaign.campaignName} · 키워드 분석</div>
          <div className="aa-section-desc">검색 영역만 키워드 단위 제어 가능 · 비검색은 통제 불가</div>
          {targetEditable && targetInfo && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#475569' }}>
              쿠팡 목표 ROAS (적용값)
              <TargetRoasInput value={targets![targetInfo.key] ?? null} onChange={(v) => onTargetChange!(targetInfo.key, v)} />
              {!hideBep && campaign.bepPct != null && <span style={{ color: '#94A3B8' }}>(BEP ROAS {Math.round(campaign.bepPct)}%)</span>}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <BepCpcLine campaign={campaign} entries={cpcEntries} rowMap={rowMap} selectedOptionId={selectedOptionId} />
          <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
        </div>
      </div>
      <div className="aa-section-body">
        <div className="aa-two-col">
          <div className="aa-metric-box search">
            <div className="aa-metric-box-label">🔍 검색 영역 (제어 가능)</div>
            <Row label="광고비 (+VAT)" value={fmtMan(areaSum.sRaw * 1.1)} sub={totalRaw > 0 ? `(${Math.round((areaSum.sRaw / totalRaw) * 100)}%)` : undefined} />
            <Row label="광고 매출" value={fmtMan(areaSum.sRev)} />
            <Row label={soldLabel} value={`${fmtNum(searchSold)}${soldUnit}`} />
            <Row label="ROAS (광고센터)" value={fmtRoas(sRoas)} valueClass={sRoas != null && campaign.bepPct != null && sRoas < campaign.bepPct ? 'text-bad' : ''} />
            {!hideBep && <Row label="BEP ROAS" value={campaign.bepPct != null ? `${Math.round(campaign.bepPct)}%` : '—'} />}
            {!hideBep && <Row label="갭" value={sRoas != null && campaign.bepPct != null ? `${Math.round(sRoas - campaign.bepPct)}%p` : '—'} valueClass={sRoas != null && campaign.bepPct != null && sRoas < campaign.bepPct ? 'text-bad' : 'text-good'} />}
          </div>
          <div className="aa-metric-box nonsearch">
            <div className="aa-metric-box-label">🎯 비검색 영역 (통제 불가)</div>
            <Row label="광고비 (+VAT)" value={fmtMan(areaSum.nRaw * 1.1)} sub={totalRaw > 0 ? `(${100 - Math.round((areaSum.sRaw / totalRaw) * 100)}%)` : undefined} />
            <Row label="광고 매출" value={fmtMan(areaSum.nRev)} />
            <Row label={soldLabel} value={`${fmtNum(nonSearchSold)}${soldUnit}`} />
            <Row label="ROAS (광고센터)" value={fmtRoas(nRoas)} valueClass={nRoas != null && campaign.bepPct != null && nRoas < campaign.bepPct ? 'text-bad' : ''} />
            {!hideBep && <Row label="BEP ROAS" value={campaign.bepPct != null ? `${Math.round(campaign.bepPct)}%` : '—'} />}
            <Row label={<span className="text-muted">참고용</span>} value={<span style={{ fontSize: 11 }}>AI 자동 운영</span>} />
          </div>
        </div>
        <OptionChips options={options} selectedOptionId={selectedOptionId} onSelect={(id) => (id == null ? onClearOption() : onSelectOption?.(id))} />
        <KeywordTable
          rows={search}
          campaignRows={campaign.rows}
          campaignBep={hideBep ? null : campaign.bepPct}
          marginOff={marginOff}
          hideBep={hideBep}
          checked={checked}
          onToggle={toggleCheck}
          nonSearchCount={nonSearch.length}
          campaignName={campaign.campaignName || campaign.campaignId}
          periodLabel={periodLabel}
          bepMap={bepMap}
          priceMap={priceMap}
          rowMap={rowMap}
          selectedOptionName={selectedOptionName}
        />
        <NonSearchKeywordTable
          rows={nonSearch}
          campaignBep={hideBep ? null : campaign.bepPct}
          hideBep={hideBep}
          campaignName={campaign.campaignName || campaign.campaignId}
          periodLabel={periodLabel}
        />
      </div>
    </div>
  )
}

function Row({ label, value, sub, valueClass }: { label: React.ReactNode; value: React.ReactNode; sub?: string; valueClass?: string }) {
  return (
    <div className="aa-metric-row">
      <span>{label}</span>
      <span className={`mono ${valueClass || ''}`}>{value}{sub && <span style={{ marginLeft: 4, color: '#94A3B8', fontSize: 11 }}>{sub}</span>}</span>
    </div>
  )
}

// ── 옵션별 드릴다운 ───────────────────────────────────────────
interface OptionDiag {
  optionId: string
  optionName: string
  alias: string
  channel: string
  adCostVat: number
  revenue: number
  otherProductRevenue: number
  sold: number
  clicks: number
  cvrPct: number | null
  searchAdCostRaw: number
  nonSearchAdCostRaw: number
  searchShare: number
  roasPct: number | null
  bepPct: number | null
  gapPct: number | null
  matched: boolean
  /** 3P / 1P */
  saleCh: '3P' | '1P'
  /** 광고 손익 (원) = 판매 × 전환 옵션 마진 − 광고비(부가포함, 1P 과세 ×1.0) */
  adProfit: number
}

function computeOptions(
  rows: AdCampaignRow[],
  bepMap: Map<string, number>,
  priceMap: Map<string, number>,
  rowMap: Map<string, { optionName?: string; coupangOptionName?: string; alias?: string; channel?: string; netProfit?: number | null; taxable?: boolean; saleChannel?: '3P' | '1P' }>,
  exposureByOptionId: Map<string, string>,
): OptionDiag[] {
  const grp = new Map<string, AdCampaignRow[]>()
  for (const r of rows) {
    const id = String(r.adOptionId || '').trim() || '_'
    const arr = grp.get(id) ?? []
    arr.push(r)
    grp.set(id, arr)
  }
  const out: OptionDiag[] = []
  for (const [optId, rs] of grp) {
    const adCostRaw = rs.reduce((s, r) => s + (r.adCost || 0), 0)
    const adCostVat = adCostRaw * 1.1
    const sold = rs.reduce((s, r) => s + (r.sold14d || 0), 0)
    const clicks = rs.reduce((s, r) => s + (r.clicks || 0), 0)
    let revenue = 0
    let otherProductRevenue = 0
    for (const r of rs) {
      const split = splitRowRevenue(r, priceMap, exposureByOptionId)
      revenue += split.self
      otherProductRevenue += split.other
    }
    let searchRaw = 0
    let nonSearchRaw = 0
    for (const r of rs) {
      if (isSearchPlacement(r.placement)) searchRaw += r.adCost || 0
      else nonSearchRaw += r.adCost || 0
    }
    const roasPct = adCostRaw > 0 ? (revenue / adCostRaw) * 100 : null // 광고센터 기준
    const bepPct = bepMap.get(optId) ?? null
    const saleCh: '3P' | '1P' = rs.some(isRetailRow) ? '1P' : '3P'
    let margin = 0
    let costForProfit = 0
    for (const r of rs) {
      const cm = rowMap.get(String(r.convOptionId || '').trim())
      if (cm?.netProfit != null && (isRetailRow(r) || cm.saleChannel !== '1P')) margin += (r.sold14d || 0) * cm.netProfit
      // 과세 여부: 광고집행 옵션 기준 (3P 행은 3P 옵션 행만) — 과세 ×1.0 · 면세 ×1.1
      const own = rowMap.get(optId)
      const ownRow = own && (isRetailRow(r) || own.saleChannel !== '1P') ? own : undefined
      const taxable = !!(ownRow?.taxable ?? cm?.taxable)
      costForProfit += (r.adCost || 0) * (taxable ? 1.0 : 1.1)
    }
    const gapPct = roasPct != null && bepPct != null ? roasPct - bepPct : null
    const mr = rowMap.get(optId)
    const matched = !!mr
    // 표시명: 쿠팡 옵션명(나무_마스터 AD) 우선, 없으면 기존 옵션명
    const optionName = mr?.coupangOptionName || mr?.optionName || `미매칭 (${optId.slice(-8) || '없음'})`
    const cvrPct = clicks > 0 ? (sold / clicks) * 100 : null
    out.push({
      optionId: optId,
      optionName,
      alias: mr?.alias || '',
      channel: mr?.channel || '',
      adCostVat, revenue, otherProductRevenue, sold, clicks, cvrPct,
      searchAdCostRaw: searchRaw,
      nonSearchAdCostRaw: nonSearchRaw,
      searchShare: adCostRaw > 0 ? searchRaw / adCostRaw : 0,
      roasPct, bepPct, gapPct, matched,
      saleCh,
      adProfit: margin - costForProfit,
    })
  }
  out.sort((a, b) => b.adCostVat - a.adCostVat)
  return out
}

// 키워드 표 위 옵션 칩 — 전체 옵션 | 옵션A | 옵션B … (같은 칩 다시 누르면 전체로)
function OptionChips({ options, selectedOptionId, onSelect }: { options: OptionDiag[]; selectedOptionId: string | null; onSelect: (id: string | null) => void }) {
  if (options.length <= 1) return null
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
    border: '1px solid ' + (active ? '#2563EB' : '#CBD5E1'), background: active ? '#EFF6FF' : '#fff', color: active ? '#1D4ED8' : '#334155',
  })
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
      <button style={chip(selectedOptionId == null)} onClick={() => onSelect(null)}>전체 옵션</button>
      {options.map((o) => (
        <button key={o.optionId} style={chip(selectedOptionId === o.optionId)} onClick={() => onSelect(o.optionId)} title={o.optionName}>
          {o.optionName.length > 28 ? `${o.optionName.slice(0, 28)}…` : o.optionName} · {fmtMan(o.adCostVat)}
        </button>
      ))}
    </div>
  )
}

// ── 검색 키워드 표 옵션 드릴다운 ──────────────────────────────
interface KeywordOption {
  optionId: string
  optionName: string
  alias: string
  channel: string
  matched: boolean
  sold: number
  share: number
  clicks: number
  cvrPct: number | null
  bepCpcVatExcl: number | null
  recommendedBidVatExcl: number | null
  /** BEP CPC 산출에 쓴 CVR source. 'option' = 옵션+키워드 자체 / 'campaign' = 캠페인 평균 fallback (clicks<20). */
  cvrSource: 'option' | 'campaign' | null
}

/** 옵션 자체 CVR 신뢰도 임계 — 클릭 < N 이면 캠페인 평균 CVR 로 fallback */
const OPTION_CVR_MIN_CLICKS = 20

function computeKeywordOptions(
  keyword: string,
  campaignRows: AdCampaignRow[],
  bepMap: Map<string, number>,
  priceMap: Map<string, number>,
  rowMap: ReturnType<typeof buildMarginRowMap>,
  campaignAvgCvr: number | null,
): KeywordOption[] {
  // 검색 영역 + 해당 키워드만
  const filtered = campaignRows.filter((r) =>
    isSearchPlacement(r.placement) && (r.keyword || '-') === keyword,
  )
  if (!filtered.length) return []
  const totalSold = filtered.reduce((s, r) => s + (r.sold14d || 0), 0)
  const keywordClicks = filtered.reduce((s, r) => s + (r.clicks || 0), 0)
  // 매출 발생 옵션 (convOptionId) 단위 그룹핑
  const grp = new Map<string, AdCampaignRow[]>()
  for (const r of filtered) {
    const id = String(r.convOptionId || '').trim()
    if (!id) continue
    const arr = grp.get(id) ?? []
    arr.push(r)
    grp.set(id, arr)
  }
  const out: KeywordOption[] = []
  for (const [optId, rs] of grp) {
    const sold = rs.reduce((s, r) => s + (r.sold14d || 0), 0)
    const clicks = rs.reduce((s, r) => s + (r.clicks || 0), 0)
    const cvrPct = clicks > 0 ? (sold / clicks) * 100 : null
    const mr = rowMap.get(optId)
    const matched = !!mr
    const price = priceMap.get(optId) ?? ((rowMap.get(optId) as any)?.saleChannel === '1P' ? (rowMap.get(optId) as any).actualPrice : null) ?? null
    const bep = bepMap.get(optId) ?? null
    let bepCpcVatExcl: number | null = null
    let recBid: number | null = null
    let cvrSource: 'option' | 'campaign' | null = null
    // 옵션 자체 CVR 신뢰도 가드 — clicks<20 이면 단발성 데이터(클릭 1→전환 1=100%) 가능성, 캠페인 평균으로 fallback
    let cvrUsedPct: number | null = null
    if (cvrPct != null && clicks >= OPTION_CVR_MIN_CLICKS) {
      cvrUsedPct = cvrPct
      cvrSource = 'option'
    } else if (campaignAvgCvr != null && campaignAvgCvr > 0) {
      cvrUsedPct = campaignAvgCvr * 100
      cvrSource = 'campaign'
    }
    if (cvrUsedPct != null && price && bep && bep > 0) {
      // BEP CPC (VAT 별도) = (CVR × 단가) / BEP(광고센터 기준, 이미 ×1.1). 추천 입찰가 = BEP CPC × 0.95 (5% 안전마진).
      const cpc = ((cvrUsedPct / 100) * price) / (bep / 100)
      if (Number.isFinite(cpc) && cpc > 0) {
        bepCpcVatExcl = cpc
        // 키워드 클릭 20 미만이면 옵션별 추천 입찰가도 없음 (모수 부족 — hasBidSample 단일 기준)
        recBid = hasBidSample(keywordClicks) ? cpc * 0.95 : null
      } else {
        cvrSource = null
      }
    } else {
      cvrSource = null
    }
    out.push({
      optionId: optId,
      optionName: mr?.coupangOptionName || mr?.optionName || `미매칭 (${optId.slice(-8) || '없음'})`,
      alias: mr?.alias || '',
      channel: mr?.channel || '',
      matched,
      sold,
      share: totalSold > 0 ? sold / totalSold : 0,
      clicks,
      cvrPct,
      bepCpcVatExcl,
      recommendedBidVatExcl: recBid,
      cvrSource,
    })
  }
  out.sort((a, b) => b.sold - a.sold)
  return out
}

function KeywordOptionRow({ entry }: { entry: KeywordOption }) {
  return (
    <tr className="aa-keyword-option-row">
      <td colSpan={13} className="aa-keyword-option-cell">
        <div className="aa-keyword-option-flex">
          <span className="aa-option-prefix">└─</span>
          <span className="aa-option-text">
            {entry.alias && <span className="aa-option-alias">{entry.alias}</span>}
            <span className="aa-option-name">{entry.optionName}</span>
            {!entry.matched && <span style={{ marginLeft: 4, fontSize: 10, color: '#92400E' }}>⚠</span>}
            <ChannelBadge raw={entry.channel} />
          </span>
          <span className="aa-kw-opt-metric">판매 <strong className="mono">{fmtNum(entry.sold)}</strong>개 <span className="text-muted">({Math.round(entry.share * 100)}%)</span></span>
          <span className="aa-kw-opt-metric">전환율 <strong className="mono">{entry.cvrPct != null ? `${entry.cvrPct.toFixed(1)}%` : '—'}</strong></span>
          <span className="aa-kw-opt-metric">BEP CPC <strong className="mono">{entry.bepCpcVatExcl != null ? `${Math.round(entry.bepCpcVatExcl).toLocaleString('ko-KR')}원` : '—'}</strong></span>
          <span className="aa-kw-opt-metric">추천 입찰가 {entry.recommendedBidVatExcl != null
            ? <span className="bid-recommend">{ceilToTen(entry.recommendedBidVatExcl).toLocaleString('ko-KR')}원</span>
            : <span className="text-muted">—</span>}
            {entry.cvrSource === 'campaign' && (
              <span style={{ marginLeft: 4, fontSize: 10, color: '#94A3B8' }}>(캠페인 평균 CVR)</span>
            )}
          </span>
        </div>
      </td>
    </tr>
  )
}

function KeywordTable({ rows, campaignRows, campaignBep, marginOff = false, hideBep = false, checked, onToggle, nonSearchCount: _nsc, campaignName, periodLabel, bepMap, priceMap, rowMap, selectedOptionName }: {
  rows: KeywordRow[]
  campaignRows: AdCampaignRow[]
  campaignBep: number | null
  marginOff?: boolean
  hideBep?: boolean
  checked: Set<string>
  onToggle: (k: string) => void
  nonSearchCount: number
  campaignName: string
  periodLabel: string
  bepMap: Map<string, number>
  priceMap: Map<string, number>
  rowMap: ReturnType<typeof buildMarginRowMap>
  /** 옵션 필터 적용 시 옵션명. null = 전체 옵션 (캠페인명 사용) */
  selectedOptionName?: string | null
}) {
  const { sorted, key, dir, toggle } = useSort(rows, 'adCostVat' as keyof KeywordRow, 'desc')
  const [expandedKws, setExpandedKws] = useState<Set<string>>(new Set())
  function toggleKw(k: string) {
    setExpandedKws((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }

  // 캠페인 평균 CVR — 옵션 row 의 클릭<20 fallback CVR (키워드 row BEP fallback 과 동일 정의)
  const campaignAvgCvr = useMemo(() => {
    let totalOrders = 0, totalClicks = 0
    for (const r of campaignRows) {
      totalOrders += r.sold14d || 0
      totalClicks += r.clicks || 0
    }
    return totalClicks > 0 ? totalOrders / totalClicks : null
  }, [campaignRows])

  const TH = ({ label, k, num, minWidth, sticky, sticky2, width }: any) => (
    <th
      className={[
        'sortable', num ? 'num' : '',
        sticky ? 'sticky-left' : '',
        sticky2 ? 'sticky-left-2' : '',
        key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
      ].filter(Boolean).join(' ')}
      style={{ ...(minWidth ? { minWidth } : null), ...(width ? { width } : null) }}
      onClick={() => toggle(k)}
    >
      {label}
    </th>
  )

  const belowBepCount = sorted.filter((r) => campaignBep != null && r.roasPct != null && r.roasPct < campaignBep).length
  const totalCost = sorted.reduce((s, r) => s + r.adCostVat, 0)

  // 체크된 모든 키워드를 선택한 카테고리(제외/수동 이동) 텍스트로 복사 — 추천 액션 무관, 사용자 의사 우선
  function copyChecked(target: 'exclude' | 'move') {
    const list = sorted.filter((r) => checked.has(r.keyword)).map((r) => r.keyword)
    if (list.length === 0) {
      alert('선택된 키워드가 없습니다.')
      return
    }
    const text = list.join('\n')
    const label = target === 'exclude' ? '제외' : '수동 이동'
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => alert(`✓ ${list.length}개 키워드 복사 완료 (${label})`)).catch(() => {
        prompt('복사 실패 — 직접 복사해주세요:', text)
      })
    } else {
      prompt(`${label} 키워드 복사:`, text)
    }
  }

  function exportRows(scope: 'all' | 'selected') {
    const target = scope === 'selected' ? sorted.filter((r) => checked.has(r.keyword)) : sorted
    if (target.length === 0) {
      alert(scope === 'selected' ? '선택된 키워드가 없습니다.' : '내보낼 키워드가 없습니다.')
      return
    }
    const cols: XlsxCol<(typeof target)[number]>[] = [
      { header: '키워드', kind: 'text', get: (r) => r.keyword },
      { header: '추천 입찰가 (5% 안전마진, VAT 별도)', kind: 'won', get: (r) =>
          r.bidSource === 'low_sample' || r.recommendedBidVatExcl == null
            ? null
            : r.bidSource === 'fixed_100'
              ? 100
              : ceilToTen(r.recommendedBidVatExcl) },
      ...KW_METRIC_COLS,
      { header: '추천 액션', kind: 'text', get: (r) => ACTION_LABEL[r.action] },
    ]
    // 파일명: 옵션 필터 적용 시 옵션명, 미적용 시 캠페인명
    const fileLabel = selectedOptionName ? selectedOptionName : campaignName
    const filename = `광고분석_검색키워드_${sanitizeFile(fileLabel)}_${periodLabel}.xlsx`
    void downloadFormattedXlsx(cols, target, filename, '검색키워드')
  }

  return (
    <div className="aa-sub-section">
      <div className="aa-sub-section-title">
        <span>🔍 검색 키워드 ({sorted.length}개{!hideBep && ` · BEP ROAS 미달 ${belowBepCount}개`} · 광고비 {fmtMan(totalCost)})</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            ⬇ 전체 다운로드
          </button>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('selected')}
            disabled={checked.size === 0}
            style={{ fontSize: 11, padding: '4px 10px', opacity: checked.size === 0 ? 0.5 : 1 }}
          >
            ⬇ 선택 다운로드 ({checked.size})
          </button>
        </div>
      </div>
      <div className="aa-table-wrap shorter">
        <table>
          <thead>
            <tr>
              <th className="sticky-left" style={{ width: 32 }}></th>
              <TH label="키워드" k="keyword" sticky2 minWidth={140} />
              <TH label="노출" k="impressions" num />
              <TH label="클릭" k="clicks" num />
              <TH label="클릭율" k="ctrPct" num />
              <TH label="광고 판매수" k="orders" num />
              <TH label="전환율" k="cvrPct" num />
              <TH label="ROAS" k="roasPct" num />
              <TH label={<>현재 CPC<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(+VAT)</span></>} k="currentCpcVatIncl" num minWidth={100} />
              <TH label="광고비 (+VAT)" k="adCostVat" num />
              <TH label="광고 매출" k="revenue" num />
              {!hideBep && <th><ActionGuideHeader /></th>}
              {!hideBep && <TH label={<>추천 입찰가<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(이대로 입력 · 5% 안전마진 · VAT 별도)</span></>} k="recommendedBidVatExcl" num minWidth={170} />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const isExpanded = !marginOff && expandedKws.has(r.keyword)
              const opts = isExpanded
                ? computeKeywordOptions(r.keyword, campaignRows, bepMap, priceMap, rowMap, campaignAvgCvr)
                : []
              return (
                <React.Fragment key={r.keyword}>
                  <KeywordRowComp
                    r={r}
                    marginOff={hideBep}
                    checked={checked.has(r.keyword)}
                    onToggle={() => onToggle(r.keyword)}
                    isExpanded={isExpanded}
                    onToggleExpand={() => toggleKw(r.keyword)}
                  />
                  {isExpanded && opts.map((opt) => (
                    <KeywordOptionRow key={`${r.keyword}::${opt.optionId}`} entry={opt} />
                  ))}
                  {isExpanded && opts.length === 0 && (
                    <tr className="aa-keyword-option-row">
                      <td colSpan={13} style={{ textAlign: 'center', color: '#94A3B8', padding: 12, fontSize: 12 }}>옵션 매출 데이터 없음</td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={hideBep ? 11 : 13} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>검색 키워드 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="aa-bulk-action">
        <div><strong>{checked.size}개</strong> 선택됨 — 어느 카테고리로 복사할지 선택하세요 (추천 액션은 가이드일 뿐)</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="aa-btn btn-sm btn-bad" onClick={() => copyChecked('exclude')}>🚫 제외 키워드 복사 ({checked.size})</button>
          <button className="aa-btn btn-sm btn-info" onClick={() => copyChecked('move')}>➡️ 수동 이동 키워드 복사 ({checked.size})</button>
        </div>
      </div>
      <ActionLegend />
    </div>
  )
}

// 현재 CPC (+VAT) 색상: 추천(+VAT) 이하=녹 / BEP CPC(+VAT) 이하=노랑 / 초과=빨강 / 산정 불가=회색.
// BEP CPC (+VAT) = revenue / (clicks × bep/100). 추천(+VAT) = BEP CPC(+VAT) × 0.95.
function currentCpcColorClass(r: KeywordRow): string {
  if (r.currentCpcVatIncl == null) return 'text-muted'
  if (r.bepPct == null || r.bepPct <= 0 || r.clicks <= 0 || r.revenue <= 0) return ''
  const bepCpcVatIncl = r.revenue / (r.clicks * (r.bepPct / 100))
  if (!Number.isFinite(bepCpcVatIncl) || bepCpcVatIncl <= 0) return ''
  const recVatIncl = bepCpcVatIncl * 0.95
  if (r.currentCpcVatIncl <= recVatIncl) return 'text-good'
  if (r.currentCpcVatIncl <= bepCpcVatIncl) return 'text-warn'
  return 'text-bad'
}

// 추천 액션 컬럼 헤더 — ⓘ hover 시 가이드 팝업 (320px, 다크 #1F2937)
function ActionGuideHeader() {
  const [hovered, setHovered] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      추천 액션
      <span
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          background: '#94A3B8', color: '#FFFFFF',
          fontSize: 10, fontWeight: 700, fontStyle: 'italic',
          cursor: 'help', userSelect: 'none',
        }}
        aria-label="추천 액션 가이드"
      >i</span>
      {hovered && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6,
            zIndex: 1000, width: 320, padding: '12px 14px',
            background: '#1F2937', color: '#FFFFFF',
            borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontSize: 12, lineHeight: 1.6, fontFamily: 'inherit', fontWeight: 400,
            whiteSpace: 'pre-line', textAlign: 'left',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>추천 액션 가이드</div>
          <div style={{ borderTop: '1px solid #374151', margin: '4px 0 8px' }} />
          <div style={{ marginBottom: 6 }}>
            <div style={{ color: '#FCD34D', fontWeight: 600, marginBottom: 2 }}>
              클릭 &lt; 20 <span style={{ color: '#9CA3AF', fontWeight: 400, fontSize: 11 }}>(모수 쌓는 중)</span>
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>
              ROAS 무관      → 모수 부족 (추천 입찰가 없음)
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: '#FCD34D', fontWeight: 600, marginBottom: 2 }}>
              클릭 ≥ 20 <span style={{ color: '#9CA3AF', fontWeight: 400, fontSize: 11 }}>(판단 가능)</span>
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>
              ROAS ≥ BEP ROAS×2  → 강화<br />
              BEP ROAS ≤ ROAS&lt;×2 → 유지<br />
              0 &lt; ROAS &lt; BEP ROAS → 입찰가 ↓<br />
              ROAS = 0      → 제외 (입찰가 100원)
            </div>
          </div>
          <div style={{ borderTop: '1px solid #374151', margin: '4px 0 6px' }} />
          <div style={{ fontSize: 11.5, color: '#D1D5DB' }}>
            💡 클릭 20 미만은 AI 캠페인이 모수 쌓는 중. 제외 추천 X.
          </div>
        </div>
      )}
    </span>
  )
}

// 추천 액션 6단 → 배지 렌더 (테이블 셀 + 엑셀 라벨 공통)
const ACTION_LABEL: Record<KeywordRow['action'], string> = {
  growing: '성장 중',
  low_sample: '모수 부족',
  enhance: '강화',
  maintain: '유지',
  lower_bid: '입찰가 ↓',
  exclude: '제외',
}
function actionBadge(action: KeywordRow['action']): React.ReactElement {
  switch (action) {
    case 'growing':    return <span className="aa-action-chip action-growing">⭐ 성장 중</span>
    case 'low_sample': return <span className="aa-action-chip action-low-sample">모수 부족</span>
    case 'enhance':    return <span className="aa-action-chip action-enhance">강화</span>
    case 'maintain':   return <span className="aa-action-chip action-maintain">유지</span>
    case 'lower_bid':  return <span className="aa-action-chip action-lower-bid">입찰가 ↓</span>
    case 'exclude':    return <span className="aa-action-chip action-exclude">🚫 제외</span>
  }
}

function KeywordRowComp({ r, checked, onToggle, isExpanded, onToggleExpand, marginOff = false }: { r: KeywordRow; checked: boolean; onToggle: () => void; isExpanded: boolean; onToggleExpand: () => void; marginOff?: boolean }) {
  const roasClass =
    r.roasPct == null || r.bepPct == null ? '' :
    r.roasPct < r.bepPct ? 'text-bad' :
    r.roasPct < r.bepPct * 1.2 ? 'text-warn' : 'text-good'
  const cvrClass =
    r.cvrPct == null ? '' :
    r.cvrPct >= 10 ? 'text-good' :
    r.cvrPct < 6 ? 'text-bad' : 'text-warn'

  // 입찰가 셀 — bidSource 별 분기.
  //   low_sample        : "—"
  //   fixed_100         : "100원" (제외 권장)
  //   revenue + growing : 매출 역산 + "(참고용)" 라벨
  //   revenue + 그 외   : 매출 역산
  let bidCell: React.ReactNode
  if (r.bidSource === 'low_sample' || r.recommendedBidVatExcl == null) {
    bidCell = <span className="text-muted" style={{ fontSize: 11 }}>—</span>
  } else if (r.bidSource === 'fixed_100') {
    bidCell = <span className="bid-recommend">100원</span>
  } else {
    bidCell = (
      <>
        <span className="bid-recommend">{ceilToTen(r.recommendedBidVatExcl).toLocaleString('ko-KR')}원</span>
        <span className="bid-vat-incl">(+VAT) {ceilToTen(r.recommendedBidVatExcl * 1.1).toLocaleString('ko-KR')}원</span>
        {r.action === 'growing' && (
          <span style={{ display: 'block', fontSize: 10, color: '#94A3B8', marginTop: 2 }}>(참고용)</span>
        )}
      </>
    )
  }

  return (
    <tr>
      <td className="sticky-left"><input type="checkbox" checked={checked} onChange={onToggle} /></td>
      <td className="sticky-left-2">
        <span
          className="aa-expand-toggle"
          onClick={onToggleExpand}
          title={isExpanded ? '옵션 접기' : '옵션 펼치기'}
        >
          {isExpanded ? '▾' : '▸'}
        </span>
        <strong>{r.keyword}</strong>
      </td>
      <td className="num">{fmtNum(r.impressions)}</td>
      <td className="num">{fmtNum(r.clicks)}</td>
      <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
      <td className="num">{fmtNum(r.orders)}</td>
      <td className={`num ${cvrClass}`}>{fmtPctVal(r.cvrPct, 2)}</td>
      <td className={`num ${roasClass}`}>{fmtRoas(r.roasPct)}</td>
      <td className={`num ${currentCpcColorClass(r)}`}>{r.currentCpcVatIncl != null ? `${Math.round(r.currentCpcVatIncl).toLocaleString('ko-KR')}원` : '—'}</td>
      <td className="num">{fmtMan(r.adCostVat)}</td>
      <td className="num">{fmtMan(r.revenue)}</td>
      {!marginOff && <td>{actionBadge(r.action)}</td>}
      {!marginOff && <td className="num">{bidCell}</td>}
    </tr>
  )
}

// ── 비검색 키워드 표 ──────────────────────────────────────────
function NonSearchKeywordTable({ rows, campaignBep, hideBep = false, campaignName, periodLabel }: {
  rows: KeywordRow[]
  campaignBep: number | null
  hideBep?: boolean
  campaignName: string
  periodLabel: string
}) {
  const { sorted, key, dir, toggle } = useSort(rows, 'adCostVat' as keyof KeywordRow, 'desc')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const onToggle = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })

  const TH = ({ label, k, num, minWidth, sticky2 }: any) => (
    <th
      className={['sortable', num ? 'num' : '', sticky2 ? 'sticky-left-2' : '', key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : ''].filter(Boolean).join(' ')}
      style={minWidth ? { minWidth } : undefined}
      onClick={() => toggle(k)}
    >{label}</th>
  )

  const totalCost = sorted.reduce((s, r) => s + r.adCostVat, 0)
  const belowBepCount = sorted.filter((r) => campaignBep != null && r.roasPct != null && r.roasPct < campaignBep).length

  function exportRows(scope: 'all' | 'selected') {
    const target = scope === 'selected' ? sorted.filter((r) => checked.has(r.keyword)) : sorted
    if (target.length === 0) {
      alert(scope === 'selected' ? '선택된 항목이 없습니다.' : '내보낼 항목이 없습니다.')
      return
    }
    const cols: XlsxCol<(typeof target)[number]>[] = [
      { header: '지면', kind: 'text', get: (r) => r.keyword },
      ...KW_METRIC_COLS,
    ]
    const filename = `광고분석_비검색키워드_${sanitizeFile(campaignName)}_${periodLabel}.xlsx`
    void downloadFormattedXlsx(cols, target, filename, '비검색키워드')
  }

  return (
    <div className="aa-sub-section" style={{ marginTop: 16 }}>
      <div className="aa-sub-section-title">
        <span>🎯 비검색 키워드 ({sorted.length}개{!hideBep && ` · BEP ROAS 미달 ${belowBepCount}개`} · 광고비 {fmtMan(totalCost)})</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >⬇ 전체 다운로드</button>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('selected')}
            disabled={checked.size === 0}
            style={{ fontSize: 11, padding: '4px 10px', opacity: checked.size === 0 ? 0.5 : 1 }}
          >⬇ 선택 다운로드 ({checked.size})</button>
        </div>
      </div>
      <div className="aa-table-wrap shorter">
        <table>
          <thead>
            <tr>
              <th className="sticky-left" style={{ width: 32 }}></th>
              <TH label="지면" k="keyword" sticky2 minWidth={140} />
              <TH label="노출" k="impressions" num />
              <TH label="클릭" k="clicks" num />
              <TH label="클릭율" k="ctrPct" num />
              <TH label="광고 판매수" k="orders" num />
              <TH label="전환율" k="cvrPct" num />
              <TH label="ROAS" k="roasPct" num />
              <TH label={<>현재 CPC<br /><span style={{ fontSize: 10, color: '#94A3B8' }}>(+VAT)</span></>} k="currentCpcVatIncl" num minWidth={100} />
              <TH label="광고비 (+VAT)" k="adCostVat" num />
              <TH label="광고 매출" k="revenue" num />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const roasClass =
                r.roasPct == null || r.bepPct == null ? '' :
                r.roasPct < r.bepPct ? 'text-bad' :
                r.roasPct < r.bepPct * 1.2 ? 'text-warn' : 'text-good'
              return (
                <tr key={r.keyword}>
                  <td className="sticky-left"><input type="checkbox" checked={checked.has(r.keyword)} onChange={() => onToggle(r.keyword)} /></td>
                  <td className="sticky-left-2"><strong>{r.keyword}</strong></td>
                  <td className="num">{fmtNum(r.impressions)}</td>
                  <td className="num">{fmtNum(r.clicks)}</td>
                  <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
                  <td className="num">{fmtNum(r.orders)}</td>
                  <td className="num">{fmtPctVal(r.cvrPct, 2)}</td>
                  <td className={`num ${roasClass}`}>{fmtRoas(r.roasPct)}</td>
                  <td className={`num ${currentCpcColorClass(r)}`}>{r.currentCpcVatIncl != null ? `${Math.round(r.currentCpcVatIncl).toLocaleString('ko-KR')}원` : '—'}</td>
                  <td className="num">{fmtNum(r.adCostVat)}</td>
                  <td className="num">{fmtNum(r.revenue)}</td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={11} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>비검색 키워드 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── xlsx export 헬퍼 ──────────────────────────────────────────
/** 검색·비검색·수동 키워드 공통 지표 열 (서식: lib/xlsxExport) */
const KW_METRIC_COLS: XlsxCol<{
  impressions: number; clicks: number; ctrPct: number | null; orders: number; cvrPct: number | null
  roasPct: number | null; currentCpcVatIncl: number | null; adCostVat: number; revenue: number
}>[] = [
  { header: '노출', kind: 'count', get: (r) => r.impressions },
  { header: '클릭', kind: 'count', get: (r) => r.clicks },
  { header: '클릭율', kind: 'pct', get: (r) => r.ctrPct },
  { header: '광고 판매수', kind: 'count', get: (r) => r.orders },
  { header: '전환율', kind: 'pct', get: (r) => r.cvrPct },
  { header: 'ROAS', kind: 'roas', get: (r) => r.roasPct },
  { header: '현재 CPC (+VAT)', kind: 'won', get: (r) => r.currentCpcVatIncl },
  { header: '광고비 (+VAT)', kind: 'won', get: (r) => r.adCostVat },
  { header: '광고 매출', kind: 'won', get: (r) => r.revenue },
]
function sanitizeFile(s: string): string {
  return (s || 'unnamed').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80)
}

function ActionLegend() {
  return (
    <div style={{ fontSize: 11.5, color: '#64748B', padding: '10px 12px', background: '#F8FAFC', borderRadius: 6, lineHeight: 1.7, marginTop: 8 }}>
      <strong style={{ color: '#1F2937' }}>추천 액션 기준 (클릭 기준):</strong>
      <br /><span style={{ color: '#1F2937', fontWeight: 600 }}>클릭 &lt; 20 (모수 쌓는 중)</span>
      <br />• <span className="aa-action-chip action-low-sample">모수 부족</span> ROAS 와 무관 — 추천 입찰가 노출 안 함 (화면·엑셀 모두)
      <br /><span style={{ color: '#1F2937', fontWeight: 600 }}>클릭 ≥ 20 (판단 가능)</span>
      <br />• <span className="aa-action-chip action-enhance">강화</span> ROAS ≥ BEP ROAS × 2
      <br />• <span className="aa-action-chip action-maintain">유지</span> BEP ROAS ≤ ROAS &lt; BEP ROAS × 2
      <br />• <span className="aa-action-chip action-lower-bid">입찰가 ↓</span> 0 &lt; ROAS &lt; BEP ROAS — 매출 역산값으로 인하
      <br />• <span className="aa-action-chip action-exclude">🚫 제외</span> ROAS = 0 — 입찰가 100원 강제
      <br /><br />
      <strong style={{ color: '#1F2937' }}>추천 입찰가 공식 (매출 역산):</strong> 매출 ÷ (클릭수 × BEP ROAS × 1.05) — BEP ROAS·ROAS 는 광고센터 기준(광고비 VAT 별도){' '}
      <span style={{ fontSize: 11 }}>— BEP ROAS 대비 5% 여유 / VAT 별도 = 쿠팡 광고센터 입력값</span>
    </div>
  )
}

// ── Manual Section ────────────────────────────────────────────
/** 키워드 분석·입찰가 점검 칸 제목 오른쪽 BEP 줄 — 캠페인 필수 ROAS / 봉수별 필수 ROAS [필수 CPC] (표시만, 계산은 buildBepCpcForCampaign).
 *  옵션 칩으로 한 옵션만 볼 때는 그 옵션 라벨을 강조 */
function BepCpcLine({ campaign, entries, rowMap, selectedOptionId }: {
  campaign: CampaignDiag
  entries: ReturnType<typeof buildBepCpcForCampaign>
  rowMap: ReturnType<typeof buildMarginRowMap>
  selectedOptionId: string | null
}) {
  if (!entries.length) return null
  const sel = selectedOptionId ? rowMap.get(selectedOptionId) : undefined
  const selLabel = sel ? bepCpcLabel(sel, selectedOptionId!) : null
  return (
    <div style={{ fontSize: 11.5, color: '#64748B' }}>
      <strong style={{ color: '#1F2937' }}>BEP ROAS</strong>{' '}—{' '}
      <strong className="mono" style={{ color: '#1F2937' }}>{campaign.bepPct != null ? `${Math.round(campaign.bepPct)}%` : '—'}</strong>{' '}/{' '}
      <span className="mono">
        {entries.map((e, i) => {
          const hit = selLabel != null && e.label === selLabel
          return (
            <span key={e.label}>
              {i > 0 && ', '}
              <span style={hit ? { background: '#FEF3C7', color: '#92400E', fontWeight: 700, padding: '0 3px', borderRadius: 3 } : selLabel ? { opacity: 0.55 } : undefined}>
                {e.label} {Math.round(e.bepPct)}% [{Math.round(e.cpc).toLocaleString('ko-KR')}원]
              </span>
            </span>
          )
        })}
      </span>{' '}
      <span style={{ color: '#EF4444' }}>(VAT 별도)</span>
    </div>
  )
}

function ManualSection({ campaign, master, marginOff = false, hideBep = false, manualBep, periodLabel, selectedOptionId, onClearOption, onClose, onSelectOption }: {
  onSelectOption?: (optionId: string | null) => void
  campaign: CampaignDiag
  master: any
  marginOff?: boolean
  hideBep?: boolean
  manualBep?: Map<string, number>
  periodLabel: string
  selectedOptionId: string | null
  onClearOption: () => void
  onClose: () => void
}) {
  const bepMap = useMemo(() => marginOff ? (manualBep ?? new Map<string, number>()) : buildBepMap(master), [marginOff, manualBep, master])
  const priceMap = useMemo(() => buildActualPriceMapById(master), [master])
  const rowMap = useMemo(() => buildMarginRowMap(master), [master])
  const exposureMap = useMemo(() => buildExposureMapByOptionId(master), [master])
  const options = useMemo(() => computeOptions(campaign.rows, bepMap, priceMap, rowMap, exposureMap), [campaign.rows, bepMap, priceMap, rowMap, exposureMap])

  const filteredCampaign = useMemo(() => {
    if (!selectedOptionId) return campaign
    return { ...campaign, rows: campaign.rows.filter((r) => String(r.adOptionId || '').trim() === selectedOptionId) }
  }, [campaign, selectedOptionId])
  const selectedOptionName = selectedOptionId
    ? (options.find((o) => o.optionId === selectedOptionId)?.optionName ?? selectedOptionId)
    : null

  const cpcEntries = useMemo(() => marginOff ? [] : buildBepCpcForCampaign(campaign, master), [campaign, master, marginOff])
  const [bidByKeyword, setBidByKeyword] = useState<Map<string, number>>(new Map())
  const rows = useMemo(() => buildManualReviewRows(filteredCampaign, bepMap, priceMap, bidByKeyword, exposureMap, marginOff), [filteredCampaign, bepMap, priceMap, bidByKeyword, exposureMap, marginOff])
  const { sorted, key, dir, toggle } = useSort(rows, 'recommendedBidVatExcl' as keyof ManualKeywordRow, 'desc')

  const TH = ({ label, k, num, minWidth, sticky, sticky2 }: any) => (
    <th
      className={[
        'sortable', num ? 'num' : '',
        sticky ? 'sticky-left' : '',
        sticky2 ? 'sticky-left-2' : '',
        key === k ? (dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '',
      ].filter(Boolean).join(' ')}
      style={minWidth ? { minWidth } : undefined}
      onClick={() => toggle(k)}
    >{label}</th>
  )

  function setBid(kw: string, value: string) {
    const n = Number(value.replace(/[^\d]/g, ''))
    setBidByKeyword((prev) => {
      const next = new Map(prev)
      if (Number.isFinite(n) && n > 0) next.set(kw, n)
      else next.delete(kw)
      return next
    })
  }

  const [checked, setChecked] = useState<Set<string>>(new Set())
  function onToggle(kw: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(kw)) next.delete(kw); else next.add(kw)
      return next
    })
  }
  const allChecked = sorted.length > 0 && sorted.every((r) => checked.has(r.keyword))
  function onToggleAll() {
    setChecked((prev) => {
      if (sorted.every((r) => prev.has(r.keyword))) return new Set()
      const next = new Set(prev)
      for (const r of sorted) next.add(r.keyword)
      return next
    })
  }

  const VERDICT_LABEL: Record<ManualKeywordRow['bidVerdict'], string> = {
    ok: '🟢 여유',
    high: '🟡 살짝 높음',
    too_high: '🔴 너무 높음',
    unknown: '⚪ 평가 보류',
  }

  function exportRows(scope: 'all' | 'selected') {
    const target = scope === 'selected' ? sorted.filter((r) => checked.has(r.keyword)) : sorted
    if (target.length === 0) {
      alert(scope === 'selected' ? '선택된 키워드가 없습니다.' : '내보낼 키워드가 없습니다.')
      return
    }
    const cols: XlsxCol<(typeof target)[number]>[] = [
      { header: '키워드', kind: 'text', get: (r) => r.keyword },
      { header: '추천 입찰가 (5% 안전마진, VAT 별도)', kind: 'won', get: (r) =>
          r.bidSource === 'low_sample' || r.recommendedBidVatExcl == null
            ? null
            : r.bidSource === 'fixed_100'
              ? 100
              : ceilToTen(r.recommendedBidVatExcl) },
      ...KW_METRIC_COLS,
      { header: '현재 입찰가 (VAT 별도)', kind: 'won', get: (r) => r.currentBidVatExcl ?? r.avgCpcVatExcl },
      { header: '차이', kind: 'won', get: (r) => r.bidDiff },
      { header: '신뢰도', kind: 'text', get: (r) => (r.confidence === 3 ? '⭐⭐⭐' : r.confidence === 2 ? '⭐⭐' : '⭐') },
      { header: '점검', kind: 'text', get: (r) => VERDICT_LABEL[r.bidVerdict] },
    ]
    const fileLabel = selectedOptionName ? selectedOptionName : campaign.campaignName
    const filename = `광고분석_수동키워드_${sanitizeFile(fileLabel)}_${periodLabel}.xlsx`
    void downloadFormattedXlsx(cols, target, filename, '수동키워드')
  }

  // 수기 BEP도 없을 때만 안내. 수기 BEP 입력 시 정상 렌더(추천입찰가·판정).
  if (hideBep) {
    return (
      <div className="aa-section" style={{ border: '2px solid #A855F7' }}>
        <div className="aa-section-header" style={{ background: '#FAF5FF' }}>
          <div>
            <div className="aa-section-title">▼ {campaign.campaignName} · 입찰가 점검</div>
            <div className="aa-section-desc">수동 점검(추천입찰가·BEP ROAS)은 마진마스터가 필요합니다.</div>
          </div>
          <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
        </div>
        <div className="aa-section-body">
          <div style={{ ...noticeBoxOrange, fontSize: 13, margin: 0 }}>
            마진마스터가 없어 추천 입찰가·BEP ROAS 점검은 표시하지 않습니다. 캠페인·키워드 기본 지표(광고비·ROAS 등)는 위 캠페인 진단 표에서 확인하세요.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="aa-section" style={{ border: '2px solid #A855F7' }}>
      <div className="aa-section-header" style={{ background: '#FAF5FF' }}>
        <div>
          <div className="aa-section-title">▼ {campaign.campaignName} · 입찰가 점검</div>
          <div className="aa-section-desc">현재 입찰가 = 광고비/클릭수 (평균 CPC, VAT 별도) · 편집 가능</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {!hideBep && <BepCpcLine campaign={campaign} entries={cpcEntries} rowMap={rowMap} selectedOptionId={selectedOptionId} />}
          <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
        </div>
      </div>
      <div className="aa-section-body">
        <OptionChips options={options} selectedOptionId={selectedOptionId} onSelect={(id) => (id == null ? onClearOption() : onSelectOption?.(id))} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >⬇ 전체 다운로드</button>
          <button
            className="aa-btn btn-sm"
            onClick={() => exportRows('selected')}
            disabled={checked.size === 0}
            style={{ fontSize: 11, padding: '4px 10px', opacity: checked.size === 0 ? 0.5 : 1 }}
          >⬇ 선택 다운로드 ({checked.size})</button>
        </div>
        <div className="aa-table-wrap shorter">
          <table>
            <thead>
              <tr>
                <th className="sticky-left" style={{ width: 32 }}>
                  <input type="checkbox" checked={allChecked} onChange={onToggleAll} aria-label="전체 선택" />
                </th>
                <TH label="키워드" k="keyword" sticky2 minWidth={140} />
                <TH label="노출" k="impressions" num />
                <TH label="클릭" k="clicks" num />
                <TH label="클릭율" k="ctrPct" num />
                <TH label="광고 판매수" k="orders" num />
                <TH label="전환율" k="cvrPct" num />
                <TH label="매출" k="revenue" num />
                <TH label={<>광고비<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(VAT 별도)</span></>} k="adCostSum" num />
                <TH label="ROAS" k="roas" num />
                <th className="num">현재 입찰가<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(VAT 별도)</span></th>
                <TH label={<>추천 입찰가<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(이대로 입력 · 5% 안전마진 · VAT 별도)</span></>} k="recommendedBidVatExcl" num minWidth={170} />
                <TH label="차이" k="bidDiff" num />
                <th>신뢰도</th>
                <th>점검</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <ManualKeywordRowComp
                  key={r.keyword}
                  r={r}
                  checked={checked.has(r.keyword)}
                  onToggle={() => onToggle(r.keyword)}
                  onChangeBid={setBid}
                />
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={15} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>검색 키워드 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12, padding: '12px 14px', background: '#F8FAFC', borderRadius: 6, fontSize: 12, color: '#64748B', lineHeight: 1.7 }}>
          <strong style={{ color: '#1F2937' }}>💡 점검 기준:</strong>
          <br />• <span className="aa-badge badge-good">🟢 여유</span> 현재 ≤ 추천
          <br />• <span className="aa-badge badge-warn">🟡 살짝 높음</span> 추천 &lt; 현재 ≤ 추천 × 1.5
          <br />• <span className="aa-badge badge-bad">🔴 너무 높음</span> 현재 &gt; 추천 × 1.5
          <br />• <span className="aa-badge badge-unsorted">⚪ 평가 보류</span> 클릭 20건 미만
          <br /><strong style={{ color: '#1F2937' }}>신뢰도:</strong> ⭐⭐⭐ 50건+ / ⭐⭐ 20~49건 / ⭐ &lt;20건
        </div>
      </div>
    </div>
  )
}

function ManualKeywordRowComp({ r, checked, onToggle, onChangeBid }: { r: ManualKeywordRow; checked: boolean; onToggle: () => void; onChangeBid: (k: string, v: string) => void }) {
  const stars = r.confidence === 3 ? '⭐⭐⭐' : r.confidence === 2 ? '⭐⭐' : '⭐'
  const starsClass = r.confidence === 3 ? 'high' : r.confidence === 2 ? 'mid' : 'low'

  const verdictBadge =
    r.deleteCandidate ? <span className="aa-badge badge-bad">🗑 삭제 후보</span> :
    r.bidVerdict === 'ok' ? <span className="aa-badge badge-good">🟢 여유</span> :
    r.bidVerdict === 'high' ? <span className="aa-badge badge-warn">🟡 살짝 높음</span> :
    r.bidVerdict === 'too_high' ? <span className="aa-badge badge-bad">🔴 너무 높음</span> :
    <span className="aa-badge badge-unsorted">⚪ 평가 보류</span>

  const diffClass = r.bidDiff != null ? (r.bidDiff >= 0 ? 'text-good' : 'text-bad') : ''
  const isLowClick = r.clicks < 20

  // ROAS 색상: BEP 미산정/매출 0 → 회색 "—". ≥ BEP 녹 · ≥ BEP×0.7 노 · 그 외 빨.
  const roasShow = r.bepRoas != null && r.revenue > 0 && r.roas != null
  const roasClass = roasShow
    ? (r.roas! >= r.bepRoas! ? 'text-good'
      : r.roas! >= r.bepRoas! * 0.7 ? 'text-warn'
      : 'text-bad')
    : 'text-muted'
  const roasTitle = r.bepRoas != null ? `BEP ROAS ${Math.round(r.bepRoas)}%` : undefined

  return (
    <tr style={isLowClick ? { opacity: 0.6 } : undefined}>
      <td className="sticky-left"><input type="checkbox" checked={checked} onChange={onToggle} /></td>
      <td className="sticky-left-2"><strong>{r.keyword}</strong></td>
      <td className="num">{fmtNum(r.impressions)}</td>
      <td className="num">{fmtNum(r.clicks)}</td>
      <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
      <td className="num">{fmtNum(r.orders)}</td>
      <td className="num">{fmtPctVal(r.cvrPct, 2)}</td>
      <td className="num">{fmtNum(r.revenue)}</td>
      <td className="num">{fmtNum(r.adCostSum)}</td>
      <td className={`num ${roasClass}`} title={roasTitle}>{roasShow ? fmtRoas(r.roas) : '—'}</td>
      <td className="num">
        <input
          key={`${r.keyword}|${r.avgCpcVatExcl ?? ''}`}
          type="text"
          inputMode="numeric"
          placeholder={r.avgCpcVatExcl != null ? r.avgCpcVatExcl.toLocaleString('ko-KR') : '—'}
          defaultValue={r.currentBidVatExcl ?? r.avgCpcVatExcl ?? ''}
          onBlur={(e) => onChangeBid(r.keyword, e.target.value)}
          title="평균 CPC = 광고비/클릭수 (VAT 별도) · 비우면 자동값으로 복귀"
          style={{ width: 64, textAlign: 'right', padding: '2px 6px', border: '1px solid #E2E8F0', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
        />
      </td>
      <td className="num">
        {r.recommendedBidVatExcl != null
          ? <span className="bid-recommend">{ceilToTen(r.recommendedBidVatExcl).toLocaleString('ko-KR')}</span>
          : <span className="text-muted">데이터 부족</span>}
      </td>
      <td className={`num ${diffClass}`}>{r.bidDiff != null ? `${r.bidDiff > 0 ? '+' : ''}${Math.round(r.bidDiff).toLocaleString('ko-KR')}` : '—'}</td>
      <td><span className={`aa-stars ${starsClass}`}>{stars}</span></td>
      <td>{verdictBadge}</td>
    </tr>
  )
}

// ── Inline styles (가안 v3 CSS 차용) ───────────────────────────
function Style() {
  return (
    <style jsx global>{`
      .aa-page-header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #E2E8F0; }
      .aa-title { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
      .aa-desc { color: #64748B; font-size: 13px; margin-top: 4px; }
      .mono { font-family: 'JetBrains Mono', monospace; }
      .aa-vat-tag { display: inline-block; font-size: 10px; background: #F1F5F9; color: #94A3B8; padding: 1px 5px; border-radius: 3px; font-weight: 500; }
      .aa-section { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 20px; overflow: clip; }
      .aa-section-header { padding: 16px 20px; border-bottom: 1px solid #E2E8F0; display: flex; justify-content: space-between; align-items: center; }
      .aa-section-title { font-size: 15px; font-weight: 600; }
      .aa-section-desc { font-size: 12px; color: #64748B; margin-top: 2px; }
      .aa-section-body { padding: 16px 20px; }
      .aa-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
      .aa-kpi-card { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px 18px; }
      .aa-kpi-label { font-size: 12px; color: #64748B; margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
      .aa-kpi-value { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; font-family: 'JetBrains Mono', monospace; }
      .aa-kpi-sub { font-size: 11px; color: #94A3B8; margin-top: 4px; }
      .aa-period-bar { display: flex; gap: 4px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 3px; width: fit-content; }
      .aa-period-btn { padding: 6px 12px; border: none; background: transparent; color: #64748B; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 500; }
      .aa-period-btn.active { background: #FFFFFF; color: #1F2937; box-shadow: 0 0 0 1px #E2E8F0; }
      .aa-table-wrap { position: relative; overflow: auto; max-height: 480px; border-top: 1px solid #E2E8F0; }
      .aa-table-wrap.shorter { max-height: 380px; }
      .aa-table-wrap.aa-camp-wrap.expanded { max-height: none; overflow: visible; }
      .aa-camp-wrap > table > thead th { z-index: 6; }
      .aa-camp-wrap > table > thead th.sticky-left { z-index: 7; }
      .aa-table-wrap table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
      .aa-table-wrap thead th { position: sticky; top: 0; z-index: 3; background: #F8FAFC; }
      .aa-table-wrap th.sticky-left, .aa-table-wrap td.sticky-left { position: sticky; left: 0; background: #FFFFFF; z-index: 1; border-right: 1px solid #E2E8F0; }
      .aa-table-wrap thead th.sticky-left { z-index: 4; background: #F8FAFC; }
      .aa-table-wrap tr.selected td.sticky-left, .aa-table-wrap tr:hover td.sticky-left { background: #FFF7ED; }
      .aa-table-wrap th.sticky-left-2, .aa-table-wrap td.sticky-left-2 { position: sticky; left: 36px; background: #FFFFFF; z-index: 1; border-right: 1px solid #E2E8F0; }
      .aa-table-wrap thead th.sticky-left-2 { z-index: 4; background: #F8FAFC; }
      .aa-table-wrap tr:hover td.sticky-left-2 { background: #FFF7ED; }
      .aa-table-wrap th { text-align: left; padding: 10px 14px; color: #64748B; font-weight: 500; font-size: 11.5px; border-bottom: 1px solid #E2E8F0; white-space: nowrap; user-select: none; }
      .aa-table-wrap th.sortable { cursor: pointer; }
      .aa-table-wrap th.sortable::after { content: ' ⇅'; font-size: 9px; opacity: 0.4; }
      .aa-table-wrap th.sorted-asc::after { content: ' ↑'; opacity: 1; color: #FF6B35; }
      .aa-table-wrap th.sorted-desc::after { content: ' ↓'; opacity: 1; color: #FF6B35; }
      .aa-table-wrap td { padding: 12px 14px; border-bottom: 1px solid #E2E8F0; white-space: nowrap; }
      .aa-table-wrap tr:last-child td { border-bottom: none; }
      .aa-table-wrap tr.clickable { cursor: pointer; }
      .aa-table-wrap tr.clickable:hover td { background: #FFF7ED; }
      .aa-table-wrap tr.selected td { background: #FFF7ED; }
      .aa-table-wrap td.num, .aa-table-wrap th.num { text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }
      .text-good { color: #10B981; font-weight: 600; }
      .text-bad { color: #EF4444; font-weight: 600; }
      .text-warn { color: #F59E0B; font-weight: 600; }
      .text-muted { color: #94A3B8; }
      .aa-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
      .aa-badge.badge-ai { background: #EFF6FF; color: #3B82F6; }
      .aa-badge.badge-manual { background: #FDF4FF; color: #A855F7; }
      .aa-badge.badge-unsorted { background: #F3F4F6; color: #94A3B8; }
      .aa-badge.badge-good { background: #D1FAE5; color: #065F46; }
      .aa-badge.badge-warn { background: #FEF3C7; color: #92400E; }
      .aa-badge.badge-bad { background: #FEE2E2; color: #991B1B; }
      .aa-badge.badge-info { background: #DBEAFE; color: #1E40AF; }
      .aa-search-bar { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-family: 'JetBrains Mono', monospace; }
      .aa-search-bar-bg { width: 70px; height: 6px; background: #DBEAFE; border-radius: 3px; position: relative; overflow: hidden; }
      .aa-search-bar-fill { height: 100%; background: #3B82F6; border-radius: 3px; }
      .aa-action-chip { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; white-space: nowrap; }
      .aa-action-chip.action-exclude { background: #FEE2E2; color: #991B1B; }
      .aa-action-chip.action-growing { background: #D1FAE5; color: #065F46; }
      .aa-action-chip.action-enhance { background: #D1FAE5; color: #065F46; }
      .aa-action-chip.action-maintain { background: #F1F5F9; color: #475569; }
      .aa-action-chip.action-lower-bid { background: #FFEDD5; color: #9A3412; }
      .aa-action-chip.action-low-sample { background: #F3F4F6; color: #6B7280; }
      .aa-btn { padding: 8px 14px; border: 1px solid #E2E8F0; background: #FFFFFF; color: #1F2937; border-radius: 6px; font-size: 13px; cursor: pointer; font-family: inherit; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
      .aa-btn:hover { background: #F8FAFC; }
      .aa-btn.btn-sm { padding: 5px 10px; font-size: 12px; }
      .aa-btn.btn-bad { background: #EF4444; border-color: #EF4444; color: white; }
      .aa-btn.btn-info { background: #3B82F6; border-color: #3B82F6; color: white; }
      .aa-sub-section { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 14px 16px; margin-bottom: 12px; }
      .aa-sub-section-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
      .aa-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
      .aa-metric-box { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 6px; padding: 12px 14px; }
      .aa-metric-box.search { border-left: 3px solid #3B82F6; }
      .aa-metric-box.nonsearch { border-left: 3px solid #A855F7; }
      .aa-metric-box-label { font-size: 11px; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
      .aa-metric-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12.5px; }
      .bid-recommend { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 13.5px; color: #FF6B35; }
      .bid-vat-incl { display: block; font-size: 9.5px; color: #94A3B8; font-family: 'JetBrains Mono', monospace; margin-top: 1px; font-weight: 400; }
      .aa-bulk-action { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 6px; margin-top: 12px; font-size: 12.5px; }
      .aa-hint-banner { background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #1E40AF; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
      .aa-stars { font-size: 12px; letter-spacing: 1px; }
      .aa-stars.high { color: #F59E0B; }
      .aa-stars.mid { color: #FCD34D; }
      .aa-stars.low { color: #94A3B8; }
      .aa-kpi-value.text-bad { color: #EF4444; }
      .aa-expand-toggle { display: inline-block; width: 18px; color: #94A3B8; font-size: 12px; cursor: pointer; user-select: none; margin-right: 4px; }
      .aa-expand-toggle:hover { color: #FF6B35; }
      .aa-table-wrap tr.aa-option-row td { background: #F8FAFC; font-size: 12.5px; padding: 8px 14px; }
      .aa-table-wrap tr.aa-option-row.clickable:hover td { background: #FEF3C7; }
      .aa-table-wrap tr.aa-option-row.option-selected td { background: #DBEAFE; }
      .aa-table-wrap tr.aa-option-row.option-selected td.sticky-left { background: #DBEAFE; border-left: 3px solid #3B82F6; }
      .aa-option-cell { padding-left: 36px !important; }
      .aa-option-prefix { color: #CBD5E1; margin-right: 6px; font-size: 11px; }
      .aa-option-text { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .aa-option-alias { color: #1E40AF; font-weight: 600; font-size: 12.5px; }
      .aa-option-name { color: #475569; font-size: 12px; }
      .aa-table-wrap tr.aa-keyword-option-row td.aa-keyword-option-cell { background: #F8FAFC; padding: 8px 14px 8px 56px; border-bottom: 1px solid #E2E8F0; }
      .aa-keyword-option-flex { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; font-size: 12px; }
      .aa-kw-opt-metric { color: #475569; }
      .aa-kw-opt-metric strong { color: #1F2937; }
    `}</style>
  )
}
