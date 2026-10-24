/**
 * 아침 보고서(매일 09:05, 16GB node 실행 — 크롬 불필요) — 그날 Supabase 에 이미 저장된 결과를 모아 #쿠팡-결합 슬랙 1장.
 * 새 크롤링 없음. 비교·문안은 lib/coupang/morningReport.ts. 로그인 풀림 마커는 이 맥 로컬 파일을 직접 읽는다.
 *
 *   npx tsx scripts/coupang-morning-report/run.ts [--date YYYY-MM-DD] [--send] [--markers-dir <dir>] [--out <json>]
 *
 * 읽는 소스 (전부 이미 모으는 것, 없으면 그 칸만 '미수신'):
 *   coupang_1p_stock_{date}(6번째) · coupang_catalog_{date}/{date-1}(2번째) · coupang_page_{date}(3번째, 아직 불안정)
 *   naver_rank_history 테이블(date/{date-1}, run_slot='morning' — 네이버 순위 v2, 2026-10-22, v1 블롭은 더 안 읽음) · coupang_ad_daily_{date-1}(8번째, 어제 1일)
 *   naver_sales_{date-1} 마커 + naver_product_orders 테이블(10번째, 네이버 커머스 API 어제 결제완료 주문) — ① 칸
 * 키: 저장소 .env.local 또는 MORNING_REPORT_ENV — SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY · SLACK_REVIEW_WEBHOOK_URL(--send, #쿠팡-결합 재사용)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { unpackAdRows, type PackedAdRows } from '../../lib/coupang/adRowsPack'
import { buildMorningReport, type MorningSources, type PageOptionLite, type RankLite, type StockStateLite } from '../../lib/coupang/morningReport'
import type { CatalogRow } from '../../lib/coupang/catalogWatch'
import { summarizeNaverOrders, type NaverOrderLite, type NaverSalesSummary } from '../../lib/naver/salesWatch'

const REPO = path.resolve(__dirname, '..', '..')
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.MORNING_REPORT_ENV ? path.resolve(expandHome(process.env.MORNING_REPORT_ENV)) : path.join(REPO, '.env.local')
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const SEND = flag('--send')

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
async function readRaw(id: string): Promise<unknown | null> {
  const { data, error } = await sb().from('dashboard_data').select('data').eq('id', id).maybeSingle()
  if (error) {
    console.log(`[경고] ${id} 읽기 실패: ${error.message}`)
    return null
  }
  return data?.data ?? null
}

/** naver_sales_{date} 마커가 있어야(그날 수집 작업이 실제로 돌았다는 뜻) naver_product_orders 를 읽는다 —
 *  마커가 없는데 표가 비어 있을 수 있는 경우(수집 안 됨)와 실제로 0건이었던 경우를 구분하기 위해. */
async function readNaverSales(date: string): Promise<NaverSalesSummary | null> {
  const ran = await readRaw(`naver_sales_${date}`)
  if (!ran) return null
  const dayStart = `${date}T00:00:00.000+09:00`
  const dayEnd = `${addDays(date, 1)}T00:00:00.000+09:00`
  const { data, error } = await sb()
    .from('naver_product_orders')
    .select('product_name, product_option, total_payment_amount, product_order_status, claim_status')
    .gte('payment_date', dayStart)
    .lt('payment_date', dayEnd)
  if (error) {
    console.log(`[경고] naver_product_orders 읽기 실패: ${error.message}`)
    return null
  }
  const rows: NaverOrderLite[] = (data ?? []).map((d) => ({
    productName: (d as { product_name: string | null }).product_name,
    productOption: (d as { product_option: string | null }).product_option,
    totalPaymentAmount: (d as { total_payment_amount: number | null }).total_payment_amount,
    productOrderStatus: (d as { product_order_status: string | null }).product_order_status,
    claimStatus: (d as { claim_status: string | null }).claim_status,
  }))
  return summarizeNaverOrders(rows)
}

/**
 * 네이버 순위 v2(2026-10-22, 10번째 작업과 별개) — naver_rank_history 테이블을 날짜+슬롯으로 직접 읽는다.
 * v1(dashboard_data 'naver_rank_{date}' 블롭) 은 더 안 읽음 — v2 등록 후 그 저장 자체를 끈다.
 * 추적 ON 상품 행(is_tracked=true) + "이 키워드에 우리 상품 없음" 요약 행(product_no='')만 가져온다 —
 * 요약 행이 있어야 "그 키워드는 수집은 됐는데 우리 상품이 없었다"를 "애초에 수집 안 됨"과 구분할 수 있다.
 * 보고서는 항상 그날 아침(08:55, run_slot='morning') 수집분을 본다 — 09:05 가 그 다음이라 이게 맞는 짝.
 */
async function readRankHistory(date: string): Promise<{ ranks: RankLite[] } | null> {
  const { data, error } = await sb()
    .from('naver_rank_history')
    .select('keyword, alias, product_no, rank')
    .eq('collected_date', date)
    .eq('run_slot', 'morning')
    .or('is_tracked.eq.true,product_no.eq.')
  if (error) {
    console.log(`[경고] naver_rank_history 읽기 실패: ${error.message}`)
    return null
  }
  if (!data || !data.length) return null
  const ranks: RankLite[] = data.map((d) => {
    const row = d as { keyword: string; alias: string | null; product_no: string; rank: number | null }
    return { keyword: row.keyword, alias: row.alias || row.keyword, productNo: row.product_no, rank: row.rank == null ? null : Number(row.rank) }
  })
  return { ranks }
}

