# 16GB 크롤링 맥 — 월요일 쿠팡 광고 보고서 자동 받기 세팅 (형이 손으로 할 순서)

- 작성 2026-10-20 (대클). 대상: 16GB 맥북(계정 namucompany.ai, ~/crawler).
- 하는 일: 매주 월요일 09:00 에 16GB 맥이 스스로 ① 크롬을 켜고 ② 클로드가 크롬 확장으로 광고센터에서 보고서 2개(지난주 월~일 · 최근 30일)를 받아 ③ ~/crawler/out/오늘날짜/ 에 두고 ④ 24GB 와 똑같은 업로드 규칙으로 대시보드 저장소(Supabase)에 올린다.
- 24GB 의 기존 자동 업로드(~/Downloads 감시)는 그대로 둔다. 바뀌는 건 없다.

## 준비물
1. 16GB 맥 + 24GB 맥이 같은 와이파이에 있을 것 (키 보내기·파일 가져오기에 씀)
2. 쿠팡 윙 비밀번호 (계정 namucompanyai, 추가계정)
3. 구글 비밀번호 (namucompany.ai@gmail.com)
4. 16GB 맥 로그인 비밀번호 (키 보낼 때 한 번 침)

---

## 1. 크롬 로그인 3곳 (16GB 에서)
1. 크롬을 연다. 구글 계정 namucompany.ai@gmail.com 로 로그인한다.
2. 새 탭에서 wing.coupang.com → namucompanyai 로 로그인. "로그인 상태 유지" 가 있으면 체크.
3. 새 탭에서 advertising.coupang.com → '마켓플레이스 판매자 로그인하기' 누름 → 광고센터가 열리면 됨.
   - 왼쪽 메뉴 '보고서' → 광고 보고서 화면까지 한 번 들어가 본다. (주소가 …/marketing-reporting/billboard/reports/pa 로 끝남)
4. 크롬 설정 → 다운로드 → "다운로드 전에 각 파일의 저장 위치 확인" 이 **꺼져** 있는지 본다 (보통 꺼져 있음). 저장 위치는 기본 '다운로드' 폴더 그대로.

> 윙 로그인은 며칠~몇 주 지나면 풀린다. 풀리면 월요일 기록에 "형, 윙 로그인 필요" 가 남고 그 주는 못 받는다. 16GB 에서 2·3번만 다시 하면 된다.

## 2. 클로드 크롬 확장 (16GB 에서)
1. 크롬 웹스토어에서 "Claude in Chrome" 확장을 추가한다.
2. 확장 아이콘을 눌러 Claude 계정(Max, 16GB 터미널 클로드와 같은 계정)으로 로그인한다.
3. 터미널을 열고 아래를 친다. 연결됐다는 표시가 나오면 `/exit` 로 나온다.

        cd ~/crawler && claude --chrome
        /chrome

> 10/20 인수인계에는 "16GB 에 크롬 확장 설치 안 함" 이라고 적혀 있었음. 이 작업이 그걸 뒤집는 결정이라 형 확인 필요. (쿠팡이 다른 자동화를 다 막아서 크롬 확장이 유일한 통로)

## 3. 원격 로그인 켜기 (16GB 에서)
1. 시스템 설정 → 일반 → 공유 → **원격 로그인** 켬.
2. 터미널에서 `hostname` 을 쳐서 이름을 적어 둔다. (예: namucompanyaiui-MacBookAir → 아래에서 `<16GB이름>` 자리에 넣음)
3. 24GB 터미널에서 확인: `ssh namucompany.ai@<16GB이름>.local echo ok` → 비밀번호 치고 `ok` 가 나오면 됨.

## 4. 저장소 받기 (16GB 터미널에서, 한 번만)
업로드 스크립트가 대시보드 코드(엑셀 읽기·마진 계산)를 같이 써서, 필요한 폴더만 부분으로 받는다. 몇 분 걸린다.

    git clone --filter=blob:none --no-checkout https://github.com/namucompanyai-afk/namu-dashboard-new.git ~/crawler/dashboard
    cd ~/crawler/dashboard
    git sparse-checkout init --cone
    git sparse-checkout set scripts/ad-weekly-upload scripts/crawler-16gb lib
    git checkout main
    npm ci
    chmod +x scripts/crawler-16gb/run-weekly.sh

