/**
 * 쿠팡 로켓 발주 매출 보고 — 슬랙(#손익, 비공개) 메시지 (순수 함수).
 *
 * 웹훅 payload = { text: 알림용 한 줄, blocks: [{ type: 'markdown', text: 본문 }] }.
 * 본문은 표준 마크다운(굵게 **, 표 |) — 슬랙 markdown 블록이 표를 그린다.
 * 숫자는 화면의 기존 집계값을 그대로 받아 문장·표만 만든다 — 여기서 새로 계산하지 않는다
 * (합계 행·비율·적재율처럼 받은 값끼리 나누고 더하는 것만).
 */

export type SlackShipFrom = {
  name: string
  sales: number
  cost: number
  box: number
  freight: number
  margin: number
  marginSales: number // 원가 있는 상품 매출 (마진율 분모)
}
export type SlackTopItem = { name: string; qty: number; kg: number; amount: number }
export type SlackCenterRow = {
  center: string
  shipFrom: string
  boxes: number
  truck: boolean // false = 택배
  plt: number | null
  loadPct: number | null // 적재율 % (택배 null)
  transport: string // '밀크런 2.5톤' / '밀크런' / '택배'
}

export type SlackReportInput = {
  dueDates: string[] // 입고예정일 (YYYY-MM-DD)
  totalSales: number // 이번 발주 매출 요약 합계
  totalQty: number
  totalBoxes: number
  totalKg: number
  shipFroms: SlackShipFrom[] // 출고지별 하단 요약 (매출 0 은 생략)
  top: SlackTopItem[] // 매출 요약 표 행
  centers: SlackCenterRow[] // 트럭분(팔레트 필요 안내·곰표분 운임 행) + 택배분, 화면 순서
}

export type SlackReport = { text: string; body: string }

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const SHIP_ORDER = ['진도팜', '위킵', '곰표']
const TOP_N = 7
const num = (n: number) => Math.round(n).toLocaleString('ko-KR')
const kg = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 1 })
const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0')
const cell = (v: string) => String(v ?? '').replace(/\|/g, '/')
const row = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`

/** 'YYYY-MM-DD' → '10/13(화)' */
const mdDay = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  if (!m) return ymd || '?'
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]})`
}
/** 별칭 '[보배마을] 귀리혼합10곡 800g' → '귀리혼합10곡 800g' */
const shortName = (name: string) => String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim() || name

/** 화면 차량값('2.5톤', '8톤 + 1톤') → 적재 한도 kg (톤 × 1,000). 못 읽으면 0 */
export const vehicleKgOf = (vehicle: string): number =>
  [...String(vehicle || '').matchAll(/([\d.]+)\s*톤/g)].reduce((a, m) => a + Number(m[1]) * 1000, 0)

export function buildCoupangSlackReport(x: SlackReportInput): SlackReport {
  const days = [...new Set(x.dueDates.filter(Boolean))].sort()
  const title = `쿠팡 로켓 ${days.length ? `${mdDay(days[0])}${days.length > 1 ? ' 외' : ''}` : '입고일 미정'} 입고 매출`
  const ships = x.shipFroms.filter((s) => s.sales > 0)
  const freight = ships.reduce((a, s) => a + s.freight, 0)

  const lines: string[] = [
    `**[${title}]**`,
    `• 총 매출 : **${num(x.totalSales)}원**`,
    `• 운송비 : ${num(freight)}원 (${pct(freight, x.totalSales)}%)`,
    `• 물량 : ${num(x.totalQty)}봉 / ${num(x.totalBoxes)}박스 / ${kg(x.totalKg)}kg`,
  ]

  if (ships.length) {
    const t = ships.reduce(
      (a, s) => ({
        sales: a.sales + s.sales,
        cost: a.cost + s.cost,
        box: a.box + s.box,
        freight: a.freight + s.freight,
        margin: a.margin + s.margin,
        marginSales: a.marginSales + s.marginSales,
      }),
      { sales: 0, cost: 0, box: 0, freight: 0, margin: 0, marginSales: 0 },
    )
    lines.push(
      '',
      '**📊 손익** (단위: 원)',
      row(['출고지', '매출', '원가', '박스', '운송비', '마진']),
      '|---|---:|---:|---:|---:|---:|',
      ...ships.map((s) =>
        row([
          s.name,
          num(s.sales),
          num(s.cost),
          num(s.box),
          `${num(s.freight)} · ${pct(s.freight, s.sales)}%`,
          `${num(s.margin)} · ${pct(s.margin, s.marginSales)}%`,
        ]),
      ),
      row([
        '**합계**',
        `**${num(t.sales)}**`,
        `**${num(t.cost)}**`,
        `**${num(t.box)}**`,
        `**${num(t.freight)} · ${pct(t.freight, t.sales)}%**`,
        `**${num(t.margin)} · ${pct(t.margin, t.marginSales)}%**`,
      ]),
    )
  }

  const top = [...x.top].filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, TOP_N)
  if (top.length) {
    lines.push(
      '',
      `**🏆 상품별 매출 TOP ${TOP_N}**`,
      row(['#', '상품', '수량', '무게', '매출']),
      '|---:|---|---:|---:|---:|',
      ...top.map((t, i) => row([String(i + 1), shortName(t.name), `${num(t.qty)}개`, `${kg(t.kg)}kg`, `${num(t.amount)}원`])),
    )
  }

  if (x.centers.length) {
    // 트럭분(센터 가나다순, 같은 센터면 진도팜 → 곰표) 다음 택배분(화면 순서)
    const rank = (sf: string) => (SHIP_ORDER.indexOf(sf) < 0 ? SHIP_ORDER.length : SHIP_ORDER.indexOf(sf))
    const truck = x.centers
      .filter((c) => c.truck)
      .map((c, i) => ({ c, i }))
      .sort((a, b) => a.c.center.localeCompare(b.c.center, 'ko') || rank(a.c.shipFrom) - rank(b.c.shipFrom) || a.i - b.i)
      .map((v) => v.c)
    const parcel = x.centers.filter((c) => !c.truck)
    lines.push(
      '',
      '**🚚 센터별 출고**',
      row(['센터', '출고지', '박스', 'PLT', '적재율', '운송']),
      '|---|---|---:|---:|---:|---|',
      ...[...truck, ...parcel].map((c) =>
        row([
          c.center,
          c.shipFrom,
          num(c.boxes),
          c.plt === null ? '—' : String(c.plt),
          c.loadPct === null ? '—' : `${c.loadPct}%`,
          c.transport,
        ]),
      ),
    )
  }

  return { text: `[${title}] 총 매출 ${num(x.totalSales)}원`, body: lines.join('\n') }
}

/** 같은 보고 판별 키 — 발주번호 묶음 */
export const slackReportKey = (poNumbers: string[]): string => [...new Set(poNumbers)].sort().join(',')
