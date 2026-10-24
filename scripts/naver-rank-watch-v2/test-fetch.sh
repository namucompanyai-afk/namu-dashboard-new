#!/bin/zsh
# 순위 v2 수집 시험 — 가짜 osascript 로 네이버 접속 없이: 이어 읽기(--resume) · 결과 0개 처리 · 캡차 중단.  실행: ./test-fetch.sh  (실패가 있으면 종료 코드 1)
HERE="${0:A:h}"; REPO="${HERE:h:h}"
T=$(mktemp -d); mkdir -p $T/bin $T/out1 $T/out2 $T/out3
FAIL=0; ok() { echo "✅ $1"; }; no() { echo "❌ $1"; FAIL=$((FAIL + 1)); }
export RANK_V2_TEST_GAP_MS=10 RANK_WATCH_V2_ENV=/dev/null NODE_PATH="$REPO/node_modules"
run() { PATH=$T/bin:$PATH npx --yes tsx "$REPO/scripts/naver-rank-watch-v2/run.ts" "$@" 2>&1; }
status() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.map(x=>x.keyword+":"+x.status).join(" "))' "$1"; }
mkbin() { printf '#!/bin/sh\n%s\n' "$1" > $T/bin/osascript; chmod +x $T/bin/osascript; }
ITEM=$(node -e 'console.log(JSON.stringify({url:"u",count:12,items:Array.from({length:12},(_,i)=>({id:String(i+1),ad:false,title:"t"+i,mall:"m",price:1,link:"https://x/"+(i+1)}))}))')
cat > $T/targets.json <<'J'
{"keywords":[{"keyword":"가","searchType":"shopping"},{"keyword":"나","searchType":"shopping"},{"keyword":"다","searchType":"shopping"},{"keyword":"라","searchType":"shopping"}],"products":[]}
J

echo "1) 이어 읽기: 이미 ok 인 키워드는 빼고 못 읽은 것만"
cat > $T/out1/naver_rank_batch_01.json <<'J'
[{"keyword":"가","searchType":"shopping","readAt":"2026-10-24T00:00:00Z","status":"ok","pagesRead":1,"items":[{"rank":1,"ad":false,"title":"t","mall":"m","link":"https://x/1","ids":["1"]}]},
 {"keyword":"나","searchType":"shopping","readAt":"2026-10-24T00:00:00Z","status":"captcha","pagesRead":1,"items":[],"note":"캡차"}]
J
mkbin "echo '$ITEM'"
out=$(run --fetch --resume --targets $T/targets.json --results $T/out1)
echo "$out" | grep -q "이미 읽음 1개 제외, 남은 3/4개" && ok "남은 3개만 읽음" || no "이어 읽기 개수: $out"
[[ -f $T/out1/naver_rank_batch_02.json ]] && [[ "$(status $T/out1/naver_rank_batch_02.json)" == "나:ok 다:ok 라:ok" ]] && ok "02 파일에 나·다·라 ok" || no "02 파일 이상"

echo "2) 결과 0개는 읽음이 아니라 error"
mkbin "if [ -f $T/second ]; then echo '{\"url\":\"u\",\"count\":0,\"items\":[]}'; else touch $T/second; echo '$ITEM'; fi"
run --fetch --targets $T/targets.json --results $T/out2 >/dev/null
s=$(status $T/out2/naver_rank_batch_01.json)
[[ "$s" == "가:ok 나:error 다:error 라:error" ]] && ok "첫 키워드만 ok, 빈 페이지는 error: $s" || no "빈 페이지 처리: $s"

echo "3) 캡차가 뜨면 거기서 중단하고 남은 키워드는 읽지 않음"
mkbin "if [ -f $T/second3 ]; then echo '{\"url\":\"u\",\"captcha\":true}'; else touch $T/second3; echo '$ITEM'; fi"
run --fetch --targets $T/targets.json --results $T/out3 >/dev/null
s=$(status $T/out3/naver_rank_batch_01.json)
[[ "$s" == "가:ok 나:captcha" ]] && ok "가:ok 나:captcha 에서 중단: $s" || no "캡차 중단: $s"

echo "4) 일부만 뜬 페이지(상품 3개)는 읽음이 아니라 error, 정상 페이지는 ok"
mkdir -p $T/out4
ITEMS12=$(node -e 'console.log(JSON.stringify({url:"u",count:12,items:Array.from({length:12},(_,i)=>({id:String(i+1),ad:false,title:"t"+i,mall:"m",price:1,link:"https://x/"+(i+1)}))}))')
ITEMS3=$(node -e 'console.log(JSON.stringify({url:"u",count:3,items:Array.from({length:3},(_,i)=>({id:String(i+1),ad:false,title:"t"+i,mall:"m",price:1,link:"https://x/"+(i+1)}))}))')
mkbin "if [ -f $T/s4 ]; then echo '$ITEMS3'; else touch $T/s4; echo '$ITEMS12'; fi"
run --fetch --targets $T/targets.json --results $T/out4 >/dev/null
s=$(status $T/out4/naver_rank_batch_01.json)
[[ "$s" == "가:ok 나:error 다:error 라:error" ]] && ok "12개 뜬 페이지 ok, 3개만 뜬 페이지 error: $s" || no "일부만 뜬 페이지 처리: $s"

echo "5) 마지막 키워드 뒤에는 쉬지 않는다 (간격 시험값 3초 x 키워드 4개 → 사이 3번만 약 9초, 마지막 뒤에도 쉬면 12초+)"
mkdir -p $T/out5; mkbin "echo '$ITEMS12'"
t0=$(date +%s); RANK_V2_TEST_GAP_MS=3000 run --fetch --targets $T/targets.json --results $T/out5 >/dev/null; t1=$(date +%s)
[[ $((t1 - t0)) -le 11 ]] && ok "걸린 시간 $((t1 - t0))초 (마지막 키워드 뒤 쉬었다면 12초+)" || no "너무 오래 걸림 $((t1 - t0))초"

rm -rf $T
[[ $FAIL -eq 0 ]] && echo "전부 통과" || echo "실패 $FAIL건"; [[ $FAIL -eq 0 ]]
