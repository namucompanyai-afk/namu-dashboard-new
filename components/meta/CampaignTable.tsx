'use client';
import { useState } from 'react';
import { fN } from './types';
import type { CampaignNode, AdsetNode, AdLeaf, StoreData, NtRow } from './types';

interface Props {
  campInsights: any[];
  storeData: StoreData;
  ntRows?: NtRow[];
  metaAdRows?: any[];
  usdToKrw?: number;
}

function buildTree(metaAdRows: any[], storeData: StoreData): CampaignNode[] {
  const campMap = new Map<string, CampaignNode>();

  for (const row of metaAdRows) {
    const campaignName = String(row['캠페인 이름'] || '').trim();
    const adsetName    = String(row['광고 세트 이름'] || '').trim();
    const adName       = String(row['광고 이름'] || '').trim();
    const spend        = Number(row['지출 금액 (USD)'] || 0);
    const impressions  = Number(row['노출'] || 0);
    const clicks       = Number(row['결과'] || 0);

    if (!campaignName) continue;

    const adRevenue = storeData.adRevenue?.[adName] || 0;

    const leaf: AdLeaf = {
      adName,
      spend,
      impressions,
      clicks,
      result: clicks,
      revenue: adRevenue,
      ntKeyword: adName,
    };

    if (!campMap.has(campaignName)) {
      campMap.set(campaignName, {
        campaignName,
        spend: 0, impressions: 0, clicks: 0, result: 0, revenue: 0,
        adsets: [],
      });
    }
    const camp = campMap.get(campaignName)!;

    let adset = camp.adsets.find(a => a.adsetName === adsetName);
    if (!adset) {
      adset = { adsetName, spend: 0, impressions: 0, clicks: 0, result: 0, revenue: 0, ads: [] };
      camp.adsets.push(adset);
    }

    adset.ads.push(leaf);
    adset.spend       += spend;
    adset.impressions += impressions;
    adset.clicks      += clicks;
    adset.result      += clicks;
    adset.revenue     += adRevenue;

    camp.spend       += spend;
    camp.impressions += impressions;
    camp.clicks      += clicks;
    camp.result      += clicks;
    camp.revenue     += adRevenue;
  }

  return Array.from(campMap.values()).sort((a, b) => b.spend - a.spend);
}

function RoasCell({ spend, revenue, rate }: { spend: number; revenue: number; rate: number }) {
  if (!revenue) return <span className="text-gray-300 text-xs">NT 없음</span>;
  const spendKrw = spend * rate;
  const roas = spendKrw > 0 ? (revenue / spendKrw * 100) : 0;
  const color = roas >= 300 ? 'text-emerald-600' : roas >= 150 ? 'text-amber-500' : 'text-red-500';
  return <span className={`font-bold text-sm font-mono ${color}`}>{roas.toFixed(0)}%</span>;
}

