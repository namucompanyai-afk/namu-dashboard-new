import { requireRole } from "@/lib/server-auth"
import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

export async function GET(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: Sales › 인플루언서
  const denied = requireRole(req, ['admin', 'staff'])
  if (denied) return denied
  try {
    const saved = await getData("influencer");
    if (!saved) return NextResponse.json({ influencers: [], ntData: {}, savedAt: null });
    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: Sales › 인플루언서
  const denied = requireRole(request, ['admin', 'staff'])
  if (denied) return denied
  try {
    const body = await request.json();
    const { influencers, ntData } = body;
    await saveData("influencer", {
      influencers: influencers || [],
      ntData: ntData || {},
      savedAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}