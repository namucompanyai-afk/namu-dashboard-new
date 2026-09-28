import { createHmac, timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'

/**
 * 서버측 로그인 확인 — 서명 쿠키(nd_auth).
 *
 * 앱 로그인은 localStorage['user'] 기반이라 서버가 로그인 여부를 알 수 없었다.
 * 로그인 성공 시(/api/apps-script action=login) 역할을 HMAC 서명한 HttpOnly 쿠키를 심고,
 * 보호 대상 API 는 이 쿠키로 역할을 확인한다. 브라우저 JS 로는 읽거나 위조할 수 없다.
 *
 * 역할 코드(ASCII): admin(관리자) · staff(직원·기타) · jindo(진도팜) · guest(게스트)
 */

export type RoleCode = 'admin' | 'staff' | 'jindo' | 'guest'

export const AUTH_COOKIE = 'nd_auth'
const MAX_AGE_SEC = 60 * 60 * 24 * 30 // 로그인 유지 30일 (nd_role 과 동일)

// 로그인 서명 전용 키 — CRON_SECRET 등 다른 값으로 대체하지 않는다 (없으면 서버 오류)
function secret(): string {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET 환경변수가 설정되지 않았습니다.')
  return s
}

export function roleCodeOf(role: unknown): RoleCode {
  if (role === '관리자') return 'admin'
  if (role === '진도팜') return 'jindo'
  if (role === '게스트') return 'guest'
  return 'staff' // Sidebar 와 동일하게 역할 없음 = 직원
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url')

/** m = 로그인 이메일(소문자) — 본인 것만 허용하는 동작(연차 신청·본인 조회) 확인용 */
export function issueAuthToken(role: unknown, email?: unknown): string {
  const m = typeof email === 'string' ? email.trim().toLowerCase() : ''
  const payload = Buffer.from(
    JSON.stringify({ r: roleCodeOf(role), e: Math.floor(Date.now() / 1000) + MAX_AGE_SEC, ...(m ? { m } : {}) })
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export interface AuthSession { role: RoleCode; email: string | null }

function verifyAuthToken(token: string | undefined): RoleCode | null {
  return verifySession(token)?.role ?? null
}

function verifySession(token: string | undefined): AuthSession | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const { r, e, m } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (typeof e !== 'number' || e < Date.now() / 1000) return null
    if (!['admin', 'staff', 'jindo', 'guest'].includes(r)) return null
    return { role: r as RoleCode, email: typeof m === 'string' && m ? m : null }
  } catch {
    return null
  }
}

const cookieOf = (req: Request, name: string) =>
  (req.headers.get('cookie') || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)

/** 서명 쿠키로 확인한 로그인 세션 (없음·위조·만료 → null) */
export function getSession(req: Request): AuthSession | null {
  return verifySession(cookieOf(req, AUTH_COOKIE))
}

export function setAuthCookie(res: NextResponse, role: unknown, email?: unknown) {
  res.cookies.set(AUTH_COOKIE, issueAuthToken(role, email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SEC,
  })
}

export function clearAuthCookie(res: NextResponse) {
  res.cookies.set(AUTH_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
}

/**
 * 허용 역할이 아니면 거부 응답을 돌려준다 (통과면 null).
 * 로그인 쿠키 없음·위조·만료 → 401 / 로그인했지만 역할 밖 → 403
 */
export function requireRole(req: Request, allowed: RoleCode[]): NextResponse | null {
  const role = verifyAuthToken(cookieOf(req, AUTH_COOKIE))
  if (!role) return NextResponse.json({ ok: false, error: '로그인이 필요합니다.' }, { status: 401 })
  if (!allowed.includes(role)) {
    return NextResponse.json({ ok: false, error: '접근 권한이 없습니다.' }, { status: 403 })
  }
  return null
}
