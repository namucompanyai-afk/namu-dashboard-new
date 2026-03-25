'use client';
import { useState } from 'react';

const AUTO_VARS = [
  { key: 'nt_source', val: '{{site_source_name}}', desc: 'facebook / instagram' },
  { key: 'nt_medium', val: 'paid_social', desc: '고정값' },
  { key: 'nt_detail', val: '{{campaign.name}}', desc: '캠페인명 자동' },
  { key: 'nt_keyword', val: '{{ad.name}}', desc: '광고명 자동' },
];

export default function NtGenerator({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [manual, setManual] = useState({ source: 'facebook', medium: 'paid_social', detail: '', keyword: '' });
  const [tab, setTab] = useState<'auto' | 'manual'>('auto');
  const [copied, setCopied] = useState(false);

  const autoResult = url
    ? `${url}${url.includes('?') ? '&' : '?'}nt_source={{site_source_name}}&nt_medium=paid_social&nt_detail={{campaign.name}}&nt_keyword={{ad.name}}`
    : '';

  const manualResult = url
    ? `${url}${url.includes('?') ? '&' : '?'}nt_source=${manual.source}&nt_medium=${manual.medium}${manual.detail ? `&nt_detail=${manual.detail}` : ''}${manual.keyword ? `&nt_keyword=${manual.keyword}` : ''}`
    : '';

  const result = tab === 'auto' ? autoResult : manualResult;

  function copy() {
    if (!result) return;
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-blue-50 px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">🔗 NT 파라미터 생성기</h2>
            <p className="text-xs text-gray-500 mt-0.5">스마트스토어 전용 마케팅 파라미터</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="p-6">
          {/* URL 입력 */}
          <div className="mb-5">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">상품 URL</label>
            <input
              type="text" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://smartstore.naver.com/yourstore/products/..."
              className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-amber-600 mt-1">⚠️ mkt.shopping.naver.com 링크에는 NT 추가 금지 — 수수료 할인 미적용 위험</p>
          </div>

          {/* 탭 */}
          <div className="flex gap-2 mb-4">
            {(['auto', 'manual'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === t ? 'bg-indigo-600 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {t === 'auto' ? '⚡ Meta 자동변수' : '✏️ 직접 입력'}
              </button>
            ))}
          </div>

          {tab === 'auto' && (
            <div className="space-y-2 mb-5">
              {AUTO_VARS.map(v => (
                <div key={v.key} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5">
                  <div>
                    <span className="text-xs font-mono font-semibold text-indigo-600">{v.key}</span>
                    <span className="text-xs text-gray-400 ml-2">{v.desc}</span>
                  </div>
                  <span className="text-xs font-mono text-gray-500">{v.val}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'manual' && (
            <div className="grid grid-cols-2 gap-3 mb-5">
              {[
                { label: 'nt_source', key: 'source' as const, ph: 'facebook' },
                { label: 'nt_medium', key: 'medium' as const, ph: 'paid_social' },
                { label: 'nt_detail', key: 'detail' as const, ph: '캠페인명' },
                { label: 'nt_keyword', key: 'keyword' as const, ph: '광고명' },
              ].map(f => (
                <div key={f.key}>
                  <label className="text-xs font-mono text-gray-500 block mb-1">{f.label}</label>
                  <input value={manual[f.key]} onChange={e => setManual(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.ph} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              ))}
            </div>
          )}

          {/* 결과 */}
          <div className="bg-gray-50 rounded-xl p-4 mb-4">
            <div className="text-xs font-semibold text-gray-400 mb-2">생성된 URL</div>
            <div className="text-xs font-mono text-gray-700 break-all">{result || 'URL을 입력하면 여기에 생성됩니다'}</div>
          </div>

          <button onClick={copy} disabled={!result} className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors ${result ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
            {copied ? '✅ 복사됨!' : '📋 URL 복사'}
          </button>
        </div>
      </div>
    </div>
  );
}
