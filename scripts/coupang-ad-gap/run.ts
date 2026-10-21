/**
 * "팔리는데 광고 없는 1P" 점검 — 대조 · 저장 · 슬랙 (월요일, run-weekly.sh 맨 끝에 붙임). 비교·문안은 lib/coupang/adGap.ts
 *
 *   npx tsx scripts/coupang-ad-gap/run.ts --sales <csv> [--date] [--send] [--local-store <dir>] [--out <json>]
 *   --sales 는 허브 판매 분석 4주 csv(scripts/crawler-16gb/run-weekly-sales.sh --range 4w 가 받은 파일).
 *
 * 데이터 소스 (전부 이미 모으고 있는 것 — 새 크롤링 없음):
 *   - 나무_마스터 '마진계산' 1P 행(옵션ID·별칭)
 *   - Supabase dashboard_data 'coupang_ad_live_30d' (최근 30일 광고 행, 기존 ad-weekly-upload 가 저장)
 *   - 허브 판매 분석 4주 csv (판매 수량>0 인 1P 옵션)
 *   - Supabase dashboard_data 'coupang_1p_stock_*' 중 가장 최근(광고센터 재고, 6번째 작업) — 품절이면 "광고 없음"에서 뺀다
 *
 * 키: 저장소 .env.local 또는 AD_GAP_ENV 가 가리키는 파일 — GOOGLE_SERVICE_ACCOUNT · SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY · SLACK_REVIEW_WEBHOOK_URL(--send)
 * 슬랙은 #쿠팡-결합 — 손익 숫자 없음, 딱 1줄.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { MARGIN_TAB } from '../../lib/coupang/marginFromSheet'
import { unpackAdRows, type PackedAdRows } from '../../lib/coupang/adRowsPack'
import { parseOnePSalesCsv } from '../../lib/coupang/parsers/onePSales'
import { buildAdGapReport, buildAdGapMessage, type AdGapReport, type AdRowLite, type MarginOneP, type SalesRow, type StockInfo } from '../../lib/coupang/adGap'

const REPO = path.resolve(__dirname, '..', '..')
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.AD_GAP_ENV ? path.resolve(expandHome(process.env.AD_GAP_ENV)) : path.join(REPO, '.env.local')
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const LOCAL = opt('--local-store')
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
const str = (v: unknown) => (v == null ? '' : String(v).trim())

async function readOneP(): Promise<MarginOneP[]> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `'${MARGIN_TAB}'!A2:X`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const rows = (res.data.values || []) as unknown[][]
  const out: MarginOneP[] = []
  for (const r of rows) {
    if (str(r[0]) !== '쿠팡 1P') continue
    const optionId = str(r[23])
    if (!/^\d+$/.test(optionId)) continue
    out.push({ optionId, alias: str(r[1]) })
  }
  return out
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
async function readAdRows(): Promise<AdRowLite[]> {
  const { data, error } = await sb().from('dashboard_data').select('data').eq('id', 'coupang_ad_live_30d').maybeSingle()
  if (error) throw new Error(`coupang_ad_live_30d 읽기 실패: ${error.message}`)
  const rows = unpackAdRows((data?.data as { rows?: PackedAdRows })?.rows)
  if (!rows.length) console.log('[경고] coupang_ad_live_30d 비어 있음 — AD_LIVE_30D_SAVE=on 인지, 월요일 업로드가 끝났는지 확인')
  return rows.map((r) => ({ campaignName: r.campaignName, saleMethod: r.saleMethod, adOptionId: r.adOptionId }))
}
async function readStock(): Promise<Map<string, StockInfo>> {
  const map = new Map<string, StockInfo>()
  if (LOCAL) return map
  try {
    const { data } = await sb().from('dashboard_data').select('id').like('id', 'coupang_1p_stock_20%').order('id', { ascending: false }).limit(1)
    const id = data?.[0]?.id as string | undefined
    if (!id) {
      console.log('[경고] coupang_1p_stock_* 없음 — 품절 제외 없이 판정(6번째 작업 아직 안 돌았을 수 있음)')
      return map
    }
    const r = await sb().from('dashboard_data').select('data').eq('id', id).single()
    const states = (r.data?.data as { states?: { optionId: string; stock: number | null; soldOut: boolean }[] })?.states ?? []
    for (const s of states) map.set(s.optionId, { stock: s.stock, soldOut: s.soldOut })
    console.log(`재고 기준: ${id} (옵션 ${states.length}개)`)
  } catch (e) {
    console.log(`[경고] 재고 스냅샷 읽기 실패 — 품절 제외 없이 판정: ${e instanceof Error ? e.message : String(e)}`)
  }
  return map
}
function readSales(file: string): SalesRow[] {
  const text = fs.readFileSync(file, 'utf-8')
  const { rows, error } = parseOnePSalesCsv(text)
  if (error) throw new Error(`판매 분석 csv 파싱 실패: ${error}`)
  return rows.map((r) => ({ optionId: r.optionId, name: r.name, qty: r.qty }))
}
async function save(date: string, snapshot: { date: string; collectedAt: string; report: AdGapReport }) {
  const id = `coupang_ad_gap_${date}`
  if (LOCAL) {
    fs.mkdirSync(LOCAL, { recursive: true })
    fs.writeFileSync(path.join(LOCAL, `${id}.json`), JSON.stringify(snapshot))
    return id
  }
  const { error } = await sb().from('dashboard_data').upsert({ id, data: snapshot, updated_at: new Date().toISOString() })
  if (error) throw new Error(`저장 실패 (${id}): ${error.message}`)
  return id
}
async function postSlack(text: string) {
  const url = process.env.SLACK_REVIEW_WEBHOOK_URL
  if (!url) throw new Error('SLACK_REVIEW_WEBHOOK_URL 없음')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
}

async function main() {
  loadEnv()
  const salesFile = opt('--sales')
  if (!salesFile || !fs.existsSync(salesFile)) throw new Error(`--sales <csv> 필요 (허브 판매 분석 4주 파일) — ${salesFile ?? '경로 없음'}`)
  const date = opt('--date') ?? kstToday()
  const [oneP, adRows, stock] = await Promise.all([readOneP(), readAdRows(), readStock()])
  const sales = readSales(salesFile)
  const report = buildAdGapReport({ oneP, adRows, sales, stock })
  const text = buildAdGapMessage(date, report)
  const snapshot = { date, collectedAt: new Date().toISOString(), report }
  const out = opt('--out')
  if (out) fs.writeFileSync(out, JSON.stringify(snapshot, null, 2))
  const id = await save(date, snapshot)
  console.log(`${date}\t${id}\t4주 판매 ${report.totalSold} · 광고없음 ${report.noAd.length} · 품절제외 ${report.noAdSoldOut.length}`)
  console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
  if (SEND) {
    await postSlack(text)
    console.log(`${date}\t슬랙 보냄`)
  }
}
main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
