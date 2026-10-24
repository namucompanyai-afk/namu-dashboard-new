// 자동 재로그인 — 로그인 화면의 아이디·비번 칸을 채우고 로그인 버튼을 누른다. relogin.applescript 가 __ID__ / __PW__ 를 메모리에서만 바꿔 끼워 실행한다.
// 돌려주는 값은 상태 JSON 뿐 (값 자체는 절대 안 돌려줌).
(() => {
  var ID = __ID__
  var PW = __PW__
  var visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) && getComputedStyle(el).visibility !== 'hidden'
  var pw = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).filter(visible)[0]
  if (!pw) return JSON.stringify({ ok: false, reason: 'no_password_field', url: location.href.slice(0, 100) })
  var form = pw.form || document
  var cands = Array.prototype.slice.call(form.querySelectorAll('input')).filter(function (el) {
    var t = (el.getAttribute('type') || 'text').toLowerCase()
    return visible(el) && el !== pw && (t === 'text' || t === 'email' || t === 'tel')
  })
  var byName = cands.filter(function (el) { return /id|user|login|email|account/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || '')) })
  var idEl = byName[0] || cands[0]
  if (!idEl) return JSON.stringify({ ok: false, reason: 'no_id_field', url: location.href.slice(0, 100) })
  var setVal = function (el, v) {
    var proto = Object.getPrototypeOf(el)
    var desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    el.focus()
    desc.set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  setVal(idEl, ID)
  setVal(pw, PW)
  ID = ''
  PW = ''
  var btn = Array.prototype.slice.call(form.querySelectorAll('button, input[type="submit"]')).filter(visible).filter(function (b) {
    var txt = (b.innerText || b.value || '').replace(/\s+/g, '')
    return b.type === 'submit' || /로그인|login|signin/i.test(txt)
  })[0]
  if (!btn) return JSON.stringify({ ok: false, reason: 'no_login_button', url: location.href.slice(0, 100) })
  var idFilled = (idEl.value || '').length > 0
  var pwFilled = (pw.value || '').length > 0
  btn.click()
  return JSON.stringify({ ok: true, idFilled: idFilled, pwFilled: pwFilled })
})()
