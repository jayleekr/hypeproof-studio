# Chalk authoring test requirements

Status: planned; every product test below is NOT RUN.
Requirement definitions: [Chalk authoring](../requirements/chalk-authoring.md).
Existing verification policy: [testing](../dev/05-testing-requirements.md) and
[verification rules](../../.claude/rules/verification.md).

## 테스트 REQ

모든 항목의 현재 상태는 NOT RUN이다. 아래 합격 기준은 구현 후 검증할 조건이다.

| Test ID | 제품 REQ | 조건 및 실행 | 합격 기준 | 검증 방식 |
|---|---|---|---|---|
| T-01 | BASE-01, ARC-01 | 강사 A, 강사 B, 학생 토큰으로 A의 수업 읽기·수정 API 직접 호출 | 허용된 강사만 작업 가능, 나머지는 401/403, 데이터 불변 | API 통합 |
| T-02 | CH-01, SAVE-01 | 초안 생성, 단계 편집, 저장 후 창을 닫고 다시 열기 | 모든 필드와 순서 복원, 인증 비밀 미포함 | API + E2E |
| T-03 | CH-03 | 같은 예제를 학생 A/B에게 제공하고 A가 파일 수정 | 원본과 B 파일의 내용·해시 불변 | 파일 통합 |
| T-04 | CH-04 | 필수 안내·완료 기준이 빠진 단계로 수업 확정 시도 | 누락 위치 표시, 초안은 보존, 확정은 차단 | API + UI |
| T-05 | ENV-01, ENV-02, WEB-03 | 필수 실행 의존성이 없는 지원 기기에서 예제 실행 | 준비 또는 복구 안내 후 실제 페이지 열림; 설치 여부만으로 성공 처리 금지 | 기기 E2E |
| T-06 | RUN-01 | 강사만 가진 외부 계정 권한을 리허설에서 사용 시도 | 학생 조건에서는 사용 불가로 표시; 강사 자격 증명 유출 없음 | 통합 |
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

The 23 scenarios cover the first vertical path and its highest-risk boundaries;
they are not complete coverage of all 53 product requirements. Before an
implementation slice is declared complete, link every changed requirement to an
executable test or a named manual scenario. Untouched later requirements remain
planned; no blanket PASS or inferred completion.

P0 release requires all applicable P0 requirements (including ones without a
dedicated T-* row yet) to have evidence. A documentation PR needs documentation
validation only. A product PR must update actual test paths and results.
