// 메인 포털 카드 마스터 정의.
// 사이드바 항목과 1:1 — 사용자가 user_dashboard_pages.page_ids 로 핀한 것만 노출.
// 여기에 없는 id(삭제/예정)는 메인에서 자동 필터된다.

export interface DashboardPage {
  id: string;
  title: string;
  emoji: string;
  href: string;
}

export const DASHBOARD_PAGES: DashboardPage[] = [
  { id: 'sales-dashboard', title: 'Sales Dashboard', emoji: '📊', href: '/sales' },
  { id: 'hr-dashboard', title: 'HR Dashboard', emoji: '👤', href: '/hr' },
  { id: 'leave-apply', title: '연차 신청', emoji: '🌴', href: '/hr/leave/apply' },
  { id: 'team-leave-calendar', title: '팀원 휴가 캘린더', emoji: '📅', href: '/hr/calendar' },
  { id: 'jindopam-order', title: '진도팜 발주', emoji: '🌾', href: '/jindopam/order-work' },
  { id: 'jindopam-settlement', title: '진도팜 정산', emoji: '💰', href: '/jindopam/settlement' },
  { id: 'jindopam-crm', title: 'CRM', emoji: '🤝', href: '/jindopam/crm' },
];

// page_ids 가 없거나 빈 배열일 때 기본 노출.
export const DEFAULT_PAGE_IDS = ['leave-apply', 'team-leave-calendar', 'jindopam-order'];

export const PAGE_BY_ID: Record<string, DashboardPage> = Object.fromEntries(
  DASHBOARD_PAGES.map((p) => [p.id, p]),
);
