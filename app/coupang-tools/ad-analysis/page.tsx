'use client'

/**
 * 광고 분석 페이지 (/coupang-tools/ad-analysis)
 *
 * 데이터 소스: store 의 rawAdCampaign (parseAdCampaign 결과) + marginMaster (BEP).
 * 1차 범위: 캠페인 진단 + AI 키워드 분석 + 수동 입찰가 점검 (현재 입찰가는 사용자 직접 입력).
 * 자동 입찰 적용은 영구 안 함 — 사용자가 키워드 복사해서 쿠팡 광고센터에 직접 입력.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMarginStore } from '@/lib/coupang/store'
import {
  buildAdAnalysisView,
  buildKeywordRows,
  buildManualReviewRows,
  buildBepMap,
  buildBepCpcForCampaign,
  type CampaignDiag,
  type KeywordRow,
  type ManualKeywordRow,
} from '@/lib/coupang/adAnalysis'

type Period = 7 | 30 | 90

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

// ── Page ──────────────────────────────────────────────────────
export default function AdAnalysisPage() {
  const marginMaster = useMarginStore((s) => s.marginMaster)
  const rawAdCampaign = useMarginStore((s) => s.rawAdCampaign)
  const adPeriod = useMarginStore((s) => s.adPeriod)
  const setMarginMaster = useMarginStore((s) => s.setMarginMaster)
  const setAdCampaign = useMarginStore((s) => s.setAdCampaign)
  const setSalesInsight = useMarginStore((s) => s.setSalesInsight)
  const [period, setPeriod] = useState<Period>(30)
  const [openCampId, setOpenCampId] = useState<string | null>(null)
  const [autoLoading, setAutoLoading] = useState(true)

  // 마운트 시점 자동 로드 — 수익 진단 페이지를 거치지 않고 직접 진입해도 동작.
  // 진단 페이지의 자동 로드 로직 중 광고 분석에 필요한 것만 발췌:
  //  1) marginMaster (BEP/단가 lookup)
  //  2) 가장 최근 주차 광고 분석 → setAdCampaign + setSalesInsight (주차 기간 + 광고 raw row)
  // settle/price/savedAnalyses 등 광고 분석에서 안 쓰는 것은 생략.
  // 이미 store 에 데이터가 있으면 fetch 안 함 (다른 페이지에서 먼저 로드된 경우).
  useEffect(() => {
    let cancelled = false
    const needMaster = !marginMaster
    const needAd = !rawAdCampaign || rawAdCampaign.length === 0 || !adPeriod

    if (!needMaster && !needAd) {
      setAutoLoading(false)
      return
    }

    ;(async () => {
      try {
        if (needMaster) {
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

        if (needAd) {
          const listRes = await fetch('/api/coupang-diagnoses?type=list')
          const listJson = await listRes.json()
          const all = listJson?.diagnoses || []
          const weeklies = all
            .filter((a: any) => a.weekKey && a._hasRaw)
            .sort((a: any, b: any) => (b.weekKey || '').localeCompare(a.weekKey || ''))
          const meta = weeklies[0]
          if (meta?.id) {
            // 메인 row 의 adRows/sellerStats 는 4.5MB Vercel limit 회피용 빈 배열 마커.
            // 실데이터는 raw 키에 분리 저장되어 있어 별도 fetch 후 머지.
            const [itemRes, rawRes] = await Promise.all([
              fetch(`/api/coupang-diagnoses?type=item&id=${meta.id}`),
              fetch(`/api/coupang-diagnoses?type=raw&id=${meta.id}`),
            ])
            const target = await itemRes.json()
            const raw = rawRes.ok ? await rawRes.json().catch(() => null) : null
            const adRows = raw?.adRows?.length ? raw.adRows : target?.adRows
            const sellerStats = raw?.sellerStats?.length ? raw.sellerStats : target?.sellerStats
            if (!cancelled && adRows?.length) {
              setAdCampaign(adRows, {
                fileName: target?.adFileName || '저장된 분석',
                uploadedAt: target?.createdAt || new Date().toISOString(),
                rowCount: adRows.length,
              }, target?.periodStartDate && target?.periodEndDate ? {
                startDate: target.periodStartDate,
                endDate: target.periodEndDate,
                days: target.periodDays || 30,
              } : null)
              if (sellerStats?.length) {
                setSalesInsight(sellerStats, {
                  fileName: target?.sellerFileName || '저장된 분석',
                  uploadedAt: target?.createdAt || new Date().toISOString(),
                  rowCount: sellerStats.length,
                })
              }
            }
          }
        }
      } catch (err) {
        console.error('[ad-analysis] 자동 로드 실패:', err)
      } finally {
        if (!cancelled) setAutoLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(
    () => buildAdAnalysisView(rawAdCampaign, marginMaster as any),
    [rawAdCampaign, marginMaster],
  )

  if (autoLoading && !view.loaded) {
    return (
      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '32px 40px', fontFamily: 'Pretendard, sans-serif' }}>
        <Header period={period} onPeriod={setPeriod} />
        <div style={{
          background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8,
          padding: 24, fontSize: 14, color: '#64748B', textAlign: 'center',
        }}>
          저장된 광고 데이터를 불러오는 중…
        </div>
      </div>
    )
  }

  if (!view.loaded) {
    return (
      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '32px 40px', fontFamily: 'Pretendard, sans-serif' }}>
        <Header period={period} onPeriod={setPeriod} />
        <div style={{
          background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
          padding: 24, fontSize: 14, color: '#92400E', textAlign: 'center',
        }}>
          광고 캠페인 엑셀이 로드되지 않았습니다. 「수익 진단」 페이지에서 광고 엑셀을 업로드해주세요.
        </div>
      </div>
    )
  }

  const openCampaign = openCampId ? view.campaigns.find((c) => c.campaignId === openCampId) || null : null

  return (
    <div style={{
      fontFamily: 'Pretendard, -apple-system, sans-serif',
      color: '#1F2937', fontSize: 14, lineHeight: 1.5,
    }}>
      <Style />
      <Header period={period} onPeriod={setPeriod} adPeriodLabel={adPeriod ? `${adPeriod.startDate} ~ ${adPeriod.endDate} (${adPeriod.days}일)` : undefined} />
      <KpiSection view={view} />
      <HintBanner />
      <CampaignSection
        view={view}
        master={marginMaster as any}
        openCampId={openCampId}
        onOpen={(id) => setOpenCampId(id === openCampId ? null : id)}
      />
      {openCampaign && (
        openCampaign.type === 'manual'
          ? <ManualSection campaign={openCampaign} master={marginMaster as any} onClose={() => setOpenCampId(null)} />
          : <AiSection campaign={openCampaign} master={marginMaster as any} onClose={() => setOpenCampId(null)} />
      )}
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────
function Header({ period, onPeriod, adPeriodLabel }: {
  period: Period
  onPeriod: (p: Period) => void
  adPeriodLabel?: string
}) {
  return (
    <div className="aa-page-header">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="aa-title">광고 분석</div>
          <div className="aa-desc">캠페인별 효율 진단 · 제외 키워드 추출 · 수동 캠페인 입찰가 가이드 {adPeriodLabel && <span style={{ marginLeft: 8, color: '#94A3B8' }}>· {adPeriodLabel}</span>}</div>
        </div>
        <div className="aa-period-bar">
          {[7, 30, 90].map((p) => (
            <button
              key={p}
              className={`aa-period-btn ${period === p ? 'active' : ''}`}
              onClick={() => onPeriod(p as Period)}
            >
              {p}일
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── KPI ───────────────────────────────────────────────────────
function KpiSection({ view }: { view: ReturnType<typeof buildAdAnalysisView> }) {
  const roasUnder = view.avgRoasPct != null && view.avgBepPct != null && view.avgRoasPct < view.avgBepPct
  return (
    <div className="aa-kpi-grid">
      <KpiCard label={<>광고비 <span className="aa-vat-tag">VAT 포함</span></>} value={fmtMan(view.totalAdCostVat)} sub={`캠페인 ${view.campaignCount}개`} />
      <KpiCard label="광고 매출" value={fmtMan(view.totalRevenue)} sub="14일 어트리뷰션" />
      <KpiCard
        label="평균 ROAS"
        value={fmtRoas(view.avgRoasPct)}
        valueClass={roasUnder ? 'text-bad' : undefined}
        sub={view.avgBepPct != null ? `BEP 평균 ${Math.round(view.avgBepPct)}% ${roasUnder ? '미달' : '도달'}` : 'BEP 매칭 없음'}
      />
      <KpiCard
        label="주문"
        value={`${fmtNum(view.totalOrders)}건`}
        sub={view.avgUnitPrice ? `평균 단가 ${fmtNum(view.avgUnitPrice)}원` : ''}
      />
    </div>
  )
}

function KpiCard({ label, value, sub, valueClass }: { label: React.ReactNode; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="aa-kpi-card">
      <div className="aa-kpi-label">{label}</div>
      <div className={`aa-kpi-value ${valueClass || ''}`}>{value}</div>
      {sub && <div className="aa-kpi-sub">{sub}</div>}
    </div>
  )
}

function HintBanner() {
  return (
    <div className="aa-hint-banner">
      💡 캠페인을 클릭하면 키워드 분석(AI) 또는 입찰가 점검(수동)이 펼쳐집니다. AI 캠페인의 "수동 이동 후보" 키워드 옆에 추천 입찰가가 표시됩니다.
    </div>
  )
}

// ── Campaign Section ──────────────────────────────────────────
function CampaignSection({ view, master, openCampId, onOpen }: {
  view: ReturnType<typeof buildAdAnalysisView>
  master: any
  openCampId: string | null
  onOpen: (id: string) => void
}) {
  const { sorted, key, dir, toggle } = useSort(view.campaigns, 'adCostVat' as keyof CampaignDiag, 'desc')

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
          <div className="aa-section-desc">AI / 수동 자동 분류 · 광고비는 VAT 포함</div>
        </div>
      </div>
      <div className="aa-table-wrap">
        <table>
          <thead>
            <tr>
              <TH label="캠페인" k={'campaignName'} sticky minWidth={240} />
              <TH label="타입" k={'type'} />
              <TH label={<>광고비 <span className="aa-vat-tag">VAT</span></>} k={'adCostVat'} num />
              <TH label="매출" k={'revenue'} num />
              <TH label="ROAS" k={'roasPct'} num />
              <TH label="BEP" k={'bepPct'} num />
              <TH label="갭" k={'gapPct'} num />
              <TH label="검색/비검색" k={'searchShare'} minWidth={200} />
              <TH label="상태" k={'roasPct'} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const isOpen = c.campaignId === openCampId
              return (
                <CampaignRowGroup
                  key={c.campaignId}
                  c={c}
                  isOpen={isOpen}
                  onToggle={() => onOpen(c.campaignId)}
                  master={master}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CampaignRowGroup({ c, isOpen, onToggle, master: _master }: {
  c: CampaignDiag
  isOpen: boolean
  onToggle: () => void
  master: any
}) {
  const roasUnder = c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct
  const roasClass = roasUnder ? 'text-bad' : (c.roasPct != null && c.bepPct != null && c.roasPct < c.bepPct * 1.2 ? 'text-warn' : '')
  const gapClass = c.gapPct != null && c.gapPct < 0 ? 'text-bad' : c.gapPct != null && c.gapPct > 0 ? 'text-good' : ''

  const typeBadge =
    c.type === 'ai' ? <span className="aa-badge badge-ai">🤖 AI</span> :
    c.type === 'manual' ? <span className="aa-badge badge-manual">🎯 수동</span> :
    <span className="aa-badge badge-unsorted">미분류</span>

  const statusBadge =
    c.type === 'manual' ? <span className="aa-badge badge-info">노출/후광용</span> :
    roasUnder ? <span className="aa-badge badge-bad">🔴 BEP 미달</span> :
    c.roasPct != null && c.bepPct != null ? <span className="aa-badge badge-good">🟢 BEP 도달</span> :
    <span className="aa-badge badge-unsorted">BEP 없음</span>

  const searchPct = Math.round(c.searchShare * 100)
  const isManual = c.type === 'manual'

  return (
    <tr className={`clickable ${isOpen ? 'selected' : ''}`} onClick={onToggle}>
      <td className="sticky-left"><strong>{c.campaignName}</strong></td>
      <td>{typeBadge}</td>
      <td className="num">{fmtMan(c.adCostVat)}</td>
      <td className="num">{fmtMan(c.revenue)}</td>
      <td className={`num ${roasClass}`}>{fmtRoas(c.roasPct)}</td>
      <td className="num">{isManual ? <span className="text-muted">—</span> : (c.bepPct != null ? `${Math.round(c.bepPct)}%` : '—')}</td>
      <td className={`num ${gapClass}`}>{isManual ? <span className="text-muted">—</span> : (c.gapPct != null ? `${c.gapPct > 0 ? '+' : ''}${Math.round(c.gapPct)}%p` : '—')}</td>
      <td>
        {c.adCostRaw > 0 ? (
          <div className="aa-search-bar">
            <span style={{ width: 32, color: '#3B82F6' }}>{searchPct}%</span>
            <div className="aa-search-bar-bg"><div className="aa-search-bar-fill" style={{ width: `${searchPct}%` }} /></div>
            <span style={{ width: 32, color: '#A855F7' }}>{100 - searchPct}%</span>
          </div>
        ) : <span className="text-muted">—</span>}
      </td>
      <td>{statusBadge}</td>
    </tr>
  )
}

// ── AI Section ────────────────────────────────────────────────
function AiSection({ campaign, master, onClose }: { campaign: CampaignDiag; master: any; onClose: () => void }) {
  const bepMap = useMemo(() => buildBepMap(master), [master])
  const { search, nonSearch } = useMemo(() => buildKeywordRows(campaign, bepMap), [campaign, bepMap])
  const cpcEntries = useMemo(() => buildBepCpcForCampaign(campaign, master), [campaign, master])

  const [checked, setChecked] = useState<Set<string>>(new Set())
  const toggleCheck = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })

  const cpcLabel = cpcEntries.length > 0
    ? cpcEntries.map((e) => `${e.label} ${Math.round(e.cpc)}원`).join(' / ')
    : '—'

  return (
    <div className="aa-section" style={{ border: '2px solid #FF6B35' }}>
      <div className="aa-section-header" style={{ background: '#FFF7ED' }}>
        <div>
          <div className="aa-section-title">▼ {campaign.campaignName} · 키워드 분석</div>
          <div className="aa-section-desc">검색 영역만 키워드 단위 제어 가능 · 비검색은 통제 불가</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {cpcEntries.length > 0 && (
            <div style={{ fontSize: 11.5, color: '#64748B' }}>
              <strong style={{ color: '#1F2937' }}>BEP CPC:</strong>{' '}
              <span className="mono">{cpcLabel}</span>{' '}
              <span style={{ color: '#94A3B8' }}>(VAT 별도)</span>
            </div>
          )}
          <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
        </div>
      </div>
      <div className="aa-section-body">
        <div className="aa-two-col">
          <div className="aa-metric-box search">
            <div className="aa-metric-box-label">🔍 검색 영역 (제어 가능)</div>
            <Row label={<>광고비 <span className="aa-vat-tag">VAT</span></>} value={fmtMan(campaign.searchAdCostVat)} sub={campaign.adCostVat > 0 ? `(${Math.round(campaign.searchShare * 100)}%)` : undefined} />
            <Row label="매출" value={fmtMan(campaign.searchRevenue)} />
            <Row label="ROAS" value={fmtRoas(campaign.searchRoasPct)} valueClass={campaign.searchRoasPct != null && campaign.bepPct != null && campaign.searchRoasPct < campaign.bepPct ? 'text-bad' : ''} />
            <Row label="BEP 갭" value={campaign.searchRoasPct != null && campaign.bepPct != null ? `${Math.round(campaign.searchRoasPct - campaign.bepPct)}%p` : '—'} valueClass={campaign.searchRoasPct != null && campaign.bepPct != null && campaign.searchRoasPct < campaign.bepPct ? 'text-bad' : 'text-good'} />
          </div>
          <div className="aa-metric-box nonsearch">
            <div className="aa-metric-box-label">🎯 비검색 영역 (통제 불가)</div>
            <Row label={<>광고비 <span className="aa-vat-tag">VAT</span></>} value={fmtMan(campaign.nonSearchAdCostVat)} sub={campaign.adCostVat > 0 ? `(${100 - Math.round(campaign.searchShare * 100)}%)` : undefined} />
            <Row label="매출" value={fmtMan(campaign.nonSearchRevenue)} />
            <Row label="ROAS" value={fmtRoas(campaign.nonSearchRoasPct)} valueClass={campaign.nonSearchRoasPct != null && campaign.bepPct != null && campaign.nonSearchRoasPct < campaign.bepPct ? 'text-bad' : ''} />
            <Row label={<span className="text-muted">참고용</span>} value={<span style={{ fontSize: 11 }}>AI 자동 운영</span>} />
          </div>
        </div>
        <KeywordTable
          rows={search}
          campaignBep={campaign.bepPct}
          checked={checked}
          onToggle={toggleCheck}
          nonSearchCount={nonSearch.length}
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

function KeywordTable({ rows, campaignBep, checked, onToggle, nonSearchCount: _nsc }: {
  rows: KeywordRow[]
  campaignBep: number | null
  checked: Set<string>
  onToggle: (k: string) => void
  nonSearchCount: number
}) {
  const { sorted, key, dir, toggle } = useSort(rows, 'adCostVat' as keyof KeywordRow, 'desc')

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

  return (
    <div className="aa-sub-section">
      <div className="aa-sub-section-title">
        <span>🔍 검색 키워드 ({sorted.length}개 · BEP 미달 {belowBepCount}개 · 광고비 {fmtMan(totalCost)})</span>
        <span style={{ fontSize: 11, color: '#64748B' }}>선택: <strong>{checked.size}</strong>개</span>
      </div>
      <div className="aa-table-wrap shorter">
        <table>
          <thead>
            <tr>
              <th className="sticky-left" style={{ width: 32 }}></th>
              <TH label="키워드" k="keyword" sticky2 minWidth={140} />
              <TH label="노출" k="impressions" num />
              <TH label="클릭" k="clicks" num />
              <TH label="CTR" k="ctrPct" num />
              <TH label="주문" k="orders" num />
              <TH label="CVR" k="cvrPct" num />
              <TH label="ROAS" k="roasPct" num />
              <TH label="BEP" k="bepPct" num />
              <TH label={<>광고비 <span className="aa-vat-tag">VAT</span></>} k="adCostVat" num />
              <TH label="매출" k="revenue" num />
              <th>추천 액션</th>
              <TH label={<>수동 이동 시<br />추천 입찰가 <span className="aa-vat-tag">VAT 별도</span></>} k="recommendedBidVatExcl" num minWidth={130} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <KeywordRowComp key={r.keyword} r={r} checked={checked.has(r.keyword)} onToggle={() => onToggle(r.keyword)} />
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={13} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>검색 키워드 없음</td></tr>
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

function KeywordRowComp({ r, checked, onToggle }: { r: KeywordRow; checked: boolean; onToggle: () => void }) {
  const action =
    r.action === 'keep' ? <span className="aa-action-chip action-keep">유지</span> :
    r.action === 'move' ? <span className="aa-action-chip action-move">➡️ 수동 이동</span> :
    <span className="aa-action-chip action-exclude">🚫 제외</span>

  const roasClass =
    r.roasPct == null || r.bepPct == null ? '' :
    r.roasPct < r.bepPct ? 'text-bad' :
    r.roasPct < r.bepPct * 1.2 ? 'text-warn' : 'text-good'
  const cvrClass =
    r.cvrPct == null ? '' :
    r.cvrPct >= 10 ? 'text-good' :
    r.cvrPct < 6 ? 'text-bad' : 'text-warn'

  return (
    <tr>
      <td className="sticky-left"><input type="checkbox" checked={checked} onChange={onToggle} /></td>
      <td className="sticky-left-2"><strong>{r.keyword}</strong></td>
      <td className="num">{fmtNum(r.impressions)}</td>
      <td className="num">{fmtNum(r.clicks)}</td>
      <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
      <td className="num">{fmtNum(r.orders)}</td>
      <td className={`num ${cvrClass}`}>{fmtPctVal(r.cvrPct, 2)}</td>
      <td className={`num ${roasClass}`}>{fmtRoas(r.roasPct)}</td>
      <td className="num">{r.bepPct != null ? `${Math.round(r.bepPct)}%` : '—'}</td>
      <td className="num">{fmtNum(r.adCostVat)}</td>
      <td className="num">{fmtNum(r.revenue)}</td>
      <td>{action}</td>
      <td className="num">
        {r.recommendedBidVatExcl != null ? (
          <>
            <span className="bid-recommend">{Math.round(r.recommendedBidVatExcl).toLocaleString('ko-KR')}원</span>
            <span className="bid-vat-incl">VAT 포함 {Math.round(r.recommendedBidVatExcl * 1.1).toLocaleString('ko-KR')}원</span>
          </>
        ) : <span className="text-muted" style={{ fontSize: 11 }}>—</span>}
      </td>
    </tr>
  )
}

function ActionLegend() {
  return (
    <div style={{ fontSize: 11.5, color: '#64748B', padding: '10px 12px', background: '#F8FAFC', borderRadius: 6, lineHeight: 1.7, marginTop: 8 }}>
      <strong style={{ color: '#1F2937' }}>추천 액션 기준:</strong>
      <br />• <span className="aa-action-chip action-keep">유지</span> ROAS ≥ BEP
      <br />• <span className="aa-action-chip action-move">➡️ 수동 이동</span> ROAS &lt; BEP 이면서 광고비 50만원 이상 (빅키워드 후보)
      <br />• <span className="aa-action-chip action-exclude">🚫 제외</span> ROAS &lt; BEP 이면서 광고비 50만원 미만 또는 ROAS &lt; BEP × 0.5
      <br /><br />
      <strong style={{ color: '#1F2937' }}>추천 입찰가 공식:</strong> 매출 ÷ (클릭수 × BEP × 1.1) ÷ 1.1 = 매출 ÷ (클릭수 × BEP × 1.21){' '}
      <span style={{ fontSize: 11 }}>— BEP 대비 10% 여유 / VAT 별도 = 쿠팡 광고센터 입력값 / 클릭 &lt; 20 → 데이터 부족</span>
    </div>
  )
}

// ── Manual Section ────────────────────────────────────────────
function ManualSection({ campaign, master, onClose }: { campaign: CampaignDiag; master: any; onClose: () => void }) {
  const bepMap = useMemo(() => buildBepMap(master), [master])
  const [bidByKeyword, setBidByKeyword] = useState<Map<string, number>>(new Map())
  const rows = useMemo(() => buildManualReviewRows(campaign, bepMap, bidByKeyword), [campaign, bepMap, bidByKeyword])
  const { sorted, key, dir, toggle } = useSort(rows, 'recommendedBidVatExcl' as keyof ManualKeywordRow, 'desc')

  const TH = ({ label, k, num, minWidth, sticky }: any) => (
    <th
      className={[
        'sortable', num ? 'num' : '',
        sticky ? 'sticky-left' : '',
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

  return (
    <div className="aa-section" style={{ border: '2px solid #A855F7' }}>
      <div className="aa-section-header" style={{ background: '#FAF5FF' }}>
        <div>
          <div className="aa-section-title">▼ {campaign.campaignName} · 입찰가 점검</div>
          <div className="aa-section-desc">현재 입찰가는 광고 엑셀에 없어 직접 입력합니다 · 추천 대비 너무 높으면 빨강</div>
        </div>
        <button className="aa-btn btn-sm" onClick={onClose}>접기</button>
      </div>
      <div className="aa-section-body">
        <div className="aa-table-wrap shorter">
          <table>
            <thead>
              <tr>
                <TH label="키워드" k="keyword" sticky minWidth={140} />
                <TH label="노출" k="impressions" num />
                <TH label="클릭" k="clicks" num />
                <TH label="CTR" k="ctrPct" num />
                <TH label="주문" k="orders" num />
                <TH label="CVR" k="cvrPct" num />
                <TH label="매출" k="revenue" num />
                <th className="num">현재 입찰가<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(VAT 별도)</span></th>
                <TH label={<>추천 입찰가<br /><span style={{ fontWeight: 400, fontSize: 10, color: '#94A3B8' }}>(VAT 별도)</span></>} k="recommendedBidVatExcl" num />
                <TH label="차이" k="bidDiff" num />
                <th>신뢰도</th>
                <th>점검</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => <ManualKeywordRowComp key={r.keyword} r={r} onChangeBid={setBid} />)}
              {sorted.length === 0 && (
                <tr><td colSpan={12} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>검색 키워드 없음</td></tr>
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

function ManualKeywordRowComp({ r, onChangeBid }: { r: ManualKeywordRow; onChangeBid: (k: string, v: string) => void }) {
  const stars = r.confidence === 3 ? '⭐⭐⭐' : r.confidence === 2 ? '⭐⭐' : '⭐'
  const starsClass = r.confidence === 3 ? 'high' : r.confidence === 2 ? 'mid' : 'low'

  const verdictBadge =
    r.bidVerdict === 'ok' ? <span className="aa-badge badge-good">🟢 여유</span> :
    r.bidVerdict === 'high' ? <span className="aa-badge badge-warn">🟡 살짝 높음</span> :
    r.bidVerdict === 'too_high' ? <span className="aa-badge badge-bad">🔴 너무 높음</span> :
    <span className="aa-badge badge-unsorted">⚪ 평가 보류</span>

  const diffClass = r.bidDiff != null ? (r.bidDiff >= 0 ? 'text-good' : 'text-bad') : ''
  const isLowClick = r.clicks < 20

  return (
    <tr style={isLowClick ? { opacity: 0.6 } : undefined}>
      <td className="sticky-left"><strong>{r.keyword}</strong></td>
      <td className="num">{fmtNum(r.impressions)}</td>
      <td className="num">{fmtNum(r.clicks)}</td>
      <td className="num">{fmtPctVal(r.ctrPct, 2)}</td>
      <td className="num">{fmtNum(r.orders)}</td>
      <td className="num">{fmtPctVal(r.cvrPct, 2)}</td>
      <td className="num">{fmtNum(r.revenue)}</td>
      <td className="num">
        <input
          type="text"
          inputMode="numeric"
          placeholder="—"
          defaultValue={r.currentBidVatExcl ?? ''}
          onBlur={(e) => onChangeBid(r.keyword, e.target.value)}
          style={{ width: 64, textAlign: 'right', padding: '2px 6px', border: '1px solid #E2E8F0', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
        />
      </td>
      <td className="num">
        {r.recommendedBidVatExcl != null
          ? <span className="bid-recommend">{Math.round(r.recommendedBidVatExcl).toLocaleString('ko-KR')}</span>
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
      .aa-section { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
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
      .aa-action-chip.action-move { background: #DBEAFE; color: #1E40AF; }
      .aa-action-chip.action-keep { background: #D1FAE5; color: #065F46; }
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
    `}</style>
  )
}
