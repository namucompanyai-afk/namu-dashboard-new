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
const REFLOG_TAB = '가공비 변동 로그' // 가공비·배송비 참고표 변동 (원료용 LOG_TAB과 별개)
const HEADER_ROW = 11 // R11 헤더, R12~ 데이터 (init12 레이아웃: 상단 참고표 A1:F8)

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

const REFLOG_HEADERS = ['일시', '종류', '항목', '변경 전', '변경 후', '적용 시작일', '변경자']

// 참고표 항목명 → 셀 (init12 배치: 가공비 A2:B8 · 배송비 D2:F4)
const REF_COST_CELL: Record<string, string> = {
  '작업비(소포장)': 'B2',
  '작업비(벌크)': 'B3',
  파쇄비: 'B4',
  제분비: 'B5',
  '혼합비(5곡까지)': 'B6',
  '혼합비(추가1곡당)': 'B7',
  물류대행비: 'B8',
}
const REF_SHIP_CELL: Record<string, string> = {
  '박스(소)': 'E2',
  '택배(소)': 'F2',
  '박스(중)': 'E3',
  '택배(중)': 'F3',
  '박스(대)': 'E4',
  '택배(대)': 'F4',
}

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

// 슬랙 알림 (#거래처-관련-진도팜) — 부가 기능. URL 없거나 실패해도 저장에 영향 없음
async function notifySlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch (e) {
    console.error('[jindopam/cost] slack 알림 실패(무시):', (e as any)?.message || e)
  }
}

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

    // ── 참고표 J열 이동 (수동 1회) ────────────────────────────────
    // P4:R14(옛 위치) → J4:L14. H·I열·원곡 데이터(A:G)는 건드리지 않음.
    if (action === 'init5') {
      // 1. 새 위치 J4:K9(가공비) · J11:L14(배송비)
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: `${quote(COST_TAB)}!J4:K9`,
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
              range: `${quote(COST_TAB)}!J11:L14`,
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
      // 2. 옛 위치 P4:R14 클리어
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!P4:R100`,
        requestBody: {},
      })

      return NextResponse.json({
        ok: true,
        message: '참고표 J열 이동 완료 (가공비 J4:K9 · 배송비 J11:L14, 옛 P:R 클리어)',
      })
    }

    // ── 가공비 변동 로그 탭 신설/헤더 세팅 (수동 1회) ─────────────
    if (action === 'init6') {
      // 탭 없으면 생성
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        fields: 'sheets(properties(title))',
      })
      const exists = meta.data.sheets?.some((s) => s.properties?.title === REFLOG_TAB)
      if (!exists) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: REFLOG_TAB } } }] },
        })
      }
      // 헤더 R4 보장 (기존 데이터 보존)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(REFLOG_TAB)}!A${HEADER_ROW}:G${HEADER_ROW}`,
        valueInputOption: 'RAW',
        requestBody: { values: [REFLOG_HEADERS] },
      })
      return NextResponse.json({
        ok: true,
        message: exists ? '가공비 변동 로그 헤더 보장' : '가공비 변동 로그 탭 생성+헤더 세팅',
      })
    }

    // ── 참고표 재배치: 가공비 6항목(제분비 추가) + 배송비 한 행 아래로 (수동 1회) ─
    // 가공비 J4:K10 / 배송비 J12:L15. H·I열·원곡 데이터(A:G)는 건드리지 않음.
    if (action === 'init7') {
      // 1. 기존 J열 참고표 영역 클리어
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!J4:L100`,
        requestBody: {},
      })
      // 2. 새 배치 (가공비 6항목·배송비 3규격)
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: `${quote(COST_TAB)}!J4:K10`,
              values: [
                ['가공비', '단가'],
                ['작업비(소포장)', 800],
                ['작업비(벌크)', 450],
                ['파쇄비', 600],
                ['제분비', 1000],
                ['혼합비(5곡까지)', 350],
                ['혼합비(추가1곡당)', 70],
              ],
            },
            {
              range: `${quote(COST_TAB)}!J12:L15`,
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
        message: '참고표 재배치 완료 (가공비 J4:K10 6항목·제분비 추가 · 배송비 J12:L15)',
      })
    }

    // ── 가공옵션 컬럼(H·I·J) 신설 + 참고표 J:L → N:P 이동 (수동 1회) ─────
    // 데이터 우측에 파쇄(H)/제분(I)/혼합곡수(J) 3열을 붙이기 위해,
    // J:L을 점유하던 참고표를 N:P로 옮긴다. 참고표 현재 단가(수정분)는 읽어서 보존.
    // 원곡 데이터(A:G)·기존 34행 값은 건드리지 않음(H:J는 빈칸 → 파쇄X/제분X/곡수0).
    if (action === 'init8') {
      // 1. 현재 참고표 J4:L15 먼저 읽기 (H:J 헤더 쓰기 전에 — J4가 참고표 '가공비' 헤더이므로 순서 중요)
      const refCur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!J4:L15`,
      })
      const rv = refCur.data.values || []

      // 2. 참고표 N4:P15로 이동 (수정된 단가 그대로 보존)
      if (rv.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${quote(COST_TAB)}!N4:P15`,
          valueInputOption: 'RAW',
          requestBody: { values: rv },
        })
      }

      // 3. 옛 참고표 J:L 클리어
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!J4:L100`,
        requestBody: {},
      })

      // 4. 데이터 헤더 H4:J4 (파쇄/제분/혼합곡수) — 클리어 뒤 마지막에
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!H4:J4`,
        valueInputOption: 'RAW',
        requestBody: { values: [['파쇄', '제분', '혼합곡수']] },
      })

      return NextResponse.json({
        ok: true,
        message: '가공옵션 컬럼(H:J) 추가 · 참고표 J:L→N:P 이동 완료',
      })
    }

    // ── init8 헤더 보정 (버그 있던 최초 init8 실행분 정정 · 수동 1회) ──
    // 최초 init8이 H:J 쓰기→참고표 읽기 순서 탓에 J4(혼합곡수)·N4(가공비) 헤더가 깨졌던 것 정정.
    if (action === 'init9') {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(COST_TAB)}!J4`, values: [['혼합곡수']] },
            { range: `${quote(COST_TAB)}!N4`, values: [['가공비']] },
          ],
        },
      })
      return NextResponse.json({ ok: true, message: 'J4=혼합곡수 · N4=가공비 헤더 보정 완료' })
    }

    // ── 참고표 항목단위 수정 + '가공비 변동 로그' append ──────────
    // body: { kind('cost'|'ship'), item, oldValue, newValue, applyFrom, editor }
    if (action === 'update-ref') {
      const { kind, item, oldValue, newValue, applyFrom, editor } = body
      const cell =
        kind === 'cost' ? REF_COST_CELL[item] : kind === 'ship' ? REF_SHIP_CELL[item] : undefined
      if (!cell) {
        return NextResponse.json(
          { ok: false, error: `알 수 없는 항목(kind=${kind}, item=${item})` },
          { status: 400 },
        )
      }

      // 해당 셀 하나만 update
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!${cell}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[newValue]] },
      })

      // 가공비 변동 로그 append (원료용 LOG_TAB과 별개)
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${quote(REFLOG_TAB)}!A:G`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [
            [
              nowKst(),
              kind === 'cost' ? '가공비' : '배송비',
              item,
              oldValue ?? '',
              newValue ?? '',
              applyFrom || '',
              editor || '',
            ],
          ],
        },
      })

      // 슬랙 알림 (저장 성공 후 · 실패 무시)
      if (kind === 'cost') {
        await notifySlack(
          `가공비 변경\n항목: ${item}\n${oldValue ?? ''} → ${newValue ?? ''}\n변경자: ${editor || ''} · 적용일: ${applyFrom || ''}`,
        )
      } else {
        // 배송비 item 예: '박스(소)' → 규격/필드 분해
        const m = /^(박스|택배)\((소|중|대)\)$/.exec(String(item))
        const seg = m ? `${m[2]} · ${m[1]}` : item
        await notifySlack(
          `배송비 변경\n${seg}\n${oldValue ?? ''} → ${newValue ?? ''}\n변경자: ${editor || ''} · 적용일: ${applyFrom || ''}`,
        )
      }

      return NextResponse.json({ ok: true, message: `${item} 수정 완료` })
    }

    // ── H:M 서식/테두리 정리 (옛 참고표 J:L 잔여 박스·헤더 제거 · 수동 1회) ──
    // init8이 J:L 값만 클리어하고 테두리/배경 서식은 남겨 '빈 박스 블록'이 남음.
    // 값은 보존(userEnteredFormat만 클리어)하고 병합 해제. N열 이후 참고표·E 원곡가는 손대지 않음.
    if (action === 'init10') {
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
      // H~M(0-based 7~12, endCol 13 → N 제외) · 행4~200(0-based 3~200)
      const gridHM = { sheetId, startRowIndex: 3, endRowIndex: 200, startColumnIndex: 7, endColumnIndex: 13 }
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [
            // 1. 영역 내 병합 해제 (빈 박스 블록이 병합셀일 수 있음)
            { unmergeCells: { range: gridHM } },
            // 2. 서식(테두리·배경 등) 초기화 — 값은 건드리지 않음
            { repeatCell: { range: gridHM, cell: {}, fields: 'userEnteredFormat' } },
          ],
        },
      })
      // 3. 헤더 H4:J4 재보장 (멱등)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!H4:J4`,
        valueInputOption: 'RAW',
        requestBody: { values: [['파쇄', '제분', '혼합곡수']] },
      })
      return NextResponse.json({ ok: true, message: 'H:M 서식/병합 정리 완료 · H4:J4 헤더 보장' })
    }

    // ── 물류대행비 항목 추가 (참고표 N11/O11 · 수동 1회) ──────────────
    // 옛 빈 구분행(N11)에 '물류대행비' 라벨 + 단가 500. 기존 단가·위치는 건드리지 않음.
    // 이미 단가가 입력돼 있으면(수정분) 보존하고 라벨만 보장.
    if (action === 'init11') {
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!N11:O11`,
      })
      const row = cur.data.values?.[0] || []
      const curVal = (row[1] ?? '').toString().trim()
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!N11:O11`,
        valueInputOption: 'RAW',
        requestBody: { values: [['물류대행비', curVal === '' ? 500 : row[1]]] },
      })
      return NextResponse.json({
        ok: true,
        message: `물류대행비 항목 세팅 완료 (단가 ${curVal === '' ? 500 : row[1]})`,
      })
    }

    // ── 레이아웃 이동 (참고표 N:P → 좌상단 A:F, 마스터 R4→R11 · 수동 1회) ──
    // 옛 배치(상단 안내문 + 마스터 A4:J + 참고표 N:P)의 모든 값을 새 배치로 무손실 이동.
    // 가공비 A1:B8 / 배송비 D1:F4 / 마스터 헤더 A11:J11 · 데이터 A12:J. A열 원료ID 수식은 +7행 bump.
    if (action === 'init12') {
      // 0. 라이브 백업 읽기 (참고표=UNFORMATTED 정확값, 마스터 값 + A 수식)
      const refRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!N4:P15`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const rb = refRes.data.values || []
      const mdRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A4:J`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const md = mdRes.data.values || []
      const faRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A4:A`,
        valueRenderOption: 'FORMULA',
      })
      const fa = faRes.data.values || []
      const cell = (r: any[] | undefined, c: number) => (r && r[c] !== undefined ? r[c] : '')

      // 1. 가공비 A1:B8 (헤더 + 7항목, 현재 값 그대로 보존)
      const gongbi = [
        [cell(rb[0], 0) || '가공비', cell(rb[0], 1) || '단가'],
        ...[1, 2, 3, 4, 5, 6, 7].map((k) => [cell(rb[k], 0), cell(rb[k], 1)]),
      ]
      // 2. 배송비 D1:F4 (헤더 rb[8] + 소/중/대 rb[9..11])
      const shipRows = [8, 9, 10, 11].map((k) => [cell(rb[k], 0), cell(rb[k], 1), cell(rb[k], 2)])
      // 3. 마스터 헤더
      const masterHeader = [
        '원료ID', '구분', '품목', '품종', '1kg당 원곡가', '과세여부', '취급상태', '파쇄', '제분', '혼합곡수',
      ]
      // 4. 마스터 데이터 이동 (품목 non-empty만 · A 수식 oldRow→newRow bump)
      const dataRows: any[][] = []
      let kept = 0
      for (let j = 1; j < md.length; j++) {
        const row = md[j] || []
        if (String(row[2] ?? '').trim() === '') continue
        const oldRow = 4 + j
        const newRow = 12 + kept
        kept++
        const aF = bumpFormula(cell(fa[j], 0), oldRow, newRow)
        const aVal = aF != null ? aF : cell(md[j], 0) || ''
        const rest: any[] = []
        for (let c = 1; c <= 9; c++) rest.push(cell(row, c))
        dataRows.push([aVal, ...rest])
      }
      const lastRow = 11 + dataRows.length

      // 5. 작업영역 값 클리어 → 새 배치 기록 (참고표 RAW 정확보존 · 마스터 USER_ENTERED 수식평가)
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!A1:P60`,
        requestBody: {},
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(COST_TAB)}!A1:B8`, values: gongbi },
            { range: `${quote(COST_TAB)}!D1:F4`, values: shipRows },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(COST_TAB)}!A11:J11`, values: [masterHeader] },
            { range: `${quote(COST_TAB)}!A12:J${lastRow}`, values: dataRows },
          ],
        },
      })

      // 6. 옛 참고표(N:P) 잔여 서식/병합 정리 (값은 이미 클리어됨)
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const sheetId = meta.data.sheets?.find((s) => s.properties?.title === COST_TAB)?.properties
        ?.sheetId
      if (sheetId != null) {
        const gridNP = { sheetId, startRowIndex: 0, endRowIndex: 60, startColumnIndex: 13, endColumnIndex: 16 }
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [
              { unmergeCells: { range: gridNP } },
              { repeatCell: { range: gridNP, cell: {}, fields: 'userEnteredFormat' } },
            ],
          },
        })
      }

      return NextResponse.json({
        ok: true,
        message: `레이아웃 이동 완료 (가공비 A1:B8 · 배송비 D1:F4 · 마스터 A11:J${lastRow}, 데이터 ${dataRows.length}행)`,
        moved: dataRows.length,
      })
    }

    // ── 기존 원료 가공옵션(파쇄/제분/혼합곡수) 수정 ────────────────
    // body: { gubun, item, variety, crush, mill, blend, oldCrush, oldMill, oldBlend, applyFrom, role }
    if (action === 'update-proc') {
      const { gubun, item, variety, crush, mill, blend, oldCrush, oldMill, oldBlend, applyFrom, role } =
        body
      if (!gubun || !item) {
        return NextResponse.json({ ok: false, error: '필수 값 누락(구분/품목)' }, { status: 400 })
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

      // H~J 갱신 (파쇄/제분/혼합곡수)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${quote(COST_TAB)}!H${targetRow}:J${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[crush ? 'O' : 'X', mill ? 'O' : 'X', Number(blend) || 0]] },
      })

      const summary = (c: boolean, m: boolean, b: number) =>
        `파쇄${c ? 'O' : 'X'}·제분${m ? 'O' : 'X'}·${Number(b) || 0}곡`

      // 변동로그 append (원곡가와 동일 로그탭, 변경전/후에 가공옵션 요약)
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
              summary(!!oldCrush, !!oldMill, oldBlend),
              summary(!!crush, !!mill, blend),
              applyFrom || '',
              role || '',
            ],
          ],
        },
      })

      await notifySlack(
        `원가표 · 가공옵션 변경\n품목: ${gubun} ${item}\n${summary(!!oldCrush, !!oldMill, oldBlend)} → ${summary(!!crush, !!mill, blend)}\n변경자: ${role || ''} · 적용일: ${applyFrom || ''}`,
      )

      return NextResponse.json({ ok: true, row: targetRow })
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

      // 슬랙 알림 (저장 성공 후 · 실패 무시)
      await notifySlack(
        `원가표 · 원곡가 변경\n품목: ${gubun} ${item}\n${oldValue ?? ''} → ${newValue ?? ''}\n변경자: ${role || ''} · 적용일: ${applyFrom || ''}`,
      )

      return NextResponse.json({ ok: true, row: targetRow })
    }

    // ── 신규 원료 추가 ────────────────────────────────────────────
    if (action === 'create') {
      const { gubun, item, variety, wongok, tax, crush, mill, blend } = body
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
        // H~J: 파쇄·제분·혼합곡수 (가공옵션)
        {
          range: `${quote(COST_TAB)}!H${newRow}:J${newRow}`,
          values: [[crush ? 'O' : 'X', mill ? 'O' : 'X', Number(blend) || 0]],
        },
      ]
      // 원료ID 자동수식은 이전 행 수식이 있을 때만 복사(없으면 시트 ARRAYFORMULA 등에 위임)
      if (fA) data.push({ range: `${quote(COST_TAB)}!A${newRow}`, values: [[fA]] })

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      })

      // 슬랙 알림 (저장 성공 후 · 실패 무시)
      await notifySlack(
        `원가표 · 신규 원료 추가\n${gubun} ${item} · 원곡가 ${wongok ?? ''}\n등록: ${body?.role || ''}`,
      )

      return NextResponse.json({ ok: true, row: newRow, rawId: makeRawId(gubun, item, variety || '') })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (e: any) {
    console.error('[jindopam/cost] write error:', e?.message || e)
    return NextResponse.json({ ok: false, error: e?.message || '서버 오류' }, { status: 500 })
  }
}
