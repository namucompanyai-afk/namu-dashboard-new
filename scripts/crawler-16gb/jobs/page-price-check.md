# 작업: 쿠팡 상품 페이지 읽기 — 묶음 1개 (16GB 크롤링 맥, 비대화형, 매일 아침)

너는 ~/crawler 에서 돌아가는 크롤링 전용 클로드다. 이 지시문 끝에 "[이번 실행 값]"으로 대상 파일·결과 파일 경로가 붙어 온다.
대상 파일(JSON)은 `[{ pid, alias, options:[{ oid, channel, sheetPrice, bagCount, optionName }] }]` 모양이다. **sheetPrice 는 참고용이고 네가 비교하지 않는다** — 읽은 값만 적는다. 비교는 뒤 단계 스크립트가 한다.

## 가장 중요한 두 가지
1. **페이지 이동은 pid 당 딱 1번.** 옵션별로 `?vendorItemId=` 주소를 열지 않는다 (10/21 그 방식으로 20회 이동하다 Access Denied 차단됨). 옵션을 봐야 하면 **페이지 안에서 DOM 클릭**(옵션 항목 클릭)만 하고 2초 기다린다. 클릭은 페이지당 10회 이내.
2. **옵션ID(vendorItemId)와 판매자**를 옵션마다 잡는다. 우리 페이지에 남의 판매자 옵션이 섞여 있어서(홍미 '1개' = 74트리) 이름만 보고 짝 맞추면 남의 가격을 우리 것으로 잘못 알린다. 모르면 **비운다** — 가격·순서로 짐작해 넣지 않는다.

