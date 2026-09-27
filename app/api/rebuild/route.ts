import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { createHash } from 'crypto'
import aliasData from './alias-data.json'
import mappingData from './mapping-data.json'
import migrationData from './migration-data.json'
import m7Data from './m7-data.json'
import m11Data from './m11-data.json'
import { MASTER_SHEET_ID } from '@/lib/sheet-ids'

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
// init10: 단가DB O2 → 진도팜 원가표 단일 바로가기 (고정 URL, 원가표 미조회)
const JINDO_SHEET_ID = '1L5FDCyvGfULZ4lyjfzcs2W3N1todfEltmWG-tUzMcWg'
const LINK_COL = '원가표 바로가기'
const ETC_TAB_RETIRED = '(폐기)기타거래처 원가표'
// init11: 단가DB J열 의미 전환 (매입가 → 총 공급가)
const PRICE_J_HEADER = '총 공급가'
// init12: 헤더 명확화
const PRICE_J_HEADER_V2 = '총 공급가(소포장)'
// init17: 마진계산 W~Z — 쿠팡 1P 준비 열 (열 삽입 없이 빈 열에 헤더만)
//   U 는 비워둔 채 두고 V1 사용안내 문구는 보존 → 검사·기입 모두 W 부터
const COUPANG_1P_HEADER = ['노출ID', '옵션ID', '소비자가(1P)', '쿠팡마진율(1P)']
const UX_LETTERS = ['W', 'X', 'Y', 'Z', 'AA', 'AB']
// init19: 비용DB 곰표 작업비 3줄 (A4:D6) — B 는 대표님 입력 (2kg 만 600 확정)
const GOMPYO_COST_ROWS: Cell[][] = [
  ['곰표 작업비 500g', '', '원', '곰표 제조 1봉당 소포장 작업비'],
  ['곰표 작업비 1kg', '', '원', '곰표 제조 1봉당 소포장 작업비'],
  ['곰표 작업비 2kg', 600, '원', '곰표 제조 1봉당 소포장 작업비'],
]
// ── 나무_마스터 통합 (m 계열 액션) — 대상 MASTER_SHEET_ID, 원본 3개 파일은 읽기·copyTo 만 ──
const B2B_SHEET_ID = '1nujXWT95QWnYBX1LpSAL1hLL3Uv8MBt7kJDz8i6WbFU'
// m1: 그대로 복사하는 탭 (원본 파일 · 탭 이름) — 복사 순서 = 참조 먼저
const M1_COPIES: { src: string; file: string; tab: string }[] = [
  { src: COST_SHEET_ID, file: '원가표', tab: '진도팜 원가표' },
  { src: COST_SHEET_ID, file: '원가표', tab: '곰표 원가표' },
  { src: TARGET_SHEET_ID, file: '마진리빌드', tab: '발주매핑' },
  { src: B2B_SHEET_ID, file: 'b2b', tab: '상품마스터' },
  { src: B2B_SHEET_ID, file: 'b2b', tab: '쿠팡 센터 주소록' },
  { src: B2B_SHEET_ID, file: 'b2b', tab: '쿠팡 밀크런 가격표' },
  { src: B2B_SHEET_ID, file: 'b2b', tab: '컬리 밀크런 가격표' },
  { src: B2B_SHEET_ID, file: 'b2b', tab: '발주 이력' },
]
const M1_LOG_TAB = '원가 변동 로그'
const M1_LOG_HEADER = ['일시', '종류', '원료ID·항목', '구분', '품목', '변경 전', '변경 후', '적용 시작일', '변경자']
const M1_SRC_UNIT_LOG = '단가 변동 로그' // 일시|원료ID|구분|품목|변경 전|변경 후|적용 시작일|변경자
const M1_SRC_PROC_LOG = '가공비 변동 로그' // 일시|종류|항목|변경 전|변경 후|적용 시작일|변경자
const M1_ORDER = [
  '진도팜 원가표', '곰표 원가표', M1_LOG_TAB,
  // (2단계 탭 자리)
  '상품마스터', '발주매핑', '쿠팡 센터 주소록', '쿠팡 밀크런 가격표', '컬리 밀크런 가격표', '발주 이력',
]
// m2: 단가DB·마진계산·설정 이관
const M2_ORDER = [
  '진도팜 원가표', '곰표 원가표', M1_LOG_TAB, PRICE_TAB, MARGIN_TAB, '설정',
  '상품마스터', '발주매핑', '쿠팡 센터 주소록', '쿠팡 밀크런 가격표', '컬리 밀크런 가격표', '발주 이력',
]
const M2_SETTING_TAB = '설정'
// 비용DB 중 설정 J~M 으로 옮기는 행 (곰표 작업비 3줄은 곰표 원가표 행 작업비로 대체되어 제외)
const M2_COST_KEEP = ['봉투 단가', '경고 기준 마진율']
// 곰표 원료ID 자동 연결 (이 4행만)
const M2_GOMPYO_LINK: Record<string, string> = {
  '[쌀쌀쌀] 병아리콩 2kg': '곰표_병아리콩',
  '[쌀쌀쌀] 캐나다산 병아리콩 1kg': '곰표_병아리콩',
  '[쌀쌀쌀] 캐나다산 렌틸콩 1kg': '곰표_렌틸콩',
  '[쌀쌀쌀] 캐나다산 렌틸콩 2kg': '곰표_렌틸콩',
}
const M2_FORBIDDEN = ['원가표미러', '채널DB', '비용DB', COST_SHEET_ID, TARGET_SHEET_ID, B2B_SHEET_ID, 'docs.google.com']
// m3: 곰표 원료 추가·연결
const M3_GOM_TAB = '곰표 원가표'
const M3_NEW_ITEMS: { item: string; price: number }[] = [
  { item: '귀리', price: 1050 },
  { item: '루피니빈', price: 3800 },
  { item: '치아시드', price: 5900 },
  { item: '파로', price: 4800 },
  { item: '레드렌틸', price: 1800 },
]
const M3_LINKS: Record<string, string> = {
  '[쌀쌀쌀] 레드 렌틸콩 2kg': '곰표_레드렌틸',
  '[쌀쌀쌀] 호주산 레드 스플릿 렌틸콩 1kg': '곰표_레드렌틸',
  '[쌀쌀쌀] 터키 파로 2kg': '곰표_파로',
  '[쌀쌀쌀] 루피니빈 1kg': '곰표_루피니빈',
  '[쌀쌀쌀] 루피니빈 2kg': '곰표_루피니빈',
  '[쌀쌀쌀] 치아시드 500g': '곰표_치아시드',
  '[쌀쌀쌀] 치아시드 1kg': '곰표_치아시드',
  '[쌀쌀쌀] 치아시드 2kg': '곰표_치아시드',
  '[쌀쌀쌀] 캐나다산 귀리 1kg': '곰표_귀리',
  '[쌀쌀쌀] 캐나다산 귀리 2kg': '곰표_귀리',
}
// 단가DB E 선택 목록 — 설정 O열 한 곳에서 원가표 탭들의 원료ID 를 모은다.
// 거래처 원가표 탭이 늘면 이 배열에 ;'새 탭'!A12:A 만 추가하면 된다.
const M3_ID_LIST_CELL = 'O1'
const M3_ID_LIST_HEADER = '원료ID 목록 (단가DB E 선택 목록)'
const M3_ID_LIST_FORMULA = `=UNIQUE(TOCOL({'진도팜 원가표'!A12:A;'${M3_GOM_TAB}'!A12:A},1))`
const M3_ID_LIST_REF = `='설정'!$O$2:$O`
// m4: 중복 별칭 삭제 + 별칭 통일 (단가DB A열이 표준)
const M4_DELETE = '[쌀쌀쌀] 국산 찰흑미 2kg'
const M4_KEEP = '[쌀쌀쌀] 흑미 2kg'
const M4_RENAME: [string, string][] = [
  ['[쌀쌀쌀] 국산 찰흑미 2kg', '[쌀쌀쌀] 흑미 2kg'],
  ['[쌀쌀쌀] 찰흑미 2kg', '[쌀쌀쌀] 흑미 2kg'],
  ['[보배마을] 귀리 10곡 800g', '[보배마을] 귀리혼합10곡 800g'],
  ['[쌀쌀쌀] 렌틸콩 2kg', '[쌀쌀쌀] 캐나다산 렌틸콩 2kg'],
  ['[쌀쌀쌀] 저속식단 2kg', '[쌀쌀쌀] 저속노화 잡곡 2kg 캐귀리'],
  ['[보배마을] 현미 귀리 즉석밥 180g * 6', '[보배마을] 즉석밥 6개'],
  ['[보배마을] 현미 귀리 즉석밥 180g * 24', '[보배마을] 즉석밥 24개'],
]
// 별칭 열 (탭 · 헤더 이름)
const M4_ALIAS_COLS: { tab: string; header: string }[] = [
  { tab: MAP_TAB, header: '표준 별칭' },
  { tab: '상품마스터', header: '별칭' },
  { tab: '발주 이력', header: '상품(별칭)' },
  { tab: MARGIN_TAB, header: '별칭' },
]
// m5: 마진계산 1P 열·행
const M5_PM_TAB = '상품마스터'
// 1P 행 입력 [옵션ID, SKU ID, 봉수] — 옵션ID 빈칸 = 광고 안 하는 1P
const M5_ROWS: [string, string, number][] = [
  ['95687867677', '70438823', 1], ['95693656020', '70438823', 2], ['95693656023', '70438823', 3],
  ['95670768339', '62185201', 1], ['95686834089', '62185201', 2], ['95686834074', '62185201', 3],
  ['95769750935', '67096372', 1], ['95775967172', '67096372', 2], ['95775967168', '67096372', 3],
  ['95768169394', '41667341', 1], ['95774490088', '41667341', 2],
  ['95907154741', '77752344', 1], ['95907173477', '77754189', 1],
  ['95637041436', '47846695', 1], ['95641151017', '47846695', 2],
  ['95637333653', '50470320', 1], ['95641300858', '50470320', 2],
  ['95664489857', '56115225', 1], ['95669821249', '56115225', 2],
  ['', '67166778', 1], ['', '70439507', 1], ['', '79665140', 1], ['', '79933349', 1],
  ['', '79911593', 1], ['', '80677477', 1], ['', '54146619', 1],
]
// m8: 마진계산 보정 — [행, 기대 B(별칭), 바꿀 값]
const M8_SPEC: [number, string][] = [
  [89, '[보배마을] 강황가루 100g'], [102, '[보배마을] 오트밀 350g'], [112, '[보배마을] 오트밀 350g'],
  [118, '[보배마을] 강황가루 100g'], [125, '[보배마을] 강황가루 100g'], [127, '[보배마을] 강황가루 100g'],
  [134, '[보배마을] 깬서리태 500g'], [136, '[보배마을] 강황가루 100g'], [138, '[보배마을] 차조 500g'],
  [153, '[보배마을] 어린이 혼합곡 800g'], [181, '[토지랑] 호라산칩 50g'], [183, '[토지랑] 호라산칩 50g'],
  [211, '[보배마을] 매실청 300g'], [212, '[보배마을] 매실청 300g'], [220, '[보배마을] 오트밀 350g'],
  [221, '[토지랑] 호라산칩 50g'], [222, '[토지랑] 호라산칩 50g'],
]
const M8_BONG: [number, string, number, string?][] = [
  [4, '[보배마을] 백태 1kg', 1], [5, '[보배마을] 파로 1kg', 1], [7, '[보배마을] 즉석밥 6개', 1],
  [8, '[보배마을] 바나듐쌀 찰흑미 2kg', 1], [9, '[보배마을] 바나듐쌀 백미 2kg', 1], [10, '[보배마을] 즉석밥 24개', 1],
  [13, '[보배마을] 찰현미 2kg', 1], [14, '[보배마을] 즉석밥 24개', 2], [15, '[보배마을] 즉석밥 24개', 1],
  [16, '[보배마을] 즉석밥 6개', 3], [18, '[보배마을] 즉석밥 6개', 1],
  [17, '[100% 국산 유기농] 현미 귀리 잡곡 즉석 밥 180g, 12개', 2, '[보배마을] 즉석밥 6개'],
  [19, '[보배마을] 어린이 혼합곡 800g', 1], [20, '[보배마을] 깬서리태 500g', 1], [25, '매실액 300ml', 1],
  [27, '유기농 계란 10구', 1], [28, '[보배마을] 강황가루 100g', 2], [29, '[보배마을] 강황가루 300g', 1],
  [32, '[보배마을] 강황가루 100g', 1], [33, '[보배마을] 저속노화쌀 1kg', 2], [34, '[보배마을] 오곡밥 500g', 1],
  [35, '[보배마을] 저속노화쌀 1kg', 1], [37, '[보배마을] 현미 2kg', 2], [38, '[보배마을] 고춧가루 100g', 2],
  [40, '[보배마을] 백미 2kg', 2],
]
const M8_FEE_ROWS = [89, 118, 125, 127, 136, 181, 183, 211, 212, 221, 222]
const M8_FEE = 11.66 // 식품 기본 10.6% × 1.1 (부가포함)
// m10: 원료ID 없는 상품 원가·과세 (나무_마진리빌드 (1).xlsx 단가DB 에서 읽은 값) — [별칭, H 소포장 공급가, J 과세여부]
const M10_VALUES: [string, number, string][] = [
  ['[보배마을] 강황가루 100g', 5029, '과세'],
  ['[보배마을] 강황가루 300g', 12400, '과세'],
  ['[보배마을] 고춧가루 100g', 5571, '면세'],
  ['[보배마을] 매실청 300g', 11100, '과세'],
  ['매실액 300ml', 11100, '과세'],
  ['유기농 계란 10구', 9960, '면세'],
  ['[보배마을] 오곡밥 500g', 3858, '면세'],
  ['[토지랑] 진도향미 10kg', 29800, '면세'],
  ['[토지랑] 진도향미 20kg', 59600, '면세'],
]
// init18: 마진계산 Y·Z 의미 전환 — 소비자가/마진율 → 1P 상품코드/납품가
const COUPANG_1P_YZ_OLD = ['소비자가(1P)', '쿠팡마진율(1P)']
const COUPANG_1P_YZ_NEW = ['1P 상품코드', '1P 납품가(부가포함)']
// 단가DB 자동 파생 컬럼 배경 (입력 흰색과 대비)
const AUTO_GRAY = 'D9D9D9'
// init13: 마진마스터 이관
const MIGRATION = migrationData as {
  newRows: (string | number)[][]
  records: any[]
  skipped: any[]
}
const MIGRATION_CHANNEL = '쿠팡 3P'
const SUSPECT_YELLOW = 'FFF2CC'
// init14: 이관분 롤백 범위
const ROLLBACK_FROM = 9
const ROLLBACK_TO = 200
// init16: 단가DB 행 확장 대비 — 파생 수식·드롭다운·서식을 여기까지 미리 깐다
const PRICE_ROWS_TO = 300
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

// ── 곰표 행 보호 — C(발송거래처)="곰표" 행의 G(원곡가)는 대표님 수기 입력 ──
//   G 파생 수식을 쓰는 init(3·4·13·16)은 이 행의 G 를 덮어쓰지 않는다.
const GOMPYO = '곰표'
const isGompyo = (c: Cell | undefined) => String(c ?? '').trim() === GOMPYO

// 현재 단가DB 에서 곰표 행의 별칭 → G 원문(수식/값) 맵
async function readGompyoG(sheets: ReturnType<typeof getSheets>): Promise<Map<string, Cell>> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: TARGET_SHEET_ID,
    range: `${quote(PRICE_TAB)}!A2:G1000`,
    valueRenderOption: 'FORMULA',
  })
  const out = new Map<string, Cell>()
  for (const r of (res.data.values || []) as Cell[][]) {
    const al = String(r?.[0] ?? '').trim()
    if (al && isGompyo(r?.[2])) out.set(al, r?.[6] ?? '')
  }
  return out
}

// 쓰려는 G~ 행렬(row[0]=G)에서 곰표 행의 G 를 현재 값으로 되돌린다 (신규 곰표 행은 빈칸)
function keepGompyoG(rows: Cell[][], keys: { alias: Cell; vendor?: Cell }[], cur: Map<string, Cell>) {
  rows.forEach((row, i) => {
    const k = keys[i]
    if (!k) return
    const kept = cur.get(String(k.alias ?? '').trim())
    if (kept !== undefined) row[0] = kept
    else if (isGompyo(k.vendor)) row[0] = ''
  })
}

// ── init20: 단가DB J열(총 공급가) 삭제에 따른 타 탭 수식 변환 ────────
//   · 고정 범위 '단가DB'!$A$2:$N$169 → 열 전체 '단가DB'!$A:$M (J 뒤 열은 한 칸 당김)
//   · 마진계산 F 의 J(10) 폴백 제거 → H(8)만
//   · VLOOKUP 열 번호: 10 미만 그대로 · 10 은 오류 · 10 초과는 -1
//   · 변환 뒤 남는 단가DB 참조는 '$A:$X,<n>,'(VLOOKUP) 또는 '$A:$A'(COUNTIF 류)만 허용
const PRICE_J_IDX = 9
const colIdx = (L: string) => L.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
const colName = (i: number): string =>
  i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26))
const shiftAfterJ = (L: string) => {
  const i = colIdx(L)
  if (i === PRICE_J_IDX) throw new Error(`단가DB J열 직접 참조`)
  return i > PRICE_J_IDX ? colName(i - 1) : L
}
const PRICE_FIXED_RANGE = /'단가DB'!\$([A-Z]{1,2})\$\d+:\$([A-Z]{1,2})\$\d+/g
const PRICE_J_FALLBACK =
  /IF\(ISNUMBER\(VLOOKUP\(\$B(\d+),'단가DB'!\$A:\$M,10,FALSE\)\),VLOOKUP\(\$B\1,'단가DB'!\$A:\$M,10,FALSE\)\*\$C\1,""\)\)/g
const PRICE_VLOOKUP_IDX = /('단가DB'!\$A:\$[A-Z]{1,2},)(\d+)(?=,)/g

function shiftPriceFormula(f: string): string {
  let out = f.replace(PRICE_FIXED_RANGE, (_m, a: string, b: string) => `'단가DB'!$${shiftAfterJ(a)}:$${shiftAfterJ(b)}`)
  // IF(ISNUMBER(V8),V8*$C,IF(ISNUMBER(V10),V10*$C,"")) → IF(ISNUMBER(V8),V8*$C,"")
  out = out.replace(PRICE_J_FALLBACK, '"")')
  out = out.replace(PRICE_VLOOKUP_IDX, (_m, head: string, n: string) => {
    const k = Number(n)
    if (k === PRICE_J_IDX + 1) throw new Error(`VLOOKUP 열 번호 10(J) 잔존`)
    return `${head}${k > PRICE_J_IDX + 1 ? k - 1 : k}`
  })
  // 남은 단가DB 참조가 전부 허용 형태인지 확인
  const refs = out.match(/'?단가DB'?!\S{0,20}/g) || []
  for (const r of refs) {
    if (!/^'단가DB'!\$A:\$[A-Z]{1,2},\d+,/.test(r) && !/^'단가DB'!\$A:\$A[,)]/.test(r)) {
      throw new Error(`처리 못 하는 단가DB 참조: ${r}`)
    }
  }
  return out
}

// 단가DB 를 참조하는 타 탭 수식 전부 → 변환안 (쓰기 없음)
async function planPriceRefs(sheets: ReturnType<typeof getSheets>) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: TARGET_SHEET_ID,
    fields: 'sheets(properties(sheetId,title))',
  })
  const titles = (meta.data.sheets || [])
    .map((s) => s.properties?.title || '')
    .filter((t) => t && t !== PRICE_TAB)
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: TARGET_SHEET_ID,
    ranges: titles.map((t) => quote(t)),
    valueRenderOption: 'FORMULA',
  })
  const cells: { tab: string; row: number; col: number; before: string; after: string }[] = []
  const errors: { 셀: string; 오류: string; 수식: string }[] = []
  ;(res.data.valueRanges || []).forEach((vr, ti) => {
    ;((vr.values || []) as Cell[][]).forEach((r, ri) =>
      (r || []).forEach((c, ci) => {
        const f = String(c ?? '')
        if (!f.startsWith('=') || !f.includes('단가DB')) return
        try {
          cells.push({ tab: titles[ti], row: ri + 1, col: ci, before: f, after: shiftPriceFormula(f) })
        } catch (e: any) {
          errors.push({ 셀: `${titles[ti]}!${colName(ci)}${ri + 1}`, 오류: e?.message || String(e), 수식: f.slice(0, 200) })
        }
      })
    )
  })
  const summary: Record<string, { 셀수: number; 샘플_전: string; 샘플_후: string }> = {}
  for (const c of cells) {
    const k = `${c.tab}!${colName(c.col)}`
    if (!summary[k]) summary[k] = { 셀수: 0, 샘플_전: c.before, 샘플_후: c.after }
    summary[k].셀수++
  }
  return { cells, errors, summary }
}

// 단가DB A열 고정 범위를 쓰는 드롭다운(ONE_OF_RANGE) → 열 끝까지 열린 범위로
const PRICE_ALIAS_FIXED = /^='단가DB'!\$A\$2:\$A\$\d+$/
const PRICE_ALIAS_OPEN = `='단가DB'!$A$2:$A`
async function planPriceValidations(sheets: ReturnType<typeof getSheets>, tabs: string[]) {
  const gd = await sheets.spreadsheets.get({
    spreadsheetId: TARGET_SHEET_ID,
    ranges: tabs.map((t) => quote(t)),
    includeGridData: true,
    fields: 'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(dataValidation))))',
  })
  const runs: { tab: string; sheetId: number; col: number; r0: number; r1: number; rule: any }[] = []
  for (const sh of gd.data.sheets || []) {
    const sheetId = sh.properties?.sheetId as number
    const tab = sh.properties?.title || ''
    const rows = sh.data?.[0]?.rowData || []
    const byCol = new Map<number, { r: number; rule: any }[]>()
    rows.forEach((rd, ri) =>
      (rd.values || []).forEach((v, ci) => {
        const dv: any = v.dataValidation
        const ref = dv?.condition?.values?.[0]?.userEnteredValue
        if (dv?.condition?.type !== 'ONE_OF_RANGE' || !PRICE_ALIAS_FIXED.test(String(ref ?? ''))) return
        if (!byCol.has(ci)) byCol.set(ci, [])
        byCol.get(ci)!.push({ r: ri, rule: dv })
      })
    )
    for (const [col, list] of Array.from(byCol.entries())) {
      for (const x of list) {
        const tail = runs[runs.length - 1]
        const same =
          tail && tail.tab === tab && tail.col === col && tail.r1 === x.r &&
          JSON.stringify(tail.rule) === JSON.stringify(x.rule)
        if (same) tail.r1 = x.r + 1
        else runs.push({ tab, sheetId, col, r0: x.r, r1: x.r + 1, rule: x.rule })
      }
    }
  }
  return runs
}

const ERR_VALUE = /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|ERROR!|NUM!|NULL!)/
const errorCellsOf = (tab: string, rows: Cell[][]) => {
  const out: string[] = []
  ;(rows || []).forEach((r, ri) =>
    (r || []).forEach((c, ci) => {
      if (typeof c === 'string' && ERR_VALUE.test(c)) out.push(`${tab}!${colName(ci)}${ri + 1} ${c}`)
    })
  )
  return out
}

// Drive 메타(수정 시각·편집 가능 여부) — drive.metadata.readonly. 실패하면 null (Drive API 미사용 환경 대비)
async function driveMeta(ids: string[]) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) return null
  try {
    const creds = JSON.parse(raw)
    if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
    })
    const drive = google.drive({ version: 'v3', auth })
    const out: Record<string, { name?: string | null; modifiedTime?: string | null; canEdit?: boolean | null }> = {}
    for (const id of ids) {
      const r = await drive.files.get({ fileId: id, fields: 'name,modifiedTime,capabilities(canEdit)' })
      out[id] = { name: r.data.name, modifiedTime: r.data.modifiedTime, canEdit: r.data.capabilities?.canEdit }
    }
    return out
  } catch (e: any) {
    return { 오류: e?.message || String(e) } as any
  }
}

// 탭 전체 값·수식 스냅샷 + 해시
async function tabSnapshot(sheets: ReturnType<typeof getSheets>, id: string, tab: string) {
  const [f, v] = await Promise.all(
    (['FORMULA', 'UNFORMATTED_VALUE'] as const).map((opt) =>
      sheets.spreadsheets.values.get({ spreadsheetId: id, range: quote(tab), valueRenderOption: opt })
    )
  )
  const fx = (f.data.values || []) as Cell[][]
  const vals = (v.data.values || []) as Cell[][]
  const h = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12)
  return {
    행수: vals.length,
    헤더: vals[0] || [],
    값해시: h(vals),
    수식해시: h(fx),
    수식셀: fx.flat().filter((c) => String(c ?? '').startsWith('=')).length,
    오류셀: errorCellsOf(tab, vals).length,
  }
}

// ── m2 수식 변환 ─────────────────────────────────────────────────
// 원료ID 조회: 진도팜 원가표 먼저, 없으면 곰표 원가표 (끝행 제한 없음)
const m2Lookup = (e: string, n: number | string) =>
  `IFERROR(VLOOKUP(${e},'진도팜 원가표'!$A$12:$Q,${n},FALSE),VLOOKUP(${e},'곰표 원가표'!$A$12:$Q,${n},FALSE))`
const M2_MIRROR_VLOOKUP = /VLOOKUP\((\$E\d+),'원가표미러'!\$A\$12:\$P\$200,(\d+),FALSE\)/g

