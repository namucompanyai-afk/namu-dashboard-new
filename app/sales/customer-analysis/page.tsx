'use client';

import { Fragment, useEffect, useMemo, useState, type ReactElement } from 'react';
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
  Cell,
  Legend,
  LabelList,
  useXAxisScale,
  usePlotArea,
} from 'recharts';
import {
  listDemographicPeriods,
  getDemographicsMulti,
  getAllDemographics,
  replaceDemographics,
  type DemographicRow,
} from '@/lib/supabase';

// 집계 입력용 최소 행
interface Row { 카테고리소: string; 상품명: string; 성별: string; 나이: string; 결제수: number; 매출: number; 환불건수: number; }

const AGE_ORDER = ['17~19', '20~25', '26~30', '31~35', '36~40', '41~45', '46~50', '51~55', '56~60', '61~65', '66~70', '71+'];
const AXES: Record<string, string[]> = {
  중년: ['41~45', '46~50', '51~55', '56~60'],
  전환맘: ['31~35', '36~40'],   // 30대 전체
  시니어: ['61~65', '66~70', '71+'],
};
const AXIS_COLORS: Record<string, string> = { 중년: '#3b82f6', 전환맘: '#ec4899', 시니어: '#22c55e' };
// 집계 축 정의(중년 41~60 / 전환맘 36~40 / 시니어 61+)는 유지하고 표시 라벨만 나이대로.
const AXIS_LABELS: Record<string, string> = { 중년: '40~50대', 전환맘: '30대', 시니어: '60대 이상' };

// 연령대 → 콘텐츠축 표시 라벨 (비제작 구간이면 '—').
function ageToAxisLabel(age: string): string {
  for (const k of Object.keys(AXES)) if (AXES[k].includes(age)) return AXIS_LABELS[k];
  return '—';
}

// 연령대별 막대 색: 제작 축별 분류 + 35세 이하 비제작 회색.
function ageColor(age: string): string {
  if (['31~35', '36~40'].includes(age)) return '#ec4899';                 // 전환맘(30대)
  if (['41~45', '46~50', '51~55', '56~60'].includes(age)) return '#3b82f6'; // 중년
  if (['61~65', '66~70', '71+'].includes(age)) return '#22c55e';           // 시니어
  return '#d1d5db';                                                        // 30세 이하 비제작
}

const fmt = (n: number) => n.toLocaleString();
const pct = (n: number) => (n * 100).toFixed(1) + '%';
// 매출 만원 단위 표기 (만원 미만 반올림, 천단위 콤마). 예: 157,132,420 → "15,713만"
const man = (n: number) => Math.round(n / 10000).toLocaleString() + '만';