확인: `ls ~/crawler/dashboard/scripts/crawler-16gb` 에 SETUP.md · run-weekly.sh 가 보이면 됨.

> 16GB CLAUDE.md 규칙 "대시보드 저장소 두지 않음" 과 **충돌**. 코드 일부만 ~/crawler 안에 두는 걸로 했음 (손익 자료 없음, 공개 저장소). 형이 싫으면 대안은 24GB 가 파일만 가져와 올리는 방식 — 그건 16GB 가 24GB 를 깨워야 해서 더 복잡함.
> 나중에 코드가 바뀌면 16GB 에서 `cd ~/crawler/dashboard && git pull && npm ci` 한 번.

## 5. 키 넣기 (24GB 터미널에서 한 줄 — 값은 화면에 안 보임)
24GB 에 이미 있는 키 4개를 16GB ~/crawler/.env 로 그대로 보낸다. 16GB 비밀번호를 한 번 친다.

    grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|GOOGLE_SERVICE_ACCOUNT|AD_LIVE_30D_SAVE)=' ~/Documents/GitHub/namu-dashboard-new/.env.local | ssh namucompany.ai@<16GB이름>.local 'umask 077; cat > ~/crawler/.env'

확인 (16GB 또는 24GB 아무 데서나): `ssh namucompany.ai@<16GB이름>.local 'grep -c = ~/crawler/.env'` → **4** 가 나오면 됨.

쓰는 키 (업로드 스크립트가 실제로 읽는 것만):
| 이름 | 용도 |
|---|---|
| SUPABASE_URL | 대시보드 저장소 주소 |
| SUPABASE_SERVICE_ROLE_KEY | 저장소에 쓰는 서버 키 |
| GOOGLE_SERVICE_ACCOUNT | 나무_마스터 시트 읽기 (마진 계산) |
| AD_LIVE_30D_SAVE | on 이면 30일 파일도 저장 |

## 6. 첫 시험 — 10/12~10/18 주간 파일 받아서 24GB 것과 대조 (10/26 일요일까지 해야 "지난주" 가 10/12~18 임)
1. 16GB 터미널 (보고서만 받고 저장소에는 안 올림):

        ~/crawler/dashboard/scripts/crawler-16gb/run-weekly.sh --no-upload

   끝나면 `cat ~/crawler/logs/run-weekly.log` 에 ✅ 파일명 2개와 행 수가 보여야 함. "형, 윙 로그인 필요" 가 보이면 1번 다시.
2. 24GB 터미널 (16GB 파일을 가져와 24GB 에 받아 둔 파일과 대조 — 일치/불일치만 나옴, 금액 안 나옴):

        mkdir -p ~/namu-brain/raw/inbox/ad_report_16gb && cd ~/Documents/GitHub/namu-dashboard-new && scp 'namucompany.ai@<16GB이름>.local:crawler/out/*/A00993784_pa_total_campaign_20261012_20261018.xlsx' ~/namu-brain/raw/inbox/ad_report_16gb/ && node scripts/crawler-16gb/ad-report-check.mjs ~/namu-brain/raw/inbox/ad_report_16gb/A00993784_pa_total_campaign_20261012_20261018.xlsx ~/Downloads/A00993784_pa_total_campaign_20261012_20261018.xlsx

   기대: 행 수 · 캠페인 수 · 광고비 합계 · 열 이름 **4개 다 일치**. (14일 전환매출은 받은 날에 따라 바뀌어서 비교 안 함)
   - 하나라도 불일치면 대클에 로그(~/crawler/logs/ad-report-날짜.log)를 보여주고 멈춤. 파일명이 A00993784 로 시작 안 하면 추가계정 업체코드 문제 — 그때는 업로드 규칙을 고쳐야 함.

## 7. 월요일 자동 실행 등록 (16GB 에서, 6번 통과하고 형 OK 뒤)

    cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-ad-report.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-ad-report.plist
    launchctl list | grep crawler-ad-report

