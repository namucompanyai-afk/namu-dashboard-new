'use client'

import type { CoupangChannel, CoupangOption } from '@/types/coupang'
import {
  winnerRateTone,
  marginRateTone,
  bepRoasTone,
  formatPct,
} from '@/lib/coupang'

/** 뱃지 표시용 확장 채널 (혼합 포함) */
export type BadgeChannel = CoupangChannel | 'mixed'

const CHANNEL_STYLES: Record<BadgeChannel, { label: string; cls: string }> = {
  growth: { label: '그로스', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  wing:   { label: '윙',     cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  mixed:  { label: '혼합',   cls: 'bg-purple-50 text-purple-700 border border-purple-200' },
}

export function ChannelBadge({ channel }: { channel: BadgeChannel }) {
  const s = CHANNEL_STYLES[channel]
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  )
}

/** 옵션 배열의 "집합 채널"을 판정. 섞여 있으면 'mixed'. */
export function aggregateChannel(options: Pick<CoupangOption, 'channel'>[]): BadgeChannel {
  if (options.length === 0) return 'wing'
  const hasGrowth = options.some((o) => o.channel === 'growth')
  const hasWing = options.some((o) => o.channel === 'wing')
  if (hasGrowth && hasWing) return 'mixed'
  if (hasGrowth) return 'growth'
  return 'wing'
}

const TONE_CLASS = {
  good:  'text-emerald-600',
  warn:  'text-amber-500',
  bad:   'text-red-500',
  muted: 'text-gray-400',
} as const

export function WinnerRateCell({ rate }: { rate: number | null | undefined }) {
  const tone = winnerRateTone(rate)
  return (
    <span className={`font-mono font-semibold ${TONE_CLASS[tone]}`}>
      {formatPct(rate, 0)}
    </span>
  )
}

export function MarginRateCell({ rate }: { rate: number | null | undefined }) {
  const tone = marginRateTone(rate)
  return (
    <span className={`font-mono font-semibold ${TONE_CLASS[tone]}`}>
      {formatPct(rate, 1)}
    </span>
  )
}

export function BepRoasCell({ roas }: { roas: number | null | undefined }) {
  const tone = bepRoasTone(roas)
  return (
    <span className={`font-mono font-semibold ${TONE_CLASS[tone]}`}>
      {formatPct(roas, 0)}
    </span>
  )
}
