/**
 * 킴스클럽(이랜드) 금요일 발주 서류 만들기 — 순수 함수.
 *
 * 입력
 *   por   : 이랜드 정보서비스 '구매오더조회' 엑셀 내보내기(PORInfo.xlsx) 의 행 (헤더 포함 2차원 배열)
 *   alloc : 점별 할당 내보내기(CSV_OUTPUT.XLS — 탭으로 나뉜 글자) 의 본문
 *   stores: 인수인계 시트 '킴스 점포별 주소 및 연락처' 탭의 행
 * 출력
 *   Plan: 점포 × 상품 수량표 + 진도팜 택배 행 + 문구 3종 + '확인 필요' 목록.
 *
 * 원칙: 숫자는 이랜드 파일을 그대로 옮긴다(계산·보정 없음). 날짜·필수 열을 못 읽으면 조용히 넘어가지 않고 중단한다. 모르는 것(처음 보는 상품·점포·주소 없음 등)은 빈칸으로 두지 않고
 *       issues 에 '확인 필요'로 적는다. 손익 숫자는 어디에도 넣지 않는다(단가는 MD용 엑셀에만 이랜드 값 그대로).
 */

export type PorRow = {
  doc: string // 구매문서
  item: string // 품목번호
  storeCode: string // 점포코드 (이랜드팜앤푸드 1902 등 — 납품 점포가 아니라 구매 주체)
  code: string // 상품코드 (바코드)
  name: string
  orderDate: string // YYYYMMDD
  dueDate: string // 납품요청일 YYYYMMDD
  qty: number
  perBox: number
  boxes: number
  price: number
  raw: Record<string, string> // 이랜드 PORInfo 한 줄 원본(열 이름 → 값). MD용 '기존 구매오더(원본)' 탭에 그대로 옮긴다 — 계산·보정 금지
}
export type AllocRow = {
  doc: string
  seq: string
  storeCode: string // 발주점포
  storeName: string // 발주점포명 (분당점)
  code: string
  name: string
  orderDate: string
  dueDate: string
  qty: number
  perBox: number
  boxes: number
}
export type StoreInfo = { code: string; name: string; recipient: string; title: string; phone: string; address: string; staffCount: number }
export type NameEntry = { short: string; md?: string } // short = "[보배마을] 흑미" 의 '흑미' 부분

export type Issue = { level: 'check' | 'info'; text: string }
export type StoreLine = { code: string; barcode: string; name: string; qty: number; boxes: number }
export type StorePlan = { storeCode: string; storeName: string; info: StoreInfo | null; lines: StoreLine[]; boxes: number }
export type Plan = {
  dueDate: string // 납품일 (YYYYMMDD) — 여러 개면 가장 이른 날
  dueDates: string[]
  shipDate: string // 출고(택배 발송) 월요일 = 납품일 - 1일
  docs: string[]
  stores: StorePlan[]
  products: { barcode: string; name: string; qty: number; boxes: number; price: number }[]
  issues: Issue[]
}

