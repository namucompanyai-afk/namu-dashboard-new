/**
 * 네이버 쇼핑 키워드 순위 — 대상 뽑기 · 결과 대조 · 저장 · 슬랙 (16GB 크롤링 맥 매일 08:15, scripts/crawler-16gb/run-daily-rank.sh)
 *   검색 결과 읽기는 클로드 크롬 확장(jobs/naver-rank-check.md), 비교·문안은 lib/naver/rankWatch.ts
 *
 * 1) 대상: 나무_마스터 '네이버 순위 키워드' 탭 A2:E (키워드 · 우리 상품 URL · 별칭 · 검색 종류 · ON/OFF)
 *      npx tsx scripts/naver-rank-watch/run.ts --targets <out.json> [--batch 3] [--limit 3]
 * 2) 대조: 결과 폴더의 naver_rank_batch_*.json → 직전 스냅샷과 비교 → dashboard_data 'naver_rank_YYYY-MM-DD' → 슬랙(--send)
 *      npx tsx scripts/naver-rank-watch/run.ts --compare --targets <json> --results <dir> [--date] [--send] [--local-store <dir>] [--out <json>]
 * 키: RANK_WATCH_ENV 가 가리키는 파일(기본 저장소 .env.local) — GOOGLE_SERVICE_ACCOUNT · SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY ·
 *     SLACK_NAVER_WEBHOOK_URL(있으면 그 채널) 없으면 SLACK_REVIEW_WEBHOOK_URL(#쿠팡-결합 Watchman) 로 보냄
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { RANK_ID_PREFIX, buildRankMessage, buildRankSnapshot, extractIds, rankSnapshotId, type RankResult, type RankSnapshot, type RankTarget } from '../../lib/naver/rankWatch'

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
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `'${TAB}'!A2:E`, valueRenderOption: 'UNFORMATTED_VALUE' })
  const rows = (res.data.values || []) as unknown[][]
  const out: RankTarget[] = []
  for (const r of rows) {
    const keyword = str(r[0])
    const url = str(r[1])
    if (!keyword || !url) continue
    const onoff = str(r[4]).toUpperCase()
    if (onoff && onoff !== 'ON' && onoff !== 'Y' && onoff !== 'TRUE') continue
    const ids = extractIds(url)
    if (!ids.length) {
      console.log(`[경고] ${keyword}: URL 에서 상품 ID 못 뽑음 — 건너뜀 (${url.slice(0, 60)})`)
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
  if (opt('--targets') && !flag('--compare')) {
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
  if (flag('--compare')) {
    const tfile = opt('--targets')
    const rdir = opt('--results')
    if (!tfile || !rdir) throw new Error('--compare 에는 --targets <json> --results <dir> 필요')
    const date = opt('--date') ?? kstToday()
    const targets = JSON.parse(fs.readFileSync(tfile, 'utf-8')) as RankTarget[]
    const results = readResults(rdir)
    const prev = await loadPrev(date)
    const { snapshot, report } = buildRankSnapshot({ date, targets, results, prev })
    const text = buildRankMessage(date, report, prev?.date ?? null)
    const out = opt('--out')
    if (out) fs.writeFileSync(out, JSON.stringify({ snapshot, report }, null, 2))
    const id = await save(snapshot)
    console.log(`${date}\t${id}\t키워드 ${report.ranks.length}/${targets.length} 읽음 · 변동 ${report.moved.length} · 이탈 ${report.lost.length} · 못 읽음 ${report.unread.length}`)
    console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
    if (SEND) console.log(`${date}\t슬랙 보냄 (${await postSlack(text)})`)
    return
  }
  console.error('사용법: --targets <out.json> [--batch N] [--limit N] | --compare --targets <json> --results <dir> [--date] [--send] [--local-store <dir>] [--out <json>]')
  process.exitCode = 2
}
main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
