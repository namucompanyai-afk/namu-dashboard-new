import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import * as XLSX from 'xlsx'

export const revalidate = 0
export const dynamic = 'force-dynamic'

/**
 * 진도팜 정산 대시보드 데이터 소스
 *
 * 구글 드라이브 공유문서함 진도팜/2026 폴더의 월별 xlsx(2026.1 ~ 2026.07 …)를
 * 서비스계정으로 읽어 정산/세일즈 지표를 계산한다. 파일명 표기가 불규칙하므로
 * "2026" + 뒤따르는 숫자를 월로 매칭한다.
 *
 * actions (GET ?action=):
 *   - whoami     : 서비스계정 client_email 반환 (폴더 공유 대상 확인용)
 *   - list       : 2026 폴더의 xlsx 목록 + 매칭된 월
 *   - introspect : ?month=YYYY-MM 파일의 시트명 + 샘플 로우 (스키마 파악용)
 *   - data       : ?month=YYYY-MM 정산 계산 결과 (파악 가능한 부분만, 나머지 미연동)
 *
 * 폴더 탐색이 실패하면(권한 없음) whoami 이메일을 공유해야 한다.
 * 환경변수 JINDOPAM_DRIVE_FOLDER_ID 로 2026 폴더 ID를 직접 지정하면 이름탐색을 건너뛴다.
 */

// ── 참고표 단가 (진도팜 원가표 배송비 기준표와 동일) ──────────────────
const TAKBAE_UNIT: Record<string, number> = { 소: 2100, 중: 2800, 대: 4400 }
const BOX_UNIT: Record<string, number> = { 소: 427, 중: 1291, 대: 1495 }

function getCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 환경변수가 설정되지 않았습니다.')
  const creds = JSON.parse(raw)
  if (typeof creds.private_key === 'string') {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n')
  }
  return creds
}

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: getCreds(),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  })
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() })
}

// 공유드라이브 포함 파일 검색 공통 옵션
const ALL_DRIVES = {
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
  corpora: 'allDrives' as const,
}

// 파일명에서 연·월 추출 (2026.1 / 2026.07 / 2026-7 / 2026_07 등 불규칙 대응)
function monthKeyFromName(name: string): string | null {
  const base = name.replace(/\.xlsx?$/i, '')
  const m = base.match(/(20\d{2})\D+(\d{1,2})/)
  if (!m) return null
  const y = m[1]
  const mo = String(parseInt(m[2], 10)).padStart(2, '0')
  if (parseInt(mo, 10) < 1 || parseInt(mo, 10) > 12) return null
  return `${y}-${mo}`
}

// 2026 폴더 ID 탐색: env 우선, 없으면 이름으로 진도팜 → 2026 순차 탐색
async function find2026FolderId(drive: ReturnType<typeof getDrive>): Promise<string> {
  const envId = process.env.JINDOPAM_DRIVE_FOLDER_ID
  if (envId) return envId

  const folderQ = "mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  // 1) 직접 공유(sharedWithMe)된 폴더 우선 — 폴더만 공유하면 여기로 들어옴
  const shared = await drive.files.list({
    q: `sharedWithMe = true and ${folderQ}`,
    fields: 'files(id,name,parents)',
    pageSize: 100,
    ...ALL_DRIVES,
  })
  const sharedFolders = shared.data.files || []
  // 이름이 정확히 2026, 없으면 2026 포함
  const s2026 =
    sharedFolders.find((f) => (f.name || '') === '2026') ||
    sharedFolders.find((f) => (f.name || '').includes('2026'))
  if (s2026?.id) return s2026.id
  // 진도팜 폴더가 공유됐으면 그 하위 2026 탐색
  for (const jf of sharedFolders.filter((f) => (f.name || '').includes('진도팜'))) {
    const sub = await drive.files.list({
      q: `'${jf.id}' in parents and ${folderQ}`,
      fields: 'files(id,name)',
      pageSize: 50,
      ...ALL_DRIVES,
    })
    const hit = (sub.data.files || []).find((f) => (f.name || '').includes('2026'))
    if (hit?.id) return hit.id
  }

  // 2) 전역 이름검색 폴백
  const any2026 = await drive.files.list({
    q: `name = '2026' and ${folderQ}`,
    fields: 'files(id,name,parents)',
    pageSize: 20,
    ...ALL_DRIVES,
  })
  const direct = (any2026.data.files || [])[0]
  if (direct?.id) return direct.id
  throw new Error('2026 폴더를 찾지 못했습니다. (서비스계정 공유 또는 JINDOPAM_DRIVE_FOLDER_ID 필요)')
}

