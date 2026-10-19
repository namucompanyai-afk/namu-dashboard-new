/**
 * 쿠팡 파트너스 오픈 API — products/search (공식 API 만. 쿠팡 상품 페이지 직접 요청 안 함).
 * 서명: CEA HmacSHA256 — message = signed-date(yyMMdd'T'HHmmss'Z', GMT) + method + path + query
 * 키: .env.local COUPANG_PARTNERS_ACCESS_KEY · COUPANG_PARTNERS_SECRET_KEY (출력·저장하지 않음)
 */
import crypto from 'crypto'

const DOMAIN = 'https://api-gateway.coupang.com'
const SEARCH_PATH = '/v2/providers/affiliate_open_api/apis/openapi/products/search'

export type PartnersProduct = {
  productId: number | string
  productName: string
  productUrl: string
  isRocket: boolean
  rank: number
  categoryName?: string
}

export const partnersKeys = () => {
  const accessKey = process.env.COUPANG_PARTNERS_ACCESS_KEY
  const secretKey = process.env.COUPANG_PARTNERS_SECRET_KEY
  return accessKey && secretKey ? { accessKey, secretKey } : null
}

function authorization(method: string, path: string, query: string, keys: { accessKey: string; secretKey: string }) {
  const d = new Date().toISOString() // 2026-10-19T00:49:32.123Z
  const signedDate = `${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}T${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}Z`
  const signature = crypto.createHmac('sha256', keys.secretKey).update(signedDate + method + path + query).digest('hex')
  return `CEA algorithm=HmacSHA256, access-key=${keys.accessKey}, signed-date=${signedDate}, signature=${signature}`
}

/** 키워드 검색 — 결과 productData. 실패는 throw (HTTP 코드·rCode 메시지만, 키 값 없음) */
export async function searchProducts(keyword: string, limit: number, keys: { accessKey: string; secretKey: string }): Promise<PartnersProduct[]> {
  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`
  const res = await fetch(`${DOMAIN}${SEARCH_PATH}?${query}`, {
    headers: { Authorization: authorization('GET', SEARCH_PATH, query, keys), 'Content-Type': 'application/json;charset=UTF-8' },
  })
  const j = (await res.json().catch(() => null)) as { rCode?: string; rMessage?: string; data?: { productData?: PartnersProduct[] } } | null
  if (!res.ok || (j?.rCode && j.rCode !== '0')) throw new Error(`HTTP ${res.status} ${j?.rCode ?? ''} ${j?.rMessage ?? ''}`.trim())
  return j?.data?.productData ?? []
}