const str = (v: unknown) => (v == null ? '' : String(v).trim())
const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}
const ymd = (v: unknown) => {
  const s = str(v).replace(/-/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

export const POR_COLUMNS = ['구매문서', '품목번호', '점포코드', '점포명', '업체코드', '업체명', '상품코드', '상품명', '구매오더일', '납품요청일', '오더수량', '단위', '입수', 'BOX', '단가', '금액', '세금']
export const ALLOC_COLUMNS = ['할당번호', '구매오더', '순번', '발주점포', '발주점포명', '상품코드', '상품명', '발주일자', '납품일자', '단위', '입수', '발주수량', 'BOX수량']
const missingCols = (header: string[], need: string[]) => need.filter((c) => !header.includes(c))

export function parsePor(rows: unknown[][]): PorRow[] {
  const h = rows[0]?.map(str) ?? []
  const miss = missingCols(h, POR_COLUMNS)
  if (miss.length) throw new Error(`PORInfo 필수 열이 없음: ${miss.join(', ')} — 이랜드 내보내기 형식이 바뀐 듯`)
  const col = (n: string) => h.indexOf(n)
  const c = { doc: col('구매문서'), item: col('품목번호'), store: col('점포코드'), code: col('상품코드'), name: col('상품명'), od: col('구매오더일'), due: col('납품요청일'), qty: col('오더수량'), per: col('입수'), box: col('BOX'), price: col('단가') }
  return rows
    .slice(1)
    .filter((r) => str(r[c.code]))
    .map((r, i) => {
      const dueDate = ymd(r[c.due])
      if (!dueDate) throw new Error(`PORInfo ${i + 2}행 납품요청일을 못 읽음("${str(r[c.due])}") — 형식이 YYYYMMDD 가 아님`)
      const raw: Record<string, string> = {}
      h.forEach((name, j) => { if (name) raw[name] = str(r[j]) })
      return { doc: str(r[c.doc]), item: str(r[c.item]), storeCode: str(r[c.store]), code: str(r[c.code]), name: str(r[c.name]), orderDate: ymd(r[c.od]), dueDate, qty: num(r[c.qty]), perBox: num(r[c.per]), boxes: num(r[c.box]), price: num(r[c.price]), raw }
    })
}

/** CSV_OUTPUT.XLS — 탭 구분. 인코딩이 cp949 일 수 있어 호출측이 디코드해서 넘긴다 */
export function parseAlloc(text: string): AllocRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const h = lines[0].split('\t').map(str)
  const miss = missingCols(h, ALLOC_COLUMNS)
  if (miss.length) throw new Error(`점별 할당 파일 필수 열이 없음: ${miss.join(', ')} — 이랜드 내보내기 형식이 바뀐 듯`)
  const col = (n: string) => h.indexOf(n)
  const c = { doc: col('할당번호'), po: col('구매오더'), seq: col('순번'), sc: col('발주점포'), sn: col('발주점포명'), code: col('상품코드'), name: col('상품명'), od: col('발주일자'), due: col('납품일자'), qty: col('발주수량'), per: col('입수'), box: col('BOX수량') }
  return lines
    .slice(1)
    .map((l) => l.split('\t'))
    .filter((r) => str(r[c.code]))
    .map((r, i) => {
      const dueDate = ymd(r[c.due])
      if (!dueDate) throw new Error(`점별 할당 ${i + 2}행 납품일자를 못 읽음("${str(r[c.due])}")`)
      return { doc: str(r[c.po]) || str(r[c.doc]), seq: str(r[c.seq]), storeCode: str(r[c.sc]), storeName: str(r[c.sn]), code: str(r[c.code]), name: str(r[c.name]), orderDate: ymd(r[c.od]), dueDate, qty: num(r[c.qty]), perBox: num(r[c.per]), boxes: num(r[c.box]) }
    })
}

/** 인수인계 시트 탭 → 지점코드별 수령 정보. 한 점포에 담당자가 여러 줄이면 '팀장' 우선, 없으면 첫 사람 */
export function parseStoreSheet(rows: unknown[][]): Map<string, StoreInfo> {
  const out = new Map<string, StoreInfo>()
  let cur: { code: string; name: string; address: string; staff: { name: string; title: string; role: string; phone: string }[] } | null = null
  const flush = () => {
    if (!cur) return
    const pick = cur.staff.find((s) => /팀장/.test(s.role) || /팀장/.test(s.title)) ?? cur.staff[0]
    out.set(cur.code, {
      code: cur.code,
      name: cur.name,
      recipient: pick?.name ?? '',
      title: pick ? (/팀장/.test(pick.role) ? '팀장' : pick.role && pick.role !== '담당' ? pick.role : '') : '',
      phone: pick?.phone ?? '',
      address: cur.address,
      staffCount: cur.staff.length,
    })
  }
  for (const r of rows) {
    const code = str(r[0])
    if (/^\d{4}$/.test(code)) {
      flush()
      cur = { code, name: str(r[1]), address: str(r[10]), staff: [] }
    }
    if (cur && str(r[5])) cur.staff.push({ name: str(r[5]), title: str(r[6]), role: str(r[7]), phone: str(r[8]) })
  }
  flush()
  return out
}

/** 이랜드 상품명 → 진도팜 내품명 용 짧은 이름. "유기농 흑미 1kg" → "흑미" . 규칙에 안 맞고 표에도 없으면 null (확인 필요) */
export function shortName(name: string, table: Record<string, NameEntry>, barcode: string): string | null {
  const t = table[barcode.trim()]
  if (t) return t.short
  const m = /^유기농\s+(.+?)\s+1kg$/.exec(name.trim())
  return m ? m[1] : null
}
/** 문구용 이름 — "유기농 " 만 뺌 ("흑미 1kg") */
export const messageName = (name: string) => name.trim().replace(/^유기농\)?\s*/, '')

