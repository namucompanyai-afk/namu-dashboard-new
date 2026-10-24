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

# ── 자동 재로그인 (2026-10-24, D안): 풀림 감지 → 키체인 비번으로 로그인 1회 ───────────────
#   · 풀림 1회당 사이트별 1번만(마커 .relogin-tried-<site>, 로그인이 확인되면 지움) — 실패해도 다음 주기에 다시 두드리지 않음(계정 잠김 방지)
#   · 비번은 키체인(namu-coupang-xauth)에서 읽어 환경변수로만 넘김. 파일·로그·슬랙에 안 적음. 로그엔 "성공/실패/이유"만
#   · 인증번호·보안문자·추가 입력이 뜨면 즉시 멈춤 · 끄기: 환경변수 KEEPALIVE_NO_RELOGIN=1
#   · 성공·실패 모두 매번 슬랙 1줄 (성공 "✅ 윙 자동 로그인함 HH:MM" / 실패 "🔑 윙 자동 로그인 실패 — 16GB에서 직접 로그인 필요 (사유: …)")
RELOGIN_AS="$DASH/scripts/crawler-16gb/session-keepalive/relogin.applescript"
RELOGIN_FILL="$DASH/scripts/crawler-16gb/session-keepalive/relogin-fill.js"
RELOGIN_STATE="$DASH/scripts/crawler-16gb/session-keepalive/relogin-state.js"
KEYCHAIN_SVC="namu-coupang-xauth"
slack_now() {  # $1=문구 — 하루 1회 규칙 없이 바로 (성공 알림 용)
  local url; url=$(webhook); [[ -z "$url" ]] && return
  curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"text\":\"$1\"}" "$url" || true
}
# 사이트 이름 → 알림에 쓰는 한글 이름
site_ko() { case "$1" in wing) echo "윙" ;; adcenter) echo "광고센터" ;; *) echo "$1" ;; esac }
relogin_fail() {  # $1=사이트 $2=사유(인증번호/비번 오류/화면 인식 실패/키체인 읽기 실패 …) $3=keepalive.log 에 남길 상세
  local k; k=$(site_ko "$1")
  say "$1	자동 재로그인 실패 — $3"
  slack_now "🔑 ${k} 자동 로그인 실패 — 16GB에서 직접 로그인 필요 (사유: $2)"
}
try_relogin() {  # $1=사이트이름 $2=URL → 0=로그인 성공 / 1=못 함
  local site="$1" url="$2" tried="$CRAWLER/logs/.relogin-tried-$1"
  [[ -n "${KEEPALIVE_NO_RELOGIN:-}" ]] && return 1
  [[ ! -f "$RELOGIN_AS" || ! -f "$RELOGIN_FILL" || ! -f "$RELOGIN_STATE" ]] && return 1
  if [[ -f "$tried" ]]; then say "$site	자동 재로그인 건너뜀 — 이번 풀림에서 이미 시도함"; return 1; fi
  : > "$tried"   # 시도 전에 먼저 표시 (중간에 죽어도 반복 안 함)
  local out cid cpw raw rc
  # 비번은 정식 통로(kc-read.sh)로만 읽는다 — 읽을 때마다 감사 로그 1줄, 이상이면 거부+즉시 슬랙 ⚠️ (kc-read.sh 머리말 참고)
  out=$("$DASH/scripts/crawler-16gb/session-keepalive/kc-read.sh" "$site" 2>/dev/null); rc=$?
  cid="${out%%$'\n'*}"; cpw="${out#*$'\n'}"; out=""
  if [[ $rc -ne 0 || -z "$cid" || -z "$cpw" ]]; then
    unset cid cpw
    if [[ $rc -eq 3 ]]; then relogin_fail "$site" "이상 감지로 비번 읽기 거부" "이상 감지로 거부됨 (감사 로그·⚠️ 알림 확인)"
    else relogin_fail "$site" "키체인 읽기 실패" "키체인 읽기 실패 ($KEYCHAIN_SVC)"; fi
    return 1
  fi
  raw=$(COUPANG_ID="$cid" COUPANG_PW="$cpw" osascript "$RELOGIN_AS" "$url" "$RELOGIN_FILL" "$RELOGIN_STATE" 2>/dev/null)
  unset cid cpw
  local fillok=0 filled=0
  echo "$raw" | grep -q '"ok":true' && fillok=1
  echo "$raw" | grep -q '"idFilled":true,"pwFilled":true' && filled=1
  if [[ "$raw" == __ERROR__* ]]; then relogin_fail "$site" "화면 인식 실패" "${raw%%$'\n'*}"; return 1; fi
  if [[ $fillok -eq 0 ]]; then relogin_fail "$site" "화면 인식 실패" "로그인 칸/버튼을 못 찾음 ($(echo "$raw" | grep -o '"reason":"[a-z_]*"' | head -1))"; return 1; fi
  if [[ $filled -eq 0 ]]; then relogin_fail "$site" "화면 인식 실패" "칸 채우기가 안 먹음(빈 칸)"; return 1; fi
  if echo "$raw" | grep -q '"challenge":true'; then relogin_fail "$site" "인증번호" "추가 인증(인증번호/보안문자) 화면"; return 1; fi
  if echo "$raw" | grep -q '"badCred":true'; then relogin_fail "$site" "비번 오류" "아이디/비밀번호가 맞지 않음(키체인 값 확인)"; return 1; fi
  if echo "$raw" | grep -q '"loggedIn":true'; then
    say "$site	자동 복구됨 (자동 재로그인 성공)"
    rm -f "$CRAWLER/logs/.session-$site-expired" "$tried"
    slack_now "✅ $(site_ko "$site") 자동 로그인함 $(date +%H:%M)"
    return 0
  fi
  relogin_fail "$site" "화면 인식 실패" "결과 불명 — 아직 로그인 화면(다음 점검에서 확인)"
  return 1
}

