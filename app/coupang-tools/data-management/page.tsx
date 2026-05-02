'use client'

/**
 * 쿠팡 데이터 관리 페이지 (v4 - Supabase 연동)
 *
 * 자주 안 바뀌는 마스터 데이터를 등록·관리:
 *   - 마진 마스터 (마진분석.xlsx)
 *   - 그로스 정산 (WAREHOUSING_SHIPPING)
 *   - 가격/재고 (price_inventory)
 *
 * 저장: Supabase (dashboard_data 테이블, key=coupang_xxx)
 * 페이지 진입 시 자동 로드 → store에 주입
 */

import { useEffect, useState } from 'react'
import { useMarginStore } from '@/lib/coupang/store'
import { parseMarginMaster } from '@/lib/coupang/parsers/marginMaster'
import { parsePriceInventory } from '@/lib/coupang/parsers/priceInventory'
import { parseSettlement } from '@/lib/coupang/parsers/settlement'
import { parseNaverProductMatch } from '@/lib/naver/parsers/productMatch'
import { parseNaverMarginMaster } from '@/lib/naver/marginNaver'

type LoadingState = 'idle' | 'loading' | 'saving' | 'success' | 'error'

export default function DataManagementPage() {
  const {
    marginMaster, marginMasterStats, uploads,
    setMarginMaster, setPriceInventory, setSettlement,
  } = useMarginStore()

  const [initialLoading, setInitialLoading] = useState(true)
  const [savingState, setSavingState] = useState<{ [key: string]: LoadingState }>({})

  useEffect(() => {
    loadAllFromSupabase()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAllFromSupabase() {
    setInitialLoading(true)
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
    } catch (err) {
      console.error('초기 로드 실패:', err)
    } finally {
      setInitialLoading(false)
    }
  }

  async function saveToSupabase(type: string, data: any, fileName: string) {
    setSavingState(s => ({ ...s, [type]: 'saving' }))
    try {
      const res = await fetch('/api/coupang-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data, fileName }),
      })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.error || `HTTP ${res.status}`)
      }
      setSavingState(s => ({ ...s, [type]: 'success' }))
      setTimeout(() => setSavingState(s => ({ ...s, [type]: 'idle' })), 2000)
    } catch (err: any) {
      setSavingState(s => ({ ...s, [type]: 'error' }))
      alert('서버 저장 실패: ' + (err?.message || err))
    }
  }

  const handleMaster = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const r = parseMarginMaster(buf)
      if (r.error || !r.master) { alert('마진 마스터 파싱 실패: ' + r.error); return }

      setMarginMaster(r.master, {
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        rowCount: r.master.marginRows.length,
      })

      await saveToSupabase('margin_master', r.master, file.name)

      // 네이버 시트 2개 동시 파싱+저장 (Map → object 직렬화)
      try {
        const [naverMatch, naverMargin] = await Promise.all([
          parseNaverProductMatch(buf),
          parseNaverMarginMaster(buf),
        ])
        const matchObj = Object.fromEntries(naverMatch)
        const marginObj: Record<string, unknown[]> = {}
        for (const [k, v] of naverMargin) marginObj[k] = v
        await saveToSupabase('naver_match', matchObj, file.name)
        await saveToSupabase('naver_margin', marginObj, file.name)
      } catch (e) {
        console.warn('네이버 시트 파싱/저장 건너뜀:', e)
      }
    } catch (err: any) {
      alert('파싱 에러: ' + (err?.message || err))
    }
  }

  const handlePrice = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const r = await parsePriceInventory(buf)

      setPriceInventory(r.rows, {
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        rowCount: r.rows.length,
      })

      await saveToSupabase('price_inventory', { rows: r.rows }, file.name)
    } catch (err: any) {
      alert('파싱 에러: ' + (err?.message || err))
    }
  }

  const handleSettle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const r = parseSettlement(buf)

      setSettlement(r.rows, {
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        rowCount: r.rows.length,
      })

      await saveToSupabase('settlement', { rows: r.rows }, file.name)
    } catch (err: any) {
      alert('파싱 에러: ' + (err?.message || err))
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6 border-b pb-5">
          <h1 className="text-2xl font-bold tracking-tight">쿠팡 데이터 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            마스터 데이터를 등록·관리합니다 (한 번 등록하면 계속 사용)
          </p>
        </div>

        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="text-sm text-blue-900">
            💡 <strong>매월 진단</strong>은 「쿠팡 수익 진단」 페이지에서 광고·판매분석 파일만 업로드하면 됩니다.<br />
            여기 등록한 마스터 데이터가 자동으로 사용됩니다.
          </div>
          <div className="text-xs text-green-700 mt-2">
            ✅ Supabase 자동 저장: 새로고침해도 데이터가 유지됩니다.
          </div>
        </div>

        {initialLoading && (
          <div className="mb-6 text-center py-8 text-gray-500 text-sm">
            서버에서 데이터 불러오는 중...
          </div>
        )}

        {!initialLoading && (
          <>
            <DataCard
              number="1"
              title="마진 마스터"
              subtitle="마진분석.xlsx (3시트: 원가표 · 비용테이블 · 마진계산)"
              required
              loaded={!!marginMaster}
              status={uploads.marginMaster}
              savingState={savingState.margin_master || 'idle'}
              onChange={handleMaster}
              stats={marginMaster ? [
                { label: '원가표 상품', value: `${marginMasterStats.costBookRows}개` },
                { label: '옵션', value: `${marginMasterStats.marginRows}개` },
                { label: '실판매가 등록', value: `${marginMasterStats.optionsWithActualPrice}개` },
              ] : null}
              description="모든 상품의 원가, 실판매가, 순이익이 이 엑셀에서 옵니다. 새 상품 추가/원가 변경 시 갱신하세요."
            />

            <DataCard
              number="2"
              title="그로스 정산"
              subtitle="WAREHOUSING_SHIPPING.xlsx (쿠팡 → 정산 → 입출고/배송)"
              loaded={!!uploads.settlement}
              status={uploads.settlement}
              savingState={savingState.settlement || 'idle'}
              onChange={handleSettle}
              description="옵션별 그로스 비용 (배송비, 입출고비) 자동 매칭에 사용. 월 1회 다운로드 권장."
            />

            <DataCard
              number="3"
              title="가격/재고"
              subtitle="price_inventory.xlsx (쿠팡 → 상품관리 → 상품/가격 관리)"
              loaded={!!uploads.priceInventory}
              status={uploads.priceInventory}
              savingState={savingState.price_inventory || 'idle'}
              onChange={handlePrice}
              description="현재 판매가, 재고 수량 등. 재고 알림 기능 등에 사용 예정."
            />
          </>
        )}
      </div>
    </div>
  )
}

