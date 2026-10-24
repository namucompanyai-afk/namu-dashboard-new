#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:40 launchd: 광고센터 "어제 1일" 보고서 → Supabase coupang_ad_daily_YYYY-MM-DD (아침 보고서 ② 어제 광고 칸의 입력)
#   기존 scripts/ad-weekly-upload/run.ts 를 그대로 재사용 — 1일짜리 파일이면 그 스크립트가 알아서 coupang_ad_daily_<날짜> 로 저장한다(2026-10-22 run.ts 에 추가된 분기)
#   시험: run-daily-ad.sh --no-upload → 보고서만 받고 Supabase 에는 안 올림
# 로그: ~/crawler/logs/ad-report-daily-YYYY-MM-DD.log · ~/crawler/logs/run-daily-ad.log (요약). 키는 ~/crawler/.env (AD_UPLOAD_ENV)
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_UPLOAD=0; [[ "${1:-}" == "--no-upload" ]] && NO_UPLOAD=1

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
JOB="$DASH/scripts/crawler-16gb/jobs/ad-report-daily.md"
CHECK="$DASH/scripts/crawler-16gb/ad-report-check.mjs"
TODAY=$(date +%Y-%m-%d)
YDAY=$(date -v-1d +%Y%m%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/ad-report-daily-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-daily-ad.log"
FILE="A00993784_pa_total_campaign_${YDAY}_${YDAY}.xlsx"
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }

if [[ ! -f "$JOB" || ! -f "$CHECK" ]]; then say "❌ 저장소 없음 — git pull"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음 — SETUP.md 5번"; exit 1; fi
[[ -f "$CRAWLER/logs/.session-wing-expired" ]] && say "참고: 윙 로그인이 최근 점검에서 풀려 있었음(세션 유지 작업 기록) — 그래도 시도함"

source "${0:A:h}/chrome-lock.sh"   # 공용 크롬 잠금(주인 PID) — 2026-10-24 함수 안 trap 버그 수정
trap chrome_unlock EXIT

if [[ ! -f "$OUT/$FILE" ]]; then
  chrome_lock || exit 1
  open -ga "Google Chrome"
  sleep 10
  say "▶ 어제 1일 광고 보고서 받기 시작 ($FILE)"
  cd "$CRAWLER" || exit 1
  PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY · 어제: $YDAY
- 저장 폴더: $OUT
- 기대 파일명: $FILE
- 확인 명령: node $CHECK <파일>
"
  # 로그는 하루치가 한 파일에 이어 붙는다 → 이번 실행에서 새로 붙은 줄만 보고 판정 (10/23: 아침 실패 문구가 남아 성공을 실패로 오판정)
  LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
  printf '%s' "$PROMPT" | claude -p --chrome \
    --add-dir "$HOME/Downloads" \
    --allowedTools "mcp__claude-in-chrome" "Bash(ls:*)" "Bash(mv:*)" "Bash(mkdir:*)" "Bash(node:*)" "Bash(sleep:*)" "Read" "Write" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" \
    >> "$LOG" 2>&1
  code=$?
  chrome_unlock
  say "클로드 종료 코드 $code (자세한 건 $LOG)"
  # 파일이 실제로 있으면 성공 — 문구는 파일이 없을 때 이유를 붙이는 용도로만 쓴다
  if [[ ! -f "$OUT/$FILE" ]] && tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -q "윙 로그인 필요"; then say "❌ 형, 윙 로그인 필요 (16GB 크롬)"; exit 1; fi
else
  say "파일 이미 있음 — 다운로드 생략 ($OUT/$FILE)"
fi

if [[ ! -f "$OUT/$FILE" ]]; then say "❌ $FILE 없음 — 다운로드 실패"; exit 1; fi
node "$CHECK" "$OUT/$FILE" | sed 's/^/    /' | tee -a "$SUMMARY"
if [[ $NO_UPLOAD -eq 1 ]]; then say "업로드 생략 (--no-upload)"; exit 0; fi

cd "$DASH" || exit 1
if [[ ! -f "$HOME/.namu-ad-upload/processed.json" ]]; then
  mkdir -p "$HOME/.namu-ad-upload" && printf '{}\n' > "$HOME/.namu-ad-upload/processed.json"
fi
AD_UPLOAD_DIR="$OUT" AD_UPLOAD_ENV="$CRAWLER/.env" npx --yes tsx scripts/ad-weekly-upload/run.ts >> "$LOG" 2>&1
UP_EXIT=$?
tail -n 3 "$HOME/.namu-ad-upload/upload.log" 2>/dev/null | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $UP_EXIT -eq 0 ]] && echo '✅' || echo '❌') 업로드 종료 코드 $UP_EXIT"
exit $UP_EXIT
