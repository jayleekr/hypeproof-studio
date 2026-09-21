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

<a id="one-instructor-acceptance"></a>

## 1인 강사 통합 인수 · 2026-09-21

상태: **계획·미실행**. 기존 개별 AT·Chalk 테스트를 하나의 수업 흐름에 연결하는 인수이며
새로운 점수 체계나 기존 통과 기록의 대체가 아니다. [세 범주의 의도와 범위](../plan/learning-agent-experience-epics.md#one-instructor-classroom)를 따른다.

| 범주 | 확인할 실제 행동 | 기존 근거와 구분 |
|---|---|---|
| 커리큘럼 구성 | 같은 커리큘럼을 두 대상에 맞게 변형하고 AI 역할·기능·실습의 변경을 학생 조건으로 확인한다. 초안 변경이 진행 중 수업을 바꾸지 않는다 | Chalk BASE-04, CH-01/04/06/07, ENV-01/03, EDU-02, RUN-01, VER-01/02 및 기존 Chalk 테스트. U3의 버전 전달 통과만으로 구성 UI까지 합격하지 않음 |
| 진행 파악·소통 | 강사 한 명이 명단 전체에서 입장 실패, 정상 진행, 도움 요청, 제출, 무신호를 구분하고 해당 학생의 피드백·해결 확인까지 이어간다 | ADM-02/04/05/09, 기존 AT·U1 선택. 상태 지연·미관찰을 정상으로 바꾸지 않음 |
| 원격 조치·결과 | 선택 학생과 전체에 조치하고 비선택 학생은 불변임을 확인한다. 토큰 준비, 배포, 허용된 데이터 회수, 알려진 장애 복구의 결과를 대상별로 확인하고 기존 초안·파일을 보존한다 | 기존 AT-15~34 및 U1~U4 계약. 명령 접수·업로드 시도·진단 완료와 실제 적용·검증된 회수·원인 해결을 구분 |

인수 기록에는 정확한 source/build, OS·네트워크·기기 수, 수업/커리큘럼 버전, 성공·실패·미확인
사례, 강사 개입 시간·학생 대기 시간·미해결 건수·현장 이동 횟수를 남긴다. 인원과 성공 기준은
실제 리허설 전에 확정하며 임의의 정원·절감률을 성과로 쓰지 않는다. 합성 수업은 기술 검증,
실제 강사가 혼자 운영한 관측은 운영 검증으로 구분한다. NOT RUN 환경은 그대로 남긴다.

현재 마무리 범위는 U3 잔여 오류 → U4 원인별 조치 → 필요한 회수 흐름 → 통합 리허설이다.
구성 편집기 확장·전체 PC 조종·새 전달 채널은 이 인수를 핑계로 추가하지 않는다.
통합 인수 후에도 미완 범주는 로드맵에 남기며, 완료한 기능만 메인 Features 항목의 지원 범위로 옮긴다.

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

<a id="at-id-ledger-20260921"></a>

#### 원격관리 인수 행과 AT ID 정정 · 2026-09-21

**무엇이 겹쳤나.** 2026-09-18(`c891b4f`)에 AT-37(근거 부족 표시)·AT-38(관찰·성장 보고서 구성)·AT-39(학생 화면의 질문·확인 지점)가 먼저 정해졌다. 2026-09-21(`b222c34`)의 U1 작업이 같은 표에 **같은 번호로** 선택 모델(AT-37)·선택 회수(AT-38) 행을 넣었고, 다섯 흐름 매핑은 대상 배포를 AT-39라고 불렀다. 한 ID가 두 인수 조건을 가리키면 ‘AT-38 PASS’가 무엇의 통과인지 알 수 없다. **먼저 정해진 뜻이 번호를 유지한다**(AT-37/38/39 = 2026-09-18의 뜻, 위 표 그대로). 나중에 들어온 세 조건은 새 번호를 받는다. AT-40·AT-41은 겹치지 않아 그대로다. 과거 실행 기록의 문장은 고치지 않았고, 아래 ‘옛 표기’로 읽는다.

| Test ID | 제품 REQ | 조건 / 깨뜨릴 가정 | 합격 기준 | 실행 계층 |
|---|---|---|---|---|
| AT-42 | ADM-02/10 · RM-1 | 개별·전체·도움 필요·연결됨·미연결 선택, 선택 없음, 명단 revision 변경, 미리 확인 뒤 선택 변경, `collect` 전용 강사 | 실행 전 대상 수·연결 가능/불가·제외 사유 표시, 빈 선택은 실행 불가, revision이 바뀌면 선택 비움, 확인은 본 대상에만 유효, 권한별로 허용된 조치만 노출 | UI e2e + 실제 Mac |
| AT-43 | ADM-03/13/14 · RM-2 | 선택 A1·A3/비선택 A2, 미동의·철회·오프라인 선택, 빈 대상·오타 필드·중복·회차 밖 좌석, 더블클릭·응답 유실·같은 key 다른 요청, 명단 변경, 종료된 회차의 새 요청 vs 이미 요청된 업로드, 구버전 전체 회수, ops OFF, 범위 조회 장애·손상, 읽기–쓰기 사이의 좌석 교체·종료·flag·철회 | 비선택 학생의 명령·업로드·객체·평가 0, 전체로 확장 0, 같은 요청은 같은 결과·다른 요청은 409, 범위를 못 읽으면 503(평가 입력 0), 경합은 0건 기록으로 거부, 회수는 평가·발송을 시작하지 않음 | Service + UI e2e + 실제 Mac |
| AT-44 | ADM-10/11 · RM-3 · INT-CO-04(제안) | 공지·자료의 대상 배포: 선택 A1·A3/비선택 A2, 권한 없음·flag OFF·구버전 capability, 배포 강사의 권한 철회(배포 강사 ≠ 연결 발급 강사), 여러 배포와 회수의 단위, 오프라인 재접속·좌석 교체·재발급·기기 교체·종료, 중복 요청·같은 key 다른 내용, v2 뒤 늦은 v1, 저장 오류·응답 유실·앱 재시작, 부분 실패만 재선택, 미연결·비선택 학생의 콘텐츠 접근, 회수, 기존 수업 회귀 | 선택 좌석만 그 revision을 **보관함에 반영**했다고 보고하고 재시작 뒤에도 카드가 열림, 비선택 학생의 제안·읽기·파일 변화 0, HTTP 200·제안·알림을 완료로 세지 않음, 되돌아감·중복 카드 0, 기존 자료 보존·거짓 반영 0, 전체로 확장 0, 미확인·회수 확인 불가는 성공이 아님 | Service + App + UI e2e + 실제 Mac ([시나리오 D1~D16·M1](#remote-management-u2-plan-20260921)) |
| AT-45 | ADM-10/11 · RM-3 · INT-CO-04(제안) | 수업 **프롬프트**의 대상 배포: 선택 A1·A3/비선택 A2, 기존 초안·첨부·예약 전송이 있는 상태와 클릭 직전의 입력, 가져온 뒤 편집·회수, 출처·revision, 미지원 App | 선택 좌석만 보관함 반영, **학생이 직접 누른 `초안에 가져오기`만** 초안을 바꾸고 덧붙일 뿐 대체·자동 전송·모델 호출 0, 첨부·예약·진행 중 turn 불변, 회수가 학생 초안·대화·파일을 지우지 않음, 가져옴·보냄이 강사에게 보고되지 않음, 보관함 반영을 ‘사용’으로 세지 않음 | Service + App + UI e2e + 실제 Mac ([시나리오 P1~P7·M2](#remote-management-u3-plan-20260921)) |
| AT-46 | ADM-10/11 · RM-3/5 · ADM-13 · AE-09/12/26/33 · VER-01 · INT-CO-04(제안) | 수업 **설정**(확정 강의 버전)의 대상 배포: 선택/비선택, 실행 중 변경과 두 번 연속 변경·다른 창의 다중 요청, 옛 key·옛 turn id 재사용, 헤더 없는 App, 두 runtime, 전환 커밋 경계의 경합, 재발급·좌석 교체·늦은 응답, OFF·전역 OFF·읽기 장애(전환 전/후/도중)·종료·권한 폐기·정책 축소, 실행 전에 거절된 요청, 기준 변경과 보고서 경로, 회수와 복귀, 미지원 App | 진행 중 turn은 **Service가 승인한 snapshot**으로 끝나고(이후 전환 횟수와 무관 · 수명 30분 · 연장 불가) 새 turn은 현재 binding으로만 승인됨, App(`/v1/profile`)·Service(gate)·turn 행·요청 헤더가 같은 key, `적용됨`은 **정규화된 wire가 upstream 응답을 받은 기록**뿐(gate 통과·`/v1/profile`·preflight·`count_tokens`·거절된 요청은 아님 · 시도/상류 실패/미확인을 구분), OFF와 장애가 좁혀진 설정을 넓히지 않고 모르는 상태에서는 보류(실행 전이면 입력 복원 · 일부 실행됐으면 부분 실행 표시 · 자동 재전송 0), 비선택 학생의 실행·profile 불변, 이전 기준의 자기보고·강사 확인을 새 기준 완료로 상속 0, **섞인 기준의 회수 입력이 평가·승인·전달되지 않음**(단일 기준은 그대로 처리), 회수가 설정을 되돌리지 않고 복귀는 새 요청+새 적용 증거 | Service + App + 합성 upstream + 로컬 workerd D1 + UI e2e + 실제 Mac ([시나리오 S1~S19·M2](#remote-management-u3-plan-20260921)) |
| AT-40 | ADM-10 · RM-4 | 원인 5종(토큰·연결·runtime·preview·업로드) × 1순위 조치, Chalk에서 눌러 실제 창으로 확인 | 원인마다 허용 목록의 조치 하나가 1순위로 제시되고 실제 사후 조건이 재관측됨, 대화·입력·파일 보존 | Service + UI e2e + 실제 Mac |
| AT-41 | ADM-10 · RM-5 | 회수·배포·복구의 결과를 한 화면에서 같은 단계 어휘로 표시, 부분 결과 | `접수 → 수신 확인 전 → 기기 수신 → 적용 / 실패 / 미확인 / 만료·대상 변경`이 세 흐름에 공통, ‘서버 검증됨’·‘보관함 반영’·복구 결과 코드를 한 성공 수로 합치지 않음, `leased`/`offered`를 수신으로 표시하지 않음 | UI e2e + 실제 Mac |

| ID | 뜻 | 상태 (2026-09-21 현재) | 근거 위치 |
|---|---|---|---|
| AT-35 | 복구·코칭 capability 분리 | **실행됨** — Service + 브라우저(합성). 실제 Studio 창에서 `send_question` 미실행 | [보강 기준 실행 기록](#보강-기준복구코칭-분리-출처-근거-부족-14--2026-09-18) |
| AT-36 | 출처·source_state·강사 확인 | **실행됨** — Service + 브라우저(합성). App의 실제 `evidence` 발행 연결은 같은 기록의 NOT RUN | 같은 곳 |
| AT-37 | 근거 부족 표시 | **실행됨** — Service·core fixtures(합성) | 같은 곳 · R5 기록 |
| AT-38 | 관찰·성장 보고서 구성 | **실행됨** — core + runner fixtures(합성). 실제 모델 NOT RUN | R5 기록 |
| AT-39 | 학생 화면의 질문·확인 지점(모달 0·문맥 유지) | **NOT RUN** — 실제 Studio 미확인 | 보강 기준 실행 기록의 NOT RUN |
| AT-40 | 원인별 복구 대응표 | **NOT RUN · 계획** (U4) | [매핑](#remote-management-map-20260921) |
| AT-41 | 세 흐름 공통 결과 화면 | **NOT RUN · 계획** | 같은 곳 |
| AT-42 | 공통 선택 모델 (옛 표기 AT-37) | **실행됨** — UI e2e + 실제 Mac 정상 경로. 실제 기기 2대 이상·Safari/Firefox NOT RUN | [U1 실행 기록](#remote-management-u1-run-20260921) |
| AT-43 | 선택한 학생의 수업 기록 회수 (옛 표기 AT-38) | **실행됨** — Service + UI e2e + 실제 Mac 정상 경로. 기기 실패·재전송은 합성, Windows·학교망·staging D1 NOT RUN | 같은 곳 |
| AT-44 | 공지·자료 대상 배포 (옛 표기 AT-39) | **실행됨 · 로컬 인수(2026-09-21)** — Service + 기기 + 로컬 workerd D1 + UI e2e + 실제 Mac M1(실제 창 1대, A2·A3 합성). 첫 인수 요청은 제안 커밋 경계 결함으로 반려 → 수정(`9d85718`)·회귀 추가 → **조율 측(Codex)이 독립 경합 재현과 실제 Chalk→Mac A1 선택 배포·회수·기기 회수 확인·초안 보존을 직접 확인해 로컬 범위를 인수**(그 증거는 조율 측 소유의 공통 git-dir `remote-classroom-evidence/management-20260921/u2-codex-reaccept-*-bdebdd3.*`·`u2-deferred-boundary-check-9d85718.log`에 있고 이 문서 작성 세션이 다시 실행한 것이 아니다). `bdebdd3`은 그 위의 문서·추적 커밋. **인수 범위 밖으로 남은 NOT RUN:** 같은 grant의 자동 재연결, Windows, 학교망, staging/production D1, 실제 기기 2대 이상, owner의 INT-CO-04 승인·운영 활성화. 로컬 인수는 PR 병합·운영 승인이 아니다 | [U2 실행 기록](#remote-management-u2-run-20260921) · [재인수 수정](#remote-management-u2-reaccept-20260921) |
| AT-45 | 수업 프롬프트 대상 배포 | **구현 · 로컬 실행 PASS · 인수 전** — Service·App 단위·브라우저·실제 Mac(실제 마우스 입력). 독립 검토 뒤 P2~P5·P7을 브라우저와 실제 host에서 마무리. 운영·Windows·학교망 NOT RUN | [실행 기록](#remote-management-u3-run-20260921) · [검토 보완 기록](#remote-management-u3-review-20260921) |
| AT-46 | 수업 설정 대상 배포 | **구현 · 로컬 실행 PASS · 인수 전** — Service·App 단위·로컬 workerd D1·브라우저·실제 Mac(agent-sdk 창 2개 + proxy-runtime 창). 독립 검토의 Service 결함 6건·화면 결함 보완, S3·S4·S9·S10·S13ⓒ를 실제 경로로 마무리. S15의 구 App 실물·p95·plan NOT RUN. 적용 시점의 운영 정책은 사용자 결정 대기(로컬 가정: 다음 질문부터) · 기준 판정은 [요청 단위의 식별 연결](#remote-management-u3-basis-identity-20260921)로 다시 닫음 | 같은 곳 |

**옛 표기가 남아 있는 곳(이번에는 고치지 않았다 — 시험 파일은 이 설계 세션의 소유가 아니다).** 아래 파일의 시험 제목·주석에 있는 번호는 작성 당시 표기다. U2 구현에서 시험 파일 소유권을 넘겨받을 때 제목을 새 번호로 바꾸고, 그때까지는 이 표로 읽는다.

| 파일 | 적힌 표기 | 가리키는 인수 |
|---|---|---|
| `worker/test/classroom-ops-selected-collect.test.mjs`(제목 11곳) | `AT-38 …`, `AT-37/38 authority and switches` | AT-43 (권한·스위치 항목은 AT-42/43) |
| `e2e/classroom/ops-roster.mjs` | `AT-37/38: one selection model → collect …` | AT-42/43 |
| `e2e/classroom/ops-selection.mjs` | `AT-37 in a real browser` | AT-42 |
| `worker/test/classroom-ops-coaching.test.mjs`, `e2e/classroom/ops.mjs` | `AT-37`(nothing observed), `AT-39`(learner-side display) | AT-37·AT-39 — 원래 뜻 그대로, 변경 없음 |
| #1165 Intent 문서의 ‘AT-15~39는 #1119에서 추가’ | AT-35~39 | 원래 뜻 그대로, 변경 없음 |

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

**실행기 (2026-09-21 추가).** `e2e/classroom/delivery-trial.mjs` — 모델 시험과 같은 구조다. 기본은 계획 + 로컬 대조군(네트워크 없음, `PASS_MACHINE_PART` 확인: 접수≠전달 / 열람 확인 값 없는 수신자에게는 실제 메일을 보내지 않음 / 같은 승인 재클릭 0통 / 서명 틀린 webhook 401·상태 불변·같은 event 2회는 1회 반영). 실제 발송은 `HPS_TRIAL_CONFIRM=real-mail`과 key·발신 주소가 있을 때만이며, 수신자는 공급자 시험 주소 3개 + 환경변수로 준 운영자 사서함 최대 2개, 10통 상한, `api.resend.com` 외 호스트 거부, 주소는 출력에서 가린다. 로컬 Service로는 볼 수 없는 ②(Resend의 실제 서명 webhook 수신)·⑤(실제 사서함에서 링크 열기)·⑥(철회 뒤 404)은 결과 파일에 `NOT_RUN`으로 적히며 staging Service에서 수행한다. 실제 발송: **NOT RUN**.


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

**남는 코드 과제(같은 날 오후 구현 — 아래 절):** 당시 `SessionSpool.append`는 `seq`를 쓰지 않는다. 따라서 **새 앱의 새 기록도** `sequence_unavailable`이며 UI의 ‘구형 기록’ 설명은 부정확하다. 이를 complete로 승격하지 말고 durable 순번/선언된 범위/재시작·부분 쓰기·snapshot 계약을 구현하고 기존 legacy를 계속 수용해야 한다. 최신 main 학생 UX와 관제 hook 통합도 아직 미완이다.

**NOT RUN:** 실제 모델 답변의 품질·비용, 실제 메일/수신/webhook, Windows, 학교망, Cloudflare staging/production D1·R2, 공식 전체 release의 설치/업데이트/서명/seed 경로. 이번 실행은 공식 shell을 활용한 개발 host 검증이며 출하 패키지 인수가 아니다. 필요한 개발 계정 key는 이 checkout/현재 환경에 없었다(값은 읽거나 출력하지 않음).


**수정 Service의 GUI 재실행:** `6a7f33c` Service + 같은 e3196e5 확장으로 합성 회차를 새로 열었다. 실제 A1 연결·SDK 대화·동의·자동 회수를 다시 실행해 **발급 ID 표시**, **6명 → 초안 1 + 미수신 5 = 현재 작업 6건**을 화면에서 확인했다. 현재 시연본은 이 조합이다. `e2e/test-results/classroom-demo-20260921/start.command`는 이 작업의 프로세스만 교체해 다시 연다. 전체 79개 회귀(실행기 2, ops 20, authoring 25, evaluator/erasure 32), worker typecheck, docs harness 100, requirement integrity, registry, workflow-shell 검사 통과. 브라우저 CI에 추가한 실행기 시험의 원격 CI는 아직 실행하지 않았다.

**추가 재현 1건 · (같은 날 오후 해결 — 아래 ‘최신 main 통합본의 Mac 재실행’):** 발급 이력을 연결하자 `token_verified` 때 `matches_issue`였던 표시가 다음 `runtime_ready` 뒤 `unknown`으로 돌아간다. Service가 `state.activation.value.token_jti`만 읽는데 최신 activation 전체 교체가 이전 토큰 확인을 지우기 때문이다. 실기 상세에서 ‘준비 완료’와 ‘앱 확인 보고 없음’이 함께 나타났고, 별도 `activation-regression.mjs`/`.log`에서 양성→음성 순서를 재현했다. 이 실패는 위 79개 수정 범위 회귀와 별개이며 숨기지 않는다. 다음 구현은 토큰 확인 근거를 입장 진행 상태와 분리해 보존하되 재발급/다른 토큰/새 연결·boot/좌석 변경의 근거를 섞지 않아야 한다. 최신 main 통합과 함께 AT-15/23에 회귀를 추가한다.

<a id="remote-mac-integrated-20260921"></a>

### 최신 main 통합본의 Mac 재실행 · 2026-09-21 (오후)

위 기록(수정 전 e3196e5 기준)의 후속이다. 같은 날 오후에 **스택 전체를 최신 main과 통합**(`19ff881`, 이어서 작업 중 들어온 `f44cce3` #1218 — 시험 체인 목록 1곳만 충돌)하고 남은 결함 두 건을 고친 뒤 같은 devhost로 다시 실행했다. 아래 표의 ‘실제/합성’ 경계가 이 실행이 증명하는 범위의 전부다.

**통합 방식.** main은 스택 맨 아래 `docs/remote-classroom-operations-20260918`에 병합하고 13개 브랜치로 올렸다(기존 관례, force-push 없음). 목록형 충돌(요구 목록·두 `package.json`의 시험 체인)은 양쪽을 합쳤다. 실제 충돌은 #1167에서 났다: `chatPanelProvider`는 관제 코드 + main의 영문 주석, `ChatPanel`은 main의 현재 과제 중심 화면을 그대로 두고 단계 자기보고를 얹었다(요구사항 ‘학생 화면 통합’ 행). Codex 수정 `6a7f33c`는 소유 PR별로 나눠 넣었다 — 초대 발급 원장 → #1167, 보고서 중복 행 → #1168, 실행기·문서 → #1169. 나눠 넣은 뒤 #1169 끝 트리가 `6fc8868` 위 병합 결과와 같음을 `git diff`로 확인했다.

**고친 결함.** ① 토큰 확인 표시: `activation-regression.mjs` 재현이 이제 통과한다(before/after 모두 `matches_issue`). 순수 대조군 1 + Service 회귀 1(`classroom-ops.test.mjs`: runtime_ready 뒤 유지 / 재발급 → other_token → 새 토큰 보고 → matches / 다른 토큰 / rejected → unknown / 새 boot → unknown → 재보고 / 오래된 boot의 늦은 sync는 무영향 / 새 연결은 첫 sync 전부터 unknown / 좌석 변경 → unknown). ② 기록 순번: 확장 `session-spool-seq.smoke.mjs` 7 PASS(동시 append 120건 1..N, 호출자가 seq를 덮어쓰지 못함, 세션별 독립 번호와 늦은 pinned turn, 실패한 append는 번호를 버림·찢어진 줄 격리, snapshot 읽기와 쓰기 큐의 일관성·쓰는 중 꼬리 제외, 재시작/다른 학생/창 밖/소유 불명 세션 수, freezer의 시작 증명 양성 2·음성 4). Service `classroom-ops-spool-seq.test.mjs` 7 PASS — **실제 SessionSpool → 실제 freezer → 실제 회수 라우트**로 정상=`complete`, seq 없는 기록=`sequence_unavailable`, 수업 중 재시작=`range_unknown(other_session_not_included)`, 꼬리 유실=`gaps(tail_missing)`, 실패한 append=`gaps`, 찢어진 줄=`damaged`, 세션 폴더 소실=`range_unknown`; 강사 요약의 ‘순번 연속’은 7건 중 1건. 기존 시험은 기대값만 고치고 시나리오는 보존했다(F7 순수 시험, device snapshot 왕복, 브라우저 왕복은 손으로 쓴 spool 대신 실제 SessionSpool로 기록 → 초안이 `partial`이 아니라 `review_required`). ③ 문구: ‘구형 기록’ 제거, Chalk에 `damaged`·`range_unknown` 표시 추가, 강사 중지 전용 안내.

**실행 구성.**

| 항목 | 값 |
|---|---|
| source | `4278b8d6b907df15bcc98a3f317633033f1fe9bb` — #1169 tip, **main `f44cce3`(#1218)까지 포함**. 원 checkout에서 빌드·`prepare`·실행(dirty 아님, 4개 번들 해시가 소스 빌드와 일치, 05:54–05:55Z). 같은 경로를 통합 과정에서 세 번 실행해 모두 14/14였다: main `19ff881` 통합 직후, 커밋 메시지 정리 뒤(`b72b8f4`), main `f44cce3` 통합 뒤(이 값). 이 기록을 적는 뒤따르는 커밋은 문서만 바꾼다 |
| shell | 공식 v0.1.56 arm64 **복사본**(commit `f5939d9cf6`), ad-hoc 서명. `/Applications` 설치본 미사용 |
| Agent SDK | 0.3.207 JS(`sdk.mjs` sha256 `7f12ca8bcc75fcdb…`) + native `claude`(sha256 `1397a062c6889675…`) 실제 실행 |
| OS | macOS 26.5.2 (25F84) arm64 |
| 실제 | Studio shell 프로세스·확장 host·webview·명령 팔레트·알림, SDK+native binary, HTTP→Service 라우터+SQLite, ops sync·명령 실행기, workspace 파일, **디스크의 SessionSpool(격리 HOME) → freezer → 업로드 → Service 재해시·coverage** |
| 합성 | 계정·강의, **모델 응답**(api.anthropic.com 자리의 스크립트), **보고서 평가 transport**, in-memory R2·secret storage. 메일은 이 실행에 없음 |
| 실행 | `e2e/classroom/mac-gui.mjs` 14/14 PASS, 39초, `result.json`·화면 13장은 devhost의 `gui/` |

| 단계(실제 창) | 확인한 것 |
|---|---|
| 발급 → 확인 | 강의 participants 경로로 발급(원장 기록). 앱이 `/v1/profile`로 확인. 과제 머리말에 확정 강의가 보임 |
| 연결 | 명령 팔레트에 1회용 코드 입력 → 보드 A1 `active` |
| 단계 → 강사 확인 | Primary 1개 확인 후 클릭 → `in_progress`; 조용한 버튼 → `submitted`·‘강사 확인 전’; Service API로 `confirmed`(기기 보고는 그대로) |
| 오류 → 해소 | 공급자 400 → 보드 차단 장애 → 다음 실제 턴 성공으로 해소 |
| **토큰 근거** | `runtime_ready` 뒤에도 `app_verified=matches_issue` (오전에 `unknown`으로 돌아가던 지점) |
| 중지 | 응답을 주지 않는 SDK 턴을 강사 명령으로 중지 → `run_stopped`. 패널에 ‘강사가 지금 실행 중이던 작업을 멈췄어요…’; ‘연결이 끊겼어요’·‘문제가 생겼어요’ 없음(화면 `06c-stopped.png`) |
| 초기화 · 작업 보존 | `reset_ok`. workspace 파일 2개 sha256 전후 동일, 대화 화면 유지, 초기화 뒤 SDK 턴 성공 |
| 동의 → 실제 기록 회수 | 실제 창에서 동의. `수업 마무리`에 해당하는 batch 생성 → 앱이 **자신의 실제 spool** 16사건(seq 1–16: workflow·prompt·usage·response·turn_end)을 동결·업로드 → Service `verified` · **`complete`**. 실제로 입력한 질문이 회수본에 있음. A2는 `consent_missing`으로 명단에 남음 |
| 초안 검수 | 평가 1회(합성 transport) → `review_required`·input `complete`·현재 행 1개. 초안이 실제 입력 문장을 인용. 내용 승인(발송 아님) |
| 재연결 · 나가기 | 새 코드로 연결 교체, 옛 연결 무효. 연결 끊기 후 파일 불변 |

이 실행은 e2e 관문(`HPS_TEST_E2E`/`hps-test-state.json`)을 **쓰지 않는다** — 쓰면 확장이 spool을 아예 만들지 않아 ‘실제 기록’을 시험할 수 없다. 대신 앱에 별도 `HOME`을 주어 실제 spool이 사용자의 `~/Library/Application Support/HypeProof-Studio`에 섞이지 않게 했다. 오전 시연은 이 격리가 없어 사용자의 실제 spool 폴더에 합성 세션(`demo-20260921-1`)을 남겼다 — 삭제하지 않았고, 정리 여부는 사람 결정이다.

**열어 둔 화면.** `e2e/classroom/mac-demo.mjs`(오전의 일회성 `demo-server.mjs`를 레포 상대 경로·격리 HOME·포트 설정으로 옮긴 추적 파일)가 같은 devhost로 6석 합성 회차를 띄운다: `http://127.0.0.1:18762/demo`(안내·강사 시험 토큰·A1 연결 코드·오류/대기 재현), `/manage`(실제 Chalk), 학생 앱 A1. 재실행 절차는 `e2e/classroom/README.md` ‘Re-running the whole classroom path on this Mac’. 회차·토큰은 약 1시간 뒤 만료되며 다시 시작하면 새 회차다.

**이 실행이 아닌 것.** 실제 모델의 답·품질·비용, 실제 메일·webhook·수신함, Windows, 학교망, Cloudflare staging/production D1·R2, 이 기능을 담은 release의 설치·업데이트·서명·seed 경로, 30석 동시 부하, 재시작 전 세션을 합친 회수(선언만 함).

<a id="remote-management-map-20260921"></a>

### 원격관리 다섯 흐름 — 현재 구현 매핑 · 2026-09-21 (HEAD `d9d31bf` 기준, 읽기 전용 조사)

[인수 계약 RM-1~5](../requirements/classroom-admin.md#remote-management-acceptance-20260921)와 현재 코드의 대조다. ‘직접 실행’은 오늘 실제 Mac 창(`mac-gui.mjs` 14/14, source `4278b8d`) 또는 오전 Codex의 수동 실행에서 본 것만이다. 브라우저 e2e·Service 시험은 ‘코드+합성 시험’으로 적는다. **오늘까지의 결과는 관제·복구·단일 회차 회수이며 원격관리 전체 완료가 아니다.** 이 문서와 E5 계획의 과거 문장 ‘이번 인수 = 관제·보존형 복구·단일 회차 보고서’는 **당시 #1119~#1169 스택의 범위**를 가리키며, 현재 사용자 목표인 원격관리 RM-1~5의 인수와 같은 말이 아니다.

| 흐름 | 있는 경로 (코드 · API · UI) | 증거 수준 | 없는 경로 |
|---|---|---|---|
| RM-1 선택·상태 | `GET …/ops/status`(좌석별 connection·token·entry_stage·step+review·error·runtime·signal·attention·last_command·observes) → Chalk `#ops-seats` 목록+`#ops-detail`. 선택: 좌석 체크박스 `picked`, `도움 필요한 좌석 선택`, `선택 해제`, 선택 요약(전달 가능/연결 없음) | 상태: **직접 실행**(실제 앱 A1 → 보드). 선택 UI: 코드+합성(30석 브라우저 e2e), 오전 수동 1석 | 전체 선택, 그룹(저장된 묶음·상태 필터), 선택을 회수·배포·다른 복구에 쓰는 공통 모델(지금 일괄 조치는 `retry_diagnostics` 하나) |
| RM-2 회수 | 수업 기록: `POST …/report-batches`(명단 전체 스냅샷, 동의·철회·미연결 사유 유지) → Service 발행 `retry_evidence_upload` → App freezer → PUT/seal → coverage. Chalk `수업 마무리`. 학생 프롬프트·결과물: 학생이 고른 공유 `POST /v1/classroom/shares`(ADM-03/05/06) → Chalk 공유 목록 | 수업 기록: **직접 실행**(실제 spool 16사건 `complete`, 미동의 좌석 제외). 공유: 코드+기존 시험, 오늘 미실행 | **대상 선택 회수**(API에 `targets` 없음 — 항상 명단 전체), 학생 프롬프트만/승인 결과물만 고르는 회수 종류, 강사가 요청하는 공유(지금은 학생 주도뿐) |
| RM-3 배포 | 없음. 인접 경로: `send_question`·`mark_checkpoint`(300/200자 평문, 기기 표시=성공, 읽음 아님), 회차 구성의 강의 version pin(`PUT …/ops` — 회차 전체, 학생 토큰의 lesson ref와 별개), 회차 일시정지의 기기별 `control_applied`(applied/pending/unknown) | 인접 경로: 코드+합성 시험만. 실제 창에서 `send_question` 미실행 | **수업 프롬프트·공지/자료·수업 설정의 대상 배포 전부**: 버전 있는 배포 객체, 좌석별 원하는 revision, 기기의 적용 보고, 비선택 불변 증거, 오프라인 후 재접속 적용 |
| RM-4 복구 | 허용 목록 5종 `retry_diagnostics`·`refresh_connection`·`restart_preview`·`cancel_current_run`·`reset_runtime`(1명씩) + 회차 `pause`. Chalk 상세의 ‘기술 복구’가 확인된 장애일 때 1순위 조치를 Primary로 제시 | `cancel_current_run`·`reset_runtime`: **직접 실행**(API 경유, 파일 해시·대화 보존). `retry_diagnostics`: 오전 수동(구 빌드). `refresh_connection`·`restart_preview`·pause: 코드+합성 | 원인→조치 대응표의 명문화와 시험(토큰 만료/거부 → 재발급 안내는 조치가 아니라 문구뿐), 업로드 실패 복구의 강사 트리거(Service 발행만), 복구를 Chalk UI에서 누른 실제 창 실행 |
| RM-5 대상별 결과 (정정: `leased`는 서버가 기기에 배정한 상태이지 기기 수신의 증거가 아니다 — 기기 receipt(`accepted` 이후) 전에는 ‘수신 확인 전’) | `ops_command_targets` 상태 12종 + result_code, `GET …/commands/:id`, Chalk `showCommand`(성공/실패/확인 불가/전달 안 됨/진행 중 + 좌석별 문구), 좌석 `last_command`. 회수는 batch item 상태, 일시정지는 `control_applied` | 성공 경로: **직접 실행**(`run_stopped`·`reset_ok`·회수 `verified`). 실패·만료·미확인·미연결·두 번째 창·재발급 뒤 미전달: 코드+합성(AT-20/21/23) | 세 흐름 공통의 한 화면 결과(지금은 명령·회수·일시정지가 각각 다른 자리), 실패 대상만 다시 선택, 배포의 결과 단계 |

**경계 조건 현황.** (정정: ‘종료’는 둘이다 — 종료 전에 이미 요청된 업로드의 유예(`upload_until`)는 계속 받고, 종료된 회차에 대한 **새** 회수 요청은 U1부터 `run_ended`로 거부한다. 기존 전체 ‘수업 마무리’의 종료 후 동작은 바꾸지 않았다.) 중복 요청(idempotency key·payload 충돌)·만료(TTL 120초: 시작 전 `expired`, 시작 후 영수증 없음 `outcome_unknown`)·재접속/재발급(이전 epoch 미전달)·부분 실패(대상별 원장)·수업 경계(회차·좌석 revision 결속)는 **명령과 회수에 구현+합성 시험**이 있다. 오프라인은 **접수 시점에 `not_connected`로 확정**된다 — 복구 명령에는 맞지만 배포에는 맞지 않는다(재접속해도 도착하지 않음). 배포에는 위 어느 것도 없다.

**추가한 인수 시험** ([ID 정정 원장](#at-id-ledger-20260921) — 이 문단은 처음에 AT-37/38/39로 적혔다). AT-42 선택 모델과 AT-43 대상 회수는 U1에서, AT-44 대상 배포(공지·자료)는 U2에서 구현·실행했다([U1 기록](#remote-management-u1-run-20260921) · [U2 기록](#remote-management-u2-run-20260921)). **아직 NOT RUN · 계획:** AT-40 원인별 복구 대응표(원인 5종 × 1순위 조치, 실제 창) · AT-41 세 흐름의 결과가 같은 단계 어휘로 한 화면에 남음. RM-3 행의 ‘없음’은 `d9d31bf` 시점의 조사이며, 그 뒤 공지·자료 배포가 구현됐다(수업 프롬프트·수업 설정 배포는 U3로 계속 없음).

<a id="remote-management-u1-run-20260921"></a>

### U1 — 공통 선택 + 선택 회수: 실행 기록 · 2026-09-21

[계약](../requirements/classroom-admin.md#remote-management-u1-20260921). 배포·PC 제어·평가 확장은 이 단계에 없다. 인수 ID는 선택 모델 = AT-42, 선택 회수 = AT-43이다(작성 당시 표기 AT-37/38 — [정정 원장](#at-id-ledger-20260921)). 아래 기록의 내용은 고치지 않았다.

**먼저 있던 재현 3건(Codex 독립 실행, 공통 git-dir `remote-classroom-evidence/management-20260921/`).** ① `selected-collection-check`: `targets:['A1']` dry-run이 201로 A1·A2 모두 반환 — API가 `targets`를 몰랐다. ② `scope-read-failure-check`: 구현 중 `batchScope`가 조회 예외를 `finish`로 읽어 collect_only 배치의 seal이 평가 입력 1건을 만들었다. ③ `selected-roster-race-check`: revision 검사 뒤 좌석이 a→b로 바뀌면 a를 고른 요청이 b에게 회수 명령을 보냈다. 수정 뒤: ① A2는 `not_selected` ② seal `503 scope_unavailable`·평가 입력 0 ③ `409 revision_conflict`·명령 0.

| 층 | 무엇을 | 결과 |
|---|---|---|
| Service (합성 6석, SQLite + in-memory R2) `classroom-ops-selected-collect.test.mjs` | 요청 정규화 대조군(양성 2·거부 12·해시 5) · 재현 ① · **선택 A1·A3 / 비선택 A2**(명령 target 2, A2 sync 명령 0, A2 PUT `not_requested`, R2 객체는 a·c만, 평가 입력 0, 보고서·발송 6개 경로 `409 collect_only_batch`, 평가 호출 0) · 선택한 미동의/철회/오프라인은 사유와 함께 남음 · 빈 대상/오타 필드/중복/회차 밖 좌석/`finish`+targets 거부와 DB 불변 · 더블클릭(경합)·응답 유실·같은 key 다른 대상/고지/dry-run/전체 → 1배치 또는 409 · 구버전 전체 회수 불변(평가 입력 생성)과 0022 이전 배치 재생 · `collect`만 가진 강사 허용/`command`만 가진 강사 거부 · 명단 변경 409·종료 뒤 새 요청 `run_ended`·이미 요청된 업로드는 유예 안에 수신 · **fail-closed**(조회 예외 + 손상 6종 × seal·조회·advance·jobs·reports·recipients·재생 = 503, 복구 뒤 검증·평가 입력 0, 진짜 이전 배치는 평가 입력 1) · **커밋 경계 경합 7종**(좌석 교체 revision 증가/미증가, flag 끔, 강사 종료, 시간 종료, 동의 철회, tombstone: 양성 대조 뒤 주입 → 거부, 5개 테이블 행 수 불변, 새 학생 target 0) · ops OFF | 12 PASS. 전체 worker suite·review suite·D1 리허설(0011→0022, 재적용, 반쪽 migration 음성 대조) PASS |
| UI → Service → 실제 host (브라우저 e2e, 30석) `ops-roster.mjs` | 전체 30/연결됨 11/미연결 19/도움 필요/해제(해제 시 회수 버튼 비활성) → S01·S02·S12 수동 선택 → 미리 확인(1명 요청·제외 2명 사유·비선택 27명 무접촉, 명령 0) → 선택 변경 시 확인 철회 → 더블클릭 요청 = 배치 1 → **실제 ClassroomOpsHost + 실제 SessionSpool**이 S01 기록 업로드 → ‘서버 검증됨 · 순번 연속’ · 결과 확정 문구 · 객체는 student-01만 · 평가/보고서 UI 미개방 · ‘도착하지 않은 대상만 다시 선택’ = S12만 · `collect` 전용 강사 화면(회수 버튼만) | 7 PASS (CI `classroom / browser`에 포함) |
| **실제 Mac** `mac-demo.mjs`(HPS_DEMO_PREPARE_A1=1) + `mac-demo-board.mjs` | 실제 Studio 창(A1): 1회용 코드 연결 → 실제 1턴 → 실제 창에서 동의. **실제 Chalk `/manage`(보이는 브라우저 창)**: A1 선택 → 미리 확인 → 요청 → `A1 — 서버 검증됨 · 기록 순번 연속 · 시작과 끝 확인됨`. 합성 좌석 A2·A3은 **연결+동의 상태**(선택만이 제외 이유)에서 `not_selected`, 회수 명령 target은 A1 하나(`succeeded · receipt_verified`), R2 객체 2개 모두 A1, 평가 입력 0·평가 호출 0·메일 0 | PASS — `result.json`·화면 2장은 devhost `board/`. source `c15e77a` + 실행기 수정(같은 커밋 묶음), shell 0.1.56 복사본, SDK 0.3.207, 확장 소스는 `4278b8d` 이후 불변 |

**UI 보완 · 같은 날 (독립 검토가 `b222c34`의 실제 브라우저에서 재현한 2건, 증거는 `management-20260921/ui-stale-preview-*`·`ui-failed-retry.*`).** P1: 지연된 미리 확인 응답이 명단 교체 뒤 도착해 ‘선택한 좌석 없음’ 옆에 ‘A1 · student-a — 요청 예정’ 확인을 다시 열었고, 확정하면 새 좌석 주인(student-c)에게 회수 명령이 나갔다(revision을 `await` 뒤에 읽음). P2: `failed`로 끝난 요청이 ‘진행 중 1’로도 세어져 재선택 버튼이 숨었다. 수정은 `017f02c`.

| 층 | 무엇을 | 결과 |
|---|---|---|
| 실제 브라우저(Chromium) + 실제 Chalk 페이지 + Service(SQLite), 합성 8석 — `e2e/classroom/ops-selection.mjs`. 응답 **도착 시점**은 네트워크 층에서 붙잡아 제어(Service는 이미 처리함), 업로드 명령의 종료 상태는 원장에 직접 기록(실제 기기를 지시대로 실패시킬 수 없음) | 대조군: 방해 없는 미리 확인→확정은 본 좌석 그대로 요청 · **지연 응답**: 선택 변경 뒤 / 선택 해제 뒤(버튼이 되살아나지 않음) / 더 새로운 미리 확인 뒤(역순 도착, 새 미리 확인 유지) / 취소 → 확인 화면 미개방, 실제 요청 0 · **재현 결함**: A1(a) 미리 확인 지연 → 정상 configure·pair·consent로 A1을 student-i(명단 2)로 교체 → 새로 확인 → 선택 비움·체크박스 0 → 옛 응답 도착 → 확인 미개방·미리 보기 빈칸 → 숨은 확정 버튼을 강제로 눌러도 student-i에게 명령 0 → 이어서 정상 경로로 student-i를 확인·확정하면 revision 2·student-i로 기록 · **확정 응답 역순**: 최신 확정이 결과 영역 유지, 이전 확정은 ‘접수되었습니다’로 고지, 두 배치 각 1건 · **P2**: 한 배치에 queued / 검증됨 / 전송 중 / failed(upload_failed) / rejected / expired / unsupported / outcome_unknown → `검증됨 1 · 기기 응답 대기 1 · 전송·검증 대기 1 · 실패·미도착 4 · 결과 미확인 1`, 미확인 줄에 ‘성공으로 세지 않습니다’, 진행 중이 남아도 재선택 버튼 표시(‘실패·미확인 5명만 … 진행 중 2명은 제외’), 누르면 A4~A8만 선택되고 아무것도 요청되지 않음, 유예·새 요청 안내 문구 | 5 PASS. **음성 대조군:** 같은 시험을 `b222c34`의 `manage.html`로 돌리면 FAIL(대조군 1건만 통과). CI `classroom / browser`에 추가 |
| 기존 브라우저 e2e 4종 + Chalk 시험 | 문구 변경 반영(`ops-roster.mjs`의 결과 요약·선택 변경 안내) | 전부 PASS |
| 실제 Mac (정상 경로 보존) `mac-demo.mjs` + `mac-demo-board.mjs`, source `017f02c` | 실제 창 A1 준비 → 보이는 Chalk 창에서 A1 선택 → 미리 확인 → 확정 → `검증됨 1 · … · 실패·미도착 0 · 결과 미확인 0 · … · 결과 확정`, A2·A3 `not_selected`, 평가 입력·호출 0 | PASS |

**이 보완에서 관측하지 않은 것(NOT RUN).** 실제 Studio 기기에서의 업로드 실패·거절·만료·결과 미확인(원장 상태를 직접 넣어 본 것이 전부다), 실제 기기 2대 이상에서의 지연·역순 응답, Safari/Firefox, 느린 실제 네트워크. Service 경계(멱등·fail-closed·커밋 경계 원자성)는 바꾸지 않았고 Service 시험 12건과 독립 재현 2건을 같은 커밋에서 다시 실행해 통과했다.

**업로드 생명주기 보완 · 같은 날 (독립 검토가 `83900f3`에서 재현한 2건, 증거 `management-20260921/ui-partial-upload-*`·`ui-late-seal-*`).** ① meta 한 파일이 실제 PUT으로 도착한 뒤 명령이 failed로 끝나면 화면은 ‘전송·검증 대기’만 말하고 실패를 숨겼으며 유예가 끝나도 같았다. ② 실패/미확인 뒤 늦게 검증된 학생이 패널에는 계속 실패로 남아 재선택 대상이 됐다. 수정은 `6004ccb`. 전이 표는 [요구 문서의 ‘회수 생명주기’](../requirements/classroom-admin.md#remote-management-u1-20260921)이고 구현(`collectStatus`)과 같은 행이다.

| 층 | 무엇을 (상태를 **바꿔 가며** 관측) | 결과 |
|---|---|---|
| 순수 함수 표 (`classroom-ops-selected-collect.test.mjs`) | 전이 표 27행(item × 요청 × 시각 × 유예) + 한 좌석의 시간 경과(요청 → 전송 → `offline_pending` 재전송 대기 → 재개된 바이트 → 검증됨) | PASS |
| 실제 Service 경로 (같은 파일) | 실제 PUT으로 meta만 도착 + `offline_pending` / `upload_refused` / `outcome_unknown` → 방금 도착한 바이트는 전송 중, 2분 조용하면 각각 재전송 대기·최종 거부·결과 미확인 → `outcome_unknown` 좌석이 유예 안에 늦게 seal → 검증됨(과거 요청 결과는 그대로 남음) → 재전송 대기 좌석이 같은 동결 revision을 마저 보내 검증됨 → 유예 종료: `grace_over`·`upload_open=false`·PUT 403 → 회차 종료: `new_request_allowed=false(run_ended)` | PASS (suite 14) |
| 실제 브라우저 + 실제 Chalk + Service (`ops-selection.mjs`, 8 PASS) | **L1** 8석 혼합 배치를 열어 둔 채 원장을 바꾸면 화면이 스스로 따라감: 검증됨 1·수신 확인 전 1·전송 진행 1·최종 거부 1·전달 안 됨 3·미확인 1, ‘진행 중 2명 — 자동으로 다시 확인’, 행마다 ‘현재: … · 기기 요청: …’, 진행 중이 있어도 재선택 5명(대기·전송·검증 제외) **L2** meta만 도착 3석: 직후에는 ‘전송 진행 3’·재선택 없음 → 2분 조용해지면 재전송 대기 1·최종 거부 2·‘일부 파일만 도착’·‘확정 아님: 업로드 유예 …까지’ → 재전송 대기 좌석의 늦은 seal을 **아무것도 누르지 않고** 재관측(5초 단계)해 검증됨, 과거 `offline_pending` 표시 유지 → 유예 종료: ‘업로드 유예 종료’·‘결과 확정 (업로드 유예 종료)’·재선택은 가능(새 요청) → 회차 종료: 재선택 비활성 + ‘이 수업은 끝나 새 회수를 요청할 수 없습니다. 업로드 유예도 끝났습니다’ **L3** 실패 + (meta 도착) 미확인 → 확정 아님 → 둘 다 늦게 seal → 보드의 ‘현황 새로 확인’만 눌러도 검증됨 2·재선택 사라짐·결과 확정 / 재선택 버튼과의 경합: 화면은 실패 2인데 그사이 한 명은 검증되고 한 명은 좌석 주인이 바뀜 → 재선택을 누르면 먼저 다시 읽어 선택 0명, 요청 0 **L4** `status` 없는 이전 Service 응답 → ‘구분 불가’, 재선택 없음. 앞선 지연 미리 확인·명단 교체·역순 확정 4건도 같은 파일에서 통과 | 8 PASS |
| 기존 회귀 | worker 전체·review, Chalk, 브라우저 e2e 4종(문구 변경 반영) | PASS |
| 실제 Mac 정상 경로 (source `586d13e`, shell 0.1.56 복사본, SDK 0.3.207) | 새 빌드로 세션 재시작, 실제 창 A1 준비 → 보이는 Chalk 창에서 A1만 선택·회수 → ‘현재: 서버 검증됨 · 기록 순번 연속 · 시작과 끝 확인됨 · 기기 요청: 기기가 전송을 마쳤다고 보고함 (receipt_verified)’, ‘서버 시각 … 관측 · 결과 확정’, A2·A3 `not_selected`, 평가 입력·호출 0. `6004ccb`에서 먼저 돌렸을 때 검증된 좌석 옆 과거 요청 문구에 ‘서버 검증 대기’가 남는 모순을 발견해 고치고 다시 실행했다 | PASS |

**시간 순서 보완 · 같은 날 (독립 검토가 `ec0f608`에서 재현, 증거 `management-20260921/upload-terminal-order-check.*`·`ui-fresh-terminal-still-active-6004ccb.txt`).** `collectStatus`가 종료된 요청 뒤에도 item `updated_at`이 90초 안이면 ‘전송 중’을 먼저 돌려줬다. 그 파일이 실패 보고 **전에** 온 것인지 **뒤에** 온 것인지 비교하지 않아, 실제 meta PUT → failed 순서에서 최대 90초 동안 ‘전송·검증 진행 중 · 기기에서 실패’, 진행 1, 재선택 숨김이었다.

| | 이전 (`ec0f608`) | 이후 |
|---|---|---|
| 파일 T → failed/`upload_refused` T+1초, 관측 T+3초 | 전송·검증 진행 중 · 재선택 숨김 | **최종 거부** · 재선택 가능 |
| 파일 T → failed/`offline_pending` T+1초, 관측 T+3초 | 전송·검증 진행 중 | **재전송 대기** · 재선택 가능 |
| failed T+1초 → **새 파일** T+2초 | 전송·검증 진행 중 | 전송·검증 진행 중(유지) — 조용해지면 재전송 대기/최종 거부로 복귀 |
| 같은 ms · 시각 없음(null) · NaN | 전송·검증 진행 중 | 순서 증명 불가 → 요청이 끝난 결과 그대로(진행 중 아님) |

`updated_at` 갱신 경로 확인: `uploading` item의 시각은 **새 파일** PUT만 갱신했고, 같은 바이트의 재전송(`retry:true`)은 갱신하지 않았다. 재개하는 기기는 가진 파일을 다시 보내는 것으로 시작하므로, 이제 같은 파일의 재전송도 (아무것도 저장하지 않지만) 이 시각을 갱신한다 — 실패해도 멱등 응답은 그대로다. `requested` 상태의 `updated_at`은 배치 생성 시각이라 바이트 규칙에 쓰지 않는다(`uploading`에서만 비교). 요청 시각은 receipt 수신·TTL 만료·취소 때 Service 시계로 기록된다. schema·새 서비스 없음.

| 층 | 무엇을 | 결과 |
|---|---|---|
| 독립 재현 그대로 | `upload-terminal-order-check.mjs` (수정 전 exit 1) | 4/4 PASS |
| 전이 표(순수) | ‘파일→실패’ 5행 · ‘실패→새 파일’ 5행(만료 뒤 재개·미확인 뒤 재개·다시 조용해짐 포함) · 순서 증명 불가 4행(같은 ms, null, NaN, item 시각 없음)을 분리해 추가. 시간 경과 시험도 ‘실패 0.1초 뒤 이미 진행 중 아님 → 새 파일 → 다시 조용’으로 교체 | PASS |
| 실제 API의 **순서만** 바꾼 검사(시계 이동 없음) | 실제 PUT(meta) → 종료 보고 → 즉시 조회: 재전송 대기 / 최종 거부 · 종료 보고 → 실제 PUT(다음 파일) → 전송 중 · 종료 보고 → 같은 파일 재전송(200 `retry`) → 전송 중 · 이후 조용해지면 복귀 · 늦은 seal·유예 종료·회차 종료는 기존 그대로 | PASS (Service suite 14) |
| 실제 브라우저 + Chalk + Service | meta 3석 PUT → failed 3종 → **곧바로** ‘전송·검증 진행 중 0 · 재전송 대기 1 · 최종 거부 2’, 재선택 3명 표시 → A4에 실패 뒤 실제 다음 파일 PUT → ‘진행 중 1’·‘도착하지 않은 2명만 … (진행 중 1명은 제외)’·‘자동으로 다시 확인’ → 같은 revision seal → 클릭 없이 검증됨 1, 과거 `offline_pending` 표시 유지. 파일 시각을 2분 전으로 옮기는 방식은 이 파일에서 제거했다. **음성 대조:** 수정 전 Service로는 이 구간의 옛 기대(‘직후에는 전송 중’)가 성립했고, 새 기대로는 실패한다 | `ops-selection.mjs` 8 PASS |
| 회귀 | worker 전체·review·Chalk·브라우저 e2e 4종, 독립 재현 2건(범위 조회 장애 503·명단 경합 409) | PASS |
| 실제 Mac (source `cb09c68`) | 이번 변경은 **종료된 요청 뒤의 바이트 해석**과 멱등 재전송의 시각 기록뿐이고 정상 경로(실행 중 → 검증됨)는 그 행들을 지나지 않는다. 별도 실기 항목을 늘리지는 않았고, 이 세션이 띄워 둔 시연(이전 빌드)을 새 빌드로 다시 여는 과정에서 같은 보드 스크립트가 실제 A1 선택 회수를 한 번 수행했다: ‘현재: 서버 검증됨 · 기록 순번 연속 · 시작과 끝 확인됨’, ‘결과 확정’, 평가 입력 0. 실제 기기의 실패·재전송은 관측하지 않았다 | PASS (정상 경로만) |

**이 보완에서 관측하지 않은 것(NOT RUN).** 기기 실패는 전부 원장에 기록한 합성이다 — 실제 Studio 기기가 `offline_pending`으로 멈췄다가 앱 재시작으로 재전송하는 경로, 실제 `upload_refused`/`verify_failed`, 실제 24시간 유예 경과는 보지 못했다(시각을 옮겨 대조). 10분 무변화 뒤 자동 확인 정지는 코드 경로만 있고 실시간으로 기다려 보지 않았다. 실제 기기 2대 이상, Safari/Firefox, 느린 망, Windows, 학교망, staging/production D1도 NOT RUN.

**실제/합성 경계.** 실제: Studio shell 복사본·확장·SDK·spool·freezer·업로드, Chalk UI, Service 라우터+SQLite. 합성: 계정·강의·모델 응답·좌석 A2/A3(그리고 e2e의 S02~S30)·R2(in-memory). 여러 좌석 동시성은 합성 좌석으로만 봤고 실제 기기는 1대다.

**남은 한계.** 실제 기기 2대 이상에서의 선택/비선택 대조, Windows, 학교망, staging D1에서의 0022 적용과 조건부 batch(D1의 트랜잭션 의미는 로컬 workerd D1 리허설까지만), 재시작 전 세션을 합친 회수, `coverage_reason`의 화면 표시는 NOT RUN/미구현. 학생 프롬프트·승인 결과물의 대상 회수, 배포(U2~), 세 흐름 공통 결과 화면은 이 단계 범위 밖이다.

<a id="remote-management-u2-plan-20260921"></a>

### U2 — 공지·자료 대상 배포: 인수 계획 · 2026-09-21 (작성 당시 전부 NOT RUN · 계획 — 실행은 [아래 실행 기록](#remote-management-u2-run-20260921))

[계약](../requirements/classroom-admin.md#remote-management-u2-20260921). 이 절은 AT-44를 구현과 **함께 한 번에** 검증할 수 있게 시나리오로 풀어 둔 것이다. 아래 어느 행도 실행되지 않았고, 시험 파일·migration·화면도 아직 없다. 제목이나 ID가 연결돼 있다는 사실을 실행으로 세지 않는다 — 실행되면 이 절 아래에 ‘실행 기록’을 따로 만들고 여기의 상태 칸은 고치지 않는다.

**보완(같은 날).** 독립 검토가 짚은 계약 공백 일곱 가지(권한 철회 경계, 기기 커밋, 배포·카드의 단위, 미반영 복구와 receipt·ack 결속, sync 조건, D1 한도·비용, 확정 뒤 안내)를 **새 행을 늘리지 않고** 기존 D2·D6·D8·D9·D10·D13·D14·M1에 묶었다. 이것들은 재현된 제품 결함이 아니라 미구현 계약의 공백이었다.

고정 fixture: 합성 회차 1개, 좌석 A1(student-a)·A2(student-b)·A3(student-c) + 30석 확장, 강사 X(`distribute` 보유)·강사 A(`distribute`만, 학생 연결은 발급하지 않음)·강사 B(학생 연결 발급)·강사 Y(`observe`·`coach`·`collect`·`command`·`deliver`만)·다른 코호트 강사 Z, 자료 M(rev 1→2)·공지 N. 모든 시나리오는 **양성 대조(방해 없는 정상 경로가 반영됨으로 끝남)를 같은 환경에서 먼저** 통과시킨 뒤 방해를 주입한다(verification 규칙 2). 비선택 불변은 ‘없음을 센다’: A2의 sync 응답 `distribution.items` 0 · targets 행 0 · 보관함 디렉터리의 파일 목록·hash 전후 동일.

| # | 조건 / 깨뜨릴 가정 | 합격 기준 | 실행 계층 | 상태 |
|---|---|---|---|---|
| D1 | A1·A3 선택 + A2 비선택(세 좌석 모두 연결·보관함 선언). 공지 N 확정 | A1·A3 `reflected`, 기기 index에 N rev 1·hash 일치. A2: targets 0 · 제안 0 · 보관함 파일 변화 0 · 화면 카드 0. `모두 반영`은 두 대상 모두 반영 뒤에만 | Service(SQLite) + App 순수/host + 브라우저 e2e | NOT RUN · 계획 |
| D2 | 권한과 그 철회: 강사 Y(다른 capability 전부 보유), 강사 Z, 학생 토큰·ops 자격으로 `contents`/`distributions` 호출 · `ops_distribute` OFF · `HPS_CLASSROOM_OPS` OFF · **배포 강사 A ≠ 학생 연결을 발급한 강사 B**에서 ① A의 배포가 대기 중일 때 A 폐기 ② A의 요청이 KV 검증을 통과한 뒤·커밋 전에 A 폐기(주입 지점 = guard 직전) ③ A를 `revoke_jti`로 재범위화(새 scope에 `distribute` 없음/있음) ④ `session/close`의 `jti` ⑤ 폐기의 D1 batch 실패 주입 ⑥ un-revoke | Y `403 ops_capability_missing`(자동 승격 0), Z 범위 거부, 학생/ops 자격 401·403, flag OFF `403 ops_distribute_disabled`, 전역 OFF 404 — 모두 새 테이블 행 수 불변. ① B가 발급한 연결이 살아 있어도 A의 열린 배포는 sweep으로 `revoked`, 다음 sync의 items 0(KV 상태와 무관 — 시험은 KV 폐기를 **반영하지 않은 채** D1만으로 판정) ② `403 issuer_revoked`·0건 ③ 옛 토큰은 fence 뒤 배포 불가, `distribute` 없는 재범위화만 sweep, D1 실패면 새 토큰 미반환·아무것도 안 바뀜 ④ 종료는 성립, fence 결과가 응답에 표시 ⑤ 응답 `ok:false` — 폐기 완료로 세지 않음, 그동안 접수·전달이 계속될 수 있음을 그대로 관측, 재시도 뒤 막힘(멱등) ⑥ sweep된 배포가 되살아나지 않음. sweep 전에 이미 나간 응답을 기기가 저장한 경우: receipt에 `recorded:false, revoked` + tombstone, 다음 sync에 카드 내려감 — ‘즉시 회수’를 주장하지 않음 | Service(경합·fault 주입) + App host + 브라우저 e2e | NOT RUN · 계획 |
| D3 | 구버전: `distribution_inbox`를 선언하지 않은 App(현재 v0.1.56 계열 동작) · `status.distribution`을 모르는 구 Chalk · 새 App ↔ 구 Service | 구 App 좌석: 미리 확인에 `지원하지 않음`, 확정 뒤 자격 있는 sync에서 `unsupported`, 그 App의 sync·명령·채팅 회귀 0. 구 Service: 새 App이 블록 없이 정상 동작. 구 Chalk: flag를 켤 수 없음 | Service + App 계약 시험 | NOT RUN · 계획 |
| D4 | 오프라인 A3 선택 → 확정 → 회차 안에 재접속 / 회차가 끝난 뒤 재접속 | 확정 직후 `accepted`(`다시 연결되면 전달`) — `not_connected`로 끝내지 않음. 회차 안 재접속: 같은 의도가 그때의 자격 검사 뒤 전달 → `reflected`. 종료 뒤 재접속: 제안 0, `expired`, 보관함 변화 0 | Service + 실제 host(브라우저 e2e의 ClassroomOpsHost) | NOT RUN · 계획 |
| D5 | 좌석 교체: A1(a) 선택·확정 뒤 반영 전에 A1을 student-d로 교체(정상 configure·pair) · 같은 학생의 좌석 이동 · **읽기–쓰기 사이** 교체·회차 종료·flag 끔·자료 회수(주입 지점 = guard 직전) | d에게 제안·보관함 0, a의 대상 `target_changed`. 이동한 학생에게 자동 이관 0. 커밋 경계 4종: `409`/`403`, 배포·대상·감사 0건, 새 학생 target 0(U1의 7종 경합 시험과 같은 구조) | Service(경합 주입) | NOT RUN · 계획 |
| D6 | 연결이 바뀌는 네 경우를 구분: ① 같은 기기의 새 boot ② 같은 기기의 다른 창이 lease owner가 됨(두 창이 같은 보관함에 동시에 씀) ③ 학습 토큰 재발급(epoch+1) 뒤 옛 `offer_key`의 receipt·**옛 ack** ④ 같은 학생이 새 1회용 코드로 다른 기기 연결, 옛 기기의 늦은 receipt | ①② `offer_key` 불변 — 저널이 이어서 보고되고 잠금으로 index 역전·이중 쓰기 0 ③ 옛 key receipt `stale_offer`·상태 불변 → 현재 epoch로 재전달 → 가진 항목은 다시 쓰지 않고 새 key로 `reflected`. 옛 ack가 새 key의 저널 항목을 지우지 못함 ④ 대상이 `device_generation`+1·`accepted`·`card_state none`으로 되돌아가 새 기기에 반영, 감사 `target_rebound_device`, 옛 기기 receipt 전부 `stale_offer`, 옛 기기는 최종 거부 뒤 그 보관함을 숨김. 옛 연결의 제안이 새 grant로 복사된 흔적 0 | Service + App host | NOT RUN · 계획 |
| D7 | 중복 요청: 더블클릭(경합) · 응답 유실 뒤 같은 key 재전송 · 같은 key + 다른 본문 revision/다른 대상/다른 만료 · `contents`의 같은 key 다른 내용 · 같은 revision을 이미 반영한 좌석에 재배포 | 배포 1건 또는 `409 idempotency_conflict`. 재배포 대상은 `no_change`·제안 0·카드 1장 그대로. 빈 대상·중복·회차 밖 좌석·모르는 필드(`all`,`seats`)는 거부이며 DB 불변 — 전체로 넓어진 경우 0 | Service | NOT RUN · 계획 |
| D8 | 순서와 단위: M rev 2 반영 뒤 rev 1이 늦게 도착(응답을 네트워크 층에서 붙잡아 역순) · rev 1 진행 중 rev 2 확정 · 같은 revision 다른 hash · **D1(v1) 반영 → D2(같은 v1) → D1 회수** · **D1(v1) 반영 → D2(v2) 반영 → D1의 늦은 회수** · 회수 tombstone과 새 배포 제안이 두 순서로 교차 도착 · retire 뒤 늦은 제안 · 두 강사의 같은 자료 동시 배포/회수 | 카드는 자료당 한 장, `seq`가 작은 사건은 어느 순서로 와도 적용되지 않음(되돌아감 0·중복 0). D2가 받치는 카드는 D1 회수로 내려가지 않음(D1 `covered`, tombstone 0), D2까지 회수돼야 내려감. `no_change`는 같은 기기·미회수일 때만. 교차 도착의 두 순서가 같은 끝 상태. retire 뒤 저장된 늦은 항목은 다음 sync에 내려가고 그 사이를 ‘막았다’고 쓰지 않음. 동시 회수는 한쪽 `409`. 과거 실행의 `reflected` 증거는 회수 뒤에도 남고 `card_state`만 바뀜 | App 순수 reducer + host + Service | NOT RUN · 계획 |
| D9 | 기기 커밋 경계 — **v1이 이미 보관함에 있는 상태에서 v2 적용 중** 중단을 경계마다 주입: rev 파일 tmp / rev rename 뒤 / index tmp / index rename 거부 / index rename 뒤 저널 전 / 저널 뒤 ack 전 · v2 뒤 늦은 v1 writer · 회수 뒤 늦은 writer · 용량 초과 · 재시작 전에 받아 두기만 한 미반영 파일 + 그사이 회차 종료/회수 · `apply_within_ms` 초과 · 기기 시계를 앞뒤로 변경 · 끝난 연결 세대의 늦은 sync 응답·webview callback | 모든 경계에서 **v1 카드가 계속 열림**(index는 전부 아니면 전무, 가리키는 파일은 지워지지 않음), 역전 0, 저널에 `reflected`가 생기는 것은 index commit + 재검증 뒤뿐(거짓 reflected 0). 재시작 reconciler는 참조되지 않는 파일을 **승격하지 않고 지움** — 회차 종료·회수 뒤 새 카드 0, 다시 실려야만 적용. 시계 변경은 판정에 영향 0. 저장 실패는 `failed`·채팅 정상. 늦은 응답의 items·withdraw·acks는 적용 0, callback은 빈 상태 | App host(fault 주입, Mac) + Service. **Windows rename·파일 점유·한글 경로는 NOT RUN** | NOT RUN · 계획 |
| D10 | 부분 실패와 확정 뒤 안내: 5석 중 반영 2·실패 1·미확인 1·전달 전 1 → ‘실패·미확인만 다시 선택’ → 그사이 1명이 늦게 반영됨 · 확정 뒤에도 확인 단계의 안내(`확인만 했습니다. 아래에서 요청해야…`)가 남는지 — **배포와 U1 선택 회수 양쪽** | 버튼은 요청을 보내지 않음. 누르는 순간 다시 읽어 선택 = 실패 1명만(늦게 반영된 미확인 제외), 반영된 2명 재실행 0. 미확인 줄에 근거와 ‘다시 보내도 중복 카드 없음’ 문구. 확정이 접수되면 안내가 확정 뒤의 말로 바뀌고, 결과가 최종 상태(`모두 반영`/`서버 검증됨 · 결과 확정`)를 말하는 화면에 그와 모순되는 과거 안내 0 | 브라우저 e2e + Service + 실제 Mac | NOT RUN · 계획 |
| D11 | 콘텐츠 접근: 연결하지 않은 학생 · 비선택 좌석의 ops 자격 · 교체된 학생의 옛 자격 · 다른 회차 자격으로 내용을 얻으려는 모든 경로(`sync`, 강사 `contents` GET, 추측한 URL) | 학생용 콘텐츠 API 부재(404), 강사 GET은 `distribute` 없이는 403, 비선택·교체·타 회차 자격의 sync 응답에 items 0. 본문이 보드 `/status`·감사·대상 원장 응답에 나타나지 않음 | Service negative | NOT RUN · 계획 |
| D12 | 내용 안전: `<script>`·`<img onerror>`·마크다운 링크·`javascript:`/`http:`/IP/userinfo/허용 목록 밖 host·셸 명령·`file://` 경로·제어문자·2,001자 | 허용 밖은 `400`. 통과한 문자열은 기기·Chalk에서 **글자 그대로** 보이고 DOM에 새 element·요청 0. 자동 URL 열기·다운로드·AI 호출·입력창 삽입 0. 링크는 학생 클릭 뒤에만 https 재검사 후 열림. 결과 어휘에 ‘다운로드/파일 전달 완료’ 없음 | Service + webview 렌더 시험 + 브라우저 e2e | NOT RUN · 계획 |
| D13 | 회수·종료: 반영 전 실행 회수 · 반영 뒤 실행 회수(다른 유효 배포 없음) · 회수 중 기기 부재 → grant 폐기/만료 · `ops_distribute`를 끈 상태에서의 회수 전달 · 종료된 회차의 새 콘텐츠/배포 vs 종료 뒤 회수·늦은 receipt · 종료 뒤 학생의 재열람 · 새 회차 연결 · 좌석 이동 | 반영 전 `revoked`·제안 중단. 반영 뒤 `withdraw_pending`→`withdrawn`, 카드가 ‘강사가 회수한 자료입니다’로 바뀌고 학생 초안·대화·workspace 파일 hash 전후 동일. 연결이 끝난 기기는 **`withdraw_unconfirmed` — 원격 삭제 완료로 세지 않음**. flag OFF에서도 tombstone·receipt ack는 오가고 새 items는 0. 종료 뒤 새 요청 `409 run_ended`, 회수와 늦은 receipt는 grant가 살아 있는 동안 처리, 기존 카드는 로컬에서 열림. 새 회차·새 좌석 화면에 이전 카드 0(`detached`) | Service + App host + 브라우저 e2e | NOT RUN · 계획 |
| D14 | 한도·D1 모양·장애 격리: 자료 51개·revision 21개·분당 21회 · 응답 3번째 item·11번째 tombstone·7번째 receipt · 제안 무응답이 만료까지 지속 · 저널 200건 · 배포 교환 예외 주입 · 배포 행 조회 예외(손상) · **30/100/200석 확정과 sync를 로컬 workerd D1에서 `meta.rows_read/rows_written`·호출당 문장 수로 계측**(준비·동시 배포·정상 idle·중복 receipt·전 좌석 동시 재접속) | 한도는 `429`/`more:true`, 재시도는 요구 문서 상한 안에서 멈춤, 부분·미확인을 성공으로 센 집계 0. 교환 예외: 블록만 빠지고 관측·명령·채팅 정상(없음≠성공). 손상 행: 재생·조회·전달 `503`. 계측 허용 한도(요구 문서): idle sync 증가분 쓰기 0·읽기 ≤ 1·문장 +0, 확정 ≤ 12쿼리·문장당 bound ≤ 30·**200석도 batch 1개**(여러 transaction으로 쪼개지 않음), 대상 1명 정상 전달 쓰기 ≤ 20행, sync 1회 ≤ 45문장, 모델 대비 +25% 이내. 기존 채팅 p95 증가 ≤ 5%(AT-25 기준) | Service fault + 로컬 workerd D1 계측. **운영 D1의 쿼터·latency·30초 한도·계정 plan은 NOT RUN/미확인** | NOT RUN · 계획 |
| D15 | 기존 수업 회귀: flag 전부 OFF · `ops_distribute`만 OFF인 기존 ops 회차(U1 선택 회수, 복구·코칭 명령, 일시정지, ‘수업 마무리’) · migration 0023 전/후 fresh vs 누적 | 기존 worker·review·Chalk·확장 suite와 기존 브라우저 e2e 전부, U1 독립 재현(공통 git-dir 증거 폴더의 검사 스크립트) 그대로 PASS. schema 동등·기존 테이블 불변·재적용 멱등(D1 리허설). `send_question` 동작 불변 | regression + 로컬 workerd/D1 | NOT RUN · 계획 |
| D16 | 접근성·표시: 학생 카드와 Chalk 작성/결과 화면 — 색 없이 읽기(흑백), 키보드만, 200% 확대, 390px, 긴 한글·긴 URL | 상태·‘새 자료’가 글자로 구분됨, 모든 조작에 포커스·접근 이름, 가로 넘침 0, 작업 화면 Primary 1개 유지(SX-04)·모달 0·자동 펼침 0 | 브라우저 e2e + 실제 Mac | NOT RUN · 계획 |
| **M1 실제 Mac** | 실제 Studio 창(A1, 공식 shell 복사본 + 현재 확장·SDK) + **실제 Chalk `/manage`(보이는 브라우저 창)**: 강사가 자료 작성 → A1만 선택 → 미리 확인 → 보내기 → 학생 창의 작업 화면 카드 → 학생이 닫았다가 다시 열기 → **앱 완전 종료 뒤 재시작** → ‘이어서 하기’ 진입 화면과 작업 화면 양쪽에서 같은 카드 → rev 2 배포 → 카드 1장이 rev 2로 → 같은 rev 2를 한 번 더 배포(`no_change`) → 첫 실행 회수(카드 유지) → 둘째 실행 회수(카드 내려감) | 보드: A1 `보관함 반영`(그 앞 단계 시각 포함), 합성 A2·A3(연결+선언 상태)은 targets 0·보관함 0. 학생 workspace 파일·대화 hash 전후 동일. 재시작 뒤에도 카드 유지·중복 0. 확정 뒤 강사 화면에 확인 단계 안내가 남지 않음. 증거: source SHA·shell/SDK 버전·`result.json`·화면(강사/학생 각 단계)·보관함 index hash | 실제 Mac GUI | NOT RUN · 계획 |

**증거 층의 구분(실행 기록을 쓸 때 그대로 지킬 것).** ‘Service(SQLite)’ = Node SQLite + in-memory 대역, ‘로컬 workerd/D1’ = wrangler의 로컬 D1(조건부 batch의 트랜잭션 의미·migration 적용·`rows_read/rows_written` 계측은 여기까지만 증명되며 **운영 D1 실측이라고 부르지 않는다**), ‘실제 Mac’ = 실제 창 1대 + 합성 좌석. **실행 전까지 NOT RUN으로 남는 환경:** Windows(경로 구분자·한글 사용자 폴더·보안 프로그램의 `globalStorage` 쓰기), 학교망(TLS 재서명·프록시에서 24 KiB 응답), Cloudflare staging/production D1(0023 적용, 실제 D1의 guard 동작·호출당 쿼리 한도·30초 batch 한도·쿼터, 계정 plan은 미확인), 실제 기기 2대 이상의 동시 수신, 실제 모델·실제 메일(이 흐름은 둘 다 쓰지 않지만 전체 목표의 미실행으로 남는다). 운영 활성화·owner 승인(INT-CO-04)은 시험 결과가 아니라 사람의 결정이다.

<a id="remote-management-u2-run-20260921"></a>

### U2 — 공지·자료 대상 배포: 실행 기록 · 2026-09-21

[계약](../requirements/classroom-admin.md#remote-management-u2-20260921) · 위 [인수 계획](#remote-management-u2-plan-20260921)의 D1~D16·M1을 구현과 함께 실행했다. 계획 표의 상태 칸은 고치지 않았다 — 실행된 것은 이 절에만 있다. 모든 계정·수업·모델 응답은 합성이고, `ops_distribute`는 시험 회차에서만 켰다. 운영·staging에는 아무것도 적용하지 않았다.

| 층 | 무엇을 | 결과 |
|---|---|---|
| Service (SQLite, 합성 5석 + 200석) `worker/test/classroom-ops-distribution.test.mjs` | 대조군 2(내용·링크·선택 정규화 / 전이 표·`card` 표·기한·재시도 간격·키) · **D2 권한**(다른 capability 전부 가진 강사 Y·다른 코호트·학생 토큰·ops 자격 거부, `/status.distribution`, 좌석별 보관함 선언) · contents(불변 revision·멱등·비밀 마스킹 뒤 hash·두 저자 경합·종류 변경 거부·빈 허용 목록의 링크 거부) · **D1** A1·A3 선택/A2 비선택(A2는 행 0·블록 0) · **D3/D4** 구 앱 `unsupported`, 오프라인 `accepted_offline` → 재연결 뒤 같은 의도 전달 · **D7** 더블클릭·응답 유실·같은 key 다른 요청 3종·거부 6종·같은 판 재배포 `no_change` · **D8** v2 뒤 늦은 v1(`superseded`, 늦은 receipt `final`)·v1로 되돌리기 거부·**같은 v2 두 실행을 순서대로 회수(첫 회수 `covered`, 마지막 회수에서 내려감, 남아 있는 v1 실행이 v1을 되살리지 않음)**·제안 키/회수 키 교차 ack 거부·중복 ack·**대기 중 배포가 받치다 만료되면 coverage 재정산** · **D13** retire·연결이 끝난 기기는 `withdraw_unconfirmed` · **D2 철회**(A 배포/B 연결: KV를 지연시킨 채 D1 fence만으로 대기 중 배포 `revoked`·B의 연결은 그대로·검증 통과 뒤 요청 `403 issuer_revoked`·D1 실패 주입 시 `ok:false`이고 그동안 접수됨을 그대로 관측·재시도 멱등·이미 나간 응답은 receipt 거부 + tombstone·un-revoke는 sweep을 되살리지 않음·재범위화 `distribute` 유/무·fence 실패 시 새 토큰 미반환) · **D5** 커밋 경계 5종(flag·종료·retire·좌석 주인 변경·정상 API로 명단 교체) 0건 기록 · **D6** 재발급 뒤 옛 키 `stale_offer`·기기 교체 되돌림 · sync 조건 표(flag OFF에서 새 제안 0·receipt 기록·회수 전달, 종료 뒤 `expired`/`unconfirmed`·늦은 `reflected` 수용) · **D14** 응답 2개·`more`·receipt 6개·교환 예외 격리·조회 장애 503·분당/판 한도 · 30/100/200석 확정의 문장 수 동일 · **D15** flag 없는 회차의 sync 응답 key 불변·오타 flag 400·ops OFF 404 | 16 PASS |
| 실제 기기 클라이언트 ↔ Service `worker/test/classroom-ops-distribution-device.test.mjs` | 확장의 실제 sync 루프 + `InboxSession` + 실제 디렉터리의 `InboxStore`: 선택/비선택(비선택 기기는 블록 0·디렉터리 0, `ops_commands` OFF에서도 좌석 lease 확보) · 응답 2회 유실 뒤 1회 적용 · 재시작 뒤 카드 유지 · 같은 판 재배포 `no_change` · 순서대로 회수(기기가 `withdrawn` 확인, v1 미복원) | 4 PASS |
| 기기 보관함 (실제 디렉터리, macOS/APFS) `extensions/hypeproof-chat/test/classroom-inbox.smoke.mjs` | 대조군 3(Service와 hash·한도 일치 / 순번 규칙 표 / ack는 자기 키·단계만) · 정상 v1→v2→재시작 · **D9 v1 보유 중 v2 적용의 네 경계에서 중단**(rev tmp / rev link 뒤 / index tmp / index link 뒤) + index link 거부(EPERM) + rev 쓰기 거부(ENOSPC): 모든 경우 v1 카드 유지·거짓 `reflected` 0·재시작 reconciler는 고아 파일을 승격하지 않고 삭제 · **D8** 늦은 v1·회수 뒤 늦은 제안·회수/재배포 교차 두 순서 동일 결과·보유한 적 없는 자료의 회수 · **정지된 writer와 두 창**(index tmp 직후 멈춘 writer가 깨어나도 v3 위에 v2를 못 씀, 8개 동시 writer 유실 0) · **실제 프로세스** SIGKILL(커밋 중) / SIGSTOP→경쟁 commit→SIGCONT · **적용 기한**(요청 시각 기준 29초 허용 / 31초·잠자기·시계 앞뒤·500ms 예산 초과는 무보고 폐기 / 재시작 뒤 고아 미승격 / 연결 종료 뒤 적용 0) · hash 불일치·모르는 kind·같은 판 다른 내용·손상 파일·디렉터리 밖 쓰기 0 | 10 PASS (3회 반복) |
| **로컬 workerd D1** (miniflare — 운영 D1 아님) `worker/test/classroom-ops-distribution-d1.test.mjs` | 0011→0023 두 번 적용, 기존 객체 SQL 불변, 새 테이블·부분 인덱스 존재 · D1의 `meta.rows_read/rows_written`과 문장·bind 수 계측(meta 없는 문장은 0이 아니라 `unmetered`로 세어 실패시킴) | PASS — 아래 실측 표. 이 PR에서 `test:classroom-ops:d1`을 PR CI(`worker / test`)에 편입했다(기존에는 로컬 전용이었다) |
| 실제 브라우저(Chromium) + 실제 Chalk + Service + **좌석별 실제 기기 클라이언트** `e2e/classroom/ops-distribution.mjs` | 권한 없는 강사에게 기능 미표시 · **D1** 작성→A1·A3 선택→미리 확인→확정→두 기기 반영, A2 무접촉, **확정 뒤 ‘확인만 했습니다’ 안내가 사라지고 최종 결과 옆에 되돌아오지 않음** · 늦은 미리 확인 응답(네트워크 층에서 붙잡음)·확인 뒤 본문 수정·숨은 버튼 강제 클릭 → 전송 0 · **D3/D4/D9/D10** 구 앱·오프라인·디스크 거부(v1 유지)·‘실패·미확인만 다시 선택’(요청 0, 실패한 2석만) → 복구 뒤 v2 한 장 · **D8/D13** 같은 판 재배포 = 카드 1장, 첫 회수 `covered`, ‘보낸 자료’에서 이전 실행을 찾아(재전송 0) 회수 → 카드 내려감·v1 미복원·전달 증거와 현재 보관함이 나란히 표시 · retire · 종료된 수업 · **D12/D16 실제 학생 컴포넌트**(`InstructorInbox.tsx`를 번들해 Chromium에 mount): 악성 문자열이 글자 그대로, 생성된 `img/script/a` 0, 네트워크 요청 0, 링크는 버튼을 눌렀을 때만 host로 메시지, 기본 닫힘, 키보드 조작, 390px·200%에서 가로 넘침 0, Primary 0 | 7 PASS (5회 반복). CI `classroom / browser`에 추가 |
| U1 후속 `e2e/classroom/ops-selection.mjs` | 선택 회수 확정 뒤 확인 단계 안내가 남지 않음(실제 Mac에서 관측된 문구) | 8 PASS |
| 회귀 (로컬, Node 22.22.1) | worker `npm test` 전체 · `test:classroom-ops:d1`(로컬 workerd) · typecheck / Chalk `npm test` · typecheck / 확장 `npm test`(hook-order 포함) · typecheck / `mac-devhost.test.mjs` / 브라우저 e2e `classroom`·`classroom-ops`·`-roster`(7)·`-selection`(8)·`-distribution`(7) | 전부 exit 0. 기존 시험에서 바꾼 기대값은 하나: ‘모든 회차 flag 기본 OFF’ 단언에 `ops_distribute:false` 추가 |
| **실제 Mac M1** `e2e/classroom/mac-distribution.mjs` | 아래 | PASS |

**로컬 workerd D1 실측 (운영 D1 아님 · 계정 plan 미확인).**

| 경로 | 문장(batch) | 최대 bind | rows_read | rows_written |
|---|---:|---:|---:|---:|
| 배포 확정 30석 (인증 읽기·조건부 batch·정산·결과 view 포함) | 20 (2) | 25 | 1,044 | 129 |
| 배포 확정 100석 | 20 (2) | 25 | 2,235 | 409 |
| 배포 확정 200석 | 20 (2) | 25 | 4,246 | 809 |
| sync · flag OFF · idle | 4 | 3 | 5 | 0 |
| sync · flag ON · 대기 없음 | 5 | 3 | 6 | 0 |
| sync · 제안 2건 | 16 (2) | 19 | 61 | 2 |
| sync · `received`+`reflected` | 21 (4) | 18 | 69 | 10 |

아래 두 sync 행은 [재인수 수정](#remote-management-u2-reaccept-20260921) 뒤의 값이다(수정 전 `51708c7`: 제안 2건 bind 9·읽기 49, receipt bind 11·읽기 54). 문장·batch·쓰기 수는 그대로이고, 기록하는 문장이 전제조건을 스스로 검사하게 되면서 **bind와 읽은 행만** 늘었다(제안 1건당 읽기 약 +6행, receipt 1건당 약 +7행 — PK·UNIQUE 조회). idle과 확정 경로는 바뀌지 않았다(100석 확정 읽기는 실행마다 2,232~2,235로 3행 흔들린다).

게이트: 좌석 수와 무관한 문장 수(200석도 조건부 batch 1개), 문장당 bind ≤ 30, idle 증가분 쓰기 0·문장 ≤ +1·읽기 ≤ +2, sync 1회 ≤ 45문장, 대상 1명 전달 쓰기 ≤ 20행 — 모두 충족. 확정 쓰기는 요구 문서의 모델(125/405/805행)과 +3% 이내다. 확정 읽기(좌석당 약 20행)는 모델에 없던 항목으로, 확정 직후의 결과 view·정산이 대부분이다. 운영 D1의 latency·쿼터·30초 한도는 NOT RUN.

**실제 Mac M1 (source `2f4eab8`, 공식 shell 0.1.56 복사본, Agent SDK 0.3.207 + 실제 binary, 전용 devhost·user-data·HOME·포트 18771/18772).** 강사 쪽은 전부 **보이는 Chromium 창의 실제 Chalk `/manage`에서 조작**했고(API 직접 호출 없음), 학생 쪽은 실제 Studio 창을 디버깅 포트로 읽었다.

1. 실제 창 A1: 수업 진입 → 1회용 코드로 연결 → 실제 1턴(모델 응답만 합성) → 입력창에 초안 남김.
2. Chalk: 공지 작성·저장(전송 0 확인) → **A1만 선택** → 미리 확인(‘선택하지 않은 2명에게는 아무것도 가지 않습니다’) → 보내기 → `대상 1명 · 보관함 반영 1 · 모두 반영`, ‘결과 확정 · 읽음·이해를 뜻하지 않습니다’.
3. 실제 창: 작업 화면 rail에 `강사가 보낸 공지·자료 1개 · 새 자료 1개`가 **닫힌 채** 나타남(모달 0) → 펼치면 본문이 `<b>…</b>`까지 글자 그대로 → 닫았다가 **다시 열기** → ‘새 자료’ 표시 사라짐 → 명령 팔레트로 시작 화면을 열어 **진입 카드에도 같은 목록**(Primary 1개 이하).
4. **앱 완전 종료(SIGTERM, exit 0) → 재시작**: 진입 화면과 작업 화면 양쪽에 같은 카드 1장(`끝난 수업의 자료` — 이 harness는 Keychain 대화상자를 피하려고 secret을 메모리에만 두므로 종료와 함께 운영 자격이 사라진다. 카드는 **연결 없이 디스크에서** 읽힌 것이다) → 새 1회용 코드로 다시 연결.
5. Chalk: 본문 수정·저장(2번째 판) → A1에 보내기 → 실제 창의 카드 1장이 2번째 판(`수정됨`)으로 → **같은 2번째 판을 한 번 더** 보내기(미리 확인에 ‘이미 같은 판이 있음’) → `no_change`, 카드 1장 그대로.
6. Chalk: 방금 실행 회수 → ‘같은 판의 다른 배포가 보관함을 유지’, 실제 창 카드 유지 → ‘보낸 자료’에서 남은 2번째 판 실행을 찾아 회수 → 실제 창 카드가 ‘강사가 회수한 자료입니다’로(제목·본문 0, **1번째 판 미복원**) → Chalk에 `보관함: 기기 보관함에서 회수됨`.
7. 학생 workspace 두 파일 sha256 전후 동일, 대화 유지(재시작 뒤 포함), 입력 초안 유지(재시작 뒤 화면에서도 확인). 합성 A2·A3(연결 + 보관함 선언, 실제 기기 클라이언트 구동): targets 행 0 · 받은 distribution 블록 0 · 보관함 디렉터리 없음. 모델 호출은 합성 1회, 실제 모델·메일 0.

증거: devhost `distribution/result.json`, 화면 11장(강사 5 · 학생 6), `manifest.json`(bundle hash 4개가 현재 빌드와 일치). 1→4에서 재연결로 1번째 판 대상이 `device_generation 1`로 되돌려져 다시 `reflected`된 것도 result.json에 있다.

**관측하지 않은 것 (NOT RUN).** Windows(link/rename·보안 프로그램의 파일 점유·한글 사용자 폴더), 학교망, Cloudflare staging/production D1(0023 적용·실제 guard·쿼터·30초 한도·plan), 실제 기기 2대 이상, 실제 모델·실제 메일, Keychain에 자격이 남는 설치본에서의 ‘재시작 뒤 연결 유지’(M1은 재연결로 대체), 전원 차단 수준의 내구성(fsync는 요청만 함), 100석 실부하에서의 채팅 p95(AT-25 기준 — 합성 부하 미실행), Safari/Firefox. D16의 200%·390px는 브라우저에 mount한 학생 컴포넌트와 Chalk 페이지에서만 봤고 실제 Studio 창의 확대는 보지 않았다. INT-CO-04 owner 승인과 운영 활성화는 시험 결과가 아니다.

**구현하며 바뀐 계약**은 [요구 문서의 표](../requirements/classroom-admin.md#remote-management-u2-20260921)에 있다(현재 판 기준 coverage, 회수 전용 키, link() CAS, 요청 시각 기준 적용 기한, probe 분리).

<a id="remote-management-u2-reaccept-20260921"></a>

### U2 — 재인수 수정 기록 · 2026-09-21 (독립 검토가 `51708c7`에서 재현한 P1 1건 + receipt 결속 1건 + 화면 P2)

Draft PR #1223(`51708c7`, CI 23/23)은 인수되지 않았다. 독립 검토의 재현 스크립트 4개(`management-20260921/u2-*.mjs` — 검토자 소유, 이 PR에 넣지 않음)를 같은 worktree에서 수정 전·후로 실행했다. 층은 전부 **로컬 HTTP + SQLite + 실제 `InboxSession/InboxStore`(임시 디스크)** 다.

| 재현 | `51708c7` (수정 전) | 수정 뒤 (`9d85718`) |
|---|---|---|
| `u2-deferred-boundary-check` — 후보 SELECT 뒤·원장 UPDATE 전에 ①정상 회수 API ②flag OFF ③좌석 교체 ④옛 epoch receipt | ①②③ **FAIL**: 응답에 item 1건, 원장은 `revoked/accepted · offers 0` · ④ PASS | 4/4 PASS — 응답 item 0건, 원장 `offers 0 · offer_key ''` 그대로 · ④ 유지 |
| `u2-revoke-inbox-impact` — 실제 기기 클라이언트·디스크 | **음성 FAIL**: 기록되지 않은 제안의 본문이 끝까지 보임(`final_visible 1`) · 양성(기록된 뒤 회수) PASS | 2/2 PASS — 음성 `initially_visible 0 → 0`, 양성 `1 → 0`(tombstone으로 내려감) |
| `u2-receipt-binding-boundary-check` — receipt 행을 읽은 뒤·기록 전에 ①재로그인(epoch+1) ②좌석 교체 (수정 중 추가된 스크립트) | `4aaab9e`에서 ①② **FAIL**: `reflected`·카드·감사 행이 바뀐 신원 아래 기록됨 | 3/3 PASS — `changed · final=false`, 상태·카드·감사 0. 양성 대조군은 정상 기록 |
| `u2-index-corruption-check` | PASS | PASS(변경 없음) |

**원인.** `distributionExchange`는 후보를 읽고(`SELECT … next_offer_at`) 원장에 기록한 뒤 응답을 만들었는데, 응답은 **읽은 후보 목록**에서 만들어졌고 기록 UPDATE의 조건은 행의 상태·키뿐이었다. 그 사이에 끼어든 회수·flag·명단 변경은 UPDATE를 0행으로 만들었지만(또는 조건에 없어 통과했지만) batch는 성공했고 item은 그대로 실렸다. receipt도 같은 모양이었다(행 CAS는 있었으나 **누구의 sync인지**는 기록 시점에 다시 묶지 않았다). **수정:** 기록하는 문장이 전제조건 전체를 스스로 검사하고, 응답·카드·감사 행은 **그 문장이 실제로 바꾼 행**에서만 만든다(‘한 번 더 읽기’ 아님). 계약은 [요구 문서의 표](../requirements/classroom-admin.md#remote-management-u2-20260921) 끝 8행.

**제품 회귀로 편입한 것.** 각 경합은 실제 SELECT 하나의 결과를 붙잡아 두고 그 사이에 **실제 요청**을 실행하는 hook으로 만들며, hook이 발화하지 않으면 시험이 실패한다(주입 지점이 SQL과 어긋난 채 통과하는 것을 막음).

| 층 | 추가 | 결과 |
|---|---|---|
| Service `classroom-ops-distribution.test.mjs` D5 ‘OFFER commit boundary’ | 양성 대조군(간섭 없음 → 응답과 원장 일치) · 제안 기록 전 간섭 6종(배포 회수·자료 회수·flag OFF(API)·수업 종료·재로그인·lease 이전) + 좌석 교체(API): 응답 0건·원장 `offers 0`, 조건이 돌아오면 같은 의도 재제안 · **기록된 뒤 회수 → receipt는 `revoked·final` + tombstone 즉시** · receipt CAS 패배: `changed·final=false`, 카드·감사 0, 재전송은 지금의 행 기준 · `no_change` 판정 순간 카드가 사라지면 ‘이미 보유’라 하지 않고 다음 sync에 실제 전송 · receipt 신원 결속(재로그인 → `changed` → 재전송 `stale_offer·final` → 새 키로 재제안·정상 기록 / 좌석 교체) · 회수 확인 receipt의 신원 결속 · `card` 대조군 5행(전달 중 회수된 카드 표시) | 17 PASS. 새 검사는 수정 전 store에서 **실패함을 확인**(offer 경계: ‘must not be in the answer’, receipt: ‘not recorded, not final’) |
| 실제 기기 루프 ↔ Service `classroom-ops-distribution-device.test.mjs` | 같은 회수 경합을 실제 sync 루프로: 응답에 item 0, **디스크 어디에도 본문 없음**, 강사 view `revoked · none` / 양성: 1 tick으로 저장됨을 확인 → 회수 → 카드 `withdrawn`, **본문 파일 사라짐**, 저널 0, view `revoked · withdrawn` | 5 PASS |
| 확장 `classroom-inbox.smoke.mjs` | `inboxPresence` 대조군 6행(연결·미연결·정상 만료·종료 시각 경과·종료 시각 모름) · 미연결 view에서도 보유 자료 읽힘 · 확정 종료는 ‘미확인’으로 같이 표시되지 않음 | 10 PASS |
| 브라우저 `e2e/classroom/ops-distribution.mjs` | 1280×720 첫 화면: 선택 → 조치 → **첫 학생 행 < 720px**, 작성기·이력 닫힘, 결과·이력은 목록 뒤, 공유 패널은 그 뒤 · 권한 없는 강사에게 작성기·보내기·결과 모두 미표시 · 선택 요약에 ‘전달되지 않습니다’ 없음 + 조치별 정책 줄(미연결 좌석이 있을 때만) · 저장줄 ‘저장만으로는 아무에게도 보내지지 않습니다’, 주 흐름에 ID·hash 없음(‘검증용 상세’에 전체) · 전송 접수 뒤 작성기 접힘·요약줄/저장줄이 ‘보낸 배포가 있음’ · 회수된 실행: 머리말 `회수한 배포`, ‘모두 반영’ 없음, ‘지금 기기’ 줄(다른 배포로 유지 1 / 회수 확인 2·남은 자료 없음) · 학생 컴포넌트: 미연결 ‘수업 연결 확인 전’ + 안내 1줄, 확정 종료 ‘끝난 수업의 자료’, 연결 중 둘 다 없음 | 7 PASS |
| 회귀 (로컬, Node 22.22.1) | worker `npm test` · `test:classroom-ops` · `test:classroom-ops:d1` · typecheck / Chalk `npm test` · typecheck / 확장 `npm test` · typecheck(host·webview) / 브라우저 e2e `classroom`·`classroom-ops`·`-roster`·`-selection`·`-distribution`·`classroom-report` | 전부 PASS |

**화면(P2)에서 계측기 쪽 오류였던 것.** e2e가 접힌 작성기를 열지 않고 입력하려다 실패(제품 아님 — 시험이 새 구조를 따르게 고침), 학생 컴포넌트 시험의 `window.root`가 `id="root"` 요소와 이름이 겹쳐 실패(시험 변수명 변경).

**실제 Mac M1 재실행 (source `9d85718` — 이 기록을 담은 문서 커밋만 그 위에 있다 · 공식 shell 0.1.56 복사본(`f5939d9`) · Agent SDK 0.3.207 + 실제 binary · 확장 bundle hash 4개가 현재 빌드와 일치 · 전용 devhost·user-data·HOME·포트 18771/18772/9371).** 앞선 U2 runner(그 프로세스의 명령·cwd·포트를 확인한 뒤)만 내리고 다시 띄웠다. `:18761/:18762` 데모와 설치본은 건드리지 않았다(전후 같은 PID가 그 포트를 듣고 있음을 확인). 수정 도중의 `4aaab9e` 실행도 PASS였고, 그 뒤 Service가 바뀌어 최종 소스로 한 번 더 돌렸다. 강사 쪽은 전부 보이는 Chromium의 실제 Chalk `/manage`에서 조작했다.

1. 강사 첫 화면(1280×720): 선택 묶음 477px → 조치 버튼 569px → **첫 학생 행 676px**, 작성기·이력 닫힘(수정 전 독립 검토 실측 1742px).
2. 작성기를 열어 공지 저장(전송 0) → A1만 선택 → 미리 확인 → 보내기 → 작성기가 접히고 요약줄 ‘이 판을 보낸 배포가 아래 조치 결과에 있음’, 저장줄에 ‘보내지 않았습니다’ 없음 → `대상 1명 · 보관함 반영 1 · 모두 반영`.
3. 실제 창: 닫힌 카드 → 열기 → 다시 열기, 진입 카드 동일, 대화·입력 초안·workspace 해시 불변.
4. **앱 완전 종료 → 재시작**: 양쪽 표시면에 같은 카드 1장, 요약은 **‘수업 연결 확인 전’**(‘끝난 수업’이라고 말하지 않음 — 회차는 열려 있다) → 새 코드로 다시 연결하면 그 문구가 사라짐. **같은 grant의 자동 재연결은 이 harness에서 NOT RUN**(secret을 메모리에만 둠).
5. 2번째 판 → 카드 1장이 2번째 판으로 → 같은 판 한 번 더 → `no_change`, 카드 1장.
6. 방금 실행 회수 → 머리말 `회수한 배포`, ‘모두 반영’ 없음, ‘지금 기기: … 다른 배포로 보관함에 남아 있음 1’, 실제 창 카드 유지 → 이력에서 남은 2번째 판 실행을 찾아 회수 → 실제 창 ‘강사가 회수한 자료입니다’, 강사 ‘기기 보관함에서 회수 확인 1 · 회수 확인 불가 0 — 이 배포로 기기에 남은 자료는 없습니다’, 1번째 판은 돌아오지 않음.
7. 합성 A2·A3: targets 행 0 · distribution 블록 0 · 보관함 디렉터리 없음. 모델 응답은 합성(실제 모델 호출 0), 메일 없음.

증거: devhost `distribution/result.json`·`run.log`·화면 13장(`00-instructor-first-screen-720` ~ `11-learner-work-screen-withdrawn`, `06b-learner-unconfirmed-connection` 포함), `manifest.json`, 독립 재현 4종 재실행 로그 `reacceptance/*-9d85718.log`(4종 모두 exit 0; 수정 도중의 `*-4aaab9e.log`에는 receipt 결속 FAIL 2건이 그대로 남아 있다). 이전 실행의 증거는 `distribution-2f4eab8/`·`distribution-4aaab9e/`로 보존했다. 실행기는 강사 페이지와 학생 앱을 연 채 떠 있다.

**여전히 NOT RUN (PASS로 바꾸지 않았다).** Keychain 자격을 유지한 **같은 grant의 자동 재연결**(이 harness는 secret을 메모리에만 둔다 — 재시작 뒤 새 코드로 다시 연결했다), Windows, 학교망, Cloudflare staging/production D1(0023 적용·실제 guard·쿼터·30초 한도·plan), 실제 기기 2대 이상과 실제 네트워크 지연에서의 경합(위 경합은 로컬 SQLite에서 hook으로 만든 것이다), 실제 모델·실제 메일, VoiceOver/NVDA, Safari/Firefox, owner의 INT-CO-04 승인과 운영 활성화. U2는 원격관리 전체의 완료가 아니다(U3·AT-40/41 미착수).

<a id="remote-management-u3-plan-20260921"></a>

### U3 — 수업 프롬프트·수업 설정 대상 배포: 인수 계획 · 2026-09-21 (전부 NOT RUN · 계획 · 설계 검토 중)

[계약](../requirements/classroom-admin.md#remote-management-u3-20260921). AT-45(프롬프트)·AT-46(설정)을 구현과 함께 검증할 시나리오다. **아래 어느 행도 실행되지 않았고 제품 코드·migration·시험 파일·화면이 없다.** 문서가 있다는 사실을 구현이나 실행으로 세지 않는다 — 실행되면 이 절 아래에 ‘실행 기록’을 따로 만들고 여기의 상태 칸은 고치지 않는다. U1(기록 회수)·U2(공지·자료 보관함 반영)의 PASS는 이 표의 어느 행의 증거도 아니다.

**보완(같은 날).** 첫 설계(`75f1f37`)를 독립 검토가 읽고 짚은 네 결함 — 진행 중 turn을 헤더·경과 시간으로 증명할 수 없음 · 전역 OFF/읽기 장애 때 토큰 강의로 넓어짐 · gate 통과를 실행 증거로 셈 · 섞인 기준의 표시를 보고서 경로가 읽지 않음 — 에 맞춰 S1·S2·S4·S9~S13·S15~S17과 M2를 고치고 **S2b·S2c·S2d·S18·S19**를 더했다. 각 행은 첫 설계의 동작을 시험 전용 스위치로 되살린 **음성 대조군**을 갖는다: 그 스위치에서 단언이 실패하지 않으면 계측기가 그 결함을 보지 못하는 것이다.

고정 fixture(U2 것에 추가): 강사 L(`distribute`+`lesson_settings`)·강사 X(`distribute`만), `HPS_LESSON_BINDINGS=enforce`인 로컬 Service(꺼진 배포는 S13⑧·S17), 확정 강의 C의 **v1**(회차 pin · A1~A3의 토큰) · **v2**(단계 `s2` 삭제·`s4` 추가·`s1` 유지, `features.allowed`에서 `write` 제거, `model.default` 변경, `assistant.display_name` 변경) · **v3**, 다른 강의 D의 v1, runtime이 다른 버전 vR, 초안 상태의 vDraft. **합성 upstream** = 받은 요청의 헤더·`system`·`model`·`tools`를 기록하는 로컬 provider 대역(실제 모델 호출 0). 모든 시나리오는 **같은 환경의 양성 대조(방해 없는 정상 경로)를 먼저** 통과시킨 뒤 방해를 주입하고, 경합은 U2 D5처럼 **실제 SELECT 하나를 붙잡고 그 사이에 실제 요청을 실행하는 hook**으로 만들며 hook이 발화하지 않으면 시험이 실패한다. 비선택 불변은 ‘없음을 센다’.

| # | 조건 / 깨뜨릴 가정 | 합격 기준 (양성 · 음성 증거) | 실행 계층 | 상태 |
|---|---|---|---|---|
| **P1** | 프롬프트를 A1·A3에 배포, A2 비선택(세 좌석 연결·`inbox_prompt` 선언) | A1·A3 `reflected`, 기기 index에 그 판·hash. A2: 대상 행 0 · 제안 0 · 보관함 파일 목록·hash 전후 동일. 강사 결과에 ‘가져오기·전송 여부는 수집하지 않습니다’ | Service + App host + 브라우저 e2e | NOT RUN · 계획 |
| **P2** | `초안에 가져오기`의 보존: ① 빈 초안 ② 글이 있는 초안 ③ 글 + 첨부 2장 + 예약 전송(`queued`) ④ **카드가 그려진 뒤·클릭 전에 입력창에 타이핑** ⑤ AI 응답 진행 중 ⑥ 입력 동결 중 ⑦ 합이 초안 한도를 넘음 | ①~⑤ 초안 = `이전 글 + 빈 줄 + 본문`(①은 본문만), **④의 타이핑이 그대로 있음**, 첨부·`queued` 바이트 동일, host `sendMessage` 0 · 모델 요청 0 · 진행 중 turn 불변. ⑥ 버튼 비활성 ⑦ 초안 불변 + 안내 1줄. **음성 대조군:** 초안을 대체하는 잘못된 구현(시험 전용 함수)을 같은 단언에 넣으면 실패해야 한다 | webview 순수 함수 + 브라우저 e2e | NOT RUN · 계획 |
| **P3** | 되돌리기: 가져온 직후 / 한 글자 고친 뒤 / 첨부를 추가한 뒤 | 직후: 직전 초안과 글자 단위로 같음. 고친 뒤: 비활성 + 이유 문구, 학생 글 손실 0. 첨부 추가는 글이 같으면 되돌리기 가능하고 첨부는 그대로 | webview 순수 + 브라우저 e2e | NOT RUN · 계획 |
| **P4** | 가져와 편집한 뒤 강사가 회수(실행 회수·다른 배포 없음) | 카드 본문·버튼 없음(‘강사가 회수한 자료입니다’), **초안(편집한 글)·`imports` 참조·대화·workspace 파일 hash 전후 동일.** 디스크 어디에도 회수된 본문 없음(보관함) — 초안에 남은 글은 학생의 것이라 검사 대상이 아니다 | App host + 브라우저 e2e + 실제 Mac | NOT RUN · 계획 |
| **P5** | 출처: 가져온 초안을 학생이 보냄 / 가져오지 않고 보냄 / 가져온 뒤 본문을 전부 지우고 보냄 / v1 카드가 v2로 바뀌는 사이 클릭 | 보낸 turn의 spool `prompt` 사건에 `instructor_prompt_refs[{object_id, revision}]`(본 판의 revision), 안 가져온 turn에는 필드 없음, 전부 지운 경우에도 ‘가져온 적 있음’만(분량·수정 정도 주장 0), 보낸 뒤 초안의 `imports` 비워짐. **가져오기·보내기 전후의 sync 요청 본문·보드 `/status`·receipt·감사 행에 그 사실의 흔적 0**(요청 body diff로 센다). 기존 회수 검증·측정 코어가 새 선택 필드를 가진 기록을 그대로 수용 | App host + spool + Service(collect seal) | NOT RUN · 계획 |
| **P6** | 권한·호환·내용: `inbox_prompt` 미선언 App · 구 Service + 새 App · 링크가 있는 prompt · 2,001자 · `<script>`/마크다운 · ‘이어서 하기’ 진입 화면 | 미선언 좌석은 제안 순간 `unsupported`이고 **본문이 그 기기로 나간 적 0**(같은 좌석이 공지는 받음). 구 Service: 회귀 0. 링크·초과 `400`. 본문은 카드와 초안 모두에서 글자 그대로(가져온 글이 DOM element·요청을 만들지 않음). 진입 화면 카드에는 버튼 없음 | Service + App 계약 + 브라우저 e2e | NOT RUN · 계획 |
| **P7** | 접근성: 키보드만 · 200% · 390px · 흑백 | 가져오기·되돌리기에 포커스·접근 이름, 상태줄은 글자, 작업 화면 Primary 1개 유지(SX-04) · 모달 0 · 자동 펼침 0 | 브라우저 e2e + 실제 Mac | NOT RUN · 계획 |
| **S1** | v2 설정을 A1·A3에 배포, A2 비선택. A1은 다음 질문을 보내고 A3은 보내지 않음 | A1: `준비됨` → (질문) → `전환 기록됨` → `실행 시도됨` → `적용됨`. **합성 upstream이 받은 A1의 그 요청**: `system`에 v2의 단계(`s4` 있음·`s2` 없음)와 v2 이름, `model` = v2 기본값, proxy면 `tools`에 빠진 기능 없음. `/v1/profile`의 `lesson_binding.key` = 그 요청의 응답 헤더 `x-hps-lesson-binding` = binding 행의 key = **그 turn의 `classroom_lesson_turns` 행의 key**(네 곳이 같다), `lesson.version=v2`·`sdk_tools.write=false`. A2: 같은 시각의 요청이 v1 · binding 행 0 · `/v1/profile` 응답이 배포 전과 `lesson_binding` 한 키 외 바이트 동일. A3: `준비됨`에 머물고 **`모두 적용`이 나오지 않음** | Service + App host + 합성 upstream + 브라우저 e2e | NOT RUN · 계획 |
| **S2** | **실행 중 설정 변경(같은 창)**: A1의 SDK turn이 여러 `/v1/messages` 요청(+`count_tokens`)을 보내는 도중에 v2를 확정·준비시킴 | 그 turn의 **남은 모든 요청**이 Service의 turn 행(v1 snapshot)으로 실행되고 upstream이 받은 `system`·`model`이 끝까지 v1, 응답·대화·도구 호출 중단 0. turn이 끝난 뒤의 다음 질문(새 turn id)부터 v2. **음성 대조군:** snapshot 대신 ‘요청 시점의 최신 binding’을 쓰는 시험 전용 스위치에서는 같은 단언이 **실패해야** 한다 | 실제 SDK binary + 로컬 Service + 합성 upstream | NOT RUN · 계획 |
| **S2b** | **두 번 연속 변경 + 다른 창의 진행 중 다중 요청**: 창 B가 v1 turn으로 SDK 하위 요청을 계속 보내는 동안 owner 창 A가 v2로 전환해 질문하고, 이어서 v3로 전환해 질문함 | B의 turn은 **v2·v3 전환 뒤의 요청까지 전부 v1**(upstream 기록)이고 끊기지 않음 · B의 요청이 v2·v3의 ‘적용됨’을 만들지 않고 v1(토큰) turn 행에만 증거가 남음 · A의 두 turn은 각각 v2·v3. B의 다음 turn은 profile을 갱신한 뒤 v3. **음성 대조군:** ‘현재+직전 key 2개’ 판정(첫 설계)을 시험 전용으로 되살리면 v3 전환 뒤 B의 요청이 거부돼 단언이 실패해야 한다 | 실제 SDK binary 2창 + 로컬 Service + 합성 upstream | NOT RUN · 계획 |
| **S2c** | **옛 key·옛 turn id의 재사용**: ① v2 전환 뒤 새 turn id + v1 key 헤더 ② 끝난 v1 turn의 turn id를 다시 써서 새 요청 — 승인 뒤 29분 / 31분 ③ 그 사이 요청을 계속 보내 수명을 늘리려 함 ④ 재발급된 토큰으로 옛 turn id ⑤ CLI의 HTTP 재시도(같은 turn id·같은 요청) ⑥ 같은 turn의 첫 요청 둘이 동시에 도착 | ① `403 lesson_binding_changed` · turn 행 0 · upstream 0 · 입력 복원 ② 29분: v1로 실행(문서가 말한 상한 그대로를 관측) / 31분: `lesson_turn_expired` · upstream 0 ③ `admitted_at` 불변 — 31분에 똑같이 거부 ④ `lesson_turn_mismatch` ⑤ 같은 행·같은 snapshot·행 1개 ⑥ 행 1개, 두 요청이 같은 snapshot. 어느 경우에도 **변경을 30분 넘게 피한 실행 0** | Service(시계 제어) + App host | NOT RUN · 계획 |
| **S2d** | **헤더 없는 App**: ① 미전환 좌석(binding 0)에서 binding 헤더 없는 요청 — turn id 있음/없음 ② 다른 기기가 v2로 전환한 좌석에서 헤더 없는 새 turn ③ 그 좌석에서 전환 **전에** 시작된 헤더 없는 turn의 후속 요청 — turn id 있음/없음 ④ 복귀 뒤 | ① 오늘과 같이 실행(**양성 대조군** — 구버전 App 회귀 0) ② `403 lesson_binding_app_unsupported` · upstream 0 · **v1 도구 캐시 + v2 Service 정책으로 실행된 요청 0** ③ turn id 있음: 승인된 v1 snapshot으로 끝까지 / 없음: 거부되고 부분 실행으로 남음 ④ 다시 실행됨. 강사 화면에 그 좌석의 사유 | Service + App 계약(구 App 대역) | NOT RUN · 계획 |
| **S3** | 두 runtime 각각(proxy 좌석 · agent-sdk 좌석)에서 S1. 헤더는 추측하지 않고 upstream 앞의 기록 서버에서 **실제로 나간 값**을 읽는다 | 두 runtime 모두 turn의 모든 요청에 같은 turn id·같은 key 헤더, Service의 응답 헤더·turn 행과 일치. runtime이 다른 버전 vR은 저장 단계에서 거부(S14) | 실제 SDK binary/proxy client + 로컬 Service | NOT RUN · 계획 |
| **S4** | App–Service 일치: ① 전환 요청 실패·4초 초과 ② 전환은 성공했는데 profile 후보 확인이 실패(5xx·timeout 주입) ③ owner 아닌 창이 갱신 전에 새 turn을 보냄 | ① turn은 기존 key로 정상 진행 · 강사 화면 `준비됨` 그대로(‘전환’·‘적용’ 0) ② **옛 key로 새 turn을 보내지 않음** — 입력 미소비 · 글·첨부 그대로 · 안내 문구 · 모델 요청 0 · 다음 시도에서 profile이 확인되면 v2로 나감 ③ `lesson_binding_changed` → 상태 조회 ‘행 없음’ → 입력 복원 → profile 갱신. 어느 경우에도 **App의 도구 정책과 Service의 system prompt가 다른 버전인 실행 0**(upstream 기록의 `system` 버전과 그 turn에서 host가 허용한 도구 집합을 대조) | App host(fault 주입) + Service | NOT RUN · 계획 |
| **S5** | 전환 전후의 학생 데이터: 초안(글 + 첨부 2) · 대화 · workspace 파일 · `activity_id` · 사용량 행 | 전후 hash·id 동일, 사용량 행의 cohort·user 귀속과 request id가 연속이고 v1 turn의 사용량이 v2로 옮겨 적히지 않음, 학생 모델 선택은 v2 기본값으로 돌아가고 안내 카드가 그것을 말함 | App host + Service D1 | NOT RUN · 계획 |
| **S6** | **전환의 커밋 경계**(읽기 뒤·조건부 INSERT 전에 끼어듦): 배포 회수 · `ops_lesson_settings` OFF · 회차 종료 · 좌석 교체 · 재로그인(epoch+1) · lease 이전 · 더 새 v3 확정 · 배포 강사 fence | 8종 모두 binding 행 0 · 감사 0 · `recorded:false`와 맞는 사유 · 그 학생의 다음 turn은 직전 버전. 조건이 돌아오면 다음 turn 경계에 같은 의도가 전환됨. **응답은 batch 성공이 아니라 INSERT의 `meta.changes`에서 만든다** — batch는 성공했는데 0행인 경우에 `recorded:true`가 나오면 실패 | Service(경합 hook) | NOT RUN · 계획 |
| **S7** | CAS·멱등: 같은 참가자의 두 창이 동시에 전환 · 전환 응답 유실 뒤 재요청 · 같은 revision 재배포(`no_change`) 뒤 전환 · 기기 교체 뒤 새 기기의 전환 | binding 행은 한 개(PK 충돌로 진 쪽 `changed` 또는 owner 아님), 재요청·재배포·새 기기 모두 **같은 행**을 돌려받고 새 행 0 · `binding_seq` 불변 | Service 동시성 + App host | NOT RUN · 계획 |
| **S8** | 늦게 온 것: v3 확정 뒤 늦은 v2 전환 요청 · 옛 epoch의 receipt · 끝난 연결 generation에 도착한 전환 응답 · 역순 도착 | v2 `superseded`·binding은 v3만, 옛 receipt `stale_offer`, 늦은 응답은 버려지고 다음 경계의 재요청이 같은 결과. 상태가 뒤로 간 경우 0 | Service + App host | NOT RUN · 계획 |
| **S9** | 다른 학생·수업·회차: A1의 key·turn id를 A2의 토큰 요청에 헤더로 · A1의 새 회차 · 다른 cohort 강사 · 학생/ops 자격으로 강사 API · 남의 turn id로 `GET /v1/lesson-turns/:id` | A2 요청 `403`(A2의 C가 아님 — **헤더가 강의도 남의 snapshot도 고르지 못함**: turn 행은 토큰의 학생으로만 읽힌다), 새 회차는 토큰 강의로 시작(binding·turn 0), 범위 밖 강사·학생 자격 거부, 남의 turn 조회는 ‘행 없음’. 모든 경우 새 테이블 행 수 불변 | Service negative | NOT RUN · 계획 |
| **S10** | 재발급: 같은 버전으로 재발급 · 다른 버전(v3 토큰)으로 재발급 · 전환 요청의 `base_lesson_sha256` 위조 · 옛 토큰으로 진행 중이던 turn | 같은 버전: binding 유지·다음 turn v2. 다른 버전: 토큰이 이김(v3)·보드 문구·보드/단계 판정도 v3 기준(`applicableBinding()`). 위조: 얻는 것은 자기 토큰의 강의뿐(더 넓은 실행 0). 옛 토큰의 turn은 옛 `jti`로만 이어지고 폐기됐으면 401 | Service + App host | NOT RUN · 계획 |
| **S11** | **기준이 바뀔 때**: v1에서 `s1`·`s2` 자기보고(`submitted`) + 강사 확인(`confirmed`) → v2 전환. 전환 뒤 늦게 도착한 v1 단계 사건. v2 좌석에 `mark_checkpoint(s2)`. **v2 전환 뒤 좌석 교체 / 다른 버전 재발급**으로 그 binding이 더는 유효하지 않은 좌석. binding 읽기 실패 중의 단계 사건 | 보드: v1의 단계·확인은 `이전 기준(v1)의 기록`으로만 보이고 **v2의 `s1`(같은 id)이 제출·확인으로 표시되지 않음**, v2는 ‘아직 시작 전’. 늦은 v1 사건 `lesson_mismatch` 격리. `mark_checkpoint(s2)`는 v2 기준 `unknown_step`. 교체·재발급된 좌석은 보드·단계·확인 표시가 **토큰 기준**으로 돌아감 — **음성 대조군:** raw 최신 행을 읽는 판정은 그 좌석을 v2라 말하므로 단언이 실패해야 한다. 읽기 실패 중의 단계 사건은 `basis_unknown` 격리(회차 pin으로 대신 판정 0). App 완료 게이트가 v1 사건으로 v2 단계를 닫지 않음. spool에 `lesson_binding` 사건이 새 기준의 첫 `prompt` 앞에 있고 그 `prompt`의 turn id가 Service의 v2 turn 행과 같음 | Service + App host + 브라우저 e2e | NOT RUN · 계획 |
| **S12** | **회수 ≠ 복귀**: ① 전환 전에 회수 ② 전환·적용 뒤에 회수 ③ 복귀(`base:true`) 배포 ④ 예전 v1을 가리키는 새 revision 배포 | ① 대상 `revoked`·다음 요청 v1·binding 0 ② **회수 직후의 다음 turn이 여전히 v2**(upstream에서 관측), binding 행 불변, 안내 카드만 내려가고 화면은 ‘이미 적용된 설정은 그대로’ — **v1이 저절로 되살아난 경우 0** ③④ 새 배포 → `준비됨` → 다음 질문에서 전환 → 그 turn의 `system`이 v1 → upstream 응답 뒤에야 `적용됨`. 복귀 전환·응답 전에는 어떤 화면도 ‘복귀됨’이라 하지 않음 | Service + App host + 합성 upstream + 브라우저 e2e | NOT RUN · 계획 |
| **S13** | **끄기·장애 — 전환 전/후/도중**, 각 행을 ⓐ 전환 전 ⓑ 전환·적용 뒤 ⓒ **SDK turn의 다중 요청 도중**에 주입: ① `ops_lesson_settings` OFF ② 전역 `HPS_CLASSROOM_OPS` OFF ③ binding/turn 테이블 읽기 오류(일반 오류) ④ `no such table`(집행 ON · 0024 없음) ⑤ turn 승인 INSERT 실패 ⑥ 회차 종료 · 배포 강사 폐기 · 학습 토큰 폐기 ⑦ **정책 축소**(전환 뒤 시험용 profile에서 기능·모델 제거) ⑧ `HPS_LESSON_BINDINGS` 없는 배포 | ①② ⓐ 새 저장·배포·전환 거부, 학생은 v1 ⓑ **v2 그대로 실행**(upstream 기록) ⓒ 그 turn 끝까지 같은 snapshot — **OFF로 토큰 강의로 내려간 요청 0**. ③ ⓐⓑ 새 turn 보류 `403 lesson_binding_unknown` · upstream 0 · 입력·첨부 복원 ⓒ 다음 하위 요청 보류 → 그 turn `부분 실행`, **자동 재전송 0**(같은 입력의 두 번째 upstream 요청 0), 장애가 풀리면 학생이 직접 다시 보냄. ④ 토큰 강의로 실행(검증된 미적용) + 오류 로그 — binding이 있을 수 없는 상태임을 행 수로 확인. ⑤ 보류. ⑥ 기존 deny가 고정된 turn에도 적용. ⑦ `409 lesson_unavailable` · 더 넓은 실행 0. ⑧ 증가분 0·기존 동작(**양성 대조군**), 설정 저장·전환은 `503 lesson_bindings_not_enforced`. **음성 대조군:** 읽기 실패·전역 OFF 때 토큰 강의로 폴백하는 첫 설계를 시험 전용으로 되살리면 ⓑⓒ에서 ‘v2로 좁혀진 학생의 요청이 v1의 `tools`/`system`으로 나감’이 관측돼 단언이 실패해야 한다 | Service(fault 주입) + 실제 SDK binary + 합성 upstream + App host | NOT RUN · 계획 |
| **S14** | 저장 검증: 초안 버전 · 다른 강의 D · sha256 불일치 · runtime이 다른 vR · 강의 pin 없는 회차 · 그 회차의 두 번째 setting 객체 · setting retire · `lesson_settings` 없는 강사 X(다른 capability 전부 보유) · 설정 `body`에 권한을 주장하는 문장 | 전부 4xx와 맞는 사유, 새 행 0. X는 `403`(자동 승격 0). `body`의 문장은 글자로만 보이고 upstream이 받은 `tools`·`model`은 v2 확정 값 그대로 | Service | NOT RUN · 계획 |
| **S15** | 호환·부분 적용: `lesson_binding` 미선언 App(공지·프롬프트는 받음) · 구 Service + 새 App · migration 0024 없는 DB + 집행 값 없는 새 Service · 앱 재시작(준비 뒤·전환 전) | 미선언 좌석은 설정만 `unsupported`(부분 적용을 성공으로 세지 않음). 0024 없는 DB: 채팅·`/v1/profile`·회수 seal·보고서 경로가 오늘과 같음(새 테이블을 참조하는 SQL이 붙지 않음). 재시작 뒤 `pending_binding`이 남아 재연결 뒤 다음 경계에 전환. **같은 grant의 자동 재연결은 U2와 같이 NOT RUN** | Service + App 계약 + App host | NOT RUN · 계획 |
| **S16** | 비용: 집행 값 없음 / 집행 ON·binding 없는 좌석 / 고정된 turn의 후속 요청 / turn 1개의 쓰기 / `step` 있는 sync / idle sync / 전환 / seal / 보고서 경로 / 보드 / 결과 조회를 30/100/200석에서 `meta.rows_read/rows_written`·호출당 문장 수로 계측 · 전 좌석 동시 전환·동시 첫 요청 | [요구 문서의 예산](../requirements/classroom-admin.md#remote-management-u3-20260921) ①~⑧ 안. 집행 값 없음과 idle sync의 증가분 0을 **문장 수로** 확인. 기존 채팅 p95 증가 ≤ 5%(집행 ON에서 따로). 문장 수를 운영 quota라고 쓰지 않는다 | 로컬 workerd D1 계측. **운영 D1·계정 plan NOT RUN/미확인** | NOT RUN · 계획 |
| **S17** | 회귀: flag 전부 OFF · `ops_distribute`만 ON(U2) · U1 선택 회수 · ‘수업 마무리’의 평가·검수·발송 dry-run · migration 0024 전/후 fresh vs 누적 · 기존 lesson 좌석(binding 0)의 gate·`/v1/profile` 응답 | 기존 suite·브라우저 e2e·U1/U2 독립 재현 그대로 PASS. **binding이 없는 좌석의 `/v1/profile` 응답은 `lesson_binding` 한 키 외에 바이트 동일**, system prompt 동일. schema 동등·재적용 멱등 | regression + 로컬 workerd D1 | NOT RUN · 계획 |
| **S18** | **실행 증거의 위치**: v2로 전환된 A1에 대해 ① `/v1/profile`만 호출 ② 전환 요청(preflight)만 ③ `count_tokens`만 ④ malformed JSON · `messages`가 배열 아님 ⑤ `effort_not_allowed`(403) ⑥ 예산/이용권 거절 · 모델 한도 429 ⑦ 오디오 wire 거절 ⑧ upstream 키 미설정(502 config) ⑨ upstream 5xx · fetch 예외 ⑩ upstream 200인데 학생 쪽 연결이 끊김(응답 유실) ⑪ dispatch 직후 프로세스 중단을 모사(종료 기록 없음) ⑫ 정상 응답 ⑬ v3가 현재일 때 v2에 고정된 turn의 요청이 성공 | ①~⑧ **turn·binding의 `first_dispatched_at`·`first_responded_at` 모두 비어 있음** · 화면 `전환 기록됨 — 실행 전` 그대로(gate는 전부 통과했음을 함께 확인 — gate 통과가 증거가 아님을 보이는 음성 대조) ⑨ `실행 시도 · 상류 실패(status)` · `적용됨` 아님 ⑩ `responded` 기록됨 · App의 그 turn은 `부분 실행`·자동 재전송 0 ⑪ 30분 뒤 `결과 미확인` · 성공으로 세지 않음 ⑫ `적용됨` + 그 요청의 usage request id·runtime·model이 upstream 기록과 일치 ⑬ 증거가 **v2 행에** 남고 v3는 `전환 기록됨` 그대로. effort receipt(`usage_request_settings`)가 없는 좌석(미성년 profile)에서도 ⑫가 성립. 두 runtime의 **실제 wire**로 확인 | Service + 실제 SDK binary/proxy client + 합성 upstream | NOT RUN · 계획 |
| **S19** | **섞인 기준의 보고서 경로**: 학생 P(binding 없음) · Q(첫 질문 전에 v2로 전환, v2로만 실행) · R(v1로 실행하다 v2로 전환) · T(v2 전환 뒤에도 다른 창의 v1 turn이 **겹쳐** 실행됨). ‘수업 마무리’로 네 명을 회수·평가. R에 대해 추가로: ① 배포 전에 쌓여 있던 `report_input` outbox 행 ② basis 기록 전에 이미 lease된 작업의 `evaluateLeased` ③ runner의 직접 `/jobs/:job/result` ④ 평가기 재설정 뒤의 재준비 ⑤ `/advance` 반복·재시도 ⑥ 배포 전에 만들어져 `review_required`인 초안의 승인 ⑦ 이미 `approved`인 작업의 발송 범위·링크 열람 ⑧ seal 시 turn 테이블 읽기 실패 | **양성 대조군:** P·Q는 `single` → `queued` → 평가 → 검수 대기(오늘과 같은 결과·같은 작업 수). **음성 대조군:** R·T는 `mixed` — outbox 행 0, ① `held` 작업 ② 저장 UPDATE 0행 · 초안 본문 삭제 · `held` ③ 같은 거부 ④ 되살아나지 않음 ⑤ `held` 그대로, lease 0, provider 호출 0 ⑥ `409 mixed_lesson_basis` ⑦ 발송 범위·링크에서 제외 ⑧ seal `503` · 봉인 0(표시 없는 봉인 없음). **T의 판정은 turn 행에서 나온다** — `activated_at`으로 자르는 분류기(시험 전용)는 T의 겹친 v1 turn을 v2로 읽어 단언이 실패해야 한다. 검수 목록은 R·T를 `기준이 바뀐 기록 — 평가 보류`로 보이고 0점·미달·누락으로 세지 않음. U1 `collect_only` 회수는 네 명 모두 그대로 검증됨 | Service + 로컬 workerd D1 + runner fixture + 브라우저 e2e | NOT RUN · 계획 |
| **M2 실제 Mac** | 실제 Studio 창 2개(A1 · 공식 shell 복사본 + 현재 확장 + 실제 SDK binary) + 실제 Chalk `/manage`(보이는 브라우저) + 합성 A2·A3 + 합성 upstream. **프롬프트:** 작성 → A1 선택 → 보내기 → 학생 창에 글과 첨부가 있는 상태에서 `초안에 가져오기` → 되돌리기 → 다시 가져와 편집(보내지 않음) → 회수. **설정:** 확정 v2 고르기 → 미리 확인의 영향 요약 → 보내기 → 학생 안내 카드 → **창 B의 turn이 진행 중일 때** 창 A가 다음 질문으로 v2 전환 → 이어서 v3 배포·전환 → B의 turn 종료 → B의 다음 질문 → 강사 `적용됨` → 회수 → 다음 질문(여전히 v3) → `복귀 보내기` → 다음 질문 → v1 `적용됨` → 로컬 Service의 ops를 끈 상태에서 한 번 더 질문(집행 유지 확인) | 강사 화면의 대상별 단계 시각(준비·전환·실행 시도·적용), 학생 화면의 단계 목록·AI 이름이 바뀐 시점이 **다음 질문**임, B의 진행 중 turn의 upstream 기록이 v2·v3 전환 뒤에도 끝까지 v1, 가져오기 전후 초안·첨부·대화·workspace hash, 회수 뒤 초안 그대로, 합성 A2 binding 0·profile 불변 · A3 `준비됨`. 증거: source SHA · shell/SDK 버전 · `result.json` · 화면(강사/학생 각 단계) · upstream 기록의 요청별 turn id·key·`system` hash · binding·turn 행 덤프 | 실제 Mac GUI | NOT RUN · 계획 |

**증거 층의 구분(실행 기록을 쓸 때 그대로 지킬 것).** ① **구현** = 단위·Service(Node SQLite) 시험 ② **합성** = 로컬 workerd D1(트랜잭션 의미·migration·`rows_*` 계측은 여기까지만 증명된다) · 합성 upstream · 실제 `ClassroomOpsHost` 루프 · 브라우저 e2e ③ **실기** = 실제 Mac 창 1대 + 실제 SDK binary + 실제 Chalk(모델 응답은 합성) ④ **운영** = 전부 NOT RUN. **실행 전까지 NOT RUN으로 남는 환경:** Windows, 학교망, Cloudflare staging/production D1(0024 적용·쿼터·plan), 실제 기기 2대 이상, **실제 모델**(v2 system prompt로 모델이 실제로 다르게 행동하는지 · 비용)·실제 메일, 같은 grant의 자동 재연결, VoiceOver/NVDA, Safari/Firefox. 설정 적용 시점의 운영 정책과 INT-CO-04 승인은 시험 결과가 아니라 사람의 결정이다.

<a id="remote-management-u3-run-20260921"></a>

### U3 — 실행 기록 · 2026-09-21 (로컬 · 인수 전 · 운영 아님)

위 [계획](#remote-management-u3-plan-20260921)의 상태 칸은 고치지 않았다. 이 절이 실제로 실행한 것이다. 증거 층을 섞지 않는다: **구현**(단위·Service Node SQLite) / **로컬 D1**(workerd) / **브라우저**(실제 Chalk·빌드된 webview·실제 기기 클라이언트) / **로컬 실기**(실제 Studio 창·실제 SDK binary) / **운영**(전부 NOT RUN). 모든 실행의 모델 공급자는 **프로토콜을 끝까지 말하는 기록 서버**다 — 실제 모델의 품질·지연·비용에 대해 아무것도 말하지 않는다.

| 층 | 명령 (Node 22.22.1) | 결과 | source |
|---|---|---|---|
| 구현 · Service | `worker`: `test/lesson-binding.test.mjs`(13) · `classroom-ops-lesson-settings.test.mjs`(9) · `classroom-ops-lesson-basis.test.mjs`(5) · `classroom-ops-lesson-settings-device.test.mjs`(3) — `npm run test:classroom-ops`에 포함 | PASS | 최종 HEAD |
| 구현 · App | `extensions/hypeproof-chat`: `test/lesson-binding.smoke.mjs`(4) · `classroom-inbox.smoke.mjs` — `npm test` | PASS | 최종 HEAD |
| 구현 · Chalk | `chalk`: `npm test`(`classroom-ops.test.mjs`에 U3 문구·전달 경로) | PASS | 최종 HEAD |
| 로컬 D1 | `worker`: `npm run test:classroom-ops:d1`(`classroom-ops-lesson-settings-d1.test.mjs` 추가) | PASS — 수치는 [요구 문서의 실측 표](../requirements/classroom-admin.md#remote-management-u3-20260921) | 최종 HEAD |
| 브라우저 | `e2e`: `npm run test:classroom-ops-lesson-settings`(E1~E4) · 회귀 `test:classroom-ops-distribution`(7) | PASS · 화면 3장은 `e2e/test-results/classroom-ops-lesson-settings/` | 최종 HEAD |
| 로컬 실기 M2 | `e2e/classroom/mac-devhost.mjs prepare` → `e2e/classroom/mac-lesson-settings.mjs` | PASS — `7665223`에서 처음 통과(5번째 실행 · 앞의 4번은 아래 결함 1건과 계측기 오류), CI가 잡은 초안 저장 회귀를 고친 **`ded79c4`에서 다시 준비해 재실행 PASS**. `result.json`·화면 10장은 devhost의 `lesson-settings/` | `ded79c4`(확장·Service·Chalk 소스는 최종 HEAD와 동일 — 이후 커밋은 문서뿐) |

**시나리오별.** PARTIAL은 ‘그 행이 요구한 조건 중 실행하지 않은 것이 있다’는 뜻이고 그 부분은 NOT RUN이다.

| # | 상태 | 어디서 | 실행하지 않은 부분 |
|---|---|---|---|
| P1 · P6 | PASS | Service `P1/P6` · 기기 `prompt` · 브라우저 E2 | 구 Service + 새 App 조합은 Service 단위(`enforcement unset`)로만 |
| P2 · P3 | PASS | App 단위(`prompt import`) · 브라우저 E2(빌드된 webview의 실제 입력창: 덧붙임 · 전송 0 · 되돌리기 · 타이핑 뒤 되돌리기 비활성) · M2(실제 창: 초안 + 붙여넣은 이미지 1장 유지) | 첨부 2장 + 예약 전송(`queued`)이 있는 상태의 실기 조합 |
| P4 | PARTIAL | 기기 `withdrawal`(카드가 내려감) — 초안은 webview 상태라 카드 회수 경로가 닿지 않는다(코드상) | 가져와 편집한 **뒤** 회수했을 때 초안·`imports`가 그대로인지의 실행 확인 |
| P5 | PARTIAL | App 단위(본문 없는 참조 · 같은 판 중복 제거) | 보낸 turn의 spool `prompt` 사건에 참조가 실리는지, v1→v2 사이 클릭 |
| P7 | PARTIAL | 브라우저 E2는 버튼을 셀렉터로 눌렀다. U2의 카드 목록 접근성 시험(키보드·200%·390px)은 회귀 PASS | 가져오기·되돌리기 버튼 자체의 키보드·200%·390px·흑백 |
| S1 | PASS | Service `S1` · 브라우저 E3 · M2 | — |
| S2 · S2b | PASS | Service `an admitted v1 turn keeps v1 through v2 and v3` · `S8/S2b` · **M2: 창 1의 답이 오는 중(공급자가 응답을 붙잡음)에 V3 확정 → 창 2의 다음 질문은 V3, 창 1의 그 질문의 모든 공급자 요청은 V2, turn 행은 V2·`completed`로 닫힘** | M2의 그 질문은 공급자 요청 1개였다(다중 요청 turn의 실기는 기록 서버 probe로만) |
| S2c · S2d | PASS | Service `a new turn with the old key…` · `completion: the host closes a turn…` · `binding-unaware app` | — |
| S3 | PASS(합성) + 실기 1경로 | Service `evidence …(SDK and proxy)` · M2: agent-sdk 창의 `/v1/messages`에 실제로 실린 `x-hps-lesson-binding`·turn id를 Service 앞에서 기록, proxy는 **실제 `proxyClient` 모듈**이 실제 HTTP로 `/v1/chat/completions`를 호출 | proxy runtime **profile의 실제 Studio 창**(합성 profile이 agent-sdk다) |
| S4 | PARTIAL | App 단위 `preflight`(전환 실패 · 후보 불일치 → 교체 안 함) | 4초 초과·profile 5xx 주입을 실제 host에서 |
| S5 | PASS | M2(대화 · workspace 파일 hash · 초안·첨부) | 사용량 행 귀속은 Service 시험만 |
| S6 · S7 · S8 | PASS | Service `S6`(8개 경합 · hook 발화 확인) · `S7` · `S8/S2b` · 로컬 D1(동시 30 · 3중 · 옛+새) | 기기 교체 뒤 새 기기의 전환은 M2의 ‘같은 기기 재연결’까지 |
| S9 | PARTIAL | Service(남의 key → 403 · 상태 조회는 같은 토큰만) | 다른 cohort 강사 · 새 회차 |
| S10 | PARTIAL | 순수 계약(`token_lesson_changed`) · Service(`turns are bound to one token`) | 재발급 4경우의 끝-끝 실행 |
| S11 · S12 | PASS | Service `S11` · `S12` · 브라우저 E4 · M2(회수 클릭 → 여전히 V3 · 복귀 클릭 → V1) | — |
| S13 | PASS | Service `unknown holds execution…; operations-off keeps enforcing mid-turn; the token-fallback control is shown to widen` | 전역 OFF를 SDK 다중 요청 **도중**에 주입하는 실기 |
| S14 | PASS | Service `S14`(+ `setting-options`) | — |
| S15 | PARTIAL | Service(`migration 0024 없는 DB` · `enforcement unset`) · 기기(재시작 뒤 pending 유지) · **M2: 수업 중에 집행을 켠 경우**(아래 결함 1) | 구 App 실물 |
| S16 | PASS(로컬 D1) | `classroom-ops-lesson-settings-d1.test.mjs` | p95 · 운영 D1 · plan **NOT RUN** |
| S17 | PASS | worker `npm test` · `test:classroom-ops` · `test:classroom-ops:d1` · Chalk · 확장 · 브라우저 U2 · M2 0단계(U3 OFF에서 실제 1턴 + U2 공지) | ‘수업 마무리’ 발송 dry-run은 기존 suite 그대로 |
| S18 | PASS | Service `evidence: profile, count_tokens, malformed and refused requests leave none…` | — |
| S19 | PASS | Service `classroom-ops-lesson-basis`(5): 이미 lease된 작업 · 기준 행 없는 작업 · 승인된 작업 · 늦은 기준 · flag 롤백 · 재시도 | — |
| M2 | PASS | 아래 | 아래 NOT RUN |

**M2 — 실제 Mac.** 공식 shell `0.1.56`의 복사본(설치된 앱은 읽지도 실행하지도 않음) + 현재 확장 build(번들 4개 hash 일치 · source `ded79c4`) + 실제 Agent SDK `0.3.207` binary, 자체 포트 18781/18782/9381 · 자체 user-data·HOME. 강사 조작은 전부 보이는 Chromium의 Chalk `/manage`에서 클릭했다. 순서: ① U3 OFF(집행 값 없음 · 회차 스위치 없음): 실제 1턴 + U2 공지 도착 — turn 행 0 · profile에 `lesson_binding` 없음 · 작성란에 ‘수업 설정’ 없음 ② 집행 + 회차 스위치 ON → ‘수업 설정’이 나타남 ③ 프롬프트: 실제 창의 초안 + 붙여넣은 이미지 → `초안에 가져오기`로 덧붙음(전송 0) → 되돌리기 → 다시 가져와 학생이 직접 전송 → 공급자 요청에 그 글 ④ 첫 설정 V2: `준비` → 다음 질문에서 전환 → 실제 요청 헤더의 key = 전환된 binding → turn 닫힘 → `적용` ⑤ 창 1의 답이 오는 중에 V3 확정, 두 번째 창의 다음 질문은 V3, 창 1의 질문은 끝까지 V2 ⑥ 회수 클릭 → 여전히 V3 ⑦ 복귀 준비 → 저장(3번째 판) → 확인 → 보내기 → 다음 질문은 V1 ⑧ 비선택 A2(실제 기기 클라이언트): 배포 블록 0 · 보관함 폴더 없음 · binding 0 · 실제 proxy 클라이언트의 질문은 V1. 결과: 공급자 요청 9 · turn 7 · binding [V2, V3, 복귀]. **정정(독립 검토):** 처음에는 ‘집행 뒤의 turn은 전부 host가 `completed`로 닫음’이라고 썼으나 틀렸다 — `ded79c4`의 `result.json`에서 닫힌 turn은 7개 중 **6개**이고, `db166bab`(binding_seq 0 · dispatched 1 · completed 1 · **closed 0**)는 닫히지 않았다(`7665223` 실행의 같은 경우는 `90e2e050`). 그 turn은 ‘집행 전에 시작한 turn’이 아니라 **집행을 켠 뒤에**, 집행 전에 profile을 캐시해 둔 App이 보낸 프롬프트 turn이다: 요청은 정상 완료됐고(Service 기록 `completed`) host가 key도 close도 보내지 않았을 뿐이다.

**실기에서만 드러난 것.**
1. **제품 결함(수정함 · `7665223`).** 수업 중에 집행을 켜면 App의 세션 캐시 profile에 `lesson_binding`이 없어 key·전환·close를 전혀 보내지 않았고 강사 화면은 ‘준비’에서 멈췄다. 합성 시험은 전부 통과하던 상태였다. App은 이제 자기 보관함에 수업 설정이 있을 때만 profile을 한 번 다시 읽는다(단위 시험 + 음성 대조군 + M2 ④에서 확인). **정정:** ‘집행 전에 시작한 turn’이라는 표현은 틀렸다. 정확히는 — 집행을 켜기 **전에 profile을 캐시한** App이, 아직 수업 설정을 받지 않은 상태에서 집행 **뒤에** 보내는 turn은 key·close 없이 나간다(토큰 강의와 같아 승인됨 · host가 닫지 않으므로 30분 상한만 적용). 세 시점을 구별한다: profile 캐시 시점 · 요청 완료(Service 기록) · host의 종료 선언.
2. 이 harness는 secret을 **창마다** 메모리에 둔다. 두 번째 창은 수업 연결이 없어 새 1회용 코드로 연결했다. 연결 직후(기기가 새 연결의 전달 key로 자료를 다시 받기 전)의 전환은 `stale_offer`로 거절되고 설계대로 다음 질문에서 다시 시도된다 — 실행기는 재수신을 기다린다. **Keychain을 쓰는 실제 설치본에서 두 창이 연결을 공유하는지는 NOT RUN.**
3. agent-sdk runtime은 붙여넣은 이미지를 파일로 저장해 Read 도구로 읽힌다 — 첫 공급자 요청의 image block이 아니다. M2는 ‘첨부가 가져오기·되돌리기 동안 그대로이고 전송과 함께 입력창을 떠났다’까지만 말한다.

**CI가 잡은 회귀(수정함 · `ded79c4`).** 초안 저장의 flush 경로가 항상 `imports: []`를 실어, 프롬프트를 받은 적 없는 학생의 저장 메시지 모양까지 바뀌었다. 로컬 회귀에 `e2e`의 `test:trial-ux`(US-UI-DRAFT)를 넣지 않아 놓쳤고 PR의 `start-page-browser`가 잡았다. 빈 경우 key를 생략하도록 고치고 그 suite(49)와 확장·U3 브라우저 시험·M2를 다시 실행했다.

**계측기 오류(제품이 아니라 시험이 틀렸던 것 — 고친 뒤 다시 실행).** ① M2의 `설정: 준비` 정규식이 ‘준비 **전**’ 문구에도 걸려 기기가 받기 전에 질문을 보냈다 → ‘기기 보관함에 있음’까지 요구 ② 브라우저 e2e가 확인 뒤에 미리보기 본문을 읽었다(이미 비워진 뒤) ③ 같은 값을 자기 자신과 비교하는 단언 1개 ④ 첫 M2는 turn close를 응답 직후에 단언했다(close는 그 뒤에 나간다) → 기다림 ⑤ D1 시험의 기준선이 `sessions` 행 없음 때문에 매 요청 재시도 1회를 포함했다 → 운영처럼 행을 넣음.

**음성 대조군.** 제품 코드에 시험 스위치는 없다. 첫 설계의 동작(옛 key 허용 · `activated_at`으로 기준 자르기 · 집행 값 없음 = 토큰 fallback · 매 turn profile 재읽기)은 시험 파일 안의 틀린 함수·설정으로 만들고, 시험이 그것을 잡는지 확인했다.

**NOT RUN.** Windows · 학교망 · 실제 복수 기기 · staging/production D1·R2 · 계정 plan·쿼터·지연·p95 · 실제 모델(품질·비용) · 실제 메일 · 같은 grant의 Keychain 자동 재연결 · proxy-runtime profile의 실제 창 · 구 App 실물 · 위 PARTIAL의 나머지. 후속으로 남는 것: 구간별 보고서(섞인 기준은 지금 `보류`까지만) · U4 복구 · U1b 회수 확장 · 공통 결과 통합.

<a id="remote-management-u3-review-20260921"></a>

### U3 — 독립 검토 보완의 실행 기록 · 2026-09-21 (로컬 · 인수 전 · 운영 아님)

`d32a191`에 대한 독립 검토(실제 강사 화면 → 실제 Mac 학생 앱 조작 + 격리 재현 4종)가 짚은 9건의 보완이다. 계약은 [요구 문서의 ‘독립 검토 보완’ 표](../requirements/classroom-admin.md#remote-management-u3-20260921). 위 [첫 실행 기록](#remote-management-u3-run-20260921)의 PARTIAL 행은 고치지 않고 여기서 닫는다. 모델 공급자는 여전히 프로토콜을 끝까지 말하는 기록 서버다.

| # | 회귀(양성 대조군 포함) | 검토의 재현 파일을 고친 소스에 다시 실행 |
|---|---|---|
| 1 · 3 | `worker/test/classroom-ops-lesson-review.test.mjs` `1`·`3` — 같은 진짜 토큰 + 변조된 기준값 · 토큰 없음 · 남의 토큰 · 위조 · 강의 없는 토큰 · 다른 과정 · 폐기된 토큰은 **기록 0**, 정직한 요청과 재발급 토큰은 전환. 좌석 a→c 교체 뒤 c는 a의 key를 받지 못함(같은 학생의 유실 응답 재요청은 replay) | `u3-activation-identity-review.mjs` — 전환 요청에 학습 토큰만 추가한 사본(케이스·기대값 그대로)으로 3/3 PASS. 원본 wire(토큰 없음)는 이제 양성 대조군부터 `learner_token_required`로 거부된다 |
| 2 · 6 | 같은 파일 `2`·`6` + `classroom-ops-lesson-basis.test.mjs`(rollback · 세션 귀속이 빠진 usage 행 · 같은 초 · `unknown`) | `u3-basis-rollback-review.mjs`(+`--same-second`) 그대로 PASS: rollback 뒤 `mixed`/보류, 같은 초의 v2 1건은 `single` |
| 4 · 5 | 같은 파일 `4`·`5` — 회차 변경 뒤에도 `dispatched`/`completed` 유지, 어디에도 없는 turn만 `not_started`, 재발급 토큰·읽기 실패는 `unknown`, close는 원래 행을 닫음. 열린 turn 200/provider 1 · 요청 전에 닫힌 turn 403/0 · **읽기와 호출 사이에 닫힌 turn 403/0**(hook 발화 확인 · `requests`는 허가된 2건만) | `u3-turn-boundary-review.mjs` 5/5 · `u3-close-route-review.mjs` PASS 그대로 |
| S9 · S10 | 같은 파일 `S9`·`S10` — 다른 cohort 강사·학습 토큰·ops 자격은 설정 API에서 401/403·쓰기 0, 새 회차는 이전 회차의 binding을 물려받지 않음(돌아오면 그대로). 재발급: 같은 버전은 binding 유지 · 다른 버전은 그 토큰의 강의로 실행 + `token_lesson_changed` · 위조 기준 거부 · 옛 토큰으로 진행 중이던 turn은 그 토큰에만 | — |
| 7 | 브라우저 e2e E1·E3·E4(진입·버튼·확인·회수 문구, `by_current`: 복귀는 ‘지금 V2 · 전환된 상태: 새로 생김 build, review · 없어짐 craft-v2’) · Chalk 표면 시험 | 실제 Chalk 화면에서 M2가 같은 문장을 확인 |
| 0 · 8 | 확장 `classroom-inbox.smoke.mjs`(포인터 소유 · 음성 대조군 = U2 규칙) · **M2** | 아래 |
| P2~P5 · P7 | 브라우저 e2e **E2b**(빌드된 webview): 초안 + 첨부 2장 + 예약 전송 · 키보드만(Tab/Shift+Tab/Enter) · 390px · 200% · 강제 색상 · 회수 뒤 보존 · 학생이 보낸 turn의 `imports` = 정확한 object·revision · 예약 전송은 출처 없음 | M2가 실제 host에서 같은 조합을 실제 마우스로 |

**M2 재작성 — 실제 Mac.** 같은 shell 복사본·SDK binary, 최종 확장 build. 학생 쪽 조작은 전부 **화면에 보이는 컨트롤을 실제 마우스 입력으로** 눌렀다: 누르기 전에 크기 · viewport 안 · 그 좌표의 최상위 요소 · enabled · visible을 검사하고, 하나라도 아니면 `evaluate(click)`으로 넘어가지 않고 실패한다. 순서: ① U3 OFF 회귀(실제 1턴 · U2 공지를 마우스로 열기) ② 집행 ON ③ 답이 오는 중에 예약 전송 1건 + 초안 + 붙여넣은 이미지 2장 → 프롬프트 도착 → 가져오기 → 되돌리기 → 다시 가져와 편집 → **강사가 프롬프트 회수** → 초안·첨부·예약 그대로 → 답이 끝나 예약 전송이 단독으로 나가고 초안은 남음 → 학생이 전송 → spool의 그 turn `prompt` 사건에 `instructor_prompt_refs=[{object, revision 1}]`(예약 turn에는 없음) ④ **S4-①** 전환 요청 무응답 4초 → 질문은 V1·토큰 key로 실행, 다음 질문에서 전환·새 key·close ⑤ 창 1의 답이 V2로 오는 중에 V3 확정 → 두 번째 창 연결 → **두 창 모두 보관함이 화면에 있고 마우스로 열림**(검토 0) → **S4-②** 전환은 됐는데 profile 5xx → 아무것도 보내지 않음 · 입력 유지 · 안내 → 학생이 다시 전송 → V3, 창 1의 질문은 끝까지 V2 ⑥ **S13-ⓒ** 실제 SDK 다중 요청 turn(도구 호출 1회) 도중 회차 스위치 OFF → 두 요청 모두 V3 · 다음 turn 도중 binding 읽기 장애 → 다음 하위 요청 보류 → 화면 ‘끝까지 실행되지 않았습니다’ · 자동 재전송 0 ⑦ 회수 클릭 → 여전히 V3 ⑧ 복귀: **S4-③** 전환 응답 유실 → 옛 key 질문은 provider 전에 거부 → ‘보내지 않았습니다’ + 입력 복원 → 학생이 다시 전송 → V1 ⑨ 두 workspace의 원본 파일 3개가 **앱 시작 전에 쓴 바이트와 동일**(음성 대조군: 한 글자 바꾸면 잡힘) · 앱이 추가한 파일은 붙여넣은 이미지 2개(`ws/assets/pasted-*.png` — 기존 동작)뿐 · 비선택 A2 불변.
결과(`result.json` schema 2): 공급자 요청 14 · turn 11개 중 host가 닫은 것 8개 — 닫히지 않은 3개는 전부 집행 전에 profile을 캐시한 창이 **설정을 받기 전에** 보낸 turn(답이 붙잡힌 질문 · 예약 전송 · 프롬프트 질문 — 요청은 모두 정상 완료, host가 key·close를 보내지 않음)이고 원인과 함께 `turns_not_closed`에 있다. 그 창이 설정을 받은 뒤의 turn은 전부 닫혔고, S13에서 보류된 turn은 host가 `failed`로 닫았다(`requests` 1 — 허가된 요청만 셈).

**proxy-runtime 실제 창(S3).** `HPS_U3_MODE=proxy`: 같은 합성 cohort를 proxy runtime profile(`boah-dental-teaser-2026-s1`)로 열어 실제 Studio 창이 `/v1/chat/completions`로 말한다. 집행·회차 스위치를 **앱 시작 전에** 켠 순서다: 첫 질문부터 토큰 key · 모든 요청에 turn id · host가 3개 turn 모두 `completed`로 닫음 · 설정 V2 → 실제 헤더의 key = 전환된 binding → `적용` → 복귀 → V1. `/v1/messages`는 한 번도 쓰지 않았다.

**이번에 고친 계측기 오류.** ① ‘SDK 요청의 마지막 메시지에 학생 글이 있다’는 가정(없다 — 대화 전체에서 가장 뒤의 마크로 귀속) ② 합성 stream이 첫 delta를 빠뜨려 화면 문구가 잘림 ③ 강사 조작 헬퍼가 ‘새 자료’를 건너뜀 ④ 브라우저 e2e: 가져오기 뒤 포커스는 입력창으로 돌아간다(되돌리기는 Shift+Tab으로 도달) — ‘다음 Tab이 되돌리기’라는 가정이 틀렸다 ⑤ 기준 판정 시험의 fixture가 turn만 넣고 usage 행을 넣지 않아 실제 원장과 달랐다.

**여전히 NOT RUN.** Windows · 학교망 · 실제 복수 기기 · staging/production D1·R2 · 계정 plan·쿼터·지연·p95 · 실제 모델 · 실제 메일 · **Keychain을 쓰는 일반 설치본에서 두 창의 연결 공유·자동 재연결**(이 harness는 secret을 창마다 메모리에 둔다 — 설치본·기존 자격증명을 건드리지 않고는 격리해 돌릴 수 없어 실행하지 않았다) · 구 App 실물(S15) · 전역 `HPS_CLASSROOM_OPS` OFF를 실제 창의 turn 도중에 주입하는 것(연결이 끊겨 이후 단계를 오염시킨다 — Service 시험으로만). 섞인 기준의 ‘보류’는 보고서 기능의 완료가 아니다: 기준별 분할 보고서는 후속이다. U4 복구·U1b 회수 확장은 시작하지 않았다.

<a id="remote-management-u3-basis-identity-20260921"></a>

### U3 — 실패 요청 마스킹 보완의 실행 기록 · 2026-09-21 (로컬 · 인수 전 · 운영 아님)

`e7d719a`에 대한 독립 검토가 회수 입력의 기준 판정에서 결함 하나를 더 재현했다: 실패한 집행 요청 하나가 집행 OFF 뒤의 성공 요청 하나를 개수로 가린다. 계약은 [요구 문서의 ‘요청 단위의 식별 연결’](../requirements/classroom-admin.md#remote-management-u3-20260921). 앞의 두 실행 기록은 고치지 않았다 — 그 기록의 ‘두 원장의 개수 대조’는 이 절로 대체된다.

| 무엇 | 어디서 | 결과 |
|---|---|---|
| 검토의 HTTP 재현 그대로 | 공통 git-dir `u3-basis-failure-mask-review.mjs` — 원본 그대로 고친 소스에 | 양성 대조군(v2 성공만) `single`/allow · v2 성공 → v2 500 → OFF → v1 성공은 `unknown`/보류 — PASS. `u3-basis-rollback-review.mjs`와 `--same-second`도 그대로 PASS |
| 회귀(실제 라우트 · 양성 대조군 먼저) | `worker/test/classroom-ops-lesson-review.test.mjs` `failure mask` | **실제 단일 기준 수업에 있는 것 전부** — 성공 1 · 한 turn의 요청 3 · provider 500 · 도중에 끊긴 stream · 같은 질문 재시도 · turn id 없는 요청 — 이 모두 v2로 기록되고(요청 행 8 = usage 행 8, 각 usage 행을 **그 요청이** 가리킴) `single`로 **보류되지 않는다**. 결함 시나리오는 허가 2 = 응답 2인데 `unknown`(음성 대조군 = `5a476f7`의 개수 규칙은 같은 입력을 single이라 함). 연결 유실 → 보류. seal 뒤에 도착한 usage 행 → 다음 경계의 verdict와 커밋 predicate가 모두 보류. 관찰 평가의 usage 행은 식별되면 single, 식별 없이는 보류(음성 대조군). 이전에 seal된 다른 입력의 행은 그대로 |
| 기준 판정의 소비 지점 | `classroom-ops-lesson-basis.test.mjs`(5) — fixture를 실제 원장 모양(요청 행 + 연결된 usage 행)으로 | lease 직후 · evaluator/runner 입력 전 · 결과 저장·승인·전달 범위·링크 열람 · flag OFF/집행 해제/복귀 뒤 유지 · 0024 없는 DB — PASS |
| 실제 D1에서의 식별 | `classroom-ops-lesson-settings-d1.test.mjs` | D1 batch 안의 `last_insert_rowid()`가 그 batch가 방금 쓴 usage 행임을 **join을 되읽어** 확인(가정하지 않음). 비용: T +9문장/+6행 · R +4문장/+2행 · seal 1문장, 전환된 참가자 요청 50 → 100개에 읽은 행 201 → 401(선형) · 100개 중 귀속 불가 1개 → `unknown` |
| 집행 OFF · 구스키마 | `lesson-binding.test.mjs` `enforcement unset…nothing is written` · `…without migration 0024` | 증가분 0 · 기존 동작 — PASS |
| 회귀 전체 | worker `npm test` · `test:classroom-ops` · `test:classroom-ops:d1` · 관찰 suite 3개 · Chalk · 확장 · 브라우저 e2e 8개 | 아래 최종 보고의 exit code |
| 실제 Mac M2 | `mac-lesson-settings.mjs`(같은 시나리오 · Service만 바뀜 — 확장 build는 `84ec5fb` 그대로) | 실제 학생의 허가된 요청 전부가 자기 usage 행을 가리키고, 가리켜지지 않는 응답 1건은 **U3 OFF 단계(0단계)의 질문**임을 `result.json.request_ledger`로 확인 |

**NOT RUN / 알 수 없는 것.** 집행이 꺼져 있던 동안의 요청인데 usage 행마저 쓰이지 못한 경우는 어디에도 흔적이 없다(기존의 기록된 손실) — 탐지했다고 쓰지 않는다. 운영 D1의 batch 동작·지연·plan·p95, Windows·학교망·실제 모델·실제 메일은 그대로 NOT RUN. 보류는 보고서 기능의 완료가 아니다.

<a id="windows-field-cuesheet-20260921"></a>

### Windows 현장 실행 패키지와 큐시트 · 2026-09-21 (준비 완료 · 현장 실행 NOT RUN)

구성은 `e2e/classroom/win-field/README.md`. 개발 Mac에서는 Windows 명령을 실행하지 않는다(레포 규칙). 두 스크립트는 CI `windows-latest`(Windows PowerShell 5.1)에서 가짜 shell로 자가 시험한다 — 파싱되고 거부해야 할 것(production 주소·http·설치 경로 아래 작업 폴더·변조된 번들·dirty 번들·shell 아님)을 거부한다는 증거이지 Studio 창이 동작한다는 증거가 아니다.

| 시점 | 누가 | 할 일 | 기록 |
|---|---|---|---|
| D-2 이전 | 운영자 | staging 대상 준비(`worker/DEPLOY.md` §0) · PR의 CI artifact `classroom-field-bundle` 내려받기 · PC마다 공식 Studio 설치와 `scripts\seed-sdk-binary.ps1` | staging 검사기 출력, bundle `manifest.json`의 source SHA |
| D-1 | 운영자 | 대표 PC 1대에서 `prepare-devhost.ps1` → `preflight.ps1` → `-Launch` → 성인 1석으로 아래 수업 중 표 전체 | `manifest.json`·`preflight.json` |
| 수업 30분 전 | 보조 | 모든 PC에서 `preflight.ps1`(현장망). FAIL은 그 PC를 빼거나 원인 제거, WARN은 기록 | PC별 `preflight.json` |
| 입장 | 강사 | Chalk에서 회차 구성 → 좌석별 1회용 코드. 학생: 토큰 입력 → 명령 팔레트 ‘수업 연결’ | 보드: 전 좌석 `active`·토큰 `앱이 같은 발급분을 확인함` |
| 수업 중 | 강사 | 단계 제출 → 강사 확인 1건 · `진단 다시 실행` 1건 · (성인 좌석에서만) 중지 1건·초기화 1건 + 파일 해시 전후 | 명령 영수증, 학생 화면 문구 |
| 마무리 | 강사 | 동의한 좌석만 `수업 마무리` → 회수 상태·coverage → 초안 1건 열람 | 좌석별 coverage와 사유 |
| 중단 조건 | 누구나 | 학생 파일 변화, 다른 학생 기록 혼입(격리), production 주소 접속, 일반 채팅 지연 체감 → run flag를 끄고(`worker/DEPLOY.md` §6) 수업은 기존 방식으로 계속 | 시각·증상 |

Windows에서만 확인할 수 있어 **NOT RUN으로 남는 것:** 경로 구분자·긴 경로·한글 사용자 폴더에서의 spool/동결 복사본, Defender/학교 보안 프로그램의 `claude.exe` 차단, 프록시·TLS 재서명 망에서의 SDK 스트리밍, 절전 복귀 뒤 sync 재개, 설치본 업데이트 알림과의 공존.


<a id="instructor-ui-pass-run-20260922"></a>

### 강사 UI 1차 정리 — 실행 기록 · 2026-09-22 (로컬 · 사용자 검토 전 시안 · 인수 아님)

설계·범위: [디자인 요구](../requirements/classroom-design.md#instructor-ui-pass-20260922). 소스 `48b4820`
(브랜치 `feat/751-instructor-ui-pass`, 기준 `d87f1fc` = U4 중간 스냅샷 — U4 최종 head와의 통합은 별도). Mac arm64 ·
Playwright Chromium · 합성 계정만. 화면 배치·문구·스타일 변경이며 Service·SDK·API 계약은 바꾸지 않았다.

| 검사 | 결과 |
|---|---|
| `npm --prefix chalk test` · `npm --prefix chalk run typecheck` | PASS · PASS |
| `e2e/classroom/run.mjs`(공유·피드백·재연결) · `ops.mjs` · `ops-selection.mjs` · `ops-distribution.mjs` · `ops-lesson-settings.mjs` · `ops-roster.mjs`(30석·1024·200%·390 drawer·44px·주요 CTA 1개) | 6개 PASS |
| `e2e/access-budgets/browser.mjs` · `e2e/chalk-authoring/run.mjs`(동선 막대가 붙은 두 화면) | PASS · PASS |
| `e2e/chalk-authoring/simple.mjs` | FAIL — **기준 소스 `d87f1fc`의 원래 `authoring.html`로도 같은 지점(‘강의가 확정되었습니다’ 대기)에서 실패**. 이 변경과 무관한 기존 실패로 분리해 둔다 |
| `e2e/classroom/ui-review-capture.mjs`(아래 캡처) | PASS — 12장 모두 가로 넘침 없음·페이지에 토큰 없음, 1280×720 첫 학생 행 434px, 연결 뒤 폼 접힘, Esc 후 포커스 복귀(C1), 취소 후 작성 내용·선택 유지, 비선택 A2 배포 대상 아님, 1024×700·200%(720×450, DSF 2)·390 drawer `fixed`·주요 CTA 1개 |

기존 시험 갱신은 1건: `ops-roster.mjs`의 합쳐진 목록 안내 문구(패널 이름 `이번 수업 학생`, 위치 ‘위’ — 이전 문구는 아래에 있지 않은 패널을 ‘아래’라고 했다). 의미(한 목록, 명단 밖 학생만 옛 패널에)는 같다.

캡처: `.git/remote-classroom-evidence/management-20260921/instructor-ui-review/after/`(`index.html`·`manifest.json`·`capture-facts.json`).
합성 미리보기 `e2e/classroom/ui-review-preview.mjs`(127.0.0.1:18951) — 24석 합성, 연결 좌석은 실제 기기 클라이언트 코드가 같은 프로세스에서 동작,
배포 실패는 합성 디스크 거부, 회수 실패는 합성 `nothing_recorded`. 각 캡처의 ‘합성 데이터’ 표식은 캡처 스크립트가 붙인 것이다.

NOT RUN: 실제 강사 사용 관측·실제 Studio 창·Windows·학교망·staging/production·실제 학생 자료·메일, 브라우저 확대 기능 자체(200%는
viewport 축소 + DSF 2로 근사), 스크린리더 실사용. `/authoring`·`/console`·`/issuer`·`/budgets`는 연결 전 첫 화면만 캡처했다.

<a id="instructor-ui-pass2-run-20260922"></a>

### 강사 UI 2차 보완 — 실행 기록 · 2026-09-22 (로컬 · 조작 결함 4건 · 인수 아님)

설계·범위: [2차 보완](../requirements/classroom-design.md#instructor-ui-pass2-20260922). 브랜치 `feat/751-instructor-ui-pass`, 시작 `1ea0f31`.
U4 브랜치는 병합하지 않았다 — 재발급 링크 규칙만 U4 `9b0c643`과 같은 코드로 옮겼다(통합 시 같은 줄이 겹친다). Mac arm64 · Playwright Chromium · 합성 계정만.

| 검사 | 결과 |
|---|---|
| `npm --prefix chalk test` · `npm --prefix chalk run typecheck` | PASS · PASS (정적 계약의 버튼 문구 `준비 확인` → `현황 새로 확인`·`도움 요청 응대`) |
| `e2e/classroom/ops-help.mjs` (신규, `test:classroom-ops-help`, CI 단계 추가) | PASS — 잘못된 토큰: 명단 영역이 ‘강사 인증이 거부돼 … 불러오지 않았습니다’, 목록·집계 없음 · 운영 권한 없는 토큰: 상단 ‘연결됨’ + 명단 영역 ‘원격 운영 권한이 없습니다’ · 올바른 토큰: 버튼 없이 10석 로드, ‘연결하지 않았습니다’ 없음, 미연결 A3·무신호 A4는 `확인 불가`(정상 4 ≠ 10) · 도움 요청: 이번 수업 `접수`(A2)·`검토 중`(A4)만 목록·집계·선택 대상, 답변함(A8)·해결(A9)·철회(A10)·만료·다른 수업·결과물 제출 제외 · 선택 `A2, A4` vs 기술 문제 `A1, A5, A6, A7` · 첫 조치: A1 토큰 거부 → `/authoring` 재발급 링크(새 탭, 강의 버전 유지, 주요 버튼 색·44px), 진단은 보조 · A3 미연결 → `기기 연결` 묶음 맨 위·연결 코드 발급 · A6 공통 장애(3/10석) → 상세 주요 CTA 0 · ‘2 수업 진행 › 도움 요청 응대’ 이동 후 상세·질문 초안·선택·연결 유지, 상세를 닫았다 열어도 질문 초안 유지, 공유 피드백 초안은 갱신 뒤에도 유지 · 학생 철회 → 목록·집계·열린 기록에서 빠짐 · 다른 수업 개설 → 옛 명단·도움 목록 비움, 옛 요청은 ‘다른 수업의 기록’ · 390px 가로 넘침 없음 |
| 대조군 | 같은 시험을 `1ea0f31`의 `manage.html`로 돌리면 첫 단언(인증 거부 시 명단 영역 문구)에서 FAIL |
| `ops.mjs` · `ops-roster.mjs` 갱신 후, `run.mjs` · `ops-selection.mjs` · `ops-distribution.mjs` · `ops-lesson-settings.mjs` · `e2e/access-budgets/browser.mjs` · `e2e/chalk-authoring/run.mjs` | 8개 PASS |
| `e2e/classroom/ui-review-capture-pass2.mjs` (아래 캡처) | PASS — 10장 가로 넘침 없음·토큰 없음·주요 CTA ≤1, 390px에서 ‘도움 요청 응대’ 링크가 화면 안 |

기존 시험 갱신(기대가 바로 이번 결함이던 곳): `ops.mjs` — A1(토큰 거부)의 주요 버튼 기대 ‘진단 다시 실행’ → 재발급 링크, 증거 링크 `/issuer` → `/authoring`(U4 `9b0c643`과 같은 단언),
목록 주요 버튼 ‘도움 필요한 학생 선택’ → ‘기술 문제 좌석 선택 (장애 1 · 주의 0)’, 묶음 선택 버튼 `#ops-select-help` → `#ops-select-fault`.
`ops-roster.mjs` — S03(9석 공통 장애)의 서랍 주요 버튼 기대 ‘진단 다시 실행’ → 없음(Service `none_shared_incident`), 묶음 선택 `ops-select-help` → `ops-select-fault`.
두 파일의 `button.primary` 셈은 링크도 세도록 `.primary`로 바꿨다.

작업 중 발견해 고친 것: 첫 캡처에서 재발급 링크가 어두운 바탕에 어두운 글자였다(주요 버튼 색이 `button.primary`에만 걸려 있었음). 링크에도 같은 색을 주고 `ops-help.mjs`에 색·높이 단언을 넣었다.

캡처: `.git/remote-classroom-evidence/management-20260921/instructor-ui-review/pass2/`(`index.html`·`manifest.json`·`capture-facts.json`, 1차 `after/`·`codex/`는 그대로).
합성 미리보기 `ui-review-preview.mjs`에 도움 요청 상태(열림 B2·C2·C6, 답변 A5, 해결 A6, 철회 B1, 만료 B3, 다른 수업 B4)를 추가했다. 이 미리보기에서 C3~C5의 공급자 장애는 3/24석이라
공통 장애 기준(30%) 아래이고, Service는 ‘진단 다시 실행’을 첫 조치로 준다 — 캡처 P2-06은 그 상태이며, 기준 이상(개별 첫 조치 없음)은 `ops-help.mjs`가 시험한다.

미충족·범위 밖: 학생 Studio 안에서 도움 요청을 보내는 입구(현재는 웹 `/sharing`)와 U1b·AT-41 통합은 이번 범위가 아니다. 도움 요청 판정은 기존 공유 metadata만 쓰며 새 API·저장소는 없다.
NOT RUN: 실제 강사 사용 관측·실제 Studio 창·실제 학생·Windows·학교망·staging/production·메일, 스크린리더 실사용, 브라우저 확대 기능 자체,
`mac-*.mjs`(실제 Mac 창 — 이 작업은 Studio GUI·18841/18842/9441을 쓰지 않는다), 전체 빌드. 사용자 시각 피드백 전이며 디자인 승인·인수가 아니다.
