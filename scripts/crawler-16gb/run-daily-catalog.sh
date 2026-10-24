#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:45 launchd 가 부르는 한 묶음 (손으로: ~/crawler/dashboard/scripts/crawler-16gb/run-daily-catalog.sh)
#   1) 크롬 켜기 → 2) 클로드가 크롬 확장으로 윙 '쿠팡상품정보' 엑셀을 받아 ~/crawler/out/오늘/ 로 옮김
#   3) 파일 확인(옵션 수, 금액 없음) → 4) 결합 감시(coupang-catalog-watch/run.ts --send)가 직전 날짜와 비교·Supabase 저장·슬랙 #쿠팡-결합
#   파일을 못 받으면(로그인 풀림 등) Watchman 슬랙(#쿠팡-결합)에 "오늘 윙 파일 없음 — 16GB 윙 로그인 필요" 1줄 — 연속 실패 중엔 첫날만
#   시험용: run-daily-catalog.sh --no-send → 받기만 하고 Supabase·슬랙 없이 로컬 검증(--file --local-store)
# 로그: ~/crawler/logs/wing-catalog-YYYY-MM-DD.log (클로드·감시 출력) · ~/crawler/logs/run-daily.log (한 줄 요약)
# 키는 ~/crawler/.env 에만 (CATALOG_WATCH_ENV). 화면·로그에 키·손익 숫자를 찍지 않는다.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0; [[ "${1:-}" == "--no-send" ]] && NO_SEND=1

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
JOB="$DASH/scripts/crawler-16gb/jobs/wing-catalog-download.md"
CHECK="$DASH/scripts/crawler-16gb/catalog-check.ts"
WATCH="$DASH/scripts/coupang-catalog-watch/run.ts"
TODAY=$(date +%Y-%m-%d)
YYMMDD=$(date +%y%m%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/wing-catalog-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-daily.log"
ALERTED="$CRAWLER/logs/.wing-nofile-alerted"   # 있으면 "파일 없음" 슬랙을 이미 보낸 상태 (성공하면 지움)
FILE="Coupang_detailinfo_${YYMMDD}.xlsx"
mkdir -p "$OUT" "$CRAWLER/logs"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
webhook() { grep -E '^SLACK_REVIEW_WEBHOOK_URL=' "$CRAWLER/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'" ; }
slack_once() {  # $1 = 문장. 연속 실패 중 첫날만 보냄
  [[ -f "$ALERTED" ]] && { say "슬랙 생략 (이미 알림 보냄)"; return; }
  local url; url=$(webhook)
  if [[ -z "$url" ]]; then say "❌ .env 에 SLACK_REVIEW_WEBHOOK_URL 없음 — 슬랙 못 보냄"; return; fi
  local md="$(date +%-m)/$(date +%-d)"
  if curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"text\":\"*[쿠팡 결합 점검 ${md}]* $1\"}" "$url"; then
    touch "$ALERTED"; say "슬랙 보냄: $1"
  else
    say "❌ 슬랙 전송 실패"
  fi
}

if [[ ! -f "$JOB" || ! -f "$CHECK" || ! -f "$WATCH" ]]; then say "❌ 저장소 파일 없음 ($DASH) — SETUP.md 2번째 작업 1번 (sparse-checkout add)"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음 — SETUP.md 5번"; exit 1; fi
# 세션 유지 작업(7번째)이 로그인 풀림을 미리 표시해 둠 — 참고만, 그래도 시도는 한다
[[ -f "$CRAWLER/logs/.session-wing-expired" ]] && say "참고: 윙 로그인이 최근 점검에서 풀려 있었음(세션 유지 작업 기록) — 그래도 시도함"

# 크롬 확장은 클로드 세션 하나씩만 — 08:00 페이지 순회(run-daily-page.sh)와 겹치면 끝날 때까지 기다림 (최대 50분, 90분 지난 잠금은 버림)
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
chrome_lock() {
  for i in {1..100}; do
    if mkdir "$CHROME_LOCK" 2>/dev/null; then trap 'rmdir "$CHROME_LOCK" 2>/dev/null' EXIT; return 0; fi
    if [[ $(( $(date +%s) - $(stat -f %m "$CHROME_LOCK") )) -gt 5400 ]]; then rmdir "$CHROME_LOCK" 2>/dev/null; continue; fi
    sleep 30
  done
  say "❌ 크롬 잠금을 50분 기다려도 안 풀림 ($CHROME_LOCK)"; return 1
}

# 이미 오늘 파일을 받아 뒀으면 다운로드는 건너뛴다 (손으로 다시 돌릴 때)
if [[ ! -f "$OUT/$FILE" ]]; then
  chrome_lock || exit 1
  open -ga "Google Chrome"
  sleep 10
  say "▶ 윙 쿠팡상품정보 받기 시작 ($FILE)"
  cd "$CRAWLER" || exit 1
  PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY
- 저장 폴더: $OUT
- 기대 파일명: $FILE
- 확인 명령: npx tsx $CHECK <파일>  (작업 폴더 $DASH 에서)
"
  # 지시문은 stdin 으로 (--allowedTools 뒤에 프롬프트를 두면 도구 이름으로 먹힘)
  # 이번 실행에서 새로 붙은 줄만 보고 판정 (로그는 하루치가 한 파일에 이어 붙음 — 10/23 아침 실패 문구가 남아 오판정)
  LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
  printf '%s' "$PROMPT" | claude -p --chrome \
    --add-dir "$HOME/Downloads" \
    --allowedTools "mcp__claude-in-chrome" "Bash(ls:*)" "Bash(mv:*)" "Bash(mkdir:*)" "Bash(npx tsx:*)" "Bash(sleep:*)" "Read" "Write" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" \
    >> "$LOG" 2>&1
  say "클로드 종료 코드 $? (자세한 건 $LOG)"
  rmdir "$CHROME_LOCK" 2>/dev/null
fi

# 클로드 자기 보고와 별개로 파일 존재 확인
if [[ ! -f "$OUT/$FILE" ]]; then
  if { tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -q "윙 로그인 필요"; }; then
    say "❌ $FILE 없음 — 형, 윙 로그인 필요 (16GB 크롬)"
    [[ $NO_SEND -eq 0 ]] && slack_once "오늘 윙 파일 없음 — 16GB 윙 로그인 필요"
  else
    say "❌ $FILE 없음 — 다운로드 실패 (로그 확인)"
    [[ $NO_SEND -eq 0 ]] && slack_once "오늘 윙 파일 없음 — 16GB 다운로드 실패, 로그 확인 필요"
  fi
  exit 1
fi
say "✅ $FILE"
cd "$DASH" || exit 1
npx --yes tsx "$CHECK" "$OUT/$FILE" | sed 's/^/    /' | tee -a "$SUMMARY"
rm -f "$ALERTED"

# 결합 감시 — 24GB 와 같은 스크립트·같은 규칙. 같은 날짜가 Supabase 에 이미 있으면(24GB 가 먼저) 건너뜀
if [[ $NO_SEND -eq 1 ]]; then
  STORE="$CRAWLER/out/catalog-store-test"
  CATALOG_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$WATCH" --file "$OUT/$FILE" --date "$TODAY" --local-store "$STORE" --out "$OUT/catalog_snapshot.json" >> "$LOG" 2>&1
  say "$([[ $? -eq 0 ]] && echo '✅' || echo '❌') 결합 감시 검증 실행 (--no-send: Supabase·슬랙 없음, 메시지는 $LOG 에)"
  exit 0
fi
if [[ ! -f "$HOME/.namu-catalog-watch/processed.json" ]]; then
  mkdir -p "$HOME/.namu-catalog-watch" && printf '{}\n' > "$HOME/.namu-catalog-watch/processed.json"
  say "처리 기록 없음 → 빈 기록으로 시작"
fi
CATALOG_WATCH_DIR="$OUT" CATALOG_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$WATCH" --send >> "$LOG" 2>&1
W_EXIT=$?
tail -n 3 "$HOME/.namu-catalog-watch/run.log" 2>/dev/null | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $W_EXIT -eq 0 ]] && echo '✅' || echo '❌') 결합 감시 종료 코드 $W_EXIT"
exit $W_EXIT
