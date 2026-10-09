import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server-auth'

/**
 * GET /api/me — 서명 쿠키(nd_auth)로 확인한 현재 역할.
 * C레벨 = admin (시트 '권한' 관리자). 화면의 건별 마진 표시는 이 값으로만 판단한다
 * (localStorage['user'].role 은 브라우저에서 바꿀 수 있어 쓰지 않는다).
 * 역할 외 개인정보·토큰은 내보내지 않는다.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const s = getSession(req)
  if (!s) return NextResponse.json({ ok: false, error: '로그인이 필요합니다.' }, { status: 401 })
  return NextResponse.json({ ok: true, role: s.role, cLevel: s.role === 'admin' }, { headers: { 'Cache-Control': 'no-store' } })
}
