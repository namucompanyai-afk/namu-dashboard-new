'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { DASHBOARD_PAGES, DEFAULT_PAGE_IDS, PAGE_BY_ID } from '@/lib/dashboard-pages';
import { getUserDashboardPages, saveUserDashboardPages } from '@/lib/supabase';

function QuickLink({ title, href, emoji }: { title: string; href: string; emoji: string }) {
  return (
    <Link href={href} className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="h-11 w-11 rounded-2xl bg-neutral-100 flex items-center justify-center text-xl">{emoji}</div>
      <div className="flex-1">
        <div className="text-[15px] font-semibold">{title}</div>
      </div>
      <div className="text-sm font-medium text-neutral-900">열기 →</div>
    </Link>
  );
}

export default function HomePage() {
  const [email, setEmail] = useState<string>('');
  const [pageIds, setPageIds] = useState<string[]>(DEFAULT_PAGE_IDS);
  const [loaded, setLoaded] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    const userEmail = userStr ? (JSON.parse(userStr).email || '') : '';
    setEmail(userEmail);
    if (!userEmail) { setLoaded(true); return; }
    (async () => {
      try {
        const ids = await getUserDashboardPages(userEmail);
        setPageIds(ids && ids.length > 0 ? ids : DEFAULT_PAGE_IDS);
      } catch (err) {
        console.error('대시보드 페이지 조회 실패:', err);
        setPageIds(DEFAULT_PAGE_IDS);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // 마스터에 존재하는 핀만 노출 (삭제/예정 id 자동 필터).
  const pinnedPages = useMemo(
    () => pageIds.map((id) => PAGE_BY_ID[id]).filter(Boolean),
    [pageIds],
  );

  const openModal = () => {
    setDraft(pageIds);
    setModalOpen(true);
  };

  const toggleDraft = (id: string) => {
    setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const saveDraft = async () => {
    if (!email) { setModalOpen(false); return; }
    setSaving(true);
    try {
      await saveUserDashboardPages(email, draft);
      setPageIds(draft);
      setModalOpen(false);
    } catch (err) {
      console.error('대시보드 페이지 저장 실패:', err);
      alert('저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">나무컴퍼니 통합 포털</h1>
        <button
          onClick={openModal}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          ⚙ 관리
        </button>
      </div>

      <section className="mt-7">
        {loaded && pinnedPages.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            노출할 페이지가 없습니다. 우측 상단 ⚙ 관리에서 페이지를 선택하세요.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {pinnedPages.map((p) => (
              <QuickLink key={p.id} title={p.title} href={p.href} emoji={p.emoji} />
            ))}
          </div>
        )}
      </section>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setModalOpen(false)}></div>
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">페이지 셋팅</h2>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-700">✕</button>
            </div>
            <p className="mb-4 text-sm text-gray-500">메인에 노출할 페이지를 선택하세요.</p>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {DASHBOARD_PAGES.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-gray-200 p-3 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={draft.includes(p.id)}
                    onChange={() => toggleDraft(p.id)}
                    className="h-4 w-4"
                  />
                  <span className="text-xl">{p.emoji}</span>
                  <span className="text-sm font-medium text-gray-800">{p.title}</span>
                </label>
              ))}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={saveDraft}
                disabled={saving}
                className={'rounded-lg px-4 py-2 text-sm font-medium text-white ' + (saving ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700')}
              >
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
