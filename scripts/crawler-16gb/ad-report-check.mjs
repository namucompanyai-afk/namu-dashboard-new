#!/usr/bin/env node
/**
 * 쿠팡 광고 보고서(A00993784_pa_total_campaign_YYYYMMDD_YYYYMMDD.xlsx) 확인·대조 — 금액은 절대 출력하지 않는다.
 *
 *   node scripts/crawler-16gb/ad-report-check.mjs <파일>            # 1개: 파일명·기간·행 수·캠페인 수·열 이름 앞 10개
 *   node scripts/crawler-16gb/ad-report-check.mjs <파일A> <파일B>    # 2개: 행 수·캠페인 수·광고비 합계·열 이름이 같은지 (일치/불일치만)
 *
 * 헤더 찾는 법은 lib/coupang/parsers/adCampaign.ts 와 같다 ('캠페인' + '광고비' 가 들어 있는 첫 행).
 * xlsx 패키지는 이 저장소 node_modules 에서 찾는다 (16GB는 ~/crawler/dashboard 에 npm ci 한 것).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase()

function load(file) {
  if (!fs.existsSync(file)) throw new Error(`파일 없음: ${file}`)
  const name = path.basename(file)
  const m = /^A00993784_pa_total_campaign_(\d{8})_(\d{8})(?: \(\d+\))?\.xlsx$/.exec(name)
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false })
  const h = aoa.findIndex((r) => r.some((c) => String(c).includes('캠페인')) && r.some((c) => String(c).includes('광고비')))
  if (h < 0) throw new Error(`헤더 행 없음 (캠페인 + 광고비): ${name}`)
  const headers = aoa[h].map((c) => String(c ?? '').trim())
  const rows = aoa.slice(h + 1)
  const col = (label) => headers.findIndex((x) => norm(x) === norm(label))
  const ci = col('캠페인명') >= 0 ? col('캠페인명') : col('캠페인 ID')
  const cc = col('광고비')
  const campaigns = new Set(rows.map((r) => r[ci]).filter((v) => v !== undefined && v !== null && v !== ''))
  const cost = rows.reduce((s, r) => s + (Number(r[cc]) || 0), 0)
  return {
    name,
    period: m ? `${m[1]}~${m[2]}` : '(파일명 규칙 아님)',
    nameOk: !!m && !name.includes('('),
    rows: rows.length,
    campaigns: campaigns.size,
    cost, // 출력 금지 — 대조에만 쓴다
    headers,
  }
}

const [a, b] = process.argv.slice(2)
if (!a) {
  console.error('사용법: ad-report-check.mjs <파일> [<파일B>]')
  process.exit(2)
}
const A = load(a)
if (!b) {
  console.log(`${A.nameOk ? '✅' : '❌'} ${A.name}`)
  console.log(`기간: ${A.period}`)
  console.log(`행 수: ${A.rows}`)
  console.log(`캠페인 수: ${A.campaigns}`)
  console.log(`열 이름 앞 10개: ${A.headers.slice(0, 10).join(' | ')}`)
  if (!A.nameOk) console.log('파일명이 규칙(A00993784_pa_total_campaign_시작_끝.xlsx)과 다르거나 "(1)" 중복본 — 업로드 스크립트가 무시함')
  process.exit(A.nameOk ? 0 : 1)
}
const B = load(b)
const same = (x, y) => (x === y ? '일치' : '불일치')
const results = [
  ['행 수', same(A.rows, B.rows)],
  ['캠페인 수', same(A.campaigns, B.campaigns)],
  ['광고비 합계', same(Math.round(A.cost), Math.round(B.cost))],
  ['열 이름', same(A.headers.join('|'), B.headers.join('|'))],
]
console.log(`A: ${A.name} (${A.period})`)
console.log(`B: ${B.name} (${B.period})`)
for (const [k, v] of results) console.log(`${v === '일치' ? '✅' : '❌'} ${k}: ${v}`)
process.exit(results.every(([, v]) => v === '일치') ? 0 : 1)
