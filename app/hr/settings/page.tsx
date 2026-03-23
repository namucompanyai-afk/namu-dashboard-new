'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SettingsPage() {
  const router = useRouter();
  const [userRole, setUserRole] = useState('');

  const [leavePolicy, setLeavePolicy] = useState({
    halfDay: true,
  });

  const [overtimePolicy, setOvertimePolicy] = useState({
    track52hours: true,
    selfRequest: true,
    adminProxy: true,
  });

  const specialLeaves = [
    { label: '본인 결혼', days: 5 },
    { label: '배우자 출산', days: 10 },
    { label: '부모/배우자 사망', days: 5 },
    { label: '조부모/형제 사망', days: 3 },
    { label: '병가', days: '연 60일' },
  ];

  const HR_DB_URL = "https://docs.google.com/spreadsheets/d/1K1KxEP_z5Y6kkw96t4j4eiRxcHrRChgFhUmFANegf0c/edit?gid=1056457652#gid=1056457652";

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      setUserRole(user.role || '직원');
      if (user.role !== '관리자') {
        router.replace('/hr');
      }
    }
  }, []);

  if (userRole !== '관리자') return null;

  const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
    <button
      onClick={onChange}
      className={'relative inline-flex h-6 w-11 items-center rounded-full transition-colors ' + (enabled ? 'bg-blue-600' : 'bg-gray-300')}
    >
      <span className={'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' + (enabled ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );

  const openHrDb = () => {
    window.open(HR_DB_URL, '_blank');
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">설정</h1>
      <p className="text-sm text-gray-500 mt-1">변경 사항은 즉시 반영됩니다</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5 lg:p-6">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">🌴</span>
            <h3 className="text-lg font-semibold text-gray-900">연차 정책</h3>
          </div>
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-900">기준: 1월 1일 (회계연도)</p>
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded-full font-medium">고정</span>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-900">연차사용촉진제도 (미사용 소멸)</p>
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded-full font-medium">고정</span>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-900">중도입사자 비례배분</p>
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded-full font-medium">고정</span>
            </div>
            <div className="h-px bg-gray-200"></div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">반차 사용 (오전/오후)</p>
                <p className="text-xs text-gray-500 mt-0.5">0.5일 단위</p>
              </div>
              <Toggle enabled={leavePolicy.halfDay} onChange={() => setLeavePolicy(prev => ({ ...prev, halfDay: !prev.halfDay }))} />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5 lg:p-6">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">⏰</span>
            <h3 className="text-lg font-semibold text-gray-900">연장근로 정책</h3>
          </div>
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">주 52시간 한도 추적</p>
                <p className="text-xs text-gray-500 mt-0.5">초과 시 알림</p>
              </div>
              <Toggle enabled={overtimePolicy.track52hours} onChange={() => setOvertimePolicy(prev => ({ ...prev, track52hours: !prev.track52hours }))} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">직원 본인 신청</p>
                <p className="text-xs text-gray-500 mt-0.5">직원이 직접 연장근로 신청 가능</p>
              </div>
              <Toggle enabled={overtimePolicy.selfRequest} onChange={() => setOvertimePolicy(prev => ({ ...prev, selfRequest: !prev.selfRequest }))} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">관리자 대리 신청</p>
                <p className="text-xs text-gray-500 mt-0.5">관리자가 직원 대신 신청 가능</p>
              </div>
              <Toggle enabled={overtimePolicy.adminProxy} onChange={() => setOvertimePolicy(prev => ({ ...prev, adminProxy: !prev.adminProxy }))} />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5 lg:p-6">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">🎉</span>
            <h3 className="text-lg font-semibold text-gray-900">특별휴가</h3>
          </div>
          <div className="space-y-3">
            {specialLeaves.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between py-2">
                <p className="text-sm text-gray-900">{item.label}</p>
                <span className="text-sm font-semibold text-gray-700">{item.days}{typeof item.days === 'number' ? '일' : ''}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-gray-50 rounded-xl">
            <p className="text-xs text-gray-500">특별휴가는 근로기준법에 따라 연차에서 차감되지 않습니다.</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5 lg:p-6">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">🗄️</span>
            <h3 className="text-lg font-semibold text-gray-900">DB 링크</h3>
          </div>
          <div className="space-y-4">
            <button
              onClick={openHrDb}
              className="w-full flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-xl hover:bg-green-100 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">📊</span>
                <div className="text-left">
                  <p className="text-sm font-medium text-green-900">HR 데이터베이스</p>
                  <p className="text-xs text-green-700">Google Sheets</p>
                </div>
              </div>
              <span className="text-green-600 text-lg">→</span>
            </button>
            <div className="flex items-center justify-between p-4 bg-gray-50 border border-gray-200 rounded-xl">
              <div className="flex items-center gap-3">
                <span className="text-2xl">📈</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">Sales 데이터베이스</p>
                  <p className="text-xs text-gray-500">추후 연결 예정</p>
                </div>
              </div>
              <span className="text-gray-400 text-lg">→</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}