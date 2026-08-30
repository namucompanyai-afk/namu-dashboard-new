/**
 * B2B 발주 변환 — 쿠팡 도메인 로직 (순수 함수).
 *
 * 발주서리스트_*.xlsx 파싱 → 출고지 분기(진도팜/위킵/곰표) → 로켓 양식 행 + 매출 요약.
 * 시트 파싱 유틸(norm/toNum/fmtDate/resolveCols)과 ProductMaster 는 kurly 모듈을 재사용한다.
 * 컬리 쪽 파싱·팔레트·운송비 로직은 건드리지 않는다.
 */
import {
  fmtDate,
  norm,
  resolveCols,
  toNum,
  type ProductMaster,
} from './kurly'

// ── 쿠팡 발주서 파싱 ─────────────────────────────────────────────
/** 첫 셀이 이 문자열로 시작하면 쿠팡 발주서로 본다 */
export const COUPANG_FILE_MARK = '발주서 No.'

export type CoupangOrderItem = {
  poNumber: string // 발주번호
  center: string // 센터명
  dueDate: string // 입고예정일 YYYY-MM-DD
  productName: string // 상품명 (발주서 표기 그대로)
  orderQty: number // 발주수량 (G열) — 참고 필드
  confirmQty: number // 납품가능수량 (H열) ← 실제 출고·매출·박스·PLT·이력 기준 (불변)
  unitPrice: number // 매입가 (공급가 블록 첫 컬럼) ← 매출 단가. 빈값·0이면 '단가 미확인'
  qtyUnconfirmed: boolean // H가 0·빈값인데 G>0 → 납품가능 미확정(구버전 발주서 의심)
  displayQty: number // 화면 표시용 — 미확정이면 G, 아니면 H
  barcode: string // 상품마스터 매칭 키
  centerAddress: string // 발주서 '주소' 셀 (택배수령담당자 괄호부 제거)
  centerPhone: string // 주소 괄호부에서 분리한 택배수령담당자 번호
  sourceFile: string
}

const cellAt = (rows: unknown[][], r: number, c: number): unknown => rows[r]?.[c]
const textAt = (rows: unknown[][], r: number, c: number): string =>
  String(cellAt(rows, r, c) ?? '').trim()

/** 쿠팡이 붙이는 '(택배수령담당자 :+82…)' 괄호부를 떼어 주소/전화로 나눈다 */
export function splitCenterAddress(raw: string): { address: string; phone: string } {
  const src = String(raw ?? '').trim()
  const m = src.match(/\(\s*택배수령담당자\s*:?\s*([^)]*)\)/)
  return {
    address: src.replace(/\(\s*택배수령담당자\s*:?[^)]*\)/g, '').replace(/\s+/g, ' ').trim(),
    phone: (m?.[1] ?? '').trim(),
  }
}

export function isCoupangRows(rows: unknown[][]): boolean {
  return textAt(rows, 0, 0).startsWith(COUPANG_FILE_MARK)
}

/**
 * 발주서 1장 파싱.
 *
 * 셀 위치가 아니라 A열 마커를 찾아 상대 위치로 읽는다(양식이 위아래로 밀려도 견딤).
 *   A열 '발주번호'      → C열 = 발주번호
 *   A열 '입고예정일시'   → 다음 행 C열 = 센터명, F열 = 입고예정일
 *   A열 '3. 상품정보'    → +4행부터 상품 1개당 2행 (1행 C/G/H, 2행 C=바코드)
 * 상품 블록은 A열이 비거나 '합계' 또는 '4.' 로 시작하면 끝난다.
 *
 * 상품 표 헤더는 2단 병합이다 — 윗줄(+2행)에 '공급가/발주금액/입고금액' 그룹,
 * 아랫줄(+3행)에 그룹마다 '매입가/공급가액/부가세'. '매입가'가 세 번 나오므로
 * 반드시 '공급가' 그룹 시작 열부터 찾는다(실측 J열).
 */
/** 상품 표 '공급가 > 매입가' 열 (못 찾으면 실측 위치 J열) */
export const SUPPLY_PRICE_COL = 9

export function supplyPriceCol(rows: unknown[][], prodIdx: number): number {
  const group = rows[prodIdx + 2] || []
  const sub = rows[prodIdx + 3] || []
  const start = group.findIndex((v) => norm(v) === '공급가')
  if (start < 0) return SUPPLY_PRICE_COL
  for (let c = start; c < sub.length; c++) if (norm(sub[c]) === '매입가') return c
  return SUPPLY_PRICE_COL
}

