/**
 * UI 유틸: 색상/뱃지 판정
 *
 * 목업(coupang_dashboard.html)의 색상 기준을 코드로 고정.
 * 나중에 threshold 바뀌면 이 파일만 수정.
 */

/** 아이템위너 비율 → 색 등급 */
export function winnerRateTone(rate: number | null | undefined): 'good' | 'warn' | 'bad' | 'muted' {
  if (rate == null) return 'muted'
  if (rate >= 100) return 'good'       // 100% = 녹색
  if (rate >= 50) return 'warn'        // 50~99% = 주황
  return 'bad'                         // 0~49% = 빨강
}

/** 마진율 → 색 등급. 쌀/곡물 기준 20% 넘으면 건강, 10% 미만은 적신호. */
export function marginRateTone(rate: number | null | undefined): 'good' | 'warn' | 'bad' | 'muted' {
  if (rate == null) return 'muted'
  if (rate >= 20) return 'good'
  if (rate >= 10) return 'warn'
  return 'bad'
}

/** BEP ROAS → 색 등급. 낮을수록 좋음 (광고 손익분기가 낮다는 뜻). */
export function bepRoasTone(roas: number | null | undefined): 'good' | 'warn' | 'bad' | 'muted' {
  if (roas == null) return 'muted'
  if (roas <= 400) return 'good'       // 400% 이하면 광고 돌리기 쉬움
  if (roas <= 600) return 'warn'
  return 'bad'                         // 600% 초과면 광고로 회수 어려움
}

export const TONE_CLASS: Record<'good' | 'warn' | 'bad' | 'muted', string> = {
  good: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-rose-400',
  muted: 'text-slate-400',
}
