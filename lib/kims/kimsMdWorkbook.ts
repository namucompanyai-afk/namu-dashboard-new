/**
 * MD용 "나무컴퍼니_매입 YYYY.MM.DD 택배 출고.xlsx" 만들기 — 9/28 양식 템플릿(저장소 밖, 이랜드 매입가 포함)의 셀을 직접 고쳐 서식을 그대로 유지한다.
 *   · 탭 1 '건강약용 매입요청': 점포 열(M~AP) × 상품 행(H열 바코드)에 점포별 수량
 *   · 탭 2 '기존 구매오더(원본)': 이랜드 PORInfo 값을 열 그대로 — 계산·보정 없음(금액도 이랜드 파일의 금액 칸 그대로)
 * 템플릿 안의 매입단가(J열)가 이랜드 단가와 다르면 issues 에 확인 필요로 남긴다.
 */
import JSZip from 'jszip'
import { POR_COLUMNS, type Plan, type PorRow } from './kimsFriday'

const colNum = (c: string) => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
const colName = (n: number) => {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const unesc = (s: string) => s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const excelSerial = (yyyymmdd: string) => Math.round((Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) - Date.UTC(1899, 11, 30)) / 86400000)
const NUMERIC_COLS = new Set(['구매문서', '품목번호', '점포코드', '업체코드', '상품코드', '오더수량', '입수', 'BOX', '단가', '금액'])
const DATE_COLS = new Set(['구매오더일', '납품요청일'])

