#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:15 launchd: 네이버 쇼핑 키워드 순위(광고 제외) → 어제 대비 → 슬랙
#   1) run.ts --targets (나무_마스터 '네이버 순위 키워드' 탭) → 2) run.ts --fetch (16GB 실제 크롬을 AppleScript 로 조종 — 클로드 확장 안 씀)
#   3) run.ts --compare --send (직전 스냅샷 비교 → naver_rank_YYYY-MM-DD 저장 → 슬랙)
#   시험: run-daily-rank.sh --no-send [--limit 3] [--dump] → Supabase·슬랙 없이 로컬 저장소 (+ 목록 innerHTML 저장)
#   전제(16GB 1회): 자동화 권한(osascript→Chrome) + Chrome 보기>개발자>"Apple Events 의 JavaScript 허용". SETUP.md 5번째 절
#   크롬 확장은 네이버를 거부, Playwright 는 캡차, 쇼핑 검색 API 는 2026-07 종료 → 이 방식(10/21)
# 로그: ~/crawler/logs/naver-rank-YYYY-MM-DD.log · ~/crawler/logs/run-rank.log (요약)
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0; LIMIT=0; DUMP=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-send) NO_SEND=1 ;;
    --limit) LIMIT="$2"; shift ;;
    --dump) DUMP=(--dump) ;;
  esac
  shift
done
CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
RUN="$DASH/scripts/naver-rank-watch/run.ts"
TODAY=$(date +%Y-%m-%d)
OUT="$CRAWLER/out/$TODAY"
LOG="$CRAWLER/logs/naver-rank-$TODAY.log"
SUMMARY="$CRAWLER/logs/run-rank.log"
TARGETS="$OUT/naver_rank_targets.json"
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
if [[ ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 ($RUN) — git pull + sparse-checkout add scripts/naver-rank-watch"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음"; exit 1; fi
# 크롬은 한 번에 한 작업만 (클로드 확장 작업과 탭이 섞이지 않게) — 다른 크롤링과 잠금 공유
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
chrome_lock() {
  for i in {1..100}; do
    if mkdir "$CHROME_LOCK" 2>/dev/null; then trap 'rmdir "$CHROME_LOCK" 2>/dev/null' EXIT; return 0; fi
    if [[ $(( $(date +%s) - $(stat -f %m "$CHROME_LOCK") )) -gt 5400 ]]; then rmdir "$CHROME_LOCK" 2>/dev/null; continue; fi
    sleep 30
  done
  say "❌ 크롬 잠금을 50분 기다려도 안 풀림 ($CHROME_LOCK)"; return 1
}

cd "$DASH" || exit 1
LIM=(); [[ "$LIMIT" -gt 0 ]] && LIM=(--limit "$LIMIT")
RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --targets "$TARGETS" --batch 100 "${LIM[@]}" >> "$LOG" 2>&1
if [[ $? -ne 0 || ! -f "$TARGETS" ]]; then say "❌ 대상 뽑기 실패 (시트 '네이버 순위 키워드' 탭) — $LOG"; exit 1; fi
say "▶ $(tail -n 1 "$LOG")"
rm -f "$OUT"/naver_rank_batch_*.json
chrome_lock || exit 1
open -ga "Google Chrome"
sleep 8
RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --fetch --targets "$TARGETS" --results "$OUT" "${DUMP[@]}" >> "$LOG" 2>&1
F_EXIT=$?
rmdir "$CHROME_LOCK" 2>/dev/null
say "$([[ $F_EXIT -eq 0 ]] && echo '✅' || echo '❌') $(tail -n 1 "$LOG")"
if [[ $NO_SEND -eq 1 ]]; then
  RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --compare --targets "$TARGETS" --results "$OUT" --date "$TODAY" --local-store "$CRAWLER/out/rank-store-test" --out "$OUT/naver_rank_report.json" >> "$LOG" 2>&1
  say "$([[ $? -eq 0 ]] && echo '✅' || echo '❌') 대조 검증 실행 (--no-send: Supabase·슬랙 없음, 메시지는 $LOG 에)"
  exit 0
fi
RANK_WATCH_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --compare --targets "$TARGETS" --results "$OUT" --date "$TODAY" --out "$OUT/naver_rank_report.json" --send >> "$LOG" 2>&1
C_EXIT=$?
say "$([[ $C_EXIT -eq 0 ]] && echo '✅' || echo '❌') 대조·슬랙 종료 코드 $C_EXIT"
exit $C_EXIT
