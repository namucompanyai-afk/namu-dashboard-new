'use client'

/**
 * 광고 분석 — 캠페인 상세 (옛 '캠페인 진단' 표 + 행 펼침 상세). page.tsx 에서 내용 수정 없이 옮김 (2026-10-19 행 드롭다운)
 *   CampaignSection(옛 표) · AiSection(AI 키워드 분석·제외/이동 추천·목표 ROAS) · ManualSection(수동 입찰가 점검·다운로드)
 *   OptionInlineRow/computeOptions(옵션별 성과) · KeywordTable/NonSearchKeywordTable · BepCpcLine · OptionChips …
 * 새 '전체 캠페인' 표(WeeklyBlocks CampaignTable)도 행을 펼치면 이 컴포넌트를 그대로 쓴다.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isRetailRow } from '@/lib/coupang/onePAnalysis'
import { downloadFormattedXlsx, type XlsxCol } from '@/lib/xlsxExport'
import { buildAdAnalysisView, buildKeywordRows, buildManualReviewRows, buildBepMap, buildBepCpcForCampaign, buildActualPriceMapById, buildMarginRowMap, buildExposureMapByOptionId, splitRowRevenue, isSearchPlacement, keywordGroupKey, type CampaignDiag, type KeywordRow, type ManualKeywordRow, hasBidSample, bepCpcLabel } from '@/lib/coupang/adAnalysis'
import type { AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import { ChannelBadge } from '../_lib/channel'
import { parseCampaignTargetKey } from '@/lib/coupang/weeklyActions'
import { ChBadge, ProductNote, AdProductHint, type ProductMonthNote } from './WeeklyPanel'


// page.tsx 의 같은 스타일 상수 (옮긴 상세가 쓰는 것만 복사)
const noticeBoxOrange: React.CSSProperties = { background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: 24, fontSize: 14, color: '#92400E', textAlign: 'center' }

// ── formatters ────────────────────────────────────────────────
export const fmtMan = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—'
  const man = n / 10000
  return `${Math.round(man).toLocaleString('ko-KR')}만`
}
export const fmtNum = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : Math.round(n).toLocaleString('ko-KR')
const fmtPctVal = (n: number | null | undefined, digits = 0): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${n.toFixed(digits)}%`
const fmtRoas = (n: number | null | undefined): string =>
  (n == null || !Number.isFinite(n)) ? '—' : `${Math.round(n)}%`
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

// ── Campaign Section ──────────────────────────────────────────
export function CampaignSection({ view, master, marginOff = false, hideBep = false, manualBep, openCampId, onOpen, selectedOptionId, onSelectOption, renderDetail, noteOf }: {
  view: ReturnType<typeof buildAdAnalysisView>
  master: any
  marginOff?: boolean
  hideBep?: boolean
  manualBep?: Map<string, number>
  openCampId: string | null
  onOpen: (id: string) => void
  selectedOptionId: string | null
  onSelectOption: (campaignId: string, optionId: string | null) => void
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
              const opts = !marginOff && isOpen
                ? computeOptions(c.rows, bepMap, priceMap, rowMap, exposureMap)
                : []
              return (
                <CampaignRowGroup
                  key={c.campaignId}
                  c={c}
                  marginOff={marginOff}
                  hideBep={hideBep}
                  isOpen={isOpen}
                  onToggle={() => onOpen(c.campaignId)}
                  options={opts}
                  selectedOptionId={isOpen ? selectedOptionId : null}
                  onSelectOption={(optId) => onSelectOption(c.campaignId, optId)}
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

function CampaignRowGroup({ c, marginOff = false, hideBep = false, isOpen, onToggle, options, selectedOptionId, onSelectOption, detail, note }: {
  detail?: React.ReactNode
  note?: ProductMonthNote | null
  c: CampaignDiag
  marginOff?: boolean
  hideBep?: boolean
  /** 펼침 — 옵션 행·키워드 분석이 같이 열림 */
  isOpen: boolean
  onToggle: () => void
  options: OptionDiag[]
  selectedOptionId: string | null
  onSelectOption: (optionId: string) => void
}) {
  const roasUnder = c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct
  // BEP 숨김이면 색상 없이 중립
  const roasClass = hideBep ? '' : (roasUnder ? 'text-bad' : (c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct * 1.2 ? 'text-warn' : ''))

  const typeBadge =
    c.type === 'ai' ? <span className="aa-badge badge-ai">🤖 AI</span> :
    c.type === 'manual' ? <span className="aa-badge badge-manual">🎯 수동</span> :
    <span className="aa-badge badge-unsorted">미분류</span>

  const isManual = c.type === 'manual'

  return (
    <>
      <tr id={`aa-camp-${c.campaignId}`} className={`clickable ${isOpen ? 'selected' : ''}`} onClick={onToggle} style={{ scrollMarginTop: 80 }}>
        <td className="sticky-left">
          <span
            className="aa-expand-toggle"
            onClick={(e) => { e.stopPropagation(); onToggle() }}
            title={isOpen ? '옵션 접기' : '옵션 펼치기'}
          >
            {isOpen ? '▾' : '▸'}
          </span>
          <strong><ChBadge ch={c.channel} />{c.campaignName}</strong>
          {note && <div style={{ paddingLeft: 22 }}><ProductNote note={note} /></div>}
          {note && <div style={{ paddingLeft: 22 }}><AdProductHint adProfit={c.adProfit} note={note} /></div>}
        </td>
        <td>{typeBadge}</td>
        <td className="num">{fmtMan(c.adCostVat)}</td>
        <td className="num">
          {fmtMan(c.revenue)}
          {c.onePConvRevenue > 0 && <div style={{ fontSize: 10, color: '#64748B' }}>1P 전환 포함 {fmtMan(c.onePConvRevenue)}</div>}
        </td>
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
      {!marginOff && isOpen && options.map((o) => (
        <OptionInlineRow
          key={`${c.campaignId}::${o.optionId}`}
          o={o}
          isSelected={selectedOptionId === o.optionId}
          onClick={() => onSelectOption(o.optionId)}
          hideBep={hideBep}
        />
      ))}
      {!marginOff && isOpen && options.length === 0 && (
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
      {marginOff && isOpen && (
        <tr className="aa-option-row">
          <td className="sticky-left aa-option-cell" colSpan={hideBep ? 7 : 9} style={{ textAlign: 'center', color: '#94A3B8' }}>옵션 상세는 마진마스터 필요 (옵션 판정은 상단 BEP ROAS 입력값 기준)</td>
        </tr>
      )}
    </>
  )
}

export function OptionInlineRow({ o, isSelected, onClick, hideBep = false }: { o: OptionDiag; isSelected: boolean; onClick: () => void; hideBep?: boolean }) {
  const roasUnder = o.roasPct != null && o.bepPct != null && o.roasPct < o.bepPct
  const roasClass = o.roasPct == null || o.bepPct == null ? '' : (roasUnder ? 'text-bad' : 'text-good')

  return (
    <tr
      className={`aa-option-row clickable ${isSelected ? 'option-selected' : ''}`}
      onClick={onClick}
    >
      <td className="sticky-left aa-option-cell">
        <span className="aa-option-prefix">└─</span>
        <span className="aa-option-text">
          {o.alias && <span className="aa-option-alias">{o.alias}</span>}
          <span className="aa-option-name"><ChBadge ch={o.saleCh} />{o.optionName}</span>
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
export function AiSection({ campaign, master, marginOff = false, hideBep = false, manualBep, periodLabel, selectedOptionId, onClearOption, onClose, targets, onTargetChange, onSelectOption }: {
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
export interface OptionDiag {
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

export function computeOptions(
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
    isSearchPlacement(r.placement) && (keywordGroupKey(r.keyword) || '-') === keyword, // 띄어쓰기만 다른 표기 묶음
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

  // 체크된 모든 키워드를 선택한 카테고리(AI 제외/수동 이동) 텍스트로 복사 — 추천 액션 무관, 사용자 의사 우선
  function copyChecked(target: 'exclude' | 'move') {
    const list = sorted.filter((r) => checked.has(r.keyword)).flatMap((r) => r.variants.map((v) => v.keyword)) // 묶인 표기마다 한 줄
    if (list.length === 0) {
      alert('선택된 키워드가 없습니다.')
      return
    }
    const text = list.join('\n')
    const label = target === 'exclude' ? 'AI 제외' : '수동 이동'
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
                ? computeKeywordOptions(r.groupKey, campaignRows, bepMap, priceMap, rowMap, campaignAvgCvr)
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
          <button className="aa-btn btn-sm btn-bad" onClick={() => copyChecked('exclude')}>AI 제외 키워드 복사 ({checked.size})</button>
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
              BEP/2 ≤ ROAS &lt; BEP ROAS → 입찰가 ↓<br />
              판매 0 · ROAS &lt; BEP/2 → 입찰가 ↓ 100원
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

// 추천 액션 4단 → 배지 렌더 (테이블 셀 + 엑셀 라벨 공통)
const ACTION_LABEL: Record<KeywordRow['action'], string> = {
  low_sample: '모수 부족',
  enhance: '강화',
  maintain: '유지',
  lower_bid: '입찰가 ↓',
}
function actionBadge(action: KeywordRow['action']): React.ReactElement {
  switch (action) {
    case 'low_sample': return <span className="aa-action-chip action-low-sample">모수 부족</span>
    case 'enhance':    return <span className="aa-action-chip action-enhance">강화</span>
    case 'maintain':   return <span className="aa-action-chip action-maintain">유지</span>
    case 'lower_bid':  return <span className="aa-action-chip action-lower-bid">입찰가 ↓</span>
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
  //   fixed_100         : "100원" (판매 0 · ROAS < BEP/2 — 최저가)
  //   revenue           : 매출 역산
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
      <br />• <span className="aa-action-chip action-lower-bid">입찰가 ↓</span> BEP ROAS/2 ≤ ROAS &lt; BEP ROAS — 매출 역산값으로 인하 (100원 하한)
      <br />• <span className="aa-action-chip action-lower-bid">입찰가 ↓</span> 판매 0 또는 ROAS &lt; BEP ROAS/2 — 지우지 않고 최저가 100원
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

export function ManualSection({ campaign, master, marginOff = false, hideBep = false, manualBep, periodLabel, selectedOptionId, onClearOption, onClose, onSelectOption }: {
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
    r.deleteCandidate ? <span className="aa-badge badge-bad">입찰가 ↓ 100원</span> :
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
      <td className="sticky-left-2">
        <strong>{r.keyword}</strong>
        {r.variantCpc.length > 1 && new Set(r.variantCpc.map((v) => v.avgCpcVatExcl)).size > 1 && (
          <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>
            {r.variantCpc.map((v) => `${v.keyword} ${v.avgCpcVatExcl != null ? v.avgCpcVatExcl.toLocaleString('ko-KR') : '—'}`).join(' · ')}
          </div>
        )}
      </td>
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
export function Style() {
  return (
    <style jsx global>{`
      .aa-page-header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #E2E8F0; }
      .aa-title { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
      .aa-desc { color: #64748B; font-size: 13px; margin-top: 4px; }
      .mono { font-family: 'JetBrains Mono', monospace; }
      .aa-section { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 20px; overflow: clip; }
      .aa-section-header { padding: 16px 20px; border-bottom: 1px solid #E2E8F0; display: flex; justify-content: space-between; align-items: center; }
      .aa-section-title { font-size: 15px; font-weight: 600; }
      .aa-section-desc { font-size: 12px; color: #64748B; margin-top: 2px; }
      .aa-section-body { padding: 16px 20px; }
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
      .aa-action-chip { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; white-space: nowrap; }
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
      .aa-stars { font-size: 12px; letter-spacing: 1px; }
      .aa-stars.high { color: #F59E0B; }
      .aa-stars.mid { color: #FCD34D; }
      .aa-stars.low { color: #94A3B8; }
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

