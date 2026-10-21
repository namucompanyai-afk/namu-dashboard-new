# 작업: 광고센터 "광고 만들기" 상품 목록 읽기 (1P 재고·현재가) — 16GB 크롤링 맥, 비대화형, 매일 10:00

너는 ~/crawler 에서 돌아가는 크롤링 전용 클로드다. 이 지시문 끝에 "[이번 실행 값]"으로 오늘 날짜·결과 파일 경로가 붙어 온다.

## 왜 하는가
쿠팡 1P(로켓)는 쿠팡이 스스로 가격을 내리고 재고가 끊기는 일이 잦다. 광고센터의 **"광고 만들기 > 수동 상품 설정 > 전체 상품" 목록**이 1P 재고를 볼 수 있는 유일한 화면이다(대표, 2026-10-21). 이 작업은 **그 목록을 읽기만** 한다 — 광고를 만들거나 저장하지 않는다.

## 가장 중요한 것 — 절대 하지 말 것
- **'상품 선택' · '모든 옵션 선택' · 화면 아래 '다음' · '저장' 버튼을 누르지 않는다.** 체크박스도 선택하지 않는다. 캠페인 이름·광고그룹 이름 입력란도 건드리지 않는다.
- 다 읽은 뒤 **탭을 닫고 끝낸다.** 광고가 등록되지 않았는지 신경 써서 확인(화면을 벗어나기 전 선택한 상품이 0인지 본다).
- 광고센터 페이지 이동은 이번 실행에 **3회 이내**.

## 로그인 — 중요(2026-10-21 확인)
이 화면은 **허브(SUPPLIER HUB, 로켓배송 공급사) 로그인**이어야 1P 상품이 보인다. 윙(wing) 쪽으로만 로그인돼 있으면 3P만 보이고 1P 재고가 안 보인다.

## 하는 일 (순서대로)
1. 크롬 확장 도구(mcp__claude-in-chrome)로 새 탭을 만들고 `https://advertising.coupang.com/marketing/campaign/registration?goalType=SALES` 로 간다. (이동 1회)
2. 화면 왼쪽 위 **"wing | SUPPLIER HUB"** 토글을 본다. **SUPPLIER HUB** 쪽이 선택돼 있는지 확인하고, 아니면 그쪽을 누른다(페이지 이동 아님, 토글만).
   - 로그인 화면이 뜨면: '로켓배송 공급사' 로그인 버튼 → 국가 '한국' 선택 → 허브 ID/비밀번호 입력 화면이 나온다. **세션이 남아 있으면 자동으로 통과되고, 입력 화면이 실제로 뜨면 아무것도 입력하지 않는다.** 그 경우 **"형, 허브(SUPPLIER HUB) 로그인 필요"** 한 줄 쓰고 끝낸다(재로그인 시도 금지).
   - 토글에 SUPPLIER HUB 자체가 없거나 상품이 하나도 안 보이면 ❌ "허브 토글 없음/상품 0개 — 화면 확인 필요"로 보고하고 끝낸다.
3. "광고 상품 설정" 에서 **'수동 상품 설정'**(원 안에 점 있는 기본 선택)이 선택돼 있는지 확인만 한다(이미 기본값).
4. 아래 "전체 상품" 목록 영역에서, 목록 밑 페이지 크기 선택을 **"100 / 페이지"** 로 바꾼다(기본값이 100이 아니면).
5. javascript_tool 로 아래 코드를 **그대로** 실행해 목록을 뽑는다. 결과는 JSON 문자열 — 항목 배열.

        (() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const btns = [...document.querySelectorAll('button')].filter((b) => clean(b.innerText) === '상품 선택')
          const items = []
          for (const btn of btns) {
            let el = btn
            for (let i = 0; i < 8 && el; i++) {
              const t = el.innerText || ''
              if (/ID\s*[:：]/.test(t) && /재고량/.test(t) && /원/.test(t)) break
              el = el.parentElement
            }
            if (!el) continue
            const text = clean(el.innerText)
            const idM = /ID\s*[:：]\s*(\d+)/.exec(text)
            const reviewM = /\(([\d,]+)\)/.exec(text)
            const priceM = /(\d{1,3}(?:,\d{3})*)\s*원/.exec(text)
            const stockM = /재고량\s*[:：]\s*(품절|[\d,]+)/.exec(text)
            const winnerM = /아이템\s*위너\s*[:：]\s*(\S+)/.exec(text)
            const rocket = /로켓배송/.test(text)
            const badges = []
            if (/광고효율\s*UP/.test(text)) badges.push('광고효율UP')
            if (/최근\s*인기\s*상품/.test(text)) badges.push('최근인기상품')
            if (/노출수\s*부족/.test(text)) badges.push('노출수부족')
            items.push({
              optionId: idM ? idM[1] : null,
              rawText: text.slice(0, 300),
              reviews: reviewM ? reviewM[1] : null,
              price: priceM ? priceM[1] : null,
              stock: stockM ? stockM[1] : null,
              itemWinner: winnerM ? winnerM[1] : null,
              rocket,
              badges,
            })
          }
          return JSON.stringify({ count: items.length, items })
        })()

