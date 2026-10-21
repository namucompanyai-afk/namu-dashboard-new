/**
 * 쿠팡 상품 페이지 가격 점검 — 대상 뽑기 · 결과 대조 · 저장 · 슬랙 (16GB 크롤링 맥이 매일 아침 실행, scripts/crawler-16gb/run-daily-page.sh)
 *   페이지 읽기 자체는 클로드 크롬 확장(jobs/page-price-check.md)이 하고, 이 스크립트는 그 앞뒤만 맡는다. 비교·메시지는 lib/coupang/pageWatch.ts
 *
 * 1) 대상: 나무_마스터 '마진계산' A2:AE → 채널 **쿠팡 3P만**(1P 는 scripts/coupang-stock-watch 가 맡음, 2026-10-21) 의 노출상품ID(W)·옵션ID(X)·쿠팡 소비자가 기준(AE)·봉수(C)·쿠팡옵션명(AD) → 노출상품ID별 묶음
 *    AE 가 비어 있는 옵션은 페이지는 읽되 비교하지 않고 '기준가 없음' 으로 센다 (D 는 1P 가 납품가라 쓰지 않음)
 *      npx tsx scripts/coupang-page-watch/run.ts --targets <out.json> [--batch 6] [--limit 10]
 *      → out.json 전체 + 같은 폴더에 <이름>_batch_01.json … (클로드 세션 1개당 페이지 수)
 * 2) 대조: 결과 폴더의 page_prices_batch_*.json 을 모아 직전 스냅샷과 비교 → dashboard_data 'coupang_page_YYYY-MM-DD' 저장 → 슬랙(--send 때만)
 *      npx tsx scripts/coupang-page-watch/run.ts --compare --targets <json> --results <dir> [--date YYYY-MM-DD] [--send] [--local-store <dir>] [--out <json>]
 *      --local-store 면 Supabase 대신 폴더(검증). --send 없으면 메시지를 화면에만.
 *
 * 키: 저장소 .env.local 또는 PAGE_WATCH_ENV 가 가리키는 파일 — GOOGLE_SERVICE_ACCOUNT(시트 읽기) · SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY(저장) · SLACK_REVIEW_WEBHOOK_URL(--send)
 * 슬랙은 #쿠팡-결합(Watchman, 직원 공유) — 마진·손익 숫자 없음.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { MARGIN_TAB } from '../../lib/coupang/marginFromSheet'
import {
  PAGE_ID_PREFIX,
  buildPageMessage,
  buildSnapshot,
  pageSnapshotId,
  type PageResult,
  type PageSnapshot,
  type TargetOption,
  type TargetPage,
} from '../../lib/coupang/pageWatch'

const REPO = path.resolve(__dirname, '..', '..')
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.PAGE_WATCH_ENV ? path.resolve(expandHome(process.env.PAGE_WATCH_ENV)) : path.join(REPO, '.env.local')

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
const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')))

// ── 1) 대상 ───────────────────────────────────────────────────────
async function readTargets(): Promise<TargetPage[]> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `'${MARGIN_TAB}'!A2:AE`, // AE = 쿠팡 소비자가(기준) — 대시보드가 읽는 A2:AD 뒤에 붙인 열 (대표 결정 2026-10-21)
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const rows = (res.data.values || []) as unknown[][]
  const byPid = new Map<string, TargetPage>()
  for (const r of rows) {
    const channel = str(r[0])
    if (channel !== '쿠팡 3P') continue // 1P 는 scripts/coupang-stock-watch(광고센터 상품 목록)가 맡는다 — 2026-10-21 대표 결정
    const pid = str(r[22])
    if (!/^\d+$/.test(pid)) continue
    const ae = num(r[30])
    const sheetPrice = str(r[30]) !== '' && Number.isFinite(ae) && ae > 0 ? ae : null // 비어 있으면 '기준가 없음' (비교 안 함)
    const o: TargetOption = {
      oid: /^\d+$/.test(str(r[23])) ? str(r[23]) : '',
      channel,
      sheetPrice,
      bagCount: num(r[2]) || 1,
      optionName: str(r[29]),
    }
    const t = byPid.get(pid) ?? { pid, alias: str(r[1]), options: [] }
    if (!t.alias) t.alias = str(r[1])
    t.options.push(o)
    byPid.set(pid, t)
  }
  return [...byPid.values()].sort((a, b) => a.pid.localeCompare(b.pid))
}

/** 가장 최근 윙 결합 감시 스냅샷(coupang_catalog_YYYY-MM-DD)의 옵션ID → 판매상태. 못 읽으면 null (필터 안 함) */
async function latestCatalogSales(): Promise<Map<string, string> | null> {
  try {
    const { data } = await sb().from('dashboard_data').select('id').like('id', 'coupang_catalog_20%').order('id', { ascending: false }).limit(1)
    const id = data?.[0]?.id as string | undefined
    if (!id) return null
    const r = await sb().from('dashboard_data').select('data').eq('id', id).single()
    const rows = (r.data?.data as { rows?: { oid: string; sale: string }[] })?.rows ?? []
    console.log(`판매상태 기준: ${id} (옵션 ${rows.length}행)`)
    return new Map(rows.map((x) => [String(x.oid), String(x.sale)]))
  } catch {
    return null
  }
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
async function loadPrev(date: string): Promise<PageSnapshot | null> {
  const cur = pageSnapshotId(date)
  if (LOCAL) {
    const ids = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f) => f.startsWith(`${PAGE_ID_PREFIX}20`)).map((f) => f.replace(/\.json$/, '')) : []
    const id = ids.filter((x) => x < cur).sort().pop()
    return id ? (JSON.parse(fs.readFileSync(path.join(LOCAL, `${id}.json`), 'utf-8')) as PageSnapshot) : null
  }
  const { data, error } = await sb().from('dashboard_data').select('id').like('id', `${PAGE_ID_PREFIX}20%`).lt('id', cur).order('id', { ascending: false }).limit(1)
  if (error) throw new Error(`직전 스냅샷 목록 읽기 실패: ${error.message}`)
  const id = data?.[0]?.id as string | undefined
  if (!id) return null
  const r = await sb().from('dashboard_data').select('data').eq('id', id).single()
  if (r.error) throw new Error(`직전 스냅샷 읽기 실패 (${id}): ${r.error.message}`)
  return (r.data?.data as PageSnapshot) ?? null
}
async function save(s: PageSnapshot) {
  const id = pageSnapshotId(s.date)
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

// ── 2) 결과 모으기 (클로드가 쓴 JSON — 형식이 조금 틀려도 최대한 살림) ──
function readResults(dir: string): PageResult[] {
  const out: PageResult[] = []
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^page_prices_batch_\d+\.json$/.test(f)).sort() : []
  for (const f of files) {
    let j: unknown
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
    } catch {
      console.log(`[경고] ${f} JSON 아님 — 건너뜀`)
      continue
    }
    const list = Array.isArray(j) ? j : Array.isArray((j as { pages?: unknown[] })?.pages) ? (j as { pages: unknown[] }).pages : []
    for (const x of list as Record<string, unknown>[]) {
      const pid = str(x.pid)
      if (!/^\d+$/.test(pid)) continue
      const opts = Array.isArray(x.options) ? (x.options as Record<string, unknown>[]) : []
      const n = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(num(v)) ? num(v) : null)
      out.push({
        pid,
        readAt: str(x.readAt) || new Date().toISOString(),
        status: (['ok', 'notfound', 'blocked', 'error'].includes(str(x.status)) ? str(x.status) : opts.length ? 'ok' : 'error') as PageResult['status'],
        title: str(x.title) || undefined,
        seller: str(x.seller) || undefined,
        rocket: !!x.rocket,
        reviews: n(x.reviews),
        soldOut: !!x.soldOut,
        vendorItemIds: Array.isArray(x.vendorItemIds) ? (x.vendorItemIds as unknown[]).map(str).filter((v) => /^\d+$/.test(v)) : undefined,
        options: opts.map((o) => ({
          label: str(o.label),
          oid: /^\d+$/.test(str(o.oid)) ? str(o.oid) : undefined,
          seller: str(o.seller) || undefined,
          price: n(o.price),
          listPrice: n(o.listPrice),
          wowPrice: n(o.wowPrice),
          couponPrice: n(o.couponPrice),
          soldOut: !!o.soldOut,
        })),
        note: str(x.note) || undefined,
      })
    }
  }
  // 같은 pid 가 여러 번이면 마지막(재시도) 것
  const byPid = new Map<string, PageResult>()
  for (const p of out) byPid.set(p.pid, p)
  return [...byPid.values()]
}

