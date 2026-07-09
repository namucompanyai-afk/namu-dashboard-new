'use client';

import { useState, useEffect } from 'react';

export default function LeaveApplyPage() {
  const [leaveType, setLeaveType] = useState('연차');
  const [halfPeriod, setHalfPeriod] = useState<'오전' | '오후'>('오전'); // 반차·생일 반차 오전/오후
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

  // 생일 반차: 사용 기록은 0.5일로 남기되 연차 잔여는 차감하지 않는 복지 휴가(noDeduct).
  // 병가·경조휴가·보상휴가는 UI 카드만 숨김(과거 신청 이력·DB enum은 그대로 유지).
  const leaveTypes = [
    { id: '연차', label: '연차', icon: '🌴', days: 1 },
    { id: '반차', label: '반차', icon: '🌗', days: 0.5 },
    { id: '생일 반차', label: '생일 반차', icon: '🎂', days: 0.5, noDeduct: true },
  ];
  const isHalfType = leaveType === '반차' || leaveType === '생일 반차';

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

  // 반차·생일 반차는 하루짜리 → 종료일을 시작일과 동일하게 고정
  useEffect(() => {
    if (isHalfType && startDate) {
      setEndDate(startDate);
    }
  }, [leaveType, startDate]);

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
    const submitType = leaveTypes.find(t => t.id === leaveType);
    // 생일 반차는 기록(days)만 남기고 잔여 차감(deductDays)은 0.
    const deductDaysSubmit = submitType?.noDeduct ? 0 : days;
    // 오전/오후를 기존 type 문자열에 녹여서 전송 (route는 pass-through)
    const typeStr =
      leaveType === '반차'
        ? (halfPeriod === '오전' ? '오전반차' : '오후반차')
        : leaveType === '생일 반차'
        ? (halfPeriod === '오전' ? '생일 오전반차' : '생일 오후반차')
        : '연차';

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
            type: typeStr,
            startDate,
            endDate,
            days,
            deductDays: deductDaysSubmit,
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
  // 잔여에서 실제 차감되는 일수 — 생일 반차(noDeduct)는 0.
  const selectedType = leaveTypes.find(t => t.id === leaveType);
  const deductDays = selectedType?.noDeduct ? 0 : days;
  const afterRemaining = leaveBalance.remaining - deductDays;

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
                <div className="grid grid-cols-3 gap-2">
                  {leaveTypes.map((type) => (
                    <button
                      key={type.id}
                      onClick={() => setLeaveType(type.id)}
                      className={'relative px-2 py-2 rounded-xl border-2 transition-all ' + (leaveType === type.id ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300')}
                    >
                      <div className="text-xl mb-1">{type.icon}</div>
                      <div className={'text-xs font-medium ' + (leaveType === type.id ? 'text-blue-700' : 'text-gray-700')}>
                        {type.label}
                      </div>
                      {type.days > 0 && (
                        <div className="text-[11px] text-gray-500 mt-1">
                          {type.noDeduct ? '0일 차감' : type.days + '일'}
                        </div>
                      )}
                    </button>
                  ))}
                </div>

                {/* 반차·생일 반차 오전/오후 선택 (연차면 숨김) */}
                {isHalfType && (
                  <div className="mt-4">
                    <span className="block text-xs font-medium text-gray-500 mb-2">시간대</span>
                    <div className="inline-flex rounded-xl border-2 border-gray-200 p-1">
                      {(['오전', '오후'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setHalfPeriod(p)}
                          className={'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ' + (halfPeriod === p ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100')}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
                    disabled={!startDate || isHalfType}
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
                className={'w-full text-sm font-medium py-2 rounded-xl transition-colors shadow-sm ' + (loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white')}
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
                    {selectedType?.icon ?? '🌴'}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{leaveType}{isHalfType ? ` · ${halfPeriod}` : ''}</div>
                    <div className="text-sm text-gray-500">{deductDays}일 차감 (주말제외){selectedType?.noDeduct && days > 0 ? ` · 기록 ${days}일` : ''}</div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">사용</span>
                    <span className="text-lg font-semibold text-blue-600">{leaveBalance.used}일</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">차감</span>
                    <span className="text-lg font-semibold text-gray-900">{deductDays}일</span>
                  </div>
                  <div className="h-px bg-gray-200"></div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">신청 후 잔여</span>
                    <span className={'text-xl font-bold ' + (afterRemaining < 0 ? 'text-red-600' : 'text-green-600')}>{afterRemaining}일</span>
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
                      <div className="bg-blue-400 h-2 rounded-full" style={{ width: Math.min((leaveBalance.used / leaveBalance.total) * 100, 100) + '%' }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs text-gray-600">잔여</span>
                      <span className={'text-sm font-semibold ' + (leaveBalance.remaining < 0 ? 'text-red-600' : 'text-green-600')}>{leaveBalance.remaining}일</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className={(leaveBalance.remaining < 0 ? 'bg-red-500' : 'bg-green-500') + ' h-2 rounded-full'} style={{ width: Math.min(Math.max(0, (leaveBalance.remaining / leaveBalance.total) * 100), 100) + '%' }}></div>
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