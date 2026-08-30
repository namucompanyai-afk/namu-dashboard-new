/**
 * B2B 발주 변환 — 컬리 도메인 로직 (순수 함수)
 *
 * 서버(app/api/b2b/kurly)는 구글시트 → ProductMaster/MilkrunPrice 파싱에,
 * 클라이언트(app/b2b)는 업로드 xlsx 파싱 + 팔레트/운송비 산정에 같은 모듈을 쓴다.
 *
 * 구글시트는 read-only. 이 모듈에도 상위 라우트에도 쓰기 코드는 없다.
 */

// ── 공통 유틸 ────────────────────────────────────────────────────
/** 헤더/구분값 비교용 정규화 — 공백·전각공백 제거 후 소문자 */
export const norm = (v: unknown): string =>
  String(v ?? '').replace(/[\s 　]/g, '').toLowerCase()

/** 콤마·원·₩ 섞인 셀 → 숫자 (실패 시 0) */
export const toNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

const trim = (v: unknown): string => String(v ?? '').trim()

// ── 상품마스터 ───────────────────────────────────────────────────
/** 상품마스터 탭 1행 헤더 기준. 매칭 키는 kurlyMasterCode (상품명 매칭 금지) */
export type ProductMaster = {
  channel: string // 채널
  alias: string // 별칭
  name: string // 상품명
  taxType: string // 과세 구분 (과세/면세)
  shipFrom: string // 출고지 (진도팜/위킵/곰표)
  priceShipFrom: string // 요금표 출고지 — 밀크런 가격표의 출고지명 (미입력이면 빈 문자열)
  boxQty: number // 박스입수
  coupangSkuId: string // 쿠팡 SKU ID
  coupangSupply: number // 쿠팡 공급가
  coupangDiscount: number // 쿠팡 할인 공급가
  kurlyMasterCode: string // 컬리 마스터 코드 ← 매칭 키
  kurlySupply: number // 컬리 공급가
  kurlyDiscount: number // 컬리 할인 공급가
  barcode: string // 바코드
  boxW: number // 박스가로(mm) — 미등록이면 0
  boxD: number // 박스세로(mm) — 미등록이면 0
  boxH: number // 박스높이(mm) — 미등록이면 0
}

const PRODUCT_COLS: Record<keyof ProductMaster, string[]> = {
  channel: ['채널'],
  alias: ['별칭'],
  name: ['상품명'],
  taxType: ['과세구분', '과세여부', '과세'],
  shipFrom: ['출고지'],
  priceShipFrom: ['요금표출고지'],
  boxQty: ['박스입수'],
  coupangSkuId: ['쿠팡skuid', '쿠팡sku', 'skuid'],
  coupangSupply: ['쿠팡공급가'],
  coupangDiscount: ['쿠팡할인공급가'],
  kurlyMasterCode: ['컬리마스터코드', '마스터코드'],
  kurlySupply: ['컬리공급가'],
  kurlyDiscount: ['컬리할인공급가'],
  barcode: ['바코드'],
  boxW: ['박스가로mm', '박스가로'],
  boxD: ['박스세로mm', '박스세로'],
  boxH: ['박스높이mm', '박스높이'],
}

/**
 * 헤더행에서 컬럼 인덱스 해석.
 * 정규화 완전일치 → 없으면 candidate 를 포함하는 헤더로 폴백(시트 표기 흔들림 흡수).
 */
export function resolveCols<K extends string>(
  header: unknown[],
  spec: Record<K, string[]>,
): Record<K, number> {
  const h = header.map(norm)
  const out = {} as Record<K, number>
  for (const key of Object.keys(spec) as K[]) {
    const cands = spec[key].map(norm)
    let idx = h.findIndex((x) => x !== '' && cands.includes(x))
    if (idx < 0) idx = h.findIndex((x) => x !== '' && cands.some((c) => x.includes(c)))
    out[key] = idx
  }
  return out
}

const at = (row: unknown[], idx: number): unknown => (idx >= 0 ? row[idx] : '')

