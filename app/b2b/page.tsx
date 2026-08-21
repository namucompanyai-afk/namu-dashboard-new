import { redirect } from 'next/navigation'

// /b2b 는 채널별 페이지로 갈라졌다 — 기본은 컬리
export default function B2BIndexPage() {
  redirect('/b2b/kurly')
}
