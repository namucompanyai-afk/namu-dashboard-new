import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import {
  HISTORY_COL_COUNT,
  HISTORY_HEADERS,
  HISTORY_TAB,
  historyKey,
  toSheetRow,
  type HistoryRow,
} from '@/lib/b2b/history'

/**
 * B2B 발주 이력 기록 — 구글시트 쓰기 API.
 *
 * ⚠️ 쓰기는 '발주 이력' 탭에만 한다. 상품마스터·쿠팡 센터 주소록·밀크런 가격표는
 *    이 라우트에서 읽지도 쓰지도 않는다. 아래 range 문자열은 전부 HISTORY_TAB 상수로만
 *    만들고, 탭명을 받는 파라미터는 두지 않는다(외부 입력으로 대상 탭이 바뀔 수 없게).
 *
 * POST body: { rows: HistoryRow[] }
 *   (채널+발주번호+상품) 키가 이미 있으면 그 행을 덮어쓰고(업로드일시 갱신), 없으면 append.
 */

export const runtime = 'nodejs'
export const revalidate = 0

const SHEET_ID = '1nujXWT95QWnYBX1LpSAL1hLL3Uv8MBt7kJDz8i6WbFU'
const MAX_ROWS = 5000 // 한 번에 받는 행 상한(폭주 방지)

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`
const RANGE_ALL = `${quote(HISTORY_TAB)}!A1:J`

function getSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 환경변수가 설정되지 않았습니다.')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

/** KST YYYY-MM-DD HH:mm */
function nowKst(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return kst.toISOString().slice(0, 16).replace('T', ' ')
}

const str = (v: unknown): string => String(v ?? '').trim()
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v) || 0

// 클라이언트 입력을 그대로 믿지 않고 필요한 필드만 추려 정규화
function sanitize(raw: unknown): HistoryRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const channel = str(r.channel)
  if (channel !== '컬리' && channel !== '쿠팡') return null
  const product = str(r.product)
  const poNumber = str(r.poNumber)
  if (!poNumber && !product) return null
  return {
    channel,
    poNumber,
    center: str(r.center),
    dueDate: str(r.dueDate),
    product,
    shipFrom: str(r.shipFrom),
    boxes: numOrNull(r.boxes),
    units: Number(r.units) || 0,
    revenue: Number(r.revenue) || 0,
  }
}

const padRow = (r: unknown[]): (string | number)[] =>
  Array.from({ length: HISTORY_COL_COUNT }, (_, i) => {
    const v = r[i]
    return typeof v === 'number' ? v : String(v ?? '')
  })

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const incoming = (Array.isArray(body?.rows) ? body.rows : [])
      .slice(0, MAX_ROWS)
      .map(sanitize)
      .filter((r: HistoryRow | null): r is HistoryRow => r !== null)

    if (incoming.length === 0) {
      return NextResponse.json({ ok: true, added: 0, updated: 0, total: 0 })
    }

    const sheets = getSheets()

    // 1. 현재 이력 읽기 (헤더 포함)
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: RANGE_ALL,
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    const vals = (cur.data.values as unknown[][]) || []
    const hasHeader = (vals[0] || []).some((v) => String(v ?? '').trim() !== '')
    const data: (string | number)[][] = (hasHeader ? vals.slice(1) : []).map(padRow)

    // 2. (채널+발주번호+상품) → 기존 행 인덱스
    const idx = new Map<string, number>()
    data.forEach((r, i) => {
      const k = historyKey(String(r[1]), String(r[2]), String(r[5]))
      if (k) idx.set(k, i)
    })

    // 3. 있으면 덮어쓰기, 없으면 append
    const uploadedAt = nowKst()
    let added = 0
    let updated = 0
    for (const row of incoming) {
      const line = toSheetRow(row, uploadedAt)
      const k = historyKey(row.channel, row.poNumber, row.product)
      const at = idx.get(k)
      if (at !== undefined) {
        data[at] = line
        updated++
      } else {
        idx.set(k, data.length)
        data.push(line)
        added++
      }
    }

    // 4. 헤더 + 전체 행 1회 기록 (헤더는 매번 보장 → 최초 1회 자동 기록과 동일 효과)
    const out = [[...HISTORY_HEADERS], ...data]
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${quote(HISTORY_TAB)}!A1:J${out.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: out },
    })

    return NextResponse.json({ ok: true, added, updated, total: data.length })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '서버 오류'
    console.error('[b2b/history] write error:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