/** 상품마스터 시트 rows(헤더 1행 포함) → ProductMaster[] */
export function parseProductMaster(rows: unknown[][]): ProductMaster[] {
  if (!rows.length) return []
  const c = resolveCols(rows[0], PRODUCT_COLS)
  const out: ProductMaster[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const code = trim(at(r, c.kurlyMasterCode))
    const name = trim(at(r, c.name))
    if (!code && !name) continue
    out.push({
      channel: trim(at(r, c.channel)),
      alias: trim(at(r, c.alias)),
      name,
      taxType: trim(at(r, c.taxType)),
      shipFrom: trim(at(r, c.shipFrom)),
      priceShipFrom: trim(at(r, c.priceShipFrom)),
      boxQty: toNum(at(r, c.boxQty)),
      coupangSkuId: trim(at(r, c.coupangSkuId)),
      coupangSupply: toNum(at(r, c.coupangSupply)),
      coupangDiscount: toNum(at(r, c.coupangDiscount)),
      kurlyMasterCode: code,
      kurlySupply: toNum(at(r, c.kurlySupply)),
      kurlyDiscount: toNum(at(r, c.kurlyDiscount)),
      barcode: trim(at(r, c.barcode)),
      boxW: toNum(at(r, c.boxW)),
      boxD: toNum(at(r, c.boxD)),
      boxH: toNum(at(r, c.boxH)),
    })
  }
  return out
}

/** 컬리 마스터 코드 → 마스터 (코드 있는 행만). 상품명은 키로 쓰지 않는다. */
export function indexByMasterCode(list: ProductMaster[]): Record<string, ProductMaster> {
  const m: Record<string, ProductMaster> = {}
  for (const p of list) if (p.kurlyMasterCode) m[norm(p.kurlyMasterCode)] = p
  return m
}

// ── 컬리 밀크런 가격표 ───────────────────────────────────────────
/** 가격표 1행 헤더: 구분/최소PLT/최대PLT/차량/부가포함 단가/원가/비고 */
export type MilkrunPrice = {
  gubun: string
  minPlt: number | null
  maxPlt: number | null
  vehicle: string
  unitPrice: number // 부가포함 단가 ← 계산에 쓰는 값
  cost: number // 원가 (참고 표시용)
  note: string
}

const PRICE_COLS = {
  gubun: ['구분'],
  minPlt: ['최소plt', '최소'],
  maxPlt: ['최대plt', '최대'],
  vehicle: ['차량'],
  unitPrice: ['부가포함단가', '부가포함'],
  cost: ['원가'],
  note: ['비고'],
}

/**
 * 가격표 rows(헤더 1행 포함) → MilkrunPrice[].
 * 표 아래 각주(※로 시작하는 행)·빈 구분 행은 버린다.
 */
export function parseMilkrunPrices(rows: unknown[][]): MilkrunPrice[] {
  if (!rows.length) return []
  const c = resolveCols(rows[0], PRICE_COLS)
  const out: MilkrunPrice[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const gubun = trim(at(r, c.gubun))
    if (!gubun || gubun.startsWith('※') || gubun.startsWith('*')) continue
    const rawMin = trim(at(r, c.minPlt))
    const rawMax = trim(at(r, c.maxPlt))
    out.push({
      gubun,
      minPlt: rawMin === '' ? null : toNum(rawMin),
      maxPlt: rawMax === '' ? null : toNum(rawMax),
      vehicle: trim(at(r, c.vehicle)),
      unitPrice: toNum(at(r, c.unitPrice)),
      cost: toNum(at(r, c.cost)),
      note: trim(at(r, c.note)),
    })
  }
  return out
}

// 구분값 판별 — 시트 표기 흔들림(화살표 문자·언더바 유무)에 안 깨지게 부분일치로 본다
const isVehicleFee = (g: string) => norm(g).startsWith('차량비')
const isViaFee = (g: string) => norm(g).startsWith('경유비')
const isMoveFee = (g: string, region: string) => norm(g).includes('이고비') && g.includes(region)

/** 총 PLT 수로 차량비 구간 lookup. 최대PLT 빈칸 = 상한 없음 */
export function lookupVehicleFee(prices: MilkrunPrice[], totalPlt: number): MilkrunPrice | null {
  return (
    prices.find(
      (p) =>
        isVehicleFee(p.gubun) &&
        totalPlt >= (p.minPlt ?? 0) &&
        totalPlt <= (p.maxPlt ?? Number.POSITIVE_INFINITY),
    ) ?? null
  )
}

