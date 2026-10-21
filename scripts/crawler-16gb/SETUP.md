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

# 3번째 작업 — 매일 07:30 쿠팡 상품 페이지 순회 → 시트 기준가 대조 → 슬랙 (2026-10-21, 매칭 규칙 10/21 시험 뒤 수정)

- 옵션 짝 맞추기 규칙 (10/21 10페이지 시험에서 남의 판매자 옵션에 붙어 가짜 알림이 난 뒤 확정): **옵션ID(vendorItemId) 일치만 정식**. 이름으로 맞추는 건 그 옵션 판매자가 우리(나무컴퍼니·보배마을·쌀쌀쌀·토지랑)이고 용량·개수 표기가 같고 짝이 하나뿐일 때만. 남의 판매자 옵션은 "⚠️ 우리 페이지에 남의 옵션" 줄로 따로(결합 감시 신호). 못 찾은 시트 옵션은 '페이지에 없음 / 그 자리에 남의 옵션 / 옵션ID 못 읽음 / 시트 중복 행' 으로 구분.
- 페이지 읽기는 **pid 당 1회만**(10/21 옵션별 `?vendorItemId=` 이동 20회에서 Access Denied 차단 → 접음). 옵션ID·판매자는 페이지 안 옵션 블록·내장 데이터와 DOM 클릭으로 잡고, 확인 안 되면 비움(가격으로 짐작 금지). 페이지 간 8초, 묶음(4페이지) 간 90초. Access Denied 1회면 그날 전체 중단 + 슬랙 맨 위에 🚫 차단 줄(16GB 크롬 완전 종료 후 다시 열기). 윙에서 판매중지인 3P 옵션은 대상에서 뺌(`--all-options` 로 끔).

- 하는 일: 16GB 가 매일 08:00 나무_마스터 마진계산에서 쿠팡 1P·3P 노출상품ID를 뽑아(약 53~80페이지) 크롬 확장으로 한 페이지씩(3~5초 간격) 읽고, 페이지 **일반 판매가**를 시트 **AE열 '쿠팡 소비자가(기준)'** 과 대조 → Supabase `coupang_page_YYYY-MM-DD` 저장 → 슬랙 #쿠팡-결합 1장(시트와 다른 옵션·어제와 달라진 가격·품절·후기 급감·미등록·못 읽은 페이지). 마진·손익 숫자는 슬랙에 안 넣음.
- 07:30 인 이유: 10/21 시험 10페이지 8분 → 50페이지 + 옵션별 이동으로 60분쯤 걸릴 수 있어 08:45 윙 엑셀 작업과 09:00 전에 끝내려고. 크롬 확장은 한 번에 클로드 세션 하나만 쓰도록 네 작업이 잠금을 공유함(겹치면 순서대로).
- 클로드 세션은 4페이지씩 묶음으로 나눠 돌림(한 세션이 페이지를 많이 읽으면 기억이 넘침). 묶음 하나에서 '차단' 화면이 보이면 그날 나머지는 안 돌리고 "못 읽음 N/N" 으로 보고.

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

---

# 5번째 작업 — 매일 11:00 네이버 쇼핑 키워드 순위(광고 제외) → 슬랙 (2026-10-21, 크롬 AppleScript 방식 · 10/21 저녁 재수정)

