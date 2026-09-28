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
import { parseAdCampaign, extractPeriodFromFileName, type AdCampaignRow } from '@/lib/coupang/parsers/adCampaign'
import { parseSalesInsight } from '@/lib/coupang/parsers/salesInsight'
import { parseOnePSalesCsv, type OnePSalesRow } from '@/lib/coupang/parsers/onePSales'
import type { PurchaseOrder } from '@/lib/coupang/parsers/purchaseOrder'
import { parseRocketLedger, ledgerToOrders, splitLedgerByMonth, type RocketLedgerRow } from '@/lib/coupang/parsers/rocketLedger'
import { parseMilkrunSettlement, parseMilkrunList, type MilkrunSettleRow, type MilkrunListRow } from '@/lib/coupang/parsers/milkrun'
import { build1PView } from '@/lib/coupang/onePAnalysis'
import { packAdRows, unpackAdRows } from '@/lib/coupang/adRowsPack'
import { computeOnePPnl } from '@/lib/coupang/onePPnl'
import type { OnePMarginRow, MarginCalcRow } from '@/lib/coupang/parsers/marginMaster'

type Kind = 'ad' | 'seller' | 'onep_sales' | 'ledger' | 'mr_settle' | 'mr_list'
const EMPTY = <T,>(v: T): Record<Kind, T> => ({ ad: v, seller: v, onep_sales: v, ledger: v, mr_settle: v, mr_list: v })
type Saved = { data: any; fileName: string | null; savedAt: string | null } | null

const KINDS: { kind: Kind; label: string; hint: string; accept: string; multiple?: boolean; optional?: boolean }[] = [
  { kind: 'ad', label: '광고', hint: 'pa_total_campaign .xlsx', accept: '.xlsx' },
  { kind: 'seller', label: '3P 판매', hint: 'SELLER_INSIGHTS .xlsx', accept: '.xlsx' },
  { kind: 'onep_sales', label: '1P 판매', hint: '로켓 판매 .csv', accept: '.csv' },
  { kind: 'ledger', label: '1P 입고 원장', hint: '로켓_세일즈 .xlsx (여러 달 → 달별 저장)', accept: '.xlsx' },
  { kind: 'mr_settle', label: '밀크런 정산', hint: 'milkrun_sales .xls', accept: '.xls,.html,.htm' },
  { kind: 'mr_list', label: '밀크런 접수 내역', hint: 'milkrun_list .xls', accept: '.xls,.html,.htm', optional: true },
]

