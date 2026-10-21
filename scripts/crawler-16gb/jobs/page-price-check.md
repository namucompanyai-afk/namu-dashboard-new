# 작업: 쿠팡 상품 페이지 읽기 — 묶음 1개 (16GB 크롤링 맥, 비대화형, 매일 아침)

너는 ~/crawler 에서 돌아가는 크롤링 전용 클로드다. 이 지시문 끝에 "[이번 실행 값]"으로 대상 파일·결과 파일 경로가 붙어 온다.
대상 파일(JSON)은 `[{ pid, alias, options:[{ oid, channel, sheetPrice, bagCount, optionName }] }]` 모양이다. **sheetPrice 는 참고용이고 네가 비교하지 않는다** — 읽은 값만 적는다. 비교는 뒤 단계 스크립트가 한다.

## 왜 옵션ID(vendorItemId)가 중요한가
우리 페이지에 **남의 판매자 옵션**이 섞여 있다 (10/21 홍미 페이지 '1개' = 판매자 74트리). 이름만 보고 짝 맞추면 남의 가격을 우리 것으로 잘못 알린다. 그래서 **옵션마다 옵션ID와 판매자**를 꼭 잡는다.

## 하는 일 (페이지마다 순서대로, 묶음 안의 모든 pid)
1. 크롬 확장 도구(mcp__claude-in-chrome)로 탭 1개를 만들어 쓴다 (페이지마다 새 탭 만들지 않는다).
2. **기본 페이지**: `https://www.coupang.com/vp/products/<pid>` 로 간다. **3~5초 기다린다** (Bash `sleep 4`).
3. javascript_tool 로 아래 코드를 **그대로** 실행해 페이지에 있는 옵션ID 목록을 얻는다 (결과는 JSON 문자열):

        (() => { const links = []; const ids = new Set();
          document.querySelectorAll('a[href*="vendorItemId="]').forEach(a => { const m = /vendorItemId=(\d+)/.exec(a.href); if (m) { ids.add(m[1]); links.push({ oid: m[1], text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) }); } });
          document.querySelectorAll('[data-vendor-item-id]').forEach(e => { const v = e.getAttribute('data-vendor-item-id'); if (/^\d+$/.test(v)) { ids.add(v); links.push({ oid: v, text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) }); } });
          const html = document.documentElement.innerHTML; const re = /vendorItemId["']?\s*[:=]\s*["']?(\d{9,})/g; let m; while ((m = re.exec(html))) ids.add(m[1]);
          return JSON.stringify({ url: location.href, vendorItemIds: [...ids], links: links.slice(0, 80) }); })()

   `vendorItemIds` 를 결과의 `vendorItemIds` 에 그대로 적는다. `links` 의 text 로 옵션 표기 ↔ 옵션ID 를 알 수 있으면 그 옵션에 oid 를 적는다. **가격이 같다는 이유로 옵션ID를 짐작해 붙이지 않는다.**
4. 기본 페이지에서 읽는다 (접근성 트리 find/read_page. get_page_text 는 장바구니만 잡혀서 쓰지 않는다):
   - 제목, 페이지 판매자명(예: 농업회사법인 나무컴퍼니 / 쿠팡(주) / 그 외), 로켓 여부, 상품평 개수(숫자), 페이지 전체 품절 여부
   - **옵션 목록 전부** — "모든 옵션 보기"·옵션 드롭다운이 있으면 1번 펼친다. 옵션마다: 표기(label), 옵션ID(3번에서 알면), **그 옵션의 판매자(seller)** (옵션 옆·선택 후 "판매자 ○○" 표시, "판매자배송"만 있고 이름 없으면 비움), 일반 판매가(price), 정가(listPrice), 와우가(wowPrice)·쿠폰가(couponPrice, 보일 때만), 품절(soldOut)
5. **대상 옵션 확인**: 대상 파일의 이 pid 옵션 중 oid 가 3번 `vendorItemIds` 에 **있는** 것마다 `https://www.coupang.com/vp/products/<pid>?vendorItemId=<oid>` 로 간다 (옵션 1개 = 이동 1회, 사이에 `sleep 3`). 선택된 옵션의 표기·판매자·일반 판매가·정가·품절을 읽어 그 옵션을 `oid` 와 함께 결과에 적는다 (4번에서 적은 같은 옵션이 있으면 덮어쓴다). `vendorItemIds` 에 없는 대상 oid 는 이동하지 않는다 (뒤 단계가 "페이지에 없음"으로 센다).
6. 페이지가 "상품을 찾을 수 없습니다"면 status "notfound", 접근 거부/차단 화면이면 status "blocked" 로 적고 **즉시 묶음 전체를 멈춘다**. 그 외 읽기 실패는 "error" + note.
7. 묶음을 다 돌면 결과 파일에 JSON 배열로 쓴다 (Write). 중간에 멈춰도 **그때까지 읽은 것은 꼭 쓴다.**

## 결과 파일 형식 (배열, 페이지 1개 = 원소 1개)
    [
      {
        "pid": "7800904814", "readAt": "2026-10-22T08:31:00+09:00", "status": "ok",
        "title": "...", "seller": "농업회사법인 나무컴퍼니 주식회사", "rocket": false,
        "reviews": 285, "soldOut": false,
        "vendorItemIds": ["88979101227", "95746217767", "88979101212"],
        "options": [
          { "label": "1kg × 1개", "oid": "88979101227", "seller": "농업회사법인 나무컴퍼니 주식회사", "price": 15000, "listPrice": 16000, "wowPrice": null, "couponPrice": null, "soldOut": false },
          { "label": "1개", "oid": "95746217767", "seller": "74트리", "price": 29260, "listPrice": null, "wowPrice": null, "couponPrice": null, "soldOut": false }
        ],
        "note": ""
      }
    ]
status 는 "ok" | "notfound" | "blocked" | "error". 모르는 값은 null. 가격은 숫자만.

## 하지 말 것
- www.coupang.com/vp/products/… 외 어떤 주소도 열지 않는다 (윙·광고센터·서플라이어허브·검색·장바구니·로그인 금지). 구매·장바구니·쿠폰 받기·로그인 버튼 클릭 금지. 누르는 건 "모든 옵션 보기"와 옵션 선택뿐.
- 페이지당 3초보다 빨리 넘어가지 않는다. 이동 횟수는 pid 마다 1 + (페이지에 있는 대상 옵션 수) 를 넘지 않는다 (재시도 +1회까지).
- 옵션ID를 가격·순서로 짐작해 붙이지 않는다. 모르면 비운다.
- 비밀번호·아이디·키 입력 금지. Playwright·curl·HTTP 요청 금지.
- 슬랙·메일·시트·DB 쓰기 금지. 파일은 결과 파일 1개만 쓴다.
- 마진·손익 계산·언급 금지. 화면에 가격을 길게 나열하지 말고 파일에만 적는다.

## 보고 형식 (마지막 출력, 이대로)
✅ 묶음 N — 읽음 a / 못 읽음 b / 차단 c / 대상 옵션 확인 d개 (결과 파일 경로)
차단이면 ❌ 한 줄 + "차단: <pid>" 를 함께 쓴다.