마지막 줄에 이름이 보이면 등록 끝. 처리 기록(~/.namu-ad-upload/processed.json)은 없으면 첫 실행 때 빈 기록으로 자동 생성되니 따로 초기화할 것 없음. 6번 시험 때 받은 파일은 첫 월요일 실행에서 업로드 대상이 아님 (기간이 다른 새 파일만 올라감). 끄려면 `launchctl bootout gui/$(id -u)/com.namucompany.crawler-ad-report`.
업로드 처리 기록은 16GB 의 ~/.namu-ad-upload/processed.json (24GB 와 따로). 같은 주를 24GB 에서도 받으면 두 번 올라가지만 같은 내용이면 그냥 교체돼서 해 없음.

## 8. 매주 확인하는 법 (24GB 에서 한 줄)

    ssh namucompany.ai@<16GB이름>.local 'tail -n 12 crawler/logs/run-weekly.log'

✅ 파일 2개 + "✅ 업로드 종료 코드 0" 이면 정상. ❌ 가 있으면 그 줄 이유대로.

---

## 이 자동화가 틀리는 경우 (확률·대응)
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 윙 로그인 풀림 | **있음** (몇 주에 한 번) | "형, 윙 로그인 필요" 기록, 그 주 파일 없음 | 16GB 크롬에서 윙 재로그인 → `run-weekly.sh` 손으로 한 번 |
| 광고센터 화면이 바뀜 (버튼 이름·위치) | 낮음 | 클로드가 폼을 못 찾아 ❌ | 지시문(jobs/ad-report-download.md) 손질 |
| 보고서 생성이 5분 넘음 | 낮음 | ❌ 후 종료 | 손으로 다시 실행 |
| 맥이 꺼져 있음 (정전 뒤 전원 안 들어옴) | 낮음 | 그 주 건너뜀. 잠자기였으면 깨면서 실행 | 켜고 손으로 실행 |
| 받은 파일명이 규칙과 다름 (추가계정 업체코드) | 첫 시험에서 판명 | ❌, 업로드 안 함 | 업로드 규칙 수정 (대클) |
| Claude 로그인 만료 | 낮음 | 클로드 종료 코드 0 아님, 파일 없음 | 16GB 에서 `claude` 한 번 띄워 재로그인 |
| 크롬이 안 떠 있거나 확장이 끊김 | 낮음 | 도구 없음으로 ❌ | 크롬 열고 확장 아이콘 확인 |
| 하루 10회 접근 제한 | 지시문으로만 막음 (강제 아님) | 클로드가 세다가 멈춤 | 로그 확인 |

손익 숫자는 어디에도 안 찍힌다 (행 수·열 이름·파일명만). 받은 결과를 24GB namu-brain inbox 로 자동으로 보내는 건 아직 미정 — 지금은 8번처럼 ssh 로 본다.

---

# 2번째 작업 — 매일 08:45 윙 '쿠팡상품정보' 엑셀 받기 → 결합 감시 매일 슬랙 (2026-10-21)

- 하는 일: 16GB 가 매일 08:45 윙(상품 조회/수정 > 엑셀 다운로드 > 쿠팡상품정보)에서 Coupang_detailinfo_YYMMDD.xlsx 를 받아 ~/crawler/out/오늘/ 에 두고, 24GB 와 같은 결합 감시 코드(scripts/coupang-catalog-watch)로 어제와 비교 → Supabase 저장 → 슬랙 #쿠팡-결합 (Watchman).
- 24GB 결합 감시(09:30·Downloads 감시)는 그대로 둔다. 같은 날짜가 Supabase 에 이미 있으면 어느 쪽이든 건너뛰어 두 번 안 올라간다.
- 파일을 못 받은 날(윙 로그인 풀림 등)은 #쿠팡-결합 에 "오늘 윙 파일 없음 — 16GB 윙 로그인 필요" 1줄. 연속으로 못 받아도 첫날만 보내고, 다시 받으면 초기화.

## 형이 할 것: 없음 (윙 로그인이 풀렸을 때 16GB 크롬에서 다시 로그인하는 것만)

