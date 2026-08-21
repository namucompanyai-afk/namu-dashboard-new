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
  boxQty: number // 박스입수
  coupangSkuId: string // 쿠팡 SKU ID
  coupangSupply: number // 쿠팡 공급가
  coupangDiscount: number // 쿠팡 할인 공급가
  kurlyMasterCode: string // 컬리 마스터 코드 ← 매칭 키
  kurlySupply: number // 컬리 공급가
  kurlyDiscount: number // 컬리 할인 공급가
  barcode: string // 바코드
}

const PRODUCT_COLS: Record<keyof ProductMaster, string[]> = {
  channel: ['채널'],
  alias: ['별칭'],
  name: ['상품명'],
  taxType: ['과세구분', '과세여부', '과세'],
  boxQty: ['박스입수'],
  coupangSkuId: ['쿠팡skuid', '쿠팡sku', 'skuid'],
  coupangSupply: ['쿠팡공급가'],
  coupangDiscount: ['쿠팡할인공급가'],
  kurlyMasterCode: ['컬리마스터코드', '마스터코드'],
  kurlySupply: ['컬리공급가'],
  kurlyDiscount: ['컬리할인공급가'],
  barcode: ['바코드'],
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
      boxQty: toNum(at(r, c.boxQty)),
      coupangSkuId: trim(at(r, c.coupangSkuId)),
      coupangSupply: toNum(at(r, c.coupangSupply)),
      coupangDiscount: toNum(at(r, c.coupangDiscount)),
      kurlyMasterCode: code,
      kurlySupply: toNum(at(r, c.kurlySupply)),
      kurlyDiscount: toNum(at(r, c.kurlyDiscount)),
      barcode: trim(at(r, c.barcode)),
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
  productCode: string // 발주상품코드
  status: string // 상태
  dueDate: string // 입고예정일
  masterCode: string // 마스터코드 ← 상품마스터 매칭 키
  productName: string // 상품명
  dest: string // 입고지 (= 최종 입고지, 팔레트 분리 기준)
  viaCenter: string // 경유센터
  shipMethod: string // 출고방법
  unitsPerBox: number // 박스당입수
  boxCount: number // 발주수량 = 박스 수
  totalUnits: number // 총 발주수량 = 낱개 수
  expiry: string // 소비기한(유통기한)
  // 발주 파일의 실제 금액(프로모션 할인 반영분) — 시트 공급가로 재계산하지 않는다
  supplyUnit: number // 공급단가
  supplyTotal: number // 공급가
}

export const ORDER_SHEET_NAME = '발주 내역'

const ORDER_COLS: Record<keyof KurlyOrderRow, string[]> = {
  productCode: ['발주상품코드'],
  status: ['상태'],
  dueDate: ['입고예정일'],
  masterCode: ['마스터코드'],
  productName: ['상품명'],
  dest: ['입고지'],
  viaCenter: ['경유센터'],
  shipMethod: ['출고방법'],
  unitsPerBox: ['박스당입수'],
  boxCount: ['발주수량'],
  totalUnits: ['총발주수량'],
  expiry: ['소비기한(유통기한)', '소비기한'],
  supplyUnit: ['공급단가'],
  supplyTotal: ['공급가'],
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
 * 발주수량 = 박스 수 / 총 발주수량 = 낱개 수 (혼동 금지).
 */
export function parseKurlyOrderRows(rows: unknown[][]): KurlyOrderRow[] {
  if (!rows.length) return []
  const c = resolveCols(rows[0], ORDER_COLS)
  if (c.dest < 0 || c.masterCode < 0) {
    throw new Error("'발주 내역' 헤더에서 입고지/마스터코드 컬럼을 찾지 못했습니다.")
  }
  const out: KurlyOrderRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const masterCode = trim(at(r, c.masterCode))
    const productName = trim(at(r, c.productName))
    const productCode = trim(at(r, c.productCode))
    if (!masterCode && !productName && !productCode) continue
    out.push({
      productCode,
      status: trim(at(r, c.status)),
      dueDate: fmtDate(at(r, c.dueDate)),
      masterCode,
      productName,
      dest: trim(at(r, c.dest)),
      viaCenter: trim(at(r, c.viaCenter)),
      shipMethod: trim(at(r, c.shipMethod)),
      unitsPerBox: toNum(at(r, c.unitsPerBox)),
      boxCount: toNum(at(r, c.boxCount)),
      totalUnits: toNum(at(r, c.totalUnits)),
      expiry: fmtDate(at(r, c.expiry)),
      supplyUnit: toNum(at(r, c.supplyUnit)),
      supplyTotal: toNum(at(r, c.supplyTotal)),
    })
  }
  return out
}

// ── 팔레트 산정 ──────────────────────────────────────────────────
export const MAX_SKU_PER_PLT = 3

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
  plt: number // 입고지당 1 PLT
  totalBoxes: number
  totalUnits: number
  overSku: boolean // SKU 3 초과 → 경고
}

/**
 * 최종 입고지(입고지 컬럼) 기준 팔레트 분리.
 * 경유센터가 같아도 최종 입고지가 다르면 별도 PLT.
 */
export function buildPallets(orders: KurlyOrderRow[]): PalletGroup[] {
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
  for (const g of list) g.overSku = g.skuCodes.length > MAX_SKU_PER_PLT
  return list
}

/**
 * 포털 파렛트수 입력값 — 같은 입고지 내 첫 발주 행만 1, 나머지 0.
 * 반환값은 orders 와 같은 길이/순서.
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
 */
export function calcTransportCost(
  pallets: PalletGroup[],
  prices: MilkrunPrice[],
): TransportCost {
  const warnings: string[] = []
  const totalPlt = pallets.reduce((s, g) => s + g.plt, 0)
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
