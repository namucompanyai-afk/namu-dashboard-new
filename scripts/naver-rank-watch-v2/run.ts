/**
 * 네이버 쇼핑 키워드 순위 v2 — 대상(키워드+상품 전체) · 수집 · 저장·슬랙 (16GB 크롤링 맥, 매일 08:55·12:30)
 *   v1(scripts/naver-rank-watch/run.ts)과 다른 점: 키워드 1개가 특정 상품 1개에 묶이지 않는다 — 상품 목록 전체를
 *   키워드마다 매칭해서 naver_rank_history 테이블에 매회 전부 쌓는다(리셋 없음). 비교·매칭·문안은 lib/naver/rankWatchV2.ts.
 *   페이지 읽기(크롬 AppleScript + extract-naver.js)는 v1 그대로 재사용 — 추출 코드 안 바뀜(2026-10-22 브레인 확인,
 *   상품 식별은 MID로 충분해서 slot_dtl_chnl_prod_no 추가 안 함).
 *
 * 1) 대상: 나무_마스터 '네이버 순위 키워드' 탭 A(키워드)·E(ON/OFF)만 + '네이버 상품' 탭 A~D·I(상품번호·상품명·별칭·MID·추적ON/OFF)
 *      npx tsx scripts/naver-rank-watch-v2/run.ts --targets <out.json> [--limit N]
 * 2) 수집: 키워드마다 1페이지(스크롤로 지연 로딩 채움) — v1과 같은 방식·같은 접근 횟수
 *      npx tsx scripts/naver-rank-watch-v2/run.ts --fetch --targets <json> --results <dir> [--dump]
 * 3) 매칭·저장·슬랙: 결과를 상품 목록 전체와 매칭 → naver_rank_history insert(매회 전부, upsert by 날짜+슬롯+키워드+상품번호) → 슬랙
 *      npx tsx scripts/naver-rank-watch-v2/run.ts --store --targets <json> --results <dir> --run-slot morning|noon [--date] [--dry-run] [--send] [--out <json>]
 *      morning = 08:55 전체 보고(추적 ON 전부) · noon = 12:30 아침 대비 변동만(변동 없으면 슬랙 생략)
 *      비교 기준: morning → 전날 같은 슬롯(어제 08:55) · noon → 오늘 자신의 morning 수집
 *      --dry-run = naver_rank_history 에 안 씀(비교용 읽기는 그대로 함, Supabase 는 건드리지만 쓰기는 안 함)
 * 키: RANK_WATCH_V2_ENV 가 가리키는 파일(기본 저장소 .env.local) — GOOGLE_SERVICE_ACCOUNT · SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY ·
 *     SLACK_NAVER_WEBHOOK_URL(있으면 그 채널) 없으면 SLACK_REVIEW_WEBHOOK_URL(#쿠팡-결합)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'
import { extractIds, type RankItem, type RankResult } from '../../lib/naver/rankWatch'
import { buildRankV2Message, buildRankV2DeltaMessage, matchKeywordToProducts, type RankRowV2, type TrackedProduct } from '../../lib/naver/rankWatchV2'

const REPO = path.resolve(__dirname, '..', '..')
const KEYWORD_TAB = '네이버 순위 키워드'
const PRODUCT_TAB = '네이버 상품'
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.RANK_WATCH_V2_ENV ? path.resolve(expandHome(process.env.RANK_WATCH_V2_ENV)) : path.join(REPO, '.env.local')
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
const str = (v: unknown) => (v == null ? '' : String(v).trim())

// ── 시트 읽기 ──────────────────────────────────────────────────
type KeywordTarget = { keyword: string; searchType: 'shopping' | 'total' }

async function sheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  return google.sheets({ version: 'v4', auth })
}

/** '네이버 순위 키워드' 탭 — v2 는 A(키워드)·E(ON/OFF) 만 쓴다. URL·별칭·MID 칸은 '네이버 상품' 탭으로 이동함 */
async function readKeywordTargets(): Promise<KeywordTarget[]> {
  const sheets = await sheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `'${KEYWORD_TAB}'!A2:E`, valueRenderOption: 'UNFORMATTED_VALUE' })
  const rows = (res.data.values || []) as unknown[][]
  const out: KeywordTarget[] = []
  for (const r of rows) {
    const keyword = str(r[0])
    if (!keyword) continue
    const onoff = str(r[4]).toUpperCase()
    if (onoff && onoff !== 'ON' && onoff !== 'Y' && onoff !== 'TRUE') continue
    out.push({ keyword, searchType: 'shopping' }) // v2 는 검색종류(D열)도 안 읽는다 — 전부 쇼핑검색으로 고정(대표 지시, 지금 키워드 전부 쇼핑검색)
  }
  return out
}

