#!/bin/zsh
# kc-read.sh 감사·이상 판정 시험 — 가짜 상황 (시험 모드: 임시 폴더라 진짜 키체인은 읽지 않고 알림도 슬랙으로 안 나감). 사용: ./kc-test.sh
HERE="${0:A:h}"
T=$(mktemp -d); export KC_LOG_DIR="$T"
PASS=0; FAIL=0
ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
no() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
KEEPCHAIN=$'zsh /Users/x/crawler/dashboard/scripts/crawler-16gb/session-keepalive/kc-read.sh wing\n/bin/zsh /Users/x/crawler/dashboard/scripts/crawler-16gb/session-keepalive/run-keepalive.sh\n/sbin/launchd'
SSHCHAIN=$'zsh /Users/x/crawler/dashboard/scripts/crawler-16gb/session-keepalive/kc-read.sh wing\n/bin/zsh /Users/x/crawler/dashboard/scripts/crawler-16gb/session-keepalive/run-keepalive.sh\n-zsh\nsshd: user@ttys001\n/usr/sbin/sshd -D\n/sbin/launchd'
MANUALCHAIN=$'zsh kc-read.sh wing\nclaude\n/sbin/launchd'
NOW="2026-10-24 09:13:30"
reset() { setopt local_options null_glob; rm -f "$T"/* "$T"/.[a-z]* 2>/dev/null; printf '2026-10-24 09:13:13\twing\t풀림\n' > "$T/keepalive.log"; }
run() { KC_NOW="$NOW" KC_CHAIN="$1" KC_DOW="${3:-6}" "$HERE/kc-read.sh" "${2:-wing}" 2>"$T/err.txt"; echo $? > "$T/rc.txt"; }
rc() { cat "$T/rc.txt"; }

echo "정상 경로 1회 (keepalive 경유 + 직전 풀림 + 첫 읽기)"
reset; out=$(run "$KEEPCHAIN")
[[ "$(rc)" == 0 ]] && ok "종료 코드 0" || no "종료 코드 $(rc)"
[[ "$out" == $'test-id\ntest-pw' ]] && ok "아이디·비번이 stdout 으로만 나옴(시험값)" || no "출력 이상"
grep -q $'\t읽음\t' "$T/relogin-audit.log" && ok "감사 로그에 '읽음' 1줄" || no "감사 로그 없음"
! grep -q "test-pw" "$T/relogin-audit.log" && ! grep -q "test-id" "$T/relogin-audit.log" && ok "감사 로그에 값이 없음" || no "감사 로그에 값이 적힘!"
[[ ! -s "$T/relogin-anomaly.log" ]] && ok "이상 기록 0건" || no "이상 기록이 생김"

echo "① keepalive 가 아닌 곳에서 비번 읽기"
reset; run "$MANUALCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && ok "거부(코드 3)" || no "코드 $(rc)"
grep -q "⚠️ 자동 로그인 이상: 정해진 점검 작업" "$T/err.txt" && ok "알림 문구: $(grep -o '⚠️[^(]*' "$T/err.txt" | head -1)" || no "알림 문구 없음"
reset; run "$SSHCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "ssh·터미널·클로드 경유" "$T/err.txt" && ok "ssh 로 점검 작업을 직접 실행해도 거부(알림: ssh·터미널·클로드 경유)" || no "ssh 경유 통과함"

echo "② 직전 '풀림' 기록 없이 로그인 시도"
reset; printf '2026-10-24 09:13:13\twing\t유지됨\n' > "$T/keepalive.log"; run "$KEEPCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "직전 점검 기록이 '풀림'이 아님" "$T/err.txt" && ok "거부 + 알림(풀림 아님)" || no "통과함"
reset; printf '2026-10-24 08:00:00\twing\t풀림\n' > "$T/keepalive.log"; run "$KEEPCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "5분 넘게" "$T/err.txt" && ok "오래된 풀림 기록도 거부(5분 초과)" || no "오래된 기록 통과"

echo "③ 사이트별 하루 3회 초과"
reset; for i in 1 2 3; do run "$KEEPCHAIN" >/dev/null; done
[[ "$(rc)" == 0 ]] && ok "3번째까지 정상" || no "3번째가 막힘(코드 $(rc))"
run "$KEEPCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "하루 3번 한도" "$T/err.txt" && ok "4번째 거부 + 알림" || no "4번째가 통과됨"
run "$KEEPCHAIN" adcenter >/dev/null; printf '2026-10-24 09:13:20\tadcenter\t풀림\n' >> "$T/keepalive.log"; run "$KEEPCHAIN" adcenter >/dev/null
[[ "$(rc)" == 0 ]] && ok "다른 사이트(광고센터)는 따로 센다" || no "사이트별로 안 셈"

echo "④ 이랜드 비번을 금 17:00~20:30 밖에서 읽기"
ELCHAIN=$'zsh kc-read.sh eland\n/bin/zsh /x/run-kims-friday.sh\n/sbin/launchd'
reset; NOW="2026-10-24 18:00:00"; run "$ELCHAIN" eland 6 >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "금 17:00~20:30 밖" "$T/err.txt" && ok "토요일 18:00 → 거부 + 알림" || no "토요일에 통과"
reset; NOW="2026-10-23 16:59:00"; run "$ELCHAIN" eland 5 >/dev/null
[[ "$(rc)" == 3 ]] && ok "금 16:59 → 거부" || no "금 16:59 통과"
reset; NOW="2026-10-23 18:00:00"; run "$ELCHAIN" eland 5 >/dev/null
[[ "$(rc)" == 0 ]] && ok "금 18:00 → 정상" || no "금 18:00 거부됨(코드 $(rc))"
reset; NOW="2026-10-23 18:00:00"; run "$KEEPCHAIN" eland 5 >/dev/null
[[ "$(rc)" == 3 ]] && ok "이랜드를 keepalive 가 읽으면 거부(허용 호출자 아님)" || no "이랜드를 keepalive 가 읽음"
NOW="2026-10-24 09:13:30"

echo "⑤ 감사 로그가 지워지거나 줄이 줄어듦"
reset; run "$KEEPCHAIN" >/dev/null; run "$KEEPCHAIN" >/dev/null
sed -i '' '1d' "$T/relogin-audit.log"; run "$KEEPCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "감사 로그 줄이 줄어듦" "$T/err.txt" && ok "줄 삭제 → 거부 + 알림(줄이 줄어듦)" || no "줄 삭제를 못 잡음"
reset; run "$KEEPCHAIN" >/dev/null; rm -f "$T/relogin-audit.log"; run "$KEEPCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "감사 로그 파일이 사라짐" "$T/err.txt" && ok "파일 삭제 → 거부 + 알림(파일이 사라짐)" || no "파일 삭제를 못 잡음"
reset; run "$KEEPCHAIN" >/dev/null; run "$KEEPCHAIN" >/dev/null
sed -i '' '1s/wing/adcenter/' "$T/relogin-audit.log"; run "$KEEPCHAIN" >/dev/null
[[ "$(rc)" == 3 ]] && grep -q "줄이 바뀜" "$T/err.txt" && ok "줄 내용 변경 → 거부 + 알림(줄이 바뀜)" || no "줄 변경을 못 잡음"

echo "알림 문구가 슬랙에 보낼 수 있는 JSON 인지 (2026-10-24: 역슬래시 때문에 JSON 이 깨져 알림이 사라졌던 회귀 방지)"
source "$HERE/kc-lib.sh"
for case in "정해진 점검 작업($(kc_allowed_caller wing)) 밖에서 비번 읽기" "ssh·터미널·클로드 경유로 점검 작업을 직접 실행해 비번 읽기" '따옴표 "와" 역슬래시 \\ 와 줄바꿈
둘째 줄'; do
  msg="⚠️ 자동 로그인 이상: ${case} (사이트 wing, 2026-10-24 17:33:44)"
  payload="{\"text\":\"$(kc_json_escape "$msg")\"}"
  if printf '%s' "$payload" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then ok "JSON 유효: ${case:0:24}…"; else no "JSON 깨짐: ${case:0:24}…"; fi
done
# 실제 거부 문구(정규식 역슬래시 없음)
reset; run "$MANUALCHAIN" >/dev/null
grep -q '\\' "$T/err.txt" && no "알림 문구에 역슬래시가 남음" || ok "거부 알림 문구에 역슬래시 없음"

echo; echo "통과 $PASS · 실패 $FAIL"; rm -rf "$T"; [[ $FAIL -eq 0 ]]
