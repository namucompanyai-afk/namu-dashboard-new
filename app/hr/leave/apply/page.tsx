'use client';

import { useState, useEffect } from 'react';

export default function LeaveApplyPage() {
  const [leaveType, setLeaveType] = useState('연차');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);

  const [currentUser, setCurrentUser] = useState({
    name: '',
    email: '',
  });

  const [leaveBalance, setLeaveBalance] = useState({
    total: 15,
    used: 0,
    remaining: 15,
  });

  const leaveTypes = [
    { id: '연차', label: '연차', icon: '🌴', days: 1 },
    { id: '오전반차', label: '오전반차', icon: '🌅', days: 0.5 },
    { id: '오후반차', label: '오후반차', icon: '🌆', days: 0.5 },
    { id: '병가', label: '병가', icon: '🏥', days: 0 },
    { id: '경조휴가', label: '경조휴가', icon: '🎊', days: 0 },
    { id: '보상휴가', label: '보상휴가', icon: '🎁', days: 0 },
  ];

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      setCurrentUser({
        name: user.name || '',
        email: user.email || '',
      });
    }
  }, []);

  useEffect(() => {
    if (currentUser.email) {
      fetchEmployeeData();
    }
  }, [currentUser.email]);

  useEffect(() => {
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      setEndDate(startDate);
    }
  }, [startDate]);

  const fetchEmployeeData = async () => {
    try {
      const res = await fetch('/api/apps-script?action=getEmployee&email=' + currentUser.email);
      const data = await res.json();

      if (data.ok && data.data) {
        setLeaveBalance({
          total: data.data.총연차 ?? 15,
          used: data.data.사용연차 ?? 0,
          remaining: data.data.잔여연차 ?? 15,
        });
      }
    } catch (err) {
      console.error('연차 정보 조회 실패:', err);
    }
  };

  const countWeekdays = (start: Date, end: Date) => {
    let count = 0;
    const current = new Date(start);

    while (current <= end) {
      const dayOfWeek = current.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }

    return count;
  };

  const calculateDays = () => {
    if (!startDate || !endDate) return 0;

    const start = new Date(startDate);
    const end = new Date(endDate);

    const weekdays = countWeekdays(start, end);

    const selectedType = leaveTypes.find(t => t.id === leaveType);
    if (selectedType && selectedType.days > 0) {
      return selectedType.days * weekdays;
    }
    return 0;
  };

  const handleSubmit = async () => {
    if (!startDate || !endDate) {
      alert('시작일과 종료일을 선택해주세요!');
      return;
    }

    const days = calculateDays();

    setLoading(true);

    try {
      const res = await fetch('/api/apps-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'createLeave',
          payload: {
            name: currentUser.name,
            email: currentUser.email,
            type: leaveType,
            startDate,
            endDate,
            days,
          },
        }),
      });

      const data = await res.json();

      if (data.ok) {
        alert('연차 신청이 완료되었습니다!\n승인 대기 중입니다.');
        setStartDate('');
        setEndDate('');
        fetchEmployeeData();
      } else {
        alert('연차 신청 실패: ' + (data.error || '알 수 없는 오류'));
      }
    } catch (err) {
      console.error('연차 신청 에러:', err);
      alert('연차 신청 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const days = calculateDays();

  return (
    <div className="min-h-screen bg-[#f5f3ef]">
      <div className="bg-white border-b border-gray-200 px-8 py-6">
        <h1 className="text-2xl font-semibold text-gray-900">연차 신청</h1>
        <p className="text-sm text-gray-500 mt-1">
          승인 받아 바로 휴가 · 잔여: <span className="font-semibold text-green-600">{leaveBalance.remaining}일</span>
        </p>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
              <div className="mb-8">
                <label className="block text-sm font-medium text-gray-700 mb-4">
                  휴가 유형
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {leaveTypes.map((type) => (
                    <button
                      key={type.id}
                      onClick={() => setLeaveType(type.id)}
                      className={'relative px-4 py-3 rounded-xl border-2 transition-all ' + (leaveType === type.id ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300')}
                    >
                      <div className="text-2xl mb-1">{type.icon}</div>
                      <div className={'text-sm font-medium ' + (leaveType === type.id ? 'text-blue-700' : 'text-gray-700')}>
                        {type.label}
                      </div>
                      {type.days > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          {type.days}일
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    시작일
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    종료일
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    min={startDate || undefined}
                    disabled={!startDate}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                  />
                </div>
              </div>

              {startDate && endDate && (
                <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                  <p className="text-sm text-blue-700">
                    💡 주말(토/일)을 제외한 평일만 연차로 계산됩니다.
                  </p>
                </div>
              )}

              <button
                onClick={handleSubmit}
                disabled={loading}
                className={'w-full font-medium py-4 rounded-xl transition-colors shadow-sm ' + (loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white')}
              >
                {loading ? '신청 중...' : '연차 신청하기'}
              </button>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-8">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">미리보기</h3>

                <div className="flex items-center mb-6">
                  <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center text-2xl mr-3">
                    🌴
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{leaveType}</div>
                    <div className="text-sm text-gray-500">{days}일 차감 (주말제외)</div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">사용</span>
                    <span className="text-lg font-semibold text-blue-600">{leaveBalance.used}일</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">차감</span>
                    <span className="text-lg font-semibold text-gray-900">{days}일</span>
                  </div>
                  <div className="h-px bg-gray-200"></div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">신청 후 잔여</span>
                    <span className="text-xl font-bold text-green-600">{leaveBalance.remaining - days}일</span>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-6 border border-blue-100">
                <h4 className="text-sm font-medium text-gray-700 mb-4">2026년 연차 현황</h4>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs text-gray-600">총 연차</span>
                      <span className="text-sm font-semibold text-gray-900">{leaveBalance.total}일</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '100%' }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs text-gray-600">사용</span>
                      <span className="text-sm font-semibold text-blue-600">{leaveBalance.used}일</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="bg-blue-400 h-2 rounded-full" style={{ width: ((leaveBalance.used / leaveBalance.total) * 100) + '%' }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs text-gray-600">잔여</span>
                      <span className="text-sm font-semibold text-green-600">{leaveBalance.remaining}일</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="bg-green-500 h-2 rounded-full" style={{ width: ((leaveBalance.remaining / leaveBalance.total) * 100) + '%' }}></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}