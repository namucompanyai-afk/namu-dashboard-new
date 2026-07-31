import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import aliasData from './alias-data.json'
import mappingData from './mapping-data.json'

/**
 * 나무_마진리빌드 구글시트 초기 세팅 API (서비스 계정 · 일회성)
 *
 * 서비스 계정 자격증명이 Vercel 환경변수(Sensitive)에만 있어 로컬 스크립트 실행이 불가능하다.
 * 그래서 진도팜 원가표 route 의 initN 액션 패턴을 그대로 따라 배포 후 1회 호출하는 라우트로 만든다.
 *
 * 액션(GET ?action=):
 *   - 'init1' : 탭 5개 생성 + 별칭원장/발주매핑 이관 + 원가표미러 IMPORTRANGE + 비용DB·채널DB 헤더
 *
 * 인증: Authorization: Bearer $CRON_SECRET  또는  ?secret=$CRON_SECRET
 *
 * 절대 주의: 원가표 시트(COST_SHEET_ID)에는 어떤 write 도 하지 않는다.
 *           모든 write 호출의 spreadsheetId 는 TARGET_SHEET_ID 로 고정이며,
 *           COST_SHEET_ID 는 IMPORTRANGE 수식 문자열 안에만 등장한다.
 */

export const runtime = 'nodejs'
export const revalidate = 0
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TARGET_SHEET_ID = '1lHJUcKDmB770PZjjJYRzYOEm1z7GD-3S8FCRys05ukA'
const COST_SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg' // 읽기 전용 · write 금지
const IMPORT_RANGE = '진도팜 원가표!A1:P200'

const TABS = ['별칭원장', '발주매핑', '원가표미러', '비용DB', '채널DB']
const PRICE_TAB = '단가DB'

// 단가DB 헤더 (A~K)
const PRICE_HEADER = [
  '별칭',
  '브랜드',
  '발송거래처',
  '취급상태',
  '원료ID',
  '원곡가',
  '소포장 공급가',
  '벌크 공급가',
  '매입가',
  '과세여부',
  '비고',
]
// 미러에서 VLOOKUP 으로 끌어올 원가표 컬럼명 (인덱스는 런타임에 헤더로 해석 · 하드코딩 안 함)
const COL_WONGOK = '1kg당 원곡가'
const COL_SUPPLY = '최종 공급가'
const COL_TAX = '과세여부'
// 미러 참조 범위 (원가표 헤더 R11 → 데이터 R12~)
const MIRROR_RANGE = `'원가표미러'!$A$11:$P$200`
// 별칭원장 초안 상태값 중 '원가 자체가 없어 매입가 수기 입력이 필요한' 상태
const STATUS_NO_COST = '원가없음(매입가 입력 필요)'

// ── init3: 단가DB 파생형 ────────────────────────────────────────
const PRICE_HEADER_V2 = [
  '별칭',
  '브랜드',
  '발송거래처',
  '취급상태',
  '원료ID',
  'g',
  '원곡가',
  '소포장 공급가',
  '벌크 공급가',
  '매입가',
  '과세여부',
  '비고',
]
const MAP_TAB = '발주매핑'
// 미러 데이터부 (헤더 R11 제외한 R12~)
const MIRROR_DATA = `'원가표미러'!$A$12:$P$200`
const MIRROR_ID_RANGE = `='원가표미러'!$A$12:$A$200`
const PRICE_ALIAS_RANGE = `='단가DB'!$A$2:$A$169`
// 미러에서 끌어올 나머지 컬럼명 (인덱스는 런타임 헤더 해석)
const COL_CRUSH = '파쇄비'
const COL_MILL = '제분비'
const COL_BLEND = '혼합비'
const COL_LOGI = '물류대행비'
// 미러 상단 가공비표 항목명 (셀 위치도 런타임에 A열 라벨로 찾는다)
const REF_LABOR_SMALL = '작업비(소포장)'
const REF_LABOR_BULK = '작업비(벌크)'

