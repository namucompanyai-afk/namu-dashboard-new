import { NextResponse } from "next/server";
import { getData, saveData } from "@/lib/supabase";

export async function GET() {
  try {
    const saved = await getData("influencer");
    if (!saved) return NextResponse.json({ influencers: [], ntData: {}, savedAt: null });
    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
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