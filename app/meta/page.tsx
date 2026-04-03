'use client';

import { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import CampaignTable from '@/components/meta/CampaignTable';
import NtGenerator from '@/components/meta/NtGenerator';
import StoreConnect from '@/components/meta/StoreConnect';

import type { StoreData, NtRow } from '@/components/meta/types';

export default function MetaDashboardPage() {
  const [metaAdRows, setMetaAdRows] = useState<any[]>([]);
  const [storeData, setStoreData] = useState<StoreData>({ revenue: 0, orders: 0, source: 'none' });
  const [ntRows, setNtRows] = useState<NtRow[]>([]);
  const [metaFileName, setMetaFileName] = useState('');
  const [ssFileName, setSsFileName] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showNt, setShowNt] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [usdToKrw, setUsdToKrw] = useState(1380);

  useEffect(() => {
    fetch('/api/meta').then(r => r.json()).then(data => {
      if (data.metaRows?.length) {
        setMetaAdRows(data.metaRows);
        setMetaFileName('저장된 메타 광고 데이터');
      }
      if (data.ntRows?.length) {
        setNtRows(data.ntRows);
        const campaignRevenue: Record<string, number> = {};
        const adRevenue: Record<string, number> = {};
        let totalRevenue = 0;
        let totalOrders = 0;
        for (const row of data.ntRows) {
          if (row.nt_detail) campaignRevenue[row.nt_detail] = (campaignRevenue[row.nt_detail] || 0) + row.revenue;
          if (row.nt_keyword) adRevenue[row.nt_keyword] = (adRevenue[row.nt_keyword] || 0) + row.revenue;
          totalRevenue += row.revenue;
          totalOrders += row.orders;
        }
        setStoreData({ revenue: totalRevenue, orders: totalOrders, source: 'excel', campaignRevenue, adRevenue });
        setSsFileName('저장된 스마트스토어 데이터');
      }
      if (data.savedAt) setSavedAt(new Date(data.savedAt).toLocaleDateString('ko-KR'));
    }).catch(() => {});
  }, []);

  function handleMetaExcel(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMetaFileName(file.name);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
      const filtered = rows.filter((r: any) => r['광고 이름'] || r['캠페인 이름']);
      setMetaAdRows(filtered);
      try {
        const existing = await fetch('/api/meta').then(r => r.json());
        await fetch('/api/meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metaRows: filtered, ntRows: existing.ntRows || [] }),
        });
        setSavedAt(new Date().toLocaleDateString('ko-KR'));
      } catch (err) {
        console.error('저장 실패:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  const totalSpend = metaAdRows.reduce((s, r) => s + Number(r['지출 금액 (USD)'] || 0), 0);
  const totalSpendKrw = totalSpend * usdToKrw;
  const totalClicks = metaAdRows.reduce((s, r) => s + Number(r['결과'] || 0), 0);
  const totalRevenue = storeData.revenue || 0;
  const realRoas = totalSpendKrw > 0 && totalRevenue > 0 ? (totalRevenue / totalSpendKrw * 100) : 0;

  return (
    <div>
      <div className="text-xs font-medium text-gray-500">META</div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Meta 광고 성과</h1>

      {/* 업로드 + 환율 입력 */}
      <div className="mt-5 flex flex-wrap gap-3 items-center">
        <label className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border cursor-pointer transition-colors text-sm font-medium ${metaFileName ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
          📊 {metaFileName || '메타 광고 엑셀 업로드'}
          <input type="file" accept=".xlsx" className="hidden" onChange={handleMetaExcel} />
        </label>

        <button
          onClick={() => setShowStore(true)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-colors text-sm font-medium ${ssFileName ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
        >
          🛒 {ssFileName || '스마트스토어 엑셀 업로드'}
        </button>

        <button
          onClick={() => setShowNt(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors text-sm font-medium"
        >
          🔗 NT 파라미터 생성기
        </button>

        {/* 환율 입력 */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white">
          <span className="text-xs text-gray-400 whitespace-nowrap">USD 환율</span>
          <input
            type="number"
            value={usdToKrw}
            onChange={e => setUsdToKrw(Number(e.target.value))}
            className="w-20 text-sm font-mono text-gray-700 focus:outline-none text-right"
          />
          <span className="text-xs text-gray-400">₩</span>
        </div>

        {savedAt && (
          <span className="text-xs text-gray-400 ml-auto">마지막 저장: {savedAt}</span>
        )}
      </div>

      {/* 요약 카드 */}
      <div className="mt-5 grid grid-cols-4 gap-3">
        {[
          { label: '총 광고비', val: totalSpendKrw > 0 ? `₩${Math.round(totalSpendKrw).toLocaleString()}` : '-', sub: totalSpend > 0 ? `$${totalSpend.toFixed(0)} × ${usdToKrw}` : '메타 엑셀 업로드 필요' },
          { label: '총 매출 (스스)', val: totalRevenue > 0 ? `₩${Math.round(totalRevenue).toLocaleString()}` : '-', sub: 'NT 파라미터 기준' },
          { label: '실 ROAS', val: realRoas > 0 ? `${Math.round(realRoas)}%` : '-', sub: '스스 매출 기준', highlight: realRoas > 0 ? (realRoas >= 300 ? 'green' : realRoas >= 150 ? 'yellow' : 'red') : '' },
          { label: '총 결과 (클릭)', val: totalClicks > 0 ? totalClicks.toLocaleString() : '-', sub: '전체 캠페인' },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-4">
            <div className="text-xs text-gray-400 mb-1">{c.label}</div>
            <div className={`text-2xl font-semibold ${c.highlight === 'green' ? 'text-emerald-600' : c.highlight === 'yellow' ? 'text-amber-500' : c.highlight === 'red' ? 'text-red-500' : 'text-gray-900'}`}>
              {c.val}
            </div>
            <div className="text-xs text-gray-400 mt-1">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* 캠페인 테이블 */}
      <div className="mt-5">
        <CampaignTable campInsights={[]} storeData={storeData} ntRows={ntRows} metaAdRows={metaAdRows} usdToKrw={usdToKrw} />
      </div>

      {showNt && <NtGenerator onClose={() => setShowNt(false)} />}
      {showStore && (
        <StoreConnect
          onApply={(data, rows) => {
            setStoreData(data);
            setNtRows(rows);
            setSsFileName('스마트스토어 데이터 업로드됨');
            setShowStore(false);
          }}
          onClose={() => setShowStore(false)}
        />
      )}
    </div>
  );
}