## 브레인이 SSH 로 할 것 (16GB)
1. 저장소에 결합 감시 코드 추가: `cd ~/crawler/dashboard && git pull && git sparse-checkout add scripts/coupang-catalog-watch`
2. 16GB ~/crawler/.env 에 키 1개 추가: `SLACK_REVIEW_WEBHOOK_URL` (24GB .env.local 에서 그 줄만 — 5번과 같은 방식으로 `>>` 덧붙이기)
3. 시험 (Supabase·슬랙 없이 받기 + 로컬 검증만): `~/crawler/dashboard/scripts/crawler-16gb/run-daily-catalog.sh --no-send` → `tail -8 ~/crawler/logs/run-daily.log` 에 ✅ 파일명·옵션 행·노출상품 수
4. 24GB 와 대조 (24GB 터미널, 같은 날짜 파일이 24GB ~/Downloads 에 있을 때. 없으면 가장 최근 파일과 비교 — 그 사이 변동만큼 불일치가 정상):

        mkdir -p ~/namu-brain/raw/inbox/wing_catalog_16gb && cd ~/Documents/GitHub/namu-dashboard-new && scp 'namucompany.ai@<16GB이름>.local:crawler/out/*/Coupang_detailinfo_*.xlsx' ~/namu-brain/raw/inbox/wing_catalog_16gb/ && npx tsx scripts/crawler-16gb/catalog-check.ts ~/namu-brain/raw/inbox/wing_catalog_16gb/Coupang_detailinfo_<YYMMDD>.xlsx ~/Downloads/Coupang_detailinfo_<YYMMDD>.xlsx

   기대: 옵션 행 수·노출상품 수·옵션ID 집합·노출상품ID 집합 4개 일치 (가격·손익 숫자 안 나옴)
5. 등록 (대표 OK 뒤):

        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-wing-catalog.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-wing-catalog.plist

6. 매일 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 8 crawler/logs/run-daily.log'`

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 윙 로그인 풀림 | **있음** | 파일 없음 → 슬랙 1줄(첫날만), 그날 비교 없음 | 16GB 크롬 재로그인 → 스크립트 손으로 1번 |
| 윙 엑셀 다운로드 화면이 바뀜 (버튼 이름·요청 목록 방식) | 낮음 | 클로드가 못 찾아 ❌ → 슬랙 "다운로드 실패" | 지시문(jobs/wing-catalog-download.md) 손질 |
| 파일명이 Coupang_detailinfo_YYMMDD 가 아님 (추가계정 차이) | 첫 시험에서 판명 | ❌, 감시 안 돌아감 | FILE_RE 수정 |
| 24GB 가 같은 날 먼저 올림 (대표 수동) | 가끔 | 16GB 쪽 "건너뜀" 기록, 슬랙은 24GB 것 1번만 | 정상 |
| 윙이 어제 파일 그대로를 줌 (반영 지연) | 낮음 | 변동 0으로 보고 | 정상 (다음 날 잡힘) |
| 맥 꺼짐·크롬 안 뜸·Claude 로그인 만료 | 낮음 | 파일 없음 → 슬랙 1줄 | 켜고 손으로 실행 |

---

# 3번째 작업 — 매일 08:00 쿠팡 상품 페이지 순회 → 시트 기준가 대조 → 슬랙 (2026-10-21)

- 하는 일: 16GB 가 매일 08:00 나무_마스터 마진계산에서 쿠팡 1P·3P 노출상품ID를 뽑아(약 53~80페이지) 크롬 확장으로 한 페이지씩(3~5초 간격) 읽고, 페이지 **일반 판매가**를 시트 **AE열 '쿠팡 소비자가(기준)'** 과 대조 → Supabase `coupang_page_YYYY-MM-DD` 저장 → 슬랙 #쿠팡-결합 1장(시트와 다른 옵션·어제와 달라진 가격·품절·후기 급감·미등록·못 읽은 페이지). 마진·손익 숫자는 슬랙에 안 넣음.
- 08:00 인 이유: 페이지 수 × (로드 4초 + 읽기)로 30~40분 걸릴 수 있어 08:45 윙 엑셀 작업과 09:00 전에 끝내려고. 크롬 확장은 한 번에 클로드 세션 하나만 쓰도록 세 작업이 잠금을 공유함(겹치면 순서대로).
- 클로드 세션은 6페이지씩 묶음으로 나눠 돌림(한 세션이 페이지를 많이 읽으면 기억이 넘침). 묶음 하나에서 '차단' 화면이 보이면 그날 나머지는 안 돌리고 "못 읽음 N/N" 으로 보고.

