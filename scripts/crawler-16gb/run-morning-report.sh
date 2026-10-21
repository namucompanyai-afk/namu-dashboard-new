#!/bin/zsh
# 16GB 크롤링 맥 — 매일 09:05 launchd: 아침 보고서(전원 공유, 손익 없음) 조립 → #쿠팡-결합 슬랙 1장. node 만 씀(크롬 불필요).
#   그날 이미 저장된 결과(재고·결합·페이지 순회·네이버 순위·어제 광고)를 모아 한 장으로. 새 크롤링 없음.
#   시험: run-morning-report.sh --no-send [--date YYYY-MM-DD]
# 로그: ~/crawler/logs/morning-report-YYYY-MM-DD.log · ~/crawler/logs/run-morning.log (요약)
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NO_SEND=0; DATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-send) NO_SEND=1 ;;
    --date) DATE="$2"; shift ;;
  esac
  shift
done
CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
RUN="$DASH/scripts/coupang-morning-report/run.ts"
TODAY=$(date +%Y-%m-%d)
D="${DATE:-$TODAY}"
LOG="$CRAWLER/logs/morning-report-$D.log"
SUMMARY="$CRAWLER/logs/run-morning.log"
mkdir -p "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$SUMMARY"; }
if [[ ! -f "$RUN" ]]; then say "❌ 저장소 파일 없음 — git pull + sparse-checkout add scripts/coupang-morning-report lib/coupang/morningReport.ts"; exit 1; fi
if [[ ! -f "$CRAWLER/.env" ]]; then say "❌ ~/crawler/.env 없음"; exit 1; fi

cd "$DASH" || exit 1
SEND=(); [[ $NO_SEND -eq 0 ]] && SEND=(--send)
MORNING_REPORT_ENV="$CRAWLER/.env" npx --yes tsx "$RUN" --date "$D" --markers-dir "$CRAWLER/logs" --out "$CRAWLER/out/$D/morning_report.json" "${SEND[@]}" >> "$LOG" 2>&1
EXIT=$?
tail -n 3 "$LOG" | sed 's/^/    /' | tee -a "$SUMMARY"
say "$([[ $EXIT -eq 0 ]] && echo '✅' || echo '❌') 아침 보고서 종료 코드 $EXIT (자세한 건 $LOG)"
exit $EXIT