export const addDays = (yyyymmdd: string, n: number) => {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)))
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토']
export const weekdayKo = (yyyymmdd: string) => WEEKDAY[new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8))).getUTCDay()]
export const mdLabel = (yyyymmdd: string) => `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`
export const mmdd = (yyyymmdd: string) => yyyymmdd.slice(4, 8)

export function buildPlan(o: { por: PorRow[]; alloc: AllocRow[]; stores: Map<string, StoreInfo>; names: Record<string, NameEntry> }): Plan {
  const { por, alloc, stores, names } = o
  const issues: Issue[] = []
  if (!por.length) throw new Error('구매오더 0건')
  if (!alloc.length) issues.push({ level: 'check', text: '점별 할당 파일이 비어 있음 — 점포별 수량을 못 나눔' })

  const dueDates = [...new Set(alloc.map((a) => a.dueDate).concat(por.map((p) => p.dueDate)).filter(Boolean))].sort()
  const dueDate = dueDates[0] ?? ''
  if (!/^\d{8}$/.test(dueDate)) throw new Error('납품일을 못 읽음 — 서류 만들기를 중단함(날짜가 틀린 서류가 나가면 안 됨)')
  if (dueDates.length > 1) issues.push({ level: 'check', text: `납품일이 여러 개(${dueDates.map(mdLabel).join(', ')}) — 가장 이른 날(${mdLabel(dueDate)}) 기준으로 만듦` })
  const shipDate = dueDate ? addDays(dueDate, -1) : ''
  if (dueDate && weekdayKo(dueDate) !== '화') issues.push({ level: 'check', text: `납품일 ${mdLabel(dueDate)}(${weekdayKo(dueDate)})가 화요일이 아님 — 출고일을 납품일 하루 전(${mdLabel(shipDate)} ${weekdayKo(shipDate)})로 잡았음, 맞는지 확인` })

  // 구매오더 ↔ 할당 합계 대조 (상품코드별)
  const porQty = new Map<string, number>()
  for (const p of por) porQty.set(p.code, (porQty.get(p.code) ?? 0) + p.qty)
  const allocQty = new Map<string, number>()
  for (const a of alloc) allocQty.set(a.code, (allocQty.get(a.code) ?? 0) + a.qty)
  for (const [code, q] of porQty) {
    const aq = allocQty.get(code) ?? 0
    if (aq !== q) issues.push({ level: 'check', text: `수량이 안 맞음 — ${por.find((p) => p.code === code)?.name ?? code}: 구매오더 ${q} / 점별 할당 합 ${aq}` })
  }
  for (const code of allocQty.keys()) if (!porQty.has(code)) issues.push({ level: 'check', text: `점별 할당에는 있는데 구매오더에 없는 상품: ${alloc.find((a) => a.code === code)?.name ?? code}` })
  // PO 번호 대조: 점별 할당의 구매오더 번호가 구매오더 파일에 없으면 다른 주 파일이 섞인 것
  const porDocs = new Set(por.map((p) => p.doc))
  for (const d of new Set(alloc.map((a) => a.doc))) if (d && !porDocs.has(d)) issues.push({ level: 'check', text: `점별 할당의 구매오더 번호 ${d}가 구매오더 파일에 없음 — 다른 주 파일이 섞였을 수 있음` })
  // 이랜드 파일 안에서 오더수량 ≠ 입수×BOX 면 문구·종합표의 박스 수가 틀릴 수 있음
  for (const p of por) {
    if (p.qty > 0 && (p.perBox <= 0 || p.boxes <= 0)) issues.push({ level: 'check', text: `구매오더 ${p.name}: 오더수량 ${p.qty}인데 입수(${p.perBox || '빈칸'}) 또는 BOX(${p.boxes || '빈칸'})가 비어 있음 — 박스 수를 못 믿음` })
    else if (p.qty !== p.perBox * p.boxes) issues.push({ level: 'check', text: `구매오더 ${p.name}: 오더수량 ${p.qty} ≠ 입수 ${p.perBox} × BOX ${p.boxes} — 박스 수 확인` })
  }
  for (const a of alloc) if (a.qty > 0 && (a.perBox <= 0 || a.boxes <= 0) && !issues.some((i) => i.text.includes(`할당 ${a.storeName} ${messageName(a.name)}: 입수`))) issues.push({ level: 'check', text: `할당 ${a.storeName} ${messageName(a.name)}: 입수·BOX 칸이 비어 있음(수량 ${a.qty}) — 박스 수를 못 믿음` })
  const porDue = new Set(por.map((p) => p.dueDate))
  for (const a of alloc) if (porDue.size && a.dueDate && !porDue.has(a.dueDate)) { issues.push({ level: 'check', text: `점별 할당 납품일(${mdLabel(a.dueDate)})이 구매오더 납품요청일과 다름` }); break }

  // 점포별
  const byStore = new Map<string, StorePlan>()
  for (const a of alloc) {
    let sp = byStore.get(a.storeCode)
    if (!sp) {
      const info = stores.get(a.storeCode) ?? null
      sp = { storeCode: a.storeCode, storeName: a.storeName, info, lines: [], boxes: 0 }
      byStore.set(a.storeCode, sp)
      if (!info) issues.push({ level: 'check', text: `주소 시트에 없는 점포: ${a.storeName}(${a.storeCode}) — 받는분·주소 확인 필요` })
      else {
        if (!info.address) issues.push({ level: 'check', text: `${a.storeName} 주소가 시트에 비어 있음` })
        if (!info.recipient || !info.phone) issues.push({ level: 'check', text: `${a.storeName} 받는분/전화가 시트에 비어 있음` })
      }
    }
    const boxes = a.boxes || (a.perBox ? Math.ceil(a.qty / a.perBox) : 0)
    if (a.perBox && a.qty % a.perBox !== 0) issues.push({ level: 'check', text: `${a.storeName} ${messageName(a.name)}: 수량 ${a.qty}이 입수 ${a.perBox}의 배수가 아님 — 박스 수 확인` })
    sp.lines.push({ code: a.code, barcode: a.code, name: a.name, qty: a.qty, boxes })
    sp.boxes += boxes
    const known13 = [...SUMMARY_BLOCK1, ...SUMMARY_BLOCK2].some((t) => t.barcode === a.code.trim()) || !!names[a.code.trim()]
    if (!known13 && !issues.some((i) => i.text.includes(`처음 보는 상품: ${a.name}`))) {
      const ruleOk = shortName(a.name, names, a.code) !== null
      issues.push({ level: 'check', text: `처음 보는 상품: ${a.name} (${a.code}) — 기존 13종에 없음${ruleOk ? '(내품명은 "유기농 ○○ 1kg" 규칙으로 만들었음, 맞는지 확인)' : ' — 진도팜 내품명 규칙에도 안 맞음'}. 확정되면 scripts/kims-friday/product-names.json 에 추가` })
    } else if (shortName(a.name, names, a.code) === null && !issues.some((i) => i.text.includes(`처음 보는 상품: ${a.name}`))) {
      issues.push({ level: 'check', text: `처음 보는 상품: ${a.name} (${a.code}) — 진도팜 내품명 규칙에 안 맞음. scripts/kims-friday/product-names.json 에 추가 필요` })
    }
  }

  const products = [...porQty.keys()].map((code) => {
    const rows = por.filter((p) => p.code === code)
    return { barcode: code, name: rows[0].name, qty: rows.reduce((s, r) => s + r.qty, 0), boxes: rows.reduce((s, r) => s + r.boxes, 0), price: rows[0].price }
  })
  return { dueDate, dueDates, shipDate, docs: [...new Set(por.map((p) => p.doc))], stores: [...byStore.values()], products, issues }
}