// ── 컬리 발주 xlsx ───────────────────────────────────────────────
export type KurlyOrderRow = {
  productCode: string // 발주 내역='발주상품코드'(P···, 행 단위) / 발주서내역='발주코드'(T···)
  invoiceCode: string // 거래명세서코드 (K···) — 발주 내역 양식에만 있다
  orderKey: string // 발주 단위 그룹핑 키 = 거래명세서코드, 없으면 productCode
  taxType: string // 발주 파일 과세구분 (금액 계산은 상품마스터 과세 구분을 쓴다)
  status: string // 상태
  dueDate: string // 입고예정일
  masterCode: string // 마스터코드 ← 상품마스터 매칭 키
  productName: string // 상품명
  dest: string // 입고지 (= 최종 입고지, 팔레트 분리 기준)
  viaCenter: string // 경유센터
  shipMethod: string // 출고방법
  unitsPerBox: number // 박스당입수
  boxCount: number // 발주확정 수량(박스) — 확정 칸이 비면 발주생성 수량(박스)
  totalUnits: number // 발주확정 수량(낱개) — 확정 칸이 비면 발주생성 수량(낱개)
  expiry: string // 소비기한(유통기한)
  // 발주 파일의 실제 금액(프로모션 할인 반영분) — 시트 공급가로 재계산하지 않는다
  supplyUnit: number // 공급단가
  supplyTotal: number // 공급가
}

export const ORDER_SHEET_NAME = '발주 내역'

/**
 * 컬리 발주 파일 헤더 매핑 — 두 양식을 모두 정식 지원한다.
 *
 *   '발주 내역'   (46컬럼) : 발주상품코드(P···) · 거래명세서코드(K···) · 발주수량/총 발주수량
 *   '발주서내역'  (41컬럼) : 발주코드(T···) · 발주생성/발주확정 수량(박스·낱개)
 *
 * resolveCols 는 후보 완전일치를 먼저 훑으므로 배열 순서와 무관하게 파일에 있는
 * 이름이 잡힌다. 두 양식 이름을 나란히 두고, 부분일치 폴백에 기대지 않는다.
 */
const ORDER_COLS: Record<keyof KurlyOrderRow, string[]> = {
  productCode: ['발주상품코드', '발주코드'],
  invoiceCode: ['거래명세서코드'],
  orderKey: [], // 파생 필드 — 시트 컬럼 아님
  taxType: ['과세구분'],
  status: ['상태', '발주상태'],
  dueDate: ['입고예정일'],
  masterCode: ['마스터코드'],
  productName: ['상품명'],
  dest: ['입고지'],
  viaCenter: ['경유센터'],
  shipMethod: ['출고방법'],
  unitsPerBox: ['박스당입수'],
  boxCount: ['발주수량', '발주확정수량(박스)'],
  totalUnits: ['총발주수량', '발주확정수량(낱개)'],
  expiry: ['소비기한/유통기한', '유통기한/소비기한', '소비기한(유통기한)', '소비기한'],
  supplyUnit: ['공급단가'],
  supplyTotal: ['공급가'],
}

/** 확정 칸이 비어 내려온 발주서(확정 전)용 폴백 — 값이 0 이면 0 그대로 쓴다 */
const ORDER_CREATED_COLS = {
  boxCreated: ['발주생성수량(박스)'],
  unitsCreated: ['발주생성수량(낱개)'],
}

