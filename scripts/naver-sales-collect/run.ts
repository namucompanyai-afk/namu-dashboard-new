/**
 * 네이버 커머스 API — 어제(KST) 결제완료 상품주문 수집 → Supabase naver_product_orders upsert (16GB 크롤링 맥, 매일 08:42)
 *   아침 보고서(09:05) ① 칸의 입력. 보고서 쪽 집계(건수·합계·취소·상품 Top3)는 scripts/coupang-morning-report/run.ts 가
 *   이 테이블을 날짜로 직접 읽어 lib/naver/salesWatch.ts 의 summarizeNaverOrders 로 만든다(여기서는 안 만듦).
 *   정규화·요약 순수 로직은 lib/naver/salesWatch.ts, 토큰·조회는 lib/naver/commerceApi.ts.
 *
 *   npx tsx scripts/naver-sales-collect/run.ts                   # 어제 하루, Supabase 업로드
 *   npx tsx scripts/naver-sales-collect/run.ts --date 2026-10-20  # 특정 날짜 재수집(백필)
 *   npx tsx scripts/naver-sales-collect/run.ts --dry-run          # Supabase 안 쓰고 요약만 출력(시험용)
 *
 * 키: NAVER_SALES_ENV 가 가리키는 파일(기본 저장소 .env.local) —
 *     NAVER_COMMERCE_CLIENT_ID · NAVER_COMMERCE_CLIENT_SECRET · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SLACK_REVIEW_WEBHOOK_URL(토큰 실패 알림, 선택)
 * 호출 허용 IP 가 사무실 공인 IP 하나로 고정 — 그 IP 가 아니면 토큰 발급부터 실패한다(16GB 전용 실행 전제).
 * --markers-dir <dir> 주면 토큰 발급 실패를 그 폴더의 .naver-api-failed-<날짜> 마커로 하루 1회만 슬랙 알림(세션 유지 작업의 slack1 과 같은 방식).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchNaverToken, fetchProductOrders } from '../../lib/naver/commerceApi'
import { kstDayRange, normalizeProductOrder, type NaverOrderRow } from '../../lib/naver/salesWatch'

const REPO = path.resolve(__dirname, '..', '..')
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.NAVER_SALES_ENV ? path.resolve(expandHome(process.env.NAVER_SALES_ENV)) : path.join(REPO, '.env.local')
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const DRY = flag('--dry-run')

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return
  for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음')
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _sb
}

async function notifyTokenFailure(markersDir: string | undefined) {
  if (!markersDir) return
  const date = kstToday()
  const marker = path.join(markersDir, `.naver-api-failed-${date}`)
  if (fs.existsSync(marker)) return
  fs.mkdirSync(markersDir, { recursive: true })
  fs.writeFileSync(marker, date)
  const url = process.env.SLACK_REVIEW_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '🔒 네이버 API 호출 실패 — API센터 IP/시크릿 확인' }) })
  } catch {
    // 슬랙 전송 자체 실패는 무시 — 로그(stderr)로만 남긴다
  }
}

const BATCH = 500
async function upsertOrders(rows: NaverOrderRow[]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((r) => ({
      product_order_id: r.productOrderId,
      order_id: r.orderId,
      product_id: r.productId,
      product_name: r.productName,
      product_option: r.productOption,
      quantity: r.quantity,
      total_payment_amount: r.totalPaymentAmount,
      product_order_status: r.productOrderStatus,
      claim_status: r.claimStatus,
      payment_date: r.paymentDate,
      expected_settlement_amount: r.expectedSettlementAmount,
      sale_commission: r.saleCommission,
      payment_commission: r.paymentCommission,
      channel_commission: r.channelCommission,
      knowledge_shopping_commission: r.knowledgeShoppingCommission,
      seller_burden_store_discount_amount: r.sellerBurdenStoreDiscountAmount,
      raw_safe: r.rawSafe,
    }))
    const { error } = await sb().from('naver_product_orders').upsert(chunk, { onConflict: 'product_order_id' })
    if (error) throw new Error(`naver_product_orders upsert 실패: ${error.message}`)
  }
}

async function markCollected(date: string, orderCount: number, from: string, to: string) {
  const id = `naver_sales_${date}`
  const { error } = await sb()
    .from('dashboard_data')
    .upsert({ id, data: { ranAt: new Date().toISOString(), orderCount, from, to }, updated_at: new Date().toISOString() })
  if (error) throw new Error(`${id} 저장 실패: ${error.message}`)
}

async function main() {
  loadEnv()
  const date = opt('--date') ?? addDays(kstToday(), -1)
  const markersDir = opt('--markers-dir')

  const clientId = process.env.NAVER_COMMERCE_CLIENT_ID
  const clientSecret = process.env.NAVER_COMMERCE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET 없음')

  const { from, to } = kstDayRange(date)
  console.log(`${date}\t조회 구간 ${from} ~ ${to}`)

  let token: string
  try {
    token = await fetchNaverToken({ clientId, clientSecret })
  } catch (e) {
    await notifyTokenFailure(markersDir)
    throw e
  }

  const contents = await fetchProductOrders(token, from, to)
  const rows = contents.map(normalizeProductOrder).filter((r) => r.productOrderId)
  const skipped = contents.length - rows.length
  console.log(`${date}\t주문 ${rows.length}건 수신${skipped ? ` (productOrderId 없어 건너뜀 ${skipped}건)` : ''}`)

  if (DRY) {
    console.log(`${date}\t--dry-run: Supabase 저장 안 함`)
    console.log(JSON.stringify(rows.slice(0, 3), null, 2))
    return
  }

  await upsertOrders(rows)
  await markCollected(date, rows.length, from, to)
  console.log(`${date}\t✅ naver_product_orders 업로드 완료 · naver_sales_${date} 마커 저장`)
}

main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
