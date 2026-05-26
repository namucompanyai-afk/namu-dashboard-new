import { NextResponse } from 'next/server';
import Papa from 'papaparse';

/**
 * 진도팜 발주매핑 — 구글시트 게시 CSV 소스
 *
 * 매핑을 xlsx 업로드 대신 구글시트 게시 CSV에서 읽는다.
 * 시트에 행을 추가하면 재업로드 없이 반영된다.
 *
 * 컬럼(A~H): 샵마인 품목명 / 옵션 / 표준 별칭 / 1주문당 수량 /
 *            발송 거래처 / 소 한계 봉수 / 중 한계 봉수 / 마켓
 *
 * 반환: { ok, rows } — rows 는 헤더 포함 string[][] (header:1 형식과 동일).
 *       클라이언트가 기존 xlsx 매핑 변환 로직(rowsToMapping)을 그대로 재사용한다.
 *
 * 주의: 게시 CSV는 구글 측 캐시로 시트 수정이 즉시가 아니라 수 분 내 반영될 수 있다.
 *       no-store 는 우리 서버 캐시만 끈다 (정상 동작).
 */

export const revalidate = 0;

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRUepV9dz4xnwYH92NoegfUVaQsTVGetYOuhHVIYZXe9mVBBD7kLf2G39Rj18bTfg/pub?gid=147741668&single=true&output=csv';

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
    // 한글 NFC 정규화 (구글시트/맥 NFD 혼입 방지 → 샵마인 품목명과 매칭 보장)
    const rows = (parsed.data as string[][]).map((row) =>
      row.map((cell) => (typeof cell === 'string' ? cell.normalize('NFC') : cell)),
    );
    return NextResponse.json({ ok: true, rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err), rows: [] }, { status: 500 });
  }
}
