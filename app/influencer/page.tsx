'use client';

import { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

interface Influencer {
  id: string;
  name: string;
  handle: string;
  followers: number;
  grade: 'nano' | 'micro' | 'macro' | 'mega';
  adCost: number;
  ntKeyword: string;
  email?: string;
}

interface InfluencerStat extends Influencer {
  visits: number;
  orders: number;
  revenue: number;
  roas: number;
}

const GRADE_MAP = {
  nano:  { label: '나노',   cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  micro: { label: '마이크로', cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  macro: { label: '매크로', cls: 'bg-purple-50 text-purple-700 border border-purple-200' },
  mega:  { label: '메가',   cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
};

function gradeFromFollowers(n: number): Influencer['grade'] {
  if (n >= 1000000) return 'mega';
  if (n >= 100000)  return 'macro';
  if (n >= 10000)   return 'micro';
  return 'nano';
}

function Avatar({ name, grade }: { name: string; grade: Influencer['grade'] }) {
  const colors = {
    nano:  'bg-amber-100 text-amber-800',
    micro: 'bg-emerald-100 text-emerald-800',
    macro: 'bg-purple-100 text-purple-800',
    mega:  'bg-blue-100 text-blue-800',
  };
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${colors[grade]}`}>
      {name[0]}
    </div>
  );
}

export default function InfluencerPage() {
  const [influencers, setInfluencers] = useState<Influencer[]>([]);
  const [ntData, setNtData] = useState<Record<string, { visits: number; orders: number; revenue: number }>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [showNt, setShowNt] = useState(false);
  const [showSs, setShowSs] = useState(false);
  const [ssFileName, setSsFileName] = useState('');
  const [ssParsed, setSsParsed] = useState<any[] | null>(null);
  const [ssLoading, setSsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [ntUrl, setNtUrl] = useState('');
  const [ntId, setNtId] = useState('');
  const [ntCopied, setNtCopied] = useState(false);
  const [form, setForm] = useState({
    name: '', handle: '', followers: '', adCost: '', ntKeyword: '', email: '', grade: 'micro' as Influencer['grade'],
  });

  useEffect(() => {
    fetch('/api/influencer').then(r => r.json()).then(data => {
      if (data.influencers?.length) setInfluencers(data.influencers);
      if (data.ntData) setNtData(data.ntData);
      if (data.savedAt) setSavedAt(new Date(data.savedAt).toLocaleDateString('ko-KR'));
    }).catch(() => {});
  }, []);

  // 스스 엑셀 파싱
  const parseSsExcel = useCallback((file: File) => {
    setSsLoading(true);
    setSsFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
        // influencer 미디엄만 필터
        const filtered = rows.filter((r: any) => String(r['nt_medium'] || '').trim() === 'influencer');
        setSsParsed(filtered);
      } catch (err) {
        alert('엑셀 파싱 실패: ' + err);
      } finally {
        setSsLoading(false);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseSsExcel(file);
  }, [parseSsExcel]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseSsExcel(file);
  };

  // 스스 엑셀 적용
  async function applySs() {
    if (!ssParsed) return;
    const parsed: Record<string, { visits: number; orders: number; revenue: number }> = {};
    for (const row of ssParsed) {
      const keyword = String(row['nt_keyword'] || '').trim();
      if (!keyword) continue;
      if (!parsed[keyword]) parsed[keyword] = { visits: 0, orders: 0, revenue: 0 };
      parsed[keyword].visits  += Number(row['유입수']   || 0);
      parsed[keyword].orders  += Number(row['결제수']   || 0);
      parsed[keyword].revenue += Number(row['결제금액'] || 0);
    }
    setNtData(parsed);
    try {
      await fetch('/api/influencer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencers, ntData: parsed }),
      });
      setSavedAt(new Date().toLocaleDateString('ko-KR'));
    } catch {}
    setShowSs(false);
    setSsParsed(null);
    setSsFileName('');
  }

  async function addInfluencer() {
    if (!form.name || !form.ntKeyword) { alert('이름과 NT 파라미터 ID는 필수예요.'); return; }
    const newInf: Influencer = {
      id: Date.now().toString(),
      name: form.name,
      handle: form.handle,
      followers: parseInt(form.followers) || 0,
      grade: gradeFromFollowers(parseInt(form.followers) || 0),
      adCost: parseInt(form.adCost) || 0,
      ntKeyword: form.ntKeyword,
      email: form.email,
    };
    const updated = [...influencers, newInf];
    setInfluencers(updated);
    try {
      const existing = await fetch('/api/influencer').then(r => r.json());
      await fetch('/api/influencer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencers: updated, ntData: existing.ntData || {} }),
      });
    } catch {}
    setShowAdd(false);
    setForm({ name: '', handle: '', followers: '', adCost: '', ntKeyword: '', email: '', grade: 'micro' });
  }

  const ntGenUrl = (() => {
    if (!ntUrl || !ntId) return '';
    const sep = ntUrl.includes('?') ? '&' : '?';
    return `${ntUrl}${sep}nt_source=instagram&nt_medium=influencer&nt_keyword=inf_${ntId}`;
  })();

  function copyNt() {
    if (!ntGenUrl) return;
    navigator.clipboard.writeText(ntGenUrl);
    setNtCopied(true);
    setTimeout(() => setNtCopied(false), 2000);
  }

  const stats: InfluencerStat[] = influencers.map(inf => {
    const d = ntData[inf.ntKeyword] || { visits: 0, orders: 0, revenue: 0 };
    const roas = inf.adCost > 0 && d.revenue > 0 ? (d.revenue / inf.adCost * 100) : 0;
    return { ...inf, ...d, roas };
  }).sort((a, b) => b.roas - a.roas);

  const totalAdCost  = influencers.reduce((s, i) => s + i.adCost, 0);
  const totalRevenue = stats.reduce((s, i) => s + i.revenue, 0);
  const totalVisits  = stats.reduce((s, i) => s + i.visits, 0);
  const totalRoas    = totalAdCost > 0 && totalRevenue > 0 ? Math.round(totalRevenue / totalAdCost * 100) : 0;

  // 스스 모달 미리보기 집계
  const ssPreview = ssParsed
    ? Object.entries(
        ssParsed.reduce((acc: any, r: any) => {
          const kw = String(r['nt_keyword'] || '').trim();
          if (!kw) return acc;
          if (!acc[kw]) acc[kw] = { visits: 0, orders: 0, revenue: 0 };
          acc[kw].visits  += Number(r['유입수']   || 0);
          acc[kw].orders  += Number(r['결제수']   || 0);
          acc[kw].revenue += Number(r['결제금액'] || 0);
          return acc;
        }, {})
      ).sort((a: any, b: any) => b[1].visits - a[1].visits)
    : [];

  return (
    <div>
      <div className="text-xs font-medium text-gray-500">인플루언서</div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">인플루언서 성과</h1>

      {/* 상단 버튼 */}
      <div className="mt-5 flex flex-wrap gap-3 items-center">
        <button
          onClick={() => setShowSs(true)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-colors text-sm font-medium ${ssFileName ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
        >
          🛒 {ssFileName || '스마트스토어 엑셀 업로드'}
        </button>
        <button
          onClick={() => setShowNt(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors text-sm font-medium"
        >
          🔗 NT 링크 생성기
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors text-sm font-medium"
        >
          + 인플루언서 추가
        </button>
        {savedAt && <span className="text-xs text-gray-400 ml-auto">마지막 저장: {savedAt}</span>}
      </div>

      {/* 요약 카드 */}
      <div className="mt-5 grid grid-cols-4 gap-3">
        {[
          { label: '총 인플루언서', val: `${influencers.length}명`, sub: '등록된 인플루언서', green: false },
          { label: '총 광고비', val: totalAdCost > 0 ? `₩${totalAdCost.toLocaleString()}` : '-', sub: '전체 합산', green: false },
          { label: '총 매출 (스스)', val: totalRevenue > 0 ? `₩${totalRevenue.toLocaleString()}` : '-', sub: 'NT 파라미터 기준', green: false },
          { label: '전체 ROAS', val: totalRoas > 0 ? `${totalRoas}%` : '-', sub: '매출 ÷ 광고비', green: totalRoas > 0 },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-4">
            <div className="text-xs text-gray-400 mb-1">{c.label}</div>
            <div className={`text-2xl font-semibold ${c.green ? 'text-emerald-600' : 'text-gray-900'}`}>{c.val}</div>
            <div className="text-xs text-gray-400 mt-1">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* 테이블 */}
      <div className="mt-5 bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="text-sm font-semibold text-gray-900">
            인플루언서별 성과
            <span className="text-xs text-gray-400 font-normal ml-2">ROAS 높은 순</span>
          </div>
          <div className="text-xs text-gray-400">ROAS = 매출 ÷ 광고비 × 100</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50">
                {['순위', '인플루언서', '구분', '팔로워', '유입수', '광고비', '매출', 'ROAS'].map(h => (
                  <th key={h} className="text-left py-2.5 px-4 text-xs font-semibold text-gray-400 whitespace-nowrap border-b border-gray-100">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-gray-400 text-sm">
                    <div className="text-2xl mb-2">👤</div>
                    인플루언서를 추가하면 성과가 표시됩니다
                  </td>
                </tr>
              )}
              {stats.map((inf, i) => (
                <tr key={inf.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="py-3 px-4 text-xs text-gray-400 font-medium">{i + 1}위</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <Avatar name={inf.name} grade={inf.grade} />
                      <div>
                        <div className="font-medium text-gray-900 text-sm">{inf.name}</div>
                        <div className="text-xs text-gray-400">{inf.handle}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${GRADE_MAP[inf.grade].cls}`}>
                      {GRADE_MAP[inf.grade].label}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs text-gray-600">{inf.followers.toLocaleString()}</td>
                  <td className="py-3 px-4 text-xs font-mono text-gray-700">{inf.visits > 0 ? inf.visits.toLocaleString() : '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono text-gray-700">{inf.adCost > 0 ? `₩${inf.adCost.toLocaleString()}` : '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono text-gray-700">{inf.revenue > 0 ? `₩${inf.revenue.toLocaleString()}` : '-'}</td>
                  <td className="py-3 px-4">
                    {inf.roas > 0
                      ? <span className={`font-bold text-sm font-mono ${inf.roas >= 300 ? 'text-emerald-600' : inf.roas >= 100 ? 'text-amber-500' : 'text-red-500'}`}>{Math.round(inf.roas)}%</span>
                      : <span className="text-xs text-gray-300">NT 없음</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 스마트스토어 업로드 모달 */}
      {showSs && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-gray-900">🛒 스마트스토어 매출 연결</h2>
                <p className="text-xs text-gray-500 mt-0.5">NT 파라미터 기반 인플루언서별 매출 분석</p>
              </div>
              <button onClick={() => { setShowSs(false); setSsParsed(null); setSsFileName(''); }} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6">
              {/* 안내 */}
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 mb-4">
                <div className="text-xs font-semibold text-emerald-800 mb-1.5">📍 파일 받는 방법</div>
                {['스마트스토어 셀러센터 → 통계 → 마케팅분석', '사용자정의채널 탭 클릭', '기간 설정 후 다운로드'].map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-emerald-700 mb-1">
                    <span className="w-4 h-4 bg-emerald-600 text-white rounded-full flex items-center justify-center flex-shrink-0 text-xs">{i + 1}</span>
                    {s}
                  </div>
                ))}
                <p className="text-xs text-emerald-600 mt-2 font-medium">nt_medium=influencer 데이터만 자동으로 필터링됩니다</p>
              </div>

              {!ssParsed ? (
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors mb-4 ${isDragging ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-emerald-300'}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('ss-inf-input')?.click()}
                >
                  <div className="text-3xl mb-2">📊</div>
                  <div className="text-sm font-medium text-gray-700 mb-1">
                    {ssLoading ? '⏳ 파싱 중...' : '사용자정의채널 엑셀 업로드'}
                  </div>
                  <p className="text-xs text-gray-400">클릭하거나 파일을 드래그 · .xlsx</p>
                  <input id="ss-inf-input" type="file" accept=".xlsx" className="hidden" onChange={handleFile} />
                </div>
              ) : (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded-lg font-medium">✅ {ssFileName}</span>
                    <button onClick={() => { setSsParsed(null); setSsFileName(''); }} className="text-xs text-gray-400 hover:text-gray-600">다시 업로드</button>
                  </div>

                  {ssParsed.length === 0 ? (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
                      <div className="text-sm font-medium text-amber-700 mb-1">인플루언서 데이터 없음</div>
                      <p className="text-xs text-amber-600">nt_medium=influencer 데이터가 없어요.<br/>NT 링크 생성기로 만든 링크를 인플루언서에게 전달했는지 확인해주세요.</p>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <div className="bg-gray-50 rounded-lg p-3">
                          <div className="text-xs text-gray-400">인플루언서 수</div>
                          <div className="text-sm font-semibold text-gray-800 mt-0.5">{ssPreview.length}명</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3">
                          <div className="text-xs text-gray-400">총 유입수</div>
                          <div className="text-sm font-semibold text-gray-800 mt-0.5">{ssParsed.reduce((s: number, r: any) => s + Number(r['유입수'] || 0), 0).toLocaleString()}</div>
                        </div>
                      </div>
                      <div className="max-h-36 overflow-y-auto border border-gray-100 rounded-lg">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="text-left p-2 text-gray-400 font-medium">NT 키워드</th>
                              <th className="text-right p-2 text-gray-400 font-medium">유입</th>
                              <th className="text-right p-2 text-gray-400 font-medium">매출</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ssPreview.map(([kw, d]: any) => (
                              <tr key={kw} className="border-t border-gray-50">
                                <td className="p-2 text-gray-600 font-mono">{kw}</td>
                                <td className="p-2 text-right text-gray-700">{d.visits.toLocaleString()}</td>
                                <td className="p-2 text-right text-gray-700">₩{d.revenue.toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={applySs}
                  disabled={!ssParsed}
                  className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-colors ${ssParsed ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                >
                  ✅ 적용 + 저장
                </button>
                <button onClick={() => { setShowSs(false); setSsParsed(null); setSsFileName(''); }} className="px-5 py-3 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors text-sm">취소</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NT 링크 생성기 모달 */}
      {showNt && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-50 to-indigo-50 px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-gray-900">🔗 NT 링크 생성기</h2>
                <p className="text-xs text-gray-500 mt-0.5">인플루언서 전용 스마트스토어 파라미터</p>
              </div>
              <button onClick={() => setShowNt(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 block mb-2">상품 URL</label>
                <input type="text" value={ntUrl} onChange={e => setNtUrl(e.target.value)} placeholder="https://smartstore.naver.com/나무/products/..."
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 block mb-2">인플루언서 ID (영문, 예: soyeon)</label>
                <input type="text" value={ntId} onChange={e => setNtId(e.target.value)} placeholder="soyeon"
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                <p className="text-xs text-gray-400 mt-1">NT 파라미터: inf_{ntId || 'ID'}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-4">
                <div className="text-xs font-semibold text-gray-400 mb-2">생성된 URL</div>
                <div className="text-xs font-mono text-gray-700 break-all">{ntGenUrl || 'URL과 인플루언서 ID를 입력하면 여기에 생성됩니다'}</div>
              </div>
              <div className="flex gap-3">
                <button onClick={copyNt} disabled={!ntGenUrl}
                  className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-colors ${ntGenUrl ? 'bg-purple-600 text-white hover:bg-purple-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
                  {ntCopied ? '✅ 복사됨!' : '📋 URL 복사'}
                </button>
                <button onClick={() => setShowNt(false)} className="px-5 py-3 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors text-sm">닫기</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 인플루언서 추가 모달 */}
      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">인플루언서 추가</h2>
              <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: '이름', key: 'name', ph: '박소연' },
                  { label: '인스타 계정', key: 'handle', ph: '@soyeon_cook' },
                  { label: '팔로워 수', key: 'followers', ph: '42000' },
                  { label: '광고비 (원)', key: 'adCost', ph: '200000' },
                  { label: 'NT 파라미터 ID', key: 'ntKeyword', ph: 'inf_soyeon' },
                  { label: '이메일 (선택)', key: 'email', ph: 'hello@email.com' },
                ].map(f => (
                  <div key={f.key}>
                    <label className="text-xs text-gray-500 block mb-1">{f.label}</label>
                    <input type="text" placeholder={f.ph} value={(form as any)[f.key]}
                      onChange={e => {
                        const val = e.target.value;
                        setForm(p => ({ ...p, [f.key]: val, ...(f.key === 'followers' ? { grade: gradeFromFollowers(parseInt(val) || 0) } : {}) }));
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <label className="text-xs text-gray-500 block mb-1">구분 (팔로워 입력 시 자동 설정)</label>
                <select value={form.grade} onChange={e => setForm(p => ({ ...p, grade: e.target.value as Influencer['grade'] }))}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500">
                  <option value="nano">나노 (1천~1만)</option>
                  <option value="micro">마이크로 (1만~10만)</option>
                  <option value="macro">매크로 (10만~100만)</option>
                  <option value="mega">메가 (100만 이상)</option>
                </select>
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={addInfluencer} className="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-colors text-sm">✅ 추가</button>
                <button onClick={() => setShowAdd(false)} className="px-5 py-3 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors text-sm">취소</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