export function parseCoupangRows(rows: unknown[][], sourceFile = ''): CoupangOrderItem[] {
  const A = (i: number) => textAt(rows, i, 0)
  const findRow = (pred: (s: string) => boolean) => rows.findIndex((_, i) => pred(A(i)))

  const poIdx = findRow((s) => norm(s) === '발주번호')
  const poNumber = poIdx >= 0 ? textAt(rows, poIdx, 2) : ''

  const dueIdx = findRow((s) => norm(s) === '입고예정일시')
  const center = dueIdx >= 0 ? textAt(rows, dueIdx + 1, 2) : ''
  const dueDate = dueIdx >= 0 ? fmtDate(cellAt(rows, dueIdx + 1, 5)) : ''
  // 주소·택배수령담당자는 마커 행의 라벨로 열을 찾는다(못 찾으면 실측 위치 D/I열)
  const labelCol = (label: string, fallback: number): number => {
    if (dueIdx < 0) return fallback
    const i = (rows[dueIdx] || []).findIndex((v) => norm(v) === norm(label))
    return i >= 0 ? i : fallback
  }
  const rawAddr = dueIdx >= 0 ? textAt(rows, dueIdx + 1, labelCol('주소', 3)) : ''
  const addr = splitCenterAddress(rawAddr)
  const centerAddress = addr.address
  const centerPhone =
    addr.phone || (dueIdx >= 0 ? textAt(rows, dueIdx + 1, labelCol('택배수령담당자', 8)) : '')

  const prodIdx = findRow((s) => norm(s).startsWith('3.상품정보'))
  if (prodIdx < 0) return []
  const priceCol = supplyPriceCol(rows, prodIdx)

  const items: CoupangOrderItem[] = []
  for (let r = prodIdx + 4; r < rows.length; r += 2) {
    const a = A(r)
    if (a === '' || norm(a) === '합계' || a.startsWith('4.')) break
    const productName = textAt(rows, r, 2)
    if (!productName) break
    const orderQty = toNum(cellAt(rows, r, 6))
    const confirmQty = toNum(cellAt(rows, r, 7))
    // 확정 전 발주서(또는 구버전 양식)는 H가 비어 내려온다 — 계산은 H 그대로 두고 표시만 G로 대체
    const qtyUnconfirmed = confirmQty <= 0 && orderQty > 0
    items.push({
      poNumber,
      center,
      dueDate,
      productName,
      orderQty,
      confirmQty,
      unitPrice: toNum(cellAt(rows, r, priceCol)),
      qtyUnconfirmed,
      displayQty: qtyUnconfirmed ? orderQty : confirmQty,
      barcode: textAt(rows, r + 1, 2),
      centerAddress,
      centerPhone,
      sourceFile,
    })
  }
  return items
}

/** 업로드 파일별 수량 합 — 구버전/미확정 발주서를 눈으로 잡기 위한 보조 정보 */
export type CoupangFileStat = {
  fileName: string
  rows: number
  orderQty: number // 발주수량 합 (G)
  confirmQty: number // 납품가능수량 합 (H)
  unconfirmed: number // 미확정 행 수
}

export function summarizeCoupangFiles(items: CoupangOrderItem[]): CoupangFileStat[] {
  const map = new Map<string, CoupangFileStat>()
  for (const it of items) {
    const fileName = it.sourceFile || '(파일명 없음)'
    let f = map.get(fileName)
    if (!f) {
      f = { fileName, rows: 0, orderQty: 0, confirmQty: 0, unconfirmed: 0 }
      map.set(fileName, f)
    }
    f.rows += 1
    f.orderQty += it.orderQty
    f.confirmQty += it.confirmQty
    if (it.qtyUnconfirmed) f.unconfirmed += 1
  }
  return [...map.values()]
}

// ── 쿠팡 센터 주소록 ─────────────────────────────────────────────
export type CenterAddress = {
  name: string // 물류센터명
  address: string // 택배 주소
  phone: string // 연락처(송장입력용)
}

const CENTER_COLS = {
  name: ['물류센터명', '센터명', '물류센터'],
  address: ['택배주소', '택배배송주소', '주소'],
  phone: ['연락처(송장입력용)', '송장입력용연락처', '연락처', '전화번호', '전화'],
}