// 차트 클릭 시 파란 박스/포커스 outline 제거 (쿠팡 수익진단 방식).
const NOSEL = 'focus:outline-none [&_*]:outline-none [&_svg]:outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none';
function ChartBox({ children, height = 288 }: { children: ReactElement; height?: number }) {
  return (
    <div tabIndex={-1} className={NOSEL} style={{ outline: 'none', height }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

// 연령 막대 색상 구간(콘텐츠축) — 그룹 합산 비중% 레이블용. 색은 ageColor와 동일.
const AGE_GROUPS: { name: string; color: string; ages: string[] }[] = [
  { name: '비제작', color: '#9ca3af', ages: ['17~19', '20~25', '26~30'] },
  { name: '30대', color: '#ec4899', ages: ['31~35', '36~40'] },
  { name: '40~50대', color: '#3b82f6', ages: ['41~45', '46~50', '51~55', '56~60'] },
  { name: '60대 이상', color: '#22c55e', ages: ['61~65', '66~70', '71+'] },
];

// 같은 색 구간(콘텐츠축)을 가로로 아우르는 그룹 합산 비중% 레이블 + 테두리 박스.
// 박스는 band 시작(xScale(firstAge))~끝(xScale(lastAge)+band폭) 기준으로 그룹 전체 막대를 감쌈.
// 비제작(회색) 구간은 박스 없이 % 텍스트만. data: [{연령, [valueKey]}], total: 분모.
const BOX_INSET = 6;   // band 경계에서 안쪽으로 inset → 인접 그룹 박스 간격 확보(막대는 band보다 좁아 안 잘림).
function AgeGroupPctOverlay({ data, valueKey, total }: { data: any[]; valueKey: string; total: number }) {
  const xScale = useXAxisScale() as any;
  const plot = usePlotArea();
  if (!xScale || !plot || total <= 0) return null;
  const present = new Set(data.map((d) => d.연령));
  // band 폭: scaleBand.bandwidth() 우선, 없으면(=0) 인접 막대 시작점 간격으로 추정.
  let band = typeof xScale.bandwidth === 'function' ? xScale.bandwidth() : 0;
  if (!(band > 0)) {
    const all = AGE_ORDER.filter((a) => present.has(a)).map((a) => xScale(a)).sort((x, y) => x - y);
    band = all.length >= 2 ? all[1] - all[0] : 0;
  }
  return (
    <g>
      {AGE_GROUPS.map((g) => {
        const ages = g.ages.filter((a) => present.has(a));
        if (!ages.length) return null;
        const starts = ages.map((a) => xScale(a));
        const inset = Math.min(BOX_INSET, band * 0.08);    // band 폭 대비 과하지 않게
        const left = Math.min(...starts) + inset;          // band 시작에서 안쪽으로
        const right = Math.max(...starts) + band - inset;  // band 끝에서 안쪽으로
        const cx = (left + right) / 2;
        const sum = data.reduce((s, d) => (g.ages.includes(d.연령) ? s + Number(d[valueKey]) : s), 0);
        const p = ((sum / total) * 100).toFixed(1);
        const drawBox = g.name !== '비제작';
        return (
          <g key={g.name}>
            {drawBox && (
              <rect x={left} y={plot.y} width={right - left} height={plot.height} fill="none" stroke={g.color} strokeWidth={2} rx={6} />
            )}
            <text x={cx} y={plot.y - 8} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fill: g.color }}>
              {g.name} {p}%
            </text>
          </g>
        );
      })}
    </g>
  );
}

// 체크박스 드롭다운 (복수 선택). native multiple 대신 사용.
function MultiSelect({ title, options, selected, onChange }: {
  title: string; options: string[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const allSel = options.length > 0 && selected.length === options.length;
  const summary = selected.length === 0 ? '(전체)' : selected.length <= 2 ? selected.join(', ') : `${selected.length}개 선택`;
  const toggle = (o: string) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  return (
    <div className="relative">
      <label className="block text-xs text-gray-500 mb-1">{title}</label>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-left flex justify-between items-center">
        <span className="truncate">{summary}</span>
        <span className="text-gray-400 ml-2">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg p-2">
            <button type="button" onClick={() => onChange(allSel ? [] : [...options])}
              className="w-full text-left text-xs text-blue-600 px-2 py-1 hover:bg-gray-50 rounded">
              {allSel ? '전체 해제' : '전체 선택'}
            </button>
            {options.map((o) => (
              <label key={o} className="flex items-center gap-2 px-2 py-1 text-sm hover:bg-gray-50 rounded cursor-pointer">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} className="h-3.5 w-3.5" />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 선택 기간 라벨: 최소 ~ 최대 (N개월). 단일이면 범위 생략.
function rangeLabel(sel: string[]): string {
  if (sel.length === 0) return '선택된 기간 없음';
  const sorted = [...sel].sort((a, b) => a.localeCompare(b));
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const n = sel.length;
  return min === max ? `${min} (${n}개월)` : `${min} ~ ${max} (${n}개월)`;
}

interface Analysis {
  rows: Row[];
  totalPay: number;
  female: number;
  male: number;
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

  return { rows: f, totalPay, female, male, femaleShare: totalPay > 0 ? female / totalPay : 0, ageVolume, axes, categories, products };
}

// 행 목록 → 결제수/매출/객단가/환불률/주력연령/콘텐츠축 (그룹·옵션 집계 공통).
function metricsOf(rows: Row[]) {
  const 결제수 = rows.reduce((s, r) => s + r.결제수, 0);
  const 매출 = rows.reduce((s, r) => s + r.매출, 0);
  const 환불건수 = rows.reduce((s, r) => s + r.환불건수, 0);
  const ageMap = new Map<string, number>();
  for (const r of rows) ageMap.set(r.나이, (ageMap.get(r.나이) ?? 0) + r.결제수);
  let 주력연령 = '';
  let max = -1;
  for (const [a, v] of ageMap) if (v > max) { max = v; 주력연령 = a; }
  return {
    결제수,
    매출,
    객단가: 결제수 > 0 ? Math.round(매출 / 결제수) : 0,
    환불률: 결제수 > 0 ? 환불건수 / 결제수 : 0,
    주력연령,
    주력연령비중: 결제수 > 0 ? max / 결제수 : 0,
    콘텐츠축: ageToAxisLabel(주력연령),
  };
}
type GroupMetrics = ReturnType<typeof metricsOf>;

// DB 행 → 집계 입력
const toRow = (d: DemographicRow): Row => ({
  카테고리소: d.cat_s ?? '',
  상품명: d.product_name ?? '',
  성별: d.gender ?? '',
  나이: d.age_band ?? '',
  결제수: Number(d.pay_count) || 0,
  매출: Number(d.pay_amount) || 0,
  환불건수: Number(d.refund_count) || 0,
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
  const [expandedYears, setExpandedYears] = useState<string[]>([]);
  const [data, setData] = useState<Analysis | null>(null);        // 합산 집계
  const [trend, setTrend] = useState<TrendPoint[]>([]);           // 추이 (period 오름차순)
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  // 표시명별 연령 분포 — 그룹/표시명/판매형태 복수 필터 (상단 그룹표와 독립).
  const [filterGroups, setFilterGroups] = useState<string[]>([]);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [filterChannels, setFilterChannels] = useState<string[]>([]);
  // 연령대별 인기 상품 섹션
  const [filterAges, setFilterAges] = useState<string[]>([]);
  const [expandedAgeGroups, setExpandedAgeGroups] = useState<string[]>([]);
  // 상품 그룹 매핑: NFC(product_name) → { group, label, channel }.
  const [prodMap, setProdMap] = useState<Map<string, { group: string; label: string; channel: string }>>(new Map());
  const [channels, setChannels] = useState<string[]>([]);        // 판매형태(E) 등장값
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);

  // 업로드 스테이징
  const [staged, setStaged] = useState<Omit<DemographicRow, 'user_email' | 'period'>[] | null>(null);
  const [stagedName, setStagedName] = useState('');
  const [periodInput, setPeriodInput] = useState('');
  const [saving, setSaving] = useState(false);

  // 선택 period들 조회 → 합산 집계 + 추이 동시 계산.
  const loadSelected = async (userEmail: string, sel: string[]) => {
    setFilterGroups([]); setFilterLabels([]); setFilterChannels([]); setFilterAges([]);
    if (sel.length === 0) { setData(null); setTrend([]); setLoading(false); return; }
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
        const years = Array.from(new Set(ps.map((p) => p.slice(0, 4)))).sort((a, b) => b.localeCompare(a));
        setExpandedYears(years);   // 전체 연도 펼침
        await loadSelected(userEmail, def);
      } catch (err) {
        console.error(err);
        setLoading(false);
      }
    })();
  }, []);

  // 상품 그룹 매핑 CSV 로드 → product_name → {group,label,channel} 맵 구축.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ss-product-mapping', { cache: 'no-store' });
        const json = await res.json();
        if (!json?.ok || !Array.isArray(json.rows)) {
          if (json?.message) setError(json.message);
          return;
        }
        const map = new Map<string, { group: string; label: string; channel: string }>();
        const chSet = new Set<string>();
        for (let i = 1; i < json.rows.length; i++) {       // 0행 헤더 스킵
          const row = json.rows[i];
          const key = String(row?.[0] ?? '').normalize('NFC').trim();
          const group = String(row?.[1] ?? '').normalize('NFC').trim();
          const label = String(row?.[3] ?? '').normalize('NFC').trim();
          const channel = String(row?.[4] ?? '').normalize('NFC').trim();
          if (!key) continue;
          if (!map.has(key)) map.set(key, { group, label, channel });   // 첫 값 유지
          if (channel) chSet.add(channel);
        }
        setProdMap(map);
        const chs = [...chSet];
        setChannels(chs);
        setSelectedChannels(chs);    // 기본 전체 선택
      } catch (err) {
        console.error('상품 매핑 로드 실패:', err);
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

  const toggleYear = (y: string) => {
    setExpandedYears((prev) => (prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y]));
  };

  // 연도 → 해당 연도 period(월) 목록(오름차순). 연도 내림차순.
  const periodsByYear = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of periods) {
      const y = p.slice(0, 4);
      const arr = map.get(y) ?? [];
      arr.push(p);
      map.set(y, arr);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, ps]) => ({ year, months: ps.sort((a, b) => a.localeCompare(b)) }));
  }, [periods]);

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

  const nfc = (s: string) => s.normalize('NFC').trim();

  const toggleGroup = (g: string) => {
    setExpandedGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  };
  const toggleChannel = (c: string) => {
    setSelectedChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  // 그룹(B) 집계 — 판매형태(E) 필터 적용. 펼치면 표시명(D) 옵션 행.
  const groupTable = useMemo(() => {
    if (!data) return [] as ({ group: string; options: ({ label: string } & GroupMetrics)[] } & GroupMetrics)[];
    const chSel = new Set(selectedChannels);
    const groups = new Map<string, { rows: Row[]; labels: Map<string, Row[]> }>();
    for (const r of data.rows) {
      const m = prodMap.get(nfc(r.상품명));
      if (!m) continue;                                                  // 미매칭 제외
      if (channels.length > 0 && !chSel.has(m.channel)) continue;        // 판매형태 필터
      const gName = m.group || '(미분류)';
      const lName = m.label || '(표시명없음)';
      const g = groups.get(gName) ?? { rows: [] as Row[], labels: new Map<string, Row[]>() };
      g.rows.push(r);
      const lab = g.labels.get(lName) ?? ([] as Row[]);
      lab.push(r);
      g.labels.set(lName, lab);
      groups.set(gName, g);
    }
    return [...groups.entries()]
      .map(([group, g]) => ({
        group,
        ...metricsOf(g.rows),
        options: [...g.labels.entries()]
          .map(([label, rs]) => ({ label, ...metricsOf(rs) }))
          .sort((a, b) => b.결제수 - a.결제수),
      }))
      .sort((a, b) => b.결제수 - a.결제수);
  }, [data, prodMap, selectedChannels, channels]);

  // 그룹표 전체 합 (결제수·매출 비중% 분모).
  const groupTotals = useMemo(() => ({
    결제수: groupTable.reduce((s, g) => s + g.결제수, 0),
    매출: groupTable.reduce((s, g) => s + g.매출, 0),
  }), [groupTable]);

  // 그룹표 엑셀 다운로드 — 10줄 제한과 무관하게 전체 그룹+옵션. 현재 기간·판매형태 필터 반영.
  const downloadGroupExcel = () => {
    const tp = groupTotals.결제수;
    const tr = groupTotals.매출;
    const p1 = (ratio: number) => (ratio > 0 ? Math.round(ratio * 1000) / 10 : 0);   // 비율→% 1자리
    const header = ['구분', '그룹', '표시명', '결제수', '결제수비중(%)', '매출(원)', '매출비중(%)', '객단가', '주력연령', '주력연령비중(%)', '콘텐츠축', '환불률(%)'];
    const aoa: any[][] = [header];
    for (const g of groupTable) {
      aoa.push(['그룹', g.group, '', g.결제수, p1(tp > 0 ? g.결제수 / tp : 0), g.매출, p1(tr > 0 ? g.매출 / tr : 0), g.객단가, g.주력연령, p1(g.주력연령비중), g.콘텐츠축, p1(g.환불률)]);
      for (const o of g.options) {
        aoa.push(['옵션', g.group, o.label, o.결제수, p1(tp > 0 ? o.결제수 / tp : 0), o.매출, p1(tr > 0 ? o.매출 / tr : 0), o.객단가, o.주력연령, p1(o.주력연령비중), o.콘텐츠축, p1(o.환불률)]);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '그룹별');
    const sorted = [...selectedPeriods].sort((a, b) => a.localeCompare(b));
    const range = sorted.length === 0 ? 'all' : sorted[0] === sorted[sorted.length - 1] ? sorted[0] : `${sorted[0]}~${sorted[sorted.length - 1]}`;
    XLSX.writeFile(wb, `스마트스토어_고객분석_그룹별_${range}.xlsx`);
  };

  // 전체 period 원본 행을 가공 없이 엑셀로 (스스 원본 형식 + 맨 앞 period 컬럼).
  const downloadRawData = async () => {
    if (!email) { setError('로그인 정보가 없습니다.'); return; }
    setRawLoading(true);
    setError('');
    try {
      const all = await getAllDemographics(email);
      const header = ['period', '상품카테고리(대)', '상품카테고리(중)', '상품카테고리(소)', '상품카테고리(세)', '상품명', '상품ID', '성별', '나이', '결제금액', '결제수', '결제상품수량', '환불금액', '환불건수', '환불수량'];
      const aoa: any[][] = [header];
      for (const r of all) {
        aoa.push([r.period, r.cat_l, r.cat_m, r.cat_s, r.cat_d, r.product_name, r.product_id, r.gender, r.age_band, r.pay_amount, r.pay_count, r.pay_qty, r.refund_amount, r.refund_count, r.refund_qty]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'RAW');
      const ps = all.map((r) => r.period).filter(Boolean).sort((a, b) => a.localeCompare(b));
      const range = ps.length === 0 ? 'all' : ps[0] === ps[ps.length - 1] ? ps[0] : `${ps[0]}~${ps[ps.length - 1]}`;
      XLSX.writeFile(wb, `스마트스토어_인구통계_RAW_${range}.xlsx`);
    } catch (err: any) {
      console.error(err);
      setError('RAW 다운로드 실패: ' + (err?.message || err));
    } finally {
      setRawLoading(false);
    }
  };

  const toggleAgeGroup = (g: string) => {
    setExpandedAgeGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  };

  // 연령대별 인기 상품 — 선택 연령대(복수=합산) 행만 그룹 집계 (미매칭 제외).
  const ageGroupTable = useMemo(() => {
    if (!data || filterAges.length === 0) return [] as ({ group: string; options: ({ label: string } & GroupMetrics)[] } & GroupMetrics)[];
    const ageSet = new Set(filterAges);
    const groups = new Map<string, { rows: Row[]; labels: Map<string, Row[]> }>();
    for (const r of data.rows) {
      if (!ageSet.has(r.나이)) continue;
      const m = prodMap.get(nfc(r.상품명));
      if (!m) continue;
      const gName = m.group || '(미분류)';
      const lName = m.label || '(표시명없음)';
      const g = groups.get(gName) ?? { rows: [] as Row[], labels: new Map<string, Row[]>() };
      g.rows.push(r);
      const lab = g.labels.get(lName) ?? ([] as Row[]);
      lab.push(r);
      g.labels.set(lName, lab);
      groups.set(gName, g);
    }
    return [...groups.entries()]
      .map(([group, g]) => ({
        group,
        ...metricsOf(g.rows),
        options: [...g.labels.entries()].map(([label, rs]) => ({ label, ...metricsOf(rs) })).sort((a, b) => b.결제수 - a.결제수),
      }))
      .sort((a, b) => b.결제수 - a.결제수);
  }, [data, prodMap, filterAges]);

  const ageGroupTotals = useMemo(() => ({
    결제수: ageGroupTable.reduce((s, g) => s + g.결제수, 0),
    매출: ageGroupTable.reduce((s, g) => s + g.매출, 0),
  }), [ageGroupTable]);

  // 미매칭 product_name (선택 기간 데이터엔 있으나 매핑 없음).
  const unmatched = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const r of data.rows) if (!prodMap.has(nfc(r.상품명))) set.add(r.상품명);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data, prodMap]);

  // 차트 필터 옵션 — 매핑 전체 기준 (그룹/표시명).
  const mapGroups = useMemo(() => {
    const set = new Set<string>();
    for (const v of prodMap.values()) set.add(v.group || '(미분류)');
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [prodMap]);
  // 표시명 옵션: 선택 그룹들의 표시명 합집합 (그룹 미선택이면 전체).
  const labelsForGroups = (groups: string[]) => {
    const set = new Set<string>();
    for (const v of prodMap.values()) {
      if (groups.length && !groups.includes(v.group || '(미분류)')) continue;
      set.add(v.label || '(표시명없음)');
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  const chartLabels = useMemo(() => labelsForGroups(filterGroups), [prodMap, filterGroups]);

  // 그룹 변경 시 더 이상 유효하지 않은 표시명 선택 제거.
  const onGroupsChange = (next: string[]) => {
    setFilterGroups(next);
    const valid = new Set(labelsForGroups(next));
    setFilterLabels((prev) => prev.filter((l) => valid.has(l)));
  };

  // 복수 필터 교집합으로 좁힌 행들의 연령 분포 합산.
  const chartAgeDist = useMemo(() => {
    if (!data) return [];
    if (!filterGroups.length && !filterLabels.length && !filterChannels.length) return [];  // 아무것도 선택 안 함
    const rs = data.rows.filter((r) => {
      const m = prodMap.get(nfc(r.상품명));
      if (!m) return false;
      if (filterGroups.length && !filterGroups.includes(m.group || '(미분류)')) return false;
      if (filterLabels.length && !filterLabels.includes(m.label || '(표시명없음)')) return false;
      if (filterChannels.length && !filterChannels.includes(m.channel)) return false;
      return true;
    });
    const mp = new Map<string, number>();
    for (const r of rs) mp.set(r.나이, (mp.get(r.나이) ?? 0) + r.결제수);
    return AGE_ORDER.filter((a) => mp.has(a)).map((a) => ({ 연령: a, 결제수: mp.get(a) ?? 0 }));
  }, [data, prodMap, filterGroups, filterLabels, filterChannels]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">스마트스토어 고객분석</h1>
        <p className="text-sm text-gray-500 mt-1">상품 인구통계 저장 데이터 → 연령·성별 분석</p>
      </div>

      {/* 컨트롤 바: [업로드 버튼] [선택 기간] ......... [합산/추이 토글] */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 text-white text-sm cursor-pointer hover:bg-gray-700">
          <span>⬆</span> 업로드
          <input type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
        </label>
        <button
          onClick={downloadRawData}
          disabled={rawLoading}
          className={'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ' + (rawLoading ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-teal-600 text-white hover:bg-teal-700')}
        >
          {rawLoading ? '⏳ 내려받는 중…' : '⬇ RAW DATA 다운로드'}
        </button>
        <span className="text-sm text-gray-600">{rangeLabel(selectedPeriods)}</span>

        <div className="ml-auto inline-flex rounded-lg border border-gray-200 overflow-hidden">
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

      {/* 업로드 스테이징 (교체 저장 확인) */}
      {staged && (
        <div className="rounded-2xl border border-teal-200 bg-teal-50 p-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-700">📄 {stagedName} · {staged.length}행</span>
          <input
            value={periodInput}
            onChange={(e) => setPeriodInput(e.target.value)}
            placeholder="기간 예: 2025-12 또는 2025-12_2026-05"
            className="px-3 py-1.5 border border-gray-300 rounded-lg bg-white"
          />
          <button onClick={saveStaged} disabled={saving}
            className={'px-3 py-1.5 rounded-lg text-white text-sm font-medium ' + (saving ? 'bg-gray-400 cursor-not-allowed' : 'bg-teal-600 hover:bg-teal-700')}>
            {saving ? '저장 중...' : '저장(교체)'}
          </button>
          <button onClick={() => { setStaged(null); setStagedName(''); setPeriodInput(''); }}
            className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 text-sm font-medium hover:bg-gray-50">
            취소
          </button>
        </div>
      )}

      {/* 포함 기간 — 연도 그룹 아코디언 */}
      {periods.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium text-gray-500 mb-3">포함 기간 (기본 최근 {RECENT_DEFAULT}개)</div>
          <div className="space-y-2">
            {periodsByYear.map(({ year, months }) => {
              const open = expandedYears.includes(year);
              const selCount = months.filter((m) => selectedPeriods.includes(m)).length;
              return (
                <div key={year} className="rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    onClick={() => toggleYear(year)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 text-sm font-medium"
                  >
                    <span>{year}년 <span className="text-gray-400 font-normal">· {selCount}/{months.length} 선택</span></span>
                    <span className="text-xs text-gray-400">{open ? '▼' : '▶'}</span>
                  </button>
                  {open && (
                    <div className="grid grid-cols-12 gap-2 p-3">
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                        const p = `${year}-${String(m).padStart(2, '0')}`;
                        const exists = months.includes(p);
                        if (!exists) {
                          // 데이터 없는 월 — 같은 크기 빈 칸(비활성 회색)으로 자리 유지.
                          return (
                            <div key={p} className="flex items-center justify-center px-1 py-1 rounded-lg border border-gray-100 bg-gray-50 text-gray-300 text-sm">
                              {m}월
                            </div>
                          );
                        }
                        return (
                          <label key={p} className={'flex items-center justify-center gap-1 px-1 py-1 rounded-lg border text-sm cursor-pointer ' + (selectedPeriods.includes(p) ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                            <input type="checkbox" checked={selectedPeriods.includes(p)} onChange={() => togglePeriod(p)} className="h-3.5 w-3.5" />
                            {m}월
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">{error}</div>}

      {loading && <div className="text-sm text-gray-500">불러오는 중…</div>}

      {!loading && !data && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          저장된 데이터가 없습니다. 위에서 상품_인구통계 파일을 업로드해 주세요.
        </div>
      )}

      {mode === 'sum' && data && (
        <>
          {/* KPI — 총 결제수 / 여성 / 남성 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">총 결제수 (남+여 합산)</div>
              <div className="mt-2 text-2xl font-bold text-gray-900">{fmt(data.totalPay)}</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">여성 비중</div>
              <div className="mt-2 text-2xl font-bold text-pink-600">{pct(data.femaleShare)}</div>
              <div className="text-xs text-gray-400">{fmt(data.female)}건</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">남성 비중</div>
              <div className="mt-2 text-2xl font-bold text-blue-600">{pct(1 - data.femaleShare)}</div>
              <div className="text-xs text-gray-400">{fmt(data.male)}건</div>
            </div>
          </div>

          {/* KPI — 콘텐츠축 3개 (제작 3축 재환산) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {data.axes.map((a) => (
              <div key={a.축} className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="text-xs text-gray-500">{AXIS_LABELS[a.축]} <span className="text-gray-400">(남+여 합산)</span></div>
                <div className="mt-2 text-2xl font-bold" style={{ color: AXIS_COLORS[a.축] }}>{pct(a.비중)}</div>
                <div className="text-xs text-gray-400">{fmt(a.결제수)}건</div>
              </div>
            ))}
          </div>

          {/* 차트 — 연령대별 볼륨 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold mb-4">연령대별 볼륨 (남+여 합산)</h2>
            <ChartBox>
              <BarChart data={[...data.ageVolume].sort((a, b) => AGE_ORDER.indexOf(a.연령) - AGE_ORDER.indexOf(b.연령))} margin={{ top: 44 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="연령" tick={{ fontSize: 11, fontWeight: 700 }} />
                <YAxis tick={{ fontSize: 11 }} width={48} />
                <Tooltip formatter={(v: any) => fmt(Number(v))} />
                <Bar dataKey="합산" radius={[4, 4, 0, 0]}>
                  {[...data.ageVolume].sort((a, b) => AGE_ORDER.indexOf(a.연령) - AGE_ORDER.indexOf(b.연령)).map((d) => (
                    <Cell key={d.연령} fill={ageColor(d.연령)} />
                  ))}
                  <LabelList dataKey="합산" position="top" formatter={(v: any) => fmt(Number(v))} style={{ fontSize: 10, fill: '#374151' }} />
                </Bar>
                <AgeGroupPctOverlay data={data.ageVolume} valueKey="합산" total={data.ageVolume.reduce((s, d) => s + d.합산, 0)} />
              </BarChart>
            </ChartBox>
          </div>

          {/* 판매형태(E) 멀티 토글 */}
          {channels.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-500">판매형태</span>
              {channels.map((c) => (
                <label key={c} className={'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-sm cursor-pointer ' + (selectedChannels.includes(c) ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                  <input type="checkbox" checked={selectedChannels.includes(c)} onChange={() => toggleChannel(c)} className="h-3.5 w-3.5" />
                  {c}
                </label>
              ))}
            </div>
          )}

          {/* 그룹별 주력연령 (표시명 옵션 펼침) */}
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 flex items-center gap-3">
              <h2 className="text-base font-semibold">그룹별 주력연령</h2>
              <button
                onClick={() => setShowUnmatched((v) => !v)}
                className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (unmatched.length > 0 ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-gray-100 text-gray-400')}
                title="매핑에 없는 product_name"
              >
                미매칭 {unmatched.length}건
              </button>
              <span className="ml-auto text-xs text-gray-400">{groupTable.length}개 그룹</span>
              <button
                onClick={downloadGroupExcel}
                className="rounded-md bg-teal-600 px-3 py-1 text-xs font-medium text-white hover:bg-teal-700"
              >
                ⬇ 엑셀 다운로드
              </button>
            </div>
            {showUnmatched && unmatched.length > 0 && (
              <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 text-xs text-amber-800 max-h-40 overflow-y-auto">
                {unmatched.map((u, i) => <div key={i}>· {u}</div>)}
              </div>
            )}
            <div className="overflow-x-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">그룹 / 표시명</th>
                    <th className="text-right px-3 py-2 font-medium">결제수 (비중)</th>
                    <th className="text-right px-3 py-2 font-medium">매출 (비중)</th>
                    <th className="text-right px-3 py-2 font-medium">객단가</th>
                    <th className="text-center px-3 py-2 font-medium">주력연령 (비중)</th>
                    <th className="text-center px-3 py-2 font-medium">콘텐츠축</th>
                    <th className="text-right px-3 py-2 font-medium">환불률</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllGroups ? groupTable : groupTable.slice(0, 10)).map((g) => {
                    const open = expandedGroups.includes(g.group);
                    return (
                      <Fragment key={g.group}>
                        <tr className="border-t border-gray-100 cursor-pointer hover:bg-gray-50" onClick={() => toggleGroup(g.group)}>
                          <td className="px-3 py-2 font-medium">
                            <span className="inline-block w-4 text-gray-400">{open ? '▼' : '▶'}</span>
                            {g.group}
                            <span className="ml-1 text-xs text-gray-400">({g.options.length})</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{fmt(g.결제수)} <span className="text-gray-400">({pct(groupTotals.결제수 > 0 ? g.결제수 / groupTotals.결제수 : 0)})</span></td>
                          <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{man(g.매출)} <span className="text-gray-400">({pct(groupTotals.매출 > 0 ? g.매출 / groupTotals.매출 : 0)})</span></td>
                          <td className="px-3 py-2 text-right font-mono whitespace-nowrap">₩{fmt(g.객단가)}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap">{g.주력연령 || '—'} <span className="text-gray-400">({Math.round(g.주력연령비중 * 100)}%)</span></td>
                          <td className="px-3 py-2 text-center">{g.콘텐츠축}</td>
                          <td className="px-3 py-2 text-right font-mono">{pct(g.환불률)}</td>
                        </tr>
                        {open && g.options.map((o, j) => (
                          <tr key={g.group + '_' + j} className="border-t border-gray-50 bg-gray-50/40 text-gray-600">
                            <td className="px-3 py-1.5 pl-10 max-w-xs truncate" title={o.label}>{o.label}</td>
                            <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{fmt(o.결제수)} <span className="text-gray-400">({pct(groupTotals.결제수 > 0 ? o.결제수 / groupTotals.결제수 : 0)})</span></td>
                            <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{man(o.매출)} <span className="text-gray-400">({pct(groupTotals.매출 > 0 ? o.매출 / groupTotals.매출 : 0)})</span></td>
                            <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">₩{fmt(o.객단가)}</td>
                            <td className="px-3 py-1.5 text-center whitespace-nowrap">{o.주력연령 || '—'} <span className="text-gray-400">({Math.round(o.주력연령비중 * 100)}%)</span></td>
                            <td className="px-3 py-1.5 text-center">{o.콘텐츠축}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{pct(o.환불률)}</td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {groupTable.length > 10 && (
              <div className="border-t border-gray-100 px-5 py-2 text-center">
                <button
                  onClick={() => setShowAllGroups((v) => !v)}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  {showAllGroups ? '접기' : `더보기 (전체 ${groupTable.length}개)`}
                </button>
              </div>
            )}
          </div>

          {/* 표시명별 연령 분포 — 차트 위, 필터 아래 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold mb-4">표시명별 연령 분포</h2>
            {(filterGroups.length || filterLabels.length || filterChannels.length) ? (
              <ChartBox>
                <BarChart data={chartAgeDist} margin={{ top: 44 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="연령" tick={{ fontSize: 11, fontWeight: 700 }} />
                  <YAxis tick={{ fontSize: 11 }} width={48} />
                  <Tooltip formatter={(v: any) => fmt(Number(v))} />
                  <Bar dataKey="결제수" radius={[4, 4, 0, 0]}>
                    {chartAgeDist.map((d) => <Cell key={d.연령} fill={ageColor(d.연령)} />)}
                    <LabelList dataKey="결제수" position="top" formatter={(v: any) => fmt(Number(v))} style={{ fontSize: 10, fill: '#374151' }} />
                  </Bar>
                  <AgeGroupPctOverlay data={chartAgeDist} valueKey="결제수" total={chartAgeDist.reduce((s, d) => s + d.결제수, 0)} />
                </BarChart>
              </ChartBox>
            ) : (
              <p className="text-sm text-gray-400 py-8 text-center">필터를 선택하세요.</p>
            )}

            {/* 복수 선택 필터: 그룹명 / 표시명 / 판매형태 */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <MultiSelect title="그룹명" options={mapGroups} selected={filterGroups} onChange={onGroupsChange} />
              <MultiSelect title="상품명(표시명)" options={chartLabels} selected={filterLabels} onChange={setFilterLabels} />
              <MultiSelect title="판매형태" options={channels} selected={filterChannels} onChange={setFilterChannels} />
            </div>
          </div>

          {/* 연령대별 인기 상품 — overflow-hidden 제거(드롭다운 클립 방지) */}
          <div className="rounded-2xl border border-gray-200 bg-white">
            <div className="px-5 py-3 border-b border-gray-200 flex items-center gap-3">
              <h2 className="text-base font-semibold">연령대별 인기 상품</h2>
              <div className="ml-auto w-56"><MultiSelect title="" options={AGE_ORDER} selected={filterAges} onChange={setFilterAges} /></div>
            </div>
            {filterAges.length === 0 ? (
              <p className="text-sm text-gray-400 py-12 text-center min-h-[120px] flex items-center justify-center">연령대를 선택하세요.</p>
            ) : (
              <div className="overflow-x-auto max-h-[60vh]">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600 text-xs uppercase sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">그룹 / 표시명</th>
                      <th className="text-right px-3 py-2 font-medium">결제수 (비중)</th>
                      <th className="text-right px-3 py-2 font-medium">매출 (비중)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ageGroupTable.map((g) => {
                      const open = expandedAgeGroups.includes(g.group);
                      return (
                        <Fragment key={g.group}>
                          <tr className="border-t border-gray-100 cursor-pointer hover:bg-gray-50" onClick={() => toggleAgeGroup(g.group)}>
                            <td className="px-3 py-2 font-medium">
                              <span className="inline-block w-4 text-gray-400">{open ? '▼' : '▶'}</span>
                              {g.group}
                              <span className="ml-1 text-xs text-gray-400">({g.options.length})</span>
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{fmt(g.결제수)} <span className="text-gray-400">({pct(ageGroupTotals.결제수 > 0 ? g.결제수 / ageGroupTotals.결제수 : 0)})</span></td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{man(g.매출)} <span className="text-gray-400">({pct(ageGroupTotals.매출 > 0 ? g.매출 / ageGroupTotals.매출 : 0)})</span></td>
                          </tr>
                          {open && g.options.map((o, j) => (
                            <tr key={g.group + '_' + j} className="border-t border-gray-50 bg-gray-50/40 text-gray-600">
                              <td className="px-3 py-1.5 pl-10 max-w-xs truncate" title={o.label}>{o.label}</td>
                              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{fmt(o.결제수)} <span className="text-gray-400">({pct(ageGroupTotals.결제수 > 0 ? o.결제수 / ageGroupTotals.결제수 : 0)})</span></td>
                              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{man(o.매출)} <span className="text-gray-400">({pct(ageGroupTotals.매출 > 0 ? o.매출 / ageGroupTotals.매출 : 0)})</span></td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
              <ChartBox>
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={48} unit="%" />
                  <Tooltip formatter={(v: any) => v + '%'} />
                  <Legend />
                  <Line type="monotone" dataKey="중년" name={AXIS_LABELS['중년']} stroke={AXIS_COLORS['중년']} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="전환맘" name={AXIS_LABELS['전환맘']} stroke={AXIS_COLORS['전환맘']} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="시니어" name={AXIS_LABELS['시니어']} stroke={AXIS_COLORS['시니어']} strokeWidth={2} dot={false} />
                </LineChart>
              </ChartBox>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold mb-4">여성 비중 추이 (%)</h2>
                <ChartBox>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={48} unit="%" />
                    <Tooltip formatter={(v: any) => v + '%'} />
                    <Line type="monotone" dataKey="여성" stroke="#ec4899" strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartBox>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold mb-4">총 결제수 추이</h2>
                <ChartBox>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={56} />
                    <Tooltip formatter={(v: any) => fmt(Number(v))} />
                    <Line type="monotone" dataKey="총결제수" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartBox>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