- 하는 일: 16GB 가 나무_마스터 **'네이버 순위 키워드'** 탭(키워드 · 우리 상품 URL · 별칭 · 검색 종류 · ON/OFF)을 읽어, 키워드마다 **16GB 의 진짜 크롬을 AppleScript 로 조종**해 네이버 쇼핑 검색 1페이지를 열고(스크롤로 지연 로딩을 채움) **'광고' 항목을 뺀 순서**로 우리 상품이 몇 번째인지 센다 → Supabase `naver_rank_YYYY-MM-DD` 저장 → 슬랙 1장(오늘 순위 · 어제 대비 ↑↓ · 순위권 이탈 · 못 읽음). 손익 숫자 없음. **입력은 그 시트 탭 하나뿐** — 형은 키워드를 거기서만 고치면 된다.
- 왜 이 방식인가: 클로드 크롬 확장은 네이버 쇼핑·통합검색을 거부, Playwright 는 캡차, 네이버 쇼핑 검색 API 는 2026-07-31 종료. 남은 길 = 확장을 거치지 않고 보통 크롬에 Apple Events 로 "탭 열어 → JS 실행 → 결과 받기".
- **광고 판별(10/21 저녁 확정)**: 클래스 추측이 아니라 네이버가 직접 붙이는 `data-nlog-params` 속성의 `is_ad`(true/false) 값을 쓴다. 같은 속성 안에 상품ID(`slot_dtl_nv_mid`)·상품명·판매처·가격도 그대로 들어 있어 이름 매칭 없이 ID 로 바로 식별된다(naver_dump_귀리_p1.html 로 확인). 상품 식별은 이 ID 로만 — 우리 상품 URL(products/ID·catalog/ID)과 겹치는지만 본다.
- **1페이지만, 2페이지는 안 간다**(10/21 낮 시험에서 `&pagingIndex=2` 로 이동하자 캡차 발생). 없으면 **"40위 밖"**.
- **지연 로딩**: 스크롤 없이는 9개쯤에서 멈춘다 → 탭을 연 뒤 8초 기다리고 아래로 스크롤을 4번(1초 간격) 해서 40개를 채운 뒤 읽는다(chrome-tab.applescript 의 스크롤 횟수 인자).
- **속도**: 키워드 간 30초(5초→30초, 짧은 간격이 캡차 원인으로 보임). 하루 1회, 11:00(대표 지정 — 08:15 아님).
- **캡차 감지**: 뜨면 그 키워드부터 그날 전체를 중단하고, 슬랙 "🔒 네이버 보안확인 — 16GB 크롬에서 한 번 풀어줘야 함" 1줄(마커로 하루 1회만). **형이 16GB 크롬에서 네이버 쇼핑을 한 번 열어 직접 풀어줘야** 다음 실행부터 정상화된다(10/21 낮 캡차가 저녁까지 남아 있었을 수 있어, 다음 시험 전에 먼저 풀어 두는 게 안전).
- Multi Plus(슬롯 서비스, 11/07 종료) 대체.

## 형이 할 것 (16GB 에서)
1. **크롬 설정**: 크롬 메뉴 막대 **보기 → 개발자 → "Apple Events 의 JavaScript 허용"** 체크.
2. **자동화 권한**: 첫 실행 때 뜨는 "터미널이 Google Chrome 을 제어하려고 합니다" 창을 **허용**.
3. **시험 전에 캡차부터 풀기**: 16GB 크롬으로 `search.shopping.naver.com` 을 직접 열어 보안확인 화면이 뜨면 풀어 둔다(낮 시험의 캡차가 남아 있을 수 있음).
4. 슬랙 채널: 1차는 #쿠팡-결합(Watchman)으로 같이. 따로 보려면 새 채널 웹훅을 `SLACK_NAVER_WEBHOOK_URL` 로.
5. **키워드 추가·끄기는 나무_마스터 '네이버 순위 키워드' 탭에서만** — 코드·파일은 안 건드려도 된다.

## 브레인이 할 것
1. 16GB: `cd ~/crawler/dashboard && git pull`
2. 시험 1 (터미널에서): `~/crawler/dashboard/scripts/crawler-16gb/run-daily-rank.sh --no-send --limit 3 --dump` → `tail -4 ~/crawler/logs/run-rank.log`, 결과 `~/crawler/out/날짜/naver_rank_batch_01.json` 에서 `ad`·`id`·`price` 값 확인(이제 `ids` 대신 `id` 1개, `mall`·가격도 있음). 상품을 3개 못 찾았으면(`count<3`) 자동으로 `naver_dump_<키워드>.html` 이 생긴다 — 그걸로 구조가 바뀌었는지 확인
3. 시험 2 (launchd 로): `launchctl kickstart -k gui/$(id -u)/com.namucompany.crawler-naver-rank`
4. Multi Plus 표(귀리 2·파로 2·호라산밀 1)와 ±1위 이내면 통과 → 등록:

        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-naver-rank.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-naver-rank.plist

