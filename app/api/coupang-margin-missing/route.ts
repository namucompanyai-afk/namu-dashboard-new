import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server'
import { getData, listIdsByPrefix, saveData } from '@/lib/supabase'

/**
 * 광고 분석 '마진계산에 없는 상품' 알림 보조 API (관리자만)
 *
 * GET  /api/coupang-margin-missing
 *   → { enabled, firstSeen: { 옵션ID: 'YYYY-MM-DD' }, catalogDate, pidByOption: { 옵션ID: 노출상품ID } }
 *   pidByOption = 가장 최근 윙 스냅샷(coupang_catalog_YYYY-MM-DD, 결합 감지 스크립트가 저장) — 3P 붙여넣기 줄 노출ID 용
 * POST /api/coupang-margin-missing { optionIds: string[] } → 처음 보는 옵션만 오늘 날짜로 기록 (이미 있으면 그대로)
 *
 * 기능 스위치: 처음 잡힌 날 기록은 서버 환경변수 MARGIN_MISSING_SAVE=on 일 때만 읽고 쓴다 (기본 꺼짐 — 대표 확인 후 켬).
 * 꺼져 있어도 GET 은 윙 노출ID 맵을 돌려준다 (읽기만).
 */

const KEY = 'coupang_margin_missing_first_seen'
const CATALOG_PREFIX = 'coupang_catalog_20' // 'coupang_catalog_search_…' 와 안 섞이게 날짜로 시작하는 것만
const enabled = () => process.env.MARGIN_MISSING_SAVE === 'on'
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

export async function GET(req: Request) {
  // 관리자만 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const ids = await listIdsByPrefix(CATALOG_PREFIX)
    const latest = ids[ids.length - 1]
    const pidByOption: Record<string, string> = {}
    let catalogDate: string | null = null
    if (latest) {
      const snap = (await getData(latest)) as { date?: string; rows?: { oid: string; pid: string }[] } | null
      catalogDate = snap?.date ?? null
      for (const r of snap?.rows ?? []) if (r.oid && r.pid) pidByOption[r.oid] = r.pid
    }
    const firstSeen = enabled() ? (((await getData(KEY)) as Record<string, string> | null) ?? {}) : {}
    return NextResponse.json({ ok: true, enabled: enabled(), firstSeen, catalogDate, pidByOption })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  if (!enabled()) return NextResponse.json({ ok: true, enabled: false, firstSeen: {} })
  try {
    const body = await req.json()
    const ids = Array.isArray(body?.optionIds) ? (body.optionIds as unknown[]).map((x) => String(x).trim()).filter((x) => /^\d+$/.test(x)) : []
    const cur = (((await getData(KEY)) as Record<string, string> | null) ?? {})
    const today = kstToday()
    let added = 0
    for (const id of ids) {
      if (!cur[id]) {
        cur[id] = today
        added += 1
      }
    }
    if (added) await saveData(KEY, cur)
    return NextResponse.json({ ok: true, enabled: true, added, firstSeen: cur })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
