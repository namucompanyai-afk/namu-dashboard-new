/**
 * 킴스 금요일 서류 만들기 — 이랜드에서 내려받은 파일 → 진도팜·MD 서류 + 문구 + 슬랙 글.
 *
 *   npx tsx scripts/kims-friday/run.ts --por <PORInfo.xlsx> --alloc <CSV_OUTPUT.XLS> --out <폴더>
 *        [--stores-json <캐시.json>]   점포 주소 표 캐시(없으면 구글시트 '킴스 점포별 주소 및 연락처' 탭을 읽는다 — KIMS_ENV 의 GOOGLE_SERVICE_ACCOUNT)
 *        [--approved "PO번호,…"]       구매처승인을 자동으로 누른 PO번호 (슬랙 첫 줄에 표시)
 *        [--missing-pdf "오더장,할당리스트"]  사이트 원본 PDF 를 못 뽑았을 때 (슬랙 첫 줄 '오더장 원본 수작업 필요')
 *        [--send]                      슬랙(KIMS_SLACK_WEBHOOK_URL, 없으면 SLACK_SALES_WEBHOOK_URL=#손익) 으로 보냄
 *
 * 숫자는 이랜드 파일 그대로. 이랜드 사이트 접속·로그인은 이 스크립트가 하지 않는다(받아 둔 파일만 읽음).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { buildMdWorkbook } from '../../lib/kims/kimsMdWorkbook'
import sharp from 'sharp'
import { google } from 'googleapis'
import {
  JINDOFARM_HEADER,
  buildPlan,
  buildSlack,
  fileNames,
  jindofarmRows,
  messageFridayJindofarm,
  qtyTableSvg,
  summarySheetAoa,
  messageMd,
  messageMondayJindofarm,
  parseAlloc,
  parsePor,
  parseStoreSheet,
  type NameEntry,
  type StoreInfo,
} from '../../lib/kims/kimsFriday'

const HERE = __dirname
// 저장소가 공개라서 MD용 템플릿(이랜드 매입가 포함)·점포 담당자 캐시·실제 발주 파일은 저장소 밖 폴더에 둔다 (기본 ~/crawler/private/kims, KIMS_PRIVATE_DIR 로 바꿈)
const PRIVATE_DIR = path.resolve((process.env.KIMS_PRIVATE_DIR ?? '~/crawler/private/kims').replace(/^~\//, os.homedir() + '/'))
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
const ENV_FILE = process.env.KIMS_ENV ? path.resolve(expandHome(process.env.KIMS_ENV)) : path.join(HERE, '..', '..', '.env.local')
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

const STORE_TAB = '킴스 점포별 주소 및 연락처'

async function readStoreRows(): Promise<unknown[][]> {
  const cache = opt('--stores-json')
  if (cache && fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf-8')) as unknown[][]
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  const sheetId = process.env.KIMS_STORE_SHEET_ID // 인수인계 시트 ID — 공개 저장소라 코드에 안 넣고 16GB ~/crawler/.env 에 둔다
  if (!sheetId) throw new Error('KIMS_STORE_SHEET_ID 없음 (또는 --stores-json 캐시 필요)')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 없음 (또는 --stores-json 캐시 필요)')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${STORE_TAB}'`, valueRenderOption: 'FORMATTED_VALUE' })
  return (res.data.values || []) as unknown[][]
}

/** 이랜드 내보내기 텍스트 — UTF-8 이 아니면 cp949 로 읽는다 */
function decodeText(buf: Buffer): string {
  const utf = buf.toString('utf-8')
  if (!utf.includes('�')) return utf
  return new TextDecoder('euc-kr').decode(buf)
}

async function postSlack(text: string) {
  const url = process.env.KIMS_SLACK_WEBHOOK_URL || process.env.SLACK_SALES_WEBHOOK_URL
  if (!url) throw new Error('KIMS_SLACK_WEBHOOK_URL / SLACK_SALES_WEBHOOK_URL 없음')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`슬랙 전송 실패 HTTP ${res.status}`)
}

