'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

export default function LeavePage() {
  const router = useRouter();
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      setUserRole(user.role || '직원');
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#f5f3ef]">
      <div className="bg-white border-b border-gray-200 px-8 py-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <span>HR</span>
        </div>
        <h1 className="text-2xl font-semibold text-gray-900">연차</h1>
        <p className="text-sm text-gray-500 mt-1">
          직원/관리자 페이지를 선택하세요.
        </p>
      </div>

      <div className="px-8 py-12">
        <div className="grid grid-cols-2 gap-6">
          <div
            onClick={() => router.push('/hr/leave/apply')}
            className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 hover:shadow-lg transition-all cursor-pointer group max-w-xl"
          >
            <div className="flex items-start gap-4">
              <div className="text-5xl">🌴</div>
              <div className="flex-1">
                <h3 className="text-xl font-semibold text-gray-900 mb-2 group-hover:text-blue-600 transition-colors">
                  직원: 연차 신청
                </h3>
                <p className="text-gray-600 mb-4">
                  입사자정 / 제출
                </p>
                <div className="flex items-center text-blue-600 font-medium">
                  열기 <span className="ml-2">→</span>
                </div>
              </div>
            </div>
          </div>

          {userRole === '관리자' && (
            <div
              onClick={() => router.push('/hr/leave/admin')}
              className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 hover:shadow-lg transition-all cursor-pointer group max-w-xl"
            >
              <div className="flex items-start gap-4">
                <div className="text-5xl">📋</div>
                <div className="flex-1">
                  <h3 className="text-xl font-semibold text-gray-900 mb-2 group-hover:text-blue-600 transition-colors">
                    관리자: 승인 관리
                  </h3>
                  <p className="text-gray-600 mb-4">
                    승인/반려 / 캘린더 등록
                  </p>
                  <div className="flex items-center text-blue-600 font-medium">
                    열기 <span className="ml-2">→</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8">
          <button
            onClick={() => router.push('/hr')}
            className="text-gray-600 hover:text-gray-900 flex items-center gap-2"
          >
            <span>←</span> HR로 돌아가기
          </button>
        </div>
      </div>
    </div>
  );
}