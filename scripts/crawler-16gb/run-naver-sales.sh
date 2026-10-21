#!/bin/zsh
# 16GB 크롤링 맥 — 매일 08:42 launchd: 네이버 커머스 API 어제 결제완료 상품주문 수집 → naver_product_orders 업로드
#   아침 보고서(09:05) ① 칸의 입력. 크롬 불필요(node 만) — 08:40 어제 광고(crawler-ad-daily)와 겹쳐도 무방(서로 다른 리소스).
#   시험: run-naver-sales.sh --no-upload → Supabase 안 쓰고 요약만 출력
#        run-naver-sales.sh --date 2026-10-20 → 특정 날짜 재수집(백필)
# 로그: ~/crawler/logs/naver-sales-YYYY-MM-DD.log · ~/crawler/logs/run-naver-sales.log (요약)
#       토큰 발급 실패(IP 차단·시크릿 만료 등)면 ~/crawler/logs/.naver-api-failed-YYYY-MM-DD 마커 + 슬랙 1줄(하루 1회)
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_UPLOAD=0; DATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-upload) NO_UPLOAD=1 ;;
    --date) DATE="$2"; shift ;;
  esac
  shift
done

CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
RUN="$DASH/scripts/naver-sales-collect/run.ts"
D="${DATE:-$(date -v-1d +%Y-%m-%d)}"
LOG="$CRAWLER/logs/naver-sales-$D.log"
SUMMARY="$CRAWLER/logs/run-naver-sales.log"
mkdir -p "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }

if [[ ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 — git pull + sparse-checkout add scripts/naver-sales-collect scripts/coupang-morning-report lib/naver"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음"; exit 1; fi

cd "$DASH" || exit 1
ARGS=(--date "$D" --markers-dir "$CRAWLER/logs")
[[ $NO_UPLOAD -eq 1 ]] && ARGS+=(--dry-run)
NAVER_SALES_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" "${ARGS[@]}" >> "$LOG" 2>&1
EXIT=$?
tail -n 3 "$LOG" | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $EXIT -eq 0 ]] && echo '✅' || echo '❌') 네이버 주문 수집 종료 코드 $EXIT (자세한 건 $LOG)"
exit $EXIT