async function main() {
  loadEnv()
  const porFile = opt('--por')
  const allocFile = opt('--alloc')
  const outDir = opt('--out')
  if (!porFile || !allocFile || !outDir) throw new Error('사용법: --por <PORInfo.xlsx> --alloc <CSV_OUTPUT.XLS> --out <폴더> [--stores-json <json>] [--approved PO,…] [--missing-pdf 오더장,할당리스트] [--send]')

  // 출력(전화번호·매입단가가 든 plan.json·엑셀 포함)은 비공개 폴더 아래로만 — 저장소 안에 실수로 쓰지 않게
  const outAbs = path.resolve(expandHome(outDir))
  if (outAbs !== PRIVATE_DIR && !outAbs.startsWith(PRIVATE_DIR + path.sep)) throw new Error(`출력 폴더는 비공개 폴더(${PRIVATE_DIR}) 아래여야 함: ${outAbs}`)
  const names = JSON.parse(fs.readFileSync(path.join(HERE, 'product-names.json'), 'utf-8')) as Record<string, NameEntry>
  // 이랜드가 0건일 때 제목 줄도 없는 빈 파일(0바이트·행 0)을 줄 수 있다 → "발주 없음"으로 처리(필수 열 없음 실패 아님)
  const porBuf = fs.readFileSync(porFile)
  let porRows: unknown[][] = []
  if (porBuf.length > 0) {
    try {
      const wb = XLSX.read(porBuf, { type: 'buffer', raw: true })
      porRows = wb.SheetNames.length ? XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }) : []
    } catch {
      porRows = []
    }
  }
  const por = porRows.length ? parsePor(porRows) : []
  if (!por.length) {
    const msg = '[킴스] 이번 주 발주 없음 — 구매오더 0건(서류 안 만듦)'
    fs.mkdirSync(outAbs, { recursive: true })
    fs.writeFileSync(path.join(outAbs, 'slack.txt'), msg)
    console.log(msg)
    if (flag('--send')) {
      await postSlack(msg)
      console.log('슬랙 보냄')
    }
    return
  }
  const alloc = parseAlloc(decodeText(fs.readFileSync(allocFile)))
  const stores = parseStoreSheet(await readStoreRows())
  const plan = buildPlan({ por, alloc, stores, names })

  fs.mkdirSync(outDir, { recursive: true })
  const fn = fileNames(plan)

  // 진도팜 통합형
  const jr = jindofarmRows(plan, names)
  const jws = XLSX.utils.aoa_to_sheet([JINDOFARM_HEADER, ...jr])
  const jwb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(jwb, jws, 'Sheet1')
  XLSX.writeFile(jwb, path.join(outDir, fn.jindofarm))

  // MD용
  const md = await buildMdWorkbook(fs.readFileSync(path.join(PRIVATE_DIR, 'md_template.xlsx')), plan, por)
  fs.writeFileSync(path.join(outDir, fn.md), md.buf)
  for (const t of md.issues) plan.issues.push({ level: 'check', text: t })

  // 발주 종합 탭 (kims_order_summary 의 주차 탭 양식, 탭 이름 = 납품일 MMDD) — 누적 파일(대표 PC)에 붙여 넣는 용도로 이번 주 탭만 단독 파일로
  const sum = summarySheetAoa(plan)
  for (const t of sum.issues) plan.issues.push({ level: 'check', text: t })
  const sws = XLSX.utils.aoa_to_sheet(sum.aoa as unknown as unknown[][])
  const swb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(swb, sws, plan.dueDate.slice(4, 8))
  const summaryName = `kims_order_summary_${plan.dueDate.slice(4, 8)}.xlsx`
  XLSX.writeFile(swb, path.join(outDir, summaryName))

  // 수량 표 PNG (상품명 · 오더수량 · BOX · 합계)
  const pngName = `kims_qty_${plan.shipDate.slice(4, 8)}.png`
  await sharp(Buffer.from(qtyTableSvg(plan))).png().toFile(path.join(outDir, pngName))

  // 문구 3종 (카톡은 자동 발송 불가 — 대표가 복사해서 보냄)
  fs.writeFileSync(path.join(outDir, 'message_friday_jindofarm.txt'), messageFridayJindofarm(plan))
  fs.writeFileSync(path.join(outDir, 'message_monday_jindofarm.txt'), messageMondayJindofarm(plan))
  fs.writeFileSync(path.join(outDir, 'message_md.txt'), messageMd(plan, fn.md))

  const approved = (opt('--approved') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const missingPdf = (opt('--missing-pdf') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const slack = buildSlack(plan, { approved, missingPdf, dir: outDir })
  const full = [slack, '', '*진도팜 금요일 문구*', '```', messageFridayJindofarm(plan), '```', '*진도팜 월요일 문구*', '```', messageMondayJindofarm(plan), '```', '*민경찬 문구(초안)*', '```', messageMd(plan, fn.md), '```'].join('\n')
  fs.writeFileSync(path.join(outDir, 'slack.txt'), full)
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2))
  console.log(full)
  console.log(`\n파일: ${fn.jindofarm} · ${fn.md} · ${summaryName} · ${pngName} · message_*.txt · slack.txt · plan.json → ${outDir}`)
  if (flag('--send')) {
    await postSlack(full)
    console.log('슬랙 보냄')
  }
}
main().catch(async (e) => {
  const why = e instanceof Error ? e.message : String(e)
  console.error(`실패\t${why}`)
  process.exitCode = 1
  if (flag('--send')) await postSlack(`⚠️ 킴스 서류 만들기 중단: ${why}`).catch(() => undefined)
})