function DataCard(props: {
  number: string
  title: string
  subtitle: string
  required?: boolean
  loaded: boolean
  status: any
  savingState: LoadingState
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  stats?: Array<{ label: string; value: string }> | null
  description: string
}) {
  return (
    <div className={`mb-4 rounded-lg border-2 bg-white p-5 ${
      props.loaded ? 'border-green-300' : props.required ? 'border-orange-300' : 'border-gray-200'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
            props.loaded ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'
          }`}>
            {props.loaded ? '✓' : props.number}
          </div>
          <div>
            <div className="font-semibold text-base flex items-center gap-2">
              {props.title}
              {props.required && (
                <span className="text-xs px-2 py-0.5 bg-orange-100 text-orange-700 rounded">필수</span>
              )}
              {props.loaded && (
                <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">등록됨</span>
              )}
              {props.savingState === 'saving' && (
                <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">저장 중...</span>
              )}
              {props.savingState === 'success' && (
                <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">✓ 서버 저장됨</span>
              )}
              {props.savingState === 'error' && (
                <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded">⚠ 저장 실패</span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{props.subtitle}</div>
          </div>
        </div>
        <label className="px-4 py-2 rounded text-sm cursor-pointer hover:opacity-90 bg-gray-900 text-white">
          {props.loaded ? '교체 업로드' : '업로드'}
          <input type="file" accept=".xlsx,.xls" onChange={props.onChange} className="hidden" />
        </label>
      </div>

      {props.loaded && props.status && (
        <div className="text-xs text-gray-500 mb-2">
          📄 {props.status.fileName} · {new Date(props.status.uploadedAt).toLocaleString('ko-KR')}
        </div>
      )}

      {props.stats && (
        <div className="grid grid-cols-3 gap-3 mt-3 mb-3">
          {props.stats.map((s, i) => (
            <div key={i} className="bg-gray-50 rounded p-3">
              <div className="text-xs text-gray-500">{s.label}</div>
              <div className="text-lg font-semibold mt-0.5">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-gray-600 mt-2 pt-2 border-t border-gray-100">
        {props.description}
      </div>
    </div>
  )
}
