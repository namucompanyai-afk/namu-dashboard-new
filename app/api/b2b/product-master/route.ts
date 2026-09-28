import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireRole } from '@/lib/server-auth'
import { MASTER_SHEET_ID } from '@/lib/sheet-ids'

/**
 * B2B 발주 변환(쿠팡) — 상품마스터 미등록 상품 행 추가. 관리자만.
 *
 * 나무_마스터 '상품마스터' 탭 맨 아래에 상품별 1행 "추가"만 한다 (기존 행 수정·삭제 없음, 다른 탭 쓰기 없음).
 *   자동: A 채널=쿠팡 · C 상품명 · F 쿠팡 SKU ID · G 쿠팡 공급가(발주서 매입가) · L 바코드
 *   D 과세 구분: 바로 위 행 수식을 읽어 행 번호만 바꿔 씀 (행별 수식, ARRAYFORMULA 없음)
 *   빈칸 + 노란 배경: B 별칭 · E 박스입수 · M 출고지 · N~P 박스 치수 · Q 요금표 출고지
 * 중복 방지: 바코드 또는 쿠팡 SKU ID 가 이미 있으면 추가 안 함 (요청 안 중복도 제거)
 *
 * POST { items: [{ name, skuId, supply, barcode }] } → { ok, added, skipped, rows: [추가된 행 번호] }
 */

export const runtime = 'nodejs'

const TAB = '상품마스터'
const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`
const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, '').trim()

function getSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 환경변수가 설정되지 않았습니다.')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  return google.sheets({ version: 'v4', auth })
}

type Item = { name: string; skuId: string; supply: number; barcode: string }

export async function POST(req: Request) {
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const body = await req.json().catch(() => null)
    const items: Item[] = Array.isArray(body?.items) ? body.items : []
    if (!items.length) return NextResponse.json({ ok: false, error: 'items 필요' }, { status: 400 })

    const sheets = getSheets()
    const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID, fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))' })
    const tabProps = meta.data.sheets?.find((s) => s.properties?.title === TAB)?.properties
    const sheetId = tabProps?.sheetId
    const gridRows = tabProps?.gridProperties?.rowCount ?? 0
    if (sheetId == null) return NextResponse.json({ ok: false, error: `'${TAB}' 탭이 없습니다` }, { status: 500 })

    const [fRes, vRes] = await Promise.all(
      (['FORMULA', 'UNFORMATTED_VALUE'] as const).map((o) =>
        sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${quote(TAB)}!A1:Q`, valueRenderOption: o }),
      ),
    )
    const formulas = (fRes.data.values || []) as unknown[][]
    const values = (vRes.data.values || []) as unknown[][]
    const header = (values[0] || []).map(norm)
    const expect = ['채널', '별칭', '상품명', '과세구분', '박스입수', '쿠팡SKUID', '쿠팡공급가']
    if (expect.some((h, i) => header[i] !== h) || header[11] !== '바코드') {
      return NextResponse.json({ ok: false, error: `상품마스터 머리글이 예상과 다릅니다: ${header.slice(0, 12).join('/')}` }, { status: 500 })
    }

    // 마지막 데이터 행 (A~Q 중 값 있는 마지막 행) — 그 아래부터 추가
    let last = values.length // 1-based 행 번호 (머리글 포함)
    while (last > 1 && !(values[last - 1] || []).some((c) => norm(c) !== '')) last--
    const seenBarcode = new Set(values.slice(1).map((r) => norm(r[11])).filter(Boolean))
    const seenSku = new Set(values.slice(1).map((r) => norm(r[5])).filter(Boolean))

    // D 과세 구분: 바로 위(마지막 데이터 행) 수식을 읽어 행 번호만 바꾼다
    const baseD = String((formulas[last - 1] || [])[3] ?? '')
    if (!baseD.startsWith('=')) {
      return NextResponse.json({ ok: false, error: `상품마스터 ${last}행 D열에 수식이 없어 과세 구분 수식을 복사할 수 없습니다` }, { status: 500 })
    }
    const dFor = (row: number) => baseD.replace(new RegExp(`(\\$?[A-Z]{1,2}\\$?)${last}(?!\\d)`, 'g'), `$1${row}`)

    const add: Item[] = []
    let skipped = 0
    for (const it of items) {
      const bc = norm(it.barcode)
      const sku = norm(it.skuId)
      if (!bc && !sku) { skipped++; continue }
      if ((bc && seenBarcode.has(bc)) || (sku && seenSku.has(sku))) { skipped++; continue }
      if (bc) seenBarcode.add(bc)
      if (sku) seenSku.add(sku)
      add.push(it)
    }
    if (!add.length) return NextResponse.json({ ok: true, added: 0, skipped, rows: [] })

    const YELLOW = { red: 1, green: 0.95, blue: 0.6 }
    const need = new Set([1, 4, 12, 13, 14, 15, 16]) // B E M N O P Q (0-based)
    const str = (s: string) => ({ userEnteredValue: { stringValue: s } })
    const rowsOut = add.map((it, i) => {
      const row = last + 1 + i
      const cells: Record<number, object> = {
        0: str('쿠팡'),
        2: str(String(it.name || '').trim()),
        3: { userEnteredValue: { formulaValue: dFor(row) } },
        5: str(String(it.skuId || '').trim()),
        6: Number(it.supply) > 0 ? { userEnteredValue: { numberValue: Number(it.supply) } } : {},
        11: str(String(it.barcode || '').trim()),
      }
      return {
        values: Array.from({ length: 17 }, (_, c) => ({
          ...(cells[c] || {}),
          ...(need.has(c) ? { userEnteredFormat: { backgroundColor: YELLOW } } : {}),
        })),
      }
    })
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: MASTER_SHEET_ID,
      requestBody: {
        requests: [
          // 시트 격자가 모자라면 아래에 행만 늘린다 (기존 행 영향 없음)
          ...(last + add.length > gridRows ? [{ appendDimension: { sheetId, dimension: 'ROWS', length: last + add.length - gridRows } }] : []),
          {
          updateCells: {
            range: { sheetId, startRowIndex: last, endRowIndex: last + add.length, startColumnIndex: 0, endColumnIndex: 17 },
            rows: rowsOut,
            fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
          },
        }],
      },
    })
    return NextResponse.json({ ok: true, added: add.length, skipped, rows: add.map((_, i) => last + 1 + i) })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[b2b/product-master] error:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