// ── 발주 종합 탭 (kims_order_summary 의 주차 탭 양식) + 수량 표 PNG ───────────────────────
//   양식: B 바코드 · C 상품명 · D 오더수량(=입수×BOX) · E BOX · F 점포명(그 상품이 나간 점포). 1번 블록 입수 18(곡물 11종) · 2번 블록 입수 12(강황·즉석밥).
//   주차 탭 이름은 납품일 MMDD (예: 1027). 이랜드 파일에 없는 상품은 BOX 비움(양식 행 유지), 양식에 없는 상품은 맨 아래에 "확인 필요"로 붙인다.
export const SUMMARY_BLOCK1: { barcode: string; name: string }[] = [
  { barcode: '8800295820244', name: '유기농 귀리 1kg' },
  { barcode: '8800295820848', name: '유기농 흑보리 1kg' },
  { barcode: '8800295820855', name: '유기농 오색현미 1kg' },
  { barcode: '8800295820527', name: '유기농 홍미 1kg' },
  { barcode: '8800295820381', name: '유기농 녹미 1kg' },
  { barcode: '8800295820480', name: '유기농 찹쌀 1kg' },
  { barcode: '8800295820862', name: '유기농 흑미 1kg' },
  { barcode: '8800295820893', name: '유기농 귀리10곡 1kg' },
  { barcode: '8800295820916', name: '유기농 찰보리 1kg' },
  { barcode: '8800295820886', name: '유기농 찰현미 1kg' },
  { barcode: '8800295820879', name: '유기농 어린이혼합곡 1kg' },
]
export const SUMMARY_BLOCK2: { barcode: string; name: string }[] = [
  { barcode: '8800295820947', name: '유기농 강황가루 100g' },
  { barcode: '8800295820770', name: '즉석밥 180g' },
]
export type SummaryLine = { barcode: string; name: string; qty: number; boxes: number; stores: string[]; block: 1 | 2 | 3 }
export function summaryLines(plan: Plan): { lines: SummaryLine[]; issues: string[] } {
  const issues: string[] = []
  const byCode = new Map(plan.products.map((p) => [p.barcode.trim(), p]))
  const storesBy = new Map<string, Set<string>>()
  for (const sp of plan.stores) for (const l of sp.lines) (storesBy.get(l.barcode.trim()) ?? storesBy.set(l.barcode.trim(), new Set()).get(l.barcode.trim())!).add(sp.storeName)
  const mk = (t: { barcode: string; name: string }, block: 1 | 2): SummaryLine => {
    const p = byCode.get(t.barcode)
    return { barcode: t.barcode, name: p?.name ?? t.name, qty: p?.qty ?? 0, boxes: p?.boxes ?? 0, stores: [...(storesBy.get(t.barcode) ?? [])], block }
  }
  const lines = [...SUMMARY_BLOCK1.map((t) => mk(t, 1)), ...SUMMARY_BLOCK2.map((t) => mk(t, 2))]
  const known = new Set(lines.map((l) => l.barcode))
  for (const p of plan.products) {
    if (known.has(p.barcode.trim())) continue
    issues.push(`발주 종합 양식에 없는 상품: ${p.name} (${p.barcode}) — 맨 아래 "확인 필요" 행으로 붙임`)
    lines.push({ barcode: p.barcode.trim(), name: `확인 필요: ${p.name}`, qty: p.qty, boxes: p.boxes, stores: [...(storesBy.get(p.barcode.trim()) ?? [])], block: 3 })
  }
  return { lines, issues }
}