5. 매일 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 4 crawler/logs/run-rank.log'`

## 권한 주체 (launchd 에서 osascript 가 크롬을 제어할 때) — 미검증, 첫 시험으로 확인
- 터미널에서 돌리면 권한은 **터미널 앱** 에 붙고, launchd 에이전트에서 돌리면 책임 앱이 없어 보통 **osascript** 자체(또는 /bin/zsh)에 붙는다. 터미널 시험이 되도 launchd 시험(3번)에서 -1743 이 날 수 있음 → 그때 뜨는 허용 창을 누르면 됨(Aqua 세션이라 창이 뜸).
- 그래도 안 되면 **앱 번들로 감싸기**: `osacompile -o ~/crawler/NaverRank.app ~/crawler/dashboard/scripts/naver-rank-watch/chrome-tab.applescript` 로 앱을 만들고 자동화 권한을 그 앱에 허용, launchd 는 `open -a` 로 띄움(그땐 run.ts 의 osascript 호출을 앱 호출로 바꿔야 함 — 대클).

## 조정값
- lib/naver/rankWatch.ts: MAX_RANK = 40 · RANK_MOVE_ALERT = 3
- scripts/naver-rank-watch/run.ts: WAIT_SEC = 8 · SCROLL_TIMES = 4 · KEYWORD_INTERVAL_MS = 30000
- 광고 판별: extract-naver.js 가 `data-nlog-params` 의 `is_ad` 를 그대로 읽음(추측 규칙 아님 — 구조가 바뀌면 `count<3` 자동 dump 로 확인)

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 캡차·보안확인 | **있음** (10/21 낮 1회 확인) | 그날 전체 중단, 슬랙 1회 | 형이 16GB 크롬에서 직접 풀어야 함. 간격(30초)을 늘려도 안 되면 키워드 수를 줄임 |
| `data-nlog-params` 속성 자체가 바뀜(네이버 로그 스키마 변경) | 낮음~있음 | 상품 0~2개 읽힘 → 자동 dump | dump 로 새 구조 확인해 extract-naver.js 손질 |
| 스크롤해도 40개가 다 안 뜸(느린 렌더링) | 있음 | 상품 일부만 읽힘, 순위 밀림 | SCROLL_TIMES·대기 늘림 |
| 크롬 앞 창 없음(launchd 에서 창 없이 떠 있음) | 있음 | AppleScript 가 창을 새로 만듦. 그래도 안 되면 -1712 | 스크립트가 `open -ga` 로 먼저 띄움. 실패 시 로그 확인 |
| 자동화 권한 주체 불일치 (터미널 OK·launchd 실패) | 있음 | -1743 | 위 '권한 주체' |
| 개인화 차이 (로그인 없는 16GB 크롬 vs 대표 폰) | 있음 | 1~3위 차이 | 추세로 봄. Multi Plus ±1 이내면 정상 |
| 우리 상품이 원부(catalog)로 묶여 다른 ID 로 노출 | 있음 | "40위 밖" 오판 | 시트 URL 셀에 catalog 주소도 같이 |
| 40위 밖 · 첫날 어제 없음 | — | 정상 | — |

---

# 6번째 작업 — 매일 10:00 광고센터 "광고 만들기" 상품 목록 → 1P 재고·현재가 → 슬랙 (2026-10-21)

