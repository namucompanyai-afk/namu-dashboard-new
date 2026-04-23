-- ============================================================
-- Coupang Seller Tools - Margin Module Schema
--
-- 실행 환경: Supabase (PostgreSQL)
-- 원칙:
--   1) 모든 테이블에 user_id FK + RLS → 나중에 멀티 셀러 지원 시 자동 격리
--   2) 금액은 전부 integer (KRW, 원 단위). 소수점 KRW 없음.
--   3) VAT 포함 기준으로 저장 (쿠팡 WING 원본은 VAT 제외 → 파싱 단계에서 ×1.1 변환)
--   4) 엑셀 파일은 monthly re-upload → upsert로 덮어쓰기 (ON CONFLICT DO UPDATE)
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. 노출상품 (Product ID) = 쿠팡 고객이 보는 상품 단위
-- ─────────────────────────────────────────────────────────────
create table if not exists coupang_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  product_id text not null,              -- 노출상품ID (쿠팡 발급)
  name text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, product_id)
);

-- ─────────────────────────────────────────────────────────────
-- 2. 등록상품 (업체상품ID) = 셀러가 WING에 등록한 단위
--    같은 product_id 아래 여러 개면 "동일 상품 분산" 경고
-- ─────────────────────────────────────────────────────────────
create table if not exists coupang_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  listing_id text not null,              -- 업체상품ID
  product_id text not null,              -- 노출상품ID (coupang_products.product_id)
  channel text not null check (channel in ('growth', 'wing')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, listing_id)
);

create index if not exists idx_coupang_listings_product on coupang_listings(user_id, product_id);

-- ─────────────────────────────────────────────────────────────
-- 3. 옵션 = 실판매 최소 단위 (1kg 1개, 1kg 2개 ...)
--    product_id도 denormalize → 그룹 쿼리 한방에
-- ─────────────────────────────────────────────────────────────
create table if not exists coupang_options (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  option_id text not null,               -- 옵션ID
  listing_id text not null,              -- 업체상품ID
  product_id text not null,              -- 노출상품ID (denormalized)
  channel text not null check (channel in ('growth', 'wing')),

  option_name text not null,
  -- 가격은 전부 VAT 포함 기준으로 저장
  selling_price integer not null,
  list_price integer,
  sale_status text,

  -- 마진 계산용 사용자 입력 (엑셀 없음)
  cost_price integer,                    -- 원가 (VAT 포함 기준 통일)

  -- 그로스 정산 엑셀에서 매칭 (wing 옵션이면 null)
  warehousing_fee integer,               -- 입출고비 (VAT 포함)
  shipping_fee integer,                  -- 배송비 (VAT 포함)
  settlement_synced_at timestamptz,

  -- 판매 분석 엑셀에서 매칭
  sales_90d integer,
  revenue_90d integer,
  winner_rate numeric(5,2),              -- 0-100
  sales_synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, option_id)
);

create index if not exists idx_coupang_options_product on coupang_options(user_id, product_id);
create index if not exists idx_coupang_options_listing on coupang_options(user_id, listing_id);
create index if not exists idx_coupang_options_channel on coupang_options(user_id, channel);

-- ─────────────────────────────────────────────────────────────
-- 4. 업로드 이력 (UI에 "2일 전 업로드" 표시용)
-- ─────────────────────────────────────────────────────────────
create table if not exists coupang_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  file_type text not null check (file_type in ('price_inventory', 'settlement', 'sales_insight')),
  file_name text not null,
  row_count integer not null,

  -- 엑셀 원본 백업용 (storage path, 옵션)
  storage_path text,

  uploaded_at timestamptz not null default now()
);

create index if not exists idx_coupang_uploads_user_type on coupang_uploads(user_id, file_type, uploaded_at desc);

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────
alter table coupang_products enable row level security;
alter table coupang_listings enable row level security;
alter table coupang_options  enable row level security;
alter table coupang_uploads  enable row level security;

-- 각 테이블 동일한 owner-only 정책
do $$
declare
  t text;
begin
  foreach t in array array['coupang_products', 'coupang_listings', 'coupang_options', 'coupang_uploads']
  loop
    execute format('drop policy if exists "%1$s_owner_select" on %1$s', t);
    execute format('create policy "%1$s_owner_select" on %1$s for select using (auth.uid() = user_id)', t);

    execute format('drop policy if exists "%1$s_owner_insert" on %1$s', t);
    execute format('create policy "%1$s_owner_insert" on %1$s for insert with check (auth.uid() = user_id)', t);

    execute format('drop policy if exists "%1$s_owner_update" on %1$s', t);
    execute format('create policy "%1$s_owner_update" on %1$s for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);

    execute format('drop policy if exists "%1$s_owner_delete" on %1$s', t);
    execute format('create policy "%1$s_owner_delete" on %1$s for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- updated_at 자동 갱신 트리거
-- ─────────────────────────────────────────────────────────────
create or replace function coupang_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

do $$
declare t text;
begin
  foreach t in array array['coupang_products', 'coupang_listings', 'coupang_options']
  loop
    execute format('drop trigger if exists trg_%1$s_touch on %1$s', t);
    execute format('create trigger trg_%1$s_touch before update on %1$s
                    for each row execute function coupang_touch_updated_at()', t);
  end loop;
end $$;
