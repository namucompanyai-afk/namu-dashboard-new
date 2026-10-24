#!/bin/zsh
# 16GB 크롤링 맥 — 매일 10:00 launchd: 광고센터 "광고 만들기" 상품 목록 읽기(1P 재고·현재가) → 어제 대비 → 슬랙
#   1) 크롬 켜기 → 2) claude -p --chrome (jobs/adcenter-stock-read.md, 읽기만·등록 안 함) → 3) run.ts (마진계산 1P 기준과 대조 → 저장 → 슬랙)
#   시험: run-daily-stock.sh --no-send → Supabase·슬랙 없이 로컬 저장소
# 로그: ~/crawler/logs/adcenter-stock-YYYY-MM-DD.log · ~/crawler/logs/run-stock.log (요약). 키는 ~/crawler/.env (STOCK_WATCH_ENV)
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0
[[ "${1:-}" == "--no-send" ]] && NO_SEND=1

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
JOB="$DASH/scripts/crawler-16gb/jobs/adcenter-stock-read.md"
RUN="$DASH/scripts/coupang-stock-watch/run.ts"
TODAY=$(date +%Y-%m-%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/adcenter-stock-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-stock.log"
RESULT="$OUT/adcenter_stock.json"
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }

# 크롬은 한 번에 한 작업만 (다른 크롤링과 잠금 공유)
source "${0:A:h}/chrome-lock.sh"   # 공용 크롬 잠금(주인 PID) — 2026-10-24 함수 안 trap 버그 수정
trap chrome_unlock EXIT

if [[ ! -f "$JOB" || ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 ($DASH) — git pull + sparse-checkout add scripts/coupang-stock-watch"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음 — SETUP.md 5번"; exit 1; fi
# 세션 유지 작업(7번째)이 로그인 풀림을 미리 표시해 둠 — 참고만, 그래도 시도는 한다
[[ -f "$CRAWLER/logs/.session-hub-expired" ]] && say "참고: 허브(SUPPLIER HUB) 로그인이 최근 점검에서 풀려 있었음(세션 유지 작업 기록) — 그래도 시도함"

if [[ ! -f "$RESULT" ]]; then
  chrome_lock || exit 1
  open -ga "Google Chrome"
  sleep 10
  say "▶ 광고센터 상품 목록 읽기 시작"
  cd "$CRAWLER" || exit 1
  PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY
- 결과 파일: $RESULT
"
  # 로그는 하루치가 한 파일에 이어 붙는다 → 이번 실행에서 새로 붙은 줄만 보고 판정 (10/23: 아침 실패 문구가 남아 성공을 실패로 오판정)
  LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
  # 지시문은 stdin 으로 (--allowedTools 뒤에 프롬프트를 두면 도구 이름으로 먹힘)
  printf '%s' "$PROMPT" | claude -p --chrome \
    --allowedTools "mcp__claude-in-chrome" "Bash(mkdir:*)" "Bash(sleep:*)" "Read" "Write" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" \
    >> "$LOG" 2>&1
  code=$?
  chrome_unlock
  say "클로드 종료 코드 $code (자세한 건 $LOG)"
  # 결과 파일이 실제로 있으면 성공 — 문구는 파일이 없을 때만 실패 이유로 쓴다
  if [[ ! -f "$RESULT" ]] && tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -qE "(광고센터|허브\(SUPPLIER HUB\)) 로그인 필요"; then
    say "❌ 로그인 필요 (로그에서 확인, 16GB 크롬)"
    exit 1
  fi
else
  say "결과 파일 이미 있음 — 읽기 생략 ($RESULT)"
fi

if [[ ! -f "$RESULT" ]]; then say "❌ 결과 파일 없음 — 읽기 실패"; exit 1; fi

cd "$DASH" || exit 1
if [[ $NO_SEND -eq 1 ]]; then
  STOCK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --results "$OUT" --date "$TODAY" --local-store "$CRAWLER/out/stock-store-test" --out "$OUT/stock_report.json" >> "$LOG" 2>&1
  say "$([[ $? -eq 0 ]] && echo '✅' || echo '❌') 대조 검증 실행 (--no-send: Supabase·슬랙 없음, 메시지는 $LOG 에)"
  exit 0
fi
STOCK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --results "$OUT" --date "$TODAY" --out "$OUT/stock_report.json" --sent-marker "$OUT/.stock_slack_sent" --send >> "$LOG" 2>&1
C_EXIT=$?
say "$([[ $C_EXIT -eq 0 ]] && echo '✅' || echo '❌') 대조·슬랙 종료 코드 $C_EXIT"
exit $C_EXIT
