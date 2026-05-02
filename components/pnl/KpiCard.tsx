import React from 'react'

/**
 * 손익 진단 공용 KPI 카드 (쿠팡 + 스스 진단 페이지에서 공유)
 *
 * - accent: 본 값 색상 (green/red/orange — 기본 회색)
 * - compare: 직전 동일기간 대비 변동 (up=증가/down=감소)
 * - compareGood: 좋은 방향 (up: 증가가 좋음 / down: 감소가 좋음)
 * - formula: 본 값 아래 회색 작은 텍스트 (계산 공식 등)
 */
export interface KpiCardProps {
  label: string
  value: string
  sub?: string
  formula?: string
  accent?: 'green' | 'red' | 'orange'
  compare?: { text: string; up: boolean } | null
  compareGood?: 'up' | 'down'
}

export default function KpiCard(props: KpiCardProps) {
  const colorClass =
    props.accent === 'green'
      ? 'text-green-700'
      : props.accent === 'red'
        ? 'text-red-700'
        : props.accent === 'orange'
          ? 'text-orange-700'
          : 'text-gray-900'

  let cmpClass = ''
  if (props.compare) {
    const isGood =
      (props.compareGood === 'up' && props.compare.up) ||
      (props.compareGood === 'down' && !props.compare.up)
    cmpClass = isGood ? 'text-green-600' : 'text-red-600'
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs text-gray-500 mb-1">{props.label}</div>
      <div className={`text-xl font-bold font-mono ${colorClass}`}>{props.value}</div>
      {props.formula && (
        <div className="text-[10px] text-gray-400 font-mono mt-1">{props.formula}</div>
      )}
      {props.sub && <div className="text-xs text-gray-500 mt-0.5">{props.sub}</div>}
      {props.compare && (
        <div className={`text-xs font-medium mt-1 ${cmpClass}`}>{props.compare.text}</div>
      )}
    </div>
  )
}