/** 발주 종합 탭 2차원 배열 — 열 B부터(A는 비움). D 는 =입수×BOX 수식(양식 그대로), 값도 함께 반환 */
export function summarySheetAoa(plan: Plan): { aoa: (string | number | { f: string; v: number } | null)[][]; issues: string[] } {
  const { lines, issues } = summaryLines(plan)
  const aoa: (string | number | { f: string; v: number } | null)[][] = []
  const blank = (): (string | number | null)[] => [null, null, null, null, null, null, null, null, null, null]
  const r1 = blank(); r1[9] = 18; aoa.push(r1)
  aoa.push([null, '바코드', '상품명 ', '오더수량', 'BOX', '점포명'])
  const b1 = lines.filter((l) => l.block === 1)
  b1.forEach((l, i) => aoa.push([null, Number(l.barcode), l.name, { f: `$J$1*E${i + 3}`, v: l.boxes * 18 }, l.boxes || null, l.stores.join(', ') || null]))
  const sumRow1 = aoa.length + 1
  aoa.push([null, null, '합계', { f: `SUM(D3:D${sumRow1 - 1})`, v: b1.reduce((s, l) => s + l.boxes * 18, 0) }, { f: `SUM(E3:E${sumRow1 - 1})`, v: b1.reduce((s, l) => s + l.boxes, 0) }])
  aoa.push([])
  const hdr2 = aoa.length + 1
  const r2 = blank(); r2[1] = null; r2[2] = '상품명 '; r2[3] = '오더수량'; r2[4] = 'BOX'; r2[9] = 12
  aoa.push(r2)
  const b2 = lines.filter((l) => l.block === 2)
  b2.forEach((l, i) => aoa.push([null, Number(l.barcode), l.name, { f: `$J$${hdr2}*E${hdr2 + 1 + i}`, v: l.boxes * 12 }, l.boxes || null, l.stores.join(', ') || null]))
  aoa.push([null, null, '합계', { f: `SUM(D${hdr2 + 1}:D${hdr2 + b2.length})`, v: b2.reduce((s, l) => s + l.boxes * 12, 0) }, { f: `SUM(E${hdr2 + 1}:E${hdr2 + b2.length})`, v: b2.reduce((s, l) => s + l.boxes, 0) }])
  const b3 = lines.filter((l) => l.block === 3)
  if (b3.length) {
    aoa.push([])
    for (const l of b3) aoa.push([null, Number.isFinite(Number(l.barcode)) ? Number(l.barcode) : l.barcode, l.name, l.qty, l.boxes, l.stores.join(', ') || null])
  }
  // 수량 불일치 점검(입수 곱 ≠ 이랜드 오더수량)
  for (const l of lines) {
    const per = l.block === 1 ? 18 : l.block === 2 ? 12 : 0
    if (per && l.boxes && l.qty !== l.boxes * per) issues.push(`${l.name}: 이랜드 오더수량 ${l.qty}이 입수 ${per}×BOX ${l.boxes}와 다름 — 종합표 오더수량은 양식 수식(입수×BOX)이라 이랜드 값과 다를 수 있음`)
  }
  return { aoa, issues }
}

