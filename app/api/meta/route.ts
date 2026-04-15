import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

export async function GET() {
  try {
    const saved = await getData("meta");
    if (!saved) return NextResponse.json({ metaRows: [], ntRows: [], savedAt: null });
    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
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