/** 센터 주소록 rows(헤더 1행 포함) → CenterAddress[] */
export function parseCenters(rows: unknown[][]): CenterAddress[] {
  if (!rows.length) return []
  const c = resolveCols(rows[0], CENTER_COLS)
  const out: CenterAddress[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []
    const name = String((c.name >= 0 ? r[c.name] : '') ?? '').trim()
    if (!name || name.startsWith('※')) continue
    out.push({
      name,
      address: String((c.address >= 0 ? r[c.address] : '') ?? '').trim(),
      phone: String((c.phone >= 0 ? r[c.phone] : '') ?? '').trim(),
    })
  }
  return out
}

/** 센터명 → 주소. 정규화 완전일치 우선, 없으면 부분일치(표기 흔들림 흡수) */
export function findCenter(centers: CenterAddress[], name: string): CenterAddress | null {
  const k = norm(name)
  if (!k) return null
  return (
    centers.find((c) => norm(c.name) === k) ??
    centers.find((c) => norm(c.name) && (norm(c.name).includes(k) || k.includes(norm(c.name)))) ??
    null
  )
}

// ── 출고지 분기 ──────────────────────────────────────────────────
export type ShipFrom = '진도팜' | '위킵' | '곰표' | '미분류'

/** 바코드 → 상품마스터 (바코드 있는 행만) */
export function indexByBarcode(list: ProductMaster[]): Record<string, ProductMaster> {
  const m: Record<string, ProductMaster> = {}
  for (const p of list) {
    const k = norm(p.barcode)
    if (k && !m[k]) m[k] = p
  }
  return m
}

/** 출고지 판정 — 미등록·빈칸·그 외 값은 모두 미분류(경고 대상) */
export function shipFromOf(m: ProductMaster | undefined): ShipFrom {
  const v = norm(m?.shipFrom)
  if (v.includes('진도팜')) return '진도팜'
  if (v.includes('위킵')) return '위킵'
  if (v.includes('곰표')) return '곰표'
  return '미분류'
}

export type RoutedItem = CoupangOrderItem & {
  master: ProductMaster | undefined
  shipFrom: ShipFrom
  boxes: number | null // 올림(납품가능수량 ÷ 박스입수). 마스터 미등록이면 null
}

const boxesFor = (qty: number, boxQty: number): number | null =>
  boxQty > 0 ? Math.ceil(qty / boxQty) : null

/** 입고예정일 → 발주번호 순 정렬 (동률이면 원래 순서 유지) */
const byDueThenPo = (a: CoupangOrderItem, b: CoupangOrderItem): number =>
  a.dueDate === b.dueDate ? a.poNumber.localeCompare(b.poNumber) : a.dueDate.localeCompare(b.dueDate)

/** 상품 단위로 출고지 분기 — 같은 발주번호에 진도팜/위킵이 섞여도 각각 나뉜다 */
export function routeItems(
  items: CoupangOrderItem[],
  productByBarcode: Record<string, ProductMaster>,
): RoutedItem[] {
  return items
    .map((it) => {
      const master = productByBarcode[norm(it.barcode)]
      return {
        ...it,
        master,
        shipFrom: shipFromOf(master),
        boxes: master ? boxesFor(it.confirmQty, master.boxQty) : null,
      }
    })
    .sort(byDueThenPo)
}

// ── 팔레트/PLT 기준 (택배·트럭 분기 공통 소스) ──────────────────
export const PALLET_BOX_LIMIT = 9 // 초과 시 택배 불가 → 트럭(밀크런) 발송
export const BOXES_PER_PLT = 30 // 팔레트 1장 적재 박스 수

/** 발주 박스 수 → PLT (30박스/PLT 올림) */
export const pltOf = (boxes: number): number => Math.ceil(boxes / BOXES_PER_PLT)

// ── 곰표 출고 기준 ───────────────────────────────────────────────
/** 곰표는 봉 단위로 팔레트를 센다 — 1PLT = 400봉 = 40박스 */
export const GOMPYO_UNITS_PER_PLT = 400
export const GOMPYO_BOXES_PER_PLT = 40

/** 곰표 발주 봉 수 → PLT (400봉/PLT 올림) */
export const gompyoPltOf = (units: number): number =>
  Math.ceil(Math.max(0, units) / GOMPYO_UNITS_PER_PLT)

