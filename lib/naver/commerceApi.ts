/**
 * 네이버 커머스 API(apicenter.commerce.naver.com) — 토큰 발급 · 상품주문 조회.
 *   호출 허용 IP 가 사무실 공인 IP 하나로 고정돼 있어, 그 IP 가 아닌 곳(이 저장소의 로컬 개발 환경 포함)에서 호출하면
 *   토큰 발급부터 HTTP 에러로 막힌다 — 16GB 크롤링 맥 실행 전제(scripts/naver-sales-collect/run.ts).
 * 인증 방식: client_secret_sign = base64( bcrypt(`${clientId}_${timestamp}`, clientSecret) ), clientSecret 자체가 bcrypt salt 형식.
 */
import bcrypt from 'bcryptjs'

export type NaverCommerceEnv = { clientId: string; clientSecret: string }

export async function fetchNaverToken(env: NaverCommerceEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  const timestamp = Date.now()
  const hashed = bcrypt.hashSync(`${env.clientId}_${timestamp}`, env.clientSecret)
  const clientSecretSign = Buffer.from(hashed, 'utf-8').toString('base64')
  const body = new URLSearchParams({
    client_id: env.clientId,
    timestamp: String(timestamp),
    client_secret_sign: clientSecretSign,
    grant_type: 'client_credentials',
    type: 'SELF',
  })
  const res = await fetchImpl('https://api.commerce.naver.com/external/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`네이버 토큰 발급 실패 HTTP ${res.status} — IP 허용 목록(사무실 공인 IP)·시크릿 확인`)
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('네이버 토큰 응답에 access_token 없음')
  return json.access_token
}

const PAGE_SIZE = 300 // pageSize=300 요청 자체는 정상 동작 확인(2026-10-22, 브레인 16GB 실데이터) — 응답에 pagination 객체도 있음.
// 다만 101건(1페이지)만 시험해봐서 두 번째 페이지를 실제로 받아본 적은 없다 — 하루 300건을 넘기면 이 루프가 처음 실전 시험이 된다.
const MAX_PAGES = 20 // 안전장치 — 페이지네이션이 예상과 다르면 끝없이 돌지 않게

/** from/to 는 kstDayRange() 결과 그대로(ISO, +09:00) — 24시간 이내 구간만 허용(네이버 쪽 제약, 2026-10 확인) */
export async function fetchProductOrders(token: string, from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<unknown[]> {
  const out: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL('https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders')
    url.searchParams.set('from', from)
    url.searchParams.set('to', to)
    url.searchParams.set('rangeType', 'PAYED_DATETIME')
    url.searchParams.set('pageNumber', String(page))
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`네이버 상품주문 조회 실패 HTTP ${res.status} (page ${page})`)
    const json = (await res.json()) as { data?: { contents?: unknown[] } }
    const contents = json.data?.contents ?? []
    out.push(...contents)
    if (contents.length < PAGE_SIZE) break
  }
  return out
}
