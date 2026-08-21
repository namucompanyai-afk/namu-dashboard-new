import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import {
  parseProductMaster,
  parseMilkrunPrices,
  type ProductMaster,
  type MilkrunPrice,
} from '@/lib/b2b/kurly'

/**
 * B2B 발주 변환(컬리) — 구글시트 read-only API.
 *
 * 진도팜 원가표(app/api/jindopam/cost)와 동일한 서비스 계정 방식.
 * 다만 이 라우트는 읽기 전용이다 — scope 를 spreadsheets.readonly 로 고정하고
 * values.update/append/clear 등 쓰기 호출은 두지 않는다.
 *
 * GET /api/b2b/kurly → { ok, products, prices }
 */

export const runtime = 'nodejs'
export const revalidate = 0

const SHEET_ID = '1nujXWT95QWnYBX1LpSAL1hLL3Uv8MBt7kJDz8i6WbFU'
const TAB_PRODUCT = '상품마스터'
const TAB_PRICE = '컬리 밀크런 가격표'

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`

// 서비스 계정 → sheets 클라이언트 (readonly scope)
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

export async function GET() {
  try {
    const sheets = getSheets()
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: [`${quote(TAB_PRODUCT)}!A1:Z`, `${quote(TAB_PRICE)}!A1:J`],
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    const [productRange, priceRange] = res.data.valueRanges || []
    const products: ProductMaster[] = parseProductMaster((productRange?.values as unknown[][]) || [])
    const prices: MilkrunPrice[] = parseMilkrunPrices((priceRange?.values as unknown[][]) || [])

    return NextResponse.json(
      { ok: true, products, prices },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '서버 오류'
    console.error('[b2b/kurly] read error:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
