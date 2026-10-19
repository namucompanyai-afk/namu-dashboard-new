import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server'
import { getData, saveData } from '@/lib/supabase'
import { BACKFILL_KEY, SALES_KEY, commentKey, type SalesRow, type WeeklyComment } from '@/lib/coupang/adWeekly13'

/**
 * 광고 분석 상단 '브레인 코멘트'·'이번 주 성과' 보조 API (관리자만)
 *
 * GET  /api/coupang-ad-overview?week=YYYY-MM-DD
 *   → { backfill: BackfillRow[], sales: SalesRow[], comment: WeeklyComment | null }
 *   주간 기록(coupang_ad_weekly_snapshots)은 기존 /api/coupang-ad-weekly 로 읽는다.
 * POST { type: 'comment', weekStart, headline, items[4], baseFile? }  → coupang_ad_weekly_comment_<weekStart> 저장 (브레인이 월요일에)
 * POST { type: 'sales', s, sales1p, sales3p }                          → coupang_sales_weekly 에 그 주 넣기/바꾸기 (관리자 입력 칸)
 * 백필(coupang_ad_weekly_backfill)은 읽기만 — 일별 보고서 환산 값을 한 번 채워 두는 키.
 */

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export async function GET(req: Request) {
  // 관리자만 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석 (손익 포함)
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const week = new URL(req.url).searchParams.get('week')
    const [backfill, sales, comment] = await Promise.all([
      getData(BACKFILL_KEY),
      getData(SALES_KEY),
      isDate(week) ? getData(commentKey(week)) : Promise.resolve(null),
    ])
    return NextResponse.json({
      ok: true,
      backfill: Array.isArray(backfill) ? backfill : [],
      sales: Array.isArray(sales) ? sales : [],
      comment: (comment as WeeklyComment | null) ?? null,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const body = await req.json()
    if (body?.type === 'comment') {
      const items = Array.isArray(body.items) ? (body.items as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean) : []
      if (!isDate(body.weekStart) || typeof body.headline !== 'string' || !items.length) {
        return NextResponse.json({ ok: false, error: 'weekStart·headline·items 필요' }, { status: 400 })
      }
      const c: WeeklyComment = {
        headline: body.headline.trim(),
        items: items.slice(0, 4),
        writtenAt: new Date().toISOString(),
        baseFile: typeof body.baseFile === 'string' ? body.baseFile : undefined,
      }
      await saveData(commentKey(body.weekStart), c)
      return NextResponse.json({ ok: true, comment: c })
    }
    if (body?.type === 'sales') {
      const s = body.s
      const p1 = Number(body.sales1p)
      const p3 = Number(body.sales3p)
      if (!isDate(s) || !Number.isFinite(p1) || !Number.isFinite(p3) || p1 < 0 || p3 < 0) {
        return NextResponse.json({ ok: false, error: '주 시작일(YYYY-MM-DD)·1P·3P 숫자 필요' }, { status: 400 })
      }
      if (new Date(`${s}T00:00:00Z`).getUTCDay() !== 1) return NextResponse.json({ ok: false, error: '주 시작일은 월요일' }, { status: 400 })
      const cur = (((await getData(SALES_KEY)) as SalesRow[] | null) ?? []).filter((x) => x.s !== s)
      cur.push({ s, e: addDays(s, 6), sales1p: Math.round(p1), sales3p: Math.round(p3), src: 'manual' })
      cur.sort((a, b) => a.s.localeCompare(b.s))
      await saveData(SALES_KEY, cur)
      return NextResponse.json({ ok: true, sales: cur })
    }
    return NextResponse.json({ ok: false, error: "type 은 'comment' 또는 'sales'" }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
