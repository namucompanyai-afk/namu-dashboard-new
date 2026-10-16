import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server-auth'
import {
  listDemographicPeriods,
  getDemographicsMulti,
  getAllDemographics,
  replaceDemographics,
  type DemographicRow,
} from '@/lib/supabase'

/**
 * 스마트스토어 고객분석 (ss_customer_demographics) — 호출 화면: /sales/customer-analysis
 *
 * 브라우저가 Supabase 에 직접 붙지 않도록 서버를 거친다. 공용 도구라 업로더 구분 없이 같은 데이터를 본다.
 *
 * GET  ?periods=1           → { ok, periods: string[] }        저장된 기간 (최신 우선)
 * GET  ?period=a&period=b   → { ok, rows: DemographicRow[] }   선택 기간 행
 * GET  ?all=1               → { ok, rows: DemographicRow[] }   전체 원본 (RAW 다운로드)
 * POST body { period, rows } → { ok, inserted }                같은 기간 교체 (업로더 = 쿠키 이메일)
 */
export const dynamic = 'force-dynamic'

const ALLOWED = ['admin', 'staff']
const NO_STORE = { 'Cache-Control': 'no-store' }

function check(req: Request) {
  const s = getSession(req)
  if (!s) return { denied: NextResponse.json({ ok: false, error: '로그인이 필요합니다.' }, { status: 401 }) }
  if (!ALLOWED.includes(s.role)) return { denied: NextResponse.json({ ok: false, error: '접근 권한이 없습니다.' }, { status: 403 }) }
  return { email: s.email ?? '' }
}

export async function GET(req: Request) {
  const c = check(req)
  if (c.denied) return c.denied
  const q = new URL(req.url).searchParams
  try {
    if (q.get('periods')) {
      return NextResponse.json({ ok: true, periods: await listDemographicPeriods(c.email) }, { headers: NO_STORE })
    }
    if (q.get('all')) {
      return NextResponse.json({ ok: true, rows: await getAllDemographics(c.email) }, { headers: NO_STORE })
    }
    const periods = q.getAll('period').filter(Boolean)
    return NextResponse.json({ ok: true, rows: await getDemographicsMulti(c.email, periods) }, { headers: NO_STORE })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const c = check(req)
  if (c.denied) return c.denied
  const body = await req.json().catch(() => null)
  const period = body?.period
  const rows = body?.rows as Omit<DemographicRow, 'user_email' | 'period'>[] | undefined
  // 기간 예: 2026-03 · 2025-12_2026-05 (화면 입력값 그대로)
  if (typeof period !== 'string' || !/^[\w.~-]{1,40}$/.test(period.trim()) || !Array.isArray(rows)) {
    return NextResponse.json({ ok: false, error: 'period·rows 형식 오류' }, { status: 400 })
  }
  try {
    const inserted = await replaceDemographics(c.email, period.trim(), rows)
    return NextResponse.json({ ok: true, inserted })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
