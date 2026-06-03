import { NextResponse } from 'next/server';
import Papa from 'papaparse';

/**
 * 스마트스토어 고객분석 — 상품 그룹 매핑 게시 CSV 소스
 *
 * 컬럼(A~E): product_name(키) / 그룹명 / 옵션명 / 상품명(표시명) / 판매 형태
 *
 * 반환: { ok, rows } — rows 는 헤더 포함 string[][].
 *
 * 주의: 게시 CSV는 구글 측 캐시로 시트 수정이 수 분 내 반영될 수 있다.
 *       헤더가 기대 컬럼과 다르면(예: 발주매핑v6의 "샵마인 품목명") ok:false 로 멈춘다.
 */

export const revalidate = 0;

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRUepV9dz4xnwYH92NoegfUVaQsTVGetYOuhHVIYZXe9mVBBD7kLf2G39Rj18bTfg/pub?gid=688842871&single=true&output=csv';

const EXPECTED = ['product_name', '그룹명', '옵션명', '상품명', '판매형태'];
// 공백 제거 + NFC 정규화 후 비교 ("판매 형태" == "판매형태" 허용).
const norm = (s: unknown) => (typeof s === 'string' ? s.normalize('NFC') : '').replace(/\s+/g, '');

export async function GET() {
  try {
    const res = await fetch(CSV_URL, { cache: 'no-store' });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, message: `CSV fetch 실패: ${res.status}`, rows: [] },
        { status: 502 },
      );
    }
    const text = await res.text();
    const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });
    const rows = (parsed.data as string[][]).map((row) =>
      row.map((cell) => (typeof cell === 'string' ? cell.normalize('NFC') : cell)),
    );

    const header = rows[0] ?? [];
    const headerOk = EXPECTED.every((h, i) => norm(header[i]) === norm(h));
    if (!headerOk) {
      return NextResponse.json({
        ok: false,
        message: `헤더 불일치 — 기대 [${EXPECTED.join(' / ')}] / 실제 [${header.join(' / ')}]`,
        rows: [],
      });
    }

    return NextResponse.json({ ok: true, rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err), rows: [] }, { status: 500 });
  }
}
