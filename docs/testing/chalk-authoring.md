# Chalk authoring test requirements

Status: staged implementation. The original scenario table is the target plan; see the execution record below for implemented subsets.
Requirement definitions: [Chalk authoring](../requirements/chalk-authoring.md).
Existing verification policy: [testing](../dev/05-testing-requirements.md) and
[verification rules](../../.claude/rules/verification.md).

## 테스트 REQ

아래는 종단 시나리오 목표다. 부분 실행 결과는 하단 기록을 따른다.

| Test ID | 제품 REQ | 조건 및 실행 | 합격 기준 | 검증 방식 |
|---|---|---|---|---|
| T-01 | BASE-01, ARC-01 | 강사 A, 강사 B, 학생 토큰으로 A의 수업 읽기·수정 API 직접 호출 | 허용된 강사만 작업 가능, 나머지는 401/403, 데이터 불변 | API 통합 |
| T-02 | CH-01, SAVE-01 | 초안 생성, 단계 편집, 저장 후 창을 닫고 다시 열기 | 모든 필드와 순서 복원, 인증 비밀 미포함 | API + E2E |
| T-03 | CH-03 | 같은 예제를 학생 A/B에게 제공하고 A가 파일 수정 | 원본과 B 파일의 내용·해시 불변 | 파일 통합 |
| T-04 | CH-04 | 필수 안내·완료 기준이 빠진 단계로 수업 확정 시도 | 누락 위치 표시, 초안은 보존, 확정은 차단 | API + UI |
| T-05 | ENV-01, ENV-02, WEB-03 | 필수 실행 의존성이 없는 지원 기기에서 예제 실행 | 준비 또는 복구 안내 후 실제 페이지 열림; 설치 여부만으로 성공 처리 금지 | 기기 E2E |
| T-06 | RUN-01 | 강사만 가진 외부 계정 권한을 리허설에서 사용 시도. 열린 세션 없이 리허설을 시작하는 대조도 포함 | 학생 조건에서는 사용 불가로 표시; 강사 자격 증명 유출 없음; 열린 세션 없이도 리허설이 시작된다 | Studio+Service 통합 |
| T-07 | VER-02 | 리허설 통과 후 예제 또는 도구 설정 변경 | 이전 합격 기록 유지하되 새 버전은 재검증 필요 상태 | 상태 전이 |
| T-08 | VER-01, ENV-03 | v1 수업 진행 중 초안을 v2로 수정 | 기존 학생은 v1 유지, 새 수업에서 명시적으로 v2 선택 | 통합 |
| T-09 | RUN-03 | 정상·만료·다른 수업용 참여 자격으로 참여 시도 | 정상만 지정 수업 진입, 오류는 복구 가능한 안내, 다른 수업 접근 불가 | API + E2E |
| T-10 | SAVE-01 | 저장 응답 유실 후 같은 요청 재시도 | 수업·학생 항목 중복 생성 없음, 상태 재조회 가능 | 장애 주입 |
| T-11 | SAVE-01 | 두 창이 같은 revision을 각각 수정·저장 | 늦은 저장에 충돌 표시, 선행 변경을 조용히 덮어쓰지 않음 | API 통합 |
| T-12 | WEB-01, WEB-02, WEB-04 | 진료시간·사진·문구 수정 후 375/768/1280px 확인 | 의도한 내용 반영, 가로 넘침·주요 버튼 가림 없음 | 브라우저 + 시각 확인 |
| T-13 | WEB-05 | 파일 추가·변경·삭제 후 복구 | 저장 지점의 파일 집합과 내용 복원, 복구 전 상태도 보존 | 파일 통합 |
| T-14 | WEB-06 | 깨진 이미지·링크·JS 오류를 의도적으로 넣고 검사 | 심은 오류 탐지, 미검사 범위 표시; 검사 완료를 전체 품질 보증으로 표현하지 않음 | 브라우저 통합 |
| T-15 | WEB-07 | 시험 호스팅에 배포 후 새 브라우저 세션으로 URL 접속 | 해당 버전의 페이지와 자산 로드, 인증 실패는 성공으로 표시하지 않음 | 외부 연동 E2E |
| T-16 | CLS-01, AUTH-01 | 활동 없는 학생 포함 수업 현황 조회 | 선택한 수업의 전체 대상 표시, 신호 없으면 unknown, 질문 원문 미노출 | 기존 board 회귀 |
| T-17 | CLS-02, AUTH-01 | 학생이 선택한 화면만 도움 요청에 공유 | 미선택 대화·파일·비밀 미포함, 다른 수업 강사는 접근 불가 | API + UI |
| T-18 | REQ-01, REQ-02 | 수업과 연결된 기능 요청 접수 및 상태 변경 | 요청 ID·다음 조치 표시, 요청자에게 접근 가능, 개발 완료로 허위 표시 금지 | 통합 |
| T-19 | BASE-05 | 수업 세션 종료 후 자기 프로젝트 재열기 | 파일 열람·로컬 수정 가능, AI/호스팅 만료는 별도 안내 | 기기 E2E |
| T-20 | EDU-03, EDU-04 | 시연과 다른 휴진 공지 과제 수행·제출 | 결과와 검수 기록, 지원 사용 범위 구분; 제출만으로 자립 등급 자동 확정 금지 | 강사 평가 |
| T-21 | ARC-01 | Chalk를 통한 미허용 쓰기·위조 전달 헤더 시도 | 기존 공유 인증 정책으로 거부, Chalk의 직접 상태 쓰기·토큰 발급 없음 | 기존 인증 회귀 |
| T-22 | ARC-02 | Studio에서 Chalk 진입, 만료 인증으로 재진입 | 정상 이동 또는 로그인 안내, URL·로그에 토큰 미노출 | 기기 E2E |
| T-23 | ENV-07 | 지원 OS 각각에서 설치·참여·실행·종료·재시작 | 같은 과제 수행 가능; 미지원 OS는 참여 전 명시 | 플랫폼 매트릭스 |

