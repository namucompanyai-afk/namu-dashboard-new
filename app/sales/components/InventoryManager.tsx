"use client";

import { useState, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";

const SAFETY_DAYS = 14;

interface Product {
  name: string;
  option: string;
  skuId: string;
  winner: string;
  stock: number;
  incoming: number;
  daily: number;
  sales30: number;
}

interface CalcProduct extends Product {
  estimatedStock: number;
  safetyStock: number;
  daysLeft: number;
  needRestock: boolean;
  shortage: number;
}

function calcProducts(products: Product[], uploadDate: string): CalcProduct[] {
  const today       = new Date();
  const upload      = new Date(uploadDate);
  const elapsedDays = Math.floor((today.getTime() - upload.getTime()) / (1000 * 60 * 60 * 24));
  return products.map((p) => {
    const estimatedStock = Math.max(0, p.stock - p.daily * elapsedDays + p.incoming);
    const safetyStock    = p.daily * SAFETY_DAYS;
    const daysLeft       = p.daily > 0 ? Math.floor(estimatedStock / p.daily) : 999;
    const needRestock    = estimatedStock <= safetyStock && p.daily > 0;
    const shortage       = Math.max(0, safetyStock - estimatedStock);
    return { ...p, estimatedStock, safetyStock, daysLeft, needRestock, shortage };
  });
}

function StatusBadge({ daysLeft, needRestock }: { daysLeft: number; needRestock: boolean }) {
  if (daysLeft <= 7)  return <span className="badge-urgent">긴급</span>;
  if (needRestock)    return <span className="badge-warn">입고필요</span>;
  return <span className="badge-ok">정상</span>;
}

export default function InventoryManager() {
  const [products, setProducts]       = useState<Product[]>([]);
  const [uploadDate, setUploadDate]   = useState<string>("");
  const [isDragging, setIsDragging]   = useState(false);
  const [loading, setLoading]         = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  useEffect(() => {
    fetch("/api/inventory")
      .then((r) => r.json())
      .then((data) => {
        if (data.products) {
          setProducts(data.products);
          setUploadDate(data.uploadDate);
          setLastUpdated(new Date(data.uploadDate).toLocaleDateString("ko-KR"));
        }
      });
  }, []);

  const parseExcel = useCallback((file: File) => {
    setLoading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data     = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        const rows     = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "" });

        const parsed: Product[] = [];
        for (let i = 2; i < rows.length; i++) {
          const row     = rows[i] as any[];
          const name    = String(row[4]  || "").trim();
          const option  = String(row[5]  || "").trim();
          const skuId   = String(row[3]  || "").trim();
          const winner  = String(row[9]  || "").trim();
          const stock   = Number(row[7])  || 0;
          const incoming= Number(row[8])  || 0;
          const sales30 = Number(row[13]) || 0;
          const daily   = Math.round(sales30 / 30);
          if (!name || sales30 === 0) continue;
          parsed.push({ name, option, skuId, winner, stock, incoming, daily, sales30 });
        }

        await fetch("/api/inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ products: parsed }),
        });

        setProducts(parsed);
        setUploadDate(new Date().toISOString());
        setLastUpdated(new Date().toLocaleDateString("ko-KR"));
      } catch (err) {
        alert("엑셀 파일 읽기 실패: " + err);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseExcel(file);
  }, [parseExcel]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseExcel(file);
  };

  const calculated   = uploadDate ? calcProducts(products, uploadDate) : [];
  const urgentItems  = calculated.filter((p) => p.daysLeft <= 7);
  const restockItems = calculated.filter((p) => p.needRestock);
  const normalItems  = calculated.filter((p) => !p.needRestock);

  // 업로드 전 보여줄 빈 샘플 rows
  const emptyRows = Array(5).fill(null);

  return (
    <div className="inv-wrap">
      <style>{`
        .inv-wrap { font-family: 'Noto Sans KR', sans-serif; padding: 24px; }
        .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
        .sum-card { background: #fff; border-radius: 12px; padding: 16px; border: 1px solid #e5e7eb; }
        .sum-card.danger { border-color: #fca5a5; background: #fff5f5; }
        .sum-card.warn   { border-color: #fcd34d; background: #fffdf0; }
        .sum-card.ok     { border-color: #86efac; background: #f0fdf4; }
        .sum-num { font-size: 28px; font-weight: 700; }
        .sum-num.red    { color: #dc2626; }
        .sum-num.yellow { color: #d97706; }
        .sum-num.green  { color: #16a34a; }
        .sum-label { font-size: 11px; color: #6b7280; margin-top: 3px; }
        .upload-box { border: 2px dashed #c7d2fe; border-radius: 12px; padding: 24px; text-align: center; cursor: pointer; margin-bottom: 20px; background: #f8faff; transition: all 0.2s; }
        .upload-box.dragging { border-color: #4f46e5; background: #eef2ff; }
        .upload-box:hover { border-color: #4f46e5; }
        .upload-title { font-size: 15px; font-weight: 600; color: #4f46e5; margin-bottom: 4px; }
        .upload-sub   { font-size: 12px; color: #9ca3af; }
        .top-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
        .top-title { font-size: 15px; font-weight: 600; color: #111827; }
        .updated-at { font-size: 12px; color: #9ca3af; }
        .table-wrap { background: #fff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { background: #f9fafb; color: #6b7280; font-size: 11px; font-weight: 600; padding: 9px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
        td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; color: #374151; vertical-align: middle; }
        tr:last-child td { border-bottom: none; }
        tr.row-urgent td { background: rgba(220,38,38,0.04); }
        tr.row-warn   td { background: rgba(217,119,6,0.04); }
        tr:hover td { background: #f9fafb; }
        .pname { font-weight: 500; max-width: 180px; }
        .opt   { font-size: 11px; color: #9ca3af; }
        .winner-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: #ede9fe; color: #5b21b6; font-weight: 600; }
        .badge-urgent { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 10px; font-weight: 700; background: #fee2e2; color: #b91c1c; }
        .badge-warn   { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 10px; font-weight: 700; background: #fef9c3; color: #92400e; }
        .badge-ok     { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 10px; font-weight: 700; background: #dcfce7; color: #15803d; }
        .banner { background: #fef3c7; border: 1px solid #fcd34d; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #92400e; font-weight: 500; }
        .days-red    { color: #dc2626; font-weight: 700; }
        .days-yellow { color: #d97706; font-weight: 700; }
        .days-green  { color: #16a34a; font-weight: 700; }
        .skeleton { background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; height: 14px; }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        .empty-hint { font-size: 12px; color: #9ca3af; font-style: italic; }
      `}</style>

      {/* 요약 카드 */}
      <div className="summary-grid">
        <div className="sum-card ok">
          <div className="sum-num green">{products.length || 0}</div>
          <div className="sum-label">전체 품목</div>
        </div>
        <div className={`sum-card ${urgentItems.length > 0 ? "danger" : "ok"}`}>
          <div className={`sum-num ${urgentItems.length > 0 ? "red" : "green"}`}>{urgentItems.length}</div>
          <div className="sum-label">🚨 긴급 (7일 미만)</div>
        </div>
        <div className={`sum-card ${restockItems.length > 0 ? "warn" : "ok"}`}>
          <div className={`sum-num ${restockItems.length > 0 ? "yellow" : "green"}`}>{restockItems.length}</div>
          <div className="sum-label">⚠️ 입고 필요</div>
        </div>
        <div className="sum-card ok">
          <div className="sum-num green">{normalItems.length}</div>
          <div className="sum-label">✅ 재고 정상</div>
        </div>
      </div>

      {/* 긴급 배너 */}
      {urgentItems.length > 0 && (
        <div className="banner">
          🚨 긴급! {urgentItems.map((p) => p.name).join(", ")} — 7일 내 재고 소진 예상
        </div>
      )}

      {/* 엑셀 업로드 */}
      <div
        className={`upload-box ${isDragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById("excel-input")?.click()}
      >
        <div style={{ fontSize: 28, marginBottom: 6 }}>📂</div>
        <div className="upload-title">
          {loading ? "⏳ 처리 중..." : "쿠팡 그로스 재고 엑셀 업로드"}
        </div>
        <div className="upload-sub">
          클릭하거나 파일을 드래그해서 올려주세요 · inventory_health_sku_info_*.xlsx
        </div>
        <input
          id="excel-input"
          type="file"
          accept=".xlsx"
          style={{ display: "none" }}
          onChange={handleFileInput}
        />
      </div>

      {/* 테이블 - 업로드 전/후 모두 표시 */}
      <div className="top-bar">
        <div className="top-title">
          재고 현황
          {lastUpdated && (
            <span className="updated-at" style={{ marginLeft: 8 }}>
              · {lastUpdated} 엑셀 기준 · 매일 자동 계산
            </span>
          )}
          {!lastUpdated && (
            <span className="updated-at" style={{ marginLeft: 8 }}>
              · 엑셀 업로드 후 자동으로 채워집니다
            </span>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>상품명 / 옵션</th>
              <th>SKU ID</th>
              <th>현재 재고</th>
              <th>입고예정</th>
              <th>30일 판매량</th>
              <th>1일 평균판매</th>
              <th>현재예상재고</th>
              <th>안전재고 (14일)</th>
              <th>잔여일수</th>
              <th>입고필요량</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {/* 데이터 있을 때 */}
            {calculated.length > 0 && calculated.map((p, i) => {
              const rowClass  = p.daysLeft <= 7 ? "row-urgent" : p.needRestock ? "row-warn" : "";
              const daysClass = p.daysLeft <= 7 ? "days-red" : p.daysLeft <= 14 ? "days-yellow" : "days-green";
              return (
                <tr key={i} className={rowClass}>
                  <td>
                    <div className="pname">{p.name}</div>
                    <div className="opt">
                      {p.option}
                      {p.winner === "아이템위너" && (
                        <span className="winner-badge" style={{ marginLeft: 4 }}>위너</span>
                      )}
                    </div>
                  </td>
                  <td style={{ color: "#9ca3af", fontSize: 11 }}>{p.skuId}</td>
                  <td><strong>{p.stock.toLocaleString()}</strong></td>
                  <td style={{ color: p.incoming > 0 ? "#16a34a" : "#9ca3af" }}>
                    {p.incoming > 0 ? `+${p.incoming.toLocaleString()}` : "-"}
                  </td>
                  <td>{p.sales30.toLocaleString()}</td>
                  <td>{p.daily}개/일</td>
                  <td><strong>{p.estimatedStock.toLocaleString()}</strong></td>
                  <td>{p.safetyStock.toLocaleString()}</td>
                  <td className={daysClass}>{p.daysLeft === 999 ? "충분" : `${p.daysLeft}일`}</td>
                  <td style={{ color: p.needRestock ? "#dc2626" : "#9ca3af", fontWeight: p.needRestock ? 700 : 400 }}>
                    {p.needRestock ? `${p.shortage.toLocaleString()}개` : "-"}
                  </td>
                  <td><StatusBadge daysLeft={p.daysLeft} needRestock={p.needRestock} /></td>
                </tr>
              );
            })}

            {/* 업로드 전 skeleton rows */}
            {calculated.length === 0 && emptyRows.map((_, i) => (
              <tr key={i}>
                <td><div className="skeleton" style={{ width: "140px" }} /></td>
                <td><div className="skeleton" style={{ width: "70px" }} /></td>
                <td><div className="skeleton" style={{ width: "50px" }} /></td>
                <td><div className="skeleton" style={{ width: "40px" }} /></td>
                <td><div className="skeleton" style={{ width: "50px" }} /></td>
                <td><div className="skeleton" style={{ width: "50px" }} /></td>
                <td><div className="skeleton" style={{ width: "60px" }} /></td>
                <td><div className="skeleton" style={{ width: "60px" }} /></td>
                <td><div className="skeleton" style={{ width: "40px" }} /></td>
                <td><div className="skeleton" style={{ width: "50px" }} /></td>
                <td><div className="skeleton" style={{ width: "50px" }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {calculated.length === 0 && (
          <div style={{ textAlign: "center", padding: "16px", borderTop: "1px solid #f3f4f6" }}>
            <span className="empty-hint">⬆️ 위에서 쿠팡 그로스 엑셀 파일을 업로드하면 자동으로 채워집니다</span>
          </div>
        )}
      </div>
    </div>
  );
}
