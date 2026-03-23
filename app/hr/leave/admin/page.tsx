'use client';

import { useState, useEffect } from 'react';

export default function LeaveAdminPage() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');

  useEffect(() => {
    fetchRequests();
  }, [filter]);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const url = filter === 'ALL' 
        ? '/api/apps-script?action=listLeaves'
        : '/api/apps-script?action=listLeaves&status=' + filter;
      
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.ok) {
        setRequests(data.items || []);
      }
    } catch (err) {
      console.error('목록 조회 실패:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (index: number) => {
    if (!confirm('이 연차를 승인하시겠습니까?')) {
      return;
    }

    const rowNumber = index + 2;

    try {
      const res = await fetch('/api/apps-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approveLeave',
          payload: { id: rowNumber },
        }),
      });

      const data = await res.json();

      if (data.ok) {
        alert('승인이 완료되었습니다!');
        fetchRequests();
      } else {
        alert('승인 실패: ' + (data.error || '알 수 없는 오류'));
      }
    } catch (err) {
      console.error('승인 에러:', err);
      alert('승인 중 오류가 발생했습니다.');
    }
  };

  const handleReject = async (index: number) => {
    if (!confirm('이 연차를 반려하시겠습니까?')) {
      return;
    }

    const rowNumber = index + 2;

    try {
      const res = await fetch('/api/apps-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'rejectLeave',
          payload: { id: rowNumber },
        }),
      });

      const data = await res.json();

      if (data.ok) {
        alert('반려가 완료되었습니다.');
        fetchRequests();
      } else {
        alert('반려 실패: ' + (data.error || '알 수 없는 오류'));
      }
    } catch (err) {
      console.error('반려 에러:', err);
      alert('반려 중 오류가 발생했습니다.');
    }
  };

  const getStatusColor = (status: string) => {
    if (status === '승인대기') return 'bg-yellow-100 text-yellow-800';
    if (status === '승인완료') return 'bg-green-100 text-green-800';
    if (status === '반려') return 'bg-red-100 text-red-800';
    return 'bg-gray-100 text-gray-800';
  };

  const pendingCount = requests.filter((r: any) => r.상태 === '승인대기').length;
  const approvedCount = requests.filter((r: any) => r.상태 === '승인완료').length;
  const rejectedCount = requests.filter((r: any) => r.상태 === '반려').length;

  return (
    <div className="min-h-screen bg-[#f5f3ef]">
      <div className="bg-white border-b border-gray-200 px-8 py-6">
        <h1 className="text-2xl font-semibold text-gray-900">연차 승인 관리</h1>
        <p className="text-sm text-gray-500 mt-1">
          승인대기 <span className="font-semibold text-yellow-600">{pendingCount}건</span> · 
          승인완료 <span className="font-semibold text-green-600 ml-2">{approvedCount}건</span> · 
          반려 <span className="font-semibold text-red-600 ml-2">{rejectedCount}건</span>
        </p>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <div className="flex gap-3">
              <button
                onClick={() => setFilter('ALL')}
                className={'px-4 py-2 rounded-lg font-medium transition-colors ' + (filter === 'ALL' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}
              >
                전체
              </button>
              <button
                onClick={() => setFilter('승인대기')}
                className={'px-4 py-2 rounded-lg font-medium transition-colors ' + (filter === '승인대기' ? 'bg-yellow-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}
              >
                🟡 승인대기
              </button>
              <button
                onClick={() => setFilter('승인완료')}
                className={'px-4 py-2 rounded-lg font-medium transition-colors ' + (filter === '승인완료' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}
              >
                ✅승인완료
              </button>
              <button
                onClick={() => setFilter('반려')}
                className={'px-4 py-2 rounded-lg font-medium transition-colors ' + (filter === '반려' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}
              >
                ❌반려
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-12 text-center text-gray-500">
                로딩 중...
              </div>
            ) : requests.length === 0 ? (
              <div className="p-12 text-center">
                <div className="text-5xl mb-4">📭</div>
                <p className="text-gray-500">신청 내역이 없습니다.</p>
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">신청일시</th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">신청자</th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">휴가유형</th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">기간</th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">일수</th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">상태</th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase">작업</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {requests.map((req: any, index: number) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {req.신청일시 ? new Date(req.신청일시).toLocaleString('ko-KR') : '-'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">{req.신청자}</div>
                        <div className="text-xs text-gray-500">{req.이메일}</div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">{req.휴가유형}</td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {req.시작일} ~ {req.종료일}
                      </td>
                      <td className="px-6 py-4 text-sm font-semibold text-gray-900">{req.일수}일</td>
                      <td className="px-6 py-4">
                        <span className={'inline-flex px-3 py-1 rounded-full text-xs font-medium ' + getStatusColor(req.상태)}>
                          {req.상태}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {req.상태 === '승인대기' && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleApprove(index)}
                              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
                            >
                              승인
                            </button>
                            <button
                              onClick={() => handleReject(index)}
                              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
                            >
                              반려
                            </button>
                          </div>
                        )}
                        {req.상태 === '승인완료' && (
                          <div className="text-xs text-gray-500">
                            {req.승인일시 ? new Date(req.승인일시).toLocaleString('ko-KR') : '승인 완료'}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}