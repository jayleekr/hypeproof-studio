# 강사·관리자 콘솔 테스트 요구사항

상태: 아래 표는 인수 계획. 실행된 범위는 하단 기록으로만 판단한다.
대상: [ADM 요구사항](../requirements/classroom-admin.md), [DES 요구사항](../requirements/classroom-design.md).
검토일: 2026-09-07 · #732. 기존 Chalk board·auth drift·logs-read·Service 검사를 유지한다.

## 테스트 REQ

| Test ID | 제품 REQ | 조건 및 실행 | 합격 기준 | 검증 방식 |
|---|---|---|---|---|
| AT-01 | ADM-01 | 강사 A/B·운영자·학생으로 초대/배정/종료 요청 | 허용 역할·범위만 변경, 다른 수업 불변 | 기존 API + 통합 |
| AT-02 | ADM-02 | 활동 학생·무활동 학생·불완전 명단·끊긴 연결 | 전체 범위 명시, 누락/무신호 unknown, 갱신 시각 표시 | 보드 + UI |
| AT-03 | ADM-03 | 동의 없이 공유, 선택한 질문·응답 공유, 중복 요청 | 동의 없는 저장 없음, 선택 필드와 수신자만 저장, 재시도 중복 없음 | API + UI |
| AT-04 | ADM-04 | 도구 오류·정상 결과·긴 출력·비밀을 넣어 공유 | 질문 연결과 선택 요약/자동 관측 구분, 비밀 마스킹, 원본 대화 자동 첨부 없음 | API + UI |
| AT-05 | ADM-05 | 강사 피드백 동시 저장·응답 유실·학생 확인 | 한 revision 한 변경, 입력 보존, 학생만 해결 확인 | SQLite + 브라우저 |
| AT-06 | ADM-06 | 결과물·검수·다른 독립 과제와 도움 사용 범위 제출 | 근거와 범위 표시, 제출만으로 평가 통과 없음 | 통합 + 강사 평가 |
| AT-07 | ADM-07 | 학생 B/강사 B/다른 프로필/폐기 토큰/위조 헤더로 접근 | 401/403/404, 원문 없음, 조회 감사 실패 시 원문 차단 | API 음성 대조군 |
| AT-08 | ADM-08 | 정상/누락 사용량·모르는 가격·예산 경계 동시 요청 | unknown과 0 구분, 계산 재현, 예산 정책의 초과/차단 동작 검증 | SQL + 장애 주입 |
| AT-09 | ADM-09 | 알려진 정상·긴 대기·실패·무신호 사례 | 검증된 기준으로 분류, 오탐/미탐 표시, 활동량을 능력 점수화하지 않음 | 보드 calibration |
| AT-10 | ADM-10 | 권한별 열기/닫기/일시정지/재개, 실행 중 작업 | 미허용 요청 거부, 적용 범위 일치, 학생 파일 보존 | API + 실제 Studio |
| AT-11 | ADM-11 | v1 수업 중 v2 강의·도구 설정 변경 | 기존 수업 유지, 변경 영향 표시, 정책 권한 확장 없음 | 상태 전이 + 통합 |
| AT-12 | ADM-12 | 요청 접수·배정·보류·답변·해결·중복 연결 | ID/담당/일정 또는 사유/다음 조치 유지, 요청자 확인 전 해결 표시 금지 | 통합 |
| AT-13 | ADM-13 | 불완전 수업 리포트 생성·다운로드 | 관측 범위/누락 명시, 원문·자격증명 미포함, JSON 재열기 가능 | 데이터 + UI |
| AT-14 | ADM-14 | 자기/타인 철회·만료 전후·정리 실패/성공 | 자기 기록만 삭제, 만료 즉시 읽기 차단, 감사 cascade, 기존 로그 불변 | 시간/DB 대조군 |
| DT-01 | DES-01, DES-04 | 첫 접속부터 수업/학생/공유 기록 선택 | 첫 화면 핵심 조작, 두 선택 이내 접근, 홍보 영역 없음 | 브라우저 수동 |
| DT-02 | DES-02, DES-03, DES-11 | 5개 화면 폭·200% 확대·긴 한글/URL·고대비 | 폰트·대비·넘침·가림 기준 충족 | 실제 브라우저/색 계산 |
| DT-03 | DES-05, DES-07 | 정상·empty·unknown·timeout·401/403/409 주입 | 상태별 조치 명확, 무신호 정상 오판 없음 | 브라우저 대조군 |
| DT-04 | DES-06 | 마우스 없이 연결·기록 열기·피드백·닫기 | 접근 이름/포커스/탭 순서, 조작 가능 | 키보드 + 접근성 검사 |
| DT-05 | DES-08, DES-10 | 저장 중 재연결·실패·철회·빠른 기록 전환 | 다른 사용자의 응답이 화면에 재등장하지 않음, 입력 보존, 대상 일치 | 브라우저 경합 |
| DT-06 | DES-09, DES-12 | 토큰·HTML 주입 문자열·학생의 민감 기록 | 토큰 비영속, 텍스트 안전 렌더, 비공유 원문 없음, 동의 기본 해제 | 소스 계약 + 브라우저 |

