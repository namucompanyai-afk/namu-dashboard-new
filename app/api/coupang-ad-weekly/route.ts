import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server'
import { getData, saveData } from '@/lib/supabase'

/**
 * 쿠팡 광고 주간 기록 API — 광고 분석 "지난주 대비"용
 *
 * 키: coupang_ad_weekly_snapshots   payload: { items: WeeklySnapshot[] }
 * GET  /api/coupang-ad-weekly                 → 전체 주간 기록 (기간 끝 오름차순)
 * POST /api/coupang-ad-weekly { snapshot }    → 같은 기간(시작·끝)이면 덮어쓰기, 아니면 추가 · 응답에 저장된 전체 목록
 * 월 저장 히스토리(coupang-master pnl_*)와는 별개 키라 건드리지 않는다.
 */

const KEY = 'coupang_ad_weekly_snapshots'

type Totals = { adCostVat: number; revenue: number; roasPct: number | null; bepPct: number | null; adProfit: number }
interface WeeklySnapshot {
  startDate: string
  endDate: string
  savedAt: string
  fileName?: string
  total: Totals
  campaigns: (Totals & { campaignId: string; campaignName: string; key: string })[]
}

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

async function loadItems(): Promise<WeeklySnapshot[]> {
  const saved = (await getData(KEY)) as { items?: WeeklySnapshot[] } | null
  return saved?.items ?? []
}

export async function GET(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(req, ['admin', 'guest'])
  if (denied) return denied
  try {
    const items = (await loadItems()).sort((a, b) => a.endDate.localeCompare(b.endDate))
    return NextResponse.json({ ok: true, items })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(req, ['admin', 'guest'])
  if (denied) return denied
  try {
    const body = await req.json()
    const s = body?.snapshot as WeeklySnapshot | undefined
    if (!s || !isDate(s.startDate) || !isDate(s.endDate) || !s.total || !Array.isArray(s.campaigns)) {
      return NextResponse.json({ ok: false, error: 'snapshot 형식 오류' }, { status: 400 })
    }
    const snap: WeeklySnapshot = { ...s, savedAt: new Date().toISOString() }
    const items = (await loadItems()).filter((x) => !(x.startDate === snap.startDate && x.endDate === snap.endDate))
    items.push(snap)
    items.sort((a, b) => a.endDate.localeCompare(b.endDate))
    await saveData(KEY, { items })
    // 저장한 전체 목록을 그대로 돌려준다 — 바로 다시 GET 하면 저장 직후 옛 값이 읽힐 수 있어 화면은 이 값을 쓴다
    return NextResponse.json({ ok: true, items })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