/** 엑셀 날짜(Date·serial·문자열) → YYYY-MM-DD */
export function fmtDate(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date) {
    const kst = new Date(v.getTime() - v.getTimezoneOffset() * 60000)
    return kst.toISOString().slice(0, 10)
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 엑셀 serial (1900 체계, 1900-02-29 버그 보정 포함한 통상 오프셋)
    const ms = Math.round((v - 25569) * 86400 * 1000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(s)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  return s
}

/**
 * '발주 내역' rows(헤더 1행 포함) → KurlyOrderRow[].
 * 박스 수 = 확정 수량(박스) / 낱개 수 = 확정 수량(낱개) (혼동 금지).
 */
export function parseKurlyOrderRows(rows: unknown[][]): KurlyOrderRow[] {
  if (!rows.length) return []
  const c = resolveCols(rows[0], ORDER_COLS)
  const alt = resolveCols(rows[0], ORDER_CREATED_COLS)
  if (c.dest < 0 || c.masterCode < 0) {
    throw new Error("'발주 내역' 헤더에서 입고지/마스터코드 컬럼을 찾지 못했습니다.")
  }
  // 수량 컬럼을 하나도 못 찾으면 전 행이 0박스가 되므로 조용히 넘기지 않는다
  if (c.boxCount < 0 && alt.boxCreated < 0) {
    throw new Error("'발주 내역' 헤더에서 발주 수량(박스) 컬럼을 찾지 못했습니다.")
  }
  /** 확정 칸이 비었으면(확정 전) 생성 칸으로 대체 — 0 은 0 그대로 */
  const qtyOf = (r: unknown[], confirmed: number, created: number): number => {
    const v = at(r, confirmed)
    return trim(v) === '' ? toNum(at(r, created)) : toNum(v)
  }
  const out: KurlyOrderRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const masterCode = trim(at(r, c.masterCode))
    const productName = trim(at(r, c.productName))
    const productCode = trim(at(r, c.productCode))
    if (!masterCode && !productName && !productCode) continue
    const invoiceCode = trim(at(r, c.invoiceCode))
    out.push({
      productCode,
      invoiceCode,
      // 발주 단위 키 — 발주 내역 양식의 P코드는 행마다 달라 그룹핑에 못 쓴다
      orderKey: invoiceCode || productCode,
      taxType: trim(at(r, c.taxType)),
      status: trim(at(r, c.status)),
      dueDate: fmtDate(at(r, c.dueDate)),
      masterCode,
      productName,
      dest: trim(at(r, c.dest)),
      viaCenter: trim(at(r, c.viaCenter)),
      shipMethod: trim(at(r, c.shipMethod)),
      unitsPerBox: toNum(at(r, c.unitsPerBox)),
      boxCount: qtyOf(r, c.boxCount, alt.boxCreated),
      totalUnits: qtyOf(r, c.totalUnits, alt.unitsCreated),
      expiry: fmtDate(at(r, c.expiry)),
      supplyUnit: toNum(at(r, c.supplyUnit)),
      supplyTotal: toNum(at(r, c.supplyTotal)),
    })
  }
  return out
}

// ── 팔레트 산정 ──────────────────────────────────────────────────
export const MAX_SKU_PER_PLT = 3

// ── 적재 기하 (도면과 팔레트 장수 계산이 같은 식을 쓰도록 여기에 둔다) ──
export const DEFAULT_BOX_MM = 400 // 치수 미등록 상품 가정값
export const PALLET_MM = 150 // 팔레트 자체 높이
export const LIMIT_MM = 1700 // 컬리 적재 한도
export const PALLET_W_MM = 1100 // 팔레트 바닥 가로
export const PALLET_D_MM = 1100 // 팔레트 바닥 세로

/** 박스 실측 치수(mm). 마스터 미등록이면 가정값 + unknown 플래그 */
export type BoxDims = { w: number; d: number; h: number; unknown: boolean }

export const UNKNOWN_DIMS: BoxDims = {
  w: DEFAULT_BOX_MM,
  d: DEFAULT_BOX_MM,
  h: DEFAULT_BOX_MM,
  unknown: true,
}

/** 상품마스터 실측 치수 — 가로/세로/높이 중 하나라도 비면 가정값으로 폴백 */
export const dimsOf = (m: ProductMaster | undefined): BoxDims => {
  const w = m?.boxW ?? 0
  const d = m?.boxD ?? 0
  const h = m?.boxH ?? 0
  return w > 0 && d > 0 && h > 0 ? { w, d, h, unknown: false } : UNKNOWN_DIMS
}

/** 1,100×1,100 바닥 격자 — 이 박스로 팔레트를 채웠을 때 자리 수 */
export function floorGrid(dims: BoxDims): { cols: number; rows: number; slots: number } {
  const cols = Math.max(1, Math.floor(PALLET_W_MM / dims.w))
  const rows = Math.max(1, Math.floor(PALLET_D_MM / dims.d))
  return { cols, rows, slots: cols * rows }
}

/** 한도 1,700mm(팔레트 150mm 포함) 안에서 쌓을 수 있는 최대 단수 */
export const maxTiersOf = (dims: BoxDims): number =>
  Math.max(1, Math.floor((LIMIT_MM - PALLET_MM) / dims.h))