- 하는 일: 16GB 가 광고센터 캠페인 등록 화면의 "수동 상품 설정 > 전체 상품" 목록(1P 재고를 볼 수 있는 유일한 화면, 읽기만·등록 안 함)을 읽어 옵션ID·상품명·가격·재고·아이템위너·후기 수·배지를 뽑고, 마진계산의 **1P 1봉 옵션 기준가(AE)** 와 대조 → Supabase `coupang_1p_stock_YYYY-MM-DD` 저장 → 슬랙 1장(품절 그룹·재고 적음·재고 급감·가격 다름·후기 급감·아이템위너 아님). 손익 숫자 없음.
- **로그인 — 중요**: 이 화면은 **허브(SUPPLIER HUB) 로그인**이어야 1P 가 보인다(윙만 로그인돼 있으면 3P만 보임, 10/21 확인). 화면 왼쪽 위 "wing | SUPPLIER HUB" 토글.
- 1P 담당 역할 분리: 가격 대조(3번째 작업, 상품 페이지 순회)는 이제 **3P만** 본다(1P 는 이 작업이 맡음). 결합 감시(2번째 작업)는 3P 윙 엑셀 그대로.
- 재고는 봉수별로 따로 표시된다(묶음은 재고를 공유 — 1봉 재고 2면 3봉 옵션은 보통 품절). 그룹(같은 상품) 안에 품절이 하나라도 있으면 그 그룹의 봉수별 재고를 한 줄로 보여준다. 가격 비교는 **1봉 옵션만**(마진계산 1P 행의 봉수=1, AE 기준) — 2봉 이상은 재고만 본다.

## 형이 할 것: 없음 (허브 로그인이 풀렸을 때 16GB 크롬에서 다시 로그인하는 것만 — 7번째 작업이 이걸 줄이려 함)

## 브레인이 할 것
1. 16GB: `cd ~/crawler/dashboard && git pull && git sparse-checkout add scripts/coupang-stock-watch`
2. 시험: `~/crawler/dashboard/scripts/crawler-16gb/run-daily-stock.sh --no-send` → `tail -6 ~/crawler/logs/run-stock.log`, 슬랙 문안은 `~/crawler/logs/adcenter-stock-날짜.log` 끝. 결과 `~/crawler/out/날짜/adcenter_stock.json` 을 대표 캡처(찰흑미 1개 재고2·3개 품절·2개 재고1, 병아리콩 품절, 렌틸콩 366)와 대조 — 옵션ID·가격·재고가 일치하는지
3. 등록 (대표 OK 뒤):

        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-adcenter-stock.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-adcenter-stock.plist

4. 매일 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 6 crawler/logs/run-stock.log'`

## 조정값 (lib/coupang/stockWatch.ts)
- LOW_STOCK_MAX = 10 · STOCK_DROP_PCT = 50 · REVIEW_DROP_PCT = 20 · REVIEW_DROP_MIN = 20

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 허브 로그인 풀림 | **있음** (10/21 실측 약 1.5시간 유지) | "형, 허브(SUPPLIER HUB) 로그인 필요" | 7번째 작업(세션 유지)으로 줄임. 그래도 풀리면 16GB 허브 재로그인 |
| 목록 화면 구조 변경(클래스·버튼 문구) | 있음 | 항목 0개 또는 값 틀림 | jobs/adcenter-stock-read.md 의 정규식 손질 |
| 제목·순서 매칭이 안 맞음(5번 JS 결과와 6번 접근성 트리 순서가 다름) | 있음 (처음이라 미검증) | 상품명이 옵션과 어긋남 | 결과 JSON 을 보고 지시문의 매칭 방식을 손질 |
| 재고 "품절"이 봉수 공유가 아니라 옵션별 독립일 수도 (가정 미확인) | 낮음 | 그룹 표시가 과하거나 부족 | 실제 데이터로 확인 |
| 1만 개 넘는 상품(목록 "최대 1만개" 안내) | 거의 없음(우리는 수십 개) | 2페이지로도 못 봄 | 해당 없음 |
| 평점 숫자(별 아이콘)를 못 읽음 | 있음 | rating 은 null | 후기 수·가격·재고로 충분 |

