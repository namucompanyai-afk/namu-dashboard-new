import { requireRole } from '@/lib/server-auth'
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { MASTER_SHEET_ID } from '@/lib/sheet-ids';
import type { MarginCalcRow } from '@/lib/coupang/parsers/marginMaster';

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
 * 옵션명 = "별칭, N개" · 1봉kg = 단가DB g ÷ 1000 · 최종채널 = '윙'.
 * 대응 열이 없는 필드는 parseMarginRows 의 빈값 규칙과 같게 채운다.
 *
 * 반환: { ok, marginRows } — 단위는 기존 게시 CSV 라우트 정규화 결과와 동일(수수료율·마진율 소수, BEP 배율).
 */

export const runtime = 'nodejs';
export const revalidate = 0;

const MARGIN_TAB = '마진계산';
const PRICE_TAB = '단가DB';
const CHANNEL = '쿠팡 3P';

type Cell = string | number | boolean | null | undefined;

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
const str = (v: Cell) => (v == null ? '' : String(v).trim());
const num = (v: Cell) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')));

export async function GET(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 진단·광고 분석
  const denied = requireRole(req, ['admin'])
  if (denied) return denied
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: MASTER_SHEET_ID,
      ranges: [`${quote(MARGIN_TAB)}!A2:AC`, `${quote(PRICE_TAB)}!A2:F`],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const margin = (res.data.valueRanges?.[0]?.values || []) as Cell[][];
    const price = (res.data.valueRanges?.[1]?.values || []) as Cell[][];
    const gramOf = new Map(price.map((r) => [str(r[0]), num(r[5])]));

    const marginRows: MarginCalcRow[] = [];
    for (const r of margin) {
      if (str(r[0]) !== CHANNEL) continue;
      const optionId = str(r[23]);
      if (!optionId || !/^\d+$/.test(optionId)) continue;
      const actualPrice = num(r[3]);
      if (!Number.isFinite(actualPrice) || actualPrice <= 0) continue;

      const alias = str(r[1]);
      const bagCount = num(r[2]) || 1;
      const g = gramOf.get(alias);
      const kgPerBag = g && Number.isFinite(g) && g > 0 ? g / 1000 : 1;
      const fin = (v: Cell) => (Number.isFinite(num(v)) && str(v) !== '' ? num(v) : NaN);
      const netProfit = fin(r[14]);
      const marginRate = fin(r[15]);
      const feePct = fin(r[10]);

      marginRows.push({
        exposureId: str(r[22]),
        optionId,
        alias,
        optionName: `${alias}, ${bagCount}개`,
        totalKg: 0,
        bagCount,
        kgPerBag,
        listPrice: actualPrice,
        actualPrice,
        perUnitPrice: actualPrice,
        priceBand: '',
        autoChannel: '',
        manualChannel: '',
        channel: '윙',
        size: str(r[7]),
        costPrice: fin(r[5]) || 0,
        bagFee: fin(r[6]) || 0,
        boxFee: fin(r[8]) || 0,
        shipFee: fin(r[9]) || 0,
        warehouseFee: 0,
        grossShipFee: 0,
        inoutFee: 0,
        feeRate: Number.isFinite(feePct) ? feePct / 100 : 0,
        packagingFee: 0,
        coupangFee: fin(r[11]) || 0,
        totalCost: fin(r[13]) || 0,
        netProfit: Number.isFinite(netProfit) ? netProfit : null,
        marginRate: Number.isFinite(marginRate) ? marginRate : null,
        bepRoas: Number.isFinite(netProfit) && netProfit > 0 ? actualPrice / netProfit : null,
      });
    }
    return NextResponse.json({ ok: true, marginRows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err), marginRows: [] }, { status: 500 });
  }
}
