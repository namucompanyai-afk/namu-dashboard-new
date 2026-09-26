'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';

// 진도팜 계정(role='진도팜') 허용 경로 화이트리스트 (원가표 하나로 축소)
const JINDO_ALLOWED = ['/jindopam/cost'];
// 게스트 계정(role='게스트') 허용 경로 (쿠팡 광고 분석 라이브 탭 전용)
const GUEST_ALLOWED = ['/coupang-tools/ad-analysis'];
const inAllowed = (pathname: string, allowed: string[]) =>
  allowed.some((p) => pathname === p || pathname.startsWith(p + '/'));
// 서버 로그인 확인(nd_auth 쿠키) 대상 API — 401 이면 로그인 쿠키가 없거나 만료된 것
const AUTH_APIS = [
  '/api/b2b/sheets', '/api/b2b/history', '/api/jindopam/cost',
  '/api/campaign-targets', '/api/coupang-ad-history', '/api/coupang-diagnoses',
  '/api/coupang-margin-master', '/api/coupang-master', '/api/influencer',
  '/api/jindopam-mapping', '/api/jindopam/settlement', '/api/meta',
  '/api/naver-diagnoses', '/api/ss-product-mapping',
];

// 보호 API 가 401 을 주면 localStorage 로그인만 남은 상태 → 로그아웃 처리 후 재로그인 (1회 설치)
function installAuthExpiryHandler() {
  const w = window as typeof window & { __ndAuthFetch?: boolean };
  if (w.__ndAuthFetch) return;
  w.__ndAuthFetch = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await orig(input, init);
    if (res.status === 401) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin).pathname;
      if (AUTH_APIS.some((p) => path === p || path.startsWith(p + '/'))) {
        localStorage.removeItem('user');
        document.cookie = 'nd_role=; path=/; max-age=0';
        window.location.href = '/login';
      }
    }
    return res;
  };
}

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    installAuthExpiryHandler();
  }, []);

  useEffect(() => {
    const user = localStorage.getItem('user');
    if (!user && pathname !== '/login') {
      router.replace('/login');
    } else {
      setLoggedIn(!!user);
      // role별 허용 화이트리스트 밖 경로 접근 시 각자 랜딩 페이지로 리다이렉트
      if (user && pathname !== '/login') {
        try {
          const role = JSON.parse(user)?.role;
          if (role === '진도팜' && !inAllowed(pathname, JINDO_ALLOWED)) {
            router.replace('/jindopam/cost');
          } else if (role === '게스트' && !inAllowed(pathname, GUEST_ALLOWED)) {
            router.replace('/coupang-tools/ad-analysis');
          }
        } catch {
          /* 파싱 실패 무시 */
        }
      }
    }
    setChecked(true);
  }, [pathname, router]);

  if (!checked) return null;
  if (pathname === '/login') return <>{children}</>;
  if (!loggedIn) return null;

  return (
    <div className="min-h-screen">
      <div className="flex">
        <Sidebar />
        <main className="flex-1 min-w-0">
          <div className="mt-14 lg:mt-0 px-4 py-6 lg:px-10 lg:py-10">
            <div className="max-w-screen-2xl">{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}