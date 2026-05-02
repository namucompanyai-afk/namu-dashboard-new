import { NextResponse } from 'next/server'
import { getData, saveData, deleteData, listByPrefix } from '@/lib/supabase'

/**
 * 스마트스토어 진단 결과 저장 API
 *
 * 키 패턴:
 *  - naver_diagnosis_last           : 마지막 자동 저장 (1개 덮어쓰기)
 *  - naver_diagnosis_item__{id}     : 명시 저장 (개별 row)
 *
 * 네이버 snapshot 은 쿠팡 대비 크기가 작아 raw 분리 미적용 (products 77종 inline).
 *
 * GET    ?type=last|list|item&id=...
 * POST   { type: 'last'|'explicit', snapshot }
 * DELETE ?id=... | ?purgeAll=1
 */

const KEY_LAST = 'naver_diagnosis_last'
const KEY_ITEM_PREFIX = 'naver_diagnosis_item__'

interface NaverSnapshot {
  id?: string
  label?: string
  monthKey?: string | null
  weekKey?: string | null
  trendType?: 'weekly' | 'monthly' | null
  includeInTrend?: boolean

  period: { start: string; end: string }
  summary: {
    revenue: number
    settleAmount: number
    settleFee: number
    cost: number
    bag: number
    box: number
    pack: number
    shipReal: number
    shipRevenue: number
    adCost: number
    netProfit: number
    productOrderCount: number
    matched: number
    unmatched: number
  }
  // 상품별 분해 (옵션)
  products?: Array<{
    productName: string
    count: number
    revenue: number
    cost: number
    profit: number
    matched: boolean
  }>
  createdAt?: string
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') || 'last'

    if (type === 'last') {
      const saved = await getData(KEY_LAST)
      return NextResponse.json(saved || null)
    }

    if (type === 'list') {
      const rows = await listByPrefix(KEY_ITEM_PREFIX)
      const diagnoses = rows
        .map((r: { data: unknown }) => r.data as NaverSnapshot)
        .filter(Boolean)
        // products 는 목록 응답에서 제거 (가벼움 유지)
        .map((d: NaverSnapshot) => {
          const { products: _products, ...meta } = d
          void _products
          return meta
        })
      return NextResponse.json({ diagnoses })
    }

    if (type === 'item') {
      const id = searchParams.get('id')
      if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 })
      const data = await getData(`${KEY_ITEM_PREFIX}${id}`)
      return NextResponse.json(data || null)
    }

    return NextResponse.json({ error: 'type=last|list|item' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { type } = body as { type: 'last' | 'explicit' }

    if (type === 'last') {
      const { snapshot } = body as { snapshot: NaverSnapshot }
      if (!snapshot) return NextResponse.json({ error: 'snapshot 필요' }, { status: 400 })
      await saveData(KEY_LAST, snapshot)
      return NextResponse.json({ ok: true, type: 'last' })
    }

    if (type === 'explicit') {
      const { snapshot } = body as { snapshot: NaverSnapshot }
      if (!snapshot) return NextResponse.json({ error: 'snapshot 필요' }, { status: 400 })

      const newId = snapshot.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newSnapshot: NaverSnapshot = {
        ...snapshot,
        id: newId,
        createdAt: snapshot.createdAt || new Date().toISOString(),
      }
      await saveData(`${KEY_ITEM_PREFIX}${newId}`, newSnapshot)
      return NextResponse.json({ ok: true, type: 'explicit', id: newId, snapshot: newSnapshot })
    }

    return NextResponse.json({ error: 'type=last|explicit' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const purgeAll = searchParams.get('purgeAll') === '1'

    if (purgeAll) {
      const result = { ok: true, purgedAll: true, deleted: { individual: 0, last: 0 }, errors: [] as string[] }
      try {
        const rows = await listByPrefix(KEY_ITEM_PREFIX)
        for (const r of rows as Array<{ id: string }>) {
          try {
            const cnt = await deleteData(r.id)
            result.deleted.individual += cnt
          } catch (e) {
            result.errors.push(`item ${r.id}: ${String(e)}`)
          }
        }
      } catch (e) {
        result.errors.push(`listByPrefix item: ${String(e)}`)
      }
      try {
        result.deleted.last = await deleteData(KEY_LAST)
      } catch (e) {
        result.errors.push(`last: ${String(e)}`)
      }
      return NextResponse.json(result)
    }

    if (!id) return NextResponse.json({ error: 'id 파라미터 필요' }, { status: 400 })
    const deletedCount = await deleteData(`${KEY_ITEM_PREFIX}${id}`)
    return NextResponse.json({ ok: true, deleted: id, deletedCount })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
