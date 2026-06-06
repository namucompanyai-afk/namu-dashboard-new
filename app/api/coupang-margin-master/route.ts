import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import { parseMarginRows } from '@/lib/coupang/parsers/marginMaster';

/**
 * 쿠팡 마진마스터 — "마진계산" 시트 게시 CSV 소스
 *
 * 기존: 마진분석.xlsx 업로드 → parseMarginMaster → Supabase 저장.
 * 변경: 대표가 올린 구글시트(게시 CSV)에서 마진계산 시트만 fetch → 동일 parseMarginRows 재사용.
 *       시트를 수정하면 재업로드 없이 반영(게시 CSV는 구글 캐시로 수 분 지연 가능).
 *
 * ⚠️ %/배율 단위 정규화 (정확도 직결):
 *   게시 CSV는 수수료율/마진율/BEP ROAS 를 "12.0%" "42.5%" "235.3%" 문자열로 내려줌.
 *   parseMarginRows 의 toNum 은 '%'를 떼어 12.0 / 42.5 / 235.3 으로 만든다.
 *   기존 xlsx 경로(SheetJS 캐시값 .v)는 소수/배율(0.12 / 0.425 / 2.353)이었으므로,
 *   '%'가 감지된 컬럼만 ÷100 하여 downstream(diagnosis.ts)과 동일 단위로 맞춘다.
 *
 * 반환: { ok, marginRows } — marginRows 는 MarginCalcRow[] (정규화 완료).
 */

export const revalidate = 0;

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vST5GD9Ft1nuFimnq6QaNtpUmq7sJcoq3JXXjshCXTR4AYoA_OBGNYqJzvSwyi04g/pub?gid=1969829740&single=true&output=csv';

// 헤더명 정규화 (marginMaster.normHeader 와 동일 규칙: 공백/괄호/대괄호/슬래시/·/개행/탭 제거 + 소문자).
const normHeader = (s: unknown) =>
  (typeof s === 'string' ? s : String(s ?? '')).replace(/[\s()\[\]/·\n\t]+/g, '').toLowerCase();

// %가 감지된 컬럼만 ÷100 (감지 안 되면 그대로 — xlsx 폴백/포맷 변경 안전).
const PCT_COLS = {
  feeRate: ['수수료율'],
  marginRate: ['마진율'],
  bepRoas: ['beproas'],
} as const;

export async function GET() {
  try {
    const res = await fetch(CSV_URL, { cache: 'no-store' });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, message: `CSV fetch 실패: ${res.status}`, marginRows: [] },
        { status: 502 },
      );
    }
    const text = await res.text();
    const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false });
    const aoa = parsed.data as string[][];

    const { rows, error } = parseMarginRows(aoa);
    if (error) {
      return NextResponse.json({ ok: false, message: error, marginRows: [] }, { status: 422 });
    }

    // ── %/배율 정규화: 헤더행에서 대상 컬럼 인덱스를 찾고, 데이터 셀에 '%'가 있으면 ÷100 ──
    const headerIdx = aoa.findIndex(
      (r) => Array.isArray(r) && r.map(normHeader).includes('옵션id') && r.map(normHeader).includes('실판매가'),
    );
    const header = (aoa[headerIdx] ?? []).map(normHeader);
    const pctDivisor: Record<keyof typeof PCT_COLS, number> = { feeRate: 1, marginRate: 1, bepRoas: 1 };
    for (const key of Object.keys(PCT_COLS) as (keyof typeof PCT_COLS)[]) {
      const ci = header.findIndex((h) => (PCT_COLS[key] as readonly string[]).includes(h));
      if (ci === -1) continue;
      // 헤더 다음 데이터 행들에서 첫 비어있지 않은 셀로 % 여부 판단.
      for (let i = headerIdx + 1; i < aoa.length; i++) {
        const cell = aoa[i]?.[ci];
        if (cell == null || String(cell).trim() === '') continue;
        if (String(cell).includes('%')) pctDivisor[key] = 100;
        break;
      }
    }

    const marginRows = rows.map((r) => ({
      ...r,
      feeRate: Number.isFinite(r.feeRate) ? r.feeRate / pctDivisor.feeRate : r.feeRate,
      marginRate: r.marginRate != null && Number.isFinite(r.marginRate) ? r.marginRate / pctDivisor.marginRate : r.marginRate,
      bepRoas: r.bepRoas != null && Number.isFinite(r.bepRoas) ? r.bepRoas / pctDivisor.bepRoas : r.bepRoas,
    }));

    return NextResponse.json({ ok: true, marginRows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err), marginRows: [] }, { status: 500 });
  }
}
