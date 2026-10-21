// 네이버 쇼핑 검색 결과 페이지에서 상품 목록을 뽑아 JSON 문자열로 돌려줌 (chrome-tab.applescript 의 execute javascript 로 실행)
//
// 광고 판별은 클래스 추측이 아니라 **네이버가 직접 붙이는 로그용 속성**을 쓴다 (2026-10-21 naver_dump_귀리_p1.html 로 확인):
//   모든 상품 요소에 data-nlog-params="{...JSON...}" 가 있고, 그 안에 is_ad(true/false) · slot_dtl_nv_mid(=상품ID) 가 그대로 들어 있다.
//   상품명·판매처 키 이름은 광고 항목(slot_dtl_prod_nm 등 확인됨)과 일반(organic) 항목이 다를 수 있어(2026-10-22 16GB 시험 — 일반 항목은 다 빈 값)
//   키 이름을 짐작하지 않고 prod_nm/product_name/mall_nm/seller_nm 류를 느슨하게 찾는다(pick 함수). 그래도 없으면 이미지 alt·aria-label 로 보충.
//   같은 상품(nv_mid)에 img/title/zzim(찜) 등 여러 요소가 각각 data-nlog-params 를 갖고 있어 nv_mid 로 묶어 하나로 합친다.
(function () {
  var captcha = /보안\s*확인|자동\s*입력\s*방지|captcha|비정상적인/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')
  var els = document.querySelectorAll('[data-nlog-params]')
  var order = []
  var byMid = {}
  // 상품명·판매처 키 이름이 광고 항목(slot_dtl_prod_nm 등)과 일반 항목이 다를 수 있어(2026-10-22, 일반 항목은 전부 빈 값으로 나옴) 키 이름을 짐작하지 않고
  // "값"이 상품명·판매처로 보이는지(product/name/mall/seller/title 류 키 이름을 느슨하게 포함)로 찾는다. 여러 개면 가장 긴 값을 쓴다(보통 제목이 더 길다).
  var pick = function (j, re, exclude) {
    var best = ''
    for (var k in j) {
      if (!re.test(k)) continue
      if (exclude && exclude.test(k)) continue // 예: '_chnl_prod_nm'(판매처) 가 '_prod_nm'(상품명) 패턴에도 걸리는 걸 막음
      var v = j[k]
      if (typeof v === 'string' && v && !/^\d+$/.test(v) && v.length > best.length) best = v
    }
    return best
  }
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
    var t = pick(j, /prod[_-]?nm|product[_-]?name|item[_-]?name|^title$|^name$/i, /chnl|mall|seller|store|shop/i)
    var m = pick(j, /chnl[_-]?prod[_-]?nm|mall[_-]?(nm|name)|seller[_-]?(nm|name)|store[_-]?name|shop[_-]?name|^mall$/i)
    if (t && t.length > rec2.title.length) rec2.title = t
    if (m && m.length > rec2.mall.length) rec2.mall = m
    if (j.slot_dtl_price) rec2.price = j.slot_dtl_price
    if (!rec2.link && els[i].tagName === 'A' && els[i].href) rec2.link = els[i].href
    // data-nlog-params 에 이름이 전혀 없으면(일반 항목 스키마가 다를 수 있음) 같은 요소의 이미지 alt·aria-label 로 보충
    if (!rec2.title) {
      var img = els[i].tagName === 'IMG' ? els[i] : els[i].querySelector && els[i].querySelector('img[alt]')
      var alt = (img && img.alt) || els[i].getAttribute('aria-label') || ''
      if (alt && alt.length > 1) rec2.title = alt.trim()
    }
  }
  var dump = ''
  if (order.length < 3 || order.every(function (x) { return !x.title })) {
    // 상품을 거의 못 찾았으면(지연 로딩 등) 원인 파악용으로 본문 앞부분을 같이 돌려준다
    var cont = document.querySelector('[class*="list_basis"], [class*="basicList"], #content, main') || document.body
    if (cont) dump = cont.innerHTML.slice(0, 20000)
  }
  return JSON.stringify({ url: location.href, captcha: captcha, count: order.length, items: order, dump: dump })
})()
