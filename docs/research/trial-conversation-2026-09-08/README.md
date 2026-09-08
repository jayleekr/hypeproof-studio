# 체험 대화·GitHub 연결 화면 조사

2026-09-08 · [에픽 #844](https://github.com/jayleekr/hypeproof-studio/issues/844) ·
[GitHub #849](https://github.com/jayleekr/hypeproof-studio/issues/849).
[설계와 요구사항](../../design/trial-conversation-experience.md), [인수 검사](../../testing/trial-conversation-experience.md).
기존 [#746 조사](../agent-experience-2026-09-08/README.md)의 후속이며 중복 기능 개발을 지시하지 않는다.

## 직접 확인한 범위

설치된 Cursor **3.19.13**, macOS arm64, 기존 창 1018×659pt.
사용자가 요청한 연결 UX 관측을 위해 현재 창의 설정과 Connect GitHub 진입만 조작했다.
설정 값·요금제·저장소·권한·사용자 대화는 변경하지 않았다. 모델 호출도 하지 않았다.

| 화면 | 관측 | HP 요구사항 |
|---|---|---|
| [연결 진입](screenshots/cursor-connect-entry.png) — APP | Getting Started 1/3 안에 Connect GitHub | GHX-01,02: 목적을 알 때 연결하고 로컬 체험은 계속 가능 |
| [계정·요금제](screenshots/cursor-account-plan.png) — APP | 계정 관리와 Upgrade to Pro를 별도 행으로 배치 | CU-11~15: 모델 권한과 수업 포함 이용 범위 구분 |
| [Git & PRs](screenshots/cursor-git-prs.png) — APP | review provider, PR 열기 위치, AI 기여 표시, 브랜치 prefix를 구분 | GHX-06,07: 반영 대상·경로·이력 설명 |
| [설치 안내](screenshots/cursor-github-setup.png) — DOC | 연결, 저장소 범위 선택, 대시보드 복귀, 연결 해제 경로 | GHX-03~05,08 |
| [권한 안내](screenshots/cursor-github-permissions.png) — DOC | 권한별 목적을 표로 설명 | GHX-02,04: 필요한 동작과 범위 설명 |
| [복구 안내](screenshots/cursor-github-recovery.png) — DOC | 저장소 접근·PR 권한·앱 설치 문제를 구분 | GHX-09 |
| [공식 GitHub App](screenshots/cursor-github-app.png) — DOC | 앱 정체와 백그라운드 Agent 연결 목적 | GHX-02,03 |
| [사용량·한도](screenshots/cursor-usage-limits.png) — DOC | 이용량 확인과 추가 이용/플랜 변경 경로 | CU-12~15 |
| [Claude Artifacts](screenshots/claude-artifacts.png) — DOC | 대화와 별도 공간에서 결과물을 다룸 | CU-08~10 |

Connect GitHub 클릭은 `github.com/login/oauth/authorize`로 이동해 조직 인증을 요구하는
경계까지 실제 확인했다. **Authorize/Continue는 누르지 않았다.** 계정·조직·인증 query가 있는
원본은 공개 커밋에서 제외했다. 열었던 인증 탭은 닫았다. 연결 성공, 설치 권한 변경,
저장소 선택 후 반영, 해제 성공은 **NOT RUN**이다. 공식 문서 캡처로 실기 성공을 대체하지 않는다.

APP 이미지는 화면의 해당 영역을 직접 캡처해 계정명과 주변 개인 작업을 제외했다.
`native-capture.json`에 버전·시각·영역·해시를 기록했다. DOC 이미지는 별도 비로그인
Playwright 브라우저에서 열고 직접 시각 확인했다. HTTP 200만으로 내용 검증을 대신하지 않았다.
시각·URL·뷰포트·SHA-256은 `web-capture.json`에 기록했다.

## 패턴 해석

사용자 제공 Cursor 화면의 잠긴 모델을 누르면 프리미엄 모델 업그레이드 안내가 보인다.
무료 첫 경험 후 성능 필요가 생기는 위치에 유료 선택지를 놓은 것으로 해석한다.
현재 실제 설정에도 업그레이드 진입점이 있다. 이 관측으로 내부 사업 지표나 전환율을
알 수는 없다. HP는 같은 모양을 복제하기 전에 체험 제공분·수업 포함분·개인 선택의 주체를
구분하고, 한도 후에도 자기 결과물을 가져갈 수 있게 설계한다.

GitHub 연결 또한 단순 로그인 완료 화면으로 끝나지 않는다. 사용자가 자신의 결과를
어디에 보관하고 누가 수정할 수 있는지 알아야 한다. 연결과 공개 배포는 다른 동작이다.
HP의 GitHub App 방식/권한/실제 성공 경로는 구현 전에 결정·검증할 사항이다.

## 공식 근거와 재현

- [Cursor GitHub](https://prod.cursor.com/docs/integrations/github): 설치·권한 목적·복구 설명.
- [Cursor GitHub App](https://github.com/apps/cursor): 공식 앱 정체.
- [Cursor usage](https://prod.cursor.com/help/models-and-usage/usage-limits): 사용량·추가 이용.
- [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them): 결과물 분리.

`node docs/research/trial-conversation-2026-09-08/capture-web.mjs`는 공개 문서만 촬영한다.
개인 계정·쿠키를 가져오지 않는다. 실제 앱 캡처 재현은 해당 버전 창을 열고 메뉴/버튼을
직접 확인해야 하며 화면 좌표를 다른 버전에 그대로 적용하지 않는다.

## 공식 시연 영상의 연결 이후 화면

[VENDOR 원본](https://prod.cursor.com/docs-static/images/bugbot/bugbot-install.mp4)은
Cursor의 공개 설치 시연이다. 직접 승인한 우리 계정의 화면이 아니다.

- [6초: 설치·접근 범위 승인](screenshots/cursor-setup-vendor-6s.png) — GHX-02,04.
- [12초: 대시보드 복귀·설치 목록 로딩](screenshots/cursor-setup-vendor-12s.png) — GHX-03,11.
- [18초: 설치된 대상과 기능 설정](screenshots/cursor-setup-vendor-18s.png) — GHX-04,07.

`capture-vendor.mjs`가 실제 video 요소를 해당 시각으로 이동해 촬영하며
`vendor-capture.json`에 원본·시각·해시를 남긴다. 이 3장은 Bugbot 시연의 상태이고
일반 체험 채팅의 모든 연결 흐름이 같다는 뜻은 아니다.
