'use client';
import { useState } from 'react';
import type { StoreData } from './types';

interface Props {
  onApply: (data: StoreData) => void;
  onClose: () => void;
}

export default function StoreConnect({ onApply, onClose }: Props) {
  const [tab, setTab] = useState<'manual' | 'excel'>('manual');
  const [rev, setRev] = useState('');
  const [orders, setOrders] = useState('');

  function apply() {
    const revenue = parseFloat(rev.replace(/,/g, '')) || 0;
    const ord = parseInt(orders) || 0;
    if (!revenue) { alert('매출 금액을 입력해주세요.'); return; }
    onApply({ revenue, orders: ord, source: 'manual' });
  }

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
          {/* 탭 */}
          <div className="flex gap-2 mb-5">
            {(['manual', 'excel'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === t ? 'bg-emerald-600 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {t === 'manual' ? '✏️ 직접 입력' : '📊 엑셀 업로드'}
              </button>
            ))}
          </div>

          {tab === 'manual' && (
            <>
              {/* 안내 */}
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-5">
                <div className="text-xs font-semibold text-emerald-800 mb-2">📍 확인 경로</div>
                {['스마트스토어 센터 로그인', '통계 → 마케팅관리 → 사용자 정의채널', 'facebook (또는 NT 채널명) 클릭', '기간 설정 후 매출 · 주문건수 확인'].map((s, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-emerald-700 mb-1">
                    <span className="w-4 h-4 bg-emerald-600 text-white rounded-full flex items-center justify-center text-xs flex-shrink-0">{i + 1}</span>
                    {s}
                  </div>
                ))}
              </div>

              <div className="space-y-4 mb-5">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Meta 유입 총매출 (₩)</label>
                  <input type="text" value={rev} onChange={e => setRev(e.target.value)} placeholder="예: 61800000" className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">총 주문건수</label>
                  <input type="text" value={orders} onChange={e => setOrders(e.target.value)} placeholder="예: 6720" className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              </div>

              <div className="flex gap-3">
                <button onClick={apply} className="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-colors">✅ ROAS 계산 적용</button>
                <button onClick={onClose} className="px-5 py-3 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-colors">취소</button>
              </div>
            </>
          )}

          {tab === 'excel' && (
            <div className="text-center py-10">
              <div className="text-4xl mb-3">📊</div>
              <div className="text-sm font-medium text-gray-700 mb-2">엑셀 업로드</div>
              <p className="text-xs text-gray-500 mb-5">스마트스토어 센터 → 통계 → 판매분석에서<br />엑셀 다운로드 후 업로드</p>
              <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-gray-400 text-sm cursor-pointer hover:border-emerald-400 hover:text-emerald-500 transition-colors">
                파일을 끌어다 놓거나 클릭해서 선택<br />
                <span className="text-xs">.xlsx / .xls 파일 지원</span>
              </div>
              <p className="text-xs text-amber-600 mt-3">* 현재 직접 입력 방식을 권장합니다</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
