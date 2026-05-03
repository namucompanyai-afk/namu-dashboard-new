'use client'

import React, { useMemo, useRef, useState } from 'react'
import { parseNaverSettlement, type NaverSettlementData } from '@/lib/naver/parsers/settlement'
import { parseNaverOrderQuery, type NaverOrderQueryData } from '@/lib/naver/parsers/orderQuery'
import {
  validatePeriodOverlap,
  type PeriodOverlapResult,
} from '@/lib/naver/dateValidation'
import { useNaverStore } from '@/lib/naver/store'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SettleSlot {
  data: NaverSettlementData
  fileName: string
}

interface OrderSlot {
  data: NaverOrderQueryData
  fileName: string
}

function fmtDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtRange(start: Date, end: Date): string {
  return `${fmtDay(start)} ~ ${fmtDay(end)}`
}

export default function SettlementUploadModal({ open, onOpenChange }: Props) {
  const setSettlement = useNaverStore((s) => s.setSettlement)
  const setOrderQuery = useNaverStore((s) => s.setOrderQuery)

  const [settle, setSettle] = useState<SettleSlot | null>(null)
  const [order, setOrder] = useState<OrderSlot | null>(null)
  const [error, setError] = useState<string>('')
  const [loadingSettle, setLoadingSettle] = useState(false)
  const [loadingOrder, setLoadingOrder] = useState(false)

  const settleInputRef = useRef<HTMLInputElement>(null)
  const orderInputRef = useRef<HTMLInputElement>(null)

  const onPickSettle = async (file: File) => {
    setError('')
    setLoadingSettle(true)
    try {
      const buf = await file.arrayBuffer()
      const data = await parseNaverSettlement(buf)
      setSettle({ data, fileName: file.name })
    } catch (e) {
      setError('정산내역 파싱 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoadingSettle(false)
    }
  }

  const onPickOrder = async (file: File) => {
    setError('')
    setLoadingOrder(true)
    try {
      const buf = await file.arrayBuffer()
      const data = await parseNaverOrderQuery(buf)
      if (data.rows.length === 0) {
        setError('주문조회 파싱 실패: 행이 0개입니다. 비밀번호가 풀린 평문 xlsx 인지 확인해 주세요.')
        return
      }
      setOrder({ data, fileName: file.name })
    } catch (e) {
      setError('주문조회 파싱 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoadingOrder(false)
    }
  }

  // 기간 매칭 검증
  const validation: PeriodOverlapResult | null = useMemo(() => {
    if (!settle || !order) return null
    const s = settle.data
    const o = order.data
    if (!s.dateRange || !o.periodStart || !o.periodEnd) return null
    const settleIds = new Set(
      s.rows.filter((r) => r.kind === '상품주문').map((r) => r.productOrderId),
    )
    const orderIds = new Set(o.rows.map((r) => r.productOrderId))
    return validatePeriodOverlap(
      {
        start: new Date(s.dateRange.min),
        end: new Date(s.dateRange.max),
        rowCount: s.productOrderCount,
      },
      { start: o.periodStart, end: o.periodEnd, rowCount: o.rows.length },
      settleIds,
      orderIds,
    )
  }, [settle, order])

  const onApply = () => {
    if (!settle || !order) return
    setSettlement(settle.data, settle.fileName)
    setOrderQuery(order.data, order.fileName)
    onOpenChange(false)
    // 모달 상태 초기화 (다음 열림 때 빈 상태)
    setSettle(null)
    setOrder(null)
    setError('')
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div className="bg-white rounded-xl w-full max-w-2xl shadow-xl my-8">
        {/* 헤더 */}
        <div className="flex items-start justify-between p-5 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              🛒 스마트스토어 매출 연결
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              정산내역 + 주문조회로 정확한 마진 분석
            </p>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* 가이드 박스 */}
          <details className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <summary className="text-sm font-medium cursor-pointer select-none">
              📍 파일 받는 방법
            </summary>
            <div className="mt-3 space-y-2 text-xs">
              <div className="rounded bg-blue-50 border border-blue-100 p-3">
                <div className="font-semibold text-blue-800 mb-1">📊 정산내역</div>
                <ol className="list-decimal pl-5 space-y-0.5 text-gray-700">
                  <li>스마트스토어센터 → 정산관리 → 정산내역</li>
                  <li>건별정산내역 → 조회기간 [결제일 기준]</li>
                  <li>수수료 상세내역 엑셀 다운로드</li>
                </ol>
              </div>
              <div className="rounded bg-green-50 border border-green-100 p-3">
                <div className="font-semibold text-green-800 mb-1">🛒 주문조회</div>
                <ol className="list-decimal pl-5 space-y-0.5 text-gray-700">
                  <li>스마트스토어센터 → 판매관리 → 주문통합검색</li>
                  <li>조회기간 [결제일] 선택</li>
                  <li>엑셀 다운로드 후 비번 1111 입력</li>
                  <li>
                    엑셀 열고 [다른 이름으로 저장] → 저장 옵션에서 [도구 → 일반 옵션 → 비번 제거] 후
                    저장
                  </li>
                </ol>
              </div>
              <div className="text-amber-700 text-[11px]">⚠ 두 파일 모두 같은 기간으로 다운로드</div>
            </div>
          </details>

          {/* 슬롯 1: 정산내역 */}
          <UploadSlot
            icon="📊"
            title="정산내역 엑셀 업로드"
            subtitle="클릭하거나 파일을 드래그 · .xlsx"
            inputRef={settleInputRef}
            onPick={onPickSettle}
            loading={loadingSettle}
            slot={
              settle
                ? {
                    fileName: settle.fileName,
                    summary: `${settle.data.productOrderCount.toLocaleString()}건 / 기간: ${
                      settle.data.dateRange
                        ? `${settle.data.dateRange.min} ~ ${settle.data.dateRange.max}`
                        : '?'
                    }`,
                  }
                : null
            }
          />

          {/* 슬롯 2: 주문조회 */}
          <UploadSlot
            icon="🛒"
            title="주문조회 엑셀 업로드 (비번 제거 후)"
            subtitle="클릭하거나 파일을 드래그 · .xlsx"
            inputRef={orderInputRef}
            onPick={onPickOrder}
            loading={loadingOrder}
            slot={
              order
                ? {
                    fileName: order.fileName,
                    summary: `${order.data.rows.length.toLocaleString()}건 / 기간: ${
                      order.data.periodStart && order.data.periodEnd
                        ? fmtRange(order.data.periodStart, order.data.periodEnd)
                        : '?'
                    }`,
                  }
                : null
            }
          />

          {/* 에러 */}
          {error && (
            <div className="rounded bg-red-50 border border-red-200 text-red-700 text-sm p-3">
              {error}
            </div>
          )}

          {/* 기간 매칭 결과 */}
          {validation && <ValidationCard result={validation} />}
        </div>

        {/* 푸터 */}
        <div className="flex items-center justify-end gap-2 p-5 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-100 bg-white"
          >
            취소
          </button>
          <button
            onClick={onApply}
            disabled={!settle || !order}
            className="px-4 py-2 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            ✅ 적용 + 저장
          </button>
        </div>
      </div>
    </div>
  )
}

function UploadSlot({
  icon,
  title,
  subtitle,
  inputRef,
  onPick,
  loading,
  slot,
}: {
  icon: string
  title: string
  subtitle: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onPick: (file: File) => void
  loading: boolean
  slot: { fileName: string; summary: string } | null
}) {
  const [drag, setDrag] = useState(false)

  return (
    <div
      className={
        'rounded-lg border-2 border-dashed p-4 transition-colors ' +
        (slot
          ? 'border-emerald-300 bg-emerald-50/30'
          : drag
            ? 'border-emerald-400 bg-emerald-50'
            : 'border-gray-300 hover:bg-gray-50')
      }
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onPick(f)
      }}
    >
      {!slot ? (
        <div
          className="flex items-center justify-between gap-3 cursor-pointer"
          onClick={() => inputRef.current?.click()}
        >
          <div className="flex items-center gap-3">
            <div className="text-2xl">{icon}</div>
            <div>
              <div className="text-sm font-medium">{title}</div>
              <div className="text-xs text-gray-500">{subtitle}</div>
            </div>
          </div>
          <button className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:bg-gray-300">
            {loading ? '파싱 중…' : '파일 선택'}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="text-2xl">{icon}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-emerald-900 flex items-center gap-2">
                <span>✓</span>
                <span className="truncate" title={slot.fileName}>{slot.fileName}</span>
              </div>
              <div className="text-xs text-gray-600 mt-0.5">{slot.summary}</div>
            </div>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-100 whitespace-nowrap"
          >
            재업로드
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          if (inputRef.current) inputRef.current.value = ''
        }}
      />
    </div>
  )
}

