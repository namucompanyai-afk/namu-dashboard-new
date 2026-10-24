#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:15(morning, 2026-10-24 08:55→08:15: 키워드 사이 70~130초 쉬어서 9개에 15~20분 걸리니 08:40 쿠팡 작업·09:05 아침 보고서 전에 끝내려고)·12:30(noon) launchd: 네이버 쇼핑 키워드 순위 v2
#   (상품 목록 × 키워드 전체 매칭, 매회 전부 naver_rank_history 에 보존 — v1의 "키워드=상품 1개"와 다름, 2026-10-22)
#   1) run.ts --targets (나무_마스터 '네이버 순위 키워드' A·E + '네이버 상품' 탭 전체)
#   2) run.ts --fetch (16GB 실제 크롬을 AppleScript 로 조종 — v1과 같은 chrome-tab.applescript·extract-naver.js 재사용, 추출 코드 안 바뀜)
#   3) run.ts --store --run-slot morning|noon (매칭 → naver_rank_history 저장 → 슬랙. noon 은 아침 대비 변동 없으면 슬랙 생략)
#   시험: run-naver-rank-v2.sh --no-send [--limit 3] [--dump] → Supabase 안 쓰고(naver_rank_history 저장 X) 로그로만 확인
#   전제(16GB, v1과 공용 — 이미 돼 있으면 생략): 자동화 권한(osascript→Chrome) + Chrome 보기>개발자>"Apple Events 의 JavaScript 허용". SETUP.md 5번째 절
#   캡차(보안확인) 뜨면 그날 중단 + 슬랙 "🔒 네이버 보안확인(v2)" 1회(마커로 중복 방지) — v1 과 마커 파일을 분리해서 서로 안 섞임
# 결과 폴더: ~/crawler/out/YYYY-MM-DD/naver-rank-v2/<morning|noon>/ (v1 의 naver-rank 폴더·아침/낮끼리 분리 — 같은 날 batch 파일명이 같아서 안 겹치게)
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
OUT="$CRAWLER/out/$TODAY/naver-rank-v2/$RUN_SLOT"   # 아침·낮 결과 폴더 분리 (같은 폴더면 낮 실행이 아침 이어 읽기 파일을 지움)
LOG="$CRAWLER/logs/naver-rank-v2-$([[ $NOON -eq 1 ]] && echo noon- || echo "")$TODAY.log"
SUMMARY="$CRAWLER/logs/run-rank-v2.log"
TARGETS="$OUT/naver_rank_v2_targets.json"
mkdir -p "$OUT" "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
if [[ ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 ($RUN) — git pull + sparse-checkout add scripts/naver-rank-watch-v2 scripts/naver-rank-watch lib/naver"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음"; exit 1; fi

CAPTCHA_MARK="$CRAWLER/logs/.naver-captcha-v2"   # v1(.naver-captcha)과 분리 — 서로 안 섞임
webhook() { grep -E '^SLACK_REVIEW_WEBHOOK_URL=' "$CRAWLER/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'" ; }
source "${0:A:h}/chrome-lock.sh"   # 공용 크롬 잠금(주인 PID) — 2026-10-24 함수 안 trap 버그 수정
trap chrome_unlock EXIT

cd "$DASH" || exit 1
LIM=(); [[ "$LIMIT" -gt 0 ]] && LIM=(--limit "$LIMIT")
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --targets "$TARGETS" "${LIM[@]}" >> "$LOG" 2>&1
if [[ $? -ne 0 || ! -f "$TARGETS" ]]; then say "❌ 대상 뽑기 실패(시트 '네이버 순위 키워드'·'네이버 상품' 탭) — $LOG"; exit 1; fi
say "▶ $(tail -n 1 "$LOG")"
rm -f "$OUT"/naver_rank_batch_*.json
chrome_lock || exit 1
open -ga "Google Chrome"
sleep 8
# 로그는 하루치가 한 파일에 이어 붙는다 → 이번 실행에서 새로 붙은 줄만 본다
LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --fetch --targets "$TARGETS" --results "$OUT" "${DUMP[@]}" >> "$LOG" 2>&1
F_EXIT=$?
chrome_unlock
say "$([[ $F_EXIT -eq 0 ]] && echo '✅' || echo '❌') $(tail -n 2 "$LOG" | head -n 1)"

# 못 읽은 키워드가 있으면(캡차·오류) 90분 뒤 남은 것만 이어 읽는다 — 캡차를 풀려는 게 아니라 간격을 두고 덜 걸리게 (2026-10-24)
READ_LINE=$(tail -n +$((LOG_START + 1)) "$LOG" 2>/dev/null | grep -o 'NAVER_V2_READ [0-9]*/[0-9]*' | tail -1)
OKN=${${READ_LINE#NAVER_V2_READ }%/*}; TOT=${READ_LINE#*/}
RETRY=0; RETRY_AT=""; RETRY_DELAY_SEC=${RETRY_DELAY_SEC:-5400}
if [[ -n "$READ_LINE" && "$TOT" -gt 0 && "$OKN" -lt "$TOT" && ( $NO_SEND -eq 0 || -n "${RETRY_TEST:-}" ) ]]; then
  RETRY=1; RETRY_AT=$(date -v+${RETRY_DELAY_SEC}S +%H:%M)
fi

# 캡차 감지 알림 (하루 1번 — 마커). 1차 읽기와 이어 읽기 둘 다에서 부른다: 이어 읽기에서 "처음" 뜬 캡차도 알려야 함
captcha_alert() {  # $1=읽은 N  $2=전체 M  $3=재시도 시각(없으면 빈 값)  $4=retry 면 이어 읽기 결과 파일(02~)만 본다 — 1차 파일의 옛 캡차 기록을 다시 세지 않게
  local files
  if [[ "${4:-}" == "retry" ]]; then files=("$OUT"/naver_rank_batch_0[2-9].json "$OUT"/naver_rank_batch_[1-9][0-9].json); else files=("$OUT"/naver_rank_batch_*.json); fi
  [[ ${#files[@]} -gt 0 ]] && grep -q '"status": *"captcha"' "${files[@]}" 2>/dev/null || return 0
  say "🔒 네이버 캡차(보안확인) 감지(v2) — 읽은 키워드 ${1:-?}/${2:-?}$([[ -n "$3" ]] && echo ", 나머지 $3 자동 재시도")"
  if [[ "$(cat "$CAPTCHA_MARK" 2>/dev/null)" != "$TODAY" && $NO_SEND -eq 0 ]]; then
    local url msg; url=$(webhook)
    if [[ -n "$url" ]]; then
      msg="🔒 네이버 보안확인(v2) — 읽은 키워드 ${1:-?}/${2:-?}$([[ -n "$3" ]] && echo ", 나머지 $3 자동 재시도(1회). 계속 걸리면 16GB 크롬에서 한 번 풀어줘야 함" || echo " — 16GB 크롬에서 한 번 풀어줘야 함")"
      curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"text\":\"$msg\"}" "$url" && echo "$TODAY" > "$CAPTCHA_MARK"
    fi
  fi
}
captcha_alert "$OKN" "$TOT" "$RETRY_AT"

DRY=(); [[ $NO_SEND -eq 1 ]] && DRY=(--dry-run)
SEND=(); [[ $NO_SEND -eq 0 ]] && SEND=(--send)
RETRY_ARGS=(); [[ $RETRY -eq 1 ]] && RETRY_ARGS=(--retry-at "$RETRY_AT")
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --store --targets "$TARGETS" --results "$OUT" --run-slot "$RUN_SLOT" --date "$TODAY" --out "$OUT/naver_rank_v2_report_$RUN_SLOT.json" "${DRY[@]}" "${SEND[@]}" "${RETRY_ARGS[@]}" >> "$LOG" 2>&1
S_EXIT=$?
say "$([[ $S_EXIT -eq 0 ]] && echo '✅' || echo '❌') 저장·슬랙($RUN_SLOT) 종료 코드 $S_EXIT$([[ $NO_SEND -eq 1 ]] && echo ' (--no-send: naver_rank_history 저장 안 함, 슬랙 안 보냄)')"
[[ $RETRY -eq 0 ]] && exit $S_EXIT

# ── 이어 읽기 (하루 1번, 같은 실행 안에서 한 번만) ─────────────────────────────
say "⏳ 못 읽은 $((TOT - OKN))개 — $RETRY_AT 에 이어 읽기 (크롬 잠금은 쉬는 동안 풀어 둠)"
sleep "$RETRY_DELAY_SEC"
chrome_lock || exit 1
open -ga "Google Chrome"
sleep 8
LOG_START=$(wc -l < "$LOG" 2>/dev/null | tr -d ' '); LOG_START=${LOG_START:-0}
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --fetch --resume --targets "$TARGETS" --results "$OUT" "${DUMP[@]}" >> "$LOG" 2>&1
R_EXIT=$?
chrome_unlock
say "$([[ $R_EXIT -eq 0 ]] && echo '✅' || echo '❌') 이어 읽기: $(tail -n 2 "$LOG" | head -n 1)"
captcha_alert "?" "$TOT" "" retry   # 이어 읽기에서 처음 뜬 캡차도 알림(오늘 이미 알렸으면 마커로 생략)
RANK_WATCH_V2_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --store --targets "$TARGETS" --results "$OUT" --run-slot "$RUN_SLOT" --date "$TODAY" --out "$OUT/naver_rank_v2_report_${RUN_SLOT}_retry.json" "${DRY[@]}" "${SEND[@]}" --retry-done >> "$LOG" 2>&1
S2=$?
say "$([[ $S2 -eq 0 ]] && echo '✅' || echo '❌') 이어 읽은 뒤 저장·슬랙($RUN_SLOT) 종료 코드 $S2"
exit $S2
