/**
 * 쿠팡 1P 재고·현재가 점검 — 대조 · 저장 · 슬랙 (16GB 크롤링 맥 매일 10:00, scripts/crawler-16gb/run-daily-stock.sh)
 *   광고센터 상품 목록 읽기 자체는 클로드 크롬 확장(jobs/adcenter-stock-read.md)이 하고, 이 스크립트는 대조·저장·슬랙만. 비교·문안은 lib/coupang/stockWatch.ts
 *
 *   npx tsx scripts/coupang-stock-watch/run.ts --results <dir> [--date YYYY-MM-DD] [--send] [--local-store <dir>] [--out <json>]
 *   --results 는 jobs/adcenter-stock-read.md 가 적은 adcenter_stock.json 이 들어 있는 폴더.
 *   --local-store 면 Supabase 대신 폴더(검증). --send 없으면 메시지를 화면에만.
 *
 * 키: 저장소 .env.local 또는 STOCK_WATCH_ENV 가 가리키는 파일 — GOOGLE_SERVICE_ACCOUNT(시트 읽기) · SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY(저장) · SLACK_REVIEW_WEBHOOK_URL(--send)
 * 슬랙은 #쿠팡-결합(Watchman, 직원 공유) — 마진·손익 숫자 없음.
 * 이 JSON(스냅샷)은 "팔리는데 광고 없는 1P" 판정의 재고 확인에도 쓴다 (2026-10-21).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { MARGIN_TAB } from '../../lib/coupang/marginFromSheet'
import { STOCK_ID_PREFIX, buildStockMessage, buildStockSnapshot, stockSnapshotId, type SheetOneP, type StockItem, type StockSnapshot } from '../../lib/coupang/stockWatch'

const REPO = path.resolve(__dirname, '..', '..')
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.STOCK_WATCH_ENV ? path.resolve(expandHome(process.env.STOCK_WATCH_ENV)) : path.join(REPO, '.env.local')

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
const clean = (v: unknown) => (/^(null|undefined|none|-|\?)$/i.test(str(v)) ? '' : str(v))
const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')))
const numOrNull = (v: unknown) => {
  const s = clean(v)
  if (!s) return null
  const n = num(s)
  return Number.isFinite(n) ? n : null
}

// ── 마진계산 1P 행 (W 노출ID는 안 씀 — 옵션ID X 로만) ──────────────
async function readOneP(): Promise<SheetOneP[]> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `'${MARGIN_TAB}'!A2:AE`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const rows = (res.data.values || []) as unknown[][]
  const out: SheetOneP[] = []
  for (const r of rows) {
    if (str(r[0]) !== '쿠팡 1P') continue
    const optionId = str(r[23])
    if (!/^\d+$/.test(optionId)) continue
    const ae = num(r[30])
    out.push({ optionId, alias: str(r[1]), bagCount: num(r[2]) || 1, sheetPrice: str(r[30]) !== '' && Number.isFinite(ae) && ae > 0 ? ae : null })
  }
  return out
}

// ── 저장소 ────────────────────────────────────────────────────────
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음')
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _sb
}
async function loadPrev(date: string): Promise<StockSnapshot | null> {
  const cur = stockSnapshotId(date)
  if (LOCAL) {
    const ids = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f) => f.startsWith(`${STOCK_ID_PREFIX}20`)).map((f) => f.replace(/\.json$/, '')) : []
    const id = ids.filter((x) => x < cur).sort().pop()
    return id ? (JSON.parse(fs.readFileSync(path.join(LOCAL, `${id}.json`), 'utf-8')) as StockSnapshot) : null
  }
  const { data, error } = await sb().from('dashboard_data').select('id').like('id', `${STOCK_ID_PREFIX}20%`).lt('id', cur).order('id', { ascending: false }).limit(1)
  if (error) throw new Error(`직전 스냅샷 목록 읽기 실패: ${error.message}`)
  const id = data?.[0]?.id as string | undefined
  if (!id) return null
  const r = await sb().from('dashboard_data').select('data').eq('id', id).single()
  if (r.error) throw new Error(`직전 스냅샷 읽기 실패 (${id}): ${r.error.message}`)
  return (r.data?.data as StockSnapshot) ?? null
}
async function save(s: StockSnapshot) {
  const id = stockSnapshotId(s.date)
  if (LOCAL) {
    fs.mkdirSync(LOCAL, { recursive: true })
    fs.writeFileSync(path.join(LOCAL, `${id}.json`), JSON.stringify(s))
    return id
  }
  const { error } = await sb().from('dashboard_data').upsert({ id, data: s, updated_at: new Date().toISOString() })
  if (error) throw new Error(`스냅샷 저장 실패 (${id}): ${error.message}`)
  return id
}
async function postSlack(text: string) {
  const url = process.env.SLACK_REVIEW_WEBHOOK_URL
  if (!url) throw new Error('SLACK_REVIEW_WEBHOOK_URL 없음')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
}

// ── 결과 읽기 (클로드가 쓴 adcenter_stock.json — 배열 또는 { items: [...] }) ──
function readResults(dir: string): StockItem[] {
  const file = fs.existsSync(path.join(dir, 'adcenter_stock.json')) ? path.join(dir, 'adcenter_stock.json') : null
  if (!file) return []
  let j: unknown
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    console.log(`[경고] ${file} JSON 아님`)
    return []
  }
  const list = Array.isArray(j) ? j : Array.isArray((j as { items?: unknown[] })?.items) ? (j as { items: unknown[] }).items : []
  const out: StockItem[] = []
  for (const x of list as Record<string, unknown>[]) {
    const optionId = clean(x.optionId) || clean(x.id)
    if (!/^\d+$/.test(optionId)) continue
    const stockRaw = clean(x.stock)
    const soldOut = /품절/.test(stockRaw) || !!x.soldOut
    out.push({
      optionId,
      title: str(x.title) || str(x.name),
      price: numOrNull(x.price),
      stock: soldOut ? null : numOrNull(x.stock),
      soldOut,
      reviews: numOrNull(x.reviews),
      rating: numOrNull(x.rating),
      itemWinner: x.itemWinner == null || clean(x.itemWinner) === '' ? null : /^(true|선정|1|y)$/i.test(str(x.itemWinner)),
      rocket: !!x.rocket,
      badges: Array.isArray(x.badges) ? (x.badges as unknown[]).map(str).filter(Boolean) : [],
      note: str(x.note) || undefined,
    })
  }
  // 같은 옵션ID 중복이면 마지막 것
  const byOid = new Map<string, StockItem>()
  for (const it of out) byOid.set(it.optionId, it)
  return [...byOid.values()]
}

async function main() {
  loadEnv()
  const dir = opt('--results')
  if (!dir) throw new Error('--results <dir> 필요')
  const date = opt('--date') ?? kstToday()
  const items = readResults(dir)
  if (!items.length) {
    console.log(`${date}\t실패\t결과 0개 (${dir}/adcenter_stock.json 없음 또는 빈 배열)`)
    process.exitCode = 1
    return
  }
  const oneP = await readOneP()
  const prev = await loadPrev(date)
  const { snapshot, report } = buildStockSnapshot({ date, items, oneP, prev })
  const text = buildStockMessage(date, report, prev?.date ?? null)
  const out = opt('--out')
  if (out) fs.writeFileSync(out, JSON.stringify({ snapshot, report }, null, 2))
  const id = await save(snapshot)
  console.log(
    `${date}\t${id}\t상품 ${report.total} · 품절 ${report.soldOutGroups.length}그룹 · 재고적음 ${report.lowStock.length} · 가격다름 ${report.priceDiffs.length} · 위너아님 ${report.notItemWinner.length} · 시트매칭안됨 ${report.unmatched}`,
  )
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
