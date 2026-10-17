import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { MASTER_SHEET_ID } from '@/lib/sheet-ids';
import { MARGIN_TAB, PRICE_TAB, marginMasterFromSheet, type SheetCell } from '@/lib/coupang/marginFromSheet';

/**
 * 쿠팡 마진마스터 — 나무_마스터 '마진계산' 탭 소스 (서비스 계정 · 읽기 전용)
 *
 * 이전: 옛 마진마스터 구글시트 게시 CSV → parseMarginRows.
 * 변경: 나무_마스터 마진계산에서 채널 = '쿠팡 3P' 이고 옵션ID(X)가 있는 행만 읽어
 *       parseMarginRows 결과(MarginCalcRow)와 같은 모양으로 변환해 돌려준다. 1P·스마트스토어 제외.
 *
 * 열 대응: W 노출ID · X 옵션ID · B 별칭 · C 봉수 · D 판매가 · F 원가 · G 봉투 · H 규격 · I 박스 · J 택배 ·
 *         K 수수료율(부가포함 %, ÷100) · L 수수료 · N 총비용 · O 마진(=순이익) · P 마진율
 * BEP ROAS = D ÷ O (×1.1 없음 — 옛 마진마스터 기준). O ≤ 0 이면 null.
 * 옵션명 = "별칭, N개"(봉수 파싱용 — 그대로 유지) · 쿠팡 옵션명(AD) = coupangOptionName(화면 표시용)
 * 1봉kg = 단가DB g ÷ 1000 · 최종채널 = '윙'.
 * 대응 열이 없는 필드는 parseMarginRows 의 빈값 규칙과 같게 채운다.
 *
 * 반환: { ok, marginRows, onePRows } — marginRows 단위는 기존 게시 CSV 라우트 정규화 결과와 동일(수수료율·마진율 소수, BEP 배율).
 *       onePRows = '쿠팡 1P' 행 (옵션ID·SKU·별칭·봉수·마진·1봉당 마진·과세·쿠팡 옵션명) — 광고 분석 1P 계산용.
 */

export const runtime = 'nodejs';
export const revalidate = 0;

function getSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT 환경변수가 설정되지 않았습니다.');
  const creds = JSON.parse(raw);
  if (typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export async function GET(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 진단·광고 분석
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: MASTER_SHEET_ID,
      ranges: [`${quote(MARGIN_TAB)}!A2:AD`, `${quote(PRICE_TAB)}!A2:J`],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const margin = (res.data.valueRanges?.[0]?.values || []) as SheetCell[][];
    const price = (res.data.valueRanges?.[1]?.values || []) as SheetCell[][];
    const { marginRows, onePRows: oneP } = marginMasterFromSheet(margin, price);
    return NextResponse.json({ ok: true, marginRows, onePRows: oneP });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err), marginRows: [] }, { status: 500 });
  }
}
