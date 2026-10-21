/**
 * 윙 '쿠팡상품정보' 엑셀(Coupang_detailinfo_YYMMDD.xlsx) 확인·대조 — 금액·손익 숫자 없음 (옵션 수·노출상품 수·ID 집합만).
 *
 *   npx tsx scripts/crawler-16gb/catalog-check.ts <파일>             # 1개: 파일명·날짜·옵션 행·노출상품·판매중 옵션
 *   npx tsx scripts/crawler-16gb/catalog-check.ts <파일A> <파일B>     # 2개: 옵션 행 수·노출상품 수·옵션ID 집합·노출상품ID 집합 일치/불일치
 *
 * 읽는 법은 scripts/coupang-catalog-watch/run.ts 의 readCatalog 와 같다 (lib/coupang/catalogWatch.parseCatalogRows).
 */
import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import { repairRef } from '../../lib/b2b/kurlyFile'
import { ON_SALE, parseCatalogRows } from '../../lib/coupang/catalogWatch'

function load(file: string) {
  if (!fs.existsSync(file)) throw new Error(`파일 없음: ${file}`)
  const name = path.basename(file)
  const m = /^(Coupang_detailinfo|price_inventory)_(\d{6})(?: \(\d+\))?\.xlsx$/.exec(name)
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' })
  const sheet = wb.Sheets['Template'] ?? wb.Sheets['data'] ?? wb.Sheets[wb.SheetNames[0]]
  if (!sheet) throw new Error(`시트 없음: ${name}`)
  repairRef(sheet)
  const rows = parseCatalogRows(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' }))
  return {
    name,
    date: m ? `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}` : '(파일명 규칙 아님)',
    nameOk: !!m && !name.includes('('),
    rows: rows.length,
    pids: new Set(rows.map((r) => r.pid).filter(Boolean)),
    oids: new Set(rows.map((r) => r.oid).filter(Boolean)),
    onSale: rows.filter((r) => r.sale === ON_SALE).length,
  }
}
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))

const [a, b] = process.argv.slice(2)
if (!a) {
  console.error('사용법: catalog-check.ts <파일> [<파일B>]')
  process.exit(2)
}
const A = load(a)
if (!b) {
  console.log(`${A.nameOk && A.rows > 0 ? '✅' : '❌'} ${A.name}`)
  console.log(`날짜: ${A.date}`)
  console.log(`옵션 행: ${A.rows}`)
  console.log(`노출상품: ${A.pids.size}`)
  console.log(`판매중 옵션: ${A.onSale}`)
  if (!A.nameOk) console.log('파일명이 규칙(Coupang_detailinfo_YYMMDD.xlsx)과 다르거나 "(1)" 중복본 — 결합 감시가 무시함')
  process.exit(A.nameOk && A.rows > 0 ? 0 : 1)
}
const B = load(b)
const same = (x: boolean) => (x ? '일치' : '불일치')
const results: [string, string][] = [
  ['옵션 행 수', same(A.rows === B.rows)],
  ['노출상품 수', same(A.pids.size === B.pids.size)],
  ['옵션ID 집합', same(sameSet(A.oids, B.oids))],
  ['노출상품ID 집합', same(sameSet(A.pids, B.pids))],
]
console.log(`A: ${A.name} (${A.date})`)
console.log(`B: ${B.name} (${B.date})`)
for (const [k, v] of results) console.log(`${v === '일치' ? '✅' : '❌'} ${k}: ${v}`)
if (A.date !== B.date) console.log('날짜가 다른 파일 — 그날 사이 변동이 있으면 불일치가 정상')
process.exit(results.every(([, v]) => v === '일치') ? 0 : 1)