async function main() {
  loadEnv()
  if (opt('--targets') && !flag('--compare')) {
    const file = path.resolve(opt('--targets')!)
    const limit = Number(opt('--limit') || 0)
    const batch = Number(opt('--batch') || 6)
    let targets = await readTargets()
    // 윙에서 판매중지인 3P 옵션은 페이지에 안 보이므로 뺀다 (시트 중복 행 → '못 찾음' 부풀림 방지). --all-options 로 끔
    let dropped = 0
    if (!flag('--all-options')) {
      const sales = await latestCatalogSales()
      if (sales) {
        for (const t of targets) {
          const keep = t.options.filter((o) => o.channel !== '쿠팡 3P' || !o.oid || !sales.has(o.oid) || sales.get(o.oid) === '판매중')
          dropped += t.options.length - keep.length
          t.options = keep
        }
        targets = targets.filter((t) => t.options.length)
      }
    }
    if (dropped) console.log(`윙 판매중지 옵션 ${dropped}개 제외`)
    if (limit > 0) targets = targets.slice(0, limit)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(targets, null, 2))
    const base = file.replace(/\.json$/, '')
    let n = 0
    for (let i = 0; i < targets.length; i += batch) {
      n += 1
      fs.writeFileSync(`${base}_batch_${String(n).padStart(2, '0')}.json`, JSON.stringify(targets.slice(i, i + batch), null, 2))
    }
    const opts = targets.reduce((s, t) => s + t.options.length, 0)
    const noBase = targets.reduce((s, t) => s + t.options.filter((o) => o.sheetPrice == null).length, 0)
    console.log(`대상 페이지 ${targets.length} · 옵션 ${opts}(3P) · AE 기준가 없음 ${noBase} · 묶음 ${n}개(${batch}페이지씩) → ${file}`)
    return
  }
  if (flag('--compare')) {
    const tfile = opt('--targets')
    const rdir = opt('--results')
    if (!tfile || !rdir) throw new Error('--compare 에는 --targets <json> --results <dir> 필요')
    const date = opt('--date') ?? kstToday()
    const targets = JSON.parse(fs.readFileSync(tfile, 'utf-8')) as TargetPage[]
    const pages = readResults(rdir)
    const prev = await loadPrev(date)
    const { snapshot, report } = buildSnapshot({ date, targets, pages, prev })
    const text = buildPageMessage(date, report, prev?.date ?? null)
    const out = opt('--out')
    if (out) fs.writeFileSync(out, JSON.stringify({ snapshot, report }, null, 2))
    const id = await save(snapshot)
    console.log(`${date}\t${id}\t페이지 ${pages.length}/${targets.length} 읽음 · 시트와 다름 ${report.diffs.length} · 어제와 달라짐 ${report.changed.length} · 품절 ${report.soldOut.length} · 미등록 ${report.unregistered.length} · 못 찾음 ${report.unmatched.length}`)
    console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
    if (SEND) {
      await postSlack(text)
      console.log(`${date}\t슬랙 보냄`)
    }
    return
  }
  console.error('사용법: --targets <out.json> [--batch N] [--limit N] | --compare --targets <json> --results <dir> [--date] [--send] [--local-store <dir>] [--out <json>]')
  process.exitCode = 2
}

main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
