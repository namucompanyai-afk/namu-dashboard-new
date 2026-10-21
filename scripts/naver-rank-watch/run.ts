/**
 * 네이버 쇼핑 키워드 순위 — 대상 뽑기 · 결과 대조 · 저장 · 슬랙 (16GB 크롤링 맥 매일 08:15, scripts/crawler-16gb/run-daily-rank.sh)
 *   검색 결과 읽기는 클로드 크롬 확장(jobs/naver-rank-check.md), 비교·문안은 lib/naver/rankWatch.ts
 *
 * 1) 대상: 나무_마스터 '네이버 순위 키워드' 탭 A2:E (키워드 · 우리 상품 URL · 별칭 · 검색 종류 · ON/OFF)
 *      npx tsx scripts/naver-rank-watch/run.ts --targets <out.json> [--batch 3] [--limit 3]
 * 2) 수집: 16GB 실제 크롬을 AppleScript 로 조종(chrome-tab.applescript) — 키워드마다 탭 열기 → 8초 → 스크롤 4번(지연 로딩) → extract-naver.js 실행 → JSON → 탭 닫기.
 *      1페이지만 본다(2페이지는 캡차 유발, 2026-10-21) — 없으면 '40위 밖'. 키워드 간 30초. 결과는 naver_rank_batch_01.json. 광고 판별은 data-nlog-params 의 is_ad(네이버 로그용 속성, 추측 아님). --dump 는 상품을 거의 못 찾았을 때만 본문 저장(디버그용)
 *      npx tsx scripts/naver-rank-watch/run.ts --fetch --targets <json> --results <dir> [--dump]
 *      (클로드 크롬 확장은 네이버 쇼핑을 "safety restrictions" 로 거부, Playwright 는 캡차, 네이버 쇼핑 검색 API 는 2026-07-31 종료 → 남은 길이 이것. 10/21)
 * 3) 대조: 결과 폴더의 naver_rank_batch_*.json → 직전 스냅샷과 비교 → dashboard_data 'naver_rank_YYYY-MM-DD' → 슬랙(--send)
 *      npx tsx scripts/naver-rank-watch/run.ts --compare --targets <json> --results <dir> [--date] [--send] [--local-store <dir>] [--out <json>]
 * 키: RANK_WATCH_ENV 가 가리키는 파일(기본 저장소 .env.local) — GOOGLE_SERVICE_ACCOUNT · SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY ·
 *     SLACK_NAVER_WEBHOOK_URL(있으면 그 채널) 없으면 SLACK_REVIEW_WEBHOOK_URL(#쿠팡-결합 Watchman). 네이버 키 없음(로그인 없는 크롬)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { RANK_ID_PREFIX, buildRankDeltaMessage, buildRankMessage, buildRankSnapshot, extractIds, rankSnapshotId, type RankItem, type RankResult, type RankSnapshot, type RankTarget } from '../../lib/naver/rankWatch'

const REPO = path.resolve(__dirname, '..', '..')
const TAB = '네이버 순위 키워드'
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.RANK_WATCH_ENV ? path.resolve(expandHome(process.env.RANK_WATCH_ENV)) : path.join(REPO, '.env.local')
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

async function readTargets(): Promise<RankTarget[]> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `'${TAB}'!A2:G`, valueRenderOption: 'UNFORMATTED_VALUE' }) // G = 네이버 상품 MID(수기, 2026-10-22) — URL 이 브랜드스토어라 네이버 nvMid 와 달라서 따로 매칭용
  const rows = (res.data.values || []) as unknown[][]
  const out: RankTarget[] = []
  for (const r of rows) {
    const keyword = str(r[0])
    const url = str(r[1])
    if (!keyword || !url) continue
    const onoff = str(r[4]).toUpperCase()
    if (onoff && onoff !== 'ON' && onoff !== 'Y' && onoff !== 'TRUE') continue
    const mid = str(r[6])
    const ids = [...new Set([...extractIds(url), ...(/^\d+$/.test(mid) ? [mid] : [])])] // G열 네이버 상품 MID — URL(브랜드스토어 등) ID 와 네이버 검색 결과의 nv_mid 가 다를 수 있어 둘 다 매칭 대상
    if (!ids.length) {
      console.log(`[경고] ${keyword}: URL·MID 모두에서 상품 ID 못 뽑음 — 건너뜀 (${url.slice(0, 60)})`)
      continue
    }
    const kind = str(r[3])
    out.push({ keyword, url, alias: str(r[2]) || keyword, searchType: /통합|total/i.test(kind) ? 'total' : 'shopping', ids })
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
async function loadPrev(date: string): Promise<RankSnapshot | null> {
  const cur = rankSnapshotId(date)
  if (LOCAL) {
    const ids = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f) => f.startsWith(`${RANK_ID_PREFIX}20`)).map((f) => f.replace(/\.json$/, '')) : []
    const id = ids.filter((x) => x < cur).sort().pop()
    return id ? (JSON.parse(fs.readFileSync(path.join(LOCAL, `${id}.json`), 'utf-8')) as RankSnapshot) : null
  }
  const { data, error } = await sb().from('dashboard_data').select('id').like('id', `${RANK_ID_PREFIX}20%`).lt('id', cur).order('id', { ascending: false }).limit(1)
  if (error) throw new Error(`직전 스냅샷 목록 읽기 실패: ${error.message}`)
  const id = data?.[0]?.id as string | undefined
  if (!id) return null
  const r = await sb().from('dashboard_data').select('data').eq('id', id).single()
  if (r.error) throw new Error(`직전 스냅샷 읽기 실패 (${id}): ${r.error.message}`)
  return (r.data?.data as RankSnapshot) ?? null
}
/** 오늘 이미 저장된(아침) 스냅샷을 그대로 — 12:30 변동만 보는 용도 (어제가 아니라 '오늘 오전') */
async function loadToday(date: string): Promise<RankSnapshot | null> {
  const id = rankSnapshotId(date)
  if (LOCAL) {
    const f = path.join(LOCAL, `${id}.json`)
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf-8')) as RankSnapshot) : null
  }
  const { data, error } = await sb().from('dashboard_data').select('data').eq('id', id).maybeSingle()
  if (error) throw new Error(`오늘 스냅샷 읽기 실패: ${error.message}`)
  return (data?.data as RankSnapshot) ?? null
}
async function save(s: RankSnapshot) {
  const id = rankSnapshotId(s.date)
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
  const url = process.env.SLACK_NAVER_WEBHOOK_URL || process.env.SLACK_REVIEW_WEBHOOK_URL
  if (!url) throw new Error('SLACK_NAVER_WEBHOOK_URL / SLACK_REVIEW_WEBHOOK_URL 없음')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
  return process.env.SLACK_NAVER_WEBHOOK_URL ? 'SLACK_NAVER_WEBHOOK_URL' : 'SLACK_REVIEW_WEBHOOK_URL(#쿠팡-결합)'
}

