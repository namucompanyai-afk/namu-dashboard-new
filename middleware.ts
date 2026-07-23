import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * 게스트 권한 서버측 게이팅.
 *
 * 이 앱의 인증은 localStorage['user'] 기반(쿠키·세션 없음)이라 미들웨어가 직접 role을 못 읽는다.
 * 그래서 로그인 시 게이팅용 ASCII 마커 쿠키 nd_role(guest|member)을 추가로 심고, 여기서 그 값만 본다.
 * (한글 role은 localStorage에 그대로 유지 — 기존 동작 불변.) 게스트가 쿠키를 지우면 로그아웃 처리되어
 * AuthWrapper가 /login으로 보낸다. 완전한 서버 세션이 아니므로 방어는 최선노력 수준임을 명시.
 *
 * nd_role === 'guest' 인 요청만 제한:
 *   - 허용 페이지: /coupang-tools/ad-analysis (라이브 탭 전용)
 *   - 허용 API: /api/apps-script (로그인/로그아웃 프록시)
 *   - 그 외 페이지 → 광고 분석으로 리다이렉트, 그 외 API(저장 데이터 등) → 403 거부
 * 게스트가 아니면(다른 role·쿠키 없음) 완전 무동작 → 대표님·직원·진도팜 동작 불변.
 */

const GUEST_PAGES = ['/coupang-tools/ad-analysis']
const GUEST_APIS = ['/api/apps-script']
const startsWithAny = (path: string, bases: string[]) =>
  bases.some((b) => path === b || path.startsWith(b + '/'))

export function middleware(req: NextRequest) {
  if (req.cookies.get('nd_role')?.value !== 'guest') return NextResponse.next()

  const { pathname } = req.nextUrl
  if (pathname === '/login') return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    if (startsWithAny(pathname, GUEST_APIS)) return NextResponse.next()
    return NextResponse.json({ ok: false, error: '게스트 권한으로는 접근할 수 없습니다.' }, { status: 403 })
  }

  if (startsWithAny(pathname, GUEST_PAGES)) return NextResponse.next()
  const url = req.nextUrl.clone()
  url.pathname = '/coupang-tools/ad-analysis'
  return NextResponse.redirect(url)
}

export const config = {
  // 정적 자원(_next, 이미지·폰트·css·js 등)은 제외, 페이지·API 라우트에만 적용
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?|ttf|css|js|map)$).*)',
  ],
}
