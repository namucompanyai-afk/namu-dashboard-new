import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server'
import { deleteData, getData, saveData } from '@/lib/supabase'

/**
 * 쿠팡 광고 분석 '주간 (라이브)' 30일 파일 저장 API — 새로고침해도 할 일·키워드·'반영됨'이 남게
 *
 * 키: coupang_ad_live_30d   payload: { fileName, period, downloadedAt, savedAt, rows: PackedAdRows }
 * 최신 1개만 — 새로 올리면 교체. 주간 기록(coupang_ad_weekly_snapshots)·월 저장본(pnl_*)과는 별개 키.
 * GET    /api/coupang-ad-live            → { enabled, item }  (item 없으면 null)
 * POST   /api/coupang-ad-live { item }   → 교체 저장
 * DELETE /api/coupang-ad-live            → 삭제
 *
 * 기능 스위치: 서버 환경변수 AD_LIVE_30D_SAVE=on 일 때만 읽고 쓴다 (기본 꺼짐 — Supabase 보안 작업 배포 후 켬).
 * 꺼져 있으면 모든 요청에 { enabled: false } 만 돌려주고 Supabase 를 건드리지 않는다.
 */

const KEY = 'coupang_ad_live_30d'
const MONTHLY_MIN_DAYS = 25

const enabled = () => process.env.AD_LIVE_30D_SAVE === 'on'
const off = () => NextResponse.json({ ok: true, enabled: false, item: null })
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

interface LiveItem {
  fileName: string
  period: { startDate: string; endDate: string; days: number }
  downloadedAt?: string
  savedAt: string
  rows: { v: 1; cols: string[]; s: string[]; r: number[][] }
}

export async function GET(req: Request) {
  // 관리자만 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  if (!enabled()) return off()
  try {
    const item = ((await getData(KEY)) as LiveItem | null) ?? null
    return NextResponse.json({ ok: true, enabled: true, item })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  if (!enabled()) return off()
  try {
    const body = await req.json()
    const it = body?.item as LiveItem | undefined
    const p = it?.period
    if (!it || typeof it.fileName !== 'string' || !p || !isDate(p.startDate) || !isDate(p.endDate) || !(p.days >= MONTHLY_MIN_DAYS)) {
      return NextResponse.json({ ok: false, error: '30일 파일(25일 이상) 형식 오류' }, { status: 400 })
    }
    if (it.rows?.v !== 1 || !Array.isArray(it.rows.cols) || !Array.isArray(it.rows.s) || !Array.isArray(it.rows.r) || !it.rows.r.length) {
      return NextResponse.json({ ok: false, error: '광고 행 형식 오류' }, { status: 400 })
    }
    const item: LiveItem = {
      fileName: it.fileName,
      period: { startDate: p.startDate, endDate: p.endDate, days: p.days },
      downloadedAt: typeof it.downloadedAt === 'string' ? it.downloadedAt : undefined,
      savedAt: new Date().toISOString(),
      rows: it.rows,
    }
    await saveData(KEY, item)
    return NextResponse.json({ ok: true, enabled: true, savedAt: item.savedAt })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  if (!enabled()) return off()
  try {
    await deleteData(KEY)
    return NextResponse.json({ ok: true, enabled: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
