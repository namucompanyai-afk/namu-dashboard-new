'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [isSalesOpen, setIsSalesOpen] = useState(true);
  const [isHROpen, setIsHROpen] = useState(true);
  const [isPnlOpen, setIsPnlOpen] = useState(true);          // 손익 관리자 (최상위)
  const [isCoupangOpen, setIsCoupangOpen] = useState(true);  // 쿠팡 서브
  const [isNaverOpen, setIsNaverOpen] = useState(true);      // 스마트스토어 서브
  const [isJindopamOpen, setIsJindopamOpen] = useState(true); // 진도팜 (최상위)
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

          {/* Sales Dashboard 드롭다운 */}
          <div>
            <button onClick={() => setIsSalesOpen(!isSalesOpen)} className={'w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (pathname.startsWith('/sales') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
              <span>📊</span>
              <span className="flex-1 text-left">Sales Dashboard</span>
              <span className="text-xs">{isSalesOpen ? '▼' : '▶'}</span>
            </button>

            {isSalesOpen && (
              <div className="ml-4 mt-1 space-y-1">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-500 cursor-not-allowed">
                  <span>📈</span>
                  <span>매출 현황</span>
                  <span className="ml-auto text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">개발중</span>
                </div>

                <Link href="/sales" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/sales') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>📦</span>
                  <span>재고관리</span>
                </Link>

                <Link href="/meta" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/meta') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>📣</span>
                  <span>Meta 광고</span>
                </Link>

                <Link href="/influencer" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/influencer') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>🌟</span>
                  <span>인플루언서</span>
                </Link>
              </div>
            )}
          </div>

          {/* HR Dashboard 드롭다운 */}
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
              </div>
            )}
          </div>

          {/* 손익 관리자 - 관리자만 */}
          {userRole === '관리자' && (
            <div>
              <button onClick={() => setIsPnlOpen(!isPnlOpen)} className={'w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (pathname.startsWith('/coupang-tools') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                <span>💰</span>
                <span className="flex-1 text-left">손익 관리자</span>
                <span className="text-xs">{isPnlOpen ? '▼' : '▶'}</span>
              </button>

              {isPnlOpen && (
                <div className="ml-4 mt-1 space-y-1">
                  {/* 데이터 관리 — 손익 관리자 직속 (쿠팡/스스 공유) */}
                  <Link href="/coupang-tools/data-management" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/coupang-tools/data-management') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                    <span>💾</span>
                    <span>데이터 관리</span>
                  </Link>

                  {/* 쿠팡 */}
                  <div>
                    <button onClick={() => setIsCoupangOpen(!isCoupangOpen)} className={'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (pathname.startsWith('/coupang-tools') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                      <span>🟠</span>
                      <span className="flex-1 text-left">쿠팡</span>
                      <span className="text-xs">{isCoupangOpen ? '▼' : '▶'}</span>
                    </button>

                    {isCoupangOpen && (
                      <div className="ml-4 mt-1 space-y-1">
                        <Link href="/coupang-tools/diagnosis" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ' + (isActive('/coupang-tools/diagnosis') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                          <span>🎯</span>
                          <span>수익 진단</span>
                        </Link>
                        <Link href="/coupang-tools/ad-analysis" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ' + (isActive('/coupang-tools/ad-analysis') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                          <span>📈</span>
                          <span>광고 분석</span>
                        </Link>
                      </div>
                    )}
                  </div>

                  {/* 스마트스토어 */}
                  <div>
                    <button onClick={() => setIsNaverOpen(!isNaverOpen)} className={'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (pathname.startsWith('/naver-tools') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                      <span>🟢</span>
                      <span className="flex-1 text-left">스마트스토어</span>
                      <span className="text-xs">{isNaverOpen ? '▼' : '▶'}</span>
                    </button>

                    {isNaverOpen && (
                      <div className="ml-4 mt-1 space-y-1">
                        <Link href="/naver-tools/diagnosis" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ' + (isActive('/naver-tools/diagnosis') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                          <span>🎯</span>
                          <span>수익 진단</span>
                        </Link>
                      </div>
                    )}
                  </div>

                  {/* 지마켓 (개발중) */}
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-500 cursor-not-allowed">
                    <span>🟡</span>
                    <span>지마켓</span>
                    <span className="ml-auto text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">예정</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 진도팜 */}
          <div>
            <button onClick={() => setIsJindopamOpen(!isJindopamOpen)} className={'w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (pathname.startsWith('/jindopam') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
              <span>🌾</span>
              <span className="flex-1 text-left">진도팜</span>
              <span className="text-xs">{isJindopamOpen ? '▼' : '▶'}</span>
            </button>

            {isJindopamOpen && (
              <div className="ml-4 mt-1 space-y-1">
                <Link href="/jindopam/settlement" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/jindopam/settlement') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>💵</span>
                  <span>정산</span>
                </Link>
                <Link href="/jindopam/orders" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/jindopam/orders') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>📦</span>
                  <span>발주 모니터링</span>
                  <span className="ml-auto text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">예정</span>
                </Link>
                <Link href="/jindopam/crm" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/jindopam/crm') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>📇</span>
                  <span>CRM</span>
                  <span className="ml-auto text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">예정</span>
                </Link>
                <Link href="/jindopam/shared" className={'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ' + (isActive('/jindopam/shared') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                  <span>🔗</span>
                  <span>공유 View</span>
                  <span className="ml-auto text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">예정</span>
                </Link>
              </div>
            )}
          </div>

          {userRole === '관리자' && (
            <>
              <div className="text-xs text-gray-400 px-3 py-2 uppercase tracking-wider mt-4">관리</div>
              <Link href="/hr/leave/admin" className={'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (isActive('/hr/leave/admin') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                <span>✅</span>
                <span>전체 히스토리</span>
              </Link>
              <Link href="/hr/users" className={'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (isActive('/hr/users') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                <span>👥</span>
                <span>가입자 관리</span>
              </Link>
              <Link href="/hr/settings" className={'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ' + (isActive('/hr/settings') ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700')}>
                <span>⚙️</span>
                <span>설정</span>
              </Link>
            </>
          )}
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
