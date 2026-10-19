/**
 * 쿠팡 상품 결합(노출상품ID) 변동 감지 (대표 맥 전용, launchd 가 ~/Downloads 변경 때 + 매일 09:30 실행).
 *   1단계: 3P 옵션 이탈 감지 — 윙 엑셀 비교
 *   2단계: 쿠팡 파트너스 오픈 API 검색 스냅샷 — 1P·3P 페이지 분리 (하루 1회, 09:00 KST 이후. 키 없으면 이 단계만 건너뛰고 맥 알림)
 *
 * 하는 일:
 *   ~/Downloads 의 윙 엑셀 Coupang_detailinfo_YYMMDD.xlsx 또는 price_inventory_YYMMDD.xlsx 중 아직 처리 안 한 날짜만
 *   → 옵션 행 파싱 (시트 범위 메타 재계산 · 병합 칸 채움) → 직전 날짜 스냅샷과 옵션ID 기준 비교
 *   → Supabase dashboard_data 'coupang_catalog_YYYY-MM-DD' 1행 저장 → 슬랙 #쿠팡-결합 한 장 (--send 일 때만)
 *   같은 날짜 파일이 둘 다 있으면 detailinfo 를 쓴다. 쓰는 곳은 이 id 패턴뿐.
 *   비교·메시지는 lib/coupang/catalogWatch.ts (손익 숫자 없음 — 직원 공유 채널)
 *
 * 키(.env.local): SUPABASE_SERVICE_ROLE_KEY · SLACK_REVIEW_WEBHOOK_URL(--send 때) · GOOGLE_SERVICE_ACCOUNT(⚪ 마진계산 노출ID, 없으면 그 줄만 생략)
 *   · COUPANG_PARTNERS_ACCESS_KEY / COUPANG_PARTNERS_SECRET_KEY (2단계)
 * 2단계 키워드·브랜드·결과 수: scripts/coupang-catalog-watch/search-keywords.json (대표가 고쳐도 됨)
 * 2단계 저장: dashboard_data 'coupang_catalog_search_YYYY-MM-DD' (우리 상품 결과만). 슬랙은 같은 날 1단계 메시지에 '2단계(검색)' 블록으로 합침
 * 실패(파싱 0행·저장 실패·웹훅 없음)는 숫자 없이 "수집 실패: 사유" + 맥 알림. 처리 기록을 안 남겨 다음 실행에 다시 시도.
 * 기록: ~/.namu-catalog-watch/processed.json (처리한 날짜) · run.log
 *
 * 실행:
 *   npx tsx scripts/coupang-catalog-watch/run.ts --init                 # 처음 한 번: 지금 Downloads 의 옛 파일을 '처리함'으로만 기록
 *   npx tsx scripts/coupang-catalog-watch/run.ts --send                 # 감시 실행 (launchd) — 저장 + 슬랙
 *   npx tsx scripts/coupang-catalog-watch/run.ts                        # 저장까지만, 슬랙은 화면 출력
 *   검증용 (Supabase 대신 로컬 폴더, 슬랙 안 보냄):
 *   npx tsx scripts/coupang-catalog-watch/run.ts --file <xlsx> --date YYYY-MM-DD --local-store <dir> [--margin <json>] [--out <json>]
 *   2단계 검증 (키 없이, 기록해 둔 검색 결과로): ... --local-store <dir> --search --search-mock <json {키워드: productData[]}> --today YYYY-MM-DD
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import * as XLSX from 'xlsx'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { repairRef } from '../../lib/b2b/kurlyFile'
import {
  CATALOG_ID_PREFIX,
  buildCatalogMessage,
  catalogSnapshotId,
  parseCatalogRows,
  type CatalogSnapshot,
} from '../../lib/coupang/catalogWatch'
import {
  SEARCH_ID_PREFIX,
  buildSearchBlock,
  isOurs,
  searchSnapshotId,
  urlIds,
  type SearchItem,
  type SearchSnapshot,
} from '../../lib/coupang/catalogSearch'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { partnersKeys, searchProducts, type PartnersProduct } from './partners'

const REPO = path.resolve(__dirname, '..', '..')
const DOWNLOADS = path.join(os.homedir(), 'Downloads')
const STATE_DIR = path.join(os.homedir(), '.namu-catalog-watch')
const PROCESSED = path.join(STATE_DIR, 'processed.json')
const LOG = path.join(STATE_DIR, 'run.log')
const LOCK = path.join(STATE_DIR, 'lock')
const FILE_RE = /^(Coupang_detailinfo|price_inventory)_(\d{6})\.xlsx$/ // '(1)' 중복·'~$' 잠금은 여기서 걸러짐
const SETTLE_MS = 5000

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const SEND = flag('--send')
const LOCAL = opt('--local-store')
const TEST = !!opt('--file') // 검증 실행 — 처리 기록·잠금 없음

function loadEnvLocal() {
  const p = path.join(REPO, '.env.local')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000)
const kstStamp = () => kstNow().toISOString().slice(0, 19).replace('T', ' ')
function log(...cols: string[]) {
  const line = [kstStamp(), ...cols].join('\t')
  console.log(line)
  if (TEST) return
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.appendFileSync(LOG, line + '\n')
}
function notify(title: string, message: string) {
  console.log(`[알림] ${title} — ${message}`)
  if (TEST) return
  try {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    execFileSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`])
  } catch {
    /* 무시 — 로그에 남음 */
  }
}

