import { requireRole } from "@/lib/server-auth"
import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

/**
 * 쿠팡 마스터 데이터 API
 *
 * type별로 dashboard_data 테이블에 저장:
 *   - coupang_margin_master  : 마진 마스터 (마진분석.xlsx 파싱 결과 — 쿠팡 마진계산_쿠팡 시트)
 *   - coupang_settlement     : 그로스 정산
 *   - coupang_price_inventory: 가격/재고
 *   - coupang_naver_match    : 네이버 상품매칭 (마진마스터 "네이버상품매칭" 시트, Map → object)
 *   - coupang_naver_margin   : 네이버 마진계산 (마진마스터 "마진계산_네이버" 시트, Map → object)
 *
 * GET    /api/coupang-master?type=margin_master   → 데이터 받기
 * POST   /api/coupang-master                       → 저장 (type, data, fileName 포함)
 * DELETE /api/coupang-master?type=margin_master   → 삭제
 */

const VALID_TYPES = [
  'margin_master',
  'settlement',
  'price_inventory',
  'naver_match',
  'naver_margin',
  'naver_cpm',
] as const;
// 쿠팡 손익 월별 저장본 — pnl_{종류}_{YYYY-MM} (광고 요약·3P 판매·1P 판매·발주서·밀크런 정산·접수 내역). 관리자만.
const PNL_TYPE = /^pnl_(ad|seller|onep_sales|po|mr_settle|mr_list)_\d{4}-\d{2}$/;
type DataType = typeof VALID_TYPES[number] | `pnl_${string}`;

/** Supabase 오류는 Error 가 아닌 객체({message, code, details, hint}) — 사람이 읽을 문장으로 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: string; details?: string; hint?: string };
    const parts = [e.message, e.details, e.hint, e.code && `(code ${e.code})`].filter(Boolean);
    return parts.length ? parts.join(' · ') : JSON.stringify(err);
  }
  return String(err);
}

function getKey(type: DataType): string {
  return `coupang_${type}`;
}

function isValidType(t: string): t is DataType {
  return VALID_TYPES.includes(t as typeof VALID_TYPES[number]) || PNL_TYPE.test(t);
}

/** pnl_ 월별 손익 데이터는 관리자만 */
function pnlDenied(request: Request, type: string) {
  return type.startsWith('pnl_') ? requireRole(request, ['admin']) : null;
}

/** 데이터 받기 */
export async function GET(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석·진단·데이터 관리·스스 진단
  const denied = requireRole(request, ['admin', 'guest'])
  if (denied) return denied
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');

    if (!type || !isValidType(type)) {
      return NextResponse.json(
        { error: 'type 파라미터 필요: margin_master | settlement | price_inventory' },
        { status: 400 }
      );
    }

    const pd = pnlDenied(request, type);
    if (pd) return pd;
    const saved = await getData(getKey(type));
    if (!saved) {
      return NextResponse.json({ data: null, fileName: null, savedAt: null });
    }

    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json({ error: errText(err) }, { status: 500 });
  }
}

/** 데이터 저장 */
export async function POST(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석·진단·데이터 관리·스스 진단
  const denied = requireRole(request, ['admin', 'guest'])
  if (denied) return denied
  try {
    const body = await request.json();
    const { type, data, fileName, uploadedBy } = body;

    if (!type || !isValidType(type)) {
      return NextResponse.json(
        { error: 'type 필요: margin_master | settlement | price_inventory' },
        { status: 400 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'data 필요' }, { status: 400 });
    }
    const pd = pnlDenied(request, type);
    if (pd) return pd;

    await saveData(getKey(type), {
      data,
      fileName: fileName || null,
      uploadedBy: uploadedBy || null,
      savedAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: errText(err) }, { status: 500 });
  }
}

/** 데이터 삭제 */
export async function DELETE(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석·진단·데이터 관리·스스 진단
  const denied = requireRole(request, ['admin', 'guest'])
  if (denied) return denied
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');

    if (!type || !isValidType(type)) {
      return NextResponse.json(
        { error: 'type 파라미터 필요' },
        { status: 400 }
      );
    }

    const pd = pnlDenied(request, type);
    if (pd) return pd;
    // 빈 객체로 덮어쓰기 (saveData가 upsert임)
    await saveData(getKey(type), {
      data: null,
      fileName: null,
      uploadedBy: null,
      savedAt: null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: errText(err) }, { status: 500 });
  }
}