/** '네이버 상품' 탭 — A상품번호·B상품명·C별칭·D MID·...·I 추적ON/OFF. 75행 안내문(※)은 상품번호 없음으로 자동 제외 */
async function readTrackedProducts(): Promise<TrackedProduct[]> {
  const sheets = await sheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `'${PRODUCT_TAB}'!A2:I`, valueRenderOption: 'UNFORMATTED_VALUE' })
  const rows = (res.data.values || []) as unknown[][]
  const out: TrackedProduct[] = []
  for (const r of rows) {
    const productNo = str(r[0])
    if (!productNo || productNo.startsWith('※')) continue
    const mid = str(r[3])
    const onoff = str(r[8]).toUpperCase()
    out.push({ productNo, name: str(r[1]), alias: str(r[2]), mid, trackOn: onoff === 'ON' || onoff === 'Y' || onoff === 'TRUE' })
  }
  return out
}

// ── 실제 크롬(AppleScript) 으로 검색 결과 읽기 — v1 과 동일(scripts/naver-rank-watch 공용 파일 그대로 재사용) ──
const APPLESCRIPT = path.join(REPO, 'scripts', 'naver-rank-watch', 'chrome-tab.applescript')
const EXTRACT_JS = path.join(REPO, 'scripts', 'naver-rank-watch', 'extract-naver.js')
type ExtractedItem = { id: string; ad: boolean; title: string; mall: string; price: number | string | null; link: string }
type Extracted = { url?: string; captcha?: boolean; count?: number; items?: ExtractedItem[]; dump?: string }
const WAIT_SEC = 8
const SCROLL_TIMES = 4
const KEYWORD_INTERVAL_MS = 30_000
function chromeExtract(url: string): Extracted {
  const raw = execFileSync('osascript', [APPLESCRIPT, url, EXTRACT_JS, String(WAIT_SEC), String(SCROLL_TIMES)], { encoding: 'utf-8', timeout: 90_000 }).trim()
  if (raw.startsWith('__ERROR__')) throw new Error(raw.slice(0, 200))
  if (!raw) throw new Error('execute javascript 결과 없음 — Chrome 보기>개발자>"Apple Events 의 JavaScript 허용" 확인')
  return JSON.parse(raw) as Extracted
}
const searchUrl = (t: KeywordTarget) => `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(t.keyword)}`

