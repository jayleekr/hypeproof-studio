# 입력창의 수업 AI 이름 — 실제 접근성 트리 검수

2026-09-08, #746 / #747 / 제품 #788. 제출 `f180890`와 검수 `d7289bd`를
고정한 실제 Mac 앱 사본 + 로컬 Service/SQLite 실행이 exit 0으로 끝났다.
[원본 환경](environment.json)에 제품/검수 SHA와 실제 앱 bundle 해시가 있다.
기존 0.1.51 셸에 후보 확장/webview를 넣은 검수이며 새 앱 릴리스가 아니다.

[원본 결과](identity-result.json)의 `A7-composer`는 이름 전환·재연결을 포함한
8회 관측에서 `textbox`, 전체 이름 + `에게 보낼 메시지`, `ignored: false`를
확인했다. 서로 다른 이름은 제작 파트너, 검토 도우미, HTML처럼 보이는 문자,
유효한 40자 한글 이름, 레거시 코치의 5개다. DOM 속성뿐 아니라 실제 native
webview의 CDP `Accessibility.getPartialAXTree`에서 이름을 읽었다.
HTML 모양 문자는 그대로 텍스트이며 레거시 이름의 기존 접근성 선택자를 유지한다.

[실제 화면](a-fixed-name.png)은 직접 열어 수업과 현재 이름을 확인했다. 이 그림만으로
접근성 이름을 판정하지 않는다. [원본 해시](capture.json)와 생성 당시 결과의
`visual_review: PENDING`을 그대로 보존하고 여기서 후속 검수 범위를 기록한다.

기존 `e2e/lesson-studio/mac.mjs`의 `HPS_LESSON_IDENTITY=1` 경로를 재사용한다.
합성 확정 수업, 별도 사용자 데이터/작업 폴더, 실제 앱 사본과 고정 SHA가 필요하다.
이번 실행은 모델 요청을 사용하지 않았다. 전체 결과의 11개 항목 중 이름 전환과
레이아웃 대조는 이전 기능 A의 회귀 확인이며 독립된 11개 접근성 시나리오가 아니다.

스크린리더 발화, 전체 키보드/확대 접근성, Windows, 실제 AI 답변, 당시 이름의
이력 보존은 **NOT_RUN**이다. [기능 B의 실행 증거](../feature-b/README.md)와도
검수 범위를 구분한다. 이 변경은 입력창의 접근성 이름을 수업 이름에 맞추는 단위다.
