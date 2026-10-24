/**
 * 순위 v2 메시지·보고서 시험 — 네트워크 없이 도는 가짜 자료 시험 (2026-10-24 오보 재발 방지)
 *   실행: NODE_PATH=$PWD/node_modules npx tsx scripts/naver-rank-watch-v2/test-messages.ts   (실패가 있으면 종료 코드 1)
 */
import { buildRankV2DeltaMessage, buildRankV2Message, type RankRowV2 } from '../../lib/naver/rankWatchV2'
import { buildMorningReport, type MorningSources } from '../../lib/coupang/morningReport'

let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) fail += 1
}
const row = (keyword: string, productNo: string, rank: number | null, status: RankRowV2['status'] = 'ok'): RankRowV2 => ({ keyword, productNo, mid: productNo ? 'm' : null, alias: productNo ? `상품${productNo}` : null, isTracked: !!productNo, rank, isAd: false, pageTotal: 40, status })
const kws = ['귀리', '파로', '호라산밀']
const prev = new Map<string, RankRowV2[]>([['귀리', [row('귀리', '1', 3)]], ['파로', [row('파로', '2', 5)]], ['호라산밀', [row('호라산밀', '3', 1)]]])
const cur = new Map<string, RankRowV2[]>([['귀리', [row('귀리', '1', 2)]], ['파로', [row('파로', '', null, 'captcha')]], ['호라산밀', [row('호라산밀', '', null, 'error')]]])

const d = buildRankV2DeltaMessage('2026-10-24', kws, cur, prev)
check('낮 알림: 못 읽은 키워드는 "1페이지 밖(어제 N위)"로 안 나온다', !d.text.includes('1페이지 밖') && !d.text.includes('파로') && !d.text.includes('호라산밀'), d.text)
check('낮 알림: 읽은 키워드의 변동은 나온다', d.changed && d.text.includes('귀리 — 상품1 2위(↑1)'), d.text)
check('낮 알림 제목에 읽은 키워드 1/3', d.text.includes('(읽은 키워드 1/3)'), d.text)

const m = buildRankV2Message('2026-10-24', kws, cur, prev)
check('아침 전체: 못 읽음(캡차) 표시', m.includes('파로 — 못 읽음(캡차)') && m.includes('호라산밀 — 못 읽음(오류/미수집)'), m)
check('아침 전체: 못 읽은 키워드는 순위 비교 안 함 표시', (m.match(/순위 비교 안 함/g) ?? []).length === 2, m)

const all = new Map<string, RankRowV2[]>([['귀리', [row('귀리', '1', 2)]]])
check('전부 읽은 날은 제목이 그대로(표기 변화 없음)', !buildRankV2Message('2026-10-24', ['귀리'], all, prev).includes('읽은 키워드'))
const noChange = buildRankV2DeltaMessage('2026-10-24', kws, new Map([['귀리', [row('귀리', '1', 3)]], ['파로', [row('파로', '', null, 'captcha')]], ['호라산밀', [row('호라산밀', '', null, 'captcha')]]]), prev)
check('못 읽은 것만 있고 읽은 쪽 변동 없으면 낮 알림 생략', noChange.changed === false)
const prevUnread = buildRankV2DeltaMessage('2026-10-24', kws, new Map([['귀리', [row('귀리', '1', 2)]], ['파로', [row('파로', '2', 5)]], ['호라산밀', [row('호라산밀', '3', 1)]]]), new Map([['귀리', [row('귀리', '1', 2)]], ['파로', [row('파로', '', null, 'captcha')]], ['호라산밀', [row('호라산밀', '3', 1)]]]))
check('아침(비교 기준)에 못 읽었던 키워드는 낮에 변동으로 안 침', prevUnread.changed === false, prevUnread.text)

// 아침 보고서 ⑦
const R = (keyword: string, productNo: string, rank: number | null, status = 'ok') => ({ keyword, alias: productNo ? `상품${productNo}` : keyword, productNo, rank, status })
const mk = (ranks: ReturnType<typeof R>[], yr: ReturnType<typeof R>[]) => ({ date: '2026-10-24', yesterday: '2026-10-23', stock: null, catalogToday: null, catalogYesterday: null, pageToday: null, rankToday: { ranks }, rankYesterday: { ranks: yr }, adDaily: null, naverSales: null, loginExpired: [] } as unknown as MorningSources)
const rep = buildMorningReport(mk([R('귀리', '1', 2), R('파로', '', null, 'captcha'), R('호라산밀', '', null, 'error'), R('※ 2026-10-22부터 새 방식', '', null, 'error')], [R('귀리', '1', 3), R('파로', '2', 5), R('호라산밀', '3', 1)])).text
check('보고서 ⑦: 읽은 키워드 N/M 표기 (※ 안내문 행은 키워드로 안 셈)', rep.includes('읽은 키워드 1/3'), rep)
check('보고서 ⑦: 못 읽은 키워드는 이탈·밖으로 안 셈', rep.includes('순위권 밖 0건') && rep.includes('이탈 0건'), rep)
check('보고서 ⑦: 못 읽음 목록 표시', rep.includes('못 읽음(캡차·오류, 비교 제외): 파로, 호라산밀'), rep)
const rep2 = buildMorningReport(mk([R('귀리', '1', null)], [R('귀리', '1', 3)])).text
check('보고서 ⑦: 읽었는데 상품이 사라지면 이탈로 잡힘(진짜 이탈은 유지)', rep2.includes('순위권 밖 1건') && rep2.includes('이탈 1건'), rep2)

console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과')
process.exit(fail ? 1 : 0)
