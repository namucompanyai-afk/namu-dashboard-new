// 네이버 쇼핑 검색 결과 페이지에서 상품 목록을 뽑아 JSON 문자열로 돌려줌 (chrome-tab.applescript 의 execute javascript 로 실행)
//
// 광고 판별은 클래스 추측이 아니라 **네이버가 직접 붙이는 로그용 속성**을 쓴다 (2026-10-21 naver_dump_귀리_p1.html 로 확인):
//   모든 상품 요소에 data-nlog-params="{...JSON...}" 가 있고, 그 안에 is_ad(true/false) · slot_dtl_nv_mid(=상품ID) ·
//   slot_dtl_prod_nm(상품명) · slot_dtl_chnl_prod_nm(판매처) · slot_dtl_price(가격) 가 그대로 들어 있다.
//   같은 상품(nv_mid)에 img/title/zzim(찜) 등 여러 요소가 각각 data-nlog-params 를 갖고 있어 nv_mid 로 묶어 하나로 합친다.
(function () {
  var captcha = /보안\s*확인|자동\s*입력\s*방지|captcha|비정상적인/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')
  var els = document.querySelectorAll('[data-nlog-params]')
  var order = []
  var byMid = {}
  for (var i = 0; i < els.length; i++) {
    var raw = els[i].getAttribute('data-nlog-params')
    var j
    try {
      j = JSON.parse(raw)
    } catch (e) {
      continue
    }
    var mid = j.slot_dtl_nv_mid
    if (!mid) continue
    if (!byMid[mid]) {
      var rec = { id: mid, ad: false, title: '', mall: '', price: null, link: '' }
      byMid[mid] = rec
      order.push(rec)
    }
    var rec2 = byMid[mid]
    if (j.is_ad) rec2.ad = true
    if (j.slot_dtl_prod_nm) rec2.title = j.slot_dtl_prod_nm
    if (j.slot_dtl_chnl_prod_nm) rec2.mall = j.slot_dtl_chnl_prod_nm
    if (j.slot_dtl_price) rec2.price = j.slot_dtl_price
    if (!rec2.link && els[i].tagName === 'A' && els[i].href) rec2.link = els[i].href
  }
  var dump = ''
  if (order.length < 3) {
    // 상품을 거의 못 찾았으면(지연 로딩 등) 원인 파악용으로 본문 앞부분을 같이 돌려준다
    var cont = document.querySelector('[class*="list_basis"], [class*="basicList"], #content, main') || document.body
    if (cont) dump = cont.innerHTML.slice(0, 20000)
  }
  return JSON.stringify({ url: location.href, captcha: captcha, count: order.length, items: order, dump: dump })
})()
