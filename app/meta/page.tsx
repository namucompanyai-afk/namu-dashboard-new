'use client';

import { useState } from 'react';
import { generateDemoData } from '@/components/meta/demoData';
import RoasBanner from '@/components/meta/RoasBanner';
import KpiGrid from '@/components/meta/KpiGrid';
import { TrendChart, RoasChart } from '@/components/meta/Charts';
import CampaignTable from '@/components/meta/CampaignTable';
import { AudienceDonut, Funnel } from '@/components/meta/AudienceFunnel';
import NtGenerator from '@/components/meta/NtGenerator';
import StoreConnect from '@/components/meta/StoreConnect';

import type { InsightData, CampaignInsight, DailyData, AudienceData, StoreData, GoalSettings } from '@/components/meta/types';

const DEFAULT_GOALS: GoalSettings = { roas: 400, ctr: 3, cpc: 500, spend: 5000000 };

// 날짜를 YYYY-MM-DD 형식으로 반환
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// 오늘 기준 N일 전 날짜 반환
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

// 프리셋 옵션
const DATE_PRESETS = [
  { label: '오늘', value: 'today', getRange: () => ({ ds: formatDate(new Date()), de: formatDate(new Date()) }) },
  { label: '어제', value: 'yesterday', getRange: () => ({ ds: daysAgo(1), de: daysAgo(1) }) },
  { label: '최근 7일', value: '7d', getRange: () => ({ ds: daysAgo(6), de: formatDate(new Date()) }) },
  { label: '최근 30일', value: '30d', getRange: () => ({ ds: daysAgo(29), de: formatDate(new Date()) }) },
  { label: '최근 90일', value: '90d', getRange: () => ({ ds: daysAgo(89), de: formatDate(new Date()) }) },
  { label: '직접 입력', value: 'custom', getRange: () => ({ ds: daysAgo(29), de: formatDate(new Date()) }) },
];

