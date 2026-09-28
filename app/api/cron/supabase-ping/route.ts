import { NextResponse } from 'next/server'
import { pingSupabase } from '@/lib/supabase'

/**
 * Supabase 매일 깨우기 — Vercel cron(vercel.json, 매일 한국시간 04:00)이 호출.
 * 무료 요금제는 7일 동안 요청이 없으면 프로젝트가 자동 정지되므로 하루 1번 dashboard_data 에서 행 1개 id 만 읽는다.
 * 인증: Authorization: Bearer $CRON_SECRET (Vercel cron 이 자동으로 붙임) 또는 ?secret=$CRON_SECRET
 */
export const dynamic = 'force-dynamic'

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; code?: string }
    const parts = [e.message, e.details, e.code && `(code ${e.code})`].filter(Boolean)
    return parts.length ? parts.join(' · ') : JSON.stringify(err)
  }
  return String(err)
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ ok: false, error: 'CRON_SECRET 미설정' }, { status: 500 })
  const url = new URL(req.url)
  const authed = req.headers.get('authorization') === `Bearer ${secret}` || url.searchParams.get('secret') === secret
  if (!authed) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const started = Date.now()
  try {
    const id = await pingSupabase()
    return NextResponse.json({ ok: true, row: id ? 'found' : 'empty', ms: Date.now() - started, at: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Supabase 읽기 실패 — ${errText(err)}` }, { status: 500 })
  }
}
