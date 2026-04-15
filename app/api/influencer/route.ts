import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATA_FILE = path.join(process.cwd(), "data", "influencer.json");

export async function GET() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return NextResponse.json({ influencers: [], ntData: {}, savedAt: null });
    }
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { influencers, ntData } = body;

    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const payload = {
      influencers: influencers || [],
      ntData: ntData || {},
      savedAt: new Date().toISOString(),
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
