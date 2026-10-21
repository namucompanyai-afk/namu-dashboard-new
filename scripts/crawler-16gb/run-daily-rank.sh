#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:15 launchd: 네이버 쇼핑 키워드 순위(광고 제외) → 어제 대비 → 슬랙
#   1) run.ts --targets (나무_마스터 '네이버 순위 키워드' 탭 → naver_rank_targets.json + 3개씩 묶음) → 2) 묶음마다 claude -p --chrome (검색 결과 읽어 JSON)
#   3) run.ts --compare --send (직전 스냅샷 비교 → naver_rank_YYYY-MM-DD 저장 → 슬랙). 묶음에서 캡차·차단이면 나머지 중단
#   시험: run-daily-rank.sh --no-send [--limit 3] → Supabase·슬랙 없이 로컬 저장소
# 로그: ~/crawler/logs/naver-rank-YYYY-MM-DD.log · ~/crawler/logs/run-rank.log (요약). 키는 ~/crawler/.env (RANK_WATCH_ENV)
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
JOB="$DASH/scripts/crawler-16gb/jobs/naver-rank-check.md"
RUN="$DASH/scripts/naver-rank-watch/run.ts"
TODAY=$(date +%Y-%m-%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/naver-rank-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-rank.log"
TARGETS="$OUT/naver_rank_targets.json"
BATCH=3
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
chrome_lock() {
  for i in {1..100}; do
    if mkdir "$CHROME_LOCK" 2>/dev/null; then trap 'rmdir "$CHROME_LOCK" 2>/dev/null' EXIT; return 0; fi
    if [[ $(( $(date +%s) - $(stat -f %m "$CHROME_LOCK") )) -gt 5400 ]]; then rmdir "$CHROME_LOCK" 2>/dev/null; continue; fi
    sleep 30
  done
  say "❌ 크롬 잠금을 50분 기다려도 안 풀림 ($CHROME_LOCK)"; return 1
}
if [[ ! -f "$JOB" || ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 ($DASH) — git pull + sparse-checkout add scripts/naver-rank-watch"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음"; exit 1; fi

cd "$DASH" || exit 1
LIM=(); [[ "$LIMIT" -gt 0 ]] && LIM=(--limit "$LIMIT")
RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --targets "$TARGETS" --batch "$BATCH" "${LIM[@]}" >> "$LOG" 2>&1
if [[ $? -ne 0 || ! -f "$TARGETS" ]]; then say "❌ 대상 뽑기 실패 (시트 '네이버 순위 키워드' 탭) — $LOG"; exit 1; fi
say "▶ $(tail -n 1 "$LOG")"

chrome_lock || exit 1
open -ga "Google Chrome"
sleep 10
cd "$CRAWLER" || exit 1
BLOCKED=0; DONE=0
for bf in "$OUT"/naver_rank_targets_batch_*.json; do
  n="${bf##*_batch_}"; n="${n%.json}"
  rf="$OUT/naver_rank_batch_${n}.json"
  if [[ -f "$rf" ]]; then say "묶음 $n 이미 있음 — 건너뜀"; DONE=$((DONE + 1)); continue; fi
  PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY
- 대상 파일: $bf  (이 파일의 키워드만, 순서대로)
- 결과 파일: $rf
"
  printf '%s' "$PROMPT" | claude -p --chrome \
    --allowedTools "mcp__claude-in-chrome" "Bash(sleep:*)" "Read" "Write" \
    --disallowedTools "WebFetch" "WebSearch" "Agent" \
    >> "$LOG" 2>&1
  code=$?
  if [[ -f "$rf" ]]; then DONE=$((DONE + 1)); say "묶음 $n ✅ (종료 코드 $code)"; else say "묶음 $n ❌ 결과 파일 없음 (종료 코드 $code)"; fi
  if grep -qE '"status": *"(captcha|blocked)"' "$rf" 2>/dev/null || grep -q "^차단:" "$LOG"; then BLOCKED=1; say "❌ 캡차·차단 감지 — 남은 묶음 중단"; break; fi
  sleep 5
done
rmdir "$CHROME_LOCK" 2>/dev/null

cd "$DASH" || exit 1
if [[ $NO_SEND -eq 1 ]]; then
  RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --compare --targets "$TARGETS" --results "$OUT" --date "$TODAY" --local-store "$CRAWLER/out/rank-store-test" --out "$OUT/naver_rank_report.json" >> "$LOG" 2>&1
  say "$([[ $? -eq 0 ]] && echo '✅' || echo '❌') 대조 검증 실행 (--no-send: Supabase·슬랙 없음, 메시지는 $LOG 에) · 묶음 $DONE 완료 · 차단 $BLOCKED"
  exit 0
fi
RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --compare --targets "$TARGETS" --results "$OUT" --date "$TODAY" --out "$OUT/naver_rank_report.json" --send >> "$LOG" 2>&1
C_EXIT=$?
say "$([[ $C_EXIT -eq 0 ]] && echo '✅' || echo '❌') 대조·슬랙 종료 코드 $C_EXIT · 묶음 $DONE 완료 · 차단 $BLOCKED"
exit $C_EXIT