type Processed = Record<string, { at: string; file: string; result: string }>
const readProcessed = (): Processed => {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED, 'utf-8')) as Processed
  } catch {
    return {}
  }
}
function markProcessed(p: Processed, date: string, file: string, result: string) {
  p[date] = { at: new Date().toISOString(), file, result }
  if (TEST) return
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(PROCESSED, JSON.stringify(p, null, 2))
}

// ── 저장소: Supabase(기본) 또는 로컬 폴더(검증) ──────────────────
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('.env.local 에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음')
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _sb
}
/** date 보다 앞 날짜 중 가장 최근 스냅샷 */
async function loadPrev(date: string): Promise<CatalogSnapshot | null> {
  const cur = catalogSnapshotId(date)
  if (LOCAL) {
    const ids = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f) => f.startsWith(`${CATALOG_ID_PREFIX}20`)).map((f) => f.replace(/\.json$/, '')) : []
    const id = ids.filter((x) => x < cur).sort().pop()
    return id ? (JSON.parse(fs.readFileSync(path.join(LOCAL, `${id}.json`), 'utf-8')) as CatalogSnapshot) : null
  }
  const { data, error } = await sb()
    .from('dashboard_data')
    .select('id')
    .like('id', `${CATALOG_ID_PREFIX}20%`) // 'coupang_catalog_search_…' 와 안 섞이게 날짜로 시작하는 것만
    .lt('id', cur)
    .order('id', { ascending: false })
    .limit(1)
  if (error) throw new Error(`직전 스냅샷 목록 읽기 실패: ${error.message}`)
  const id = data?.[0]?.id as string | undefined
  if (!id) return null
  const r = await sb().from('dashboard_data').select('data').eq('id', id).single()
  if (r.error) throw new Error(`직전 스냅샷 읽기 실패 (${id}): ${r.error.message}`)
  return (r.data?.data as CatalogSnapshot) ?? null
}
async function saveSnapshot(s: CatalogSnapshot) {
  const id = catalogSnapshotId(s.date)
  if (LOCAL) {
    fs.mkdirSync(LOCAL, { recursive: true })
    fs.writeFileSync(path.join(LOCAL, `${id}.json`), JSON.stringify(s))
    return id
  }
  const { error } = await sb().from('dashboard_data').upsert({ id, data: s, updated_at: new Date().toISOString() })
  if (error) throw new Error(`스냅샷 저장 실패 (${id}): ${error.message}`)
  return id
}

// ── 마진계산 노출ID (W열, 쿠팡 1P·3P) — ⚪ 줄 전용, 못 읽으면 null ──
async function loadMasterPids(): Promise<Set<string> | null> {
  try {
    let margin: unknown[][]
    const file = opt('--margin')
    if (file) margin = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { margin: unknown[][] }).margin
    else {
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT
      if (!raw) return null
      const creds = JSON.parse(raw)
      if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
      const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
      const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `'마진계산'!A2:W`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      margin = (res.data.values || []) as unknown[][]
    }
    const ids = new Set<string>()
    for (const r of margin) {
      const ch = String(r?.[0] ?? '').trim()
      const id = String(r?.[22] ?? '').trim()
      if ((ch === '쿠팡 1P' || ch === '쿠팡 3P') && /^\d+$/.test(id)) ids.add(id)
    }
    return ids.size ? ids : null
  } catch {
    return null
  }
}