6. **제목(title)은 JS 가 못 뽑으므로 접근성 트리(find/read_page)로 목록 순서대로 읽어 각 항목에 보충한다.** 목록의 각 줄은 보통 "뱃지(있으면) → 상품명(쉼표로 봉수·중량 포함) → 별점·후기수·ID·로켓배송 → 가격 → 재고량·아이템위너" 순서다. 5번 결과의 `optionId` 순서와 화면에서 보이는 순서가 같으므로, 위에서부터 순서대로 제목을 붙인다. 값이 안 맞으면(개수가 다르면) 접근성 트리로 전체를 다시 읽어 직접 짝짓는다.
7. 6번까지 한 결과를 아래 형식으로 정리해 결과 파일에 JSON **배열**로 쓴다 (Write).
   - stock: "품절" 이면 `"품절"` 그대로 적고(스크립트가 처리), 숫자면 쉼표 뺀 숫자만.
   - itemWinner: "선정"이면 `true`, 그 외(미선정 등)면 `false`. 아예 안 보이면 `null`.
   - price·reviews: 쉼표 뺀 숫자만.
8. 목록 맨 아래 페이지 번호 옆에 **다음 페이지(2)** 가 있고 1페이지가 꽉 찼으면(항목 100개), 2페이지로 **딱 1번만** 더 가서 5~7번을 반복해 합친다. 3페이지는 가지 않는다.
9. 다 됐으면 탭을 닫는다. 선택한 상품이 0개인지("선택한 상품 0") 확인하고 보고에 적는다.

## 결과 파일 형식 (배열, 항목 1개 = 원소 1개)
    [
      { "optionId": "95626139245", "title": "쌀쌀쌀 프리미엄 찰흑미, 1개, 2kg", "price": 15900, "stock": 2, "reviews": 1314, "rating": null, "itemWinner": true, "rocket": true, "badges": ["광고효율UP"] },
      { "optionId": "95631912692", "title": "쌀쌀쌀 프리미엄 찰흑미, 3개, 2kg", "price": 47700, "stock": "품절", "reviews": 1314, "rating": null, "itemWinner": true, "rocket": true, "badges": [] }
    ]
평점(rating)은 보통 별 아이콘이라 숫자가 없다 — 접근성 트리에 aria-label 등으로 숫자가 보이면 넣고, 없으면 `null` (어려우면 생략해도 된다).

## 하지 말 것
- 상품 선택·옵션 선택·다음·저장·삭제·캠페인 이름 입력 금지(위 "가장 중요한 것" 참고). 다른 메뉴(광고보고서·프로모션 관리·자동규칙 등) 클릭 금지.
- 광고센터 외 사이트(윙·허브·coupang.com) 접근 금지.
- 비밀번호·아이디·키 입력 금지. Playwright·curl·HTTP 요청 금지.
- 슬랙·메일·시트·DB 쓰기 금지. 파일은 결과 파일 1개만.
- 마진·손익 계산·언급 금지. 가격은 파일에만.

## 보고 형식 (마지막 출력, 이대로)
✅ 상품 N개 읽음 (페이지 M개) · 선택한 상품 0 확인 (결과 파일 경로)
로그인 필요면 "형, 광고센터 로그인 필요" 한 줄만. 그 외 실패는 ❌ 한 줄 + 이유.