// ── 실제 크롬(AppleScript) 으로 검색 결과 읽기 ──────────────────────
import { execFileSync } from 'child_process'
const APPLESCRIPT = path.join(__dirname, 'chrome-tab.applescript')
const EXTRACT_JS = path.join(__dirname, 'extract-naver.js')
type ExtractedItem = { id: string; ad: boolean; title: string; mall: string; price: number | string | null; link: string }
type Extracted = { url?: string; captcha?: boolean; count?: number; items?: ExtractedItem[]; dump?: string }
const WAIT_SEC = 8
const SCROLL_TIMES = 4 // 지연 로딩 — 스크롤 안 하면 9개쯤에서 멈춤 (10/21 확인)
const KEYWORD_INTERVAL_MS = 30_000 // 짧은 간격 연속 이동이 캡차 원인으로 보임(10/21) → 5초 → 30초
function chromeExtract(url: string): Extracted {
  const raw = execFileSync('osascript', [APPLESCRIPT, url, EXTRACT_JS, String(WAIT_SEC), String(SCROLL_TIMES)], { encoding: 'utf-8', timeout: 90_000 }).trim()
  if (raw.startsWith('__ERROR__')) throw new Error(raw.slice(0, 200))
  if (!raw) throw new Error('execute javascript 결과 없음 — Chrome 보기>개발자>"Apple Events 의 JavaScript 허용" 확인')
  return JSON.parse(raw) as Extracted
}
const searchUrl = (t: RankTarget) =>
  t.searchType === 'total'
    ? `https://search.naver.com/search.naver?query=${encodeURIComponent(t.keyword)}`
    : `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(t.keyword)}`
