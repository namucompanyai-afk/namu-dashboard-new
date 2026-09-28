import { NextResponse } from "next/server";
import { getSession, setAuthCookie, type AuthSession } from "@/lib/server-auth";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxTaB84ClwxR5PZGXpqbIBUWDphYL-ol6FRwnkcdBbinOYTwKdc0fzEjeDLX-RWAxVWuA/exec";

/**
 * Apps Script(가입자·연차 시트) 프록시 — 동작별 권한 (서명 쿠키 nd_auth 세션 기준).
 *
 *   누구나(로그인 전)   POST login                       — 성공 시 nd_auth(역할·이메일) 발급
 *   로그인한 관리자·직원 GET  listLeaves · ping           — 팀 휴가 목록(홈 "오늘 휴가자")
 *   본인만(관리자는 전부) GET  getEmployee&email=본인      — 연차 잔여
 *                        POST createLeave (payload.email=본인)
 *   관리자만             GET  listEmployees
 *                        POST approveLeave · rejectLeave · addEmployee · updateEmployee
 *   그 외 동작           관리자만
 *
 * 어떤 응답에도 비밀번호 필드를 넣지 않는다 (목록·로그인 응답 포함) — 로그인 검증은 Apps Script 안에서만.
 */

type Rule = "public" | "member" | "self" | "admin";
const GET_RULES: Record<string, Rule> = { ping: "member", listLeaves: "member", getEmployee: "self", listEmployees: "admin" };
const POST_RULES: Record<string, Rule> = {
  login: "public",
  createLeave: "self",
  approveLeave: "admin",
  rejectLeave: "admin",
  addEmployee: "admin",
  updateEmployee: "admin",
};

const deny = (status: 401 | 403, error: string) => NextResponse.json({ ok: false, error }, { status });

/** 규칙 확인 — 통과면 null, 아니면 거부 응답 */
function check(rule: Rule, s: AuthSession | null, targetEmail?: string): NextResponse | null {
  if (rule === "public") return null;
  if (!s) return deny(401, "로그인이 필요합니다.");
  if (s.role === "admin") return null;
  if (rule === "admin") return deny(403, "관리자만 사용할 수 있습니다.");
  if (s.role !== "staff") return deny(403, "접근 권한이 없습니다.");
  if (rule === "member") return null;
  // self — 본인 이메일만 (옛 로그인 쿠키엔 이메일이 없으니 다시 로그인)
  if (!s.email) return deny(401, "다시 로그인해 주세요.");
  if (!targetEmail || targetEmail.trim().toLowerCase() !== s.email) return deny(403, "본인 것만 조회·신청할 수 있습니다.");
  return null;
}

/** 비밀번호 필드 제거 (중첩 객체·배열 포함) */
const SECRET_KEY = /비밀번호|password|passwd|^pw$/i;
function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEY.test(k)) o[k] = stripSecrets(x);
    return o;
  }
  return v;
}

async function relay(res: Response): Promise<{ data: any; raw?: string }> {
  const text = await res.text();
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { data: null, raw: text };
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "ping";
    const email = searchParams.get("email") || undefined;
    const denied = check(GET_RULES[action] ?? "admin", getSession(request), email);
    if (denied) return denied;

    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    if (email) url.searchParams.set("email", email);

    const { data } = await relay(await fetch(url.toString(), { method: "GET", cache: "no-store" }));
    if (data == null) return NextResponse.json({ ok: false, error: "Apps Script 응답을 읽지 못했습니다." });
    return NextResponse.json(stripSecrets(data));
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err) });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    const denied = check(POST_RULES[action] ?? "admin", getSession(request), body?.payload?.email);
    if (denied) return denied;

    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { data } = await relay(res);
    if (data == null) return NextResponse.json({ ok: false, error: "Apps Script 응답을 읽지 못했습니다." });

    const out = NextResponse.json(stripSecrets(data));
    // 로그인 성공 → 서버측 확인용 서명 쿠키(nd_auth: 역할·이메일) 발급
    if (action === "login" && data?.ok) setAuthCookie(out, data.user?.role, data.user?.email ?? body?.payload?.email);
    return out;
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: String(err) });
  }
}
