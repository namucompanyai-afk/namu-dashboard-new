'use client';

import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import {
  listDemographicPeriods,
  getDemographicsMulti,
  replaceDemographics,
  type DemographicRow,
} from '@/lib/supabase';

// 집계 입력용 최소 행
interface Row { 카테고리소: string; 상품명: string; 성별: string; 나이: string; 결제수: number; }

const AGE_ORDER = ['17~19', '20~25', '26~30', '31~35', '36~40', '41~45', '46~50', '51~55', '56~60', '61~65', '66~70', '71+'];
const AXES: Record<string, string[]> = {
  중년: ['41~45', '46~50', '51~55', '56~60'],
  전환맘: ['36~40'],
  시니어: ['61~65', '66~70', '71+'],
};
const AXIS_COLORS: Record<string, string> = { 중년: '#3b82f6', 전환맘: '#ec4899', 시니어: '#22c55e' };

const fmt = (n: number) => n.toLocaleString();
const pct = (n: number) => (n * 100).toFixed(1) + '%';

interface Analysis {
  rows: Row[];
  totalPay: number;
  femaleShare: number;
  ageVolume: { 연령: string; 합산: number; 비중: number }[];
  axes: { 축: string; 결제수: number; 비중: number }[];
  categories: { 카테고리: string; 결제수: number; 비중: number }[];
  products: { 상품명: string; 결제수: number; 주력연령: string; 여성비중: number }[];
}

function analyze(all: Row[]): Analysis {
  // (알수없음) 제외
  const f = all.filter((r) => r.성별 !== '(알수없음)' && r.나이 !== '(알수없음)');

  const female = f.filter((r) => r.성별 === '여성').reduce((s, r) => s + r.결제수, 0);
  const male = f.filter((r) => r.성별 === '남성').reduce((s, r) => s + r.결제수, 0);
  const totalPay = female + male;

  const byAge = new Map<string, number>();
  for (const r of f) byAge.set(r.나이, (byAge.get(r.나이) ?? 0) + r.결제수);
  const ageVolume = AGE_ORDER.filter((a) => byAge.has(a)).map((a) => ({
    연령: a,
    합산: byAge.get(a) ?? 0,
    비중: totalPay > 0 ? (byAge.get(a) ?? 0) / totalPay : 0,
  })).sort((a, b) => b.합산 - a.합산);

  const axisCnt = Object.fromEntries(
    Object.entries(AXES).map(([k, ages]) => [k, ages.reduce((s, a) => s + (byAge.get(a) ?? 0), 0)]),
  ) as Record<string, number>;
  const axisTotal = Object.values(axisCnt).reduce((s, v) => s + v, 0);
  const axes = Object.keys(AXES).map((k) => ({ 축: k, 결제수: axisCnt[k], 비중: axisTotal > 0 ? axisCnt[k] / axisTotal : 0 }));

  const byCat = new Map<string, number>();
  for (const r of f) byCat.set(r.카테고리소, (byCat.get(r.카테고리소) ?? 0) + r.결제수);
  const catTotal = [...byCat.values()].reduce((s, v) => s + v, 0);
  const categories = [...byCat.entries()]
    .map(([카테고리, 결제수]) => ({ 카테고리, 결제수, 비중: catTotal > 0 ? 결제수 / catTotal : 0 }))
    .sort((a, b) => b.결제수 - a.결제수);

  const byProd = new Map<string, Row[]>();
  for (const r of f) {
    const arr = byProd.get(r.상품명) ?? [];
    arr.push(r);
    byProd.set(r.상품명, arr);
  }
  const products = [...byProd.entries()].map(([상품명, rs]) => {
    const 결제수 = rs.reduce((s, r) => s + r.결제수, 0);
    const ageMap = new Map<string, number>();
    for (const r of rs) ageMap.set(r.나이, (ageMap.get(r.나이) ?? 0) + r.결제수);
    let 주력연령 = '';
    let max = -1;
    for (const [a, v] of ageMap) if (v > max) { max = v; 주력연령 = a; }
    const pf = rs.filter((r) => r.성별 === '여성').reduce((s, r) => s + r.결제수, 0);
    const pm = rs.filter((r) => r.성별 === '남성').reduce((s, r) => s + r.결제수, 0);
    return { 상품명, 결제수, 주력연령, 여성비중: pf + pm > 0 ? pf / (pf + pm) : 0 };
  }).sort((a, b) => b.결제수 - a.결제수);

  return { rows: f, totalPay, femaleShare: totalPay > 0 ? female / totalPay : 0, ageVolume, axes, categories, products };
}

