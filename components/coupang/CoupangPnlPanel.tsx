'use client'

/**
 * 쿠팡 손익 — 월 선택 · 파일 6종 · 순이익(3P + 1P 입고 기준) · 매출 구조
 *
 * 파일은 파싱 결과를 월별로 Supabase(/api/coupang-master, type=pnl_{종류}_{YYYY-MM})에 저장하고,
 * 월을 다시 열면 그 달 저장본을 자동으로 불러온다.
 *   - 광고: 기존 파서 → 수익 진단 저장소에도 반영(onAd) + 1P 계산용 요약 행만 월별 저장
 *   - 3P 판매(SELLER_INSIGHTS): 기존 파서 → 저장소 반영(onSeller) + 월별 저장
 *   - 1P 판매 CSV · 발주서(zip/xlsx) · 밀크런 정산 · 밀크런 접수 내역: 새 파서
 * 3P 손익은 기존 수익 진단 결과(summary)를 그대로 가져온다.
 */

import { useEffect, useMemo, useState } from 'react'
import { parseAdCampaign, type AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import { parseSalesInsight } from '@/lib/coupang/parsers/salesInsight'
import { parseOnePSalesCsv, type OnePSalesRow } from '@/lib/coupang/parsers/onePSales'
import { parsePurchaseOrderFiles, type PurchaseOrder } from '@/lib/coupang/parsers/purchaseOrder'
import { parseMilkrunSettlement, parseMilkrunList, type MilkrunSettleRow, type MilkrunListRow } from '@/lib/coupang/parsers/milkrun'
import { build1PView } from '@/lib/coupang/onePAnalysis'
import { computeOnePPnl } from '@/lib/coupang/onePPnl'
import type { OnePMarginRow, MarginCalcRow } from '@/lib/coupang/parsers/marginMaster'

type Kind = 'ad' | 'seller' | 'onep_sales' | 'po' | 'mr_settle' | 'mr_list'
type Saved = { data: any; fileName: string | null; savedAt: string | null } | null

const KINDS: { kind: Kind; label: string; hint: string; accept: string; multiple?: boolean }[] = [
  { kind: 'ad', label: '광고', hint: 'pa_total_campaign .xlsx', accept: '.xlsx' },
  { kind: 'seller', label: '3P 판매', hint: 'SELLER_INSIGHTS .xlsx', accept: '.xlsx' },
  { kind: 'onep_sales', label: '1P 판매', hint: '로켓 판매 .csv', accept: '.csv' },
  { kind: 'po', label: '1P 발주서', hint: '발주서리스트 .zip / 여러 .xlsx', accept: '.zip,.xlsx', multiple: true },
  { kind: 'mr_settle', label: '밀크런 정산', hint: 'milkrun_sales .xls', accept: '.xls,.html,.htm' },
  { kind: 'mr_list', label: '밀크런 접수 내역', hint: 'milkrun_list .xls', accept: '.xls,.html,.htm' },
]

const thisMonth = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)
const won = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`)
const man = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${(n / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}만`)
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`)

/** 광고 행 → 1P 계산에 필요한 필드만 합친 요약 (캠페인·광고옵션·전환옵션·판매방식 단위) */
function compactAdRows(rows: AdCampaignRow[]): AdCampaignRow[] {
  const m = new Map<string, AdCampaignRow>()
  for (const r of rows) {
    const k = [r.campaignId, r.adOptionId, r.convOptionId, r.saleMethod || ''].join('|')
    const a = m.get(k)
    if (a) {
      a.adCost += r.adCost || 0
      a.sold14d += r.sold14d || 0
      a.revenue14d += r.revenue14d || 0
      a.clicks += r.clicks || 0
      a.orders14d += r.orders14d || 0
    } else {
      m.set(k, {
        ...r, keyword: '', placement: '', adGroup: '', impressions: 0,
        directRevenue14d: 0, indirectRevenue14d: 0,
      })
    }
  }
  return Array.from(m.values())
}

export default function CoupangPnlPanel(props: {
  summary3P: any | null
  storeAdRows: AdCampaignRow[]
  storeHasSeller: boolean
  onePRows?: OnePMarginRow[]
  marginRows?: MarginCalcRow[]
  onAd: (rows: AdCampaignRow[], meta: any, period: any) => void
  onSeller: (rows: any[], meta: any) => void
}) {
  const [month, setMonth] = useState(thisMonth())
  const [saved, setSaved] = useState<Record<Kind, Saved>>({ ad: null, seller: null, onep_sales: null, po: null, mr_settle: null, mr_list: null })
  const [busy, setBusy] = useState<Kind | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // 월 바뀌면 그 달 저장본 로드
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const next: Record<Kind, Saved> = { ad: null, seller: null, onep_sales: null, po: null, mr_settle: null, mr_list: null }
      await Promise.all(KINDS.map(async ({ kind }) => {
        try {
          const r = await fetch(`/api/coupang-master?type=pnl_${kind}_${month}`)
          const j = await r.json()
          if (j?.data) next[kind] = { data: j.data, fileName: j.fileName, savedAt: j.savedAt }
        } catch { /* 없음 */ }
      }))
      if (cancelled) return
      setSaved(next)
      // 3P 판매 저장본은 수익 진단 저장소가 비어 있을 때만 주입 (기존 흐름 우선)
      if (next.seller?.data?.rows?.length && !props.storeHasSeller) {
        props.onSeller(next.seller.data.rows, { fileName: next.seller.fileName || '저장본', uploadedAt: next.seller.savedAt, rowCount: next.seller.data.rows.length })
      }
    })()
    return () => { cancelled = true }
  }, [month]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (kind: Kind, data: any, fileName: string) => {
    const res = await fetch('/api/coupang-master', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: `pnl_${kind}_${month}`, data, fileName }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `저장 실패 (${res.status})`)
    setSaved((s) => ({ ...s, [kind]: { data, fileName, savedAt: new Date().toISOString() } }))
  }

  const onFiles = async (kind: Kind, files: FileList | null) => {
    if (!files || !files.length) return
    setBusy(kind)
    setMsg(null)
    try {
      const f = files[0]
      if (kind === 'ad') {
        const r = parseAdCampaign(await f.arrayBuffer(), f.name)
        if (r.missingColumns.length) throw new Error(`광고 파일 열 누락: ${r.missingColumns.join(', ')}`)
        props.onAd(r.rows, { fileName: f.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length },
          r.startDate && r.endDate ? { startDate: r.startDate, endDate: r.endDate, days: r.periodDays || 30 } : null)
        await save('ad', { rows: compactAdRows(r.rows), startDate: r.startDate, endDate: r.endDate }, f.name)
      } else if (kind === 'seller') {
        const r = parseSalesInsight(await f.arrayBuffer())
        const rows = (r as any).rows || []
        if (!rows.length) throw new Error((r as any).error || '3P 판매 행이 없습니다')
        props.onSeller(rows, { fileName: f.name, uploadedAt: new Date().toISOString(), rowCount: rows.length })
        await save('seller', { rows }, f.name)
      } else if (kind === 'onep_sales') {
        const r = parseOnePSalesCsv(await f.text())
        if (r.error) throw new Error(r.error)
        await save('onep_sales', { rows: r.rows }, f.name)
      } else if (kind === 'po') {
        const list = await Promise.all(Array.from(files).map(async (x) => ({ name: x.name, buf: await x.arrayBuffer() })))
        const r = await parsePurchaseOrderFiles(list)
        if (!r.orders.length) throw new Error('발주서를 찾지 못했습니다')
        await save('po', { orders: r.orders }, list.map((x) => x.name).join(', '))
        if (r.skipped.length) setMsg(`발주서로 읽지 못한 파일 ${r.skipped.length}개: ${r.skipped.slice(0, 3).join(', ')}`)
      } else if (kind === 'mr_settle') {
        const r = parseMilkrunSettlement(await f.text())
        if (r.error) throw new Error(r.error)
        await save('mr_settle', { rows: r.rows, total: r.total, headerTotal: r.headerTotal }, f.name)
      } else if (kind === 'mr_list') {
        const r = parseMilkrunList(await f.text())
        if (r.error) throw new Error(r.error)
        await save('mr_list', { rows: r.rows }, f.name)
      }
    } catch (e: any) {
      setMsg(`${KINDS.find((k) => k.kind === kind)?.label}: ${e?.message || e}`)
    } finally {
      setBusy(null)
    }
  }

  // ── 계산 ──
  const adRows: AdCampaignRow[] | null = saved.ad?.data?.rows || (props.storeAdRows.length ? props.storeAdRows : null)
  const onePView = useMemo(() => (adRows ? build1PView(adRows, props.onePRows, props.marginRows) : null), [adRows, props.onePRows, props.marginRows])
  const pnl = useMemo(() => computeOnePPnl({
    month,
    onePRows: props.onePRows,
    orders: (saved.po?.data?.orders as PurchaseOrder[]) || null,
    settle: (saved.mr_settle?.data?.rows as MilkrunSettleRow[]) || null,
    list: (saved.mr_list?.data?.rows as MilkrunListRow[]) || null,
    adView: onePView,
    sales: (saved.onep_sales?.data?.rows as OnePSalesRow[]) || null,
    extraNames: (adRows || []).flatMap((r) => [{ optionId: r.convOptionId, name: r.convProductName }, { optionId: r.adOptionId, name: r.adProductName }]),
  }), [month, props.onePRows, saved, onePView, adRows])

  const s3 = props.summary3P
  const net3P: number | null = s3 ? s3.totalNetProfit : null
  const rev3P: number | null = s3 ? s3.totalRevenue : null
  const margin3P: number | null = s3 ? s3.totalMargin : null
  const ad3P: number | null = s3 ? s3.totalAdCost : null
  const adRev3P: number | null = s3 ? (s3.totalAdRevenueSelf || s3.totalAdRevenue || 0) : null
  const organic3P: number | null = s3 ? s3.totalOrganicRevenue : null

  const need1P: string[] = []
  if (!props.onePRows?.length) need1P.push('1P 마진(나무_마스터)')
  if (!saved.po) need1P.push('1P 발주서')
  if (!saved.mr_settle) need1P.push('밀크런 정산')
  if (!saved.mr_list) need1P.push('밀크런 접수 내역')
  if (!adRows) need1P.push('광고')
  const net1P = pnl.netProfit
  const total = net3P != null && net1P != null ? net3P + net1P : null
  const revTotal = rev3P != null && pnl.inbound ? rev3P + pnl.inbound.revenue : null
  const monthLabel = `${Number(month.slice(5, 7))}월`

  const steps = revTotal != null && margin3P != null && pnl.inbound && pnl.milkrun && ad3P != null && pnl.adCost != null ? [
    { label: '매출 합계', value: revTotal, color: '#3B82F6' },
    { label: '원가·포장·배송·수수료', value: -(revTotal - (margin3P + pnl.inbound.margin)), color: '#94A3B8' },
    { label: '밀크런 운송비', value: -pnl.milkrun.allocated, color: '#F59E0B' },
    { label: '광고비(부가포함)', value: -(ad3P + pnl.adCost), color: '#EF4444' },
    { label: '순이익', value: total ?? 0, color: (total ?? 0) >= 0 ? '#10B981' : '#DC2626' },
  ] : null
  const stepMax = steps ? Math.max(...steps.map((x) => Math.abs(x.value)), 1) : 1

  const gmv1P = pnl.sales?.gmv ?? null
  const adRev1P = pnl.adRevenue
  const need = (label: string) => <span className="text-sm text-amber-700">{label} 파일 필요</span>

  return (
    <div className="mb-8">
      {/* 월 선택 + 파일 막대 */}
      <div className="mb-4 rounded-xl border bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-3">
          <label className="text-sm font-semibold text-gray-700">월</label>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="rounded border px-2 py-1 text-sm" />
          <span className="text-xs text-gray-400">올린 파일은 이 달 기준으로 저장되고, 다시 열면 자동으로 불러옵니다</span>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          {KINDS.map(({ kind, label, hint, accept, multiple }) => {
            const sv = saved[kind]
            const live = (kind === 'ad' && !sv && props.storeAdRows.length > 0) || (kind === 'seller' && !sv && props.storeHasSeller)
            return (
              <label key={kind} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${sv ? 'border-green-300 bg-green-50' : live ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
                <div className="flex items-center justify-between font-semibold text-gray-800">
                  <span>{label}</span>
                  <span>{busy === kind ? '…' : sv ? '✓' : live ? '·' : '＋'}</span>
                </div>
                <div className="mt-0.5 truncate text-gray-500" title={sv?.fileName || hint}>
                  {sv ? `${sv.fileName || ''}` : live ? '진단 데이터 사용 중 (월 저장 전)' : hint}
                </div>
                {sv?.savedAt && <div className="text-[10px] text-gray-400">저장 {String(sv.savedAt).slice(0, 10)}</div>}
                <input type="file" accept={accept} multiple={multiple} className="hidden" onChange={(e) => { onFiles(kind, e.target.files); e.currentTarget.value = '' }} />
              </label>
            )
          })}
        </div>
        {msg && <div className="mt-2 rounded bg-red-50 px-3 py-1.5 text-xs text-red-700">{msg}</div>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 순이익 */}
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold text-gray-600">{monthLabel} 쿠팡 순이익</div>
          <div className={`mt-1 text-3xl font-bold ${total != null && total < 0 ? 'text-red-600' : 'text-gray-900'}`}>
            {total != null ? won(total) : <span className="text-lg text-amber-700">{net3P == null ? '3P 판매 파일 필요' : `${need1P.join('·')} 필요`}</span>}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-gray-600">
            <div>3P<br /><b className="text-sm text-gray-900">{net3P != null ? won(net3P) : need('3P 판매')}</b></div>
            <div>1P (입고 기준)<br /><b className="text-sm text-gray-900">{net1P != null ? won(net1P) : <span className="text-amber-700">{need1P.join('·')} 필요</span>}</b></div>
            <div>순이익률<br /><b className="text-sm text-gray-900">{total != null && revTotal ? pct(total / revTotal) : '—'}</b></div>
          </div>
          {steps && (
            <div className="mt-4 space-y-1.5">
              {steps.map((st) => (
                <div key={st.label} className="flex items-center gap-2 text-xs">
                  <div className="w-36 shrink-0 text-gray-600">{st.label}</div>
                  <div className="h-3 flex-1 rounded bg-gray-100">
                    <div className="h-3 rounded" style={{ width: `${(Math.abs(st.value) / stepMax) * 100}%`, background: st.color }} />
                  </div>
                  <div className="w-24 shrink-0 text-right tabular-nums">{st.value < 0 ? '−' : ''}{man(Math.abs(st.value))}</div>
                </div>
              ))}
            </div>
          )}
          {pnl.milkrun && pnl.milkrun.unallocated > 0 && (
            <div className="mt-2 text-[11px] text-amber-700">
              밀크런 미배분 {won(pnl.milkrun.unallocated)} (이 달 입고 발주에 연결 안 됨 — 순이익에서 빠짐)
            </div>
          )}
          {saved.mr_settle?.data?.headerTotal != null && Math.abs(saved.mr_settle.data.headerTotal - (saved.mr_settle.data.total || 0)) > 1 && (
            <div className="text-[11px] text-amber-700">밀크런 정산 표 합계 {won(saved.mr_settle.data.total)} ≠ 파일 상단 총 금액 {won(saved.mr_settle.data.headerTotal)} (미확정 행 포함 추정)</div>
          )}
          <div className="mt-3 text-[11px] text-gray-400">
            반품·쿠폰 분담·판매장려금 등 정산 차감 전 손익 · 3P = 현재 수익 진단 데이터 · 1P = 입고예정일 {monthLabel} 발주 기준
          </div>
        </div>

        {/* 매출 구조 */}
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold text-gray-600">매출 구조</div>
          {rev3P != null && gmv1P != null ? (
            <div className="mt-3">
              <div className="flex h-5 overflow-hidden rounded">
                <div style={{ width: `${(rev3P / (rev3P + gmv1P)) * 100}%` }} className="bg-sky-400" />
                <div style={{ width: `${(gmv1P / (rev3P + gmv1P)) * 100}%` }} className="bg-violet-400" />
              </div>
              <div className="mt-1 flex justify-between text-xs text-gray-600">
                <span>3P {man(rev3P)} ({pct(rev3P / (rev3P + gmv1P))})</span>
                <span>1P {man(gmv1P)} ({pct(gmv1P / (rev3P + gmv1P))})</span>
              </div>
            </div>
          ) : (
            <div className="mt-3">{rev3P == null ? need('3P 판매') : need('1P 판매')}</div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-gray-600">
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="font-semibold text-gray-700">광고 의존도 (광고 매출 ÷ 판매 매출)</div>
              <div className="mt-1">3P <b>{rev3P ? pct((adRev3P || 0) / rev3P) : '—'}</b></div>
              <div>1P <b>{gmv1P && adRev1P != null ? pct(adRev1P / gmv1P) : '—'}</b></div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="font-semibold text-gray-700">자연 매출</div>
              <div className="mt-1">3P <b>{organic3P != null ? man(organic3P) : '—'}</b></div>
              <div>1P <b>{gmv1P != null && adRev1P != null ? man(Math.max(0, gmv1P - adRev1P)) : '—'}</b></div>
            </div>
          </div>
          <div className="mt-3 text-[11px] text-gray-400">1P 판매 매출 = 로켓 판매 GMV · 1P 광고 매출 = 광고센터 전환매출(판매수 = 봉)</div>
          {pnl.sales && pnl.sales.unlinked.length > 0 && (
            <div className="mt-2 text-[11px] text-amber-700">1P 판매 옵션 {pnl.sales.unlinked.length}개 SKU 연결 못 함 (봉수 집계 제외)</div>
          )}
        </div>
      </div>
    </div>
  )
}
