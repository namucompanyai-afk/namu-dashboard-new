'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [isHROpen, setIsHROpen] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      setUserRole(user.role || '직원');
      setUserName(user.name || '사용자');
    }
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const handleLogout = () => {
    if (confirm('로그아웃 하시겠습니까?')) {
      localStorage.removeItem('user');
      router.push('/login');
    }
  };

  const isActive = (path: string) => pathname === path;

  const sidebarContent = (
    <>
      <div className="p-6 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gray-600 rounded-full flex items-center justify-center text-lg font-bold">
            {userName.charAt(0)}
          </div>
          <div>
            <h2 className="font-semibold">통합 대시보드</h2>
            <p className="text-xs text-gray-400">Sales / HR</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 overflow-y-auto">
        <div className="space-y-1">
          <div className="text-xs text-gray-400 px-3 py-2 uppercase tracking-wider">분석</div>

          <Link href="/sales" className={'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (isActive('/sales') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
            <span>📊</span>
            <span>Sales Dashboard</span>
          </Link>

          <Link href="/inventory" className={'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (isActive('/inventory') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
            <span>📦</span>
            <span>재고관리</span>
          </Link>

          <div>
            <button onClick={() => setIsHROpen(!isHROpen)} className={'w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (pathname.startsWith('/hr') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
              <span>👤</span>
              <span className="flex-1 text-left">HR Dashboard</span>
              <span className="text-xs">{isHROpen ? '▼' : '▶'}</span>
            </button>

            {isHROpen && (
              <div className="ml-4 mt-1 space-y-1">
                <Link href="/hr/leave" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/hr/leave') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>🌴</span>
                  <span>연차 신청</span>
                </Link>

                <Link href="/hr/calendar" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/hr/calendar') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>📅</span>
                  <span>팀원 휴가 캘린더</span>
                </Link>

                {userRole === '관리자' && (
                  <>
                    <div className="border-t border-gray-600 my-2"></div>
                    <div className="text-xs text-gray-400 px-3 py-1">관리</div>

                    <Link href="/hr/leave/admin" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/hr/leave/admin') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                      <span>✅</span>
                      <span>전체 히스토리</span>
                    </Link>

                    <Link href="/hr/users" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/hr/users') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                      <span>👥</span>
                      <span>가입자 관리</span>
                    </Link>

                    <Link href="/hr/settings" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/hr/settings') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                      <span>⚙️</span>
                      <span>설정</span>
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </nav>

      <div className="p-4 border-t border-gray-700">
        <div className="mb-3">
          <p className="text-xs text-gray-400">사용자</p>
          <p className="mt-1 text-white font-medium">{userName}</p>
          <p className="text-xs text-gray-400">{userRole === '관리자' ? '👑 관리자' : '👤 직원'}</p>
        </div>
        <button onClick={handleLogout} className="w-full px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium">
          로그아웃
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-[#2d2d2d] text-white flex items-center px-4 h-14">
        <button onClick={() => setMobileOpen(true)} className="p-2 -ml-2">
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <span className="ml-3 font-semibold">통합 대시보드</span>
      </div>

      <div className="hidden lg:flex w-64 bg-[#2d2d2d] text-white h-screen flex-col sticky top-0">
        {sidebarContent}
      </div>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => setMobileOpen(false)}></div>
          <div className="relative w-64 h-full bg-[#2d2d2d] text-white flex flex-col">
            <button onClick={() => setMobileOpen(false)} className="absolute top-4 right-4 text-gray-400 hover:text-white">
              ✕
            </button>
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}