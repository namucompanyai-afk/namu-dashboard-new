-- ============================================================
-- 네이버 커머스 API — 상품주문 원본 저장 (건별, 상태 추적용)
--
-- 실행 환경: Supabase (PostgreSQL)
-- 흐름: scripts/naver-sales-collect/run.ts 가 매일 08:42(16GB) 어제 결제완료 상품주문을
--       productOrderId 기준 upsert. 취소·반품으로 상태가 나중에 바뀌면 같은 행이 업데이트된다.
-- 집계(건수·합계·취소 건수·상품 Top3)는 이 표를 직접 날짜로 읽어 그때 계산한다(별도 요약 표 없음) —
--   아침 보고서(scripts/coupang-morning-report/run.ts)가 담당.
--
-- 응답 필드명: 2026-10-20 실데이터(101건)로 확인됨(브레인, 2026-10-22). product_order_status·claim_status 는
--   원본 값 그대로 저장(enum 변환 안 함) — 확인된 값: DELIVERED·DELIVERING·CANCELED·PURCHASE_DECIDED(상태),
--   CANCEL·CANCEL_DONE(클레임, 없으면 null). 그 외 상태값은 실제로 나오면 추가될 수 있음.
--
-- 개인정보 주의: raw_safe 는 "원본 그대로"가 아니다 — 수취인명·전화·주소(delivery 블록 전체, order.ordererName·
--   ordererTel·ordererId, productOrder.shippingAddress·takingAddress)는 전부 빼고 저장한다
--   (lib/naver/salesWatch.ts 의 safeOrder·safeProductOrder). 16GB 가 자동 로그인·FileVault 꺼짐이라
--   기계를 손에 넣으면 그대로 노출되는 위험(SETUP.md 숙제 항목)까지 고려한 설계.
-- ============================================================

create table if not exists naver_product_orders (
  id                     uuid primary key default gen_random_uuid(),

  product_order_id       text not null unique,   -- upsert 키
  order_id               text,
  product_id             text,
  product_name           text,
  product_option         text,
  quantity               integer,
  total_payment_amount   numeric,
  product_order_status   text,                   -- 원본 값 그대로 (DELIVERED·DELIVERING·CANCELED·PURCHASE_DECIDED 등)
  claim_status            text,                   -- 원본 값 그대로 (CANCEL·CANCEL_DONE 등), 클레임 없으면 null
  payment_date           timestamptz,             -- '결제 기준' 집계 키 (order.paymentDate)

  -- 정산 기준 칸(2026-10-22 추가) — 보고서엔 아직 안 씀, 나중에 "결제 기준 vs 정산 기준" 비교용
  expected_settlement_amount        numeric,
  sale_commission                   numeric,
  payment_commission                numeric,
  channel_commission                numeric,
  knowledge_shopping_commission     numeric,      -- knowledgeShoppingSellingInterlockCommission
  seller_burden_store_discount_amount numeric,

  raw_safe               jsonb,                   -- 개인정보 뺀 order·productOrder 나머지 칸 (위 주의 참고, delivery 블록 자체는 없음)

  collected_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_naver_product_orders_payment_date
  on naver_product_orders (payment_date);

-- ─────────────────────────────────────────────────────────────
-- RLS — 서비스 키(16GB 크롤링 맥)로만 쓰고 읽는다. 002/003 의 anon 허용 패턴과 달리
-- 이 표는 사람 로그인 화면에서 직접 쓰지 않으므로 anon 허용 정책을 넣지 않는다.
-- (대시보드에서 조회 화면을 붙이게 되면 그때 필요한 정책을 추가)
-- ─────────────────────────────────────────────────────────────
alter table naver_product_orders enable row level security;

-- ─────────────────────────────────────────────────────────────
-- updated_at 자동 갱신 (003 과 동일 패턴)
-- ─────────────────────────────────────────────────────────────
create or replace function naver_product_orders_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_naver_product_orders_touch on naver_product_orders;
create trigger trg_naver_product_orders_touch
  before update on naver_product_orders
  for each row execute function naver_product_orders_touch();