function ValidationCard({ result }: { result: PeriodOverlapResult }) {
  const { status, settleRange, orderRange, overlapRange, matchedCount, unmatchedCount } = result

  if (status === 'match') {
    return (
      <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-sm">
        <div className="font-semibold text-green-800 mb-1">
          ✓ 기간 일치: {fmtRange(settleRange.start, settleRange.end)} ({settleRange.days}일)
        </div>
        <ul className="text-xs text-gray-700 space-y-0.5 mt-1">
          <li>
            · 정산내역 {settleRange.rowCount.toLocaleString()}건 / 주문조회{' '}
            {orderRange.rowCount.toLocaleString()}건
          </li>
          <li>
            · 매칭 가능: {matchedCount.toLocaleString()}건 (
            {settleRange.rowCount > 0
              ? ((matchedCount / settleRange.rowCount) * 100).toFixed(1)
              : '0'}
            %)
          </li>
        </ul>
      </div>
    )
  }

  if (status === 'partial') {
    return (
      <div className="rounded-lg bg-yellow-50 border border-yellow-300 p-4 text-sm">
        <div className="font-semibold text-yellow-800 mb-1">⚠ 기간 부분 일치</div>
        <ul className="text-xs text-gray-700 space-y-0.5 mt-1">
          <li>· 정산내역: {fmtRange(settleRange.start, settleRange.end)} ({settleRange.days}일)</li>
          <li>· 주문조회: {fmtRange(orderRange.start, orderRange.end)} ({orderRange.days}일)</li>
          {overlapRange && (
            <li>
              · 겹치는 기간: {fmtRange(overlapRange.start, overlapRange.end)} ({overlapRange.days}일)
            </li>
          )}
          <li>
            · 매칭 가능: {matchedCount.toLocaleString()}건 / 미매칭{' '}
            {unmatchedCount.toLocaleString()}건
          </li>
        </ul>
        <div className="text-yellow-700 text-xs mt-2">→ 두 파일을 같은 기간으로 받아주세요</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-red-50 border border-red-300 p-4 text-sm">
      <div className="font-semibold text-red-800 mb-1">✗ 기간 불일치 — 매칭 가능 0건</div>
      <ul className="text-xs text-gray-700 space-y-0.5 mt-1">
        <li>· 정산내역: {fmtRange(settleRange.start, settleRange.end)}</li>
        <li>· 주문조회: {fmtRange(orderRange.start, orderRange.end)}</li>
      </ul>
      <div className="text-red-700 text-xs mt-2">→ 두 파일을 같은 기간으로 받아주세요</div>
    </div>
  )
}
