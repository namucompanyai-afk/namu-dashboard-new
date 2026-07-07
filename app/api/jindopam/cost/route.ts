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

    // ── 원가표 원곡가 중심 재구성 (수동 1회) ─────────────────────
    // 헤더 A~G: 원료ID·구분·품목·품종·1kg당 원곡가·과세여부·취급상태
    // 기존 J(과세)·K(취급) → 새 F·G로 이전, 구 F~I(포장/작업비직접/작업비/공급가) 및 J·K 잔여 클리어
    // 우측: 구 포장형태 기준표 제거 후 작업비 단가표(M4 제목, 소포장 800 / 벌크 450) 배치
    if (action === 'init2') {
      // 0. 기존 데이터 읽기 (과세=idx9 / 취급=idx10 이전용). 원곡가(E)는 손대지 않음
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A5:K`,
      })
      const vals = cur.data.values || []
      const n = vals.length
      const lastRow = HEADER_ROW + n // 4 + n
      const fg = vals.map((r) => [r?.[9] ?? '', r?.[10] ?? '']) // [과세, 취급]

      // 1. 새 헤더 (R4)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A4:G4`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['원료ID', '구분', '품목', '품종', '1kg당 원곡가', '과세여부', '취급상태']],
        },
      })

      // 2. 값 이전 먼저: 구 J(과세)·K(취급) → 새 F·G
      if (n > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${quote(COST_TAB)}!F5:G${lastRow}`,
          valueInputOption: 'RAW',
          requestBody: { values: fg },
        })
        // 3. 잔여열 클리어 나중: 구 H(작업비)·I(공급가)·J·K
        await sheets.spreadsheets.values.clear({
          spreadsheetId: SHEET_ID,
          range: `${quote(COST_TAB)}!H5:K${lastRow}`,
          requestBody: {},
        })
      }

      // 4. 우측 구 기준표 제거 → 작업비 단가표 배치
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!M4:R100`,
        requestBody: {},
      })
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!M4:N6`,
        valueInputOption: 'RAW',
        requestBody: { values: [['작업비 단가', ''], ['소포장', 800], ['벌크', 450]] },
      })

      return NextResponse.json({ ok: true, message: `원가표 재구성 완료 (데이터 ${n}행)` })
    }

    // ── 원가표 잔재 정리(원곡가 중심 정돈) + F·G 데이터검증 재설정 (수동 1회) ─────
    // 목표: 헤더 A~G / 데이터 A~G 보존(E 원곡가 불변) / H열 이후 잔재 전부 제거 /
    //       우측 M·N 작업비 단가표 보존 / F열 검증 과세·면세, G열 검증 O·X
    if (action === 'init3') {
      const LAST = 1000 // 데이터 정리 하한 행

      // 1. 헤더 A~G 보장(멱등)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A4:G4`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['원료ID', '구분', '품목', '품종', '1kg당 원곡가', '과세여부', '취급상태']],
        },
      })

      // 2. H:L 잔재(값·수식·#REF!) 클리어 — M·N 작업비 단가표는 보존(제외)
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!H4:L${LAST}`,
        requestBody: {},
      })

      // 3. 우측 작업비 단가표 보장(멱등) — 소포장 800 / 벌크 450
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!M4:N6`,
        valueInputOption: 'RAW',
        requestBody: { values: [['작업비 단가', ''], ['소포장', 800], ['벌크', 450]] },
      })

      // 4. 데이터검증 재설정 — 탭의 숫자 sheetId 필요
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const sheetId = meta.data.sheets?.find(
        (s) => s.properties?.title === COST_TAB,
      )?.properties?.sheetId
      if (sheetId == null) {
        return NextResponse.json(
          { ok: false, error: `탭 '${COST_TAB}' sheetId를 찾지 못했습니다.` },
          { status: 500 },
        )
      }

      // 데이터 영역 F5:F, G5:G (0-based: row5→4, F열→5, G열→6)
      const listRule = (values: string[]) => ({
        condition: {
          type: 'ONE_OF_LIST',
          values: values.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false,
      })
      const gridF = { sheetId, startRowIndex: 4, endRowIndex: LAST, startColumnIndex: 5, endColumnIndex: 6 }
      const gridG = { sheetId, startRowIndex: 4, endRowIndex: LAST, startColumnIndex: 6, endColumnIndex: 7 }
      const gridHL = { sheetId, startRowIndex: 4, endRowIndex: LAST, startColumnIndex: 7, endColumnIndex: 12 }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [
            // 옛 소포장/벌크 등 잔여 검증 제거(H:L)
            { setDataValidation: { range: gridHL } },
            // F열: 과세/면세 (옛 소포장/벌크 규칙 덮어씀)
            { setDataValidation: { range: gridF, rule: listRule(['과세', '면세']) } },
            // G열: O/X
            { setDataValidation: { range: gridG, rule: listRule(['O', 'X']) } },
          ],
        },
      })

      return NextResponse.json({
        ok: true,
        message: '원가표 정리 완료(H이후 클리어·F 과세/면세·G O/X 검증 재설정, M·N 단가표 보존)',
      })
    }

    // ── 가공비·배송비 참고 기준표 배치 (수동 1회) ─────────────────
    // 우측 옛 M/N 작업비 단가표 제거 후 P~R에 가공비/배송비 기준표 배치.
    // 원곡 데이터(A:G)·원곡가는 건드리지 않음.
    if (action === 'init4') {
      // 1. 우측 구 단가표 영역 클리어 (M~R)
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!M4:R100`,
        requestBody: {},
      })

      // 2. 가공비 블록 P4:Q9 · 배송비 블록 P11:R14 (행 오프셋 고정 → 클라 read가 이 배치 가정)
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: `${quote(COST_TAB)}!P4:Q9`,
              values: [
                ['가공비', '단가'],
                ['작업비(소포장)', 800],
                ['작업비(벌크)', 450],
                ['파쇄비', 600],
                ['혼합비(5곡까지)', 350],
                ['혼합비(추가1곡당)', 70],
              ],
            },
            {
              range: `${quote(COST_TAB)}!P11:R14`,
              values: [
                ['규격', '박스', '택배'],
                ['소', 371, 2100],
                ['중', 1123, 2800],
                ['대', 1300, 4400],
              ],
            },
          ],
        },
      })

      return NextResponse.json({
        ok: true,
        message: '가공비·배송비 참고표 배치 완료 (가공비 P4:Q9 · 배송비 P11:R14)',
      })
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
        range: `${quote(COST_TAB)}!A${HEADER_ROW}:G`,
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

      // 원료ID 자동수식(A열) 보존을 위해 마지막 실데이터 행 수식을 읽어 다음 행으로 bump
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A${HEADER_ROW}:G`,
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
      const fA = bumpFormula(lastIdx > 0 ? vals[lastIdx]?.[0] : undefined, lastFilled, newRow)

      const data: { range: string; values: any[][] }[] = [
        // B~F: 구분·품목·품종·원곡가·과세여부 (G 취급상태는 빈칸 → 나무가 시트에서 직접 기입)
        {
          range: `${quote(COST_TAB)}!B${newRow}:F${newRow}`,
          values: [[gubun, item, variety || '', wongok ?? '', tax || '']],
        },
      ]
      // 원료ID 자동수식은 이전 행 수식이 있을 때만 복사(없으면 시트 ARRAYFORMULA 등에 위임)
      if (fA) data.push({ range: `${quote(COST_TAB)}!A${newRow}`, values: [[fA]] })

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