## 실행 기록

- `worker/test/classroom.test.mjs`: 실제 Service 라우팅·서명 토큰·SQLite를 사용한 공유/역할/범위/비밀 마스킹/중복/CAS/감사 실패/철회/만료 대조군. 실제 명령과 결과는 PR에 기록한다.
- `chalk/test/classroom.test.mjs`: 실제 Chalk→Service forwarding과 헤더 필터·메타데이터 목록·공유 조회·피드백, HTML 스크립트 파싱·토큰 비영속·안전 렌더 계약.
- `worker/test/classroom-d1.test.mjs`: 2026-09-07 로컬 workerd/D1에서 migration 재실행·공유·감사 기록·동시 CAS·철회 cascade 검사 PASS. 운영 D1 배포 증거는 아니다.
- UI의 실제 레이아웃·키보드·기기 관측은 이 두 API/소스 검사로 대체하지 않는다.
- 기존 test 파일이 존재한다는 사실을 ADM 전체 통과로 세지 않는다. 기존 board의 stage/submission 미수집을 수업 진행 완료로 추론하지 않는다.

## 재현과 출시 게이트

```sh
npm --prefix worker test
npm --prefix worker run typecheck
npm --prefix chalk test
npm --prefix chalk run typecheck
```

추가로 운영과 동일한 D1에서 0003 migration·외래키 삭제·동시성·만료를 검증한다.
최소 성인 강사 2명·학생 2명의 합성 계정으로 허용·거부 대조군을 실행하고 DT-* 실기를 수행한다.
새 전체 앱 릴리스, 실제 학생 학습 효과, 아동 동의·관찰 모드 검증은 별도다.
증거에는 Test ID, commit, 환경, 날짜, 결과, 관측/로그, 미실행 범위를 남긴다.

## 실제 브라우저 실행 · #742

2026-09-07 Mac/Chromium에서 `npm --prefix e2e run test:classroom`을 실행했다.
`e2e/classroom/run.mjs`는 Chalk HTTP, 실제 Service 인증 및 SQLite를 연결한다.
합성 강사/학생만 사용했다.

- AT-02/03/05/07/14 일부: 명단 접두어로 무활동 학생 2명 표시, 동의 없음 거부, 공유, 메타데이터 목록, 개별 열람 감사, 피드백, 학생 확인, 철회 후 감사 cascade, 잘못된 인증.
- DT-01/02/04/06 일부: 한 번 선택해 기록 열기, 375/390/768/1280/1440px, 긴 한국어, 실제 computed color로 컨트롤 경계 대비, 키보드 해결 확인, HTML 문자열 안전 렌더, 토큰 비영속.
- 경계 대비 3:1 대조군이 기존 색에서 실패했고 수정 후 통과했다. 성공한 학생 연결이 계속 ‘연결 중’으로 표시되는 문제와 무신호 학생의 `absent`/내부 열 이름 노출도 수정했다.
- 증거: `e2e/test-results/classroom/teacher-*.png`, `student-*.png`, `/tmp/classroom-browser*.log`. CI도 이 스크립트를 실행하고 화면을 보관한다.
- 전체 AT/DT 합격을 뜻하지 않는다. 200% 브라우저 확대, 실제 Windows, 모든 경합·오프라인 조합과 운영 D1 삭제는 별도 검증이다. Node SQLite의 번호 매개변수는 기존 보드 테스트와 같은 위치 매개변수 방식으로 fixture에서 변환하며 실제 SQL/Service 정책은 변경하지 않았다.

