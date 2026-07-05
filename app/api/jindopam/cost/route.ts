import { NextResponse } from 'next/server'
import { google } from 'googleapis'

/**
 * 진도팜 원가표 write API (서비스 계정)
 *
 * 진도팜/나무 담당자는 대시보드 계정만 사용하고 구글시트를 직접 열지 않는다.
 * read 는 클라이언트가 API 키(NEXT_PUBLIC_GSHEET_API_KEY)로 직접 하고,
 * write(수정/신규)만 이 라우트가 서비스 계정으로 처리한다.
 *
 * 액션(POST body.action):
 *   - 'init'   : 변동로그 탭 헤더(R4) 세팅 (최초 1회, 멱등)
 *   - 'update' : 기존 원료 셀 수정 + 변동로그 append
 *   - 'create' : 신규 원료 행 추가 (자동수식 열 A/H/I 보존)
 *
 * 자동수식 열: A 원료ID · H 작업비 · I 공급가 → 대시보드는 값 안 넣음(수식 유지).
 */

export const runtime = 'nodejs'
export const revalidate = 0

const SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg'
const COST_TAB = '진도팜 원가표'
const LOG_TAB = '단가 변동 로그'
const HEADER_ROW = 4 // R4 헤더, R5~ 데이터

const LOG_HEADERS = [
  '일시',
  '원료ID',
  '구분',
  '품목',
  '변경 전',
  '변경 후',
  '적용 시작일',
  '변경자',
]

// 서비스 계정 → sheets 클라이언트
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

// 원료ID = 구분_품목(_품종)
const makeRawId = (gubun: string, item: string, variety: string) =>
  [gubun, item, variety].filter((s) => (s || '').trim() !== '').join('_')

// KST YYYY-MM-DD HH:mm
function nowKst(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return kst.toISOString().slice(0, 16).replace('T', ' ')
}

// 셀 참조 행번호 치환: from행 수식을 to행으로 (예: =B5&"_"&C5 → =B6&"_"&C6)
function bumpFormula(f: unknown, from: number, to: number): string | null {
  if (typeof f !== 'string' || !f.startsWith('=')) return null
  return f.replace(new RegExp('([A-Z]{1,3}\\$?)' + from + '(?![0-9])', 'g'), `$1${to}`)
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const action = body?.action as string
    const sheets = getSheets()

    // ── 변동로그 헤더 세팅 (멱등) ────────────────────────────────
    if (action === 'init') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(LOG_TAB)}!A${HEADER_ROW}:H${HEADER_ROW}`,
        valueInputOption: 'RAW',
        requestBody: { values: [LOG_HEADERS] },
      })
      return NextResponse.json({ ok: true, message: '변동로그 헤더 세팅 완료' })
    }

    // ── 기존 원료 수정 ────────────────────────────────────────────
    if (action === 'update') {
      const { gubun, item, variety, field, oldValue, newValue, applyFrom, role } = body
      if (!gubun || !item || !field) {
        return NextResponse.json({ ok: false, error: '필수 값 누락(구분/품목/필드)' }, { status: 400 })
      }

      // 대상 행 탐색 (구분+품목+품종 일치)
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A${HEADER_ROW}:K`,
      })
      const vals = cur.data.values || []
      let targetRow = -1
      for (let i = 1; i < vals.length; i++) {
        const r = vals[i] || []
        if (
          (r[1] || '').trim() === String(gubun).trim() &&
          (r[2] || '').trim() === String(item).trim() &&
          (r[3] || '').trim() === String(variety || '').trim()
        ) {
          targetRow = HEADER_ROW + i
          break
        }
      }
      if (targetRow === -1) {
        return NextResponse.json({ ok: false, error: '대상 원료 행을 찾지 못했습니다.' }, { status: 404 })
      }

      // 원곡가(E열)만 수정 지원
      if (field !== '원곡가') {
        return NextResponse.json({ ok: false, error: `지원하지 않는 필드: ${field}` }, { status: 400 })
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!E${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[newValue]] },
      })

      // 변동로그 append
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${quote(LOG_TAB)}!A:H`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [
            [
              nowKst(),
              makeRawId(gubun, item, variety || ''),
              gubun,
              item,
              oldValue ?? '',
              newValue ?? '',
              applyFrom || '',
              role || '',
            ],
          ],
        },
      })

      return NextResponse.json({ ok: true, row: targetRow })
    }

    // ── 신규 원료 추가 ────────────────────────────────────────────
    if (action === 'create') {
      const { gubun, item, variety, wongok, tax } = body
      if (!gubun || !item) {
        return NextResponse.json({ ok: false, error: '필수 값 누락(구분/품목)' }, { status: 400 })
      }
      // 포장형태(F)는 모달에서 제거됨 → 작업비 자동수식 유지를 위해 '소포장' 기본 기록
      const pack = '소포장'

      // 수식 보존을 위해 마지막 실데이터 행의 A/H/I 수식을 읽어 다음 행으로 bump
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A${HEADER_ROW}:K`,
        valueRenderOption: 'FORMULA',
      })
      const vals = cur.data.values || []
      let lastFilled = HEADER_ROW
      let lastIdx = 0
      for (let i = 1; i < vals.length; i++) {
        if ((String(vals[i]?.[2] ?? '')).trim() !== '') {
          lastFilled = HEADER_ROW + i
          lastIdx = i
        }
      }
      const newRow = lastFilled + 1

      const srcA = lastIdx > 0 ? vals[lastIdx]?.[0] : undefined
      const srcH = lastIdx > 0 ? vals[lastIdx]?.[7] : undefined
      const srcI = lastIdx > 0 ? vals[lastIdx]?.[8] : undefined
      const fA = bumpFormula(srcA, lastFilled, newRow)
      const fH = bumpFormula(srcH, lastFilled, newRow)
      const fI = bumpFormula(srcI, lastFilled, newRow)

      const data: { range: string; values: any[][] }[] = [
        // B~F: 구분·품목·품종·원곡가·포장형태
        {
          range: `${quote(COST_TAB)}!B${newRow}:F${newRow}`,
          values: [[gubun, item, variety || '', wongok ?? '', pack || '']],
        },
        // J~K: 과세여부 · 취급상태(빈칸 → 나무가 시트에서 직접 O/X 기입)
        {
          range: `${quote(COST_TAB)}!J${newRow}:K${newRow}`,
          values: [[tax || '', '']],
        },
      ]
      // 자동수식 열은 이전 행 수식이 있을 때만 복사(없으면 시트 ARRAYFORMULA 등에 위임)
      if (fA) data.push({ range: `${quote(COST_TAB)}!A${newRow}`, values: [[fA]] })
      if (fH) data.push({ range: `${quote(COST_TAB)}!H${newRow}`, values: [[fH]] })
      if (fI) data.push({ range: `${quote(COST_TAB)}!I${newRow}`, values: [[fI]] })

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      })

      return NextResponse.json({ ok: true, row: newRow, rawId: makeRawId(gubun, item, variety || '') })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (e: any) {
    console.error('[jindopam/cost] write error:', e?.message || e)
    return NextResponse.json({ ok: false, error: e?.message || '서버 오류' }, { status: 500 })
  }
}
