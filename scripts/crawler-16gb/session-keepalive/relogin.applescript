-- 16GB 쿠팡 자동 재로그인 (D안): 실제 크롬 새 탭에서 아이디·비번 칸을 JS로 채우고 로그인 버튼을 누른 뒤, 결과 상태만 돌려준다 (AppleScript, 확장·손쉬운 사용·화면 잠금 해제 필요 없음)
--   사용: COUPANG_ID=… COUPANG_PW=… osascript relogin.applescript <시작 URL> <relogin-fill.js 경로> <relogin-state.js 경로>
--   비번은 환경변수로만 받는다 (파일·로그·명령줄에 안 남김). 출력은 상태 JSON 한 줄뿐 — 아이디·비번 값은 절대 출력하지 않는다.
--   오류 메시지도 일부러 고정 문구만 돌려준다 (오류 본문에 코드가 섞여 나올 가능성 차단).
on replaceText(src, needle, repl)
  set AppleScript's text item delimiters to needle
  set parts to text items of src
  set AppleScript's text item delimiters to repl
  set outText to parts as text
  set AppleScript's text item delimiters to ""
  return outText
end replaceText

on jsString(s)
  -- JS 문자열 리터럴로 안전하게 (역슬래시·따옴표·줄바꿈)
  set s to my replaceText(s, "\\", "\\\\")
  set s to my replaceText(s, "\"", "\\\"")
  set s to my replaceText(s, return, "\\n")
  set s to my replaceText(s, linefeed, "\\n")
  return "\"" & s & "\""
end jsString

on run argv
  set theURL to item 1 of argv
  set fillPath to item 2 of argv
  set statePath to item 3 of argv
  set uid to system attribute "COUPANG_ID"
  set upw to system attribute "COUPANG_PW"
  if uid is "" or upw is "" then return "__ERROR__ 자격증명 없음"
  set fillTpl to read (POSIX file fillPath) as «class utf8»
  set stateJs to read (POSIX file statePath) as «class utf8»
  set fillJs to my replaceText(my replaceText(fillTpl, "__ID__", my jsString(uid)), "__PW__", my jsString(upw))
  set upw to ""
  set uid to ""
  tell application "Google Chrome"
    if (count of windows) = 0 then make new window
    set w to front window
    set t to make new tab at end of tabs of w with properties {URL:theURL}
    delay 7
    set fillResult to ""
    try
      set fillResult to execute t javascript fillJs
    on error
      try
        close t
      end try
      return "__ERROR__ 입력 실행 실패"
    end try
    set fillJs to ""
    -- 로그인 직후 화면이 넘어가는 중일 수 있어서 최대 6번(약 24초) 지켜본다. 로그인됨이 보이면 바로 끝, 아니면 마지막 상태를 돌려준다 (2026-10-24: 9초 뒤 한 번만 보다가 넘어가는 중 화면을 인증 화면으로 오판)
    set stateResult to "\"상태 확인 실패\""
    repeat 6 times
      delay 4
      try
        set stateResult to execute t javascript stateJs
        if stateResult contains "\"loggedIn\":true" then exit repeat
      on error
        set stateResult to "\"상태 확인 실패\""
      end try
    end repeat
    try
      close t
    end try
    return "{\"fill\":" & fillResult & ",\"state\":" & stateResult & "}"
  end tell
end run
