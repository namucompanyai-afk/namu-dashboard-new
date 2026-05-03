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
type DataType = typeof VALID_TYPES[number];

function getKey(type: DataType): string {
  return `coupang_${type}`;
}

function isValidType(t: string): t is DataType {
  return VALID_TYPES.includes(t as DataType);
}

/** 데이터 받기 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');

    if (!type || !isValidType(type)) {
      return NextResponse.json(
        { error: 'type 파라미터 필요: margin_master | settlement | price_inventory' },
        { status: 400 }
      );
    }

    const saved = await getData(getKey(type));
    if (!saved) {
      return NextResponse.json({ data: null, fileName: null, savedAt: null });
    }

    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** 데이터 저장 */
export async function POST(request: Request) {
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

    await saveData(getKey(type), {
      data,
      fileName: fileName || null,
      uploadedBy: uploadedBy || null,
      savedAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** 데이터 삭제 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');

    if (!type || !isValidType(type)) {
      return NextResponse.json(
        { error: 'type 파라미터 필요' },
        { status: 400 }
      );
    }

    // 빈 객체로 덮어쓰기 (saveData가 upsert임)
    await saveData(getKey(type), {
      data: null,
      fileName: null,
      uploadedBy: null,
      savedAt: null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
