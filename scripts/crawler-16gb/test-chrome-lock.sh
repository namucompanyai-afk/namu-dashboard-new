#!/bin/zsh
# 크롬 잠금 시험 — 가짜 폴더로 실제 크롬·쿠팡 없이.  실행: ./test-chrome-lock.sh  (실패 시 종료 코드 1)
HERE="${0:A:h}"; T=$(mktemp -d); mkdir -p $T/logs
FAIL=0; ok() { echo "✅ $1"; }; no() { echo "❌ $1"; FAIL=$((FAIL + 1)); }
export CRAWLER=$T
cat > $T/holder.sh <<EOS
#!/bin/zsh
CRAWLER=$T; say() { :; }
source "$HERE/chrome-lock.sh"; trap chrome_unlock EXIT
chrome_lock || exit 1
echo \$\$ > $T/holder.pid
sleep \${1:-3}
EOS
chmod +x $T/holder.sh

echo "1) 잠금을 함수에서 잡아도 함수가 끝났을 때 안 풀린다 (예전 버그: 함수 안 trap 이 바로 실행)"
$T/holder.sh 4 & H=$!; sleep 1
[[ -d $T/logs/.chrome-claude.lock && "$(cat $T/logs/.chrome-claude.lock/pid)" == "$(cat $T/holder.pid)" ]] && ok "잠금 폴더가 살아 있고 주인 PID 가 적혀 있음" || no "잠금이 사라졌음"
echo "2) 다른 작업은 잠금 중엔 못 잡는다"
zsh -c "CRAWLER=$T; say() { :; }; source $HERE/chrome-lock.sh; chrome_lock_try" && no "남의 잠금을 잡음" || ok "두 번째 작업은 거절(chrome_lock_try=1)"
echo "3) 내 잠금이 아니면 지우지 않는다"
zsh -c "CRAWLER=$T; say() { :; }; source $HERE/chrome-lock.sh; chrome_unlock"; [[ -d $T/logs/.chrome-claude.lock ]] && ok "남이 chrome_unlock 해도 잠금이 그대로" || no "남의 잠금을 지웠음"
echo "4) 주인이 끝나면(EXIT trap) 잠금이 풀린다"
wait $H; [[ ! -d $T/logs/.chrome-claude.lock ]] && ok "주인 종료 후 잠금 없음" || no "잠금이 남았음"
echo "5) 주인이 죽으면(PID 없음) 낡은 잠금을 치우고 새로 잡는다"
mkdir $T/logs/.chrome-claude.lock; echo 999999 > $T/logs/.chrome-claude.lock/pid
zsh -c "CRAWLER=$T; say() { :; }; source $HERE/chrome-lock.sh; chrome_lock_try && echo \$\$ > /dev/null" && ok "죽은 주인의 잠금을 치우고 새로 잡음" || no "죽은 주인 잠금이 안 치워짐"
rm -rf $T/logs/.chrome-claude.lock
echo "6) 기다리는 쪽은 주인이 끝나면 이어서 잡는다 (chrome_lock 대기)"
$T/holder.sh 2 & H=$!; sleep 1
out=$(zsh -c "CRAWLER=$T; say() { echo SAY:\$*; }; CHROME_LOCK_POLL=1; source $HERE/chrome-lock.sh; chrome_lock && echo GOT")
echo "$out" | grep -q GOT && ok "주인 종료 뒤 대기하던 쪽이 잠금을 잡음" || no "대기 실패: $out"
wait $H 2>/dev/null
echo "7) 주인이 살아 있으면 90분이 넘어도 치우지 않는다(긴 작업 보호), 경고만"
$T/holder.sh 6 & H=$!; sleep 1
touch -t 202601010000 $T/logs/.chrome-claude.lock   # 아주 오래된 잠금으로 보이게 (주인은 살아 있음)
out=$(zsh -c "CRAWLER=$T; say() { echo SAY:\$*; }; source $HERE/chrome-lock.sh; chrome_lock_try && echo GOT || echo REFUSED")
echo "$out" | grep -q REFUSED && echo "$out" | grep -q "SAY:⚠️ 크롬 잠금 주인" && ok "살아 있는 주인의 오래된 잠금은 안 치우고 경고 로그만" || no "오래된 잠금을 치웠거나 경고 없음: $out"
[[ "$(cat $T/logs/.chrome-claude.lock/pid 2>/dev/null)" == "$(cat $T/holder.pid)" ]] && ok "주인 PID 기록이 그대로" || no "잠금이 뒤바뀜"
wait $H 2>/dev/null
echo "8) PID 기록이 없는 90분 넘은 옛 잠금은 치운다"
mkdir $T/logs/.chrome-claude.lock; touch -t 202601010000 $T/logs/.chrome-claude.lock
zsh -c "CRAWLER=$T; say() { :; }; source $HERE/chrome-lock.sh; chrome_lock_try" && ok "PID 없는 옛 잠금을 치우고 새로 잡음" || no "PID 없는 옛 잠금이 남음"
rm -rf $T; [[ $FAIL -eq 0 ]] && echo "전부 통과" || echo "실패 $FAIL건"; [[ $FAIL -eq 0 ]]