// ── 수량 표 PNG (상품명 · 오더수량 · BOX · 합계) — SVG 문자열, PNG 변환은 호출측(sharp) ─────
const xmlEsc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export function qtyTableSvg(plan: Plan): string {
  const rows = plan.products.filter((p) => p.qty > 0)
  const W = [380, 170, 140]
  const H = 62
  const totalW = W[0] + W[1] + W[2]
  const n = rows.length + 2
  const totalH = H * n + 2
  const font = `font-family="Apple SD Gothic Neo, AppleGothic, Noto Sans CJK KR, sans-serif" font-size="30"`
  let y = 1
  let g = ''
  const cell = (x: number, w: number, yy: number, text: string, fill = 'none') => `<rect x="${x}" y="${yy}" width="${w}" height="${H}" fill="${fill}" stroke="#000" stroke-width="2"/><text x="${x + w / 2}" y="${yy + H / 2 + 11}" text-anchor="middle" ${font}>${xmlEsc(text)}</text>`
  g += cell(1, W[0], y, '상품명') + cell(1 + W[0], W[1], y, '오더수량') + cell(1 + W[0] + W[1], W[2], y, 'BOX')
  y += H
  for (const p of rows) {
    g += cell(1, W[0], y, messageName(p.name).replace(/^/, '유기농 ').replace('유기농 유기농', '유기농')) + cell(1 + W[0], W[1], y, String(p.qty)) + cell(1 + W[0] + W[1], W[2], y, String(p.boxes))
    y += H
  }
  const tq = rows.reduce((s, p) => s + p.qty, 0)
  const tb = rows.reduce((s, p) => s + p.boxes, 0)
  g += cell(1, W[0], y, '합계', '#d9d9d9') + cell(1 + W[0], W[1], y, String(tq), '#d9d9d9') + cell(1 + W[0] + W[1], W[2], y, String(tb), '#d9d9d9')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW + 2}" height="${totalH}" viewBox="0 0 ${totalW + 2} ${totalH}"><rect width="100%" height="100%" fill="#fff"/>${g}</svg>`
}

// ── 진도팜 택배 행 (통합형 xlsx) ─────────────────────────────────
export const JINDOFARM_HEADER = ['받는분성명', '받는분전화번호', '받는분주소(전체, 분할)', '배송메세지1', '내품명', '내품수량', '농업회사법인 나무컴퍼니 주식회사']
export function jindofarmRows(plan: Plan, names: Record<string, NameEntry>): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const s of plan.stores) {
    const who = s.info && s.info.recipient ? `${s.info.recipient}${s.info.title}님` : '확인 필요'
    for (const l of s.lines) {
      const sn = shortName(l.name, names, l.barcode)
      rows.push([who, s.info?.phone || '확인 필요', s.info?.address || '확인 필요', '', sn ? `[보배마을] ${sn}` : `확인 필요: ${l.name}`, l.qty])
    }
  }
  return rows
}