## 구현 순서와 각 단계의 종료 기준

### 누락된 요구사항의 인수 시나리오 (2026-09-13, #1007)

아래 T-24~46은 새로 발현한 인수 계획이며 전부 **NOT RUN**이다.
기존 79개 작성·관리·디자인 요구 중 테스트 연결이 없던 23개를 다룬다.
각 실행은 제출·실제 App/Service/수업 revision, 기대/관측과 근거를 기록한다.
합성·로컬 검사는 실제 설치본·운영 활성화·인간 학습 효과의 PASS가 아니다.

| Test ID | 제품 REQ | 조건 및 실행 | 합격 기준 | 검증 방식 |
|---|---|---|---|---|
| T-24 | BASE-02 | 강사 조건으로 초안→설정→(Studio에서) 학생 리허설→확정 수업 현황까지 이동하고 각 단계 실패를 주입 | 같은 수업 revision으로 연결; 미실행 리허설을 준비 완료로 표시하지 않고 입력/확정본 보존 | Chalk+Studio+Service E2E |
| T-25 | BASE-03 | 새 지원 기기의 학생이 기본 홈페이지 실습 시작·수정·검수·저장을 UI로 수행; 실행 의존성 하나 제거 | 명령어/설정 파일 편집 없이 정상 완료; 환경 부재는 지원되는 복구 안내, 몰래 성공 처리 금지 | 실제 App+관찰 |
| T-26 | BASE-04 | 안내·예제·도구·지침·완료 기준을 저장/재열기/확정하고 필수 항목 하나씩 삭제 | 전 항목과 순서 복원; 누락 위치 표시·확정 차단·기존 확정본 불변 | API+상태 전이 |
| T-27 | CH-02 | 충분한 목표/자료로 홈페이지 수업 초안 생성, 예제나 검수 기준 누락·생성 중단 재현 | 편집 가능한 초안에 예제/실습/검수 항목 존재; 누락/부분 생성은 미완 표시, 자동 개설 없음 | 실제 모델+Chalk |
| T-28 | CH-05 | 선택 기록 A로 초안 생성, 기록 B 미선택·A 공유 철회 후 재시도 | A 출처를 보존한 초안을 강사가 직접 확정; B/철회 기록 재전송·자동 확정 없음 | 권한+실제 모델 |
| T-29 | CH-06 | 기본/확장 과제 편집·순서 변경·학생 진입, 확장 과제만 실패 | 기본과 확장 조건/완료 상태 분리; 확장 실패가 기본 결과 삭제나 허위 전체 완료를 만들지 않음 | API+UI |
| T-30 | CH-07 | 학생 기록·합성 자격을 포함한 이전 기수에서 새 기수 복제 | 수업 자료/구성만 복제, 새 ID; 학생 원문/명단/자격/사용량 미포함, 원 기수 불변 | API+저장소 대조 |
| T-31 | WEB-08 | 통제된 공개 대상에서 v1→v2→v1 복구, 인증 실패·배포 중 응답 유실 | 실제 재접속한 파일/자산이 선택한 revision; 미확인/실패를 복구 완료로 표시하지 않고 이전 대상 보존 | 승인된 외부 연동 E2E |
| T-32 | WEB-09 | 지원 템플릿 설치→빌드→실행, lock 불일치·의존성/빌드 오류·실행 포트 충돌 | 검증된 템플릿만 실행, 단계별 오류/복구 제공·파일 보존; 임의 템플릿 지원 성공 주장 없음 | 격리 설치+App |
| T-33 | ENV-04 | 학생 A/B 자격으로 실행·예제 복제·내보내기, B 자격/공유 폴더로 우회 시도 | A/B 정상 작업 분리; 복제에 자격 없음, 타 학생 자격 재사용·접근 거부 | API+파일+SDK |
| T-34 | ENV-05 | 검토된 플러그인/MCP 연결 시험 후 확정 버전에 편입, 시험 실패/버전 변경 | 시험한 권한/버전만 편입; 실패·미검토 버전 자동 활성화 없음 | 격리 통합 |
| T-35 | ENV-06 | 미등록 도구 후보를 격리 시험·제거하고 수업 편입 요청 | 시험 기록과 검토 결정 분리; 시험 중 운영 수업/학생 자격 접근 없음, 미승인 편입 차단 | 격리 환경+검토 |
| T-36 | RUN-02 | 정상 준비와 실행/자료/도구/인증 누락을 각각 재현 | 각각 원인·기준시각·다음 행동 표시; 하나의 ping 성공으로 전체 준비 완료 금지 | Service+Studio |
| T-37 | RUN-04 | 지원/미지원 OS·앱, 연결 끊김, AI 한도/권한 거부 학생을 동일 명단에 둠 | 지원·연결·AI 가능 상태를 분리, 신호 없는 학생 unknown; 누락 학생을 명단에서 숨기지 않음 | 플랫폼+운영 보드 |
| T-38 | RUN-05 | 수정 중 네트워크/실행 환경 실패 후 재시도·복구 | 파일/입력/현재 연결 보존, 복구 가능 다음 행동; 조용한 데이터 초기화·중복 외부 실행 없음 | 장애 주입+App |
| T-39 | CLS-03 | 학생 산출물의 파일/위치/revision에 피드백하고 이후 파일 수정/삭제 | 원 위치·버전 근거 유지, 현재 위치 불일치는 명시; 다른 파일/새 버전에 조용히 재부착 금지 | 공유 API+UI |
| T-40 | CLS-04 | 학생이 범위를 승인한 강사 수정, 거부·철회·만료·수정 대상 변경 대조 | 허용 범위만 수정, 변경 이력/복구 전 snapshot 보존; 승인 없는 수정과 확대 거부 | 권한+실제 App |
| T-41 | CLS-05 | 선택 결과 A로 공동 리뷰, 결과 B 미선택·A 철회/만료·타 수업 접근 | A만 허용된 대상에게 표시; B/철회 자료·원문 자동 공개 없음 | 공유 API+Chalk |
| T-42 | EDU-01 | 단계별 목적·선택·검수 과제를 보며 작업, 충분한 기존 목표/모호한 목표 대조 | 필요한 판단을 안내하고 이미 명확한 목표는 재설문 없이 진행; 과제 열람/AI 문장을 인간 선택으로 기록하지 않음 | 실제 모델+App |
| T-43 | EDU-02 | 힌트→함께 수행→독립 시도 전환과 실행 중 변경, 다른 수업 도움 설정 주입 | 다음 실행의 도움 방식·출처가 일치, 입력 보존; 권한 확대·타 수업 지침 혼입 없음 | 실제 모델+정책 |
| T-44 | EDU-05 | 직접/도움받은/전문가 위임의 근거 있는 사례와 출처 없는 사례를 비교 | 도움 조건과 판단 주체를 구분; 미관찰은 unknown, AI 설명/제출 수를 자립 등급으로 승격하지 않음 | 합성 기록+사람 검토 |
| T-45 | REQ-03 | 같은 요청을 기존 안내/선택 확장/기본 개발로 분류하고 이유 수정, 권한 없는 변경 시도 | 요청자에게 분류·이유·다음 행동 표시; 권한 없는 변경 거부, 분류가 개발 완료 표시를 만들지 않음 | API+UI |
| T-46 | REQ-04 | 수정 후보를 강사가 요청 당시 예제로 재실행해 해결/미해결 판정, 예제/버전 불일치 대조 | 실제 대상 revision과 강사 확인 기록 연결; PR 병합/다른 예제 통과만으로 해결 완료 금지 | 강사 인수 |
| T-47 | ARC-03 | 교환권 링크를 두 번 제출, 만료된 교환권, 내용이 바뀌어 sha256 이 어긋난 교환권을 각각 제출 | 한 번만 통과하고 나머지는 이유와 함께 거부; 좌표·자격증명이 URL·로그·webview 저장소에 남지 않음 | Studio+Service 통합 |

