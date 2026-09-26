import { requireRole } from "@/lib/server-auth"
﻿import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

export async function GET(req: Request) {
  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: Sales › 메타
  const denied = requireRole(req, ['admin', 'staff'])
  if (denied) return denied
  try {
    const saved = await getData("meta");
    if (!saved) return NextResponse.json({ metaRows: [], ntRows: [], savedAt: null });
    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {

  // 로그인 필수 (서명 쿠키 nd_auth) — 호출 화면: Sales › 메타
  const denied = requireRole(request, ['admin', 'staff'])
  if (denied) return denied
  try {
    const body = await request.json();
    const { metaRows, ntRows } = body;
    await saveData("meta", {
      metaRows: metaRows || [],
      ntRows: ntRows || [],
      savedAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}