// DB 행 → 집계 입력
const toRow = (d: DemographicRow): Row => ({
  카테고리소: d.cat_s ?? '',
  상품명: d.product_name ?? '',
  성별: d.gender ?? '',
  나이: d.age_band ?? '',
  결제수: Number(d.pay_count) || 0,
});

// 파일명 날짜에서 period 추출.
//   시작월 == 끝월 → "YYYY-MM"            (2025-01-01_2025-01-31 → "2025-01")
//   시작월 != 끝월 → "YYYY-MM_YYYY-MM"    (2025-12-01_2026-05-31 → "2025-12_2026-05")
function extractPeriod(name: string): string {
  const m = name.match(/(\d{4})-(\d{2})-\d{2}[_~](\d{4})-(\d{2})-\d{2}/);
  if (!m) {
    const single = name.match(/(\d{4})-(\d{2})-\d{2}/);
    return single ? `${single[1]}-${single[2]}` : '';
  }
  const start = `${m[1]}-${m[2]}`;
  const end = `${m[3]}-${m[4]}`;
  return start === end ? start : `${start}_${end}`;
}

const RECENT_DEFAULT = 12;

interface TrendPoint { period: string; 중년: number; 전환맘: number; 시니어: number; 여성: number; 총결제수: number; }

export default function CustomerAnalysisPage() {
  const [email, setEmail] = useState('');
  const [periods, setPeriods] = useState<string[]>([]);            // 전체 (desc)
  const [selectedPeriods, setSelectedPeriods] = useState<string[]>([]);
  const [mode, setMode] = useState<'sum' | 'trend'>('sum');
  const [data, setData] = useState<Analysis | null>(null);        // 합산 집계
  const [trend, setTrend] = useState<TrendPoint[]>([]);           // 추이 (period 오름차순)
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState('');

  // 업로드 스테이징
  const [staged, setStaged] = useState<Omit<DemographicRow, 'user_email' | 'period'>[] | null>(null);
  const [stagedName, setStagedName] = useState('');
  const [periodInput, setPeriodInput] = useState('');
  const [saving, setSaving] = useState(false);

  // 선택 period들 조회 → 합산 집계 + 추이 동시 계산.
  const loadSelected = async (userEmail: string, sel: string[]) => {
    setSelectedProduct('');
    if (sel.length === 0) { setData(null); setTrend([]); return; }
    setLoading(true);
    try {
      const all = await getDemographicsMulti(userEmail, sel);
      // 합산: 모든 행을 한 리스트로 집계(analyze 가 상품·연령·성별 단위로 SUM).
      setData(analyze(all.map(toRow)));
      // 추이: period별로 나눠 각각 집계 → 오름차순 정렬.
      const byPeriod = new Map<string, DemographicRow[]>();
      for (const r of all) {
        const arr = byPeriod.get(r.period) ?? [];
        arr.push(r);
        byPeriod.set(r.period, arr);
      }
      const pts: TrendPoint[] = [...byPeriod.keys()].sort((a, b) => a.localeCompare(b)).map((p) => {
        const a = analyze((byPeriod.get(p) ?? []).map(toRow));
        const ax = Object.fromEntries(a.axes.map((x) => [x.축, x.비중])) as Record<string, number>;
        return {
          period: p,
          중년: +(ax['중년'] * 100).toFixed(1),
          전환맘: +(ax['전환맘'] * 100).toFixed(1),
          시니어: +(ax['시니어'] * 100).toFixed(1),
          여성: +(a.femaleShare * 100).toFixed(1),
          총결제수: a.totalPay,
        };
      });
      setTrend(pts);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // 최초 로드
  useEffect(() => {
    const userStr = localStorage.getItem('user');
    const userEmail = userStr ? (JSON.parse(userStr).email || '') : '';
    setEmail(userEmail);
    if (!userEmail) { setLoading(false); return; }
    (async () => {
      try {
        const ps = await listDemographicPeriods(userEmail);
        setPeriods(ps);
        const def = ps.slice(0, RECENT_DEFAULT);   // 최근 12개
        setSelectedPeriods(def);
        await loadSelected(userEmail, def);
      } catch (err) {
        console.error(err);
        setLoading(false);
      }
    })();
  }, []);

  const togglePeriod = (p: string) => {
    const next = selectedPeriods.includes(p)
      ? selectedPeriods.filter((x) => x !== p)
      : [...selectedPeriods, p];
    setSelectedPeriods(next);
    loadSelected(email, next);
  };

  const parseFile = (file: File) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
        const rows = json.map((r) => ({
          cat_l: String(r['상품카테고리(대)'] ?? ''),
          cat_m: String(r['상품카테고리(중)'] ?? ''),
          cat_s: String(r['상품카테고리(소)'] ?? ''),
          cat_d: String(r['상품카테고리(세)'] ?? ''),
          product_name: String(r['상품명'] ?? ''),
          product_id: String(r['상품ID'] ?? ''),   // text 강제
          gender: String(r['성별'] ?? ''),
          age_band: String(r['나이'] ?? ''),
          pay_amount: Number(r['결제금액']) || 0,
          pay_count: Number(r['결제수']) || 0,
          pay_qty: Number(r['결제상품수량']) || 0,
          refund_amount: Number(r['환불금액']) || 0,
          refund_count: Number(r['환불건수']) || 0,
          refund_qty: Number(r['환불수량']) || 0,
        }));
        if (rows.length === 0) { setError('데이터가 없습니다.'); return; }
        setStaged(rows);
        setStagedName(file.name);
        setPeriodInput(extractPeriod(file.name));
      } catch (err: any) {
        console.error(err);
        setError('파일 파싱 실패: ' + (err?.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const saveStaged = async () => {
    if (!email) { setError('로그인 정보가 없습니다.'); return; }
    if (!staged) return;
    const period = periodInput.trim();
    if (!period) { setError('기간(period)을 입력하세요. 예: 2025-12_2026-05'); return; }
    setSaving(true);
    setError('');
    try {
      await replaceDemographics(email, period, staged);
      // 스테이징 초기화 + 목록/데이터 갱신
      setStaged(null);
      setStagedName('');
      setPeriodInput('');
      const ps = await listDemographicPeriods(email);
      setPeriods(ps);
      // 방금 저장한 period 를 선택에 포함시켜 갱신.
      const next = selectedPeriods.includes(period) ? selectedPeriods : [period, ...selectedPeriods];
      setSelectedPeriods(next);
      await loadSelected(email, next);
    } catch (err: any) {
      console.error(err);
      setError('저장 실패: ' + (err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  const productAgeDist = useMemo(() => {
    if (!data || !selectedProduct) return [];
    const rs = data.rows.filter((r) => r.상품명 === selectedProduct);
    const m = new Map<string, number>();
    for (const r of rs) m.set(r.나이, (m.get(r.나이) ?? 0) + r.결제수);
    return AGE_ORDER.filter((a) => m.has(a)).map((a) => ({ 연령: a, 결제수: m.get(a) ?? 0 }));
  }, [data, selectedProduct]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">스마트스토어 고객분석</h1>
          <p className="text-sm text-gray-500 mt-1">상품 인구통계 저장 데이터 → 연령·성별·콘텐츠축 분석</p>
        </div>
        {/* 합산/추이 토글 — 추이는 period 2개 이상일 때만 */}
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setMode('sum')}
            className={'px-3 py-1.5 text-sm font-medium ' + (mode === 'sum' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}
          >
            합산
          </button>
          <button
            onClick={() => setMode('trend')}
            disabled={periods.length < 2}
            className={'px-3 py-1.5 text-sm font-medium ' + (mode === 'trend' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed')}
          >
            추이
          </button>
        </div>
      </div>

      {/* 포함할 period 다중선택 */}
      {periods.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium text-gray-500 mb-2">포함 기간 (기본 최근 {RECENT_DEFAULT}개)</div>
          <div className="flex flex-wrap gap-2">
            {periods.map((p) => (
              <label key={p} className={'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-sm cursor-pointer ' + (selectedPeriods.includes(p) ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                <input type="checkbox" checked={selectedPeriods.includes(p)} onChange={() => togglePeriod(p)} className="h-3.5 w-3.5" />
                {p}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 업로드 (교체 저장) */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) parseFile(f); }}
        className={'rounded-2xl border-2 border-dashed p-6 text-center transition-colors ' + (drag ? 'border-teal-500 bg-teal-50' : 'border-gray-300 bg-white')}
      >
        <div className="text-sm font-medium mb-1">상품_인구통계 (.xlsx) 업로드 → 같은 기간 데이터 교체 저장</div>
        <p className="text-xs text-gray-500 mb-3">드래그앤드롭 또는 클릭</p>
        <label className="inline-block px-4 py-2 rounded-lg bg-gray-900 text-white text-sm cursor-pointer hover:bg-gray-700">
          파일 선택
          <input type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
        </label>

        {staged && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm">
            <span className="text-gray-700">📄 {stagedName} · {staged.length}행</span>
            <input
              value={periodInput}
              onChange={(e) => setPeriodInput(e.target.value)}
              placeholder="기간 예: 2025-12_2026-05"
              className="px-3 py-1.5 border border-gray-300 rounded-lg"
            />
            <button onClick={saveStaged} disabled={saving}
              className={'px-3 py-1.5 rounded-lg text-white text-sm font-medium ' + (saving ? 'bg-gray-400 cursor-not-allowed' : 'bg-teal-600 hover:bg-teal-700')}>
              {saving ? '저장 중...' : '저장(교체)'}
            </button>
            <button onClick={() => { setStaged(null); setStagedName(''); setPeriodInput(''); }}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 text-sm font-medium hover:bg-gray-50">
              취소
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">{error}</div>}

      {loading && <div className="text-sm text-gray-500">불러오는 중…</div>}

      {!loading && !data && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          저장된 데이터가 없습니다. 위에서 상품_인구통계 파일을 업로드해 주세요.
        </div>
      )}

      {mode === 'sum' && data && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">총 결제수</div>
              <div className="mt-2 text-2xl font-bold text-gray-900">{fmt(data.totalPay)}</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">여성 비중</div>
              <div className="mt-2 text-2xl font-bold text-pink-600">{pct(data.femaleShare)}</div>
            </div>
            {data.axes.map((a) => (
              <div key={a.축} className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="text-xs text-gray-500">{a.축} 축</div>
                <div className="mt-2 text-2xl font-bold" style={{ color: AXIS_COLORS[a.축] }}>{pct(a.비중)}</div>
                <div className="text-xs text-gray-400">{fmt(a.결제수)}건</div>
              </div>
            ))}
          </div>

          {/* 차트 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold mb-4">연령대별 볼륨 (남+여 합산)</h2>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={[...data.ageVolume].sort((a, b) => AGE_ORDER.indexOf(a.연령) - AGE_ORDER.indexOf(b.연령))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="연령" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={48} />
                    <Tooltip formatter={(v: any) => fmt(Number(v))} />
                    <Bar dataKey="합산" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold mb-4">콘텐츠축 (제작 3축 재환산)</h2>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={data.axes} dataKey="결제수" nameKey="축" innerRadius={60} outerRadius={100} label={(e: any) => `${e.축} ${pct(e.비중)}`}>
                      {data.axes.map((a) => <Cell key={a.축} fill={AXIS_COLORS[a.축]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => fmt(Number(v))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold mb-4">카테고리(소)별 결제수</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.categories} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="카테고리" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip formatter={(v: any) => fmt(Number(v))} />
                  <Bar dataKey="결제수" fill="#22c55e" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 상품별 주력연령 */}
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold">상품별 주력연령</h2>
            </div>
            <div className="overflow-x-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">상품</th>
                    <th className="text-right px-4 py-2 font-medium">결제수</th>
                    <th className="text-center px-4 py-2 font-medium">주력연령</th>
                    <th className="text-right px-4 py-2 font-medium">여성%</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.slice(0, 50).map((p, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-4 py-2 max-w-md truncate" title={p.상품명}>{p.상품명}</td>
                      <td className="px-4 py-2 text-right font-mono">{fmt(p.결제수)}</td>
                      <td className="px-4 py-2 text-center">{p.주력연령}</td>
                      <td className="px-4 py-2 text-right font-mono">{pct(p.여성비중)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 상품 선택 → 연령 분포 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-base font-semibold">상품별 연령 분포</h2>
              <select
                value={selectedProduct}
                onChange={(e) => setSelectedProduct(e.target.value)}
                className="flex-1 max-w-md px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">상품을 선택하세요</option>
                {data.products.map((p) => <option key={p.상품명} value={p.상품명}>{p.상품명}</option>)}
              </select>
            </div>
            {selectedProduct ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={productAgeDist}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="연령" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={48} />
                    <Tooltip formatter={(v: any) => fmt(Number(v))} />
                    <Bar dataKey="결제수" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-gray-400 py-8 text-center">상품을 선택하면 연령 분포가 표시됩니다.</p>
            )}
          </div>
        </>
      )}

      {/* 추이 모드 */}
      {mode === 'trend' && (
        trend.length < 2 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            추이는 포함 기간이 2개 이상일 때 표시됩니다. 위에서 기간을 더 선택하세요.
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold mb-4">콘텐츠축 비중 추이 (%)</h2>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={48} unit="%" />
                    <Tooltip formatter={(v: any) => v + '%'} />
                    <Legend />
                    <Line type="monotone" dataKey="중년" stroke={AXIS_COLORS['중년']} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="전환맘" stroke={AXIS_COLORS['전환맘']} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="시니어" stroke={AXIS_COLORS['시니어']} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold mb-4">여성 비중 추이 (%)</h2>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} width={48} unit="%" />
                      <Tooltip formatter={(v: any) => v + '%'} />
                      <Line type="monotone" dataKey="여성" stroke="#ec4899" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold mb-4">총 결제수 추이</h2>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} width={56} />
                      <Tooltip formatter={(v: any) => fmt(Number(v))} />
                      <Line type="monotone" dataKey="총결제수" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
