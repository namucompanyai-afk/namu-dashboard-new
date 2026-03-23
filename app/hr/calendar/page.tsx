'use client';

export default function CalendarPage() {
  const calendarId = 'de97b6f14ad2e1a92c472b62f0c0daf85dab993071c9eb7ca9af46968ac5e163@group.calendar.google.com';
  
  const calendarUrl = 'https://calendar.google.com/calendar/embed?src=' + 
    encodeURIComponent(calendarId) + 
    '&ctz=Asia/Seoul&mode=MONTH&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=0&showCalendars=0&showTz=0&hl=ko';

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">팀 휴가 캘린더</h1>
      <p className="text-sm text-gray-500 mt-1">전체 직원의 휴가 일정을 확인할 수 있습니다</p>

      <div className="mt-6 bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <iframe 
          src={calendarUrl} 
          className="w-full h-[500px] lg:h-[700px]"
          style={{ border: 0 }}
        ></iframe>
      </div>
    </div>
  );
}