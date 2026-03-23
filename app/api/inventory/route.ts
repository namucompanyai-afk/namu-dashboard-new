import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATA_FILE = path.join(process.cwd(), "data", "inventory.json");

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// GET - 재고 데이터 불러오기
export async function GET() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) {
      return NextResponse.json({ products: [], uploadDate: null });
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// POST - 재고 데이터 저장
export async function POST(request: Request) {
  try {
    ensureDataDir();
    const body = await request.json();
    const data = {
      products: body.products,
      uploadDate: new Date().toISOString(),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
