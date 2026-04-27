'use client'

/**
 * MasterDiagnosisView — 마진 마스터 단독 view
 *
 * 광고/SELLER 데이터 없이 마진 마스터(.xlsx) 만으로
 * 별칭별 옵션 카드 + 비용 분해 + 채널 필터 표시.
 */

import { useState, useMemo } from 'react'
import { useMarginStore } from '@/lib/coupang/store'
import { buildMasterView, type MasterOptionView } from '@/lib/coupang/marginView'

const fmt = (n: number | null | undefined): string =>
  (n === null || n === undefined || !Number.isFinite(n)) ? '-' : Math.round(n).toLocaleString('ko-KR')

const fmtPct = (n: number | null | undefined, digits = 1): string =>
  (n === null || n === undefined || !Number.isFinite(n)) ? '-' : `${(n * 100).toFixed(digits)}%`

const fmtRoas = (n: number | null | undefined): string =>
  (n === null || n === undefined || !Number.isFinite(n)) ? '-' : `${n.toFixed(2)}x`

type ChannelFilter = 'all' | '윙' | '그로스'

export default function MasterDiagnosisView() {
  const marginMaster = useMarginStore((s) => s.marginMaster)
  const view = useMemo(() => buildMasterView(marginMaster as any), [marginMaster])

  const [open, setOpen] = useState<boolean>(false)
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')
  const [expandedOptionId, setExpandedOptionId] = useState<string | null>(null)
  const [searchAlias, setSearchAlias] = useState<string>('')

  if (!view.loaded) {
    return (
      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        마진 마스터 엑셀이 로드되지 않았습니다. 「데이터 관리」 페이지에서 업로드해주세요.
      </div>
    )
  }

  const filteredGroups = view.groups
    .map((g) => ({
      ...g,
      options: channelFilter === 'all' ? g.options : g.options.filter((o) => o.channel === channelFilter),
    }))
    .filter((g) => g.options.length > 0)
    .filter((g) => !searchAlias.trim() || g.alias.toLowerCase().includes(searchAlias.toLowerCase()))

  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 rounded-t-lg"
      >
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold">📋 마진 마스터 옵션 분석</span>
          <span className="text-xs text-gray-500">
            {view.groups.length}개 별칭 · {view.totalOptions}개 옵션 · 윙 {view.totalChannels.윙} / 그로스 {view.totalChannels.그로스}
          </span>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲ 접기' : '▼ 펼치기'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-200 p-4">
          {/* 컨트롤 */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-600">채널:</span>
              {(['all', '윙', '그로스'] as ChannelFilter[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannelFilter(c)}
                  className={`px-2.5 py-1 rounded border ${channelFilter === c ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                >
                  {c === 'all' ? '전체' : c}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={searchAlias}
              onChange={(e) => setSearchAlias(e.target.value)}
              placeholder="별칭 검색..."
              className="text-xs px-2 py-1 border border-gray-300 rounded w-48"
            />
            <span className="text-xs text-gray-500 ml-auto">
              표시: {filteredGroups.length}개 별칭 · {filteredGroups.reduce((s, g) => s + g.options.length, 0)}개 옵션
            </span>
          </div>

          {/* 별칭 그룹별 표 */}
          <div className="space-y-4 max-h-[70vh] overflow-auto">
            {filteredGroups.map((g) => (
              <div key={g.alias} className="border border-gray-200 rounded">
                <div className="bg-gray-50 px-3 py-2 flex items-center justify-between border-b border-gray-200">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{g.alias}</span>
                    <span className="text-xs text-gray-500">
                      {g.optionCount}개 옵션 · 평균 마진율 {fmtPct(g.avgMarginRate)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    노출ID: {g.exposureIds.join(', ')}
                  </div>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-gray-100/50">
                    <tr>
                      <th className="px-2 py-1.5 text-left">옵션명</th>
                      <th className="px-2 py-1.5 text-left">채널</th>
                      <th className="px-2 py-1.5 text-left">규격</th>
                      <th className="px-2 py-1.5 text-right">실판매가</th>
                      <th className="px-2 py-1.5 text-right">원가</th>
                      <th className="px-2 py-1.5 text-right">총비용</th>
                      <th className="px-2 py-1.5 text-right">순이익</th>
                      <th className="px-2 py-1.5 text-right">마진율</th>
                      <th className="px-2 py-1.5 text-right">BEP ROAS</th>
                      <th className="px-2 py-1.5 text-center">분해</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.options.map((o) => {
                      const isOpen = expandedOptionId === o.optionId
                      return (
                        <FragmentRow
                          key={o.optionId}
                          o={o}
                          isOpen={isOpen}
                          onToggle={() => setExpandedOptionId(isOpen ? null : o.optionId)}
                        />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            {filteredGroups.length === 0 && (
              <div className="text-center py-8 text-sm text-gray-500">
                해당 채널/검색어에 맞는 옵션이 없습니다.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FragmentRow({ o, isOpen, onToggle }: { o: MasterOptionView; isOpen: boolean; onToggle: () => void }) {
  const profitClass = (o.netProfit ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'
  return (
    <>
      <tr className="border-t border-gray-100 hover:bg-blue-50/30">
        <td className="px-2 py-1.5 font-mono">{o.optionName}</td>
        <td className="px-2 py-1.5">
          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
            o.channel === '윙' ? 'bg-blue-100 text-blue-700' :
            o.channel === '그로스' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-700'
          }`}>{o.channel || '—'}</span>
        </td>
        <td className="px-2 py-1.5 text-gray-600">{o.size || '—'}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmt(o.actualPrice)}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmt(o.costPrice)}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmt(o.totalCost)}</td>
        <td className={`px-2 py-1.5 text-right font-mono font-medium ${profitClass}`}>{fmt(o.netProfit)}</td>
        <td className="px-2 py-1.5 text-right">{fmtPct(o.marginRate)}</td>
        <td className="px-2 py-1.5 text-right">{fmtRoas(o.bepRoas)}</td>
        <td className="px-2 py-1.5 text-center">
          <button
            onClick={onToggle}
            className="text-blue-600 hover:underline text-[11px]"
          >
            {isOpen ? '▲ 접기' : '▼ 보기'}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-gray-50/50 border-t border-gray-100">
          <td colSpan={10} className="px-3 py-2">
            <div className="grid grid-cols-4 gap-2 text-[11px]">
              <Cell label="원가" v={o.costPrice} />
              <Cell label="봉투" v={o.bagFee} />
              <Cell label="박스" v={o.boxFee} />
              <Cell label="택배" v={o.shipFee} />
              <Cell label="창고입고" v={o.warehouseFee} />
              <Cell label="그로스배송" v={o.grossShipFee} />
              <Cell label="입출고" v={o.inoutFee} />
              <Cell label={`수수료 (${(o.feeRate * 100).toFixed(2)}%)`} v={o.coupangFee} />
            </div>
            <div className="mt-1.5 pt-1.5 border-t border-gray-200 flex items-center gap-4 text-[11px] text-gray-600">
              <span>가격대: <span className="font-mono">{o.priceBand || '—'}</span></span>
              <span>1봉kg: <span className="font-mono">{o.kgPerBag}</span></span>
              <span>봉수: <span className="font-mono">{o.bagCount}</span></span>
              <span className="ml-auto">총비용 합계: <span className="font-mono font-medium">{fmt(o.totalCost)}</span></span>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Cell({ label, v }: { label: string; v: number }) {
  return (
    <div className="bg-white rounded px-2 py-1 border border-gray-200">
      <div className="text-gray-500 text-[10px]">{label}</div>
      <div className="font-mono font-medium text-gray-900">{fmt(v)}</div>
    </div>
  )
}
