'use client'

/**
 * 마진 관리 페이지 (/coupang-tools/margin)
 *
 * 인플루언서 페이지와 동일한 업로드 UX 패턴 사용:
 * 버튼 카드 클릭 → 모달 오픈 → 안내 박스 + 드롭존
 */

import { useMemo } from 'react'
import {
  parsePriceInventory,
  parseSettlement,
  parseSalesInsight,
  parseCostTable,
} from '@/lib/coupang'
import { useMarginStore } from '@/lib/coupang/store'
import { UploadZone } from '@/components/coupang/UploadZone'
import { ProductGroupTable } from '@/components/coupang/ProductGroupTable'
import {
  FilterTabs,
  applyFilter,
  WarningBanner,
} from '@/components/coupang/FilterTabs'

export default function MarginPage() {
  const options = useMarginStore((s) => s.options)
  const uploads = useMarginStore((s) => s.uploads)
  const filter = useMarginStore((s) => s.filter)
  const selectedCount = useMarginStore((s) => s.selectedOptionIds.size)
  const costStats = useMarginStore((s) => s.costStats)
  const deleteSelected = useMarginStore((s) => s.deleteSelected)
  const clearSelection = useMarginStore((s) => s.clearSelection)
  const setPriceInventory = useMarginStore((s) => s.setPriceInventory)
  const setSettlement = useMarginStore((s) => s.setSettlement)
  const setSalesInsight = useMarginStore((s) => s.setSalesInsight)
  const setCostTable = useMarginStore((s) => s.setCostTable)

  const filtered = useMemo(() => applyFilter(options, filter), [options, filter])

  return (
    <div>
      {/* Page Title */}
      <div className="text-xs font-medium text-gray-500">쿠팡 도구</div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">
        마진 관리
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        옵션별 원가를 입력하면 BEP ROAS가 자동 계산됩니다
      </p>

      {/* Upload zones */}
      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <UploadZone
          icon="📦"
          title="쿠팡 상품 엑셀"
          subtitle="상품ID · 옵션ID · 판매가"
          modalDescription="노출상품ID / 등록상품ID / 옵션ID / 판매가"
          instructions={[
            '쿠팡 WING → 상품관리 → 상품 조회/수정',
            '우측 상단 "엑셀 다운로드" 클릭',
            '상품 전체 선택 후 다운로드',
          ]}
          status={uploads.priceInventory}
          onFile={async (buf, file) => {
            const result = await parsePriceInventory(buf)
            if (result.missingColumns.length > 0) {
              throw new Error(`필수 컬럼 누락: ${result.missingColumns.join(', ')}`)
            }
            if (result.rows.length === 0) {
              throw new Error('파싱된 행이 없습니다. 엑셀 포맷을 확인해 주세요.')
            }
            setPriceInventory(result.rows, {
              fileName: file.name,
              uploadedAt: new Date().toISOString(),
              rowCount: result.rows.length,
            })
            if (result.skippedRows > 0) {
              return {
                warning: `${result.skippedRows}개 행을 건너뛰었습니다 (필수 필드 누락).`,
              }
            }
          }}
        />
        <UploadZone
          icon="💰"
          title="그로스 정산 엑셀"
          subtitle="배송비 + 입출고비"
          modalDescription="로켓그로스 옵션별 배송비 / 입출고비 매칭"
          instructions={[
            '쿠팡 WING → 정산 → 로켓그로스 정산',
            '기간 선택 (최근 1~3개월 권장)',
            '입출고비 + 배송비 엑셀 다운로드',
          ]}
          status={uploads.settlement}
          onFile={async (buf, file) => {
            const result = parseSettlement(buf)
            if (result.rows.length === 0) {
              throw new Error('정산 데이터를 찾지 못했습니다. 시트 구조를 확인해 주세요.')
            }
            setSettlement(result.rows, {
              fileName: file.name,
              uploadedAt: new Date().toISOString(),
              rowCount: result.rows.length,
            })
            if (result.missingColumns.length > 0) {
              return {
                warning: `일부 컬럼 없음: ${result.missingColumns.join(', ')}`,
              }
            }
          }}
        />
        <UploadZone
          icon="📊"
          title="판매 분석 엑셀"
          subtitle="90일 판매량 · 매출 · 위너비율"
          modalDescription="옵션별 90일 판매량 / 매출 / 아이템위너 비율"
          instructions={[
            '쿠팡 WING → 통계 → 상품 통계',
            '기간: 최근 90일 선택',
            'VENDOR_ITEM_METRICS 엑셀 다운로드',
          ]}
          status={uploads.salesInsight}
          onFile={async (buf, file) => {
            const result = parseSalesInsight(buf)
            if (result.rows.length === 0) {
              throw new Error(
                result.missingColumns.length > 0
                  ? `필수 컬럼 누락: ${result.missingColumns.join(', ')}`
                  : '판매 데이터를 찾지 못했습니다.',
              )
            }
            setSalesInsight(result.rows, {
              fileName: file.name,
              uploadedAt: new Date().toISOString(),
              rowCount: result.rows.length,
            })
          }}
        />
        <UploadZone
          icon="📋"
          title="원가 엑셀"
          subtitle="옵션ID · 공급가 (직접 관리)"
          modalDescription="옵션별 원가(공급가) 일괄 적용"
          instructions={[
            '구글 시트에 "옵션ID" 컬럼 추가',
            '각 품목 옆에 쿠팡 옵션ID 입력 (옵션별로 한 행)',
            '파일 → 다운로드 → Microsoft Excel (.xlsx)',
          ]}
          status={uploads.costTable}
          onFile={async (buf, file) => {
            const result = parseCostTable(buf)
            if (result.rows.length === 0) {
              throw new Error(
                result.missingColumns.length > 0
                  ? result.missingColumns.join(' · ')
                  : '원가 데이터를 찾지 못했습니다. "옵션ID" 헤더가 있는지 확인해 주세요.',
              )
            }
            setCostTable(result.rows, {
              fileName: file.name,
              uploadedAt: new Date().toISOString(),
              rowCount: result.rows.length,
            })
            const warnings: string[] = []
            if (result.skippedRows > 0) {
              warnings.push(`${result.skippedRows}개 행 건너뜀 (옵션ID 또는 공급가 누락)`)
            }
            if (warnings.length > 0) return { warning: warnings.join(' · ') }
          }}
        />
      </div>

      {/* 원가 매칭 통계 배너 */}
      {uploads.costTable && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <strong className="font-semibold">📋 원가 적용됨</strong>{' '}
          · 전체 {costStats.totalOptions}개 옵션 중{' '}
          <strong>{costStats.matchedCount}개</strong> 매칭됨
          {costStats.totalOptions > costStats.matchedCount && (
            <span className="ml-1 text-emerald-600">
              ({costStats.totalOptions - costStats.matchedCount}개는 원가 미매칭 → 수동 입력 가능)
            </span>
          )}
        </div>
      )}

      {/* Warnings */}
      <div className="mt-5">
        <WarningBanner />
      </div>

      {/* Filter tabs + bulk action bar */}
      <div className="mt-5">
        <FilterTabs options={options} />
        {selectedCount > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-sm">
            <div className="text-sm">
              <strong className="text-emerald-600">{selectedCount}</strong>
              <span className="ml-1 text-gray-500">개 옵션 선택됨</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              >
                선택 해제
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`선택된 ${selectedCount}개 옵션을 삭제하시겠어요?`)) {
                    deleteSelected()
                  }
                }}
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100"
              >
                선택 삭제
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Product group table */}
      <div className="mt-3">
        <ProductGroupTable options={filtered} />
      </div>

      {/* Info footer */}
      {options.length > 0 && (
        <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500 shadow-sm">
          💡 모든 금액은 VAT 포함 기준입니다. 쿠팡 수수료는 판매가의 7%로 가정했으며, 카테고리별 실제 수수료와 차이가 있을 수 있습니다.
        </div>
      )}
    </div>
  )
}
