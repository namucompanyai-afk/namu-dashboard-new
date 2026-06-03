'use client';

import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';

// 원본 한 행 (상품_인구통계 xlsx)
interface Row {
  카테고리소: string;
  상품명: string;
  성별: string;
  나이: string;
  결제수: number;
}

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

function analyze(rows: Row[]): Analysis {
  // (알수없음) 제외
  const f = rows.filter((r) => r.성별 !== '(알수없음)' && r.나이 !== '(알수없음)');

  const female = f.filter((r) => r.성별 === '여성').reduce((s, r) => s + r.결제수, 0);
  const male = f.filter((r) => r.성별 === '남성').reduce((s, r) => s + r.결제수, 0);
  const totalPay = female + male;

  // 연령대 볼륨 (남+여)
  const byAge = new Map<string, number>();
  for (const r of f) byAge.set(r.나이, (byAge.get(r.나이) ?? 0) + r.결제수);
  const ageVolume = AGE_ORDER.filter((a) => byAge.has(a)).map((a) => ({
    연령: a,
    합산: byAge.get(a) ?? 0,
    비중: (byAge.get(a) ?? 0) / totalPay,
  })).sort((a, b) => b.합산 - a.합산);

  // 콘텐츠축 재환산
  const axisCnt = Object.fromEntries(
    Object.entries(AXES).map(([k, ages]) => [k, ages.reduce((s, a) => s + (byAge.get(a) ?? 0), 0)]),
  ) as Record<string, number>;
  const axisTotal = Object.values(axisCnt).reduce((s, v) => s + v, 0);
  const axes = Object.keys(AXES).map((k) => ({ 축: k, 결제수: axisCnt[k], 비중: axisCnt[k] / axisTotal }));

  // 카테고리(소)
  const byCat = new Map<string, number>();
  for (const r of f) byCat.set(r.카테고리소, (byCat.get(r.카테고리소) ?? 0) + r.결제수);
  const catTotal = [...byCat.values()].reduce((s, v) => s + v, 0);
  const categories = [...byCat.entries()]
    .map(([카테고리, 결제수]) => ({ 카테고리, 결제수, 비중: 결제수 / catTotal }))
    .sort((a, b) => b.결제수 - a.결제수);

  // 상품별
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

export default function CustomerAnalysisPage() {
  const [fileName, setFileName] = useState('');
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState('');

  const parseFile = (file: File) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
        const rows: Row[] = json.map((r) => ({
          카테고리소: String(r['상품카테고리(소)'] ?? ''),
          상품명: String(r['상품명'] ?? ''),
          성별: String(r['성별'] ?? ''),
          나이: String(r['나이'] ?? ''),
          결제수: Number(r['결제수']) || 0,
        }));
        if (rows.length === 0) { setError('데이터가 없습니다.'); return; }
        setData(analyze(rows));
        setSelectedProduct('');
        setFileName(file.name);
      } catch (err: any) {
        console.error(err);
        setError('파일 파싱 실패: ' + (err?.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
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
      <div>
        <h1 className="text-2xl font-semibold">스마트스토어 고객분석</h1>
        <p className="text-sm text-gray-500 mt-1">상품_인구통계 xlsx 업로드 → 연령·성별·콘텐츠축 분석</p>
      </div>

      {/* 1. 업로드 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) parseFile(f); }}
        className={'rounded-2xl border-2 border-dashed p-8 text-center transition-colors ' + (drag ? 'border-teal-500 bg-teal-50' : 'border-gray-300 bg-white')}
      >
        <div className="text-sm font-medium mb-1">상품_인구통계 (.xlsx)</div>
        <p className="text-xs text-gray-500 mb-3">드래그앤드롭 또는 클릭</p>
        <label className="inline-block px-4 py-2 rounded-lg bg-gray-900 text-white text-sm cursor-pointer hover:bg-gray-700">
          파일 선택
          <input type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
        </label>
        {fileName && <p className="text-xs text-gray-700 mt-3">📄 {fileName}</p>}
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">{error}</div>}

      {data && (
        <>
          {/* 2. KPI */}
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

          {/* 3. 차트 */}
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

          {/* 4. 상품별 주력연령 */}
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

          {/* 5. 상품 선택 → 연령 분포 */}
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
    </div>
  );
}
