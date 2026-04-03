'use client';
import { useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import type { StoreData, NtRow } from './types';

interface Props {
  onApply: (data: StoreData, ntRows: NtRow[]) => void;
  onClose: () => void;
}

export default function StoreConnect({ onApply, onClose }: Props) {
  const [tab, setTab] = useState<'excel' | 'manual'>('excel');
  const [rev, setRev] = useState('');
  const [orders, setOrders] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<NtRow[] | null>(null);
  const [fileName, setFileName] = useState('');

  const parseExcel = useCallback((file: File) => {
    setLoading(true);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
        const ntRows: NtRow[] = [];
        for (const row of rows) {
          const nt_source  = String(row['nt_source']  || '').trim();
          const nt_medium  = String(row['nt_medium']  || '').trim();
          const nt_detail  = String(row['nt_detail']  || '').trim();
          const nt_keyword = String(row['nt_keyword'] || '').trim();
          const revenue    = Number(row['결제금액']    || 0);
          const orders     = Number(row['결제수']      || 0);
          if (nt_medium !== 'paid_social') continue;
          if (!nt_detail && !nt_keyword) continue;
          ntRows.push({ nt_source, nt_medium, nt_detail, nt_keyword, revenue, orders });
        }
        setParsed(ntRows);
      } catch (err) {
        alert('엑셀 파싱 실패: ' + err);
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

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseExcel(file);
  };

  async function applyExcel() {
    if (!parsed) return;
    const campaignRevenue: Record<string, number> = {};
    const adRevenue: Record<string, number> = {};
    let totalRevenue = 0;
    let totalOrders = 0;
    for (const row of parsed) {
      if (row.nt_detail) campaignRevenue[row.nt_detail] = (campaignRevenue[row.nt_detail] || 0) + row.revenue;
      if (row.nt_keyword) adRevenue[row.nt_keyword] = (adRevenue[row.nt_keyword] || 0) + row.revenue;
      totalRevenue += row.revenue;
      totalOrders  += row.orders;
    }
    const storeData: StoreData = {
      revenue: totalRevenue,
      orders: totalOrders,
      source: 'excel',
      campaignRevenue,
      adRevenue,
    };
    try {
      const existing = await fetch('/api/meta').then(r => r.json());
      await fetch('/api/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metaRows: existing.metaRows || [], ntRows: parsed }),
      });
    } catch (err) {
      console.error('저장 실패:', err);
    }
    onApply(storeData, parsed);
  }

  function applyManual() {
    const revenue = parseFloat(rev.replace(/,/g, '')) || 0;
    const ord = parseInt(orders) || 0;
    if (!revenue) { alert('매출 금액을 입력해주세요.'); return; }
    onApply({ revenue, orders: ord, source: 'manual' }, []);
  }

  const totalRev   = parsed?.reduce((s, r) => s + r.revenue, 0) || 0;
  const totalOrd   = parsed?.reduce((s, r) => s + r.orders, 0) || 0;
  const uniqueCamp = parsed ? new Set(parsed.map(r => r.nt_detail).filter(Boolean)).size : 0;
  const uniqueAd   = parsed ? new Set(parsed.map(r => r.nt_keyword).filter(Boolean)).size : 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">📦 스마트스토어 매출 연결</h2>
            <p className="text-xs text-gray-500 mt-0.5">NT 파라미터 기반 실매출 → 실 ROAS 계산</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="p-6">
          <div className="flex gap-2 mb-5">
            {(['excel', 'manual'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === t ? 'bg-emerald-600 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {t === 'excel' ? '📊 엑셀 업로드' : '✏️ 직접 입력'}
              </button>
            ))}
          </div>

          {tab === 'excel' && (
            <>
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 mb-4">
                <div className="text-xs font-semibold text-emerald-800 mb-1.5">📍 파일 받는 방법</div>
                {['스마트스토어 셀러센터 → 통계 → 마케팅분석', '사용자정의채널 탭 클릭', '기간 설정 후 다운로드'].map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-emerald-700 mb-1">
                    <span className="w-4 h-4 bg-emerald-600 text-white rounded-full flex items-center justify-center flex-shrink-0">{i + 1}</span>
                    {s}
                  </div>
                ))}
              </div>

              {!parsed ? (
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors mb-4 ${isDragging ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-emerald-300'}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('nt-excel-input')?.click()}
                >
                  <div className="text-3xl mb-2">📊</div>
                  <div className="text-sm font-medium text-gray-700 mb-1">
                    {loading ? '⏳ 파싱 중...' : '사용자정의채널 엑셀 업로드'}
                  </div>
                  <p className="text-xs text-gray-400">클릭하거나 파일을 드래그 · .xlsx</p>
                  <input id="nt-excel-input" type="file" accept=".xlsx" className="hidden" onChange={handleFile} />
                </div>
              ) : (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded-lg font-medium">✅ {fileName}</span>
                    <button onClick={() => { setParsed(null); setFileName(''); }} className="text-xs text-gray-400 hover:text-gray-600">다시 업로드</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {[
                      { label: '총 매출', val: `₩${totalRev.toLocaleString()}` },
                      { label: '총 주문', val: `${totalOrd}건` },
                      { label: '캠페인 수', val: `${uniqueCamp}개` },
                      { label: '소재 수', val: `${uniqueAd}개` },
                    ].map(c => (
                      <div key={c.label} className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xs text-gray-400">{c.label}</div>
                        <div className="text-sm font-semibold text-gray-800 mt-0.5">{c.val}</div>
                      </div>
                    ))}
                  </div>
                  <div className="max-h-36 overflow-y-auto border border-gray-100 rounded-lg">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="text-left p-2 text-gray-400 font-medium">캠페인 (nt_detail)</th>
                          <th className="text-right p-2 text-gray-400 font-medium">매출</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(
                          parsed.reduce((acc, r) => {
                            if (r.nt_detail) acc[r.nt_detail] = (acc[r.nt_detail] || 0) + r.revenue;
                            return acc;
                          }, {} as Record<string, number>)
                        ).sort((a, b) => b[1] - a[1]).map(([name, rev]) => (
                          <tr key={name} className="border-t border-gray-50">
                            <td className="p-2 text-gray-600 truncate max-w-[200px]">{name}</td>
                            <td className="p-2 text-right text-gray-700 font-mono">₩{rev.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={applyExcel} disabled={!parsed}
                  className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-colors ${parsed ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
                  ✅ ROAS 계산 적용 + 저장
                </button>
                <button onClick={onClose} className="px-5 py-3 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors">취소</button>
              </div>
            </>
          )}

          {tab === 'manual' && (
            <>
              <div className="space-y-4 mb-5">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Meta 유입 총매출 (₩)</label>
                  <input type="text" value={rev} onChange={e => setRev(e.target.value)} placeholder="예: 61800000"
                    className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">총 주문건수</label>
                  <input type="text" value={orders} onChange={e => setOrders(e.target.value)} placeholder="예: 6720"
                    className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={applyManual} className="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-colors">✅ ROAS 계산 적용</button>
                <button onClick={onClose} className="px-5 py-3 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors">취소</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
