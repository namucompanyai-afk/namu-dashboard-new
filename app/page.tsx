'use client';
import Link from 'next/link';

function QuickLink({ title, desc, href, emoji }: { title: string; desc: string; href: string; emoji: string }) {
  return (
    <Link href={href} className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="h-11 w-11 rounded-2xl bg-neutral-100 flex items-center justify-center text-xl">{emoji}</div>
      <div className="flex-1">
        <div className="text-[15px] font-semibold">{title}</div>
        <div className="mt-1 text-sm text-gray-500">{desc}</div>
      </div>
      <div className="text-sm font-medium text-neutral-900">열기 →</div>
    </Link>
  );
}

export default function HomePage() {
  return (
    <div>
      <section className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-semibold">(회사명) 통합 포털</h1>
        <p className="mt-3 text-sm text-gray-500">Sales / HR 대시보드를 한 곳에서 운영합니다.</p>
      </section>
      <section className="mt-7">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <QuickLink title="Sales Dashboard" desc="매출/성과/리포트" href="/sales" emoji="📊" />
          <QuickLink title="HR Dashboard" desc="근태/휴가/승인/관리" href="/hr" emoji="🧑‍💼" />
        </div>
      </section>
    </div>
  );
}