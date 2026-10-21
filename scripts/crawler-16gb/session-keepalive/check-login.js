// 로그인 유지 확인용 — wing/허브/광고센터 홈을 열어 로그인 폼이 보이는지만 확인한다 (osascript 가 실행, chrome-tab.applescript 재사용)
(() => {
  var hasPw = !!document.querySelector('input[type="password"]')
  var u = location.href
  var urlLogin = /\/login|\/signin|xauth|accounts\.coupang|loginfast/i.test(u)
  var title = document.title || ''
  return JSON.stringify({ url: u, title: title.slice(0, 80), loggedOut: hasPw || urlLogin })
})()