---

# 7번째 작업 — 20분마다 윙·허브·광고센터 로그인 유지 확인 (2026-10-21)

- 왜: 10/21 실측 — 윙 로그인 09:5x~14:0x(약 4시간), 허브 12:4x~14:1x(약 1.5시간)만 유지됨. 2·4·6번째 작업(08:45·09:10·10:00)이 자주 "로그인 필요"로 멈출 수 있어, **로그인이 끊기기 전에 홈 화면을 열어 세션을 되살리는** 작업.
- 방식: 20분마다 **실제 크롬**(클로드 확장 아님, naver-rank-watch/chrome-tab.applescript 재사용)으로 wing.coupang.com·supplier.coupang.com·advertising.coupang.com 홈을 6초씩 열어 로그인 폼이 보이는지만 확인하고 닫는다. 로그인 폼이 보이면(=세션 풀림) 사이트별 마커 파일을 만들고 그날 처음 한 번만 슬랙 "🔑 OO 로그인 풀림". 세션이 살아 있으면(또는 다시 살아나면) 마커를 지운다.
- 2·4·6번째 작업은 시작할 때 마커 파일이 있으면 로그에 참고 한 줄을 남기고(그래도 시도는 함) — 마커는 안내용이지 막는 용도가 아니다.
- 다른 크롤링 작업과 **크롬 잠금을 공유하되, 바쁘면 기다리지 않고 이번 20분 주기를 건너뛴다** (대기해서 다른 작업을 늦추지 않음).

## 형이 할 것: 없음

## 브레인이 할 것
1. 16GB: `git pull` (chrome-tab.applescript 는 네이버 작업과 공용 — 이미 받아져 있으면 생략)
2. 시험(터미널에서 직접): `~/crawler/dashboard/scripts/crawler-16gb/session-keepalive/run-keepalive.sh` → `tail -10 ~/crawler/logs/keepalive.log` 에 `wing 유지됨` / `hub 유지됨` / `adcenter 유지됨` (또는 지금 로그인 안 돼 있으면 `풀림` + 슬랙 1회)
3. 등록 (대표 OK 뒤):

        cp ~/crawler/dashboard/scripts/crawler-16gb/session-keepalive/com.namucompany.crawler-session-keepalive.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-session-keepalive.plist

4. **효과 검증(등록 후 2일)**: `grep -c 풀림 ~/crawler/logs/keepalive.log` 와 로그의 유지→풀림 전환 시각을 보고, 전처럼 몇 시간 안에 풀리면 plist 의 `StartInterval`을 1200(20분) → 600(10분)으로 낮춰 bootout·재등록.
5. 매일 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 10 crawler/logs/keepalive.log'`

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 홈 화면을 여는 것만으론 세션이 안 늘어남(서버 쪽 정책) | **있음** (미검증 — 그래서 2일 효과 검증) | 로그인 유지 시간이 그대로 | 간격을 줄여도 안 되면 이 방식 자체 재검토(예: API 호출로 세션 갱신) |
| 로그인 폼 감지 오탐(비밀번호 입력칸이 있는 다른 팝업) | 낮음 | 로그인 안 풀렸는데 "풀림" 오보 | keepalive.log 와 실제 상태 비교해 check-login.js 보정 |
| 20분마다 접근이 쌓여 반대로 차단 유발 | 낮음 (홈 화면만, 검색·목록 아님) | 그 사이트 접근 전반 영향 | 간격을 늘림(30분) |
| 다른 작업과 겹쳐 매번 건너뜀(크롬이 항상 바쁨) | 낮음 | 로그인 유지 효과 못 봄 | keepalive.log 의 "건너뜀" 비율 확인, 겹치면 각 작업 시간 재조정 |

---