<a id="remote-classroom-tests"></a>

## 원격 수업 운영 인수 계획 · 2026-09-18

[확장 PRD](../requirements/classroom-admin.md#원격-수업-운영-확장-설계--2026-09-18)의 계약을 검사한다. 아래 **AT-15~34는 모두 NOT RUN**이다. 이전 classroom test PASS를 새 원격 기능의 증거로 재사용하지 않는다. 합성 강사 A/B·학생 A/B·다른 반·구버전 앱·동일 PC 다른 사용자·다중 창을 고정 fixture로 둔다. 시간·fault·동시 요청을 제어하고 양성/음성 대조를 같은 환경에서 실행한다.

| Test ID | 제품 REQ | 조건 / 깨뜨릴 가정 | 합격 기준 | 실행 계층 |
|---|---|---|---|---|
| AT-15 | ADM-01/02/07 | 미등록·pairing 만료/재사용·발급만 성공·앱검증 실패·runtime 정상 | 발급≠활성화, 미등록 unknown, ticket 1회, 교차 좌석/수업 위조 거부 | Service+D1+App |
| AT-16 | ADM-01/02/11 | 15개 run 명단, 누적 roster 340개, 무활동 2명, 교체 좌석 | 현재 수업 명단 전부 표시·누적 테스트 좌석 제외·변경 이력, 신호 없는 학생 누락 0 | DB+Chalk browser |
| AT-17 | ADM-02/04/11 | step event 중복/역순/구버전·lesson v1 중 v2 발행·자유 활동 | lesson/step/revision 일치, 서버 수신시각과 source 시각 분리, 완료 추정 0 | contract+App UI |
| AT-18 | ADM-02/09 | 401 expired/signature, session_closed/roster_missing, approval 대기, network, provider 공통 장애, 휴식 | 정확한 사유·다음 조치, 확인된 차단만 빨간 글자, 무신호 회색, 공통 장애 묶음 | calibration+browser |
| AT-19 | ADM-07/10 | 학생/다른 강사/폐기 issuer/direct API/forged scope·action/임의 path·shell | 서버/클라이언트 allowlist·scope 모두 차단, 토큰·프롬프트 로그 노출 0 | Service+host negative |
| AT-20 | ADM-05/10 | 강사 2명 동시 reset, duplicate key 같은/다른 payload, response loss | CAS 1개 효과, 같은 key 기존 결과/다른 payload 409, queued를 성공 표기 안 함 | real D1 concurrent |
| AT-21 | ADM-07/10 | lease 만료·옛 epoch·새 로그인·재기동 후 지연 명령·클라이언트 시간 왜곡 | 잘못된 세대/기기/활동에 실행 0, TTL 이후 실행 0, 이전 결과 replay만 | host crash/fault |
| AT-22 | ADM-05/10 | reset 중 실행중 SDK·tool·unsaved draft·디스크 부족·보존 실패·중지 timeout | 보존 후 새 generation, 파일/대화/증거 손실 0, 중지/보존 불확실하면 실행 보류 | 실제 Mac/Windows |
| AT-23 | ADM-01/07/10 | 토큰 교체 전후 동시 창·공용 PC 사용자 교체·상위 issuer 폐기 | current lease owner만 실행, old grant 폐기, 비밀 교사 UI 비노출, 타인 spool 수집 0 | App+Service+D1 |
| AT-24 | ADM-10/11 | class pause→두 chat 경로·SDK tool admission, 이미 실행 중·offline·구버전, Service 실패 | 새 실행 정책 실제 적용, 진행중 효과·미적용 표시, local 저장/Stop/export 유지 | real SDK/proxy+OS |
| AT-25 | ADM-02/08/09 | 관제 API 5xx·KV 지연 60초·D1 장애·프록시 차단·수업30/100명 | metadata 장애로 채팅 중단 없음, 명령 authority 불명은 보류, bounded backoff, 기존 대화 p95 증가≤5% | fault+load |
| AT-26 | ADM-03/07/14 | 동의 없음/만료/철회/기존 profile flag만 true·아동 동의 없는 일괄수집 | 서버 저장/원문전달 없음, 학생별 사유, 명단 행 유지, 기존 수동 업로드 불변 | Service+consent fixture |
| AT-27 | ADM-03/13 | R2 PUT 성공 뒤 DB 실패·manifest-only·hash mismatch·active file 변화·seq gap/중복/역순 | verified receipt 전 complete 없음, immutable revision, outbox로 재조정·혼입 quarantine | local R2+D1+uploader |
| AT-28 | ADM-13/14 | 수업 종료 뒤 offline 복귀·AI token 만료·collection grant 유효/만료·삭제 tombstone | 유효한 본인 snapshot만 회수, AI 권한 확장 0, late input 별 revision, 삭제 기록 재생성 0 | clock+App+API |
| AT-29 | ADM-06/13 | 신규6/legacy7 혼재·입력 없음·AI 문장만 존재·다른 학생 evidence·review 누락 | 모델/version 분리·근거 없는 점수 부여 0건·NA/보류·별도 입력 hash; 기존 HAIN7 28marker 경계 유지 | core+runner fixtures |
| AT-30 | ADM-07/13/14 | Mac runner 종료/lease takeover·동일 job 재전달·timeout·한 학생 손상 | 동일 digest 중복산출 제어, stale runner overwrite 0, 부분 재개, 타 학생 계속 | runner+DB fault |
| AT-31 | ADM-07/13/14 | 갤러리 비공식 대상·형제·recipient 변경·승인 뒤 PDF 변경·send timeout/duplicate webhook·링크 철회 | 원본 명단 매핑, 승인 hash 불일치 차단, send_unknown 자동 재발송 0, accepted≠delivered, 원문 공개 0 | send adapter sandbox |
| AT-32 | ADM-01~14 | feature flag 전부 OFF와 v0.1.56/실제 배포 클라이언트, 신규 API 구형 요청 | 기존 입장/채팅/저장/preview/업로드/board/선택공유 모두 동작, strict validator 호환 | regression+real app |
| AT-33 | ADM-01~14 | fresh DB vs 현행+새 migration, 기능별 canary→flag rollback, 미완 job | schema 동등·기존 데이터 불변·pending TTL/보존·delivery 중지·receipt 조회 가능 | local+staging D1 |
| AT-34 | ADM-02/09/10/13 | 100명×2h, 20% 단절/재접속, 동시 강사2·bulk30·학교 TLS proxy, 5폭/200%/키보드 | p95 목표·상태시각·명단 보존, 교차학생 노출/중복 부작용/파일손실 0, 대비·포커스·오류문구 | load+OS/browser pilot |

2026-09-18 보강 기준([PRD 절](../requirements/classroom-admin.md#추가-설계-기준--복구와-코칭의-분리-2026-09-18-보강))의 인수 행이다. 아래도 실행 기록에 적힌 범위만 실행된 것이다.

| Test ID | 제품 REQ | 조건 / 깨뜨릴 가정 | 합격 기준 | 실행 계층 |
|---|---|---|---|---|
| AT-35 | ADM-05/10 | 복구 capability만 있는 강사의 질문 전송, coach만 있는 강사의 reset, 정답·코드·파일 경로를 담은 질문, 기술 장애 좌석에 질문 없이 바로 복구 | capability 상호 비대체, 코칭 조치가 파일·대화·입력 불변, 본문 비밀 마스킹, 복구가 코칭 단계에 막히지 않음, 표시됨≠읽음 | Service+App+browser |
| AT-36 | ADM-02/04/07 | actor·source_state 미지정/위조, simulated 근거, 변경 전후 digest, 강사 confirmed/disputed, 로그 도착만 있는 좌석 | 미지정은 unverified, simulated가 real로 승격되지 않음, 강사 확인이 발송 승인·학습 완료로 읽히지 않음, 새 저장소 0 | Service+browser |
| AT-37 | ADM-09/13 | 근거 0건 학생·조용한 학생·느린 학생·프롬프트만 있는 학생 | 0점/미달/빨간색 0건, `아직 충분히 보지 못함` 표기, 활동량→능력 추론 0 | core+browser |
| AT-38 | ADM-06/13 | 단일 수업 입력, 누적 회차 입력, 점수 필드가 있는 legacy 입력 | 관찰→근거→판단 변화→다음 실험 구성, 단일 수업에서 성장 패턴 서술 0, 점수·순위·의존도 전면 노출 0, legacy 7축 산출 불변 | core+runner fixtures |
| AT-39 | ADM-05 | 학생 작업 중 질문/확인 지점 수신, 같은 근거 재입력 요구 | 모달·평가 팝업 0, 작업 문맥 유지, 닫기/나중에 보기 가능, 재입력 강제 0 | App 실기 |
| DT-07 | DES-01/05/11 | §14 토큰 조합, 기술 장애 있는/없는 학생 상세, 집계 표기 | 실측 대비 기준 충족, 패널당 주요 CTA 1개, 장애 시 복구가 주요·마무리는 보조, 집계가 평가 지표로 읽히지 않음 | 실제 브라우저 |

실기 gate는 Windows/macOS 각각 앱 release/build hash, Service/Chalk SHA, DB·profile/lesson revision, Test ID, 재현 명령, 기대/관측, screenshot/receipt hash, 실행자·날짜를 남긴다. 지원 안 하는 OS·죽은 host·네트워크 없는 PC에서 원격 복구 성공을 주장하지 않는다. 실제 발송 시험은 승인된 테스트 수신자로 provider sandbox 또는 지정 계정에서만 하고 합성 adapter 성공과 구분한다.

## 2026-09-18 설계 작업의 기반 검증

대상: main `75fe6e4`, Mac arm64. runtime 코드는 변경하지 않았다. 기존 baseline을 실행해 새 설계가 의존할 환경을 확인했다.

- Node 22.22.1에서 Worker/Chalk/extension 각각 `npm test` 및 `npm run typecheck` PASS(exit 0). 초기 Node 24 wrapper의 zsh 예약변수 오류는 수정하고 요구 버전에서 재실행했다.
- extension `build:extension`과 webview `build` 완료(Node 24.15.0). 전체 VSCodium 앱 빌드는 하지 않았다.
- `npm --prefix e2e run test:classroom`: PASS, 합성 계정의 consent 음성 대조·공유/피드백/학생 확인/철회·5폭·키보드·인증/비영속 토큰. 실제 설치 Studio/Windows/production 검증은 아님.
- `python3 scripts/docs-harness/check.py --min-score 95`, `python3 scripts/next-work.py --check`: 문서 변경 후 각각 100/100 PASS, 14문서·358요구사항 무결성 PASS. 구현 충족 검사가 아니다.
- 제품 registry 검사 PASS(`.git/remote-classroom-evidence/check-env/bin/python scripts/check-registry.py`, 격리 PyYAML 환경). 변경 문서 로컬 링크 172개·코드블록·`git diff --check` PASS.
- 새 AT-15~34 및 운영 부하·원격제어·실제 수업·평가·발송은 NOT RUN이다. 설계 완료와 기능 구현 완료를 구분한다.

## 원격 운영 실행 기록

아래는 실제로 실행한 범위만 적는다. 표의 AT 행 전체 합격을 뜻하지 않으며 App·브라우저·실기·운영 D1은 해당 계층이 실행될 때까지 NOT RUN이다.

### R0/R1 Service · 2026-09-18

대상: `worker/migrations/0011-classroom-ops.sql`, `worker/src/lib/classroom-ops.ts`, `worker/src/routes/classroom-ops.ts`, 기존 `instructor-auth.ts`·`tokens.ts`·`admin.ts` 확장. Mac arm64, Node 22.22.1, 합성 강사 2·학생 3·다른 cohort. 전역 스위치 `HPS_CLASSROOM_OPS`와 회차별 flag는 기본 OFF이며 production에는 설정하지 않았다.

- `npm --prefix worker run test:classroom-ops`(SQLite, 16 PASS): AT-15 발급≠활성화·ticket 1회/만료/대체/교차 좌석, AT-16 회차 명단 snapshot·누적 roster 제외·CAS·무신호 좌석 표시, AT-17 확정 authoring 버전에서 읽은 step만 고정(초안·요청 본문의 steps 거부)·중복/역순/충돌 재전송/미등록 step/자유 활동, AT-18 원인 분류·확인된 차단만 blocked·stale은 unknown, AT-19 opt-in ops capability·학생/타 cohort/타 profile/위조 scope·credential↔학생 토큰 상호 거부, AT-23 기기 교체·토큰 재발급 epoch·좌석 교체 시 이전 상태 비노출·issuer 폐기의 D1 commit, AT-25 무변화 poll 무쓰기·저장 실패 시 ack 없음·배치 상한·flag rollback, AT-32 스위치 OFF 시 신규 경로 404와 기존 발급/공유 동작, AT-33 fresh schema = 이전 schema + 0011·재실행 가능·기존 행 불변.
- `npm --prefix worker run test:classroom-ops:d1`(로컬 workerd/D1): migration 재실행, 3개 동시 명단 저장 중 1개만 전체 적용, 같은 ticket 4개 동시 connect 중 1개만 성공, 좌석 상태 CAS. 운영 D1 증거가 아니다.
- 회귀: `npm --prefix worker test`, `npm --prefix worker run typecheck`, `npm --prefix chalk test`, `npm --prefix chalk run typecheck` 모두 exit 0.
- 이 단계에서 NOT RUN: App의 실제 연결·다중 창 lease(AT-21/23 App 계층), Chalk 브라우저 화면(AT-16/18 browser), 100명 부하·KV 지연·학교망(AT-25/34), 구버전 설치 앱(AT-32 real app), staging D1(AT-33).

### R1 Chalk 화면 · 2026-09-18

대상: 기존 `chalk/src/ui/manage.html`의 ‘원격 수업 운영’ 패널(새 대시보드 없음). Chalk는 기존 forwarder만 사용한다.

- `npm --prefix chalk run test:classroom-ops`: 페이지 스크립트 계약(토큰·ticket 비영속, textContent 렌더), run/status/pairing forwarding, 위조 헤더 제거, capability 없는 강사 403, 앱 경로(`/v1/classroom/ops/*`)와 미등록 action은 Service로 전달되지 않음.
- `npm --prefix e2e run test:classroom-ops`(Mac/Chromium, 합성 계정): AT-16 browser — 무신호 좌석 포함 회차 명단 전부 표시·누적 roster 좌석 제외, 명단 오류 시 입력 보존. AT-18 browser — 401을 만료로 표시하지 않고 앱이 보고한 원인과 다음 조치 표시, 확인된 차단만 빨간 글자, 승인 대기는 오류 아님, stale 신호는 회색 ‘확인 불가’로 강등. AT-15 — 발급 문구가 연결 완료를 주장하지 않음. DES — 키보드만으로 좌석 열기·코드 발급, 포커스 이동, 대비 4.5:1 실측, 375/390/768/1280/1440px 무넘침, 44px 대상, 연결 해제 시 ticket 제거. 화면은 `e2e/test-results/classroom/ops-*.png`.
- 회귀: `npm --prefix chalk test`, 기존 `npm --prefix e2e run test:classroom` PASS.
- NOT RUN: 200% 확대, 실제 Windows 브라우저, 공통 장애 묶음의 30명 이상 화면, 실제 Studio 앱이 보낸 신호.

### R1 Studio 확장(App) · 2026-09-18

대상: 순수 모듈 `extensions/hypeproof-chat/src/classroomOps.ts`(영속 outbox·sync 스케줄러·원인 분류), host 어댑터 `classroomOpsHost.ts`, `chatPanelProvider.ts`의 관측 hook 3곳, 명령 `수업 연결`/`수업 연결 끊기`. 학생이 직접 코드를 입력해야만 연결되며 credential은 SecretStorage, outbox는 grant별 파일이다.

- `node --experimental-strip-types test/classroom-ops.smoke.mjs`(5 PASS): payload builder ↔ Service validator drift lock(양성·음성 대조), 안전하지 않은 문자열 제거, 401을 만료로 승격하지 않는 분류, outbox의 전송 전 영속·contiguous ack로만 삭제·재시작 후 seq 연속·다른 grant 비상속·상한 도달 시 명시적 거부, sync의 ack 없는 2xx 무삭제·5→10→20→60초 backoff·single-flight·Service 지정 주기·401 영구 중지·Retry-After·기능 OFF 시 저빈도·±20% jitter.
- 회귀: 확장 `npm test`(전체 smoke)·`npm run typecheck`·`npm run build:extension` exit 0. 신고 메타의 `studio_version`은 상수 대신 설치된 package 버전을 쓴다.
- **NOT RUN (BLOCKED: 실제 앱 필요):** 설치된 Studio에서의 코드 입력→연결→보드 반영, 재시작 후 outbox 재개, 다중 창, Windows, 학교망 TLS proxy, 45초 heartbeat와의 병합(현재는 기존 heartbeat를 그대로 두고 sync를 추가로 보낸다 — 중복 제거는 실측 뒤). 단계(step) 이벤트는 builder와 Service 계약만 있고 App의 수업 단계 UI 연결은 아직 없다.

### R2 명령 원장과 저위험 조치 · 2026-09-18

대상: `worker/migrations/0012-classroom-ops-commands.sql`, Service의 enqueue/조회/취소와 sync 안의 lease·receipt 교환, App `classroomOpsCommands.ts`(허용목록 실행기·실행 전 재확인·저널 우선·crash 복구)와 host 실행기 3종(`retry_diagnostics`, `refresh_connection`, `restart_preview`), Chalk 좌석별/선택 좌석 조치. 허용목록 밖 action·인자·임의 셸/URL/VS Code command/경로는 계약에 없다. 별도 OS agent 없음.

- `npm --prefix worker run test:classroom-ops`(명령 12 PASS 포함): AT-19 flag OFF·capability 없음·학생·타 cohort·비허용 action 6종·인자 3종 거부와 원장 무기록. AT-20 202=queued이며 성공 아님, 대상별 `queued/unsupported/not_connected` 사전 판정, 같은 key 재전송은 기존 명령·다른 payload 409, 동일 key 3중 동시 요청 1건 기록, enqueue+audit 원자성(감사 실패 시 명령·대상 0건), 취소는 미시작 대상만. AT-21 lease owner 창만 수신·다른 창은 observer, 응답 유실 시 재전달, 잘못된 generation/epoch/좌석/역행 상태/자유 문자열 receipt 거부, terminal 결과 불변, TTL 경과 시 `expired`+proceed=false, 시작 후 무영수증은 `outcome_unknown`. AT-23 토큰 재발급·기기 재pairing 뒤 옛 epoch 명령 미전달(`epoch_stale`). AT-25 명령 권한 조회 실패 시 명령 0건 전달·관측 ack는 유지. AT-33 fresh schema = 이전 + 0011 + 0012.
- `npm --prefix worker run test:classroom-ops:d1`(로컬 workerd/D1): 같은 idempotency key 4중 동시 enqueue → 명령 1건, 3개 창 동시 sync → lease owner 1·명령 수신 1.
- 확장 `test/classroom-ops-commands.smoke.mjs`(5 PASS): 미등록 action=unsupported, 인자/epoch 거절, proceed 전 실행 0, 실행 전 `running` 저널 영속, 반복 proceed 재실행 0, monotonic 시작 창(벽시계 역행 무시), Service가 expired라 하면 미실행, mutating timeout=`outcome_unknown`, 예외 문자열 비노출, crash 복구는 postcondition만 보고 재실행 0, 실제 Service 원장과의 queued→leased→accepted→running→succeeded·응답 2회 유실·이중 실행 0.
- `npm --prefix e2e run test:classroom-ops`: 브라우저→Chalk→Service←실제 기기 클라이언트 코드(in-process)로 단일 조치 성공과 결과 코드 표시, 일괄 조치의 `전달 가능/기기 연결 없음` 사전 표시, 미확정 상태에서 ‘모두 완료’ 미표시.
- 회귀: worker/chalk `npm test`·typecheck, 확장 `npm test`·typecheck·`build:extension`, 기존 `test:classroom` e2e 모두 exit 0.
- **NOT RUN (BLOCKED: 실제 앱·OS 필요):** host 실행기 3종의 실제 Studio 동작(실제 preview 서버 복구·profile 재확인), 실제 프로세스 kill 후 저널 복구, 다중 창 lease 인계(150초), Windows, 클라이언트 시계 왜곡 실기. `refresh_connection`의 토큰 재발급·기기 전달은 미구현(현재는 기존 토큰 재검증만).

### R3 보존형 reset·중지·일시정지 · 2026-09-18

- `worker/test/classroom-ops-control.test.mjs`(8 PASS + OFF 대조 1): AT-19/20 reset은 별도 `reset` capability·대상 1명·인자 없음, 강사 2명 동시 reset 시 1건만 진행·다른 1건은 `seat_busy`, 상태 변경 명령 진행 중에도 읽기 전용 진단은 가능, `outcome_unknown`은 성공으로 합산되지 않음. AT-24 양성 대조(일시정지 전 두 경로 입장) → `/v1/chat/completions`·`/v1/messages` 새 요청만 `class_paused` 503, profile·공유 등 다른 경로 불변, CAS와 `pause` capability, 미적용 범위 명시, 기기별 applied/pending/unknown. AT-25 control 조회 실패는 채팅을 막지 않음(fail-open은 의도된 선택이며 기존 KV kill switch가 비상 정지로 남는다). AT-32 스위치 OFF면 잔류 control 행이 아무것도 멈추지 못함.
- 확장 `test/runtime-reset.smoke.mjs`(5 PASS): 동결→중지 확인→보존 manifest 영속→새 generation→보존 대조→probe→해제 순서, 입력 미저장·중지 미확인·보존 I/O 실패·디스크 부족·스풀 미flush 시 generation 불변·입력 해제, 보존 불일치 보고, deadline 경과 시 변경 전 중단, crash postcondition, 원격 경로 소스에 `clearHistory(`·파일 삭제·history 비우기·셸·동적 VS Code command가 없음을 소스 검사로 고정.
- **NOT RUN (BLOCKED: 실제 Mac/Windows Studio 필요) — AT-22/24의 핵심:** 실행 중인 실제 SDK 턴·도구 프로세스의 중지 확인, 미저장 draft가 있는 실제 webview 동결, 실제 디스크 부족, reset 뒤 같은 파일로의 실제 재연결, SDK 로컬 tool admission에 대한 일시정지 적용(현재 App은 새 send만 hold하며 진행 중 도구 호출은 막지 않는다), 구버전 설치 앱. 단위시험은 순서와 거절 규칙만 증명한다.

### 보강 기준(복구·코칭 분리, 출처, 근거 부족, §14) · 2026-09-18

- `worker/test/classroom-ops-coaching.test.mjs`(5 PASS): AT-35 `coach`와 `command/reset` capability 상호 비대체, 복구는 코칭 단계 없이 즉시 접수, 코드 fence·마크업·세미콜론 끝 코드·300자 초과·추가 필드 거부, 비밀 마스킹 후 저장, 감사에 본문 미기록, 대상 좌석 기기에만 전달, `succeeded`의 결과 코드는 `shown`. AT-36 actor·source_state 이벤트별 보존, 미지정=`unverified`, 학생 원문·파일명 필드 거부, 전후 digest 비교, 확인 상태 CAS·`coach` capability·발송 승인/학습 완료 아님 명시·step 불변, 새 근거 저장소 0(검토 상태 테이블만 추가). AT-37 근거 0건 좌석은 `observed:0`이며 blocked 아님, 상태 응답에 score/rank/grade/percent/dependency 문자열 0.
- `npm --prefix e2e run test:classroom-ops`(Mac/Chromium): DT-07 패널당 주요 CTA 1개(장애 좌석=`진단 다시 실행`, 정상 좌석=`질문 보내기`), §14 토큰 computed color 일치와 대비 실측(본문·muted·주의·차단·unknown ≥4.5:1 on `#202C24`, 주요 CTA 글자 ≥4.5:1, 컨트롤 경계 ≥3:1), `운영 집계(학생 평가 아님)` 표기, 평가성 단어 0. AT-35 코드 질문 거부 시 입력 보존·학생 기기 미전달, 정상 질문은 학생 기기 실행기에 본문 전달·학생 작업 불변. AT-36 가상 근거 주의색 표기·`근거 확인` 후에도 step 불변. R3 reset 인라인 확인(대상 명시·포커스 이동·Enter)과 보존 결과 문구, 일시정지 범위 고지와 기기 적용 집계.
- **NOT RUN:** AT-39(실제 Studio에서 질문·확인 지점이 작업 문맥을 가리지 않는지 — 현재 구현은 비모달 알림 + `강사가 보낸 질문·확인 지점 보기` 명령이며 실기 미확인), App이 실제 학습 행동에서 `evidence` 이벤트를 내보내는 연결(빌더·계약·Service 저장만 있음; 어떤 행동이 어떤 근거인지는 선택한 커리큘럼 계약에 따라 정해야 하므로 추측으로 연결하지 않았다), AT-38(R5에서 실행), 200% 확대.
