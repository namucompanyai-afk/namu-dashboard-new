'use client';
import { fN } from './types';
import type { StoreData } from './types';

interface Props {
  metaRoas: number;
  storeData: StoreData;
  spend: number;
  onUpload: () => void;
  onNt: () => void;
}

export default function RoasBanner({ metaRoas, storeData, spend, onUpload, onNt }: Props) {
  const storeRoas = spend > 0 && storeData.revenue > 0 ? storeData.revenue / spend : 0;
  const diff = metaRoas > 0 && storeRoas > 0 ? metaRoas - storeRoas : 0;
  const diffPct = storeRoas > 0 ? (diff / storeRoas * 100).toFixed(1) : '0';

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
      <div className="flex items-center gap-0">
        {/* Meta ROAS */}
        <div className="flex-1 pr-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-semibold">Meta 픽셀</span>
            <span className="text-xs text-gray-400">ROAS</span>
          </div>
          <div className="text-3xl font-bold text-blue-600">{metaRoas > 0 ? (metaRoas * 100).toFixed(0) + '%' : 'N/A'}</div>
          <div className="text-xs text-gray-400 mt-1">Meta 추정 전환 기준</div>
        </div>

        <div className="w-px h-14 bg-gray-100 mx-2" />

        {/* 실 ROAS */}
        <div className="flex-1 px-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">스마트스토어</span>
            <span className="text-xs text-gray-400">실 ROAS</span>
          </div>
          <div className="text-3xl font-bold text-emerald-600">
            {storeRoas > 0 ? (storeRoas * 100).toFixed(0) + '%' : <span className="text-base text-gray-400 font-medium">매출 미연결</span>}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {storeData.revenue > 0 ? `실매출 ₩${fN(storeData.revenue)} · ${fN(storeData.orders)}건` : 'NT 파라미터 기반 매출 입력 필요'}
          </div>
        </div>

        <div className="w-px h-14 bg-gray-100 mx-2" />

        {/* 괴리율 */}
        <div className="flex-1 px-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-semibold">괴리율</span>
          </div>
          <div className={`text-3xl font-bold ${diff > 0 ? 'text-orange-500' : 'text-gray-300'}`}>
            {diff !== 0 ? `${diff > 0 ? '+' : ''}${diffPct}%` : '—'}
          </div>
          <div className="text-xs text-gray-400 mt-1">{diff > 0 ? `Meta가 ${diffPct}% 과대 측정` : '데이터 연결 후 표시'}</div>
        </div>

        <div className="w-px h-14 bg-gray-100 mx-2" />

        {/* 버튼 */}
        <div className="flex flex-col gap-2 pl-4">
          <button onClick={onUpload} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap">
            📦 매출 업로드
          </button>
          <button onClick={onNt} className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-600 text-xs font-semibold rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap">
            🔗 NT 파라미터
          </button>
        </div>
      </div>
    </div>
  );
}
