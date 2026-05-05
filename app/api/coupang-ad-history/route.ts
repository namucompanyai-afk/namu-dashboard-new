import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

/**
 * 쿠팡 광고 운영 히스토리 메모 API
 *
 * 키: coupang_ad_history_notes
 * payload: { items: [{ id, ts, text }] }
 *
 * GET    /api/coupang-ad-history             → 전체 메모 조회
 * POST   /api/coupang-ad-history { text }    → 메모 추가 (서버 타임스탬프)
 * DELETE /api/coupang-ad-history?id={id}     → 메모 삭제
 */

const KEY = 'coupang_ad_history_notes';

interface NoteItem {
  id: string;
  ts: string;
  text: string;
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
export async function GET() {
  try {
    const items = await loadItems();
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** 메모 추가 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return NextResponse.json({ error: 'text 필요' }, { status: 400 });
    }

    const items = await loadItems();
    const newItem: NoteItem = {
      id: makeId(),
      ts: new Date().toISOString(),
      text,
    };
    items.push(newItem);
    await saveData(KEY, { items });

    return NextResponse.json({ ok: true, item: newItem });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** 메모 삭제 */
export async function DELETE(request: Request) {
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