// ── 파일 ────────────────────────────────────────────────────────
type Candidate = { file: string; name: string; kind: string; date: string; mtime: number }
function candidates(): Candidate[] {
  const one = opt('--file')
  const files = one ? [path.resolve(one)] : fs.readdirSync(DOWNLOADS).map((n) => path.join(DOWNLOADS, n))
  const out: Candidate[] = []
  for (const file of files) {
    const name = path.basename(file)
    const m = FILE_RE.exec(name)
    const date = opt('--date') ?? (m ? `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}` : '')
    if (!one && !m) continue
    const st = fs.statSync(file)
    if (!st.isFile() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    out.push({ file, name, kind: m?.[1] ?? 'test', date, mtime: st.mtimeMs })
  }
  // 날짜별 1개 — detailinfo 우선
  const byDate = new Map<string, Candidate>()
  for (const c of out.sort((a, b) => (a.kind === 'Coupang_detailinfo' ? -1 : 1) - (b.kind === 'Coupang_detailinfo' ? -1 : 1)))
    if (!byDate.has(c.date)) byDate.set(c.date, c)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function readCatalog(file: string) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' })
  const sheet = wb.Sheets['Template'] ?? wb.Sheets['data'] ?? wb.Sheets[wb.SheetNames[0]]
  if (!sheet) throw new Error('시트 없음')
  repairRef(sheet) // !ref 가 헤더 행까지만 적혀 있음 → 실제 범위로
  const rows = parseCatalogRows(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' }))
  if (!rows.length) throw new Error('옵션 행 0개 (헤더 못 찾음 또는 빈 파일)')
  return rows
}

async function postSlack(text: string) {
  const url = process.env.SLACK_REVIEW_WEBHOOK_URL
  if (!url) throw new Error('.env.local 에 SLACK_REVIEW_WEBHOOK_URL 없음')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
}

/** 실패 — 숫자 없이 사유만 (슬랙은 --send 이고 웹훅이 있을 때만) */
async function fail(name: string, date: string, reason: string) {
  log(name, date, '실패', reason)
  notify('쿠팡 결합 점검 실패', `${date} ${reason}`.slice(0, 150))
  if (SEND && process.env.SLACK_REVIEW_WEBHOOK_URL) {
    try {
      await postSlack(`*[쿠팡 결합 점검 ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}]* 수집 실패: ${reason}`)
    } catch {
      /* 알림·로그에 남음 */
    }
  }
}

// ── 2단계: 파트너스 검색 스냅샷 ──────────────────────────────────
const SEARCH_CONFIG = path.join(__dirname, 'search-keywords.json')
const SEARCH_HISTORY = 14 // 비교에 쓰는 지난 검색 스냅샷 수 (처음 보는 노출상품 판단용)
const SEARCH_FROM_HOUR = 9 // KST 이 시각 이후에만 (하루 1회)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function loadSearchHistory(date: string): Promise<SearchSnapshot[]> {
  const cur = searchSnapshotId(date)
  if (LOCAL) {
    const ids = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f) => f.startsWith(SEARCH_ID_PREFIX)).map((f) => f.replace(/\.json$/, '')) : []
    return ids
      .filter((x) => x < cur)
      .sort()
      .slice(-SEARCH_HISTORY)
      .map((id) => JSON.parse(fs.readFileSync(path.join(LOCAL, `${id}.json`), 'utf-8')) as SearchSnapshot)
  }
  const { data, error } = await sb()
    .from('dashboard_data')
    .select('id, data')
    .like('id', `${SEARCH_ID_PREFIX}%`)
    .lt('id', cur)
    .order('id', { ascending: false })
    .limit(SEARCH_HISTORY)
  if (error) throw new Error(`검색 스냅샷 읽기 실패: ${error.message}`)
  return (data ?? []).map((r) => r.data as SearchSnapshot).reverse()
}
async function saveSearch(s: SearchSnapshot) {
  const id = searchSnapshotId(s.date)
  if (LOCAL) {
    fs.mkdirSync(LOCAL, { recursive: true })
    fs.writeFileSync(path.join(LOCAL, `${id}.json`), JSON.stringify(s))
    return id
  }
  const { error } = await sb().from('dashboard_data').upsert({ id, data: s, updated_at: new Date().toISOString() })
  if (error) throw new Error(`검색 스냅샷 저장 실패 (${id}): ${error.message}`)
  return id
}

