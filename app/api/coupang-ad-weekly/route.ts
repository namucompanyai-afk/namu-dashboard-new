import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server'
import { getData, saveData } from '@/lib/supabase'
import { WEEKLY_SNAPSHOTS_KEY, mergeWeeklySnapshot, type StoredWeeklySnapshot } from '@/lib/coupang/weeklySnapshots'

/**
 * 쿠팡 광고 주간 기록 API — 광고 분석 "지난주 대비"용
 *
 * 키: coupang_ad_weekly_snapshots   payload: { items: WeeklySnapshot[] }
 * GET  /api/coupang-ad-weekly                 → 전체 주간 기록 (기간 끝 오름차순)
 * POST /api/coupang-ad-weekly { snapshot }    → 같은 기간(시작·끝)이면 덮어쓰기, 아니면 추가 · 응답에 저장된 전체 목록
 * DELETE /api/coupang-ad-weekly?start=YYYY-MM-DD&end=YYYY-MM-DD → 그 기간 기록 삭제
 * 월 저장 히스토리(coupang-master pnl_*)와는 별개 키라 건드리지 않는다.
 */

const KEY = WEEKLY_SNAPSHOTS_KEY
type WeeklySnapshot = StoredWeeklySnapshot

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

async function loadItems(): Promise<WeeklySnapshot[]> {
  const saved = (await getData(KEY)) as { items?: WeeklySnapshot[] } | null
  return saved?.items ?? []
}

export async function GET(req: Request) {
  // 관리자만 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석. 게스트는 회사 기록 조회·저장 불가
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const items = (await loadItems()).sort((a, b) => a.endDate.localeCompare(b.endDate))
    return NextResponse.json({ ok: true, items })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  // 관리자만 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석. 게스트는 회사 기록 조회·저장 불가
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const body = await req.json()
    const s = body?.snapshot as WeeklySnapshot | undefined
    if (!s || !isDate(s.startDate) || !isDate(s.endDate) || !s.total || !Array.isArray(s.campaigns)) {
      return NextResponse.json({ ok: false, error: 'snapshot 형식 오류' }, { status: 400 })
    }
    const snap: WeeklySnapshot = { ...s, savedAt: new Date().toISOString() }
    const { items } = mergeWeeklySnapshot(await loadItems(), snap)
    await saveData(KEY, { items })
    // 저장한 전체 목록을 그대로 돌려준다 — 바로 다시 GET 하면 저장 직후 옛 값이 읽힐 수 있어 화면은 이 값을 쓴다
    return NextResponse.json({ ok: true, items })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  // 관리자만 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석. 게스트는 회사 기록 조회·저장 불가
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const { searchParams } = new URL(req.url)
    const start = searchParams.get('start')
    const end = searchParams.get('end')
    if (!isDate(start) || !isDate(end)) return NextResponse.json({ ok: false, error: 'start·end(YYYY-MM-DD) 필요' }, { status: 400 })
    const all = await loadItems()
    const items = all.filter((x) => !(x.startDate === start && x.endDate === end))
    if (items.length === all.length) return NextResponse.json({ ok: false, error: '그 기간 기록 없음' }, { status: 404 })
    await saveData(KEY, { items })
    return NextResponse.json({ ok: true, items })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