// 별칭 끝 용량 → g. 끝에서 못 찾으면 문자열 안에 용량 토큰이 "딱 하나"일 때만 그것을 쓴다.
// (예: '[쌀쌀쌀] 저속노화 잡곡 1kg 캐귀리' — 용량이 끝이 아니지만 모호하지 않음)
const CAP_END = /([0-9]+(?:\.[0-9]+)?)\s*(kg|g)\s*$/i
const CAP_ANY = /([0-9]+(?:\.[0-9]+)?)\s*(kg|g)(?![a-zA-Z가-힣0-9])/gi
// 원료ID 자체가 봉 단위로 값이 매겨진 것(원료ID 텍스트에 용량 포함) — 예: 관행_백미 10kg_새청무
const BAG_PRICED = /[0-9]+(?:\.[0-9]+)?\s*(kg|g)(?![a-zA-Z가-힣0-9])/i

function toGram(numText: string, unit: string): number {
  return Math.round(parseFloat(numText) * (unit.toLowerCase() === 'kg' ? 1000 : 1))
}
function parseGram(aliasText: string): number | '' {
  const t = aliasText.trim()
  const end = CAP_END.exec(t)
  if (end) return toGram(end[1], end[2])
  const all = t.match(CAP_ANY)
  if (all && all.length === 1) {
    const m = /([0-9]+(?:\.[0-9]+)?)\s*(kg|g)/i.exec(all[0])
    if (m) return toGram(m[1], m[2])
  }
  return ''
}

// 별칭원장 상태 → 배경색 (초안 xlsx 실측: 확정=흰색 / 병합=노랑 / 구DB신규=파랑 / 원가없음=빨강)
const STATUS_BG: Record<string, string> = {
  '병합(검수)': 'FFF3CD',
  구DB신규: 'E8F0FE',
  '원가없음(매입가 입력 필요)': 'FDECEA',
}
// 채택 기본 Y 대상 상태
const ADOPT_Y = new Set(['확정', '병합(검수)'])
// 초안 헤더행 배경(짙은 남색) — 그대로 재현
const HEADER_BG = '2F3542'

type Cell = string | number
const alias = aliasData as { title: string; legend: string; header: string[]; rows: Cell[][] }
const mapping = mappingData as { header: string[]; rows: Cell[][] }