// 최상위 함수 인자 분리 — "IF(a,b,c)" 의 괄호 안 문자열을 받아 [a,b,c] (문자열·중첩 괄호 고려)
function splitTopArgs(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let cur = ''
  for (const ch of inner) {
    if (ch === '"') inStr = !inStr
    if (!inStr) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        out.push(cur)
        cur = ''
        continue
      }
    }
    cur += ch
  }
  out.push(cur)
  return out
}

// init19 곰표 분기 벗기기: =IF(TRIM($C#)="곰표",X,원래식) → =원래식
function m2Unwrap(f: string): string {
  if (!f.startsWith('=IF(TRIM($C')) return f
  const args = splitTopArgs(f.slice(4, -1))
  if (args.length !== 3) throw new Error(`곰표 분기 해석 실패: ${f.slice(0, 80)}`)
  return `=${args[2]}`
}

// 단가DB 한 셀 변환 (G·H·I·J). r = 행번호
function m2PriceFormula(f: string, col: 'G' | 'H' | 'I' | 'J', r: number): string {
  let out = col === 'H' || col === 'I' ? m2Unwrap(f) : f
  out = out.replace(M2_MIRROR_VLOOKUP, (_m, e: string, n: string) => m2Lookup(e, n))
  // H 소포장: 작업비 고정값(원가표미러 B2) → 원가표 행의 작업비(6번째 열). 봉 kg 곱하기는 그대로
  if (col === 'H') {
    const fixed = `'원가표미러'!$B$2*MAX(1,`
    if (!out.includes(fixed)) throw new Error(`H${r} 작업비 고정값 없음`)
    out = out.replace(fixed, `${m2Lookup(`$E${r}`, 6)}*MAX(1,`)
  }
  // 나머지 원가표미러 셀(B3 벌크 작업비·B4 파쇄·B5 제분)은 같은 위치의 진도팜 원가표로
  out = out.split(`'원가표미러'!`).join(`'진도팜 원가표'!`)
  return out
}

// 원가표 파일로 가는 HYPERLINK → 같은 파일 안 진도팜 원가표 탭 링크 (정렬로 위치가 바뀌므로 위치 대신 내용으로 찾음)
function m2LinkCells(fx: Cell[][], jinGid: number | undefined) {
  const out: { r: number; c: number; f: string }[] = []
  fx.forEach((row, ri) =>
    (row || []).forEach((c, ci) => {
      const f = String(c ?? '')
      if (f.startsWith('=HYPERLINK(') && f.includes(COST_SHEET_ID)) {
        const m = f.match(/,"([^"]*)"\)$/)
        out.push({ r: ri + 1, c: ci, f: `=HYPERLINK("#gid=${jinGid}","${m ? m[1] : '원가표 바로가기'}")` })
      }
    })
  )
  return out
}

// 마진계산·설정 등: 탭 이름만 바꾸는 변환
function m2RenameRefs(f: string): string {
  return f
    .split(`'비용DB'!$A$2:$B$50`).join(`'${M2_SETTING_TAB}'!$J$2:$K$50`)
    .split(`'채널DB'!`).join(`'${M2_SETTING_TAB}'!`)
    .split(`'원가표미러'!`).join(`'진도팜 원가표'!`)
}

