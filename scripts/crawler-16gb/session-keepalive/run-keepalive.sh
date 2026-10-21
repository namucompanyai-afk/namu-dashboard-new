#!/bin/zsh
# 16GB 크롤링 맥 — 20분마다(launchd StartInterval) wing·허브·광고센터 홈을 실제 크롬으로 열어 로그인 유지 확인 (AppleScript, 확장 안 씀)
#   로그인 폼이 보이면(세션 풀림) 그 사이트 마커 생성 + 슬랙 "🔑 로그인 풀림" 1줄(그날 1회만) → 다른 작업(08:45 윙·10:00 광고센터 등)이 시작 전 마커로 미리 안다
#   다른 크롤링 작업이 크롬을 쓰는 중이면 기다리지 않고 이번 주기는 건너뜀(20분 뒤 다시) — 다른 작업을 방해하지 않는다
# 로그: ~/crawler/logs/keepalive.log (한 줄씩, 로그인 유지 시간 측정용) · 마커: ~/crawler/logs/.session-<site>-expired
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CRAWLER="$HOME/crawler"
DASH="$CRAWLER/dashboard"
APPLESCRIPT="$DASH/scripts/naver-rank-watch/chrome-tab.applescript"
JS="$DASH/scripts/crawler-16gb/session-keepalive/check-login.js"
LOG="$CRAWLER/logs/keepalive.log"
mkdir -p "$CRAWLER/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')	$*" | tee -a "$LOG"; }
webhook() { grep -E '^SLACK_REVIEW_WEBHOOK_URL=' "$CRAWLER/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'" ; }
slack1() {  # $1=문구 $2=마커파일 — 마커 없을 때만(오늘 1회), 생기면 건드리지 않음
  [[ -f "$2" ]] && return
  date +%F > "$2"
  local url; url=$(webhook); [[ -z "$url" ]] && return
  curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"text\":\"$1\"}" "$url" || true
}

if [[ ! -f "$APPLESCRIPT" || ! -f "$JS" ]]; then say "❌ 저장소 파일 없음 — git pull"; exit 1; fi

# 다른 크롤링 작업과 크롬 잠금 공유 — 바쁘면 기다리지 않고 이번 주기 건너뜀(20분 뒤 다시 옴)
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"
if ! mkdir "$CHROME_LOCK" 2>/dev/null; then
  if [[ $(( $(date +%s) - $(stat -f %m "$CHROME_LOCK") )) -le 5400 ]]; then say "건너뜀 — 크롬 사용 중"; exit 0; fi
  rmdir "$CHROME_LOCK" 2>/dev/null
  mkdir "$CHROME_LOCK" 2>/dev/null || { say "건너뜀 — 크롬 사용 중"; exit 0; }
fi
trap 'rmdir "$CHROME_LOCK" 2>/dev/null' EXIT
open -ga "Google Chrome"
sleep 5

check() {  # $1=사이트이름 $2=URL
  local marker="$CRAWLER/logs/.session-$1-expired"
  local raw
  raw=$(osascript "$APPLESCRIPT" "$2" "$JS" 6 2>>"$LOG")
  if [[ "$raw" == __ERROR__* ]]; then say "$1	확인 실패	$raw"; return; fi
  if echo "$raw" | grep -q '"loggedOut":true'; then
    say "$1	풀림"
    slack1 "🔑 ${1} 로그인 풀림 — 16GB 에서 재로그인 필요" "$marker"
  else
    say "$1	유지됨"
    if [[ -f "$marker" ]]; then rm -f "$marker"; say "$1	복구됨(마커 지움)"; fi
  fi
}

check wing "https://wing.coupang.com"
sleep 3
check hub "https://supplier.coupang.com"
sleep 3
check adcenter "https://advertising.coupang.com"
