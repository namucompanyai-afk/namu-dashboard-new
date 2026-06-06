'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'

/**
 * 공용 비동기 확인 모달 훅.
 *
 * native confirm()은 동기 블로킹이라 다이얼로그가 열려있는 동안 메인 스레드를 점유 → INP 악화.
 * 이 훅은 confirm()을 Promise<boolean> 로 대체한다. 클릭 핸들러는 `await confirm(...)` 한 줄만
 * 바꾸면 되고, 클릭 즉시 메인 스레드를 양보(모달만 열고 반환)하므로 블로킹이 없다.
 *
 * 사용:
 *   const { confirm, confirmModal } = useConfirm()
 *   const onDelete = async () => { if (!(await confirm({ message: '삭제할까요?' }))) return; ...실제삭제 }
 *   return (<> ... {confirmModal} </>)
 */

export interface ConfirmOptions {
  title?: string
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  /** 확인 버튼 색 — 'danger'(빨강, 기본) | 'primary'(파랑) */
  tone?: 'danger' | 'primary'
}

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback((options: ConfirmOptions = {}) => {
    setOpts(options)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = useCallback((result: boolean) => {
    resolver.current?.(result)
    resolver.current = null
    setOpts(null)
  }, [])

  const confirmModal = opts ? (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => close(false)} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        {opts.title && <h3 className="text-base font-semibold text-gray-900">{opts.title}</h3>}
        {opts.message != null && (
          <p className={'text-sm text-gray-700 whitespace-pre-line ' + (opts.title ? 'mt-2' : '')}>{opts.message}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            {opts.cancelText || '취소'}
          </button>
          <button
            onClick={() => close(true)}
            className={
              'px-3 py-1.5 rounded-lg text-sm font-medium text-white ' +
              (opts.tone === 'primary' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700')
            }
          >
            {opts.confirmText || '확인'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { confirm, confirmModal }
}