const thisMonth = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)
const won = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`)
const man = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : `${(n / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}만`)
const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : e && typeof e === 'object' ? ((e as any).message || JSON.stringify(e)) : String(e)
const rowCountOf = (d: any): number | null => (Array.isArray(d?.rows) ? d.rows.length : Array.isArray(d?.orders) ? d.orders.length : null)
const stamp = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString()
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`
}
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
  /** 수익 진단 저장소의 3P 판매 행 — "이 데이터로 저장" 용 */
  storeSellerRows?: any[]
  onePRows?: OnePMarginRow[]
  marginRows?: MarginCalcRow[]
  onAd: (rows: AdCampaignRow[], meta: any, period: any) => void
  onSeller: (rows: any[], meta: any) => void
  /** 선택 월에 광고·3P 판매 저장본이 없을 때 — 수익 진단 저장소 비우기 */
  onMonthEmpty?: () => void
}) {
  const [month, setMonth] = useState(thisMonth())
  const [saved, setSaved] = useState<Record<Kind, Saved>>(EMPTY(null))
  // 올렸지만 월 저장 못 한 파싱 결과 (저장 실패해도 계산엔 사용) · 칸별 오류 문장
  const [pending, setPending] = useState<Record<Kind, { data: any; fileName: string; kw?: AdCampaignRow[] } | null>>(EMPTY(null))
  const [errors, setErrors] = useState<Record<Kind, string | null>>(EMPTY(null))
  // 옛 발주서(zip) 월 저장본 — 그 달 원장이 없을 때만 1P 입고 계산에 사용
  const [legacyPo, setLegacyPo] = useState<PurchaseOrder[] | null>(null)
  const [busy, setBusy] = useState<Kind | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // 월 바뀌면 그 달 저장본 로드
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const next: Record<Kind, Saved> = EMPTY(null)
      await Promise.all(KINDS.map(async ({ kind }) => {
        try {
          const r = await fetch(`/api/coupang-master?type=pnl_${kind}_${month}`)
          const j = await r.json()
          if (j?.data) next[kind] = { data: j.data, fileName: j.fileName, savedAt: j.savedAt }
        } catch { /* 없음 */ }
      }))
      let po: PurchaseOrder[] | null = null
      if (!next.ledger) {
        try {
          const j = await (await fetch(`/api/coupang-master?type=pnl_po_${month}`)).json()
          if (Array.isArray(j?.data?.orders) && j.data.orders.length) po = j.data.orders
        } catch { /* 없음 */ }
      }
      // 키워드 포함 광고 행 (광고 분석과 같은 데이터) — 있으면 수익 진단에 요약 대신 주입
      let kwRows: AdCampaignRow[] = []
      if (next.ad) {
        try {
          const j = await (await fetch(`/api/coupang-master?type=pnl_adkw_${month}`)).json()
          kwRows = unpackAdRows(j?.data)
        } catch { /* 없음 → 요약 사용 */ }
      }
      if (cancelled) return
      setSaved(next)
      setLegacyPo(po)
      setPending(EMPTY(null))
      setErrors(EMPTY(null))
      // 그 달 저장본을 아래 수익 진단(3P)에도 주입 — 광고 요약 행 + 광고 기간 → SELLER 순서.
      // 광고 요약(캠페인·광고옵션·전환옵션·판매방식 단위 합계)은 3P 진단이 쓰는 열(광고비·14일 매출·판매수·옵션ID)을 다 가져 결과가 원본과 같다.
      const ad = next.ad
      if (ad?.data?.rows?.length) {
        const fromName = extractPeriodFromFileName(ad.fileName || '')
        const start: string | null = ad.data.startDate || fromName?.startDate || null
        const end: string | null = ad.data.endDate || fromName?.endDate || null
        const days = start && end ? Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1 : null
        const rows = kwRows.length ? kwRows : ad.data.rows
        props.onAd(rows, { fileName: `${ad.fileName || '광고'} (${month} 월 저장본)`, uploadedAt: ad.savedAt, rowCount: rows.length },
          start && end && days ? { startDate: start, endDate: end, days } : null)
      }
      if (next.seller?.data?.rows?.length) {
        props.onSeller(next.seller.data.rows, { fileName: next.seller.fileName || '저장본', uploadedAt: next.seller.savedAt, rowCount: next.seller.data.rows.length })
      }
      // 그 달 저장본이 하나도 없으면 다른 달 데이터가 남지 않게 수익 진단 광고·판매를 비움
      if (!ad?.data?.rows?.length && !next.seller?.data?.rows?.length) props.onMonthEmpty?.()
    })()
    return () => { cancelled = true }
  }, [month]) // eslint-disable-line react-hooks/exhaustive-deps

  const postPnl = async (type: string, data: any, fileName: string, m: string = month) => {
    let res: Response
    try {
      res = await fetch('/api/coupang-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: `pnl_${type}_${m}`, data, fileName }),
      })
    } catch (e) {
      throw new Error(`월 저장 실패 — 서버 연결 안 됨 (${errMsg(e)})`)
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      const why = j?.error == null ? '' : typeof j.error === 'string' ? j.error : errMsg(j.error)
      throw new Error(`월 저장 실패 (${res.status})${why ? ` — ${why}` : ''}`)
    }
  }
  /** kw = 광고 원본 행 (키워드 포함) — 광고 칸이면 압축해 pnl_adkw 로 함께 저장 (광고 분석이 읽음) */
  const save = async (kind: Kind, data: any, fileName: string, kw?: AdCampaignRow[]) => {
    setPending((p) => ({ ...p, [kind]: { data, fileName, kw } }))
    if (kind === 'ad' && kw?.length) await postPnl('adkw', packAdRows(kw), fileName)
    await postPnl(kind, data, fileName)
    setSaved((s) => ({ ...s, [kind]: { data, fileName, savedAt: new Date().toISOString() } }))
    setPending((p) => ({ ...p, [kind]: null }))
  }
  /** 노랑 칸 "이 데이터로 저장" — 올렸지만 저장 못 한 파일 또는 수익 진단 화면 데이터 */
  const saveCurrent = async (kind: Kind) => {
    setBusy(kind)
    setErrors((e) => ({ ...e, [kind]: null }))
    try {
      const p = pending[kind]
      if (p) await save(kind, p.data, p.fileName, p.kw)
      else if (kind === 'ad' && props.storeAdRows.length) await save('ad', { rows: compactAdRows(props.storeAdRows) }, '수익 진단 광고 데이터', props.storeAdRows)
      else if (kind === 'seller' && props.storeSellerRows?.length) await save('seller', { rows: props.storeSellerRows }, '수익 진단 3P 판매 데이터')
    } catch (e) {
      setErrors((x) => ({ ...x, [kind]: errMsg(e) }))
    } finally {
      setBusy(null)
    }
  }
  const onFiles = async (kind: Kind, files: FileList | null) => {
    if (!files || !files.length) return
    setBusy(kind)
    setMsg(null)
    setErrors((e) => ({ ...e, [kind]: null }))
    try {
      const f = files[0]
      if (kind === 'ad') {
        const r = parseAdCampaign(await f.arrayBuffer(), f.name)
        if (r.missingColumns.length) throw new Error(`광고 파일 열 누락: ${r.missingColumns.join(', ')}`)
        props.onAd(r.rows, { fileName: f.name, uploadedAt: new Date().toISOString(), rowCount: r.rows.length },
          r.startDate && r.endDate ? { startDate: r.startDate, endDate: r.endDate, days: r.periodDays || 30 } : null)
        const per = r.startDate && r.endDate ? { startDate: r.startDate, endDate: r.endDate } : extractPeriodFromFileName(f.name)
        await save('ad', { rows: compactAdRows(r.rows), startDate: per?.startDate ?? null, endDate: per?.endDate ?? null }, f.name, r.rows)
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
      } else if (kind === 'ledger') {
        // 원장은 여러 달이 들어 있으므로 입고 월별로 나눠 각 달 pnl_ledger_YYYY-MM 에 저장 (선택 월은 칸 상태로)
        const r = parseRocketLedger(await f.arrayBuffer())
        if (r.error) throw new Error(r.error)
        if (!r.rows.length) throw new Error('입고(구분=발주) 행이 없습니다')
        const byMonth = splitLedgerByMonth(r.rows)
        const months = Object.keys(byMonth).sort()
        for (const m of months) if (m !== month) await postPnl('ledger', { rows: byMonth[m] }, f.name, m)
        if (byMonth[month]) await save('ledger', { rows: byMonth[month] }, f.name)
        const label = months.map((m) => `${Number(m.slice(5, 7))}월`).join('·')
        setMsg(`입고 원장 ${months.length}개월 저장: ${label}${byMonth[month] ? '' : ` — 선택한 ${Number(month.slice(5, 7))}월 입고는 없음`}${r.skipped ? ` · 발주 외 행 ${r.skipped}개 제외` : ''}`)
      } else if (kind === 'mr_settle') {
        const r = parseMilkrunSettlement(await f.text())
        if (r.error) throw new Error(r.error)
        await save('mr_settle', { rows: r.rows, total: r.total, headerTotal: r.headerTotal }, f.name)
      } else if (kind === 'mr_list') {
        const r = parseMilkrunList(await f.text())
        if (r.error) throw new Error(r.error)
        await save('mr_list', { rows: r.rows }, f.name)
      }
    } catch (e) {
      setErrors((x) => ({ ...x, [kind]: errMsg(e) }))
    } finally {
      setBusy(null)
    }
  }

  // ── 계산 (월 저장본 → 올렸지만 저장 못 한 파일 순) ──
  const cur = (k: Kind): any => saved[k]?.data ?? pending[k]?.data ?? null
  const adRows: AdCampaignRow[] | null = cur('ad')?.rows || (props.storeAdRows.length ? props.storeAdRows : null)
  const onePView = useMemo(() => (adRows ? build1PView(adRows, props.onePRows, props.marginRows) : null), [adRows, props.onePRows, props.marginRows])
  const pnl = useMemo(() => computeOnePPnl({
    month,
    onePRows: props.onePRows,
    orders: cur('ledger')?.rows ? ledgerToOrders(cur('ledger').rows as RocketLedgerRow[]) : legacyPo,
    settle: (cur('mr_settle')?.rows as MilkrunSettleRow[]) || null,
    list: (cur('mr_list')?.rows as MilkrunListRow[]) || null,
    adView: onePView,
    sales: (cur('onep_sales')?.rows as OnePSalesRow[]) || null,
    extraNames: (adRows || []).flatMap((r) => [{ optionId: r.convOptionId, name: r.convProductName }, { optionId: r.adOptionId, name: r.adProductName }]),
  }), [month, props.onePRows, saved, pending, legacyPo, onePView, adRows]) // eslint-disable-line react-hooks/exhaustive-deps

  const s3 = props.summary3P
  const net3P: number | null = s3 ? s3.totalNetProfit : null
  const rev3P: number | null = s3 ? s3.totalRevenue : null
  const margin3P: number | null = s3 ? s3.totalMargin : null
  const ad3P: number | null = s3 ? s3.totalAdCost : null
  const adRev3P: number | null = s3 ? (s3.totalAdRevenueSelf || s3.totalAdRevenue || 0) : null
  const organic3P: number | null = s3 ? s3.totalOrganicRevenue : null

  const need1P: string[] = []
  if (!props.onePRows?.length) need1P.push('1P 마진(나무_마스터)')
  if (!cur('ledger') && !legacyPo) need1P.push('1P 입고 원장')
  if (!cur('mr_settle')) need1P.push('밀크런 정산')
  if (!adRows) need1P.push('광고')
  const net1P = pnl.netProfit
  const total = net3P != null && net1P != null ? net3P + net1P : null
  const revTotal = rev3P != null && pnl.inbound ? rev3P + pnl.inbound.revenue : null
  const monthLabel = `${Number(month.slice(5, 7))}월`

  const steps = revTotal != null && margin3P != null && pnl.inbound && pnl.milkrun && ad3P != null && pnl.adCost != null ? [
    { label: '매출 합계', value: revTotal, color: '#3B82F6' },
    { label: '원가·포장·배송·수수료', value: -(revTotal - (margin3P + pnl.inbound.margin)), color: '#94A3B8' },
    { label: '밀크런 운송비', value: -(pnl.milkrun.allocated + pnl.milkrun.estimated), color: '#F59E0B' },
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
          {KINDS.map(({ kind, label, hint, accept, multiple, optional }) => {
            const sv = saved[kind]
            const pd = pending[kind]
            const err = errors[kind]
            const live = !pd && ((kind === 'ad' && props.storeAdRows.length > 0) || (kind === 'seller' && props.storeHasSeller))
            // 초록: 월 저장 완료 · 빨강: 실패 · 노랑: 저장 전(올린 파일 또는 다른 화면 데이터) · 회색: 없음
            const state: 'green' | 'red' | 'yellow' | 'gray' = err ? 'red' : sv && !pd ? 'green' : pd || live ? 'yellow' : 'gray'
            const box = { green: 'border-green-300 bg-green-50', red: 'border-red-400 bg-red-50', yellow: 'border-amber-300 bg-amber-50', gray: 'border-gray-200 bg-gray-50' }[state]
            const canSave = !!pd || (kind === 'ad' && props.storeAdRows.length > 0) || (kind === 'seller' && !!props.storeSellerRows?.length)
            const n = rowCountOf(sv?.data)
            return (
              <label key={kind} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${box}`}>
                <div className="flex items-center justify-between font-semibold text-gray-800">
                  <span>{label}{optional && <span className="ml-1 font-normal text-gray-400">(선택)</span>}</span>
                  <span>{busy === kind ? '…' : state === 'green' ? '✓' : state === 'red' ? '!' : state === 'yellow' ? '·' : '＋'}</span>
                </div>
                {state === 'green' && sv ? (
                  <div className="mt-0.5 truncate text-green-800" title={sv.fileName || ''}>
                    ✓ {sv.fileName || ''}{n != null ? ` · ${n.toLocaleString('ko-KR')}행` : ''}{sv.savedAt ? ` · ${stamp(sv.savedAt)}` : ''}
                  </div>
                ) : (
                  <div className="mt-0.5 truncate text-gray-500" title={pd?.fileName || sv?.fileName || hint}>
                    {pd ? `${pd.fileName} (월 저장 전)` : live ? '수익 진단 데이터 사용 중 (월 저장 전)' : sv ? sv.fileName : hint}
                  </div>
                )}
                {err && <div className="mt-1 whitespace-normal break-all text-[11px] text-red-700">{err}</div>}
                {(state === 'yellow' || state === 'red') && canSave && (
                  <button
                    type="button"
                    disabled={busy === kind}
                    className="mt-1 rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); saveCurrent(kind) }}
                  >이 데이터로 저장</button>
                )}
                <input type="file" accept={accept} multiple={multiple} className="hidden" onChange={(e) => { onFiles(kind, e.target.files); e.currentTarget.value = '' }} />
              </label>
            )
          })}
        </div>
        {msg && <div className="mt-2 rounded bg-gray-50 px-3 py-1.5 text-xs text-gray-700">{msg}</div>}
        {!cur('ledger') && legacyPo && (
          <div className="mt-2 rounded bg-amber-50 px-3 py-1.5 text-xs text-amber-800">이 달은 입고 원장이 없어 옛 발주서(zip) 저장본(입고예정일 기준)으로 1P 입고를 계산 중 — 로켓_세일즈 원장을 올리면 실제 입고일 기준으로 바뀝니다</div>
        )}
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
          {pnl.milkrun && (
            <div className="mt-2 text-[11px] text-gray-600">
              {pnl.milkrun.mode === 'settle'
                ? <>밀크런 운송비 {won(pnl.milkrun.allocated)} — 접수 내역 없음: 정산 픽업일 {monthLabel} 합계 (상품별 배분 없음)</>
                : <>운송비 확정 {won(pnl.milkrun.allocated)} + <span className="text-amber-700">추정 {won(pnl.milkrun.estimated)}</span>
                  {pnl.milkrun.estimated > 0 && <> (운송비 연결 안 된 발주 {pnl.milkrun.estimatedBags.toLocaleString('ko-KR')}봉 × 이번 달 평균 봉당 운송비 — 정산 파일 다시 올리면 실제 값으로 바뀜)</>}</>}
            </div>
          )}
          {pnl.milkrun && pnl.milkrun.mode === 'list' && pnl.milkrun.unallocated > 0 && (
            <div className="mt-2 text-[11px] text-amber-700">
              밀크런 미배분 {won(pnl.milkrun.unallocated)} (이 달 입고 발주에 연결 안 됨 — 순이익에서 빠짐)
            </div>
          )}
          {cur('mr_settle')?.headerTotal != null && Math.abs(cur('mr_settle').headerTotal - (cur('mr_settle').total || 0)) > 1 && (
            <div className="text-[11px] text-amber-700">밀크런 정산 표 합계 {won(cur('mr_settle').total)} ≠ 파일 상단 총 금액 {won(cur('mr_settle').headerTotal)} (미확정 행 포함 추정)</div>
          )}
          <div className="mt-3 text-[11px] text-gray-400">
            반품·쿠폰 분담·판매장려금 등 정산 차감 전 손익 · 3P = 현재 수익 진단 데이터 · 1P = {cur('ledger') ? `실제 입고일 ${monthLabel} 기준 (로켓_세일즈 원장)` : legacyPo ? `입고예정일 ${monthLabel} 발주 기준 (옛 발주서)` : '입고 원장 필요'}
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
