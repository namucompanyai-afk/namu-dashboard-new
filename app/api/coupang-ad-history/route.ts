import { requireRole } from "@/lib/server-auth"
import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

/**
 * 쿠팡 광고 운영 히스토리 메모 API
 *
 * 키: coupang_ad_history_notes
 * payload: { items: [{ id, ts, text }] }
 *
 * GET    /api/coupang-ad-history             → 전체 메모 조회
 * POST   /api/coupang-ad-history { text, kind?, campaignKey?, campaignName? } → 메모 추가 (서버 타임스탬프)
 *        kind='reflect' = 광고 분석 "쿠팡 반영 완료" 기록 — campaignKey(prefix::타입, 없으면 캠페인명)로 지난주 조정 결과를 찾는다
 * DELETE /api/coupang-ad-history?id={id}     → 메모 삭제
 */

const KEY = 'coupang_ad_history_notes';

interface NoteItem {
  id: string;
  ts: string;
  text: string;
  kind?: 'reflect';
  campaignKey?: string;
  campaignName?: string;
}
interface NotesPayload {
  items: NoteItem[];
}

async function loadItems(): Promise<NoteItem[]> {
  const saved = (await getData(KEY)) as NotesPayload | null;
  return saved?.items ?? [];
}

function makeId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 메모 전체 조회 */
export async function GET(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(req, ['admin', 'guest'])
  if (denied) return denied
  try {
    const items = await loadItems();
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** 메모 추가 */
export async function POST(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(request, ['admin', 'guest'])
  if (denied) return denied
  try {
    const body = await request.json();
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return NextResponse.json({ error: 'text 필요' }, { status: 400 });
    }

    const items = await loadItems();
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
    const newItem: NoteItem = {
      id: makeId(),
      ts: new Date().toISOString(),
      text,
      // 쿠팡 반영 완료 기록이면 캠페인 식별값을 별도 필드로 (메모 문구 형식은 그대로)
      ...(body?.kind === 'reflect'
        ? { kind: 'reflect' as const, campaignKey: str(body?.campaignKey), campaignName: str(body?.campaignName) }
        : {}),
    };
    items.push(newItem);
    await saveData(KEY, { items });

    return NextResponse.json({ ok: true, item: newItem });
  } catch (err: any) {
    // PostgREST 에러는 {message, code, details, hint} 객체 → String()이면 [object Object]. 실제 내용 노출.
    return NextResponse.json(
      { error: err?.message || String(err), code: err?.code, details: err?.details, hint: err?.hint },
      { status: 500 },
    );
  }
}

/** 메모 삭제 */
export async function DELETE(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: 쿠팡 광고 분석
  const denied = requireRole(request, ['admin', 'guest'])
  if (denied) return denied
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id 파라미터 필요' }, { status: 400 });
    }

    const items = await loadItems();
    const next = items.filter((it) => it.id !== id);
    await saveData(KEY, { items: next });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
