"use client";

import { useState } from "react";
import InventoryManager from "./components/InventoryManager";

export default function SalesDashboardPage() {
  const [activeTab, setActiveTab] = useState<"sales" | "inventory">("inventory");

  return (
    <div>
      <div className="text-xs font-medium text-gray-500">SALES</div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Sales Dashboard
      </h1>

      {/* 탭 */}
      <div style={{
        display: "flex",
        borderBottom: "2px solid #e5e7eb",
        marginTop: 20,
        marginBottom: 0,
      }}>
        <button
          onClick={() => setActiveTab("sales")}
          style={{
            padding: "10px 24px",
            fontSize: 14,
            fontWeight: 500,
            color: activeTab === "sales" ? "#4f46e5" : "#6b7280",
            borderBottom: activeTab === "sales" ? "2px solid #4f46e5" : "2px solid transparent",
            marginBottom: -2,
            background: "none",
            border: "none",
            borderBottomWidth: 2,
            borderBottomStyle: "solid",
            borderBottomColor: activeTab === "sales" ? "#4f46e5" : "transparent",
            cursor: "pointer",
          }}
        >
          📊 매출 현황
        </button>
        <button
          onClick={() => setActiveTab("inventory")}
          style={{
            padding: "10px 24px",
            fontSize: 14,
            fontWeight: 500,
            color: activeTab === "inventory" ? "#4f46e5" : "#6b7280",
            borderBottom: activeTab === "inventory" ? "2px solid #4f46e5" : "2px solid transparent",
            marginBottom: -2,
            background: "none",
            border: "none",
            borderBottomWidth: 2,
            borderBottomStyle: "solid",
            borderBottomColor: activeTab === "inventory" ? "#4f46e5" : "transparent",
            cursor: "pointer",
          }}
        >
          📦 재고관리 (쿠팡 그로스)
        </button>
      </div>

      {/* 탭 컨텐츠 */}
      {activeTab === "sales" && (
        <div style={{ marginTop: 24 }}>
          <div className="mt-6 rounded-2xl border bg-white p-6 shadow-sm">
            <div className="text-sm font-semibold">🚧 준비중</div>
            <div className="mt-2 text-sm text-gray-500">
              매출/실과/리포트 연동 예정입니다.
            </div>
          </div>
        </div>
      )}

      {activeTab === "inventory" && (
        <div style={{ marginTop: 8 }}>
          <InventoryManager />
        </div>
      )}
    </div>
  );
}
