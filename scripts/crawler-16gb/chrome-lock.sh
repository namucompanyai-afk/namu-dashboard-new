# 16GB 크롤링 래퍼 공용 — 크롬 한 번에 한 작업만 (잠금 폴더 + 주인 PID). zsh 전용, 각 래퍼가 `source "${0:A:h}/chrome-lock.sh"` 하고 바로 아래에서 `trap chrome_unlock EXIT` 를 최상위에 건다.
#   2026-10-24 고침: 예전엔 잠금 함수 "안에서" trap EXIT 를 걸었는데 zsh 는 함수가 끝날 때 그 trap 을 바로 실행해 잠금 폴더가 만들자마자 지워졌다 → 래퍼끼리 잠금이 없었음.
#   · 잠금 폴더 안에 주인 PID 를 적고, 지울 땐 내 PID 일 때만 지운다(다른 작업의 진짜 잠금을 못 지움)
#   · 주인 프로세스가 죽은 잠금(또는 PID 기록 없는 90분 넘은 옛 잠금)만 치우고 다시 시도. 주인이 살아 있으면 오래돼도 안 치움(월요일 주간 작업 같은 긴 작업 보호), 90분 넘으면 경고만
# 쓰는 쪽이 미리 정해 둘 것: CRAWLER(~/crawler 경로), say() 함수
CHROME_LOCK="$CRAWLER/logs/.chrome-claude.lock"

# 오래 안 놓는 잠금 경고 — 주인이 살아 있는데 90분이 넘었으면 치우지 않고(긴 주간 작업 보호) 로그 + 슬랙으로 하루 1번만 알린다
chrome_lock_warn() {  # $1=주인 PID $2=지난 초
  local mark="$CRAWLER/logs/.chrome-lock-warned-$(date +%F)"
  [[ -f "$mark" ]] && return 0
  : > "$mark"
  say "⚠️ 크롬 잠금 주인(PID $1)이 ${2}초째 안 놓음 — 치우지 않고 계속 기다림"
  if typeset -f webhook >/dev/null 2>&1; then
    local url; url=$(webhook)
    [[ -n "$url" ]] && curl -sS -m 20 -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"text\":\"⚠️ 16GB 크롬 잠금을 ${2}초째 한 작업이 쥐고 있음(PID $1) — 작업이 멈췄는지 확인\"}" "$url" || true
  fi
}

# 잠금 시도 1번 (기다리지 않음) → 0=잡음 / 1=남이 쓰는 중
chrome_lock_try() {
  local pid age
  if mkdir "$CHROME_LOCK" 2>/dev/null; then echo "$$" > "$CHROME_LOCK/pid"; return 0; fi
  pid=$(cat "$CHROME_LOCK/pid" 2>/dev/null)
  age=$(( $(date +%s) - $(stat -f %m "$CHROME_LOCK" 2>/dev/null || echo 0) ))
  # 치우는 경우: ① 주인 PID 가 죽었음 ② PID 기록이 아예 없는 옛 잠금이 90분 넘음. 주인이 살아 있으면 시간이 아무리 지나도 안 치운다(경고만)
  if { [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; } || { [[ -z "$pid" ]] && [[ $age -gt 5400 ]]; }; then
    # 이름 바꾸기(mv, 원자적)로 치운다 — 두 프로세스가 동시에 치우다 새로 잡은 남의 잠금을 지우는 경쟁을 막는다. mv 에 진 쪽은 그냥 다시 시도
    mv "$CHROME_LOCK" "$CHROME_LOCK.stale.$$" 2>/dev/null && rm -rf "$CHROME_LOCK.stale.$$"
    if mkdir "$CHROME_LOCK" 2>/dev/null; then echo "$$" > "$CHROME_LOCK/pid"; return 0; fi
  elif [[ -n "$pid" && $age -gt 5400 ]]; then
    chrome_lock_warn "$pid" "$age"
  fi
  return 1
}

# 잠금 잡기 — 최대 50분(30초 간격) 기다림 → 0=잡음 / 1=실패(50분 넘음)
chrome_lock() {
  local i
  for i in {1..100}; do
    chrome_lock_try && return 0
    sleep "${CHROME_LOCK_POLL:-30}"
  done
  say "❌ 크롬 잠금을 50분 기다려도 안 풀림 ($CHROME_LOCK)"
  return 1
}

# 내 잠금일 때만 풀기 (아니면 아무것도 안 함). EXIT trap 으로도 쓴다
chrome_unlock() {
  [[ "$(cat "$CHROME_LOCK/pid" 2>/dev/null)" == "$$" ]] && rm -rf "$CHROME_LOCK"
  return 0
}