# 숙제 구현 — "팔리는데 광고 없는 1P" 월요일 점검 (2026-10-21, 설계는 raw/2026-10-21_crawler16gb_jobs/2026-10-21_ad_gap_1p_design.md)

- 하는 일: 월요일 광고 보고서 업로드(1번째 작업)가 끝나면 이어서 — 나무_마스터 1P 행(옵션ID·별칭) · 방금 올라간 30일 광고 데이터(`coupang_ad_live_30d`) · 허브 판매 분석 4주(그 자리에서 새로 받음) · 광고센터 재고(6번째 작업의 가장 최근 스냅샷)를 대조해 "4주간 팔렸는데 광고가 안 걸린 1P 상품"을 찾아 #쿠팡-결합에 **슬랙 1줄**. **새 크롤링 화면을 만들지 않고 이미 모으는 데이터만 씀.**
- **핵심 — 옵션 단위가 아니라 별칭(상품) 단위로 광고 연결을 본다.** 옵션ID가 광고 행에 직접 있으면 그 옵션의 별칭을 "광고 있음"으로, 1P 캠페인 이름(브랜드·AI/수동/스마트·숫자를 뺀 "상품 토큰")이 별칭과 겹치면 그 별칭 전체를(봉수가 다른 옵션까지) "광고 있음"으로 묶는다. 원래 설계가 지적한 "클릭 0인 옵션은 광고 보고서에 아예 안 나와 90% 오판" 문제를 캠페인 하나가 보통 여러 봉수를 같이 묶는다는 점으로 메운 것 — 실제 10/11 판매 42건으로 시험하니 "광고 없음" 1건만 남음(옛 방식이면 훨씬 많았을 숫자).
- 광고센터 재고(6번째 작업)로 **품절 상품은 "광고 없음" 알림에서 뺀다**(품절인데 광고 없다고 알려봐야 할 게 없음) — 대표 지시(10/21) 반영.
- 한계: 캠페인 이름이 실제 상품명과 많이 다르면 놓친다(예: 캠페인 "저속노화" vs 상품명 "저속식단" — 테스트로 확인된 실제 사례, 품절이라 가려졌을 뿐 매칭은 실패함). 클릭이 평생 한 번도 없던 상품은 광고 행 자체에 안 잡혀 완전히 놓칠 수 있음 — 이건 광고센터 캠페인 목록 화면을 읽기 전엔 못 메움(다음 숙제로 남김, 이번엔 안 만듦).

## 형이 할 것: 없음

## 브레인이 할 것
1. 16GB: `cd ~/crawler/dashboard && git pull && git sparse-checkout add scripts/coupang-ad-gap lib/coupang/adGap.ts` (lib 전체가 있으면 뒤 항목 생략)
2. 시험(월요일 전체 묶음 켜지 않고 이 단계만): `AD_GAP_ENV=~/crawler/.env npx tsx scripts/coupang-ad-gap/run.ts --sales <허브 4주 csv 경로> --local-store /tmp/adgap-test --out /tmp/adgap-test/report.json` (Supabase 안 씀, 화면에 슬랙 문안만). 24GB 에서 10/11 샘플 csv 로 이미 시험해 42건 중 1건 확인함
3. 등록은 따로 없음 — run-weekly.sh(1번째 작업, 이미 등록됨)가 자동으로 끝에서 돌린다. **run-weekly.sh 가 이제 더 오래 걸린다**(허브 4주 추가 다운로드 1회분만큼)

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 캠페인 이름이 상품명과 다름(마케팅용 별명) | **있음** (실측 사례: 저속노화≠저속식단) | 광고가 있어도 "없음"으로 오판 | ad_gap.json 의 matchedBy 로 확인, 심하면 별칭 사전 추가 검토 |
| 평생 클릭 0인 상품(광고 행 자체에 안 잡힘) | 있음 | 완전히 놓침(알림도 안 뜸, 조용한 누락) | 광고센터 캠페인 목록 화면 읽기 숙제(다음) |
| coupang_ad_live_30d 가 비어 있거나 옛날 것(AD_LIVE_30D_SAVE 꺼짐 등) | 낮음 | 전부 "광고 없음"으로 과잉 알림 | run.ts 가 로그에 경고 남김, out/ad_gap.json 으로 확인 |
| 6번째 작업(재고) 스냅샷이 아직 없음(첫 주) | 가끔 | 품절 제외 없이 판정(과잉 알림 가능) | 로그 경고, 6번째 작업 등록되면 자동 해소 |
| 허브 로그인 풀려 4주 파일을 못 받음 | 있음 (7번째 작업이 줄이려 함) | "1P 광고 점검 생략" 로그만, 알림 없음 | 7번째(로그인 유지)·2번째(허브 로그인) 대응과 동일 |
| 토큰이 너무 짧아 오매칭(예: 두 글자 상품명) | 낮음 (2글자 미만은 걸러둠) | 상관없는 상품이 묶일 수 있음 | ad_gap.json 으로 사람이 확인 |

