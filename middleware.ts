import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * 서버측 페이지·게스트 게이팅 — 서명 쿠키(nd_auth, HttpOnly)를 여기서 직접 검증한다.
 *
 * 역할 판단은 브라우저가 바꿀 수 없는 nd_auth(AUTH_SECRET HMAC) 기준이다.
 * (localStorage·nd_role 은 화면 표시용일 뿐 — 지워도 권한이 넓어지지 않는다)
 *
 *   로그인 없음(쿠키 없음·위조·만료) → 페이지는 /login 으로, API 는 각 라우트가 401
 *   게스트(guest)  → 페이지: 광고 분석만 · API: 로그인·로그아웃(apps-script·auth)만 (저장·삭제 등 전부 403)
 *   진도팜(jindo)  → 페이지: 원가표만
 *   관리자 전용 페이지(가입자 관리·전체 히스토리·설정·데이터 관리·쿠팡 손익·광고 분석·스마트스토어 수익 진단)
 *                   → 관리자(게스트는 광고 분석만) 아니면 홈(/)으로
 * Edge 런타임이라 Node crypto 대신 Web Crypto 로 lib/server-auth.ts 와 같은 서명을 검증한다.
 */

type Role = 'admin' | 'staff' | 'jindo' | 'guest'

const PUBLIC_PAGES = ['/login', '/signup']
const GUEST_PAGES = ['/coupang-tools/ad-analysis']
const GUEST_APIS = ['/api/apps-script', '/api/auth']
const JINDO_PAGES = ['/jindopam/cost']
const ADMIN_PAGES = [
  '/hr/users', '/hr/leave/admin', '/hr/settings',
  '/coupang-tools/data-management', '/coupang-tools/diagnosis', '/coupang-tools/ad-analysis', '/coupang-tools/parser-test',
  '/naver-tools/diagnosis',
]

const startsWithAny = (path: string, bases: string[]) =>
  bases.some((b) => path === b || path.startsWith(b + '/'))

const b64urlToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
const bytesToB64url = (u: Uint8Array) =>
  btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function roleOf(req: NextRequest): Promise<Role | null> {
  const token = req.cookies.get('nd_auth')?.value
  const secret = process.env.AUTH_SECRET
  if (!token || !secret) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const expected = bytesToB64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))))
    if (expected.length !== sig.length) return null
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
    if (diff !== 0) return null
    const { r, e } = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)))
    if (typeof e !== 'number' || e < Date.now() / 1000) return null
    return ['admin', 'staff', 'jindo', 'guest'].includes(r) ? (r as Role) : null
  } catch {
    return null
  }
}

const redirectTo = (req: NextRequest, path: string) => {
  const url = req.nextUrl.clone()
  url.pathname = path
  url.search = ''
  return NextResponse.redirect(url)
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const role = await roleOf(req)

  if (pathname.startsWith('/api/')) {
    if (role === 'guest' && !startsWithAny(pathname, GUEST_APIS)) {
      return NextResponse.json({ ok: false, error: '게스트 권한으로는 접근할 수 없습니다.' }, { status: 403 })
    }
    // 그 외 API 는 각 라우트의 requireRole / 자체 검사(apps-script 동작별 권한, CRON_SECRET)가 판단
    return NextResponse.next()
  }

  if (startsWithAny(pathname, PUBLIC_PAGES)) return NextResponse.next()
  if (!role) return redirectTo(req, '/login')
  if (role === 'guest') return startsWithAny(pathname, GUEST_PAGES) ? NextResponse.next() : redirectTo(req, GUEST_PAGES[0])
  if (role === 'jindo') return startsWithAny(pathname, JINDO_PAGES) ? NextResponse.next() : redirectTo(req, JINDO_PAGES[0])
  if (role !== 'admin' && startsWithAny(pathname, ADMIN_PAGES)) return redirectTo(req, '/')
  return NextResponse.next()
}

export const config = {
  // 정적 자원(_next, 이미지·폰트·css·js 등)은 제외, 페이지·API 라우트에만 적용
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?|ttf|css|js|map)$).*)',
  ],
}