// ── 쿠팡 로켓 양식 (진도팜분) ────────────────────────────────────
/** 택배 발송분 컬럼 (기존 9개 그대로) */
export const ROCKET_HEADERS = [
  '받는분성명',
  '받는분전화번호',
  '받는분주소',
  '배송메세지1',
  '내품명',
  '내품수량',
  '박스 수',
  '제조일자',
  '송장',
] as const

/** 트럭 발송분 컬럼 — 송장 앞에 '파렛트 수' 추가 */
export const TRUCK_HEADERS = [
  '받는분성명',
  '받는분전화번호',
  '받는분주소',
  '배송메세지1',
  '내품명',
  '내품수량',
  '박스 수',
  '제조일자',
  '파렛트 수',
  '송장',
] as const

export type RocketMode = '택배' | '트럭'

/** 시트명 + 1행 안내 제목 */
export const ROCKET_SHEETS: Record<RocketMode, { sheetName: string; title: string }> = {
  택배: { sheetName: '택배 발송분', title: '■ 택배 발송분 — 박스별 택배 발송' },
  트럭: { sheetName: '트럭 발송분(밀크런)', title: '■ 트럭 발송분 — 밀크런 트럭, 팔레트 적재' },
}

export type RocketRow = {
  mode: RocketMode // 택배(9박스 이하) / 트럭(9박스 초과)
  recipient: string // 받는분성명 = 센터명
  phone: string
  address: string
  memo: string // 배송메세지1 (공란)
  itemName: string // 내품명 = 발주서 상품명
  itemQty: number // 내품수량 = 납품가능수량
  boxes: number | null // 박스 수
  madeDate: string // 제조일자
  pallet: number | null // 파렛트 수 — 트럭분 발주 첫 행에만 기입, 나머지는 null
  invoice: string // 송장 (공란)
  centerKnown: boolean // 주소를 못 구하면 false → 행 강조
  masterKnown: boolean // 상품마스터 미등록이면 false → 박스 수 공란
  qtyUnconfirmed: boolean // 납품가능 미확정 → 표에 경고 (양식 값은 H 그대로)
  orderQty: number // 미확정 행 경고에 함께 띄우는 발주수량
  poNumber: string
  dueDate: string
}

/** 발주번호 → 박스 합계 (마스터 미등록 행은 0으로 본다) */
const boxesByPo = (items: RoutedItem[]): Record<string, number> => {
  const m: Record<string, number> = {}
  for (const it of items) m[it.poNumber] = (m[it.poNumber] ?? 0) + (it.boxes ?? 0)
  return m
}

/**
 * 진도팜분 → 로켓 양식 행 (정렬은 routeItems 에서 이미 적용된 순서 유지).
 *
 * 발주 단위 박스 합계가 9박스 이하면 택배분, 초과면 트럭분(밀크런)으로 나눈다.
 *   택배분 — 주소·전화는 기존 센터 주소록 lookup
 *   트럭분 — 주소는 발주서가 자동 출력한 값, 전화는 그 주소 괄호부의 택배수령담당자
 *            (발주서 값이 비면 주소록으로 대체)
 * 파렛트 수는 발주 단위 1회(첫 행)만 기입한다.
 */
export function buildRocketRows(
  items: RoutedItem[],
  centers: CenterAddress[],
  madeDate: string,
): RocketRow[] {
  const poBoxes = boxesByPo(items)
  const palletDone = new Set<string>()
  return items.map((it) => {
    const c = findCenter(centers, it.center)
    const truck = (poBoxes[it.poNumber] ?? 0) > PALLET_BOX_LIMIT
    const address = truck ? it.centerAddress || c?.address || '' : c?.address || ''
    const phone = truck ? it.centerPhone || c?.phone || '' : c?.phone || ''
    let pallet: number | null = null
    if (truck && !palletDone.has(it.poNumber)) {
      palletDone.add(it.poNumber)
      pallet = pltOf(poBoxes[it.poNumber] ?? 0)
    }
    return {
      mode: (truck ? '트럭' : '택배') as RocketMode,
      recipient: it.center,
      phone,
      address,
      memo: '',
      itemName: it.productName,
      itemQty: it.confirmQty,
      boxes: it.boxes,
      madeDate,
      pallet,
      invoice: '',
      centerKnown: !!address,
      masterKnown: !!it.master,
      qtyUnconfirmed: it.qtyUnconfirmed,
      orderQty: it.orderQty,
      poNumber: it.poNumber,
      dueDate: it.dueDate,
    }
  })
}