// 2026 폴더의 xlsx 목록 + 월키. folderId 지정 시 이름탐색 건너뜀.
async function listMonthlyFiles(drive: ReturnType<typeof getDrive>, folderIdOverride?: string) {
  const folderId = folderIdOverride || (await find2026FolderId(drive))
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)',
    pageSize: 200,
    orderBy: 'name',
    ...ALL_DRIVES,
  })
  const files = (res.data.files || [])
    .filter((f) => /\.xlsx?$/i.test(f.name || '') || f.mimeType?.includes('spreadsheet'))
    .map((f) => ({
      id: f.id!,
      name: f.name!,
      mimeType: f.mimeType!,
      modifiedTime: f.modifiedTime || '',
      month: monthKeyFromName(f.name || ''),
    }))
  return { folderId, files }
}

// 월키로 파일 하나 선택 (동일 월 다중이면 최신 수정본)
async function fileForMonth(drive: ReturnType<typeof getDrive>, month: string, folderId?: string) {
  const { files } = await listMonthlyFiles(drive, folderId)
  const cand = files
    .filter((f) => f.month === month)
    .sort((a, b) => (b.modifiedTime > a.modifiedTime ? 1 : -1))
  return cand[0] || null
}

// Drive에서 xlsx 다운로드 → 워크북 파싱
async function readWorkbook(drive: ReturnType<typeof getDrive>, fileId: string, mimeType: string) {
  let buf: Buffer
  if (mimeType.includes('google-apps.spreadsheet')) {
    // 구글시트면 xlsx로 export
    const res = await drive.files.export(
      { fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { responseType: 'arraybuffer' },
    )
    buf = Buffer.from(res.data as ArrayBuffer)
  } else {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    )
    buf = Buffer.from(res.data as ArrayBuffer)
  }
  return XLSX.read(buf, { type: 'buffer' })
}

// 시트를 2차원 배열로 (header:1). 없으면 null
function sheetRows(wb: XLSX.WorkBook, name: string): any[][] | null {
  const ws = wb.Sheets[name]
  if (!ws) return null
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as any[][]
}

// 시트명 유연 매칭 (공백/유사어)
function findSheetName(wb: XLSX.WorkBook, candidates: string[]): string | null {
  const names = wb.SheetNames
  for (const c of candidates) {
    const exact = names.find((n) => n.replace(/\s/g, '') === c.replace(/\s/g, ''))
    if (exact) return exact
  }
  for (const c of candidates) {
    const partial = names.find((n) => n.replace(/\s/g, '').includes(c.replace(/\s/g, '')))
    if (partial) return partial
  }
  return null
}

const nowKstMonth = () => {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action') || 'data'
  const month = searchParams.get('month') || ''
  const folderId = searchParams.get('folderId') || undefined // 이름탐색 대신 폴더ID 직접 지정

  // whoami는 Drive 접근 없이도 동작해야 함 (공유 대상 이메일 안내용)
  if (action === 'whoami') {
    try {
      const creds = getCreds()
      return NextResponse.json({ ok: true, clientEmail: creds.client_email || null })
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || '서비스계정 로드 실패' }, { status: 500 })
    }
  }

  let clientEmail: string | null = null
  try {
    clientEmail = getCreds().client_email || null
  } catch {
    /* 아래에서 처리 */
  }

  try {
    const drive = getDrive()

    // 서비스계정이 볼 수 있는 것 진단 (폴더 탐색 실패 원인 파악용)
    if (action === 'debug') {
      const folders = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'files(id,name,parents,driveId)',
        pageSize: 50,
        ...ALL_DRIVES,
      })
      const sharedDrives = await drive.drives.list({ pageSize: 50 }).catch(() => ({ data: { drives: [] } }))
      const sharedWithMe = await drive.files.list({
        q: 'sharedWithMe = true and trashed = false',
        fields: 'files(id,name,mimeType,parents)',
        pageSize: 100,
        ...ALL_DRIVES,
      })
      const anyFiles = await drive.files.list({
        q: "name contains '2026' and trashed = false",
        fields: 'files(id,name,mimeType,parents)',
        pageSize: 50,
        ...ALL_DRIVES,
      })
      return NextResponse.json({
        ok: true,
        clientEmail,
        visibleFolders: (folders.data.files || []).map((f) => ({ id: f.id, name: f.name, driveId: f.driveId })),
        sharedDrives: (sharedDrives.data.drives || []).map((d) => ({ id: d.id, name: d.name })),
        sharedWithMe: (sharedWithMe.data.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
        filesNamed2026: (anyFiles.data.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents })),
      })
    }

    if (action === 'list') {
      const r = await listMonthlyFiles(drive, folderId)
      return NextResponse.json({ ok: true, folderId: r.folderId, files: r.files, clientEmail })
    }

    if (action === 'introspect') {
      if (!month) return NextResponse.json({ ok: false, error: 'month 필요' }, { status: 400 })
      const f = await fileForMonth(drive, month, folderId)
      if (!f) return NextResponse.json({ ok: false, error: `${month} 파일 없음`, clientEmail }, { status: 404 })
      const wb = await readWorkbook(drive, f.id, f.mimeType)
      const sample: Record<string, any[][]> = {}
      for (const sn of wb.SheetNames) {
        const rows = sheetRows(wb, sn) || []
        sample[sn] = rows.slice(0, 25) // 상단 25행만
      }
      return NextResponse.json({ ok: true, file: f, sheetNames: wb.SheetNames, sample })
    }

    if (action === 'data') {
      if (!month) return NextResponse.json({ ok: false, error: 'month 필요' }, { status: 400 })
      const f = await fileForMonth(drive, month, folderId)
      if (!f) {
        return NextResponse.json({
          ok: true,
          month,
          status: 'no-file',
          clientEmail,
        })
      }
      const wb = await readWorkbook(drive, f.id, f.mimeType)
      const result = computeSettlement(wb, month, f)
      return NextResponse.json({ ok: true, ...result })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (e: any) {
    const msg = e?.message || String(e)
    const isAccess = /permission|not found|찾지 못|403|404|insufficient/i.test(msg)
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        // 폴더 접근 실패면 공유해야 할 서비스계정 이메일 안내
        needsShare: isAccess,
        clientEmail,
      },
      { status: isAccess ? 403 : 500 },
    )
  }
}

