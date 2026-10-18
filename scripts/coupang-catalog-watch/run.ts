/**
 * 쿠팡 상품 결합(노출상품ID) 변동 감지 — 1단계: 3P 옵션 이탈 감지 (대표 맥 전용, launchd 가 ~/Downloads 변경 때 실행).
 *
 * 하는 일:
 *   ~/Downloads 의 윙 엑셀 Coupang_detailinfo_YYMMDD.xlsx 또는 price_inventory_YYMMDD.xlsx 중 아직 처리 안 한 날짜만
 *   → 옵션 행 파싱 (시트 범위 메타 재계산 · 병합 칸 채움) → 직전 날짜 스냅샷과 옵션ID 기준 비교
 *   → Supabase dashboard_data 'coupang_catalog_YYYY-MM-DD' 1행 저장 → 슬랙 #쿠팡-결합 한 장 (--send 일 때만)
 *   같은 날짜 파일이 둘 다 있으면 detailinfo 를 쓴다. 쓰는 곳은 이 id 패턴뿐.
 *   비교·메시지는 lib/coupang/catalogWatch.ts (손익 숫자 없음 — 직원 공유 채널)
 *
 * 키(.env.local): SUPABASE_SERVICE_ROLE_KEY · SLACK_REVIEW_WEBHOOK_URL(--send 때) · GOOGLE_SERVICE_ACCOUNT(⚪ 마진계산 노출ID, 없으면 그 줄만 생략)
 * 실패(파싱 0행·저장 실패·웹훅 없음)는 숫자 없이 "수집 실패: 사유" + 맥 알림. 처리 기록을 안 남겨 다음 실행에 다시 시도.
 * 기록: ~/.namu-catalog-watch/processed.json (처리한 날짜) · run.log
 *
 * 실행:
 *   npx tsx scripts/coupang-catalog-watch/run.ts --init                 # 처음 한 번: 지금 Downloads 의 옛 파일을 '처리함'으로만 기록
 *   npx tsx scripts/coupang-catalog-watch/run.ts --send                 # 감시 실행 (launchd) — 저장 + 슬랙
 *   npx tsx scripts/coupang-catalog-watch/run.ts                        # 저장까지만, 슬랙은 화면 출력
 *   검증용 (Supabase 대신 로컬 폴더, 슬랙 안 보냄):
 *   npx tsx scripts/coupang-catalog-watch/run.ts --file <xlsx> --date YYYY-MM-DD --local-store <dir> [--margin <json>] [--out <json>]
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
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'

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
    const ids = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f) => f.startsWith(CATALOG_ID_PREFIX)).map((f) => f.replace(/\.json$/, '')) : []
    const id = ids.filter((x) => x < cur).sort().pop()
    return id ? (JSON.parse(fs.readFileSync(path.join(LOCAL, `${id}.json`), 'utf-8')) as CatalogSnapshot) : null
  }
  const { data, error } = await sb()
    .from('dashboard_data')
    .select('id')
    .like('id', `${CATALOG_ID_PREFIX}%`)
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
  if (SEND && !process.env.SLACK_REVIEW_WEBHOOK_URL) {
    await fail('-', kstNow().toISOString().slice(0, 10), '.env.local 에 SLACK_REVIEW_WEBHOOK_URL 없음')
    return
  }
  let todo = candidates().filter((c) => TEST || !processed[c.date])
  for (let i = 0; i < 12 && !TEST && todo.some((c) => Date.now() - c.mtime < SETTLE_MS); i++) {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    todo = candidates().filter((c) => !processed[c.date])
  }
  for (const c of todo) {
    let rows
    try {
      rows = readCatalog(c.file)
    } catch (e) {
      await fail(c.name, c.date, `파싱 실패 — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    let text: string
    try {
      const prev = await loadPrev(c.date)
      const cur: CatalogSnapshot = { date: c.date, fileName: c.name, collectedAt: new Date().toISOString(), rows }
      const isMonday = new Date(`${c.date}T00:00:00Z`).getUTCDay() === 1
      const masterPids = !prev || isMonday ? await loadMasterPids() : null
      text = buildCatalogMessage({ cur, prev, masterPids, isMonday })
      const out = opt('--out')
      if (out) fs.writeFileSync(out, JSON.stringify(cur, null, 2))
      const id = await saveSnapshot(cur)
      log(c.name, c.date, id, prev ? `비교 ${prev.date}` : '기준선', `옵션 ${rows.length}`)
    } catch (e) {
      await fail(c.name, c.date, e instanceof Error ? e.message : String(e))
      continue
    }
    console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
    if (SEND) {
      try {
        await postSlack(text)
        log(c.name, c.date, '슬랙 보냄')
      } catch (e) {
        await fail(c.name, c.date, e instanceof Error ? e.message : String(e))
        continue
      }
    }
    markProcessed(processed, c.date, c.name, SEND ? 'saved-sent' : 'saved')
  }
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
