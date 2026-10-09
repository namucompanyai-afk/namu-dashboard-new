import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/server-auth'

/**
 * POST /api/b2b/slack-report  { text, dry? } — 쿠팡 발주 매출 보고를 #공유-데일리세일즈 로 보낸다.
 *
 * 웹훅은 SLACK_SALES_WEBHOOK_URL (진도팜 알림용 SLACK_WEBHOOK_URL 과 별개).
 * 웹훅 주소는 응답·로그 어디에도 내보내지 않는다.
 * dry=1(또는 true)이면 전송 없이 text 와 웹훅 설정 여부만 돌려준다.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_TEXT = 8000

export async function POST(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 허용: admin, staff
  const denied = requireRole(req, ['admin', 'staff'])
  if (denied) return denied

  let body: { text?: unknown; dry?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: '요청 본문(JSON)을 읽지 못했습니다.' }, { status: 400 })
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return NextResponse.json({ ok: false, error: '보낼 내용이 없습니다.' }, { status: 400 })
  if (text.length > MAX_TEXT) return NextResponse.json({ ok: false, error: '보낼 내용이 너무 깁니다.' }, { status: 400 })

  const url = process.env.SLACK_SALES_WEBHOOK_URL
  const dry = body.dry === true || body.dry === 1 || body.dry === '1'
  if (dry) return NextResponse.json({ ok: true, dry: true, webhookConfigured: !!url, text })
  if (!url) return NextResponse.json({ ok: false, error: 'SLACK_SALES_WEBHOOK_URL 없음' }, { status: 500 })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      console.error('[b2b/slack-report] 슬랙 전송 실패:', res.status, detail)
      return NextResponse.json({ ok: false, error: `슬랙 전송 실패 (HTTP ${res.status}${detail ? ` · ${detail}` : ''})` }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[b2b/slack-report] 슬랙 전송 오류:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ ok: false, error: '슬랙 전송 중 네트워크 오류' }, { status: 502 })
  }
}
