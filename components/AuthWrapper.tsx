'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const user = localStorage.getItem('user');
    if (!user && pathname !== '/login') {
      router.replace('/login');
    } else {
      setLoggedIn(!!user);
      // 진도팜 계정(role='진도팜'): 진도팜 그룹(/jindopam/*) 밖 경로 접근 시 원가표로 리다이렉트
      if (user && pathname !== '/login' && !pathname.startsWith('/jindopam')) {
        try {
          if (JSON.parse(user)?.role === '진도팜') {
            router.replace('/jindopam/cost');
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