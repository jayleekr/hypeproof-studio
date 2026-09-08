# 개인 체험 UI·UX 테스트

추적: [#758](https://github.com/jayleekr/hypeproof-studio/issues/758). 기준은 [화면별 조작 요구사항](../requirements/studio-native-trial-ux.md)의 `TUX-*` ID다. 상위 API·권한·관찰·사람 파일럿 테스트 [T01~25](studio-native-trial-validation.md)는 유지한다. 이 문서는 실행 계획과 판정 계약이며 PASS 보고서가 아니다. [2026-09-08 실행 결과](studio-native-trial-ux-results-2026-09-08.md)는 별도로 기록한다.

## 실행 범위

| ID 범위 | 최소 테스트 | 실제 결과를 확인할 위치 |
|---|---|---|
| TUX-SP-01~10 | 실제 React에서 입력·버튼·상태 분기 + Electron 연결/시작/폴더·패널 이동 | `e2e/trial-ux/run.mjs`, 기존 `e2e/tests/native-trial-live.spec.ts`, `startPage` 호스트 테스트 |
| TUX-CHAT-01~14 | 실제 React에서 전송·키보드·예약·이미지·코드·링크·오류 + 실제 호스트 전송/중지/삭제 | `e2e/trial-ux/run.mjs`, extension smoke, Electron 기록 |
| TUX-OBS-01~10 | 실제 React에서 기록·동의·평가·정정·scope 전환 + 실제 평가 API/저장·재시작 | `e2e/trial-ux/run.mjs`, native observation 계약/실제 API, Electron 기록 |
| TUX-COND-01~06 | 조건별 controlled host 이벤트로 실제 React 렌더 + 설치/복구 호스트 검증 | `e2e/trial-ux/run.mjs`, updater·error boundary smoke, 별도 앱 사본 |
| TUX-HOST-01~08 | 실제 Electron·OS·파일시스템·로컬 신고 수신기 | `e2e/tests/native-trial-live.spec.ts`, `native-entry-controls.spec.ts`, `native-approval-controls.spec.ts`, `native-browser-input.spec.ts`, `26-report-resilience.spec.ts` 및 실제 앱 실행 기록 |
| TUX-A11Y-01~04 | 브라우저 DOM/키보드/viewport + 실제 앱 focus·늦은 응답·좁은 패널 | `e2e/trial-ux/run.mjs`, Electron 화면·입력 기록 |

모의 호스트 응답과 합성 관찰 시료는 **UI 분기 검사**로 표시한다. 클릭 후 `postMessage`가 전달돼도 OS 창, API, 실제 파일 변경은 아직 검증하지 않은 것이다. 실행 보고서는 같은 ID라도 `browser`, `host contract`, `Electron`, `real API`, `release artifact` 범위를 나눠 기록한다. 보이지 않는 조건을 임의로 켠 호환성 시험은 기본 체험 버튼 전수 검사와 별도로 집계한다.

## 실행 순서와 증거

1. 코드 SHA, dirty diff, 앱 셸/확장 버전·해시, Service 주소와 코드 SHA, SDK 버전, 합성 프로필을 기록한다. 토큰·API 키·실제 참가자 정보는 기록하지 않는다.
2. 현재 소스와 렌더된 화면에서 조작 목록을 확인한다. 새 판정기는 양성·음성 대조군을 먼저 실행한다. 예: busy 중 두 번 전송되면 실패, 정상 enabled 버튼은 한 번 전송되면 통과, 다른 scope의 결과는 표시되면 실패한다.
3. 브라우저 검사는 빌드된 React와 격리한 host bridge를 사용한다. 각 ID의 입력·host 이벤트·화면 결과·스크린샷을 남긴다. 사용자가 만든 파일이나 운영 신고 수신기를 쓰지 않는다.
4. 실제 앱은 별도 user-data-dir와 합성 workspace를 사용한다. 시작 버튼의 정상·만료 대조군, 채팅·중지, 관찰·정정·재시작, 대화 삭제 취소/확정, 렌더 오류 복구를 실제 webview에서 검사한다. 기존 앱·세션·사용자 파일을 보존한다.
5. 관련 변경의 extension/Worker 테스트·typecheck, 브라우저 UX 전체 suite, 필요한 실제 앱 검증을 실행한다. 테스트가 실패하면 관측기·환경·제품 중 원인을 구분하고 수정한 코드에서 해당 경로를 재실행한다.
6. 퍼블리시는 검증과 병렬로 준비할 수 있다. 최종 공개 설치본은 검증된 커밋을 빌드해야 하며 진행 중인 세션 보호와 정상 release gate를 따른다. PR CI, 머지 SHA, 배포 run, 설치본 버전·SHA와 실제 실행 결과를 따로 기록한다.

실행 진입점:

```bash
npm --prefix extensions/hypeproof-chat test
npm --prefix extensions/hypeproof-chat run typecheck
npm --prefix extensions/hypeproof-chat/webview-ui run build
node e2e/trial-ux/run.mjs
npm --prefix worker test
npm --prefix worker run typecheck
bash scripts/test-native-trial-laptop.sh
```

추가 Mac 호스트 검사(합성 코드·별도 앱 사본):

```bash
HPS_NATIVE_MANAGED=1 HPS_NATIVE_HOST=1 bash scripts/test-native-trial-laptop.sh
HPS_QUIET_NO_HIDE=1 HPS_NATIVE_MANAGED=1 HPS_NATIVE_EXTRA=1 bash scripts/test-native-trial-laptop.sh
HPS_NATIVE_MANAGED=1 HPS_NATIVE_APPROVAL=1 bash scripts/test-native-trial-laptop.sh --grep 'real shell:'
HPS_NATIVE_MANAGED=1 HPS_NATIVE_APPROVAL=1 bash scripts/test-native-trial-laptop.sh --grep 'real browser:'
HPS_NATIVE_MANAGED=1 HPS_NATIVE_INPUT=1 bash scripts/test-native-trial-laptop.sh
```

이미 만든 검사 앱은 `HPS_NATIVE_REUSE_DIR`로 재사용할 수 있다. 스크립트가 현재 확장·webview 해시와 다르면 거절한다. `HPS_QUIET_NO_HIDE=1`은 창을 화면 밖에 표시하되 앱 전체를 숨기지 않게 해 네이티브 미리보기 캡처가 진행되도록 한다. Run 검사의 HTML은 합성 시료를 실제 모델 채팅으로 돌려받은 것으로, 학생의 독립 제작 결과가 아니다. 폴더 선택 검사는 VS Code의 simple dialog 설정에서 실행하며 macOS 시스템 파일 선택 창과 구분한다.

공개 설치본 검사는 GitHub asset digest와 내려받은 ZIP의 SHA-256을 먼저 대조한 뒤 압축을 푼다. `HPS_NATIVE_REUSE_DIR`에 그 폴더, `HPS_APP_PATH`에 그 안의 앱을 지정한다. 다음 옵션은 앱 버전·코드 SHA·확장 버전을 확인하며 확장 주입을 허용하지 않는다. 기존 개발 사본을 넣으면 검사 시작 전에 실패해야 한다.

```bash
HPS_NATIVE_RELEASE_VERIFY=1 \
HPS_NATIVE_RELEASE_VERSION=0.1.54 \
HPS_NATIVE_RELEASE_SHA=9ebed633e5b1e94a514a3b0731758faf36fc4177 \
HPS_NATIVE_MANAGED=1 HPS_NATIVE_UI=1 HPS_NATIVE_OBSERVATION=1 \
HPS_QUIET_NO_HIDE=1 bash scripts/test-native-trial-laptop.sh
```

예약 테스트 호스트는 해당 앱의 resolver에서만 loopback으로 연결한다. 브라우저 열기·입력은 실제 SDK와 DOM 결과를 확인하되 공개 사이트 검증으로 집계하지 않는다. loopback 열기는 Studio 자체 LiveServer로 주소를 보정하므로 요청한 임의 포트와 최종 확인 URL을 구분한다.

실제 앱 스크립트의 옵션·외부 요건은 [랩탑 실행 안내](studio-native-trial-laptop.md)를 따른다. 특정 옵션만 실행했으면 전체 앱 suite 통과로 보고하지 않는다. 이미 실행 중인 스크립트를 수정하지 않는다. 앱 전체 빌드를 로컬에서 자동 실행하지 않는다.

## 판정과 리포트 형식

`PASS`: 해당 입력과 결과를 실제 실행으로 확인했다. `FAIL`: 실행했지만 기대를 어겼다. `BLOCKED`: 필요한 환경·권한·외부 의존성이 없다. `NOT_RUN`: 실행하지 않았다. `NOT_IMPLEMENTED`: 필요한 기능이 없다. 다른 레이어의 성공으로 상태를 덮어쓰지 않는다.

| 필드 | 기록할 내용 |
|---|---|
| 식별 | TUX ID, 하위 조건, 연결 NAT/T ID, 실행 시간 |
| 환경 | 코드 SHA/dirty, 플랫폼, 앱 버전·확장 해시, API 또는 fixture 종류 |
| 재현 | 실제 누른 버튼/키, 입력 시료, 시작 상태 |
| 결과 | 화면·포커스·호스트 이벤트·API 상태·파일 변화, 기대와 차이 |
| 증거 | 로그·JSON·스크린샷·생성 파일의 위치 |
| 판정 | 상태와 범위, 실패 원인, 수정 PR/재실행 증거 |
| 잔여 | BLOCKED/NOT_RUN 이유와 완료에 필요한 구체적 요건 |

보고서에는 전체 ID 수, 실행한 ID 수, 하위 검사 수를 구분한다. 단일 screenshot이 버튼의 클릭/키보드·취소·실패·호스트 동작까지 입증하지 않는다. ‘모든 버튼 PASS’는 인벤토리의 해당 조건에 실행 근거가 모두 연결돼 있을 때만 쓴다.

## 발견 사항 추적

#758의 소스 확인에서 대화 즉시 삭제, 연결 변경 뒤 관찰의 일부 상태 잔류, 렌더 오류에서 복구 트리가 다시 실패할 수 있는 경로를 발견했다. 각각 TUX-CHAT-08/HOST-01, TUX-OBS-10/A11Y-04, TUX-COND-04에 연결한다. 수정 여부와 재실행 결과는 최종 실행 보고서에서 확인한다. 문서를 추가하거나 코드를 수정한 사실 자체는 PASS가 아니다.

사람 파일럿 T25는 별도다. 이 테스트의 합성 사용자 실행은 고객의 학습 효과나 독립 수행 능력을 입증하지 않는다. Windows CI 빌드와 Mac 실기기 검증도 서로 대신하지 않는다.