---

# 9번째 작업 — 매일 09:05 아침 보고서(전원 공유, 손익 없음) + 8번째(어제 1일 광고) + 시각 조정 (2026-10-22, 대표 확정)

- 하는 일: **매일 09:05에 전 직원이 같이 보는 보고서 1장**을 #쿠팡-결합(새 채널 안 만듦)에 보낸다. 그날 이미 저장된 결과(재고·1P 가격·결합/남의 옵션·네이버 순위·어제 광고)를 다시 모을 뿐 새 크롤링은 안 한다 — node 만 쓰고 **크롬이 필요 없다**.
- **손익·마진 숫자는 절대 안 넣는다** — 건별·기간 마진·순이익은 여전히 C레벨 #손익 전용(나무컴퍼니 공통 규칙). 이 보고서는 매출·광고비 같은 공개해도 되는 숫자만.
- 8칸: ① 어제 매출(**미구현, "준비 중"**) ② 어제 광고(8번째 작업 — 광고비·클릭·캠페인 수, 품절인데 광고 ON 경고) ③ 재고·품절(6번째) ④ 1P 가격 변동(6번째) ⑤ 결합·점유(2번째 결합 감시 + 3번째 페이지 순회의 남의 판매자 + 6번째 아이템위너) ⑥ 후기(**미구현, "준비 중"**) ⑦ 네이버 순위(5번째, ±3 이상만 따로 보여줌) ⑧ 오늘 할 일(화/목 발주 알림 · 로그인 풀림 · 못 받은 소스)
- 소스가 그날 없으면(아직 등록 안 됐거나 실패) 그 칸만 "미수신"으로 비고, ⑧ 에도 모아서 보여준다 — 막지 않는다.
- **8번째(새 작업)**: 매일 08:40 광고센터 "어제 1일" 보고서 1개(합계·클릭 키워드만) → 기존 `scripts/ad-weekly-upload/run.ts` 를 그대로 재사용(1일짜리 파일이면 자동으로 `coupang_ad_daily_YYYY-MM-DD` 에 저장하는 분기를 run.ts 에 추가함, 월요일 작업과 같은 스크립트).
- **시각 조정**: 6번째(재고) 10:00→08:50, 5번째(네이버) **08:55 + 12:30 하루 2회**로. 11:00 설정은 폐기. 12:30 은 08:55 대비 **바뀐 키워드만** 슬랙(변동 없으면 조용히 끝남 — 매번 전체를 또 보내지 않음).

## 형이 할 것: 없음

