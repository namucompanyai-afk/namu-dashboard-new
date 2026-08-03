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

// ── init4: 원료 일괄 연결 · 가공 컬럼 · 기타거래처 원가표 ────────
const ETC_TAB = '기타거래처 원가표'
const ETC_HEADER = ['거래처', '별칭', '매입가', '과세여부', '메모']
const PROC_CRUSH = '파쇄'
const PROC_MILL = '제분'
const REF_CRUSH = '파쇄비' // 미러 가공비표 라벨 (셀 위치는 런타임 해석)
const REF_MILL = '제분비'
// 이 이상 용량인데 봉단가가 아니면 작업비 비례 적용이 진도팜과 미합의 → 비고로 표시
const BIG_PACK_G = 10000

// 별칭|원료ID|가공|봉단가여부 (지시문 원문 형식 그대로 유지)
const LINK_91 = [
  '[보배마을] 귀리 1kg|유기농_귀리||',
  '[보배마을] 귀리혼합10곡 800g|유기농_귀리10곡||',
  '[보배마을] 기장 1kg|유기농_기장||',
  '[보배마을] 기장 500g|유기농_기장||',
  '[보배마을] 바나듐쌀 백미 2kg|유기농_바나듐 백미||',
  '[보배마을] 녹미 1kg|유기농_녹미||',
  '[보배마을] 바나듐쌀 찰흑미 2kg|유기농_바나듐 흑미||',
  '[보배마을] 백미 2kg|유기농_백미||',
  '[보배마을] 수수 1kg|유기농_수수||',
  '[토지랑] 백미 10kg|관행_백미 10kg_새청무||봉단가',
  '[보배마을] 오색현미 1kg|유기농_오색현미||',
  '[보배마을] 저속노화쌀 1kg|유기농_저속노화||',
  '[보배마을] 저속노화쌀 200g|유기농_저속노화||',
  '[보배마을] 차조 500g|유기농_차조||',
  '[보배마을] 찰보리 1kg|유기농_찰보리||',
  '[보배마을] 찰현미 2kg|유기농_찰현미||',
  '[보배마을] 찰흑미 1kg|유기농_흑미||',
  '[보배마을] 찹쌀 1kg|유기농_찹쌀||',
  '[보배마을] 현미 2kg|유기농_현미||',
  '[보배마을] 호라산밀 1kg|유기농_호라산밀||',
  '[보배마을] 홍미 1kg|유기농_홍미||',
  '[보배마을] 흑보리 1kg|유기농_흑보리||',
  '[쌀쌀쌀] 국산 귀리 1kg|관행_귀리||',
  '[쌀쌀쌀] 국산 귀리 2kg|관행_귀리||',
  '[쌀쌀쌀] 국산 찰흑미 2kg|관행_흑미||',
  '[쌀쌀쌀] 국산 현미 1kg|관행_현미||',
  '[쌀쌀쌀] 국산 호라산밀 2kg|관행_호라산밀||',
  '[쌀쌀쌀] 귀리혼합10곡 2kg|관행_귀리혼합10곡||',
  '[토지랑] 백미 20kg|관행_백미 20kg_새청무||봉단가',
  '[쌀쌀쌀] 쌀눈 500g|관행_쌀눈 500g||봉단가',
  '[쌀쌀쌀] 저속노화쌀 1kg|혼합_저속노화||',
  '[쌀쌀쌀] 저속노화쌀 2kg|혼합_저속노화||',
  '[쌀쌀쌀] 저속노화쌀 500g|혼합_저속노화||',
  '[쌀쌀쌀] 찰흑미 2kg|관행_흑미||',
  '[쌀쌀쌀] 터키산 호라산밀 1kg|수입_호라산밀_터키산||',
  '[쌀쌀쌀] 터키산 호라산밀 2kg|수입_호라산밀_터키산||',
  '[토지랑] 귀리 1kg|관행_귀리||',
  '[토지랑] 기장 1kg|관행_기장||',
  '[토지랑] 녹미 1kg|관행_녹미||',
  '[토지랑] 수수 1kg|관행_수수||',
  '[토지랑] 오색현미 1kg|관행_오색현미||',
  '[토지랑] 차조 1kg|관행_차조||',
  '[토지랑] 찰보리 1kg|관행_찰보리||',
  '[토지랑] 찰흑미 1kg|관행_흑미||',
  '[토지랑] 찹쌀 1kg|관행_찹쌀||',
  '[토지랑] 향진주 10kg|관행_백미 10kg_향진주||봉단가',
  '[토지랑] 현미 1kg|관행_현미||',
  '[토지랑] 호라산밀 1kg|관행_호라산밀||',
  '[토지랑] 호라산밀칩|관행_호라산칩||봉단가',
  '[토지랑] 홍미 1kg|관행_홍미||',
  '[토지랑] 흑보리 1kg|관행_흑보리||',
  '[토지랑] 백미 1kg|관행_백미_새청무||',
  '[보배마을] 귀리 3kg|유기농_귀리||',
  '[보배마을] 유기농 수수 1kg|유기농_수수||',
  '[보배마을] 흑보리 500g|유기농_흑보리||',
  '[보배마을] 생 귀리가루 350g|유기농_귀리|제분|',
  '[보배마을] 흑미 1kg|유기농_흑미||',
  '[보배마을] 귀리10곡 1kg|유기농_귀리10곡||',
  '[보배마을] 조생종 백미 2kg|유기농_조생종 백미||',
  '[보배마을] 조생종 백미 10kg|유기농_조생종 백미||',
  '[보배마을] 찰현미 1kg|유기농_찰현미||',
  '[보배마을] 백태 1kg|유기농_백태||',
  '[보배마을] 깬 백태 1kg|유기농_백태|파쇄|',
  '[보배마을] 호라산밀 가루 1kg|유기농_호라산밀|제분|',
  '[보배마을] 귀리 가루 1kg|유기농_귀리|제분|',
  '[보배마을] 어린이혼합곡 1kg|유기농_어린이 혼합곡||',
  '[보배마을] 호라산밀 가루 20kg|유기농_호라산밀|제분|',
  '[보배마을] 귀리 가루 20kg|유기농_귀리|제분|',
  '[보배마을] 흑미 제분 20kg|유기농_흑미|제분|',
  '[보배마을] 찹쌀 가루 1kg|유기농_찹쌀|제분|',
  '[보배마을] 찹쌀 가루 500g|유기농_찹쌀|제분|',
  '[보배마을] 유기농 흰찰보리 1kg|유기농_흰찰보리||',
  '[보배마을] 무농약 흰찰보리 1kg|무농약_흰찰보리||',
  '[보배마을] 무농약 청보리 1kg|무농약_청보리||',
  '[토지랑] 흑미 1kg|관행_흑미||',
  '[토지랑] 청보리 1kg|관행_청보리||',
  '[토지랑] 조생종 백미 10kg|관행_백미 10kg_조생종||봉단가',
  '[토지랑] 백태 1kg|관행_백태||',
  '[토지랑] 조각 백태 1kg|관행_깬 백태||',
  '[쌀쌀쌀] 저속노화 잡곡 200g 캐귀리|혼합_저속노화||',
  '[쌀쌀쌀] 저속노화 잡곡 500g 캐귀리|혼합_저속노화||',
  '[쌀쌀쌀] 저속노화 잡곡 1kg 캐귀리|혼합_저속노화||',
  '[쌀쌀쌀] 저속노화 잡곡 2kg 캐귀리|혼합_저속노화||',
  '[쌀쌀쌀] 국산 흑보리 1kg|관행_흑보리||',
  '[쌀쌀쌀] 국산 흑보리 2kg|관행_흑보리||',
  '[쌀쌀쌀] 찹쌀 1kg|관행_찹쌀||',
  '[쌀쌀쌀] 찰현미 1kg|관행_찰현미||',
  '[해남농부들] 터키 호라산밀 1kg|수입_호라산밀_터키산||',
  '[보배마을] 어린이혼합곡|유기농_어린이 혼합곡||',
  '[쌀쌀쌀] 귀리 1kg|관행_귀리||',
  '[쌀쌀쌀] 흑미 1kg|관행_흑미||',
]

// ── init5: 채널DB · 비용DB · 마진계산 ───────────────────────────
const MARGIN_TAB = '마진계산'
const MARGIN_ROWS = 300 // 데이터 R2~R301
const CHANNEL_HEADER = ['채널', '수수료율(%)', 'VAT포함율', '배송비부담', '메모']
// 수수료율은 쿠팡 윙(잡곡)만 확정값. 나머지는 직원 수기 입력 대기(빈칸).
const CHANNELS: [string, number | ''][] = [
  ['스마트스토어', ''],
  ['쿠팡 윙(잡곡)', 5.8],
  ['쿠팡 윙(가공식품)', ''],
  ['컬리', ''],
  ['11번가', ''],
  ['롯데온', ''],
  ['SSG', ''],
  ['지마켓', ''],
  ['옥션', ''],
  ['티딜', ''],
  ['토스', ''],
  ['올웨이즈', ''],
  ['오아시스', ''],
  ['카카오메이커스', ''],
  ['카카오톡딜', ''],
  ['자사몰', ''],
  ['B2B', ''],
]
const COST_DB_BAG = '봉투 단가'
const COST_DB_WARN = '경고 기준 마진율'
const COST_DB_ROWS: Cell[][] = [
  [COST_DB_BAG, 150, '원', '제품 1봉당 포장 봉투 단가'],
  [COST_DB_WARN, 20, '%', '마진율이 이 값 미만이면 마진계산 상태에 경고 표시'],
]
const MARGIN_HEADER = [
  '별칭',
  '채널',
  '봉수',
  '판매가',
  '목표마진율%',
  '원가',
  '봉투',
  '규격',
  '박스',
  '택배',
  '수수료율%',
  '수수료',
  '총비용',
  '마진',
  '마진율',
  'BEP ROAS',
  '권장판매가',
  '상태',
]
const MARGIN_USAGE = '별칭·채널·봉수·판매가·규격 입력 → 나머지 자동'
// init6: 채널 우선 배치 (A 채널 / B 별칭, 나머지 동일)
const MARGIN_HEADER_V2 = [
  '채널',
  '별칭',
  '봉수',
  '판매가',
  '목표마진율%',
  '원가',
  '봉투',
  '규격',
  '박스',
  '택배',
  '수수료율%',
  '수수료',
  '총비용',
  '마진',
  '마진율',
  'BEP ROAS',
  '권장판매가',
  '상태',
]
const MARGIN_USAGE_V2 = '채널·별칭·봉수·판매가·규격 입력 → 나머지 자동'
// init7: 수수료율 수기 전환 (K 헤더만 변경, 나머지 V2 동일)
const MARGIN_HEADER_V3 = MARGIN_HEADER_V2.map((h, i) => (i === 10 ? '수수료율%(부가포함)' : h))
const MARGIN_USAGE_V3 = '채널·별칭·봉수·판매가·수수료율(부가포함)·규격 입력 → 나머지 자동'
const CHANNEL_NOTE = '참고표 — 마진계산에는 행별 직접 입력'
// init8: 배송비 수수료 구조 (E 고객배송비 / N 배송비수수료 삽입 → A~T 20열)
const SHIP_IN_COL = '고객배송비'
const SHIP_FEE_COL = '배송비수수료'
const SHIP_RATE_COL = '배송비수수료율(%)'
const SMART_STORE = '스마트스토어'
const SMART_STORE_SHIP_RATE = 3.05
const MARGIN_HEADER_V4 = [
  '채널',
  '별칭',
  '봉수',
  '판매가',
  SHIP_IN_COL,
  '목표마진율%',
  '원가',
  '봉투',
  '규격',
  '박스',
  '택배',
  '수수료율%(부가포함)',
  '수수료',
  SHIP_FEE_COL,
  '총비용',
  '마진',
  '마진율',
  'BEP ROAS(광고센터 기준)',
  '권장판매가',
  '상태',
]
const MARGIN_USAGE_V4 =
  '채널·별칭·봉수·판매가·고객배송비·수수료율(부가포함)·규격 입력 → 나머지 자동'
// init9: 목표마진율%를 권장판매가 바로 앞(R열)으로 이동 → A~T 20열
const GOAL_COL = '목표마진율%'
const MARGIN_HEADER_V5 = [
  '채널',
  '별칭',
  '봉수',
  '판매가',
  SHIP_IN_COL,
  '원가',
  '봉투',
  '규격',
  '박스',
  '택배',
  '수수료율%(부가포함)',
  '수수료',
  SHIP_FEE_COL,
  '총비용',
  '마진',
  '마진율',
  'BEP ROAS(광고센터 기준)',
  GOAL_COL,
  '권장판매가',
  '상태',
]
const MARGIN_USAGE_V5 =
  '채널·별칭·봉수·판매가·고객배송비·규격·수수료율(부가포함)·목표마진율 입력 → 나머지 자동'
// init10: 단가DB → 진도팜 원가표 바로가기 (원가표는 read-only, 읽기만)
const JINDO_SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg'
const JINDO_COST_TAB = '진도팜 원가표'
const JINDO_HEADER_ROW = 11 // R11 헤더 → 데이터 R12~
const LINK_COL = '원가표 바로가기'
const LINK_TEXT = '열기'
const DEFAULT_TABS = ['시트1', 'Sheet1']
const SIZE_OPTIONS = ['소', '중', '대', '없음']
const ST_NO_FEE = '수수료율 미입력'
const ST_NO_COST = '원가 미입력'
const ST_LOW = '마진 미달'
// 예시 행 (R2) — 실데이터
const MARGIN_SAMPLE = { alias: '[보배마을] 서리태 1kg', channel: '쿠팡 윙(잡곡)', bongsu: 1, price: 23900, size: '소' }
// 탭 노출 순서 / 숨김
const TAB_ORDER = [MARGIN_TAB, PRICE_TAB, '채널DB', ETC_TAB, MAP_TAB, '비용DB']
const TAB_HIDDEN = ['원가표미러', '별칭원장']

