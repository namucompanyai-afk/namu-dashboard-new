'use client'

import { useEffect, useRef, useState } from 'react'
import { formatKrw } from '@/lib/coupang'

interface CostCellProps {
  value: number | null
  onChange: (next: number | null) => void
}

export function CostCell({ value, onChange }: CostCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value != null ? String(value) : '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    setDraft(value != null ? String(value) : '')
  }, [value])

  const commit = () => {
    const trimmed = draft.replace(/[,\s]/g, '').trim()
    if (trimmed === '') {
      onChange(null)
    } else {
      const n = Number(trimmed)
      if (Number.isFinite(n) && n >= 0) onChange(Math.round(n))
    }
    setEditing(false)
  }

  const cancel = () => {
    setDraft(value != null ? String(value) : '')
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
        }}
        inputMode="numeric"
        className="w-20 rounded-lg border border-emerald-400 bg-white px-2 py-0.5 text-right font-mono text-xs text-gray-900 outline-none focus:ring-2 focus:ring-emerald-500"
      />
    )
  }

  if (value == null) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100"
      >
        입력 필요
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="클릭하여 수정"
      className="rounded px-1.5 py-0.5 font-mono text-xs text-gray-700 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
    >
      {formatKrw(value)}
    </button>
  )
}
