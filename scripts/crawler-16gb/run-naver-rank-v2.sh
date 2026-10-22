#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:55(morning)·12:30(noon) launchd: 네이버 쇼핑 키워드 순위 v2
#   (상품 목록 × 키워드 전체 매칭, 매회 전부 naver_rank_history 에 보존 — v1의 "키워드=상품 1개"와 다름, 2026-10-22)
#   1) run.ts --targets (나무_마스터 '네이버 순위 키워드' A·E + '네이버 상품' 탭 전체)
#   2) run.ts --fetch (16GB 실제 크롬을 AppleScript 로 조종 — v1과 같은 chrome-tab.applescript·extract-naver.js 재사용, 추출 코드 안 바뀜)
#   3) run.ts --store --run-slot morning|noon (매칭 → naver_rank_history 저장 → 슬랙. noon 은 아침 대비 변동 없으면 슬랙 생략)
#   시험: run-naver-rank-v2.sh --no-send [--limit 3] [--dump] → Supabase 안 쓰고(naver_rank_history 저장 X) 로그로만 확인
#   전제(16GB, v1과 공용 — 이미 돼 있으면 생략): 자동화 권한(osascript→Chrome) + Chrome 보기>개발자>"Apple Events 의 JavaScript 허용". SETUP.md 5번째 절
#   캡차(보안확인) 뜨면 그날 중단 + 슬랙 "🔒 네이버 보안확인(v2)" 1회(마커로 중복 방지) — v1 과 마커 파일을 분리해서 서로 안 섞임
# 결과 폴더: ~/crawler/out/YYYY-MM-DD/naver-rank-v2/ (v1 의 naver-rank 폴더와 분리 — 같은 날 batch 파일명이 같아서 안 겹치게)
# 로그: ~/crawler/logs/naver-rank-v2-YYYY-MM-DD.log · ~/crawler/logs/run-rank-v2.log (요약)
set -u
setopt null_glob 2>/dev/null  # 매칭 없는 글롭을 빈 값으로(기본 zsh는 "no matches found" 에러 — 첫 실행 등 naver_rank_batch_*.json 이 없을 때 대비)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0; LIMIT=0; DUMP=(); NOON=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-send) NO_SEND=1 ;;
    --limit) LIMIT="$2"; shift ;;
    --dump) DUMP=(--dump) ;;
    --noon) NOON=1 ;;   # 12:30 — 오늘 아침(morning) 대비 바뀐 키워드만, 없으면 슬랙 생략
  esac
  shift
done
CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
RUN="$DASH/scripts/naver-rank-watch-v2/run.ts"
TODAY=$(date +%Y-%m-%d)
RUN_SLOT=$([[ $NOON -eq 1 ]] && echo noon || echo morning)
OUT="$CRAWLER/out/$TODAY/naver-rank-v2"
LOG="$CRAWLER/logs/naver-rank-v2-$([[ $NOON -eq 1 ]] && echo noon- || echo "")$TODAY.log"
SUMMARY="$CRAWLER/logs/run-rank-v2.log"
TARGETS="$OUT/naver_rank_v2_targets.json"
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
if [[ ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 ($RUN) — git pull + sparse-checkout add scripts/naver-rank-watch-v2 scripts/naver-rank-watch lib/naver"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음"; exit 1; fi

CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
CAPTCHA_MARK="$CRAWLER/logs/.naver-captcha-v2"   # v1(.naver-captcha)과 분리 — 서로 안 섞임
webhook() { grep -E '^SLACK_REVIEW_WEBHOOK_URL=' "$CRAWLER/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'" ; }
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
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --targets "$TARGETS" "${LIM[@]}" >> "$LOG" 2>&1
if [[ $? -ne 0 || ! -f "$TARGETS" ]]; then say "❌ 대상 뽑기 실패(시트 '네이버 순위 키워드'·'네이버 상품' 탭) — $LOG"; exit 1; fi
say "▶ $(tail -n 1 "$LOG")"
rm -f "$OUT"/naver_rank_batch_*.json
chrome_lock || exit 1
open -ga "Google Chrome"
sleep 8
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --fetch --targets "$TARGETS" --results "$OUT" "${DUMP[@]}" >> "$LOG" 2>&1
F_EXIT=$?
rmdir "$CHROME_LOCK" 2>/dev/null
say "$([[ $F_EXIT -eq 0 ]] && echo '✅' || echo '❌') $(tail -n 1 "$LOG")"
BATCH_FILES=("$OUT"/naver_rank_batch_*.json)
if [[ ${#BATCH_FILES[@]} -gt 0 ]] && grep -q '"status": *"captcha"' "${BATCH_FILES[@]}" 2>/dev/null; then
  say "🔒 네이버 캡차(보안확인) 감지(v2) — 16GB 크롬에서 한 번 풀어줘야 함"
  if [[ "$(cat "$CAPTCHA_MARK" 2>/dev/null)" != "$TODAY" && $NO_SEND -eq 0 ]]; then
    url=$(webhook)
    if [[ -n "$url" ]]; then
      curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data '{"text":"🔒 네이버 보안확인(v2) — 16GB 크롬에서 한 번 풀어줘야 함"}' "$url" && echo "$TODAY" > "$CAPTCHA_MARK"
    fi
  fi
fi

DRY=(); [[ $NO_SEND -eq 1 ]] && DRY=(--dry-run)
SEND=(); [[ $NO_SEND -eq 0 ]] && SEND=(--send)
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --store --targets "$TARGETS" --results "$OUT" --run-slot "$RUN_SLOT" --date "$TODAY" --out "$OUT/naver_rank_v2_report_$RUN_SLOT.json" "${DRY[@]}" "${SEND[@]}" >> "$LOG" 2>&1
S_EXIT=$?
say "$([[ $S_EXIT -eq 0 ]] && echo '✅' || echo '❌') 저장·슬랙($RUN_SLOT) 종료 코드 $S_EXIT$([[ $NO_SEND -eq 1 ]] && echo ' (--no-send: naver_rank_history 저장 안 함, 슬랙 안 보냄)')"
exit $S_EXIT