type LinkSpec = { rid: string; proc: string; bag: boolean }
const linkByAlias = new Map<string, LinkSpec>(
  LINK_91.map((line) => {
    const p = line.split('|')
    return [
      p[0].trim(),
      { rid: (p[1] || '').trim(), proc: (p[2] || '').trim(), bag: (p[3] || '').trim() !== '' },
    ] as [string, LinkSpec]
  }),
)

// 발주매핑 표준 별칭 → 발송 거래처 (첫 등장 기준)
const vendorByAlias = new Map<string, string>()
for (const r of (mappingData as { rows: (string | number)[][] }).rows) {
  const key = String(r[2] ?? '').trim()
  if (key && !vendorByAlias.has(key)) vendorByAlias.set(key, String(r[4] ?? '').trim())
}

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

    // ── init4: 원료 일괄 연결 + 가공 컬럼 + 기타거래처 원가표 (멱등) ──
    if (action === 'init4') {
      const sheets = getSheets()

      if (alias.rows.length !== 168) {
        throw new Error(`별칭원장 행수 이상: ${alias.rows.length} (168 기대)`)
      }
      if (linkByAlias.size !== 91) {
        throw new Error(`연결 리스트 이상: ${linkByAlias.size} (91 기대 · 별칭 중복 의심)`)
      }
      // 리스트의 별칭이 전부 단가DB(=별칭원장)에 있는지 먼저 확인
      const knownAlias = new Set(alias.rows.map((r) => String(r[0] ?? '').trim()))
      const missing = [...linkByAlias.keys()].filter((a) => !knownAlias.has(a))
      if (missing.length > 0) {
        throw new Error(`단가DB에 없는 별칭 ${missing.length}건: ${JSON.stringify(missing)}`)
      }

      // ── 1. 원가표 레이아웃 해석 (미러 우선 · 원본은 read-only 폴백) ──
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
      const labelRow = (t: string[][], label: string) =>
        t.findIndex((r) => (r?.[0] ?? '') === label) + 1 // 1-based 시트 행번호
      const REF_LABELS = [REF_LABOR_SMALL, REF_LABOR_BULK, REF_CRUSH, REF_MILL]

      let layoutSource = '원가표미러'
      let costHeader = (await readRange(TARGET_SHEET_ID, `${quote('원가표미러')}!A11:P11`))[0] || []
      let refTable = await readRange(TARGET_SHEET_ID, `${quote('원가표미러')}!A1:B8`)
      if (!hasAll(costHeader) || REF_LABELS.some((l) => labelRow(refTable, l) === 0)) {
        layoutSource = '원가표 원본(read-only)'
        costHeader = (await readRange(COST_SHEET_ID, `${quote('진도팜 원가표')}!A11:P11`))[0] || []
        refTable = await readRange(COST_SHEET_ID, `${quote('진도팜 원가표')}!A1:B8`)
      }
      if (!hasAll(costHeader)) {
        throw new Error(`원가표 헤더(R11) 해석 실패: ${JSON.stringify(costHeader)}`)
      }
      const missLabel = REF_LABELS.filter((l) => labelRow(refTable, l) === 0)
      if (missLabel.length > 0) {
        throw new Error(
          `가공비표에서 항목을 찾지 못했습니다: ${missLabel.join(', ')} / 읽은 A1:B8 ${JSON.stringify(refTable)}`,
        )
      }
      const refCell = (label: string) => `'원가표미러'!$B$${labelRow(refTable, label)}`
      const laborSmall = refCell(REF_LABOR_SMALL)
      const laborBulk = refCell(REF_LABOR_BULK)
      const crushRate = refCell(REF_CRUSH)
      const millRate = refCell(REF_MILL)
      const col = (name: string) => costHeader.indexOf(name) + 1
      const iWongok = col(COL_WONGOK)
      const iCrush = col(COL_CRUSH)
      const iMill = col(COL_MILL)
      const iBlend = col(COL_BLEND)
      const iLogi = col(COL_LOGI)
      const iTax = col(COL_TAX)

      // ── 2. 탭 확보 (기타거래처 원가표는 J 수식이 참조하므로 먼저 만든다) ──
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      if (!idByTitle.has(PRICE_TAB)) {
        throw new Error(`'${PRICE_TAB}' 탭이 없습니다. init3 을 먼저 실행하세요.`)
      }
      if (!idByTitle.has(ETC_TAB)) {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: ETC_TAB } } }] },
        })
        const p = res.data.replies?.[0]?.addSheet?.properties
        if (p?.sheetId == null) throw new Error(`'${ETC_TAB}' 탭 생성 실패`)
        idByTitle.set(ETC_TAB, p.sheetId)
      }
      const priceId = idByTitle.get(PRICE_TAB) as number
      const etcId = idByTitle.get(ETC_TAB) as number

      // ── 3. 행 조립 ────────────────────────────────────────────
      const vl = (r: number, c: number) => `VLOOKUP($E${r},${MIRROR_DATA},${c},FALSE)`
      const blank = (r: number, expr: string) => `=IF(OR($E${r}="",$F${r}=""),"",${expr})`
      // 가공 추가분: M 이 파쇄/제분이면 해당 단가 × g/1000
      const procAdd = (r: number) =>
        `IF($M${r}="${PROC_CRUSH}",${crushRate},IF($M${r}="${PROC_MILL}",${millRate},0))*$F${r}/1000`
      const baseSum = (r: number) =>
        `(${vl(r, iWongok)}+${vl(r, iCrush)}+${vl(r, iMill)}+${vl(r, iBlend)})*$F${r}/1000` +
        `+${vl(r, iLogi)}`

      const colEF: Cell[][] = [] // E 원료ID · F g
      const colGK: Cell[][] = [] // G~K 수식
      const colL: Cell[][] = [] // L 비고
      const colM: Cell[][] = [] // M 가공
      const etcRows: Cell[][] = []

      let linked = 0
      let newlyLinked = 0
      let unlinked = 0
      let bagPriced = 0
      let procCount = 0
      let bigPack = 0
      let needPurchase = 0
      let gramOk = 0
      let gramFail = 0

      alias.rows.forEach((a, i) => {
        const r = 2 + i
        const aliasText = String(a[0] ?? '').trim()
        const status = String(a[2] ?? '').trim()

        // 기존 연결 유지 → 깬서리태 교정 → 91리스트(최우선)
        let rid = String(a[8] ?? '').trim()
        if (aliasText.includes('깬서리태')) rid = '유기농_깬 서리태'
        let proc = ''
        let bagFlag = false
        const spec = linkByAlias.get(aliasText)
        if (spec) {
          if (rid === '') newlyLinked++
          rid = spec.rid
          proc = spec.proc
          bagFlag = spec.bag
        }

        const isLinked = rid !== ''
        // 봉단가: 리스트 명시 플래그 또는 원료ID 텍스트에 용량 포함
        const isBag = isLinked && (bagFlag || BAG_PRICED.test(rid))
        if (isLinked) linked++
        else unlinked++
        if (isBag) bagPriced++
        if (proc) procCount++

        const gram: Cell = isBag ? 1000 : parseGram(aliasText)
        if (gram === '') gramFail++
        else gramOk++
        // 대포장인데 봉단가가 아니면 작업비 비례 적용이 미합의 상태
        const isBigPack = typeof gram === 'number' && gram >= BIG_PACK_G && !isBag
        if (isBigPack) bigPack++
        // 매입가 수기 입력은 '원가없음'이면서 아직 원료 연결이 안 된 행에만 해당
        const noCost = status === STATUS_NO_COST && !isLinked
        if (noCost) needPurchase++

        colEF.push([rid, gram])
        colGK.push([
          blank(r, `${vl(r, iWongok)}*$F${r}/1000`),
          blank(r, `${baseSum(r)}+${laborSmall}*MAX(1,$F${r}/1000)+${procAdd(r)}`),
          blank(r, `${baseSum(r)}+${laborBulk}*MAX(1,$F${r}/1000)+${procAdd(r)}`),
          // J 매입가 — 원료 연결된 행은 항상 빈칸, 미연결 행만 기타거래처 원가표에서 조회
          `=IF($E${r}<>"","",IFERROR(VLOOKUP($A${r},'${ETC_TAB}'!$B:$C,2,FALSE),""))`,
          `=IF($E${r}="","",${vl(r, iTax)})`,
        ])
        colM.push([proc])

        const notes: string[] = []
        if (isBag) notes.push('봉단가 원료')
        if (!isLinked) notes.push('원료 미연결')
        if (noCost) notes.push('매입가 입력 필요')
        if (isBigPack) notes.push('대포장 작업비 확인')
        colL.push([notes.join(' · ')])

        // 기타거래처 원가표 사전 채움 — 원료ID 없는 행 전부
        if (!isLinked) {
          etcRows.push([vendorByAlias.get(aliasText) || '', aliasText, '', '', ''])
        }
      })
      const priceLast = 1 + alias.rows.length // R169

      // ── 4. 기타거래처 원가표 기록 (J 수식이 참조 → 먼저) ──────
      await sheets.spreadsheets.values.clear({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(ETC_TAB)}!A1:E1000`,
        requestBody: {},
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(ETC_TAB)}!A1:E1`, values: [ETC_HEADER] },
            ...(etcRows.length > 0
              ? [{ range: `${quote(ETC_TAB)}!A2:E${1 + etcRows.length}`, values: etcRows }]
              : []),
          ],
        },
      })

      // ── 5. 단가DB E~M 기록 (A~D 는 건드리지 않음) ─────────────
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(PRICE_TAB)}!M1`, values: [['가공']] },
            { range: `${quote(PRICE_TAB)}!E2:F${priceLast}`, values: colEF },
            { range: `${quote(PRICE_TAB)}!L2:L${priceLast}`, values: colL },
            { range: `${quote(PRICE_TAB)}!M2:M${priceLast}`, values: colM },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [{ range: `${quote(PRICE_TAB)}!G2:K${priceLast}`, values: colGK }],
        },
      })

      // ── 6. 서식 · 데이터검증 ──────────────────────────────────
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const headerFmt = {
        userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
        },
      }
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // 단가DB M1 헤더 + M 가공 드롭다운 (strict 아님 → 빈칸 허용)
            {
              repeatCell: {
                range: grid(priceId, 0, 1, 12, 13),
                cell: headerFmt,
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            {
              setDataValidation: {
                range: grid(priceId, 1, priceLast, 12, 13),
                rule: {
                  condition: {
                    type: 'ONE_OF_LIST',
                    values: [
                      { userEnteredValue: PROC_CRUSH },
                      { userEnteredValue: PROC_MILL },
                    ],
                  },
                  showCustomUi: true,
                  strict: false,
                },
              },
            },
            // 기타거래처 원가표 헤더 + 매입가 콤마
            {
              repeatCell: {
                range: grid(etcId, 0, 1, 0, 5),
                cell: headerFmt,
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            {
              repeatCell: {
                range: grid(etcId, 1, 1 + Math.max(etcRows.length, 1), 2, 3),
                cell: {
                  userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } },
                },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
          ],
        },
      })

      // ── 7. 되읽어 검증 ────────────────────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A2:M${priceLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const bv = back.data.values || []
      const hOf = (aliasText: string) => {
        const row = bv.find((r) => String(r[0] ?? '').trim() === aliasText)
        return row ? row[7] : undefined
      }
      let linkedBack = 0
      let computed = 0
      let notNumber = 0
      const noGram: string[] = []
      for (const r of bv) {
        if (String(r[4] ?? '').trim() === '') continue
        linkedBack++
        // g 가 없으면 수식이 의도대로 빈칸 → #REF! 등 진짜 오류와 구분한다
        if (String(r[5] ?? '').trim() === '') {
          noGram.push(String(r[0] ?? '').trim())
          continue
        }
        if (typeof r[7] === 'number') computed++
        else notNumber++
      }
      const etcBack = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(ETC_TAB)}!B2:B1000`,
      })

      return NextResponse.json({
        ok: true,
        message: '원료 일괄 연결 + 가공 컬럼 + 기타거래처 원가표 구축 완료',
        layoutSource,
        rateCells: {
          작업비_소포장: laborSmall,
          작업비_벌크: laborBulk,
          파쇄비: crushRate,
          제분비: millRate,
        },
        summary: {
          원료_연결: linked,
          신규_연결: newlyLinked,
          원료_미연결: unlinked,
          봉단가_원료: bagPriced,
          가공_지정: procCount,
          대포장_작업비확인: bigPack,
          매입가_입력필요: needPurchase,
          g파싱_성공: gramOk,
          g파싱_실패: gramFail,
          기타거래처_행수: etcRows.length,
        },
        verify: {
          원료연결_되읽기: linkedBack,
          원료연결_기대: 118,
          '[보배마을] 귀리 가루 1kg H': hOf('[보배마을] 귀리 가루 1kg'),
          '[보배마을] 귀리 가루 1kg H 기대': 5400,
          '[보배마을] 깬 백태 1kg H': hOf('[보배마을] 깬 백태 1kg'),
          '[보배마을] 깬 백태 1kg H 기대': 7400,
          '[토지랑] 조각 백태 1kg H': hOf('[토지랑] 조각 백태 1kg'),
          '[토지랑] 조각 백태 1kg H 기대': 6900,
          '[토지랑] 호라산밀칩 H': hOf('[토지랑] 호라산밀칩'),
          기타거래처_되읽기_행수: (etcBack.data.values || []).filter(
            (r) => String(r[0] ?? '').trim() !== '',
          ).length,
          연결행_H_숫자계산됨: computed,
          연결행_H_숫자아님: notNumber,
          연결됐지만_g없음: noGram,
          비고:
            notNumber > 0
              ? 'H가 숫자가 아닌 행이 있습니다. 원가표미러 IMPORTRANGE 액세스 허용 여부를 확인하세요.'
              : 'g 있는 전 연결행 정상 계산',
        },
      })
    }

    // ── init5: 채널DB·비용DB 구축 + 봉투 컬럼 + 마진계산 탭 (멱등) ──
    if (action === 'init5') {
      const sheets = getSheets()

      // ── 1. 탭 확보 ────────────────────────────────────────────
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      for (const t of [PRICE_TAB, '채널DB', '비용DB', ETC_TAB, MAP_TAB]) {
        if (!idByTitle.has(t)) throw new Error(`'${t}' 탭이 없습니다. init1~init4 를 먼저 실행하세요.`)
      }
      if (!idByTitle.has(MARGIN_TAB)) {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: MARGIN_TAB } } }] },
        })
        const p = res.data.replies?.[0]?.addSheet?.properties
        if (p?.sheetId == null) throw new Error(`'${MARGIN_TAB}' 탭 생성 실패`)
        idByTitle.set(MARGIN_TAB, p.sheetId)
      }
      const marginId = idByTitle.get(MARGIN_TAB) as number
      const priceId = idByTitle.get(PRICE_TAB) as number
      const channelId = idByTitle.get('채널DB') as number
      const costDbId = idByTitle.get('비용DB') as number

      // ── 2. 단가DB N열 '봉투' 산출 (A~M 은 건드리지 않음) ───────
      // 토지랑 브랜드 전체 N · 원료 미연결(매입 완제품) N · 나머지 Y
      const bagCol: Cell[][] = []
      let bagY = 0
      let bagN = 0
      alias.rows.forEach((a) => {
        const aliasText = String(a[0] ?? '').trim()
        const brand = String(a[1] ?? '').trim()
        let rid = String(a[8] ?? '').trim()
        if (aliasText.includes('깬서리태')) rid = '유기농_깬 서리태'
        const spec = linkByAlias.get(aliasText)
        if (spec) rid = spec.rid
        const useBag = brand !== '토지랑' && rid !== ''
        if (useBag) bagY++
        else bagN++
        bagCol.push([useBag ? 'Y' : 'N'])
      })
      const priceLast = 1 + alias.rows.length // R169
      const chLast = 1 + CHANNELS.length // R18

      // ── 3. 마진계산 수식 ──────────────────────────────────────
      const DB = `'${PRICE_TAB}'!$A$2:$N$${priceLast}`
      const CH = `'채널DB'!$A$2:$C$${chLast}`
      const COSTDB = `'비용DB'!$A$2:$B$50`
      const SHIP = `'원가표미러'!$D$2:$F$4` // 규격/박스/택배 (헤더 D1:F1 제외)
      const vd = (r: number, c: number) => `VLOOKUP($A${r},${DB},${c},FALSE)`
      const isTax = (r: number) => `IFERROR(${vd(r, 11)},"")="과세"`
      const bagRate = `IFERROR(VLOOKUP("${COST_DB_BAG}",${COSTDB},2,FALSE),0)`
      const warnRate = `IFERROR(VLOOKUP("${COST_DB_WARN}",${COSTDB},2,FALSE),0)`

      const colFG: Cell[][] = []
      const colIR: Cell[][] = []
      for (let r = 2; r <= 1 + MARGIN_ROWS; r++) {
        // F 원가 — 소포장 공급가(H) 우선, 없으면 매입가(J). 둘 다 없으면 빈칸
        const f =
          `=IF(OR($A${r}="",$C${r}=""),"",IFERROR(` +
          `IF(ISNUMBER(${vd(r, 8)}),${vd(r, 8)}*$C${r},IF(ISNUMBER(${vd(r, 10)}),${vd(r, 10)}*$C${r},""))` +
          `,""))`
        // G 봉투 — 단가DB N열이 Y 인 행만 봉투단가 × 봉수
        const g =
          `=IF(OR($A${r}="",$C${r}=""),"",IF(IFERROR(${vd(r, 14)},"N")="Y",${bagRate}*$C${r},0))`
        colFG.push([f, g])

        const i = `=IF($H${r}="","",IF($H${r}="없음",0,IFERROR(VLOOKUP($H${r},${SHIP},2,FALSE),"")))`
        const j = `=IF($H${r}="","",IF($H${r}="없음",0,IFERROR(VLOOKUP($H${r},${SHIP},3,FALSE),"")))`
        // K 수수료율 — 채널DB VAT포함율. 채널DB 미입력이면 '미입력'
        const k =
          `=IF($B${r}="","",IFERROR(IF(VLOOKUP($B${r},${CH},3,FALSE)="","미입력",` +
          `VLOOKUP($B${r},${CH},3,FALSE)),"미입력"))`
        const l = `=IF(OR($B${r}="",$D${r}=""),"",IF(ISNUMBER($K${r}),$D${r}*$K${r}/100,"확인필요"))`
        const m =
          `=IF(OR($A${r}="",$C${r}="",$D${r}="",$H${r}=""),"",` +
          `IF(AND(ISNUMBER($F${r}),ISNUMBER($G${r}),ISNUMBER($I${r}),ISNUMBER($J${r}),ISNUMBER($L${r})),` +
          `$F${r}+$G${r}+$I${r}+$J${r}+$L${r},"확인필요"))`
        // N 마진 — 과세면 판매가에서 부가세 제외(×10/11)
        const n = `=IF(NOT(ISNUMBER($M${r})),"",IF(${isTax(r)},$D${r}*10/11,$D${r})-$M${r})`
        const o = `=IF(OR(NOT(ISNUMBER($N${r})),$D${r}=""),"",$N${r}/$D${r})`
        const p = `=IF(OR(NOT(ISNUMBER($N${r})),$N${r}=0),"",$D${r}/$N${r})`
        // Q 권장판매가 — 목표마진율(E) 입력 시에만
        const q =
          `=IF(OR($E${r}="",NOT(ISNUMBER($F${r})),NOT(ISNUMBER($K${r}))),"",IFERROR(` +
          `($F${r}+$G${r}+$I${r}+$J${r})/(IF(${isTax(r)},10/11,1)-$K${r}/100-$E${r}/100),""))`
        const s =
          `=IF($A${r}="","",IF($K${r}="미입력","${ST_NO_FEE}",IF($F${r}="","${ST_NO_COST}",` +
          `IF(AND(ISNUMBER($O${r}),$O${r}<${warnRate}/100),"${ST_LOW}",""))))`
        colIR.push([i, j, k, l, m, n, o, p, q, s])
      }
      const marginLast = 1 + MARGIN_ROWS // R301

      // ── 4. 값·수식 기록 ───────────────────────────────────────
      await sheets.spreadsheets.values.clear({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('채널DB')}!A1:E1000`,
        requestBody: {},
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            // 채널DB
            { range: `${quote('채널DB')}!A1:E1`, values: [CHANNEL_HEADER] },
            {
              range: `${quote('채널DB')}!A2:B${chLast}`,
              values: CHANNELS.map(([name, fee]) => [name, fee]),
            },
            // 비용DB (헤더는 init1 에서 세팅됨)
            { range: `${quote('비용DB')}!A2:D${1 + COST_DB_ROWS.length}`, values: COST_DB_ROWS },
            // 단가DB N열 — A~M 은 손대지 않음
            { range: `${quote(PRICE_TAB)}!N1`, values: [['봉투']] },
            { range: `${quote(PRICE_TAB)}!N2:N${priceLast}`, values: bagCol },
            // 마진계산 헤더 + 사용법
            { range: `${quote(MARGIN_TAB)}!A1:R1`, values: [MARGIN_HEADER] },
            { range: `${quote(MARGIN_TAB)}!T1`, values: [[MARGIN_USAGE]] },
            // 예시 행 (입력 컬럼만)
            {
              range: `${quote(MARGIN_TAB)}!A2:D2`,
              values: [
                [
                  MARGIN_SAMPLE.alias,
                  MARGIN_SAMPLE.channel,
                  MARGIN_SAMPLE.bongsu,
                  MARGIN_SAMPLE.price,
                ],
              ],
            },
            { range: `${quote(MARGIN_TAB)}!H2`, values: [[MARGIN_SAMPLE.size]] },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote('채널DB')}!C2:C${chLast}`, values: CHANNELS.map((_, i) => [`=IF($B${2 + i}="","",ROUND($B${2 + i}*1.1,2))`]) },
            { range: `${quote(MARGIN_TAB)}!F2:G${marginLast}`, values: colFG },
            { range: `${quote(MARGIN_TAB)}!I2:R${marginLast}`, values: colIR },
          ],
        },
      })

      // ── 5. 서식 · 검증 · 조건부서식 ───────────────────────────
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const headerFmt = {
        userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
        },
      }
      const HEADER_FIELDS =
        'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor'
      const numFmt = (pattern: string) => ({
        userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } },
      })
      const bg = (r: number, g: number, b: number) => ({
        userEnteredFormat: { backgroundColor: { red: r, green: g, blue: b } },
      })
      const listRule = (values: string[]) => ({
        condition: {
          type: 'ONE_OF_LIST',
          values: values.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false,
      })
      const rangeRule = (ref: string) => ({
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: ref }] },
        showCustomUi: true,
        strict: false,
      })
      const dataRange = grid(marginId, 1, marginLast, 0, 18)

      const requests: any[] = [
        // 채널DB — 헤더 + 수수료율/VAT포함율 % 표기(값은 5.8 그대로)
        { repeatCell: { range: grid(channelId, 0, 1, 0, 5), cell: headerFmt, fields: HEADER_FIELDS } },
        {
          repeatCell: {
            range: grid(channelId, 1, chLast, 1, 3),
            cell: numFmt('0.00"%"'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 비용DB 헤더
        { repeatCell: { range: grid(costDbId, 0, 1, 0, 4), cell: headerFmt, fields: HEADER_FIELDS } },
        // 단가DB N열 헤더 + Y/N 드롭다운
        { repeatCell: { range: grid(priceId, 0, 1, 13, 14), cell: headerFmt, fields: HEADER_FIELDS } },
        {
          setDataValidation: {
            range: grid(priceId, 1, priceLast, 13, 14),
            rule: listRule(['Y', 'N']),
          },
        },
        // 마진계산 — 기존 서식/검증 초기화 후 재적용
        { setDataValidation: { range: grid(marginId, 1, marginLast, 0, 18) } },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 0, 18),
            cell: {},
            fields: 'userEnteredFormat',
          },
        },
        { repeatCell: { range: grid(marginId, 0, 1, 0, 18), cell: headerFmt, fields: HEADER_FIELDS } },
        // 입력 컬럼 A~E · H 흰색 / 자동 컬럼 F~G · I~R 옅은 회색
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 0, 5),
            cell: bg(1, 1, 1),
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 7, 8),
            cell: bg(1, 1, 1),
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 5, 7),
            cell: bg(0.94, 0.94, 0.94),
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 8, 18),
            cell: bg(0.94, 0.94, 0.94),
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
        // 드롭다운 — 별칭 / 채널 / 규격
        {
          setDataValidation: {
            range: grid(marginId, 1, marginLast, 0, 1),
            rule: rangeRule(`='${PRICE_TAB}'!$A$2:$A$${priceLast}`),
          },
        },
        {
          setDataValidation: {
            range: grid(marginId, 1, marginLast, 1, 2),
            rule: rangeRule(`='채널DB'!$A$2:$A$${chLast}`),
          },
        },
        {
          setDataValidation: {
            range: grid(marginId, 1, marginLast, 7, 8),
            rule: listRule(SIZE_OPTIONS),
          },
        },
        // 숫자 서식: 판매가 D · 원가 F · 봉투 G
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 3, 4),
            cell: numFmt('#,##0'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 5, 7),
            cell: numFmt('#,##0'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 목표마진율 E · 수수료율 K → % 표기 (값은 20 / 6.38 그대로)
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 4, 5),
            cell: numFmt('0.0"%"'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 10, 11),
            cell: numFmt('0.00"%"'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 박스 I · 택배 J · 수수료 L · 총비용 M · 마진 N
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 8, 10),
            cell: numFmt('#,##0'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 11, 14),
            cell: numFmt('#,##0'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 마진율 O(비율) · BEP ROAS P(비율) · 권장판매가 Q
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 14, 15),
            cell: numFmt('0.0%'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 15, 16),
            cell: numFmt('0%'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: grid(marginId, 1, marginLast, 16, 17),
            cell: numFmt('#,##0'),
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 조건부서식 — 기존 규칙 제거 후 재등록 (멱등)
        { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
        { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
        {
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [dataRange],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [{ userEnteredValue: `=$R2="${ST_LOW}"` }],
                },
                format: { backgroundColor: { red: 0.98, green: 0.85, blue: 0.85 } },
              },
            },
          },
        },
        {
          addConditionalFormatRule: {
            index: 1,
            rule: {
              ranges: [dataRange],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [{ userEnteredValue: `=$R2="${ST_NO_FEE}"` }],
                },
                format: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 } },
              },
            },
          },
        },
      ]

      // 조건부서식 삭제는 규칙이 없으면 에러 → 별도 배치로 먼저 시도하고 실패는 무시
      const delRules = requests.splice(
        requests.findIndex((r) => r.deleteConditionalFormatRule),
        2,
      )
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: delRules },
        })
      } catch {
        /* 기존 규칙 없음 — 최초 실행 */
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: { requests },
      })

      // ── 6. 탭 순서 재배치 + 숨김 ──────────────────────────────
      const orderReqs: any[] = []
      TAB_ORDER.forEach((t, i) => {
        const id = idByTitle.get(t)
        if (id != null) {
          orderReqs.push({
            updateSheetProperties: { properties: { sheetId: id, index: i }, fields: 'index' },
          })
        }
      })
      for (const t of TAB_HIDDEN) {
        const id = idByTitle.get(t)
        if (id != null) {
          orderReqs.push({
            updateSheetProperties: { properties: { sheetId: id, hidden: true }, fields: 'hidden' },
          })
        }
      }
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: { requests: orderReqs },
      })

      // ── 7. 되읽어 검증 (예시 행 R2) ───────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:R2`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const row = back.data.values?.[0] || []
      const at = (c: number) => row[c]
      const r1 = (v: any) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)
      const finalMeta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(title,index,hidden))',
      })

      return NextResponse.json({
        ok: true,
        message: '채널DB·비용DB 구축 + 봉투 컬럼 + 마진계산 탭 완료',
        summary: {
          채널DB_행수: CHANNELS.length,
          비용DB_행수: COST_DB_ROWS.length,
          단가DB_봉투Y: bagY,
          단가DB_봉투N: bagN,
          마진계산_수식행: MARGIN_ROWS,
        },
        verify: {
          'F 원가': at(5),
          'F 기대': 13800,
          'G 봉투': at(6),
          'G 기대': 150,
          'I 박스': at(8),
          'I 기대': 427,
          'J 택배': at(9),
          'J 기대': 2100,
          'K 수수료율': at(10),
          'K 기대': 6.38,
          'L 수수료': r1(at(11)),
          'L 기대': 1524.8,
          'M 총비용': r1(at(12)),
          'M 기대': 18001.8,
          'N 마진': r1(at(13)),
          'N 기대': 5898.2,
          'O 마진율%': typeof at(14) === 'number' ? Math.round(at(14) * 1000) / 10 : at(14),
          'O 기대%': 24.7,
          'P BEP ROAS%': typeof at(15) === 'number' ? Math.round(at(15) * 100) : at(15),
          'P 기대%': 405,
          'R 상태': at(17),
        },
        tabs: (finalMeta.data.sheets || []).map((s) => ({
          title: s.properties?.title,
          index: s.properties?.index,
          hidden: s.properties?.hidden || false,
        })),
      })
    }

    // ── init6: 마진계산 채널 우선 재배치 + 기본 필터 (멱등) ────────
    if (action === 'init6') {
      const sheets = getSheets()

      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      if (!idByTitle.has(MARGIN_TAB)) {
        throw new Error(`'${MARGIN_TAB}' 탭이 없습니다. init5 를 먼저 실행하세요.`)
      }
      const marginId = idByTitle.get(MARGIN_TAB) as number
      const priceId = idByTitle.get(PRICE_TAB)
      const chId = idByTitle.get('채널DB')
      if (priceId == null || chId == null) {
        throw new Error('단가DB / 채널DB 탭이 없습니다. init1~init5 를 먼저 실행하세요.')
      }
      const priceLast = 1 + alias.rows.length // R169
      const chLast = 1 + CHANNELS.length // R18
      const marginLast = 1 + MARGIN_ROWS // R301

      // ── 1. 기존 입력값 읽기 (A~E, H) ──────────────────────────
      // 현재 배치: A 별칭 / B 채널 / C 봉수 / D 판매가 / E 목표마진율 / H 규격
      // 이미 init6 이 한 번 돌았으면 A 가 채널이므로, 채널DB 목록에 있는지로 방향을 판별한다.
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:H${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const curRows = cur.data.values || []
      const channelNames = new Set(CHANNELS.map(([n]) => n))
      const aliasNames = new Set(alias.rows.map((r) => String(r[0] ?? '').trim()))
      let swapCount = 0
      let keepCount = 0
      let undecided = 0
      const inputAE: Cell[][] = []
      const inputH: Cell[][] = []
      for (let i = 0; i < MARGIN_ROWS; i++) {
        const r = curRows[i] || []
        const c0 = String(r[0] ?? '').trim()
        const c1 = String(r[1] ?? '').trim()
        // 스왑 여부 판정: A 가 별칭이면 스왑, 이미 채널이면 그대로
        let chan: Cell
        let al: Cell
        if (c0 === '' && c1 === '') {
          chan = ''
          al = ''
        } else if (aliasNames.has(c0) || channelNames.has(c1)) {
          // A 가 별칭이거나 B 가 채널 → 옛 배치. 스왑한다
          chan = r[1] ?? ''
          al = r[0] ?? ''
          swapCount++
        } else if (aliasNames.has(c1) || channelNames.has(c0)) {
          // 이미 새 배치
          chan = r[0] ?? ''
          al = r[1] ?? ''
          keepCount++
        } else {
          // 어느 목록에도 없는 수기 값 — 재실행 시 앞뒤로 뒤집히지 않도록 그대로 둔다
          chan = r[0] ?? ''
          al = r[1] ?? ''
          undecided++
        }
        inputAE.push([chan, al, r[2] ?? '', r[3] ?? '', r[4] ?? ''])
        inputH.push([r[7] ?? ''])
      }
      const filledRows = inputAE.filter((r) => r.some((v) => String(v).trim() !== '')).length

      // ── 2. 새 배치 수식 ($A 채널 / $B 별칭) ────────────────────
      const DB = `'${PRICE_TAB}'!$A$2:$N$${priceLast}`
      const CH = `'채널DB'!$A$2:$C$${chLast}`
      const COSTDB = `'비용DB'!$A$2:$B$50`
      const SHIP = `'원가표미러'!$D$2:$F$4`
      const vd = (r: number, c: number) => `VLOOKUP($B${r},${DB},${c},FALSE)`
      const isTax = (r: number) => `IFERROR(${vd(r, 11)},"")="과세"`
      const bagRate = `IFERROR(VLOOKUP("${COST_DB_BAG}",${COSTDB},2,FALSE),0)`
      const warnRate = `IFERROR(VLOOKUP("${COST_DB_WARN}",${COSTDB},2,FALSE),0)`

      const colFG: Cell[][] = []
      const colIR: Cell[][] = []
      for (let r = 2; r <= marginLast; r++) {
        const f =
          `=IF(OR($B${r}="",$C${r}=""),"",IFERROR(` +
          `IF(ISNUMBER(${vd(r, 8)}),${vd(r, 8)}*$C${r},IF(ISNUMBER(${vd(r, 10)}),${vd(r, 10)}*$C${r},""))` +
          `,""))`
        const g = `=IF(OR($B${r}="",$C${r}=""),"",IF(IFERROR(${vd(r, 14)},"N")="Y",${bagRate}*$C${r},0))`
        colFG.push([f, g])

        const i = `=IF($H${r}="","",IF($H${r}="없음",0,IFERROR(VLOOKUP($H${r},${SHIP},2,FALSE),"")))`
        const j = `=IF($H${r}="","",IF($H${r}="없음",0,IFERROR(VLOOKUP($H${r},${SHIP},3,FALSE),"")))`
        const k =
          `=IF($A${r}="","",IFERROR(IF(VLOOKUP($A${r},${CH},3,FALSE)="","미입력",` +
          `VLOOKUP($A${r},${CH},3,FALSE)),"미입력"))`
        const l = `=IF(OR($A${r}="",$D${r}=""),"",IF(ISNUMBER($K${r}),$D${r}*$K${r}/100,"확인필요"))`
        const m =
          `=IF(OR($B${r}="",$C${r}="",$D${r}="",$H${r}=""),"",` +
          `IF(AND(ISNUMBER($F${r}),ISNUMBER($G${r}),ISNUMBER($I${r}),ISNUMBER($J${r}),ISNUMBER($L${r})),` +
          `$F${r}+$G${r}+$I${r}+$J${r}+$L${r},"확인필요"))`
        const n = `=IF(NOT(ISNUMBER($M${r})),"",IF(${isTax(r)},$D${r}*10/11,$D${r})-$M${r})`
        const o = `=IF(OR(NOT(ISNUMBER($N${r})),$D${r}=""),"",$N${r}/$D${r})`
        const p = `=IF(OR(NOT(ISNUMBER($N${r})),$N${r}=0),"",$D${r}/$N${r})`
        const q =
          `=IF(OR($E${r}="",NOT(ISNUMBER($F${r})),NOT(ISNUMBER($K${r}))),"",IFERROR(` +
          `($F${r}+$G${r}+$I${r}+$J${r})/(IF(${isTax(r)},10/11,1)-$K${r}/100-$E${r}/100),""))`
        const s =
          `=IF($B${r}="","",IF($K${r}="미입력","${ST_NO_FEE}",IF($F${r}="","${ST_NO_COST}",` +
          `IF(AND(ISNUMBER($O${r}),$O${r}<${warnRate}/100),"${ST_LOW}",""))))`
        colIR.push([i, j, k, l, m, n, o, p, q, s])
      }

      // ── 3. 기록 (입력값 먼저 되돌려 놓고 수식 재배치) ──────────
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(MARGIN_TAB)}!A1:R1`, values: [MARGIN_HEADER_V2] },
            { range: `${quote(MARGIN_TAB)}!T1`, values: [[MARGIN_USAGE_V2]] },
            { range: `${quote(MARGIN_TAB)}!A2:E${marginLast}`, values: inputAE },
            { range: `${quote(MARGIN_TAB)}!H2:H${marginLast}`, values: inputH },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(MARGIN_TAB)}!F2:G${marginLast}`, values: colFG },
            { range: `${quote(MARGIN_TAB)}!I2:R${marginLast}`, values: colIR },
          ],
        },
      })

      // ── 4. 서식 · 검증 · 조건부서식 재적용 ────────────────────
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const headerFmt = {
        userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
        },
      }
      const HEADER_FIELDS = 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor'
      const numFmt = (pattern: string) => ({
        userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } },
      })
      const bg = (r: number, g: number, b: number) => ({
        userEnteredFormat: { backgroundColor: { red: r, green: g, blue: b } },
      })
      const listRule = (values: string[]) => ({
        condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      })
      const rangeRule = (ref: string) => ({
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: ref }] },
        showCustomUi: true,
        strict: false,
      })
      const dataRange = grid(marginId, 1, marginLast, 0, 18)
      const fmt = (c0: number, c1: number, cell: any, fields: string) => ({
        repeatCell: { range: grid(marginId, 1, marginLast, c0, c1), cell, fields },
      })
      const BGF = 'userEnteredFormat.backgroundColor'
      const NF = 'userEnteredFormat.numberFormat'

      // 기존 조건부서식 2건 제거 (없으면 무시)
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            requests: [
              { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
              { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
            ],
          },
        })
      } catch {
        /* 최초 실행 등 기존 규칙 없음 */
      }
      // 기존 기본필터 제거 (없으면 무시) — setBasicFilter 전에 정리
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [{ clearBasicFilter: { sheetId: marginId } }] },
        })
      } catch {
        /* 기존 필터 없음 */
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            { setDataValidation: { range: grid(marginId, 1, marginLast, 0, 18) } },
            { repeatCell: { range: dataRange, cell: {}, fields: 'userEnteredFormat' } },
            {
              repeatCell: {
                range: grid(marginId, 0, 1, 0, 18),
                cell: headerFmt,
                fields: HEADER_FIELDS,
              },
            },
            // 입력 A~E · H 흰색 / 자동 F~G · I~R 옅은 회색
            fmt(0, 5, bg(1, 1, 1), BGF),
            fmt(7, 8, bg(1, 1, 1), BGF),
            fmt(5, 7, bg(0.94, 0.94, 0.94), BGF),
            fmt(8, 18, bg(0.94, 0.94, 0.94), BGF),
            // 드롭다운 — A 채널 / B 별칭 / H 규격
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 0, 1),
                rule: rangeRule(`='채널DB'!$A$2:$A$${chLast}`),
              },
            },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 1, 2),
                rule: rangeRule(`='${PRICE_TAB}'!$A$2:$A$${priceLast}`),
              },
            },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 7, 8),
                rule: listRule(SIZE_OPTIONS),
              },
            },
            // 숫자 서식 (컬럼 위치는 init5 와 동일 — A/B 스왑은 텍스트 컬럼끼리라 영향 없음)
            fmt(3, 4, numFmt('#,##0'), NF), // D 판매가
            fmt(4, 5, numFmt('0.0"%"'), NF), // E 목표마진율
            fmt(5, 7, numFmt('#,##0'), NF), // F 원가 · G 봉투
            fmt(8, 10, numFmt('#,##0'), NF), // I 박스 · J 택배
            fmt(10, 11, numFmt('0.00"%"'), NF), // K 수수료율
            fmt(11, 14, numFmt('#,##0'), NF), // L 수수료 · M 총비용 · N 마진
            fmt(14, 15, numFmt('0.0%'), NF), // O 마진율
            fmt(15, 16, numFmt('0%'), NF), // P BEP ROAS
            fmt(16, 17, numFmt('#,##0'), NF), // Q 권장판매가
            // 조건부서식
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [dataRange],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$R2="${ST_LOW}"` }],
                    },
                    format: { backgroundColor: { red: 0.98, green: 0.85, blue: 0.85 } },
                  },
                },
              },
            },
            {
              addConditionalFormatRule: {
                index: 1,
                rule: {
                  ranges: [dataRange],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$R2="${ST_NO_FEE}"` }],
                    },
                    format: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 } },
                  },
                },
              },
            },
            // 기본 필터 A1:R301
            { setBasicFilter: { filter: { range: grid(marginId, 0, marginLast, 0, 18) } } },
          ],
        },
      })

      // ── 5. 기본 탭('시트1') 정리 — 비어 있을 때만 삭제 ─────────
      let defaultTabDeleted: string | null = null
      let defaultTabKept: string | null = null
      for (const t of DEFAULT_TABS) {
        const id = idByTitle.get(t)
        if (id == null) continue
        const chk = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(t)}!A1:Z100`,
        })
        const hasData = (chk.data.values || []).some((row) =>
          (row || []).some((v) => String(v ?? '').trim() !== ''),
        )
        if (hasData) {
          // 값이 있으면 지우지 않는다 (되돌릴 수 없는 삭제)
          defaultTabKept = t
          continue
        }
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [{ deleteSheet: { sheetId: id } }] },
        })
        defaultTabDeleted = t
      }

      // ── 6. 되읽어 검증 ────────────────────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:R${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const bv = back.data.values || []
      const sampleIdx = bv.findIndex(
        (r) => String(r[1] ?? '').trim() === MARGIN_SAMPLE.alias,
      )
      const sample = sampleIdx >= 0 ? bv[sampleIdx] : []
      const r1 = (v: any) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)
      const finalMeta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(title,index,hidden))',
      })

      return NextResponse.json({
        ok: true,
        message: '마진계산 채널 우선 재배치 + 기본 필터 적용 완료',
        summary: {
          입력행_보존: filledRows,
          스왑_적용행: swapCount,
          이미_새배치행: keepCount,
          판정보류_그대로둠: undecided,
          수식_재배치행: MARGIN_ROWS,
          기본탭_삭제: defaultTabDeleted,
          기본탭_보존_값있음: defaultTabKept,
        },
        verify: {
          예시행_위치: sampleIdx >= 0 ? `R${sampleIdx + 2}` : '못 찾음',
          'A 채널': sample[0],
          'A 기대': MARGIN_SAMPLE.channel,
          'B 별칭': sample[1],
          'B 기대': MARGIN_SAMPLE.alias,
          'C 봉수': sample[2],
          'D 판매가': sample[3],
          'H 규격': sample[7],
          'M 총비용': r1(sample[12]),
          'M 기대': 18001.8,
          'O 마진율%':
            typeof sample[14] === 'number' ? Math.round(sample[14] * 1000) / 10 : sample[14],
          'O 기대%': 24.7,
          'R 상태': sample[17],
        },
        tabs: (finalMeta.data.sheets || []).map((s) => ({
          title: s.properties?.title,
          index: s.properties?.index,
          hidden: s.properties?.hidden || false,
        })),
      })
    }

    // ── init7: 마진계산 수수료율(K) 수기 전환 (멱등) ──────────────
    if (action === 'init7') {
      const sheets = getSheets()

      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      if (!idByTitle.has(MARGIN_TAB)) {
        throw new Error(`'${MARGIN_TAB}' 탭이 없습니다. init5~init6 을 먼저 실행하세요.`)
      }
      if (!idByTitle.has('채널DB')) {
        throw new Error("'채널DB' 탭이 없습니다. init5 를 먼저 실행하세요.")
      }
      const marginId = idByTitle.get(MARGIN_TAB) as number
      const marginLast = 1 + MARGIN_ROWS // R301

      // ── 1. 현재 K열 원문(수식/값) + 입력 컬럼 읽기 ────────────
      const [kRaw, inputRaw] = await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(MARGIN_TAB)}!K2:K${marginLast}`,
          valueRenderOption: 'FORMULA',
        }),
        sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(MARGIN_TAB)}!A2:H${marginLast}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        }),
      ])
      const kRows = kRaw.data.values || []
      const inRows = inputRaw.data.values || []

      // 수식(= 로 시작)은 제거 대상. 숫자로 해석되는 값만 수기 입력으로 보고 보존한다.
      const keepK: { row: number; value: number }[] = []
      let formulaCleared = 0
      for (let i = 0; i < MARGIN_ROWS; i++) {
        const v = (kRows[i] || [])[0]
        const t = String(v ?? '').trim()
        if (t === '') continue
        if (t.startsWith('=')) {
          formulaCleared++
          continue
        }
        const n = Number(t)
        if (Number.isFinite(n)) keepK.push({ row: 2 + i, value: n })
      }

      // 예시행(서리태·쿠팡 윙) 위치 — B 별칭 기준, 없으면 R2
      const sampleIdx = inRows.findIndex((r) => String(r?.[1] ?? '').trim() === MARGIN_SAMPLE.alias)
      const sampleRow = sampleIdx >= 0 ? sampleIdx + 2 : 2

      // 테스트 행 — A~E·H 가 모두 빈 행 (R3 우선)
      const isEmptyRow = (i: number) => {
        const r = inRows[i] || []
        return [0, 1, 2, 3, 4, 7].every((c) => String(r[c] ?? '').trim() === '')
      }
      let testRow = 0
      for (let i = 1; i < MARGIN_ROWS; i++) {
        if (isEmptyRow(i) && !keepK.some((k) => k.row === 2 + i)) {
          testRow = 2 + i
          break
        }
      }

      // ── 2. K열 수식 제거 → 빈칸 (수기 숫자만 되돌려 씀) ────────
      await sheets.spreadsheets.values.clear({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!K2:K${marginLast}`,
        requestBody: {},
      })
      const kWrites = keepK
        .filter((k) => k.row !== sampleRow)
        .map((k) => ({ range: `${quote(MARGIN_TAB)}!K${k.row}`, values: [[k.value]] as Cell[][] }))
      // 예시행은 6.38 고정 (서리태·쿠팡 윙 예시 유지용)
      kWrites.push({ range: `${quote(MARGIN_TAB)}!K${sampleRow}`, values: [[6.38]] })

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(MARGIN_TAB)}!A1:R1`, values: [MARGIN_HEADER_V3] },
            { range: `${quote(MARGIN_TAB)}!T1`, values: [[MARGIN_USAGE_V3]] },
            { range: `${quote('채널DB')}!F1`, values: [[CHANNEL_NOTE]] },
            ...kWrites,
          ],
        },
      })

      // ── 3. L~R 수식 재기록 (K 는 참조만, 빈칸이면 전부 빈칸) ───
      const COSTDB = `'비용DB'!$A$2:$B$50`
      const priceLast = 1 + alias.rows.length
      const DB = `'${PRICE_TAB}'!$A$2:$N$${priceLast}`
      const vd = (r: number, c: number) => `VLOOKUP($B${r},${DB},${c},FALSE)`
      const isTax = (r: number) => `IFERROR(${vd(r, 11)},"")="과세"`
      const warnRate = `IFERROR(VLOOKUP("${COST_DB_WARN}",${COSTDB},2,FALSE),0)`

      const colLR: Cell[][] = []
      for (let r = 2; r <= marginLast; r++) {
        // L 수수료 — K 빈칸이면 빈칸 (숫자 아닌 값만 '확인필요')
        const l =
          `=IF(OR($A${r}="",$D${r}="",$K${r}=""),"",IF(ISNUMBER($K${r}),$D${r}*$K${r}/100,"확인필요"))`
        const m =
          `=IF(OR($B${r}="",$C${r}="",$D${r}="",$H${r}="",$K${r}=""),"",` +
          `IF(AND(ISNUMBER($F${r}),ISNUMBER($G${r}),ISNUMBER($I${r}),ISNUMBER($J${r}),ISNUMBER($L${r})),` +
          `$F${r}+$G${r}+$I${r}+$J${r}+$L${r},"확인필요"))`
        const n = `=IF(NOT(ISNUMBER($M${r})),"",IF(${isTax(r)},$D${r}*10/11,$D${r})-$M${r})`
        const o = `=IF(OR(NOT(ISNUMBER($N${r})),$D${r}=""),"",$N${r}/$D${r})`
        const p = `=IF(OR(NOT(ISNUMBER($N${r})),$N${r}=0),"",$D${r}/$N${r})`
        // Q 권장판매가 — K 빈칸이면 빈칸 (ISNUMBER 판정 그대로 유지)
        const q =
          `=IF(OR($E${r}="",NOT(ISNUMBER($F${r})),NOT(ISNUMBER($K${r}))),"",IFERROR(` +
          `($F${r}+$G${r}+$I${r}+$J${r})/(IF(${isTax(r)},10/11,1)-$K${r}/100-$E${r}/100),""))`
        // R 상태 — 수수료율 미입력 판정을 "B·D 입력됐는데 K 빈칸" 으로 변경
        const s =
          `=IF($B${r}="","",IF(AND($D${r}<>"",$K${r}=""),"${ST_NO_FEE}",IF($F${r}="","${ST_NO_COST}",` +
          `IF(AND(ISNUMBER($O${r}),$O${r}<${warnRate}/100),"${ST_LOW}",""))))`
        colLR.push([l, m, n, o, p, q, s])
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [{ range: `${quote(MARGIN_TAB)}!L2:R${marginLast}`, values: colLR }],
        },
      })

      // ── 4. K열 서식 — 입력 컬럼이므로 흰 배경 + 0.00"%" 유지 ───
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
            {
              repeatCell: {
                range: grid(marginId, 1, marginLast, 10, 11),
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 1 },
                    numberFormat: { type: 'NUMBER', pattern: '0.00"%"' },
                  },
                },
                fields:
                  'userEnteredFormat.backgroundColor,userEnteredFormat.numberFormat',
              },
            },
          ],
        },
      })

      // ── 5. 테스트 행 — K 빈칸 → '수수료율 미입력' 확인 후 삭제 ──
      let testStatus: any = '테스트 행 자리 없음(빈 행 없음)'
      if (testRow > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              {
                range: `${quote(MARGIN_TAB)}!A${testRow}:D${testRow}`,
                values: [[MARGIN_SAMPLE.channel, MARGIN_SAMPLE.alias, 1, 23900]],
              },
            ],
          },
        })
        const t = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(MARGIN_TAB)}!R${testRow}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        testStatus = t.data.values?.[0]?.[0] ?? ''
        // 테스트 입력만 제거 (F~R 은 수식이므로 건드리지 않는다)
        await sheets.spreadsheets.values.batchClear({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            ranges: [
              `${quote(MARGIN_TAB)}!A${testRow}:E${testRow}`,
              `${quote(MARGIN_TAB)}!H${testRow}`,
            ],
          },
        })
      }

      // ── 6. 되읽어 검증 (예시행) ───────────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A${sampleRow}:R${sampleRow}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const row = back.data.values?.[0] || []
      const r1 = (v: any) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)
      const hdr = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!K1`,
      })

      return NextResponse.json({
        ok: true,
        message: '마진계산 수수료율(K) 수기 입력 전환 완료',
        summary: {
          K_수식_제거행: formulaCleared,
          K_수기값_보존행: keepK.filter((k) => k.row !== sampleRow).length,
          예시행: `R${sampleRow}`,
          테스트행: testRow > 0 ? `R${testRow}` : null,
          L_R_수식_재기록행: MARGIN_ROWS,
        },
        verify: {
          K1_헤더: hdr.data.values?.[0]?.[0],
          K1_기대: '수수료율%(부가포함)',
          'K 수수료율': row[10],
          'K 기대': 6.38,
          'L 수수료': r1(row[11]),
          'L 기대': 1524.8,
          'M 총비용': r1(row[12]),
          'M 기대': 18001.8,
          'N 마진': r1(row[13]),
          'N 기대': 5898.2,
          'O 마진율%': typeof row[14] === 'number' ? Math.round(row[14] * 1000) / 10 : row[14],
          'O 기대%': 24.7,
          'R 상태': row[17],
          테스트행_R상태: testStatus,
          테스트행_기대: ST_NO_FEE,
        },
      })
    }

    // ── init8: 배송비 수수료 구조 추가 (E 고객배송비 / N 배송비수수료) ──
    if (action === 'init8') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      for (const t of [MARGIN_TAB, '채널DB', PRICE_TAB]) {
        if (!idByTitle.has(t)) throw new Error(`'${t}' 탭이 없습니다.`)
      }
      const marginId = idByTitle.get(MARGIN_TAB) as number
      const chDbId = idByTitle.get('채널DB') as number
      const marginLast = 1 + MARGIN_ROWS // R301

      // ── 1. 사전 스냅샷 (읽기) ─────────────────────────────────
      const pre = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(MARGIN_TAB)}!A1:Z1`,
          `${quote(MARGIN_TAB)}!A2:T4`,
          `${quote('채널DB')}!A1:Z1`,
          `${quote('채널DB')}!A2:C200`,
          `${quote(PRICE_TAB)}!A2:A1000`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const pv = pre.data.valueRanges || []
      const hdr = (pv[0]?.values?.[0] || []).map((h) => String(h ?? '').trim())
      const beforeRows = pv[1]?.values || []
      const chHdr = (pv[2]?.values?.[0] || []).map((h) => String(h ?? '').trim())
      const chRows = pv[3]?.values || []
      const priceCol = pv[4]?.values || []

      const alreadyInserted = hdr.includes(SHIP_IN_COL)
      // 채널DB 마지막 데이터 행 / 단가DB 마지막 행
      let chLast = 1
      chRows.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') chLast = 2 + i
      })
      let priceLast = 1
      priceCol.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') priceLast = 2 + i
      })
      // 스마트스토어 행 위치 + VAT포함율 확인
      const ssIdx = chRows.findIndex((r) => String(r?.[0] ?? '').trim() === SMART_STORE)
      const ssRow = ssIdx >= 0 ? ssIdx + 2 : 0
      const ssVat = ssIdx >= 0 ? chRows[ssIdx]?.[2] : null

      // ── 2. 입력/자동 컬럼 배경색 복사용 읽기 ──────────────────
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!A2:T2`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const cells = gd.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
      const bgOf = (i: number) => cells[i]?.effectiveFormat?.backgroundColor
      const inputBg = bgOf(3) || { red: 1, green: 1, blue: 1 } // D 판매가
      const autoBg = (alreadyInserted ? bgOf(6) : bgOf(5)) || { red: 0.94, green: 0.94, blue: 0.94 }

      // ── 3. 컬럼 삽입 (멱등 — 헤더에 '고객배송비' 없을 때만) ────
      if (!alreadyInserted) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            requests: [
              {
                insertDimension: {
                  range: { sheetId: marginId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
                  inheritFromBefore: true,
                },
              },
              {
                insertDimension: {
                  range: { sheetId: marginId, dimension: 'COLUMNS', startIndex: 13, endIndex: 14 },
                  inheritFromBefore: true,
                },
              },
            ],
          },
        })
      }

      // ── 4. 채널DB 배송비수수료율 컬럼 (기존 값·행 수정 없음) ───
      let shipRateIdx = chHdr.findIndex((h) => h === SHIP_RATE_COL)
      if (shipRateIdx < 0) shipRateIdx = 7 // H열 (F=안내문구 / G=수기메모 점유)
      const shipRateLetter = String.fromCharCode(65 + shipRateIdx)
      const chWrites: { range: string; values: Cell[][] }[] = [
        { range: `${quote('채널DB')}!${shipRateLetter}1`, values: [[SHIP_RATE_COL]] },
      ]
      if (ssRow > 0) {
        chWrites.push({
          range: `${quote('채널DB')}!${shipRateLetter}${ssRow}`,
          values: [[SMART_STORE_SHIP_RATE]],
        })
      }

      // ── 5. 마진계산 수식 (신 배치 A~T) ────────────────────────
      const DB = `'${PRICE_TAB}'!$A$2:$N$${priceLast}`
      const CH3 = `'채널DB'!$A$2:$C$${chLast}`
      const CHH = `'채널DB'!$A:$${shipRateLetter}`
      const COSTDB = `'비용DB'!$A$2:$B$50`
      const SHIP = `'원가표미러'!$D$2:$F$4`
      const vd = (r: number, c: number) => `VLOOKUP($B${r},${DB},${c},FALSE)`
      const isTax = (r: number) => `IFERROR(${vd(r, 11)},"")="과세"`
      const bagRate = `IFERROR(VLOOKUP("${COST_DB_BAG}",${COSTDB},2,FALSE),0)`
      const warnRate = `IFERROR(VLOOKUP("${COST_DB_WARN}",${COSTDB},2,FALSE),0)`

      const colGH: Cell[][] = [] // G 원가 · H 봉투
      const colJK: Cell[][] = [] // J 박스 · K 택배
      const colMT: Cell[][] = [] // M 수수료 ~ T 상태
      for (let r = 2; r <= marginLast; r++) {
        colGH.push([
          `=IF(OR($B${r}="",$C${r}=""),"",IFERROR(` +
            `IF(ISNUMBER(${vd(r, 8)}),${vd(r, 8)}*$C${r},IF(ISNUMBER(${vd(r, 10)}),${vd(r, 10)}*$C${r},""))` +
            `,""))`,
          `=IF(OR($B${r}="",$C${r}=""),"",IF(IFERROR(${vd(r, 14)},"N")="Y",${bagRate}*$C${r},0))`,
        ])
        colJK.push([
          `=IF($I${r}="","",IF($I${r}="없음",0,IFERROR(VLOOKUP($I${r},${SHIP},2,FALSE),"")))`,
          `=IF($I${r}="","",IF($I${r}="없음",0,IFERROR(VLOOKUP($I${r},${SHIP},3,FALSE),"")))`,
        ])
        // M 수수료 (L 수수료율 참조)
        const m = `=IF(OR($A${r}="",$D${r}="",$L${r}=""),"",IF(ISNUMBER($L${r}),$D${r}*$L${r}/100,"확인필요"))`
        // N 배송비수수료 — 채널DB 배송비수수료율 빈칸이면 0
        const n = `=IF(OR($A${r}="",$E${r}="",$E${r}=0),0,$E${r}*IFERROR(VLOOKUP($A${r},${CHH},${shipRateIdx + 1},0),0)/100)`
        // O 총비용 — 배송비수수료 N 합산
        const o =
          `=IF(OR($B${r}="",$C${r}="",$D${r}="",$I${r}="",$L${r}=""),"",` +
          `IF(AND(ISNUMBER($G${r}),ISNUMBER($H${r}),ISNUMBER($J${r}),ISNUMBER($K${r}),ISNUMBER($M${r}),ISNUMBER($N${r})),` +
          `$G${r}+$H${r}+$J${r}+$K${r}+$M${r}+$N${r},"확인필요"))`
        // P 마진 — 매출에 고객배송비 포함 (빈칸이면 0)
        const p =
          `=IF(NOT(ISNUMBER($O${r})),"",IF(${isTax(r)},($D${r}+N($E${r}))*10/11,$D${r}+N($E${r}))-$O${r})`
        // Q 마진율 — 분모는 판매가 D 유지
        const q = `=IF(OR(NOT(ISNUMBER($P${r})),$D${r}=""),"",$P${r}/$D${r})`
        // R BEP ROAS — 광고센터 표기 기준 보정 ×1.1
        const rr = `=IF(OR(NOT(ISNUMBER($P${r})),$P${r}=0),"",$D${r}/$P${r}*1.1)`
        // S 권장판매가 — 기준 D 판매가 유지
        const s =
          `=IF(OR($F${r}="",NOT(ISNUMBER($G${r})),NOT(ISNUMBER($L${r}))),"",IFERROR(` +
          `($G${r}+$H${r}+$J${r}+$K${r})/(IF(${isTax(r)},10/11,1)-$L${r}/100-$F${r}/100),""))`
        // T 상태 — 스마트스토어는 L 자동참조이므로 미입력 경고 제외
        const t =
          `=IF($B${r}="","",IF(AND($D${r}<>"",$L${r}="",$A${r}<>"${SMART_STORE}"),"${ST_NO_FEE}",` +
          `IF($G${r}="","${ST_NO_COST}",IF(AND(ISNUMBER($Q${r}),$Q${r}<${warnRate}/100),"${ST_LOW}",""))))`
        colMT.push([m, n, o, p, q, rr, s, t])
      }

      // ── 6. L 수수료율 — 빈칸 행에만 스마트스토어 자동참조 수식 ──
      const lNow = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!L2:L${marginLast}`,
        valueRenderOption: 'FORMULA',
      })
      const lRows = lNow.data.values || []
      const lAuto = (r: number) =>
        `=IF($A${r}<>"${SMART_STORE}","",IFERROR(VLOOKUP($A${r},${CH3},3,FALSE),""))`
      const colL: Cell[][] = []
      let lKept = 0
      let lFilled = 0
      for (let i = 0; i < MARGIN_ROWS; i++) {
        const raw = (lRows[i] || [])[0]
        const t = String(raw ?? '').trim()
        if (t !== '' && !t.startsWith('=')) {
          colL.push([raw as Cell]) // 수기값 그대로 보존
          lKept++
        } else {
          colL.push([lAuto(2 + i)])
          lFilled++
        }
      }

      // ── 7. 기록 ───────────────────────────────────────────────
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(MARGIN_TAB)}!A1:T1`, values: [MARGIN_HEADER_V4] },
            { range: `${quote(MARGIN_TAB)}!V1`, values: [[MARGIN_USAGE_V4]] },
            ...chWrites,
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(MARGIN_TAB)}!G2:H${marginLast}`, values: colGH },
            { range: `${quote(MARGIN_TAB)}!J2:K${marginLast}`, values: colJK },
            { range: `${quote(MARGIN_TAB)}!L2:L${marginLast}`, values: colL },
            { range: `${quote(MARGIN_TAB)}!M2:T${marginLast}`, values: colMT },
          ],
        },
      })

      // ── 8. 서식 · 검증 · 조건부서식 · 필터 ────────────────────
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const numFmt = (pattern: string) => ({
        userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } },
      })
      const listRule = (vals: string[]) => ({
        condition: { type: 'ONE_OF_LIST', values: vals.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      })
      const rangeRule = (ref: string) => ({
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: ref }] },
        showCustomUi: true,
        strict: false,
      })
      const dataRange = grid(marginId, 1, marginLast, 0, 20)
      const NF = 'userEnteredFormat.numberFormat'

      // 기존 조건부서식 / 기본필터 정리 (없으면 무시)
      for (const reqs of [
        [
          { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
          { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
        ],
        [{ clearBasicFilter: { sheetId: marginId } }],
      ]) {
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: TARGET_SHEET_ID,
            requestBody: { requests: reqs },
          })
        } catch {
          /* 기존 규칙 없음 */
        }
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // 헤더
            {
              repeatCell: {
                range: grid(marginId, 0, 1, 0, 20),
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            // E 고객배송비 — 입력 컬럼 색 복사 + #,##0
            {
              repeatCell: {
                range: grid(marginId, 1, marginLast, 4, 5),
                cell: {
                  userEnteredFormat: {
                    backgroundColor: inputBg,
                    numberFormat: { type: 'NUMBER', pattern: '#,##0' },
                  },
                },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.numberFormat',
              },
            },
            // N 배송비수수료 — 자동 컬럼 색 + #,##0
            {
              repeatCell: {
                range: grid(marginId, 1, marginLast, 13, 14),
                cell: {
                  userEnteredFormat: {
                    backgroundColor: autoBg,
                    numberFormat: { type: 'NUMBER', pattern: '#,##0' },
                  },
                },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.numberFormat',
              },
            },
            // 숫자 서식 재확정 (밀린 열 기준)
            { repeatCell: { range: grid(marginId, 1, marginLast, 3, 4), cell: numFmt('#,##0'), fields: NF } }, // D 판매가
            { repeatCell: { range: grid(marginId, 1, marginLast, 5, 6), cell: numFmt('0.0"%"'), fields: NF } }, // F 목표마진율
            { repeatCell: { range: grid(marginId, 1, marginLast, 6, 8), cell: numFmt('#,##0'), fields: NF } }, // G 원가 · H 봉투
            { repeatCell: { range: grid(marginId, 1, marginLast, 9, 11), cell: numFmt('#,##0'), fields: NF } }, // J 박스 · K 택배
            { repeatCell: { range: grid(marginId, 1, marginLast, 11, 12), cell: numFmt('0.00"%"'), fields: NF } }, // L 수수료율
            { repeatCell: { range: grid(marginId, 1, marginLast, 12, 13), cell: numFmt('#,##0'), fields: NF } }, // M 수수료
            { repeatCell: { range: grid(marginId, 1, marginLast, 14, 16), cell: numFmt('#,##0'), fields: NF } }, // O 총비용 · P 마진
            { repeatCell: { range: grid(marginId, 1, marginLast, 16, 17), cell: numFmt('0.0%'), fields: NF } }, // Q 마진율
            { repeatCell: { range: grid(marginId, 1, marginLast, 17, 18), cell: numFmt('0%'), fields: NF } }, // R BEP ROAS
            { repeatCell: { range: grid(marginId, 1, marginLast, 18, 19), cell: numFmt('#,##0'), fields: NF } }, // S 권장판매가
            // 드롭다운 재적용 — A 채널 / B 별칭 / I 규격, E·N 은 검증 해제
            { setDataValidation: { range: grid(marginId, 1, marginLast, 4, 5) } },
            { setDataValidation: { range: grid(marginId, 1, marginLast, 13, 14) } },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 0, 1),
                rule: rangeRule(`='채널DB'!$A$2:$A$${chLast}`),
              },
            },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 1, 2),
                rule: rangeRule(`='${PRICE_TAB}'!$A$2:$A$${priceLast}`),
              },
            },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 8, 9),
                rule: listRule(SIZE_OPTIONS),
              },
            },
            // 조건부서식 — 상태는 T열
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [dataRange],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$T2="${ST_LOW}"` }],
                    },
                    format: { backgroundColor: { red: 0.98, green: 0.85, blue: 0.85 } },
                  },
                },
              },
            },
            {
              addConditionalFormatRule: {
                index: 1,
                rule: {
                  ranges: [dataRange],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$T2="${ST_NO_FEE}"` }],
                    },
                    format: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 } },
                  },
                },
              },
            },
            // 채널DB 새 헤더 볼드 + % 서식
            {
              repeatCell: {
                range: grid(chDbId, 0, 1, shipRateIdx, shipRateIdx + 1),
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            {
              repeatCell: {
                range: grid(chDbId, 1, chLast, shipRateIdx, shipRateIdx + 1),
                cell: numFmt('0.00"%"'),
                fields: NF,
              },
            },
            { setBasicFilter: { filter: { range: grid(marginId, 0, marginLast, 0, 20) } } },
          ],
        },
      })

      // ── 9. 테스트 행 (스마트스토어 + 고객배송비 3000) ──────────
      const inNow = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:I${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const inRows = inNow.data.values || []
      let testRow = 0
      for (let i = 0; i < MARGIN_ROWS; i++) {
        const r = inRows[i] || []
        if ([0, 1, 2, 3, 4, 5, 8].every((c) => String(r[c] ?? '').trim() === '')) {
          testRow = 2 + i
          break
        }
      }
      let testOut: any = { note: '빈 행 없음 — 테스트 생략' }
      if (testRow > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              {
                range: `${quote(MARGIN_TAB)}!A${testRow}:E${testRow}`,
                values: [[SMART_STORE, MARGIN_SAMPLE.alias, 1, 23900, 3000]],
              },
              { range: `${quote(MARGIN_TAB)}!I${testRow}`, values: [[MARGIN_SAMPLE.size]] },
            ],
          },
        })
        const tr = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(MARGIN_TAB)}!A${testRow}:T${testRow}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const t = tr.data.values?.[0] || []
        const num = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
        testOut = {
          행: `R${testRow}`,
          'L 수수료율_자동': num(t[11]),
          'L 기대': 8.94,
          'E 고객배송비': t[4],
          'N 배송비수수료': num(t[13]),
          'N 기대': 91.5,
          'O 총비용': num(t[14]),
          'P 마진': num(t[15]),
          'Q 마진율%': typeof t[16] === 'number' ? Math.round(t[16] * 1000) / 10 : t[16],
          'R BEP ROAS%': typeof t[17] === 'number' ? Math.round(t[17] * 1000) / 10 : t[17],
          'R×Q 불변식(=1.1 이어야)':
            typeof t[16] === 'number' && typeof t[17] === 'number'
              ? Math.round(t[16] * t[17] * 1000) / 1000
              : null,
          '마진율30%_환산_BEP%': 110,
          'T 상태': t[19] ?? '',
        }
        await sheets.spreadsheets.values.batchClear({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            ranges: [
              `${quote(MARGIN_TAB)}!A${testRow}:F${testRow}`,
              `${quote(MARGIN_TAB)}!I${testRow}`,
            ],
          },
        })
      }

      // ── 10. 기존 행 전후 비교 (R2~R4) ─────────────────────────
      const post = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:T4`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const afterRows = post.data.values || []
      const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
      // 삽입 전 배치: M(12) 총비용 / N(13) 마진 / O(14) 마진율
      // 삽입 후 배치: O(14) 총비용 / P(15) 마진 / Q(16) 마진율
      const beforeIdx = alreadyInserted ? [14, 15, 16] : [12, 13, 14]
      const compare = [0, 1, 2].map((i) => {
        const b = beforeRows[i] || []
        const a = afterRows[i] || []
        return {
          행: `R${2 + i}`,
          채널: a[0] ?? '',
          'E 고객배송비': a[4] ?? '',
          'N 배송비수수료': r2(a[13]),
          총비용_전: r2(b[beforeIdx[0]]),
          총비용_후: r2(a[14]),
          마진_전: r2(b[beforeIdx[1]]),
          마진_후: r2(a[15]),
          마진율_전: r2(b[beforeIdx[2]]),
          마진율_후: r2(a[16]),
          'T 상태': a[19] ?? '',
          동일: r2(b[beforeIdx[1]]) === r2(a[15]) && r2(b[beforeIdx[0]]) === r2(a[14]),
        }
      })

      const finalHdr = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A1:V1`,
      })

      return NextResponse.json({
        ok: true,
        message: '배송비 수수료 구조 추가 완료 (E 고객배송비 / N 배송비수수료)',
        summary: {
          컬럼삽입: alreadyInserted ? '이미 적용됨(중복 삽입 안 함)' : 'E·N 2개 삽입',
          채널DB_배송비수수료율_컬럼: `${shipRateLetter}열`,
          스마트스토어_행: ssRow ? `R${ssRow}` : '못 찾음',
          스마트스토어_VAT포함율: ssVat,
          VAT포함율_기대: 8.94,
          채널DB_마지막행: chLast,
          단가DB_마지막행: priceLast,
          L_수기값_보존: lKept,
          L_자동수식_적용: lFilled,
          수식_적용행: MARGIN_ROWS,
        },
        헤더: finalHdr.data.values?.[0] || [],
        검증1_스마트스토어_테스트행: testOut,
        검증2_기존행_전후비교: compare,
      })
    }

    // ── init9: 목표마진율%를 권장판매가 앞(R열)으로 이동 ──────────
    if (action === 'init9') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      for (const t of [MARGIN_TAB, '채널DB', PRICE_TAB]) {
        if (!idByTitle.has(t)) throw new Error(`'${t}' 탭이 없습니다.`)
      }
      const marginId = idByTitle.get(MARGIN_TAB) as number
      const marginLast = 1 + MARGIN_ROWS

      // ── 1. 사전 스냅샷 ────────────────────────────────────────
      const pre = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(MARGIN_TAB)}!A1:T1`,
          `${quote(MARGIN_TAB)}!A2:T4`,
          `${quote('채널DB')}!A1:Z1`,
          `${quote('채널DB')}!A2:A200`,
          `${quote(PRICE_TAB)}!A2:A1000`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const pv = pre.data.valueRanges || []
      const hdr = (pv[0]?.values?.[0] || []).map((h) => String(h ?? '').trim())
      const beforeRows = pv[1]?.values || []
      const chHdr = (pv[2]?.values?.[0] || []).map((h) => String(h ?? '').trim())
      const chCol = pv[3]?.values || []
      const priceCol = pv[4]?.values || []

      const alreadyMoved = hdr[17] === GOAL_COL
      if (!alreadyMoved && hdr[5] !== GOAL_COL) {
        throw new Error(
          `예상 배치가 아닙니다 (F1='${hdr[5]}', R1='${hdr[17]}'). init8 을 먼저 실행하세요.`,
        )
      }
      let chLast = 1
      chCol.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') chLast = 2 + i
      })
      let priceLast = 1
      priceCol.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') priceLast = 2 + i
      })
      let shipRateIdx = chHdr.findIndex((h) => h === SHIP_RATE_COL)
      if (shipRateIdx < 0) shipRateIdx = 7
      const shipRateLetter = String.fromCharCode(65 + shipRateIdx)

      // ── 2. 배경색 표본 (이동 전: D 입력 / G 원가 자동) ─────────
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!A2:T2`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const cells = gd.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
      const bgOf = (i: number) => cells[i]?.effectiveFormat?.backgroundColor
      const inputBg = bgOf(3) || { red: 1, green: 1, blue: 1 }
      const autoBg = (alreadyMoved ? bgOf(5) : bgOf(6)) || { red: 0.94, green: 0.94, blue: 0.94 }

      // ── 3. 컬럼 이동 (멱등) ───────────────────────────────────
      if (!alreadyMoved) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            requests: [
              {
                moveDimension: {
                  source: {
                    sheetId: marginId,
                    dimension: 'COLUMNS',
                    startIndex: 5,
                    endIndex: 6,
                  },
                  // 이동 전 좌표 기준 — 18 지정 시 최종 인덱스 17(R열)에 안착
                  destinationIndex: 18,
                },
              },
            ],
          },
        })
      }

      // ── 4. 신 배치 수식 ───────────────────────────────────────
      const DB = `'${PRICE_TAB}'!$A$2:$N$${priceLast}`
      const CH3 = `'채널DB'!$A$2:$C$${chLast}`
      const CHH = `'채널DB'!$A:$${shipRateLetter}`
      const COSTDB = `'비용DB'!$A$2:$B$50`
      const SHIP = `'원가표미러'!$D$2:$F$4`
      const vd = (r: number, c: number) => `VLOOKUP($B${r},${DB},${c},FALSE)`
      const isTax = (r: number) => `IFERROR(${vd(r, 11)},"")="과세"`
      const bagRate = `IFERROR(VLOOKUP("${COST_DB_BAG}",${COSTDB},2,FALSE),0)`
      const warnRate = `IFERROR(VLOOKUP("${COST_DB_WARN}",${COSTDB},2,FALSE),0)`

      const colFG: Cell[][] = [] // F 원가 · G 봉투
      const colIJ: Cell[][] = [] // I 박스 · J 택배
      const colLQ: Cell[][] = [] // L 수수료 ~ Q BEP
      const colST: Cell[][] = [] // S 권장판매가 · T 상태
      for (let r = 2; r <= marginLast; r++) {
        colFG.push([
          `=IF(OR($B${r}="",$C${r}=""),"",IFERROR(` +
            `IF(ISNUMBER(${vd(r, 8)}),${vd(r, 8)}*$C${r},IF(ISNUMBER(${vd(r, 10)}),${vd(r, 10)}*$C${r},""))` +
            `,""))`,
          `=IF(OR($B${r}="",$C${r}=""),"",IF(IFERROR(${vd(r, 14)},"N")="Y",${bagRate}*$C${r},0))`,
        ])
        colIJ.push([
          `=IF($H${r}="","",IF($H${r}="없음",0,IFERROR(VLOOKUP($H${r},${SHIP},2,FALSE),"")))`,
          `=IF($H${r}="","",IF($H${r}="없음",0,IFERROR(VLOOKUP($H${r},${SHIP},3,FALSE),"")))`,
        ])
        // L 수수료 (K 수수료율 참조)
        const l = `=IF(OR($A${r}="",$D${r}="",$K${r}=""),"",IF(ISNUMBER($K${r}),$D${r}*$K${r}/100,"확인필요"))`
        // M 배송비수수료 — 채널DB 배송비수수료율 빈칸이면 0
        const m = `=IF(OR($A${r}="",$E${r}="",$E${r}=0),0,$E${r}*IFERROR(VLOOKUP($A${r},${CHH},${shipRateIdx + 1},0),0)/100)`
        // N 총비용
        const n =
          `=IF(OR($B${r}="",$C${r}="",$D${r}="",$H${r}="",$K${r}=""),"",` +
          `IF(AND(ISNUMBER($F${r}),ISNUMBER($G${r}),ISNUMBER($I${r}),ISNUMBER($J${r}),ISNUMBER($L${r}),ISNUMBER($M${r})),` +
          `$F${r}+$G${r}+$I${r}+$J${r}+$L${r}+$M${r},"확인필요"))`
        // O 마진 — 매출에 고객배송비 포함 (빈칸이면 0)
        const o =
          `=IF(NOT(ISNUMBER($N${r})),"",IF(${isTax(r)},($D${r}+N($E${r}))*10/11,$D${r}+N($E${r}))-$N${r})`
        // P 마진율 — 분모 판매가 D 유지
        const p = `=IF(OR(NOT(ISNUMBER($O${r})),$D${r}=""),"",$O${r}/$D${r})`
        // Q BEP ROAS — 광고센터 표기 기준 ×1.1
        const q = `=IF(OR(NOT(ISNUMBER($O${r})),$O${r}=0),"",$D${r}/$O${r}*1.1)`
        colLQ.push([l, m, n, o, p, q])
        // S 권장판매가 — 목표마진율 $R 참조
        const s =
          `=IF(OR($R${r}="",NOT(ISNUMBER($F${r})),NOT(ISNUMBER($K${r}))),"",IFERROR(` +
          `($F${r}+$G${r}+$I${r}+$J${r})/(IF(${isTax(r)},10/11,1)-$K${r}/100-$R${r}/100),""))`
        // T 상태 — 스마트스토어는 K 자동참조이므로 미입력 경고 제외
        const t =
          `=IF($B${r}="","",IF(AND($D${r}<>"",$K${r}="",$A${r}<>"${SMART_STORE}"),"${ST_NO_FEE}",` +
          `IF($F${r}="","${ST_NO_COST}",IF(AND(ISNUMBER($P${r}),$P${r}<${warnRate}/100),"${ST_LOW}",""))))`
        colST.push([s, t])
      }

      // ── 5. K 수수료율 — 수기값 보존, 빈칸에만 자동참조 수식 ────
      const kNow = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!K2:K${marginLast}`,
        valueRenderOption: 'FORMULA',
      })
      const kRows = kNow.data.values || []
      const colK: Cell[][] = []
      let kKept = 0
      let kAuto = 0
      for (let i = 0; i < MARGIN_ROWS; i++) {
        const raw = (kRows[i] || [])[0]
        const t = String(raw ?? '').trim()
        if (t !== '' && !t.startsWith('=')) {
          colK.push([raw as Cell])
          kKept++
        } else {
          colK.push([
            `=IF($A${2 + i}<>"${SMART_STORE}","",IFERROR(VLOOKUP($A${2 + i},${CH3},3,FALSE),""))`,
          ])
          kAuto++
        }
      }

      // ── 6. 기록 (R 목표마진율 = 입력 컬럼, 손대지 않음) ────────
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${quote(MARGIN_TAB)}!A1:T1`, values: [MARGIN_HEADER_V5] },
            { range: `${quote(MARGIN_TAB)}!V1`, values: [[MARGIN_USAGE_V5]] },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(MARGIN_TAB)}!F2:G${marginLast}`, values: colFG },
            { range: `${quote(MARGIN_TAB)}!I2:J${marginLast}`, values: colIJ },
            { range: `${quote(MARGIN_TAB)}!K2:K${marginLast}`, values: colK },
            { range: `${quote(MARGIN_TAB)}!L2:Q${marginLast}`, values: colLQ },
            { range: `${quote(MARGIN_TAB)}!S2:T${marginLast}`, values: colST },
          ],
        },
      })

      // ── 7. 서식 · 드롭다운 · 조건부서식 · 필터 재적용 ──────────
      const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
        sheetId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      const numFmt = (pattern: string) => ({
        userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } },
      })
      const bgCell = (c: any) => ({ userEnteredFormat: { backgroundColor: c } })
      const listRule = (vals: string[]) => ({
        condition: { type: 'ONE_OF_LIST', values: vals.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      })
      const rangeRule = (ref: string) => ({
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: ref }] },
        showCustomUi: true,
        strict: false,
      })
      const dataRange = grid(marginId, 1, marginLast, 0, 20)
      const NF = 'userEnteredFormat.numberFormat'
      const BGF = 'userEnteredFormat.backgroundColor'
      const fmt = (c0: number, c1: number, cell: any, fields: string) => ({
        repeatCell: { range: grid(marginId, 1, marginLast, c0, c1), cell, fields },
      })

      for (const reqs of [
        [
          { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
          { deleteConditionalFormatRule: { sheetId: marginId, index: 0 } },
        ],
        [{ clearBasicFilter: { sheetId: marginId } }],
      ]) {
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: TARGET_SHEET_ID,
            requestBody: { requests: reqs },
          })
        } catch {
          /* 기존 규칙 없음 */
        }
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: grid(marginId, 0, 1, 0, 20),
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            // 배경 — 입력 A~E · H 규격 · K 수수료율 · R 목표마진율
            fmt(0, 5, bgCell(inputBg), BGF),
            fmt(7, 8, bgCell(inputBg), BGF),
            fmt(10, 11, bgCell(inputBg), BGF),
            fmt(17, 18, bgCell(inputBg), BGF),
            // 배경 — 자동 F·G / I·J / L~Q / S·T
            fmt(5, 7, bgCell(autoBg), BGF),
            fmt(8, 10, bgCell(autoBg), BGF),
            fmt(11, 17, bgCell(autoBg), BGF),
            fmt(18, 20, bgCell(autoBg), BGF),
            // 숫자 서식
            fmt(3, 5, numFmt('#,##0'), NF), // D 판매가 · E 고객배송비
            fmt(5, 7, numFmt('#,##0'), NF), // F 원가 · G 봉투
            fmt(8, 10, numFmt('#,##0'), NF), // I 박스 · J 택배
            fmt(10, 11, numFmt('0.00"%"'), NF), // K 수수료율
            fmt(11, 13, numFmt('#,##0'), NF), // L 수수료 · M 배송비수수료
            fmt(13, 15, numFmt('#,##0'), NF), // N 총비용 · O 마진
            fmt(15, 16, numFmt('0.0%'), NF), // P 마진율
            fmt(16, 17, numFmt('0%'), NF), // Q BEP ROAS
            fmt(17, 18, numFmt('0.0"%"'), NF), // R 목표마진율
            fmt(18, 19, numFmt('#,##0'), NF), // S 권장판매가
            // 드롭다운 — 자동 컬럼 검증 해제 후 A/B/H 재적용
            { setDataValidation: { range: grid(marginId, 1, marginLast, 4, 5) } },
            { setDataValidation: { range: grid(marginId, 1, marginLast, 12, 13) } },
            { setDataValidation: { range: grid(marginId, 1, marginLast, 17, 18) } },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 0, 1),
                rule: rangeRule(`='채널DB'!$A$2:$A`), // 열린 범위 — 채널 추가 시 자동 반영
              },
            },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 1, 2),
                rule: rangeRule(`='${PRICE_TAB}'!$A$2:$A$${priceLast}`),
              },
            },
            {
              setDataValidation: {
                range: grid(marginId, 1, marginLast, 7, 8),
                rule: listRule(SIZE_OPTIONS),
              },
            },
            // 조건부서식 — 상태 T열
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [dataRange],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$T2="${ST_LOW}"` }],
                    },
                    format: { backgroundColor: { red: 0.98, green: 0.85, blue: 0.85 } },
                  },
                },
              },
            },
            {
              addConditionalFormatRule: {
                index: 1,
                rule: {
                  ranges: [dataRange],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [{ userEnteredValue: `=$T2="${ST_NO_FEE}"` }],
                    },
                    format: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 } },
                  },
                },
              },
            },
            { setBasicFilter: { filter: { range: grid(marginId, 0, marginLast, 0, 20) } } },
          ],
        },
      })

      // ── 8. 테스트 행 — 목표마진율 입력 시 권장판매가 작동 확인 ──
      const inNow = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:R${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const inRows = inNow.data.values || []
      let testRow = 0
      for (let i = 0; i < MARGIN_ROWS; i++) {
        const r = inRows[i] || []
        if ([0, 1, 2, 3, 4, 7, 17].every((c) => String(r[c] ?? '').trim() === '')) {
          testRow = 2 + i
          break
        }
      }
      let testOut: any = { note: '빈 행 없음 — 테스트 생략' }
      if (testRow > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              {
                range: `${quote(MARGIN_TAB)}!A${testRow}:E${testRow}`,
                values: [[SMART_STORE, MARGIN_SAMPLE.alias, 1, 23900, 3000]],
              },
              { range: `${quote(MARGIN_TAB)}!H${testRow}`, values: [[MARGIN_SAMPLE.size]] },
              { range: `${quote(MARGIN_TAB)}!R${testRow}`, values: [[20]] },
            ],
          },
        })
        const tr = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(MARGIN_TAB)}!A${testRow}:T${testRow}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const t = tr.data.values?.[0] || []
        const n2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
        testOut = {
          행: `R${testRow}`,
          'K 수수료율_자동': n2(t[10]),
          'M 배송비수수료': n2(t[12]),
          'N 총비용': n2(t[13]),
          'O 마진': n2(t[14]),
          'P 마진율%': typeof t[15] === 'number' ? Math.round(t[15] * 1000) / 10 : t[15],
          'Q BEP%': typeof t[16] === 'number' ? Math.round(t[16] * 1000) / 10 : t[16],
          'R 목표마진율': t[17],
          'S 권장판매가': n2(t[18]),
          S_숫자여부: typeof t[18] === 'number',
          'T 상태': t[19] ?? '',
        }
        await sheets.spreadsheets.values.batchClear({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            ranges: [
              `${quote(MARGIN_TAB)}!A${testRow}:E${testRow}`,
              `${quote(MARGIN_TAB)}!H${testRow}`,
              `${quote(MARGIN_TAB)}!R${testRow}`,
            ],
          },
        })
      }

      // ── 9. 기존 행 전후 비교 ──────────────────────────────────
      const post = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:T4`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const afterRows = post.data.values || []
      const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
      // 이동 전 인덱스: 총비용14 마진15 마진율16 BEP17 / 이동 후: 13,14,15,16
      const bIdx = alreadyMoved ? [13, 14, 15, 16] : [14, 15, 16, 17]
      const compare = [0, 1, 2].map((i) => {
        const b = beforeRows[i] || []
        const a = afterRows[i] || []
        const same =
          r2(b[bIdx[0]]) === r2(a[13]) &&
          r2(b[bIdx[1]]) === r2(a[14]) &&
          r2(b[bIdx[2]]) === r2(a[15]) &&
          r2(b[bIdx[3]]) === r2(a[16])
        return {
          행: `R${2 + i}`,
          별칭: a[1] ?? '',
          총비용: [r2(b[bIdx[0]]), r2(a[13])],
          마진: [r2(b[bIdx[1]]), r2(a[14])],
          마진율: [r2(b[bIdx[2]]), r2(a[15])],
          BEP: [r2(b[bIdx[3]]), r2(a[16])],
          'R 목표마진율': a[17] ?? '',
          'T 상태': a[19] ?? '',
          동일: same,
        }
      })
      const finalHdr = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A1:V1`,
      })

      return NextResponse.json({
        ok: true,
        message: '목표마진율% 컬럼 이동 완료 (F → R, 권장판매가 앞)',
        summary: {
          컬럼이동: alreadyMoved ? '이미 적용됨(이동 생략, 수식만 재기록)' : 'F → R 이동',
          채널드롭다운: `'채널DB'!$A$2:$A (열린 범위)`,
          채널DB_마지막행: chLast,
          단가DB_마지막행: priceLast,
          K_수기값_보존: kKept,
          K_자동수식: kAuto,
          수식_적용행: MARGIN_ROWS,
        },
        헤더: finalHdr.data.values?.[0] || [],
        검증1_기존행_전후비교: compare,
        검증2_목표마진율_테스트행: testOut,
      })
    }

    // ── init10: 단가DB 원가표 바로가기 컬럼 (멱등) ────────────────
    if (action === 'init10') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const idByTitle = new Map<string, number>()
      for (const s of meta.data.sheets || []) {
        const p = s.properties
        if (p?.title != null && p.sheetId != null) idByTitle.set(p.title, p.sheetId)
      }
      if (!idByTitle.has(PRICE_TAB)) throw new Error(`'${PRICE_TAB}' 탭이 없습니다.`)
      const priceId = idByTitle.get(PRICE_TAB) as number

      // ── 1. 단가DB 현황 (읽기) ─────────────────────────────────
      const pre = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(PRICE_TAB)}!A1:Z1`,
          `${quote(PRICE_TAB)}!A2:E1000`,
          `${quote(PRICE_TAB)}!H2:J4`,
          `${quote(MAP_TAB)}!I1:I10`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const pv = pre.data.valueRanges || []
      const priceHdr = (pv[0]?.values?.[0] || []).map((h) => String(h ?? '').trim())
      const priceRows = pv[1]?.values || []
      const beforeHIJ = pv[2]?.values || []
      const mapIBefore = pv[3]?.values || []

      let priceLast = 1
      priceRows.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') priceLast = 2 + i
      })
      // 바로가기 컬럼 위치 — 이미 있으면 재사용, 없으면 첫 빈 헤더 열
      let linkIdx = priceHdr.findIndex((h) => h === LINK_COL)
      const alreadyHasCol = linkIdx >= 0
      if (linkIdx < 0) {
        linkIdx = 0
        while (linkIdx < 26 && (priceHdr[linkIdx] ?? '') !== '') linkIdx++
      }
      const linkLetter = String.fromCharCode(65 + linkIdx)

      // ── 2. 진도팜 원가표 — 읽기 전용 (메타 gid + 원료ID 행) ────
      const jMeta = await sheets.spreadsheets.get({
        spreadsheetId: JINDO_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const jTab = (jMeta.data.sheets || []).find(
        (s) => s.properties?.title === JINDO_COST_TAB,
      )?.properties
      if (jTab?.sheetId == null) {
        throw new Error(`진도팜 원가표에 '${JINDO_COST_TAB}' 탭이 없습니다.`)
      }
      const gid = jTab.sheetId
      const jRows = await sheets.spreadsheets.values.get({
        spreadsheetId: JINDO_SHEET_ID,
        range: `${quote(JINDO_COST_TAB)}!A${JINDO_HEADER_ROW + 1}:A500`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const rowByRid = new Map<string, number>()
      ;(jRows.data.values || []).forEach((r, i) => {
        const rid = String(r?.[0] ?? '').trim()
        if (rid && !rowByRid.has(rid)) rowByRid.set(rid, JINDO_HEADER_ROW + 1 + i)
      })

      // ── 3. 링크 컬럼 생성 (원료ID 있는 행만) ──────────────────
      const linkCol: Cell[][] = []
      let linked = 0
      let blank = 0
      const unmatched: string[] = []
      let sampleLink: any = null
      for (let i = 0; i < priceLast - 1; i++) {
        const rid = String(priceRows[i]?.[4] ?? '').trim()
        if (!rid) {
          linkCol.push([''])
          blank++
          continue
        }
        const targetRow = rowByRid.get(rid)
        if (!targetRow) {
          linkCol.push([''])
          if (unmatched.length < 10) unmatched.push(rid)
          continue
        }
        const url = `https://docs.google.com/spreadsheets/d/${JINDO_SHEET_ID}/edit#gid=${gid}&range=A${targetRow}`
        linkCol.push([`=HYPERLINK("${url}","${LINK_TEXT}")`])
        linked++
        if (!sampleLink) {
          sampleLink = {
            단가DB행: `R${2 + i}`,
            별칭: priceRows[i]?.[0] ?? '',
            원료ID: rid,
            원가표_대상행: `R${targetRow}`,
            url,
          }
        }
      }

      // ── 4. 기록 (단가DB O열만 — 기존 A~N 손대지 않음) ─────────
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{ range: `${quote(PRICE_TAB)}!${linkLetter}1`, values: [[LINK_COL]] }],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            {
              range: `${quote(PRICE_TAB)}!${linkLetter}2:${linkLetter}${priceLast}`,
              values: linkCol,
            },
          ],
        },
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: priceId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: linkIdx,
                  endColumnIndex: linkIdx + 1,
                },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            {
              repeatCell: {
                range: {
                  sheetId: priceId,
                  startRowIndex: 1,
                  endRowIndex: priceLast,
                  startColumnIndex: linkIdx,
                  endColumnIndex: linkIdx + 1,
                },
                cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat.horizontalAlignment',
              },
            },
          ],
        },
      })

      // ── 5. 검증 (읽기) ────────────────────────────────────────
      const post = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(PRICE_TAB)}!H2:J4`,
          `${quote(MAP_TAB)}!I1:I10`,
          `${quote(PRICE_TAB)}!A1:Z1`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const qv = post.data.valueRanges || []
      const afterHIJ = qv[0]?.values || []
      const mapIAfter = qv[1]?.values || []
      const hdrAfter = (qv[2]?.values?.[0] || []).map((h) => String(h ?? '').trim())
      const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
      const hijSame = JSON.stringify(beforeHIJ.map((r) => r.map(r2))) ===
        JSON.stringify(afterHIJ.map((r) => r.map(r2)))
      const mapSame = JSON.stringify(mapIBefore) === JSON.stringify(mapIAfter)
      // 발주매핑 I열 수식 원문 확인 (단가DB A열 참조가 유지되는지)
      const mapFx = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MAP_TAB)}!I2`,
        valueRenderOption: 'FORMULA',
      })

      return NextResponse.json({
        ok: true,
        message: `단가DB 원가표 바로가기 컬럼(${linkLetter}열) 적용 완료`,
        summary: {
          컬럼: `${linkLetter}1 = ${LINK_COL}`,
          기존컬럼_존재: alreadyHasCol ? '있음 — 링크만 재기록' : '신규 추가',
          단가DB_마지막행: priceLast,
          링크_생성: linked,
          원료ID_없음_빈칸: blank,
          원료ID_원가표_미매칭: unmatched.length ? unmatched : 0,
          진도팜_원가표_gid: gid,
          진도팜_원가표: 'read-only (메타·A열만 읽음, 쓰기 없음)',
        },
        검증1_샘플링크: sampleLink,
        검증2_단가DB_HIJ_3행: { 전: beforeHIJ, 후: afterHIJ, 동일: hijSame },
        검증3_발주매핑_I열: {
          전: mapIBefore.flat(),
          후: mapIAfter.flat(),
          동일: mapSame,
          I2_수식: mapFx.data.values?.[0]?.[0] ?? '',
        },
        단가DB_헤더: hdrAfter,
      })
    }

    // ── inspect: 읽기 전용 현황 조사 (쓰기 없음) ──────────────────
    if (action === 'inspect') {
      const sheets = getSheets()
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(MARGIN_TAB)}!A1:T4`,
          `${quote(MARGIN_TAB)}!A1:T4`,
          `${quote('채널DB')}!A1:H20`,
          `${quote('비용DB')}!A1:D10`,
          `${quote('원가표미러')}!D1:F4`,
        ],
        valueRenderOption: 'FORMULA',
      })
      const v = res.data.valueRanges || []
      const shown = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A1:T4`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title,gridProperties(columnCount,rowCount)))',
      })
      return NextResponse.json({
        ok: true,
        마진계산_수식: v[0]?.values || [],
        마진계산_값: shown.data.values || [],
        채널DB: v[2]?.values || [],
        비용DB: v[3]?.values || [],
        원가표미러_배송: v[4]?.values || [],
        탭: (meta.data.sheets || []).map((s) => ({
          title: s.properties?.title,
          cols: s.properties?.gridProperties?.columnCount,
          rows: s.properties?.gridProperties?.rowCount,
        })),
      })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (e: any) {
    console.error('[rebuild] error:', e?.message || e)
    return NextResponse.json({ ok: false, error: e?.message || '서버 오류' }, { status: 500 })
  }
}
