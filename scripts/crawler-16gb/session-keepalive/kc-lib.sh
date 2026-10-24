#!/bin/zsh
# 16GB 키체인 비번 읽기 — 감사·이상 판정 함수 모음 (kc-read.sh 가 불러 쓰고, kc-test.sh 가 가짜 상황으로 시험한다)
#   원칙: 이 맥에서 쿠팡·이랜드 비번을 읽는 정식 통로는 kc-read.sh 하나. 읽을 때마다 감사 로그 1줄, 이상이면 읽지 않고 거부 + 즉시 슬랙.
#   감사 로그에는 비번·아이디 값을 절대 안 적는다 (시각·사이트·호출 경로·직전 점검·결과만).
#   로그 형식(탭): 번호 · 시각 · 사이트 · 호출한 쪽 · 직전 점검 · 결과 · 앞줄해시8자리  (앞줄 해시로 줄이 지워지거나 바뀌면 잡는다)

# 정상 호출자: 사이트별로 허용되는 스크립트 이름
kc_allowed_caller() {  # $1=사이트(wing|adcenter|eland) → 스크립트 이름 정규식
  case "$1" in
    wing|adcenter) echo 'run-keepalive\.sh' ;;
    eland) echo 'run-kims-friday\.sh' ;;
    *) echo 'NO_SUCH_CALLER' ;;
  esac
}

# 부모 프로세스 사슬(명령줄) — 현재 프로세스에서 PID 1 까지. 한 줄에 하나
kc_chain() {
  local pid=$$ cmd ppid i=0
  while [[ $pid -gt 1 && $i -lt 25 ]]; do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null)
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    echo "$cmd"
    [[ -z "$ppid" ]] && break
    pid=$ppid; i=$((i + 1))
  done
}

# ① 호출자 판정: 사슬에 허용 스크립트가 있고, 사람이 연 흔적(ssh·터미널·클로드)이 없어야 함 → 0=정상 / 1=이상(이유를 stdout 에)
#   $1=사이트 $2=사슬(여러 줄 글자)
kc_caller_check() {
  local site="$1" chain="$2" allowed
  allowed=$(kc_allowed_caller "$site")
  if ! echo "$chain" | grep -Eq "$allowed"; then echo "정해진 점검 작업($allowed) 밖에서 비번 읽기"; return 1; fi
  if echo "$chain" | grep -Eqi 'sshd|ssh-session|/login |Terminal|iTerm|claude|ssh '; then echo "ssh·터미널·클로드 경유로 점검 작업을 직접 실행해 비번 읽기"; return 1; fi
  return 0
}

# ② 직전 점검 결과: 점검 기록(keepalive.log)의 이 사이트 마지막 줄이 '풀림' 이고 5분 이내여야 함 → 0=정상 / 1=이상
#   $1=사이트 $2=keepalive.log 경로 $3=지금(YYYY-MM-DD HH:MM:SS)
kc_prior_check() {
  local site="$1" klog="$2" now="$3" line ts
  [[ "$site" == "eland" ]] && return 0   # 이랜드는 점검 기록이 없다 — 시간대(④)로만 판정
  line=$(grep "	${site}	" "$klog" 2>/dev/null | grep -v '자동 재로그인' | tail -n 1)
  if ! echo "$line" | grep -q "	풀림"; then echo "직전 점검 기록이 '풀림'이 아님(없음)"; return 1; fi
  ts="${line%%	*}"
  local a b; a=$(date -j -f '%Y-%m-%d %H:%M:%S' "$ts" +%s 2>/dev/null); b=$(date -j -f '%Y-%m-%d %H:%M:%S' "$now" +%s 2>/dev/null)
  if [[ -z "$a" || -z "$b" || $((b - a)) -gt 300 || $((b - a)) -lt -5 ]]; then echo "직전 '풀림' 기록이 5분 넘게 오래됨"; return 1; fi
  return 0
}

# ③ 사이트별 하루 읽기 횟수: 오늘 '읽음' 이 3번 이상이면 4번째부터 이상 → 0=정상 / 1=이상
#   $1=사이트 $2=감사로그 $3=오늘(YYYY-MM-DD)
kc_count_check() {
  local n; n=$(awk -F'\t' -v s="$1" -v d="$3" '$3==s && index($2,d)==1 && $6=="읽음"{c++} END{print c+0}' "$2" 2>/dev/null)
  if [[ ${n:-0} -ge 3 ]]; then echo "오늘 이미 ${n}번 읽음(하루 3번 한도)"; return 1; fi
  return 0
}

# ④ 이랜드 비번은 금요일 17:00~20:30 에만 → 0=정상 / 1=이상.   $1=사이트 $2=요일(1=월..7=일) $3=HHMM
kc_time_check() {
  [[ "$1" != "eland" ]] && return 0
  if [[ "$2" == "5" && "$3" -ge 1700 && "$3" -le 2030 ]]; then return 0; fi
  echo "이랜드 비번 읽기가 금 17:00~20:30 밖"; return 1
}

# ⑤ 감사 로그 무결성: 상태 파일(줄 수·마지막 줄 해시)과 비교 → 0=정상 / 1=이상.   $1=감사로그 $2=상태파일
kc_hash8() { printf '%s' "$1" | shasum -a 256 | cut -c1-8; }
kc_integrity_check() {
  local alog="$1" st="$2" want_n want_h n h
  [[ ! -f "$st" ]] && return 0
  want_n=$(sed -n 's/^lines=\([0-9]*\).*/\1/p' "$st"); want_h=$(sed -n 's/.*last=\([0-9a-f]*\)$/\1/p' "$st")
  if [[ ! -f "$alog" ]]; then [[ ${want_n:-0} -gt 0 ]] && { echo "감사 로그 파일이 사라짐(기록 ${want_n}줄이었음)"; return 1; }; return 0; fi
  n=$(wc -l < "$alog" | tr -d ' ')
  if [[ $n -lt ${want_n:-0} ]]; then echo "감사 로그 줄이 줄어듦(${want_n}→${n})"; return 1; fi
  if [[ ${want_n:-0} -gt 0 ]]; then
    h=$(kc_hash8 "$(sed -n "${want_n}p" "$alog")")
    [[ "$h" != "$want_h" ]] && { echo "감사 로그 ${want_n}번째 줄이 바뀜"; return 1; }
  fi
  # 앞줄 해시 사슬 전체 확인 — 중간 줄을 고치면 다음 줄에 적힌 '앞줄 해시'와 안 맞는다
  local i=1 prevline="" line field
  while IFS= read -r line; do
    field="${line##*	}"
    if [[ $i -gt 1 ]]; then
      [[ "$field" != "$(kc_hash8 "$prevline")" ]] && { echo "감사 로그 $((i - 1))번째 줄이 바뀜"; return 1; }
    fi
    prevline="$line"; i=$((i + 1))
  done < "$alog"
  return 0
}

# 감사 로그 1줄 쓰기 (+상태 파일 갱신).   $1=감사로그 $2=상태파일 $3=시각 $4=사이트 $5=호출자 $6=직전점검 $7=결과
kc_audit_append() {
  local alog="$1" st="$2" n prev
  n=0; [[ -f "$alog" ]] && n=$(wc -l < "$alog" | tr -d ' ')
  prev="00000000"; [[ $n -gt 0 ]] && prev=$(kc_hash8 "$(sed -n "${n}p" "$alog")")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$((n + 1))" "$3" "$4" "$5" "$6" "$7" "$prev" >> "$alog"
  printf 'lines=%s last=%s\n' "$((n + 1))" "$(kc_hash8 "$(sed -n "$((n + 1))p" "$alog")")" > "$st"
}
