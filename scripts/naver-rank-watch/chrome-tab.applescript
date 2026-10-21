-- 16GB 실제 크롬을 AppleScript 로 조종: 새 탭에 URL 열고 → 기다렸다가 → (옵션) 여러 번 스크롤해 지연 로딩 채우고 → JS 실행 결과(문자열) 돌려주고 → 탭 닫기
-- 사용: osascript chrome-tab.applescript <URL> <JS 파일 경로> [대기 초] [스크롤 횟수]
--   스크롤 횟수를 주면 메인 JS 실행 전에 "아래로 스크롤 → 1초 기다림" 을 그만큼 반복한다 (지연 로딩으로 처음엔 몇 개만 뜨는 목록용, 2026-10-21)
-- 전제(16GB 1회): 시스템 설정 > 개인정보 보호 및 보안 > 자동화 에서 호출한 쪽(터미널·osascript)이 Google Chrome 제어 허용
--               + Chrome 메뉴 보기 > 개발자 > "Apple Events 의 JavaScript 허용" 체크 (없으면 execute javascript 가 빈 값/오류)
-- 클로드 크롬 확장을 거치지 않으므로 확장의 사이트 차단 목록과 무관하고, 자동화 플래그가 없는 보통 크롬이라 캡차 가능성이 낮다
on run argv
  set theURL to item 1 of argv
  set jsPath to item 2 of argv
  set waitSec to 6
  if (count of argv) ≥ 3 then set waitSec to (item 3 of argv) as number
  set scrollTimes to 0
  if (count of argv) ≥ 4 then set scrollTimes to (item 4 of argv) as number
  set js to read (POSIX file jsPath) as «class utf8»
  tell application "Google Chrome"
    if (count of windows) = 0 then make new window
    set w to front window
    set t to make new tab at end of tabs of w with properties {URL:theURL}
    delay waitSec
    repeat scrollTimes times
      try
        execute t javascript "window.scrollTo(0, document.body.scrollHeight); window.scrollBy(0, -200);"
      end try
      delay 1
    end repeat
    set r to ""
    try
      set r to execute t javascript js
    on error errMsg
      set r to "__ERROR__ " & errMsg
    end try
    try
      close t
    end try
    return r
  end tell
end run
