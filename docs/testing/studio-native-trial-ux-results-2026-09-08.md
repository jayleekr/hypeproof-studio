# 개인 체험 UI·UX 실행 기록 — 2026-09-08

추적: [#758](https://github.com/jayleekr/hypeproof-studio/issues/758). [요구사항](../requirements/studio-native-trial-ux.md)과 [테스트 계약](studio-native-trial-ux.md)은 실행 결과와 별도로 관리한다.

브라우저는 실제 빌드된 React와 실제 registry의 체험 프로필을 사용했다. host 응답·관찰 시료는 합성 데이터다. 실제 Mac은 별도 앱 사본·user-data-dir·workspace에서 실행했다. 사용 중인 개인 체험 앱과 원본 설치 앱은 테스트 대상으로 사용하지 않았다.

## 실행한 검사

| 범위 | 결과 | 근거 |
|---|---|---|
| 브라우저 43개 시나리오 | PASS 43 / FAIL 0 | `e2e/test-results/trial-ux/2026-09-08T15-47-49-122Z/report.json`; 시작 10, 채팅 14, 관찰 10, 조건부 6(오류 복구 대조군 포함), 화면 폭 2, 접근성 1 |
| Mac 코드 입력 → 실제 모델 → 파일 생성·수정 | PASS | `e2e/test-results/native-trial/20260908T153942Z/`: 실제 provider request ID, 입력/응답, 초기·수정 파일과 SHA |
| Mac 관찰·정정·앱 재시작 | PASS | 같은 실행의 `observation-results.png`, `reloaded.png`; 실제 관찰 API와 보존 기록. 합성 사용자이며 학습 효과 검증은 아님 |
| Mac 대화 삭제 취소·확정 | PASS | `clear-confirmation.png`, `clear-complete-files-preserved.png`, `ui-host-result.json`; 취소 시 대화 유지, 확정 후 파일·관찰 보존 |
| Mac 호스트 추가 6개 | PASS 6 / FAIL 0 | `20260908T1547` 계열의 `native-trial` 실행 로그: 실제 승인 창 취소·작업 폴더 경계·설정 열기·오류 복구·격리된 신고 수신기. 승인-only 시료는 명령을 실제 실행하지 않음 |
| Worker / Chalk / extension | PASS | 각 전체 테스트와 typecheck. extension에는 삭제 확인·중복·진행 중 차단·신원 변경 대조군 및 공통 안내 용어 검사를 포함 |
| 치과 authoring demo / reference browser | PASS | 기존 L1–L5 예제 검사. 실제 치과의사의 Studio 독립 수행 증거가 아님 |
| 문서 검사 | PASS | `scripts/docs-harness/check.py --min-score 95`: 100/100 |
| 실제 운영 Service | PASS | 배포 [34238918748](https://github.com/jayleekr/hypeproof-studio/actions/runs/34238918748), `w0.0.0-dev+fe6f7b5`; health, 정상 freeze, additive migration, SDK canary 6/6 |
| 운영 개인 체험 API | PASS | 합성 계정 발급·profile/context·실제 관찰 모델·사용량 정산·폐기 후 401. 테스트 grant 폐기 완료; 다른 참가자 roster를 덮어쓰지 않기 위해 합성 행은 보존 |

첫 브라우저 실행에서는 대화 삭제 버튼의 이전 번들, scope 전환 상태 잔류, 390px 입력창 넘침을 확인했다. 수정 중 만들어진 혼합 번들 실행은 최종 증거로 사용하지 않는다. 위 43개 결과는 수정된 번들의 전체 재실행이다. 새 detector는 정상 요청·다른 요청·요청 없음 대조군부터 통과했다.

기존 승인 테스트의 첫 실행은 실패했다. `destructive` 분류와 command payload를 전달하지 않은 시료에서 파일 생성 여부만으로 승인 대기를 추측하던 테스트였다. 실제 대화상자가 표시되는지, 항상 허용이 없는지, 취소 결과가 거절인지 확인하도록 수정하고 6개 호스트 검사를 다시 실행해 통과했다.

## 수정한 제품 문제

- 대화 지우기: 확인 없이 삭제하던 동작에 확인/취소를 추가했다. 처리 중·중복 요청을 차단하고 확인 중 사용자가 바뀌면 삭제하지 않는다. 관찰 기록과 파일은 삭제 범위가 아님을 안내한다.
- 관찰 패널: 다른 scope로 바뀔 때 정정 초안·오류·학습 링크·관찰 건수를 포함해 초기화한다. 같은 scope의 설정 갱신은 초안을 보존하며 늦게 도착한 다른 scope의 batch는 무시한다.
- 오류 복구: 다시 열기에서 crash 상태를 초기화하고 host의 보존 상태를 다시 요청한다. 복구할 수 없는 데이터를 새 성공 결과로 표시하지 않는다.
- 좁은 화면: 채팅 입력창의 테두리·padding 때문에 390px 화면을 6px 넘기던 문제를 수정했다.
- 접근성: 채팅 입력창과 설정 버튼에 조작 이름을 붙이고, 출처 링크를 listitem으로 위장한 button 역할을 바로잡았다. 변경 가능한 코치 이름은 키보드로 조작 가능한 버튼으로 제공한다.
- 공통 문구: 체험판·일반판의 인증 안내에서 ‘선생님’과 ‘새 토큰’을 제거했다. ‘참여 코드’, ‘코드 발급 담당자’, ‘운영 담당자’를 역할에 맞게 사용한다.

## 판정 범위와 남은 검사

43개 브라우저 시나리오의 성공은 OS 동작까지 43개 모두 성공했다는 뜻이 아니다. TUX-COND-06의 다른 프로필 전체 조작, TUX-HOST-02~07의 모든 하위 조건, 모든 조작의 스크린리더·키보드 포커스 경로는 추가 실행 결과가 연결될 때까지 NOT_RUN이다. 실제 Mac 추가 호스트 검사와 새 App 설치본의 결과는 이 문서와 #758에 이어 기록한다.

TUX-HOST-08의 앱 재시작은 in-memory credential을 다시 입력한 조건에서 PASS다. macOS Keychain 지속성은 NOT_RUN이다. 실제 Windows 기기와 T25 사람 파일럿도 NOT_RUN이며 CI 빌드로 대체하지 않는다.

## 출시 상태

Service는 배포됐다. App `v0.1.53`은 UI 결함 검증을 위해 빌드를 취소했으며 공개 릴리스가 아니다. 수정 PR의 최신 CI·머지와 다음 App 태그/다운로드/실제 설치본 확인은 #758에서 추적한다. 로컬 앱 성공을 공개 App 릴리스 성공으로 기록하지 않는다.

로컬 증거의 기준 디렉터리는 `.claude/worktrees/studio-trial/e2e/test-results/`다. 자격 증명은 이 디렉터리 밖에서 접근 권한을 제한해 보관했다. 브라우저 시료에 포함된 문자열은 합성 코드이며 실제 코드·키·참가자 정보는 커밋하지 않는다.