export default function MetaDashboardPage() {
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [isDemo, setIsDemo] = useState(false);

  // 날짜 상태 — 기본값: 최근 30일
  const [datePreset, setDatePreset] = useState('30d');
  const [dateStart, setDateStart] = useState(daysAgo(29));
  const [dateEnd, setDateEnd] = useState(formatDate(new Date()));
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [insights, setInsights] = useState<{ data: InsightData[] }>({ data: [] });
  const [campInsights, setCampInsights] = useState<CampaignInsight[]>([]);
  const [daily, setDaily] = useState<DailyData[]>([]);
  const [audience, setAudience] = useState<AudienceData[]>([]);
  const [storeData, setStoreData] = useState<StoreData>({ revenue: 0, orders: 0, source: 'none' });
  const [goals] = useState<GoalSettings>(DEFAULT_GOALS);
  const [showNt, setShowNt] = useState(false);
  const [showStore, setShowStore] = useState(false);

  const ins = insights.data[0] || {} as InsightData;
  const spend = parseFloat(ins.spend || '0');
  let rev = 0;
  (ins.action_values || []).forEach(av => { if (av.action_type === 'purchase') rev += parseFloat(av.value); });
  const metaRoas = spend > 0 ? rev / spend : 0;
  const storeRoas = spend > 0 && storeData.revenue > 0 ? storeData.revenue / spend : 0;

  // 날짜 프리셋 선택 핸들러
  function handlePresetChange(preset: string) {
    setDatePreset(preset);
    const found = DATE_PRESETS.find(p => p.value === preset);
    if (found && preset !== 'custom') {
      const { ds, de } = found.getRange();
      setDateStart(ds);
      setDateEnd(de);
    }
    if (preset !== 'custom') setShowDatePicker(false);
  }

  // 날짜 표시 포맷
  function displayDateRange(): string {
    const found = DATE_PRESETS.find(p => p.value === datePreset);
    if (found && datePreset !== 'custom') return `${found.label} (${dateStart} ~ ${dateEnd})`;
    return `${dateStart} ~ ${dateEnd}`;
  }

  async function connectDemo() {
    setLoading(true); setLoadingText('샘플 데이터 불러오는 중...');
    await new Promise(r => setTimeout(r, 700));
    const demo = generateDemoData();
    setInsights(demo.insights as { data: InsightData[] });
    setDaily(demo.daily);
    setCampInsights(demo.campInsights);
    setAudience(demo.audience);
    setStoreData({ revenue: 61800000, orders: 6720, source: 'demo' });
    setIsDemo(true); setConnected(true); setLoading(false);
  }

  async function connectReal() {
    if (!token || !accountId) { alert('Access Token과 계정 ID를 입력하세요.'); return; }
    setLoading(true);
    const G = 'https://graph.facebook.com/v21.0';
    const acct = accountId.startsWith('act_') ? accountId : 'act_' + accountId;
    const DS = dateStart;
    const DE = dateEnd;
    try {
      const api = async (path: string) => {
        setLoadingText(
          path.includes('time_increment') ? '일별 데이터 수집 중...' :
          path.includes('level=campaign') ? '캠페인 분석 중...' :
          '광고 성과 집계 중...'
        );
        const r = await fetch(`${G}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        return j;
      };
      const ins2 = await api(`/${acct}/insights?fields=impressions,clicks,spend,ctr,reach,actions,action_values&time_range={"since":"${DS}","until":"${DE}"}&level=account`);
      const dr = await api(`/${acct}/insights?fields=impressions,clicks,spend,ctr&time_range={"since":"${DS}","until":"${DE}"}&time_increment=1&level=account`);
      const cir = await api(`/${acct}/insights?fields=campaign_id,campaign_name,impressions,clicks,spend,ctr,actions,action_values&time_range={"since":"${DS}","until":"${DE}"}&level=campaign&limit=50`);
      setInsights(ins2);
      setDaily((dr.data || []).sort((a: DailyData, b: DailyData) => a.date_start.localeCompare(b.date_start)));
      setCampInsights(cir.data || []);
      setConnected(true);
    } catch (e) { alert('연결 실패: ' + (e as Error).message); }
    setLoading(false);
  }

  // 날짜 변경 후 데이터 재조회
  async function refetchWithNewDates() {
    if (!connected || isDemo) return;
    setShowDatePicker(false);
    await connectReal();
  }

  if (!connected) return (
    <div>
      <div className="text-xs font-medium text-gray-500">META</div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Meta 광고 대시보드</h1>

      {/* 날짜 범위 선택 — 연결 전 */}
      <div className="mt-6 max-w-lg">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">조회 기간</label>
        <div className="flex flex-wrap gap-2 mb-3">
          {DATE_PRESETS.map(p => (
            <button
              key={p.value}
              onClick={() => handlePresetChange(p.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                datePreset === p.value
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {datePreset === 'custom' && (
          <div className="flex gap-2 items-center">
            <input
              type="date"
              value={dateStart}
              onChange={e => setDateStart(e.target.value)}
              className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-gray-400 text-sm">~</span>
            <input
              type="date"
              value={dateEnd}
              onChange={e => setDateEnd(e.target.value)}
              className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
        {datePreset !== 'custom' && (
          <p className="text-xs text-gray-400">{dateStart} ~ {dateEnd}</p>
        )}
      </div>

      <div className="mt-6 max-w-lg">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-5 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-lg">f</div>
              <div>
                <h2 className="font-semibold text-gray-900">Meta × 스마트스토어 ROAS</h2>
                <p className="text-xs text-gray-500 mt-0.5">Meta API 연동 · NT 기반 실매출 ROAS 계산</p>
              </div>
            </div>
            <div className="mt-3 text-xs text-blue-700 bg-blue-100 rounded-lg px-3 py-2">
              Meta 픽셀은 스마트스토어 결제 완료를 정확히 추적하지 못해 <strong>ROAS 과대 측정</strong>이 발생합니다. 실제 매출을 연결하면 <strong>진짜 ROAS</strong>를 캠페인별로 볼 수 있습니다.
            </div>
          </div>
          <div className="p-6 space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Access Token</label>
              <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="EAAxxxxxxxxxxxxxxxx..." className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 mt-1">Graph API Explorer에서 발급 · ads_read 권한 필요</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Ad Account ID</label>
              <input type="text" value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="act_1234567890..." className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button onClick={connectReal} className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors">🔗 연결하고 대시보드 시작</button>
            <button onClick={connectDemo} className="w-full py-3 border border-gray-200 text-gray-600 rounded-xl font-medium hover:bg-gray-50 transition-colors text-sm">👀 샘플 데이터로 대시보드 미리보기</button>
          </div>
        </div>
      </div>

      {loading && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 flex flex-col items-center gap-4 shadow-xl">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-600">{loadingText}</p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      {isDemo && (
        <div className="mb-5 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700 flex items-center justify-between">
          <span>👀 샘플 데이터 미리보기 모드 — 실제 Meta API와 스마트스토어 데이터를 연결하면 이 화면에 실데이터가 표시됩니다</span>
          <button onClick={() => { setConnected(false); setIsDemo(false); }} className="ml-4 text-amber-600 hover:text-amber-800 font-semibold whitespace-nowrap">실데이터 연결하기 →</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs font-medium text-gray-500">META</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">광고 성과 개요</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* 날짜 범위 선택 — 연결 후 (대시보드 상단) */}
          <div className="relative">
            <button
              onClick={() => setShowDatePicker(v => !v)}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <span>📅</span>
              <span>{displayDateRange()}</span>
              <span className="text-gray-400">▾</span>
            </button>

            {showDatePicker && (
              <div className="absolute right-0 top-10 z-40 bg-white border border-gray-200 rounded-2xl shadow-xl p-4 w-80">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">조회 기간 선택</p>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {DATE_PRESETS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => handlePresetChange(p.value)}
                      className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        datePreset === p.value
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {datePreset === 'custom' && (
                  <div className="space-y-2 mb-4">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">시작일</label>
                      <input
                        type="date"
                        value={dateStart}
                        onChange={e => setDateStart(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">종료일</label>
                      <input
                        type="date"
                        value={dateEnd}
                        onChange={e => setDateEnd(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}
                <button
                  onClick={refetchWithNewDates}
                  disabled={isDemo}
                  className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isDemo ? '샘플 모드에서는 기간 변경 불가' : '이 기간으로 재조회'}
                </button>
              </div>
            )}
          </div>

          <button
            onClick={() => { setConnected(false); setIsDemo(false); }}
            className="px-4 py-2 border border-gray-200 text-gray-500 rounded-lg text-sm hover:bg-gray-50 transition-colors"
          >
            ↺ 재연결
          </button>
        </div>
      </div>

      <RoasBanner metaRoas={metaRoas} storeData={storeData} spend={spend} onUpload={() => setShowStore(true)} onNt={() => setShowNt(true)} />
      <KpiGrid ins={ins} storeData={storeData} goals={goals} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <TrendChart daily={daily} />
        <RoasChart daily={daily} metaRoas={metaRoas} storeRoas={storeRoas} />
      </div>
      <CampaignTable campInsights={campInsights} storeData={storeData} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <AudienceDonut audience={audience} />
        <Funnel ins={ins} storeData={storeData} />
      </div>

      {showNt && <NtGenerator onClose={() => setShowNt(false)} />}
      {showStore && <StoreConnect onApply={(data) => { setStoreData(data); setShowStore(false); }} onClose={() => setShowStore(false)} />}

      {loading && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 flex flex-col items-center gap-4 shadow-xl">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-600">{loadingText}</p>
          </div>
        </div>
      )}
    </div>
  );
}
