-- ============================================================
-- 네이버 쇼핑 키워드 순위 v2 — 매회 전체 기록 (건별, 리셋 없음)
--
-- 실행 환경: Supabase (PostgreSQL)
-- 흐름: scripts/naver-rank-watch-v2/run.ts 가 매일 08:55(morning)·12:30(noon) 키워드마다 1페이지를 읽어
--   나무_마스터 '네이버 상품' 탭의 모든 상품(ON/OFF 무관)과 매칭한 결과를 매회 전부 insert 한다(덮어쓰기 없음).
--   한 키워드에 우리 상품이 없거나 수집 자체가 실패하면 product_no='' 요약 행 1개를 남겨
--   "수집했는데 없음"과 "애초에 안 돌았음(행 자체가 없음)"을 구분한다.
--
-- v1(naver_rank_YYYY-MM-DD, dashboard_data 블롭)과 다른 점: v1은 키워드당 상품 1개만, 하루 스냅샷 1개를 덮어썼다.
--   v2는 상품 여러 개 × 매회 보존이 필요해서 전용 테이블로 뗐다(2026-10-22, 네이버 주문 테이블과 같은 이유).
--
-- is_tracked: 수집 당시 그 상품의 '네이버 상품' 탭 추적 ON/OFF 값을 그대로 찍어둔 것(snapshot) —
--   나중에 ON/OFF가 바뀌어도 그날 기록은 그대로 남는다. 슬랙·보고서는 이 값이 true인 것만 보여준다.
-- ============================================================

create table if not exists naver_rank_history (
  id             uuid primary key default gen_random_uuid(),

  collected_date date not null,                 -- KST 수집일(YYYY-MM-DD) — 어제/오늘 대비 키
  collected_at   timestamptz not null,           -- 실제 수집 시각
  run_slot       text not null check (run_slot in ('morning', 'noon')),
  keyword        text not null,

  product_no     text not null default '',       -- 스마트스토어 상품번호. '' = 이 키워드에 우리 상품 없음(요약 행)
  mid            text,                            -- 매칭에 쓴 네이버쇼핑 MID (product_no 있을 때만)
  alias          text,                            -- 수집 당시 별칭 snapshot
  is_tracked     boolean not null default false,  -- 수집 당시 추적 ON/OFF snapshot

  rank           integer,                         -- 광고 제외 순번. null = 1페이지 밖(또는 광고로만 노출)
  is_ad          boolean not null default false,  -- 이 노출이 광고 슬롯이었는지
  page_total     integer,                         -- 그 페이지에서 읽은 광고 제외 상품 수(순위의 분모, 보통 ≤40)

  status         text not null default 'ok',      -- ok | captcha | blocked | error — 키워드 수집 자체의 상태
  created_at     timestamptz not null default now(),

  unique (collected_date, run_slot, keyword, product_no)
);

create index if not exists idx_naver_rank_history_date_slot
  on naver_rank_history (collected_date, run_slot);
create index if not exists idx_naver_rank_history_keyword
  on naver_rank_history (keyword);

-- ─────────────────────────────────────────────────────────────
-- RLS — naver_product_orders(004)와 같은 이유로 anon 허용 정책 없음(서비스 키로만 읽고 쓴다)
-- ─────────────────────────────────────────────────────────────
alter table naver_rank_history enable row level security;