/** 키워드마다 1페이지만(스크롤로 지연 로딩 채움) — 2페이지는 안 간다(캡차 유발, 10/21). 못 찾으면 '40위 밖'. 결과는 크롬 확장 방식과 같은 파일 형식으로 저장 */
async function fetchAll(targets: RankTarget[], dir: string, dump: boolean) {
  fs.mkdirSync(dir, { recursive: true })
  const out: RankResult[] = []
  let loads = 0
  for (const t of targets) {
    const readAt = new Date().toISOString()
    try {
      const ex = chromeExtract(searchUrl(t))
      loads += 1
      if (dump && ex.dump) fs.writeFileSync(path.join(dir, `naver_dump_${t.keyword}.html`), ex.dump)
      if (ex.captcha) {
        out.push({ keyword: t.keyword, searchType: t.searchType, readAt, status: 'captcha', pagesRead: 1, items: [], note: '캡차·보안확인 화면' })
        console.log(`캡차 — ${t.keyword} 에서 중단, 오늘 남은 키워드는 건너뜀`)
        break
      }
      let n = 0
      const items: RankItem[] = (ex.items ?? []).map((it) => {
        if (!it.ad) n += 1
        return { rank: it.ad ? null : n, ad: !!it.ad, title: it.title, mall: it.mall, link: it.link, ids: it.id ? [it.id] : [] }
      })
      out.push({ keyword: t.keyword, searchType: t.searchType, readAt, status: 'ok', pagesRead: 1, items })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      out.push({ keyword: t.keyword, searchType: t.searchType, readAt, status: 'error', items: [], note: msg.slice(0, 200) })
    }
    await new Promise((r) => setTimeout(r, KEYWORD_INTERVAL_MS))
  }
  const file = path.join(dir, 'naver_rank_batch_01.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 1))
  const ok = out.filter((r) => r.status === 'ok').length
  console.log(`크롬 페이지 로드 ${loads}회 · 키워드 ${ok}/${targets.length} 읽음 → ${file}`)
  return out
}

function readResults(dir: string): RankResult[] {
  const out: RankResult[] = []
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^naver_rank_batch_\d+\.json$/.test(f)).sort() : []
  for (const f of files) {
    let j: unknown
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
    } catch {
      console.log(`[경고] ${f} JSON 아님 — 건너뜀`)
      continue
    }
    const list = Array.isArray(j) ? j : []
    for (const x of list as Record<string, unknown>[]) {
      const keyword = str(x.keyword)
      if (!keyword) continue
      const items = Array.isArray(x.items) ? (x.items as Record<string, unknown>[]) : []
      out.push({
        keyword,
        searchType: /통합|total/i.test(str(x.searchType)) ? 'total' : 'shopping',
        readAt: str(x.readAt) || new Date().toISOString(),
        status: (['ok', 'captcha', 'blocked', 'error'].includes(str(x.status)) ? str(x.status) : items.length ? 'ok' : 'error') as RankResult['status'],
        pagesRead: Number(x.pagesRead) || undefined,
        items: items.map((it) => ({
          rank: it.rank == null ? null : Number(it.rank),
          ad: !!it.ad,
          title: str(it.title) || undefined,
          mall: str(it.mall) || undefined,
          link: str(it.link) || undefined,
          ids: Array.isArray(it.ids) ? (it.ids as unknown[]).map(str).filter((v) => /^\d+$/.test(v)) : extractIds(str(it.link)),
        })),
        note: str(x.note) || undefined,
      })
    }
  }
  const by = new Map<string, RankResult>()
  for (const r of out) by.set(`${r.keyword}|${r.searchType}`, r)
  return [...by.values()]
}