RECOVERED=0
check() {  # $1=사이트이름 $2=URL
  local marker="$CRAWLER/logs/.session-$1-expired"
  local raw
  raw=$(osascript "$APPLESCRIPT" "$2" "$JS" 6 2>>"$LOG")
  if [[ "$raw" == __ERROR__* ]]; then say "$1	확인 실패	$raw"; return; fi
  if echo "$raw" | grep -q '"loggedOut":true'; then
    say "$1	풀림"
    slack1 "🔑 ${1} 로그인 풀림 — 16GB 에서 재로그인 필요" "$marker"
    if [[ "$1" == "wing" || "$1" == "adcenter" ]] && try_relogin "$1" "$2"; then RECOVERED=1; eval "LOGGED_$1=1"; fi
  else
    say "$1	유지됨"
    eval "LOGGED_$1=1"
    rm -f "$CRAWLER/logs/.relogin-tried-$1"   # 로그인이 확인되면 다음 풀림에서 다시 1번 시도 가능
    if [[ -f "$marker" ]]; then rm -f "$marker"; say "$1	복구됨(마커 지움)"; RECOVERED=1; fi
  fi
}

check wing "https://wing.coupang.com"
sleep 3
check hub "https://supplier.coupang.com"
sleep 3
check adcenter "https://advertising.coupang.com"

# ── 복구 감지 → 그날 실패한 아침 작업 자동 재실행 (2026-10-24) ──────────────────
# 로그인이 풀려서 아침 작업이 실패했고 지금 복구됐으면, 실패한 작업만 하루 1번씩 다시 돌린다 (작업 사이 5분).
#   · 예정 시각이 안 지난 작업은 건드리지 않음 (원래 스케줄이 돈다) · 오늘 이미 ✅ 인 작업은 안 돌림 · 오늘 ❌ 기록이 없는 작업(아직 안 돈 것)도 안 돌림
#   · 아침 보고서(09:05)는 재실행 대상 아님 · 재실행한 작업은 마커(.rerun-<이름>-<날짜>)로 하루 1번만
rmdir "$CHROME_LOCK" 2>/dev/null   # 재실행되는 래퍼가 크롬 잠금을 직접 잡는다
trap - EXIT
#   · 윙·광고센터가 둘 다 로그인된 상태일 때만 (2026-10-24 시험: 광고센터만 복구되고 윙은 추가 인증에서 멈췄는데 재실행이 시작돼 헛걸음)
if [[ $RECOVERED -eq 1 && ${LOGGED_wing:-0} -eq 1 && ${LOGGED_adcenter:-0} -eq 1 && -z "${KEEPALIVE_NO_RERUN:-}" ]]; then
  TODAY=$(date +%F); NOWHM=$(date +%H%M); UID_NUM=$(id -u)
  # 이름 | launchd 라벨 | 예정 HHMM | 요약 로그 | 성공 줄 패턴
  JOBS=(
    "ad|com.namucompany.crawler-ad-daily|0840|$CRAWLER/logs/run-daily-ad.log|✅ 업로드 종료 코드 0"
    "wing|com.namucompany.crawler-wing-catalog|0845|$CRAWLER/logs/run-daily.log|✅ Coupang_detailinfo_"
    "stock|com.namucompany.crawler-adcenter-stock|0850|$CRAWLER/logs/run-stock.log|✅ 대조·슬랙 종료 코드 0"
  )
  FIRST=1
  for j in "${JOBS[@]}"; do
    IFS='|' read -r name label sched log okpat <<< "$j"
    rmark="$CRAWLER/logs/.rerun-$name-$TODAY"
    [[ -f "$rmark" ]] && continue
    [[ "$NOWHM" -lt "$sched" ]] && continue
    grep -q "^$TODAY.*❌" "$log" 2>/dev/null || continue
    grep -q "^$TODAY.*$okpat" "$log" 2>/dev/null && continue
    [[ $FIRST -eq 0 ]] && sleep 300
    FIRST=0
    : > "$rmark"
    if launchctl kickstart "gui/$UID_NUM/$label" 2>>"$LOG"; then say "재실행	$name	복구 후 오늘 실패 작업 다시 시작 ($label)"; else say "재실행 실패	$name	launchctl kickstart 안 됨 ($label)"; fi
  done
fi
