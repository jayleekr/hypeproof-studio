# 개인 체험 UI·UX 실행 기록 — 2026-09-08

추적: [#758](https://github.com/jayleekr/hypeproof-studio/issues/758). [요구사항](../requirements/studio-native-trial-ux.md)과 [테스트 계약](studio-native-trial-ux.md)은 실행 결과와 별도로 관리한다.

브라우저는 실제 빌드된 React와 실제 registry의 체험 프로필을 사용했다. host 응답·관찰 시료는 합성 데이터다. 실제 Mac은 별도 앱 사본·user-data-dir·workspace에서 실행했다. 사용 중인 개인 체험 앱과 원본 설치 앱은 테스트 대상으로 사용하지 않았다.

## 실행한 검사

| 범위 | 결과 | 근거 |
|---|---|---|
| 브라우저 43개 시나리오 | PASS 43 / FAIL 0 | `e2e/test-results/trial-ux/2026-09-08T16-50-13-849Z/report.json`; 시작 10, 채팅 14, 관찰 10, 조건부 6(오류 복구 대조군 포함), 화면 폭 2, 접근성 1 |
| Mac 코드 입력 → 실제 모델 → 파일 생성·수정 | PASS | `e2e/test-results/native-trial/20260908T153942Z/`: 실제 provider request ID, 입력/응답, 초기·수정 파일과 SHA |
| Mac 관찰·정정·앱 재시작 | PASS | 같은 실행의 `observation-results.png`, `reloaded.png`; 실제 관찰 API와 보존 기록. 합성 사용자이며 학습 효과 검증은 아님 |
| Mac 대화 삭제 취소·확정 | PASS | `clear-confirmation.png`, `clear-complete-files-preserved.png`, `ui-host-result.json`; 취소 시 대화 유지, 확정 후 파일·관찰 보존 |
| Mac 호스트 추가 6개 | PASS 6 / FAIL 0 | `e2e/test-results/native-trial/20260908T154645Z/`와 해당 실행 로그: 실제 승인 창 취소·작업 폴더 경계·설정 열기·오류 복구·격리된 신고 수신기. 승인-only 시료는 명령을 실제 실행하지 않음 |
| Worker / Chalk / extension | PASS | 각 전체 테스트와 typecheck. extension에는 삭제 확인·중복·진행 중 차단·신원 변경 대조군 및 공통 안내 용어 검사를 포함 |
| 치과 authoring demo / reference browser | PASS | 기존 L1–L5 예제 검사. 실제 치과의사의 Studio 독립 수행 증거가 아님 |
| 문서 검사 | PASS | `scripts/docs-harness/check.py --min-score 95`: 100/100 |
| 실제 운영 Service | PASS | 배포 [34238918748](https://github.com/jayleekr/hypeproof-studio/actions/runs/34238918748), `w0.0.0-dev+fe6f7b5`; health, 정상 freeze, additive migration, SDK canary 6/6 |
| 운영 개인 체험 API | PASS | 합성 계정 발급·profile/context·실제 관찰 모델·사용량 정산·폐기 후 401. 테스트 grant 폐기 완료; 다른 참가자 roster를 덮어쓰지 않기 위해 합성 행은 보존 |

첫 브라우저 실행에서는 대화 삭제 버튼의 이전 번들, scope 전환 상태 잔류, 390px 입력창 넘침을 확인했다. 수정 중 만들어진 혼합 번들 실행은 최종 증거로 사용하지 않는다. 위 43개 결과는 수정된 번들의 전체 재실행이다. 새 detector는 정상 요청·다른 요청·요청 없음 대조군부터 통과했다. 접근성 수정 후 고정 코치를 이전 버튼 selector로 찾던 검사를 실제 고정 이름 요소로 고쳤다. 15:47 실행은 42 PASS / 1 FAIL이며, 15:53:43 재실행은 43 PASS / 0 FAIL이다. 16:24:19에는 각 시나리오의 보이는 조작 요소에 접근성 이름·활성 요소의 tabIndex와 실제 focus 검사를 추가해 43 PASS / 0 FAIL로 다시 실행했다. 스크린리더 또는 모든 실제 키보드 이동 경로를 검증한 것은 아니다. CI의 누락된 esbuild 의존성은 테스트 패키지에 직접 선언했다.

기존 승인 테스트의 첫 실행은 실패했다. `destructive` 분류와 command payload를 전달하지 않은 시료에서 파일 생성 여부만으로 승인 대기를 추측하던 테스트였다. 실제 대화상자가 표시되는지, 항상 허용이 없는지, 취소 결과가 거절인지 확인하도록 수정하고 6개 호스트 검사를 다시 실행해 통과했다.

실제 Mac의 401·429·503·timeout·구형 Service 대조군도 각각 PASS했다. 다른 참여 코드 연결 후 이전 시작 상태가 남던 문제는 호스트 상태 초기화로 수정했으며, 같은 workspace에서 두 합성 사용자 간 대화·관찰 분리와 원래 사용자 기록 복원을 실제 API로 재실행해 PASS했다.

## 추가 Mac 호스트 관측

- `20260908T155744Z`: 4 PASS. 실제 탐색기·설정, simple folder dialog 취소, 연결 해제·재연결·파일 보존, 신고 최소 길이·세 단계 Escape·로컬 수신기 성공/실패. 운영 신고나 알림을 전송하지 않았다.
- `20260908T160612Z`: 미리보기 PASS. 실제 채팅의 Run → 로컬 URL HTTP 200 → 네이티브 브라우저의 390/1280/390px iframe → 원본 크기 이동. `native-preview.json`과 두 화면 캡처를 남겼다. HTML은 합성 조작 시료다.
- 미리보기 초기 실패는 두 관측 조건에서 발생했다. 이전 cohort history 시딩은 새 개인 scope의 대화를 채우지 않으므로 실제 채팅 경로로 바꿨다. 숨겨진 앱에서는 네이티브 페이지 캡처가 정지했고, 화면 밖에 표시한 실행에서 캡처·너비 전환을 다시 확인했다. 초기 실패·중단 기록은 최종 PASS와 분리해 보존했다.
- 셸의 일반 ‘항상 허용’은 현재 체험 SDK에서 노출되지 않는다. 비파괴 Bash는 상위 정책이 자동 허용한다. 해당 창을 기다린 초기 검사는 판정 오류였으며 요구사항에 노출 조건을 정정했다. 제품 승인 정책은 변경하지 않았다.

- `20260908T161236Z`: 실제 SDK 셸 PASS. 비파괴 mkdir 자동 실행, 강한 확인에서 mv 실행, 다음 mv를 Escape로 거절한 후 파일 상태를 확인했다. 절대·상대 작업 경로와 승인 detail selector를 실제 구현에 맞춘 후 재실행했다.
- `20260908T161856Z`: 실제 SDK 브라우저 PASS. loopback 자동 열기의 최종 LiveServer URL에서 HTTP 200, 예약 테스트 origin의 한 번 열기·항상 허용·재사용, 다른 origin의 취소와 요청 부재를 확인했다. 앱 내부 resolver 외에 DNS를 변경하지 않았다.
- `20260908T162521Z`: 새 작업 폴더 선택 PASS. 실제 simple dialog로 별도 폴더를 열고 창 제목·시작 화면·기존/새 폴더 파일을 확인했다.
- `20260908T162528Z`: 실제 SDK 브라우저 입력 PASS. 로컬 합성 폼에서 입력 취소 후 빈 값, 승인 후 지정한 값과 미제출 상태를 실제 DOM으로 확인했다.

- `20260908T164351Z`: 공개 v0.1.54의 이미지 조작 PASS. 합성 paste/drop으로 서로 다른 이미지 두 장을 넣고 디코딩, 선택 이미지 마우스 삭제, 남은 이미지 Enter 삭제, 초안 보존을 확인했다. OS 클립보드는 변경하지 않았다. 초기 실패는 합성 드래그 뒤 VS Code의 바깥 iframe 차단 상태가 남은 관측기 문제였다. 실제 포인터 이동으로 드래그 상태를 끝낸 뒤 정상 hit testing을 거친 클릭으로 재실행했다. DOM click 또는 React handler 호출로 통과시키지 않았다.

- `20260908T164452Z`: 공개 v0.1.54 추가 호스트 suite 7 PASS / 0 FAIL. 신고 3개, 이미지 1개, 시작·연결 이동, 작업 폴더 선택, 실제 Run/viewport를 같은 수정 없는 배포 앱에서 재실행했다.

- `20260908T164646Z`: 최신 main의 Service 지침과 공개 Mac 0.1.54 조합에서 기본 실제 모델·파일·관찰·정정·재시작·대화 삭제 검사 PASS. App source는 9ebed63이며 Service는 최신 main을 사용한 후속 브랜치 ab2c7cd 기준이다.
- `20260908T164943Z`: 신고 추가 분기 3 PASS. 취소/수신 실패 재검사와 명시적 대화 첨부 선택, 연락처 201자 거절·공백 정리, 로컬 수신 결과를 확인했다. 격리된 빈 대화 기록을 사용했으므로 실제 대화 내용 첨부 검증으로 확대하지 않는다.
- `2026-09-08T16-50-13-849Z`: 최신 main에 맞게 webview를 다시 빌드한 브라우저 전체 43 PASS / 0 FAIL. 앞선 16:46 실행은 최신 AI 이름 selector와 이전 로컬 번들을 섞어 42 PASS / 1 FAIL이었다. 빌드 후 재실행으로 해결했으며 실패 기록은 보존한다. 0.1.54 이후 main에 추가된 강사 지정 AI 이름 기능을 0.1.54에 포함됐다고 주장하지 않는다.

## 수정한 제품 문제

- 수업 전환: 검증된 새 연결은 시작 전 상태로 표시한다. 실패한 코드 교체는 기존 연결과 시작 상태를 유지한다.
- 대화 지우기: 확인 없이 삭제하던 동작에 확인/취소를 추가했다. 처리 중·중복 요청을 차단하고 확인 중 사용자가 바뀌면 삭제하지 않는다. 관찰 기록과 파일은 삭제 범위가 아님을 안내한다.
- 관찰 패널: 다른 scope로 바뀔 때 정정 초안·오류·학습 링크·관찰 건수를 포함해 초기화한다. 같은 scope의 설정 갱신은 초안을 보존하며 늦게 도착한 다른 scope의 batch는 무시한다.
- 오류 복구: 다시 열기에서 crash 상태를 초기화하고 host의 보존 상태를 다시 요청한다. 복구할 수 없는 데이터를 새 성공 결과로 표시하지 않는다.
- 좁은 화면: 채팅 입력창의 테두리·padding 때문에 390px 화면을 6px 넘기던 문제를 수정했다.
- 접근성: 채팅 입력창과 설정 버튼에 조작 이름을 붙이고, 출처 링크를 listitem으로 위장한 button 역할을 바로잡았다. 변경 가능한 코치 이름은 키보드로 조작 가능한 버튼으로 제공한다.
- 공통 문구: 체험판·일반판의 인증 안내에서 ‘선생님’과 ‘새 토큰’을 제거했다. ‘참여 코드’, ‘코드 발급 담당자’, ‘운영 담당자’를 역할에 맞게 사용한다.

## 판정 범위와 남은 검사

43개 브라우저 시나리오의 성공은 OS 동작까지 43개 모두 성공했다는 뜻이 아니다. 실행한 하위 조건은 다음과 같이 연결한다.

| 요구사항 | 확인한 범위 | 아직 완료로 판단하지 않은 범위 |
|---|---|---|
| TUX-HOST-01 | 실제 시작/채팅, 파일·설정 열기, 폴더 취소/선택, 연결 해제/재연결, 파일 보존 | macOS 시스템 파일 대화상자와 모든 반복 조합 |
| TUX-HOST-02 | SDK 비파괴 자동 실행, 강한 확인 실행/거절, 거절 시 미실행 | 현재 native SDK에 노출되지 않는 일반 승인 기억 경로는 조건부 |
| TUX-HOST-03 | loopback 실제 URL, 예약 origin 열기/기억/재사용/다른 origin 취소 | 공개 사이트·실제 외부 DNS 검증은 범위 밖 |
| TUX-HOST-04 | 명시적 Write 거절과 파일 부재, 브라우저 입력 거절/승인과 실제 값 | 이 결과는 인증·결제·실제 개인정보 폼 사용 승인이 아님 |
| TUX-HOST-05 | 최소 길이, 세 단계 취소, 기본 미첨부/명시적 첨부(빈 기록), 연락처 검증, 성공 ID·수신 실패 | 실제 사용자 대화 첨부·운영 신고는 사용하지 않음 |
| TUX-HOST-06 | Run, 실제 390/1280/390px iframe, 원본 URL 이동 | 실제 휴대전화·공개 배포 검증은 범위 밖 |
| TUX-HOST-07 | 공개 앱 직접 설치/실행과 별도 단위 fixture | 앱 내 전체 업데이트·재시작·실패 복구 NOT_RUN |
| TUX-CHAT-06 | 실제 webview 합성 이미지 입력, 디코딩, 마우스/Enter 삭제와 초안 보존 | OS 클립보드·Finder 드래그는 NOT_RUN |
| TUX-COND-06 / A11Y | native에 불필요한 프로필 조작 미노출, 각 시나리오 조작 이름/직접 focus | 다른 프로필 전체 조작, VoiceOver·전체 Tab 이동은 NOT_RUN |

실패·중단한 관측 기록은 성공 실행과 분리해 남겼으며, 미실행 항목을 다른 레이어의 PASS로 덮지 않았다.

TUX-HOST-08의 앱 재시작은 in-memory credential을 다시 입력한 조건에서 PASS다. macOS Keychain 지속성은 NOT_RUN이다. 실제 Windows 기기와 T25 사람 파일럿도 NOT_RUN이며 CI 빌드로 대체하지 않는다.

## 출시 상태

Service는 배포됐다. [#760](https://github.com/jayleekr/hypeproof-studio/pull/760)은 최신 CI 18개 통과 후 `9ebed633e5b1e94a514a3b0731758faf36fc4177`로 머지됐다. App `v0.1.53`은 빌드를 취소한 미공개 태그로 보존한다.

[v0.1.54 공개 릴리스](https://github.com/jayleekr/hypeproof-studio-releases/releases/tag/v0.1.54)는 위 merge SHA에서 빌드했다. [Mac 빌드](https://github.com/jayleekr/hypeproof-studio/actions/runs/34247970082), [Windows 빌드](https://github.com/jayleekr/hypeproof-studio/actions/runs/34247970181), [공개 미러](https://github.com/jayleekr/hypeproof-studio/actions/runs/34251442615)가 모두 성공했다. 정상 live-session freeze를 통과했으며 override하지 않았다. 공개 Mac ZIP의 SHA-256 `ff9ea037e294d2818f1770e162e1b459ac94fe2d080283593240eab9c75421d3`은 원본·미러 asset digest와 일치한다.

내려받은 Mac 번들의 `codesign --verify --deep --strict`, product 버전/코드 SHA와 확장 버전 확인이 통과했다. 확장을 주입하지 않은 정식 앱으로 `20260908T163437Z`의 실제 API·모델·파일 생성/수정·관찰/정정·재시작·대화 삭제 검사를 다시 실행해 PASS했다. 이전 개발 사본에 0.1.54 검증 모드를 적용한 음성 대조군은 실행 전에 거절됐다. 이 검사는 공개 앱이 로컬 합성 Service에서 실행된 증거이며, 운영 Service에서 동일 조합으로 완주했다고 확대하지 않는다.

로컬 체험 실행기는 별도 `releases/v0.1.54` 앱을 다음 실행부터 사용한다. 실행 중인 사용자 앱과 기존 `/Applications` 앱·파일을 보존했다. 되돌릴 때는 보존한 실행기와 기존 개발 앱 또는 공개 v0.1.52를 사용한다. 앱 내 자동 업데이트의 설치·재시작·실패 복구(TUX-HOST-07)는 이 직접 설치 검사와 별도로 NOT_RUN이다. 현재 updater의 재실행은 일반 `open`으로 실행되므로 격리 user-data 인자를 잃는 경로를 안전하게 검증할 fixture가 더 필요하다.

로컬 증거의 기준 디렉터리는 `.claude/worktrees/studio-trial/e2e/test-results/`다. 자격 증명은 이 디렉터리 밖에서 접근 권한을 제한해 보관했다. 브라우저 시료에 포함된 문자열은 합성 코드이며 실제 코드·키·참가자 정보는 커밋하지 않는다.