## 하는 일 (페이지마다 순서대로, 묶음 안의 모든 pid)
1. 크롬 확장 도구(mcp__claude-in-chrome)로 탭 1개를 만들어 쓴다 (페이지마다 새 탭 만들지 않는다).
2. `https://www.coupang.com/vp/products/<pid>` 로 간다. 로드 뒤 **8초** 기다린다 (Bash `sleep 8`). 다음 pid 로 넘어갈 때도 8초.
3. javascript_tool 로 아래 코드를 **그대로** 실행한다. 결과는 JSON 문자열 — `domOptions`(옵션 블록의 항목들: 표기·그 항목에 붙은 옵션ID·선택 여부), `embedded`(페이지 내장 데이터에서 vendorItemId 주변 글자 — 옵션 이름·가격이 옆에 보임):

        (() => { const txt = (e) => (e && e.innerText ? e.innerText : '').replace(/\s+/g, ' ').trim();
          const idsIn = (s) => { const r = /vendorItemId["']?\s*[:=]\s*["']?(\d{9,})|vendorItemId=(\d{9,})/g; const o = new Set(); let m; while ((m = r.exec(s))) o.add(m[1] || m[2]); return [...o]; };
          const blocks = [...document.querySelectorAll('[class*="option"],[class*="Option"]')].filter(e => { const n = e.querySelectorAll('li,button,a').length; return n >= 2 && n <= 60; });
          const dom = []; for (const b of blocks.slice(0, 6)) for (const li of b.querySelectorAll('li,button,a')) { const t = txt(li); if (!t || t.length > 120) continue;
            const a = li.matches('a') ? li : li.querySelector('a[href]'); const attrs = [...li.attributes].map(x => x.name + '=' + x.value).join(' ');
            dom.push({ text: t, ids: [...new Set(idsIn((a && a.href) || '').concat(idsIn(attrs)))], selected: /selected|active|checked/i.test(li.className) || li.getAttribute('aria-selected') === 'true' }); }
          const emb = []; for (const s of document.querySelectorAll('script')) { const c = s.textContent || ''; if (!c.includes('vendorItemId')) continue;
            const r = /vendorItemId["']?\s*:\s*["']?(\d{9,})/g; let m; while ((m = r.exec(c)) && emb.length < 60) emb.push({ oid: m[1], around: c.slice(Math.max(0, m.index - 160), m.index + 120).replace(/\s+/g, ' ') }); }
          return JSON.stringify({ url: location.href, domOptions: dom.slice(0, 40), embedded: emb.slice(0, 40) }); })()

   - `embedded` 의 `around` 에 옵션 이름(itemName·optionName 등)과 가격(salePrice 등)이 함께 보이면 그 옵션ID를 그 옵션에 적는다. **이 페이지 옵션 블록의 표기와 맞는 것만.** 추천 상품·다른 상품 ID 가 섞여 있으니(10/21 확인: HTML 전체엔 100개 넘게 섞임) **옵션 표기와 연결되는 근거가 없는 ID 는 쓰지 않는다.**
   - 결과의 `vendorItemIds` 에는 **옵션 블록·옵션 내장 데이터에서 이 페이지 옵션으로 확인된 ID 만** 적는다. HTML 전체 정규식 결과를 넣지 않는다. 확인된 게 없으면 빈 배열.
4. 접근성 트리(find/read_page)로 읽는다 (get_page_text 는 장바구니만 잡혀서 쓰지 않는다):
   - 제목, 페이지 판매자명(예: 농업회사법인 나무컴퍼니 / 쿠팡(주) / 그 외), 로켓 여부, 상품평 개수(숫자), 페이지 전체 품절 여부
   - **옵션 목록 전부** — "모든 옵션 보기"·드롭다운이 있으면 1번 펼친다(DOM 클릭). 옵션마다: 표기(label), 옵션ID(3번에서 확인된 것만), **그 옵션의 판매자(seller)** — 옵션을 DOM 클릭해 선택하면 구매 영역에 "판매자 ○○" 가 바뀌어 보인다(선택 뒤 2초). 판매자 이름이 안 보이고 "판매자배송"만 있으면 seller 는 비운다. 일반 판매가(price), 정가(listPrice), 와우가·쿠폰가(보일 때만), 품절(soldOut)
   - 옵션이 5개 넘고 클릭 한도(10회)에 걸리면 나머지는 목록에서 보이는 표기·가격만 적고 seller 는 비운다.
5. 페이지가 "상품을 찾을 수 없습니다"면 status "notfound"(계속 진행), **접근 거부(Access Denied)·차단 화면이면 status "blocked" 로 적고 즉시 묶음 전체를 멈춘다** (재시도 금지). 그 외 읽기 실패는 "error" + note.
6. 묶음을 다 돌면 결과 파일에 JSON 배열로 쓴다 (Write). 중간에 멈춰도 **그때까지 읽은 것은 꼭 쓴다.**

## 결과 파일 형식 (배열, 페이지 1개 = 원소 1개)
    [
      {
        "pid": "7800904814", "readAt": "2026-10-22T07:41:00+09:00", "status": "ok",
        "title": "...", "seller": "농업회사법인 나무컴퍼니 주식회사", "rocket": false,
        "reviews": 285, "soldOut": false,
        "vendorItemIds": ["88979101227", "88979101212", "88979101219"],
        "options": [
          { "label": "1kg × 1개", "oid": "88979101227", "seller": "농업회사법인 나무컴퍼니 주식회사", "price": 15000, "listPrice": 16000, "wowPrice": null, "couponPrice": null, "soldOut": false },
          { "label": "1개", "oid": null, "seller": null, "price": 29260, "listPrice": null, "wowPrice": null, "couponPrice": null, "soldOut": false }
        ],
        "note": ""
      }
    ]
status 는 "ok" | "notfound" | "blocked" | "error". 모르는 값은 null. 가격은 숫자만.

## 하지 말 것
- www.coupang.com/vp/products/<pid> 외 어떤 주소도 열지 않는다. `?vendorItemId=` 로 다시 열기 금지. 윙·광고센터·허브·검색·장바구니·로그인 금지. 구매·장바구니·쿠폰 받기·"다른 판매자 보기" 클릭 금지. 누르는 건 "모든 옵션 보기"와 옵션 항목 선택뿐(페이지당 10회 이내).
- 페이지 사이 8초, 옵션 클릭 사이 2초보다 빨리 가지 않는다. 새로고침 금지.
- 옵션ID를 가격·순서로 짐작해 붙이지 않는다. HTML 전체에서 긁은 ID 를 vendorItemIds 에 넣지 않는다.
- 비밀번호·아이디·키 입력 금지. Playwright·curl·HTTP 요청 금지.
- 슬랙·메일·시트·DB 쓰기 금지. 파일은 결과 파일 1개만.
- 마진·손익 계산·언급 금지. 가격은 파일에만.

## 보고 형식 (마지막 출력, 이대로)
✅ 묶음 N — 읽음 a / 못 읽음 b / 차단 c / 옵션ID 확인 d개 (결과 파일 경로)
차단이면 ❌ 한 줄 + "차단: <pid>".
