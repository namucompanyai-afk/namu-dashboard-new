-- ============================================================
-- 개인별 대시보드 페이지 핀(셋팅) 저장
--
-- 실행 환경: Supabase (PostgreSQL)
-- 용도: 메인 포털에서 사용자가 직접 고른 페이지 카드만 노출.
--
-- 식별자 주의:
--   이 앱은 Supabase Auth 세션이 아니라 localStorage 의 email 기반 identity 를
--   사용한다(연차/HR 은 Apps Script, 대시보드는 anon key). 따라서 coupang_* 처럼
--   auth.uid() = user_id RLS 를 걸면 anon key 로는 접근이 막힌다.
--   → dashboard_data 와 동일하게 RLS 는 켜되 anon/authenticated 에 허용 정책을 둔다.
--   (행 격리는 앱 레벨에서 user_email 키로 수행)
-- ============================================================

create table if not exists user_dashboard_pages (
  user_email text primary key,
  page_ids   jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────
-- RLS — 앱 레벨 email identity 이므로 anon 허용 (dashboard_data 패턴)
-- ─────────────────────────────────────────────────────────────
alter table user_dashboard_pages enable row level security;

drop policy if exists "user_dashboard_pages_all" on user_dashboard_pages;
create policy "user_dashboard_pages_all" on user_dashboard_pages
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- ─────────────────────────────────────────────────────────────
-- updated_at 자동 갱신
-- ─────────────────────────────────────────────────────────────
create or replace function user_dashboard_pages_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_user_dashboard_pages_touch on user_dashboard_pages;
create trigger trg_user_dashboard_pages_touch
  before update on user_dashboard_pages
  for each row execute function user_dashboard_pages_touch();
