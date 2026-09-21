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

[확장 PRD](../requirements/classroom-admin.md#원격-수업-운영-확장-설계--2026-09-18)의 계약을 검사한다. 아래 표는 인수 **계획**이다. 실행된 범위는 하단 ‘원격 운영 실행 기록’에만 있으며, 거기 없는 계층(실제 Mac/Windows Studio·SDK·학교망·운영 D1/R2·실제 발송)은 **NOT RUN**이다. 이전 classroom test PASS를 새 원격 기능의 증거로 재사용하지 않는다. 합성 강사 A/B·학생 A/B·다른 반·구버전 앱·동일 PC 다른 사용자·다중 창을 고정 fixture로 둔다. 시간·fault·동시 요청을 제어하고 양성/음성 대조를 같은 환경에서 실행한다.

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

### R4 동의 범위·일괄 회수·immutable snapshot · 2026-09-18

대상: `worker/migrations/0015-classroom-collection.sql`, `worker/src/routes/classroom-collect.ts`·`lib/classroom-collect.ts`, 확장 `evidenceSnapshot.ts`와 host 실행기 `retry_evidence_upload`(Service만 발행, 강사 `/commands`로는 지정 불가), 명령 `수업 기록 보내기 동의·철회`, Chalk ‘수업 마무리’(보조 CTA). 기존 `routes/logs.ts` 수동 업로드·`studio-logs/` 정책은 읽지도 바꾸지도 않는다. 회차 flag `ops_collect` 기본 OFF.

- `worker/test/classroom-ops-collect.test.mjs`(9 PASS, SQLite + in-memory R2): AT-26 동의 없음→명단 행 유지·요청 0·저장 0·`upload_session_logs` flag는 동의 아님, 동의는 회차·목적·고지 version 단위(옛 고지 동의 불인정), dry-run 저장 0, 배치 생성 시 제외된 학생은 이후 동의해도 그 배치에 업로드 불가, 학습 토큰은 회수 자격 아님, 아동 profile은 앱 동의 거부·강사 Bearer로 보호자 동의 기록 불가·운영자 기록 뒤에만 요청. AT-27 manifest-only·hash 불일치·sealed 후 변경 거부, 같은 revision 다른 bytes 거부(새 revision), 서버 재해시 뒤에만 verified receipt와 outbox job 1건(재전송 포함), integrity와 coverage 분리(`gaps`·`sequence_unavailable`는 verified여도 complete 아님), 타 학생 이벤트 혼입 quarantine, R2 성공·DB 실패는 reconcile의 orphan으로 보고되고 회수 집계 0, R2 실패 시 행 0. AT-28 연결 만료 뒤 sync 401이지만 upload-only 창에서 본인 snapshot만 수용·AI/타 배치 접근 0·창 종료 후 거부, 철회 tombstone 뒤 저장 0·명단 행은 `withdrawn`으로 유지, 늦은 revision은 새 input revision.
- 기기 uploader `worker/test/classroom-ops-snapshot-device.test.mjs`(4 PASS, 확장 소스 ↔ 실제 Service 경로 in-process. extension CI job은 Service 의존성을 설치하지 않아 Service 스위트에 둔다): allowlist 파일만 전송, verified receipt 뒤 재전송 0, 전송 중 오프라인→pending→**같은 고정 사본**으로 재개(그 사이 커진 spool 미반영), 변경된 bytes는 r2·input revision 2, 혼입/무기록/철회 사유 보고.
- 브라우저 e2e: ‘수업 마무리’가 주요 CTA가 아님, dry-run 결과의 전체 명단·사유·R2 0, 동의 후 실제 요청은 `요청함 · 기록 미도착`.
- 회귀: worker/chalk/확장 `npm test`·typecheck·build, D1 시험(0011~0015 재실행) exit 0. route-registry 검사가 새 라우트 미등록을 잡아 traceability에 등록했다.
- **NOT RUN:** 실제 R2·운영 D1, 실제 spool 디렉터리와 수업 중 활성 파일, 실제 오프라인 복귀, 공용 PC에서 이전 사용자 spool 비수집 실기(AT-23), 종료 후 24시간 창의 운영값(정책 확정 전 production 비활성), 삭제 요청 시 R2 snapshot·runner cache·링크까지의 연쇄 삭제(현재는 tombstone으로 재생성만 막는다), 로컬 snapshot 사본의 보존 기간(기존 spool 보존 결정에 따름).

### R5 평가 초안·runner·검수 큐 · 2026-09-18

대상: `worker/migrations/0016-classroom-report-jobs.sql`, `worker/src/lib/classroom-report.ts`(공통 측정 코어의 capability model·finding status·score/변환 거부를 그대로 사용), `routes/classroom-reports.ts`, `scripts/classroom-report-runner.mjs`, Chalk 검수 목록. 회차 flag `ops_reports` 기본 OFF. 서술 평가기는 기본 OFF이며 미설정 시 초안은 전 역량 ‘아직 충분히 보지 못함’이다.

- `worker/test/classroom-ops-reports.test.mjs`(5 PASS): AT-29 검증된 입력에서만 job 생성·입력 없는 학생은 `missing`(0점 아님)·재실행 시 중복 0, 신규 6모델과 legacy 7축은 같은 입력이어도 별도 job/버전이며 변환 key·다른 모델 초안·legacy 필드 혼입은 quarantine, 근거 quote가 검증된 본인 입력에 없으면(다른 학생·AI 문장) quarantine, 근거 없는 observed 거부, score/rank key 거부, legacy는 fingerprint 필수·28 marker review 미완이면 승인 불가. AT-30 runner capability는 배치 단위(학생 연결·타 배치·승인 불가), lease 만료 후 takeover 시 옛 generation 결과 폐기, 완료 job 재결과 거부, 한 학생 격리가 다른 학생을 막지 않음, runner 스크립트는 같은 lease API 사용·평가기 예외 시 그 job만 failed·credential/경로 미로그. AT-37/38 보고서 구성이 `관찰된 행동→판단이 바뀐 과정→아직 충분히 보지 못함→다음 실험`이고 단일 수업에는 `최근 반복된 패턴` 없음(근거 있는 수업 2회 이상에서만), 제목·항목에 점수·순위·의존도·퍼센트 0, coverage가 complete가 아니면 ‘본 범위’ 절이 앞에 옴, 방법/세부 데이터는 별도 `method`. 검수는 열람 감사 실패 시 본문 비반환, 승인은 읽은 draft digest에 결속(CAS), `승인≠발송 승인` 명시.
- 회귀는 아래 R6/R7 기록의 전체 실행에 포함.
- **NOT RUN:** 실제 Mac에서의 장시간 runner·절전 복귀, legacy `skills/hain7-report` 엔진을 evaluator로 연결한 실제 PDF·지면 QA(이번 구현은 계약과 격리만; 엔진 호출 adapter는 미작성), LLM 서술 평가기(운영자가 evaluator version·호출 한도를 정하기 전 OFF), 누적 회차 패턴의 실제 서술, Chalk 검수 화면 브라우저 인수.

### R6 수신자·승인 결속·전달 원장 · 2026-09-18

대상: `worker/migrations/0017-classroom-delivery.sql`, `lib/classroom-delivery.ts`(adapter 경계·상태 전이), `routes/classroom-delivery.ts`, Chalk 발송 승인/상태. 회차 flag `ops_delivery` 기본 OFF, `HPS_DELIVERY_PROVIDER` 미설정이 기본이며 이 변경은 어떤 발신 계정도 설정하지 않는다. 실제 provider adapter는 없다(dry-run + 시험용 sandbox만).

- `worker/test/classroom-ops-delivery.test.mjs`(7 PASS): AT-31 수신자는 운영자 import만(강사 Bearer 불가, 회차 명단 밖·갤러리 인물 거부, 형제는 별도 행, 강사에게는 마스킹), 보내지 않는 학생도 사유와 함께 표시, 승인은 표시된 scope hash에 결속·검수 권한과 발송 권한 분리, 발신 계정 미설정 시 live 거부·dry-run은 외부 발송 0, 승인 뒤 수신자 주소 변경/새 보고서 승인 → `approval_stale`로 발송 0, 원장 행을 adapter 호출 전에 기록, timeout=`send_unknown`이며 재요청해도 재발송 0, 운영자가 provider 확인 근거와 함께 resolve, `provider_accepted`≠`delivered`, 중복 webhook 흡수, 늦은 accepted가 delivered를 되돌리지 않음, 열람(opened) 상태 없음, 메시지에는 불투명 링크만, 링크는 no-store·만료·철회·조회 감사·token 미저장(hash만), 거절은 `failed`.
- **NOT RUN / 운영 gate:** 실제 발신 계정·provider sandbox·실제 수신자, 반송/전달 webhook의 provider 서명 검증(현재 이벤트 수신은 운영자 인증 경로), Kakao/SMS, QR, PDF 첨부·지면 QA, 링크 열람자의 수신자 본인 확인, Chalk 발송 화면 브라우저 인수.

### R7 회귀·rollback·합성 부하 · 2026-09-18

- `worker/test/classroom-ops-regression.test.mjs`(4 PASS): AT-32 전역 스위치 OFF에서 신규 경로 23개 전부 404, 기존 토큰 발급·`/v1/profile`·45초 heartbeat(`/v1/trace/event`)·선택 공유·토큰 폐기 동작 유지, 신규 테이블 25개 행 0. 스위치 ON·회차 flag 전부 OFF(기본)에서 pairing·명령·일시정지·회수 각각 거부. AT-33 commands flag rollback 시 즉시 전달 중지·대기 명령은 TTL 만료·완료 receipt와 audit 조회 가능·관측은 계속. AT-25/34 **합성**: 100좌석×12 poll, 20% 단절 후 복귀, 30좌석 일괄 진단, 강사 2명 동시 조회 — 매 조회 명단 100석 유지, 좌석 간 명령/이벤트 교차 0, 12 poll 동안 상태 쓰기 20회(이벤트가 있던 좌석만; 무변화 poll은 쓰기 0), 이 Mac의 Node+SQLite에서 sync p95 13.8ms·status p95 1.4ms.
- 위 수치는 Workers CPU·D1 지연·학교망이 아니다. PRD의 p95 15초/10초/채팅 +5% 목표는 **측정되지 않았다.**
- 최종 회귀(스택 끝, Mac arm64, Node 22.22.1): `npm --prefix worker test`, worker typecheck, `test:classroom-ops:d1`, `test:classroom:d1`, `npm --prefix chalk test`·typecheck, 확장 `npm test`·typecheck·`build:extension`, `npm --prefix e2e run test:classroom`·`test:classroom-ops` 모두 exit 0.
- **NOT RUN (R7의 실기 gate 전부):** 실제 Windows/macOS Studio 빌드·설치(전체 build는 CLAUDE.md상 별도 승인 필요), 구버전 v0.1.56 설치 앱과의 혼재, staging/운영 D1 migration 0011~0017 적용, 학교망 1곳·TLS proxy, 100명 실부하와 기존 채팅 p95 비교, 성인 canary→30명 pilot, 200% 확대·Windows 브라우저.

### 리뷰 반영과 CI 실패 수정 · 2026-09-19

[#1119](https://github.com/jayleekr/hypeproof-studio/pull/1119)~[#1121](https://github.com/jayleekr/hypeproof-studio/pull/1121) 리뷰(JinyongShin)와 GitHub CI 실패를 스택 아래에서부터 고치고 위 브랜치로 merge했다. 2026-09-18 기록의 "exit 0"은 로컬 결과였고 CI에서는 재현되지 않았다.

- **CI `worker / test`:** AT-33 시험이 `git show 75fe6e4:worker/schema.sql`에 기대 얕은 checkout에서 실패했다. 0011 이전 schema를 `worker/test/fixtures/schema-pre-0011.sql`로 체크인했다. main이 `schema.sql`을 바꾸면 이 fixture를 같이 갱신해야 시험이 통과한다.
- **CI `extension / smoke`:** 확장 smoke 2개가 worker harness(hono)를 import해 extension job에서 `ERR_MODULE_NOT_FOUND`였다. 기기↔Service 왕복은 `worker/test/classroom-ops-device.test.mjs`, `classroom-ops-snapshot-device.test.mjs`로 옮겼다. `worker/node_modules`를 숨긴 상태에서 확장 ops smoke 3개 exit 0을 확인했다.
- **`/connect` rate limit:** 실패한 시도만 센다. 같은 주소에서 100좌석 연속 페어링 201, 잘못된 티켓 30회 뒤 429(유효 티켓도 차단 중에는 429).
- **epoch·cursor·ticket:** 토큰 재발급의 epoch 증가를 best-effort batch에서 분리하고 실패를 응답 `ops.epoch_advanced=false`로 드러낸다(발급 자체는 막지 않음, AT-32). 상태 쓰기가 없는 거부 배치에서도 ack cursor를 저장한다. 티켓 생성의 modulo 편향을 제거했다.
- **main 병합에서 드러난 회귀:** 교육 원칙 관문(#1115)이 합성 수업 확정을 `pedagogy_blocked`로 막았다. 합성 lesson에 선행 조건·제출 증거를 채웠다. 제품 코드 변경은 없다.
- **문서:** operations 음성 대조를 `requirement-work.json`과 `requirements-activation.md`에서 같은 문장으로 맞췄다(눈으로 대조). 작업 머신 경로·비공개 금고 경로 제거, flag 저장소(D1) 명시. 실수로 포함됐던 `docs/ui-concepts/` PNG 11개를 추적에서 제거했다.
- 재실행(스택 끝 `93da3b1` 기준 + 이 기록, Mac arm64, Node 22.22.1): worker test·typecheck, `test:classroom-ops:d1`, chalk test·typecheck, 확장 test·typecheck, e2e `test:classroom`·`test:classroom-ops`, `next-work --check`, docs harness, `check-registry` 모두 exit 0. 중간 브랜치는 그 PR이 건드린 계층만 재실행했다.
- **NOT RUN은 그대로다:** 실제 Mac/Windows Studio·SDK·학교망·운영 D1/R2·실제 발송. NAT 시험은 in-process KV이며 Cloudflare KV의 eventual consistency에서는 차단 시점이 늦을 수 있다.

<a id="remote-classroom-review-20260919"></a>

### 독립 검토에서 확인한 수정 인수 · 2026-09-19

대상은 R7 끝 `1432b27fac32bcfd2ea0420233f92579478dd8be`다. 기존 합성 suite와 브라우저 시험 통과는 아래 결함을 배제하지 못했다. F 번호는 이번 검토의 식별자이며 새 요구사항/별도 PRD가 아니다. 이 절의 테스트·문서 인계는 제품 구현 완료나 출시 승인이 아니다.

| 결함 / 기존 인수 | 직접 확인한 동작 | 반드시 통과해야 할 수정 인수 |
|---|---|---|
| F1 · P1 · AT-19/23/26/27 | 실제 spool처럼 metadata에만 `user={u,c,p}`가 있고 events에 user가 없으면, 다른 학생/cohort/profile 파일도 해당 좌석의 verified 입력이 됨 | App의 현재 활동과 Service의 학생·cohort·profile·회차·활동 binding을 immutable snapshot에 결속. 서로 다른 신원·회차·활동은 수집/평가 전 격리. 정당한 자기 기록은 정상 통과. 레거시 회차 귀속이 없으면 현재 회차로 추정하지 않음 |
| F2 · P1 · AT-21/23/24 | sync 요청 중 disconnect 후 늦은 proceed가 도착하면 reset 실행 1회. 이전 pause도 다시 적용됨 | 연결 generation/cancellation을 응답 후 및 실제 실행 직전에 확인. disconnect/재연결 전 응답으로 새 명령·hold 적용 0회. 정상 연결 명령은 1회. 이미 실행 중인 작업은 중지 요청과 결과 확정/불명을 구분 |
| F3 · P1 · AT-31 | 형제자매 2명·동일 guardian·동일 초안을 승인하면 예상 2건인데 adapter/원장 각각 1건. 두 번째가 replay로 표시됨 | delivery key를 논리 발송의 학생·회차·job·수신자 revision에 결속. 두 학생은 각각 1건, 같은 발송 재시도는 추가 0건. 타 회차에서 재사용한 recipient_ref, 같은 내용/다른 주소도 별개. send_unknown 재조정 유지 |
| F4 · P1 · AT-15/17/18/36 | 실제 host는 profile/trace만 관측. step/evidence builder, runtime_ready, 실제 SDK/도구 오류 발행이 빠짐. browser 시험은 사건을 직접 주입함 | 확정 수업의 실제 단계 선택·완료/근거 행동과 SDK/proxy/도구 오류·해결을 App에서 발행. 실제 UI→host→Service→보드 왕복 시험. raw 대화/파일은 상태 전송에서 제외. 미지원은 unknown, 토큰 수/클릭으로 학습 완료를 추정하지 않음 |
| F5 · P1 · AT-28 | 정상 수업 만료 뒤 pending snapshot을 둔 실제 host.resume은 자격 삭제 후 종료, 업로드 0회 | 관측/명령과 upload-only 수명을 분리. 정상 만료는 승인된 기존 snapshot만 24시간 범위 내 재개. 관측·AI·명령은 재개하지 않음. 철회·좌석/사용자 변경은 이전 자격으로 신규 수집 금지. 다른 학생의 pending 파일을 현재 자격으로 순회하지 않음 |
| F6 · P2 · AT-29/36/37 | 없는 event_id나 다른 사건의 인용도 전역 문자열 검색으로 통과. 반대로 따옴표·줄바꿈을 포함한 정상 인용은 거부 | 검증된 event_id 또는 레거시 turn/line locator와 해당 사건의 JSON 해석 후 원문을 연결. actor/source_state를 구조적으로 대조. AI/강사/가상 사례를 학생의 실제 독립 수행으로 승격 금지. 정확한 인용과 이스케이프 문자는 정상 통과 |
| F7 · P2 · AT-27/29 | seq 1 / 깨진 JSON / seq 2를 complete로 판정. 시작/마지막 확정 경계 없이 연속 꼬리만으로도 완전성 판정 가능 | 잘못된 JSON/스키마를 버리고 complete로 만들지 않음. snapshot의 선언된 시작·종료 범위와 최종 확정 사건을 검증. 범위 불명은 불완전/격리, 레거시 seq 없음은 sequence_unavailable 유지 |

수정 시작점: Service의 `worker/src/routes/classroom-collect.ts`, `worker/src/lib/classroom-collect.ts`, `worker/src/routes/classroom-delivery.ts`, `worker/src/lib/classroom-report.ts`; App의 `extensions/hypeproof-chat/src/classroomOps.ts`, `classroomOpsHost.ts`, `classroomOpsCommands.ts`, `chatPanelProvider.ts`, `sessionSpool.ts`, `evidenceSnapshot.ts`. 이 목록은 파일 소유권을 바꾸거나 전체 재작성을 허용하지 않는다.

#### 실행 가능한 실패 테스트

`test/751-ops-review-regressions`는 제품 코드 수정 없이 회귀 조건을 인계하는 로컬 브랜치다. Node 22.22.1에서 다음 두 명령을 각각 실행한다.

```sh
npm --prefix worker run test:classroom-ops:review
npm --prefix extensions/hypeproof-chat run test:classroom-ops:review
```

- `worker/test/classroom-ops-review.test.mjs`: F1의 학생/cohort/profile 혼입, F3의 동일 초안 형제자매+재시도, F6의 locator/다른 사건/이스케이프 인용, F7의 깨진 JSON/레거시 대조군. 실제 HTTP route·SQLite·메모리 R2·외부 요청 없는 발송 adapter를 사용한다.
- `extensions/hypeproof-chat/test/classroom-ops-review.test.mjs`: 실제 sync/CommandRunner로 정상 연결과 disconnect 뒤 늦은 명령·control 응답을 대조한다.
- `extensions/hypeproof-chat/test/classroom-ops-expiry-review.test.mjs`: 실제 host를 VS Code stub과 번들해 uploader가 만든 frozen pending state를 재개한다. 정상 만료와 명시적 disconnect를 구분한다. 설치 앱/운영 Service 검증은 아니다.
- 인계 시 **총 15건 중 4 PASS / 11 FAIL**. FAIL은 올바른 동작을 기대하는 assertion이며 known-bug를 PASS 처리하지 않았다. F4는 실제 App 연결이 없어 이 테스트 묶음으로 검증되지 않는다. F1 회차/활동, F2 재연결·실행 도중, F3 다른 회차, F5 철회·공유 PC, F6 주체/출처, F7 경계 조건은 수정 시 추가한다.
- 신원/업로드 scope에 새 versioned 계약을 도입하면 fixture도 정상 발급 경로로 갱신한다. 특히 기존 mock metadata `{"s":1}`와 전역 snapshot 파일은 정상 귀속의 증거가 아니다. fixture만 바꾸고 혼입·늦은 응답·발송 누락·정상 만료 시나리오를 제거해서는 안 된다. App spool 세션 ID를 class_run ID로 단순 치환해 실제 기기 검증을 대신하지 않는다.
- 현재는 명시적 review 스크립트로 실행하며 기존 CI 성공과 구분한다. 수정 PR에서는 모두 green으로 만든 뒤 worker `test:classroom-ops`와 확장 기본 test/CI에 편입한다. `skip`/`todo`/항상 실패 기대 방식으로 통과시키지 않는다. 실패 테스트만 담은 이 브랜치를 제품 완료 PR로 병합하지 않는다.

#### 구현 누락과 실제 운영 미실행을 구분한다

| 현재 상태 | 필요한 코드 | 완료 증거 |
|---|---|---|
| R5 runner 기본값은 모든 항목이 unobserved인 emptyDraft | 기존 공통 측정 계약과 승인된 rubric/evaluator를 쓰는 실제 평가 adapter, 별도의 legacy HAIN7 adapter. evaluator 미설정은 명시적 미설정 상태로 표시 | 검증된 실제 형식의 합성 기록에서 근거 있는 초안·근거 부족 결과가 각각 생성. version/hash/주체/출처 유지. 새 점수 체계나 7→6 변환 없음 |
| 수집 이후 별도 jobs 버튼·수동 runner 실행 필요 | 수집 receipt→dedupe job→제한 runner→검수 대기 자동 연결, sleep/offline/재시도·진행률/부분 실패 복구 | ‘수업 마무리’ 1회로 동의된 대상만 자동 진행. 재클릭/재시작 중복 0. 검수/발송 승인 단계는 유지 |
| 보고서 JSON만 있고 실제 HTML/PDF renderer 없음 | 기존 보고서 산출/스타일 재사용, 보호 링크의 읽기 화면·PDF 렌더, 데이터와 서술 일치 | 합성 보고서를 실제 브라우저·PDF 지면으로 확인. 빈 근거를 저점수로 표현하지 않고 개인정보/원문 불필요 노출 없음 |
| R6는 dry-run/test adapter만 존재, Chalk도 dry-run만 호출 | 실제 provider adapter 한 개, 서명 검증 webhook·중복/역순/unknown 조정, 승인된 묶음의 발송 UI | 자격 없이 가능한 전송 계약/서명 fixture 시험은 로컬 완료. 공급자 sandbox/실수신은 해당 환경에서 별도 확인. 계정만 넣으면 이미 완성된 상태라고 기록하지 않음 |
| refresh_connection은 기존 학습 토큰 재검증 | 기존 발급·재발급·기기 연결 흐름과 표시/권한 통합. 원격 전달을 구현할 경우 SecretStorage·학생/좌석 binding·epoch 반영 | 발급/전달/검증/수업 입장/runtime 준비를 혼동하지 않고 확인 가능. 보드·URL·로그에 bearer 미노출 |
| 동의 철회 tombstone는 있으나 R2/산출물/링크/캐시 삭제·보존 정리가 미완 | 기존 보존 정책을 실행하는 제한된 정리·철회 경로와 재수집 방지 | 삭제/보존 대상과 감사 기록을 분리, 늦은 재전송으로 부활 0. 이미 외부에 전달한 사본은 회수했다고 주장하지 않음 |
| 기존 학생 목록과 원격 목록 중복, 선택 상세가 긴 화면 하단 | 기존 관리 화면 안에서 중복 정리·목록+오른쪽 상세(좁은 폭은 drawer 등), 화면 기준 주요 CTA 하나 | 30좌석·공통 장애·키보드·200%·5개 폭에서 실제 렌더. forest/lime, 코칭/복구 분리, 도움받은 수행 출처 유지 |

실제 macOS/Windows Studio·SDK 중지/복구, 학교망, staging/운영 D1/R2, 실제 평가 공급자 호출·메일 발송은 이번 인계에서도 **NOT RUN**이다. mock/브라우저/타입검사로 이 행을 PASS로 바꾸지 않는다. 코드로 가능한 부분은 계정 대기와 분리해 끝내고, 운영 활성화에 필요한 결정만 마지막에 남긴다.

### 검토 결함 수정과 미완 기능 보강의 실행 기록 · 2026-09-19

브랜치 `fix/751-ops-review-f1-f7`(R7 끝 `1432b27` + 준비 커밋 `115d4d3` 위). 이 기록 직전 HEAD `dcc2332`, Mac arm64, Node 22.22.1. 인계 시 15건 중 4 PASS / 11 FAIL이던 review 시험은 **기대값을 바꾸지 않고** 전부 통과하며, 빠져 있던 대조군을 더해 worker 25건·확장 14건이 됐다. 두 묶음은 worker `test:classroom-ops`와 확장 기본 `npm test`에 편입돼 PR CI의 `worker / test`·`extension / smoke`에서 항상 실행된다.

| 결함 | 수정 | 실행한 시험 (모두 exit 0) |
|---|---|---|
| F1 | App `freezeSnapshot` + manifest `/2` binding, Service 귀속 대조, migration 0018 | 다른 u/c/p 3건, 다른 회차·활동·활동 없음·동의 범위·좌석·spool session, 수업 창 밖 기록, 신원 없는 기록, 회차 귀속 없는 레거시, metadata 없는 manifest, 자기 기록 양성 대조군. 기기 쪽: 공유 PC(`identity_mismatch`)·신원 없음·수업 전 이벤트 제외·다른 grant의 복사본 |
| F2 | sync 응답 폐기, `CommandRunner.close()`, host 연결 generation | 늦은 proceed 0회·늦은 pause 0회·정상 1회, 재연결 뒤 이전 응답 무효, 실행 도중 해제 → 중지 요청 + `outcome_unknown(connection_closed)` |
| F3 | `deliveryKey` | 형제자매 2건·재시도 0건, key 단위: 다른 회차의 같은 recipient_ref·정정 주소·개정 보고서·dry/live |
| F4 | 수업 패널 단계 버튼, `turnObservations`, 산출물 digest, capability 선언, status `observes` | 단위 3건 + 브라우저 왕복(아래) |
| F5 | upload-only 재개, grant 결속 state | 정상 만료 재개·명시적 해제·공유 PC·24시간 경과·Service 거부(철회) 1회 기록 후 미재시도 |
| F6 | 사건별 디코딩 원문 대조, actor/source_state | 없는 event_id·다른 사건 인용·따옴표/줄바꿈 양성, AI·강사·가상 사례 단독 근거 거부, 맥락 인용 허용, 초안의 화자 바꿔 적기 거부, 레거시 line/turn locator |
| F7 | `damaged`·`range_unknown`·extent 대조 | 깨진 행, 비객체 JSON, 선언 없는 연속 꼬리, 선언 시작/끝 불일치, 행 수 불일치, 마지막 사건 불일치, 레거시 유지 |

보강한 기능과 그 시험:

- **평가 adapter·자동 연결** `worker/test/classroom-ops-evaluator.test.mjs`(7): 미설정은 `evaluator_not_configured`(초안 0건), `advance` 반복에도 학생당 provider 호출 1회·job 중복 0, 학생 입력 없는 기록은 호출 없이 전부 `아직 충분히 보지 못함`, 카탈로그 밖 인용·AI 단독 근거는 초안이 되지 않음, 503은 큐 복귀 후 가시적 실패, runner의 Service 내 평가. provider는 전송 seam에서 대체했다 — **실제 모델의 관찰 품질 검증이 아니다.**
- **legacy HAIN7 adapter**: 기존 Python 엔진을 실제로 실행(`--legacy-replay`, 엔진의 sample session). 7축 유지, score/band 미반입, 학생 발화만 근거, 28-marker 검수 없으면 `marker_review_missing`.
- **읽기 화면·PDF** `e2e test:classroom-report`: 실제 Chromium 1280/360/200%. 악성 인용 미실행, 가로 스크롤 없음, 키보드로 세부 열기, 대비(본문 ≥7, 보조 ≥4.5), 같은 페이지에서 A4 PDF 2쪽 생성을 눈으로도 확인(한글·밝은 지면·방법 절 인쇄).
- **메일 adapter·webhook** `classroom-ops-provider.test.mjs`(5): Svix 공개 테스트 벡터, 응답별 accepted/unknown/rejected 매핑, 검수된 문안만 live 발송, 확정 실패만 재시도, 서명 불일치·재생·중복·역순(delivered 뒤 sent)·opened 무시, delivery_key tag로 `send_unknown` 확정, 다른 message id를 가진 행은 가로챌 수 없음, 미설정은 dry-run만.
- **철회·보존** `classroom-ops-erasure.test.mjs`(3): 철회 시 해당 학생의 snapshot·초안·링크만 사라지고 다른 학생은 유지, 남는 행에 학생 원문 없음, 늦은 기기 재전송·`수업 마무리` 재실행·새 batch·새 발송에서 제외, 운영자 1명 철회·보존 기간(기본값 없음·기한 전 거부·재실행 무해).
- **Chalk 목록+상세·왕복** `e2e test:classroom-ops-roster`(6): 빌드된 webview의 실제 클릭 → provider의 단계 매핑 → **실제 ClassroomOpsHost**(vscode만 bundle 경계에서 stub) → 실제 Service → 실제 Chalk. 30좌석, 공통 장애(30%=9석), 구버전 앱 `확인 불가`, 기존 목록과 중복 제거, 1440 측면 패널·1024/200%/390 drawer, 키보드 열기/닫기·포커스 복귀, 44px, 화면 기준 주요 CTA 1개, `수업 마무리` 1회 → 실제 host 업로드 → 평가 → 검수 대기(재실행 중복 0), 승인≠발송·실제 발송 확인 단계·재클릭 재발송 0.
  - 이 왕복 시험이 **실제 결함 1건**을 잡았다: 관측 훅이 동시에 outbox에 저장하면 임시 파일 rename 경합으로 사건이 사라졌다. 저장을 직렬화했고 대조군을 추가했다.
- 기존 시험의 계약 변경: `수집/보고서/발송/기기 snapshot` fixture를 App의 실제 freezer를 쓰는 발급 경로로 바꿨다(시나리오는 보존). runner 시험의 "평가기 없으면 전부 not seen yet 초안"은 검토 지적대로 **잘못된 기대**여서 `evaluator_not_configured`로 바꿨다. 철회 시험은 "이미 수집한 것도 지워진다"로 강화했다.

최종 회귀(이 브랜치 끝): `npm --prefix worker test`·typecheck, `test:classroom-ops:d1`(migration 0011~0018 재실행), `npm --prefix chalk test`·typecheck, 확장 `npm test`·typecheck, e2e `test:classroom`·`test:classroom-ops`·`test:classroom-ops-roster`·`test:classroom-report`, `next-work --check`, docs harness, `check-registry` — **실행 결과: 전부 exit 0**, 확장 `build:extension`도 exit 0(2026-09-19, 문서 커밋 직전 작업 트리 기준). 브라우저 e2e 4종은 PR CI에 없다(로컬 실행).

**코드는 있으나 실제 환경에서 NOT RUN:** 실제 macOS/Windows Studio에서의 단계 버튼·SDK fallback·reset·업로드 재개, 학교망, staging/운영 D1(0018 포함)·R2 삭제, 실제 Anthropic 호출로 만든 초안의 품질과 비용, Resend 계정·sandbox·실수신·실제 webhook, 실제 보호자 메일 클라이언트에서의 링크·PDF.

**2026-09-20 후속 보강(같은 브랜치):** 앞 문장의 “아직 코드가 없는 것” 중 단계의 강사 확인 입력, 브라우저 e2e의 PR CI 편입, 보존 기간 자동 실행, 링크 열람자 확인은 구현했다(아래). 누적 패턴 본문·PDF 첨부·Kakao/SMS·QR·열람자 본인 인증은 [후속 범위](../requirements/classroom-admin.md#이번-인수-범위와-후속-범위-2026-09-20)로 분리했고 **이번 관제·단일 회차 보고서 인수의 합격 조건이 아니다.**

- **평가 큐 정체(Codex 후속 재현)** `classroom-ops-evaluator.test.mjs` +6(총 13): OFF→ON에서 이전 `evaluator=none` 작업은 `superseded`, 학생당 평가 1회, 반복 호출 중복 0; Codex 재현 그대로(두 학생 각 1회, `more`가 끝남); evaluator 버전 변경 시 평가된 초안은 그대로 두고 미평가 작업만 재준비; legacy 7축이 앞에 있어도 Service가 lease하지 않음; 두 호출자 동시 실행은 서로 다른 job; 503은 그 작업만 30초→2분 쉬고(fake clock) 3회째 `failed`; runner는 선언한 종류만 받는다. 재현 스크립트(`.git/remote-classroom-evidence/review-20260919/followup-evaluator.mjs`) 재실행 결과 provider 호출 2회·정체 없음.
- **강사 reviewed** `classroom-ops-coaching.test.mjs` +1: 진행 중 단계는 확인 불가(`step_not_submitted`), `observe`만 가진 강사 거부, 두 강사 동시 확인은 200/409, 오래된 revision 거부, 다음 단계는 ‘확인 전’. 브라우저 왕복에서 `결과를 확인했어요` → 행에 `(강사 확인함)`.
- **보존 자동 실행** `classroom-ops-erasure.test.mjs` +3(총 6): 기간 미설정·잘못된 값 6종·전역 스위치 OFF는 무동작, 기간만 설정은 dry-run, 기한 전(fake clock) 대상 0, enforce에서 R2 장애 주입 → `started/content_delete_failed` → 다음 tick이 완료, 재실행 무해, tick 상한, 15분 tick은 실행하지 않고 일일 tick만 실행.
- **링크 열람자 확인** `classroom-ops-delivery.test.mjs` +1(총 8)과 기존 링크 시험 갱신: GET은 질문만(보고서 내용 없음), 오답 403·남은 횟수, 구분자 섞인 정답 허용, 5회째 영구 잠금(정답도 404), 값 없는 수신자는 live 발송 제외·원장 0행, 승인 뒤 값 변경은 `approval_stale`, 잘못된 형식 4종 거부, DB·감사에 값 원문 없음. 브라우저에서 질문 → 오답 → 정답 → 보고서.
- **PR CI** `.github/workflows/classroom-ops.yml`: 브라우저 e2e 4종. 확장 의존성을 숨긴 상태(CI와 같은 설치 집합)에서 로컬 통과를 확인했다. **GitHub에서의 첫 실행 결과는 PR 생성 뒤 확인한다.**
- **격리 Mac host** `e2e/classroom/mac-devhost.mjs`([README](../../e2e/classroom/README.md)): `prepare`를 실제 실행 — 설치된 v0.1.16 앱은 변경되지 않았고, 복사본의 번들 4개 해시가 현재 빌드와 일치, 복사본 ad-hoc 서명 검증 통과. **`launch`(GUI 실행)와 실기 관찰은 하지 않았다.** 설치된 v0.1.16을 실행한 결과를 이 기능의 검증으로 기록하지 않는다.

최종 회귀(2026-09-20, 이 브랜치 끝): worker test·typecheck, `test:classroom-ops:d1`(0011~0021), chalk test·typecheck, 확장 test·typecheck·build, e2e 4종, `next-work --check`, docs harness, `check-registry`, `check-workflow-shells` — 결과는 PR 본문의 검증 절에 HEAD와 함께 적는다.

**아직 코드가 없는 것(환경 대기가 아님):** 위 후속 범위 표의 5개 항목.

<a id="remote-readiness-review-20260920"></a>

### 독립 재검토와 실기 전 추가 인수 · 2026-09-20

검토 기준은 #1169 끝 `c58dbc804503d45d6efde83a80e0d61cb5f6252a`다. 제품 소스는 수정하지 않았다. 확인한 범위는 다음과 같다.

- 로컬은 `feat/751-review-c-ops-ui-retention-ci`, clean이며 원격 #1169 HEAD와 같다. 확인 당시 origin/main `ce95747`을 모두 포함하고 58 commits 앞이다. 관제 구현은 아직 main에 병합되지 않았다.
- GitHub API로 #1165, #1119~1127, #1129, #1167~1169의 14개 PR을 조회했다. 모두 OPEN/CLEAN, 수집된 check 중 실패·대기 0. 마지막 3개는 Draft이고 #1169의 `classroom / browser`도 SUCCESS다. **#1120·#1121은 CHANGES_REQUESTED**, 나머지도 승인 확보와는 별개다. CLEAN은 테스트·실기·리뷰 승인을 합친 판정이 아니다.
- 직접 실행: worker review 25, 확장 review 14, evaluator/provider/erasure 24 = **63 PASS / 0 FAIL / skip 0**. 기존 평가기 OFF→ON 재현도 다시 실행해 두 학생 각각 1회 평가, 이전 job superseded, 최종 more=false를 확인했다. 브라우저는 이번 재검토에서 재실행하지 않고 현재 PR의 CI 결과를 확인했다.
- 이 기록은 전체 코드 감사나 출시 승인 판정이 아니다. 아래 두 동시성/복구 시나리오는 기존 테스트에 없었고 합성 계정·SQLite·메모리 R2·provider transport stub으로 직접 재현했다. 실제 모델/학생/운영 저장소에 접근하지 않았다.

| 추가 수정 / 기존 인수 | 재현과 관측 | 수정 인수 |
|---|---|---|
| P1 · 철회 완료 뒤 늦은 평가 결과가 R2에 다시 남음 / AT-28~30 | 실제 `advance`가 provider 응답을 기다릴 때 같은 학생을 `eraseLearnerCollection`로 철회. 삭제 기록 done, report 객체 0 확인 뒤 provider 응답 반환. job은 withdrawn을 유지하지만 학생 인용을 담은 `draft.json`이 1개 다시 저장됨. 30일 보존을 설정하고 40일 뒤 tick해도 done 행을 제외해 객체가 남음 | 삭제/철회와 쓰기의 순서를 결속. stale lease 또는 tombstone의 입력은 결과 저장을 확정하지 못해야 함. D1/R2는 하나의 transaction이 아니므로 사전 확인만으로 끝내지 말고 늦은 PUT·CAS 실패·프로세스 중단 때 남는 객체의 보상 삭제/재조정까지 포함. 정상 job은 1회 저장. 학생 A 철회가 B를 건드리지 않음 |
| P1 · 실패한 철회 삭제가 보존 만기까지 재시도되지 않음 / AT-28 | 수업 중 철회에서 R2 delete 실패 주입 → erasure_log는 withdrawn/started. R2 복구 뒤 retention=30일/enforce, 다음 날 tick. due=0, attempts=1 그대로이고 snapshot 객체 2개가 남음 | 사용자가 이미 요청한 철회의 중단된 삭제를 만기 보존 작업과 분리해 재시도. 보존 일수 미설정/기한 전에도 명시적으로 승인된 철회 작업은 회복 가능해야 함. 일반 보존 OFF는 신규 만기 삭제 0을 유지. 재시도 상한·지연·진행 상태·다른 학생 불변 검사 |

첫 문제의 시작점은 `worker/src/routes/classroom-reports.ts`의 `saveResult`다. R2 put을 먼저 하고 D1의 leased/generation 조건을 나중에 검사한다. 두 번째는 `worker/src/lib/classroom-erasure.ts`의 `runClassroomRetention`: 모든 후보에 `ends_at <= cutoff`를 적용하며 설정 OFF 시 돌아온다. 기존의 철회 후 재요청 거부 시험은 **이미 진행 중인 요청의 늦은 완료**를 검사하지 않는다. 이번 재현은 R2 잔존을 증명하며 보호 링크의 재공개를 증명한 것은 아니다.

추가 회귀는 임의 sleep으로 순서를 기대하지 말고 provider/R2 단계별 barrier로 재현한다. 평가/업로드 중 철회, R2 put 중 철회, 결과 CAS 실패, 삭제 중 오류·프로세스 중단을 대조한다. 실제 구현 위치의 원장을 재사용하고 별도 삭제 시스템을 복제하지 않는다.

**Mac 인수 준비의 현재 한계:** 기존 `mac-devhost` manifest는 shell v0.1.16, extension SHA `f3763d6`, `agent_sdk_vendored=false`이며 prepare만 실행돼 있다. 현재 HEAD의 GUI/SDK 인수 증거가 아니다. v0.1.56의 공식 Mac arm64 ZIP(170,569,061 bytes)과 Windows x64 산출물은 GitHub release에 존재함을 조회했다. 다운로드/설치/GUI 실행은 이번 재검토에서 하지 않았다. 준비된 복사본과 실제 release, proxy fallback과 vendored SDK 실행은 각각 다른 증거로 남긴다.

#### 위 두 결함의 수정과 실행 결과 · 2026-09-20

수정 위치는 재현이 가리킨 그대로다. #1168에 `saveResult`(결과 저장), #1169에 삭제 원장의 복구·재확인을 넣었다. 계약은 [요구사항의 ‘결과 저장과 삭제의 순서’·‘요청된 삭제의 복구 ≠ 보존 만기 삭제’](../requirements/classroom-admin.md#검토-반영으로-확정한-계약-2026-09-19)가 소유한다. 추가 migration은 없다(0021의 `state`에 `settled` 값만 추가로 쓴다).

| 시나리오 (순서는 sleep이 아니라 provider/R2 barrier로 강제) | 결과 |
|---|---|
| Codex 재현 1 그대로: provider 응답 대기 중 철회 → 삭제 `done` → 응답 도착 | 학생 객체 0, job `withdrawn`, 응답은 `withdrawn`으로 거부. 40일 뒤에도 0 |
| R2 쓰기가 진행 중일 때 삭제 완료 → 쓰기 도착 | D1이 확정을 거부, 같은 요청에서 본문 삭제. 객체 0 |
| 쓰기 도착 직후 프로세스 중단(CAS·보상 삭제 없음) | 고아 객체 1개(열람 경로 없음) → 창이 닫히기 전 tick은 건드리지 않음 → 이후 tick이 삭제, `settled`, 감사 `collection_erased_late_objects{objects:1}`. 이후 다시 선택되지 않음 |
| lease 만료 뒤 재claim, 이전 세대의 늦은 쓰기 | 이전 세대는 자기 키만 쓰고 지움. 확정된 `draft.g2.json`은 digest까지 그대로, 검수자가 정상 열람, 저장 감사 1건 |
| 보상 삭제 자체가 실패 | 요청은 정상 응답, 내용 없는 `report_draft_discard_failed` 기록, 같은 작업의 다음 확정 저장이 잔여 세대 본문 정리 |
| Codex 재현 2 그대로: 철회 삭제 중 R2 오류, 보존 OFF | 학생 응답 `202 erasure=pending`, 원장 `started`. 5분 뒤 tick은 대기, 15분 뒤 tick이 완료(`done`, attempts 2). 보존 30일/enforce·기한 전이어도 동일하며 보존 tick은 due 0 |
| 계속 실패 | 간격 15분·1시간·6시간·24시간…, 12회에서 자동 재시도 중단·`retry_limit`·감사 1건(매 tick 반복 없음). 운영자 조회에 `needs_operator`, 원인 해소 뒤 운영자 요청으로 완료 |
| 15분 tick / 일일 tick | 15분 tick이 보존 설정 없이 철회를 끝냄. 보존 OFF의 일일 tick은 900일 지난 회차도 새로 지우지 않음 |
| 다른 학생 | 모든 시나리오에서 다른 학생의 snapshot·초안 객체와 digest, 열람 링크가 그대로. 원장에 요청되지 않은 학생 행이 생기지 않음 |

실행: `worker/test/classroom-ops-evaluator.test.mjs` 17(신규 4), `worker/test/classroom-ops-erasure.test.mjs` 12(신규 6, 기존 1건은 ‘중단된 보존 삭제는 복구가 끝낸다’로 계약 변경 반영) — 모두 PASS, skip 0. Codex의 원 재현 스크립트도 수정 뒤 다시 실행했다: 재현 1은 잔존 객체 0. 재현 2의 원본은 보존 tick만 호출하므로 출력이 같고(보존은 더 이상 재시도 주체가 아님), 복구 tick을 더한 사본은 `done`·객체 0이다. 결과 JSON은 저장소 공통 `.git` 아래 재검토 증거 폴더에 `*-after-fix.json`으로 두었다.

**한계:** SQLite와 메모리 R2에서의 순서 검증이다. 실제 D1/R2의 지연·부분 실패·Worker 중단은 staging 시험 항목이며 NOT RUN이다. `settled` 이전의 고아 객체는 어떤 열람 경로로도 읽히지 않지만(작업 `withdrawn`, digest 없음, 링크 폐기) 저장소에는 최대 한 tick(15분)+창(약 13분) 동안 존재할 수 있다.

#### 실제 Mac GUI·SDK 실행 · 2026-09-20

`e2e/classroom/mac-devhost.mjs prepare` → `e2e/classroom/mac-gui.mjs`. 설치된 앱(`/Applications`)은 읽기만 했고 실행·수정하지 않았다. 아래는 **합성 시험이 아니라 실제 창을 구동한 결과**이며, 무엇이 실제이고 무엇이 합성인지는 결과 파일의 `real`/`synthetic` 항목이 소유한다.

| 구분 | 내용 |
|---|---|
| 실제 | Studio shell 프로세스(v0.1.16 **복사본**, ad-hoc 서명, 격리 user-data), extension host·webview(실행 시점의 소스 SHA와 bundle 해시 4개는 결과 파일에 기록, 최종 실행 `35370da`), 명령 팔레트·알림, Agent SDK 0.3.207 JS(저장소 설치본에서 복사, package-lock 핀 일치·import 검증) + 네이티브 `claude` 바이너리(`HPS_SDK_BINARY`), 127.0.0.1 HTTP → 실제 Service 라우터 + SQLite, 실제 sync loop·명령 실행기, 실제 workspace 파일 |
| 합성 | 계정·수업, **모델 공급자**(api.anthropic.com 자리에 정해진 SSE/400/무응답), 메모리 R2, in-memory secret storage |
| 결과 10/10 PASS | 토큰 활성화(수업 패널 표시) → 팔레트에 1회용 코드 입력해 연결(알림, 보드 `token_verified`·connection active) → 학생 단계 버튼 → 보드 in_progress/submitted(자기보고) → 강사 확인(`confirmed`, 기기 보고값은 그대로) → 공급자 400 → 보드 blocking 오류·`runtime_failed` → 다음 실제 턴 성공으로 해제(`cleared`, SDK 경로 stream+tools 15) → **실행 중인 SDK 턴을 강사가 중지**(`run_stopped`) → 보존형 reset(`reset_ok`, 파일 2개 sha256 동일, 대화 유지, reset 뒤 턴 성공) → 새 코드로 재연결(이전 grant `revoked`, epoch 2) → 연결 끊기(파일 동일) |

이 실행이 **찾아낸 결함 2건**(수정·회귀 추가, #1167; ①의 첫 수정은 늦게 돌아온 확인이 최신 신호를 덮는 순서 문제를 만들었고 F4 왕복 e2e가 잡아 ‘그 연결의 첫 보고일 때만’으로 좁혔다): ① 연결 전에 끝난 토큰 검증이 보드에 도달하지 않음 — 합성 시험은 연결 뒤에 검증을 호출해 실제 순서를 가렸다. ② 학생 알림에 `reset_runtime` 식별자가 그대로 노출. **관측 2건**(결함으로 판정하지 않음): 지속적인 5xx에서 실제 CLI가 재시도를 계속해 보드는 stall watchdog(기본 240초)까지 아무 신호도 받지 못한다 — 강사에게 ‘응답 없음’이 늦게 보인다는 뜻이며 watchdog 값은 운영 결정이다. 확장의 시작 시 업데이트 확인이 공개 release feed를 읽어 이 구버전 shell 복사본에 “새 버전 v0.1.56” 배너를 띄웠다(읽기 전용, 설치하지 않음).

**이 실행이 증거가 아닌 것:** 현재 공식 release shell(v0.1.56)·설치/업데이트/서명·seed된 바이너리 경로, release의 registry vendoring, 실제 모델의 응답, 학교망, Windows, production/staging D1·R2. 공식 v0.1.56 ZIP은 내려받지 않았다(다운로드는 별도 승인 사항).

#### migration 순서 리허설과 대상 확인 도구 · 2026-09-20

`worker/scripts/classroom-ops-d1-check.mjs`(읽기 전용, 대상 이름과 uuid를 매번 요구)와 절차는 [`worker/DEPLOY.md`](../../worker/DEPLOY.md#remote-classroom-operations-751--staging-rehearsal-schema-order-flags-recovery)가 소유한다. 로컬 workerd D1에서 미적용 → 0011~0015만 적용(중단 지점 보고) → 전체 → 재적용, 절반만 만들어진 migration의 음성 대조군까지 PASS(`npm --prefix worker run test:classroom-ops:d1`). 확인한 사실: 이 저장소에는 `d1_migrations` 이력이 없고, `deploy-worker.yml`은 0011~0021을 몰랐으며(명시적 opt-in 입력 추가), staging 환경은 존재하지 않는다. **실제 Cloudflare 대상에 대한 실행은 NOT RUN.**

#### 실제 모델·메일 제한 시험 준비 · 2026-09-20 (둘 다 NOT RUN — 계정·비용 승인 전)

**모델.** `e2e/classroom/evaluator-trial.mjs`. 운영 경로(라우트·adapter·`validateDraft`)를 그대로 쓰고 기록만 합성이며, 사례마다 정답을 심었다(본인 기준 제시 / AI만 있는 기록 / 가상 사례 / 판단 변경 / 비밀값이 든 줄 / 빈약한 기록). 상한: 호출 8회(9번째 시도에서 프로세스 중단), 입력 60,000자/회, 출력 4,096 토큰/회 → Sonnet급 정가 기준 **최악 $2.72**, 이 사례들의 예상 실비 $0.10 미만. 중단 조건: 상한 초과, 200이 아닌 응답 2회, anthropic 외 호스트로의 요청. 키는 환경변수로만 읽고 출력하지 않으며, 키가 속한 API workspace에 별도 지출 한도를 걸 것을 전제로 한다. 채점기 자체의 대조군은 모델 없이 실행했다: 양성(`good`) 6/6 통과, 음성(`scores`, claim에 “85점, 상위 10%”)은 FAIL — 그리고 이 음성 대조군이 **글로 쓴 점수가 저장되던 결함**을 드러내 수정했다.

| 판정 | 기준 |
|---|---|
| 기계 PASS | 6사례 모두: 심은 본인 발화가 근거로 인용됨, AI·가상 사례 문장이 학생 근거로 인용되지 않음, 비밀값이 든 줄 미인용, AI만 있는 기록은 호출 0·전부 미관찰, 점수·순위 표현 없음, 모든 인용이 기록 원문과 글자 단위로 일치 |
| 사람 PASS | 관찰 주장마다 인용이 그 행동을 실제로 보여 주는가. 6사례 중 5 이상에서 근거 없는 주장 0, AI/가상 문장을 학생에게 귀속한 사례 0 |
| FAIL → 활성화 보류 | 위 미달, 또는 실측 비용이 예상의 5배 초과 |

**메일(Resend).** 계정 준비(사람): 발신 전용 **하위 도메인** 인증(DKIM·SPF 레코드는 Resend 화면이 제시), 그 도메인에 한정한 sending 전용 API key, webhook endpoint `https://<service>/v1/classroom/delivery-webhooks/resend`와 signing secret. Service 설정은 이름만: `wrangler secret put RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, vars `HPS_DELIVERY_PROVIDER=resend`·`HPS_DELIVERY_FROM`·`HPS_PUBLIC_BASE_URL`. 값은 문서·커밋·대화에 적지 않는다. 시험 수신자: 공급자의 시험 주소 `delivered@resend.dev`·`bounced@resend.dev`·`complained@resend.dev`와 운영자 본인 사서함 1~2개(합성 학생에 연결, 열람 확인 값 설정). 상한 10통, staging Service에서만.

| 판정 | 기준 |
|---|---|
| PASS | ① 발송 직후 `provider_accepted`이며 화면이 ‘전달 완료’라고 하지 않음 ② delivered 주소는 webhook 뒤 `delivered`, bounced 주소는 `bounced` ③ 같은 승인으로 다시 눌러도 새 발송 0(Idempotency-Key) ④ 서명이 틀린 webhook은 401·상태 불변, 같은 event 재전송은 1회만 반영 ⑤ 실제 사서함에서 링크 → 확인 값 오답 → 정답 → 보고서, 5회 오답 잠금 ⑥ 철회 뒤 같은 링크는 404 |
| 합성으로만 남는 것 | 공급자 timeout 뒤 결과 불명(`send_unknown`)은 실계정에서 강제할 수 없다 |


<a id="remote-mac-readiness-20260921"></a>

### 공식 Mac shell 복사본으로 직접 실행 · 2026-09-21

기준 소스는 #1169 `e3196e5bcf08c1e373014cc8086cd14ef4018f90`. 그 HEAD의 #1167~1169 최신 체크는 성공이며 Draft OPEN이다. 최신 main은 `19ff881`(학생 화면 개편 #1170/#1178). `git merge-tree --write-tree HEAD origin/main`에서 **5개 파일 충돌**(요구 목록, 확장 package.json, chatPanelProvider, ChatPanel, worker package.json)을 확인했다. 합성 CI 성공은 이 두 개발선의 통합이나 운영 활성화를 증명하지 않는다.

이번에는 공식 v0.1.56 arm64 ZIP을 내려받아 SHA-256 `96d4cb31c3845370dc5ba8794a0bfd7682063579b0549bc94b4c19cfb9ad9526`를 대조했다. 그 **복사본**에 현재 extension/webview 번들 4개를 주입하고 ad-hoc 서명했다. SDK 0.3.207 JS와 native binary를 실제 실행했다. 설치 앱·실학생·production 자격은 사용하지 않았다. 창 조작은 macOS 접근성/브라우저 UI로 직접 수행했다.

| 직접 수행한 경로 | 결과와 경계 |
|---|---|
| 학생 입장 → A1 연결 | 실제 앱이 frozen lesson과 토큰을 읽고 `token_verified`를 보고. 6좌석 중 **실제 Mac은 A1 하나**이며 A2 오류/A3 정상은 합성 신호, A4~6은 미연결 대조군 |
| 과제 수행 → 제출 → 강사 확인 | 실제 학생 버튼에서 `in_progress/submitted`, Chalk에서 강사 `confirmed`. 자기보고와 강사 확인을 구분 |
| 오류 → 진단 → 보존형 초기화 → 재시도 | 공급자 400을 주입해 빨간 장애 표시. `retry_diagnostics=token_ok`, `reset_runtime=reset_ok`. 대화·미전송 입력 보존, workspace 파일 2개 전후 SHA-256 동일, SDK 재대화 성공 |
| 실행 중인 SDK 중지 → 재시작 | 지연 응답 중 강사 명령 `cancel_current_run=run_stopped`. 이어서 새 SDK 턴 성공. 의도적인 중지를 학생 화면에서 일반 연결 오류처럼 표현하는 문구는 후속 UX 과제 |
| 동의 → 수업 마무리 → 실제 기록 회수 → 초안 | A1의 실제 SessionSpool 파일을 업로드·서버 해시 검증. 6명 중 1명 수신, 동의 없는 5명 제외. **평가기 transport는 합성**이나 실제 입력한 질문이 인용된 초안을 열고 내용 검수/승인함 |
| 발송 미리 확인·보고서 렌더 | 합성 수신자에 dry-run 통과, 외부 발송 0. 실제 발송 버튼은 HTTP public origin 등 미설정 상태로 `delivery_provider_not_configured`를 반환. HTML 보고서는 실제 compose/render 경로로 열었지만 정적 로컬 미리보기이며 실제 수신자 인증·메일 전달 증거가 아님 |

로컬 증거는 공통 git-dir `remote-classroom-evidence/review-20260921/`(PR 상태, 전후 workspace 해시, status/명령/초안 JSON, 화면, 재현 로그)에 있다. 시연 산출물은 ignored `e2e/test-results/classroom-demo-20260921/`이며 자격값/원문을 git에 넣지 않는다. `/manage`는 실제 Chalk 화면이다. 수업용 토큰·세션은 임시이고 재실행 시 새 합성 회차로 시작한다.

**실행 중 발견해 수정한 코드 3건.** 격리 브랜치 `fix/751-mac-devhost-launch`에 준비했다. 위 실기 기록은 수정 전 기준이며 아래 회귀가 수정본의 증거다.

1. 긴 checkout 하위 user-data 경로로 Electron IPC Unix socket가 103바이트를 넘으면 `ENOTSOCK`로 종료. 짧은 temp 경로를 host별로 분리하고 비정상 종료를 성공으로 끝내지 않음. 실제 Unix socket bind 대조군 포함 2 PASS, 기존 브라우저 workflow에 편입. GUI는 짧은 별도 profile로 실행해 원인을 확인함.
2. 늦게 기록이 도착하면 같은 학생이 `missing`과 초안 행 양쪽에 남아 6명이 7작업으로 보임. 검수 view에서 입력 있는 학생의 옛 placeholder만 제외하고 DB 이력/다른 학생 누락은 보존. 해당 회귀 포함 evaluator+erasure 32 PASS.
3. 강의의 `participants` 초대 경로가 일반 발급의 원장·재발급 세대 갱신을 누락. 위 실제 UI에서 발급 이력 없음으로 나타났고, 새 API 회귀에서 `unregistered != token_issued`로 재현. 같은 hook 연결 후 ops 20 PASS(강의 binding·다른 학생 세대·OFF·저장 장애 대조 포함), 기존 authoring 25 PASS, worker typecheck PASS.

**남는 코드 과제:** 현재 `SessionSpool.append`는 `seq`를 쓰지 않는다. 따라서 **새 앱의 새 기록도** `sequence_unavailable`이며 UI의 ‘구형 기록’ 설명은 부정확하다. 이를 complete로 승격하지 말고 durable 순번/선언된 범위/재시작·부분 쓰기·snapshot 계약을 구현하고 기존 legacy를 계속 수용해야 한다. 최신 main 학생 UX와 관제 hook 통합도 아직 미완이다.

**NOT RUN:** 실제 모델 답변의 품질·비용, 실제 메일/수신/webhook, Windows, 학교망, Cloudflare staging/production D1·R2, 공식 전체 release의 설치/업데이트/서명/seed 경로. 이번 실행은 공식 shell을 활용한 개발 host 검증이며 출하 패키지 인수가 아니다. 필요한 개발 계정 key는 이 checkout/현재 환경에 없었다(값은 읽거나 출력하지 않음).