// ── 정산 계산 ─────────────────────────────────────────────────────────
// 파악 가능한 집계만 채우고, 매핑 미확정(내품명→단가, 정산분해 채널)은 null(미연동)로 남긴다.
function computeSettlement(wb: XLSX.WorkBook, month: string, file: { name: string }) {
  const status = month >= nowKstMonth() ? 'in-progress' : 'complete'

  // 1) 발주 취합 → 상품별 수량 집계
  const orderSheet = findSheetName(wb, ['발주 취합', '발주취합'])
  const products = orderSheet ? aggregateProducts(sheetRows(wb, orderSheet)) : null

  // 2) 택배 시트 → 규격별 건수 → 택배비/박스비
  const takbaeSheet = findSheetName(wb, ['택배'])
  const delivery = takbaeSheet ? computeDelivery(sheetRows(wb, takbaeSheet)) : null

  return {
    month,
    status,
    fileName: file.name,
    sheetNames: wb.SheetNames,
    orderSheet,
    takbaeSheet,
    products, // [{name, qty, unitPrice:null, subtotal:null}] — 단가 미연동
    delivery, // {takbae, box, byChannel, bySize} 또는 null
    // 정산 분해 6항목: 채널→항목 매핑 미확정 → 미연동
    breakdown: null as null | Array<{ label: string; amount: number | null }>,
  }
}

// 헤더 행에서 컬럼 인덱스 찾기 (부분일치)
function colIndex(header: any[], keys: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '').replace(/\s/g, '')
    if (keys.some((k) => h.includes(k.replace(/\s/g, '')))) return i
  }
  return -1
}

// 데이터 시작 행(헤더) 찾기: 내품명/내품수량 포함 행
function findHeaderRow(rows: any[][], keys: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const joined = (rows[i] || []).map((c) => String(c || '').replace(/\s/g, '')).join('|')
    if (keys.every((k) => joined.includes(k.replace(/\s/g, '')))) return i
  }
  return -1
}

function aggregateProducts(rows: any[][] | null): Array<{ name: string; qty: number; unitPrice: number | null; subtotal: number | null }> | null {
  if (!rows || !rows.length) return null
  const hr = findHeaderRow(rows, ['내품명', '내품수량'])
  if (hr < 0) return null
  const header = rows[hr]
  const nameIdx = colIndex(header, ['내품명', '상품', '품목'])
  const qtyIdx = colIndex(header, ['내품수량', '수량'])
  if (nameIdx < 0 || qtyIdx < 0) return null

  const agg = new Map<string, number>()
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i] || []
    const name = String(r[nameIdx] ?? '').trim()
    if (!name) continue
    const qty = Number(String(r[qtyIdx] ?? '').replace(/[^0-9.-]/g, '')) || 0
    agg.set(name, (agg.get(name) || 0) + qty)
  }
  return [...agg.entries()]
    .map(([name, qty]) => ({ name, qty, unitPrice: null, subtotal: null }))
    .sort((a, b) => b.qty - a.qty)
}

// 택배 시트 → 규격(소/중/대)별 총건수 → 택배비/박스비
// 시트 구조 불확실 → 전 셀에서 소/중/대 라벨 인접 숫자를 합산하는 방식은 위험하므로
// 우선 규격 라벨 컬럼 + 건수 합산을 시도하고, 실패 시 null 반환(미연동).
function computeDelivery(rows: any[][] | null):
  | null
  | {
      takbae: { total: number; bySize: Record<string, number> }
      box: { total: number; bySize: Record<string, number> }
      counts: Record<string, number>
      note: string
    } {
  if (!rows || !rows.length) return null
  // 스키마 확정 전에는 임의 계산을 하지 않는다 (미연동).
  // introspect로 실제 레이아웃 확인 후 이 함수를 구현한다.
  return null
}