## 브레인이 할 것
1. 16GB: `git pull && git sparse-checkout add scripts/coupang-morning-report scripts/coupang-ad-gap lib/coupang/morningReport.ts` (lib 전체가 있으면 뒤 항목 생략)
2. 8번째 시험: `~/crawler/dashboard/scripts/crawler-16gb/run-daily-ad.sh --no-upload` → `tail -4 ~/crawler/logs/run-daily-ad.log`
3. 아침 보고서 시험(크롬 불필요, 바로 가능): `~/crawler/dashboard/scripts/crawler-16gb/run-morning-report.sh --no-send` → `tail -4 ~/crawler/logs/run-morning.log`, 전체 문안은 `~/crawler/logs/morning-report-날짜.log`. 그날 저장된 소스가 적으면 "미수신"이 많이 뜨는 게 정상(6·2·5번째가 먼저 돌고 쌓여야 꽉 참)
4. 네이버 12:30 시험: `run-daily-rank.sh --noon --no-send` (아침 걸 먼저 한 번 돌려 둬야 비교 대상이 생김)
5. 등록 (대표 OK 뒤, 전부):

        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-ad-daily.plist ~/Library/LaunchAgents/
        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-morning-report.plist ~/Library/LaunchAgents/
        cp ~/crawler/dashboard/scripts/crawler-16gb/com.namucompany.crawler-naver-rank-noon.plist ~/Library/LaunchAgents/
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-ad-daily.plist
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-morning-report.plist
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.namucompany.crawler-naver-rank-noon.plist

   기존 6번째(재고)·5번째(네이버 아침) plist 는 시각만 바뀌었으니 **재등록**(bootout 후 다시 bootstrap)해야 새 시각이 적용됨.
6. 매일 확인: `ssh namucompany.ai@<16GB이름>.local 'tail -n 4 crawler/logs/run-morning.log'`

## 이 자동화가 틀리는 경우
| 경우 | 확률 | 어떻게 되나 | 대응 |
|---|---|---|---|
| 09:05 전에 재고·네이버·어제광고가 아직 안 끝남(크롬 작업들이 밀림) | 있음 (크롬 잠금을 서로 기다리느라) | 그 칸 "미수신" | 몇 주 지켜보고 안 맞으면 09:05 를 09:10~15 로 늦춤 |
| 페이지 순회(3번째)가 등록 안 돼 있거나 실패(현재 미해결) | **있음** (옵션ID 추출 아직 안 됨) | ⑤ 칸 "페이지 순회(남의 옵션): 미수신" | 3번째 작업 완성되면 자동으로 채워짐, 그전까진 정상 |
| coupang_ad_daily 가 비어 있거나 옛날 것 | 낮음 | ② 칸 "미수신" | 8번째 로그 확인 |
| 결합 감시(2번째)가 그날 윙 파일을 못 받음 | 가끔(대표가 윙 파일 안 받은 날) | ⑤ 칸에 catalog 쪽만 "기준선" 또는 미수신 | 정상 — 한계로 이미 알려진 것 |
| 화/목 발주 알림이 실제 발주 여부와 무관하게 뜸(날짜만 봄) | 항상 | 발주 없는 화/목에도 리마인드가 뜸 | 참고용 — 실제 발주 시스템과 연동 아님, 오탐 아님(그냥 "확인해라") |
| 12:30 이 08:55 데이터를 못 찾음(아침이 실패했던 날) | 가끔 | "오늘 아침 스냅샷 없음 — 비교 없이 저장만" 로그, 슬랙 안 감 | 정상 (비교 기준이 없어서) |

## 숙제 (다음에)
- **키 범위 좁히기**: 16GB 는 자동 로그인·FileVault 꺼짐이라 기계를 손에 넣으면 ~/crawler/.env 의 서비스 키(모든 표 읽기·쓰기 가능)가 그대로 노출된다. dashboard_data 의 두 행(coupang_ad_weekly_snapshots · coupang_ad_live_30d)만 쓸 수 있는 별도 키 + RLS 정책으로 바꾸고, 나무_마스터 시트도 읽기 전용 서비스 계정을 따로 만드는 안 (브레인 2026-10-20 지적).