1. PR 1 — 저장 및 권한 계약: 기존 모델 확인 후 초안/버전/리허설 상태 추가. T-01/02/04/07/08/10/11/21 통과.
2. PR 2 — Chalk 작성 화면: 홈페이지 수업 생성, 예제·단계 편집, 준비 상태, 버전 확정 UI. 학생 간 예제 격리 T-03 포함.
3. PR 3 — Studio 진입 및 리허설: 학생 권한 실행, 환경 검사, 기존 참여 흐름 연결. T-05/06/09/22/23 통과.
4. PR 4 — 홈페이지 종단 검증: 수정·모바일·복구·배포·수업 종료 후 접근. T-12/13/14/15/19 통과.
5. PR 5 — 운영 지원: 기존 board 보존, 선택적 도움 요청·기능 요청·학습 제출. T-16/17/18/20 통과.

PR은 구현 분할 제안이며 아직 생성하지 않았다. 각 단계는 관련 테스트와 기존 회귀 검사를 통과한 뒤 다음 단계로 진행한다.

## 검증 환경과 증거

- 합성 병원 자료와 가상 학생 두 명, 강사 두 명 사용. 운영 데이터·운영 토큰 사용 금지.
- 지원 OS 범위는 첫 구현에서 확정하고 OS·아키텍처·Studio 버전을 기록한다. 실제 기기 검증을 브라우저 에뮬레이션으로 대체하지 않는다.
- 자동 검증은 API/파일/상태 전이 중심, E2E는 사용자가 끝까지 수행하는 주요 경로 중심으로 제한한다.
- 기존 chalk npm test와 typecheck는 실행 가능한 체크아웃에서 수행한다. README에 적힌 명령을 실행 결과로 간주하지 않는다.
- 증거 형식: Test ID, commit SHA, 환경, 실행 일시, PASS/FAIL/BLOCKED, 관측 결과, 로그 또는 화면. 비밀과 학생 원문 제외.
- 미구현/환경 부재/실패를 구분한다. 조건 없는 skip을 PASS로 계산하지 않는다.

