import { NextResponse } from 'next/server'
import { getData, saveData } from '@/lib/supabase'

/**
 * 캠페인 목표 ROAS 저장 API
 *
 * 같은 prefix+타입(AI|수동|스마트)의 캠페인은 분석 업로드가 갱신되어도
 * 동일한 목표 ROAS 를 공유한다. 캠페인 행이 사라져도 (해당 주차에 데이터 없음)
 * 사용자가 입력한 목표값은 유지되어야 하므로 단일 k/v blob 로 저장.
 *
 * 키: `${prefix}::${typeKind}` — typeKind ∈ {'AI', '수동', '스마트'}
 * 값: 정수 (%, 예: 400) | null
 *
 * GET  /api/campaign-targets       → { targets: Record<string, number> }
 * POST /api/campaign-targets       → 단일 키 upsert (body: { key, value })
 *                                    value 가 null/undefined/0 이하 → 해당 키 삭제
 */

const STORE_KEY = 'coupang_campaign_targets'

type Targets = Record<string, number>

async function loadTargets(): Promise<Targets> {
  const saved = await getData(STORE_KEY)
  if (!saved) return {}
  // 과거 호환: data 객체 자체가 targets 일 수도, { data: {...} } 형식일 수도.
  if (saved.targets && typeof saved.targets === 'object') return saved.targets as Targets
  if (typeof saved === 'object') return saved as Targets
  return {}
}

export async function GET() {
  try {
    const targets = await loadTargets()
    return NextResponse.json({ targets })
  } catch (err) {
    return NextResponse.json({ error: String(err), targets: {} }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const key: string | undefined = body?.key
    const rawValue = body?.value

    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'key 필요' }, { status: 400 })
    }

    const targets = await loadTargets()

    if (rawValue == null || rawValue === '' || !Number.isFinite(Number(rawValue)) || Number(rawValue) <= 0) {
      delete targets[key]
    } else {
      targets[key] = Math.round(Number(rawValue))
    }

    await saveData(STORE_KEY, { targets, savedAt: new Date().toISOString() })
    return NextResponse.json({ ok: true, targets })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