/** 택배분/트럭분 분리 (순서 유지) */
export function splitRocketRows(rows: RocketRow[]): { parcel: RocketRow[]; truck: RocketRow[] } {
  return {
    parcel: rows.filter((r) => r.mode === '택배'),
    truck: rows.filter((r) => r.mode === '트럭'),
  }
}

/** 안내 제목 1행 + 헤더 + 데이터 (xlsx 소스) */
export function rocketAoa(rows: RocketRow[], mode: RocketMode): (string | number)[][] {
  const truck = mode === '트럭'
  const headers = truck ? TRUCK_HEADERS : ROCKET_HEADERS
  return [
    [ROCKET_SHEETS[mode].title],
    [...headers],
    ...rows.map((r) => {
      const base: (string | number)[] = [
        r.recipient,
        r.phone,
        r.address,
        r.memo,
        r.itemName,
        r.itemQty,
        r.boxes ?? '',
        r.madeDate,
      ]
      return truck ? [...base, r.pallet ?? '', r.invoice] : [...base, r.invoice]
    }),
  ]
}

/** coupang_rocket_{YYYYMMDD}.xlsx */
export function rocketFileName(madeDate: string): string {
  const ymd = String(madeDate || '').replace(/[^0-9]/g, '').slice(0, 8)
  return `coupang_rocket_${ymd || 'nodate'}.xlsx`
}

/** 오늘(KST) YYYY-MM-DD */
export function todayKst(): string {
  const now = new Date()
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

// ── 매출 요약 ────────────────────────────────────────────────────
/** 과세면 ×1.1 원 단위 반올림, 면세는 그대로 */
export const withVat = (amount: number, taxable: boolean): number =>
  taxable ? Math.round(amount * 1.1) : amount

export type CoupangSummaryRow = {
  barcode: string
  name: string // 상품마스터 별칭(없으면 발주서 상품명)
  qty: number // 납품가능수량 합
  unitPrices: number[] // 발주서 매입가 — 발주마다 다르면 여러 개 (VAT 별도)
  unitPricesIncl: number[] // 부가포함 단가 (과세면 ×1.1)
  total: number // VAT 별도
  totalIncl: number // 부가포함
  taxType: string
  taxable: boolean
  taxKnown: boolean
  masterKnown: boolean
  priceKnown: boolean // 매입가가 빈값·0인 행이 있으면 false → '단가 미확인'
}

export type CoupangSummary = {
  rows: CoupangSummaryRow[]
  totalQty: number
  total: number
  totalIncl: number
}

/**
 * 상품별 매출 요약. 단가는 **발주서 매입가**를 쓴다 — 같은 상품이라도 발주서마다
 * 단가가 다를 수 있으므로 행별로 그 발주서 값을 곱해 합산한다(시트 쿠팡 공급가는
 * 매출 경로에서 쓰지 않는다). 과세 구분만 시트 상품마스터에서 가져온다.
 * 부가세는 상품별 합계에 한 번만 적용해 행별 반올림 누적 오차를 피한다.
 */
export function summarizeCoupang(items: RoutedItem[]): CoupangSummary {
  const byKey = new Map<string, CoupangSummaryRow>()
  for (const it of items) {
    const key = norm(it.barcode) || norm(it.productName)
    let r = byKey.get(key)
    if (!r) {
      const taxType = it.master?.taxType || ''
      r = {
        barcode: it.barcode,
        name: it.master?.alias || it.productName,
        qty: 0,
        unitPrices: [],
        unitPricesIncl: [],
        total: 0,
        totalIncl: 0,
        taxType,
        taxable: taxType.includes('과세'),
        taxKnown: taxType !== '',
        masterKnown: !!it.master,
        priceKnown: true,
      }
      byKey.set(key, r)
    }
    r.qty += it.confirmQty
    r.total += it.confirmQty * it.unitPrice
    if (it.unitPrice > 0) {
      if (!r.unitPrices.includes(it.unitPrice)) r.unitPrices.push(it.unitPrice)
    } else {
      r.priceKnown = false
    }
  }

  const rows = [...byKey.values()]
  for (const r of rows) {
    r.unitPrices.sort((a, b) => a - b)
    r.totalIncl = withVat(r.total, r.taxable)
    r.unitPricesIncl = r.unitPrices.map((p) => withVat(p, r.taxable))
  }
  return {
    rows,
    totalQty: rows.reduce((s, r) => s + r.qty, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
    totalIncl: rows.reduce((s, r) => s + r.totalIncl, 0),
  }
}
