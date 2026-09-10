# 공통 앱 전환·이행·배포 검사 — 2026-09-10

대상: #915, #916~919. INT-US-01~04 → US-01~18 → US-T01~21.
실행자는 자동 합성 사용자다. 사람의 이해도나 학습 효과를 관측한 기록이 아니다.

## 실행 환경과 관측

macOS arm64, Node 22, 별도 worktree `feat/unified-activity-completion`.
개발 검사 시 base는 `880a13d`이며 수정 중인 소스를 주입했다. 최종 패키지 SHA로
소급 표시하지 않는다. 각 런의 `environment.json`에 dirty 여부, Service 소스 hash,
확장 JS/CSS hash와 App 원래 버전/소스가 있다.

앱은 `/tmp/hps-unified-completion/HypeProof Studio.app`의 v0.1.56 셸에 개발 확장을
주입한 사본이다. 운영 앱과 기존 체험 앱은 종료·교체하지 않았다. 실기 저장 검사는
메모리 SecretStorage를 쓰지 않았다. 시험 사본에 한해 고유 앱 이름을 부여하고
ad-hoc 서명한 뒤 실제 Electron 암호화 저장과 프로세스 재시작을 검사했다.
이는 공개 서명/키체인 업데이트 호환성 검사가 아니다. 시험 키체인 항목만 정리했다.

근거 경로는 worktree 아래 `e2e/test-results/`이며 gitignore 대상이다.
아래 런의 성공 결과·실패 결과를 서로 대체하지 않는다.

| 실행 | 결과 | 근거 |
|---|---|---|
| Worker 전체 smoke + typecheck | PASS | `/tmp/hps-unified-completion-worker-test.log`, `worker-types.log`; 활동 ID/401/403 대조 포함 |
| 확장 전체 smoke + typecheck, React/확장 빌드 | PASS | `/tmp/hps-unified-completion-extension-test.log`, `types.log`, `ui-build.log`, `build.log`; Windows 전용 검사의 skip은 Windows PASS가 아님 |
| 실제 React 브라우저 49개 검사 | PASS | `trial-ux/2026-09-10T19-21-14-462Z/report.json`; 초안·첨부·queue/freeze/stale event와 offline 열람 포함 |
| Mac 체험 A→B→A→프로세스 재시작 | PASS (모델 미호출) | `native-trial/20260910T192341Z`; `unified-switch.json`, `shared-root-blocked.png`, `activity-b.png`, `activity-a-restored.png` |
| Mac 수업 A→B→A→프로세스 재시작 | PASS (모델 미호출) | `native-trial/20260910T192142Z`; 위와 같은 결과·화면 파일 |
| 활동 credential/폴더 잠금 | PASS (단위·프로세스 대조) | `activity-connections.smoke.mjs`: 별도 창 핀, 재발급, 저장/참조 실패 복구, 기존 코드 미전송, 네 자식 프로세스 경합·dead owner 회수 |
| draft 저장 확인 후 전환 | PASS (실제 host 코드 대조) | `activity-draft.smoke.mjs`: text/image/queue ack, stale scope 거부, 저장 실패 시 전환 거부 |
| 실제 SDK 파일 생성·A/B 요청 payload 격리 | BLOCKED | `native-trial/20260910T190956Z`; Anthropic API 2회 모두 HTTP 400, `credit balance is too low`. 파일 없음. 호출을 다른 공급자로 자동 대체하지 않음 |
| 릴리스 판정 정상·실패 대조 | PASS (판정기 단위) | `node e2e/unified-release/gate.test.mjs`; 누락/실패/BLOCKED/옛 SHA/주입/OS/byte/Service/실호출 누락 거부 |
| 실행기 이행·복구 대조 | PASS (임시 파일) | `node scripts/test-unified-launcher.mjs`; dry-run 무변경, 구 앱 거부, 원본 hash/권한 보존, 복구, 사용자 수정 시 덮어쓰기 거부 |
| 실제 실행기 이행 | BLOCKED | 설치된 공통 앱 v0.1.51에는 활동 저장 구현이 없어 dry-run에서 거부. 사용자 실행기 변경 없음 |
| Windows 최종 ZIP·두 설치기 실행 | NOT RUN | Mac 개발 결과로 Windows 인수를 대신하지 않음 |
| 최종 패키지 × 공개 Service / 공개 App × 후보 Service | BLOCKED | 검증된 새 패키지, CI 모델 자격과 잔액, 승인된 합성 공개 체험·수업 코드 필요 |
| App/Service/Module 공개 전달·복구 | NOT RUN | 이 개발 결과는 배포/사용자 적용 완료가 아님 |
| US-T21 사람 사용성 관찰 | NOT RUN | 자동 페르소나를 사람 관측으로 기록하지 않음 |

`worker-types.log` 등 짧게 쓴 로그 이름의 공통 접두사는
`/tmp/hps-unified-completion-`이다. 최종 PR head의 CI는 위 로컬 개발 런과 별도 확인한다.

## 발견한 오류

#968: SDK 오류만 반환되고 도구/파일 작업이 없는데도 “파일로 저장돼 있어요”라고
표시했다. 확인되지 않은 저장을 단정하지 않고 작업 파일 확인을 안내하도록 수정했다.
`test/sdk-result-drift.smoke.mjs`는 **도구 실행 0건인 오류 스트림**을 통과시켜 거짓 저장
문구가 없는지 검사한다. 정상 완료에는 오류 안내를 붙이지 않는 대조도 유지했다.
모델 잔액 부족 자체를 이 문구 수정으로 해결했다고 쓰지 않는다.

## 수용 행의 해석

US-T03/05/07/08/09/10/11/13/16/17/18의 일부 구현과 위 대조를 실행했다.
US-T 행 전체는 정상·실패·실기·지원 조합을 모두 요구하므로 단위 성공을 전체 PASS로
옮기지 않는다. 특히 다른 정책의 강의 pin/예산, 실행 중 강제 종료, 실제 SDK resume와
늦은 정산, 최종 서명 업데이트·운영 복귀는 아직 전체 인수하지 않았다.
#916~919와 Epic은 이 결과만으로 닫지 않는다.

## main 갱신 후 재실행

`03e65f0` main(음성 UI와 canary 준비 검사 포함)을 받아 다시 빌드·검사했다.
실기 검사 코드 SHA는 `8352170d70132eeb1fe5845703c8df8ef5ccfb26`이다.
후속 문서 커밋과 이 실기 SHA를 구분한다.

- 확장 전체 smoke/typecheck, UI/확장 build: PASS. 로그 `/tmp/hps-unified-final-{extension-test,types,ui-build,build}.log`.
- 브라우저 49개: PASS. `trial-ux/2026-09-10T19-27-50-381Z/report.json`.
- 실제 Mac 체험 전환·재시작: PASS (모델 미호출). `native-trial/20260910T192830Z`.
- 실제 Mac 수업 전환·재시작: PASS (모델 미호출). `native-trial/20260910T192844Z`.
- gate CLI 정상 exit 0, missing/tampered bytes/다른 공개 Service revision exit nonzero,
  Windows installer receipt 누락 대조: PASS. 실제 Windows 실행은 여전히 NOT RUN.

실기 폴더의 `environment.json`, `unified-switch.json`과 3개 화면 캡처가 근거다.
실제 모델·최종 패키지·공개 전달의 BLOCKED/NOT RUN 상태는 바뀌지 않았다.
