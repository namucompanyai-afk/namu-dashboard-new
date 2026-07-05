'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'

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
  const [role, setRole] = useState<Role>('namu')
  const device = useDevice()

  // 편집 모달 상태
  const [editRow, setEditRow] = useState<CostRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  // 원가표 read (기존 클라이언트 방식 유지 · 저장 후 재호출용으로 함수화)
  const loadData = useCallback(async () => {
    const key = process.env.NEXT_PUBLIC_GSHEET_API_KEY
    if (!key) {
      setError('API 키가 설정되지 않았습니다. (.env.local 의 NEXT_PUBLIC_GSHEET_API_KEY)')
      setLoading(false)
      return
    }
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
      `${encodeURIComponent(RANGE)}?key=${key}`
    try {
      setLoading(true)
      setError(null)
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
      setRows(data)
      setLoading(false)
    } catch (e: any) {
      setError(e?.message || '데이터를 불러오지 못했습니다.')
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const roleLabel = role === 'jindo' ? '진도팜' : '나무'
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
        <div className="flex items-center gap-2">
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
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700"
          >
            ＋ 신규 원료 추가
          </button>
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
          roleLabel={roleLabel}
          onClose={() => setEditRow(null)}
          onSaved={async () => {
            setEditRow(null)
            await loadData()
          }}
        />
      )}
      {showCreate && (
        <CreateModal
          roleLabel={roleLabel}
          onClose={() => setShowCreate(false)}
          onSaved={async () => {
            setShowCreate(false)
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