// ── 문구 3종 ────────────────────────────────────────────────────
export function messageFridayJindofarm(plan: Plan): string {
  const L: string[] = ['킴스 수량 공유드립니다.', `납품 ${mdLabel(plan.dueDate)}(${weekdayKo(plan.dueDate)}) / 택배 출고 ${mdLabel(plan.shipDate)}(${weekdayKo(plan.shipDate)})`, '']
  let totalBox = 0
  for (const p of plan.products) {
    L.push(`${messageName(p.name)} ${p.qty}개 (${p.boxes}박스)`)
    totalBox += p.boxes
  }
  L.push('', `총 ${totalBox}박스`, '파일들은 월요일에 공유드리겠습니다.')
  return L.join('\n')
}
export function messageMondayJindofarm(plan: Plan): string {
  const L: string[] = [`킴스 ${mdLabel(plan.dueDate)}(${weekdayKo(plan.dueDate)}) 납품분 파일 공유드립니다.`]
  for (const s of plan.stores) {
    L.push(`${s.storeName}: ${s.lines.map((l) => `${messageName(l.name)} ${l.qty}개`).join(', ')} (총 ${s.boxes}박스)`)
  }
  L.push('박스에 서류 동봉하여 택배 발송해 주시고 겉박스에도 라벨 부착 부탁드립니다. 라벨에는 품종도 같이 적어주세요.', '부자재 재고 확인부탁드려요 @윤형')
  return L.join('\n')
}
export function messageMd(plan: Plan, fileName: string): string {
  return [`민경찬 MD님 안녕하세요, 나무컴퍼니입니다.`, `${mdLabel(plan.dueDate)}(${weekdayKo(plan.dueDate)}) 납품분 택배 출고 파일 공유드립니다.`, `(${fileName})`].join('\n')
}

// ── 파일 이름 ────────────────────────────────────────────────────
export const fileNames = (plan: Plan) => ({
  md: `나무컴퍼니_매입 ${plan.shipDate.slice(0, 4)}.${plan.shipDate.slice(4, 6)}.${plan.shipDate.slice(6, 8)} 택배 출고.xlsx`,
  jindofarm: `킴스_택배_보배마을(통합형)_${mmdd(plan.shipDate)}.xlsx`,
  orderPdf: `이랜드_구매오더장_${mmdd(plan.shipDate)}.pdf`,
  allocPdf: `이랜드_상품별 점포 할당리스트_${mmdd(plan.shipDate)}.pdf`,
})

// ── 슬랙 (손익 숫자 없음) ───────────────────────────────────────
export function buildSlack(plan: Plan, o: { approved?: string[]; missingPdf?: string[]; dir?: string }): string {
  const checks = plan.issues.filter((i) => i.level === 'check')
  const L: string[] = []
  if (checks.length) L.push(`⚠️ 확인 필요 ${checks.length}건 — 아래 목록을 보고 보내기 (빈칸 대신 "확인 필요"로 채워 둠)`)
  if (o.approved?.length) L.push(`구매처승인 완료 ${o.approved.join(', ')}`)
  if (o.missingPdf?.length) L.push(`오더장 원본 수작업 필요 (${o.missingPdf.join(' · ')})`)
  L.push(`*[킴스 ${mdLabel(plan.dueDate)}(${weekdayKo(plan.dueDate)}) 납품분 서류 준비 완료]*`)
  L.push(`점포 ${plan.stores.length}곳 · 상품 ${plan.products.length}종 · 총 ${plan.stores.reduce((s, x) => s + x.boxes, 0)}박스`)
  if (checks.length) L.push('', '*확인 필요*', ...checks.map((i) => `• ${i.text}`))
  // 이미지·폴더 위치는 문구 밖 안내 — 카톡 문구에 넣으면 16GB 경로가 외부로 나갈 수 있다
  const mm = mmdd(plan.shipDate)
  L.push('', `수량 표 이미지(24GB로 복사한 뒤 위치): ~/Downloads/kims_${mm}/kims_qty_${mm}.png`)
  if (o.dir) L.push(`16GB 원본 위치(내부용): ${o.dir}`)
  return L.join('\n')
}