export async function buildMdWorkbook(template: Buffer, plan: Plan, por: PorRow[]): Promise<{ buf: Buffer; issues: string[] }> {
  const issues: string[] = []
  const zip = await JSZip.loadAsync(template)
  const f1 = zip.file('xl/worksheets/sheet1.xml')
  const f2 = zip.file('xl/worksheets/sheet2.xml')
  if (!f1 || !f2) throw new Error('MD 템플릿에 sheet1/sheet2 가 없음')
  let s1 = await f1.async('string')

  // 헤더(2행) 점포 이름 → 열, 상품코드(H열) → 행, 템플릿 매입단가(J열) → 행
  const storeCols = new Map<string, string>()
  const hm = /<row [^>]*r="2"[^>]*>([\s\S]*?)<\/row>/.exec(s1)
  if (!hm) throw new Error('MD 템플릿 2행(점포 이름 헤더)을 못 찾음')
  for (const m of hm[1].matchAll(/<c r="([A-Z]+)2"[^>]*>([\s\S]*?)<\/c>/g)) {
    const col = m[1]
    if (colNum(col) < colNum('M') || colNum(col) > colNum('AP')) continue
    const t = unesc(m[2].replace(/<[^>]+>/g, '')).trim()
    if (t) storeCols.set(t, col)
  }
  const productRows = new Map<string, number>()
  const tplPrice = new Map<string, number>()
  for (const m of s1.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = Number(m[1])
    if (r < 3) continue
    const cell = (c: string) => new RegExp(`<c r="${c}${r}"[^>]*>([\\s\\S]*?)</c>`).exec(m[2])
    const h = cell('H')
    if (!h) continue
    const code = unesc(h[1].replace(/<[^>]+>/g, '')).trim()
    productRows.set(code, r)
    const j = cell('J')
    if (j) tplPrice.set(code, Number(unesc(j[1].replace(/<[^>]+>/g, '')).replace(/[ ,]/g, '')))
  }

  // 이전 수량 전부 비우기 (M..AP, 3행~)
  s1 = s1.replace(/<c r="([A-Z]+)(\d+)"( s="\d+")?( t="n")?>(?:<v>[^<]*<\/v>)?<\/c>/g, (full, col: string, row: string, st: string | undefined) => {
    const n = colNum(col)
    if (Number(row) >= 3 && n >= colNum('M') && n <= colNum('AP')) return `<c r="${col}${row}"${st ?? ''} t="n"></c>`
    return full
  })

  const norm = (n: string) => n.replace(/\s+/g, '').replace(/점$/, '').replace(/킴스$/, '')
  const storeColByNorm = new Map([...storeCols].map(([k, v]) => [norm(k), v]))
  for (const sp of plan.stores) {
    const col = storeColByNorm.get(norm(sp.storeName)) ?? storeColByNorm.get(norm(sp.info?.name ?? ''))
    if (!col) {
      issues.push(`MD 엑셀 헤더에 없는 점포: ${sp.storeName} — 수량을 못 넣었음, 직접 열 추가 필요`)
      continue
    }
    for (const l of sp.lines) {
      const row = productRows.get(l.barcode.trim())
      if (!row) {
        issues.push(`MD 엑셀 양식에 없는 상품: ${l.name} (${l.barcode}) — ${sp.storeName} 수량을 못 넣었음, 직접 행 추가 필요`)
        continue
      }
      const re = new RegExp(`<c r="${col}${row}"( s="\\d+")?( t="n")?></c>`)
      if (!re.test(s1)) {
        issues.push(`MD 엑셀 ${col}${row} 칸을 못 찾음 (${sp.storeName} ${l.name})`)
        continue
      }
      s1 = s1.replace(re, (_m, st: string | undefined) => `<c r="${col}${row}"${st ?? ''} t="n"><v>${l.qty}</v></c>`)
    }
  }
  // 템플릿 매입단가 ≠ 이랜드 단가
  for (const p of por) {
    const t = tplPrice.get(p.code.trim())
    if (t !== undefined && Number.isFinite(t) && t !== p.price) issues.push(`MD 엑셀 양식의 매입단가(${p.name} ${t.toLocaleString('ko-KR')})가 이랜드 구매오더 단가(${p.price.toLocaleString('ko-KR')})와 다름 — 양식 단가는 안 바꿨음, 확인 필요`)
  }
  zip.file('xl/worksheets/sheet1.xml', s1)

  // 원본 탭: 이랜드 PORInfo 한 줄씩, 열 이름 그대로 (A~Q = POR_COLUMNS 순서). 계산 없음
  let s2 = await f2.async('string')
  const rows = por
    .map((p, i) => {
      const r = i + 2
      const cells = POR_COLUMNS.map((name, j) => {
        const c = colName(j + 1)
        const v = p.raw[name] ?? ''
        if (v === '') {
          if (name === '금액') issues.push(`구매오더 ${p.name}: 이랜드 파일의 금액 칸이 비어 있음 — 원본 탭 금액을 비워 둠`)
          return `<c r="${c}${r}" s="1"></c>`
        }
        if (DATE_COLS.has(name)) {
          const ymdv = v.replace(/-/g, '')
          return /^\d{8}$/.test(ymdv) ? `<c r="${c}${r}" s="31" t="n"><v>${excelSerial(ymdv)}</v></c>` : `<c r="${c}${r}" s="1" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
        }
        if (NUMERIC_COLS.has(name) && Number.isFinite(Number(v.replace(/,/g, '')))) return `<c r="${c}${r}" s="1" t="n"><v>${Number(v.replace(/,/g, ''))}</v></c>`
        return `<c r="${c}${r}" s="1" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
      }).join('')
      return `<row r="${r}">${cells}</row>`
    })
    .join('')
  if (!/<row r="1"[\s\S]*?<\/row>[\s\S]*?<\/sheetData>/.test(s2)) throw new Error('MD 템플릿 원본 탭 구조(1행 헤더)를 못 찾음')
  s2 = s2.replace(/(<row r="1"[\s\S]*?<\/row>)[\s\S]*?(<\/sheetData>)/, (_m, a: string, b: string) => `${a}${rows}${b}`).replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:Q${por.length + 1}"/>`)
  zip.file('xl/worksheets/sheet2.xml', s2)
  return { buf: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), issues }
}
