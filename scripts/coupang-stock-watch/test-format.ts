/**
 * 1P 재고·가격 슬랙 새 형식 시험 — 가짜 자료로 네트워크 없이.  실행: NODE_PATH=$PWD/node_modules npx tsx scripts/coupang-stock-watch/test-format.ts
 * 미리보기(실제 저장 스냅샷으로 본문·자세히 출력): npx tsx scripts/coupang-stock-watch/test-format.ts --preview <stock_report.json>   ← 16GB out/<날짜>/stock_report.json 형식
 */
import fs from 'node:fs'
import { buildStockDetailMessage, buildStockMainMessage, buildStockSnapshot, stockDisplayName, type SheetOneP, type StockItem } from '../../lib/coupang/stockWatch'

if (process.argv[2] === '--preview') {
  const j = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8')) as { snapshot: { date: string; states: Parameters<typeof buildStockMainMessage>[1] }; report: Parameters<typeof buildStockMainMessage>[2] }
  console.log(buildStockMainMessage(j.snapshot.date, j.snapshot.states, j.report), '\n\n----- 자세히 -----\n', buildStockDetailMessage(j.snapshot.date, j.snapshot.states, j.report, null))
  process.exit(0)
}
let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) fail += 1
}
const it = (optionId: string, title: string, price: number, stock: number | null, itemWinner: boolean | null = true): StockItem => ({ optionId, title, price, stock, soldOut: stock === null, reviews: 10, rating: 4.5, itemWinner, rocket: true, badges: [] })
const sheet: SheetOneP[] = [
  { optionId: '1', alias: '[보배마을] 귀리 1kg', bagCount: 1, sheetPrice: 5100 }, // 1봉 기준가
  { optionId: '5', alias: '[보배마을] 오트밀 350g', bagCount: 1, sheetPrice: 12300 },
  { optionId: '7', alias: '[쌀쌀쌀] 흑미 2kg', bagCount: 1, sheetPrice: 14700 },
]
const items: StockItem[] = [
  it('1', '보배마을 국산 유기농 귀리, 1kg, 1개', 7400, 12, false), // 위너 아님 + 가격 +45% (한 줄에 같이)
  it('2', '보배마을 국산 유기농 귀리, 1kg, 2개', 19900, null, false), // 2개 구성 품절 + 위너 아님(품절이라 본문에서 뺌)
  it('3', '쌀쌀쌀 캐나다산 햇 병아리콩, 2kg, 1개', 20000, null, true), // 1개 구성 품절
  it('4', '쌀쌀쌀 캐나다산 햇 병아리콩, 2kg, 2개', 40000, null, true),
  it('5', '보배마을 국산 유기농 오트밀, 350g, 1개', 11400, 50, true), // -7.3% → 본문 아님
  it('6', '보배마을 국내산 유기농 흑보리, 1kg, 3개', 18000, 5, true), // 재고 적음
  it('7', '쌀쌀쌀 흑미 2kg 1개', 14800, 30, true), // +0.7%
]
const { snapshot, report } = buildStockSnapshot({ date: '2026-10-24', items, oneP: sheet, prev: null })
const main = buildStockMainMessage('2026-10-24', snapshot.states, report)
const detail = buildStockDetailMessage('2026-10-24', snapshot.states, report, '2026-10-23')
check('본문 제목: 볼 것 2개 (귀리 1kg 은 위너+가격 겹쳐도 1번만, 병아리콩 1개 구성 품절)', main.includes('볼 것 2개'), main)
check('본문: 위너 아님 칸에 귀리 1줄 + 가격 정보가 같은 줄에', /• \[보배마을\] 귀리 1kg 1개 — 위너 아님 · 로켓 7,400원 \/ 기준가 5,100원 \(\+45\.1%\)/.test(main), main)
check('본문 문구는 "마진표"가 아니라 "기준가"', !main.includes('마진표') && main.includes('기준가'))
check('본문: 1개 구성 품절 칸에 병아리콩(이름 줄이기: [쌀쌀쌀] 병아리콩 2kg 1개)', main.includes('🔴 1개 구성 품절 1개') && main.includes('• [쌀쌀쌀] 병아리콩 2kg 1개 — 품절'), main)
check('본문: 2개 구성 품절·재고 적음·±10% 이하 가격은 안 나옴', !main.includes('오트밀') && !main.includes('흑보리') && !main.includes('귀리 1kg 2개') && !main.includes('병아리콩 2kg 2개'), main)
check('본문 끝: 나머지 정상 (품절 n · 재고 적음 n) → 바로 아래 자세히', /나머지 정상 \(품절 \d+ · 재고 적음 \d+\) → 바로 아래 자세히/.test(main), main)
check('자세히: 제목 바뀜 + 예전 본문 전체(품절·재고 적음·가격 다름 3건)', detail.startsWith('*[쿠팡 1P 자세히 10/24]') && detail.includes('재고 적음') && detail.includes('가격이 시트 기준가와 다름'), detail)
check('자세히: 위너 아님 중 1P 품절은 따로 표시(본문에서 뺀 것)', detail.includes('위너 아님 중 1P 품절') && detail.includes('귀리 1kg 2개'), detail)
const calm = buildStockSnapshot({ date: '2026-10-24', items: [it('7', '쌀쌀쌀 흑미 2kg 1개', 14700, 30, true), it('6', '보배마을 국내산 유기농 흑보리, 1kg, 3개', 18000, 5, true)], oneP: sheet, prev: null })
check('볼 것 0개면 한 줄: 이상 없음', buildStockMainMessage('2026-10-24', calm.snapshot.states, calm.report) === '[쿠팡 1P 점검 10/24] 이상 없음 (품절 0 · 재고 적음 1, 아래 자세히)', buildStockMainMessage('2026-10-24', calm.snapshot.states, calm.report))
const named = buildStockSnapshot({ date: '2026-10-24', items: [it('9', '보배마을 국내산 유기농 바나듐쌀, 2kg, 2개', 38800, null, false), it('10', '쌀쌀쌀 프리미엄 저속식단 잡곡, 2kg, 3개', 50700, null, false), it('11', '보배마을 국내산 유기농 호라산밀, 1kg, 3개', 50700, null, false)], oneP: [], prev: null })
check('이름 줄이기: [브랜드] 핵심이름 용량 N개', JSON.stringify(named.snapshot.states.map(stockDisplayName)) === JSON.stringify(['[보배마을] 바나듐쌀 2kg 2개', '[쌀쌀쌀] 저속식단 잡곡 2kg 3개', '[보배마을] 호라산밀 1kg 3개']), JSON.stringify(named.snapshot.states.map(stockDisplayName)))
check('슬랙 문구에 전화번호·손익(순이익·마진율) 없음', !/\d{2,3}-\d{3,4}-\d{4}/.test(main + detail) && !/순이익|마진율|마진액|이익률/.test(main + detail))
// 검수 지적 반영 시험
const detail2 = buildStockDetailMessage('2026-10-24', snapshot.states, report, '2026-10-23')
check('자세히: 예전 "아이템위너 아님" 칸이 그대로 남고(재고 있는 위너 아님 포함) 새 칸이 덧붙음', detail2.includes('⚪ 아이템위너 아님') && detail2.includes('귀리 1kg 1개') && detail2.includes('위너 아님 중 1P 품절'), detail2)
const dollar = buildStockSnapshot({ date: '2026-10-24', items: [it('20', "보배마을 국산 유기농 달러$'$&$1곡, 1kg, 2개", 10000, null, false), it('21', '쌀쌀쌀 흑미 2kg 1개', 14700, 30, false)], oneP: sheet, prev: null })
const dd = buildStockDetailMessage('2026-10-24', dollar.snapshot.states, dollar.report, null)
check('자세히: 상품명에 $\'·$&·$1 이 있어도 메시지가 안 깨짐(뒷부분 중복 없음)', (dd.match(/_기준:/g) ?? []).length === 1 && dd.includes("달러$'$&$1곡"), dd)
const edge = buildStockSnapshot({ date: '2026-10-24', items: [it('30', '쌀쌀쌀 흑미 2kg', 14700, 30, true), it('31', '쌀쌀쌀 신상 잡곡 2kg', 20000, null, true), it('1', '보배마을 국산 유기농 귀리, 1kg, 1개', 5610, 12, true)], oneP: sheet, prev: null })
const em = buildStockMainMessage('2026-10-24', edge.snapshot.states, edge.report)
check('제목에 "N개"가 없는 품절 상품은 본문에 "구성 수 미상"으로 표시', em.includes('구성 수 미상'), em)
const near = buildStockSnapshot({ date: '2026-10-24', items: [it('1', '보배마을 국산 유기농 귀리, 1kg, 1개', 5630, 12, true)], oneP: sheet, prev: null }) // 5100 → 5630 = +10.4%
check('+10.4% → 본문에 "(+10.4%)"', buildStockMainMessage('2026-10-24', near.snapshot.states, near.report).includes('(+10.4%)'), buildStockMainMessage('2026-10-24', near.snapshot.states, near.report))
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과')
process.exit(fail ? 1 : 0)
