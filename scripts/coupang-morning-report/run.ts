/**
 * 아침 보고서(매일 09:05, 16GB node 실행 — 크롬 불필요) — 그날 Supabase 에 이미 저장된 결과를 모아 #쿠팡-결합 슬랙 1장.
 * 새 크롤링 없음. 비교·문안은 lib/coupang/morningReport.ts. 로그인 풀림 마커는 이 맥 로컬 파일을 직접 읽는다.
 *
 *   npx tsx scripts/coupang-morning-report/run.ts [--date YYYY-MM-DD] [--send] [--markers-dir <dir>] [--out <json>]
 *
 * 읽는 소스 (전부 이미 모으는 것, 없으면 그 칸만 '미수신'):
 *   coupang_1p_stock_{date}(6번째) · coupang_catalog_{date}/{date-1}(2번째) · coupang_page_{date}(3번째, 아직 불안정)
 *   naver_rank_{date}/{date-1}(5번째) · coupang_ad_daily_{date-1}(8번째, 어제 1일)
 * 키: 저장소 .env.local 또는 MORNING_REPORT_ENV — SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY · SLACK_REVIEW_WEBHOOK_URL(--send, #쿠팡-결합 재사용)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { unpackAdRows, type PackedAdRows } from '../../lib/coupang/adRowsPack'
import { buildMorningReport, type MorningSources, type PageOptionLite, type RankLite, type StockStateLite } from '../../lib/coupang/morningReport'
import type { CatalogRow } from '../../lib/coupang/catalogWatch'

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

async function main() {
  loadEnv()
  const date = opt('--date') ?? kstToday()
  const yesterday = addDays(date, -1)

  const [stockRaw, catalogTodayRaw, catalogYdayRaw, pageRaw, rankTodayRaw, rankYdayRaw, adDailyRaw] = await Promise.all([
    readRaw(`coupang_1p_stock_${date}`),
    readRaw(`coupang_catalog_${date}`),
    readRaw(`coupang_catalog_${yesterday}`),
    readRaw(`coupang_page_${date}`),
    readRaw(`naver_rank_${date}`),
    readRaw(`naver_rank_${yesterday}`),
    readRaw(`coupang_ad_daily_${yesterday}`),
  ])

  const stock = stockRaw ? { states: (stockRaw as { states: StockStateLite[] }).states } : null
  const catalogToday = catalogTodayRaw ? { rows: (catalogTodayRaw as { rows: CatalogRow[] }).rows } : null
  const catalogYesterday = catalogYdayRaw ? { rows: (catalogYdayRaw as { rows: CatalogRow[] }).rows } : null
  const pageToday = pageRaw ? { options: (pageRaw as { options: PageOptionLite[] }).options } : null
  const rankToday = rankTodayRaw ? { ranks: (rankTodayRaw as { ranks: RankLite[] }).ranks } : null
  const rankYesterday = rankYdayRaw ? { ranks: (rankYdayRaw as { ranks: RankLite[] }).ranks } : null
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

  const sources: MorningSources = { date, yesterday, stock, catalogToday, catalogYesterday, pageToday, rankToday, rankYesterday, adDaily, loginExpired }
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
