#!/bin/zsh
# 16GB 크롤링 맥 — 월요일 09:00 launchd 가 부르는 한 묶음 (손으로 돌릴 때: ~/crawler/dashboard/scripts/crawler-16gb/run-weekly.sh)
#   1) 크롬 켜기 → 2) 클로드가 크롬 확장으로 광고센터 보고서 2개(지난주 월~일 · 최근 30일) 받아 ~/crawler/out/오늘/ 로 옮김
#   3) 받은 파일 확인(행 수·열 이름, 금액 없음) → 4) 업로드 스크립트(run.ts)가 Supabase 에 저장
#   5) 업로드 성공하면 허브 판매 분석(4주) 받아 '팔리는데 광고 없는 1P' 대조 → #쿠팡-결합 슬랙 1줄 (2026-10-21 추가)
# 로그: ~/crawler/logs/ad-report-YYYY-MM-DD.log (클로드 출력 전체) · ~/crawler/logs/run-weekly.log (한 줄 요약)
# 키는 ~/crawler/.env 에만 (AD_UPLOAD_ENV). 화면·로그에 키·금액을 찍지 않는다.
#   시험용: run-weekly.sh --no-upload  → 보고서만 받고 Supabase 에는 올리지 않는다 (SETUP.md 6번)
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_UPLOAD=0; [[ "${1:-}" == "--no-upload" ]] && NO_UPLOAD=1

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"                      # 대시보드 저장소 부분 체크아웃 (SETUP.md 4번)
JOB="$DASH/scripts/crawler-16gb/jobs/ad-report-download.md"
CHECK="$DASH/scripts/crawler-16gb/ad-report-check.mjs"
TODAY=$(date +%Y-%m-%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/ad-report-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-weekly.log"
mkdir -p "$OUT" "$CRAWLER/logs"

# 기간 계산 — 지난주 월~일(오늘이 월요일이면 7일 전 월요일부터), 최근 30일(30일 전~어제)
U=$(date +%u)                                   # 1=월 … 7=일
OFF=$(( (U - 1) + 7 ))
WEEK_START=$(date -v-${OFF}d +%Y%m%d)
WEEK_END=$(date -v-$((OFF - 6))d +%Y%m%d)
M_START=$(date -v-30d +%Y%m%d)
M_END=$(date -v-1d +%Y%m%d)
WEEK_FILE="A00993784_pa_total_campaign_${WEEK_START}_${WEEK_END}.xlsx"
MONTH_FILE="A00993784_pa_total_campaign_${M_START}_${M_END}.xlsx"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }

if [[ ! -f "$JOB" || ! -f "$CHECK" ]]; then say "❌ 저장소 없음 ($DASH) — SETUP.md 4번"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음 — SETUP.md 5번"; exit 1; fi

# 크롬 확장은 클로드 세션 하나씩만 — 매일 아침 크롤링(페이지 순회·윙 엑셀)과 겹치면 끝날 때까지 기다림 (최대 50분, 90분 지난 잠금은 버림)
source "${0:A:h}/chrome-lock.sh"   # 공용 크롬 잠금(주인 PID) — 2026-10-24 함수 안 trap 버그 수정
trap chrome_unlock EXIT
chrome_lock || exit 1

# 1) 크롬 — 확장이 붙으려면 크롬이 떠 있어야 한다
open -ga "Google Chrome"
sleep 10

# 2) 클로드 세션 (비대화형) — 크롬 확장 도구 + 파일 옮기기·확인에 필요한 명령만 허용. 다른 사이트·슬랙·DB 쓰기는 지시문에서 금지
say "▶ 보고서 받기 시작 (주간 ${WEEK_START}~${WEEK_END} · 30일 ${M_START}~${M_END})"
cd "$CRAWLER" || exit 1
PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY
- 저장 폴더: $OUT
- 지난주 보고서 기간: ${WEEK_START} ~ ${WEEK_END} (월~일) → 기대 파일명 $WEEK_FILE
- 30일 보고서 기간: ${M_START} ~ ${M_END} → 기대 파일명 $MONTH_FILE
- 확인 명령: node $CHECK <파일>
"
# 지시문은 stdin 으로 — --allowedTools/--disallowedTools 는 뒤따르는 인자를 전부 도구 이름으로 먹어서 프롬프트를 뒤에 두면 안 된다 (10/21 16GB 실패 원인)
# 이번 실행에서 새로 붙은 줄만 보고 판정 (로그는 하루치가 한 파일에 이어 붙음 — 10/23 아침 실패 문구가 남아 오판정)
LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
printf '%s' "$PROMPT" | claude -p --chrome \
  --add-dir "$HOME/Downloads" \
  --allowedTools "mcp__claude-in-chrome" "Bash(ls:*)" "Bash(mv:*)" "Bash(mkdir:*)" "Bash(node:*)" "Bash(sleep:*)" "Read" "Write" \
  --disallowedTools "WebFetch" "WebSearch" "Agent" \
  >> "$LOG" 2>&1
