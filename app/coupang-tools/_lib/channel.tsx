// 쿠팡 채널 라벨/배지/분포 공용 모듈.
// 진단·광고 분석·재고 페이지 등에서 동일 팔레트/이모지로 사용.

import React from 'react'

export type ChannelKey = 'rocket' | 'growth' | 'wing' | 'other'

export interface ChannelMeta {
  label: string
  emoji: string
  key: ChannelKey
}

export function channelLabel(raw?: string | null): ChannelMeta | null {
  if (raw == null) return null
  const v = raw.toString().trim().toLowerCase()
  if (!v) return null
  if (v === '1p' || v === 'rocket' || v === '로켓' || v === '로켓배송') {
    return { label: '1P', emoji: '🚀', key: 'rocket' }
  }
  if (v === 'growth' || v === '그로스') {
    return { label: '그로스', emoji: '📦', key: 'growth' }
  }
  if (v === 'wing' || v === '윙') {
    return { label: '윙', emoji: '🚚', key: 'wing' }
  }
  return { label: raw, emoji: '', key: 'other' }
}

const BADGE_CLS: Record<ChannelKey, string> = {
  rocket: 'bg-blue-100 text-blue-700',
  growth: 'bg-orange-100 text-orange-700',
  wing: 'bg-emerald-100 text-emerald-700',
  other: 'bg-gray-100 text-gray-700',
}

const TEXT_CLS: Record<ChannelKey, string> = {
  rocket: 'text-blue-700',
  growth: 'text-orange-700',
  wing: 'text-emerald-700',
  other: 'text-gray-500',
}

export function ChannelBadge({ raw }: { raw?: string | null }) {
  const c = channelLabel(raw)
  if (!c) return <span className="text-gray-400">—</span>
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${BADGE_CLS[c.key]}`}
    >
      {c.emoji && <span>{c.emoji}</span>}
      <span>{c.label}</span>
    </span>
  )
}

export function ChannelDistribution({ channels }: { channels: (string | null | undefined)[] }) {
  if (!channels || channels.length === 0) return <span className="text-gray-400">—</span>
  const counts: Record<string, number> = {}
  for (const raw of channels) {
    const c = channelLabel(raw)
    const key = c ? c.key : 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  const keys = Object.keys(counts)
  if (keys.every((k) => k === 'unknown')) return <span className="text-gray-400">—</span>
  const order = ['rocket', 'growth', 'wing', 'other', 'unknown']
  const sorted = keys.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {sorted.map((k) => {
        const meta =
          k === 'rocket' ? { label: '1P', emoji: '🚀', cls: TEXT_CLS.rocket } :
          k === 'growth' ? { label: '그로스', emoji: '📦', cls: TEXT_CLS.growth } :
          k === 'wing' ? { label: '윙', emoji: '🚚', cls: TEXT_CLS.wing } :
          { label: k === 'unknown' ? '미상' : k, emoji: '', cls: TEXT_CLS.other }
        return (
          <span key={k} className={`whitespace-nowrap ${meta.cls}`}>
            {meta.emoji && <span className="mr-0.5">{meta.emoji}</span>}
            {meta.label} {counts[k]}
          </span>
        )
      })}
    </div>
  )
}
