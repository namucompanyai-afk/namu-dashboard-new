import { NextResponse } from 'next/server'
import { clearAuthCookie } from '@/lib/server-auth'

// 로그아웃 — HttpOnly 로그인 쿠키(nd_auth)는 브라우저 JS 로 못 지우므로 서버에서 만료시킨다
export async function POST() {
  const res = NextResponse.json({ ok: true })
  clearAuthCookie(res)
  return res
}