// 서비스 계정 → sheets 클라이언트 (jindopam/cost route 와 동일 패턴)
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

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`

const hex = (h: string) => ({
  red: parseInt(h.slice(0, 2), 16) / 255,
  green: parseInt(h.slice(2, 4), 16) / 255,
  blue: parseInt(h.slice(4, 6), 16) / 255,
})

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const action = url.searchParams.get('action')

    // ── 인증 (CRON_SECRET) ──────────────────────────────────────
    const secret = process.env.CRON_SECRET
    if (!secret) {
      return NextResponse.json({ ok: false, error: 'CRON_SECRET 미설정' }, { status: 500 })
    }
    const authHeader = req.headers.get('authorization')
    const authed = authHeader === `Bearer ${secret}` || url.searchParams.get('secret') === secret
    if (!authed) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }

    // ── init1: 마진리빌드 시트 초기 세팅 (멱등) ───────────────────
    if (action === 'init1') {
      const sheets = getSheets()

      // 소스 데이터 방어 검증 (168 / 644 행 기대)
      if (alias.rows.length !== 168) {
        throw new Error(`별칭원장 행수 이상: ${alias.rows.length} (168 기대)`)
      }
      if (mapping.rows.length !== 644) {
        throw new Error(`발주매핑 행수 이상: ${mapping.rows.length} (644 기대)`)
      }

      // 1. 탭 생성 — 없는 것만 (멱등)
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      const toAdd = TABS.filter((t) => !idByTitle.has(t))
      if (toAdd.length > 0) {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })),
          },
        })
        for (const r of res.data.replies || []) {
          const p = r.addSheet?.properties
          if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
        }
      }
      const idOf = (t: string): number => {
        const id = idByTitle.get(t)
        if (id == null) throw new Error(`탭 '${t}' sheetId 를 찾지 못했습니다.`)
        return id
      }

      // 2. 채택 기본값 — 상태(초안 3번째 컬럼)가 확정/병합(검수)인 행만 Y
      const adopt = alias.rows.map((r) => (ADOPT_Y.has(String(r[2]).trim()) ? 'Y' : ''))
      const yCount = adopt.filter((v) => v === 'Y').length
      const aliasLast = 4 + alias.rows.length // 헤더 R4 → 데이터 R5~R172

      // 3. 값 기록
      //    RAW: '[보배마을] …' 같은 값이나 특수문자 옵션명이 수식·날짜로 재해석되지 않게 함
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            // 별칭원장: 채택(A) + 초안 11컬럼(B~L)
            { range: `${quote('별칭원장')}!B1`, values: [[alias.title]] },
            { range: `${quote('별칭원장')}!B2`, values: [[alias.legend]] },
            { range: `${quote('별칭원장')}!A4:L4`, values: [['채택', ...alias.header]] },
            {
              range: `${quote('별칭원장')}!A5:L${aliasLast}`,
              values: alias.rows.map((r, i) => [adopt[i], ...r]),
            },
            // 발주매핑: 헤더 R1 · 데이터 R2~
            { range: `${quote('발주매핑')}!A1:H1`, values: [mapping.header] },
            {
              range: `${quote('발주매핑')}!A2:H${1 + mapping.rows.length}`,
              values: mapping.rows,
            },
            // 비용DB · 채널DB 헤더만
            { range: `${quote('비용DB')}!A1:D1`, values: [['항목', '값', '단위', '메모']] },
            {
              range: `${quote('채널DB')}!A1:D1`,
              values: [['채널', '수수료율', '배송정책', '메모']],
            },
          ],
        },
      })

      // 4. 원가표미러 — IMPORTRANGE 는 수식으로 들어가야 하므로 USER_ENTERED
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('원가표미러')}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[`=IMPORTRANGE("${COST_SHEET_ID}","${IMPORT_RANGE}")`]],
        },
      })

      // 5. 서식 · 데이터검증
      const aliasId = idOf('별칭원장')
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const boldHeader = (sheetId: number, cols: number) => ({
        repeatCell: {
          range: grid(sheetId, 0, 1, 0, cols),
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      })

      const requests: any[] = [
        // 별칭원장 헤더 A4:L4 — 초안과 동일한 짙은 배경 + 흰 볼드
        {
          repeatCell: {
            range: grid(aliasId, 3, 4, 0, 12),
            cell: {
              userEnteredFormat: {
                backgroundColor: hex(HEADER_BG),
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields:
              'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor',
          },
        },
        // 채택(A5:A172) Y/N 드롭다운
        {
          setDataValidation: {
            range: grid(aliasId, 4, aliasLast, 0, 1),
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: [{ userEnteredValue: 'Y' }, { userEnteredValue: 'N' }],
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
        boldHeader(idOf('발주매핑'), 8),
        boldHeader(idOf('비용DB'), 4),
        boldHeader(idOf('채널DB'), 4),
      ]

      // 상태별 배경색 — 같은 색 연속 구간을 묶어 요청 수를 줄인다 (확정은 무색 → 요청 없음)
      let run: { bg: string; start: number; end: number } | null = null
      const flush = () => {
        if (!run) return
        requests.push({
          repeatCell: {
            range: grid(aliasId, run.start, run.end, 0, 12),
            cell: { userEnteredFormat: { backgroundColor: hex(run.bg) } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        })
        run = null
      }
      alias.rows.forEach((r, i) => {
        const bg = STATUS_BG[String(r[2]).trim()]
        const rowIdx = 4 + i
        if (!bg) {
          flush()
          return
        }
        if (run && run.bg === bg && run.end === rowIdx) run.end = rowIdx + 1
        else {
          flush()
          run = { bg, start: rowIdx, end: rowIdx + 1 }
        }
      })
      flush()

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: { requests },
      })

      // 6. 요약
      const byStatus: Record<string, number> = {}
      for (const r of alias.rows) {
        const s = String(r[2]).trim()
        byStatus[s] = (byStatus[s] || 0) + 1
      }
      return NextResponse.json({
        ok: true,
        message: '마진리빌드 시트 초기 세팅 완료',
        tabsCreated: toAdd,
        summary: {
          별칭원장: `${alias.rows.length}행 × 12컬럼(채택+11) · 채택 Y ${yCount} / 빈칸 ${alias.rows.length - yCount}`,
          별칭원장_상태별: byStatus,
          발주매핑: `${mapping.rows.length}행 × 8컬럼`,
          원가표미러: 'A1 IMPORTRANGE 수식 1셀 (시트에서 최초 1회 액세스 허용 필요)',
          비용DB: '헤더 1행 (항목/값/단위/메모)',
          채널DB: '헤더 1행 (채널/수수료율/배송정책/메모)',
        },
      })
    }

    // ── init2: 별칭원장 채택 일괄 Y + 단가DB 탭 구축 (멱등) ────────
    if (action === 'init2') {
      const sheets = getSheets()

      if (alias.rows.length !== 168) {
        throw new Error(`별칭원장 행수 이상: ${alias.rows.length} (168 기대)`)
      }

      // 1. 원가표 컬럼 위치 해석 — 헤더를 실제로 읽어서 매핑 (하드코딩 금지)
      //    미러(IMPORTRANGE 결과) 우선. 아직 액세스 허용 전이면 #REF! 이므로
      //    원본 원가표를 읽어(READ ONLY) 같은 레이아웃에서 인덱스를 얻는다.
      const readHeader = async (spreadsheetId: string, range: string): Promise<string[]> => {
        try {
          const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
          return (res.data.values?.[0] || []).map((v) => String(v ?? '').trim())
        } catch {
          return []
        }
      }
      let headerSource = '원가표미러'
      let costHeader = await readHeader(TARGET_SHEET_ID, `${quote('원가표미러')}!A11:P11`)
      const hasAll = (h: string[]) =>
        [COL_WONGOK, COL_SUPPLY, COL_TAX].every((c) => h.indexOf(c) >= 0)
      if (!hasAll(costHeader)) {
        // 원본은 읽기만 한다 (write 없음)
        headerSource = '원가표 원본(read-only)'
        costHeader = await readHeader(COST_SHEET_ID, `${quote('진도팜 원가표')}!A11:P11`)
      }
      if (!hasAll(costHeader)) {
        throw new Error(
          `원가표 헤더(R11)에서 컬럼을 찾지 못했습니다. 읽은 헤더: ${JSON.stringify(costHeader)}`,
        )
      }
      // VLOOKUP 열번호 = A11:P200 범위 내 1-based 위치
      const idxWongok = costHeader.indexOf(COL_WONGOK) + 1
      const idxSupply = costHeader.indexOf(COL_SUPPLY) + 1
      const idxTax = costHeader.indexOf(COL_TAX) + 1

      // 2. 단가DB 탭 생성 (없을 때만)
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      if (!idByTitle.has('별칭원장')) {
        throw new Error("'별칭원장' 탭이 없습니다. init1 을 먼저 실행하세요.")
      }
      let priceCreated = false
      if (!idByTitle.has(PRICE_TAB)) {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: PRICE_TAB } } }] },
        })
        const p = res.data.replies?.[0]?.addSheet?.properties
        if (p?.sheetId == null) throw new Error(`'${PRICE_TAB}' 탭 생성 실패`)
        idByTitle.set(PRICE_TAB, p.sheetId)
        priceCreated = true
      }
      const priceId = idByTitle.get(PRICE_TAB) as number

      // 3. 행 조립 — 별칭원장 초안 컬럼 인덱스:
      //    0 별칭 / 1 브랜드 / 2 상태 / 3 발송거래처 / 4 소포장 원곡가 / 5 소포장 공급가 /
      //    6 벌크 원곡가 / 7 벌크 공급가 / 8 원료ID 추정
      const vlookup = (row: number, col: number) =>
        `=VLOOKUP($E${row},${MIRROR_RANGE},${col},FALSE)`

      const colAE: Cell[][] = [] // A~E (값)
      const colFG: Cell[][] = [] // F~G (연결행은 수식)
      const colHI: Cell[][] = [] // H~I (값)
      const colJ: Cell[][] = [] // J   (연결행은 수식)
      const colK: Cell[][] = [] // K   (값)
      let linked = 0
      let unlinked = 0
      let needPurchase = 0

      alias.rows.forEach((a, i) => {
        const r = 2 + i // 헤더 R1 → 데이터 R2~R169
        const rid = String(a[8] ?? '').trim()
        const status = String(a[2] ?? '').trim()
        const isLinked = rid !== ''
        const noCost = status === STATUS_NO_COST
        if (isLinked) linked++
        else unlinked++
        if (noCost) needPurchase++

        colAE.push([a[0] ?? '', a[1] ?? '', a[3] ?? '', 'O', rid])
        // 원료ID 있으면 원가표 실시간 참조, 없으면 초안 값 복사
        colFG.push(
          isLinked
            ? [vlookup(r, idxWongok), vlookup(r, idxSupply)]
            : [a[4] ?? '', a[5] ?? ''],
        )
        colHI.push([a[7] ?? '', '']) // H 벌크 공급가 · I 매입가(수기 입력용 빈칸)
        colJ.push([isLinked ? vlookup(r, idxTax) : ''])
        // 비고: 미연결 표시 + 원가 자체가 없던 행은 매입가 입력 필요까지 함께 표기
        const notes: string[] = []
        if (!isLinked) notes.push('원료 미연결')
        if (noCost) notes.push('매입가 입력 필요')
        colK.push([notes.join(' · ')])
      })
      const priceLast = 1 + alias.rows.length // R169

      // 4. 값 기록
      //    - 별칭원장은 A열(채택)만 건드린다. 다른 컬럼은 이 액션에서 일절 쓰지 않음.
      //    - 텍스트/숫자 컬럼은 RAW, 수식이 섞인 F·G·J 만 USER_ENTERED
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: `${quote('별칭원장')}!A5:A${4 + alias.rows.length}`,
              values: alias.rows.map(() => ['Y']),
            },
            { range: `${quote(PRICE_TAB)}!A1:K1`, values: [PRICE_HEADER] },
            { range: `${quote(PRICE_TAB)}!A2:E${priceLast}`, values: colAE },
            { range: `${quote(PRICE_TAB)}!H2:I${priceLast}`, values: colHI },
            { range: `${quote(PRICE_TAB)}!K2:K${priceLast}`, values: colK },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(PRICE_TAB)}!F2:G${priceLast}`, values: colFG },
            { range: `${quote(PRICE_TAB)}!J2:J${priceLast}`, values: colJ },
          ],
        },
      })

      // 5. 서식 · 데이터검증
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // 헤더 A1:K1 볼드 + 옅은 회색
            {
              repeatCell: {
                range: grid(priceId, 0, 1, 0, 11),
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            // 취급상태 D2:D169 — O/X 드롭다운
            {
              setDataValidation: {
                range: grid(priceId, 1, priceLast, 3, 4),
                rule: {
                  condition: {
                    type: 'ONE_OF_LIST',
                    values: [{ userEnteredValue: 'O' }, { userEnteredValue: 'X' }],
                  },
                  showCustomUi: true,
                  strict: false,
                },
              },
            },
            // 금액 컬럼 F~I 천단위 콤마
            {
              repeatCell: {
                range: grid(priceId, 1, priceLast, 5, 9),
                cell: {
                  userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } },
                },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
          ],
        },
      })

      return NextResponse.json({
        ok: true,
        message: '별칭원장 채택 일괄 Y + 단가DB 구축 완료',
        headerSource,
        vlookupCols: { [COL_WONGOK]: idxWongok, [COL_SUPPLY]: idxSupply, [COL_TAX]: idxTax },
        priceTabCreated: priceCreated,
        summary: {
          별칭원장_채택Y: alias.rows.length,
          단가DB_행수: alias.rows.length,
          원료_연결: linked,
          원료_미연결: unlinked,
          매입가_입력필요: needPurchase,
        },
      })
    }

    // ── init3: 단가DB 파생형 재구축 + 발주매핑 연결 (멱등) ─────────
    if (action === 'init3') {
      const sheets = getSheets()

      if (alias.rows.length !== 168) {
        throw new Error(`별칭원장 행수 이상: ${alias.rows.length} (168 기대)`)
      }
      if (mapping.rows.length !== 644) {
        throw new Error(`발주매핑 행수 이상: ${mapping.rows.length} (644 기대)`)
      }

      // ── 1. 원가표 레이아웃 해석 (하드코딩 금지 · 미러 우선, 원본은 read-only 폴백) ──
      const readRange = async (spreadsheetId: string, range: string): Promise<string[][]> => {
        try {
          const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
          return (res.data.values || []).map((r) => (r || []).map((v) => String(v ?? '').trim()))
        } catch {
          return []
        }
      }
      const NEEDED = [COL_WONGOK, COL_CRUSH, COL_MILL, COL_BLEND, COL_LOGI, COL_TAX]
      const hasAll = (h: string[]) => NEEDED.every((c) => h.indexOf(c) >= 0)

      let layoutSource = '원가표미러'
      let costHeader = (await readRange(TARGET_SHEET_ID, `${quote('원가표미러')}!A11:P11`))[0] || []
      let refTable = await readRange(TARGET_SHEET_ID, `${quote('원가표미러')}!A1:B8`)
      const labelRow = (t: string[][], label: string) =>
        t.findIndex((r) => (r?.[0] ?? '') === label) + 1 // 1-based 시트 행번호
      if (!hasAll(costHeader) || labelRow(refTable, REF_LABOR_SMALL) === 0) {
        // 미러가 아직 IMPORTRANGE 승인 전(#REF!)이면 원본을 읽어서 같은 레이아웃을 얻는다.
        layoutSource = '원가표 원본(read-only)'
        costHeader = (await readRange(COST_SHEET_ID, `${quote('진도팜 원가표')}!A11:P11`))[0] || []
        refTable = await readRange(COST_SHEET_ID, `${quote('진도팜 원가표')}!A1:B8`)
      }
      if (!hasAll(costHeader)) {
        throw new Error(
          `원가표 헤더(R11)에서 컬럼을 찾지 못했습니다. 읽은 헤더: ${JSON.stringify(costHeader)}`,
        )
      }
      const rowSmall = labelRow(refTable, REF_LABOR_SMALL)
      const rowBulk = labelRow(refTable, REF_LABOR_BULK)
      if (rowSmall === 0 || rowBulk === 0) {
        throw new Error(
          `가공비표에서 작업비 항목을 찾지 못했습니다. 읽은 A1:B8: ${JSON.stringify(refTable)}`,
        )
      }
      const laborSmall = `'원가표미러'!$B$${rowSmall}` // 작업비(소포장) 셀
      const laborBulk = `'원가표미러'!$B$${rowBulk}` // 작업비(벌크) 셀
      const col = (name: string) => costHeader.indexOf(name) + 1 // A12:P200 내 1-based 열번호
      const iWongok = col(COL_WONGOK)
      const iCrush = col(COL_CRUSH)
      const iMill = col(COL_MILL)
      const iBlend = col(COL_BLEND)
      const iLogi = col(COL_LOGI)
      const iTax = col(COL_TAX)

      // ── 2. 탭 확보 ────────────────────────────────────────────
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      if (!idByTitle.has(MAP_TAB)) throw new Error(`'${MAP_TAB}' 탭이 없습니다. init1 을 먼저 실행하세요.`)
      if (!idByTitle.has(PRICE_TAB)) {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: PRICE_TAB } } }] },
        })
        const p = res.data.replies?.[0]?.addSheet?.properties
        if (p?.sheetId == null) throw new Error(`'${PRICE_TAB}' 탭 생성 실패`)
        idByTitle.set(PRICE_TAB, p.sheetId)
      }
      const priceId = idByTitle.get(PRICE_TAB) as number
      const mapId = idByTitle.get(MAP_TAB) as number

      // ── 3. 행 조립 ────────────────────────────────────────────
      const vl = (r: number, c: number) => `VLOOKUP($E${r},${MIRROR_DATA},${c},FALSE)`
      const blank = (r: number, expr: string) => `=IF(OR($E${r}="",$F${r}=""),"",${expr})`

      const colAF: Cell[][] = [] // A~F 값
      const colGI: Cell[][] = [] // G~I 수식
      const colJ: Cell[][] = [] // J 매입가(빈칸)
      const colK: Cell[][] = [] // K 과세여부 수식
      const colL: Cell[][] = [] // L 비고 값

      let linked = 0
      let unlinked = 0
      let needPurchase = 0
      let bagPriced = 0
      let gramOk = 0
      let gramFail = 0
      let ridFixed = 0

      alias.rows.forEach((a, i) => {
        const r = 2 + i // 헤더 R1 → 데이터 R2~R169
        const aliasText = String(a[0] ?? '').trim()
        const status = String(a[2] ?? '').trim()
        let rid = String(a[8] ?? '').trim()
        // 깬서리태 오연결 교정 (유기농_서리태 → 유기농_깬 서리태)
        if (aliasText.includes('깬서리태')) {
          if (rid !== '유기농_깬 서리태') ridFixed++
          rid = '유기농_깬 서리태'
        }
        const isLinked = rid !== ''
        const isBag = isLinked && BAG_PRICED.test(rid)
        const noCost = status === STATUS_NO_COST
        if (isLinked) linked++
        else unlinked++
        if (noCost) needPurchase++
        if (isBag) bagPriced++

        // 봉단가 원료는 원료ID 자체가 봉 단위 값 → 배수 1 (g=1000)
        const gram: Cell = isBag ? 1000 : parseGram(aliasText)
        if (gram === '') gramFail++
        else gramOk++

        colAF.push([aliasText, a[1] ?? '', a[3] ?? '', 'O', rid, gram])
        // G 원곡가 = 1kg당 원곡가 × g/1000
        colGI.push([
          blank(r, `${vl(r, iWongok)}*$F${r}/1000`),
          // H 소포장 공급가 = (원곡가+파쇄+제분+혼합)×g/1000 + 작업비(소포장)×MAX(1,g/1000) + 물류대행비
          blank(
            r,
            `(${vl(r, iWongok)}+${vl(r, iCrush)}+${vl(r, iMill)}+${vl(r, iBlend)})*$F${r}/1000` +
              `+${laborSmall}*MAX(1,$F${r}/1000)+${vl(r, iLogi)}`,
          ),
          // I 벌크 공급가 = H 와 동일, 작업비만 벌크 단가
          blank(
            r,
            `(${vl(r, iWongok)}+${vl(r, iCrush)}+${vl(r, iMill)}+${vl(r, iBlend)})*$F${r}/1000` +
              `+${laborBulk}*MAX(1,$F${r}/1000)+${vl(r, iLogi)}`,
          ),
        ])
        colJ.push([''])
        // K 과세여부는 용량과 무관 → E 만 보고 판단
        colK.push([`=IF($E${r}="","",${vl(r, iTax)})`])

        const notes: string[] = []
        if (isBag) notes.push('봉단가 원료')
        if (!isLinked) notes.push('원료 미연결')
        if (noCost) notes.push('매입가 입력 필요')
        colL.push([notes.join(' · ')])
      })
      const priceLast = 1 + alias.rows.length // R169
      const mapLast = 1 + mapping.rows.length // R645

      // ── 4. 단가DB 전면 교체 ───────────────────────────────────
      await sheets.spreadsheets.values.clear({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A1:Z1000`,
        requestBody: {},
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(PRICE_TAB)}!A1:L1`, values: [PRICE_HEADER_V2] },
            { range: `${quote(PRICE_TAB)}!A2:F${priceLast}`, values: colAF },
            { range: `${quote(PRICE_TAB)}!J2:J${priceLast}`, values: colJ },
            { range: `${quote(PRICE_TAB)}!L2:L${priceLast}`, values: colL },
            { range: `${quote(MAP_TAB)}!I1`, values: [['DB확인']] },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(PRICE_TAB)}!G2:I${priceLast}`, values: colGI },
            { range: `${quote(PRICE_TAB)}!K2:K${priceLast}`, values: colK },
            // 발주매핑 I: C(표준 별칭)가 단가DB A열에 없으면 표시. C열 값은 건드리지 않음.
            {
              range: `${quote(MAP_TAB)}!I2:I${mapLast}`,
              values: mapping.rows.map((_, i) => [
                `=IF($C${2 + i}="","",IF(COUNTIF('${PRICE_TAB}'!$A$2:$A$${priceLast},$C${2 + i})=0,"단가DB 없음",""))`,
              ]),
            },
          ],
        },
      })

      // ── 5. 서식 · 데이터검증 ──────────────────────────────────
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const rangeRule = (ref: string) => ({
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: ref }] },
        showCustomUi: true,
        strict: false,
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // 이전 레이아웃(init2)의 검증·서식 잔재 제거
            { setDataValidation: { range: grid(priceId, 0, 1000, 0, 26) } },
            {
              repeatCell: {
                range: grid(priceId, 0, 1000, 0, 26),
                cell: {},
                fields: 'userEnteredFormat',
              },
            },
            // 헤더 A1:L1 볼드 + 옅은 회색
            {
              repeatCell: {
                range: grid(priceId, 0, 1, 0, 12),
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            // D 취급상태 O/X
            {
              setDataValidation: {
                range: grid(priceId, 1, priceLast, 3, 4),
                rule: {
                  condition: {
                    type: 'ONE_OF_LIST',
                    values: [{ userEnteredValue: 'O' }, { userEnteredValue: 'X' }],
                  },
                  showCustomUi: true,
                  strict: false,
                },
              },
            },
            // E 원료ID — 원가표미러 A12:A200 드롭다운
            {
              setDataValidation: {
                range: grid(priceId, 1, priceLast, 4, 5),
                rule: rangeRule(MIRROR_ID_RANGE),
              },
            },
            // F~J 천단위 콤마
            {
              repeatCell: {
                range: grid(priceId, 1, priceLast, 5, 10),
                cell: {
                  userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } },
                },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
            // 발주매핑 C — 단가DB A2:A169 드롭다운 (값은 수정하지 않음, 검증만 추가)
            {
              setDataValidation: {
                range: grid(mapId, 1, mapLast, 2, 3),
                rule: rangeRule(PRICE_ALIAS_RANGE),
              },
            },
            // 발주매핑 I1 헤더 볼드
            {
              repeatCell: {
                range: grid(mapId, 0, 1, 8, 9),
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        },
      })

      // ── 6. 되읽어 검증 ────────────────────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A2:L${priceLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const bv = back.data.values || []
      const findRow = (pred: (r: any[]) => boolean) => bv.find(pred)
      const cellOf = (r: any[] | undefined, c: number) => (r ? r[c] : undefined)
      const kkaen = findRow((r) => String(r[0] ?? '').includes('깬서리태') && Number(r[5]) === 500)
      const seoritae = findRow(
        (r) => String(r[0] ?? '').trim() === '[보배마을] 서리태 1kg',
      )
      let computed = 0
      let notNumber = 0
      for (const r of bv) {
        if (String(r[4] ?? '').trim() === '') continue
        if (typeof r[7] === 'number') computed++
        else notNumber++
      }

      return NextResponse.json({
        ok: true,
        message: '단가DB 파생형 재구축 + 발주매핑 연결 완료',
        layoutSource,
        vlookupCols: {
          [COL_WONGOK]: iWongok,
          [COL_CRUSH]: iCrush,
          [COL_MILL]: iMill,
          [COL_BLEND]: iBlend,
          [COL_LOGI]: iLogi,
          [COL_TAX]: iTax,
        },
        laborCells: { 소포장: laborSmall, 벌크: laborBulk },
        summary: {
          단가DB_행수: alias.rows.length,
          원료_연결: linked,
          원료_미연결: unlinked,
          매입가_입력필요: needPurchase,
          봉단가_원료: bagPriced,
          g파싱_성공: gramOk,
          g파싱_실패: gramFail,
          원료ID_교정: ridFixed,
          발주매핑_DB확인행: mapping.rows.length,
        },
        verify: {
          '깬서리태 500g H': cellOf(kkaen, 7),
          '깬서리태 500g H 기대': 7600,
          '서리태 1kg H': cellOf(seoritae, 7),
          '서리태 1kg H 기대': 13800,
          연결행_H_숫자계산됨: computed,
          연결행_H_숫자아님: notNumber,
          비고:
            notNumber > 0
              ? 'H가 숫자가 아닌 행이 있습니다. 원가표미러 IMPORTRANGE 액세스 허용이 아직이면 #REF! 입니다.'
              : '전 연결행 정상 계산',
        },
      })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (e: any) {
    console.error('[rebuild] error:', e?.message || e)
    return NextResponse.json({ ok: false, error: e?.message || '서버 오류' }, { status: 500 })
  }
}