## 형이 할 것
1. 나무_마스터 마진계산 **AE열**에 쿠팡 소비자가(숫자만) — 3P 는 채워짐(10/21). **1P 행은 W열 노출ID와 AE 둘 다 비어 있어 아직 대상 0** → 1P 를 보려면 1P 행에 W(노출상품ID)·AE 를 채워야 함.
2. 그 외 없음 (브레인이 SSH 로 설치·시험).

## 브레인이 SSH 로 할 것 (16GB)
1. `cd ~/crawler/dashboard && git pull && git sparse-checkout add scripts/coupang-page-watch` (lib 는 이미 있음)
2. 시험 — 앞 10페이지만, Supabase·슬랙 없이: `~/crawler/dashboard/scripts/crawler-16gb/run-daily-page.sh --no-send --limit 10` → `tail -6 ~/crawler/logs/run-page.log` 에 "묶음 1 ✅·묶음 2 ✅" 와 "대조 검증 실행". 슬랙 문안은 `~/crawler/logs/page-price-날짜.log` 끝에. 결과 JSON 은 `~/crawler/out/날짜/page_prices_batch_01.json`.
   - 볼 것: 읽은 페이지 수(10/10 이면 차단 없음), 옵션에 oid(vendorItemId)가 잡히는지, 옵션명이 시트 AD 와 맞아 "못 찾음" 이 0인지, 와우가가 로그인 없이 보이는지
3. 전체 시험 1회: `run-daily-page.sh --no-send` (전체 페이지, 30~40분) → 차단 0 확인
4. 등록 (대표 OK 뒤):

        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-page-price.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-page-price.plist

5. 매일 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 6 crawler/logs/run-page.log'`

## 조정값 (lib/coupang/pageWatch.ts 상수)
- PRICE_DIFF_MIN_PCT = 0 (1원이라도 다르면 전부. 나중에 % 로 올릴 수 있음)
- REVIEW_DROP_PCT = 20 · REVIEW_DROP_MIN = 20 (후기 급감)
- 묶음 크기: run-daily-page.sh 의 BATCH=6

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 쿠팡이 차단 (매일 60~80페이지 연속은 미검증) | 낮음 (10/19 10페이지 0건) | 그날 "못 읽음 N/N", 남은 묶음 중단 | 첫 2주 관찰, 묶음 간격·페이지 간격 늘림 |
| 옵션 표기가 상품마다 달라 시트와 못 맞춤 | **있음** (향진주 사례) | "못 찾은 옵션 N건" 줄에 나옴, 가격 비교 빠짐 | 시트 AD 쿠팡옵션명을 페이지 표기와 맞추거나 매칭 규칙 보정 |
| 클로드가 가격을 잘못 읽음 (와우가·정가를 일반가로) | 있음 (상품별) | 가짜 "시트와 다름" | 해당 상품 결과 JSON 보고 지시문 보정 |
| 페이지에 안 보이는 할인 (카드·장바구니 쿠폰) | — | 못 잡음 | 한계로 표기 |
| 하루 1회 이후 가격 변동 | — | 다음 날 잡힘 | 낮에 손으로 1회 더 실행 가능 |
| 1P 행 W·AE 비어 있음 | 지금 상태 | 1P 페이지 대상 0 | 시트에 채우면 자동 포함 |
| 시트 AE 빈 칸 | 가끔 | 그 옵션은 "기준가 없음" 줄, 비교 안 함 | AE 채움 |
| 어제 기록 없음 (첫날·전날 실패) | 가끔 | "어제와 달라짐·언제부터" 없이 시트 대조만 | 정상 |
| 크롬 확장 끊김·Claude 로그인 만료 | 낮음 | 묶음 ❌, "못 읽음 N/N" | 16GB 에서 확인 |

---

# 4번째 작업 — 월요일 09:10 서플라이어허브 '판매 분석' export 자동 다운로드 (2026-10-21)

