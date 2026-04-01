import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

const DATA_FILE = path.join(process.cwd(), "data", "inventory.json");
const ALERT_EMAILS = ["huguoh8501@gmail.com", "namumedical22@gmail.com", "dlagusdn1991@gmail.com"];
const SAFETY_DAYS = 14;

// ✅ GET: 두 가지 역할
// 1) 크론/알림 호출 (secret 파라미터 있을 때) → 이메일 발송
// 2) 일반 페이지 호출 → 저장된 데이터 반환
export async function GET(request: Request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization");
  const isCron =
    authHeader === `Bearer ${process.env.CRON_SECRET}` ||
    url.searchParams.get("secret") === "namu2024";

  // 크론 호출이면 기존 이메일 발송 로직
  if (isCron) {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        return NextResponse.json({ message: "데이터 없음" });
      }

      const { products, uploadDate } = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      if (!products || products.length === 0) {
        return NextResponse.json({ message: "품목 없음" });
      }

      const today = new Date();
      const upload = new Date(uploadDate);
      const elapsedDays = Math.floor(
        (today.getTime() - upload.getTime()) / (1000 * 60 * 60 * 24)
      );

      const calculated = products.map((p: any) => {
        const estimatedStock = Math.max(0, p.stock - p.daily * elapsedDays + p.incoming);
        const safetyStock = p.daily * SAFETY_DAYS;
        const daysLeft = p.daily > 0 ? Math.floor(estimatedStock / p.daily) : 999;
        const needRestock = estimatedStock <= safetyStock && p.daily > 0;
        const shortage = Math.max(0, safetyStock - estimatedStock);
        return { ...p, estimatedStock, safetyStock, daysLeft, needRestock, shortage };
      });

      const restockItems = calculated.filter((p: any) => p.needRestock);
      const urgentItems = calculated.filter((p: any) => p.daysLeft <= 7);
      const normalItems = calculated.filter((p: any) => !p.needRestock);

      if (restockItems.length === 0) {
        return NextResponse.json({ message: "모든 품목 정상 - 알림 없음" });
      }

      const dateStr = today.toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      await sendEmail(dateStr, restockItems, urgentItems, normalItems, elapsedDays);

      return NextResponse.json({
        ok: true,
        message: `알림 발송 완료 - 입고필요: ${restockItems.length}건`,
      });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // ✅ 일반 페이지 호출: 저장된 데이터 반환
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return NextResponse.json({ products: [], uploadDate: null });
    }
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const { products, uploadDate } = JSON.parse(raw);
    return NextResponse.json({ products: products || [], uploadDate: uploadDate || null });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ✅ POST: 엑셀 업로드 시 데이터 저장
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { products } = body;

    if (!products || !Array.isArray(products)) {
      return NextResponse.json({ error: "잘못된 데이터" }, { status: 400 });
    }

    // data 폴더 없으면 생성
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const payload = {
      products,
      uploadDate: new Date().toISOString(),
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), "utf-8");

    return NextResponse.json({ ok: true, count: products.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function sendEmail(
  dateStr: string,
  restockItems: any[],
  urgentItems: any[],
  normalItems: any[],
  elapsedDays: number
) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const restockRows = restockItems
    .map((p) => {
      const isUrgent = p.daysLeft <= 7;
      const bg = isUrgent ? "#fff5f5" : "#fffdf0";
      const color = isUrgent ? "#dc2626" : "#d97706";
      const badge = isUrgent
        ? `<span style="background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:100px;font-size:11px;font-weight:700">긴급</span>`
        : `<span style="background:#fef9c3;color:#92400e;padding:2px 8px;border-radius:100px;font-size:11px;font-weight:700">입고필요</span>`;
      return `
    <tr style="background:${bg}">
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6"><strong>${p.name}</strong><br><span style="font-size:11px;color:#9ca3af">${p.option}</span></td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#9ca3af">${p.skuId}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6">${p.stock.toLocaleString()} → <strong>${p.estimatedStock.toLocaleString()}</strong></td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6">${p.daily}개/일</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6">${p.safetyStock.toLocaleString()}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:${color};font-weight:700">${p.daysLeft}일</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#dc2626;font-weight:700">${p.shortage.toLocaleString()}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6">${badge}</td>
    </tr>`;
    })
    .join("");

  const html = `
<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f7fb;margin:0;padding:20px">
<div style="max-width:720px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#4f46e5;padding:28px 32px">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">📦 쿠팡 그로스 재고 입고 알림</h1>
    <p style="color:#c7d2fe;margin:8px 0 0;font-size:14px">나무포털 · ${dateStr} · 엑셀 업로드 후 ${elapsedDays}일 경과 기준</p>
  </div>
  <div style="padding:24px 32px;border-bottom:1px solid #f3f4f6">
    <div style="display:flex;gap:12px">
      <div style="flex:1;background:#fff5f5;border-radius:10px;padding:16px;text-align:center;border:1px solid #fca5a5">
        <div style="font-size:32px;font-weight:700;color:#dc2626">${urgentItems.length}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">🚨 긴급 (7일 미만)</div>
      </div>
      <div style="flex:1;background:#fffbeb;border-radius:10px;padding:16px;text-align:center;border:1px solid #fcd34d">
        <div style="font-size:32px;font-weight:700;color:#d97706">${restockItems.length}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">⚠️ 입고 필요 (${SAFETY_DAYS}일 기준)</div>
      </div>
      <div style="flex:1;background:#f0fdf4;border-radius:10px;padding:16px;text-align:center;border:1px solid #86efac">
        <div style="font-size:32px;font-weight:700;color:#16a34a">${normalItems.length}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">✅ 재고 정상</div>
      </div>
    </div>
  </div>
  <div style="padding:24px 32px">
    <h2 style="font-size:15px;font-weight:700;color:#111827;margin:0 0 16px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">⚠️ 입고 필요 품목</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f9fafb">
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">상품명</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">SKU</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">업로드→현재예상</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">일판매량</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">안전재고</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">잔여일수</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">입고필요량</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px">상태</th>
      </tr></thead>
      <tbody>${restockRows}</tbody>
    </table>
  </div>
  <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #f3f4f6">
    <p style="font-size:12px;color:#9ca3af;margin:0">나무포털 재고관리 시스템 · 매일 오전 9시 자동 발송<br>엑셀 업로드일 기준으로 일평균 판매량을 차감하여 예상 재고를 계산합니다.</p>
  </div>
</div>
</body></html>`;

  await transporter.sendMail({
    from: `"나무포털 재고알림" <${process.env.GMAIL_USER}>`,
    to: ALERT_EMAILS.join(", "),
    subject: `[나무포털] 📦 쿠팡 그로스 입고 알림 ${restockItems.length}건 - ${dateStr}`,
    html,
  });
}