export default function CampaignTable({ campInsights, storeData, ntRows, metaAdRows, usdToKrw }: Props) {
  const [openCamps, setOpenCamps]   = useState<Set<string>>(new Set());
  const [openAdsets, setOpenAdsets] = useState<Set<string>>(new Set());
  const rate = usdToKrw ?? 1380;

  const tree = metaAdRows && metaAdRows.length > 0
    ? buildTree(metaAdRows, storeData)
    : [];

  const totalSpend   = tree.reduce((s, c) => s + c.spend, 0);
  const totalRevenue = tree.reduce((s, c) => s + c.revenue, 0);

  function toggleCamp(name: string) {
    setOpenCamps(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }
  function toggleAdset(key: string) {
    setOpenAdsets(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  if (tree.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">캠페인 성과</h2>
        <div className="text-center py-10 text-gray-400 text-sm">
          <div className="text-3xl mb-3">📊</div>
          메타 광고 엑셀을 업로드하면 캠페인별 성과가 표시됩니다
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-gray-900">
          캠페인 성과
          <span className="text-xs text-gray-400 font-normal ml-2">{tree.length}개 캠페인</span>
        </h2>
        {totalRevenue > 0 && (
          <div className="text-xs bg-emerald-50 text-emerald-700 px-3 py-1 rounded-full font-medium">
            전체 실 ROAS: {(totalRevenue / (totalSpend * rate) * 100).toFixed(0)}%
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-200">
              {['캠페인 / 광고세트 / 소재', 'NT 파라미터', '지출', '노출', '결과', '매출 (스스)', '실 ROAS'].map(h => (
                <th key={h} className="text-left py-2.5 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tree.map((camp) => {
              const campOpen = openCamps.has(camp.campaignName);
              return (
                <>
                  <tr
                    key={camp.campaignName}
                    className="border-b border-gray-100 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => toggleCamp(camp.campaignName)}
                  >
                    <td className="py-3 px-3 font-semibold text-gray-900">
                      <span className="mr-2 text-gray-400">{campOpen ? '▼' : '▶'}</span>
                      {camp.campaignName}
                    </td>
                    <td className="py-3 px-3"></td>
                    <td className="py-3 px-3 font-mono text-xs text-gray-700">₩{fN(camp.spend * rate)}</td>
                    <td className="py-3 px-3 font-mono text-xs text-gray-600">{fN(camp.impressions)}</td>
                    <td className="py-3 px-3 font-mono text-xs text-gray-600">{fN(camp.clicks)}</td>
                    <td className="py-3 px-3 font-mono text-xs text-gray-700">{camp.revenue > 0 ? `₩${fN(camp.revenue)}` : '-'}</td>
                    <td className="py-3 px-3"><RoasCell spend={camp.spend} revenue={camp.revenue} rate={rate} /></td>
                  </tr>

                  {campOpen && camp.adsets.map((adset) => {
                    const adsetKey  = `${camp.campaignName}__${adset.adsetName}`;
                    const adsetOpen = openAdsets.has(adsetKey);
                    return (
                      <>
                        <tr
                          key={adsetKey}
                          className="border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors"
                          onClick={() => toggleAdset(adsetKey)}
                        >
                          <td className="py-2.5 px-3 text-gray-700 pl-8">
                            <span className="mr-2 text-gray-300">{adsetOpen ? '▼' : '▶'}</span>
                            {adset.adsetName}
                          </td>
                          <td className="py-2.5 px-3"></td>
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-600">₩{fN(adset.spend * rate)}</td>
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-500">{fN(adset.impressions)}</td>
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-500">{fN(adset.clicks)}</td>
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-600">{adset.revenue > 0 ? `₩${fN(adset.revenue)}` : '-'}</td>
                          <td className="py-2.5 px-3"><RoasCell spend={adset.spend} revenue={adset.revenue} rate={rate} /></td>
                        </tr>

                        {adsetOpen && adset.ads.map((ad) => (
                          <tr key={ad.adName} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                            <td className="py-2 px-3 text-gray-500 text-xs pl-14">{ad.adName}</td>
                            <td className="py-2 px-3">
                              {ad.ntKeyword
                                ? <span className="text-xs font-mono bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded">{ad.ntKeyword}</span>
                                : <span className="text-xs text-gray-300">-</span>
                              }
                            </td>
                            <td className="py-2 px-3 font-mono text-xs text-gray-500">₩{fN(ad.spend * rate)}</td>
                            <td className="py-2 px-3 font-mono text-xs text-gray-400">{fN(ad.impressions)}</td>
                            <td className="py-2 px-3 font-mono text-xs text-gray-400">{fN(ad.clicks)}</td>
                            <td className="py-2 px-3 font-mono text-xs text-gray-500">{ad.revenue > 0 ? `₩${fN(ad.revenue)}` : '-'}</td>
                            <td className="py-2 px-3"><RoasCell spend={ad.spend} revenue={ad.revenue} rate={rate} /></td>
                          </tr>
                        ))}
                      </>
                    );
                  })}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
