'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'

// ── 구글시트 설정 ────────────────────────────────────────────────
const SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg'
// 탭 이름 공백 포함 → 작은따옴표 + encodeURIComponent
const RANGE = "'진도팜 원가표'!A4:G"
// 가공비(J5:K10 6항목)·배송비(J13:L15) 참고 기준표 (init7이 배치한 고정 오프셋)
const RANGE_REF = "'진도팜 원가표'!J4:L15"

// 참고표 값 (시트에서 read, 하드코딩 아님)
type RefCost = {
  작업비소포장: number
  작업비벌크: number
  파쇄비: number
  제분비: number
  혼합비기본: number
  혼합비추가: number
}
type RefShip = { 규격: string; 박스: number; 택배: number }
// 배송비 규격별 기준(무게) 표기 — UI 라벨(값 아님)
const SHIP_STD: Record<string, string> = { 소: '1~3kg', 중: '4~10kg', 대: '11~20kg' }

// R4 헤더 순서(원곡가 중심): A 원료ID / B 구분 / C 품목 / D 품종 /
//                            E 1kg당 원곡가 / F 과세여부 / G 취급상태
type CostRow = {
  rawId: string      // A 원료ID (내부 키, 표시 안 함)
  category: string   // B 구분
  item: string       // C 품목
  variety: string    // D 품종
  price: number      // E 1kg당 원곡가
  tax: string        // F 과세여부
  status: string     // G 취급상태
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

type Device = 'pc' | 'phone'

// 컬럼 정의 (통합 원곡표 · 진도팜/나무 뷰 구분 없음)
type ColKey = 'category' | 'item' | 'variety' | 'price' | 'tax' | 'status'
const COL_LABEL: Record<ColKey, string> = {
  category: '구분',
  item: '품목',
  variety: '품종',
  price: '1kg당 원곡가',
  tax: '과세여부',
  status: '취급상태',
}
const NUM_COLS: ColKey[] = ['price']

// 기기별 노출 컬럼 — 폰은 취급상태 숨김
function visibleCols(device: Device): ColKey[] {
  return device === 'pc'
    ? ['category', 'item', 'variety', 'price', 'tax', 'status']
    : ['category', 'item', 'variety', 'price', 'tax']
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

// 취급상태 O/X (빈칸이면 '-')
function StatusMark({ value }: { value: string }) {
  const v = (value || '').trim()
  if (v === '') return <span className="text-gray-300">-</span>
  const on = /^(o|취급|사용|y|1|가능|활성)/i.test(v)
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
  const [editorLabel, setEditorLabel] = useState('나무') // 변동로그 변경자 표기
  const [refCost, setRefCost] = useState<RefCost | null>(null)
  const [refShip, setRefShip] = useState<RefShip[]>([])
  const [showRef, setShowRef] = useState(false) // 참고표 펼침 (기본 접힘)
  // 참고표 항목별 수정 모달 (가공비/배송비 공용)
  const [refEdit, setRefEdit] = useState<null | {
    title: string
    kind: 'cost' | 'ship'
    fields: { item: string; label: string; current: number }[]
  }>(null)
  const device = useDevice()

  // 로그인 role로 변경자 표기만 판별 (뷰 자체는 통합, 분기 없음)
  useEffect(() => {
    try {
      const userStr = localStorage.getItem('user')
      const userRole = userStr ? JSON.parse(userStr)?.role : null
      setEditorLabel(userRole === '진도팜' ? '진도팜' : '나무')
    } catch {
      /* 파싱 실패 시 기본 '나무' */
    }
  }, [])

  // 편집 모달 상태
  const [editRow, setEditRow] = useState<CostRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  // 구분 필터 ('전체' + 고정순서 구분). 화면 필터만, 시트/데이터 무변형.
  const [catFilter, setCatFilter] = useState<string>('전체')

  // 원가표 read (저장 후 재호출용으로 함수화)
  const loadData = useCallback(async () => {
    const key = process.env.NEXT_PUBLIC_GSHEET_API_KEY
    if (!key) {
      setError('API 키가 설정되지 않았습니다. (.env.local 의 NEXT_PUBLIC_GSHEET_API_KEY)')
      setLoading(false)
      return
    }
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/`
    const url = `${base}${encodeURIComponent(RANGE)}?key=${key}`
    const refUrl = `${base}${encodeURIComponent(RANGE_REF)}?key=${key}`
    try {
      setLoading(true)
      setError(null)
      const [res, refRes] = await Promise.all([fetch(url), fetch(refUrl)])
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
          tax: (r[5] || '').trim(),
          status: (r[6] || '').trim(),
        }))
      setRows(data)
      // 참고 기준표 (J4:L15 고정 오프셋: 0=가공비헤더, 1~6=가공비 6항목, 7=빈행, 8=배송비헤더, 9~11=배송비)
      if (refRes.ok) {
        const rj = await refRes.json()
        const rv: string[][] = rj.values || []
        setRefCost({
          작업비소포장: toNum(rv[1]?.[1]),
          작업비벌크: toNum(rv[2]?.[1]),
          파쇄비: toNum(rv[3]?.[1]),
          제분비: toNum(rv[4]?.[1]),
          혼합비기본: toNum(rv[5]?.[1]),
          혼합비추가: toNum(rv[6]?.[1]),
        })
        setRefShip(
          [9, 10, 11]
            .map((i) => rv[i])
            .filter((r) => r && (r[0] || '').trim() !== '')
            .map((r) => ({ 규격: (r[0] || '').trim(), 박스: toNum(r[1]), 택배: toNum(r[2]) })),
        )
      }
      setLoading(false)
    } catch (e: any) {
      setError(e?.message || '데이터를 불러오지 못했습니다.')
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const cols = visibleCols(device)

  // 구분 탭별 건수 (로드된 전체 데이터 기준). 데이터 없는 구분도 0으로 노출.
  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1)
    return m
  }, [rows])

  const view = useMemo(() => {
    // 구분 필터('전체'는 전부) → 정렬: 구분(고정순서) → 품목(ko) → 품종(ko)
    return rows
      .filter((r) => catFilter === '전체' || r.category === catFilter)
      .sort((a, b) => {
        const c = catRank(a.category) - catRank(b.category)
        if (c !== 0) return c
        const it = a.item.localeCompare(b.item, 'ko')
        if (it !== 0) return it
        return a.variety.localeCompare(b.variety, 'ko')
      })
  }, [rows, catFilter])

  // 구분 rowspan 병합: 연속 같은 구분 구간의 첫 행에 span 길이, 나머지는 0(구분 td 생략)
  const catRowSpan = useMemo(() => {
    const spans = new Array<number>(view.length).fill(0)
    let i = 0
    while (i < view.length) {
      let j = i
      while (j < view.length && view[j].category === view[i].category) j++
      spans[i] = j - i
      i = j
    }
    return spans
  }, [view])

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">원가표</h1>
          <p className="text-sm text-gray-500 mt-1">진도팜 → 나무 공급 단가</p>
        </div>
        {/* 신규 추가 (진도팜·나무 공통) */}
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700"
        >
          ＋ 신규 원료 추가
        </button>
      </div>

      {/* 가공비·배송비 참고표 (기본 접힘) */}
      <div>
        <button
          onClick={() => setShowRef((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          <span className={'inline-block transition-transform ' + (showRef ? 'rotate-90' : '')}>▶</span>
          가공비·배송비 참고표
        </button>

        {showRef && (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* 가공비 */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-2 text-sm font-semibold">가공비</div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">항목</th>
                    <th className="px-3 py-2 text-right font-medium">단가</th>
                    <th className="px-3 py-2 text-left font-medium">단위</th>
                    <th className="px-3 py-2 text-right font-medium">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { item: '작업비(소포장)', v: refCost?.작업비소포장 },
                    { item: '작업비(벌크)', v: refCost?.작업비벌크 },
                    { item: '파쇄비', v: refCost?.파쇄비 },
                    { item: '제분비', v: refCost?.제분비 },
                    { item: '혼합비(5곡까지)', v: refCost?.혼합비기본 },
                    { item: '혼합비(추가1곡당)', v: refCost?.혼합비추가 },
                  ].map((r) => (
                    <tr key={r.item} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-left">{r.item}</td>
                      <td className="px-3 py-2 text-right font-mono">{(r.v ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2 text-left text-gray-400">원/kg</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() =>
                            setRefEdit({
                              title: `${r.item} 수정`,
                              kind: 'cost',
                              fields: [{ item: r.item, label: '단가', current: r.v ?? 0 }],
                            })
                          }
                          className="rounded-md border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 배송비 */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-sm font-semibold">
                배송비
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-500">참고</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">규격</th>
                    <th className="px-3 py-2 text-right font-medium">박스</th>
                    <th className="px-3 py-2 text-right font-medium">택배</th>
                    <th className="px-3 py-2 text-left font-medium">기준</th>
                    <th className="px-3 py-2 text-right font-medium">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {refShip.map((s) => (
                    <tr key={s.규격} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-left">{s.규격}</td>
                      <td className="px-3 py-2 text-right font-mono">{s.박스.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono">{s.택배.toLocaleString()}</td>
                      <td className="px-3 py-2 text-left text-gray-400">
                        {SHIP_STD[s.규격] || ''}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() =>
                            setRefEdit({
                              title: `배송비(${s.규격}) 수정`,
                              kind: 'ship',
                              fields: [
                                { item: `박스(${s.규격})`, label: '박스', current: s.박스 },
                                { item: `택배(${s.규격})`, label: '택배', current: s.택배 },
                              ],
                            })
                          }
                          className="rounded-md border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-100 px-4 py-2">
              {/* 구분 필터 탭 (전체 + 고정순서). 화면 필터만 */}
              <div className="flex flex-wrap gap-1.5">
                {['전체', ...CATEGORY_ORDER].map((c) => {
                  const count = c === '전체' ? rows.length : (catCounts.get(c) ?? 0)
                  const active = catFilter === c
                  return (
                    <button
                      key={c}
                      onClick={() => setCatFilter(c)}
                      className={
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                        (active
                          ? 'border-gray-900 bg-gray-900 text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')
                      }
                    >
                      {c} <span className={active ? 'text-gray-300' : 'text-gray-400'}>{count}</span>
                    </button>
                  )
                })}
              </div>
              <span className="text-sm text-gray-500">총 {view.length}건</span>
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
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {view.length === 0 && (
                    <tr>
                      <td colSpan={cols.length + 1} className="py-12 text-center text-sm text-gray-400">
                        표시할 데이터가 없습니다.
                      </td>
                    </tr>
                  )}
                  {view.map((row, i) => (
                    <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                      {cols.map((k) => {
                        // 구분: 연속 구간 첫 행만 rowSpan 병합 셀, 나머지 행은 생략
                        if (k === 'category') {
                          if (catRowSpan[i] === 0) return null
                          return (
                            <td
                              key={k}
                              rowSpan={catRowSpan[i]}
                              className="whitespace-nowrap px-3 py-2 text-left align-middle bg-gray-50 font-medium text-gray-700"
                            >
                              {row.category || '-'}
                            </td>
                          )
                        }
                        return (
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
                            ) : k === 'price' ? (
                              row.price.toLocaleString()
                            ) : (
                              (row[k as 'item' | 'variety'] as string) || '-'
                            )}
                          </td>
                        )
                      })}
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button
                          onClick={() => setEditRow(row)}
                          className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
                        >
                          수정
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editRow && (
        <EditModal
          row={editRow}
          roleLabel={editorLabel}
          onClose={() => setEditRow(null)}
          onSaved={async () => {
            setEditRow(null)
            await loadData()
          }}
        />
      )}
      {showCreate && (
        <CreateModal
          roleLabel={editorLabel}
          onClose={() => setShowCreate(false)}
          onSaved={async () => {
            setShowCreate(false)
            await loadData()
          }}
        />
      )}
      {refEdit && (
        <RefEditModal
          title={refEdit.title}
          kind={refEdit.kind}
          fields={refEdit.fields}
          editor={editorLabel}
          onClose={() => setRefEdit(null)}
          onSaved={async () => {
            setRefEdit(null)
            await loadData()
          }}
        />
      )}
    </div>
  )
}

// ── 공용 모달 셸 (PC 중앙 / 폰 하단시트) ──────────────────────────
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const POST_URL = '/api/jindopam/cost'

// ── 수정 모달 (원곡가·과세여부·적용시작일) ─────────────────────────
function EditModal({
  row,
  roleLabel,
  onClose,
  onSaved,
}: {
  row: CostRow
  roleLabel: string
  onClose: () => void
  onSaved: () => void
}) {
  const [price, setPrice] = useState('')
  const [applyFrom, setApplyFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const rawId = [row.category, row.item, row.variety].filter((s) => s.trim() !== '').join('_')

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      const newPrice = Number(String(price).replace(/[^0-9.-]/g, ''))
      if (price.trim() === '' || !Number.isFinite(newPrice)) {
        setErr('변경 후 원곡가를 입력해 주세요.')
        setSaving(false)
        return
      }
      if (newPrice === row.price) {
        onClose()
        return
      }
      const res = await fetch(POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          gubun: row.category,
          item: row.item,
          variety: row.variety,
          field: '원곡가',
          oldValue: String(row.price),
          newValue: String(newPrice),
          applyFrom,
          role: roleLabel,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || '저장 실패')
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title="원료 수정" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          <div className="text-xs text-gray-400">원료ID (자동)</div>
          <div className="font-medium">{rawId}</div>
        </div>
        <div>
          <span className="mb-1 block text-gray-600">1kg당원곡가</span>
          <div className="flex items-center gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-gray-400">변경 전</span>
              <input
                type="text"
                value={row.price.toLocaleString()}
                readOnly
                className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-gray-500 focus:outline-none"
              />
            </label>
            <span className="mt-5 text-gray-400">→</span>
            <label className="flex-1">
              <span className="mb-1 block text-xs text-gray-400">변경 후</span>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="새 원곡가"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
            </label>
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-gray-600">적용 시작일</span>
          <input
            type="date"
            value={applyFrom}
            onChange={(e) => setApplyFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </label>
        {err && <p className="text-sm text-red-600">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── 신규 원료 추가 모달 ───────────────────────────────────────────
function CreateModal({
  roleLabel,
  onClose,
  onSaved,
}: {
  roleLabel: string
  onClose: () => void
  onSaved: () => void
}) {
  const GUBUN_OPTIONS = ['유기농', '무농약', '관행', '수입', '직접입력']
  const [gubunSelect, setGubunSelect] = useState('유기농')
  const [gubunCustom, setGubunCustom] = useState('')
  const [item, setItem] = useState('')
  const [variety, setVariety] = useState('')
  const [wongok, setWongok] = useState('')
  const [tax, setTax] = useState('면세')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const gubun = gubunSelect === '직접입력' ? gubunCustom : gubunSelect
  const rawId = [gubun, item, variety].filter((s) => s.trim() !== '').join('_') || '—'

  const handleSave = async () => {
    if (!gubun.trim() || !item.trim()) {
      setErr('구분과 품목은 필수입니다.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          gubun: gubun.trim(),
          item: item.trim(),
          variety: variety.trim(),
          wongok: wongok ? Number(String(wongok).replace(/[^0-9.-]/g, '')) : '',
          tax,
          role: roleLabel,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || '저장 실패')
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, node: React.ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-gray-600">{label}</span>
      {node}
    </label>
  )
  const inputCls =
    'w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400'

  return (
    <ModalShell title="신규 원료 추가" onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-auto text-sm">
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
          <div className="text-xs text-gray-400">원료ID (자동 · 구분_품목_품종)</div>
          <div className="font-medium">{rawId}</div>
        </div>
        {field(
          '구분 *',
          <div className="space-y-2">
            <select value={gubunSelect} onChange={(e) => setGubunSelect(e.target.value)} className={inputCls}>
              {GUBUN_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {gubunSelect === '직접입력' && (
              <input
                value={gubunCustom}
                onChange={(e) => setGubunCustom(e.target.value)}
                className={inputCls}
                placeholder="구분 직접 입력"
              />
            )}
          </div>,
        )}
        {field('품목 *', <input value={item} onChange={(e) => setItem(e.target.value)} className={inputCls} />)}
        {field('품종', <input value={variety} onChange={(e) => setVariety(e.target.value)} className={inputCls} />)}
        {field('1kg당원곡가', <input type="number" value={wongok} onChange={(e) => setWongok(e.target.value)} className={inputCls} />)}
        {field(
          '과세여부',
          <select value={tax} onChange={(e) => setTax(e.target.value)} className={inputCls}>
            <option value="면세">면세</option>
            <option value="과세">과세</option>
          </select>,
        )}
        <p className="text-xs text-gray-400">원료ID·작업비·공급가는 시트 수식이 자동 계산합니다. 취급상태는 시트에서 직접 입력합니다.</p>
        {err && <p className="text-sm text-red-600">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {saving ? '저장 중…' : '추가'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── 참고표 항목별 수정 모달 (변경전/후·적용시작일, 원곡가 모달과 통일) ──
function RefEditModal({
  title,
  kind,
  fields,
  editor,
  onClose,
  onSaved,
}: {
  title: string
  kind: 'cost' | 'ship'
  fields: { item: string; label: string; current: number }[]
  editor: string
  onClose: () => void
  onSaved: () => void
}) {
  const [next, setNext] = useState<Record<string, string>>({})
  const [applyFrom, setApplyFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const num = (s: string) => Number(String(s).replace(/[^0-9.-]/g, ''))

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      // 값이 입력되고 현재값과 다른 항목만 개별 update (로그도 항목마다)
      const changes = fields
        .map((f) => ({ f, raw: (next[f.item] ?? '').trim() }))
        .filter(({ raw }) => raw !== '')
        .map(({ f, raw }) => ({ f, nv: num(raw) }))
        .filter(({ f, nv }) => Number.isFinite(nv) && nv !== f.current)

      if (changes.length === 0) {
        onClose()
        return
      }
      for (const { f, nv } of changes) {
        const res = await fetch(POST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update-ref',
            kind,
            item: f.item,
            oldValue: String(f.current),
            newValue: String(nv),
            applyFrom,
            editor,
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.ok) throw new Error(json.error || '저장 실패')
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {fields.map((f) => (
          <div key={f.item}>
            <span className="mb-1 block text-gray-600">{f.label}</span>
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <span className="mb-1 block text-xs text-gray-400">변경 전</span>
                <input
                  type="text"
                  value={f.current.toLocaleString()}
                  readOnly
                  className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-gray-500 focus:outline-none"
                />
              </label>
              <span className="mt-5 text-gray-400">→</span>
              <label className="flex-1">
                <span className="mb-1 block text-xs text-gray-400">변경 후</span>
                <input
                  type="number"
                  value={next[f.item] ?? ''}
                  onChange={(e) => setNext((v) => ({ ...v, [f.item]: e.target.value }))}
                  placeholder="새 값"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
              </label>
            </div>
          </div>
        ))}
        <label className="block">
          <span className="mb-1 block text-gray-600">적용 시작일</span>
          <input
            type="date"
            value={applyFrom}
            onChange={(e) => setApplyFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </label>
        {err && <p className="text-sm text-red-600">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50">
            취소
          </button>
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50">
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
