#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:00 launchd 가 부르는 한 묶음: 쿠팡 상품 페이지 순회 → 시트 기준가(마진계산 AE)와 대조 → 슬랙 #쿠팡-결합
#   1) 대상 뽑기(run.ts --targets: 시트 → page_targets.json + 묶음 파일) → 2) 크롬 켜고 묶음마다 claude -p(크롬 확장으로 페이지 읽어 JSON)
#   3) 대조·저장·슬랙(run.ts --compare --send). 묶음 하나가 '차단'이면 나머지 묶음은 돌리지 않는다.
#   시험: run-daily-page.sh --no-send [--limit 10] → 앞 10페이지만, Supabase·슬랙 없이 로컬 저장소(--local-store)에
# 로그: ~/crawler/logs/page-price-YYYY-MM-DD.log · ~/crawler/logs/run-page.log (요약)
# 키는 ~/crawler/.env (PAGE_WATCH_ENV). 화면·로그에 키·마진·손익 숫자를 찍지 않는다 (가격은 파일·슬랙에만).
set -u
setopt null_glob
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0; LIMIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-send) NO_SEND=1 ;;
    --limit) LIMIT="$2"; shift ;;
  esac
  shift
done

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
JOB="$DASH/scripts/crawler-16gb/jobs/page-price-check.md"
RUN="$DASH/scripts/coupang-page-watch/run.ts"
TODAY=$(date +%Y-%m-%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/page-price-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-page.log"
TARGETS="$OUT/page_targets.json"
BATCH=4            # 클로드 세션 1개당 페이지 수 (페이지 읽기 + 대상 옵션별 이동이 세션 기억을 많이 먹어서 작게)
mkdir -p "$OUT" "$CRAWLER/logs"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }

# 크롬 확장은 클로드 세션 하나씩만 — 다른 크롤링(윙 엑셀·광고 보고서)과 겹치지 않게 잠금 (최대 50분 대기, 90분 지난 잠금은 버림)
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
chrome_lock() {
  for i in {1..100}; do
    if mkdir "$CHROME_LOCK" 2>/dev/null; then trap 'rmdir "$CHROME_LOCK" 2>/dev/null' EXIT; return 0; fi
    if [[ $(( $(date +%s) - $(stat -f %m "$CHROME_LOCK") )) -gt 5400 ]]; then rmdir "$CHROME_LOCK" 2>/dev/null; continue; fi
    sleep 30
  done
  say "❌ 크롬 잠금을 50분 기다려도 안 풀림 ($CHROME_LOCK)"; return 1
}

if [[ ! -f "$JOB" || ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 ($DASH) — SETUP.md 3번째 작업 (sparse-checkout add scripts/coupang-page-watch)"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음 — SETUP.md 5번"; exit 1; fi

# 1) 대상
cd "$DASH" || exit 1
LIM=(); [[ "$LIMIT" -gt 0 ]] && LIM=(--limit "$LIMIT")
PAGE_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --targets "$TARGETS" --batch "$BATCH" "${LIM[@]}" >> "$LOG" 2>&1
if [[ $? -ne 0 || ! -f "$TARGETS" ]]; then say "❌ 대상 뽑기 실패 (시트 읽기) — $LOG"; exit 1; fi
say "▶ $(tail -n 1 "$LOG")"

# 2) 묶음마다 클로드
chrome_lock || exit 1
open -ga "Google Chrome"
sleep 10
cd "$CRAWLER" || exit 1
BLOCKED=0; DONE=0
for bf in "$OUT"/page_targets_batch_*.json; do
  [[ -f "$bf" ]] || continue
  n="${bf##*_batch_}"; n="${n%.json}"
  rf="$OUT/page_prices_batch_${n}.json"
  if [[ -f "$rf" ]]; then say "묶음 $n 이미 있음 — 건너뜀"; DONE=$((DONE + 1)); continue; fi
  PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY
- 대상 파일: $bf  (이 파일의 pid 만, 순서대로)
- 결과 파일: $rf
"
  # 지시문은 stdin 으로 (--allowedTools 뒤에 프롬프트를 두면 도구 이름으로 먹힘)
  printf '%s' "$PROMPT" | claude -p --chrome \
    --allowedTools "mcp__claude-in-chrome" "Bash(sleep:*)" "Read" "Write" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" \
    >> "$LOG" 2>&1
  code=$?
  if [[ -f "$rf" ]]; then DONE=$((DONE + 1)); say "묶음 $n ✅ (종료 코드 $code)"; else say "묶음 $n ❌ 결과 파일 없음 (종료 코드 $code)"; fi
  if grep -q '"status": *"blocked"' "$rf" 2>/dev/null || grep -q "^차단:" "$LOG"; then BLOCKED=1; say "❌ 차단 감지 — 남은 묶음 중단"; break; fi
  sleep 5
done
rmdir "$CHROME_LOCK" 2>/dev/null

# 3) 대조·저장·슬랙 (읽은 게 하나도 없어도 '못 읽음 N/N' 으로 보고 — 0개 읽음이면 차단·확장 문제 신호)
cd "$DASH" || exit 1
if [[ $NO_SEND -eq 1 ]]; then
  PAGE_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --compare --targets "$TARGETS" --results "$OUT" --date "$TODAY" --local-store "$CRAWLER/out/page-store-test" --out "$OUT/page_report.json" >> "$LOG" 2>&1
  say "$([[ $? -eq 0 ]] && echo '✅' || echo '❌') 대조 검증 실행 (--no-send: Supabase·슬랙 없음, 메시지는 $LOG 에) · 묶음 $DONE 완료 · 차단 $BLOCKED"
  exit 0
fi
PAGE_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --compare --targets "$TARGETS" --results "$OUT" --date "$TODAY" --out "$OUT/page_report.json" --send >> "$LOG" 2>&1
C_EXIT=$?
say "$([[ $C_EXIT -eq 0 ]] && echo '✅' || echo '❌') 대조·슬랙 종료 코드 $C_EXIT · 묶음 $DONE 완료 · 차단 $BLOCKED"
exit $C_EXIT
