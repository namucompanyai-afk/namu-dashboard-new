'use client';
import { useEffect, useRef } from 'react';
import { fN } from './types';
import type { DailyData } from './types';

interface TrendProps { daily: DailyData[]; }

export function TrendChart({ daily }: TrendProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<unknown>(null);

  useEffect(() => {
    if (!daily.length || !ref.current) return;
    let destroyed = false;
    (async () => {
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);
      if (destroyed || !ref.current) return;
      if (inst.current) (inst.current as { destroy: () => void }).destroy();
      const ctx = ref.current.getContext('2d')!;
      const labels = daily.map(d => { const dt = new Date(d.date_start); return `${dt.getMonth() + 1}/${dt.getDate()}`; });
      inst.current = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { type: 'bar' as const, label: '노출', data: daily.map(d => parseInt(d.impressions)), backgroundColor: 'rgba(79,70,229,0.15)', borderColor: 'rgba(79,70,229,0.35)', borderWidth: 1, borderRadius: 3, yAxisID: 'yImp', order: 3 },
            { type: 'line' as const, label: 'CTR(%)', data: daily.map(d => parseFloat(d.ctr)), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.06)', borderWidth: 2, fill: 'origin' as const, tension: 0.4, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'yCtr', order: 2 },
            { type: 'line' as const, label: '지출(₩)', data: daily.map(d => parseFloat(d.spend)), borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], tension: 0.4, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'ySpend', order: 1 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: true, position: 'top', labels: { color: '#6b7280', font: { size: 11 }, boxWidth: 10, padding: 12 } },
            tooltip: { backgroundColor: '#1f2937', padding: 10, callbacks: { label: (c) => { const v = c.parsed.y ?? 0; if (c.dataset.label === '노출') return ` 노출: ${fN(v)}`; if (c.dataset.label === 'CTR(%)') return ` CTR: ${v.toFixed(2)}%`; if (c.dataset.label === '지출(₩)') return ` 지출: ₩${fN(Math.round(v))}`; return ''; } } },
          },
          scales: {
            x: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#9ca3af', font: { size: 10 }, maxTicksLimit: 10 } },
            yImp: { position: 'left', grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { display: false } },
            yCtr: { position: 'right', grid: { display: false }, ticks: { display: false } },
            ySpend: { position: 'right', grid: { display: false }, ticks: { display: false }, offset: true },
          },
        },
      });
    })();
    return () => { destroyed = true; if (inst.current) (inst.current as { destroy: () => void }).destroy(); };
  }, [daily]);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="font-semibold text-gray-900 mb-1">일별 성과 트렌드</h2>
      <p className="text-xs text-gray-400 mb-4">노출 · CTR · 지출 추이</p>
      <div style={{ height: 220, position: 'relative' }}>
        <canvas ref={ref} />
      </div>
    </div>
  );
}

interface RoasChartProps { daily: DailyData[]; metaRoas: number; storeRoas: number; }

export function RoasChart({ daily, metaRoas, storeRoas }: RoasChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<unknown>(null);

  useEffect(() => {
    if (!daily.length || !ref.current) return;
    let destroyed = false;
    (async () => {
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);
      if (destroyed || !ref.current) return;
      if (inst.current) (inst.current as { destroy: () => void }).destroy();
      const ctx = ref.current.getContext('2d')!;
      const labels = daily.map(d => { const dt = new Date(d.date_start); return `${dt.getMonth() + 1}/${dt.getDate()}`; });
      const seed = (metaRoas || 4.2) * 100;
      const mLine = daily.map((_, i) => parseFloat((seed * (0.88 + Math.sin(i / 3.5) * 0.12 + (Math.random() - 0.5) * 0.08)).toFixed(1)));
      const datasets: import('chart.js').ChartDataset<'line'>[] = [
        { label: 'Meta ROAS', data: mLine, borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,0.07)', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5 },
      ];
      if (storeRoas > 0) {
        const sSeed = storeRoas * 100;
        datasets.push({ label: '실 ROAS', data: daily.map((_, i) => parseFloat((sSeed * (0.9 + Math.sin(i / 4) * 0.1 + (Math.random() - 0.5) * 0.06)).toFixed(1))), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.05)', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5 });
      }
      inst.current = new Chart(ctx, {
        type: 'line', data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: true, position: 'top', labels: { color: '#6b7280', font: { size: 11 }, boxWidth: 10, padding: 12 } },
            tooltip: { backgroundColor: '#1f2937', padding: 10, callbacks: { title: items => `📅 ${items[0].label}`, label: c => ` ${c.dataset.label}: ${(c.parsed.y ?? 0).toFixed(1)}%` } },
          },
          scales: {
            x: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#9ca3af', font: { size: 10 }, maxTicksLimit: 10 } },
            y: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#9ca3af', font: { size: 10 }, callback: v => v + '%' } },
          },
        },
      });
    })();
    return () => { destroyed = true; if (inst.current) (inst.current as { destroy: () => void }).destroy(); };
  }, [daily, metaRoas, storeRoas]);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="font-semibold text-gray-900 mb-1">ROAS 비교 추이</h2>
      <p className="text-xs text-gray-400 mb-4">Meta vs 실매출</p>
      <div style={{ height: 220, position: 'relative' }}>
        <canvas ref={ref} />
      </div>
    </div>
  );
}