## 출시 게이트

첫 구현 및 기본 홈페이지 경로에 해당하는 P0 테스트 전부 PASS, 권한·학생 격리·복구 실패 0건, 지원 플랫폼 실기 검증 완료. 강사 1명과 시험 학생 2명이 명령어·설정 파일 편집 없이 수업 생성부터 결과물 확인까지 수행한다. 공개 배포·운영 반영은 검증된 변경과 실행 증거를 검토한 뒤 수행한다.


## Architecture coverage additions

T-07/T-08 must exercise the declared session-design schema and old-client
compatibility, reject malformed/incompatible content with visible loss of
capability, and prove unaffected classes continue. T-10/T-11 must prove storage
atomicity with concurrent requests rather than trusting a mutable KV pin.
These additions are acceptance criteria, not claims that those tests exist.

## Coverage and status

The original T-01~23 cover the first vertical path and its highest-risk boundaries.
T-24~46 add the previously unlinked requirements. With the classroom-admin AT/DT
scenarios, all 79 authoring/admin/design requirement IDs now have a named scenario.
This is design coverage only. Before an implementation slice is declared complete,
link each applicable scenario to executable tests or actual manual evidence.
Unexecuted requirements remain planned; no blanket PASS or inferred completion.

P0 release requires all applicable P0 requirements and their scenarios to have
evidence. A documentation PR needs documentation
validation only. A product PR must update actual test paths and results.

