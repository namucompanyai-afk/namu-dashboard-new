'use client';

import { useState, useEffect } from 'react';

interface LeaveBalance {
  total: number;
  used: number;
  remaining: number;
}

interface LeaveRecord {
  id: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: string;
  appliedAt: string;
}

interface TodayOff {
  name: string;
  type: string;
  crew: string;
}

interface PendingApproval {
  id: string;
  name: string;
  type: string;
  date: string;
  crew: string;
  days: number;
  reason: string;
}

const typeColors: Record<string, string> = {
  '연차': '#10b981',
  '오전반차': '#f59e0b',
  '오후반차': '#f59e0b',
  '반반차': '#8b5cf6',
  '병가': '#ef4444',
  '경조휴가': '#ec4899',
  '보상휴가': '#06b6d4',
  '연장근로': '#ef4444',
};

export default function HRDashboardPage() {
  const [user, setUser] = useState<any>(null);
  const [leaveBalance, setLeaveBalance] = useState<LeaveBalance>({ total: 15, used: 0, remaining: 15 });
  const [leaveHistory, setLeaveHistory] = useState<LeaveRecord[]>([]);
  const [todayOff, setTodayOff] = useState<TodayOff[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const userData = JSON.parse(userStr);
      setUser(userData);
      loadData(userData);
    }
  }, []);

  const loadData = async (userData: any) => {
    setLoading(true);
    try {
      // 연차 잔여 조회
      const balanceRes = await fetch(`/api/apps-script?action=getEmployee&email=${encodeURIComponent(userData.email)}`);
      const balanceData = await balanceRes.json();
      if (balanceData.ok && balanceData.data) {
        setLeaveBalance({
          total: balanceData.data.총연차 ?? 15,
          used: balanceData.data.사용연차 ?? 0,
          remaining: balanceData.data.잔여연차 ?? 15,
        });
      }

      // 전체 휴가 목록 조회
      const leavesRes = await fetch('/api/apps-script?action=listLeaves');
      const leavesData = await leavesRes.json();
      if (leavesData.ok && Array.isArray(leavesData.data)) {
        // 오늘 휴가자 추출
        const today = new Date().toISOString().slice(0, 10);
        const todayOffList = leavesData.data
          .filter((leave: any) => {
            const start = leave.시작일 || leave.startDate || '';
            const end = leave.종료일 || leave.endDate || start;
            const status = leave.승인상태 || leave.status || '';
            return start <= today && end >= today && status !== '반려';
          })
          .map((leave: any) => ({
            name: leave.이름 || leave.name || '',
            type: leave.휴가유형 || leave.type || '연차',
            crew: leave.크루 || leave.crew || '',
          }));
        setTodayOff(todayOffList);

        // 승인 대기 목록 (관리자용)
        if (userData.role === '관리자') {
          const pending = leavesData.data
            .filter((leave: any) => {
              const status = leave.승인상태 || leave.status || '';
              return status === '승인대기' || status === '대기';
            })
            .map((leave: any) => ({
              id: leave.id || '',
              name: leave.이름 || leave.name || '',
              type: leave.휴가유형 || leave.type || '연차',
              date: leave.시작일 || leave.startDate || '',
              crew: leave.크루 || leave.crew || '',
              days: leave.일수 || leave.days || 1,
              reason: leave.사유 || leave.reason || '',
            }));
          setPendingApprovals(pending);
        }

        // 내 신청 내역
        const myLeaves = leavesData.data
          .filter((leave: any) => {
            const email = leave.이메일 || leave.email || '';
            const name = leave.이름 || leave.name || '';
            return email === userData.email || name === userData.name;
          })
          .map((leave: any) => ({
            id: leave.id || '',
            type: leave.휴가유형 || leave.type || '연차',
            startDate: leave.시작일 || leave.startDate || '',
            endDate: leave.종료일 || leave.endDate || '',
            days: leave.일수 || leave.days || 1,
            reason: leave.사유 || leave.reason || '',
            status: leave.승인상태 || leave.status || '',
            appliedAt: leave.신청일 || leave.appliedAt || '',
          }));
        setLeaveHistory(myLeaves);
      }
    } catch (err) {
      console.error('데이터 로딩 에러:', err);
    } finally {
      setLoading(false);
    }
  };

  const usageRate = leaveBalance.total > 0
    ? Math.round((leaveBalance.used / leaveBalance.total) * 100)
    : 0;

  const isAdmin = user?.role === '관리자';

  const filteredHistory = leaveHistory.filter(h => {
    const year = h.startDate?.slice(0, 4);
    return year === String(selectedYear);
  });

  const todayStr = (() => {
    const d = new Date();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    return `${month}/${day} (${weekdays[d.getDay()]})`;
  })();

  const getStatusBadge = (status: string) => {
    if (status === '승인') return { bg: '#dcfce7', color: '#16a34a', label: '승인' };
    if (status === '반려') return { bg: '#fee2e2', color: '#dc2626', label: '반려' };
    return { bg: '#fef3c7', color: '#d97706', label: '대기' };
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '28px', marginBottom: '12px' }}>⏳</div>
          <p style={{ color: '#8c8478', fontSize: '14px' }}>데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Page Title */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#1a1815', margin: 0 }}>
          내 연차
        </h1>
        <p style={{ fontSize: '13px', color: '#8c8478', marginTop: '4px' }}>
          {user?.name}님의 연차 현황 및 신청 내역
        </p>
      </div>

      {/* Dashboard Cards - 직원: 2칸 / 관리자: 3칸 */}
      <div className={isAdmin ? 'grid grid-cols-1 md:grid-cols-3 gap-4 mb-6' : 'grid grid-cols-1 md:grid-cols-2 gap-4 mb-6'}>

        {/* Card 1: 나의 연차 */}
        <div style={{
          background: '#fff', borderRadius: '16px', padding: '20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #ece8e1',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <span style={{ fontSize: '18px' }}>🌴</span>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a1815' }}>나의 연차</span>
            <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#8c8478' }}>{selectedYear}년 기준</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#8c8478' }}>총 연차</div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#1a1815' }}>{leaveBalance.total}<span style={{ fontSize: '12px', color: '#8c8478' }}>일</span></div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#8c8478' }}>사용</div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#3b82f6' }}>{leaveBalance.used}<span style={{ fontSize: '12px', color: '#8c8478' }}>일</span></div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#8c8478' }}>잔여</div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#10b981' }}>{leaveBalance.remaining}<span style={{ fontSize: '12px', color: '#8c8478' }}>일</span></div>
            </div>
          </div>

          <div style={{ background: '#f3f0ea', borderRadius: '8px', height: '8px', overflow: 'hidden' }}>
            <div style={{
              background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
              height: '100%', borderRadius: '8px',
              width: `${usageRate}%`, transition: 'width 0.5s',
            }} />
          </div>
          <div style={{ fontSize: '11px', color: '#8c8478', marginTop: '6px', textAlign: 'right' }}>
            사용률 {usageRate}%
          </div>
        </div>

        {/* Card 2: 승인 대기 (관리자만) */}
        {isAdmin && (
          <div style={{
            background: '#fff', borderRadius: '16px', padding: '20px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #ece8e1',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>📋</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a1815' }}>승인 대기</span>
              </div>
              <span style={{
                background: pendingApprovals.length > 0 ? '#fef3c7' : '#f0ede6',
                color: pendingApprovals.length > 0 ? '#d97706' : '#8c8478',
                fontSize: '12px', fontWeight: 700,
                padding: '2px 10px', borderRadius: '12px',
              }}>
                {pendingApprovals.length}건
              </span>
            </div>

            {pendingApprovals.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {pendingApprovals.slice(0, 4).map((item, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', background: '#fafaf8', borderRadius: '10px',
                    fontSize: '13px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: typeColors[item.type] || '#9ca3af',
                      }} />
                      <span style={{ fontWeight: 600, color: '#1a1815' }}>{item.name}</span>
                      <span style={{
                        fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
                        background: '#f0ede6', color: '#6b6560',
                      }}>{item.type}</span>
                    </div>
                    <span style={{ fontSize: '11px', color: '#8c8478' }}>{(item.date || '').slice(5)}</span>
                  </div>
                ))}
                {pendingApprovals.length > 4 && (
                  <div style={{ textAlign: 'center', fontSize: '11px', color: '#8c8478', paddingTop: '4px' }}>
                    +{pendingApprovals.length - 4}건 더보기
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '20px', color: '#8c8478', fontSize: '13px' }}>
                ✅ 처리할 건이 없어요
              </div>
            )}
          </div>
        )}

        {/* Card 3: 오늘 휴가자 */}
        <div style={{
          background: '#fff', borderRadius: '16px', padding: '20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #ece8e1',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>☀️</span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a1815' }}>오늘 휴가자</span>
            </div>
            <span style={{ fontSize: '12px', color: '#8c8478' }}>{todayStr}</span>
          </div>

          {todayOff.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {todayOff.map((p, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '8px 10px', background: '#fafaf8', borderRadius: '10px',
                }}>
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '50%',
                    background: `hsl(${i * 80 + 200}, 60%, 75%)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', fontWeight: 700, color: '#fff',
                    flexShrink: 0,
                  }}>
                    {p.name?.[0] || '?'}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#1a1815' }}>{p.name}</div>
                    <div style={{ fontSize: '11px', color: '#8c8478' }}>{p.crew}</div>
                  </div>
                  <span style={{
                    marginLeft: 'auto', fontSize: '11px', padding: '2px 8px',
                    borderRadius: '6px', fontWeight: 600, flexShrink: 0,
                    background: typeColors[p.type] ? `${typeColors[p.type]}15` : '#f0f0f0',
                    color: typeColors[p.type] || '#666',
                  }}>{p.type}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '20px', color: '#8c8478', fontSize: '13px' }}>
              오늘은 모두 출근! 🎉
            </div>
          )}
        </div>
      </div>

      {/* 신청 내역 */}
      <div style={{
        background: '#fff', borderRadius: '16px', padding: '20px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #ece8e1',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>📝</span>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#1a1815' }}>{selectedYear}년 신청 내역</span>
          </div>
          <span style={{ fontSize: '12px', color: '#8c8478' }}>{filteredHistory.length}건</span>
        </div>

        {filteredHistory.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filteredHistory.map((record, i) => {
              const badge = getStatusBadge(record.status);
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 14px', background: '#fafaf8', borderRadius: '12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      background: typeColors[record.type] || '#9ca3af',
                      flexShrink: 0,
                    }} />
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: '#1a1815' }}>{record.type}</span>
                        <span style={{ fontSize: '11px', color: '#8c8478' }}>{record.days}일</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#8c8478', marginTop: '2px' }}>
                        {record.startDate}{record.endDate && record.endDate !== record.startDate ? ` ~ ${record.endDate}` : ''}
                        {record.reason ? ` · ${record.reason}` : ''}
                      </div>
                    </div>
                  </div>
                  <span style={{
                    fontSize: '11px', fontWeight: 600, padding: '3px 10px',
                    borderRadius: '8px', background: badge.bg, color: badge.color,
                    flexShrink: 0,
                  }}>
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '32px', color: '#b0a99d', fontSize: '13px' }}>
            <div style={{ fontSize: '28px', marginBottom: '8px' }}>📄</div>
            신청 내역이 없습니다
          </div>
        )}
      </div>
    </div>
  );
}