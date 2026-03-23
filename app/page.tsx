"use client";

import { useMemo, useState } from "react";

type SectionKey = "sales" | "hr";

export default function Page() {
  const [section, setSection] = useState<SectionKey>("sales");

  const content = useMemo(() => {
    if (section === "sales") {
      return {
        title: "Sales Dashboard",
        icon: "📊",
        desc: "판매, 주문 및 채널 실적이 여기에 표시됩니다. (Google Sheets 연동은 곧 제공될 예정입니다.)",
        card: "💰 Sales data area (Google Sheets 연동 예정)",
      };
    }
    return {
      title: "HR Dashboard",
      icon: "👥",
      desc: "근태, 연차, 인사 데이터가 여기에 표시됩니다. (Google Sheets 연동은 곧 제공될 예정입니다.)",
      card: "🗂️ HR data area (Google Sheets 연동 예정)",
    };
  }, [section]);

  return (
    <div className="namu-app">
      <aside className="namu-sidebar">
        <div className="namu-brand">
          <div className="namu-brand-title">🌳 나무컴퍼니 Dashboard</div>
        </div>

        <nav className="namu-nav">
          {/* 요청: Sales가 HR보다 위 */}
          <button
            className={`namu-nav-item ${section === "sales" ? "is-active" : ""}`}
            onClick={() => setSection("sales")}
            type="button"
          >
            📊 <span>Sales Dashboard</span>
          </button>

          <button
            className={`namu-nav-item ${section === "hr" ? "is-active" : ""}`}
            onClick={() => setSection("hr")}
            type="button"
          >
            👥 <span>HR Dashboard</span>
          </button>
        </nav>
      </aside>

      <main className="namu-main">
        <div className="namu-page">
          <h1 className="namu-title">
            <span className="namu-title-icon">{content.icon}</span>
            {content.title}
          </h1>

          <p className="namu-desc">{content.desc}</p>

          <section className="namu-card">{content.card}</section>
        </div>
      </main>
    </div>
  );
}