async function main() {
  loadEnv()
  if (opt('--targets') && !flag('--compare') && !flag('--fetch')) {
    const file = path.resolve(opt('--targets')!)
    const limit = Number(opt('--limit') || 0)
    const batch = Number(opt('--batch') || 3)
    let targets = await readTargets()
    if (limit > 0) targets = targets.slice(0, limit)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(targets, null, 2))
    const base = file.replace(/\.json$/, '')
    let n = 0
    for (let i = 0; i < targets.length; i += batch) {
      n += 1
      fs.writeFileSync(`${base}_batch_${String(n).padStart(2, '0')}.json`, JSON.stringify(targets.slice(i, i + batch), null, 2))
    }
    console.log(`대상 키워드 ${targets.length} (통검 ${targets.filter((t) => t.searchType === 'total').length}) · 묶음 ${n}개(${batch}개씩) → ${file}`)
    return
  }
  if (flag('--fetch')) {
    const tfile = opt('--targets')
    const rdir = opt('--results')
    if (!tfile || !rdir) throw new Error('--fetch 에는 --targets <json> --results <dir> 필요')
    const targets = JSON.parse(fs.readFileSync(tfile, 'utf-8')) as RankTarget[]
    const out = await fetchAll(targets, rdir, flag('--dump'))
    if (!out.some((r) => r.status === 'ok')) process.exitCode = 1
    return
  }
  if (flag('--compare')) {
    const tfile = opt('--targets')
    const rdir = opt('--results')
    if (!tfile || !rdir) throw new Error('--compare 에는 --targets <json> --results <dir> 필요')
    const date = opt('--date') ?? kstToday()
    const targets = JSON.parse(fs.readFileSync(tfile, 'utf-8')) as RankTarget[]
    const results = readResults(rdir)
    const sinceToday = flag('--since-today') // 12:30 — 어제가 아니라 오늘 아침 스냅샷과 비교, 바뀐 것만
    const prev = sinceToday ? await loadToday(date) : await loadPrev(date)
    const { snapshot, report } = buildRankSnapshot({ date, targets, results, prev })
    const out = opt('--out')
    if (out) fs.writeFileSync(out, JSON.stringify({ snapshot, report }, null, 2))
    const id = await save(snapshot)
    if (sinceToday) {
      if (!prev) {
        console.log(`${date}\t${id}\t오늘 아침 스냅샷 없음 — 비교 없이 저장만 (슬랙 생략)`)
        return
      }
      const changed = report.moved.length > 0 || report.lost.length > 0
      console.log(`${date}\t${id}\t오늘 아침 대비 변동 ${report.moved.length} · 이탈 ${report.lost.length}`)
      if (!changed) {
        console.log('변동 없음 — 슬랙 생략')
        return
      }
      const deltaText = buildRankDeltaMessage(date, report)
      console.log('----- 슬랙 메시지(변동분만) -----\n' + deltaText + '\n-----------------------')
      if (SEND) console.log(`${date}\t슬랙 보냄 (${await postSlack(deltaText)})`)
      return
    }
    const text = buildRankMessage(date, report, prev?.date ?? null)
    console.log(`${date}\t${id}\t키워드 ${report.ranks.length}/${targets.length} 읽음 · 변동 ${report.moved.length} · 이탈 ${report.lost.length} · 못 읽음 ${report.unread.length}`)
    console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
    if (SEND) console.log(`${date}\t슬랙 보냄 (${await postSlack(text)})`)
    return
  }
  console.error('사용법: --targets <out.json> [--batch N] [--limit N] | --fetch --targets <json> --results <dir> [--dump] | --compare --targets <json> --results <dir> [--date] [--send] [--since-today] [--local-store <dir>] [--out <json>]')
  process.exitCode = 2
}
main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
