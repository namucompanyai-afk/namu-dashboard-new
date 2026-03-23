import { NextResponse } from "next/server";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxTaB84ClwxR5PZGXpqbIBUWDphYL-ol6FRwnkcdBbinOYTwKdc0fzEjeDLX-RWAxVWuA/exec";

/**
 * GET
 * - action=ping
 * - action=listLeaves
 * - action=getEmployee&email=xxx
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "ping";

    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    
    // email 파라미터가 있으면 추가
    const email = searchParams.get("email");
    if (email) {
      url.searchParams.set("email", email);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
    });

    const text = await res.text();

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json({
        ok: false,
        raw: text,
      });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      message: String(err),
    });
  }
}

/**
 * POST
 * - action=createLeave
 * - action=approveLeave
 * - action=rejectLeave
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json({
        ok: false,
        raw: text,
      });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      message: String(err),
    });
  }
}