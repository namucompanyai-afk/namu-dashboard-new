'use client';

import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';

// ── mock 데이터 (자동 수집은 다음 단계, 현재는 화면 가안만) ─────────────

type ChannelId = 'youtube' | 'instagram' | 'tiktok' | 'navertv' | 'naverblog' | 'facebook';

interface Channel {
  id: ChannelId;
  name: string;
  emoji: string;
  color: string;
  source: '자동' | '수동';
  followers: number;
  day: number;
  week: number;
  month: number;
}

const CHANNELS: Channel[] = [
  { id: 'youtube', name: 'YouTube', emoji: '📺', color: '#ef4444', source: '자동', followers: 12340, day: 45, week: 320, month: 1200 },
  { id: 'instagram', name: 'Instagram', emoji: '📷', color: '#ec4899', source: '자동', followers: 8752, day: 12, week: -85, month: 430 },
  { id: 'tiktok', name: 'TikTok', emoji: '🎵', color: '#0ea5e9', source: '수동', followers: 4201, day: 88, week: 540, month: 2100 },
  { id: 'navertv', name: '네이버TV', emoji: '📹', color: '#22c55e', source: '수동', followers: 1820, day: -5, week: 30, month: 120 },
  { id: 'naverblog', name: '네이버 블로그', emoji: '📝', color: '#10b981', source: '수동', followers: 6540, day: 20, week: 110, month: -50 },
  { id: 'facebook', name: 'Facebook', emoji: '👍', color: '#3b82f6', source: '자동', followers: 2103, day: -8, week: -40, month: 60 },
];

// 결정적(seed 불필요) 추이 생성 — 현재값에서 역산해 과거 90일 점을 사인파+추세로 흔들기.
function buildSeries(ch: Channel, days: number): number[] {
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = days - 1 - i; // 0(과거) → days-1(현재)
    const trend = (ch.month / 30) * (t - (days - 1)); // 현재 기준 음수(과거가 낮거나 높음)
    const wave = Math.sin((t + ch.followers) / 6) * (ch.followers * 0.012);
    out.push(Math.max(0, Math.round(ch.followers + trend + wave)));
  }
  return out; // 길이 days, 마지막이 현재에 가까움
}

const SERIES_90: Record<ChannelId, number[]> = Object.fromEntries(
  CHANNELS.map((c) => [c.id, buildSeries(c, 90)]),
) as Record<ChannelId, number[]>;

function fmt(n: number): string {
  return n.toLocaleString();
}

function Delta({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className={up ? 'text-green-600' : 'text-red-500'}>
      {up ? '↑' : '↓'} {fmt(Math.abs(value))}
    </span>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-10 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function SnsDashboardPage() {
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});

  const totalFollowers = CHANNELS.reduce((s, c) => s + c.followers, 0);
  const weekNew = CHANNELS.reduce((s, c) => s + c.week, 0);
  const topChannel = useMemo(
    () => [...CHANNELS].sort((a, b) => b.week / b.followers - a.week / a.followers)[0],
    [],
  );

  // 통합 추이 차트 데이터 (최근 period 일).
  const trendData = useMemo(() => {
    const rows: Record<string, number | string>[] = [];
    for (let i = 0; i < period; i++) {
      const idx = 90 - period + i;
      const row: Record<string, number | string> = { day: `D-${period - 1 - i}` };
      for (const c of CHANNELS) row[c.id] = SERIES_90[c.id][idx];
      rows.push(row);
    }
    return rows;
  }, [period]);

  const toggleChannel = (id: string) => {
    setHidden((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const saveManual = (ch: Channel) => {
    const val = manualInputs[ch.id];
    // 실제 DB 저장은 다음 단계 — 현재는 로그만.
    console.log('[SNS 수동입력]', ch.name, '오늘 팔로워:', val);
  };

  const manualChannels = CHANNELS.filter((c) => c.source === '수동');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">SNS 대시보드</h1>
        <p className="text-sm text-gray-500 mt-1">채널별 팔로워 추이</p>
      </div>

      {/* 섹션 1: 통합 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-xs text-gray-500">총 팔로워</div>
          <div className="mt-2 text-2xl font-bold text-gray-900">{fmt(totalFollowers)}</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-xs text-gray-500">이번 주 신규</div>
          <div className={'mt-2 text-2xl font-bold ' + (weekNew >= 0 ? 'text-green-600' : 'text-red-500')}>
            {weekNew >= 0 ? '+' : ''}{fmt(weekNew)}
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-xs text-gray-500">최고 성장 채널</div>
          <div className="mt-2 text-lg font-bold text-gray-900">{topChannel.emoji} {topChannel.name}</div>
          <div className="text-sm"><Delta value={topChannel.week} /> (이번 주)</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="text-xs text-gray-500">마지막 업데이트</div>
          <div className="mt-2 text-2xl font-bold text-gray-900">5분 전</div>
        </div>
      </div>

      {/* 섹션 2: 채널별 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {CHANNELS.map((c) => (
          <div key={c.id} className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{c.emoji}</span>
                <span className="font-semibold text-gray-900">{c.name}</span>
              </div>
              <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (c.source === '자동' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600')}>
                {c.source}
              </span>
            </div>
            <div className="mt-4 text-3xl font-bold text-gray-900">{fmt(c.followers)}</div>
            <div className="mt-4 flex items-end justify-between">
              <div className="space-y-0.5 text-sm">
                <div className="flex gap-2"><span className="text-gray-400 w-6">일</span><Delta value={c.day} /></div>
                <div className="flex gap-2"><span className="text-gray-400 w-6">주</span><Delta value={c.week} /></div>
                <div className="flex gap-2"><span className="text-gray-400 w-6">월</span><Delta value={c.month} /></div>
              </div>
              <Sparkline data={SERIES_90[c.id].slice(-7)} color={c.color} />
            </div>
          </div>
        ))}
      </div>

      {/* 섹션 3: 통합 추이 차트 */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">통합 추이</h2>
          <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
            {([7, 30, 90] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={'px-3 py-1.5 text-sm font-medium ' + (period === p ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}
              >
                {p}일
              </button>
            ))}
          </div>
        </div>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11 }} width={48} />
              <Tooltip />
              <Legend onClick={(e: any) => toggleChannel(e.dataKey)} />
              {CHANNELS.map((c) => (
                <Line
                  key={c.id}
                  type="monotone"
                  dataKey={c.id}
                  name={c.name}
                  stroke={c.color}
                  strokeWidth={2}
                  dot={false}
                  hide={hidden[c.id]}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-gray-400">범례를 클릭하면 채널을 켜고 끌 수 있습니다.</p>
      </div>

      {/* 섹션 4: 수동 입력 */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold mb-1">수동 입력</h2>
        <p className="text-sm text-gray-500 mb-4">자동 수집이 안 되는 채널의 오늘 팔로워 수를 입력하세요. (저장은 다음 단계)</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {manualChannels.map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">{c.emoji}</span>
                <span className="font-medium text-gray-800">{c.name}</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={manualInputs[c.id] ?? ''}
                  onChange={(e) => setManualInputs((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  placeholder={fmt(c.followers)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  onClick={() => saveManual(c)}
                  className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 whitespace-nowrap"
                >
                  저장
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
