-- ============================================================
-- 스마트스토어 고객분석 — 상품 인구통계 원본 저장
--
-- 실행 환경: Supabase (PostgreSQL)
-- 흐름: 엑셀 업로드 → 파싱 → 같은 period 행 delete 후 insert(교체).
--       페이지 로드 시 조회 → 클라이언트 집계.
--
-- 식별자 주의 (002 와 동일):
--   이 앱은 Supabase Auth 가 아니라 localStorage email identity 를 쓴다.
--   → dashboard_data / user_dashboard_pages 처럼 RLS 는 켜되 anon 허용.
--
-- 컬럼 주의:
--   gender / age_band 는 원본 한글값("여성","41~45") 그대로 저장(컬럼명만 영문).
--   product_id 는 반드시 text — 숫자형이면 선행 0/대형 ID 매칭이 깨진다.
-- ============================================================

create table if not exists ss_customer_demographics (
  id            uuid primary key default gen_random_uuid(),
  user_email    text not null,
  period        text not null,          -- 예: "2025-12_2026-05"

  cat_l         text,                   -- 상품카테고리(대)
  cat_m         text,                   -- 상품카테고리(중)
  cat_s         text,                   -- 상품카테고리(소)
  cat_d         text,                   -- 상품카테고리(세)
  product_name  text,
  product_id    text,                   -- 숫자형 금지

  gender        text,                   -- 원본 한글값 ("여성" 등)
  age_band      text,                   -- 원본 한글값 ("41~45" 등)

  pay_amount    numeric default 0,
  pay_count     integer default 0,
  pay_qty       integer default 0,
  refund_amount numeric default 0,
  refund_count  integer default 0,
  refund_qty    integer default 0,

  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists idx_ss_demo_email_period
  on ss_customer_demographics (user_email, period);

-- ─────────────────────────────────────────────────────────────
-- RLS — 앱 레벨 email identity 이므로 anon 허용 (002 패턴)
-- ─────────────────────────────────────────────────────────────
alter table ss_customer_demographics enable row level security;

drop policy if exists "ss_customer_demographics_all" on ss_customer_demographics;
create policy "ss_customer_demographics_all" on ss_customer_demographics
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- ─────────────────────────────────────────────────────────────
-- updated_at 자동 갱신
-- ─────────────────────────────────────────────────────────────
create or replace function ss_customer_demographics_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_ss_customer_demographics_touch on ss_customer_demographics;
create trigger trg_ss_customer_demographics_touch
  before update on ss_customer_demographics
  for each row execute function ss_customer_demographics_touch();
