#!/bin/zsh
# 16GB 크롤링 맥 — 서플라이어허브 '판매 분석' export 받기 (월요일 09:10 launchd, 또는 손으로)
#   run-weekly-sales.sh                       → 지난주 월~일 (launchd 기본)
#   run-weekly-sales.sh --range 4w            → 최근 4주 (오늘-28일 ~ 어제)
#   run-weekly-sales.sh --range 30d           → 최근 N일 (오늘-N ~ 어제)
#   run-weekly-sales.sh --start 2026-10-01 --end 2026-10-19
#   --no-send                                 → 슬랙 안 보냄 (시험·1회용)
# 1차 범위: 파일만 받아 ~/crawler/out/오늘/ 에 두고(+기간 메모 json) Watchman 슬랙 1줄. 수집기(namu-ingest)는 아직 없어서
#   24GB 로는 브레인이 scp 로 가져가 ~/NamuData/sales_1p_weekly/ 에 둔다 (SETUP.md 4번째 작업).
# 로그: ~/crawler/logs/hub-sales-YYYY-MM-DD.log · ~/crawler/logs/run-sales.log (요약). 금액은 로그·슬랙에 안 찍는다 (행 수만).
set -u
setopt null_glob
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0; RANGE="lastweek"; START=""; END=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-send) NO_SEND=1 ;;
    --range) RANGE="$2"; shift ;;
    --start) START="$2"; shift ;;
    --end) END="$2"; shift ;;
  esac
  shift
done

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
JOB="$DASH/scripts/crawler-16gb/jobs/hub-sales-export.md"
TODAY=$(date +%Y-%m-%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/hub-sales-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-sales.log"
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
webhook() { grep -E '^SLACK_REVIEW_WEBHOOK_URL=' "$CRAWLER/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'" ; }
slack() {
  [[ $NO_SEND -eq 1 ]] && { say "슬랙 생략 (--no-send): $1"; return; }
  local url; url=$(webhook)
  if [[ -z "$url" ]]; then say "❌ .env 에 SLACK_REVIEW_WEBHOOK_URL 없음 — 슬랙 못 보냄"; return; fi
  curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"text\":\"$1\"}" "$url" && say "슬랙 보냄: $1" || say "❌ 슬랙 전송 실패"
}

# 기간
if [[ -z "$START" || -z "$END" ]]; then
  case "$RANGE" in
    lastweek) U=$(date +%u); OFF=$(( (U - 1) + 7 )); START=$(date -v-${OFF}d +%Y-%m-%d); END=$(date -v-$((OFF - 6))d +%Y-%m-%d) ;;
    4w) START=$(date -v-28d +%Y-%m-%d); END=$(date -v-1d +%Y-%m-%d) ;;
    *d) N="${RANGE%d}"; START=$(date -v-${N}d +%Y-%m-%d); END=$(date -v-1d +%Y-%m-%d) ;;
    *) say "❌ --range 는 lastweek | 4w | <N>d"; exit 2 ;;
  esac
fi
PERIOD_FILE="$OUT/hub_sales_${START//-/}_${END//-/}.period.json"

if [[ ! -f "$JOB" ]]; then say "❌ 지시문 없음 ($JOB) — git pull"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음 — SETUP.md 5번"; exit 1; fi
# 세션 유지 작업(7번째)이 로그인 풀림을 미리 표시해 둠 — 참고만, 그래도 시도는 한다
[[ -f "$CRAWLER/logs/.session-hub-expired" ]] && say "참고: 허브(SUPPLIER HUB) 로그인이 최근 점검에서 풀려 있었음(세션 유지 작업 기록) — 그래도 시도함"

# 크롬 확장은 클로드 세션 하나씩만 (다른 크롤링과 잠금 공유, 최대 50분 대기)
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
chrome_lock() {
  for i in {1..100}; do
    if mkdir "$CHROME_LOCK" 2>/dev/null; then trap 'rmdir "$CHROME_LOCK" 2>/dev/null' EXIT; return 0; fi
    if [[ $(( $(date +%s) - $(stat -f %m "$CHROME_LOCK") )) -gt 5400 ]]; then rmdir "$CHROME_LOCK" 2>/dev/null; continue; fi
    sleep 30
  done
  say "❌ 크롬 잠금을 50분 기다려도 안 풀림 ($CHROME_LOCK)"; return 1
}
chrome_lock || exit 1
open -ga "Google Chrome"
sleep 10

RUN_STAMP=$(date +%Y%m%d%H%M%S)
say "▶ 허브 판매 분석 export 시작 (${START}~${END}, ${RANGE})"
cd "$CRAWLER" || exit 1
PROMPT="$(cat "$JOB")

---
[이번 실행 값]
- 오늘: $TODAY · 실행 시작 시각: $RUN_STAMP (파일명 뒤 14자리가 이 값 이상인 파일만 이번 것)
- 기간: 시작일 $START · 종료일 $END · 기간 메모: $RANGE
- 저장 폴더: $OUT
- 기간 메모 파일: $PERIOD_FILE
"
# 이번 실행에서 새로 붙은 줄만 보고 판정 (로그는 하루치가 한 파일에 이어 붙음 — 10/23 아침 실패 문구가 남아 오판정)
LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
printf '%s' "$PROMPT" | claude -p --chrome \
  --add-dir "$HOME/Downloads" \
  --allowedTools "mcp__claude-in-chrome" "Bash(ls:*)" "Bash(mv:*)" "Bash(mkdir:*)" "Bash(wc:*)" "Bash(sleep:*)" "Read" "Write" \
  --disallowedTools "WebFetch" "WebSearch" "Agent" \
  >> "$LOG" 2>&1
say "클로드 종료 코드 $? (자세한 건 $LOG)"
rmdir "$CHROME_LOCK" 2>/dev/null

# 클로드 자기 보고와 별개로 파일 확인 — 이번 실행 이후 시각의 export 1개
GOT=""
for f in "$OUT"/A00993784_SALES_ANALYSIS_BY_PRODUCT_*.csv; do
  ts="${f##*_}"; ts="${ts%.csv}"
  [[ "$ts" -ge "$RUN_STAMP" ]] && GOT="$f"
done
if [[ -z "$GOT" ]]; then
  if { tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -q "허브 로그인 필요"; }; then say "❌ 파일 없음 — 형, 허브 로그인 필요 (16GB 크롬)"; slack "*[허브 판매 분석]* ${START}~${END} export 못 받음 — 16GB 허브 로그인 필요"
  elif { tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -q "차단"; }; then say "❌ 파일 없음 — 허브 차단(Access Denied). 크롬 재시작 후 다시"; slack "*[허브 판매 분석]* ${START}~${END} export 못 받음 — 허브 차단, 크롬 재시작 필요"
  else say "❌ 파일 없음 — 다운로드 실패 (로그 확인)"; slack "*[허브 판매 분석]* ${START}~${END} export 못 받음 — 로그 확인 필요"
  fi
  exit 1
fi
ROWS=$(( $(wc -l < "$GOT") - 1 ))
[[ -f "$PERIOD_FILE" ]] || printf '{"file":"%s","start":"%s","end":"%s","range":"%s","downloadedAt":"%s"}\n' "$(basename "$GOT")" "$START" "$END" "$RANGE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PERIOD_FILE"
say "✅ $(basename "$GOT") · 기간 ${START}~${END} · 행 $ROWS"
slack "*[허브 판매 분석]* ${START}~${END} export 받음 — ${ROWS}행, 16GB ~/crawler/out/${TODAY}/ (24GB NamuData 로 가져가기)"
exit 0
