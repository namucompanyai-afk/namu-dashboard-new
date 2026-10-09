'use client'

import { useEffect, useState } from 'react'

/**
 * C레벨(서버 역할 admin) 여부 — /api/me 응답으로만 판단한다.
 * 처음엔 false 로 시작해 서버가 cLevel:true 를 돌려줄 때만 true — 로딩 중에 마진이 보였다 사라지지 않게.
 */
export function useCLevel(): boolean {
  const [cLevel, setCLevel] = useState(false)
  useEffect(() => {
    let alive = true
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j?.cLevel === true) setCLevel(true)
      })
      .catch(() => {
        /* 실패하면 false 유지 */
      })
    return () => {
      alive = false
    }
  }, [])
  return cLevel
}