- 하는 일: 16GB 가 허브 > 애널리틱스 > 판매 분석 화면을 기간 주소로 **한 번** 열고 '엑셀 다운로드' → `A00993784_SALES_ANALYSIS_BY_PRODUCT_YYYYMMDDhhmmss.csv` 를 ~/crawler/out/오늘/ 에 두고(파일명에 기간이 없어서 옆에 `hub_sales_시작_끝.period.json` 메모) 슬랙 #쿠팡-결합 에 "받음 — N행" 1줄. 매출 숫자는 안 찍음.
- 1차 범위: **파일만 받음.** 수집기(namu-ingest)는 아직 코드가 없어서, 24GB `~/NamuData/sales_1p_weekly/` 로는 브레인이 가져감(아래 4번). 대시보드 1P 손익 업로드(onePSales 파서)는 그 파일을 그대로 씀.
- 차단 주의: 허브는 10/19 에 12회 연속 호출 뒤 Access Denied 가 났음. 실행당 허브 이동 5회 이내, 새로고침 반복 금지, 차단 보이면 즉시 중단(지시문에 박음). 막히면 16GB 크롬 완전 종료 후 다시 열면 풀림.

## 형이 할 것: 없음 (허브 로그인이 풀렸을 때 16GB 크롬에서 다시 로그인 — 계정 namucompanyai, 부계정 만료 2027-04-19)

## 브레인이 SSH 로 할 것 (16GB)
1. `cd ~/crawler/dashboard && git pull`
2. **지금 1회용 — 최근 4주 파일** (대표 "로켓 등록·판매 있는데 광고 없는 상품" 표 입력): `~/crawler/dashboard/scripts/crawler-16gb/run-weekly-sales.sh --no-send --range 4w` → `tail -4 ~/crawler/logs/run-sales.log` 에 ✅ 파일명·기간·행 수. 16GB 크롬에 허브 로그인이 안 돼 있으면 "형, 허브 로그인 필요" → 대표가 16GB 에서 로그인(namucompanyai) 후 다시.
3. 주간 시험: `run-weekly-sales.sh --no-send` (지난주 월~일)
4. 24GB 로 가져가기 (24GB 터미널): `scp 'namucompany.ai@<16GB이름>.local:crawler/out/*/A00993784_SALES_ANALYSIS_BY_PRODUCT_*.csv' 'namucompany.ai@<16GB이름>.local:crawler/out/*/hub_sales_*.period.json' ~/NamuData/sales_1p_weekly/`
5. 등록 (대표 OK 뒤):

        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-hub-sales.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-hub-sales.plist

6. 매주 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 4 crawler/logs/run-sales.log'`

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 허브 차단 (Access Denied) | **있음** (10/19 사례, 쿠키 단위) | 그 주 파일 없음 → 슬랙 "허브 차단" | 16GB 크롬 완전 종료 후 다시 열고 손으로 1회 |
| 허브 로그인 풀림 | 있음 | 슬랙 "허브 로그인 필요" | 16GB 크롬 재로그인 |
| 판매 분석 화면의 기간 선택·export 버튼 이름이 다름 (미확인) | 첫 시험에서 판명 | 클로드가 못 찾아 ❌ | 지시문(jobs/hub-sales-export.md) 손질. 필요하면 브레인이 16GB 크롬 확장으로 화면 확인 |
| 기간 주소(start_date·end_date)가 화면에 안 먹음 | 낮음 (10/19 확인됨) | 기본 최근 7일 파일 → 기간 메모와 어긋남 | 지시문대로 달력으로 맞춤. 받은 파일 행 수·기간 메모로 검증 |
| 다운로드가 '요청 내역' 방식이고 5분 넘게 걸림 | 낮음 | ❌ 후 종료 | 손으로 다시 |
| 파일명 패턴이 다름 (부계정 차이) | 첫 시험에서 판명 | ❌ | 패턴 수정 |
| 24GB 전달이 수동 | 지금 구조 | NamuData 에 자동 반영 안 됨 | 수집기(namu-ingest) 만들 때 흡수 |

## 숙제 (다음에)
- **키 범위 좁히기**: 16GB 는 자동 로그인·FileVault 꺼짐이라 기계를 손에 넣으면 ~/crawler/.env 의 서비스 키(모든 표 읽기·쓰기 가능)가 그대로 노출된다. dashboard_data 의 두 행(coupang_ad_weekly_snapshots · coupang_ad_live_30d)만 쓸 수 있는 별도 키 + RLS 정책으로 바꾸고, 나무_마스터 시트도 읽기 전용 서비스 계정을 따로 만드는 안 (브레인 2026-10-20 지적).
