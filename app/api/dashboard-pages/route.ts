import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server-auth'
import { getUserDashboardPages, saveUserDashboardPages } from '@/lib/supabase'

/**
 * 개인별 대시보드 페이지 핀 (user_dashboard_pages) — 호출 화면: 메인(/)
 *
 * 브라우저가 Supabase 에 직접 붙지 않도록 서버를 거친다.
 * 누구의 핀인지는 서명 쿠키(nd_auth)의 이메일로만 정한다 (브라우저가 보낸 이메일은 쓰지 않음).
 *
 * GET → { ok, pageIds: string[] | null }   (null = 저장된 핀 없음 → 화면 기본값)
 * PUT  body { pageIds: string[] } → { ok }
 */
export const dynamic = 'force-dynamic'

const ALLOWED = ['admin', 'staff'] as const

function sessionEmail(req: Request): { email: string } | NextResponse {
  const s = getSession(req)
  if (!s) return NextResponse.json({ ok: false, error: '로그인이 필요합니다.' }, { status: 401 })
  if (!(ALLOWED as readonly string[]).includes(s.role)) {
    return NextResponse.json({ ok: false, error: '접근 권한이 없습니다.' }, { status: 403 })
  }
  // 2026-09-28 이전에 발급된 쿠키에는 이메일이 없다 → 다시 로그인하면 생김
  if (!s.email) return NextResponse.json({ ok: false, error: '다시 로그인해 주세요.' }, { status: 401 })
  return { email: s.email }
}

export async function GET(req: Request) {
  const who = sessionEmail(req)
  if (who instanceof NextResponse) return who
  try {
    const pageIds = await getUserDashboardPages(who.email)
    return NextResponse.json({ ok: true, pageIds }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const who = sessionEmail(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => null)
  const pageIds = body?.pageIds
  if (!Array.isArray(pageIds) || !pageIds.every((p) => typeof p === 'string') || pageIds.length > 200) {
    return NextResponse.json({ ok: false, error: 'pageIds 형식 오류' }, { status: 400 })
  }
  try {
    await saveUserDashboardPages(who.email, pageIds)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
