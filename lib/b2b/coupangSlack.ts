/**
 * 쿠팡 로켓 발주 매출 보고 — 슬랙(#공유-데일리세일즈) 텍스트 (순수 함수).
 *
 * 웹훅은 마크다운 표를 그리지 못해 줄 단위 텍스트 + *굵게*(슬랙 mrkdwn).
 * 숫자는 화면의 기존 집계값을 그대로 받아 문장만 만든다 — 여기서 새로 계산하지 않는다.
 */

export type SlackShipFrom = { name: string; sales: number; freight: number; margin: number; marginSales: number }
export type SlackPalletRow = { center: string; shipFrom: string; boxes: number; plt: number; vehicle: string }
export type SlackParcelRow = { center: string; boxes: number }
export type SlackTopItem = { name: string; qty: number; amount: number }

export type SlackReportInput = {
  dueDates: string[] // 입고예정일 (YYYY-MM-DD)
  poCount: number
  totalSales: number // 이번 발주 매출 요약 합계
  totalQty: number
  totalBoxes: number
  shipFroms: SlackShipFrom[] // 출고지별 하단 요약 (매출 0 은 생략)
  pallet: SlackPalletRow[] // 팔레트 필요 안내 행·곰표분 운임 행 (밀크런)
  parcel: SlackParcelRow[] // 택배 가능 행
  top: SlackTopItem[] // 매출 요약 표 행
  madeDates: { shipFrom: string; dates: string[] }[] // 출고지별 제조일자 (빈 배열 = 공란)
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const num = (n: number) => Math.round(n).toLocaleString('ko-KR')
const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0')

/** 'YYYY-MM-DD' → '10/13' */
const md = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? `${Number(m[2])}/${Number(m[3])}` : ymd || '?'
}
/** 'YYYY-MM-DD' → '10/13(화)' */
const mdDay = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? `${md(ymd)}(${WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]})` : ymd || '?'
}
/** 별칭 '[보배마을] 귀리혼합10곡 800g' → '귀리혼합10곡 800g' */
const shortName = (name: string) => String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim() || name

export function buildCoupangSlackReport(x: SlackReportInput): string {
  const days = [...new Set(x.dueDates.filter(Boolean))].sort()
  const title = days.length ? `${mdDay(days[0])}${days.length > 1 ? ' 외' : ''}` : '입고일 미정'
  const lines: string[] = [
    `*[쿠팡 로켓] ${title} 입고 발주 매출 보고*`,
    `총 매출 *${num(x.totalSales)}원* · 발주 ${x.poCount}건 · ${num(x.totalQty)}봉 · ${num(x.totalBoxes)}박스`,
  ]

  const ships = x.shipFroms.filter((s) => s.sales > 0)
  if (ships.length) {
    lines.push('', '*출고지별*')
    for (const s of ships) {
      lines.push(
        `• ${s.name} 매출 ${num(s.sales)}원 · 운송비 ${num(s.freight)}원 (${pct(s.freight, s.sales)}%) · ` +
          `마진 ${num(s.margin)}원 (${pct(s.margin, s.marginSales)}%)`,
      )
    }
  }

  if (x.pallet.length || x.parcel.length) {
    lines.push('', '*센터별 출고*')
    const byCenter = new Map<string, string[]>()
    for (const p of x.pallet) {
      const part = `${p.shipFrom} ${num(p.boxes)}박스 · ${p.plt}PLT${p.vehicle ? ` (밀크런 ${p.vehicle})` : ''}`
      byCenter.set(p.center, [...(byCenter.get(p.center) ?? []), part])
    }
    for (const [center, parts] of byCenter) lines.push(`• ${center} ${parts.join(' / ')}`)
    if (x.parcel.length) lines.push(`• ${x.parcel.map((p) => `${p.center} ${num(p.boxes)}박스`).join(' · ')} — 택배`)
  }

  const top = [...x.top].filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 3)
  if (top.length) {
    lines.push('', '*상품별 매출 TOP 3*')
    top.forEach((t, i) => lines.push(`${i + 1}. ${shortName(t.name)} ${num(t.qty)}개 — ${num(t.amount)}원`))
  }

  const made = x.madeDates
  if (made.length) {
    const label = (ds: string[]) => (ds.length ? [...new Set(ds)].sort().map(md).join(',') : '공란')
    const all = [...new Set(made.flatMap((m) => m.dates))]
    const same = all.length === 1 && made.every((m) => m.dates.length > 0)
    lines.push(
      '',
      same ? `제조일자 ${md(all[0])}` : `제조일자 ${made.map((m) => `${m.shipFrom} ${label(m.dates)}`).join(' · ')}`,
    )
  }
  return lines.join('\n')
}

/** 같은 보고 판별 키 — 발주번호 묶음 */
export const slackReportKey = (poNumbers: string[]): string => [...new Set(poNumbers)].sort().join(',')
