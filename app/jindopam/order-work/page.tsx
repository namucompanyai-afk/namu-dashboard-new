'use client';

import React, { useCallback, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import KpiCard from '@/components/pnl/KpiCard';

type Market = '스스' | '스타' | '일반';
type Size = '소' | '중' | '대';
type FileKey = '스스소' | '스스중' | '스타소' | '스타중' | '일반소' | '일반중';

interface ShopmineRow {
  주문번호: string;
  받는분성명: string;
  전화: string;
  주소: string;
  품목명: string;
  옵션: string;
  수량: number;
  배송메세지1: string;
  배송메세지2: string;
}

interface MappingRow {
  품목명: string;
  옵션: string;
  별칭: string;
  주문당수량: number;
  발송거래처: string;
  소한계: number;
  중한계: number;
}

interface ProcessedRow extends ShopmineRow {
  mapped: boolean;
  별칭: string;
  발송봉수: number;
  발송거래처: string;
  소한계: number;
  중한계: number;
  봉용량kg: number;
  봉용량유효: boolean;
  마켓: Market;
}

interface RecipientGroup {
  key: string;
  받는분성명: string;
  전화: string;
  주소: string;
  마켓: Market;
  사이즈: Size;
  rows: ProcessedRow[];
}

const FILE_KEYS: FileKey[] = ['스스소', '스스중', '스타소', '스타중', '일반소', '일반중'];

function classifyMarket(msg: string): Market {
  const s = (msg || '').toString();
  if (s.includes('스마트스토어')) return '스스';
  if (s.includes('지마켓')) return '스타';
  return '일반';
}

function extractBongKg(별칭: string): { kg: number; valid: boolean } {
  if (!별칭) return { kg: 0, valid: false };
  const re = /(\d+(?:\.\d+)?)\s*(kg|g)/gi;
  const matches = [...별칭.matchAll(re)];
  if (matches.length === 0) return { kg: 0, valid: false };
  const last = matches[matches.length - 1];
  const v = parseFloat(last[1]);
  const unit = last[2].toLowerCase();
  return { kg: unit === 'kg' ? v : v / 1000, valid: true };
}

function pickSize(g: RecipientGroup['rows']): Size {
  if (g.length === 1) {
    const r = g[0];
    if (r.발송봉수 <= r.소한계) return '소';
    if (r.발송봉수 <= r.중한계) return '중';
    return '대';
  }
  const totalKg = g.reduce((s, r) => s + r.발송봉수 * r.봉용량kg, 0);
  if (totalKg <= 3) return '소';
  if (totalKg <= 10) return '중';
  return '대';
}

function bucketKey(market: Market, size: Size): FileKey {
  const s = size === '대' ? '중' : size;
  return (market + s) as FileKey;
}

function downloadXlsx(rows: any[][], filename: string) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}

