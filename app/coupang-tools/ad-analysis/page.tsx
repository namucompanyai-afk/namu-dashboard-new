'use client'

/**
 * 광고 분석 페이지 (/coupang-tools/ad-analysis)
 *
 * 주 1회 광고센터에서 바꿀 것을 보는 화면. 탭 두 개:
 *   - 주간 (라이브, 기본): 광고 엑셀 직접 업로드 — 10일 이하 = 주간 기록 저장, 25일 이상 = 30일 분석(할 일·표)
 *   - 월 저장본: 쿠팡 손익 화면이 저장한 월 광고 파일 (store 의 rawAdCampaign)
 * BEP 는 marginMaster(나무_마스터). 자동 입찰 적용은 영구 안 함 — 키워드 복사해서 쿠팡 광고센터에 직접 입력.
 * 권한은 서버 역할(/api/me)로만: 관리자 = 전부, 게스트 = 라이브 업로드 분석만 (회사 기록 조회·저장 없음).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getDefaultConstants } from '@/lib/coupang/costBook'
import { build1PView, isRetailRow, augmentMasterWith1P, type OnePView } from '@/lib/coupang/onePAnalysis'
import { packAdRows, unpackAdRows } from '@/lib/coupang/adRowsPack'
import { extractPeriodFromFileName } from '@/lib/coupang/parsers/adCampaign'
import { useMarginStore } from '@/lib/coupang/store'
import { useServerRole } from '@/lib/useCLevel'
import { parseAdCampaign } from '@/lib/coupang/parsers/adCampaign'
import { buildAdAnalysisView, buildBepMap, buildActualPriceMapById, buildMarginRowMap, buildExposureMapByOptionId, type CampaignDiag } from '@/lib/coupang/adAnalysis'
import type { AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import { actionItems, buildWeeklyActions, campaignStatusOf, type CampaignActions } from '@/lib/coupang/weeklyActions'
import { attributionLag, ProfitLine, StatusBoxes, WarningLine, MarginMissingBar, ReplaceConfirmBox, WeekCompareBox, WeeklyActionsSection, reflectMemoText, type ProductMonthNote, snapshotFromView, type ReflectNote, type ReflectState, type WeeklySnapshot } from './WeeklyPanel'
import { findMarginMissing } from '@/lib/coupang/marginMissing'
import { buildWeeks13, type BackfillRow, type SalesRow, type WeeklyComment } from '@/lib/coupang/adWeekly13'
import type { SnapshotDiff } from '@/lib/coupang/weeklySnapshots'
import { WeeklyOverview } from './WeeklyOverview'
import { HistoryNotesSection, type MemoPrefill } from './HistoryNotes'
import { AiSection, CampaignSection, ManualSection, OptionInlineRow, Style, computeOptions, fmtMan, fmtNum } from './CampaignDetail'
import { CampaignSummary, CampaignTable, LastWeekChips, MobileNote, TodoBlock, WEEKLY_BLOCKS_CSS, type TodoRow } from './WeeklyBlocks'
import { buildTodoPlans, followupLastWeek, judgeCampaigns, judgeInputFromSnapshot, prevWeekOf, snapFind, summarizeActions, type JudgeInput, type TodoPlan } from '@/lib/coupang/weeklyJudge'

type Mode = 'saved' | 'live'

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
  const [mode, setMode] = useState<Mode>('live')
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

  // 권한 — 서버 역할(/api/me)로만 판단 (localStorage 역할은 브라우저에서 바꿀 수 있어 쓰지 않음).
  // 확인 전(null)에는 회사 기록을 불러오지 않는다. 관리자가 아니면(이 페이지는 관리자·게스트만) 게스트 화면:
  // 주간(라이브) 탭 업로드 분석만 — 월 저장본·지난주 대비·운영 메모·주간 기록 저장·목표 ROAS 저장·쿠팡 반영 완료 없음
  const role = useServerRole()
  const isAdmin = role === 'admin'
  const isGuest = role !== null && role !== 'admin'

  // 목표 ROAS — 사용자 입력값 (prefix::타입 → %). 분석 갱신과 무관하게 유지.
  const [targets, setTargets] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!isAdmin) return // 목표 ROAS 는 회사 저장데이터 — 관리자만
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
  }, [isAdmin])
  const setTargetForKey = (key: string, value: number | null) => {
    if (!isAdmin) return
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
    if (role === null) return // 역할 확인 전
    // 게스트는 저장 분석(마진마스터·월 저장본) 자동 로드 안 함 — 라이브 업로드만 사용
    if (role !== 'admin') {
      setAutoLoading(false)
      return
    }
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
  }, [role]) // eslint-disable-line react-hooks/exhaustive-deps

  // 30일 파일 서버 저장본 (/api/coupang-ad-live, 기능 스위치 AD_LIVE_30D_SAVE) — 관리자만.
  // 스위치가 꺼져 있으면 enabled:false → 지금처럼 화면 메모리만 (새로고침하면 사라짐)
  const [liveSaveOn, setLiveSaveOn] = useState(false)
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch('/api/coupang-ad-live', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || j?.enabled !== true) return
        setLiveSaveOn(true)
        const it = j.item
        // 이미 이 화면에서 올린 30일 파일이 있으면 덮지 않음
        if (!it || useMarginStore.getState().adAnalysisLive) return
        const rows = unpackAdRows(it.rows)
        if (!rows.length) return
        setAdAnalysisLive(
          rows,
          { fileName: it.fileName, uploadedAt: it.savedAt, rowCount: rows.length, downloadedAt: it.downloadedAt },
          it.period ?? null,
        )
      })
      .catch(() => { /* 없으면 업로드 화면 */ })
    return () => { cancelled = true }
  }, [isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  // 모드별 source 분기
  const sourceRows = mode === 'live' ? (adAnalysisLive?.rows ?? null) : rawAdCampaign
  const sourcePeriod = mode === 'live' ? (adAnalysisLive?.period ?? null) : adPeriod
  const reflectPeriod = sourcePeriod ? `${sourcePeriod.startDate}~${sourcePeriod.endDate}` : null
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
  // 마진계산에 없는 상품 — 윙 노출ID 맵·처음 잡힌 날은 서버에서 (관리자만, 처음 잡힌 날 기록은 기능 스위치 MARGIN_MISSING_SAVE)
  const [mmInfo, setMmInfo] = useState<{ enabled: boolean; firstSeen: Record<string, string>; pidByOption: Record<string, string> }>({ enabled: false, firstSeen: {}, pidByOption: {} })
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch('/api/coupang-margin-missing', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.ok) setMmInfo({ enabled: !!j.enabled, firstSeen: j.firstSeen || {}, pidByOption: j.pidByOption || {} }) })
      .catch(() => { /* 없으면 노출ID·처음 잡힌 날 없이 표시 */ })
    return () => { cancelled = true }
  }, [isAdmin])
  const marginMissing = useMemo(
    () => findMarginMissing(sourceRows, marginMaster as any, new Map(Object.entries(mmInfo.pidByOption))),
    [sourceRows, marginMaster, mmInfo.pidByOption],
  )
  const mmKey = marginMissing.map((x) => x.optionId).join(',')
  useEffect(() => {
    if (!isAdmin || !mmInfo.enabled || !mmKey) return
    const fresh = mmKey.split(',').filter((id) => !mmInfo.firstSeen[id])
    if (!fresh.length) return
    fetch('/api/coupang-margin-missing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionIds: fresh }) })
      .then((r) => r.json())
      .then((j) => { if (j?.ok && j.firstSeen) setMmInfo((p) => ({ ...p, firstSeen: j.firstSeen })) })
      .catch(() => { /* 기록 실패는 표시만 '—' */ })
  }, [isAdmin, mmInfo.enabled, mmInfo.firstSeen, mmKey])
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
  // 손익 줄·지난주 대비·상태 3칸은 채널 필터와 무관하게 전체(상품 필터만 적용) 기준 — 채널 필터는 할 일·캠페인 진단 표에만
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
  // 할 일은 전체 기준으로 판정(AI·수동 짝 겹침 포함)한 뒤 채널 필터만 적용
  const weeklyActionsShown = useMemo(
    () => (chFilter === 'all' ? weeklyActions : weeklyActions.filter((a) => a.campaign.channel === chFilter)),
    [weeklyActions, chFilter],
  )
  // 쿠팡 반영 완료 — 운영 메모 자동 기록 + (BEP ROAS 바뀐 AI 캠페인이면) 적용값 저장
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
        period: reflectPeriod ?? undefined,
        items: actionItems(a).map((x) => x.key),
      }),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j?.item) throw new Error(j?.error || `HTTP ${res.status}`)
    // 저장 직후 GET 은 옛 값이 읽힐 수 있어 응답 메모를 바로 붙인다 (조정 결과 표용)
    setNotes((prev) => [...prev, j.item as ReflectNote])
    if (a.bepChange && a.targetKey) setTargetForKey(a.targetKey, a.bepChange.next)
    setNotesReload((n) => n + 1)
  }
  // 주간 기록(지난주 대비) · 운영 메모(지난주 조정 결과) — 30일 판정과 별개
  const [weekly, setWeekly] = useState<WeeklySnapshot[]>([])
  // 이 화면에서 올린 주간 파일의 분석(클릭 포함) — 하단 캠페인 표·모수 판정용 (새로고침하면 사라져 주간 기록으로 대신)
  const [sessionWeeklyView, setSessionWeeklyView] = useState<{ view: ReturnType<typeof buildAdAnalysisView>; period: { startDate: string; endDate: string }; fileName: string } | null>(null)
  // 이 화면에서 올린 주간 파일 (기간 끝이 가장 늦은 것) — 상태 바·종료일 차이 경고·14일 미반영(주간 기준)용
  const [sessionWeekly, setSessionWeekly] = useState<{ startDate: string; endDate: string; days: number; fileName: string; saved: boolean; downloadedAt?: string } | null>(null)
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch('/api/coupang-ad-weekly', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && Array.isArray(j?.items)) setWeekly(j.items as WeeklySnapshot[]) })
      .catch(() => { /* 없으면 빈 기록 */ })
    return () => { cancelled = true }
  }, [isAdmin])
  // 상단 2블록 (브레인 코멘트·이번 주 성과) — 주간 기록 + 백필 + 전체 매출 + 그 주 코멘트 (관리자만)
  const overviewWeek = useMemo(() => [...weekly].sort((a, b) => a.startDate.localeCompare(b.startDate)).pop()?.startDate ?? null, [weekly])
  const [overview, setOverview] = useState<{ backfill: BackfillRow[]; sales: SalesRow[]; comment: WeeklyComment | null }>({ backfill: [], sales: [], comment: null })
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch(`/api/coupang-ad-overview${overviewWeek ? `?week=${overviewWeek}` : ''}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.ok) setOverview({ backfill: j.backfill || [], sales: j.sales || [], comment: j.comment ?? null }) })
      .catch(() => { /* 없으면 주간 기록만으로 표시 */ })
    return () => { cancelled = true }
  }, [isAdmin, overviewWeek])
  const weeks13 = useMemo(() => buildWeeks13(weekly, overview.backfill, overview.sales), [weekly, overview.backfill, overview.sales])
  const [notes, setNotes] = useState<ReflectNote[]>([])
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch('/api/coupang-ad-history', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && Array.isArray(j?.items)) setNotes(j.items as ReflectNote[]) })
      .catch(() => { /* 없으면 빈 메모 */ })
    return () => { cancelled = true }
  }, [notesReload, isAdmin])
  // 쿠팡 반영 완료 기록(서버 메모) → 캠페인별 '반영됨'·반영 뒤 새로 생긴 할 일 — 같은 30일 기간 기록만.
  // 기간·항목 없이 저장된 옛 기록은 파일 종료일 다음 날~7일 안에 남긴 것만 같은 기간으로 보고 '반영됨'만 (새 할 일 비교 불가)
  const reflectState = useMemo(() => {
    const m = new Map<string, ReflectState>()
    if (!reflectPeriod || !sourcePeriod) return m
    const end = sourcePeriod.endDate
    const legacyUntil = new Date(new Date(`${end}T00:00:00Z`).getTime() + 7 * 86400000).toISOString().slice(0, 10)
    const kstDay = (ts: string) => new Date(new Date(ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    for (const a of weeklyActions) {
      const key = a.targetKey ?? a.campaign.campaignName
      const hit = notes
        .filter((n) => n.kind === 'reflect' && n.campaignKey === key)
        .filter((n) => (n.period ? n.period === reflectPeriod : kstDay(n.ts) > end && kstDay(n.ts) <= legacyUntil))
        .sort((x, y) => y.ts.localeCompare(x.ts))[0]
      if (!hit) continue
      const prev = Array.isArray(hit.items) ? new Set(hit.items) : null
      m.set(a.campaign.campaignId, { newItems: prev ? actionItems(a).filter((x) => !prev.has(x.key)) : [], legacy: !prev })
    }
    return m
  }, [weeklyActions, notes, reflectPeriod, sourcePeriod])

  // ── 하단 3블록 (지난주 성과 칩 · 이번 주 할 일 · 전체 캠페인 표) — 규칙은 lib/coupang/weeklyJudge.ts (스킬 weekly.ts 와 같은 코드) ──
  // 이번 주 = 주간 기록 중 시작일이 가장 늦은 주 · 지난주 = 그 7일 전 기록
  const curWeekSnap = useMemo(() => [...weekly].sort((a, b) => a.startDate.localeCompare(b.startDate)).pop() ?? null, [weekly])
  const prevWeekSnap = useMemo(() => prevWeekOf(weekly, curWeekSnap), [weekly, curWeekSnap])
  // 판정 입력: 이 화면에서 올린 주간 파일(클릭 있음) → 없으면 주간 기록(클릭은 2026-10-19 밤 이후 기록에만 있음 — 없으면 모수 부족 판정 못 함)
  const sessionMatches = !!sessionWeeklyView && !!curWeekSnap && sessionWeeklyView.period.startDate === curWeekSnap.startDate
  const clicksKnown = sessionMatches || !!curWeekSnap?.campaigns.some((c) => typeof c.clicks === 'number')
  const weekInputs = useMemo<JudgeInput[]>(() => {
    if (sessionMatches && sessionWeeklyView) {
      return sessionWeeklyView.view.campaigns.map((c) => ({
        campaignId: c.campaignId, campaignName: c.campaignName, type: c.type, channel: c.channel, clicks: c.clicks,
        adCostVat: c.adCostVat, revenue: c.revenue, roasPct: c.roasPct, bepPct: c.bepPct, adProfit: c.adProfit,
      }))
    }
    return curWeekSnap ? judgeInputFromSnapshot(curWeekSnap) : []
  }, [sessionMatches, sessionWeeklyView, curWeekSnap])
  const judged = useMemo(
    () => (curWeekSnap ? judgeCampaigns(weekInputs, { curWeek: curWeekSnap, prevWeek: prevWeekSnap, notes, targets, periodEnd: curWeekSnap.endDate }) : []),
    [weekInputs, curWeekSnap, prevWeekSnap, notes, targets],
  )
  const followup = useMemo(() => followupLastWeek(prevWeekSnap, curWeekSnap, notes), [prevWeekSnap, curWeekSnap, notes])
  // 이 화면에서 '쿠팡 반영 완료' 누른 캠페인 (반영 직후 할 일에서 사라지지 않고 '반영됨'으로 남김)
  const [sessionReflected, setSessionReflected] = useState<Map<string, string>>(new Map())
  // 주간·30일 파일 종료일이 3일 이상 차이 나면 키워드 계획·행 클릭 상세를 숨김 (스킬 period_mismatch 와 같은 기준, 2026-10-19 보수 ③)
  const weeklyEndForGap = sessionWeekly?.endDate ?? curWeekSnap?.endDate ?? null
  const gap30 = weeklyEndForGap && adAnalysisLive?.period ? Math.abs(dayDiff(weeklyEndForGap, adAnalysisLive.period.endDate)) : null
  const gapBlock = gap30 != null && gap30 >= END_GAP_MAX
  const has30 = mode === 'live' && !!adAnalysisLive && viewAll.loaded && !hideBep && !gapBlock
  const gapNote = mode === 'live' && adAnalysisLive?.period && gapBlock && weeklyEndForGap
    ? `30일 파일 다시 받아 올리세요 (종료일 주간 ${fmtMd(weeklyEndForGap)} vs 30일 ${fmtMd(adAnalysisLive.period.endDate)}, ${gap30}일 차이) — 그동안 키워드 조치 숨김`
    : null
  const todoJudged = useMemo(
    () => judged.filter((j) => j.decision === 'todo' || j.decision === 'nosale' || j.decision === 'nomargin' || sessionReflected.has(j.campaignId)).sort((a, b) => a.adProfit - b.adProfit),
    [judged, sessionReflected],
  )
  // 키워드·입찰 계획 — 30일 파일이 이 화면에 있을 때만 (대시보드 할 일 함수 buildWeeklyActions 결과를 스킬과 같은 규칙으로 가공)
  const todoPlans = useMemo(() => {
    if (!has30) return null
    const m = new Map<string, TodoPlan>()
    if (!todoJudged.length) return m
    const plans = buildTodoPlans(todoJudged.map((j) => ({ campaign: j.campaignName, isAi: j.isAi })), {
      actions: summarizeActions(weeklyActions),
      kwView: viewAll,
      kwRows: rowsAllCh ?? [],
      bepMap: marginOff ? manualBepMap : buildBepMap(masterAug as any),
      priceMap: buildActualPriceMapById(masterAug as any),
      exposureMap: buildExposureMapByOptionId(masterAug as any),
      notes,
    })
    for (const p of plans) m.set(p.campaign, p)
    return m
  }, [has30, todoJudged, weeklyActions, viewAll, rowsAllCh, marginOff, manualBepMap, masterAug, notes])
  const todoRows: TodoRow[] = useMemo(
    () => todoJudged.map((j) => ({ j, plan: todoPlans?.get(j.campaignName) ?? null, done: sessionReflected.get(j.campaignId) ?? null })),
    [todoJudged, todoPlans, sessionReflected],
  )
  // 쿠팡 반영 완료 — 운영 메모 reflect 기록 (기존 API) + 목표를 BEP 로 올리는 할 일이면 적용값 저장
  const reflectTodo = async (row: TodoRow) => {
    const { j, plan } = row
    const act = weeklyActions.find((a) => a.campaign.campaignId === j.campaignId) ?? null
    const raise = j.isAi && !!j.targetAction && j.targetAction.startsWith('목표 →') && j.bep != null
    const nBid = plan ? plan.bidLines.length + plan.extraBidLines.length : 0
    const parts = [
      raise ? `BEP ROAS ${j.applied ?? '미입력'}→${j.bep}%` : '',
      plan?.movePairs.length ? `수동 이동 ${plan.movePairs.length}개` : '',
      nBid ? `입찰가 ${nBid}개` : '',
    ].filter(Boolean)
    const res = await fetch('/api/coupang-ad-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${j.campaignName} · ${parts.join(', ') || '2주 연속 BEP 미달 조치'}`,
        kind: 'reflect',
        campaignKey: j.key ?? j.campaignName,
        campaignName: j.campaignName,
        period: has30 && reflectPeriod ? reflectPeriod : curWeekSnap ? `${curWeekSnap.startDate}~${curWeekSnap.endDate}` : undefined,
        items: act ? actionItems(act).map((x) => x.key) : raise ? ['bep'] : [],
      }),
    })
    const jj = await res.json().catch(() => null)
    if (!res.ok || !jj?.item) throw new Error(jj?.error || `HTTP ${res.status}`)
    setNotes((prev) => [...prev, jj.item as ReflectNote])
    // 같은 prefix AI 캠페인이 둘이면 'key#campaignId' 로 따로 저장 (weeklyJudge.targetOf 가 먼저 읽음)
    if (raise && j.key) setTargetForKey(judged.some((x) => x.campaignId !== j.campaignId && x.key === j.key) ? `${j.key}#${j.campaignId}` : j.key, j.bep!)
    const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString()
    setSessionReflected((m) => new Map(m).set(j.campaignId, `${now.slice(5, 7)}/${now.slice(8, 10)} ${now.slice(11, 16)}`))
    setNotesReload((n) => n + 1)
  }
  /** 주간 파일 → 캠페인별 요약(기존 광고 분석 계산 그대로) → 주간 기록 저장 */
  // 같은 기간 저장본과 많이 다른 주간 파일 — 서버가 저장 보류(needConfirm) → 확인 칸 [교체]/[취소] (2026-10-19 업로드 실수 방지)
  const [pendingReplace, setPendingReplace] = useState<{ snapshot: WeeklySnapshot; view: ReturnType<typeof buildAdAnalysisView>; period: { startDate: string; endDate: string }; fileName: string; diff: SnapshotDiff } | null>(null)
  async function postWeeklySnapshot(snapshot: WeeklySnapshot, force: boolean): Promise<{ items: WeeklySnapshot[] } | { needConfirm: SnapshotDiff }> {
    const res = await fetch('/api/coupang-ad-weekly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot, force }),
    })
    const j = await res.json().catch(() => null)
    if (res.ok && j?.needConfirm && j.diff) return { needConfirm: j.diff as SnapshotDiff }
    if (!res.ok || !j?.ok) throw new Error(`주간 기록 저장 실패: ${j?.error || res.status}`)
    // 저장 직후 GET 은 옛 값이 읽힐 수 있어 POST 응답의 전체 목록을 그대로 쓴다
    const items = Array.isArray(j.items) ? (j.items as WeeklySnapshot[]) : []
    if (items.length) setWeekly(items)
    return { items }
  }
  /** 주간 파일 → 캠페인별 요약(기존 광고 분석 계산 그대로) → 주간 기록 저장. 저장본과 많이 다르면 보류(pending) */
  async function saveWeeklySnapshot(rows: AdCampaignRow[], period: { startDate: string; endDate: string }, fileName: string): Promise<{ overlaps: WeeklySnapshot[]; pending: SnapshotDiff | null }> {
    const aug = augmentMasterWith1P(marginMaster as Parameters<typeof augmentMasterWith1P>[0], rows)
    const v = buildAdAnalysisView(rows, aug as Parameters<typeof buildAdAnalysisView>[1], marginOff ? manualBepMap : undefined)
    const snapshot = snapshotFromView(v, period, fileName)
    const r = await postWeeklySnapshot(snapshot, false)
    if ('needConfirm' in r) {
      setPendingReplace({ snapshot, view: v, period, fileName, diff: r.needConfirm })
      return { overlaps: [], pending: r.needConfirm }
    }
    setPendingReplace(null)
    setSessionWeeklyView({ view: v, period, fileName }) // 저장된 파일만 화면 판정에 씀
    // 기간이 겹치는 다른 주간 기록 (같은 기간 덮어쓰기는 제외)
    return {
      overlaps: r.items.filter((x) => !(x.startDate === period.startDate && x.endDate === period.endDate) && x.startDate <= period.endDate && period.startDate <= x.endDate),
      pending: null,
    }
  }
  /** 확인 칸 [교체] — force 로 다시 저장 (직전 기록은 prev 에 1개 보관됨) */
  async function confirmReplace() {
    if (!pendingReplace) return
    const p = pendingReplace
    try {
      await postWeeklySnapshot(p.snapshot, true)
      setPendingReplace(null)
      setSessionWeeklyView({ view: p.view, period: p.period, fileName: p.fileName })
      setSessionWeekly((w) => (w && w.startDate === p.period.startDate ? { ...w, saved: true } : w))
      setUploadNote(`주간 기록 교체 ${fmtMd(p.period.startDate)}~${fmtMd(p.period.endDate)} (직전 기록 1개 보관)`)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e))
    }
  }

  // 상품 월 손익 — 쿠팡 손익이 저장한 가장 최근 달 상품별 판정 요약(pnl_verdict_YYYY-MM, 관리자만)
  const [productMonth, setProductMonth] = useState<{ month: string; byAlias: Map<string, { profit: number; adShare: number | null; revenue?: number }> } | null>(null)
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    ;(async () => {
      try {
        const mj = await (await fetch('/api/coupang-master?type=pnl_months')).json()
        const months = Object.entries((mj?.months || {}) as Record<string, string[]>)
          .filter(([, kinds]) => kinds.includes('verdict'))
          .map(([m]) => m)
          .sort((x, y) => y.localeCompare(x))
        // 월 전체 자료로 확정된 달(confirmed === true) 중 가장 최근 달만 — 없으면 표시 안 함
        for (const m of months) {
          const vj = await (await fetch(`/api/coupang-master?type=pnl_verdict_${m}`)).json()
          if (vj?.data?.confirmed !== true) continue
          const rows = (vj?.data?.rows || []) as { alias: string; profit: number; adShare: number | null; revenue?: number }[]
          if (!cancelled && rows.length) {
            setProductMonth({ month: m, byAlias: new Map(rows.map((r) => [r.alias, { profit: r.profit, adShare: r.adShare, revenue: r.revenue }])) })
          }
          return
        }
      } catch { /* 없으면 표시 안 함 */ }
    })()
    return () => { cancelled = true }
  }, [isAdmin])
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
    return v && productMonth && alias ? { month: productMonth.month, alias, profit: v.profit, adShare: v.adShare, revenue: v.revenue } : null
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

  // 라이브 광고 엑셀 업로드 — 여러 파일, store 의 rawAdCampaign 안 건드림. 파일명 기간으로 구분:
  // 10일 이하 = 주간 기록 저장(관리자만) · 25일 이상 = 30일 분석 화면(+ 스위치 켜졌으면 서버 저장) · 11~24일 = 건너뜀
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  async function handleLiveFiles(files: File[]) {
    setUploadError(null)
    setUploadNote(null)
    const notes: string[] = []
    const warns: string[] = []
    let monthly: { rows: AdCampaignRow[]; meta: { fileName: string; uploadedAt: string; rowCount: number; downloadedAt: string }; period: { startDate: string; endDate: string; days: number } | null; end: string } | null = null
    let weeklyFile: { startDate: string; endDate: string; days: number; fileName: string; saved: boolean; downloadedAt?: string } | null = null
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
          // 주간 기록은 월~일 7일 파일만 (자동 업로드 스크립트와 같은 검사) — 아니면 13주 꺾은선·지난주 비교가 깨져 저장 안 함 (2026-10-19 보수 ④)
          const monday = new Date(`${period.startDate}T00:00:00Z`).getUTCDay() === 1
          if (period.days !== 7 || !monday) {
            warns.push(`${label}: 주간 기록은 월~일 7일 파일만 저장 — ${period.days !== 7 ? `${period.days}일 파일` : '시작일이 월요일 아님'}이라 저장 안 함 (6일 파일은 백필 전용)`)
            continue
          }
          // 주간 기록은 회사 기록 — 관리자만 저장 (게스트는 마진마스터가 없어 손익이 틀리게 남음)
          if (isAdmin) {
            const { overlaps, pending } = await saveWeeklySnapshot(r.rows, period, file.name)
            if (pending) notes.push(`주간 기록 저장 보류 ${label} — 아래 확인 칸`)
            else notes.push(`주간 기록 저장 ${label}`)
            if (overlaps.length) {
              warns.push(`${label}: 다른 주간 기록과 기간이 겹침 — ${overlaps.map((x) => `${fmtMd(x.startDate)}~${fmtMd(x.endDate)}`).join(', ')}`)
            }
            if (pending) {
              const downloadedAt = new Date(file.lastModified + 9 * 3600 * 1000).toISOString().slice(0, 10)
              if (!weeklyFile || period.endDate > weeklyFile.endDate) weeklyFile = { ...period, fileName: file.name, saved: false, downloadedAt }
              continue
            }
          } else {
            warns.push(`${label}: 주간 파일은 이 계정에서 쓰지 않음 — 30일 파일(25일 이상)을 올리세요`)
          }
          const downloadedAt = new Date(file.lastModified + 9 * 3600 * 1000).toISOString().slice(0, 10)
          if (!weeklyFile || period.endDate > weeklyFile.endDate) weeklyFile = { ...period, fileName: file.name, saved: isAdmin, downloadedAt }
        } else if (period && period.days >= MONTHLY_MIN_DAYS) {
          // 30일 파일이 여러 개면 기간 끝이 가장 늦은 것. 받은 날 = 파일 수정 시각(KST 날짜) — 14일 전환 미반영 경고용
          if (!monthly || period.endDate > monthly.end) {
            const downloadedAt = new Date(file.lastModified + 9 * 3600 * 1000).toISOString().slice(0, 10)
            monthly = { rows: r.rows, meta: { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length, downloadedAt }, period, end: period.endDate }
          }
          notes.push(`30일 분석 ${label}`)
        } else {
          warns.push(`${label}: 기간이 ${period ? `${period.days}일` : '불명'} — 주간(10일 이하)도 30일(25일 이상)도 아니라 건너뜀`)
        }
      } catch (err) {
        warns.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (weeklyFile) setSessionWeekly(weeklyFile)
    if (monthly) {
      setAdAnalysisLive(monthly.rows, monthly.meta, monthly.period)
      if (isAdmin && liveSaveOn && monthly.period) {
        try {
          const res = await fetch('/api/coupang-ad-live', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: { fileName: monthly.meta.fileName, period: monthly.period, downloadedAt: monthly.meta.downloadedAt, rows: packAdRows(monthly.rows) } }),
          })
          const j = await res.json().catch(() => null)
          if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`)
          if (j.enabled === true) notes.push('30일 파일 서버 저장')
        } catch (err) {
          warns.push(`30일 파일 서버 저장 실패 — 이 화면에서만 보임 (${err instanceof Error ? err.message : String(err)})`)
        }
      }
    }
    if (notes.length) setUploadNote(notes.join(' · '))
    if (warns.length) setUploadError(warns.join(' / '))
  }

  // 업로드 상태 바 — 주간 파일 = 이 화면에서 올린 것, 없으면 마지막 주간 기록 (관리자만)
  const lastWeeklyRecord = weekly.length ? weekly[weekly.length - 1] : null
  const weeklySlot = sessionWeekly
    ?? (lastWeeklyRecord
      ? { startDate: lastWeeklyRecord.startDate, endDate: lastWeeklyRecord.endDate, days: daysOf(lastWeeklyRecord.startDate, lastWeeklyRecord.endDate), fileName: lastWeeklyRecord.fileName || '', saved: true }
      : null)
  const livePeriod = adAnalysisLive?.period ?? null
  // 두 파일 종료일 3일 이상 차이 → 같은 날 다시 받기 (주간 판정과 30일 키워드가 다른 기간이 됨)
  const endGap = weeklySlot && livePeriod ? Math.abs(dayDiff(weeklySlot.endDate, livePeriod.endDate)) : null
  const liveDownloadedAt = adAnalysisLive?.meta?.downloadedAt
  const liveLag = mode === 'live' && livePeriod && liveDownloadedAt ? attributionLag(livePeriod.endDate, livePeriod.days, liveDownloadedAt) : null
  // 전체 캠페인 표 위 14일 미반영 띠는 주간 파일 기준(7일) — 주간 파일이 이 화면에 없으면 30일 파일 기준(13일) (2026-10-19 보수 ⑥)
  const weeklyLag = mode === 'live' && sessionWeekly?.downloadedAt ? attributionLag(sessionWeekly.endDate, sessionWeekly.days, sessionWeekly.downloadedAt) : null

  // 셀렉터/공통 헤더 — 어떤 분기든 항상 노출
  const headerNode = (
    <>
      <Header
        mode={mode}
        onMode={setMode}
        role={role}
        adPeriodLabel={sourcePeriod ? `${sourcePeriod.startDate} ~ ${sourcePeriod.endDate} (${sourcePeriod.days}일)` : undefined}
      />
      {aliasFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px', padding: '8px 14px', borderRadius: 8, border: '1px solid #FDBA74', background: '#FFF7ED', fontSize: 13, color: '#9A3412' }}>
          <span>🔎 상품 필터: <b>{aliasFilter}</b> — 이 상품을 광고·전환한 캠페인 {aliasCampaignIds?.size ?? 0}개만 표시</span>
          <button onClick={clearAliasFilter} style={{ marginLeft: 'auto', border: '1px solid #FDBA74', borderRadius: 6, background: '#fff', padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}>필터 해제</button>
        </div>
      )}
      {mode === 'saved' && isAdmin && (
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

  // 캠페인 펼침 상세 — 키워드 분석(AI)·입찰가 점검(수동): 옛 캠페인 진단 표와 새 전체 캠페인 표가 같이 씀 (내용 동일, CampaignDetail.tsx)
  // sel/onSel 을 주면 그 행만의 옵션 선택(새 표는 여러 행 동시 펼침이라 행마다 따로), 없으면 옛 표의 공용 상태
  const detailFor = (c: CampaignDiag, sel?: string | null, onSel?: (id: string | null) => void, onClose?: () => void) => {
    const selected = sel === undefined ? selectedOptionId : sel
    const select = onSel ?? ((id: string | null) => openCampaignAndOption(c.campaignId, id))
    const clear = () => select(null)
    const close = onClose ?? (() => { setOpenCampId(null); setSelectedOptionId(null) })
    return c.type === 'manual'
      ? <ManualSection campaign={c} master={masterAug as any} marginOff={marginOff} hideBep={hideBep} manualBep={manualBepMap} periodLabel={periodLabel} selectedOptionId={selected} onClearOption={clear} onSelectOption={select} onClose={close} />
      : <AiSection campaign={c} master={masterAug as any} marginOff={marginOff} hideBep={hideBep} manualBep={manualBepMap} periodLabel={periodLabel} selectedOptionId={selected} onClearOption={clear} onSelectOption={select} onClose={close} targets={isAdmin ? targets : undefined} onTargetChange={isAdmin ? setTargetForKey : undefined} />
  }
  // 운영 메모 칸 — 관리자 라이브 모드에선 파일 유무와 상관없이 전체 캠페인 표 아래 항상 (2026-10-19 대표 "메모가 어딨어")
  const [memoPrefill, setMemoPrefill] = useState<MemoPrefill | null>(null)
  const memoCampaignNames = useMemo(() => judged.map((j) => j.campaignName).sort(), [judged])
  const notesNode = isAdmin ? (
    <HistoryNotesSection
      reloadKey={notesReload}
      campaignNames={memoCampaignNames}
      prefill={memoPrefill}
      onSaved={(item) => setNotes((prev) => [...prev, item as ReflectNote])} // 저장 즉시 판정·태그 갱신 (OFF 면 그 캠페인 태그 OFF)
    />
  ) : null
  // 새 전체 캠페인 표 — 여러 행 동시 펼침 (정렬·필터 바꿔도 유지), 행마다 옵션 선택 따로
  const [openCampIds, setOpenCampIds] = useState<Set<string>>(new Set())
  const toggleCampId = (id: string) => setOpenCampIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const [selOptByCamp, setSelOptByCamp] = useState<Map<string, string | null>>(new Map())
  const optionMaps = useMemo(() => ({
    bepMap: marginOff ? manualBepMap : buildBepMap(masterAug as any),
    priceMap: buildActualPriceMapById(masterAug as any),
    rowMap: buildMarginRowMap(masterAug as any),
    exposureMap: buildExposureMapByOptionId(masterAug as any),
  }), [marginOff, manualBepMap, masterAug])
  /** 행 펼침 내용 = 캠페인 요약(기록 2주·판정 이유·메모·반영 완료) + 30일 파일 있으면 옛 캠페인 진단 상세 그대로(옵션 행 + AI/수동 섹션) */
  const renderRowDetail = (campaignId: string) => {
    const j = judged.find((x) => x.campaignId === campaignId)
    if (!j) return null
    const c30 = has30 ? viewAll.campaigns.find((x) => x.campaignId === campaignId) ?? null : null
    const sel = selOptByCamp.get(campaignId) ?? null
    const setSel = (id: string | null) => setSelOptByCamp((m) => new Map(m).set(campaignId, m.get(campaignId) === id ? null : id))
    const opts = c30 && !marginOff ? computeOptions(c30.rows, optionMaps.bepMap, optionMaps.priceMap, optionMaps.rowMap, optionMaps.exposureMap) : []
    return (
      <>
        <CampaignSummary
          j={j}
          prevC={prevWeekSnap ? snapFind(prevWeekSnap, j.campaignName) : null}
          curC={curWeekSnap ? snapFind(curWeekSnap, j.campaignName) : null}
          notes={notes}
          has30={has30}
          reflected={sessionReflected.get(campaignId) ?? null}
          onReflect={isAdmin ? () => reflectTodo({ j, plan: todoPlans?.get(j.campaignName) ?? null, done: null }) : undefined}
          onAddMemo={isAdmin ? () => {
            setMemoPrefill({ campaignName: j.campaignName, nonce: Date.now() })
            setTimeout(() => document.getElementById('aa-history-notes')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
          } : undefined}
        />
        {c30 && (
          <>
            {/* 옛 캠페인 진단 표의 옵션 행 그대로 (옵션 클릭 → 아래 키워드 표를 그 옵션만) */}
            {!marginOff && (
              <div className="aa-table-wrap" style={{ maxHeight: 'none', borderTop: '1px solid #E2E8F0', marginTop: 10 }}>
                <table>
                  <thead><tr><th style={{ minWidth: 260 }}>옵션</th><th>타입</th><th className="num">광고비 (+VAT)</th><th className="num">광고 매출</th><th className="num">ROAS</th>{!hideBep && <th className="num">BEP ROAS</th>}{!hideBep && <th className="num">광고 손익</th>}<th className="num">광고 판매수</th><th className="num">타상품 매출</th></tr></thead>
                  <tbody>
                    {opts.map((o) => <OptionInlineRow key={o.optionId} o={o} isSelected={sel === o.optionId} onClick={() => setSel(o.optionId)} hideBep={hideBep} />)}
                    {opts.length === 0 && <tr className="aa-option-row"><td colSpan={hideBep ? 7 : 9} style={{ textAlign: 'center', color: '#94A3B8' }}>옵션 없음</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ marginTop: 10 }}>{detailFor(c30, sel, setSel, () => toggleCampId(campaignId))}</div>
          </>
        )}
      </>
    )
  }
  // 하단 3블록 — 관리자만 (회사 기록), 주간 기록이 하나라도 있을 때. 이번 주 성과 블록 바로 아래에 붙임
  const blocksNode = isAdmin && curWeekSnap ? (
    <div className="adw">
      <style>{WEEKLY_BLOCKS_CSS}</style>
      <LastWeekChips followup={followup} judged={judged} prev={prevWeekSnap} cur={curWeekSnap} clicksKnown={clicksKnown} />
      <MobileNote />
      <TodoBlock rows={todoRows} has30={has30} file30={has30 ? sourcePeriod : null} gapNote={gapNote} onReflect={reflectTodo} />
      <CampaignTable
        judged={judged}
        clicksKnown={clicksKnown}
        lag={weeklyLag ?? liveLag}
        weekLabel={`주간 ${fmtMd(curWeekSnap.startDate)}~${fmtMd(curWeekSnap.endDate)}${sessionMatches ? ' (주간 파일)' : ' (주간 기록)'}`}
        openIds={openCampIds}
        onToggle={toggleCampId}
        renderDetail={renderRowDetail}
        has30={has30}
      />
      {notesNode}
    </div>
  ) : null

  // ── 본문 (라이브·저장 공통) — 경고 · 손익 · 지난주 대비 · 상태 3칸 · 채널 필터 · 할 일 · 캠페인 진단 표 · 운영 메모 ──
  // adminNew = 관리자 라이브 모드: 옛 블록(손익 줄·지난주 대비·상태 3칸·할 일·캠페인 진단 표)은 위 3블록으로 대체돼 경고·운영 메모만
  const renderBody = (adminNew = false) => (
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
      {/* 1-1) 마진계산에 없는 상품 — 넣으면 다음 업로드에서 자동으로 사라짐 */}
      {isAdmin && !hideBep && (
        <MarginMissingBar
          list={marginMissing}
          periodLabel={sourcePeriod ? `${fmtMd(sourcePeriod.startDate)}~${fmtMd(sourcePeriod.endDate)} 광고 파일 기준` : '광고 파일 기준'}
          firstSeen={mmInfo.firstSeen}
          today={new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)}
        />
      )}
      {/* 2) 경고 1줄 — 1P 미연결 · 마스터 미등록 옵션 · BEP ROAS 없는 캠페인 */}
      <WarningLine
        unlinked1P={onePView.unlinked}
        unmatched={hideBep ? [] : viewAll.unmatched.list ?? []}
        noBep={hideBep ? [] : viewAll.campaigns.filter((c) => campaignStatusOf(c) == null)}
        lag={liveLag}
      />
      {!adminNew && !hideBep && viewAll.loaded && (
        <>
          {/* 3) 기간 손익 1줄 */}
          <ProfitLine view={viewAll} days={sourcePeriod?.days ?? null} />
          {/* 4) 지난주 대비 · 지난주 조정 결과 (주간 기록 기준, 관리자만) */}
          {isAdmin && <WeekCompareBox snapshots={weekly} notes={notes} />}
          {/* 5) 캠페인 상태 3칸 */}
          <StatusBoxes campaigns={viewAll.campaigns} onPick={pickCampaign} noteOf={productNoteOf} />
        </>
      )}
      {!adminNew && (
        <>
          {/* 6) 채널 필터 한 줄 — 아래 할 일·캠페인 진단 표에 같이 적용 */}
          <ChannelFilterBar value={chFilter} onChange={setChFilter} has1P={onePView.loaded} />
          {chFilter === '1P' && !onePView.loaded && <div style={{ ...noticeBoxOrange, padding: 12, fontSize: 13, margin: '12px 0' }}>이 광고 데이터에는 1P(판매방식 Retail) 광고 행이 없습니다.</div>}
        </>
      )}
      {!adminNew && !hideBep && viewAll.loaded && (
        /* 7) 요약 카드 3개 + 이번 주 할 일 — 반영 기록·적용값 저장은 관리자만 */
        <WeeklyActionsSection
          actions={weeklyActionsShown}
          reflectState={reflectState}
          onReflect={isAdmin ? reflectCampaign : undefined}
          onSetApplied={isAdmin ? setTargetForKey : undefined}
          noteOf={productNoteOf}
        />
      )}
      {/* 8) 캠페인 진단 표 (관리자 라이브는 위 '전체 캠페인' 표로 대체 — 행 클릭 키워드 상세·다운로드는 같은 상세) */}
      {!adminNew && (
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
          noteOf={productNoteOf}
          renderDetail={detailFor}
        />
      )}
      {/* 9) 운영 메모 (접힌 상태, 관리자만) */}
      {/* 관리자 라이브 모드는 위 3블록 아래(notesNode)에 항상 있음 — 월 저장본 탭만 여기 */}
      {isAdmin && !adminNew && notesNode}
    </>
  )

  // ── 주간 (라이브) 모드 — 업로드 상태 바(주간 파일 · 30일 파일) + 30일 파일 있으면 본문 ──
  if (mode === 'live') {
    const filesBar = (
      <LiveFilesBar
        weekly={isAdmin ? weeklySlot : null}
        showWeekly={isAdmin}
        live={adAnalysisLive ? { meta: adAnalysisLive.meta, period: livePeriod } : null}
        endGap={endGap}
        onFiles={handleLiveFiles}
        onClear={() => { clearAdAnalysisLive(); setUploadError(null) }}
      />
    )
    const uploadMsgs = (
      <>
        {uploadNote && <div style={{ ...noticeBoxOrange, padding: '8px 12px', fontSize: 12, textAlign: 'left', margin: '0 0 8px' }}>✓ {uploadNote}</div>}
        {uploadError && <div style={errorBox}>{uploadError}</div>}
        {pendingReplace && (
          <ReplaceConfirmBox diff={pendingReplace.diff} fileName={pendingReplace.fileName} onReplace={confirmReplace} onCancel={() => { setPendingReplace(null); setUploadNote(`${fmtMd(pendingReplace.period.startDate)}~${fmtMd(pendingReplace.period.endDate)} 교체 취소 — 저장된 기록 그대로`) }} />
        )}
      </>
    )
    const overviewNode = isAdmin && weeks13.length ? (
      <WeeklyOverview weeks={weeks13} comment={overview.comment} isAdmin={isAdmin} onSalesSaved={(rows) => setOverview((p) => ({ ...p, sales: rows }))}>
        {blocksNode}
      </WeeklyOverview>
    ) : null
    if (!adAnalysisLive) {
      return (
        <div style={pageWrap}>
          <Style />
          {headerNode}
          {overviewNode}
          {filesBar}
          <LiveUploadBox onFiles={handleLiveFiles} />
          {uploadMsgs}
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
        {overviewNode}
        {filesBar}
        {uploadMsgs}
        {renderBody(isAdmin)}
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
          저장된 광고 분석이 없습니다. 「쿠팡 손익」 화면에서 광고 파일을 저장하거나, 위 「주간 (라이브)」 탭에서 직접 업로드하세요.
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

// ── 채널 필터 (전체 / 3P / 1P) — 할 일·캠페인 진단 표 공통 ─────────

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
/** 'YYYY-MM-DD' 두 날짜 차이 (b − a, 일) */
const dayDiff = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000)
/** 기간 일수 (시작·끝 포함) */
const daysOf = (start: string, end: string) => dayDiff(start, end) + 1
const END_GAP_MAX = 3 // 주간·30일 파일 종료일이 이만큼 이상 차이 나면 다시 받기
const WEEKLY_MAX_DAYS = 10 // 이하 = 주간 파일 (지난주 대비 기록)
const MONTHLY_MIN_DAYS = 25 // 이상 = 30일 파일 (할 일·상태·손익)

const pageWrap: React.CSSProperties = { maxWidth: 1500, margin: '0 auto', padding: '32px 40px', fontFamily: 'Pretendard, sans-serif' }
const loadingBox: React.CSSProperties = { background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: 24, fontSize: 14, color: '#64748B', textAlign: 'center' }
const noticeBoxOrange: React.CSSProperties = { background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: 24, fontSize: 14, color: '#92400E', textAlign: 'center' }
const errorBox: React.CSSProperties = { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '8px 12px', margin: '8px 0', fontSize: 12, color: '#991B1B' }

// ── 라이브 모드 업로드 박스 (드래그 + 클릭) ───────────────────
function LiveUploadBox({ onFiles }: { onFiles: (fs: File[]) => void }) {
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
          파일을 끌어다 놓거나 클릭해서 선택하세요 (여러 개 가능). 기간은 파일명에서 자동 인식 — 10일 이하 = 주간 파일, 25일 이상 = 30일 파일
        </div>
        <div style={{ fontSize: 12, color: '#A16207', marginTop: 4 }}>
          주간 파일과 30일 파일은 같은 날 받아서 같이 올리세요 (종료일 {END_GAP_MAX}일 이상 차이 나면 경고)
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
    </>
  )
}

// ── 업로드 상태 바 — 주간 파일(10일 이하) · 30일 파일(25일 이상) 두 칸 + 파일 올리기 ───────
type FileSlot = { startDate: string; endDate: string; days: number; fileName: string; saved: boolean }
function LiveFilesBar({ weekly, showWeekly, live, endGap, onFiles, onClear }: {
  /** 주간 파일 — 이 화면에서 올린 것, 없으면 마지막 주간 기록 */
  weekly: FileSlot | null
  /** 주간 칸 표시 (관리자만 — 게스트는 주간 기록을 쓰지 않음) */
  showWeekly: boolean
  live: { meta: { fileName: string; rowCount: number; downloadedAt?: string } | null; period: { startDate: string; endDate: string; days: number } | null } | null
  endGap: number | null
  onFiles: (fs: File[]) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const range = (p: { startDate: string; endDate: string; days: number }) => `${fmtMd(p.startDate)}~${fmtMd(p.endDate)} (${p.days}일)`
  const slot: React.CSSProperties = { flex: '1 1 260px', minWidth: 0, padding: '6px 10px', borderRadius: 6, background: '#fff', border: '1px solid #FED7AA' }
  const label: React.CSSProperties = { fontSize: 11, color: '#B45309', marginBottom: 2 }
  const btn: React.CSSProperties = { padding: '4px 10px', border: '1px solid #FED7AA', background: '#FFFBF5', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#92400E' }
  return (
    <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6, padding: '8px 12px', margin: '8px 0 12px', fontSize: 12, color: '#92400E' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'stretch' }}>
        {showWeekly && (
          <div style={slot}>
            <div style={label}>주간 파일 (10일 이하) — 지난주 대비</div>
            {weekly
              ? <div><b>{range(weekly)}</b> {weekly.saved ? '주간 기록 저장됨' : ''}</div>
              : <div style={{ color: '#94A3B8' }}>주간 기록 없음</div>}
          </div>
        )}
        <div style={slot}>
          <div style={label}>30일 파일 (25일 이상) — 할 일·키워드·입찰가</div>
          {live
            ? (
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={live.meta?.fileName}>
                <b>{live.period ? range(live.period) : '기간 불명'}</b>
                <span style={{ color: '#B45309' }}> · {live.meta?.fileName || '—'}{live.meta?.rowCount != null ? ` · ${live.meta.rowCount.toLocaleString('ko-KR')}행` : ''}</span>
              </div>
            )
            : <div style={{ color: '#94A3B8' }}>아직 안 올림</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => inputRef.current?.click()} style={btn}>파일 올리기</button>
          {live && <button onClick={onClear} style={{ ...btn, border: '1px solid #FECACA', background: '#FEF2F2', color: '#991B1B' }}>닫기</button>}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files ? Array.from(e.target.files) : []
              if (fs.length) onFiles(fs)
              if (inputRef.current) inputRef.current.value = ''
            }}
          />
        </div>
      </div>
      {endGap != null && endGap >= END_GAP_MAX && (
        <div style={{ ...errorBox, margin: '8px 0 0', fontSize: 12.5, fontWeight: 600 }}>
          ⚠ 두 파일 종료일 {endGap}일 차이 — 같은 날 다시 받기 (주간 {fmtMd(weekly!.endDate)} · 30일 {fmtMd(live!.period!.endDate)})
        </div>
      )}
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────
function Header({ mode, onMode, adPeriodLabel, role }: {
  mode: Mode
  onMode: (m: Mode) => void
  adPeriodLabel?: string
  /** 서버 역할 — null = 확인 중(탭 숨김), 관리자만 월 저장본 탭 */
  role: string | null
}) {
  const allTabs: { id: Mode; label: string; sub: string }[] = [
    { id: 'live', label: '주간 (라이브)', sub: '광고 엑셀 직접 업로드 — 주 1회 조정용' },
    { id: 'saved', label: '월 저장본', sub: '쿠팡 손익 화면이 저장한 월 광고 파일' },
  ]
  const tabs = role === 'admin' ? allTabs : []
  return (
    <div className="aa-page-header">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="aa-title">광고 분석</div>
          <div className="aa-desc">주 1회 광고센터에서 바꿀 것 · 캠페인별 BEP ROAS · 키워드 입찰가 {adPeriodLabel && <span style={{ marginLeft: 8, color: '#94A3B8' }}>· {adPeriodLabel}</span>}</div>
        </div>
        <div className="aa-period-bar">
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

