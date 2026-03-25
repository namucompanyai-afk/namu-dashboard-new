'use client';
import { useEffect, useRef } from 'react';
import { fN } from './types';
import type { AudienceData, InsightData, StoreData } from './types';

const PAL = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

interface AudienceProps { audience: AudienceData[]; }

export function AudienceDonut({ audience }: AudienceProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<unknown>(null);

  const groups: Record<string, number> = {};
  audience.forEach(r => {
    const k = `${r.gender === 'male' ? '남성' : '여성'} ${r.age}`;
    groups[k] = (groups[k] || 0) + parseInt(r.reach || r.impressions || '0');
  });
  const entries = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  useEffect(() => {
    if (!ref.current || !entries.length) return;
    let destroyed = false;
    (async () => {
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);
      if (destroyed || !ref.current) return;
      if (inst.current) (inst.current as { destroy: () => void }).destroy();
      inst.current = new Chart(ref.current.getContext('2d')!, {
        type: 'doughnut',
        data: { labels: entries.map(([k]) => k), datasets: [{ data: entries.map(([, v]) => v), backgroundColor: PAL, borderWidth: 0, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1f2937', callbacks: { label: c => ` ${c.label}: ${total > 0 ? (c.parsed / total * 100).toFixed(0) : 0}%` } } } },
      });
    })();
    return () => { destroyed = true; if (inst.current) (inst.current as { destroy: () => void }).destroy(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="font-semibold text-gray-900 mb-1">오디언스 분포</h2>
      <p className="text-xs text-gray-400 mb-4">연령·성별</p>
      <div style={{ height: 160, position: 'relative' }} className="flex items-center justify-center">
        <canvas ref={ref} />
        <div className="absolute text-center pointer-events-none">
          <div className="text-lg font-bold text-indigo-600">{total > 0 ? fN(total) : '—'}</div>
          <div className="text-xs text-gray-400">총 도달</div>
        </div>
      </div>
      <div className="mt-4 space-y-1.5">
        {entries.map(([k, v], i) => (
          <div key={k} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: PAL[i] }} />
              <span className="text-gray-600">{k}</span>
            </div>
            <span className="font-semibold text-gray-700">{total > 0 ? (v / total * 100).toFixed(0) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface FunnelProps { ins: InsightData; storeData: StoreData; }

export function Funnel({ ins, storeData }: FunnelProps) {
  const imp = parseInt(ins.impressions || '0');
  const clk = parseInt(ins.clicks || '0');
  let cart = 0, buy = 0;
  (ins.actions || []).forEach(a => {
    if (a.action_type === 'add_to_cart') cart += parseInt(a.value);
    if (a.action_type === 'purchase') buy += parseInt(a.value);
  });
  if (storeData.orders > 0) buy = storeData.orders;

  const stages = [
    { icon: '👁', label: '노출', value: imp, color: '#4f46e5' },
    { icon: '🖱', label: '클릭', value: clk, color: '#06b6d4' },
    { icon: '🛒', label: '장바구니', value: cart, color: '#10b981' },
    { icon: '✅', label: '구매', value: buy, color: '#f59e0b' },
  ];
  const mx = imp || 1;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="font-semibold text-gray-900 mb-1">전환 퍼널</h2>
      <p className="text-xs text-gray-400 mb-4">노출 → 구매</p>
      <div className="space-y-3">
        {stages.map(s => (
          <div key={s.label}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-600 font-medium">{s.icon} {s.label}</span>
              <span className="font-mono text-gray-500">{fN(s.value)}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, s.value / mx * 100).toFixed(1)}%`, background: s.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
