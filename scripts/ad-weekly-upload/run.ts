/**
 * 쿠팡 광고 보고서 → 광고 분석 주간 기록 자동 업로드 (대표 맥 전용, launchd 가 ~/Downloads 변경 때 실행).
 *
 * 하는 일 (광고 분석 '라이브' 업로드와 같은 규칙·같은 함수):
 *   ~/Downloads 의 A00993784_pa_total_campaign_YYYYMMDD_YYYYMMDD.xlsx 중 아직 처리 안 한 파일만
 *   - 7일(월~일) 파일 → parseAdCampaign → augmentMasterWith1P → buildAdAnalysisView → snapshotFromView
 *                       → mergeWeeklySnapshot(같은 기간 교체·다른 기간 누적) → dashboard_data 'coupang_ad_weekly_snapshots'
 *   - 10일 이하인데 7일(월~일)이 아닌 파일 → 저장 안 함, 알림만 (부분 주가 지난주 대비·2주 연속 판정을 꼬지 않게)
 *   - 25일 이상 → AD_LIVE_30D_SAVE=on 일 때만 'coupang_ad_live_30d' 최신 1개 교체 (꺼져 있으면 저장 안 함)
 *   - 11~24일 → 처리 안 함 (화면과 같음)
 *   - 종료일이 오늘(KST)보다 뒤 → 건너뜀 · 다른 업체코드·'(1)' 중복·'~$' 잠금 파일 → 파일명 규칙에서 제외
 * 쓰는 표는 dashboard_data 의 위 두 행뿐 — 운영 메모·목표 ROAS(coupang_ad_history_notes·coupang_campaign_targets)는 건드리지 않는다.
 *
 * 키: 저장소 루트 .env.local — SUPABASE_SERVICE_ROLE_KEY(서버 키) · GOOGLE_SERVICE_ACCOUNT(나무_마스터 읽기, 화면과 같은 마진마스터)
 *     둘 중 하나라도 없으면 아무것도 쓰지 않고 멈춘 뒤 알림 (처리 기록도 안 남겨서 키를 넣으면 다음 실행에 처리된다).
 * 환경변수(없으면 위 기본값 그대로): AD_UPLOAD_DIR = 감시 폴더 · AD_UPLOAD_ENV = 키 파일 경로 (16GB 크롤링 맥용, scripts/crawler-16gb/SETUP.md)
 * 기록: ~/.namu-ad-upload/processed.json (처리한 파일명 — 같은 파일 두 번 안 올림) · ~/.namu-ad-upload/upload.log (한 줄씩)
 * 알림: 맥 알림 센터(osascript). 손익 숫자는 넣지 않는다 (파일명·기간·결과만).
 *
 * 실행:
 *   npx tsx scripts/ad-weekly-upload/run.ts                 # 감시 실행 (launchd)
 *   npx tsx scripts/ad-weekly-upload/run.ts --init          # 처음 한 번: 지금 ~/Downloads 에 있는 보고서를 '처리함'으로만 기록 (옛 주간이 한꺼번에 올라가지 않게)
 *   npx tsx scripts/ad-weekly-upload/run.ts --dry-run       # 저장·처리 기록 없이 판단만 출력
 *   npx tsx scripts/ad-weekly-upload/run.ts --dry-run --file <xlsx> --margin <json> --out <json>
 *       # 검증용: 마진마스터를 시트 대신 파일({ margin, price } = 마진계산 A2:AD · 단가DB A2:J 원래 값)로 받고, 만든 스냅샷을 파일로 쓴다
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { parseAdCampaign, extractPeriodFromFileName } from '../../lib/coupang/parsers/adCampaign'
import { augmentMasterWith1P } from '../../lib/coupang/onePAnalysis'
import { buildAdAnalysisView } from '../../lib/coupang/adAnalysis'
import { packAdRows } from '../../lib/coupang/adRowsPack'
import { getDefaultConstants } from '../../lib/coupang/costBook'
import { MARGIN_TAB, PRICE_TAB, marginMasterFromSheet, type SheetCell } from '../../lib/coupang/marginFromSheet'
import {
  WEEKLY_SNAPSHOTS_KEY,
  compareSnapshots,
  findSamePeriod,
  mergeWeeklySnapshot,
  snapshotFromView,
  type StoredWeeklySnapshot,
} from '../../lib/coupang/weeklySnapshots'
import { MASTER_SHEET_ID } from '../../lib/sheet-ids'

const REPO = path.resolve(__dirname, '..', '..')
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
// 감시 폴더·키 파일 — 기본은 24GB 그대로(~/Downloads · 저장소 .env.local). 16GB 크롤링 맥은 환경변수로 바꿔 쓴다 (scripts/crawler-16gb)
const DOWNLOADS = process.env.AD_UPLOAD_DIR ? path.resolve(expandHome(process.env.AD_UPLOAD_DIR)) : path.join(os.homedir(), 'Downloads')
const ENV_FILE = process.env.AD_UPLOAD_ENV ? path.resolve(expandHome(process.env.AD_UPLOAD_ENV)) : path.join(REPO, '.env.local')
const STATE_DIR = path.join(os.homedir(), '.namu-ad-upload')
const PROCESSED = path.join(STATE_DIR, 'processed.json')
const LOG = path.join(STATE_DIR, 'upload.log')
const LOCK = path.join(STATE_DIR, 'lock')
const LIVE_30D_KEY = 'coupang_ad_live_30d'
const DAILY_KEY_PREFIX = 'coupang_ad_daily_' // 2026-10-22 추가 — 어제 1일 보고서(16GB 8번째 작업). dashboard_data 'coupang_ad_daily_YYYY-MM-DD'
const WEEKLY_MAX_DAYS = 10 // 화면과 같은 구간 (ad-analysis page.tsx)
const MONTHLY_MIN_DAYS = 25
const FILE_RE = /^A00993784_pa_total_campaign_(\d{8})_(\d{8})\.xlsx$/ // 업체코드 고정 · '(1)'·'~$' 는 여기서 걸러짐
const SETTLE_MS = 5000 // 다운로드 직후 파일 — 마지막 수정 후 5초 지날 때까지 기다린 뒤 처리 (launchd 는 다시 안 부를 수 있음)

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const DRY = flag('--dry-run')

// ── 환경 (.env.local) ────────────────────────────────────────────
function loadEnvLocal() {
  const p = ENV_FILE
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

// ── 기록·알림 ────────────────────────────────────────────────────
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000)
const kstToday = () => kstNow().toISOString().slice(0, 10)
const kstStamp = () => kstNow().toISOString().slice(0, 19).replace('T', ' ')

function log(fileName: string, period: string, savedId: string, result: string, note = '') {
  const line = [kstStamp(), fileName, period, savedId || '-', result, note].join('\t')
  console.log(line)
  if (DRY) return
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.appendFileSync(LOG, line + '\n')
}

/** 맥 알림 — 손익 숫자 금지 (파일명·기간·결과 문장만) */
function notify(title: string, message: string) {
  console.log(`[알림] ${title} — ${message}`)
  if (DRY) return
  try {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    execFileSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`])
  } catch {
    /* 알림 실패는 무시 — 로그에는 남아 있다 */
  }
}

type Processed = Record<string, { at: string; result: string }>
function readProcessed(): Processed {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED, 'utf-8')) as Processed
  } catch {
    return {}
  }
}
function markProcessed(p: Processed, fileName: string, result: string) {
  p[fileName] = { at: new Date().toISOString(), result }
  if (DRY) return
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(PROCESSED, JSON.stringify(p, null, 2))
}

// ── Supabase (lib/supabase.ts 의 getData·saveData 와 같은 쿼리 — 그 모듈은 server-only 라 Next 밖에서 못 불러옴) ──
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음')
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _sb
}
async function getData(id: string): Promise<unknown> {
  const { data, error } = await sb().from('dashboard_data').select('data').eq('id', id).single()
  if (error) {
    if (error.code === 'PGRST116') return null // 행 없음
    throw new Error(`읽기 실패 (${id}): ${error.message}`)
  }
  return data?.data ?? null
}
async function saveData(id: string, payload: unknown) {
  const { error } = await sb().from('dashboard_data').upsert({ id, data: payload, updated_at: new Date().toISOString() })
  if (error) throw new Error(`저장 실패 (${id}): ${error.message}`)
}

// ── 마진마스터 (/api/coupang-margin-master 와 같은 시트·같은 변환) ──
async function loadMaster() {
  let margin: SheetCell[][]
  let price: SheetCell[][]
  const file = opt('--margin')
  if (file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8')) as { margin: SheetCell[][]; price: SheetCell[][] }
    margin = j.margin
    price = j.price
  } else {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음')
    const creds = JSON.parse(raw)
    if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
    const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`
    const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.batchGet({
      spreadsheetId: MASTER_SHEET_ID,
      ranges: [`${quote(MARGIN_TAB)}!A2:AD`, `${quote(PRICE_TAB)}!A2:J`],
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    margin = (res.data.valueRanges?.[0]?.values || []) as SheetCell[][]
    price = (res.data.valueRanges?.[1]?.values || []) as SheetCell[][]
  }
  const { marginRows, onePRows } = marginMasterFromSheet(margin, price)
  if (!marginRows.length) throw new Error('나무_마스터 마진계산 쿠팡 3P 행 0개')
  // 화면 setMarginMaster 와 같은 모양
  return { costBook: [], marginRows, constants: getDefaultConstants(), onePRows }
}

// ── 파일 고르기 ──────────────────────────────────────────────────
type Candidate = { file: string; name: string; startDate: string; endDate: string; days: number; mtime: number }
const isMonday = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay() === 1

function candidates(): Candidate[] {
  const one = opt('--file')
  const files = one ? [path.resolve(one)] : fs.readdirSync(DOWNLOADS).map((n) => path.join(DOWNLOADS, n))
  const out: Candidate[] = []
  for (const file of files) {
    const name = path.basename(file)
    if (!FILE_RE.test(name)) continue
    const st = fs.statSync(file)
    if (!st.isFile()) continue
    const p = extractPeriodFromFileName(name)
    if (!p) continue
    out.push({ file, name, startDate: p.startDate, endDate: p.endDate, days: p.periodDays, mtime: st.mtimeMs })
  }
  return out.sort((a, b) => a.endDate.localeCompare(b.endDate) || a.startDate.localeCompare(b.startDate))
}

const readRows = (file: string, name: string) => {
  const buf = fs.readFileSync(file)
  const r = parseAdCampaign(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, name)
  if (!r.rows.length) throw new Error('광고 캠페인 행 없음')
  return r.rows
}

// ── 실행 ─────────────────────────────────────────────────────────
async function main() {
  loadEnvLocal()
  if (flag('--init')) {
    const p = readProcessed()
    const list = candidates().filter((c) => !p[c.name])
    for (const c of list) markProcessed(p, c.name, 'init-existing')
    log(`${list.length}개`, '-', '', '초기화', '기존 보고서를 처리함으로 기록 (업로드 안 함)')
    return
  }
  if (!fs.existsSync(PROCESSED) && !DRY && !opt('--file')) {
    log('-', '-', '', 'STOP', '처리 기록 없음 — 먼저 --init')
    notify('쿠팡 광고 자동 업로드 멈춤', '처음 설치 — run.ts --init 을 먼저 실행')
    return
  }
  const processed = readProcessed()
  const today = kstToday()
  let todo = candidates().filter((c) => opt('--file') || !processed[c.name])
  if (!todo.length) return
  // 막 받은 파일이 있으면 수정이 멈출 때까지 최대 1분 기다린다
  for (let i = 0; i < 12 && !opt('--file') && todo.some((c) => Date.now() - c.mtime < SETTLE_MS); i++) {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    todo = candidates().filter((c) => !processed[c.name])
  }

  // 쓰기 전에 키부터 확인 — 없으면 아무것도 처리하지 않고(처리 기록도 안 남김) 알림
  if (!DRY) {
    const missing = ['SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_SERVICE_ACCOUNT'].filter((k) => !process.env[k])
    if (missing.length) {
      log(todo.map((c) => c.name).join(','), '-', '', 'STOP', `.env.local 에 ${missing.join('·')} 없음`)
      notify('쿠팡 광고 자동 업로드 멈춤', `.env.local 에 ${missing.join('·')} 없음 — 넣은 뒤 파일을 다시 받거나 수동 실행`)
      return
    }
  }

  let master: Awaited<ReturnType<typeof loadMaster>> | null = null
  const getMaster = async () => (master ??= await loadMaster())
  // 30일 파일은 이번 실행에서 종료일이 가장 늦은 것 1개만 (화면과 같음)
  const monthly = todo.filter((c) => c.days >= MONTHLY_MIN_DAYS && c.endDate <= today).slice(-1)[0]

  for (const c of todo) {
    const label = `${c.startDate}~${c.endDate}(${c.days}일)`
    try {
      if (c.endDate > today) {
        log(c.name, label, '', '건너뜀', '종료일이 오늘보다 뒤')
        notify('쿠팡 광고 자동 업로드', `${c.name} — 종료일이 오늘보다 뒤라 건너뜀`)
        markProcessed(processed, c.name, 'skip-future')
        continue
      }
      if (c.days === 1) {
        const key = `${DAILY_KEY_PREFIX}${c.startDate}`
        const rows = readRows(c.file, c.name)
        const item = {
          fileName: c.name,
          period: { startDate: c.startDate, endDate: c.endDate, days: c.days },
          downloadedAt: new Date(c.mtime + 9 * 3600 * 1000).toISOString().slice(0, 10),
          savedAt: new Date().toISOString(),
          rows: packAdRows(rows),
        }
        if (DRY) {
          log(c.name, label, key, '저장 안 함(dry-run)', `캠페인 ${new Set(rows.map((r) => r.campaignName)).size}개`)
          continue
        }
        await saveData(key, item)
        log(c.name, label, key, '저장', `캠페인 ${new Set(rows.map((r) => r.campaignName)).size}개`)
        notify('쿠팡 광고 일별 파일 저장', `${label} 저장`)
        markProcessed(processed, c.name, 'daily-save')
        continue
      }
      if (c.days <= WEEKLY_MAX_DAYS) {
        if (c.days !== 7 || !isMonday(c.startDate)) {
          log(c.name, label, '', '알림만', '7일(월~일) 아님 — 주간 기록 저장 안 함')
          notify('쿠팡 광고 주간 파일 아님', `${label} — 7일(월~일) 파일이 아니라 주간 기록에 올리지 않음`)
          markProcessed(processed, c.name, 'notify-partial')
          continue
        }
        const rows = readRows(c.file, c.name)
        const aug = augmentMasterWith1P((await getMaster()) as Parameters<typeof augmentMasterWith1P>[0], rows)
        const v = buildAdAnalysisView(rows, aug as Parameters<typeof buildAdAnalysisView>[1])
        const snapshot = snapshotFromView(v, c, c.name)
        const out = opt('--out')
        if (out) fs.writeFileSync(out, JSON.stringify(snapshot, null, 2))
        if (DRY) {
          log(c.name, label, WEEKLY_SNAPSHOTS_KEY, '저장 안 함(dry-run)', `캠페인 ${snapshot.campaigns.length}개`)
          continue
        }
        const saved = (await getData(WEEKLY_SNAPSHOTS_KEY)) as { items?: StoredWeeklySnapshot[] } | null
        // 같은 기간 저장본과 캠페인 수·광고비·광고 매출이 ±10% 넘게 다르면 업로드 실수 의심 — 사람이 없으니 저장 안 하고 알림 (손익 숫자는 알림에 안 넣음)
        const same = findSamePeriod(saved?.items ?? [], snapshot)
        if (same) {
          const diff = compareSnapshots(same, snapshot)
          if (diff.big) {
            log(c.name, label, WEEKLY_SNAPSHOTS_KEY, '저장 안 함(저장본과 다름)', diff.text)
            notify('쿠팡 광고 주간 파일 확인 필요', `${label} — 저장된 기록과 다름 (캠페인 ${diff.campaigns[0]}→${diff.campaigns[1]}개, 광고비 ${diff.costPct == null ? '새로 생김' : Math.round(diff.costPct) + '%'}, 매출 ${diff.revPct == null ? '새로 생김' : Math.round(diff.revPct) + '%'}). 대시보드에서 직접 올려 확인`)
            markProcessed(processed, c.name, 'guard-skip')
            continue
          }
        }
        const { items, replaced } = mergeWeeklySnapshot(saved?.items ?? [], { ...snapshot, savedAt: new Date().toISOString() })
        await saveData(WEEKLY_SNAPSHOTS_KEY, { items })
        log(c.name, label, WEEKLY_SNAPSHOTS_KEY, replaced ? '교체' : '누적', `캠페인 ${snapshot.campaigns.length}개 · 기록 ${items.length}주`)
        notify('쿠팡 광고 주간 기록 저장', `${label} ${replaced ? '교체' : '추가'}`)
        markProcessed(processed, c.name, replaced ? 'weekly-replace' : 'weekly-add')
        continue
      }
      if (c.days >= MONTHLY_MIN_DAYS) {
        if (c !== monthly) {
          log(c.name, label, '', '건너뜀', '더 늦은 30일 파일이 같이 있음')
          markProcessed(processed, c.name, 'skip-older-30d')
          continue
        }
        if (process.env.AD_LIVE_30D_SAVE !== 'on') {
          log(c.name, label, '', '저장 안 함', 'AD_LIVE_30D_SAVE 꺼짐')
          markProcessed(processed, c.name, 'skip-30d-off')
          continue
        }
        const rows = readRows(c.file, c.name)
        const item = {
          fileName: c.name,
          period: { startDate: c.startDate, endDate: c.endDate, days: c.days },
          downloadedAt: new Date(c.mtime + 9 * 3600 * 1000).toISOString().slice(0, 10), // 화면과 같음: 파일 수정 시각 KST 날짜
          savedAt: new Date().toISOString(),
          rows: packAdRows(rows),
        }
        if (DRY) {
          log(c.name, label, LIVE_30D_KEY, '저장 안 함(dry-run)', '최신 1개 교체 예정')
          continue
        }
        await saveData(LIVE_30D_KEY, item)
        log(c.name, label, LIVE_30D_KEY, '교체', '30일 파일 최신 1개')
        notify('쿠팡 광고 30일 파일 저장', `${label} 교체`)
        markProcessed(processed, c.name, '30d-replace')
        continue
      }
      log(c.name, label, '', '건너뜀', '11~24일 — 화면도 처리 안 함')
      markProcessed(processed, c.name, 'skip-mid')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(c.name, label, '', '실패', msg)
      notify('쿠팡 광고 자동 업로드 실패', `${c.name} — ${msg.slice(0, 120)}`)
      // 처리 기록 안 남김 — 원인 고친 뒤 다음 실행에서 다시 시도
    }
  }
}

// 동시 실행 막기 (launchd 가 Downloads 변경마다 부름)
function withLock(fn: () => Promise<void>) {
  if (DRY) return fn()
  fs.mkdirSync(STATE_DIR, { recursive: true })
  try {
    fs.mkdirSync(LOCK)
  } catch {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs
    if (age < 10 * 60 * 1000) return Promise.resolve() // 다른 실행 중
    fs.rmSync(LOCK, { recursive: true, force: true })
    fs.mkdirSync(LOCK)
  }
  return fn().finally(() => fs.rmSync(LOCK, { recursive: true, force: true }))
}

withLock(main).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  log('-', '-', '', '실패', msg)
  notify('쿠팡 광고 자동 업로드 실패', msg.slice(0, 120))
  process.exitCode = 1
})