/** 오늘 검색 → 저장 → 슬랙 블록. 건너뛰면 null (이미 함·09시 전·키 없음). 실패는 throw */
async function runSearch(processed: Processed, today: string): Promise<{ lines: string[] } | null> {
  const forced = flag('--search')
  if (TEST && !forced) return null
  if (!forced && (processed[`search:${today}`] || kstNow().getUTCHours() < SEARCH_FROM_HOUR)) return null
  const mockFile = opt('--search-mock')
  const mock = mockFile ? (JSON.parse(fs.readFileSync(mockFile, 'utf-8')) as Record<string, PartnersProduct[]>) : null
  const keys = partnersKeys()
  if (!keys && !mock) {
    if (!processed[`search-nokey:${today}`]) {
      log('-', today, '2단계 건너뜀', '파트너스 키 없음 (COUPANG_PARTNERS_ACCESS_KEY·SECRET_KEY)')
      notify('쿠팡 결합 점검 2단계 대기', '.env.local 에 쿠팡 파트너스 키 없음 — 1단계만 실행')
      markProcessed(processed, `search-nokey:${today}`, '-', 'no-key')
    }
    return null
  }
  const cfg = JSON.parse(fs.readFileSync(SEARCH_CONFIG, 'utf-8')) as { brands: string[]; limit: number; intervalMs: number; keywords: string[] }
  const masterPids = await loadMasterPids()
  const wing = await loadPrev(addDays(today, 1)) // 오늘까지 중 가장 최근 윙 스냅샷
  const knownPids = new Set<string>([...(masterPids ?? []), ...(wing?.rows.map((r) => r.pid).filter(Boolean) ?? [])])

  let limit = cfg.limit
  const keywords: SearchSnapshot['keywords'] = []
  const items: SearchItem[] = []
  for (const kw of cfg.keywords) {
    let list: PartnersProduct[] = []
    let error: string | undefined
    try {
      if (mock) list = mock[kw] ?? []
      else {
        try {
          list = await searchProducts(kw, limit, keys!)
        } catch (e) {
          // 상한보다 큰 limit 이면 거절될 수 있음 → 10 으로 한 번만 줄여 다시 (이후 키워드도 10)
          if (limit > 10 && /HTTP 400|limit/i.test(String(e))) {
            limit = 10
            list = await searchProducts(kw, limit, keys!)
          } else throw e
        }
        await sleep(cfg.intervalMs)
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 120) : String(e)
    }
    let ours = 0
    let withVi = 0
    for (const p of list) {
      const ids = urlIds(p.productUrl || '')
      if (ids.vendorItemId) withVi += 1
      const it: SearchItem = {
        kw,
        rank: Number(p.rank) || 0,
        pid: String(p.productId),
        name: p.productName || '',
        rocket: !!p.isRocket,
        cat: p.categoryName || '',
        ...ids,
      }
      if (isOurs(it, cfg.brands, knownPids)) {
        ours += 1
        items.push(it)
      }
    }
    keywords.push({ kw, count: list.length, ours, withVendorItemId: withVi, ...(error ? { error } : {}) })
  }
  if (keywords.every((k) => k.error)) throw new Error(`2단계 검색 전부 실패 — ${keywords[0]?.error ?? ''}`)
  const cur: SearchSnapshot = { date: today, collectedAt: new Date().toISOString(), limitUsed: limit, keywords, items }
  const history = await loadSearchHistory(today)
  const id = await saveSearch(cur)
  log('-', today, id, `2단계 검색 키워드 ${keywords.length}`, `우리 결과 ${items.length}`)
  const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1
  return { lines: buildSearchBlock({ cur, history, knownPids, masterPids, isMonday }) }
}