/** 박스 n개 → 자리별 단수. 자리당 최대 maxTier, 앞 자리부터 채운다. */
export function packColumns(boxes: number, maxTier: number): number[] {
  const cap = Math.max(1, Math.floor(maxTier))
  const out: number[] = []
  let left = Math.max(0, Math.floor(boxes))
  while (left > 0) {
    const t = Math.min(cap, left)
    out.push(t)
    left -= t
  }
  return out
}

/** 한 입고지에 올라가는 SKU 별 적재 단위 (등장 순서 유지) */
export type SkuStack = {
  code: string // 마스터코드 (발주 파일 표기 그대로)
  dims: BoxDims
  boxes: number
  units: number
  tiersPerSlot: number // 한도 안에서 이 박스가 쌓이는 최대 단수
  columns: number[] // 자리별 단수
}

/** 발주 행 묶음 → SKU 별 적재 단위 */
export function stacksOf(
  orders: KurlyOrderRow[],
  rowIndexes: number[],
  masterByCode: Record<string, ProductMaster>,
): SkuStack[] {
  const map = new Map<string, SkuStack>()
  for (const i of rowIndexes) {
    const o = orders[i]
    if (!o) continue
    const key = norm(o.masterCode)
    let st = map.get(key)
    if (!st) {
      const dims = dimsOf(masterByCode[key])
      st = { code: o.masterCode, dims, boxes: 0, units: 0, tiersPerSlot: maxTiersOf(dims), columns: [] }
      map.set(key, st)
    }
    st.boxes += o.boxCount
    st.units += o.totalUnits
  }
  const list = [...map.values()]
  for (const st of list) st.columns = packColumns(st.boxes, st.tiersPerSlot)
  return list
}

/**
 * 자리 크기를 정하는 격자 — 이 팔레트에 올라가는 박스 중 **자리가 가장 적게
 * 나오는(=가장 빡빡한) 박스** 기준. 한 자리에 한 SKU 만 올리므로 여기에 맞춘다.
 */
export function palletGridOf(stacks: SkuStack[]): {
  cols: number
  rows: number
  slots: number
  dims: BoxDims
} {
  if (!stacks.length) return { ...floorGrid(UNKNOWN_DIMS), dims: UNKNOWN_DIMS }
  return stacks
    .map((st) => ({ ...floorGrid(st.dims), dims: st.dims }))
    .reduce((a, b) => (b.slots < a.slots ? b : a))
}

/** 팔레트 한 장에 담긴 자리 — stack 인덱스 + 그 자리의 단수 */
export type PalletSlot = { stack: number; tiers: number }

/**
 * SKU 별 자리들을 팔레트에 담는다 — **자리 수 한도와 PLT당 SKU 한도를 둘 다** 지킨다.
 * 앞 팔레트부터 채우고, 둘 중 하나라도 넘치면 다음 팔레트를 연다.
 */
export function packPallets(
  stacks: SkuStack[],
  slotsPerPallet: number,
  maxSku = MAX_SKU_PER_PLT,
): PalletSlot[][] {
  const cap = Math.max(1, slotsPerPallet)
  const skuCap = Math.max(1, maxSku)
  const out: PalletSlot[][] = []
  let cur: PalletSlot[] | null = null
  let curSkus = new Set<number>()
  stacks.forEach((st, si) => {
    for (const tiers of st.columns) {
      const needNew =
        !cur || cur.length >= cap || (!curSkus.has(si) && curSkus.size >= skuCap)
      if (needNew) {
        cur = []
        curSkus = new Set<number>()
        out.push(cur)
      }
      // needNew 분기에서 항상 새 배열이 들어가므로 여기서 cur 는 비어 있지 않다
      ;(cur as PalletSlot[]).push({ stack: si, tiers })
      curSkus.add(si)
    }
  })
  return out.length ? out : [[]]
}

export type Region = '평택' | '김포' | '창원' | '기타'
const REGIONS: Exclude<Region, '기타'>[] = ['김포', '창원', '평택']

/** 최종 입고지 기준 권역 판별 — 입고지에 없으면 경유센터로 폴백 */
export function regionOf(dest: string, viaCenter: string): Region {
  for (const k of REGIONS) if (dest.includes(k)) return k
  for (const k of REGIONS) if (viaCenter.includes(k)) return k
  return '기타'
}