export default function JindopamOrderWorkPage() {
  const [shopmine, setShopmine] = useState<ShopmineRow[]>([]);
  const [mapping, setMapping] = useState<MappingRow[]>([]);
  const [shopmineName, setShopmineName] = useState<string>('');
  const [mappingName, setMappingName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [dragSm, setDragSm] = useState(false);
  const [dragMp, setDragMp] = useState(false);

  const parseShopmine = useCallback((file: File) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any[]>(sh, { header: 1, defval: '' });
        const parsed: ShopmineRow[] = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i] as any[];
          if (!r || r.length === 0) continue;
          const 품목명 = String(r[7] || '').trim();
          if (!품목명) continue;
          parsed.push({
            주문번호: String(r[0] || '').trim(),
            받는분성명: String(r[1] || '').trim(),
            전화: String(r[2] || '').trim(),
            주소: String(r[5] || '').trim(),
            품목명,
            옵션: String(r[8] || '').trim(),
            수량: Number(r[9]) || 0,
            배송메세지1: String(r[10] || '').trim(),
            배송메세지2: String(r[11] || '').trim(),
          });
        }
        setShopmine(parsed);
        setShopmineName(file.name);
      } catch (err: any) {
        setError('샵마인 파일 파싱 실패: ' + (err?.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const parseMapping = useCallback((file: File) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const sheetName = wb.SheetNames.find(n => n === '발주매핑v6') || wb.SheetNames[0];
        const sh = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<any[]>(sh, { header: 1, defval: '' });
        const parsed: MappingRow[] = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i] as any[];
          if (!r || r.length === 0) continue;
          const 품목명 = String(r[0] || '').trim();
          if (!품목명) continue;
          parsed.push({
            품목명,
            옵션: String(r[1] || '').trim(),
            별칭: String(r[2] || '').trim(),
            주문당수량: Number(r[3]) || 0,
            발송거래처: String(r[4] || '').trim(),
            소한계: Number(r[5]) || 0,
            중한계: Number(r[6]) || 0,
          });
        }
        setMapping(parsed);
        setMappingName(file.name);
      } catch (err: any) {
        setError('매핑 파일 파싱 실패: ' + (err?.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const mappingMap = useMemo(() => {
    const m = new Map<string, MappingRow>();
    for (const r of mapping) {
      m.set(`${r.품목명}||${r.옵션}`, r);
    }
    return m;
  }, [mapping]);

  const processed = useMemo<ProcessedRow[]>(() => {
    return shopmine.map((s) => {
      const m = mappingMap.get(`${s.품목명}||${s.옵션}`);
      const 마켓 = classifyMarket(s.배송메세지2);
      if (!m) {
        return {
          ...s,
          mapped: false,
          별칭: '',
          발송봉수: 0,
          발송거래처: '',
          소한계: 0,
          중한계: 0,
          봉용량kg: 0,
          봉용량유효: false,
          마켓,
        };
      }
      const 발송봉수 = m.주문당수량 * s.수량;
      const bong = extractBongKg(m.별칭);
      return {
        ...s,
        mapped: true,
        별칭: m.별칭,
        발송봉수,
        발송거래처: m.발송거래처,
        소한계: m.소한계,
        중한계: m.중한계,
        봉용량kg: bong.kg,
        봉용량유효: bong.valid,
        마켓,
      };
    });
  }, [shopmine, mappingMap]);

  const unmapped = useMemo(() => {
    const set = new Map<string, { 품목명: string; 옵션: string; count: number }>();
    for (const r of processed) {
      if (r.mapped) continue;
      const k = `${r.품목명}||${r.옵션}`;
      const v = set.get(k);
      if (v) v.count++;
      else set.set(k, { 품목명: r.품목명, 옵션: r.옵션, count: 1 });
    }
    return [...set.values()].sort((a, b) => b.count - a.count);
  }, [processed]);

  const jindopam = useMemo(() => processed.filter(r => r.mapped && r.발송거래처 === '진도팜'), [processed]);

  const aggregate = useMemo(() => {
    const m = new Map<string, { 별칭: string; 발송봉수: number; 봉용량유효: boolean }>();
    for (const r of jindopam) {
      const v = m.get(r.별칭);
      if (v) {
        v.발송봉수 += r.발송봉수;
        if (!r.봉용량유효) v.봉용량유효 = false;
      } else {
        m.set(r.별칭, { 별칭: r.별칭, 발송봉수: r.발송봉수, 봉용량유효: r.봉용량유효 });
      }
    }
    const arr = [...m.values()].sort((a, b) => b.발송봉수 - a.발송봉수);
    const total = arr.reduce((s, x) => s + x.발송봉수, 0);
    return { rows: arr, total };
  }, [jindopam]);

  const recipientBuckets = useMemo(() => {
    const groups = new Map<string, RecipientGroup>();
    for (const r of jindopam) {
      const k = `${r.받는분성명}|${r.전화}|${r.주소}`;
      const g = groups.get(k);
      if (g) {
        g.rows.push(r);
      } else {
        groups.set(k, {
          key: k,
          받는분성명: r.받는분성명,
          전화: r.전화,
          주소: r.주소,
          마켓: r.마켓,
          사이즈: '소',
          rows: [r],
        });
      }
    }
    const buckets: Record<FileKey, RecipientGroup[]> = {
      스스소: [], 스스중: [], 스타소: [], 스타중: [], 일반소: [], 일반중: [],
    };
    for (const g of groups.values()) {
      g.사이즈 = pickSize(g.rows);
      buckets[bucketKey(g.마켓, g.사이즈)].push(g);
    }
    return { groups: [...groups.values()], buckets };
  }, [jindopam]);

  const totalBong = aggregate.total;
  const totalRecipients = recipientBuckets.groups.length;

  const copyAggregateText = useCallback(() => {
    const lines = [`별칭\t발송봉수`];
    for (const r of aggregate.rows) {
      lines.push(`${r.별칭}\t${r.발송봉수}`);
    }
    lines.push(`총합계\t${aggregate.total}`);
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(
      () => alert('집계표 복사 완료. 카톡에 붙여넣기 하세요.'),
      () => alert('복사 실패. 브라우저 권한 확인.'),
    );
  }, [aggregate]);

  const downloadAggregate = useCallback(() => {
    const rows: any[][] = [['별칭', '발송봉수']];
    for (const r of aggregate.rows) rows.push([r.별칭, r.발송봉수]);
    rows.push(['총합계', aggregate.total]);
    downloadXlsx(rows, `진도팜_집계표_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [aggregate]);

  const downloadBucket = useCallback((key: FileKey) => {
    const groups = recipientBuckets.buckets[key];
    const rows: any[][] = [['받는분성명', '받는분전화번호', '받는분주소', '배송메세지1', '내품명', '내품수량', '채널']];
    for (const g of groups) {
      for (const r of g.rows) {
        rows.push([g.받는분성명, g.전화, g.주소, r.배송메세지1, r.별칭, r.발송봉수, g.마켓]);
      }
    }
    downloadXlsx(rows, `진도팜_${key}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [recipientBuckets]);

  const onDrop = (kind: 'sm' | 'mp') => (e: React.DragEvent) => {
    e.preventDefault();
    if (kind === 'sm') setDragSm(false);
    else setDragMp(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (kind === 'sm') parseShopmine(file);
    else parseMapping(file);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">진도팜 발주</h1>
        <p className="text-sm text-gray-500 mt-1">샵마인 발송대기 + 매핑 파일 업로드 → 1단계 집계표 + 2단계 6개 파일</p>
      </div>

      {/* 업로드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragSm(true); }}
          onDragLeave={() => setDragSm(false)}
          onDrop={onDrop('sm')}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${dragSm ? 'border-teal-500 bg-teal-50' : 'border-gray-300 bg-white'}`}
        >
          <div className="text-sm font-medium mb-1">① 샵마인 발송대기 (.xls)</div>
          <p className="text-xs text-gray-500 mb-3">드래그앤드롭 또는 클릭</p>
          <label className="inline-block px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs cursor-pointer hover:bg-gray-700">
            파일 선택
            <input type="file" accept=".xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) parseShopmine(f); }} />
          </label>
          {shopmineName && (
            <p className="text-xs text-gray-700 mt-3">📄 {shopmineName} · {shopmine.length}행</p>
          )}
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragMp(true); }}
          onDragLeave={() => setDragMp(false)}
          onDrop={onDrop('mp')}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${dragMp ? 'border-teal-500 bg-teal-50' : 'border-gray-300 bg-white'}`}
        >
          <div className="text-sm font-medium mb-1">② 매핑 파일 (.xlsx, 시트 발주매핑v6)</div>
          <p className="text-xs text-gray-500 mb-3">드래그앤드롭 또는 클릭</p>
          <label className="inline-block px-3 py-1.5 rounded-md bg-gray-900 text-white text-xs cursor-pointer hover:bg-gray-700">
            파일 선택
            <input type="file" accept=".xlsx" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) parseMapping(f); }} />
          </label>
          {mappingName && (
            <p className="text-xs text-gray-700 mt-3">📄 {mappingName} · {mapping.length}행</p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 p-3 text-sm">{error}</div>
      )}

      {/* 매핑 안 된 행 빨간 배너 */}
      {shopmine.length > 0 && mapping.length > 0 && unmapped.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-red-700">⚠️ 매핑 안 된 (품목명+옵션) — {unmapped.length}건</h2>
            <span className="text-xs text-red-600">매핑 파일에 추가 후 다시 업로드</span>
          </div>
          <ul className="text-xs text-red-700 space-y-0.5 max-h-48 overflow-y-auto">
            {unmapped.map((u, i) => (
              <li key={i}>· {u.품목명} <span className="text-red-500">/ {u.옵션 || '(옵션없음)'}</span> · {u.count}건</li>
            ))}
          </ul>
        </div>
      )}

      {/* KPI */}
      {shopmine.length > 0 && mapping.length > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard label="진도팜 총 봉수" value={`${totalBong.toLocaleString()}봉`} accent="green" />
            <KpiCard label="받는분 수" value={`${totalRecipients.toLocaleString()}명`} />
            <KpiCard label="매핑 안 된 행" value={`${unmapped.length}건`} accent={unmapped.length > 0 ? 'red' : undefined} />
            <KpiCard label="6 파일 분포"
              value={FILE_KEYS.map(k => recipientBuckets.buckets[k].length).reduce((a, b) => a + b, 0) + '명'}
              sub={FILE_KEYS.map(k => `${k}:${recipientBuckets.buckets[k].length}`).join(' · ')} />
          </div>

          {/* 1단계 집계표 */}
          <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between">
              <h2 className="text-base font-semibold">1단계 · 진도팜 통합 집계표</h2>
              <div className="flex gap-2">
                <button onClick={copyAggregateText}
                  className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700">
                  📋 텍스트 복사 (카톡용)
                </button>
                <button onClick={downloadAggregate}
                  className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700">
                  ⬇ 엑셀 다운로드
                </button>
              </div>
            </div>
            <div className="overflow-x-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">별칭</th>
                    <th className="text-right px-4 py-2 font-medium">발송봉수</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregate.rows.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-4 py-2">
                        {r.별칭}
                        {!r.봉용량유효 && <span title="별칭에서 1봉 용량 추출 실패" className="ml-1">⚠️</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{r.발송봉수.toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                    <td className="px-4 py-2">총합계</td>
                    <td className="px-4 py-2 text-right font-mono">{aggregate.total.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 2단계 6파일 */}
          <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold">2단계 · 마켓×사이즈 6개 파일</h2>
              <p className="text-xs text-gray-500 mt-0.5">받는분 단위 합포장 · 대 사이즈는 중 파일로 통합</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-4">
              {FILE_KEYS.map((k) => {
                const groups = recipientBuckets.buckets[k];
                const bong = groups.reduce((s, g) => s + g.rows.reduce((ss, r) => ss + r.발송봉수, 0), 0);
                return (
                  <div key={k} className="rounded-lg border border-gray-200 p-3">
                    <div className="text-sm font-semibold mb-1">{k}</div>
                    <div className="text-xs text-gray-500 mb-2">받는분 {groups.length}명 · {bong.toLocaleString()}봉</div>
                    <button
                      onClick={() => downloadBucket(k)}
                      disabled={groups.length === 0}
                      className="w-full rounded-md bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                    >
                      ⬇ 다운로드
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
