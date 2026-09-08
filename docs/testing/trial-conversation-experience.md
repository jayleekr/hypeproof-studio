# 체험 대화·GitHub UX 인수 검사

상태: 계획. [요구사항](../design/trial-conversation-experience.md) · [에픽 #844](https://github.com/jayleekr/hypeproof-studio/issues/844).
작성일 2026-09-08. 아래 표는 테스트 정의이며 실행 결과가 아니다.

| ID | 조건과 확인할 결과 | 요구사항 | 상태 |
|---|---|---|---|
| CUT-01 | 새 사용자·빈 폴더/기존 폴더: 대화 중심 진입, 입력·본문 배치 및 불필요 파일 없음 | CU-01,02 | NOT RUN (전체 UI) |
| CUT-02 | 짧은 명확한 요청/모호한 요청/질문 건너뛰기: 실행 또는 필요한 질문 하나 | CU-02, NAT-03 | #842 실기 부분 PASS, 아래 참조 |
| CUT-03 | 전송·예약·중지·재전송·중복 클릭: 정확히 한 실행, 초안 보존 | CU-03,04,17 | NOT RUN |
| CUT-04 | 업데이트·회고·긴 답변·Markdown: 입력 안 가림, strong/list/code/link 렌더 및 포커스 | CU-01,05,16 | NOT RUN |
| CUT-05 | 무변경/Read/Write/실패/취소 대조군: 실제 실행과 문구 일치, 내역 펼침 | CU-06,07 | NOT RUN |
| CUT-06 | 문서·웹·표: 결과물별 열기, 수정 비교, 되돌림 및 사용자 변경 보존 | CU-08,09,10 | NOT RUN |
| CUT-07 | 사용 가능/수업 제한/한도 소진/공급자 잔액 부족/사용량 미확인: 다른 안내 | CU-11~15 | NOT RUN (권한 UI) |
| CUT-08 | 390·768·1280·1920px, 200% 확대, 키보드 및 스크린리더 상태·포커스 | CU-01,16 | NOT RUN |
| CUT-09 | 연결 단절·인증 만료·재시작·부분 파일: 결과와 작성 중 입력 보존 | CU-17 | NOT RUN |
| CUT-10 | 첫 유용한 결과/직접 검토/재방문 각각 관측, 학습효과 또는 독립수행으로 오인하지 않음 | CU-18 | NOT RUN |

| ID | 조건과 확인할 결과 | 요구사항 | 상태 |
|---|---|---|---|
| GHXT-01 | GitHub 없이 새 체험 수행; 필요할 때만 연결 안내 | GHX-01,02,05 | NOT RUN |
| GHXT-02 | 정상 callback/취소/만료/replay/다른 계정/위조 state: 미승인 성공 없음 | GHX-03,11 | NOT RUN |
| GHXT-03 | 선택 저장소·조직 승인 대기·SSO·private·권한 없음·목록 빈 상태 | GHX-04,09,10 | NOT RUN |
| GHXT-04 | 실제 연습 저장소 diff 확인→브랜치/PR 반영→API 커밋 readback, 시크릿 대조군 차단 | GHX-05~07 | NOT RUN |
| GHXT-05 | 원격 선행 변경/충돌/오프라인/429/재시도: 중복 업로드와 사용자 변경 손실 없음 | GHX-07,09 | NOT RUN |
| GHXT-06 | 연결 해제/외부 철회 후 원격 요청 거절, 로컬 파일 유지, 재연결 가능 | GHX-08,09 | NOT RUN |
| GHXT-07 | 강사/학생/개인 경계: 다른 좌석·수업 토큰으로 GitHub 권한 재사용 불가 | GHX-10,12 | NOT RUN |
| GHXT-08 | 실제 Mac·Windows에서 브라우저 복귀/취소/재실행, 키보드 포커스·안전한 진단 | GHX-11,12 | NOT RUN |

합성 계약 검사를 정상/오류 대조군으로 먼저 검증하고 승인된 연습 저장소로 실제 경로를 실행한다.
운영 조직을 새로 연결하거나 공개 배포를 수행해 문서 테스트를 통과시키지 않는다.
Cursor 화면 조사에서 성공한 클릭은 HP GHXT의 PASS가 아니다.

## 실제 실행한 시작 동작 (#842)

20260908T232730Z · macOS arm64 · 공개 v0.1.56 shell에 수정 extension을 넣은 별도 앱.
Service/App 소스 base 18281a9 + 이 PR 변경. 원본 공개 앱의 검증으로 보고하지 않는다.
`HPS_TRIAL_ENTRY=1 HPS_NATIVE_PORT=8789 HPS_NATIVE_REUSE_DIR=/tmp/hps-842-app bash scripts/test-native-trial-laptop.sh tests/native-trial-entry.spec.ts`

- PASS: 빈 폴더의 모호한 요청에 파일 도구 실행 없음, index.html 언급/생성 없음 (Opus).
- PASS: 기존 index.html이 있는 폴더도 불필요 파일 도구 없음, 기존 파일 내용 동일 (Opus).
- PASS: 명시적 walk.md 요청 후 실제 Markdown 작성, 다음 웹 요청에 실제 index.html 작성, 앞 문서 보존 (Haiku).
- PASS: helper 파일 시스템 대조군은 empty 시작, legacy HTML 시작 및 사용자 파일 보존 확인.
- PASS: 정상 인증·열린 세션의 /v1/profile이 empty 정책 반환; legacy 웹 프로필 회귀.

기록: `e2e/test-results/native-trial/20260908T232730Z/`의 실행 manifest, 요청·응답,
도구 내역, 파일 확인, PNG. 실행 명령과 테스트 소스는 이 PR에 포함한다.
포트 8788은 다른 프로세스가 사용 중이어서 첫 시도는 preflight BLOCKED였고 종료하지 않았다.
이후 미사용 8789로 재실행했다. 새 UI 전체·GitHub·공개 배포·학습 효과는 이 결과에 포함하지 않는다.

## 증거 형식

각 실행에 앱 버전/소스 SHA/Service SHA/프로필/합성 사용자/뷰포트/요청/실제 응답/도구/파일
해시/확인한 URL·커밋/스크린샷/PASS·FAIL·BLOCKED·NOT RUN/원인·재실행을 기록한다.
인증값·개인정보·비공개 파일 내용은 공개 커밋에 넣지 않는다. 토큰 존재는 인증·접근 성공이 아니다.
