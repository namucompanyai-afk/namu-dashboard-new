'use client';

import { useState, useEffect } from 'react';

interface Employee {
  이름: string;
  이메일: string;
  입사일: string;
  총연차: number;
  사용연차: number;
  잔여연차: number;
  비밀번호: string;
}

export default function UsersPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Employee>>({});
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState<Partial<Employee>>({
    이름: '',
    이메일: '',
    입사일: '',
    비밀번호: '1234',
  });

  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/apps-script?action=listEmployees');
      const data = await res.json();
      
      if (data.ok) {
        setEmployees(data.items || []);
      }
    } catch (err) {
      console.error('직원 조회 실패:', err);
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (emp: Employee) => {
    setEditingEmail(emp.이메일);
    setEditForm(emp);
  };

  const cancelEdit = () => {
    setEditingEmail(null);
    setEditForm({});
  };

  const saveEdit = async () => {
    try {
      const res = await fetch('/api/apps-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateEmployee',
          payload: editForm,
        }),
      });

      const data = await res.json();

      if (data.ok) {
        alert('저장되었습니다.');
        fetchEmployees();
        cancelEdit();
      } else {
        alert('저장 실패: ' + data.error);
      }
    } catch (err) {
      console.error('저장 에러:', err);
      alert('저장 중 오류가 발생했습니다.');
    }
  };

  const handleAddEmployee = async () => {
    if (!addForm.이름 || !addForm.이메일 || !addForm.입사일) {
      alert('이름, 이메일, 입사일을 모두 입력해주세요.');
      return;
    }

    try {
      const res = await fetch('/api/apps-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addEmployee',
          payload: addForm,
        }),
      });

      const data = await res.json();

      if (data.ok) {
        alert('직원이 추가되었습니다.');
        setShowAddModal(false);
        setAddForm({
          이름: '',
          이메일: '',
          입사일: '',
          비밀번호: '1234',
        });
        fetchEmployees();
      } else {
        alert('추가 실패: ' + data.error);
      }
    } catch (err) {
      console.error('추가 에러:', err);
      alert('추가 중 오류가 발생했습니다.');
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f3ef]">
      <div className="bg-white border-b border-gray-200 px-8 py-6">
        <h1 className="text-2xl font-semibold text-gray-900">가입자 관리</h1>
        <p className="text-sm text-gray-500 mt-1">
          직원 정보 및 연차 수동 조정
        </p>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">전체 직원</h3>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              + 신규 직원 추가
            </button>
          </div>

          {loading ? (
            <div className="p-12 text-center text-gray-500">
              로딩 중...
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">이름</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">이메일</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">입사일</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">총연차</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">사용</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">잔여</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">비밀번호</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {employees.map((emp, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      {editingEmail === emp.이메일 ? (
                        <>
                          <td className="px-6 py-4">
                            <input
                              type="text"
                              value={editForm.이름 || ''}
                              onChange={(e) => setEditForm({...editForm, 이름: e.target.value})}
                              className="border border-gray-300 rounded px-2 py-1 w-full"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <input
                              type="email"
                              value={editForm.이메일 || ''}
                              onChange={(e) => setEditForm({...editForm, 이메일: e.target.value})}
                              className="border border-gray-300 rounded px-2 py-1 w-full"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <input
                              type="date"
                              value={editForm.입사일 || ''}
                              onChange={(e) => setEditForm({...editForm, 입사일: e.target.value})}
                              className="border border-gray-300 rounded px-2 py-1 w-full"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <input
                              type="number"
                              value={editForm.총연차 || 0}
                              onChange={(e) => setEditForm({...editForm, 총연차: Number(e.target.value)})}
                              className="border border-gray-300 rounded px-2 py-1 w-20"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <input
                              type="number"
                              value={editForm.사용연차 || 0}
                              onChange={(e) => setEditForm({...editForm, 사용연차: Number(e.target.value)})}
                              className="border border-gray-300 rounded px-2 py-1 w-20"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <input
                              type="number"
                              value={editForm.잔여연차 || 0}
                              onChange={(e) => setEditForm({...editForm, 잔여연차: Number(e.target.value)})}
                              className="border border-gray-300 rounded px-2 py-1 w-20"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <input
                              type="text"
                              value={editForm.비밀번호 || ''}
                              onChange={(e) => setEditForm({...editForm, 비밀번호: e.target.value})}
                              className="border border-gray-300 rounded px-2 py-1 w-24"
                            />
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex gap-2">
                              <button
                                onClick={saveEdit}
                                className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
                              >
                                저장
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700"
                              >
                                취소
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-6 py-4 font-medium text-gray-900">{emp.이름}</td>
                          <td className="px-6 py-4 text-gray-600">{emp.이메일}</td>
                          <td className="px-6 py-4 text-gray-600">{emp.입사일}</td>
                          <td className="px-6 py-4 text-gray-900">{emp.총연차}일</td>
                          <td className="px-6 py-4 text-orange-600">{emp.사용연차}일</td>
                          <td className="px-6 py-4 text-green-600">{emp.잔여연차}일</td>
                          <td className="px-6 py-4 font-mono text-sm text-gray-600">{emp.비밀번호}</td>
                          <td className="px-6 py-4">
                            <button
                              onClick={() => startEdit(emp)}
                              className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
                            >
                              수정
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-xl font-semibold text-gray-900 mb-4">신규 직원 추가</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">이름</label>
                <input
                  type="text"
                  value={addForm.이름 || ''}
                  onChange={(e) => setAddForm({...addForm, 이름: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="홍길동"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
                <input
                  type="email"
                  value={addForm.이메일 || ''}
                  onChange={(e) => setAddForm({...addForm, 이메일: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="example@company.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">입사일</label>
                <input
                  type="date"
                  value={addForm.입사일 || ''}
                  onChange={(e) => setAddForm({...addForm, 입사일: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">초기 비밀번호</label>
                <input
                  type="text"
                  value={addForm.비밀번호 || ''}
                  onChange={(e) => setAddForm({...addForm, 비밀번호: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="1234"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleAddEmployee}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
              >
                추가
              </button>
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}