// 자동 재로그인 뒤 화면 상태 확인 — 로그인 성공 / 추가 인증(인증번호·보안문자) / 자격증명 오류 / 아직 로그인 화면 을 구분한다. 값은 안 읽고 상태만 돌려줌.
(() => {
  var u = location.href
  var text = (document.body && document.body.innerText) || ''
  var hasPw = !!document.querySelector('input[type="password"]')
  var urlLogin = /\/login|\/signin|xauth|accounts\.coupang|loginfast/i.test(u)
  var loggedIn = !hasPw && !urlLogin
  // 로그인된 화면(홈)의 일반 문구("본인확인" 안내 등)가 걸리지 않도록, 추가 인증·오류는 아직 로그인 화면일 때만 판단한다 (2026-10-24 시험: 로그인 성공 직후 홈 문구를 인증 화면으로 오판)
  var challenge =
    !loggedIn &&
    (/인증번호|보안문자|자동입력\s*방지|캡차|captcha|추가\s*인증|본인\s*확인|휴대폰\s*인증|문자\s*메시지.*인증|2단계/i.test(text) ||
      !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha, [class*="captcha" i]'))
  var badCred = !loggedIn && /(아이디|비밀번호).{0,12}(일치하지|올바르지|틀렸|확인해)|잘못된\s*(아이디|비밀번호)/.test(text)
  return JSON.stringify({ url: u.slice(0, 120), loggedIn: loggedIn, challenge: challenge, badCred: badCred })
})()