/** 자동 로그인 어제 요약 — 16GB 감사 로그(relogin-audit.log)·이상 기록(relogin-anomaly.log)에서 집계. 값(아이디·비번)은 애초에 로그에 없다 */
function summarizeAutoLogin(dir: string, date: string): string | null {
  const alog = path.join(dir, 'relogin-audit.log')
  const state = path.join(dir, '.relogin-audit.state')
  if (!fs.existsSync(alog) && !fs.existsSync(state)) return null // 이 기능을 아직 안 쓰는 맥
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  const ymd = d.toISOString().slice(0, 10)
  const lines = fs.existsSync(alog) ? fs.readFileSync(alog, 'utf-8').split('\n').filter(Boolean) : []
  const cnt: Record<string, number> = { wing: 0, adcenter: 0, eland: 0 }
  for (const l of lines) {
    const f = l.split('\t') // 번호·시각·사이트·호출자·직전점검·결과·앞줄해시
    if ((f[1] ?? '').startsWith(ymd) && f[5] === '읽음' && f[2] in cnt) cnt[f[2]] += 1
  }
  const alines = fs.existsSync(path.join(dir, 'relogin-anomaly.log')) ? fs.readFileSync(path.join(dir, 'relogin-anomaly.log'), 'utf-8').split('\n').filter(Boolean) : []
  let anomalies = alines.filter((l) => l.startsWith(ymd)).length
  // 감사 로그가 통째로 사라졌거나 줄어든 경우 — 읽기 시도가 없어서 kc-read 가 못 잡았을 수 있으니 여기서도 확인
  if (fs.existsSync(state)) {
    const m = /lines=(\d+)/.exec(fs.readFileSync(state, 'utf-8'))
    if (m && Number(m[1]) > lines.length) anomalies += 1
  }
  const total = cnt.wing + cnt.adcenter + cnt.eland
  return `어제 자동 로그인 ${total}회(윙 ${cnt.wing}·광고센터 ${cnt.adcenter}·이랜드 ${cnt.eland}), 이상 ${anomalies}건`
}

async function main() {
  loadEnv()
  const date = opt('--date') ?? kstToday()
  const yesterday = addDays(date, -1)

  const [stockRaw, catalogTodayRaw, catalogYdayRaw, pageRaw, rankToday, rankYesterday, adDailyRaw, naverSales] = await Promise.all([
    readRaw(`coupang_1p_stock_${date}`),
    readRaw(`coupang_catalog_${date}`),
    readRaw(`coupang_catalog_${yesterday}`),
    readRaw(`coupang_page_${date}`),
    readRankHistory(date),
    readRankHistory(yesterday),
    readRaw(`coupang_ad_daily_${yesterday}`),
    readNaverSales(yesterday),
  ])

  const stock = stockRaw ? { states: (stockRaw as { states: StockStateLite[] }).states } : null
  const catalogToday = catalogTodayRaw ? { rows: (catalogTodayRaw as { rows: CatalogRow[] }).rows } : null
  const catalogYesterday = catalogYdayRaw ? { rows: (catalogYdayRaw as { rows: CatalogRow[] }).rows } : null
  const pageToday = pageRaw ? { options: (pageRaw as { options: PageOptionLite[] }).options } : null
  const adDaily = adDailyRaw ? { rows: unpackAdRows((adDailyRaw as { rows?: PackedAdRows }).rows) } : null

  // 로그인 풀림 — 7번째 작업이 남긴 로컬 마커 (이 맥 자신의 ~/crawler/logs/.session-*-expired)
  const markersDir = opt('--markers-dir')
  const loginExpired: string[] = []
  if (markersDir && fs.existsSync(markersDir)) {
    const names: Record<string, string> = { wing: '윙', hub: '허브(SUPPLIER HUB)', adcenter: '광고센터' }
    for (const [key, label] of Object.entries(names)) {
      if (fs.existsSync(path.join(markersDir, `.session-${key}-expired`))) loginExpired.push(label)
    }
  }

  const autoLogin = markersDir && fs.existsSync(markersDir) ? summarizeAutoLogin(markersDir, date) : null
  const sources: MorningSources = { date, yesterday, stock, catalogToday, catalogYesterday, pageToday, rankToday, rankYesterday, adDaily, naverSales, loginExpired, autoLogin }
  const { text, missing } = buildMorningReport(sources)
  const out = opt('--out')
  if (out) fs.writeFileSync(out, JSON.stringify({ date, sources, text, missing }, null, 2))
  console.log(`${date}\t미수신 ${missing.length}개: ${missing.join(', ') || '없음'}`)
  console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
  if (SEND) {
    const url = process.env.SLACK_REVIEW_WEBHOOK_URL
    if (!url) throw new Error('SLACK_REVIEW_WEBHOOK_URL 없음')
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
    console.log(`${date}\t슬랙 보냄`)
  }
}
main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
