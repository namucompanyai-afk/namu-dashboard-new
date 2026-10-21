// 네이버 쇼핑 검색 결과 페이지에서 목록 항목을 뽑아 JSON 문자열로 돌려줌 (chrome-tab.applescript 의 execute javascript 로 실행)
// 광고 식별 규칙은 실제 DOM 을 봐야 확정 — 첫 시험에서 dump(목록 영역 innerHTML 앞부분)를 같이 저장해 확인한다
(function () {
  var txt = function (e) { return (e && e.innerText ? e.innerText : '').replace(/\s+/g, ' ').trim() }
  var idsIn = function (h) {
    var out = []
    var res = [/\/products\/(\d+)/g, /\/catalog\/(\d+)/g, /[?&]nvMid=(\d+)/g, /[?&]productId=(\d+)/g, /[?&]catalogId=(\d+)/g]
    for (var i = 0; i < res.length; i++) { var m; while ((m = res[i].exec(h))) out.push(m[1]) }
    return out.filter(function (v, i, a) { return a.indexOf(v) === i })
  }
  var captcha = /보안\s*확인|자동\s*입력\s*방지|captcha|비정상적인/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')
  // 목록 항목 후보: 클래스에 product_item / adProduct_item / list_item 이 든 요소 (네이버가 자주 바꿔서 넓게 잡음)
  var nodes = document.querySelectorAll('[class*="product_item"], [class*="adProduct_item"], [class*="list_item"], li[class*="item"]')
  var items = []
  var seen = []
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i]
    if (seen.some(function (s) { return s.contains(el) })) continue // 중첩 중복 제거 (바깥 요소 우선)
    var links = el.querySelectorAll('a[href]')
    var link = ''
    for (var j = 0; j < links.length; j++) { var h = links[j].href; if (/\/products\/\d+|\/catalog\/\d+|nvMid=|adcr\.nhn|cr\.shopping|cr2\.shopping/.test(h)) { link = h; break } }
    if (!link) continue
    seen.push(el)
    var cls = el.className || ''
    var t = txt(el)
    var ad = /adProduct|_ad_|\bad\b/i.test(cls) || /adcr\.nhn|cr2?\.shopping\.naver\.com\/adcr/.test(link) || /^광고\b/.test(t) || !!el.querySelector('[class*="ad_label"], [class*="adLabel"], [class*="ad_badge"]')
    var titleEl = el.querySelector('[class*="title"], [class*="name"]')
    var mallEl = el.querySelector('[class*="mall"], [class*="seller"], [class*="store"]')
    items.push({ ad: ad, title: titleEl ? txt(titleEl).slice(0, 120) : t.slice(0, 120), mall: mallEl ? txt(mallEl).slice(0, 60) : '', link: link.slice(0, 300), ids: idsIn(link), cls: cls.slice(0, 80) })
  }
  var dump = ''
  var cont = document.querySelector('[class*="list_basis"], [class*="basicList"], #content, main') || document.body
  if (cont) dump = cont.innerHTML.slice(0, 60000)
  return JSON.stringify({ url: location.href, captcha: captcha, count: items.length, items: items.slice(0, 120), dump: dump })
})()