// ── 단가DB 수기 H·J 보호 — 원료ID(E)가 빈 행의 H(소포장 공급가)·J(과세여부)가 값이면 덮어쓰기 금지 ──
//   마스터 단가DB 에 H~J 를 쓰는 액션은 쓰기 전에 반드시 이 가드를 통과해야 한다.
async function guardManualPriceHJ(sheets: ReturnType<typeof getSheets>, spreadsheetId: string, ranges: string[]) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quote(PRICE_TAB)}!A1:J1000`, valueRenderOption: 'FORMULA' })
  const fx = (res.data.values || []) as Cell[][]
  const hits: string[] = []
  for (const rg of ranges) {
    const m = rg.match(/^'단가DB'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/)
    if (!m) continue
    const c0 = colIdx(m[1]), c1 = colIdx(m[3] || m[1]), r0 = Number(m[2]), r1 = Number(m[4] || m[2])
    for (let r = r0; r <= r1; r++) {
      const row = fx[r - 1] || []
      if (String(row[4] ?? '').trim() !== '') continue
      for (const c of [7, 9]) {
        const v = String(row[c] ?? '')
        if (c >= c0 && c <= c1 && v !== '' && !v.startsWith('=')) hits.push(`${colName(c)}${r} ${row[0] ?? ''}`)
      }
    }
  }
  if (hits.length) throw new Error(`원료ID 빈 행의 수기 H·J 덮어쓰기 차단: ${hits.slice(0, 5).join(', ')}`)
}

// ── m6 마진계산 과세 분기 변환 ─────────────────────────────────────
//   O: 과세 → (매출 − 총비용) × 10/11 · 면세 그대로 / Q: 과세 → ×1.1 없음 · 면세 그대로
const M6_O = /^=IF\(NOT\(ISNUMBER\(\$N(\d+)\)\),"",IF\((.+?="과세"),\((.+)\)\*10\/11,(.+)\)-\$N\1\)$/
const M6_Q = /^=IF\(OR\(NOT\(ISNUMBER\(\$O(\d+)\)\),\$O\1=0\),"",\$D\1\/\$O\1\*1\.1\)$/
function m6Rewrite(o: string, q: string, r: number): { o: string; q: string } | null {
  const mo = o.match(M6_O)
  const mq = q.match(M6_Q)
  if (!mo || !mq || Number(mo[1]) !== r || Number(mq[1]) !== r || mo[3] !== mo[4]) return null
  const cond = mo[2]
  const rev = mo[3]
  return {
    o: `=IF(NOT(ISNUMBER($N${r})),"",IF(${cond},(${rev}-$N${r})*10/11,${rev}-$N${r}))`,
    q: `=IF(OR(NOT(ISNUMBER($O${r})),$O${r}=0),"",$D${r}/$O${r}*IF(${cond},1,1.1))`,
  }
}

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

    // ── 구 구조 전용 init 차단 — init20(단가DB J열 삭제) 이후 재실행하면 열 구조가 깨진다 ──
    const LEGACY_ACTIONS = new Set([
      'init1', 'init2', 'init3', 'init4', 'init5', 'init6', 'init7', 'init8',
      'init9', 'init10', 'init11', 'init12', 'init13', 'init14', 'init16',
    ])
    if (action && LEGACY_ACTIONS.has(action)) {
      return NextResponse.json(
        { ok: false, error: `${action}: 구 구조 전용 — 재실행 금지 (init20 단가DB J열 삭제 이후)` },
        { status: 410 }
      )
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

      // 곰표 행 G(대표님 입력)는 전면 교체 전에 읽어 두고 그대로 되돌린다
      keepGompyoG(
        colGI,
        colAF.map((r) => ({ alias: r[0], vendor: r[2] })),
        await readGompyoG(sheets),
      )

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
      // 곰표 행 G(대표님 입력)는 덮어쓰지 않음
      keepGompyoG(colGK, alias.rows.map((a) => ({ alias: a[0] })), await readGompyoG(sheets))
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

    // ── init10: O2 단일 바로가기 + 기타거래처 원가표 폐기(J 직접입력) ──
    if (action === 'init10') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title,hidden))',
      })
      const props = (meta.data.sheets || []).map((s) => s.properties).filter(Boolean) as any[]
      const priceId = props.find((p) => p.title === PRICE_TAB)?.sheetId
      if (priceId == null) throw new Error(`'${PRICE_TAB}' 탭이 없습니다.`)
      const marginId = props.find((p) => p.title === MARGIN_TAB)?.sheetId
      const etcProp = props.find((p) => p.title === ETC_TAB || p.title === ETC_TAB_RETIRED)
      const etcTitle: string | null = etcProp?.title ?? null

      // ── 1. 사전 읽기 ──────────────────────────────────────────
      const preRanges = [
        `${quote(PRICE_TAB)}!A2:A1000`,
        `${quote(PRICE_TAB)}!E2:E1000`,
        `${quote(PRICE_TAB)}!H2:I1000`,
      ]
      if (etcTitle) preRanges.push(`${quote(etcTitle)}!A2:E1000`)
      const pre = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: preRanges,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const pv = pre.data.valueRanges || []
      const aCol = pv[0]?.values || []
      const eCol = pv[1]?.values || []
      const beforeHI = pv[2]?.values || []
      const etcRowsRaw = etcTitle ? pv[3]?.values || [] : []

      let priceLast = 1
      aCol.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') priceLast = 2 + i
      })
      const nRows = priceLast - 1

      // J 열 원문(수식/값) — 진도팜 행은 그대로 되돌려 쓴다
      const jNow = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!J2:J${priceLast}`,
        valueRenderOption: 'FORMULA',
      })
      const jRaw = jNow.data.values || []

      // ── 2. O열 정리 + O2 단일 링크 ────────────────────────────
      await sheets.spreadsheets.values.clear({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!O1:O1000`,
        requestBody: {},
      })
      const linkUrl = `https://docs.google.com/spreadsheets/d/${JINDO_SHEET_ID}/edit`
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!O2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=HYPERLINK("${linkUrl}","${LINK_COL}")`]] },
      })

      // ── 3. 기타거래처 매입가 이관 맵 ──────────────────────────
      // 기타거래처 원가표: A 거래처 · B 별칭 · C 매입가 · D 과세여부 · E 메모
      const etcByAlias = new Map<string, number>()
      const etcDup: string[] = []
      etcRowsRaw.forEach((r) => {
        const al = String(r?.[1] ?? '').trim()
        const raw = r?.[2]
        if (!al || raw === '' || raw == null) return
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''))
        if (!Number.isFinite(n)) return
        if (etcByAlias.has(al)) etcDup.push(al)
        else etcByAlias.set(al, n)
      })
      const etcFilled = etcByAlias.size

      // ── 4. 단가DB J 재구성 ────────────────────────────────────
      const aliasSet = new Set<string>()
      const colJ: Cell[][] = []
      let migrated = 0
      let etcKeptFormula = 0
      let nonJindoBlank = 0
      const migratedSamples: any[] = []
      for (let i = 0; i < nRows; i++) {
        const aliasText = String(aCol[i]?.[0] ?? '').trim()
        aliasSet.add(aliasText)
        const rid = String(eCol[i]?.[0] ?? '').trim()
        if (rid !== '') {
          // 진도팜 행 — J 기존 상태 그대로 유지
          colJ.push([(jRaw[i] || [])[0] ?? ''])
          etcKeptFormula++
          continue
        }
        const v = etcByAlias.get(aliasText)
        if (v != null) {
          colJ.push([v])
          migrated++
          if (migratedSamples.length < 3) {
            migratedSamples.push({ 행: `R${2 + i}`, idx: i, 별칭: aliasText, J매입가: v })
          }
        } else {
          colJ.push([''])
          nonJindoBlank++
        }
      }
      // 매칭 실패 — 기타거래처에 매입가가 있는데 단가DB 별칭에 없는 건
      const unmatched = [...etcByAlias.keys()].filter((a) => !aliasSet.has(a))

      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!J2:J${priceLast}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: colJ },
      })

      // ── 5. 서식 — 비진도팜 J 는 수기 입력 컬럼 (입력 배경색) ───
      let inputBg: any = { red: 1, green: 1, blue: 1 }
      if (marginId != null) {
        const gd = await sheets.spreadsheets.get({
          spreadsheetId: TARGET_SHEET_ID,
          ranges: [`${quote(MARGIN_TAB)}!D2`],
          includeGridData: true,
          fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
        })
        inputBg =
          gd.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.effectiveFormat
            ?.backgroundColor || inputBg
      }
      const fmtReqs: any[] = []
      for (let i = 0; i < nRows; i++) {
        if (String(eCol[i]?.[0] ?? '').trim() !== '') continue
        fmtReqs.push({
          repeatCell: {
            range: {
              sheetId: priceId,
              startRowIndex: 1 + i,
              endRowIndex: 2 + i,
              startColumnIndex: 9,
              endColumnIndex: 10,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: inputBg,
                numberFormat: { type: 'NUMBER', pattern: '#,##0' },
              },
            },
            fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.numberFormat',
          },
        })
      }
      // O열 서식 초기화도 함께
      fmtReqs.push({
        repeatCell: {
          range: {
            sheetId: priceId,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 14,
            endColumnIndex: 15,
          },
          cell: {},
          fields: 'userEnteredFormat',
        },
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: { requests: fmtReqs },
      })

      // ── 6. 기타거래처 탭 폐기 표시 (J 기록 후 → 참조 자동 갱신) ─
      let etcAction = '탭 없음'
      if (etcProp?.sheetId != null) {
        const needRename = etcProp.title !== ETC_TAB_RETIRED
        const needHide = etcProp.hidden !== true
        if (needRename || needHide) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: TARGET_SHEET_ID,
            requestBody: {
              requests: [
                {
                  updateSheetProperties: {
                    properties: {
                      sheetId: etcProp.sheetId,
                      title: ETC_TAB_RETIRED,
                      hidden: true,
                    },
                    fields: 'title,hidden',
                  },
                },
              ],
            },
          })
          etcAction = `'${etcProp.title}' → '${ETC_TAB_RETIRED}' 이름변경 + 숨김`
        } else {
          etcAction = '이미 폐기 표시됨'
        }
      }

      // ── 7. 검증 ───────────────────────────────────────────────
      const post = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(PRICE_TAB)}!O1:O${priceLast}`,
          `${quote(PRICE_TAB)}!H2:I1000`,
          `${quote(PRICE_TAB)}!J2:J${priceLast}`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const qv = post.data.valueRanges || []
      const oCol = (qv[0]?.values || []).map((r, i) => ({
        행: i + 1,
        값: String(r?.[0] ?? '').trim(),
      }))
      const oNonEmpty = oCol.filter((x) => x.값 !== '')
      const afterHI = qv[1]?.values || []
      const jAfter = qv[2]?.values || []

      // 진도팜 행 H·I 전후 비교 (원료ID 있는 행 앞 3개)
      const jindoIdx: number[] = []
      for (let i = 0; i < nRows && jindoIdx.length < 3; i++) {
        if (String(eCol[i]?.[0] ?? '').trim() !== '') jindoIdx.push(i)
      }
      const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : (v ?? ''))
      const jindoCmp = jindoIdx.map((i) => ({
        행: `R${2 + i}`,
        별칭: String(aCol[i]?.[0] ?? ''),
        H: [r2(beforeHI[i]?.[0]), r2(afterHI[i]?.[0])],
        I: [r2(beforeHI[i]?.[1]), r2(afterHI[i]?.[1])],
        동일:
          r2(beforeHI[i]?.[0]) === r2(afterHI[i]?.[0]) &&
          r2(beforeHI[i]?.[1]) === r2(afterHI[i]?.[1]),
      }))

      // 비진도팜 실사용 검증 — 마진계산 빈 행에 해당 별칭 넣어 원가(F) 폴백 확인
      let fallback: any = { note: '이관 건이 없어 생략' }
      const sample = migratedSamples[0]
      if (sample && marginId != null) {
        const mIn = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(MARGIN_TAB)}!A2:R${1 + MARGIN_ROWS}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const mRows = mIn.data.values || []
        let testRow = 0
        for (let i = 0; i < MARGIN_ROWS; i++) {
          const r = mRows[i] || []
          if ([0, 1, 2, 3, 4, 7, 17].every((c) => String(r[c] ?? '').trim() === '')) {
            testRow = 2 + i
            break
          }
        }
        if (testRow > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: TARGET_SHEET_ID,
            requestBody: {
              valueInputOption: 'RAW',
              data: [
                {
                  range: `${quote(MARGIN_TAB)}!A${testRow}:D${testRow}`,
                  values: [[SMART_STORE, sample.별칭, 1, 10000]],
                },
                { range: `${quote(MARGIN_TAB)}!H${testRow}`, values: [['소']] },
              ],
            },
          })
          const tr = await sheets.spreadsheets.values.get({
            spreadsheetId: TARGET_SHEET_ID,
            range: `${quote(MARGIN_TAB)}!A${testRow}:T${testRow}`,
            valueRenderOption: 'UNFORMATTED_VALUE',
          })
          const t = tr.data.values?.[0] || []
          fallback = {
            테스트행: `R${testRow}`,
            별칭: sample.별칭,
            '단가DB J 매입가': sample.J매입가,
            '단가DB H 소포장공급가(비진도팜은 설계상 빈칸)': r2(afterHI[sample.idx]?.[0]),
            '마진계산 F 원가': r2(t[5]),
            'F=J 일치': r2(t[5]) === sample.J매입가,
            'N 총비용': r2(t[13]),
            'T 상태': t[19] ?? '',
          }
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
      }

      const finalMeta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(title,hidden))',
      })

      return NextResponse.json({
        ok: true,
        message: 'O2 단일 바로가기 + 기타거래처 원가표 폐기(단가DB J 직접입력) 완료',
        summary: {
          단가DB_마지막행: priceLast,
          기타거래처_매입가_입력건수: etcFilled,
          단가DB_J_이관건수: migrated,
          이관_일치: etcFilled === migrated && unmatched.length === 0,
          매칭실패_별칭: unmatched.length ? unmatched : 0,
          기타거래처_중복별칭: etcDup.length ? etcDup : 0,
          비진도팜_빈칸행: nonJindoBlank,
          진도팜_J_원형유지행: etcKeptFormula,
          기타거래처_탭: etcAction,
          단가DB_J_참조수식: '없음 (VLOOKUP 제거, 비진도팜은 수기 입력 컬럼)',
        },
        검증1_O열: {
          비어있지_않은_셀: oNonEmpty,
          'O1 비어있음': !oCol.some((x) => x.행 === 1 && x.값 !== ''),
          'O3이하 비어있음': oNonEmpty.every((x) => x.행 === 2),
        },
        검증2_이관: { 기타거래처_건수: etcFilled, 이관: migrated, 매칭실패: unmatched.length, 샘플: migratedSamples },
        검증3_비진도팜_파생: fallback,
        검증4_진도팜_HI: jindoCmp,
        탭목록: (finalMeta.data.sheets || []).map((s) => ({
          title: s.properties?.title,
          hidden: s.properties?.hidden || false,
        })),
        _jAfterCount: jAfter.filter((r) => String(r?.[0] ?? '').trim() !== '').length,
      })
    }

    // ── init11: 단가DB J열 '총 공급가' 전환 (멱등) ────────────────
    if (action === 'init11') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const props = (meta.data.sheets || []).map((s) => s.properties).filter(Boolean) as any[]
      const priceId = props.find((p) => p.title === PRICE_TAB)?.sheetId
      if (priceId == null) throw new Error(`'${PRICE_TAB}' 탭이 없습니다.`)
      const hasMargin = props.some((p) => p.title === MARGIN_TAB)

      // ── 1. 사전 읽기 ──────────────────────────────────────────
      const preRanges = [
        `${quote(PRICE_TAB)}!A2:A1000`,
        `${quote(PRICE_TAB)}!E2:E1000`,
        `${quote(PRICE_TAB)}!H2:J1000`,
      ]
      if (hasMargin) preRanges.push(`${quote(MARGIN_TAB)}!A2:T10`)
      const pre = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: preRanges,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const pv = pre.data.valueRanges || []
      const aCol = pv[0]?.values || []
      const eCol = pv[1]?.values || []
      const beforeHIJ = pv[2]?.values || []
      const beforeMargin = hasMargin ? pv[3]?.values || [] : []

      let priceLast = 1
      aCol.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') priceLast = 2 + i
      })
      const nRows = priceLast - 1

      // J 원문 — 비진도팜 행은 그대로 되돌려 쓴다 (기존 입력값 보존)
      const jNow = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!J2:J${priceLast}`,
        valueRenderOption: 'FORMULA',
      })
      const jRaw = jNow.data.values || []

      // 자동 컬럼 배경색 표본 — H(소포장 공급가)
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(PRICE_TAB)}!H2:J2`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const g0 = gd.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
      const autoBg = g0[0]?.effectiveFormat?.backgroundColor || {
        red: 0.94,
        green: 0.94,
        blue: 0.94,
      }

      // ── 2. J 컬럼 재구성 ──────────────────────────────────────
      const colJ: Cell[][] = []
      const jindoRows: number[] = []
      let jindo = 0
      let nonJindoKept = 0
      let nonJindoWithValue = 0
      for (let i = 0; i < nRows; i++) {
        const rid = String(eCol[i]?.[0] ?? '').trim()
        const r = 2 + i
        if (rid !== '') {
          colJ.push([`=IF($H${r}="","",$H${r})`])
          jindoRows.push(i)
          jindo++
        } else {
          const raw = (jRaw[i] || [])[0]
          colJ.push([raw ?? ''])
          nonJindoKept++
          if (String(raw ?? '').trim() !== '') nonJindoWithValue++
        }
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{ range: `${quote(PRICE_TAB)}!J1`, values: [[PRICE_J_HEADER]] }],
        },
      })
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!J2:J${priceLast}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: colJ },
      })

      // ── 3. 진도팜 행 J 만 자동 컬럼 배경색 (비진도팜 서식 미변경) ─
      const runs: [number, number][] = []
      for (const i of jindoRows) {
        const last = runs[runs.length - 1]
        if (last && last[1] === i) last[1] = i + 1
        else runs.push([i, i + 1])
      }
      const fmtReqs = runs.map(([s, e]) => ({
        repeatCell: {
          range: {
            sheetId: priceId,
            startRowIndex: 1 + s,
            endRowIndex: 1 + e,
            startColumnIndex: 9,
            endColumnIndex: 10,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: autoBg,
              numberFormat: { type: 'NUMBER', pattern: '#,##0' },
            },
          },
          fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.numberFormat',
        },
      }))
      if (fmtReqs.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: fmtReqs },
        })
      }

      // ── 4. 검증 ───────────────────────────────────────────────
      const postRanges = [`${quote(PRICE_TAB)}!H2:J1000`, `${quote(PRICE_TAB)}!J1`]
      if (hasMargin) postRanges.push(`${quote(MARGIN_TAB)}!A2:T10`)
      const post = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: postRanges,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const qv = post.data.valueRanges || []
      const afterHIJ = qv[0]?.values || []
      const jHeader = qv[1]?.values?.[0]?.[0] ?? ''
      const afterMargin = hasMargin ? qv[2]?.values || [] : []
      const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : (v ?? ''))

      // 검증1 — 진도팜 행 3개 J = H
      const jindoCheck = jindoRows.slice(0, 3).map((i) => ({
        행: `R${2 + i}`,
        별칭: String(aCol[i]?.[0] ?? ''),
        H: r2(afterHIJ[i]?.[0]),
        J: r2(afterHIJ[i]?.[2]),
        일치: r2(afterHIJ[i]?.[0]) === r2(afterHIJ[i]?.[2]),
      }))

      // 검증2 — 비진도팜 행 배경색 + 값 보존
      const nonJindoIdx: number[] = []
      for (let i = 0; i < nRows && nonJindoIdx.length < 3; i++) {
        if (String(eCol[i]?.[0] ?? '').trim() === '') nonJindoIdx.push(i)
      }
      let nonJindoBgCheck: any = null
      if (nonJindoIdx.length) {
        const i = nonJindoIdx[0]
        const bgRes = await sheets.spreadsheets.get({
          spreadsheetId: TARGET_SHEET_ID,
          ranges: [`${quote(PRICE_TAB)}!J${2 + i}`, `${quote(MARGIN_TAB)}!D2`],
          includeGridData: true,
          fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
        })
        const pick = (n: number) =>
          bgRes.data.sheets?.[n]?.data?.[0]?.rowData?.[0]?.values?.[0]?.effectiveFormat
            ?.backgroundColor
        const a = pick(0)
        const b = hasMargin ? pick(1) : null
        nonJindoBgCheck = {
          행: `R${2 + i}`,
          별칭: String(aCol[i]?.[0] ?? ''),
          J값: r2(afterHIJ[i]?.[2]),
          J값_이전: r2(beforeHIJ[i]?.[2]),
          값_보존: r2(beforeHIJ[i]?.[2]) === r2(afterHIJ[i]?.[2]),
          J배경: a,
          마진계산_입력색: b,
          입력색_일치: JSON.stringify(a) === JSON.stringify(b),
          자동색과_다름: JSON.stringify(a) !== JSON.stringify(autoBg),
        }
      }

      // 검증3 — 마진계산 원가(F, index 5) 변동 없음
      const marginCheck = beforeMargin.slice(0, 5).map((b, i) => {
        const a = afterMargin[i] || []
        return {
          행: `R${2 + i}`,
          별칭: a[1] ?? b[1] ?? '',
          'F 원가': [r2(b[5]), r2(a[5])],
          'N 총비용': [r2(b[13]), r2(a[13])],
          동일: r2(b[5]) === r2(a[5]) && r2(b[13]) === r2(a[13]),
        }
      })

      return NextResponse.json({
        ok: true,
        message: `단가DB J열 '${PRICE_J_HEADER}' 전환 완료`,
        summary: {
          J1_헤더: jHeader,
          단가DB_마지막행: priceLast,
          진도팜_J수식_적용: jindo,
          비진도팜_원형유지: nonJindoKept,
          비진도팜_값있는행: nonJindoWithValue,
          이중계산_없음:
            '마진계산 F 는 H(소포장 공급가)가 숫자면 H 사용, H 빈칸일 때만 J 폴백 → 진도팜 행에서 J=H 여도 합산 아님',
        },
        검증1_진도팜_J등H: jindoCheck,
        검증2_비진도팜: nonJindoBgCheck,
        검증3_마진계산_원가: marginCheck,
      })
    }

    // ── init12: 단가DB J 헤더 명확화 + 자동/입력 컬럼 색 구분 (멱등) ──
    if (action === 'init12') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const props = (meta.data.sheets || []).map((s) => s.properties).filter(Boolean) as any[]
      const priceId = props.find((p) => p.title === PRICE_TAB)?.sheetId
      if (priceId == null) throw new Error(`'${PRICE_TAB}' 탭이 없습니다.`)
      const hasMargin = props.some((p) => p.title === MARGIN_TAB)

      // ── 1. 사전 스냅샷 — 값·수식 무변동 확인용 ─────────────────
      const preRanges = [`${quote(PRICE_TAB)}!A2:A1000`, `${quote(PRICE_TAB)}!E2:E1000`]
      const preIdx = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: preRanges,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const aCol = preIdx.data.valueRanges?.[0]?.values || []
      const eCol = preIdx.data.valueRanges?.[1]?.values || []
      let priceLast = 1
      aCol.forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') priceLast = 2 + i
      })
      const nRows = priceLast - 1

      const snapRanges = [`${quote(PRICE_TAB)}!A2:O${priceLast}`]
      if (hasMargin) snapRanges.push(`${quote(MARGIN_TAB)}!A2:T10`)
      const beforeFx = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: snapRanges,
        valueRenderOption: 'FORMULA',
      })
      const beforePrice = beforeFx.data.valueRanges?.[0]?.values || []
      const beforeMarginVal = hasMargin
        ? (
            await sheets.spreadsheets.values.get({
              spreadsheetId: TARGET_SHEET_ID,
              range: `${quote(MARGIN_TAB)}!A2:T10`,
              valueRenderOption: 'UNFORMATTED_VALUE',
            })
          ).data.values || []
        : []

      // ── 2. 자동 컬럼 회색 — #D9D9D9 고정 (입력 흰색과 대비) ────
      const autoBg: any = hex(AUTO_GRAY)
      const whiteBg = { red: 1, green: 1, blue: 1 }
      const BGF = 'userEnteredFormat.backgroundColor'
      const band = (c0: number, c1: number, r0: number, r1: number, bg: any) => ({
        repeatCell: {
          range: {
            sheetId: priceId,
            startRowIndex: r0,
            endRowIndex: r1,
            startColumnIndex: c0,
            endColumnIndex: c1,
          },
          cell: { userEnteredFormat: { backgroundColor: bg } },
          fields: BGF,
        },
      })

      // J — 진도팜(원료ID 있음) 회색 / 비진도팜 흰색
      const jindoRuns: [number, number][] = []
      const etcRuns: [number, number][] = []
      let jindoCnt = 0
      let etcCnt = 0
      for (let i = 0; i < nRows; i++) {
        const isJindo = String(eCol[i]?.[0] ?? '').trim() !== ''
        const runs = isJindo ? jindoRuns : etcRuns
        if (isJindo) jindoCnt++
        else etcCnt++
        const last = runs[runs.length - 1]
        if (last && last[1] === i) last[1] = i + 1
        else runs.push([i, i + 1])
      }

      const requests: any[] = [
        // G 원곡가 · H 소포장 공급가 · I 벌크 공급가 — 자동 파생 회색 통일
        band(6, 9, 1, priceLast, autoBg),
        ...jindoRuns.map(([s, e]) => band(9, 10, 1 + s, 1 + e, autoBg)),
        ...etcRuns.map(([s, e]) => band(9, 10, 1 + s, 1 + e, whiteBg)),
      ]
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: { requests },
      })

      // J1 헤더만 갱신 (값·수식 아님)
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!J1`,
        valueInputOption: 'RAW',
        requestBody: { values: [[PRICE_J_HEADER_V2]] },
      })

      // ── 3. 검증 — 실제 배경색 되읽기 ──────────────────────────
      const bgBack = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(PRICE_TAB)}!G2:J${priceLast}`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const rowData = bgBack.data.sheets?.[0]?.data?.[0]?.rowData || []
      const eq = (a: any, b: any) =>
        Math.abs((a?.red ?? 1) - (b.red ?? 1)) < 0.01 &&
        Math.abs((a?.green ?? 1) - (b.green ?? 1)) < 0.01 &&
        Math.abs((a?.blue ?? 1) - (b.blue ?? 1)) < 0.01
      let ghiGray = 0
      let jGrayJindo = 0
      let jWhiteEtc = 0
      const mismatch: string[] = []
      for (let i = 0; i < nRows; i++) {
        const vals = rowData[i]?.values || []
        const bgAt = (c: number) => vals[c]?.effectiveFormat?.backgroundColor
        if ([0, 1, 2].every((c) => eq(bgAt(c), autoBg))) ghiGray++
        else if (mismatch.length < 10) mismatch.push(`R${2 + i} G~I`)
        const isJindo = String(eCol[i]?.[0] ?? '').trim() !== ''
        const jbg = bgAt(3)
        if (isJindo && eq(jbg, autoBg)) jGrayJindo++
        else if (!isJindo && eq(jbg, whiteBg)) jWhiteEtc++
        else if (mismatch.length < 10) mismatch.push(`R${2 + i} J`)
      }

      // 값·수식 무변동
      const afterFx = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(PRICE_TAB)}!A2:O${priceLast}`, `${quote(PRICE_TAB)}!J1`],
        valueRenderOption: 'FORMULA',
      })
      const afterPrice = afterFx.data.valueRanges?.[0]?.values || []
      const jHeader = afterFx.data.valueRanges?.[1]?.values?.[0]?.[0] ?? ''
      const priceSame = JSON.stringify(beforePrice) === JSON.stringify(afterPrice)
      const afterMarginVal = hasMargin
        ? (
            await sheets.spreadsheets.values.get({
              spreadsheetId: TARGET_SHEET_ID,
              range: `${quote(MARGIN_TAB)}!A2:T10`,
              valueRenderOption: 'UNFORMATTED_VALUE',
            })
          ).data.values || []
        : []
      const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : (v ?? ''))
      const marginCost = beforeMarginVal.slice(0, 3).map((b, i) => {
        const a = afterMarginVal[i] || []
        return {
          행: `R${2 + i}`,
          별칭: a[1] ?? b[1] ?? '',
          'F 원가': [r2(b[5]), r2(a[5])],
          'N 총비용': [r2(b[13]), r2(a[13])],
          동일: r2(b[5]) === r2(a[5]) && r2(b[13]) === r2(a[13]),
        }
      })

      return NextResponse.json({
        ok: true,
        message: `단가DB J1 '${PRICE_J_HEADER_V2}' + 자동/입력 컬럼 색 구분 완료`,
        summary: {
          J1_헤더: jHeader,
          자동_회색: autoBg,
          입력_흰색: whiteBg,
          단가DB_마지막행: priceLast,
          진도팜행: jindoCnt,
          비진도팜행: etcCnt,
        },
        검증1_색적용: {
          'G·H·I 회색 행수': ghiGray,
          'J 회색(진도팜) 행수': jGrayJindo,
          'J 흰색(비진도팜) 행수': jWhiteEtc,
          기대: { 'G~I': nRows, 'J 회색': jindoCnt, 'J 흰색': etcCnt },
          불일치: mismatch.length ? mismatch : 0,
        },
        검증2_무변동: {
          '단가DB A~O 수식·값 동일': priceSame,
          마진계산_원가: marginCost,
        },
      })
    }

    // ── dump: 마진계산 전체 읽기 전용 덤프 (쓰기 없음) ────────────
    if (action === 'dump') {
      const sheets = getSheets()
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(MARGIN_TAB)}!A1:T${1 + MARGIN_ROWS}`,
          `${quote(PRICE_TAB)}!A1:O1000`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const v = res.data.valueRanges || []
      return NextResponse.json({
        ok: true,
        마진계산: v[0]?.values || [],
        단가DB: v[1]?.values || [],
      })
    }

    // ── dump2: 수식 원형 + 원가표미러 읽기 전용 (쓰기 없음) ────────
    if (action === 'dump2') {
      const sheets = getSheets()
      const fx = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(PRICE_TAB)}!A1:O200`],
        valueRenderOption: 'FORMULA',
      })
      const val = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote('원가표미러')}!A1:P250`,
          `${quote(PRICE_TAB)}!A1:O200`,
          `${quote(MAP_TAB)}!A1:I300`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const v = val.data.valueRanges || []
      return NextResponse.json({
        ok: true,
        단가DB_수식: fx.data.valueRanges?.[0]?.values || [],
        원가표미러: v[0]?.values || [],
        단가DB_값: v[1]?.values || [],
        발주매핑: v[2]?.values || [],
      })
    }

    // ── init13: 마진마스터 → 신시트 이관 (단가DB 8행 추가 + 윙 192건) ──
    if (action === 'init13') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const props = (meta.data.sheets || []).map((s) => s.properties).filter(Boolean) as any[]
      const priceId = props.find((p) => p.title === PRICE_TAB)?.sheetId
      const marginId = props.find((p) => p.title === MARGIN_TAB)?.sheetId
      if (priceId == null || marginId == null) throw new Error('단가DB / 마진계산 탭이 없습니다.')
      const marginLast = 1 + MARGIN_ROWS

      // ── 1. 현황 읽기 ──────────────────────────────────────────
      const pre = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(PRICE_TAB)}!A1:O300`, `${quote(MARGIN_TAB)}!A2:T${marginLast}`],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const priceVals = pre.data.valueRanges?.[0]?.values || []
      const marginVals = pre.data.valueRanges?.[1]?.values || []
      let priceLast = 1
      priceVals.forEach((r, i) => {
        if (i > 0 && String(r?.[0] ?? '').trim() !== '') priceLast = 1 + i
      })
      const priceAliases = new Set(
        priceVals.slice(1).map((r) => String(r?.[0] ?? '').trim()).filter(Boolean),
      )

      // ── 2. 단가DB 신규 별칭 행 추가 (기존 행 무변경) ───────────
      const tplFx = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!G2:K2`,
        valueRenderOption: 'FORMULA',
      })
      const tpl = (tplFx.data.values?.[0] || []).map((x) => String(x ?? ''))
      if (tpl.length < 5 || !tpl[0].startsWith('=')) {
        throw new Error(`단가DB R2 수식 템플릿을 읽지 못했습니다: ${JSON.stringify(tpl)}`)
      }
      // 상대 행 참조($E2 형태)만 새 행 번호로 치환 — 절대 참조($A$12)는 보존
      const reRow = (f: string, to: number) => f.replace(/(\$[A-Z]{1,2})(\d+)/g, `$1${to}`)

      const toAdd = MIGRATION.newRows.filter((n) => !priceAliases.has(n[0] as string))
      const addedRows: any[] = []
      if (toAdd.length) {
        const first = priceLast + 1
        const valuesAF: Cell[][] = []
        const valuesGK: Cell[][] = []
        const valuesLN: Cell[][] = []
        toAdd.forEach((n, i) => {
          const r = first + i
          const [al, rid, g, brand, vendor, status, note, proc, bag] = n as any[]
          valuesAF.push([al, brand, vendor, status, rid, g])
          valuesGK.push(tpl.map((f) => reRow(f, r)))
          valuesLN.push([note, proc, bag])
          addedRows.push({ 행: `R${r}`, 별칭: al, 원료ID: rid || '(빈칸)', g })
        })
        const lastNew = first + toAdd.length - 1
        // 곰표 행 G(대표님 입력)는 수식을 깔지 않음
        keepGompyoG(
          valuesGK,
          toAdd.map((n) => ({ alias: n[0] as Cell, vendor: n[4] as Cell })),
          await readGompyoG(sheets),
        )
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              { range: `${quote(PRICE_TAB)}!A${first}:F${lastNew}`, values: valuesAF },
              { range: `${quote(PRICE_TAB)}!L${first}:N${lastNew}`, values: valuesLN },
            ],
          },
        })
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [{ range: `${quote(PRICE_TAB)}!G${first}:K${lastNew}`, values: valuesGK }],
          },
        })
        // 서식 — 기존 행(R2) 복사 후 J 는 원료ID 유무로 색 분기
        const copyFmt = {
          copyPaste: {
            source: {
              sheetId: priceId,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 15,
            },
            destination: {
              sheetId: priceId,
              startRowIndex: first - 1,
              endRowIndex: lastNew,
              startColumnIndex: 0,
              endColumnIndex: 15,
            },
            pasteType: 'PASTE_FORMAT',
          },
        }
        const jFmt = toAdd.map((n, i) => ({
          repeatCell: {
            range: {
              sheetId: priceId,
              startRowIndex: first - 1 + i,
              endRowIndex: first + i,
              startColumnIndex: 9,
              endColumnIndex: 10,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: (n as any[])[1] ? hex(AUTO_GRAY) : { red: 1, green: 1, blue: 1 },
              },
            },
            fields: 'userEnteredFormat.backgroundColor',
          },
        }))
        // O열(바로가기)은 R2 만 유지 — 복사분 제거
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { requests: [copyFmt, ...jFmt] },
        })
        await sheets.spreadsheets.values.clear({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!O${first}:O${lastNew}`,
          requestBody: {},
        })
        priceLast = lastNew
      }

      // ── 3. 마진계산 기록 위치 — 기존 입력 흔적 아래부터 ────────
      let lastUsed = 1
      const existingKeys = new Set<string>()
      marginVals.forEach((r, i) => {
        const row = (r || []) as any[]
        const touched = [0, 1, 2, 3, 4, 7, 17].some(
          (c) => String(row[c] ?? '').trim() !== '',
        )
        if (touched) lastUsed = 2 + i
        const al = String(row[1] ?? '').trim()
        if (al) existingKeys.add(`${al}|${row[2]}|${row[3]}`)
      })
      const startRow = lastUsed + 1

      // 멱등성 — 별칭+봉수+판매가 가 이미 있으면 건너뜀
      const todo = MIGRATION.records.filter(
        (r: any) => !existingKeys.has(`${r.alias}|${r.bongsu}|${r.price}`),
      )
      // 단가DB 에 없는 별칭은 기록 제외
      const missing = todo.filter((r: any) => !priceAliases.has(r.alias) &&
        !MIGRATION.newRows.some((n) => n[0] === r.alias))
      const writable = todo.filter((r: any) => !missing.includes(r))
      const endRow = startRow + writable.length - 1
      if (endRow > marginLast) {
        throw new Error(`기록 행수 초과: ${startRow}~${endRow} (수식 범위 ${marginLast})`)
      }

      if (writable.length) {
        const colAD: Cell[][] = writable.map((r: any) => [
          MIGRATION_CHANNEL,
          r.alias,
          r.bongsu,
          r.price,
        ])
        const colH: Cell[][] = writable.map((r: any) => [r.size])
        const colK: Cell[][] = writable.map((r: any) => [r.fee])
        const colU: Cell[][] = writable.map((r: any) => [r.flag || ''])
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              { range: `${quote(MARGIN_TAB)}!A${startRow}:D${endRow}`, values: colAD },
              { range: `${quote(MARGIN_TAB)}!H${startRow}:H${endRow}`, values: colH },
              { range: `${quote(MARGIN_TAB)}!K${startRow}:K${endRow}`, values: colK },
              { range: `${quote(MARGIN_TAB)}!U${startRow}:U${endRow}`, values: colU },
            ],
          },
        })

        // ── 4. 의심 행 노란 표시 (A~D) ──────────────────────────
        const yellowRuns: [number, number][] = []
        writable.forEach((r: any, i: number) => {
          if (!r.flag) return
          const last = yellowRuns[yellowRuns.length - 1]
          if (last && last[1] === i) last[1] = i + 1
          else yellowRuns.push([i, i + 1])
        })
        const reqs: any[] = yellowRuns.map(([s, e]) => ({
          repeatCell: {
            range: {
              sheetId: marginId,
              startRowIndex: startRow - 1 + s,
              endRowIndex: startRow - 1 + e,
              startColumnIndex: 0,
              endColumnIndex: 4,
            },
            cell: { userEnteredFormat: { backgroundColor: hex(SUSPECT_YELLOW) } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        }))
        reqs.push({
          repeatCell: {
            range: {
              sheetId: marginId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 20,
              endColumnIndex: 21,
            },
            cell: {
              userEnteredValue: { stringValue: '이관 확인사유' },
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
              },
            },
            fields:
              'userEnteredValue,userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
          },
        })
        if (reqs.length) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: TARGET_SHEET_ID,
            requestBody: { requests: reqs },
          })
        }
      }

      // ── 5. 이관 후 대조 (읽기만) ──────────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:U${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const bv = back.data.values || []
      const byKey = new Map<string, any[]>()
      bv.forEach((r) => {
        const row = (r || []) as any[]
        const al = String(row[1] ?? '').trim()
        if (al) byKey.set(`${al}|${row[2]}|${row[3]}`, row)
      })
      const num = (v: any) => (typeof v === 'number' ? v : null)
      const diffs: any[] = []
      let compared = 0
      let notFound = 0
      for (const r of MIGRATION.records as any[]) {
        const row = byKey.get(`${r.alias}|${r.bongsu}|${r.price}`)
        if (!row) {
          notFound++
          continue
        }
        compared++
        const pairs: [string, number, any][] = [
          ['원가', r.mCost, num(row[5])],
          ['총비용', r.mTotal, num(row[13])],
          ['마진', r.mProfit, num(row[14])],
        ]
        for (const [fld, mv, sv] of pairs) {
          if (sv == null) {
            diffs.push({ 별칭: r.alias, 봉수: r.bongsu, 항목: fld, 마스터: mv, 신시트: null, 차이: null })
            continue
          }
          const d = Math.round((sv - mv) * 100) / 100
          if (Math.abs(d) >= 1) {
            diffs.push({
              별칭: r.alias,
              봉수: r.bongsu,
              항목: fld,
              마스터: Math.round(mv * 100) / 100,
              신시트: Math.round(sv * 100) / 100,
              차이: d,
            })
          }
        }
      }
      diffs.sort((a, b) => Math.abs(b.차이 ?? 0) - Math.abs(a.차이 ?? 0))

      return NextResponse.json({
        ok: true,
        message: '마진마스터 → 신시트 이관 완료',
        summary: {
          단가DB_추가행: addedRows.length,
          단가DB_마지막행: priceLast,
          마진계산_기록시작: `R${startRow}`,
          마진계산_기록행수: writable.length,
          이미존재_건너뜀: MIGRATION.records.length - todo.length,
          단가DB_별칭없어_제외: missing.length ? missing.map((m: any) => m.alias) : 0,
          마스터_결측제외: MIGRATION.skipped,
          대조_비교건수: compared,
          대조_행못찾음: notFound,
          차이_1원이상_건수: diffs.length,
        },
        단가DB_추가: addedRows,
        차이_상위30: diffs.slice(0, 30),
      })
    }

    // ── init14: init13 이관분 롤백 (마진계산 R9~R200 입력값 제거) ──
    if (action === 'init14') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const marginId = (meta.data.sheets || []).find((s) => s.properties?.title === MARGIN_TAB)
        ?.properties?.sheetId
      if (marginId == null) throw new Error(`'${MARGIN_TAB}' 탭이 없습니다.`)
      const R0 = ROLLBACK_FROM // 9
      const R1 = ROLLBACK_TO // 200
      const marginLast = 1 + MARGIN_ROWS

      // 사전 스냅샷 — R2~R8 무변경 확인용
      const pre = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:U8`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const beforeTop = pre.data.values || []

      // 입력 컬럼 색 표본 (D2 = 판매가, 입력 컬럼)
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!D2`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const inputBg =
        gd.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.effectiveFormat
          ?.backgroundColor || { red: 1, green: 1, blue: 1 }

      // ── 1. 입력값 클리어 (자동 수식 컬럼 F·G·I·J·L~T 는 손대지 않음) ──
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          ranges: [
            `${quote(MARGIN_TAB)}!A${R0}:E${R1}`,
            `${quote(MARGIN_TAB)}!H${R0}:H${R1}`,
            `${quote(MARGIN_TAB)}!K${R0}:K${R1}`,
            `${quote(MARGIN_TAB)}!U${R0}:U${R1}`,
            `${quote(MARGIN_TAB)}!U1`,
          ],
        },
      })

      // ── 2. K 수수료율 — 빈칸 자동참조 수식 복원 (init9 와 동일) ──
      const chCol = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('채널DB')}!A2:A200`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      let chLast = 1
      ;(chCol.data.values || []).forEach((r, i) => {
        if (String(r?.[0] ?? '').trim() !== '') chLast = 2 + i
      })
      const CH3 = `'채널DB'!$A$2:$C$${chLast}`
      const colK: Cell[][] = []
      for (let r = R0; r <= R1; r++) {
        colK.push([`=IF($A${r}<>"${SMART_STORE}","",IFERROR(VLOOKUP($A${r},${CH3},3,FALSE),""))`])
      }
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!K${R0}:K${R1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: colK },
      })

      // ── 3. 노란 배경 제거 → 입력 컬럼 색 복원 / U열 서식 초기화 ──
      const grid = (r0: number, r1: number, c0: number, c1: number) => ({
        sheetId: marginId,
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
                range: grid(R0 - 1, R1, 0, 5),
                cell: { userEnteredFormat: { backgroundColor: inputBg } },
                fields: 'userEnteredFormat.backgroundColor',
              },
            },
            {
              repeatCell: {
                range: grid(R0 - 1, R1, 7, 8),
                cell: { userEnteredFormat: { backgroundColor: inputBg } },
                fields: 'userEnteredFormat.backgroundColor',
              },
            },
            {
              repeatCell: {
                range: grid(R0 - 1, R1, 10, 11),
                cell: { userEnteredFormat: { backgroundColor: inputBg } },
                fields: 'userEnteredFormat.backgroundColor',
              },
            },
            {
              repeatCell: {
                range: grid(0, R1, 20, 21),
                cell: {},
                fields: 'userEnteredFormat',
              },
            },
          ],
        },
      })

      // ── 4. 검증 ───────────────────────────────────────────────
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A2:U${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const bv = back.data.values || []
      const filled: string[] = []
      let aliasRows = 0
      bv.forEach((r, i) => {
        const row = (r || []) as any[]
        if ([0, 1, 2, 3, 4, 7, 17, 20].some((c) => String(row[c] ?? '').trim() !== '')) {
          filled.push(`R${2 + i}`)
        }
        if (String(row[1] ?? '').trim() !== '') aliasRows++
      })
      const afterTop = bv.slice(0, 7).map((r) => (r || []).slice(0, 21))
      const norm = (x: any[][]) => JSON.stringify(x.map((r) => r.map((v) => v ?? '')))
      const topSame = norm(beforeTop as any[][]) === norm(afterTop as any[][])

      return NextResponse.json({
        ok: true,
        message: `init13 이관분 롤백 완료 (마진계산 R${R0}~R${R1})`,
        summary: {
          클리어_범위: `A${R0}:E${R1} · H · K · U (+U1 헤더)`,
          입력_흔적_남은_행: filled,
          입력_행수: filled.length,
          별칭_입력행수: aliasRows,
          'R2~R8 무변경': topSame,
          자동수식_컬럼: 'F·G·I·J·L~T 미변경 / K 는 자동참조 수식 복원',
        },
      })
    }

    // ── init16: 단가DB 행 확장 대비 정비 (R2~R300, 멱등) ──────────
    // 파생 수식(G·H·I·J·K)은 "빈 셀에만" 채운다 → 기존 값·수기 입력은 절대 건드리지 않음.
    if (action === 'init16') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))',
      })
      const priceProp = (meta.data.sheets || []).find((s) => s.properties?.title === PRICE_TAB)
        ?.properties
      if (priceProp?.sheetId == null) throw new Error(`'${PRICE_TAB}' 탭이 없습니다.`)
      const priceId = priceProp.sheetId as number
      const LAST = PRICE_ROWS_TO

      // ── 0. 시트 행수 확보 (R300 까지) ─────────────────────────
      const rowCount = priceProp.gridProperties?.rowCount ?? 0
      const addedRowCount = rowCount < LAST ? LAST - rowCount : 0
      if (addedRowCount) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            requests: [
              { appendDimension: { sheetId: priceId, dimension: 'ROWS', length: addedRowCount } },
            ],
          },
        })
      }

      // ── 1. 사전 스냅샷 (수식 원문) ────────────────────────────
      const pre = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A2:O${LAST}`,
        valueRenderOption: 'FORMULA',
      })
      const before = (pre.data.values || []) as any[][]
      const at = (r: number, c: number) => String((before[r - 2] || [])[c] ?? '').trim()

      let priceLast = 1
      for (let r = 2; r <= LAST; r++) if (at(r, 0) !== '') priceLast = r

      // ── 2. R2 파생 수식 템플릿 (G~K) ──────────────────────────
      const tpl = [6, 7, 8, 9, 10].map((c) => at(2, c))
      if (!tpl[0].startsWith('=') || !tpl[1].startsWith('=')) {
        throw new Error(`단가DB R2 파생 수식 템플릿을 읽지 못했습니다: ${JSON.stringify(tpl)}`)
      }
      // 상대 행 참조($E2)만 대상 행으로 치환 — 절대 참조($A$12)는 보존 (init13 과 동일)
      const reRow = (f: string, to: number) => f.replace(/(\$[A-Z]{1,2})(\d+)/g, `$1${to}`)

      // ── 3. 빈 셀에만 파생 수식 채우기 ─────────────────────────
      // J(총 공급가)만 예외: 기존 행에서 원료ID가 빈 행은 비진도팜 = 수기 입력 칸이라
      // (init11·init12 설계) 수식을 깔지 않는다. 신규 빈 행(R{priceLast+1}~)에는 깐다.
      const isManualJ = (r: number) => r <= priceLast && at(r, 4) === ''
      const AUTO_COLS = [
        { letter: 'G', idx: 6, t: 0, name: '원곡가' },
        { letter: 'H', idx: 7, t: 1, name: '소포장 공급가' },
        { letter: 'I', idx: 8, t: 2, name: '벌크 공급가' },
        { letter: 'J', idx: 9, t: 3, name: '총 공급가(소포장)' },
        { letter: 'K', idx: 10, t: 4, name: '과세여부' },
      ]
      const data: { range: string; values: Cell[][] }[] = []
      const filledCount: Record<string, number> = {}
      for (const c of AUTO_COLS) {
        let run: number[] = []
        let n = 0
        const flush = () => {
          if (!run.length) return
          data.push({
            range: `${quote(PRICE_TAB)}!${c.letter}${run[0]}:${c.letter}${run[run.length - 1]}`,
            values: run.map((r) => [reRow(tpl[c.t], r)]),
          })
          n += run.length
          run = []
        }
        for (let r = 2; r <= LAST; r++) {
          // 곰표 행 G 는 대표님 입력칸 — 비어 있어도 수식을 깔지 않음
          const skip = (c.letter === 'J' && isManualJ(r)) || (c.letter === 'G' && isGompyo(at(r, 2)))
          if (at(r, c.idx) === '' && !skip) run.push(r)
          else flush()
        }
        flush()
        filledCount[`${c.letter} ${c.name}`] = n
      }
      if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { valueInputOption: 'USER_ENTERED', data },
        })
      }

      // ── 4. 드롭다운·서식 R300 까지 확장 ───────────────────────
      const grid = (r0: number, r1: number, c0: number, c1: number) => ({
        sheetId: priceId,
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
      const autoBg = hex(AUTO_GRAY)
      const whiteBg = { red: 1, green: 1, blue: 1 }
      const band = (c0: number, c1: number, r0: number, r1: number, bg: any) => ({
        repeatCell: {
          range: grid(r0, r1, c0, c1),
          cell: { userEnteredFormat: { backgroundColor: bg } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      })

      // J — init12 규칙 유지: 기존 행 중 원료ID 빈 행(비진도팜 수기칸)은 흰색, 그 외 자동 회색
      const jManual: number[] = []
      const jGrayRuns: [number, number][] = []
      const jWhiteRuns: [number, number][] = []
      for (let r = 2; r <= LAST; r++) {
        const manual = isManualJ(r)
        if (manual) jManual.push(r)
        const runs = manual ? jWhiteRuns : jGrayRuns
        const tail = runs[runs.length - 1]
        if (tail && tail[1] === r) tail[1] = r + 1
        else runs.push([r, r + 1])
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // D 취급상태 O/X — D2:D300
            {
              setDataValidation: {
                range: grid(1, LAST, 3, 4),
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
            // E 원료ID — 원가표미러 원료 목록 드롭다운 · E2:E300
            { setDataValidation: { range: grid(1, LAST, 4, 5), rule: rangeRule(MIRROR_ID_RANGE) } },
            // G~I 자동 파생 회색
            band(6, 9, 1, LAST, autoBg),
            // J 회색/흰색 분기
            ...jGrayRuns.map(([s, e]) => band(9, 10, s - 1, e - 1, autoBg)),
            ...jWhiteRuns.map(([s, e]) => band(9, 10, s - 1, e - 1, whiteBg)),
            // F~J 천단위 콤마
            {
              repeatCell: {
                range: grid(1, LAST, 5, 10),
                cell: {
                  userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } },
                },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
          ],
        },
      })

      // ── 5. 검증1 — 원래 비어있지 않던 셀 전부 무변동 ──────────
      const post = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A2:O${LAST}`,
        valueRenderOption: 'FORMULA',
      })
      const after = (post.data.values || []) as any[][]
      const atAfter = (r: number, c: number) => String((after[r - 2] || [])[c] ?? '').trim()
      const colName = (c: number) => String.fromCharCode(65 + c)
      const changed: string[] = []
      let keptCells = 0
      for (let r = 2; r <= LAST; r++) {
        for (let c = 0; c < 15; c++) {
          const b = at(r, c)
          if (b === '') continue
          if (b === atAfter(r, c)) keptCells++
          else if (changed.length < 20) changed.push(`R${r}${colName(c)}`)
        }
      }

      // ── 6. 검증2 — 파로 행 전부 ───────────────────────────────
      const paroRows: number[] = []
      for (let r = 2; r <= LAST; r++) if (at(r, 0).includes('파로')) paroRows.push(r)
      const paro: any[] = []
      for (const r of paroRows) {
        const shown = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!A${r}:K${r}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const sv = shown.data.values?.[0] || []
        const rid = at(r, 4)
        const g = at(r, 5)
        paro.push({
          행: `R${r}`,
          별칭: at(r, 0),
          원료ID: rid || '(미선택)',
          g: g || '(빈칸)',
          G_수식_적용: atAfter(r, 6).startsWith('='),
          G_현재값: sv[6] ?? '',
          남은_수기입력: rid === '' ? 'E 원료ID' : g === '' ? 'F g(용량)' : '없음',
          비고:
            rid !== '' && g === ''
              ? '수식은 깔렸지만 기존 IF 구조상 g 가 비면 빈칸 — g 입력 시 즉시 자동 계산'
              : '',
        })
      }

      // ── 7. 검증3 — 빈 행 프로브 (원료ID 넣으면 원곡가 자동 계산) ─
      const mirror = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`'원가표미러'!A11:P11`, `'원가표미러'!A12:P200`],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const mHead = (mirror.data.valueRanges?.[0]?.values?.[0] || []).map((x: any) =>
        String(x ?? '').trim(),
      )
      const mRows = (mirror.data.valueRanges?.[1]?.values || []) as any[][]
      const iWongok = mHead.indexOf(COL_WONGOK)
      const sample = mRows.find(
        (r) => String(r?.[0] ?? '').trim() !== '' && typeof r?.[iWongok] === 'number',
      )
      let probeRow: number | null = null
      for (let r = LAST; r >= 2; r--) {
        if (at(r, 0) === '' && at(r, 4) === '' && at(r, 5) === '') {
          probeRow = r
          break
        }
      }
      let probe: any = null
      if (probeRow && sample && iWongok >= 0) {
        const rid = String(sample[0]).trim()
        await sheets.spreadsheets.values.update({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!E${probeRow}:F${probeRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[rid, 1000]] },
        })
        const got = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!G${probeRow}:K${probeRow}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const gv = got.data.values?.[0] || []
        // 프로브 원복 — 넣었던 E·F 만 삭제 (수식은 그대로 남아 빈칸 표시로 복귀)
        await sheets.spreadsheets.values.clear({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!E${probeRow}:F${probeRow}`,
          requestBody: {},
        })
        const back = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!E${probeRow}:K${probeRow}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const bv = back.data.values?.[0] || []
        const expect = Number(sample[iWongok])
        probe = {
          프로브행: `R${probeRow}`,
          투입: { 원료ID: rid, g: 1000 },
          G_원곡가: gv[0] ?? null,
          H_소포장: gv[1] ?? null,
          I_벌크: gv[2] ?? null,
          J_총공급가: gv[3] ?? null,
          K_과세여부: gv[4] ?? null,
          기대_원곡가: expect,
          원곡가_자동계산: typeof gv[0] === 'number' && Math.abs(gv[0] - expect) < 0.5,
          원복_후_빈칸: bv.every((v: any) => String(v ?? '').trim() === ''),
        }
      }

      // ── 8. 검증4 — 드롭다운 실제 적용 확인 (R300) ─────────────
      const dv = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(PRICE_TAB)}!D${LAST}:E${LAST}`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(dataValidation(condition(type,values(userEnteredValue)))))))',
      })
      const dvRow = dv.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
      const dvOf = (i: number) => {
        const cond = dvRow[i]?.dataValidation?.condition
        if (!cond) return null
        return {
          type: cond.type,
          values: (cond.values || []).map((v: any) => v.userEnteredValue),
        }
      }

      return NextResponse.json({
        ok: true,
        message: `단가DB 행 확장 대비 정비 완료 (R2~R${LAST})`,
        summary: {
          단가DB_마지막_데이터행: `R${priceLast}`,
          수식_적용_하한: `R${LAST}`,
          시트_행_추가: addedRowCount || 0,
          빈칸_채운_셀수: filledCount,
          J_수기입력칸_흰색_유지행수: jManual.length,
          비고: [
            'K(과세여부)도 같은 자동 파생 컬럼이라 함께 깔았다 — 안 깔면 신규 행 과세여부가 빈칸으로 남는다',
            'J 는 기존 행 중 원료ID 빈 행(비진도팜 수기 입력칸)에는 깔지 않고 흰색 유지 (init11·init12 설계 보존)',
          ],
        },
        검증1_기존값_무변동: {
          '비어있지 않던 셀 수': keptCells,
          변경된_셀: changed.length ? changed : 0,
          판정: changed.length === 0,
        },
        검증2_파로행: paro,
        검증3_빈행_프로브: probe,
        검증4_드롭다운: {
          [`D${LAST} 취급상태`]: dvOf(0),
          [`E${LAST} 원료ID`]: dvOf(1),
          적용범위: `D2:D${LAST} · E2:E${LAST}`,
        },
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

    // ── inspectUX: 마진계산 W~AB 점유 여부 · 색 표본 읽기 전용 (쓰기 없음) ──
    if (action === 'inspectUX') {
      const sheets = getSheets()
      const marginLast = 1 + MARGIN_ROWS
      const val = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [
          `${quote(MARGIN_TAB)}!W1:AB${marginLast}`,
          `${quote(MARGIN_TAB)}!A1:Z1`,
          `${quote('채널DB')}!A1:H20`,
        ],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const fx = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!W1:AB${marginLast}`,
        valueRenderOption: 'FORMULA',
      })
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!A1:Z1`, `${quote(MARGIN_TAB)}!A2:Z2`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const bgRow = (i: number) =>
        (gd.data.sheets?.[0]?.data?.[i]?.rowData?.[0]?.values || []).map(
          (c) => c.effectiveFormat?.backgroundColor
        )
      const cellsOf = (rows: Cell[][]) => {
        const out: { 셀: string; 값: Cell }[] = []
        ;(rows || []).forEach((r, ri) =>
          (r || []).forEach((c, ci) => {
            if (String(c ?? '').trim() === '') return
            out.push({ 셀: `${UX_LETTERS[ci] ?? `+${ci}`}${ri + 1}`, 값: c })
          })
        )
        return out
      }
      const v = val.data.valueRanges || []
      const occVal = cellsOf((v[0]?.values || []) as Cell[][])
      const occFx = cellsOf((fx.data.values || []) as Cell[][])
      return NextResponse.json({
        ok: true,
        WAB_비어있음: occVal.length === 0 && occFx.length === 0,
        WAB_점유_값: occVal.slice(0, 20),
        WAB_점유_수식: occFx.slice(0, 20),
        마진계산_헤더_A_Z: v[1]?.values?.[0] || [],
        헤더1행_배경: bgRow(0),
        데이터2행_배경: bgRow(1),
        채널DB: v[2]?.values || [],
      })
    }

    // ── init17: 마진계산 W~Z 쿠팡 1P 준비 열 + 채널DB 쿠팡 1P 수수료율 0 ──
    //   · 열 삽입 없음 — 빈 W~Z 에 헤더만 기입. A~T 값·수식과 V1 안내문은 건드리지 않는다.
    //   · W~AB 에 예상 헤더 외 값·수식이 하나라도 있으면 아무것도 쓰지 않고 중단.
    //   · U 열·V1(사용안내 문구)은 검사·기입 대상에서 제외.
    if (action === 'init17') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))',
      })
      const marginProps = (meta.data.sheets || []).find(
        (s) => s.properties?.title === MARGIN_TAB
      )?.properties
      const marginId = marginProps?.sheetId
      if (marginId == null) throw new Error(`'${MARGIN_TAB}' 탭이 없습니다.`)
      const colCount = marginProps?.gridProperties?.columnCount ?? 0
      if (colCount < 26) throw new Error(`'${MARGIN_TAB}' 열 수 부족: ${colCount} (26 이상 필요)`)
      const channelId = (meta.data.sheets || []).find((s) => s.properties?.title === '채널DB')
        ?.properties?.sheetId
      if (channelId == null) throw new Error(`'채널DB' 탭이 없습니다.`)
      const marginLast = 1 + MARGIN_ROWS // 301

      // ── 0. 사전 가드 — W~AB 값·수식 점유 검사 (U·V1 제외) ───────
      const pre = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!W1:AB${marginLast}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const preFx = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!W1:AB${marginLast}`,
        valueRenderOption: 'FORMULA',
      })
      // 재실행 허용 — W1~Z1 이 이미 같은 헤더인 경우만 점유로 보지 않는다
      const strayOf = (rows: Cell[][]) => {
        const out: { 셀: string; 값: Cell }[] = []
        ;(rows || []).forEach((r, ri) =>
          (r || []).forEach((c, ci) => {
            const s = String(c ?? '').trim()
            if (s === '') return
            if (ri === 0 && ci < 4 && s === COUPANG_1P_HEADER[ci]) return
            out.push({ 셀: `${UX_LETTERS[ci] ?? `+${ci}`}${ri + 1}`, 값: c })
          })
        )
        return out
      }
      const stray = [
        ...strayOf((pre.data.values || []) as Cell[][]),
        ...strayOf((preFx.data.values || []) as Cell[][]),
      ]
      if (stray.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `마진계산 W~AB 가 비어있지 않습니다 (${stray.length}셀) — 쓰기 중단`,
            점유셀: stray.slice(0, 10),
          },
          { status: 409 }
        )
      }

      // ── 1. 색 표본 — K1(수기 입력 컬럼 헤더) · D2(수기 입력 데이터) ──
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!K1`, `${quote(MARGIN_TAB)}!D2`],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      })
      const bgAt = (i: number) =>
        gd.data.sheets?.[0]?.data?.[i]?.rowData?.[0]?.values?.[0]?.effectiveFormat?.backgroundColor
      const headerBg = bgAt(0) || { red: 0.95, green: 0.95, blue: 0.95 }
      const inputBg = bgAt(1) || { red: 1, green: 1, blue: 1 }

      // ── 2. 헤더 기입 (W1:Z1) ──────────────────────────────────
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!W1:Z1`,
        valueInputOption: 'RAW',
        requestBody: { values: [COUPANG_1P_HEADER] },
      })

      // ── 3. 서식 (W~Z, 데이터 2~301행) ─────────────────────────
      const grid = (r0: number, r1: number, c0: number, c1: number) => ({
        sheetId: marginId,
        startRowIndex: r0,
        endRowIndex: r1,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // 헤더 W~Z — 수기 입력 컬럼 헤더와 같은 색 + 볼드
            {
              repeatCell: {
                range: grid(0, 1, 22, 26),
                cell: {
                  userEnteredFormat: { textFormat: { bold: true }, backgroundColor: headerBg },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
              },
            },
            // 데이터 W~Z — 수기 입력 배경
            {
              repeatCell: {
                range: grid(1, marginLast, 22, 26),
                cell: { userEnteredFormat: { backgroundColor: inputBg } },
                fields: 'userEnteredFormat.backgroundColor',
              },
            },
            // W 노출ID · X 옵션ID — 텍스트 서식 (긴 숫자 ID 지수표기 방지)
            {
              repeatCell: {
                range: grid(1, marginLast, 22, 24),
                cell: {
                  userEnteredFormat: {
                    numberFormat: { type: 'TEXT' },
                    horizontalAlignment: 'LEFT',
                  },
                },
                fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment',
              },
            },
            // Y 소비자가(1P) — 숫자(쉼표)
            {
              repeatCell: {
                range: grid(1, marginLast, 24, 25),
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
            // Z 쿠팡마진율(1P) — 퍼센트 (마진율 P열과 동일 표기)
            {
              repeatCell: {
                range: grid(1, marginLast, 25, 26),
                cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
          ],
        },
      })

      // ── 4. 채널DB '쿠팡 1P' 수수료율(B) → 0 (해당 행만) ────────
      const ch = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('채널DB')}!A1:B60`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      const chRows = (ch.data.values || []) as Cell[][]
      const idx = chRows.findIndex((r, i) => i > 0 && String(r?.[0] ?? '').trim() === '쿠팡 1P')
      if (idx < 0) throw new Error(`채널DB 에 '쿠팡 1P' 행이 없습니다.`)
      const chRow = idx + 1 // 1-based 시트 행번호
      const before1P = chRows[idx]?.[1] ?? ''
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('채널DB')}!B${chRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[0]] },
      })

      // ── 5. 결과 확인 ─────────────────────────────────────────
      const post = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!A1:Z1`, `${quote('채널DB')}!A1:B20`],
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      return NextResponse.json({
        ok: true,
        message: '마진계산 W~Z(쿠팡 1P 준비) 헤더·서식 + 채널DB 쿠팡 1P 수수료율 0 완료',
        마진계산_헤더_A_Z: post.data.valueRanges?.[0]?.values?.[0] || [],
        채널DB_A_B: post.data.valueRanges?.[1]?.values || [],
        쿠팡1P_수수료율: { 행: chRow, 이전: before1P, 이후: 0 },
        서식: { W: 'TEXT', X: 'TEXT', Y: '#,##0', Z: '0.0% (PERCENT)' },
        비고: '열 삽입 없음 · A~T·V1 안내문·단가DB 무변경 · 원가표 시트 미접근',
      })
    }

    // ── init18: 마진계산 Y·Z 헤더 이름 변경 + 서식 전환 (데이터 입력 없음) ──
    //   · Y1 '소비자가(1P)' → '1P 상품코드' (Y2:Y301 텍스트)
    //   · Z1 '쿠팡마진율(1P)' → '1P 납품가(부가포함)' (Z2:Z301 #,##0)
    //   · Y1·Z1 이 기존 헤더가 아니거나 Y2:Z301 에 값·수식이 있으면 쓰지 않고 409.
    //   · A~X 값·수식은 실행 전·후 해시로 무변경 확인.
    if (action === 'init18') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const marginId = (meta.data.sheets || []).find((s) => s.properties?.title === MARGIN_TAB)
        ?.properties?.sheetId
      if (marginId == null) throw new Error(`'${MARGIN_TAB}' 탭이 없습니다.`)
      const marginLast = 1 + MARGIN_ROWS // 301

      const hashAX = async () => {
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: TARGET_SHEET_ID,
          ranges: [`${quote(MARGIN_TAB)}!A1:X${marginLast}`],
          valueRenderOption: 'FORMULA',
        })
        return createHash('sha256')
          .update(JSON.stringify(res.data.valueRanges?.[0]?.values || []))
          .digest('hex')
      }

      // ── 0. 가드 — Y1·Z1 기존 헤더 + Y2:Z301 값·수식 비어있음 ─────
      const pre = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!Y1:Z${marginLast}`,
        valueRenderOption: 'FORMULA',
      })
      const preRows = (pre.data.values || []) as Cell[][]
      const head = [String(preRows[0]?.[0] ?? '').trim(), String(preRows[0]?.[1] ?? '').trim()]
      if (head[0] !== COUPANG_1P_YZ_OLD[0] || head[1] !== COUPANG_1P_YZ_OLD[1]) {
        return NextResponse.json(
          { ok: false, error: 'Y1·Z1 이 기존 헤더가 아닙니다 — 쓰기 중단', 현재_Y1_Z1: head },
          { status: 409 }
        )
      }
      const stray: { 셀: string; 값: Cell }[] = []
      preRows.slice(1).forEach((r, ri) =>
        (r || []).forEach((c, ci) => {
          if (String(c ?? '').trim() !== '') stray.push({ 셀: `${ci === 0 ? 'Y' : 'Z'}${ri + 2}`, 값: c })
        })
      )
      if (stray.length > 0) {
        return NextResponse.json(
          { ok: false, error: `마진계산 Y2:Z${marginLast} 가 비어있지 않습니다 (${stray.length}셀) — 쓰기 중단`, 점유셀: stray.slice(0, 10) },
          { status: 409 }
        )
      }
      const before = await hashAX()

      // ── 1. 헤더 (Y1:Z1) ──────────────────────────────────────
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!Y1:Z1`,
        valueInputOption: 'RAW',
        requestBody: { values: [COUPANG_1P_YZ_NEW] },
      })

      // ── 2. 서식 (Y·Z, 데이터 2~301행) ─────────────────────────
      const grid = (c0: number, c1: number) => ({
        sheetId: marginId,
        startRowIndex: 1,
        endRowIndex: marginLast,
        startColumnIndex: c0,
        endColumnIndex: c1,
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            // Y 1P 상품코드 — 텍스트 (8자리 코드 숫자 변환 방지)
            {
              repeatCell: {
                range: grid(24, 25),
                cell: {
                  userEnteredFormat: { numberFormat: { type: 'TEXT' }, horizontalAlignment: 'LEFT' },
                },
                fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment',
              },
            },
            // Z 1P 납품가(부가포함) — 숫자(쉼표)
            {
              repeatCell: {
                range: grid(25, 26),
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
                fields: 'userEnteredFormat.numberFormat',
              },
            },
          ],
        },
      })

      // ── 3. 결과 확인 ─────────────────────────────────────────
      const after = await hashAX()
      const post = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!A1:Z1`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      return NextResponse.json({
        ok: true,
        message: '마진계산 Y·Z 헤더 이름 변경 + 서식 전환 완료',
        마진계산_헤더_A_Z: post.data.values?.[0] || [],
        A_X_해시: { 전: before, 후: after, 동일: before === after },
        서식: { Y: 'TEXT', Z: '#,##0' },
        비고: '데이터 입력 없음 · A~X·V1 안내문·단가DB·채널DB 무변경 · 원가표 시트 미접근',
      })
    }

    // ── init19: 단가DB H·I 곰표 분기 + 비용DB 곰표 작업비 3줄 ──────
    //   · H: C="곰표" → G + 비용DB '곰표 작업비 {g}' (G·작업비 빈칸이면 ""), 그 외 → 기존 H 수식 그대로
    //   · I: C="곰표" → H, 그 외 → 기존 I 수식 그대로
    //   · 기존 수식은 FORMULA 로 읽어 감싸기만 한다 (재조립 없음). 수기 값·빈칸·이미 감싼 행은 건너뜀.
    //   · 비용DB A4:D6 가 비어있지 않으면 쓰지 않고 409.
    //   · 단가DB A~G·J~M 값·수식은 실행 전·후 해시, H·I 는 계산값 비교로 무변경 확인.
    if (action === 'init19') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const costDbId = (meta.data.sheets || []).find((s) => s.properties?.title === '비용DB')
        ?.properties?.sheetId
      if (costDbId == null) throw new Error(`'비용DB' 탭이 없습니다.`)
      const LAST = PRICE_ROWS_TO // 300

      // ── 0. 가드 — 비용DB A4:D6 값·수식 비어있음 ─────────────────
      const costPre = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('비용DB')}!A4:D6`,
        valueRenderOption: 'FORMULA',
      })
      const costStray = ((costPre.data.values || []) as Cell[][]).flat().filter((c) => String(c ?? '').trim() !== '')
      if (costStray.length > 0) {
        return NextResponse.json(
          { ok: false, error: '비용DB A4:D6 가 비어있지 않습니다 — 쓰기 중단', 현재: costPre.data.values },
          { status: 409 }
        )
      }

      // ── 1. 단가DB 스냅샷 (수식 원문 · 계산값) ──────────────────
      const snap = async () => {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!A2:M${LAST}`,
          valueRenderOption: 'FORMULA',
        })
        const val = await sheets.spreadsheets.values.get({
          spreadsheetId: TARGET_SHEET_ID,
          range: `${quote(PRICE_TAB)}!A2:M${LAST}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const fx = (res.data.values || []) as Cell[][]
        const vals = (val.data.values || []) as Cell[][]
        // A~G(0~6) · J~M(9~12) 만 해시 — H·I(7·8)는 제외 (init20 J열 삭제 후 구조)
        const keep = (rows: Cell[][]) =>
          rows.map((r) => [...(r || []).slice(0, 7), ...(r || []).slice(9, 13)])
        const hash = createHash('sha256')
          .update(JSON.stringify([keep(fx), keep(vals)]))
          .digest('hex')
        const hi = Array.from({ length: LAST - 1 }, (_, i) => [
          (vals[i] || [])[7] ?? '',
          (vals[i] || [])[8] ?? '',
        ])
        return { fx, hash, hi }
      }
      const before = await snap()
      const fxAt = (r: number, c: number) => String((before.fx[r - 2] || [])[c] ?? '').trim()

      // ── 2. H·I 새 수식 (행별, 기존 수식 감싸기) ─────────────────
      const WRAP_MARK = `TRIM($C`
      const manualRows: { 행: number; H: Cell; I: Cell }[] = []
      const skippedBlank: number[] = []
      let already = 0
      const data: { range: string; values: Cell[][] }[] = []
      let run: { r: number; hi: Cell[] }[] = []
      const flush = () => {
        if (!run.length) return
        data.push({
          range: `${quote(PRICE_TAB)}!H${run[0].r}:I${run[run.length - 1].r}`,
          values: run.map((x) => x.hi),
        })
        run = []
      }
      for (let r = 2; r <= LAST; r++) {
        const h = fxAt(r, 7)
        const i = fxAt(r, 8)
        if (h === '' && i === '') {
          skippedBlank.push(r)
          flush()
          continue
        }
        if (!h.startsWith('=') || !i.startsWith('=')) {
          manualRows.push({ 행: r, H: h, I: i })
          flush()
          continue
        }
        if (h.includes(WRAP_MARK) || i.includes(WRAP_MARK)) {
          already++
          flush()
          continue
        }
        const key = `"곰표 작업비 "&IF($F${r}<1000,$F${r}&"g",$F${r}/1000&"kg")`
        const labor = `IFERROR(VLOOKUP(${key},'비용DB'!$A:$B,2,FALSE),"")`
        const newH =
          `=IF(TRIM($C${r})="${GOMPYO}",IF(OR($G${r}="",${labor}=""),"",$G${r}+${labor}),` +
          `${h.slice(1)})`
        const newI = `=IF(TRIM($C${r})="${GOMPYO}",$H${r},${i.slice(1)})`
        run.push({ r, hi: [newH, newI] })
      }
      flush()

      // ── 3. 비용DB A4:D6 + 서식(A2:D2 → A4:D6) ─────────────────
      await sheets.spreadsheets.values.update({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('비용DB')}!A4:D6`,
        valueInputOption: 'RAW',
        requestBody: { values: GOMPYO_COST_ROWS },
      })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            {
              copyPaste: {
                source: { sheetId: costDbId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 4 },
                destination: { sheetId: costDbId, startRowIndex: 3, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 4 },
                pasteType: 'PASTE_FORMAT',
              },
            },
          ],
        },
      })

      // ── 4. 단가DB H·I 기입 ───────────────────────────────────
      if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { valueInputOption: 'USER_ENTERED', data },
        })
      }

      // ── 5. 검증 ─────────────────────────────────────────────
      const after = await snap()
      const hiDiff: { 행: number; 전: Cell[]; 후: Cell[] }[] = []
      before.hi.forEach((b, i) => {
        const a = after.hi[i]
        if (JSON.stringify(b) !== JSON.stringify(a)) hiDiff.push({ 행: i + 2, 전: b, 후: a })
      })
      const sampleIdx = after.fx.findIndex((r) => String(r?.[0] ?? '').trim() === '[쌀쌀쌀] 캐나다산 렌틸콩 2kg')
      const cost = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote('비용DB')}!A1:D6`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      return NextResponse.json({
        ok: true,
        message: '단가DB H·I 곰표 분기 + 비용DB 곰표 작업비 3줄 완료',
        H_I_재작성_행수: data.reduce((n, d) => n + d.values.length, 0),
        건너뜀: { 수기값: manualRows, 빈칸: skippedBlank.length, 이미_적용: already },
        H_I_계산값: { 변경_행수: hiDiff.length, 변경: hiDiff.slice(0, 10) },
        A_G_J_M_해시: { 전: before.hash, 후: after.hash, 동일: before.hash === after.hash },
        샘플: sampleIdx < 0 ? null : {
          행: sampleIdx + 2,
          H: (after.fx[sampleIdx] || [])[7] ?? '',
          I: (after.fx[sampleIdx] || [])[8] ?? '',
        },
        비용DB_A1_D6: cost.data.values || [],
        비고: '단가DB C·G·마진계산·원가표 시트 무변경',
      })
    }

    // ── inspect20: init20 사전 백업 + 변환 dry-run (쓰기 없음) ──────
    if (action === 'inspect20') {
      const sheets = getSheets()
      const TABS20 = [PRICE_TAB, MARGIN_TAB, MAP_TAB]
      const [fx, val] = await Promise.all(
        (['FORMULA', 'UNFORMATTED_VALUE'] as const).map((opt) =>
          sheets.spreadsheets.values.batchGet({
            spreadsheetId: TARGET_SHEET_ID,
            ranges: TABS20.map((t) => quote(t)),
            valueRenderOption: opt,
          })
        )
      )
      const backup: Record<string, { 수식: Cell[][]; 값: Cell[][] }> = {}
      TABS20.forEach((t, i) => {
        backup[t] = {
          수식: (fx.data.valueRanges?.[i]?.values || []) as Cell[][],
          값: (val.data.valueRanges?.[i]?.values || []) as Cell[][],
        }
      })
      const priceFx = backup[PRICE_TAB].수식
      const jBad = priceFx
        .slice(1)
        .map((r, i) => ({ 행: i + 2, J: String((r || [])[PRICE_J_IDX] ?? '') }))
        .filter((x) => x.J.trim() !== '' && !x.J.startsWith('=IF($H'))
      const plan = await planPriceRefs(sheets)
      const dv = await planPriceValidations(sheets, [MARGIN_TAB, MAP_TAB])
      return NextResponse.json({
        ok: true,
        단가DB_헤더: priceFx[0] || [],
        J_수기값: jBad,
        참조_요약: plan.summary,
        참조_셀수: plan.cells.length,
        변환_오류: plan.errors,
        드롭다운: dv.map((d) => ({
          범위: `${d.tab}!${colName(d.col)}${d.r0 + 1}:${colName(d.col)}${d.r1}`,
          참조: d.rule?.condition?.values?.[0]?.userEnteredValue,
        })),
        오류셀_현재: TABS20.flatMap((t) => errorCellsOf(t, backup[t].값)),
        백업: backup,
      })
    }

    // ── init20: 단가DB J열(총 공급가) 삭제 + 참조 보정 + 범위 열 전체 확장 ──
    //   · 가드: J 에 수기 값 1개라도 / 변환 못 하는 단가DB 참조 1개라도 → 409, 쓰기 없음
    //   · deleteDimension 으로 J 열 삭제 → 타 탭 수식은 삭제 전 원문을 변환해 행별로 다시 기입
    //   · 발주매핑·마진계산의 단가DB A열 드롭다운 → '단가DB'!$A$2:$A (열린 범위)
    //   · 검증에서 오류 셀이 생기면 ok:false 로 보고만 (자동 복구 없음)
    if (action === 'init20') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: TARGET_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const priceId = (meta.data.sheets || []).find((s) => s.properties?.title === PRICE_TAB)
        ?.properties?.sheetId
      if (priceId == null) throw new Error(`'${PRICE_TAB}' 탭이 없습니다.`)
      const TABS20 = [PRICE_TAB, MARGIN_TAB, MAP_TAB]
      const readVals = async () => {
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: TARGET_SHEET_ID,
          ranges: TABS20.map((t) => quote(t)),
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
        const out: Record<string, Cell[][]> = {}
        TABS20.forEach((t, i) => (out[t] = (res.data.valueRanges?.[i]?.values || []) as Cell[][]))
        return out
      }
      const hashOf = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
      // 마진계산 W~Z 전체 + V1 (값·수식)
      const readWZ = async () => {
        const [a, b] = await Promise.all(
          (['FORMULA', 'UNFORMATTED_VALUE'] as const).map((opt) =>
            sheets.spreadsheets.values.batchGet({
              spreadsheetId: TARGET_SHEET_ID,
              ranges: [`${quote(MARGIN_TAB)}!V1`, `${quote(MARGIN_TAB)}!W1:Z${1 + MARGIN_ROWS}`],
              valueRenderOption: opt,
            })
          )
        )
        return hashOf([a.data.valueRanges?.map((v) => v.values), b.data.valueRanges?.map((v) => v.values)])
      }

      // ── 0. 가드 ──────────────────────────────────────────────
      const hdr = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A1:O1000`,
        valueRenderOption: 'FORMULA',
      })
      const priceFx = (hdr.data.values || []) as Cell[][]
      const jHead = String(priceFx[0]?.[PRICE_J_IDX] ?? '').trim()
      if (jHead !== PRICE_J_HEADER_V2) {
        return NextResponse.json(
          { ok: false, error: `단가DB J1 이 '${PRICE_J_HEADER_V2}' 가 아닙니다 — 이미 삭제됐거나 구조가 다름`, J1: jHead, 헤더: priceFx[0] },
          { status: 409 }
        )
      }
      const jBad = priceFx
        .slice(1)
        .map((r, i) => ({ 행: i + 2, J: String((r || [])[PRICE_J_IDX] ?? '') }))
        .filter((x) => x.J.trim() !== '' && !x.J.startsWith('=IF($H'))
      if (jBad.length) {
        return NextResponse.json({ ok: false, error: 'J 에 수기 값이 있습니다 — 쓰기 중단', J_수기값: jBad }, { status: 409 })
      }
      const plan = await planPriceRefs(sheets)
      if (plan.errors.length) {
        return NextResponse.json({ ok: false, error: '변환 못 하는 단가DB 참조 — 쓰기 중단', 변환_오류: plan.errors }, { status: 409 })
      }
      const dv = await planPriceValidations(sheets, [MARGIN_TAB, MAP_TAB])

      const before = await readVals()
      const wzBefore = await readWZ()
      const errBefore = TABS20.flatMap((t) => errorCellsOf(t, before[t]))

      // ── 1. J 열 삭제 ─────────────────────────────────────────
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: TARGET_SHEET_ID,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: { sheetId: priceId, dimension: 'COLUMNS', startIndex: PRICE_J_IDX, endIndex: PRICE_J_IDX + 1 },
              },
            },
          ],
        },
      })

      // ── 2. 타 탭 수식 재기입 (삭제 전 원문 기준 변환, 열별 연속 구간) ──
      const byCol = new Map<string, typeof plan.cells>()
      for (const c of plan.cells) {
        const k = `${c.tab}\u0000${c.col}`
        if (!byCol.has(k)) byCol.set(k, [])
        byCol.get(k)!.push(c)
      }
      const data: { range: string; values: Cell[][] }[] = []
      for (const list of Array.from(byCol.values())) {
        list.sort((a, b) => a.row - b.row)
        let run: typeof plan.cells = []
        const flush = () => {
          if (!run.length) return
          const L = colName(run[0].col)
          data.push({
            range: `${quote(run[0].tab)}!${L}${run[0].row}:${L}${run[run.length - 1].row}`,
            values: run.map((c) => [c.after]),
          })
          run = []
        }
        for (const c of list) {
          if (run.length && run[run.length - 1].row + 1 !== c.row) flush()
          run.push(c)
        }
        flush()
      }
      if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: { valueInputOption: 'USER_ENTERED', data },
        })
      }

      // ── 3. 드롭다운 범위 열기 ─────────────────────────────────
      if (dv.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: TARGET_SHEET_ID,
          requestBody: {
            requests: dv.map((d) => ({
              setDataValidation: {
                range: { sheetId: d.sheetId, startRowIndex: d.r0, endRowIndex: d.r1, startColumnIndex: d.col, endColumnIndex: d.col + 1 },
                rule: {
                  ...d.rule,
                  condition: { ...d.rule.condition, values: [{ userEnteredValue: PRICE_ALIAS_OPEN }] },
                },
              },
            })),
          },
        })
      }

      // ── 4. 검증 ─────────────────────────────────────────────
      const after = await readVals()
      const wzAfter = await readWZ()
      const errAfter = TABS20.flatMap((t) => errorCellsOf(t, after[t]))
      const postFx = await sheets.spreadsheets.values.get({
        spreadsheetId: TARGET_SHEET_ID,
        range: `${quote(PRICE_TAB)}!A1:N${PRICE_ROWS_TO}`,
        valueRenderOption: 'FORMULA',
      })
      const pf = (postFx.data.values || []) as Cell[][]
      // 단가DB 값: 전 A~I·K~N == 후 A~M
      const dropJ = (r: Cell[]) => [...(r || []).slice(0, PRICE_J_IDX), ...(r || []).slice(PRICE_J_IDX + 1, 14)]
      const trim = (r: Cell[]) => {
        const x = [...r]
        while (x.length && String(x[x.length - 1] ?? '') === '') x.pop()
        return x
      }
      const priceDiff: number[] = []
      const nP = Math.max(before[PRICE_TAB].length, after[PRICE_TAB].length)
      for (let i = 0; i < nP; i++) {
        const b = trim(dropJ(before[PRICE_TAB][i] || []))
        const a = trim((after[PRICE_TAB][i] || []).slice(0, 13))
        if (JSON.stringify(a) !== JSON.stringify(b)) priceDiff.push(i + 1)
      }
      // 마진계산 A~T 계산값 전·후
      const marginDiff: { 행: number; 별칭: Cell; 전: Cell[]; 후: Cell[] }[] = []
      const nM = Math.max(before[MARGIN_TAB].length, after[MARGIN_TAB].length)
      for (let i = 1; i < nM; i++) {
        const b = trim((before[MARGIN_TAB][i] || []).slice(0, 20))
        const a = trim((after[MARGIN_TAB][i] || []).slice(0, 20))
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const cols = Array.from({ length: 20 }, (_, c) => c).filter((c) => String(b[c] ?? '') !== String(a[c] ?? ''))
          marginDiff.push({
            행: i + 1,
            별칭: (after[MARGIN_TAB][i] || [])[1] ?? '',
            전: cols.map((c) => `${colName(c)}=${b[c] ?? ''}`),
            후: cols.map((c) => `${colName(c)}=${a[c] ?? ''}`),
          })
        }
      }
      // 단가DB H·I 가공 참조가 $L 로 당겨졌는지
      const procShift = { L: 0, M_잔존: 0 }
      pf.slice(1).forEach((r, i) => {
        const h = String((r || [])[7] ?? '') + String((r || [])[8] ?? '')
        if (h.includes(`$L${i + 2}="파쇄"`)) procShift.L++
        if (h.includes(`$M${i + 2}="파쇄"`)) procShift.M_잔존++
      })
      const sample = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: TARGET_SHEET_ID,
        ranges: [`${quote(MARGIN_TAB)}!A2:T2`, `${quote(MAP_TAB)}!I2`],
        valueRenderOption: 'FORMULA',
      })
      return NextResponse.json({
        ok: errAfter.length === 0 && priceDiff.length === 0 && wzBefore === wzAfter,
        message: errAfter.length ? '오류 셀 발생 — 백업 기준으로 원인 확인 필요 (자동 복구 안 함)' : '단가DB J열 삭제 + 참조 보정 완료',
        단가DB_헤더_A_M: (pf[0] || []).slice(0, 13),
        재기입_셀수: plan.cells.length,
        참조_요약: Object.fromEntries(Object.entries(plan.summary).map(([k, v]) => [k, v.셀수])),
        드롭다운_변경: dv.map((d) => `${d.tab}!${colName(d.col)}${d.r0 + 1}:${colName(d.col)}${d.r1}`),
        오류셀: { 전: errBefore, 후: errAfter },
        단가DB_값_불일치_행: priceDiff,
        마진계산_A_T_변경: marginDiff,
        마진계산_W_Z_V1_동일: wzBefore === wzAfter,
        가공참조_당김: procShift,
        샘플_마진계산_R2: sample.data.valueRanges?.[0]?.values?.[0] || [],
        샘플_발주매핑_I2: sample.data.valueRanges?.[1]?.values?.[0]?.[0] ?? '',
      })
    }

    // ── m1check: 나무_마스터 1단계 사전 확인 (쓰기 없음) ──────────
    if (action === 'm1check') {
      const sheets = getSheets()
      const tabsOf = async (id: string) => {
        const m = await sheets.spreadsheets.get({
          spreadsheetId: id,
          fields: 'properties.title,sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))',
        })
        return {
          파일: m.data.properties?.title,
          탭: (m.data.sheets || []).map((x) => ({
            title: x.properties?.title,
            hidden: !!x.properties?.hidden,
            rows: x.properties?.gridProperties?.rowCount,
          })),
        }
      }
      const out: Record<string, any> = {}
      for (const [k, id] of [['마스터', MASTER_SHEET_ID], ['원가표', COST_SHEET_ID], ['마진리빌드', TARGET_SHEET_ID], ['b2b', B2B_SHEET_ID]] as const) {
        try {
          out[k] = await tabsOf(id)
        } catch (e: any) {
          out[k] = { 오류: e?.message || String(e) }
        }
      }
      const srcTabs = (file: string) => new Set(((out[file]?.탭 || []) as any[]).map((t) => t.title))
      const missing = M1_COPIES.filter((c) => !srcTabs(c.file).has(c.tab)).map((c) => `${c.file}!${c.tab}`)
      for (const t of [M1_SRC_UNIT_LOG, M1_SRC_PROC_LOG]) if (!srcTabs('원가표').has(t)) missing.push(`원가표!${t}`)
      return NextResponse.json({
        ok: true,
        파일: out,
        원본_누락탭: missing,
        드라이브: await driveMeta([MASTER_SHEET_ID, COST_SHEET_ID, TARGET_SHEET_ID, B2B_SHEET_ID]),
      })
    }

    // ── m1: 나무_마스터 1단계 — 탭 그대로 복사 + 원가 변동 로그 합치기 ──
    //   · 원본 3개 파일은 values.get·sheets.copyTo 만 (쓰기 없음). 쓰기 대상은 MASTER_SHEET_ID 뿐.
    //   · 가드: 마스터에 기본 시트 1개 외 탭이 있거나, 원본 탭이 없으면 409 (아무것도 안 씀)
    //   · 탭 하나씩 copyTo → 즉시 원래 이름으로 변경 (뒤 탭의 탭 간 참조가 이름으로 이어지게)
    if (action === 'm1') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: MASTER_SHEET_ID,
        fields: 'sheets(properties(sheetId,title))',
      })
      const masterTabs = (meta.data.sheets || []).map((x) => ({
        id: x.properties?.sheetId as number,
        title: x.properties?.title || '',
      }))
      const clash = masterTabs.filter((t) => M1_ORDER.includes(t.title)).map((t) => t.title)
      if (clash.length) {
        return NextResponse.json({ ok: false, error: '마스터에 같은 이름 탭이 이미 있음 — 쓰기 중단', 탭: clash }, { status: 409 })
      }
      if (masterTabs.length !== 1) {
        return NextResponse.json(
          { ok: false, error: '마스터가 비어있지 않음 (기본 시트 1개가 아님) — 쓰기 중단', 탭: masterTabs.map((t) => t.title) },
          { status: 409 }
        )
      }
      const defaultSheet = masterTabs[0]

      // 원본 탭 sheetId 확인
      const srcIds = new Map<string, Map<string, number>>()
      for (const id of Array.from(new Set(M1_COPIES.map((c) => c.src)))) {
        const m = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets(properties(sheetId,title))' })
        srcIds.set(id, new Map((m.data.sheets || []).map((x) => [x.properties?.title || '', x.properties?.sheetId as number])))
      }
      const missing = M1_COPIES.filter((c) => srcIds.get(c.src)?.get(c.tab) == null).map((c) => `${c.file}!${c.tab}`)
      for (const t of [M1_SRC_UNIT_LOG, M1_SRC_PROC_LOG]) if (srcIds.get(COST_SHEET_ID)?.get(t) == null) missing.push(`원가표!${t}`)
      if (missing.length) {
        return NextResponse.json({ ok: false, error: '원본 탭 없음 — 쓰기 중단', 누락: missing }, { status: 409 })
      }
      const driveBefore = await driveMeta([COST_SHEET_ID, TARGET_SHEET_ID, B2B_SHEET_ID])

      // 원가 변동 로그 원본 읽기 (표시값 그대로)
      const logs = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: COST_SHEET_ID,
        ranges: [quote(M1_SRC_UNIT_LOG), quote(M1_SRC_PROC_LOG)],
        valueRenderOption: 'FORMATTED_VALUE',
      })
      const dataRows = (rows: Cell[][]) => {
        const h = rows.findIndex((r) => String(r?.[0] ?? '').trim() === '일시')
        return h < 0 ? [] : rows.slice(h + 1).filter((r) => String(r?.[0] ?? '').trim() !== '')
      }
      const unitRows = dataRows((logs.data.valueRanges?.[0]?.values || []) as Cell[][])
      const procRows = dataRows((logs.data.valueRanges?.[1]?.values || []) as Cell[][])
      const g = (r: Cell[], i: number) => r[i] ?? ''
      const merged: Cell[][] = [
        ...unitRows.map((r) => [g(r, 0), '단가', g(r, 1), g(r, 2), g(r, 3), g(r, 4), g(r, 5), g(r, 6), g(r, 7)]),
        ...procRows.map((r) => [g(r, 0), g(r, 1), g(r, 2), '', '', g(r, 3), g(r, 4), g(r, 5), g(r, 6)]),
      ]
      merged.sort((a, b) => String(a[0]).localeCompare(String(b[0])))

      // ── 1. 탭 복사 (copyTo → 이름 변경) ──────────────────────────
      const newIds = new Map<string, number>()
      for (const c of M1_COPIES) {
        const res = await sheets.spreadsheets.sheets.copyTo({
          spreadsheetId: c.src,
          sheetId: srcIds.get(c.src)!.get(c.tab)!,
          requestBody: { destinationSpreadsheetId: MASTER_SHEET_ID },
        })
        const nid = res.data.sheetId as number
        newIds.set(c.tab, nid)
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: {
            requests: [{ updateSheetProperties: { properties: { sheetId: nid, title: c.tab }, fields: 'title' } }],
          },
        })
      }

      // ── 2. 원가 변동 로그 새 탭 ────────────────────────────────
      const add = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: M1_LOG_TAB, gridProperties: { frozenRowCount: 1, rowCount: Math.max(100, merged.length + 50), columnCount: 9 } },
              },
            },
          ],
        },
      })
      const logId = add.data.replies?.[0]?.addSheet?.properties?.sheetId as number
      newIds.set(M1_LOG_TAB, logId)
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${quote(M1_LOG_TAB)}!A1:I${1 + merged.length}`,
        valueInputOption: 'RAW',
        requestBody: { values: [M1_LOG_HEADER, ...merged] },
      })

      // ── 3. 탭 순서 + 기본 시트 삭제 + 로그 헤더 볼드 ─────────────
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          requests: [
            { deleteSheet: { sheetId: defaultSheet.id } },
            ...M1_ORDER.map((t, i) => ({
              updateSheetProperties: { properties: { sheetId: newIds.get(t)!, index: i }, fields: 'index' },
            })),
            {
              repeatCell: {
                range: { sheetId: logId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        },
      })

      // ── 4. 검증 (원본 ↔ 마스터) ───────────────────────────────
      const 비교: Record<string, any> = {}
      for (const c of M1_COPIES) {
        const [a, b] = await Promise.all([tabSnapshot(sheets, c.src, c.tab), tabSnapshot(sheets, MASTER_SHEET_ID, c.tab)])
        비교[c.tab] = {
          행수: `${a.행수}→${b.행수}`,
          헤더_동일: JSON.stringify(a.헤더) === JSON.stringify(b.헤더),
          값_동일: a.값해시 === b.값해시,
          수식_동일: a.수식해시 === b.수식해시,
          수식셀: `${a.수식셀}→${b.수식셀}`,
          오류셀: `${a.오류셀}→${b.오류셀}`,
        }
      }
      const logSnap = await tabSnapshot(sheets, MASTER_SHEET_ID, M1_LOG_TAB)
      const finalMeta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(title,index))' })
      const driveAfter = await driveMeta([COST_SHEET_ID, TARGET_SHEET_ID, B2B_SHEET_ID])
      return NextResponse.json({
        ok: true,
        message: '나무_마스터 1단계 복사 완료',
        탭순서: (finalMeta.data.sheets || []).map((x) => x.properties?.title),
        비교,
        원가변동로그: {
          원본_단가: unitRows.length,
          원본_가공비: procRows.length,
          합: unitRows.length + procRows.length,
          새탭_데이터행: logSnap.행수 - 1,
        },
        원본_수정시각: { 전: driveBefore, 후: driveAfter },
      })
    }

    // ── mread: 탭 읽기 전용 덤프 (쓰기 없음) — file=master|cost|rebuild|b2b · tab=탭이름 ──
    if (action === 'mread') {
      const sheets = getSheets()
      const FILES: Record<string, string> = {
        master: MASTER_SHEET_ID, cost: COST_SHEET_ID, rebuild: TARGET_SHEET_ID, b2b: B2B_SHEET_ID,
      }
      const id = FILES[url.searchParams.get('file') || '']
      const tab = url.searchParams.get('tab') || ''
      if (!id || !tab) return NextResponse.json({ ok: false, error: 'file·tab 필요' }, { status: 400 })
      const [f, v] = await Promise.all(
        (['FORMULA', 'UNFORMATTED_VALUE'] as const).map((opt) =>
          sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${quote(tab)}!A1:AB1000`, valueRenderOption: opt })
        )
      )
      return NextResponse.json({ ok: true, 수식: f.data.values || [], 값: v.data.values || [] })
    }

    // ── m2: 나무_마스터 2단계 — 단가DB·마진계산·설정 이관 + 파일 간 참조 → 파일 안 참조 ──
    //   · 원본(마진리빌드)은 values.get·copyTo 만. 쓰기 대상은 MASTER_SHEET_ID 뿐.
    //   · 복사된 수식 원문을 읽어 참조만 바꿔 행별로 다시 기입 (새로 조립 없음, ARRAYFORMULA 없음)
    if (action === 'm2') {
      const sheets = getSheets()
      const LAST = PRICE_ROWS_TO // 단가DB 300
      const MLAST = 1 + MARGIN_ROWS // 마진계산 301
      const metaOf = async (id: string) => {
        const m = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets(properties(sheetId,title))' })
        return new Map((m.data.sheets || []).map((x) => [x.properties?.title || '', x.properties?.sheetId as number]))
      }
      // ── 0. 가드 ──────────────────────────────────────────────
      const master0 = await metaOf(MASTER_SHEET_ID)
      const clash = [PRICE_TAB, MARGIN_TAB, M2_SETTING_TAB].filter((t) => master0.has(t))
      if (clash.length) {
        return NextResponse.json({ ok: false, error: '마스터에 이미 있는 탭 — 쓰기 중단', 탭: clash }, { status: 409 })
      }
      const needM1 = M1_ORDER.filter((t) => !master0.has(t))
      if (needM1.length) {
        return NextResponse.json({ ok: false, error: '1단계 탭 누락 — 쓰기 중단', 누락: needM1 }, { status: 409 })
      }
      const src = await metaOf(TARGET_SHEET_ID)
      for (const t of [PRICE_TAB, MARGIN_TAB, '채널DB', '비용DB']) {
        if (src.get(t) == null) return NextResponse.json({ ok: false, error: `원본 탭 없음: ${t}` }, { status: 409 })
      }
      const driveBefore = await driveMeta([COST_SHEET_ID, TARGET_SHEET_ID, B2B_SHEET_ID])
      const readTab = async (id: string, tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE') =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${quote(tab)}!A1:Z1000`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      // 원본 스냅샷 (비교용)
      const before = {
        price: await readTab(TARGET_SHEET_ID, PRICE_TAB, 'UNFORMATTED_VALUE'),
        margin: await readTab(TARGET_SHEET_ID, MARGIN_TAB, 'UNFORMATTED_VALUE'),
        marginFx: await readTab(TARGET_SHEET_ID, MARGIN_TAB, 'FORMULA'),
      }
      const costRows = await readTab(TARGET_SHEET_ID, '비용DB', 'UNFORMATTED_VALUE')

      // ── 1. 수식 변환안 (쓰기 전에 전부 계산 — 실패하면 쓰지 않음) ─────
      const priceFx = await readTab(TARGET_SHEET_ID, PRICE_TAB, 'FORMULA')
      const at = (r: number, c: number) => String((priceFx[r - 1] || [])[c] ?? '')
      const reRow = (f: string, to: number) => f.replace(/(\$[A-Z]{1,2})(\d+)/g, `$1${to}`)
      const gTpl = at(2, 6).startsWith('=') ? at(2, 6) : at(3, 6)
      if (!gTpl.startsWith('=')) throw new Error('단가DB G 수식 템플릿 없음')
      const priceGJ: Cell[][] = []
      const gRestored: string[] = []
      for (let r = 2; r <= LAST; r++) {
        const gSrc = at(r, 6).startsWith('=') ? at(r, 6) : reRow(gTpl, r)
        if (!at(r, 6).startsWith('=') && at(r, 0).trim() !== '') gRestored.push(at(r, 0))
        const row: Cell[] = [m2PriceFormula(gSrc, 'G', r)]
        for (const [c, col] of [[7, 'H'], [8, 'I'], [9, 'J']] as const) {
          const f = at(r, c)
          if (!f.startsWith('=')) throw new Error(`단가DB ${col}${r} 가 수식이 아님 — 중단`)
          row.push(m2PriceFormula(f, col, r))
        }
        priceGJ.push(row)
      }
      // 곰표 원료ID 4행
      const eLinks: { r: number; alias: string; before: string; after: string }[] = []
      for (let r = 2; r <= LAST; r++) {
        const al = at(r, 0).trim()
        if (M2_GOMPYO_LINK[al]) {
          if (!isGompyo(at(r, 2))) throw new Error(`${al} 발송거래처가 곰표가 아님 — 중단`)
          eLinks.push({ r, alias: al, before: at(r, 4), after: M2_GOMPYO_LINK[al] })
        }
      }
      if (eLinks.length !== Object.keys(M2_GOMPYO_LINK).length) throw new Error('곰표 연결 대상 4행을 모두 찾지 못함 — 중단')
      // 마진계산: 원가표미러·채널DB·비용DB 참조 셀만
      const marginFx = before.marginFx
      const marginCells: { r: number; c: number; f: string }[] = []
      marginFx.forEach((row, ri) =>
        (row || []).forEach((c, ci) => {
          const f = String(c ?? '')
          if (f.startsWith('=') && /원가표미러|채널DB|비용DB/.test(f)) marginCells.push({ r: ri + 1, c: ci, f: m2RenameRefs(f) })
        })
      )
      // 설정: 채널DB A~H (그대로) + 비용DB 2줄
      const chFx = await readTab(TARGET_SHEET_ID, '채널DB', 'FORMULA')
      const costKeep = costRows.filter((r) => M2_COST_KEEP.includes(String(r?.[0] ?? '').trim()))
      if (costKeep.length !== M2_COST_KEEP.length) throw new Error('비용DB 봉투 단가·경고 기준 마진율 행 없음 — 중단')

      // ── 2. 복사 (단가DB → 마진계산 → 채널DB=설정) ───────────────
      const newIds = new Map<string, number>()
      for (const [tab, title] of [[PRICE_TAB, PRICE_TAB], [MARGIN_TAB, MARGIN_TAB], ['채널DB', M2_SETTING_TAB]] as const) {
        const res = await sheets.spreadsheets.sheets.copyTo({
          spreadsheetId: TARGET_SHEET_ID,
          sheetId: src.get(tab)!,
          requestBody: { destinationSpreadsheetId: MASTER_SHEET_ID },
        })
        const nid = res.data.sheetId as number
        newIds.set(title, nid)
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: nid, title }, fields: 'title' } }] },
        })
      }
      const master = await metaOf(MASTER_SHEET_ID)
      const jinId = master.get('진도팜 원가표')

      // ── 3. 수식·값 기입 ───────────────────────────────────────
      const colRuns = (cells: { r: number; c: number; f: string }[], tab: string) => {
        const byCol = new Map<number, typeof cells>()
        for (const x of cells) {
          if (!byCol.has(x.c)) byCol.set(x.c, [])
          byCol.get(x.c)!.push(x)
        }
        const data: { range: string; values: Cell[][] }[] = []
        for (const [c, list] of Array.from(byCol.entries())) {
          list.sort((a, b) => a.r - b.r)
          let run: typeof cells = []
          const flush = () => {
            if (!run.length) return
            data.push({ range: `${quote(tab)}!${colName(c)}${run[0].r}:${colName(c)}${run[run.length - 1].r}`, values: run.map((x) => [x.f]) })
            run = []
          }
          for (const x of list) {
            if (run.length && run[run.length - 1].r + 1 !== x.r) flush()
            run.push(x)
          }
          flush()
        }
        return data
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            ...eLinks.map((x) => ({ range: `${quote(PRICE_TAB)}!E${x.r}`, values: [[x.after]] })),
            {
              range: `${quote(M2_SETTING_TAB)}!J1:M${1 + costKeep.length}`,
              values: [['항목', '값', '단위', '메모'], ...costKeep.map((r) => [0, 1, 2, 3].map((i) => r[i] ?? ''))],
            },
          ],
        },
      })
      await guardManualPriceHJ(sheets, MASTER_SHEET_ID, [`${quote(PRICE_TAB)}!G2:J${LAST}`])
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(PRICE_TAB)}!G2:J${LAST}`, values: priceGJ },
            ...m2LinkCells(priceFx, jinId).map((x) => ({ range: `${quote(PRICE_TAB)}!${colName(x.c)}${x.r}`, values: [[x.f]] })),
            ...colRuns(marginCells, MARGIN_TAB),
          ],
        },
      })
      // 설정: 채널DB 복사본에서 A~H 밖 열은 비움 (채널DB 는 A~H 만 사용)
      const setFx = await readTab(MASTER_SHEET_ID, M2_SETTING_TAB, 'FORMULA')
      const setStray = setFx.some((r) => (r || []).slice(8, 9).some((c) => String(c ?? '') !== ''))
      // 발주매핑 I: 단가DB 가 생겼으므로 같은 수식 원문을 다시 기입해 참조 재해석
      const mapFx = await readTab(MASTER_SHEET_ID, MAP_TAB, 'FORMULA')
      const mapCells: { r: number; c: number; f: string }[] = []
      mapFx.forEach((row, ri) => {
        const f = String((row || [])[8] ?? '')
        if (ri > 0 && f.startsWith('=')) mapCells.push({ r: ri + 1, c: 8, f })
      })
      if (mapCells.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: { valueInputOption: 'USER_ENTERED', data: colRuns(mapCells, MAP_TAB) },
        })
      }

      // ── 4. 드롭다운 참조 변환 (단가DB·마진계산·설정·발주매핑) ──────
      const dvTabs = [PRICE_TAB, MARGIN_TAB, M2_SETTING_TAB, MAP_TAB]
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: MASTER_SHEET_ID,
        ranges: dvTabs.map((t) => quote(t)),
        includeGridData: true,
        fields: 'sheets(properties(sheetId,title),data(rowData(values(dataValidation))))',
      })
      const dvReqs: any[] = []
      const dvLog: string[] = []
      for (const sh of gd.data.sheets || []) {
        const sid = sh.properties?.sheetId as number
        const rows = sh.data?.[0]?.rowData || []
        rows.forEach((rd, ri) =>
          (rd.values || []).forEach((v, ci) => {
            const dv: any = v.dataValidation
            const vals = dv?.condition?.values
            if (!vals?.some((x: any) => /원가표미러|채널DB|비용DB/.test(String(x?.userEnteredValue ?? '')))) return
            const rule = {
              ...dv,
              condition: {
                ...dv.condition,
                values: vals.map((x: any) => ({ userEnteredValue: m2RenameRefs(String(x?.userEnteredValue ?? '')).replace(/\$A\$12:\$A\$\d+/, '$A$12:$A') })),
              },
            }
            dvReqs.push({ setDataValidation: { range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: ci, endColumnIndex: ci + 1 }, rule } })
            dvLog.push(`${sh.properties?.title}!${colName(ci)}`)
          })
        )
      }

      // ── 5. 탭 순서 + 설정 헤더 볼드 ────────────────────────────
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          requests: [
            ...dvReqs,
            ...M2_ORDER.map((t, i) => ({ updateSheetProperties: { properties: { sheetId: master.get(t)!, index: i }, fields: 'index' } })),
            {
              repeatCell: {
                range: { sheetId: newIds.get(M2_SETTING_TAB)!, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 9, endColumnIndex: 13 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        },
      })

      // ── 6. 검증 ─────────────────────────────────────────────
      const after = {
        price: await readTab(MASTER_SHEET_ID, PRICE_TAB, 'UNFORMATTED_VALUE'),
        margin: await readTab(MASTER_SHEET_ID, MARGIN_TAB, 'UNFORMATTED_VALUE'),
        marginFx: await readTab(MASTER_SHEET_ID, MARGIN_TAB, 'FORMULA'),
      }
      const errOf = async (tab: string) => errorCellsOf(tab, await readTab(MASTER_SHEET_ID, tab, 'UNFORMATTED_VALUE'))
      const 오류셀: Record<string, number> = {}
      for (const t of [PRICE_TAB, MARGIN_TAB, M2_SETTING_TAB, MAP_TAB]) 오류셀[t] = (await errOf(t)).length
      const mapI = (await readTab(MASTER_SHEET_ID, MAP_TAB, 'UNFORMATTED_VALUE')).slice(1).filter((r) => ERR_VALUE.test(String(r?.[8] ?? ''))).length
      // 금지 참조 전수 (마스터 전 탭 수식)
      const allTabs = Array.from((await metaOf(MASTER_SHEET_ID)).keys())
      const allFx = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: MASTER_SHEET_ID,
        ranges: allTabs.map((t) => quote(t)),
        valueRenderOption: 'FORMULA',
      })
      const forbidden: string[] = []
      ;(allFx.data.valueRanges || []).forEach((vr, ti) =>
        ((vr.values || []) as Cell[][]).forEach((row, ri) =>
          (row || []).forEach((c, ci) => {
            const f = String(c ?? '')
            if (f.startsWith('=') && M2_FORBIDDEN.some((w) => f.includes(w))) forbidden.push(`${allTabs[ti]}!${colName(ci)}${ri + 1}`)
          })
        )
      )
      // 단가DB G~J 차이 + 이유
      const jin = await readTab(MASTER_SHEET_ID, '진도팜 원가표', 'UNFORMATTED_VALUE')
      const laborById = new Map(jin.slice(11).map((r) => [String(r?.[0] ?? ''), r?.[5]]))
      const B2 = Number(jin[1]?.[1])
      const num = (x: Cell | undefined) => (typeof x === 'number' ? x : null)
      const eq = (a: Cell | undefined, b: Cell | undefined) =>
        typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? '')
      const priceDiff: any[] = []
      const changedAlias = new Set<string>()
      const nP = Math.max(before.price.length, after.price.length)
      for (let i = 1; i < nP; i++) {
        const b = before.price[i] || []
        const a = after.price[i] || []
        const al = String(a[0] ?? b[0] ?? '')
        if (String(b[0] ?? '') !== al) {
          priceDiff.push({ 행: i + 1, 별칭: al, 이유: '기타', 비고: `별칭 불일치 전=${b[0]}` })
          continue
        }
        const cols = [6, 7, 8, 9].filter((c) => !eq(b[c], a[c]))
        if (!cols.length) continue
        changedAlias.add(al)
        let why = '기타'
        const eAfter = String(a[4] ?? '')
        if (isGompyo(a[2])) why = M2_GOMPYO_LINK[al] ? '곰표 연결' : '곰표 분기 제거'
        else {
          const lab = num(laborById.get(eAfter) as Cell)
          const g = num(a[5])
          const onlyH = cols.length === 1 && cols[0] === 7
          if (onlyH && lab != null && g != null && num(b[7]) != null && num(a[7]) != null &&
              Math.abs((num(a[7])! - num(b[7])!) - (lab - B2) * Math.max(1, g / 1000)) < 1e-6) why = '작업비 행값 적용'
        }
        priceDiff.push({
          행: i + 1, 별칭: al, 이유: why,
          전: cols.map((c) => `${colName(c)}=${b[c] ?? ''}`).join(' '),
          후: cols.map((c) => `${colName(c)}=${a[c] ?? ''}`).join(' '),
        })
      }
      // 마진계산 F 원가·O 마진·Q BEP 차이 + 입력값(비수식 셀) 무변경
      const marginDiff: any[] = []
      const nM = Math.max(before.margin.length, after.margin.length)
      for (let i = 1; i < nM; i++) {
        const b = before.margin[i] || []
        const a = after.margin[i] || []
        const cols = [5, 14, 16].filter((c) => !eq(b[c], a[c]))
        if (!cols.length) continue
        const al = String(a[1] ?? '')
        marginDiff.push({
          행: i + 1, 채널: a[0], 별칭: al, 단가DB_변경_연쇄: changedAlias.has(al),
          전: cols.map((c) => `${colName(c)}=${b[c] ?? ''}`).join(' '),
          후: cols.map((c) => `${colName(c)}=${a[c] ?? ''}`).join(' '),
        })
      }
      const inputDiff: string[] = []
      for (let i = 0; i < Math.max(before.marginFx.length, after.marginFx.length); i++) {
        const b = before.marginFx[i] || []
        const a = after.marginFx[i] || []
        for (let c = 0; c < 26; c++) {
          const bs = String(b[c] ?? '')
          if (bs.startsWith('=')) continue
          if (bs !== String(a[c] ?? '')) inputDiff.push(`${colName(c)}${i + 1}`)
        }
      }
      const gompyo = after.price
        .slice(1)
        .filter((r) => isGompyo(r?.[2]))
        .map((r) => ({ 별칭: r[0], 원료ID: r[4] || '(빈칸)', 원곡가: r[6] === '' || r[6] == null ? '(빈칸)' : r[6], 소포장: r[7] === '' || r[7] == null ? '(빈칸)' : r[7] }))
      const driveAfter = await driveMeta([COST_SHEET_ID, TARGET_SHEET_ID, B2B_SHEET_ID])
      const mtime = (d: any) => Object.fromEntries(Object.entries(d || {}).map(([k, v]: any) => [v?.name || k, v?.modifiedTime]))
      return NextResponse.json({
        ok: forbidden.length === 0 && inputDiff.length === 0 && !priceDiff.some((d) => d.이유 === '기타'),
        탭순서: allTabs.length ? (await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(title))' })).data.sheets?.map((x) => x.properties?.title) : [],
        기입: { 단가DB_GJ_행: priceGJ.length, G_수식복구: gRestored, 곰표_원료ID: eLinks, 마진계산_셀: marginCells.length, 발주매핑_I_재기입: mapCells.length, 드롭다운: dvLog, 설정_I열_잔여: setStray },
        오류셀, 발주매핑_I_오류: mapI,
        금지참조_잔존: forbidden.slice(0, 20), 금지참조_수: forbidden.length,
        단가DB_차이: priceDiff,
        마진계산_차이: marginDiff,
        마진계산_입력값_변경: inputDiff.slice(0, 20),
        곰표행: gompyo,
        원본_수정시각: { 전: mtime(driveBefore), 후: mtime(driveAfter) },
      })
    }

    // ── m2link: m2 보정 — 단가DB 원가표 바로가기 링크를 파일 안 링크로 (정렬로 N10 으로 옮겨진 것) ──
    //   · 마스터 단가DB 에서 원가표 파일 HYPERLINK 를 #gid 링크로 바꾸고,
    //     m2 가 N2 에 새로 넣은 링크는 원본 N2 가 빈칸이었을 때만 지운다.
    if (action === 'm2link') {
      const sheets = getSheets()
      const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(sheetId,title))' })
      const jinId = (meta.data.sheets || []).find((x) => x.properties?.title === '진도팜 원가표')?.properties?.sheetId as number | undefined
      if (jinId == null) throw new Error('마스터에 진도팜 원가표 없음')
      const get = async (id: string) =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${quote(PRICE_TAB)}!A1:N${PRICE_ROWS_TO}`, valueRenderOption: 'FORMULA' }))
          .data.values || []) as Cell[][]
      const fx = await get(MASTER_SHEET_ID)
      const src = await get(TARGET_SHEET_ID)
      const links = m2LinkCells(fx, jinId)
      const n2Mine = String(fx[1]?.[13] ?? '') === `=HYPERLINK("#gid=${jinId}","원가표 바로가기")`
      const n2SrcBlank = String(src[1]?.[13] ?? '').trim() === ''
      const clearN2 = n2Mine && n2SrcBlank && links.length > 0
      if (!links.length && !clearN2) return NextResponse.json({ ok: true, message: '바꿀 링크 없음' })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            ...links.map((x) => ({ range: `${quote(PRICE_TAB)}!${colName(x.c)}${x.r}`, values: [[x.f]] })),
            ...(clearN2 ? [{ range: `${quote(PRICE_TAB)}!N2`, values: [['']] }] : []),
          ],
        },
      })
      const post = await get(MASTER_SHEET_ID)
      return NextResponse.json({
        ok: true,
        변경: links.map((x) => `${colName(x.c)}${x.r}`),
        N2_비움: clearN2,
        N열: post.map((r, i) => [i + 1, String(r?.[13] ?? '')]).filter((x) => x[1] !== ''),
        원가표ID_잔존: post.flat().filter((c) => String(c ?? '').includes(COST_SHEET_ID)).length,
      })
    }

    // ── m3: 나무_마스터 3단계 — 곰표 원료 5행 추가 + 단가DB 곰표 행 연결·정리 + E 선택 목록 ──
    //   · 쓰기 대상은 MASTER_SHEET_ID 의 곰표 원가표 14~18행, 단가DB 곰표 행 E·K·M, 설정 O열, 단가DB E 드롭다운뿐
    if (action === 'm3') {
      const sheets = getSheets()
      const read = async (tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE', range = 'A1:Z1000') =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(sheetId,title))' })
      const idOf = (t: string) => (meta.data.sheets || []).find((x) => x.properties?.title === t)?.properties?.sheetId as number | undefined
      const priceId = idOf(PRICE_TAB)
      if (priceId == null || idOf(M3_GOM_TAB) == null || idOf(M2_SETTING_TAB) == null) throw new Error('마스터 탭 누락')

      // ── 0. 가드 ──────────────────────────────────────────────
      const gomFx = await read(M3_GOM_TAB, 'FORMULA', 'A1:Q1000')
      const tpl = gomFx[12] || []
      if (String(tpl[0] ?? '') === '' || String(tpl[2] ?? '') !== '렌틸콩') throw new Error('곰표 원가표 13행(렌틸콩) 템플릿이 아님 — 중단')
      const occupied = gomFx.slice(13, 18).some((r) => (r || []).some((c) => String(c ?? '') !== ''))
      if (occupied) return NextResponse.json({ ok: false, error: '곰표 원가표 14~18행이 비어있지 않음 — 쓰기 중단', 행: gomFx.slice(13, 18) }, { status: 409 })
      const setFx = await read(M2_SETTING_TAB, 'FORMULA', 'O1:O3')
      if (setFx.flat().some((c) => String(c ?? '') !== '')) return NextResponse.json({ ok: false, error: '설정 O열이 비어있지 않음 — 쓰기 중단', O: setFx }, { status: 409 })

      const priceFxBefore = await read(PRICE_TAB, 'FORMULA', `A1:M${PRICE_ROWS_TO}`)
      const priceBefore = await read(PRICE_TAB, 'UNFORMATTED_VALUE', `A1:M${PRICE_ROWS_TO}`)
      const marginBefore = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:T${1 + MARGIN_ROWS}`)
      // 별칭 → 행 (정확히 1개일 때만)
      const rowsOf = (al: string) => priceFxBefore.map((r, i) => (String(r?.[0] ?? '').trim() === al ? i + 1 : 0)).filter(Boolean)
      const skipped: string[] = []
      const links: { r: number; alias: string; id: string }[] = []
      for (const [al, id] of Object.entries(M3_LINKS)) {
        const rs = rowsOf(al)
        if (rs.length !== 1) { skipped.push(`${al}: 일치 ${rs.length}행`); continue }
        if (!isGompyo(priceFxBefore[rs[0] - 1]?.[2])) { skipped.push(`${al}: 발송거래처가 곰표 아님`); continue }
        links.push({ r: rs[0], alias: al, id })
      }
      // 현재 E 드롭다운 규칙 (보고용)
      const dvNow = await sheets.spreadsheets.get({
        spreadsheetId: MASTER_SHEET_ID, ranges: [`${quote(PRICE_TAB)}!E2:E3`], includeGridData: true,
        fields: 'sheets(data(rowData(values(dataValidation))))',
      })
      const eRuleBefore = dvNow.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.dataValidation || null

      // ── 1. 곰표 원가표 14~18행 ──────────────────────────────────
      const reRow = (f: string, to: number) => f.replace(/([A-Z]{1,2})13(?!\d)/g, `$1${to}`)
      const gomRows: Cell[][] = M3_NEW_ITEMS.map((it, i) => {
        const r = 14 + i
        const row: Cell[] = Array(17).fill('')
        row[0] = reRow(String(tpl[0]), r)
        for (let c = 5; c <= 10; c++) row[c] = String(tpl[c] ?? '').startsWith('=') ? reRow(String(tpl[c]), r) : ''
        row[1] = '곰표'
        row[2] = it.item
        row[4] = it.price
        row[11] = '면세'
        row[16] = 'O'
        return row
      })
      // ── 2·3. 단가DB 곰표 행: E 연결 · M 봉투 Y · K "원료 미연결" 제거 ──
      const linkByRow = new Map(links.map((x) => [x.r, x.id]))
      const priceData: { range: string; values: Cell[][] }[] = links.map((x) => ({ range: `${quote(PRICE_TAB)}!E${x.r}`, values: [[x.id]] }))
      const gomRowsInPrice: number[] = []
      priceFxBefore.forEach((row, i) => {
        if (i === 0 || !isGompyo(row?.[2])) return
        const r = i + 1
        gomRowsInPrice.push(r)
        priceData.push({ range: `${quote(PRICE_TAB)}!M${r}`, values: [['Y']] })
        const eAfter = linkByRow.get(r) ?? String(row?.[4] ?? '')
        const note = String(row?.[10] ?? '')
        if (eAfter.trim() !== '' && note.includes('원료 미연결')) {
          const cleaned = note.split('·').map((x) => x.trim()).filter((x) => x && x !== '원료 미연결').join(' · ')
          priceData.push({ range: `${quote(PRICE_TAB)}!K${r}`, values: [[cleaned]] })
        }
      })

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(M3_GOM_TAB)}!A14:Q18`, values: gomRows },
            { range: `${quote(M2_SETTING_TAB)}!O1:O2`, values: [[M3_ID_LIST_HEADER], [M3_ID_LIST_FORMULA]] },
          ],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: priceData },
      })
      // ── 4. E 선택 목록 → 설정 O열 ──────────────────────────────
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          requests: [
            {
              setDataValidation: {
                range: { sheetId: priceId, startRowIndex: 1, endRowIndex: PRICE_ROWS_TO, startColumnIndex: 4, endColumnIndex: 5 },
                rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: M3_ID_LIST_REF }] }, showCustomUi: true, strict: false },
              },
            },
            {
              repeatCell: {
                range: { sheetId: idOf(M2_SETTING_TAB)!, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 14, endColumnIndex: 15 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        },
      })

      // ── 5. 검증 ─────────────────────────────────────────────
      const gomAfter = await read(M3_GOM_TAB, 'UNFORMATTED_VALUE', 'A12:Q18')
      const idList = (await read(M2_SETTING_TAB, 'UNFORMATTED_VALUE', 'O2:O1000')).map((r) => String(r?.[0] ?? '')).filter(Boolean)
      const priceAfter = await read(PRICE_TAB, 'UNFORMATTED_VALUE', `A1:M${PRICE_ROWS_TO}`)
      const marginAfter = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:T${1 + MARGIN_ROWS}`)
      const idSet = new Set(idList)
      const eMissing = priceAfter.slice(1).map((r) => String(r?.[4] ?? '').trim()).filter((e) => e && !idSet.has(e))
      const eq = (a: Cell | undefined, b: Cell | undefined) =>
        typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? '')
      const otherChanged: number[] = []
      priceBefore.forEach((b, i) => {
        if (i === 0 || isGompyo(b?.[2])) return
        const a = priceAfter[i] || []
        if (Array.from({ length: 13 }, (_, c) => c).some((c) => !eq(b?.[c], a[c]))) otherChanged.push(i + 1)
      })
      const marginDiff = marginBefore
        .map((b, i) => ({ i, b, a: marginAfter[i] || [] }))
        .filter((x) => x.i > 0 && !eq(x.b?.[5], x.a[5]))
        .map((x) => ({ 행: x.i + 1, 별칭: x.a[1], 전: x.b?.[5] ?? '', 후: x.a[5] ?? '' }))
      return NextResponse.json({
        ok: skipped.length === 0 && eMissing.length === 0 && otherChanged.length === 0,
        E_규칙_전: eRuleBefore,
        곰표원가표: gomAfter.map((r) => ({ 원료ID: r[0], 원곡가: r[4], 작업비: r[5], 최종공급가: r[10] })),
        연결: links.map((x) => `${x.alias} → ${x.id}`),
        연결_제외: skipped,
        단가DB_곰표행: priceAfter
          .map((r, i) => ({ r, i }))
          .filter((x) => x.i > 0 && isGompyo(x.r[2]))
          .map(({ r, i }) => ({ 행: i + 1, 별칭: r[0], 원료ID: r[4] || '(빈칸)', g: r[5], G: r[6] === '' ? '(빈칸)' : r[6], H: r[7] === '' ? '(빈칸)' : r[7], M: r[12], K: r[10] ?? '' })),
        E_목록_수: idList.length,
        E_목록밖_값: eMissing,
        오류셀: { 단가DB: errorCellsOf(PRICE_TAB, priceAfter).length, 마진계산: errorCellsOf(MARGIN_TAB, marginAfter).length },
        마진계산_원가_변경: marginDiff,
        곰표외_단가DB_변경행: otherChanged,
      })
    }

    // ── mdv: 마스터 전 탭 드롭다운(ONE_OF_RANGE) 규칙 요약 (쓰기 없음) ──
    if (action === 'mdv') {
      const sheets = getSheets()
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: MASTER_SHEET_ID,
        includeGridData: true,
        fields: 'sheets(properties(title),data(rowData(values(dataValidation))))',
      })
      const out: Record<string, number> = {}
      for (const sh of gd.data.sheets || []) {
        ;(sh.data?.[0]?.rowData || []).forEach((rd) =>
          (rd.values || []).forEach((v, ci) => {
            const c: any = v.dataValidation?.condition
            if (!c) return
            const k = `${sh.properties?.title}!${colName(ci)} ${c.type} ${(c.values || []).map((x: any) => x.userEnteredValue).join('|')}`
            out[k] = (out[k] || 0) + 1
          })
        )
      }
      return NextResponse.json({ ok: true, 규칙: out })
    }

    // ── m4: 나무_마스터 4단계 — 중복 별칭 행 삭제 + 다른 탭 별칭 통일 + 곰표 원가표 선택 목록 보완 ──
    //   · ?dry=1 이면 사전 확인만 (쓰기 없음). 별칭 셀·단가DB 1행 삭제·곰표 원가표 드롭다운 외 쓰기 없음
    if (action === 'm4') {
      const sheets = getSheets()
      const dry = url.searchParams.get('dry') === '1'
      const read = async (tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE' = 'UNFORMATTED_VALUE', range = 'A1:Z5000') =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(sheetId,title))' })
      const idOf = (t: string) => (meta.data.sheets || []).find((x) => x.properties?.title === t)?.properties?.sheetId as number | undefined
      const price = await read(PRICE_TAB)
      const rowsOf = (al: string) => price.map((r, i) => (String(r?.[0] ?? '') === al ? i + 1 : 0)).filter(Boolean)

      // ── 0. 사전 확인 ─────────────────────────────────────────
      const problems: string[] = []
      const delRows = rowsOf(M4_DELETE)
      const keepRows = rowsOf(M4_KEEP)
      if (delRows.length !== 1) problems.push(`${M4_DELETE}: 단가DB ${delRows.length}행`)
      if (keepRows.length !== 1) problems.push(`${M4_KEEP}: 단가DB ${keepRows.length}행`)
      let cmp: any = null
      if (delRows.length === 1 && keepRows.length === 1) {
        const a = price[delRows[0] - 1] || []
        const b = price[keepRows[0] - 1] || []
        cmp = { 삭제행: delRows[0], 유지행: keepRows[0], 원료ID: [a[4], b[4]], g: [a[5], b[5]], 소포장: [a[7], b[7]], 벌크: [a[8], b[8]] }
        for (const c of [4, 5, 7, 8]) if (String(a[c] ?? '') !== String(b[c] ?? '')) problems.push(`${colName(c)} 다름: ${a[c]} ≠ ${b[c]}`)
      }
      const okNames = new Map<string, string>()
      const badNames: string[] = []
      for (const [from, to] of M4_RENAME) {
        if (rowsOf(to).length === 1) okNames.set(from, to)
        else badNames.push(`${from} → ${to}: 단가DB ${rowsOf(to).length}행`)
      }
      // 탭별 별칭 열
      const tabData: { tab: string; col: number; rows: Cell[][] }[] = []
      for (const { tab, header } of M4_ALIAS_COLS) {
        const rows = await read(tab, 'FORMULA')
        const col = (rows[0] || []).findIndex((h) => String(h ?? '').trim() === header)
        if (col < 0) problems.push(`${tab} 에 '${header}' 헤더 없음`)
        else tabData.push({ tab, col, rows })
      }
      const cells: { tab: string; r: number; c: number; from: string; to: string }[] = []
      for (const t of tabData) {
        t.rows.forEach((row, i) => {
          if (i === 0) return
          const v = String(row?.[t.col] ?? '')
          const to = okNames.get(v)
          if (to) cells.push({ tab: t.tab, r: i + 1, c: t.col, from: v, to })
        })
      }
      const count: Record<string, Record<string, number>> = {}
      for (const x of cells) {
        count[x.tab] = count[x.tab] || {}
        count[x.tab][`${x.from} → ${x.to}`] = (count[x.tab][`${x.from} → ${x.to}`] || 0) + 1
      }
      if (dry || problems.length) {
        return NextResponse.json(
          { ok: problems.length === 0, dry, 문제: problems, 비교: cmp, 제외_이름: badNames, 바꿀_셀: count, 셀수: cells.length },
          { status: problems.length ? 409 : 200 }
        )
      }

      const marginBefore = await read(MARGIN_TAB)
      const keepBefore = price[keepRows[0] - 1]

      // ── 1. 별칭 셀 교체 ───────────────────────────────────────
      if (cells.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: cells.map((x) => ({ range: `${quote(x.tab)}!${colName(x.c)}${x.r}`, values: [[x.to]] })),
          },
        })
      }
      // ── 2. 단가DB 중복 행 삭제 + 곰표 원가표 14~18행 선택 목록 ────────
      const gomId = idOf(M3_GOM_TAB)
      const gd = await sheets.spreadsheets.get({
        spreadsheetId: MASTER_SHEET_ID, ranges: [`${quote(M3_GOM_TAB)}!A12:Q12`], includeGridData: true,
        fields: 'sheets(data(rowData(values(dataValidation))))',
      })
      const r12 = gd.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
      const dvCols = [11, 12, 16].filter((c) => r12[c]?.dataValidation)
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          requests: [
            ...dvCols.map((c) => ({
              setDataValidation: {
                range: { sheetId: gomId!, startRowIndex: 13, endRowIndex: 18, startColumnIndex: c, endColumnIndex: c + 1 },
                rule: r12[c].dataValidation,
              },
            })),
            { deleteDimension: { range: { sheetId: idOf(PRICE_TAB)!, dimension: 'ROWS', startIndex: delRows[0] - 1, endIndex: delRows[0] } } },
          ],
        },
      })

      // ── 3. 검증 ─────────────────────────────────────────────
      const priceAfter = await read(PRICE_TAB)
      const aliasSet = new Set(priceAfter.slice(1).map((r) => String(r?.[0] ?? '')).filter(Boolean))
      const colVals = async (tab: string, header: string) => {
        const rows = await read(tab)
        const c = (rows[0] || []).findIndex((h) => String(h ?? '').trim() === header)
        return { rows, c }
      }
      const pm = await colVals('상품마스터', '별칭')
      const pmMissing = Array.from(new Set(pm.rows.slice(1).map((r) => String(r?.[pm.c] ?? '')).filter((a) => a && !aliasSet.has(a))))
      const mp = await colVals(MAP_TAB, 'DB확인')
      const mapIssues = mp.rows.slice(1).filter((r) => String(r?.[mp.c] ?? '').trim() !== '').length
      const hi = await colVals('발주 이력', '상품(별칭)')
      const hiMissing = Array.from(new Set(hi.rows.slice(1).map((r) => String(r?.[hi.c] ?? '')).filter((a) => a && !aliasSet.has(a))))
      const marginAfter = await read(MARGIN_TAB)
      const keepAfter = priceAfter.find((r) => String(r?.[0] ?? '') === M4_KEEP) || []
      const marginChanged = marginBefore
        .map((b, i) => ({ i, b, a: marginAfter[i] || [] }))
        .filter((x) => x.i > 0 && String(x.b?.[5] ?? '') !== String(x.a[5] ?? ''))
        .map((x) => ({ 행: x.i + 1, 별칭: x.a[1], 전: x.b?.[5] ?? '', 후: x.a[5] ?? '' }))
      return NextResponse.json({
        ok: pmMissing.length === 0 && mapIssues === 0,
        삭제: cmp, 제외_이름: badNames, 바꾼_셀: count, 셀수: cells.length,
        곰표원가표_선택목록_열: dvCols.map((c) => colName(c)),
        상품마스터_단가DB없음: pmMissing,
        발주매핑_DB확인_표시: mapIssues,
        발주이력: { 바뀐_행: cells.filter((x) => x.tab === '발주 이력').length, 단가DB없음: hiMissing },
        오류셀: { 단가DB: errorCellsOf(PRICE_TAB, priceAfter).length, 마진계산: errorCellsOf(MARGIN_TAB, marginAfter).length },
        흑미2kg: { 전: { G: keepBefore?.[6], H: keepBefore?.[7], I: keepBefore?.[8] }, 후: { G: keepAfter[6], H: keepAfter[7], I: keepAfter[8] } },
        마진계산_원가_변경: marginChanged,
      })
    }

    // ── m5: 나무_마스터 5단계 — 마진계산 1P 열(Z~AC)·1P 행 + 설정 입고박스 단가 ──
    //   · 쓰기: 설정 J4:M6, 마진계산 Z~AC(2~301행 수식)·AA1:AC1 헤더, 1P 새 행의 A·B·C·D·H·I·K·X·Y
    //   · 기존 데이터 행(A~X)·상품마스터·단가DB 는 쓰지 않음
    if (action === 'm5') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const read = async (tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE', range: string) =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))' })
      const propOf = (t: string) => (meta.data.sheets || []).find((x) => x.properties?.title === t)?.properties
      const marginProp = propOf(MARGIN_TAB)
      if (!marginProp || !propOf(M2_SETTING_TAB) || !propOf(M5_PM_TAB)) throw new Error('마스터 탭 누락')

      // ── 0. 가드 ──────────────────────────────────────────────
      const setJM = await read(M2_SETTING_TAB, 'FORMULA', 'J4:M6')
      if (setJM.flat().some((c) => String(c ?? '') !== '')) return NextResponse.json({ ok: false, error: '설정 J4:M6 비어있지 않음 — 쓰기 중단', 값: setJM }, { status: 409 })
      const mFx = await read(MARGIN_TAB, 'FORMULA', `A1:AC${MLAST}`)
      const mVal = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const zacStray = mFx.slice(1).some((r) => (r || []).slice(25, 29).some((c) => String(c ?? '') !== '' && !String(c).startsWith('=')))
      if (zacStray) return NextResponse.json({ ok: false, error: '마진계산 Z~AC 에 입력값이 있음 — 쓰기 중단' }, { status: 409 })
      const jin = await read('진도팜 원가표', 'UNFORMATTED_VALUE', 'A1:F8')
      const gom = await read(M3_GOM_TAB, 'UNFORMATTED_VALUE', 'A1:F8')
      const findBox = (rows: Cell[][], label: string) => {
        const i = rows.findIndex((r) => String(r?.[3] ?? '').trim() === label)
        return i < 0 ? null : { cell: `$E$${i + 1}`, v: rows[i]?.[4] }
      }
      const jinBox = findBox(jin, '대')
      const gomBox = findBox(gom, '10개입')
      if (!jinBox || !gomBox) throw new Error('입고박스 참고표 셀을 찾지 못함')

      // 마지막 데이터 행 · 재실행 대비 기존 1P 키
      let last = 1
      mFx.forEach((r, i) => { if (i > 0 && (String(r?.[0] ?? '').trim() || String(r?.[1] ?? '').trim())) last = i + 1 })
      const existing = new Set(mVal.slice(1).map((r) => (String(r?.[23] ?? '').trim() ? `o:${String(r?.[23]).trim()}` : `s:${String(r?.[24] ?? '').trim()}`)))
      const todo = M5_ROWS.filter(([o, sku]) => !existing.has(o ? `o:${o}` : `s:${sku}`))
      const skipped = M5_ROWS.filter((x) => !todo.includes(x)).map(([o, sku]) => o || `SKU ${sku}`)
      if (last + todo.length > MLAST) throw new Error('마진계산 301행 초과')
      const beforeHash = createHash('sha256').update(JSON.stringify([mFx.slice(0, last).map((r) => (r || []).slice(0, 24)), mVal.slice(0, last).map((r) => (r || []).slice(0, 24))])).digest('hex')

      // ── 1. 설정 입고박스 3줄 ──────────────────────────────────
      const setRows: Cell[][] = [
        ['입고박스 진도팜', `='진도팜 원가표'!${jinBox.cell}`, '원', '1P 쿠팡 입고용 대박스'],
        ['입고박스 곰표', `='${M3_GOM_TAB}'!${gomBox.cell}`, '원', '1P 쿠팡 입고용 10개입 박스'],
        ['입고박스 위킵', 0, '원', '1P 쿠팡 입고용 (위킵 출고)'],
      ]
      // ── 2. Z~AC 행별 수식 (상품마스터 SKU 문자·숫자 모두 매칭) ─────
      const pm = (col: string, r: number) =>
        `INDEX('${M5_PM_TAB}'!$${col}:$${col},IFERROR(MATCH(TO_TEXT($Y${r}),'${M5_PM_TAB}'!$F:$F,0),MATCH(VALUE($Y${r}),'${M5_PM_TAB}'!$F:$F,0)))`
      const zac: Cell[][] = []
      for (let r = 2; r <= MLAST; r++) {
        zac.push([
          `=IF($Y${r}="","",IFERROR(${pm('G', r)},""))`,
          `=IF($Y${r}="","",IFERROR(${pm('E', r)},""))`,
          `=IF($Y${r}="","",IFERROR(${pm('M', r)},""))`,
          `=IF($Y${r}="","",IFERROR(VLOOKUP("입고박스 "&$AB${r},'${M2_SETTING_TAB}'!$J$2:$K$50,2,FALSE)/$AA${r},""))`,
        ])
      }
      // ── 3. 1P 행 ─────────────────────────────────────────────
      const rowData: { range: string; values: Cell[][] }[] = []
      const rawData: { range: string; values: Cell[][] }[] = []
      todo.forEach(([o, sku, n], i) => {
        const r = last + 1 + i
        rawData.push({ range: `${quote(MARGIN_TAB)}!A${r}`, values: [['쿠팡 1P']] })
        rawData.push({ range: `${quote(MARGIN_TAB)}!C${r}`, values: [[n]] })
        rawData.push({ range: `${quote(MARGIN_TAB)}!H${r}`, values: [['없음']] })
        rawData.push({ range: `${quote(MARGIN_TAB)}!X${r}:Y${r}`, values: [[o, sku]] })
        rowData.push({ range: `${quote(MARGIN_TAB)}!B${r}`, values: [[`=IF($Y${r}="","",IFERROR(${pm('B', r)},""))`]] })
        rowData.push({ range: `${quote(MARGIN_TAB)}!D${r}`, values: [[`=IF(OR($Z${r}="",$C${r}=""),"",$Z${r}*$C${r})`]] })
        rowData.push({ range: `${quote(MARGIN_TAB)}!I${r}`, values: [[`=IF(OR($AC${r}="",$C${r}=""),"",$AC${r}*$C${r})`]] })
        rowData.push({ range: `${quote(MARGIN_TAB)}!K${r}`, values: [[`=IF($A${r}="","",IFERROR(VLOOKUP($A${r},'${M2_SETTING_TAB}'!$A$2:$C$19,3,FALSE),""))`]] })
      })

      // 열 수 확보 (AC = 29열)
      const colCount = marginProp.gridProperties?.columnCount ?? 0
      if (colCount < 29) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: { requests: [{ appendDimension: { sheetId: marginProp.sheetId!, dimension: 'COLUMNS', length: 29 - colCount } }] },
        })
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{ range: `${quote(MARGIN_TAB)}!AA1:AC1`, values: [['박스입수', '출고지', '입고박스비(봉당)']] }, ...rawData],
        },
      })
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${quote(M2_SETTING_TAB)}!J4:M6`, values: setRows },
            { range: `${quote(MARGIN_TAB)}!Z2:AC${MLAST}`, values: zac },
            ...rowData,
          ],
        },
      })
      // 서식: AA~AC 자동 칸 회색 · 헤더 볼드 · AC 숫자
      const grid = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId: marginProp.sheetId!, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 })
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          requests: [
            { repeatCell: { range: grid(0, 1, 26, 29), cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: hex(AUTO_GRAY) } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor' } },
            { repeatCell: { range: grid(1, MLAST, 26, 29), cell: { userEnteredFormat: { backgroundColor: hex(AUTO_GRAY) } }, fields: 'userEnteredFormat.backgroundColor' } },
            { repeatCell: { range: grid(1, MLAST, 28, 29), cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } },
          ],
        },
      })

      // ── 4. 검증 ─────────────────────────────────────────────
      const aFx = await read(MARGIN_TAB, 'FORMULA', `A1:AC${MLAST}`)
      const aVal = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const afterHash = createHash('sha256').update(JSON.stringify([aFx.slice(0, last).map((r) => (r || []).slice(0, 24)), aVal.slice(0, last).map((r) => (r || []).slice(0, 24))])).digest('hex')
      const oldYAC = aVal.slice(1, last).filter((r) => (r || []).slice(24, 29).some((c) => String(c ?? '') !== '')).length
      const g = (r: Cell[], i: number) => (r?.[i] === undefined ? '' : r[i])
      const oneP = aVal.slice(last).filter((r) => String(r?.[0] ?? '') === '쿠팡 1P').map((r) => ({
        옵션ID: g(r, 23), SKU: g(r, 24), 별칭: g(r, 1), 봉수: g(r, 2), 판매가: g(r, 3), 원가: g(r, 5), 봉투: g(r, 6),
        박스: g(r, 8), 수수료: g(r, 11), 총비용: g(r, 13), 마진: g(r, 14), 마진율: g(r, 15), BEP: g(r, 16), 상태: g(r, 19),
        박스입수: g(r, 26), 출고지: g(r, 27),
      }))
      const setAfter = await read(M2_SETTING_TAB, 'UNFORMATTED_VALUE', 'J1:M6')
      return NextResponse.json({
        ok: beforeHash === afterHash && oldYAC === 0 && errorCellsOf(MARGIN_TAB, aVal).length === 0,
        설정_입고박스: setAfter.slice(3),
        입고박스_참조: { 진도팜: jinBox, 곰표: gomBox },
        시작행: last + 1, 추가: todo.length, 건너뜀: skipped,
        기존행_A_X_동일: beforeHash === afterHash,
        기존행_Y_AC_값있음: oldYAC,
        오류셀: errorCellsOf(MARGIN_TAB, aVal).length,
        '1P': oneP,
      })
    }

    // ── m6: 나무_마스터 6단계 — 마진계산 O·Q 과세 분기 + 선택 목록 정상화 ──
    //   · 쓰기: 마진계산 O·Q (2~301행, 과세 분기만), ONE_OF_RANGE 드롭다운 재설정. 단가DB 쓰기 없음
    if (action === 'm6') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const read = async (tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE', range: string) =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const g = (rows: Cell[][], r: number, c: number) => (rows[r - 1] || [])[c] ?? ''

      // ── [1] 단가DB 확인 (쓰기 없음) ─────────────────────────────
      const pFx = await read(PRICE_TAB, 'FORMULA', 'A1:M1000')
      const pVal = await read(PRICE_TAB, 'UNFORMATTED_VALUE', 'A1:M1000')
      const rowOfAlias = (al: string) => pVal.findIndex((r) => String(r?.[0] ?? '') === al) + 1
      const check1 = {
        즉석밥6개: (() => { const r = rowOfAlias('[보배마을] 즉석밥 6개'); return r ? { H: g(pVal, r, 7), J: g(pVal, r, 9) } : null })(),
        즉석밥24개: (() => { const r = rowOfAlias('[보배마을] 즉석밥 24개'); return r ? { H: g(pVal, r, 7), J: g(pVal, r, 9) } : null })(),
        귀리현미즉석밥_남음: rowOfAlias('[보배마을] 귀리현미 즉석밥') > 0,
        원료ID빈칸_HJ수기: pFx
          .map((r, i) => ({ r, i }))
          .filter(({ r, i }) => i > 0 && String(r?.[0] ?? '') && String(r?.[4] ?? '').trim() === '' &&
            [7, 9].some((c) => String(r?.[c] ?? '') !== '' && !String(r?.[c]).startsWith('=')))
          .map(({ r, i }) => `${i + 1} ${r[0]}: H=${r[7] ?? ''} J=${r[9] ?? ''}`),
      }
      const taxOf = new Map(pVal.slice(1).map((r) => [String(r?.[0] ?? ''), String(r?.[9] ?? '')]))

      // ── [2] O·Q 변환안 (전부 성공해야 씀) ─────────────────────────
      const mFx = await read(MARGIN_TAB, 'FORMULA', `A1:T${MLAST}`)
      const mBefore = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const oq: Cell[][] = []
      const bad: number[] = []
      let already = 0
      for (let r = 2; r <= MLAST; r++) {
        const o = String(g(mFx, r, 14))
        const q = String(g(mFx, r, 16))
        if (o.includes('*10/11,') && o.includes(`-$N${r})*10/11`)) { already++; oq.push([o, q]); continue }
        const nw = m6Rewrite(o, q, r)
        if (!nw) { bad.push(r); continue }
        oq.push([nw.o, nw.q])
      }
      if (bad.length) return NextResponse.json({ ok: false, error: 'O·Q 수식 형태가 예상과 다름 — 쓰기 중단', 행: bad.slice(0, 20), check1 }, { status: 409 })

      // ── [3] 선택 목록 규칙 수집 ────────────────────────────────
      const auditDv = async () => {
        const gd = await sheets.spreadsheets.get({
          spreadsheetId: MASTER_SHEET_ID, includeGridData: true,
          fields: 'sheets(properties(sheetId,title),data(rowData(values(dataValidation,effectiveValue))))',
        })
        const listCache = new Map<string, Set<string>>()
        const listOf = async (ref: string) => {
          if (listCache.has(ref)) return listCache.get(ref)!
          const rg = ref.replace(/^=/, '')
          const v = ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: rg, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || []) as Cell[][]
          const set = new Set(v.flat().map((x) => String(x ?? '').trim()).filter(Boolean))
          listCache.set(ref, set)
          return set
        }
        const rules: { sheetId: number; tab: string; row: number; col: number; rule: any }[] = []
        const invalid: Record<string, number> = {}
        for (const sh of gd.data.sheets || []) {
          const tab = sh.properties?.title || ''
          const rows = sh.data?.[0]?.rowData || []
          for (let ri = 0; ri < rows.length; ri++) {
            const vals = rows[ri].values || []
            for (let ci = 0; ci < vals.length; ci++) {
              const dv: any = vals[ci].dataValidation
              if (!dv?.condition) continue
              rules.push({ sheetId: sh.properties?.sheetId as number, tab, row: ri, col: ci, rule: dv })
              const ev: any = vals[ci].effectiveValue
              const v = String(ev?.stringValue ?? ev?.numberValue ?? ev?.boolValue ?? '').trim()
              if (!v) continue
              const c = dv.condition
              let allowed: Set<string> | null = null
              if (c.type === 'ONE_OF_LIST') allowed = new Set((c.values || []).map((x: any) => String(x.userEnteredValue ?? '').trim()))
              else if (c.type === 'ONE_OF_RANGE') allowed = await listOf(String(c.values?.[0]?.userEnteredValue ?? ''))
              if (allowed && !allowed.has(v)) {
                const k = `${tab}!${colName(ci)}`
                invalid[k] = (invalid[k] || 0) + 1
              }
            }
          }
        }
        return { rules, invalid }
      }
      const dvBefore = await auditDv()

      // ── 쓰기: O·Q ───────────────────────────────────────────────
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${quote(MARGIN_TAB)}!O2:Q${MLAST}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: oq.map(([o, q], i) => [o, String(g(mFx, i + 2, 15)), q]) },
      })
      // ── 쓰기: ONE_OF_RANGE 규칙 재설정 (발주매핑 C 는 '단가DB'!$A$2:$A) ──
      const reqs: any[] = []
      for (const x of dvBefore.rules) {
        if (x.rule.condition.type !== 'ONE_OF_RANGE') continue
        const ref = x.tab === MAP_TAB && x.col === 2 ? `='${PRICE_TAB}'!$A$2:$A` : String(x.rule.condition.values?.[0]?.userEnteredValue ?? '')
        reqs.push({
          setDataValidation: {
            range: { sheetId: x.sheetId, startRowIndex: x.row, endRowIndex: x.row + 1, startColumnIndex: x.col, endColumnIndex: x.col + 1 },
            rule: { ...x.rule, condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: ref }] } },
          },
        })
      }
      for (let i = 0; i < reqs.length; i += 500) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { requests: reqs.slice(i, i + 500) } })
      }

      // ── 검증 ─────────────────────────────────────────────────
      const mAfter = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const dvAfter = await auditDv()
      const eq = (a: Cell, b: Cell) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? ''))
      const changed: any[] = []
      let taxFreeChanged = 0
      for (let r = 2; r <= MLAST; r++) {
        const b = mBefore[r - 1] || []
        const a = mAfter[r - 1] || []
        const cols = [14, 15, 16].filter((c) => !eq(b[c] ?? '', a[c] ?? ''))
        if (!cols.length) continue
        const tax = taxOf.get(String(a[1] ?? '')) === '과세'
        if (!tax) taxFreeChanged++
        changed.push({ 행: r, 채널: a[0], 별칭: a[1], 과세: tax, 전: cols.map((c) => `${colName(c)}=${b[c] ?? ''}`).join(' '), 후: cols.map((c) => `${colName(c)}=${a[c] ?? ''}`).join(' ') })
      }
      const inputChanged = mBefore.some((b, i) => [0, 1, 2, 3, 4, 7, 10, 17, 23, 24].some((c) => !eq(b?.[c] ?? '', (mAfter[i] || [])[c] ?? '')))
      const pick = (al: string) => mAfter.filter((r) => String(r?.[0] ?? '') === '쿠팡 1P' && String(r?.[1] ?? '') === al).map((r) => ({
        판매가: r[3], 원가: r[5], 봉투: r[6], 박스: r[8], 총비용: r[13], 마진: r[14], 마진율: r[15], BEP: r[16], 상태: r[19],
      }))
      const errs = async (t: string) => errorCellsOf(t, await read(t, 'UNFORMATTED_VALUE', 'A1:AC1000')).length
      return NextResponse.json({
        ok: taxFreeChanged === 0 && !inputChanged,
        check1,
        OQ_변환: { 행: oq.length - already, 이미적용: already },
        즉석밥_6개: pick('[보배마을] 즉석밥 6개'),
        즉석밥_24개: pick('[보배마을] 즉석밥 24개'),
        변경행: changed,
        면세행_변경: taxFreeChanged,
        입력값_변경: inputChanged,
        드롭다운_재설정: reqs.length,
        목록밖_값: { 전: dvBefore.invalid, 후: dvAfter.invalid },
        오류셀: { 마진계산: await errs(MARGIN_TAB), 단가DB: await errs(PRICE_TAB), 발주매핑: await errs(MAP_TAB) },
      })
    }

    // ── m7: 검수 결과 반영 — 스마트스토어 행 별칭 수정·삭제 + 쿠팡 3P 윙 옵션 행 추가 ──
    //   · 입력: m7-data.json (마진계산_검수_260927.xlsx 에서 확정분만 추출)
    //   · 쓰기: 마진계산의 대상 행 B·C (수정), 대상 행 삭제, 새 행 A·B·C·D·H·K·W·X. 단가DB 쓰기 없음
    if (action === 'm7') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const data = m7Data as {
        edits: { row: number; curB: string; alias: string; bong: number }[]
        deletes: { row: number; curB: string }[]
        adds: { pid: string; oid: string; alias: string; bong: number; price: number; spec: string }[]
      }
      const read = async (tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE', range: string) =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(sheetId,title))' })
      const marginId = (meta.data.sheets || []).find((x) => x.properties?.title === MARGIN_TAB)?.properties?.sheetId as number
      const price = await read(PRICE_TAB, 'UNFORMATTED_VALUE', 'A1:M1000')
      const aliasSet = new Set(price.slice(1).map((r) => String(r?.[0] ?? '')).filter(Boolean))
      const mFx = await read(MARGIN_TAB, 'FORMULA', `A1:AC${MLAST}`)
      const mBefore = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const B = (r: number) => String((mBefore[r - 1] || [])[1] ?? '')

      // ── 0. 가드·걸러내기 ─────────────────────────────────────
      const skip: Record<string, string[]> = {}
      const note = (k: string, v: string) => ((skip[k] = skip[k] || []).push(v))
      const edits = data.edits.filter((e) => {
        if (B(e.row) !== e.curB) return note('수정: B값 불일치', `${e.row}`), false
        if (!aliasSet.has(e.alias)) return note('수정: 단가DB에 없는 별칭', `${e.row} ${e.alias}`), false
        return true
      })
      const deletes = data.deletes.filter((d) => (B(d.row) === d.curB ? true : (note('삭제: B값 불일치', `${d.row}`), false)))
      const haveOid = new Set(mBefore.slice(1).map((r) => String(r?.[23] ?? '').trim()).filter(Boolean))
      const adds = data.adds.filter((a) => {
        if (haveOid.has(a.oid)) return note('추가: 옵션ID 이미 있음', a.oid), false
        if (!aliasSet.has(a.alias)) return note('추가: 단가DB에 없는 별칭', `${a.oid} ${a.alias}`), false
        haveOid.add(a.oid)
        return true
      })
      let last = 1
      mBefore.forEach((r, i) => { if (i > 0 && (String(r?.[0] ?? '').trim() || String(r?.[1] ?? '').trim())) last = i + 1 })
      if (last + adds.length > MLAST) throw new Error(`마진계산 ${MLAST}행 초과`)
      const noTpl = adds.map((_, i) => last + 1 + i).filter((r) => !String((mFx[r - 1] || [])[5] ?? '').startsWith('='))
      if (noTpl.length) return NextResponse.json({ ok: false, error: '추가 행에 기존 수식이 없음 — 쓰기 중단', 행: noTpl.slice(0, 10) }, { status: 409 })

      // ── 1. 수정 + 추가 (삭제 전, 행번호 고정 상태) ─────────────────
      const raw: { range: string; values: Cell[][] }[] = []
      const fx: { range: string; values: Cell[][] }[] = []
      for (const e of edits) raw.push({ range: `${quote(MARGIN_TAB)}!B${e.row}:C${e.row}`, values: [[e.alias, e.bong]] })
      adds.forEach((a, i) => {
        const r = last + 1 + i
        raw.push({ range: `${quote(MARGIN_TAB)}!A${r}:D${r}`, values: [['쿠팡 3P', a.alias, a.bong, a.price]] })
        raw.push({ range: `${quote(MARGIN_TAB)}!H${r}`, values: [[a.spec]] })
        raw.push({ range: `${quote(MARGIN_TAB)}!W${r}:X${r}`, values: [[a.pid, a.oid]] })
        fx.push({ range: `${quote(MARGIN_TAB)}!K${r}`, values: [[`=IF($A${r}="","",IFERROR(VLOOKUP($A${r},'${M2_SETTING_TAB}'!$A$2:$C$19,3,FALSE),""))`]] })
      })
      for (let i = 0; i < raw.length; i += 400) {
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { valueInputOption: 'RAW', data: raw.slice(i, i + 400) } })
      }
      if (fx.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: fx } })
      // ── 2. 삭제 (아래 행부터) ─────────────────────────────────
      if (deletes.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: {
            requests: [...deletes].sort((a, b) => b.row - a.row).map((d) => ({
              deleteDimension: { range: { sheetId: marginId, dimension: 'ROWS', startIndex: d.row - 1, endIndex: d.row } },
            })),
          },
        })
      }

      // ── 3. 검증 ─────────────────────────────────────────────
      const mAfter = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      // 손대지 않은 행 A~X 값 무변경 (삭제·수정·추가 행 제외, 순서 대응)
      const touched = new Set([...edits.map((e) => e.row), ...deletes.map((d) => d.row)])
      const keepBefore = mBefore.slice(1, last).map((r, i) => ({ r, row: i + 2 })).filter((x) => !touched.has(x.row))
      const delSet = new Set(deletes.map((d) => d.row))
      const mapRow = (row: number) => row - deletes.filter((d) => d.row < row).length
      const untouchedChanged = keepBefore.filter(({ r, row }) => {
        if (delSet.has(row)) return false
        const a = mAfter[mapRow(row) - 1] || []
        return Array.from({ length: 24 }, (_, c) => c).some((c) => {
          const x = r?.[c] ?? '', y = a[c] ?? ''
          return typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) > 1e-6 : String(x) !== String(y)
        })
      }).map((x) => x.row)
      const rowsA = mAfter.slice(1).map((r, i) => ({ r, row: i + 2 })).filter(({ r }) => String(r?.[1] ?? '').trim())
      const pct = (v: Cell) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : String(v ?? ''))
      const PROC = /가루|즉석밥|매실|식초|강황|칩|즙|빵|순대|오곡밥|새우장|표고|계란|오트밀/
      return NextResponse.json({
        ok: untouchedChanged.length === 0 && errorCellsOf(MARGIN_TAB, mAfter).length === 0,
        반영: { 수정: edits.length, 삭제: deletes.length, 추가: adds.length, 추가_시작행: last + 1 - deletes.length },
        건너뜀: Object.fromEntries(Object.entries(skip).map(([k, v]) => [k, { 수: v.length, 예: v.slice(0, 5) }])),
        규격_없음: adds.filter((a) => a.spec === '없음').map((a) => `${a.alias} ×${a.bong}`),
        손대지않은행_변경: untouchedChanged,
        B_단가DB없음: rowsA.filter(({ r }) => !aliasSet.has(String(r[1]))).map(({ r, row }) => `${row} ${r[1]}`),
        오류셀: errorCellsOf(MARGIN_TAB, mAfter).length,
        원가_빈칸: rowsA.filter(({ r }) => String(r[5] ?? '') === '').map(({ r, row }) => `${row} ${r[0]} ${r[1]}`),
        마진_마이너스_미달: rowsA.filter(({ r }) => (typeof r[15] === 'number' && r[15] < 0) || r[19] === '마진 미달')
          .map(({ r }) => `${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${pct(r[15])}`),
        가공식품_행: rowsA.filter(({ r }) => PROC.test(String(r[1])) && r[0] !== '쿠팡 1P').map(({ r }) => `${r[0]} | ${r[1]} | 수수료율 ${r[10]}`),
      })
    }

    // ── m8: 마진계산 보정 — 3P 규격 소 · 스마트스토어 봉수 · 3P 가공식품 수수료 ──
    //   · 쓰기: 지정 행의 H(규격)·C(봉수)·B(17행만)·K(수수료율) 뿐. 각 행 B 가 기대 별칭과 다르면 건너뜀
    if (action === 'm8') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const read = async () =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(MARGIN_TAB)}!A1:AC${MLAST}`, valueRenderOption: 'UNFORMATTED_VALUE' }))
          .data.values || []) as Cell[][]
      const before = await read()
      const B = (r: number) => String((before[r - 1] || [])[1] ?? '')
      const skipped: string[] = []
      const writes: { range: string; values: Cell[][] }[] = []
      const touched = new Set<number>()
      const specRows = M8_SPEC.filter(([r, al]) => (B(r) === al ? true : (skipped.push(`규격 ${r}: B=${B(r)}`), false)))
      for (const [r] of specRows) { writes.push({ range: `${quote(MARGIN_TAB)}!H${r}`, values: [['소']] }); touched.add(r) }
      const bongRows = M8_BONG.filter(([r, al]) => (B(r) === al ? true : (skipped.push(`봉수 ${r}: B=${B(r)}`), false)))
      for (const [r, , n, newB] of bongRows) {
        writes.push(newB ? { range: `${quote(MARGIN_TAB)}!B${r}:C${r}`, values: [[newB, n]] } : { range: `${quote(MARGIN_TAB)}!C${r}`, values: [[n]] })
        touched.add(r)
      }
      const feeAlias = new Map(M8_SPEC)
      const feeRows = M8_FEE_ROWS.filter((r) => (B(r) === feeAlias.get(r) ? true : (skipped.push(`수수료 ${r}: B=${B(r)}`), false)))
      for (const r of feeRows) { writes.push({ range: `${quote(MARGIN_TAB)}!K${r}`, values: [[M8_FEE]] }); touched.add(r) }
      if (writes.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { valueInputOption: 'RAW', data: writes } })

      const after = await read()
      const eq = (a: Cell, b: Cell) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? ''))
      const others = after.map((_, i) => i + 1).filter((r) => r > 1 && !touched.has(r))
        .filter((r) => Array.from({ length: 29 }, (_, c) => c).some((c) => !eq((before[r - 1] || [])[c] ?? '', (after[r - 1] || [])[c] ?? '')))
      const v = (rows: Cell[][], r: number, c: number) => (rows[r - 1] || [])[c] ?? ''
      const pct = (x: Cell) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-')
      const n0 = (x: Cell) => (typeof x === 'number' ? Math.round(x).toLocaleString('ko-KR') : String(x || '-'))
      return NextResponse.json({
        ok: others.length === 0 && skipped.length === 0 && errorCellsOf(MARGIN_TAB, after).length === 0,
        건너뜀: skipped,
        다른행_변경: others,
        오류셀: errorCellsOf(MARGIN_TAB, after).length,
        규격: specRows.map(([r]) => `${r} | ${v(after, r, 1)} | ${v(after, r, 2)} | ${n0(v(after, r, 3))} | ${n0(v(after, r, 8))} | ${n0(v(after, r, 9))} | ${pct(v(before, r, 15))} → ${pct(v(after, r, 15))}`),
        봉수: bongRows.map(([r]) => `${r} | ${v(after, r, 1)} | ${v(after, r, 2)} | ${n0(v(after, r, 3))} | ${v(after, r, 5) === '' ? '원가 없음' : n0(v(after, r, 5))} | ${pct(v(after, r, 15))}`),
        수수료: feeRows.map((r) => `${r} | ${v(after, r, 1)} | ${v(before, r, 10)} → ${v(after, r, 10)} | ${pct(v(before, r, 15))} → ${pct(v(after, r, 15))}`),
      })
    }

    // ── m9: 스마트스토어 규격(H) 채우기 — H 가 빈 스마트스토어 행만 ──
    //   · 총량 = 봉수 × 단가DB g (즉석밥 N개 = 180g × N). 3kg 이하 소 / ~10kg 중 / ~20kg 대, 총량 못 구하면 소
    if (action === 'm9') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const read = async (tab: string, range: string) =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: 'UNFORMATTED_VALUE' }))
          .data.values || []) as Cell[][]
      const price = await read(PRICE_TAB, 'A1:M1000')
      const gOf = new Map(price.slice(1).map((r) => [String(r?.[0] ?? ''), r?.[5]]))
      const before = await read(MARGIN_TAB, `A1:AC${MLAST}`)
      const targets: { r: number; alias: string; bong: Cell; tot: number | null; spec: string }[] = []
      before.forEach((row, i) => {
        if (i === 0 || String(row?.[0] ?? '') !== '스마트스토어' || String(row?.[7] ?? '') !== '') return
        const alias = String(row?.[1] ?? '')
        if (!alias) return
        const bong = row?.[2] ?? ''
        const rice = alias.match(/즉석밥\s*(\d+)개/)
        const g = rice ? 180 * Number(rice[1]) : gOf.get(alias)
        const tot = typeof g === 'number' && typeof bong === 'number' ? (g * bong) / 1000 : null
        const spec = tot == null || tot <= 3 ? '소' : tot <= 10 ? '중' : tot <= 20 ? '대' : '없음'
        targets.push({ r: i + 1, alias, bong, tot, spec })
      })
      // 쓰기 직전 B 재확인
      const live = await read(MARGIN_TAB, `A1:H${MLAST}`)
      const skipped: string[] = []
      const ok = targets.filter((t) => {
        const row = live[t.r - 1] || []
        if (String(row[1] ?? '') !== t.alias || String(row[7] ?? '') !== '') return skipped.push(`${t.r} B=${row[1]}`), false
        return true
      })
      if (ok.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: MASTER_SHEET_ID,
          requestBody: { valueInputOption: 'RAW', data: ok.map((t) => ({ range: `${quote(MARGIN_TAB)}!H${t.r}`, values: [[t.spec]] })) },
        })
      }
      const after = await read(MARGIN_TAB, `A1:AC${MLAST}`)
      const eq = (a: Cell, b: Cell) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? ''))
      const touched = new Set(ok.map((t) => t.r))
      const others = after.map((_, i) => i + 1).filter((r) => r > 1 && !touched.has(r))
        .filter((r) => Array.from({ length: 29 }, (_, c) => c).some((c) => !eq((before[r - 1] || [])[c] ?? '', (after[r - 1] || [])[c] ?? '')))
      const v = (r: number, c: number) => (after[r - 1] || [])[c] ?? ''
      const n0 = (x: Cell) => (typeof x === 'number' ? Math.round(x).toLocaleString('ko-KR') : String(x || '-'))
      const pct = (x: Cell) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-')
      return NextResponse.json({
        ok: others.length === 0 && skipped.length === 0 && errorCellsOf(MARGIN_TAB, after).length === 0,
        대상: ok.length, 건너뜀: skipped, 다른행_변경: others, 오류셀: errorCellsOf(MARGIN_TAB, after).length,
        총량_없음_소: ok.filter((t) => t.tot == null).map((t) => `${t.r} ${t.alias}`),
        행: ok.map((t) => `${t.r} | ${t.alias} | ${t.bong} | ${t.tot == null ? '?' : `${+t.tot.toFixed(2)}kg`} | ${v(t.r, 7)} | ${n0(v(t.r, 3))} | ${v(t.r, 5) === '' ? '원가 없음' : n0(v(t.r, 5))} | ${pct(v(t.r, 15))}`),
      })
    }

    // ── m10: 원료ID 없는 상품의 단가DB H·J 값 입력 (E 빈칸 행만) ──
    if (action === 'm10') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const read = async (tab: string, range: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE' = 'UNFORMATTED_VALUE') =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const pBefore = await read(PRICE_TAB, 'A1:M1000')
      const mBefore = await read(MARGIN_TAB, `A1:AC${MLAST}`)
      const res: string[] = []
      const writes: { range: string; values: Cell[][] }[] = []
      const rowsDone = new Set<number>()
      for (const [al, h, j] of M10_VALUES) {
        const idx = pBefore.map((r, i) => (String(r?.[0] ?? '') === al ? i + 1 : 0)).filter(Boolean)
        if (idx.length !== 1) { res.push(`${al} | - | - | 건너뜀(마스터 ${idx.length}행)`); continue }
        const r = idx[0]
        if (String(pBefore[r - 1]?.[4] ?? '').trim() !== '') { res.push(`${al} | - | - | 건너뜀(원료ID 있음)`); continue }
        writes.push({ range: `${quote(PRICE_TAB)}!H${r}`, values: [[h]] }, { range: `${quote(PRICE_TAB)}!J${r}`, values: [[j]] })
        rowsDone.add(r)
        res.push(`${al} | ${h} | ${j} | 반영(${r}행)`)
      }
      if (writes.length) {
        await guardManualPriceHJ(sheets, MASTER_SHEET_ID, writes.map((w) => w.range))
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { valueInputOption: 'RAW', data: writes } })
      }
      const pAfter = await read(PRICE_TAB, 'A1:M1000')
      const mAfter = await read(MARGIN_TAB, `A1:AC${MLAST}`)
      const eq = (a: Cell, b: Cell) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : String(a ?? '') === String(b ?? ''))
      const diffRows = (b: Cell[][], a: Cell[][], n: number) =>
        Array.from({ length: Math.max(b.length, a.length) }, (_, i) => i).filter((i) => i > 0 &&
          Array.from({ length: n }, (_, c) => c).some((c) => !eq((b[i] || [])[c] ?? '', (a[i] || [])[c] ?? ''))).map((i) => i + 1)
      const aliases = new Set(M10_VALUES.map((x) => x[0]))
      const priceOther = diffRows(pBefore, pAfter, 13).filter((r) => !rowsDone.has(r))
      const marginOther = diffRows(mBefore, mAfter, 29).filter((r) => !aliases.has(String((mAfter[r - 1] || [])[1] ?? '')))
      const n0 = (x: Cell) => (typeof x === 'number' ? Math.round(x).toLocaleString('ko-KR') : String(x || '-'))
      const pct = (x: Cell) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-')
      return NextResponse.json({
        ok: priceOther.length === 0 && marginOther.length === 0 && errorCellsOf(PRICE_TAB, pAfter).length === 0 && errorCellsOf(MARGIN_TAB, mAfter).length === 0,
        단가DB: res,
        마진계산: mAfter.map((r, i) => ({ r, i })).filter(({ r, i }) => i > 0 && aliases.has(String(r?.[1] ?? '')))
          .map(({ r, i }) => `${i + 1} | ${r[0]} | ${r[1]} | ${r[2]} | ${n0(r[3])} | ${n0(r[5])} | ${pct(r[15])}`),
        단가DB_다른행_변경: priceOther, 마진계산_무관행_변경: marginOther,
        오류셀: { 단가DB: errorCellsOf(PRICE_TAB, pAfter).length, 마진계산: errorCellsOf(MARGIN_TAB, mAfter).length },
      })
    }

    // ── m11: 검수 추가분 — 쿠팡 3P 윙 광고 옵션 행 추가 (m7 추가 규칙과 동일, 기존 행 수정 없음) ──
    if (action === 'm11') {
      const sheets = getSheets()
      const MLAST = 1 + MARGIN_ROWS
      const data = m11Data as { adds: { pid: string; oid: string; name: string; alias: string; bong: number; price: number; spec: string }[] }
      const read = async (tab: string, opt: 'FORMULA' | 'UNFORMATTED_VALUE', range: string) =>
        ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(tab)}!${range}`, valueRenderOption: opt }))
          .data.values || []) as Cell[][]
      const price = await read(PRICE_TAB, 'UNFORMATTED_VALUE', 'A1:M1000')
      const aliasSet = new Set(price.slice(1).map((r) => String(r?.[0] ?? '')).filter(Boolean))
      const mFx = await read(MARGIN_TAB, 'FORMULA', `A1:AC${MLAST}`)
      const mBefore = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const skip: string[] = []
      const haveOid = new Set(mBefore.slice(1).map((r) => String(r?.[23] ?? '').trim()).filter(Boolean))
      const adds = data.adds.filter((a) => {
        if (haveOid.has(a.oid)) return skip.push(`${a.oid} 이미 있음`), false
        if (!aliasSet.has(a.alias)) return skip.push(`${a.oid} 단가DB에 없는 별칭 ${a.alias}`), false
        haveOid.add(a.oid)
        return true
      })
      let last = 1
      mBefore.forEach((r, i) => { if (i > 0 && (String(r?.[0] ?? '').trim() || String(r?.[1] ?? '').trim())) last = i + 1 })
      if (last + adds.length > MLAST) throw new Error(`마진계산 ${MLAST}행 초과`)
      const noTpl = adds.map((_, i) => last + 1 + i).filter((r) => !String((mFx[r - 1] || [])[5] ?? '').startsWith('='))
      if (noTpl.length) return NextResponse.json({ ok: false, error: '추가 행에 기존 수식이 없음 — 쓰기 중단', 행: noTpl.slice(0, 10) }, { status: 409 })
      const raw: { range: string; values: Cell[][] }[] = []
      const fx: { range: string; values: Cell[][] }[] = []
      adds.forEach((a, i) => {
        const r = last + 1 + i
        raw.push({ range: `${quote(MARGIN_TAB)}!A${r}:D${r}`, values: [['쿠팡 3P', a.alias, a.bong, a.price]] })
        raw.push({ range: `${quote(MARGIN_TAB)}!H${r}`, values: [[a.spec]] })
        raw.push({ range: `${quote(MARGIN_TAB)}!W${r}:X${r}`, values: [[a.pid, a.oid]] })
        fx.push({ range: `${quote(MARGIN_TAB)}!K${r}`, values: [[`=IF($A${r}="","",IFERROR(VLOOKUP($A${r},'${M2_SETTING_TAB}'!$A$2:$C$19,3,FALSE),""))`]] })
      })
      if (raw.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { valueInputOption: 'RAW', data: raw } })
      if (fx.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER_SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: fx } })
      const mAfter = await read(MARGIN_TAB, 'UNFORMATTED_VALUE', `A1:AC${MLAST}`)
      const eq = (x: Cell, y: Cell) => (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 1e-6 : String(x ?? '') === String(y ?? ''))
      const changed = Array.from({ length: last - 1 }, (_, i) => i + 2)
        .filter((r) => Array.from({ length: 29 }, (_, c) => c).some((c) => !eq((mBefore[r - 1] || [])[c] ?? '', (mAfter[r - 1] || [])[c] ?? '')))
      const pct = (v: Cell) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '-')
      const byOid = new Map(adds.map((a) => [a.oid, a]))
      return NextResponse.json({
        ok: changed.length === 0 && errorCellsOf(MARGIN_TAB, mAfter).length === 0,
        추가: adds.length, 시작행: last + 1, 건너뜀: skip, 기존행_변경: changed, 오류셀: errorCellsOf(MARGIN_TAB, mAfter).length,
        행: mAfter.slice(last, last + adds.length).map((r) => {
          const a = byOid.get(String(r[23] ?? ''))
          const bep = typeof r[14] === 'number' && r[14] > 0 && typeof r[3] === 'number' ? (r[3] / r[14]).toFixed(2) : '-'
          return `${r[23]} | ${a?.name ?? ''} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[7]} | ${pct(r[15])} | ${bep}`
        }),
      })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (e: any) {
    console.error('[rebuild] error:', e?.message || e)
    return NextResponse.json({ ok: false, error: e?.message || '서버 오류' }, { status: 500 })
  }
}
