'use client'

import React, { useEffect, useMemo, useState } from 'react'

// ── 구글시트 설정 ────────────────────────────────────────────────
const SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg'
// 탭 이름 공백 포함 → 작은따옴표 + encodeURIComponent
const RANGE = "'진도팜 원가표'!A4:K"

// R4 헤더 순서: A 원료ID / B 구분 / C 품목 / D 품종 / E 1kg당원곡가 /
//               F 포장형태 / G 작업비직접입력 / H 작업비 / I 공급가 / J 과세여부 / K 취급상태
type CostRow = {
  rawId: string      // A 원료ID
  category: string   // B 구분
  item: string       // C 품목
  variety: string    // D 품종
  price: number      // E 1kg당원곡가
  pkg: string        // F 포장형태
  workCost: number   // H 작업비
  supply: number     // I 공급가
  tax: string        // J 과세여부
  status: string     // K 취급상태
}

// 콤마/원 제거 후 숫자화
const toNum = (v: string | undefined): number => {
  if (!v) return 0
  const n = Number(String(v).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

// 구분 고정 정렬 순서 (그 외 맨 뒤)
const CATEGORY_ORDER = ['유기농', '무농약', '관행', '수입']
const catRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf((c || '').trim())
  return i === -1 ? CATEGORY_ORDER.length : i
}

// ── 역할 판별 (기존 인증에 진도팜/나무 역할 없음 → 상단 토글) ──────
type Role = 'jindo' | 'namu'
type Device = 'pc' | 'phone'

// 컬럼 정의
type ColKey = keyof CostRow
const COL_LABEL: Record<ColKey, string> = {
  rawId: '원료ID',
  category: '구분',
  item: '품목',
  variety: '품종',
  price: '1kg당원곡가',
  pkg: '포장형태',
  workCost: '작업비',
  supply: '공급가',
  tax: '과세여부',
  status: '취급상태',
}
const NUM_COLS: ColKey[] = ['price', 'workCost', 'supply']

// 역할 × 기기별 노출 컬럼
function visibleCols(role: Role, device: Device): ColKey[] {
  if (device === 'pc') {
    return role === 'jindo'
      ? ['category', 'item', 'variety', 'price', 'tax']
      : ['rawId', 'category', 'item', 'variety', 'price', 'pkg', 'workCost', 'supply', 'tax', 'status']
  }
  // phone
  return role === 'jindo'
    ? ['category', 'item', 'variety', 'price']
    : ['category', 'item', 'variety', 'price', 'workCost', 'supply', 'tax']
}

// 기기 감지 (md 브레이크포인트 768px)
function useDevice(): Device {
  const [device, setDevice] = useState<Device>('pc')
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setDevice(mq.matches ? 'phone' : 'pc')
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return device
}

// 과세 배지
function TaxBadge({ value }: { value: string }) {
  const v = (value || '').trim()
  const taxed = v.includes('과세')
  const label = taxed ? '과세' : '면세'
  return (
    <span
      className={
        'inline-block rounded px-2 py-0.5 text-xs font-medium ' +
        (taxed ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700')
      }
    >
      {label}
    </span>
  )
}

// 취급상태 O/X
function StatusMark({ value }: { value: string }) {
  const on = /^(o|취급|사용|y|1|가능|활성)/i.test((value || '').trim())
  return (
    <span className={'font-bold ' + (on ? 'text-green-600' : 'text-gray-400')}>
      {on ? 'O' : 'X'}
    </span>
  )
}

export default function JindopamCostPage() {
  const [rows, setRows] = useState<CostRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('namu')
  const device = useDevice()

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GSHEET_API_KEY
    if (!key) {
      setError('API 키가 설정되지 않았습니다. (.env.local 의 NEXT_PUBLIC_GSHEET_API_KEY)')
      setLoading(false)
      return
    }
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
      `${encodeURIComponent(RANGE)}?key=${key}`

    let alive = true
    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`시트 응답 오류 (${res.status})`)
        const json = await res.json()
        const values: string[][] = json.values || []
        // values[0] = R4 헤더 → 스킵, R5부터 데이터
        const data: CostRow[] = values
          .slice(1)
          .filter((r) => (r[2] || '').trim() !== '') // 품목(C) 빈 행 스킵
          .map((r) => ({
            rawId: (r[0] || '').trim(),
            category: (r[1] || '').trim(),
            item: (r[2] || '').trim(),
            variety: (r[3] || '').trim(),
            price: toNum(r[4]),
            pkg: (r[5] || '').trim(),
            workCost: toNum(r[7]),
            supply: toNum(r[8]),
            tax: (r[9] || '').trim(),
            status: (r[10] || '').trim(),
          }))
        if (alive) {
          setRows(data)
          setLoading(false)
        }
      } catch (e: any) {
        if (alive) {
          setError(e?.message || '데이터를 불러오지 못했습니다.')
          setLoading(false)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const cols = visibleCols(role, device)

  const view = useMemo(() => {
    // 나무 × 폰 → 소포장 행만 (외부 견적용)
    let list = rows
    if (role === 'namu' && device === 'phone') {
      list = list.filter((r) => r.pkg.includes('소포장'))
    }
    // 정렬: 구분(고정순서) → 품목(ko) → 품종(ko)
    return [...list].sort((a, b) => {
      const c = catRank(a.category) - catRank(b.category)
      if (c !== 0) return c
      const it = a.item.localeCompare(b.item, 'ko')
      if (it !== 0) return it
      return a.variety.localeCompare(b.variety, 'ko')
    })
  }, [rows, role, device])

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">원가표</h1>
          <p className="text-sm text-gray-500 mt-1">진도팜 → 나무 공급 단가</p>
        </div>
        {/* 임시 역할 토글 (진도팜/나무) */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 text-sm">
          {(['jindo', 'namu'] as Role[]).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={
                'px-3 py-1.5 rounded-md font-medium transition-colors ' +
                (role === r ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')
              }
            >
              {r === 'jindo' ? '진도팜' : '나무'}
            </button>
          ))}
        </div>
      </div>

      {/* 본문 카드 */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {loading && (
          <div className="flex items-center justify-center gap-3 py-16 text-gray-500">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
            <span className="text-sm">원가 데이터를 불러오는 중…</span>
          </div>
        )}

        {!loading && error && (
          <div className="py-16 text-center">
            <p className="text-sm text-red-600">⚠️ {error}</p>
            <p className="mt-1 text-xs text-gray-400">시트 공개 상태와 API 키를 확인해 주세요.</p>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
              <span className="text-sm text-gray-500">총 {view.length}건</span>
              {role === 'namu' && device === 'phone' && (
                <span className="text-xs text-gray-400">소포장 견적 뷰</span>
              )}
            </div>
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    {cols.map((k) => (
                      <th
                        key={k}
                        className={
                          'whitespace-nowrap px-3 py-2 font-medium ' +
                          (NUM_COLS.includes(k) ? 'text-right' : 'text-left')
                        }
                      >
                        {COL_LABEL[k]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.length === 0 && (
                    <tr>
                      <td colSpan={cols.length} className="py-12 text-center text-sm text-gray-400">
                        표시할 데이터가 없습니다.
                      </td>
                    </tr>
                  )}
                  {view.map((row, i) => (
                    <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                      {cols.map((k) => (
                        <td
                          key={k}
                          className={
                            'whitespace-nowrap px-3 py-2 ' +
                            (NUM_COLS.includes(k) ? 'text-right font-mono' : 'text-left')
                          }
                        >
                          {k === 'tax' ? (
                            <TaxBadge value={row.tax} />
                          ) : k === 'status' ? (
                            <StatusMark value={row.status} />
                          ) : NUM_COLS.includes(k) ? (
                            (row[k] as number).toLocaleString()
                          ) : (
                            (row[k] as string) || '-'
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
