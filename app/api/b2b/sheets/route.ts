import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { parseProductMaster, parseMilkrunPrices } from '@/lib/b2b/kurly'
import { parseCenters } from '@/lib/b2b/coupang'
import { parseCoupangMilkrun } from '@/lib/b2b/coupangMilkrun'

/**
 * B2B 발주 변환 공용 기준정보 — 구글시트 read-only API (컬리·쿠팡 공용).
 *
 * 진도팜 원가표(app/api/jindopam/cost)와 동일한 서비스 계정 방식이되,
 * 이 라우트는 읽기 전용이다 — scope 를 spreadsheets.readonly 로 고정하고
 * values.update/append/clear 등 쓰기 호출은 두지 않는다.
 *
 * GET /api/b2b/sheets        → { ok, products, prices, centers, coupangPrices }
 * GET /api/b2b/sheets?debug=1 → + { debug: 탭 목록·헤더 } (컬럼명 확인용)
 */

export const runtime = 'nodejs'
export const revalidate = 0

const SHEET_ID = '1nujXWT95QWnYBX1LpSAL1hLL3Uv8MBt7kJDz8i6WbFU'
const TAB_PRODUCT = '상품마스터'
const TAB_PRICE = '컬리 밀크런 가격표'
const TAB_CENTER = '쿠팡 센터 주소록'
const TAB_CP_PRICE = '쿠팡 밀크런 가격표'

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`

function getSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 환경변수가 설정되지 않았습니다.')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  return google.sheets({ version: 'v4', auth })
}

export async function GET(req: Request) {
  try {
    const debug = new URL(req.url).searchParams.get('debug') === '1'
    const sheets = getSheets()

    // 탭이 없어도 나머지는 살려야 하므로 실제 존재하는 탭만 요청한다
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets(properties(title))',
    })
    const titles = (meta.data.sheets || []).map((s) => s.properties?.title || '')
    const has = (t: string) => titles.includes(t)

    const wanted: { tab: string; range: string }[] = []
    if (has(TAB_PRODUCT)) wanted.push({ tab: TAB_PRODUCT, range: `${quote(TAB_PRODUCT)}!A1:Z` })
    if (has(TAB_PRICE)) wanted.push({ tab: TAB_PRICE, range: `${quote(TAB_PRICE)}!A1:J` })
    if (has(TAB_CENTER)) wanted.push({ tab: TAB_CENTER, range: `${quote(TAB_CENTER)}!A1:Z` })
    if (has(TAB_CP_PRICE)) wanted.push({ tab: TAB_CP_PRICE, range: `${quote(TAB_CP_PRICE)}!A1:ZZ` })

    const res = wanted.length
      ? await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SHEET_ID,
          ranges: wanted.map((w) => w.range),
          valueRenderOption: 'UNFORMATTED_VALUE',
        })
      : { data: { valueRanges: [] } }

    const valuesOf = (tab: string): unknown[][] => {
      const i = wanted.findIndex((w) => w.tab === tab)
      if (i < 0) return []
      return ((res.data.valueRanges || [])[i]?.values as unknown[][]) || []
    }

    const productRows = valuesOf(TAB_PRODUCT)
    const centerRows = valuesOf(TAB_CENTER)

    const body: Record<string, unknown> = {
      ok: true,
      products: parseProductMaster(productRows),
      prices: parseMilkrunPrices(valuesOf(TAB_PRICE)),
      centers: parseCenters(centerRows),
      coupangPrices: parseCoupangMilkrun(valuesOf(TAB_CP_PRICE)),
      missingTabs: [TAB_PRODUCT, TAB_PRICE, TAB_CENTER, TAB_CP_PRICE].filter((t) => !has(t)),
    }
    if (debug) {
      body.debug = {
        tabs: titles,
        productHeader: productRows[0] || [],
        centerHeader: centerRows[0] || [],
        centerSample: centerRows.slice(1, 4),
        coupangPriceHeader: (valuesOf(TAB_CP_PRICE)[0] || []).slice(0, 8),
      }
    }

    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '서버 오류'
    console.error('[b2b/sheets] read error:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