CLAUDE_EXIT=$?
chrome_unlock
say "클로드 종료 코드 $CLAUDE_EXIT (자세한 건 $LOG)"

# 3) 클로드 자기 보고와 별개로 파일이 실제로 있는지 확인
OK=0
for f in "$WEEK_FILE" "$MONTH_FILE"; do
  if [[ -f "$OUT/$f" ]]; then
    say "✅ $f"; node "$CHECK" "$OUT/$f" | sed 's/^/    /' | tee -a "$SUMMARY"; OK=$((OK + 1))
  else
    say "❌ $f 없음"
  fi
done
if { tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -q "윙 로그인 필요"; }; then say "❌ 형, 윙 로그인 필요 (16GB 크롬)"; fi
if [[ $OK -eq 0 ]]; then say "업로드 생략 — 받은 파일 없음"; exit 1; fi
if [[ $NO_UPLOAD -eq 1 ]]; then say "업로드 생략 (--no-upload 시험 실행) — 파일은 $OUT 에 있음"; exit 0; fi

# 4) 업로드 — 24GB 와 같은 스크립트·같은 규칙. 처리 기록 ~/.namu-ad-upload/processed.json (이 맥 것)
cd "$DASH" || exit 1
# 처리 기록이 없으면 빈 기록으로 시작 (--init 을 $OUT 으로 돌리면 방금 받은 파일을 '처리함'으로만 적고 안 올린다 — 10/21 발견)
if [[ ! -f "$HOME/.namu-ad-upload/processed.json" ]]; then
  mkdir -p "$HOME/.namu-ad-upload" && printf '{}\n' > "$HOME/.namu-ad-upload/processed.json"
  say "처리 기록 없음 → 빈 기록으로 시작"
fi
AD_UPLOAD_DIR="$OUT" AD_UPLOAD_ENV="$CRAWLER/.env" npx --yes tsx scripts/ad-weekly-upload/run.ts >> "$LOG" 2>&1
UP_EXIT=$?
tail -n 5 "$HOME/.namu-ad-upload/upload.log" 2>/dev/null | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $UP_EXIT -eq 0 ]] && echo '✅' || echo '❌') 업로드 종료 코드 $UP_EXIT"
if [[ $UP_EXIT -ne 0 ]]; then exit $UP_EXIT; fi

# 5) "팔리는데 광고 없는 1P" 점검 (2026-10-21 추가) — 업로드가 방금 coupang_ad_live_30d 를 새로 올렸으니 그걸 바로 씀.
#    새 크롤링 없음: 허브 판매 분석 4주 파일만 이 자리에서 받아(기존 run-weekly-sales.sh 재사용) 옵션ID·캠페인명으로 대조.
say "▶ 1P 광고 없음 점검 — 허브 판매 분석(4주) 받기"
"$DASH/scripts/crawler-16gb/run-weekly-sales.sh" --no-send --range 4w >> "$LOG" 2>&1
SALES_FILE=$(ls -t "$OUT"/A00993784_SALES_ANALYSIS_BY_PRODUCT_*.csv 2>/dev/null | head -1)
if [[ -z "$SALES_FILE" ]]; then
  say "❌ 허브 판매 분석(4주) 못 받음 — 1P 광고 점검 생략 (허브 로그인 확인)"
  exit 0
fi
AD_GAP_ENV="$CRAWLER/.env" npx --yes tsx scripts/coupang-ad-gap/run.ts --sales "$SALES_FILE" --out "$OUT/ad_gap.json" --send >> "$LOG" 2>&1
GAP_EXIT=$?
tail -n 3 "$LOG" | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $GAP_EXIT -eq 0 ]] && echo '✅' || echo '❌') 1P 광고 없음 점검 종료 코드 $GAP_EXIT"
exit $GAP_EXIT