## API slice execution record

- `worker/test/authoring.test.mjs`: 19 checks passed locally on Node 24, real Service routing, signed tokens, and real SQLite. Covers owner/cohort/profile denial (T-01), draft save/reopen (T-02), incomplete freeze rejection (T-04), frozen document preservation (part of T-08), retry/conflict behavior (T-10/T-11), and existing admin reachability (T-21).
- `chalk/test/authoring-forward.test.mjs`: passed locally; Service verdict and header filtering preserved for authoring GET/PUT.
- Worker and Chalk existing test suites passed locally; typechecks passed.
- `worker/test/authoring-d1.test.mjs`: passed on the actual Mac with Node 24 on 2026-09-06; local workerd/D1 migration, CAS, immutable-version reopen and overwrite rejection. PR #706 CI worker/test also passed before merge.
- T-07 rehearsal invalidation, T-08 active-class version binding, actual UI and Electron flows, student participation, and production D1/deployment are NOT RUN and not implemented by this slice.
- Contract and rollback: [ADR 0004](../adr/0004-chalk-authoring-storage.md). No full product requirement is inferred complete from these subsets.

## Chalk authoring surface slice (#712)

`e2e/chalk-authoring/run.mjs` drives Chromium through Chalk HTTP forwarding to real Service routes and SQLite: Module draft import, form editing, save/reload, immutable version read, concurrent 409 with local edit preservation, 401/403 negative controls, mobile layout and no browser credential storage. Passed locally on Mac. This is instructor UI evidence, not student Electron or public deployment evidence. GitHub support links prepare a draft; receipt and assignment only exist after the instructor submits on GitHub.

## Version delivery (#739)

- T-08/T-09: `worker/test/authoring.test.mjs` exercises signed frozen-version delivery, owner/student/roster/duration denial, legacy-token compatibility, draft-versus-version separation, checksum rejection and revoked-token denial. Tool permissions remain identical.
- `e2e/chalk-authoring/run.mjs` now executes instructor mint → student `/learn` via actual Service routing/SQLite; 375/390/768/1280/1440px, keyboard hint, cleared credentials, 401 and changed-identity clearing.
- `e2e/lesson-studio/mac.mjs`: actual installed Mac shell with development extension, synthetic signed credential and local Service. This checks lesson display and explicit task insertion; it does not claim LLM completion or a shipped binary.
- Session-wide model/tool pinning, automated readiness/rehearsal evidence, all ADM/AT/DT acceptance and Windows actual-device testing remain outside this slice. Issuing another credential does not revoke existing credentials or replace the session.

Execution on 2026-09-07: Worker/Chalk full suites, both typechecks, extension smoke suite/typecheck, webview build, local authoring/classroom D1, instructor/student browser flow and the actual Mac 0.1.51 test-copy navigation passed. Mac initially failed with a stale/rejected development extension; bundle hash assertions now reject that setup. Evidence paths: `/tmp/lesson-*.log` and `e2e/test-results/{chalk-authoring,lesson-studio}/`. These are local results; production delivery and a released App containing the lesson panel are separate gates.

## Simplified entry verification

`npm --prefix e2e run test:chalk-simple` uses synthetic issuer credentials, the
actual Chalk/Service routes and in-memory SQLite. It exercises server-verified
choices, automatically named new drafts/versions, save/freeze/reopen, forged-token
denial with edit preservation, and the negative path where clearing a visible setting
removes the hidden target and blocks create/save until the setting is reselected without
discarding curriculum edits. It also checks no credential storage and 390/1280px layout.
This is local evidence; production deployment and live classroom behavior are separate.