async function fetchAll(targets: KeywordTarget[], dir: string, dump: boolean) {
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
    for (const x of (Array.isArray(j) ? j : []) as Record<string, unknown>[]) {
      const keyword = str(x.keyword)
      if (!keyword) continue
      const items = Array.isArray(x.items) ? (x.items as Record<string, unknown>[]) : []
      out.push({
        keyword,
        searchType: 'shopping',
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
  for (const r of out) by.set(r.keyword, r)
  return [...by.values()]
}

// ── Supabase ──────────────────────────────────────────────────
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음')
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _sb
}
async function readRows(date: string, runSlot: 'morning' | 'noon'): Promise<RankRowV2[]> {
  const { data, error } = await sb().from('naver_rank_history').select('*').eq('collected_date', date).eq('run_slot', runSlot)
  if (error) throw new Error(`naver_rank_history 읽기 실패: ${error.message}`)
  return (data ?? []).map((d) => {
    const row = d as Record<string, unknown>
    return {
      keyword: str(row.keyword),
      productNo: str(row.product_no),
      mid: row.mid ? str(row.mid) : null,
      alias: row.alias ? str(row.alias) : null,
      isTracked: !!row.is_tracked,
      rank: row.rank == null ? null : Number(row.rank),
      isAd: !!row.is_ad,
      pageTotal: Number(row.page_total) || 0,
      status: str(row.status) as RankRowV2['status'],
    }
  })
}
async function insertRows(date: string, runSlot: 'morning' | 'noon', collectedAt: string, rows: RankRowV2[]) {
  const chunk = rows.map((r) => ({
    collected_date: date,
    collected_at: collectedAt,
    run_slot: runSlot,
    keyword: r.keyword,
    product_no: r.productNo,
    mid: r.mid,
    alias: r.alias,
    is_tracked: r.isTracked,
    rank: r.rank,
    is_ad: r.isAd,
    page_total: r.pageTotal,
    status: r.status,
  }))
  const { error } = await sb().from('naver_rank_history').upsert(chunk, { onConflict: 'collected_date,run_slot,keyword,product_no' })
  if (error) throw new Error(`naver_rank_history 저장 실패: ${error.message}`)
}
async function postSlack(text: string) {
  const url = process.env.SLACK_NAVER_WEBHOOK_URL || process.env.SLACK_REVIEW_WEBHOOK_URL
  if (!url) throw new Error('SLACK_NAVER_WEBHOOK_URL / SLACK_REVIEW_WEBHOOK_URL 없음')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
  return process.env.SLACK_NAVER_WEBHOOK_URL ? 'SLACK_NAVER_WEBHOOK_URL' : 'SLACK_REVIEW_WEBHOOK_URL(#쿠팡-결합)'
}

async function main() {
  loadEnv()

  if (opt('--targets') && !flag('--fetch') && !flag('--store')) {
    const file = path.resolve(opt('--targets')!)
    const limit = Number(opt('--limit') || 0)
    let [keywords, products] = await Promise.all([readKeywordTargets(), readTrackedProducts()])
    if (limit > 0) keywords = keywords.slice(0, limit) // 시험용 — 키워드 적게(접근 횟수 줄여서) 돌려보기
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ keywords, products }, null, 2))
    console.log(`키워드(ON) ${keywords.length}개 · 상품 ${products.length}개(ON ${products.filter((p) => p.trackOn).length}) → ${file}`)
    return
  }

  if (flag('--fetch')) {
    const tfile = opt('--targets')
    const rdir = opt('--results')
    if (!tfile || !rdir) throw new Error('--fetch 에는 --targets <json> --results <dir> 필요')
    const { keywords } = JSON.parse(fs.readFileSync(tfile, 'utf-8')) as { keywords: KeywordTarget[] }
    const out = await fetchAll(keywords, rdir, flag('--dump'))
    if (!out.some((r) => r.status === 'ok')) process.exitCode = 1
    return
  }

  if (flag('--store')) {
    const tfile = opt('--targets')
    const rdir = opt('--results')
    const runSlot = opt('--run-slot') as 'morning' | 'noon' | undefined
    if (!tfile || !rdir || !runSlot) throw new Error('--store 에는 --targets <json> --results <dir> --run-slot morning|noon 필요')
    if (runSlot !== 'morning' && runSlot !== 'noon') throw new Error('--run-slot 은 morning 또는 noon')
    const date = opt('--date') ?? kstToday()

    // 상품 목록은 --targets 시점 그대로 쓴다(같은 실행 묶음 안의 일관성 — fetch·store 사이 시트가 바뀌어도 이 묶음은 안 흔들림)
    const { keywords, products } = JSON.parse(fs.readFileSync(tfile, 'utf-8')) as { keywords: KeywordTarget[]; products: TrackedProduct[] }
    const results = readResults(rdir)
    const collectedAt = new Date().toISOString()

    const currentByKeyword = new Map<string, RankRowV2[]>()
    const allRows: RankRowV2[] = []
    for (const kw of keywords) {
      const r = results.find((x) => x.keyword === kw.keyword)
      const rows = r ? matchKeywordToProducts(kw.keyword, r, products) : [{ keyword: kw.keyword, productNo: '', mid: null, alias: null, isTracked: false, rank: null, isAd: false, pageTotal: 0, status: 'error' as const }]
      currentByKeyword.set(kw.keyword, rows)
      allRows.push(...rows)
    }
    const DRY = flag('--dry-run') // 시험용 — naver_rank_history 에 안 씀(비교 읽기는 그대로, 그래서 전날 자료가 있어야 의미 있는 비교가 됨)
    if (!DRY) await insertRows(date, runSlot, collectedAt, allRows)

    // 비교 기준 — morning: 전날 같은 슬롯(어제 08:55) · noon: 오늘 자신의 morning 수집. 둘 다 'morning' 슬롯을 읽는다
    const prevDate = runSlot === 'morning' ? addDays(date, -1) : date
    const prevRows = await readRows(prevDate, 'morning')
    const previousByKeyword = new Map<string, RankRowV2[]>()
    for (const r of prevRows) previousByKeyword.set(r.keyword, [...(previousByKeyword.get(r.keyword) ?? []), r])

    const keywordNames = keywords.map((k) => k.keyword)
    // morning: 전체 보고(항상 보냄) · noon: 변동분만(바뀐 게 없으면 안 보냄)
    let text: string
    let shouldSend: boolean
    if (runSlot === 'morning') {
      text = buildRankV2Message(date, keywordNames, currentByKeyword, previousByKeyword)
      shouldSend = true
    } else {
      const delta = buildRankV2DeltaMessage(date, keywordNames, currentByKeyword, previousByKeyword)
      text = delta.text
      shouldSend = delta.changed
    }

    const out = opt('--out')
    if (out) fs.writeFileSync(out, JSON.stringify({ date, runSlot, rows: allRows, text }, null, 2))
    console.log(`${date}\t${runSlot}\t키워드 ${keywords.length}개 · 매칭 행 ${allRows.filter((r) => r.productNo).length}개${DRY ? ' (--dry-run: naver_rank_history 저장 안 함)' : ' 저장'}`)
    if (!shouldSend) {
      console.log('아침 대비 변동 없음 — 슬랙 생략')
      return
    }
    console.log('----- 슬랙 메시지 -----\n' + text + '\n-----------------------')
    if (SEND) console.log(`${date}\t슬랙 보냄 (${await postSlack(text)})`)
    return
  }

  console.error('사용법: --targets <out.json> [--limit N] | --fetch --targets <json> --results <dir> [--dump] | --store --targets <json> --results <dir> --run-slot morning|noon [--date] [--dry-run] [--send] [--out <json>]')
  process.exitCode = 2
}
main().catch((e) => {
  console.error(`실패\t${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
