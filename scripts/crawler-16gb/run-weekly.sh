#!/bin/zsh
# 16GB 크롤링 맥 — 월요일 09:00 launchd 가 부르는 한 묶음 (손으로 돌릴 때: ~/crawler/dashboard/scripts/crawler-16gb/run-weekly.sh)
#   1) 크롬 켜기 → 2) 클로드가 크롬 확장으로 광고센터 보고서 2개(지난주 월~일 · 최근 30일) 받아 ~/crawler/out/오늘/ 로 옮김
#   3) 받은 파일 확인(행 수·열 이름, 금액 없음) → 4) 업로드 스크립트(run.ts)가 Supabase 에 저장
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
claude -p --chrome \
  --allowedTools "mcp__claude-in-chrome" "Bash(ls:*)" "Bash(mv:*)" "Bash(mkdir:*)" "Bash(node:*)" "Bash(sleep:*)" "Read" "Write" \
  --disallowedTools "WebFetch" "WebSearch" "Agent" \
  "$PROMPT" >> "$LOG" 2>&1
CLAUDE_EXIT=$?
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
if grep -q "윙 로그인 필요" "$LOG" 2>/dev/null; then say "❌ 형, 윙 로그인 필요 (16GB 크롬)"; fi
if [[ $OK -eq 0 ]]; then say "업로드 생략 — 받은 파일 없음"; exit 1; fi
if [[ $NO_UPLOAD -eq 1 ]]; then say "업로드 생략 (--no-upload 시험 실행) — 파일은 $OUT 에 있음"; exit 0; fi

# 4) 업로드 — 24GB 와 같은 스크립트·같은 규칙. 처리 기록 ~/.namu-ad-upload/processed.json (이 맥 것)
cd "$DASH" || exit 1
if [[ ! -f "$HOME/.namu-ad-upload/processed.json" ]]; then
  AD_UPLOAD_DIR="$OUT" AD_UPLOAD_ENV="$CRAWLER/.env" npx --yes tsx scripts/ad-weekly-upload/run.ts --init >> "$LOG" 2>&1
fi
AD_UPLOAD_DIR="$OUT" AD_UPLOAD_ENV="$CRAWLER/.env" npx --yes tsx scripts/ad-weekly-upload/run.ts >> "$LOG" 2>&1
UP_EXIT=$?
tail -n 5 "$HOME/.namu-ad-upload/upload.log" 2>/dev/null | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $UP_EXIT -eq 0 ]] && echo '✅' || echo '❌') 업로드 종료 코드 $UP_EXIT"
exit $UP_EXIT
