'use client'

/**
 * 엑셀 업로드 버튼 + 모달
 *
 * 대표님의 인플루언서 페이지 UX와 완전 동일한 패턴:
 *  - 메인 페이지엔 컴팩트한 카드 버튼
 *  - 클릭 시 모달 오픈
 *  - 모달: 민트 그라데이션 헤더 + 민트 안내 박스(단계별) + 점선 드롭존 + 하단 액션 버튼
 */

import { useCallback, useState, type DragEvent } from 'react'
import type { UploadMeta } from '@/types/coupang'

interface UploadZoneProps {
  icon: string
  title: string
  subtitle: string
  /** 모달 상단 설명 */
  modalDescription: string
  /** 민트 박스에 들어갈 "파일 받는 방법" 단계 */
  instructions: string[]
  status: UploadMeta | null
  accept?: string
  /** 파일 파싱/적용. 성공 시 UploadMeta 리턴 → 스토어에 저장됨. */
  onFile: (buffer: ArrayBuffer, file: File) => Promise<{ warning?: string } | void>
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '방금'
  if (mins < 60) return `${mins}분 전`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  return `${days}일 전`
}

export function UploadZone({
  icon,
  title,
  subtitle,
  modalDescription,
  instructions,
  status,
  accept = '.xlsx,.xls,.csv',
  onFile,
}: UploadZoneProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)

  const inputId = `upload-${title.replace(/\s+/g, '-')}`

  const processFile = useCallback(
    async (file: File) => {
      setBusy(true)
      setError(null)
      setWarning(null)
      setFileName(file.name)
      try {
        const buf = await file.arrayBuffer()
        const result = await onFile(buf, file)
        if (result?.warning) {
          setWarning(result.warning)
          // 경고만 있으면 모달 1.5초 후 자동 닫기
          setTimeout(() => setOpen(false), 1500)
        } else {
          // 성공 → 즉시 닫기
          setTimeout(() => setOpen(false), 500)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [onFile],
  )

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  const closeModal = () => {
    setOpen(false)
    // 모달 내부 상태 리셋
    setTimeout(() => {
      setError(null)
      setWarning(null)
      setFileName(null)
      setBusy(false)
    }, 200)
  }

  const hasFile = status !== null

  return (
    <>
      {/* 메인 페이지 버튼 카드 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-3 rounded-2xl border p-4 text-left transition-colors ${
          hasFile
            ? 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100'
            : 'border-gray-200 bg-white hover:bg-gray-50'
        }`}
        style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}
      >
        <div className="text-2xl leading-none">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          {status ? (
            <div className="mt-0.5 truncate text-xs text-emerald-700">
              ✓ {status.fileName} · {timeAgo(status.uploadedAt)} · {status.rowCount}행
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-gray-500">{subtitle}</div>
          )}
        </div>
        <div
          className={`flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold ${
            hasFile ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-white'
          }`}
        >
          {hasFile ? '교체' : '업로드'}
        </div>
      </button>

      {/* 모달 */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30"
          onClick={closeModal}
        >
          <div
            className="mx-4 w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 헤더: 민트 그라데이션 */}
            <div className="flex items-center justify-between border-b border-gray-200 bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4">
              <div>
                <h2 className="font-semibold text-gray-900">
                  {icon} {title}
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">{modalDescription}</p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                className="text-xl text-gray-400 hover:text-gray-600"
                aria-label="닫기"
              >
                ×
              </button>
            </div>

            {/* 본문 */}
            <div className="p-6">
              {/* 파일 받는 방법 안내 박스 */}
              <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="mb-1.5 text-xs font-semibold text-emerald-800">
                  📍 파일 받는 방법
                </div>
                {instructions.map((s, i) => (
                  <div
                    key={i}
                    className="mb-1 flex items-start gap-2 text-xs text-emerald-700"
                  >
                    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>

              {/* 현재 등록된 파일 정보 (교체 모드) */}
              {status && !fileName && (
                <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs">
                  <div className="font-medium text-gray-700">
                    현재 등록된 파일: <span className="text-gray-900">{status.fileName}</span>
                  </div>
                  <div className="mt-0.5 text-gray-500">
                    {timeAgo(status.uploadedAt)} · {status.rowCount}행
                  </div>
                </div>
              )}

              {/* 드롭존 */}
              <label
                htmlFor={inputId}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={`mb-4 block cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                  dragging
                    ? 'border-emerald-400 bg-emerald-50'
                    : error
                      ? 'border-red-300 bg-red-50'
                      : 'border-gray-200 hover:border-emerald-300'
                }`}
              >
                <div className="mb-2 text-3xl">📊</div>
                <div className="mb-1 text-sm font-medium text-gray-700">
                  {busy
                    ? '파싱 중…'
                    : fileName
                      ? fileName
                      : `${title} 업로드`}
                </div>
                <p className="text-xs text-gray-400">
                  클릭하거나 파일을 드래그 · .xlsx
                </p>
                <input
                  id={inputId}
                  type="file"
                  accept={accept}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) processFile(f)
                    e.target.value = ''
                  }}
                  disabled={busy}
                />
              </label>

              {/* 에러/경고 메시지 */}
              {error && (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  <div className="font-semibold">⚠ 업로드 실패</div>
                  <div className="mt-1 break-all">{error}</div>
                </div>
              )}
              {warning && !error && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                  <div className="font-semibold">ⓘ 경고</div>
                  <div className="mt-1">{warning}</div>
                </div>
              )}

              {/* 하단 액션 */}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white py-3 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                >
                  {error || warning || status ? '닫기' : '취소'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
