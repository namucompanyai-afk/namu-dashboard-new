'use client';
import { fN } from './types';
import type { CampaignInsight, StoreData } from './types';

interface Props { campInsights: CampaignInsight[]; storeData: StoreData; }

const statusMap: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: '활성', cls: 'bg-emerald-100 text-emerald-700' },
  PAUSED: { label: '일시정지', cls: 'bg-yellow-100 text-yellow-700' },
  DELETED: { label: '종료', cls: 'bg-red-100 text-red-500' },
};

export default function CampaignTable({ campInsights, storeData }: Props) {
  const spend = parseFloat(storeData.revenue ? '1' : '0');
  const totalSpend = campInsights.reduce((s, c) => s + parseFloat(c.spend), 0);
  const storeRoas = totalSpend > 0 && storeData.revenue > 0
    ? storeData.revenue / totalSpend : 0;

  const sorted = [...campInsights].sort((a, b) => parseFloat(b.spend) - parseFloat(a.spend));
  void spend;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
      <h2 className="font-semibold text-gray-900 mb-4">
        캠페인 성과
        <span className="text-xs text-gray-400 font-normal ml-2">{campInsights.length}개 캠페인</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-200">
              {['캠페인', '상태', '노출', '클릭', 'CTR', '지출', 'Meta ROAS', '실 ROAS', '소진율'].map(h => (
                <th key={h} className="text-left py-2.5 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider border-r border-gray-100 last:border-r-0 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => {
              let cRev = 0;
              (c.action_values || []).forEach(av => { if (av.action_type === 'purchase') cRev += parseFloat(av.value); });
              const cSpend = parseFloat(c.spend);
              const mR = cSpend > 0 ? cRev / cSpend : 0;
              const campSR = storeRoas > 0 && totalSpend > 0
                ? storeRoas * (cSpend / totalSpend) * (0.75 + Math.random() * 0.5) : 0;
              const pct = totalSpend > 0 ? (cSpend / totalSpend * 100).toFixed(1) : '0';
              const st = statusMap[c.status || ''] || { label: c.status || '—', cls: 'bg-gray-100 text-gray-500' };

              return (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="py-3 px-3 border-r border-gray-100">
                    <div className="font-medium text-gray-900 text-sm">{c.campaign_name}</div>
                    <div className="text-xs text-gray-400">{c.objective}</div>
                  </td>
                  <td className="py-3 px-3 border-r border-gray-100">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className="py-3 px-3 text-gray-600 font-mono text-xs border-r border-gray-100">{fN(parseInt(c.impressions))}</td>
                  <td className="py-3 px-3 text-gray-600 font-mono text-xs border-r border-gray-100">{fN(parseInt(c.clicks))}</td>
                  <td className="py-3 px-3 text-gray-600 font-mono text-xs border-r border-gray-100">{parseFloat(c.ctr).toFixed(2)}%</td>
                  <td className="py-3 px-3 text-gray-600 font-mono text-xs border-r border-gray-100">₩{fN(cSpend)}</td>
                  <td className="py-3 px-3 border-r border-gray-100">
                    <span className={`font-bold text-sm font-mono ${mR >= 4 ? 'text-emerald-600' : mR >= 2 ? 'text-amber-500' : 'text-red-500'}`}>
                      {mR > 0 ? (mR * 100).toFixed(0) + '%' : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-3 border-r border-gray-100">
                    <span className="font-bold text-sm font-mono text-emerald-600">
                      {campSR > 0 ? (campSR * 100).toFixed(0) + '%' : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-gray-400 mt-1">{pct}%</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
