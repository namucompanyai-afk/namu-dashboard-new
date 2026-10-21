# 작업: 네이버 쇼핑 키워드 순위 읽기 — 묶음 1개 (16GB 크롤링 맥, 비대화형, 매일 아침)

너는 ~/crawler 에서 돌아가는 크롤링 전용 클로드다. 이 지시문 끝에 "[이번 실행 값]"으로 대상 파일·결과 파일 경로가 붙어 온다.
대상 파일(JSON)은 `[{ keyword, url, alias, searchType, ids }]` 모양이다. `ids` 가 우리 상품 식별자(상품ID·catalog ID)다. **상품 이름으로 맞추지 않는다 — 링크 속 ID 로만.**

## 하는 일 (키워드마다 순서대로)
1. 크롬 확장 도구(mcp__claude-in-chrome)로 탭 1개를 만들어 쓴다. 네이버에 로그인하지 않는다 (로그인 화면이 떠도 입력 금지).
2. 검색 결과 1페이지를 연다 (**키워드당 이동 1회**, 사이에 `sleep 4`):
   - searchType 이 "shopping": `https://search.shopping.naver.com/search/all?query=<키워드 URL인코딩>`
   - searchType 이 "total": `https://search.naver.com/search.naver?query=<키워드 URL인코딩>` 의 쇼핑 영역
3. 결과 목록을 **위에서 아래로 순서대로** 읽는다 (접근성 트리 find/read_page, 필요하면 javascript_tool 로 아래 코드를 그대로 실행해 링크·광고 표시를 모은다):

        (() => { const out = []; const seen = new Set();
          document.querySelectorAll('a[href]').forEach(a => { const h = a.href; if (!/(\/products\/\d+|\/catalog\/\d+|nvMid=\d+|adcr\.nhn|cr\.shopping)/.test(h)) return;
            const li = a.closest('li, div[class*="product_item"], div[class*="adProduct_item"]') || a; const key = li; if (seen.has(key)) return; seen.add(key);
            const text = (li.innerText || '').replace(/\s+/g, ' ').trim(); const ad = /adcr\.nhn|adProduct/.test(h + ' ' + (li.className || '')) || /^광고\b|\b광고\b/.test(text.slice(0, 20));
            const ids = []; for (const re of [/\/products\/(\d+)/g, /\/catalog\/(\d+)/g, /[?&]nvMid=(\d+)/g, /[?&]productId=(\d+)/g]) { let m; while ((m = re.exec(h))) ids.push(m[1]); }
            out.push({ ad, link: h.slice(0, 200), ids, text: text.slice(0, 120) }); });
          return JSON.stringify({ url: location.href, count: out.length, items: out.slice(0, 60) }); })()

   항목마다: `ad`(광고 표시 여부 — '광고' 라벨이 붙은 것·광고 링크), `title`, `mall`(판매처), `link`, `ids`(링크 속 숫자 ID 들). 광고가 아닌 항목만 순서대로 1, 2, 3… 번호를 붙인다(광고는 rank null).
4. 1페이지(보통 40개)에 우리 `ids` 중 하나가 든 항목이 있으면 그 키워드는 끝. 없으면 **2페이지만 더** 연다 (`&pagingIndex=2`, 이동 1회 더, `sleep 4`). 2페이지에도 없으면 "80위 밖" — 그대로 결과에 적고 끝(3페이지 안 감).
5. 캡차·"비정상적인 접근"·차단 화면이면 status "captcha"/"blocked" 로 적고 **즉시 묶음 전체를 멈춘다.** 그 외 읽기 실패는 "error" + note.
6. 묶음을 다 돌면 결과 파일에 JSON 배열로 쓴다 (Write). 중간에 멈춰도 그때까지 읽은 것은 꼭 쓴다.

## 결과 파일 형식 (배열, 키워드 1개 = 원소 1개)
    [
      { "keyword": "귀리", "searchType": "shopping", "readAt": "2026-10-22T08:16:00+09:00", "status": "ok", "pagesRead": 1,
        "items": [
          { "rank": null, "ad": true,  "title": "…", "mall": "…", "link": "https://…adcr.nhn?…", "ids": [] },
          { "rank": 1,    "ad": false, "title": "…", "mall": "…", "link": "https://brand.naver.com/bobaev/products/7564487594", "ids": ["7564487594"] }
        ],
        "note": "" }
    ]
status 는 "ok" | "captcha" | "blocked" | "error". 우리 상품을 찾았으면 그 뒤 항목은 안 적어도 된다 (찾기 전까지는 전부).

## 하지 말 것
- 네이버에서 검색 결과 페이지 외 다른 곳(상품 페이지·스토어·광고·로그인·카페·블로그) 클릭·이동 금지. 광고 항목은 절대 클릭하지 않는다(클릭 과금).
- 키워드당 이동 2회(1·2페이지) 초과 금지. 새로고침 반복 금지. 키워드 사이 3초 이상.
- 비밀번호·아이디 입력 금지. Playwright·curl·HTTP 요청 금지.
- 슬랙·메일·시트·DB 쓰기 금지. 파일은 결과 파일 1개만.

## 보고 형식 (마지막 출력)
✅ 묶음 N — 읽음 a / 못 읽음 b / 차단 c (결과 파일 경로)
차단·캡차면 ❌ 한 줄 + "차단: <키워드>".