export type PalletGroup = {
  dest: string // 최종 입고지 (팔레트 분리 기준)
  region: Region
  viaCenters: string[] // 참고 표시용
  skuCodes: string[] // 이 입고지의 distinct 마스터코드
  rowIndexes: number[] // orders 배열 인덱스 (등장 순서)
  plt: number // 실측 자리 수 + PLT당 SKU 한도로 계산한 팔레트 장수
  totalBoxes: number
  totalUnits: number
  overSku: boolean // SKU 3 초과 → 경고
}

// ── 입고예정일 분리 ──────────────────────────────────────────────
/** 입고예정일 한 건의 발주 행 (rowIndexes 는 원본 orders 인덱스) */
export type DueSlice = { dueDate: string; rowIndexes: number[]; orders: KurlyOrderRow[] }

/**
 * 입고예정일별로 발주 행을 나눈다.
 * 입고일마다 배차가 따로 나가므로 팔레트·혼적·운송비는 이 단위로 계산한다.
 * (매출 요약·발주 이력은 파일 전체 기준 그대로다)
 */
export function sliceByDueDate(orders: KurlyOrderRow[]): DueSlice[] {
  const map = new Map<string, DueSlice>()
  orders.forEach((o, i) => {
    const key = o.dueDate || '(입고예정일 미상)'
    let sl = map.get(key)
    if (!sl) {
      sl = { dueDate: key, rowIndexes: [], orders: [] }
      map.set(key, sl)
    }
    sl.rowIndexes.push(i)
    sl.orders.push(o)
  })
  return [...map.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

// ── 물리 팔레트 (혼적 포함) ──────────────────────────────────────
/** 팔레트 한 자리 — 어느 입고지의 어떤 SKU 가 몇 단 올라갔는지 */
export type UnitSlot = {
  dest: string
  code: string // 마스터코드
  tiers: number
  dims: BoxDims
}

/** 실제로 준비하는 팔레트 1장 */
export type PalletUnit = {
  dests: string[] // 이 장에 실린 입고지 (혼적이면 2곳)
  regions: Region[]
  slots: UnitSlot[]
  cols: number
  rows: number
  slotCount: number
  gridDims: BoxDims
  mixed: boolean // 경유 혼적 여부
}

/** 경유 혼적이 가능한 권역 — 둘 다 입고대행센터(평택1) 경유. 평택 직납은 제외 */
const MIXABLE: Region[] = ['김포', '창원']

const unitOf = (dest: string, region: Region, slots: UnitSlot[]): PalletUnit => {
  const dims = slots.map((s) => s.dims)
  const grid = dims.length
    ? dims.map((d) => ({ ...floorGrid(d), dims: d })).reduce((a, b) => (b.slots < a.slots ? b : a))
    : { ...floorGrid(UNKNOWN_DIMS), dims: UNKNOWN_DIMS }
  return {
    dests: [dest],
    regions: [region],
    slots,
    cols: grid.cols,
    rows: grid.rows,
    slotCount: grid.slots,
    gridDims: grid.dims,
    mixed: false,
  }
}

/** 두 팔레트를 한 장으로 합칠 수 있으면 합친 결과, 아니면 null */
export function mergeUnits(a: PalletUnit, b: PalletUnit, maxSku = MAX_SKU_PER_PLT): PalletUnit | null {
  const slots = [...a.slots, ...b.slots]
  const skus = new Set(slots.map((s) => norm(s.code)))
  if (skus.size > maxSku) return null
  const grid = slots
    .map((s) => ({ ...floorGrid(s.dims), dims: s.dims }))
    .reduce((x, y) => (y.slots < x.slots ? y : x))
  if (slots.length > grid.slots) return null
  return {
    dests: [...a.dests, ...b.dests],
    regions: [...a.regions, ...b.regions],
    slots,
    cols: grid.cols,
    rows: grid.rows,
    slotCount: grid.slots,
    gridDims: grid.dims,
    mixed: true,
  }
}

/**
 * 발주 행 → 실제로 준비하는 팔레트 장수.
 *
 * 입고지별로 실측 자리·SKU 한도에 맞춰 나눈 뒤, 같은 경유센터를 타는
 * 김포·창원의 **마지막 자투리 장끼리** 한 장에 들어가면 혼적한다.
 * 평택은 직납이라 혼적하지 않는다.
 */
export function buildPalletUnits(
  orders: KurlyOrderRow[],
  masterByCode: Record<string, ProductMaster> = {},
): PalletUnit[] {
  const byDest = new Map<string, { region: Region; rowIndexes: number[] }>()
  orders.forEach((o, i) => {
    const key = o.dest || '(입고지 없음)'
    let e = byDest.get(key)
    if (!e) {
      e = { region: regionOf(o.dest, o.viaCenter), rowIndexes: [] }
      byDest.set(key, e)
    }
    e.rowIndexes.push(i)
  })

  const units: PalletUnit[] = []
  for (const [dest, e] of byDest) {
    const stacks = stacksOf(orders, e.rowIndexes, masterByCode)
    const grid = palletGridOf(stacks)
    for (const pack of packPallets(stacks, grid.slots)) {
      units.push(
        unitOf(
          dest,
          e.region,
          pack.map((sl) => ({
            dest,
            code: stacks[sl.stack].code,
            tiers: sl.tiers,
            dims: stacks[sl.stack].dims,
          })),
        ),
      )
    }
  }

  // 혼적 — 김포·창원의 마지막 장끼리 한 장에 들어가면 합친다
  const lastOf = (r: Region): number => {
    for (let i = units.length - 1; i >= 0; i--) {
      if (!units[i].mixed && units[i].regions[0] === r) return i
    }
    return -1
  }
  const ai = lastOf(MIXABLE[0])
  const bi = lastOf(MIXABLE[1])
  if (ai >= 0 && bi >= 0) {
    const merged = mergeUnits(units[ai], units[bi])
    if (merged) {
      const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai]
      units.splice(hi, 1)
      units.splice(lo, 1)
      units.push(merged)
    }
  }
  return units
}

/**
 * 최종 입고지(입고지 컬럼) 기준 팔레트 분리.
 * 경유센터가 같아도 최종 입고지가 다르면 별도 PLT.
 *
 * 한 입고지의 팔레트 장수는 실측 박스 치수로 계산한다 —
 * 바닥 자리(1,100×1,100 격자) 와 PLT당 SKU 한도를 둘 다 넘기면 자동 분할한다.
 * 김포·창원 자투리 장이 혼적되면 그 장은 **두 입고지 모두**에 1장으로 잡힌다
 * (포털 파렛트수 신고·이고비는 입고지별 물량 기준이므로).
 * masterByCode 를 안 넘기면 치수 미등록으로 보고 가정값(400mm)으로 계산한다.
 */
export function buildPallets(
  orders: KurlyOrderRow[],
  masterByCode: Record<string, ProductMaster> = {},
): PalletGroup[] {
  const map = new Map<string, PalletGroup>()
  orders.forEach((o, i) => {
    const key = o.dest || '(입고지 없음)'
    let g = map.get(key)
    if (!g) {
      g = {
        dest: key,
        region: regionOf(o.dest, o.viaCenter),
        viaCenters: [],
        skuCodes: [],
        rowIndexes: [],
        plt: 1,
        totalBoxes: 0,
        totalUnits: 0,
        overSku: false,
      }
      map.set(key, g)
    }
    g.rowIndexes.push(i)
    g.totalBoxes += o.boxCount
    g.totalUnits += o.totalUnits
    if (o.masterCode && !g.skuCodes.includes(o.masterCode)) g.skuCodes.push(o.masterCode)
    if (o.viaCenter && !g.viaCenters.includes(o.viaCenter)) g.viaCenters.push(o.viaCenter)
  })
  const list = [...map.values()]
  const units = buildPalletUnits(orders, masterByCode)
  for (const g of list) {
    // 혼적 장은 실린 입고지 **각각**에 1장으로 잡는다 (포털 신고·이고비 기준)
    g.plt = units.filter((u) => u.dests.includes(g.dest)).length
    g.overSku = g.skuCodes.length > MAX_SKU_PER_PLT
  }
  return list
}

/**
 * 포털 파렛트수 입력값 — 같은 입고지 내 첫 발주 행에 그 입고지의 팔레트 장수,
 * 나머지 행은 0. 반환값은 orders 와 같은 길이/순서.
 */
export function palletInputValues(orders: KurlyOrderRow[], pallets: PalletGroup[]): number[] {
  const out = new Array(orders.length).fill(0)
  for (const g of pallets) {
    if (g.rowIndexes.length > 0) out[g.rowIndexes[0]] = g.plt
  }
  return out
}

// ── 운송비 계산 ──────────────────────────────────────────────────
export type CostLine = { label: string; unit: number; qty: number; amount: number; note?: string }

export type TransportCost = {
  totalPlt: number
  vehicle: CostLine // 차량비 (총 PLT 구간 lookup)
  via: CostLine // 경유비 × 경유 곳 수
  moveKimpo: CostLine // 이고비_김포 × 김포행 PLT
  moveChangwon: CostLine // 이고비_창원 × 창원행 PLT
  total: number
  warnings: string[]
}

/**
 * 운송비 = 차량비 + 경유비×경유곳수 + 이고비_김포×김포PLT + 이고비_창원×창원PLT.
 * 전부 '부가포함 단가' 사용. 경유 곳 수는 김포/창원 중 물량 있는 곳만(평택 제외).
 *
 * 차량비 구간에 넣는 총 PLT 는 **실제로 싣는 팔레트 장수**다 — 혼적으로 한 장이
 * 줄면 그만큼 줄어든다. 이고비는 입고지별 물량 기준이라 혼적 장을 양쪽에 각각
 * 계상한다(pallets[].plt 가 이미 그렇게 계산돼 있다).
 * 단가·구간 lookup 자체는 건드리지 않는다.
 */
export function calcTransportCost(
  pallets: PalletGroup[],
  prices: MilkrunPrice[],
  physicalPlt?: number,
): TransportCost {
  const warnings: string[] = []
  const totalPlt = physicalPlt ?? pallets.reduce((s, g) => s + g.plt, 0)
  const pltIn = (r: Region) => pallets.filter((g) => g.region === r).reduce((s, g) => s + g.plt, 0)

  const kimpoPlt = pltIn('김포')
  const changwonPlt = pltIn('창원')
  const viaCount = (kimpoPlt > 0 ? 1 : 0) + (changwonPlt > 0 ? 1 : 0) // 평택은 경유 아님

  const veh = lookupVehicleFee(prices, totalPlt)
  if (!veh && totalPlt > 0) warnings.push(`차량비 구간을 찾지 못했습니다 (총 ${totalPlt} PLT)`)

  const viaRow = prices.find((p) => isViaFee(p.gubun)) ?? null
  if (!viaRow && viaCount > 0) warnings.push('경유비 단가 행을 찾지 못했습니다')

  const kimpoRow = prices.find((p) => isMoveFee(p.gubun, '김포')) ?? null
  if (!kimpoRow && kimpoPlt > 0) warnings.push('이고비_김포 단가 행을 찾지 못했습니다')

  const changwonRow = prices.find((p) => isMoveFee(p.gubun, '창원')) ?? null
  if (!changwonRow && changwonPlt > 0) warnings.push('이고비_창원 단가 행을 찾지 못했습니다')

  const unknown = pallets.filter((g) => g.region === '기타')
  if (unknown.length > 0) {
    warnings.push(`권역 미판별 입고지: ${unknown.map((g) => g.dest).join(', ')} — 이고비 미반영`)
  }
  for (const g of pallets) {
    if (g.overSku) warnings.push(`${g.dest}: SKU ${g.skuCodes.length}종 — PLT당 최대 ${MAX_SKU_PER_PLT} 초과`)
  }

  const line = (label: string, unit: number, qty: number, note?: string): CostLine => ({
    label,
    unit,
    qty,
    amount: unit * qty,
    note,
  })

  const vehicle = line(
    veh?.gubun || '차량비',
    veh?.unitPrice ?? 0,
    totalPlt > 0 ? 1 : 0,
    veh ? `${veh.minPlt ?? 0}~${veh.maxPlt ?? '∞'} PLT · ${veh.vehicle}` : undefined,
  )
  const via = line(viaRow?.gubun || '경유비', viaRow?.unitPrice ?? 0, viaCount, '김포/창원 중 물량 있는 곳')
  const moveKimpo = line(kimpoRow?.gubun || '이고비_김포', kimpoRow?.unitPrice ?? 0, kimpoPlt, '김포행 PLT')
  const moveChangwon = line(
    changwonRow?.gubun || '이고비_창원',
    changwonRow?.unitPrice ?? 0,
    changwonPlt,
    '창원행 PLT',
  )

  return {
    totalPlt,
    vehicle,
    via,
    moveKimpo,
    moveChangwon,
    total: vehicle.amount + via.amount + moveKimpo.amount + moveChangwon.amount,
    warnings,
  }
}
