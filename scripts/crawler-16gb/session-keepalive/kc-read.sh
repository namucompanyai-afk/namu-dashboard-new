#!/bin/zsh
# 키체인 비번 읽기 정식 통로 (쿠팡 윙·광고센터 / 이랜드). 사용: kc-read.sh <wing|adcenter|eland>
#   성공하면 stdout 에 1줄째 아이디, 2줄째 비번을 돌려준다. 이상이면 키체인을 읽지 않고 종료 코드 3 + 즉시 슬랙 "⚠️ 자동 로그인 이상: …".
#   감사 로그: ~/crawler/logs/relogin-audit.log (읽을 때마다 1줄, 값은 안 적음) · 이상 기록: relogin-anomaly.log
#   누가 손으로 실행해도 예외 없이 ① 호출자 이상으로 거부·알림이 간다. 시험 모드(KC_LOG_DIR 를 기본 폴더가 아닌 곳으로 지정)에서는 진짜 키체인을 절대 읽지 않고 가짜 값을 쓴다.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
HERE="${0:A:h}"
source "$HERE/kc-lib.sh"
CRAWLER="$HOME/crawler"
DEFAULT_DIR="$CRAWLER/logs"
LOGDIR="${KC_LOG_DIR:-$DEFAULT_DIR}"
TEST=0; [[ "$LOGDIR" != "$DEFAULT_DIR" ]] && TEST=1
ALOG="$LOGDIR/relogin-audit.log"; ST="$LOGDIR/.relogin-audit.state"; ANOM="$LOGDIR/relogin-anomaly.log"; KLOG="$LOGDIR/keepalive.log"
SITE="${1:-}"
case "$SITE" in wing|adcenter) SVC="namu-coupang-xauth" ;; eland) SVC="namu-eland-eis" ;; *) echo "사용법: kc-read.sh <wing|adcenter|eland>" >&2; exit 2 ;; esac
mkdir -p "$LOGDIR"

NOW="${KC_NOW:-$(date '+%Y-%m-%d %H:%M:%S')}"; [[ $TEST -eq 0 ]] && NOW=$(date '+%Y-%m-%d %H:%M:%S')   # 시각 흉내는 시험 모드에서만
TODAY="${NOW%% *}"
if [[ $TEST -eq 1 && -n "${KC_DOW:-}" ]]; then DOW="$KC_DOW"; else DOW=$(date '+%u'); fi
HHMM=$(echo "${NOW#* }" | cut -c1,2,4,5)
if [[ $TEST -eq 1 && -n "${KC_CHAIN:-}" ]]; then CHAIN="$KC_CHAIN"; else CHAIN=$(kc_chain); fi   # 호출자 흉내도 시험 모드에서만

PENDING="$LOGDIR/.relogin-alert-pending"; ALERTLOG="$LOGDIR/relogin-alert.log"
alert() {  # $1=이상 내용
  local text="⚠️ 자동 로그인 이상: $1 (사이트 $SITE, $NOW)"
  printf '%s\t%s\t%s\n' "$NOW" "$SITE" "$1" >> "$ANOM"
  if [[ $TEST -eq 1 ]]; then echo "[알림 문구] $text" >&2; return; fi
  kc_flush_pending "$ALERTLOG" "$CRAWLER/.env" "$PENDING"
  if ! kc_slack_notify "$text" "$ALERTLOG" "$CRAWLER/.env" "$PENDING"; then
    printf '%s\t%s\t알림 발송 실패(보류 파일에 저장, 로그 relogin-alert.log)\n' "$NOW" "$SITE" >> "$ANOM"
  fi
}
CALLER_SHORT=$(echo "$CHAIN" | grep -Eo 'run-[a-z-]+\.sh|sshd|ssh|claude|Terminal|iTerm|launchd' | awk '!s[$0]++' | head -4 | paste -sd'>' -)
[[ -z "$CALLER_SHORT" ]] && CALLER_SHORT="알수없음"

PRIOR_NOTE="-"
fail() {  # $1=이유 — 읽지 않고 거부
  kc_audit_append "$ALOG" "$ST" "$NOW" "$SITE" "$CALLER_SHORT" "$PRIOR_NOTE" "거부:$1"
  alert "$1"
  exit 3
}

# ⑤ 감사 로그 무결성 (읽기 전에 먼저)
if r=$(kc_integrity_check "$ALOG" "$ST"); then :; else
  alert "$r"
  # 같은 이상이 매번 반복되지 않게 현재 상태를 새 기준으로 삼되, 이 호출은 계속 진행하지 않고 거부
  n=$(wc -l < "$ALOG" 2>/dev/null | tr -d ' '); n=${n:-0}
  if [[ $n -gt 0 ]]; then printf 'lines=%s last=%s\n' "$n" "$(kc_hash8 "$(sed -n "${n}p" "$ALOG")")" > "$ST"; else rm -f "$ST"; fi
  kc_audit_append "$ALOG" "$ST" "$NOW" "$SITE" "$CALLER_SHORT" "$PRIOR_NOTE" "거부:감사 로그 이상"
  exit 3
fi
# ① 호출자
if r=$(kc_caller_check "$SITE" "$CHAIN"); then :; else fail "$r"; fi
# ② 직전 풀림 기록
if [[ "$SITE" != "eland" ]]; then
  if r=$(kc_prior_check "$SITE" "$KLOG" "$NOW"); then PRIOR_NOTE="풀림 확인"; else PRIOR_NOTE="풀림 기록 없음"; fail "$r"; fi
else
  PRIOR_NOTE="금요일 시간대 점검"
fi
# ③ 횟수
if r=$(kc_count_check "$SITE" "$ALOG" "$TODAY"); then :; else fail "$r"; fi
# ④ 이랜드 시간대
if r=$(kc_time_check "$SITE" "$DOW" "$HHMM"); then :; else fail "$r"; fi

# 읽기 (시험 모드는 가짜 값)
if [[ $TEST -eq 1 ]]; then
  ID="test-id"; PW="test-pw"
else
  ID=$(security find-generic-password -s "$SVC" 2>/dev/null | sed -n 's/.*"acct"<blob>="\(.*\)"$/\1/p' | head -1)
  PW=$(security find-generic-password -s "$SVC" -w 2>/dev/null)
fi
if [[ -z "$ID" || -z "$PW" ]]; then
  kc_audit_append "$ALOG" "$ST" "$NOW" "$SITE" "$CALLER_SHORT" "$PRIOR_NOTE" "읽기실패"
  exit 1
fi
kc_audit_append "$ALOG" "$ST" "$NOW" "$SITE" "$CALLER_SHORT" "$PRIOR_NOTE" "읽음"
printf '%s\n%s\n' "$ID" "$PW"