async function main() {
  loadEnvLocal()
  const processed = readProcessed()
  if (flag('--init')) {
    const list = candidates().filter((c) => !processed[c.date])
    for (const c of list) markProcessed(processed, c.date, c.name, 'init-existing')
    log(`${list.length}개 날짜`, '-', '초기화', '기존 윙 파일을 처리함으로 기록 (저장·슬랙 없음)')
    return
  }
  if (!TEST && !fs.existsSync(PROCESSED)) {
    log('-', '-', 'STOP', '처리 기록 없음 — 먼저 --init')
    notify('쿠팡 결합 점검 멈춤', '처음 설치 — run.ts --init 을 먼저 실행')
    return
  }
  const today = opt('--today') ?? kstNow().toISOString().slice(0, 10)
  if (SEND && !process.env.SLACK_REVIEW_WEBHOOK_URL) {
    await fail('-', today, '.env.local 에 SLACK_REVIEW_WEBHOOK_URL 없음')
    return
  }
  let todo = candidates().filter((c) => TEST || !processed[c.date])
  for (let i = 0; i < 12 && !TEST && todo.some((c) => Date.now() - c.mtime < SETTLE_MS); i++) {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    todo = candidates().filter((c) => !processed[c.date])
  }
  // 1단계 — 파일마다 저장하고 메시지는 모아 둠 (같은 날 2단계 블록을 붙이려고)
  const pending: { c: Candidate; text: string }[] = []
  for (const c of todo) {
    let rows
    try {
      rows = readCatalog(c.file)
    } catch (e) {
      await fail(c.name, c.date, `파싱 실패 — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    try {
      const prev = await loadPrev(c.date)
      const cur: CatalogSnapshot = { date: c.date, fileName: c.name, collectedAt: new Date().toISOString(), rows }
      const isMonday = new Date(`${c.date}T00:00:00Z`).getUTCDay() === 1
      const masterPids = !prev || isMonday ? await loadMasterPids() : null
      const text = buildCatalogMessage({ cur, prev, masterPids, isMonday })
      const out = opt('--out')
      if (out) fs.writeFileSync(out, JSON.stringify(cur, null, 2))
      const id = await saveSnapshot(cur)
      log(c.name, c.date, id, prev ? `비교 ${prev.date}` : '기준선', `옵션 ${rows.length}`)
      pending.push({ c, text })
    } catch (e) {
      await fail(c.name, c.date, e instanceof Error ? e.message : String(e))
    }
  }
  // 2단계 — 하루 1회. 실패해도 1단계 메시지는 보냄 (2단계 자리에 실패 사유 한 줄)
  let block: string[] | null = null
  let searchOk = false // 실패는 처리 기록 안 남김 → 다음 실행(09:30·파일 받을 때)에 다시
  try {
    block = (await runSearch(processed, today))?.lines ?? null
    searchOk = !!block
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    log('-', today, '2단계 실패', reason)
    notify('쿠팡 결합 점검 2단계 실패', reason.slice(0, 150))
    block = [`*2단계(검색)* 수집 실패: ${reason.slice(0, 150)}`]
  }
  const md = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}`
  const target = pending.find((p) => p.c.date === today) ?? pending[pending.length - 1]
  if (block && target) target.text += '\n\n' + block.join('\n')
  const messages = pending.map((p) => ({ key: p.c.date, name: p.c.name, text: p.text }))
  // 2단계만 실패한 날은 실패 메시지를 하루 한 번만 (재시도는 계속)
  if (block && !target && !searchOk && processed[`search-fail:${today}`]) block = null
  if (!searchOk && block && !TEST) markProcessed(processed, `search-fail:${today}`, '-', 'fail-noted')
  if (block && !target) messages.push({ key: `search:${today}`, name: '-', text: [`*[쿠팡 결합 점검 ${md}]* 오늘 윙 파일 없음 — 1단계(3P 옵션) 비교 없음`, '', ...block].join('\n') })

  for (const m of messages) {
    console.log('----- 슬랙 메시지 -----\n' + m.text + '\n-----------------------')
    if (SEND) {
      try {
        await postSlack(m.text)
        log(m.name, m.key, '슬랙 보냄')
      } catch (e) {
        await fail(m.name, m.key, e instanceof Error ? e.message : String(e))
        continue
      }
    }
    if (m.key.startsWith('search:')) {
      if (searchOk) markProcessed(processed, m.key, '-', SEND ? 'sent' : 'saved')
    } else markProcessed(processed, m.key, m.name, SEND ? 'saved-sent' : 'saved')
  }
  if (searchOk && target) markProcessed(processed, `search:${today}`, '-', 'merged')
}

function withLock(fn: () => Promise<void>) {
  if (TEST) return fn()
  fs.mkdirSync(STATE_DIR, { recursive: true })
  try {
    fs.mkdirSync(LOCK)
  } catch {
    if (Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60 * 1000) return Promise.resolve()
    fs.rmSync(LOCK, { recursive: true, force: true })
    fs.mkdirSync(LOCK)
  }
  return fn().finally(() => fs.rmSync(LOCK, { recursive: true, force: true }))
}

withLock(main).catch(async (e) => {
  await fail('-', kstNow().toISOString().slice(0, 10), e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
