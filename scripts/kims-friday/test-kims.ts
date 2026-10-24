/**
 * 킴스 서류 만들기 시험 — 가짜 이랜드 자료(가짜 점포·번호)로 네트워크·파일 없이.  실행: NODE_PATH=$PWD/node_modules npx tsx scripts/kims-friday/test-kims.ts
 * 실패가 있으면 종료 코드 1. 실제 이랜드 자료와의 비교는 run.ts 를 직접 돌려 사람이 손으로 만든 파일과 대조한다(저장소 밖 비공개 폴더 필요).
 * 이 시험이 쓰는 점포·전화·단가·PO 번호는 전부 가짜 값이다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { buildPlan, buildSlack, jindofarmRows, messageFridayJindofarm, messageMondayJindofarm, parseAlloc, parsePor, parseStoreSheet, qtyTableSvg, summarySheetAoa, type NameEntry } from '../../lib/kims/kimsFriday'
import { buildMdWorkbook } from '../../lib/kims/kimsMdWorkbook'

let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) fail += 1
}
const names: Record<string, NameEntry> = { '8800295820770': { short: '오트현미 한끼 즉석밥' } }
// 가짜 점포 시트: 지점코드 · 지점명 · … · 성함 · 직급 · 직책 · 연락처 · 메일 · 주소  (F=성함 G=직급 H=직책 I=연락처 K=주소)
const storeRows = [
  ['농산 담당자 현황'],
  ['지점코드', '지점명', '점장'],
  ['9001', '가짜1 킴스', '점장A', '', '', '담당자1', 'S3', '팀장', '전화A', '메일A', '가짜시 가짜구 1번지', '10시'],
  ['', '', '', '', '', '담당자1b', 'J', '담당', '전화B', '메일B'],
  ['9002', '가짜2 킴스', '점장B', '', '', '담당자2', 'S3', '담당', '전화C', '메일C', '', '10시'], // 주소 비어 있음
]
const stores = parseStoreSheet(storeRows)
const porHeader = ['구매문서', '품목번호', '점포코드', '점포명', '업체코드', '업체명', '상품코드', '상품명', '구매오더일', '납품요청일', '오더수량', '단위', '입수', 'BOX', '단가', '금액', '세금']
const por = (rows: string[][]) => parsePor([porHeader, ...rows])
const alloc = (rows: string[][]) => parseAlloc(['할당번호\t구매오더\t순번\t발주점포\t발주점포명\t상품코드\t상품명\t발주일자\t납품일자\t단위\t입수\t발주수량\tBOX수량', ...rows.map((r) => r.join('\t'))].join('\n'))
const P = (code: string, name: string, qty: number, per = 18, due = '20261027') => ['111', '10', '1902', 'X', 'V', 'N', code, name, '20261023', due, String(qty), 'EA', String(per), String(qty / per), '100', '0', 'FRE']
const A = (store: string, sname: string, code: string, name: string, qty: number, per = 18, due = '2026-10-27') => ['1', '111', '10', store, sname, code, name, '2026-10-23', due, 'EA', String(per), String(qty), String(qty / per)]

// 1) 정상 — 2점포·2상품
let plan = buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 36), P('8800295820916', '유기농 찰보리 1kg', 18)]), alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 18), A('9001', '가짜1점', '8800295820916', '유기농 찰보리 1kg', 18), A('9002', '가짜2점', '8800295820862', '유기농 흑미 1kg', 18)]), stores, names })
check('정상: 확인 필요 중 수량 문제 없음(주소 빈 점포 1건만)', plan.issues.length === 1 && plan.issues[0].text.includes('가짜2점') && plan.issues[0].text.includes('주소'), JSON.stringify(plan.issues))
check('출고일은 납품일 하루 전(월)', plan.shipDate === '20261026' && plan.dueDate === '20261027')
const jr = jindofarmRows(plan, names)
check('진도팜 행: 받는분 = 팀장 우선("담당자1팀장님") + 내품명 [보배마을] 흑미', jr[0][0] === '담당자1팀장님' && jr[0][4] === '[보배마을] 흑미' && jr[0][5] === 18, JSON.stringify(jr[0]))
check('진도팜 행: 주소가 빈 점포는 "확인 필요"', jr[2][2] === '확인 필요' && jr[2][0] === '담당자2님', JSON.stringify(jr[2]))
check('월요일 문구에 점포·수량·총 박스', messageMondayJindofarm(plan).includes('가짜1점: 흑미 1kg 18개, 찰보리 1kg 18개 (총 2박스)'))
check('금요일 문구 안에는 경로가 없고, 슬랙 안내 줄에만 24GB 복사 후 위치(~/Downloads/kims_MMDD/)가 나온다', !/\/Users|private|crawler|\.png/.test(messageFridayJindofarm(plan)) && buildSlack(plan, {}).includes('~/Downloads/kims_1026/kims_qty_1026.png'))
const sum = summarySheetAoa(plan)
check('발주 종합: 흑미 행 BOX 2, 점포명 둘, 합계 BOX 3', JSON.stringify(sum.aoa[8].slice(1, 6)) === JSON.stringify([8800295820862, '유기농 흑미 1kg', { f: '$J$1*E9', v: 36 }, 2, '가짜1점, 가짜2점']) && (sum.aoa[13][4] as { v: number }).v === 3, JSON.stringify(sum.aoa[8]))
check('수량 표 SVG: 합계 54/3', qtyTableSvg(plan).includes('>54<') && qtyTableSvg(plan).includes('>3<'))

// 2) 처음 보는 점포·상품
plan = buildPlan({ por: por([P('8800295829999', '유기농 신상품 1kg', 18)]), alloc: alloc([A('9999', '모르는점', '8800295829999', '유기농 신상품 1kg', 18)]), stores, names })
const txt = plan.issues.map((i) => i.text).join(' | ')
check('처음 보는 점포 → 확인 필요', txt.includes('주소 시트에 없는 점포: 모르는점'), txt)
check('처음 보는 상품이 규칙에 맞아도 확인 필요 + 이름은 만들어짐(빈칸 아님)', jindofarmRows(plan, names)[0][4] === '[보배마을] 신상품' && plan.issues.some((i) => i.text.includes('처음 보는 상품') && i.text.includes('규칙으로 만들었음')))
plan = buildPlan({ por: por([P('8800295829998', '이상한 이름 상품 500g', 12, 12)]), alloc: alloc([A('9001', '가짜1점', '8800295829998', '이상한 이름 상품 500g', 12, 12)]), stores, names })
check('규칙 밖 이름 상품 → "처음 보는 상품" 확인 필요 + 내품명 "확인 필요:"', plan.issues.some((i) => i.text.includes('처음 보는 상품')) && String(jindofarmRows(plan, names)[0][4]).startsWith('확인 필요:'))
check('발주 종합 양식에 없는 상품은 맨 아래 "확인 필요" 행', summarySheetAoa(plan).issues.some((t) => t.includes('양식에 없는 상품')))

// 3) 수량 불일치 · 비배수 · 납품일
plan = buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 36)]), alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 18)]), stores, names })
check('구매오더 36 vs 할당 18 → 수량이 안 맞음', plan.issues.some((i) => i.text.includes('수량이 안 맞음')), JSON.stringify(plan.issues))
plan = buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 20)]), alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 20)]), stores, names })
check('입수 18에 수량 20 → 배수 아님 확인 필요', plan.issues.some((i) => i.text.includes('배수가 아님')))
plan = buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 18, 18, '20261028')]), alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 18, 18, '2026-10-28')]), stores, names })
check('납품일이 수요일 → 확인 필요(출고일 추정 표시)', plan.issues.some((i) => i.text.includes('화요일이 아님')))
const slack = buildSlack(plan, { approved: ['4523712226'], missingPdf: ['구매오더장'] })
check('슬랙: 첫 줄 ⚠️ 확인 필요 + 구매처승인 완료·오더장 원본 수작업 필요 표시', slack.startsWith('⚠️ 확인 필요') && slack.includes('구매처승인 완료 4523712226') && slack.includes('오더장 원본 수작업 필요 (구매오더장)') && /확인 필요 \d+건/.test(slack), slack)
check('슬랙에 전화번호·금액 없음', !/\d{2,3}-\d{3,4}-\d{4}/.test(slack) && !/단가|매입가/.test(slack))
let threw = false
try { buildPlan({ por: [], alloc: [], stores, names }) } catch { threw = true }
check('구매오더 0건이면 예외(호출측이 "이번 주 발주 없음" 처리)', threw)

// ── 검수 지적 반영: 날짜·열·전화·PO·금액·MD 엑셀·CLI ────────────────────────────────
const throws = (f: () => unknown) => { try { f(); return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }
check('납품요청일을 못 읽으면 중단(0/0 서류가 안 나감)', throws(() => parsePor([porHeader, ['111', '10', '1902', 'X', 'V', 'N', '8800295820862', '유기농 흑미 1kg', '20261023', '', '18', 'EA', '18', '1', '100', '100', 'FRE']])).includes('납품요청일'))
check('할당 파일 납품일자가 깨져도 중단', throws(() => parseAlloc(['할당번호\t구매오더\t순번\t발주점포\t발주점포명\t상품코드\t상품명\t발주일자\t납품일자\t단위\t입수\t발주수량\tBOX수량', '1\t111\t10\t9001\t가짜1점\t88\t흑미\t2026-10-23\tabc\tEA\t18\t18\t1'].join('\n'))).includes('납품일자'))
check('PORInfo 열 이름이 바뀌면(BOX → 박스) 중단하고 열 이름을 알려줌', throws(() => parsePor([porHeader.map((h) => (h === 'BOX' ? '박스' : h)), P('8800295820862', '유기농 흑미 1kg', 18)])).includes('BOX'))
check('할당 파일 열 이름이 바뀌면 중단', throws(() => parseAlloc('할당번호\t구매오더\t순번\t발주점포\t발주점포명\t상품코드\t상품명\t발주일자\t납품일자\t단위\t입수\t수량\tBOX수량\n')).includes('발주수량'))
const noPhone = parseStoreSheet([['지점코드'], ['지점코드', '지점명'], ['9003', '가짜3 킴스', '', '', '', '', '', '', '', '', '가짜시 가짜구 3번지']]) // 담당자·전화 없음
plan = buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 18)]), alloc: alloc([A('9003', '가짜3점', '8800295820862', '유기농 흑미 1kg', 18)]), stores: noPhone, names })
const nj = jindofarmRows(plan, names)[0]
check('전화·담당자가 시트에 비면 진도팜 파일에 "확인 필요"(빈칸·"님"만 안 나감) + 확인 필요 목록', nj[0] === '확인 필요' && nj[1] === '확인 필요' && plan.issues.some((i) => i.text.includes('받는분/전화')), JSON.stringify(nj))
check('슬랙 첫 줄이 "⚠️ 확인 필요 N건"', buildSlack(plan, {}).startsWith('⚠️ 확인 필요'))
plan = buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 18)]), alloc: alloc([['1', '999', '10', '9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', '2026-10-23', '2026-10-27', 'EA', '18', '18', '1']]), stores, names })
check('점별 할당의 PO 번호가 구매오더 파일에 없으면 확인 필요(다른 주 파일 섞임)', plan.issues.some((i) => i.text.includes('구매오더 번호 999')))
const odd = parsePor([porHeader, ['111', '10', '1902', 'X', 'V', 'N', '8800295820862', '유기농 흑미 1kg', '20261023', '20261027', '20', 'EA', '18', '1', '100', '2000', 'FRE']])
check('이랜드 파일 안에서 오더수량 ≠ 입수×BOX 면 확인 필요', buildPlan({ por: odd, alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 20)]), stores, names }).issues.some((i) => i.text.includes('≠ 입수')))
const sumRows = summarySheetAoa(buildPlan({ por: por([P('8800295820862', '유기농 흑미 1kg', 36)]), alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 36)]), stores, names })).aoa
const blankBox = parsePor([porHeader, ['111', '10', '1902', 'X', 'V', 'N', '8800295820862', '유기농 흑미 1kg', '20261023', '20261027', '18', 'EA', '', '', '100', '1800', 'FRE']])
const bp = buildPlan({ por: blankBox, alloc: parseAlloc(['할당번호\t구매오더\t순번\t발주점포\t발주점포명\t상품코드\t상품명\t발주일자\t납품일자\t단위\t입수\t발주수량\tBOX수량', '1\t111\t10\t9001\t가짜1점\t8800295820862\t유기농 흑미 1kg\t2026-10-23\t2026-10-27\tEA\t\t18\t'].join('\n')), stores, names })
check('수량은 있는데 입수·BOX 칸이 빈칸이면 확인 필요(조용히 0박스로 안 나감)', bp.issues.some((i) => i.text.includes('입수') && i.text.includes('비어 있음')) && bp.issues.some((i) => i.text.includes('할당 가짜1점')), JSON.stringify(bp.issues))
check('종합 탭: 바코드는 숫자, 주문 없는 빈 행에도 수식(=입수×BOX) 유지', typeof sumRows[2][1] === 'number' && typeof sumRows[2][3] === 'object' && (sumRows[2][3] as { f: string }).f === '$J$1*E3')

// 강황·즉석밥(입수 12) 혼합 + 2박스 금액 + MD 엑셀 생성
const mixed = buildPlan({
  por: parsePor([porHeader, ['111', '00010', '1902', '이랜드팜앤푸드(서울)', '125864    ', '나무컴퍼니', '8800295820862', '유기농 흑미 1kg', '20261023', '20261027', '36', 'EA', '18', '2', '100', '3600', 'FRE'], ['111', '00020', '1902', '이랜드팜앤푸드(서울)', '125864    ', '나무컴퍼니', '8800295820947', '유기농 강황가루 100g', '20261023', '20261027', '24', 'EA', '12', '2', '200', '4800', 'FRE']]),
  alloc: alloc([A('9001', '가짜1점', '8800295820862', '유기농 흑미 1kg', 36), A('9001', '가짜1점', '8800295820947', '유기농 강황가루 100g', 24, 12)]),
  stores,
  names,
})
const mx = summarySheetAoa(mixed).aoa
const find = (code: number) => mx.find((r) => r[1] === code)!
check('강황(입수 12) 2박스 = 24, 흑미(입수 18) 2박스 = 36 — 종합 탭 블록별 입수', (find(8800295820947)[3] as { v: number }).v === 24 && (find(8800295820862)[3] as { v: number }).v === 36)
async function mdTest() {
  const ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
  const z = new JSZip()
  z.file('[Content_Types].xml', ct)
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  z.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="건강약용 매입요청" sheetId="1" r:id="rId1"/><sheet name="기존 구매오더(원본)" sheetId="2" r:id="rId2"/></sheets></workbook>')
  z.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
  const it = (c: string, v: string) => `<c r="${c}" s="6" t="inlineStr"><is><t>${v}</t></is></c>`
  const empty = (c: string) => `<c r="${c}" s="16" t="n"></c>`
  const prodRow = (r: number, code: string, price: string) => `<row r="${r}">${it(`H${r}`, code)}${it(`J${r}`, price)}${empty(`M${r}`)}${empty(`N${r}`)}${empty(`O${r}`)}</row>`
  z.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2">${it('M2', '중계')}${it('N2', '가짜1')}${it('O2', '가짜2')}</row>${prodRow(3, '8800295820862', ' 100 ')}${prodRow(4, '8800295820947', ' 250 ')}</sheetData></worksheet>`)
  z.file('xl/worksheets/sheet2.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:Q3"/><sheetData><row r="1">${it('A1', '구매문서')}</row><row r="2"><c r="A2" t="n"><v>1</v></c></row></sheetData></worksheet>`)
  const tpl = await z.generateAsync({ type: 'nodebuffer' })
  const out = await buildMdWorkbook(tpl, mixed, mixed.stores.length ? parsePor([porHeader, ['111', '00010', '1902', '이랜드팜앤푸드(서울)', '125864    ', '나무컴퍼니', '8800295820862', '유기농 흑미 1kg', '20261023', '20261027', '36', 'EA', '18', '2', '100', '3600', 'FRE'], ['111', '00020', '1902', '이랜드팜앤푸드(서울)', '125864    ', '나무컴퍼니', '8800295820947', '유기농 강황가루 100g', '20261023', '20261027', '24', 'EA', '12', '2', '200', '4800', 'FRE']]) : [])
  const wb = XLSX.read(out.buf)
  const s1 = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['건강약용 매입요청'], { header: 1, raw: true, defval: '' })
  const r862 = s1.find((r) => String(r[0]).trim() === '8800295820862'); const r947 = s1.find((r) => String(r[0]).trim() === '8800295820947')
  check('MD 엑셀: 점포(가짜1점→"가짜1" 열) × 상품 행에 점포별 수량(흑미 36·강황 24), 다른 점포 열은 비어 있음', r862?.[6] === 36 && r947?.[6] === 24 && r862?.[7] === '' && r862?.[5] === '', JSON.stringify(s1))
  const s2 = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['기존 구매오더(원본)'], { header: 1, raw: true, defval: '' })
  check('MD 원본 탭: 2박스 행의 금액은 이랜드 파일 값 그대로(단가×입수로 다시 계산하지 않음) — 3600/4800', s2.length === 3 && s2[1][15] === 3600 && s2[2][15] === 4800 && s2[1][14] === 100, JSON.stringify(s2))
  check('MD 원본 탭: 점포명·업체코드·업체명·세금도 이랜드 값 그대로(고정값 아님)', s2[1][3] === '이랜드팜앤푸드(서울)' && s2[1][4] === 125864 && s2[1][5] === '나무컴퍼니' && s2[1][16] === 'FRE', JSON.stringify(s2[1]))
  check('MD 양식 매입단가(강황 250) ≠ 이랜드 단가(200) → 확인 필요, 같은 흑미(100)는 통과', out.issues.some((x) => x.includes('강황') && x.includes('매입단가')) && !out.issues.some((x) => x.includes('흑미') && x.includes('매입단가')), JSON.stringify(out.issues))
}

// CLI: 발주 0건 · 출력 폴더 제한
function cliTest() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kimstest-'))
  const priv = path.join(T, 'private'); fs.mkdirSync(priv)
  const emptyPor = path.join(T, 'por.xlsx'); { const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet([porHeader]), "PORInfo"); XLSX.writeFile(b, emptyPor) }
  const allocF = path.join(T, 'alloc.xls'); fs.writeFileSync(allocF, '할당번호\t구매오더\t순번\t발주점포\t발주점포명\t상품코드\t상품명\t발주일자\t납품일자\t단위\t입수\t발주수량\tBOX수량\n')
  const run = (out: string) => spawnSync('npx', ['--yes', 'tsx', path.join(__dirname, 'run.ts'), '--por', emptyPor, '--alloc', allocF, '--stores-json', path.join(T, 'x.json'), '--out', out], { encoding: 'utf-8', env: { ...process.env, KIMS_PRIVATE_DIR: priv } })
  const a = run(path.join(priv, 'out'))
  check('발주 0건이면 "이번 주 발주 없음"으로 정상 종료(서류 안 만듦)', a.status === 0 && (a.stdout + a.stderr).includes('이번 주 발주 없음') && !fs.existsSync(path.join(priv, 'out', 'plan.json')), a.stdout + a.stderr)
  // 제목 줄도 없는 0바이트 파일(이랜드가 0건일 때) → 필수 열 없음 실패가 아니라 "발주 없음"
  fs.writeFileSync(emptyPor, '')
  const z = run(path.join(priv, 'out0'))
  check('이랜드가 0바이트 빈 파일을 주면 "이번 주 발주 없음"(필수 열 없음 실패 아님)', z.status === 0 && (z.stdout + z.stderr).includes('이번 주 발주 없음'), z.stdout + z.stderr)
  const b = run(path.join(T, 'outside'))
  check('출력 폴더가 비공개 폴더 밖이면 거부', b.status !== 0 && (b.stdout + b.stderr).includes('출력 폴더는 비공개 폴더'), b.stdout + b.stderr)
  fs.rmSync(T, { recursive: true, force: true })
}
(async () => {
await mdTest()
cliTest()

console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과')
process.exit(fail ? 1 : 0)
})()
