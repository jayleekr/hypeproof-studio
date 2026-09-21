# 강사·플랫폼 관리자 콘솔 요구사항

상태: 채택한 구현 목표. 개별 완료 범위는 하단 구현표를 따른다.
검토일: 2026-09-07 · 추적: #732.
범위: Chalk 강사 콘솔, Service 운영자 콘솔, Studio 학생의 선택적 공유.
기존 [수업 작성 요구사항](chalk-authoring.md), [행동 계약](../studio-requirements.md)을 확장한다.
교육 에셋의 정의는 [seven-assets](../seven-assets.md)에 위임한다.

## 역할과 열람 경계

강사는 자기 코호트·프로필의 수업을 운영한다. 플랫폼 관리자는 기존 운영자 인증으로
계정·사용량·장애를 관리한다. 운영 권한 자체가 모든 대화 원문 접근 권한은 아니다.
기존 board는 계속 metadata-only이며 기존 studio-logs의 operator-only 계약도 유지한다.

공유 모드는 (1) 기본 운영 메타데이터 (2) 학생이 선택한 기록 공유
(3) 별도 동의·계약이 필요한 수업 관찰 모드로 구분한다.
기존 구현은 (2)이며 전체 세션 자동 수집이나 과거 로그 재공개를 포함하지 않는다.
2026-09-18 원격 운영·수집 확장 설계는 아래 별도 절에 있으며 아직 활성화하지 않았다.
관찰 모드는 구현 목표이고 아직 활성화하지 않는다. 아동 공유는 검증된 보호자 동의
계약이 마련되기 전 서버에서 거부한다. 기존 profile의 단순 동의 주장으로 해제하지 않는다.

## Acceptance requirements

| ID | 요구사항 및 관측 가능한 인수 기준 | 우선순위 |
|---|---|---|
| ADM-01 | 강사·학생·기수·수업을 초대·배정·종료한다. 서버가 역할·코호트·프로필 범위를 강제하며 다른 수업 데이터는 불변이다. | P0 |
| ADM-02 | 수업 전체 학생의 단계·최근 활동·제출·도움 요청을 표시한다. 명단 범위와 갱신 시각을 명시하며 무신호는 확인 불가로 표시한다. | P0 |
| ADM-03 | 공유 허용된 학생 프롬프트·응답·시각·수업 단계를 담당 강사가 조회한다. 학생에게 공유 대상·내용·기한이 보이며 수업 밖 기록은 제외한다. | P0 |
| ADM-04 | 질문에 연결된 도구 실행·오류·파일 변경 근거를 표시한다. 학생이 선택한 요약과 자동 관측 사실을 구분하며 비밀은 가린다. | P0 |
| ADM-05 | 학생이 특정 대화·결과물을 선택해 도움을 요청하고 강사가 피드백·다음 조치를 남긴다. 저장 충돌 시 입력을 보존하고 해결은 학생이 확인한다. | P0 |
| ADM-06 | 결과물과 변경 이유·검수 기록·도움 사용 범위를 함께 검토한다. URL을 서버가 임의 실행하거나 결과물 제출만으로 합격시키지 않는다. | P0 |
| ADM-07 | 담당자·코호트·프로필·기록별 공유 권한을 서버에서 검증한다. 열람 이력 기록 실패 시 원문을 내보내지 않고 철회·만료·폐기된 자격은 거부한다. | P0 |
| ADM-08 | 학생·수업별 요청·토큰·비용·오류를 표시하고 예산을 설정한다. 가격/사용량 미확인은 0으로 표시하지 않으며 동시 요청에도 정한 예산 정책을 지킨다. | P1 |
| ADM-09 | 반복 오류·긴 대기·미진행 신호와 판정 근거를 표시한다. 임계값은 검증 가능한 근거를 가지며 프롬프트 수로 능력 점수를 만들지 않는다. | P1 |
| ADM-10 | 권한 있는 강사가 참여 열기·닫기·새 실행 일시정지·재개를 수행한다. 적용 범위·실행 중 작업 영향·복구 방법을 확인하고 학생 파일을 보존한다. | P0 |
| ADM-11 | 강의·모델·도구·설정의 적용 버전과 변경 영향을 표시한다. 진행 수업을 조용히 바꾸지 않으며 서버의 정책 권한을 강의 문구로 확대하지 않는다. | P0 |
| ADM-12 | 기능 요청·장애를 수업과 연결해 접수하고 담당자·상태·분류·다음 조치·일정 또는 미정 사유를 관리한다. 요청자의 실제 해결 확인을 기록한다. | P1 |
| ADM-13 | 수업 종료 리포트에 완료·미완료·도움 사용·주요 오류와 근거·미측정 범위를 표시한다. 메타데이터 보고서에 대화 원문을 자동 포함하지 않는다. | P1 |
| ADM-14 | 공유 기록의 보관·열람 기한을 표시하고 학생의 철회·만료·삭제를 적용한다. 원문과 연결된 감사 기록의 삭제를 검사하며 기존 로그 정책을 변경하지 않는다. | P0 |

## 공유 계약 — hps-classroom-share/1

Service 소유의 별도 D1 테이블 `classroom_shares`, `classroom_share_audit`를 사용한다.
Chalk는 HTTP 전달과 표시만 맡으며 KV/D1/R2에 직접 쓰지 않는다.

- 학생: `/v1/classroom/shares` GET/POST, `/:id` DELETE, `/:id/confirm` POST, `/:id/audit` GET.
- 강사: `/admin/cohorts/:cohort/classroom/shares` GET, `/:id` GET/PUT.
- 신원은 검증된 토큰에서 가져온다. 학생 입력의 수업·학생 ID로 덮어쓰지 않는다.
- 제출은 열린 동일 프로필 수업의 명단에 있는 성인 학생만 가능하다. 읽기·철회·확인은 수업 종료 후에도 토큰 유효 기간 안에서 가능하다.
- 수신 강사 ID를 학생이 명시한다. 강사는 토큰의 subject와 정확히 일치하는 수신 기록만 읽는다. 같은 코호트의 다른 강사도 접근할 수 없다.
- 공유 필드: prompt, response, tool_summary, artifact_url, verification. 학생이 선택해 붙여넣은 기록이며 자동 검증된 실행 로그가 아니다.
- 열람 기한은 학생 선택 5분~24시간과 학생 토큰 만료 중 이른 시각이다. UI 기본값 1시간. 서버 읽기는 만료 즉시 차단하고 기존 15분 cron에서 새 공유 테이블의 만료 행만 삭제한다. cron 실패는 로그에 남기며 물리 삭제 시각을 만료 시각과 동일하다고 표현하지 않는다.
- 삭제는 자기 공유만 가능하며 연결된 감사 기록도 삭제한다. 이미 보거나 내려받은 사본은 회수할 수 없다고 안내한다.
- 요청 ID는 중복 제출을 식별한다. 동일 ID의 다른 내용은 409. feedback은 revision CAS. 강사는 answered까지, 학생만 resolved로 전이시킨다.
- 원문 목록 조회는 없다. 강사 목록은 메타데이터이며 개별 열람 시 감사 쓰기 성공 후 내용을 반환한다. API는 no-store, 클라이언트 토큰은 메모리 전용이다.
- 자동 관찰·학생 파일 원격 수정·아동 동의·전체 세션 보존은 이 계약으로 허용하지 않는다.

## 구현 범위와 후속 작업

| 요구사항 | 이 변경의 범위 | 남은 인수 기준 |
|---|---|---|
| ADM-01 | 기존 console/issuer 진입 재사용 | 통합 명단 편집·배정 및 전체 권한별 실기 검증 |
| ADM-02 | 기존 board 기반 관리 화면, 전체 명단 범위 경고, 공유 요청 목록 | 강의 단계·제출 상태를 수업 설계 버전과 연결 |
| ADM-03/04 | 성인 학생의 선택적 프롬프트·응답·실행 요약 공유 | Studio 안의 선택 UI, 원래 턴/도구 ID 연결, 별도 관찰 모드 |
| ADM-05/07/14 | 공유·피드백·학생 해결 확인·권한·열람 이력·철회·만료 API | 실제 기기/운영 D1 검증, 계정 만료 후 삭제 지원 운영 절차 |
| ADM-06 | 결과물 URL·검수 기록 제출 | 도움 사용 범위의 구조화된 평가와 위치별 피드백 |
| ADM-08 | 기존 운영자 사용량 페이지 유지 | 강사용 비용 집계·예산 정책과 동시성 검증 |
| ADM-09 | 기존 보드의 검증된 상태·임계값 재사용 | 새 신호의 근거 데이터 및 오탐 평가 |
| ADM-10 | 기존 수업 열기·종료로 연결 | 강사용 일시정지 범위/진행 작업 보존 계약 |
| ADM-11 | 기존 authoring 버전 화면 연결 | 진행 수업·모델·도구 고정 및 변경 영향 |
| ADM-12 | 기존 GitHub 요청 초안 유지 | 실제 내부 접수 큐·담당·상태·해결 확인 |
| ADM-13 | 메타데이터 JSON 내려받기 | 강의 단계·독립 과제 평가와 연결된 종료 리포트 |

표의 구현 범위는 전체 ADM 합격을 의미하지 않는다. [테스트 계획](../testing/classroom-admin.md)과
[디자인 요구사항](classroom-design.md)을 함께 검토한다. 전면 자동 모니터링은 이 기능과 별도다.

## 출시·제거

마이그레이션 0003은 기존 테이블을 수정하지 않는 추가 스키마다. 운영 적용은 기존
deploy-worker의 live-session freeze를 통과한 뒤 정확한 파일만 적용한다. Service 배포와
Chalk 배포는 별도이며 웹 PRD 배포를 제품 API 배포로 세지 않는다.
롤백 시 두 라우트 mount와 두 HTML 진입을 제거하고 신규 기록 제출을 닫는다.
이미 수집한 신규 공유 데이터는 정해진 만료 정리를 유지한 뒤 테이블 제거를 별도 결정한다.
기존 session logs, board, instructor authorization을 삭제·완화하지 않는다.

## 원격 수업 운영 확장 설계 · 2026-09-18

상태: **설계 채택 · R0~R7 구현 + 2026-09-19 독립 검토 결함(F1~F7) 수정·미완 기능 보강 · 운영 비활성**(2026-09-19, 아래 ‘검토 반영으로 확정한 계약’). 구현은 전역 스위치 `HPS_CLASSROOM_OPS`와 회차별 flag 5개가 모두 기본 OFF이며 production에는 설정·migration·발신 계정 어느 것도 적용하지 않았다. 실행된 검증과 NOT RUN 범위는 [테스트 문서의 실행 기록](../testing/classroom-admin.md#원격-운영-실행-기록)이 정본이다. 위의 기존 공유 구현과 구분한다. 원격 관제·일괄 수집·보고서 발송은 이 문서나 코드 병합만으로 켜지지 않는다. 기준 소스는 `75fe6e46f1a47c43ec3db6276b4b690abf5c0e2a`(2026-09-16 main), 조사일은 2026-09-18이다. 기존 E5 [#751](https://github.com/jayleekr/hypeproof-studio/issues/751), 콘솔 [#732](https://github.com/jayleekr/hypeproof-studio/issues/732), 복구 #673, 세션 #647, 공통 측정 #1020에 연결한다. 새로운 독립 제품·별도 인증 체계를 만들지 않는다.

### 목표와 범위

강사가 수업 중 자리를 돌아다니지 않고 **누가 들어오지 못했는지 → 어느 단계에서 무엇 때문에 막혔는지 → 어떤 조치가 실제로 끝났는지** 확인한다. 종료 시 하나의 배치에서 기록 회수·평가 초안·검수·발송까지 추적한다. 운영 성공은 학습 효과와 별도로 측정한다.

Product Intent의 최소 개입, 사람의 판단 보존, 근거 우선에 따른다. 원격 조치는 학습자의 판단이나 결과물을 대신 완성하지 않는다. 기존 ADM-01~14를 아래 세부 계약으로 확장하며 새 점수 체계를 만들지 않는다.

| 사용자 요구 | 기존 요구와 확장 | 인수 근거 |
|---|---|---|
| 토큰 발급부터 활성화 확인 | ADM-01/02/07/11: 등록·발급·검증·수업 진입·런타임 준비를 각각 표시 | AT-15/16/23 |
| 각 학생의 현재 단계와 빨간 오류 | ADM-02/04/09: 수업 버전에 연결된 단계, 오류 원인, 마지막 신호와 관측 범위 | AT-17/18/25 |
| 원격으로 초기화·문제 해결 | ADM-05/07/10: 허용 명령·대상 사전조건·보존·결과 영수증 | AT-19~24 |
| 한 번에 프롬프트 수집·평가지 생성·전달 | ADM-03/06/07/13/14: 권한 있는 수집 배치, 검증된 입력, 개별 평가/수신자/발송 상태 | AT-26~31 |
| 기존 프로그램 정상 작동 | ADM-08/11: 구버전 호환·관제 장애 격리·단계 배포·회귀 검증 | AT-24/25/32~34 |

P0는 Studio 앱의 상태와 제한된 조치를 다룬다. 전체 PC 화면 썸네일, 키보드·마우스 탈취, OS 재부팅, 임의 셸·파일 원격 수정은 P2 선택 기능이다. 앱이 설치되지 않았거나 extension host가 죽은 PC는 이 채널로 복구할 수 없다. 보드에 현장 조치 필요를 표시하고, 학교가 이미 운용하는 원격 지원 도구를 별도 절차로 이용한다.

### 기존 구현에서 출발할 지점

| 현재 소스 | 확인한 동작 | 확장 지점 / 지켜야 할 경계 |
|---|---|---|
| `chalk/src/routes/board.ts`, `src/lib/board-verdict.ts`, `src/ui/board.html`, `manage.html` | 10초 polling, 명단·호출·대기·무신호, metadata-only | 동일 화면의 학생 행/상세 패널 확장. 원문 미리보기를 보드에 넣지 않음 |
| `worker/src/lib/instructor-auth.ts`, `tokens.ts`, `routes/admin.ts` | issuer scope, 발급·명단·수업 열기/종료. pause는 현재 일반 issuer 허용 목록에 없음 | 기존 검증기를 재사용하고 명시적인 operations capability를 추가. 기존 issuer 전체에 새 권한 자동 부여 금지 |
| `extensions/hypeproof-chat/src/heartbeat.ts`, `chatPanelProvider.ts`; `worker/src/routes/trace.ts`, `lib/liveness.ts` | 45초 heartbeat, 서버 시각·idle 관측, KV 900초 TTL. 기존 trace는 활성 수업·명단 gate를 거침 | 수업 전 연결 진단과 정밀 명령에는 별도 operations 경로가 필요. 기존 trace 응답 성공은 저장·명령 완료 증거가 아님 |
| `activityConnections.ts`, `worker/src/lib/lesson-delivery.ts`, `modules.ts` | 활동 신원·작업 폴더·수업 설정/버전 전달 | 활동·수업 실행·앱 실행 ID를 분리하고 확정 수업 버전의 step ID에 단계 이벤트 연결 |
| `sessionSpool.ts`, `spoolUploader.ts`, `extension.ts`; `worker/src/routes/logs.ts` | 로컬 스풀, 본인 세션만 전송, manifest, 수동 업로드·재기동 안내·갤러리 시점 snapshot | 자동 수집은 새 고지/권한 계약으로 구현. 진행 snapshot과 완결 manifest를 혼동하지 않음 |
| `chalk/src/routes/logs-admin.ts` | 로그 도착 메타데이터, 원문 operator-only | 강사 원격 수집 요청이 원문 조회 권한을 부여하지 않음 |
| `chatPanelProvider.ts:clearHistory()` | 로컬 확인 후 대화를 지우는 동작. 활성 작업 중 거부 | 원격 초기화에서 직접 호출하지 않음. 작업 보존형 runtime reset을 별도로 구현 |
| `worker/src/lib/measurement-core/`, `packages/measurement/`, `skills/hain7-report/` | 공통 관찰/근거/해석 코어, host package, legacy HAIN7 보고서 | 신·구 평가 모델을 분리해 재사용. 자동 발송 어댑터는 미구현 |

소스 구현, 실제 설치 버전, 운영 활성화는 다른 상태다. GitHub 최신 release API는 `measurement-v0.3.1`을 반환하지만 데스크톱 앱 release는 별도로 `v0.1.56`이다(2026-09-18 확인). extension `package.json`의 `0.1.5`만으로 설치 앱 기능을 판단하지 말고 App release/build hash·extension hash·operations protocol/capability를 보고한다.

### 실수업·장애 근거와 해석

수업 기록의 분석 단위는 class run이다. 누적 cohort 명단·발급 좌석·실제 출석·로그 도착·보고서 수신자는 서로 다른 모수다. 도착 로그만 보면 시작조차 못한 학생을 놓친다. 과거 오류가 현재도 발생한다고 단정하지 않고, 코드 수정 여부와 실기 인수 여부를 나눈다.

| 근거 집합 | 재집계 결과 | 원격 운영에 필요한 개선 |
|---|---|---|
| 실제 오전 D1 고정본 `chalk/test/fixtures/session-2026-08-22.json` | 2,928 호출행 / 명단 15좌석 / 관측 13좌석. 2좌석은 0행. 정상9·quiet2·stuck1·미접속 라벨2·중도이탈1 | 호출한 학생만 보여주지 않음. 등록/검증/진입 단계와 생존 신호를 따로 수집. 0행의 원인을 토큰 오류로 단정하지 않음 |
| 같은 D1 고정본 | status 전부 200, latency 중앙값 4.996초·최대283.525초 | 과거 #684가 실패행 누락/200 상수였으므로 서버 오류율 산출 불가. 최신 소스는 실패 상태 기록을 보완했으며 이번 Worker 회귀 통과. 운영 배포/신호 적용 시점은 미확인 |
| 기존 `chalk/README.md`의 2026-09-03 R2 도착 조사 + fixture 라벨 교차 | 오전 9/15 도착, 6누락 중 정상1·quiet1·stuck1·미접속2·중도이탈1 | 수동 전송만으로는 장애/이탈 집단의 증거가 빠짐. 현재 R2를 새로 조회한 수치가 아니라 저장소의 당시 조사 기록. 회수 불가도 배치 명단에 남김 |
| 로컬 비공개 Supabase mirror 회수본(8/22 하루, 오전·오후 포함) | 22개 가명 사용자·34개 앱 세션·11,791 이벤트. prompt991/response971/turn_end985. 종료 ok932/aborted51/error2(stall) | 취소와 오류, 미완 턴을 구분. 응답/end 두 이벤트의 오류를 두 번 집계하지 않음. 수집된 사용자만의 집합이며 오전15명/공식21명과 모수가 다름 |
| 같은 회수본의 연속성 | prompt만 있는 턴6. 10/22 사용자가 2~3세션, 추가 세션12 | app_instance/previous_session/종료 사유/seq/receipt 필요. 다중 세션을 crash12회 또는 네트워크 재접속12회라고 부르지 않음 |
| manifest 대조 | meta34/manifest34/events33. 33세션 byte·SHA-256 일치, 1세션 선언 events 결손. 그 사용자는 공식21명 병합 대상 밖 | manifest 존재≠완결. 해당 R2 정본까지 없는지 미확인. 현재 mirror가 best-effort라 미러 누락 가능성은 가설. 입력 complete 검증과 source별 상태 분리 |
| 비공개 공식 보고서/검수표 | 공식21명 PDF·병합 대응, 비발송 참고1. 2부13명×28marker 검수 기록. 실제 메일 전달/반송 미확인 | 생성/검수/예약/전송/전달을 별도 상태로. 고객 원본 명단을 수신자 정본으로 유지 |
| 현재 `reportProblem.ts` | `REPORT_VERSION="0.1.2"` 상수, extension package `0.1.5`와 불일치 | R1에서 실제 package/build 버전과 신고 메타를 연결. 신고가 없다고 오류가 없었다고 읽지 않음 |

재현: 원본과 파생본은 운영자의 로컬 비공개 보관함에만 있으며 그 경로는 저장소에 남기지 않는다. repository에는 원문·학생별 식별자·연락처·평가값을 복제하지 않았다. 고정 파일명만 순회해 event type/turn_id/status/시각과 manifest byte/hash를 집계했고, 본문을 화면에 출력하거나 실행하지 않았다. 로컬 인수인계용 재현 스크립트·집계 JSON은 Git 비추적 metadata의 `remote-classroom-evidence/`에 보존한다. 다른 기기에서는 원본 접근 권한이 있어야 재집계 가능하다.

D1 fixture SHA-256: `4e20b7bc59d5d7356f5c5288b90e49cadd64f53266096b4a532b40fd838d5952`.

기존 보드의 idle/평균대기 임계값은 `chalk/src/lib/board-verdict.ts`의 실수업 라벨 replay에서 유도됐다. 같은 파일은 정상 라벨에서도 75분간 약5개의 quiet 경보가 발생했음을 기록한다. 고정 임계값을 새 수업/교육 방식에 무조건 적용하지 않으며 교사 휴식·읽는 시간·승인대기를 반영해 오탐을 측정한다. 과거의 실제 장애, 현재 소스 수정, 아직 실행하지 않은 실기 인수는 별개의 증거다.

### 비교 조사와 선택 근거

학교·PC방 관리 프로그램에서 가져올 것은 전체 좌석판, 여러 대상 선택, 준비 상태, 도움 요청, 조치 결과, 파일 회수라는 운영 흐름이다. 데스크톱 영상을 수집해도 Studio의 토큰·단계·보고서 완결 여부는 알 수 없으므로 앱 이벤트가 정본이어야 한다.

공식 자료에서 작동 구조까지 확인한 것은 A, 공식 소개·FAQ에서 기능 존재만 확인한 것은 B, 미공개는 확인 불가로 구분했다. 모두 2026-09-18 조회. 상용 견적을 추정하거나 도입·설치하지 않았다.

| 사례 | 확인한 구조·특징 | Studio에 연결할 원칙 / 선택 |
|---|---|---|
| [Veyon GitHub](https://github.com/veyon/veyon), [구조](https://docs.veyon.io/en/latest/admin/introduction.html), [접근 제어](https://docs.veyon.io/en/latest/admin/configuration.html) — A | 교사 Master→학생 Service/Server, VNC 화면, 인증 후 접근 규칙; Windows/Linux, GPL-2.0 | 전체 좌석·보기/제어 분리·기기별 사유. 같은 LAN 컴퓨터실의 별도 지원 도구 후보이며 Studio에 코드를 섞어 배포하지 않음 |
| NetSupport School [구성](https://help.netsupportschool.com/en-windows/Content/Windows/Installation/select_installation_type.html), [학생 승인](https://help.netsupportschool.com/en-windows/Content/Windows/Settings/student_security_settings.html), [Journal](https://help.netsupportschool.com/en-windows/Content/Windows/Using-tutor/student_journal.html) — A | Student/Tutor/Tech Console, 선택 Gateway, 수업용·IT용 권한 분리, 학생별 수업 PDF | 강사 허용 조치와 고권한 장비 관리 분리. 보고서에 출석/과정/부분 기록 포함. 장치 단위 견적제여서 기존 설치가 있을 때 활용 |
| LanSchool [Classic setup](https://helpdesk.lanschool.com/portal/en/kb/articles/lanschool-classic-setup-guide), [원격제어](https://helpdesk.lanschool.com/portal/en/kb/articles/remote-controlling-student-devices), [Air](https://lanschool.com/solutions/lanschool-air) — A/B | Classic의 Teacher/Student와 LCS, Air의 클라우드 교실. Classic 원격입력과 Air 모니터링은 같은 기능 범위가 아님 | 수업별 그룹·재연결·마지막 관측 시각. 인터넷/BYOD와 관리 LAN을 구분. Air 원격 키보드·마우스 지원은 확인 불가 |
| [게토](https://www.geto.co.kr/Product/program), [피카 FAQ](https://www.pcbang.com/_support/faq.jsp), [피카AI](https://www.pcbang.com/_picaAI/picaAI.jsp) — B | 카운터/손님 PC 구분, 좌석·다매장·이상징후·복구/운영 보고서 | 좌석 상태판·선택/전체 조치·장애 처리 이력 UX 참고. 화면 프로토콜/암호화/권한·정확한 가격은 공개 확인 불가이므로 기술 기반으로 채택하지 않음 |
| [MeshCentral GitHub](https://github.com/Ylianst/MeshCentral), [공식 문서](https://docs.meshcentral.com/meshcentral/) — A | outbound agent/web 관리, 데스크톱·터미널·파일, Apache-2.0 | 기관 소유 장치의 별도 비상 지원 후보. MFA/장비 그룹/시간 제한/동의 필요. 고권한 agent를 P0에 번들하지 않음 |
| [RustDesk server](https://github.com/rustdesk/rustdesk-server), [구조·OSS/Pro](https://rustdesk.com/docs/en/self-host/) — A | hbbs rendezvous/ID, hbbr relay, NAT 직접 연결 실패 시 릴레이; AGPL-3.0 | 일대일 화면 지원 후보. 중앙 장비 관리·SSO 등 Pro 차이, 릴레이 운영비와 재배포 조건 검토. 자체 앱 이벤트를 대체하지 못함 |
| [Apache Guacamole](https://guacamole.apache.org/doc/gug/guacamole-architecture.html), [GitHub](https://github.com/apache/guacamole-client) — A | 브라우저→웹 게이트웨이→guacd→RDP/VNC/SSH, Apache-2.0 | 이미 기관 VPN/RDP/VNC가 있는 경우. NAT 뒤 개인 PC 접근 경로까지 자동 해결하지 않아 신규 도입 우선순위 낮음 |

[NetSupport 견적](https://www.netsupportschool.com/pricing/), [LanSchool 구매](https://lanschool.com/purchasing)는 금액 비공개, Veyon core는 무료지만 [애드온](https://veyon.io/en/addons/)은 유료다. 오픈소스도 설치·업데이트·권한 관리·릴레이 대역폭 비용은 남는다. 라이선스 표시는 저장소 기준이며 복사/수정/번들 배포 전에 해당 버전 조건을 확인한다.

선택 결론: **P0는 기존 App extension·Chalk·Service, 외부 화면 도구 도입 없음.** 원격 상태만으로 해결하지 못한 장애 비율과 현장 지원 시간을 첫 3회 수업에서 기록하고, 기존 학교 도구가 있는지 먼저 확인한 뒤 P2를 선택한다.

### 화면과 상태 계약

기존 `/manage`를 운영 진입점으로 유지한다. 상단은 선택 수업/버전·연결 시각·전체 명단·도움 필요/연결 미확인/기록 미도착 수, 본문은 학생 행, 오른쪽은 선택 학생의 근거와 허용 조치다. 첫 운영 버튼은 `준비 확인`, 수업 중은 `도움 필요한 학생`, 종료는 `수업 마무리`다. 매번 모든 화면을 보여주는 대형 관제 화면을 새로 만들지 않는다.

학생 행: `좌석/가명 · 입장 상태 · 현재 단계 · 수행 상태 · 마지막 신호 · 오류 원인 · 조치 상태 · 기록 도착`. 기본 보드에는 프롬프트·파일명·파일 본문·토큰을 넣지 않는다. 공유 원문은 기존 개별 열람·감사 계약 안의 별도 화면에서만 연다.

- 입장: `미등록 → 기기 연결 → 토큰 발급 → 앱에서 검증 → 수업 진입 → 준비 완료`. 발급 성공을 활성화로 표시하지 않는다. 토큰 원문 없이 발급 ID/만료·검증 결과만 표시한다.
- 단계: 확정 `lesson_version/step_id`와 `not_started/in_progress/submitted/reviewed`를 보고한다. 강의형·자유 과제는 단계 없음/자유 활동도 유효하다. 채팅 횟수, 창을 연 것, AI의 “완료” 발언으로 단계 완료를 추론하지 않는다.
- 수행: `idle/running/waiting_approval/waiting_user/error`와 관측 시각·출처를 분리한다. `waiting_approval`은 AI 실패가 아니다.
- 빨간색: 확인된 blocking error/실패한 명령. 반드시 짧은 한글 사유와 조치 버튼을 함께 표시한다. 긴 대기·조용한 학생은 주의 색, 오래된/없는 신호는 회색 `확인 불가`다. idle만으로 빨간 실패 판정하지 않는다.
- 오류 분류: 인증 거부, 수업 미개설/프로필 불일치/명단 누락, 비용 한도, 공급자 rate limit/5xx, 네트워크, SDK/도구 준비, 승인 대기, 검수 오류, 기록 전송, 미확인. HTTP 401만으로 토큰 만료를 단정하지 않는다. 안전한 코드·request ID·다음 행동만 노출한다.
- 여러 학생 같은 공급자 오류는 공통 장애 1건과 영향 인원으로 묶고, 개별 PC 초기화를 기본 추천하지 않는다. 수업 일시정지와 학교 휴식은 시간 기반 경보에 반영한다.
- bulk 선택은 전 좌석/현재 필터/선택 좌석의 차이를 보여준다. 명령별 가능·미지원·오프라인을 미리 산출하고 `23 성공 / 2 실패 / 5 확인 불가`처럼 결과를 남긴다. 제출·접수·완료를 한 체크 표시로 합치지 않는다.

### 신원과 수업 실행 계약

기존 cohort/profile/token/authoring를 정본으로 쓴다. `class_run_id`는 기존 `sessions.session_id`에 1:1 연결한 회차 ID다. 같은 cohort의 누적 roster를 재사용하되 새 `class_run_seats`는 **그 수업 명단의 불변 snapshot + 명시적 변경 revision**이다. 별도 학생 계정을 만들지 않는다. 좌석과 학생의 연결이 바뀌면 이력을 남기고 이전 학생 기록/명령을 새 사용자에게 넘기지 않는다.

토큰 입력 전 PC까지 확인하려면 먼저 연결이 필요하다. 강사가 기존 인증으로 회차·좌석에 묶인 일회용 pairing ticket을 발급하고 앱에서 입력/스캔한다(관리형 교실은 사전 등록). ticket은 제안 기본 10분·1회, 상태 보고/본인 명령 확인만 허용하며 AI·로그 원문 접근 권한이 없다. 미등록 PC는 보드에서 `등록 안 됨`이며 설치·방화벽 문제 원인은 아직 모른다. 익명 ping으로 학생 신원을 추정하지 않는다.

등록 후 operations connection은 기존 Service 서명/검증기로 발급한 별도 좁은 capability다. 학습 토큰이 거부돼도 안전한 진단은 가능하되 토큰 복구가 학생 자격·명단·동의를 우회하지 못한다. `cohort, profile, class_run, seat, device_registration, activity, connection_epoch`를 서버가 바인딩한다. machine GUID/MAC/사용자 OS 계정 같은 영구 지문을 수집할 필요가 없다. 공용 PC는 무작위 등록 ID와 활동별 연결을 사용한다.

- 동시에 열린 창은 `app_instance_id/boot_id`를 나눈다. 회차·좌석·activity별 실행 lease의 owner인 창만 변경 명령을 실행한다. 다른 창은 관측만 가능하다.
- 학생 토큰 재발급/회차 변경/기기 교체 때 epoch 증가, 옛 capability/명령·lease 무효화. 공유 PC 로그 회수는 원 소유자·회차·consent grant가 일치해야 한다.
- 권한: 강사는 배정 회차와 허용 action, 학생은 본인 상태/조치 고지/거절·중지, 운영자는 기존 운영 경로, 보고서 실행기는 특정 batch/job만. 운영자 자격을 학생 앱/Chalk에 전달하지 않는다.
- 새 grant와 명령 authority는 D1 primary에서 검사한다. 기존 token/issuer KV revocation만으로 즉시 폐기를 보장하지 않는다. operations credential은 중앙 `ops_grants` 상태·revision/만료·상위 issuer 폐기 연결을 매 poll/claim/ack/실행 직전 재검사한다. 폐기 endpoint는 새 operations grant 무효화와 원장 commit까지 성공해야 폐기 완료로 응답한다.
- 새 권한은 opt-in이다. metadata도 개인과 연결될 수 있으므로 metadata-only를 무조건 동의 불필요라는 법률 결론으로 사용하지 않는다.

### 전송·저장·비용을 줄이는 구조

```mermaid
flowchart LR
  App[Studio host: 관측 / 명령 실행 / 로컬 영수증] -->|외향 HTTPS 443| S[기존 Service: 인증 / 범위 / CAS]
  C[기존 Chalk manage / board] -->|기존 forwarder| S
  S --> D[(D1: 회차 / 상태 / 명령 / 작업 원장)]
  App -->|허용된 기록 / manifest| R[(기존 R2)]
  D --> Runner[제한된 보고서 runner]
  Runner --> Core[공통 측정 코어 / 별도 legacy HAIN7]
  Runner --> R
  D --> Send[검수·수신자 승인된 발송 adapter]
```

**첫 구현은 기존 HTTPS polling.** 새 `/v1/classroom/ops/sync`가 상태 차이·receipt를 받고 본인에게 유효한 명령만 반환한다. 수업 중 5초(±20% jitter), 준비 30초, 종료 60초를 잠정값으로 두고 Service가 범위 안에서 설정한다. fetch timeout 4초, single-flight, backoff 5→10→20→60초. 401은 연결 재검증, 403은 reason별 처리, 429는 Retry-After. 학교망에서 외향 443만 필요하며 인바운드 포트·학생 PC 서버·VNC를 추가하지 않는다.

새 기능을 협상한 클라이언트는 45초의 기존 생존 신호를 sync에 합쳐 중복 heartbeat를 끈다. 변화가 없으면 큰 상태 본문·DB 상태 쓰기를 생략한다. 오류/단계/명령 결과는 다음 sync 또는 즉시 전송한다. 기존 `/trace/event`와 기존 앱 경로는 계속 지원한다. 관제 전송은 학습 요청을 기다리게 하지 않으며 제한된 큐와 로그만 가진다.

D1은 명령·최신 상태·회차 명단·receipt의 정본, R2는 허용된 원본·보고서, 기존 KV liveness는 구버전 호환 표시용이다. KV는 다른 위치에 쓰기 반영이 60초 이상 늦을 수 있고 원자 연산에 부적합하므로 즉시 중지/명령 성공의 근거로 쓰지 않는다([공식 일관성 설명](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). 새 status/claim/authorization은 D1 primary 읽기, read replication 도입 시 Sessions API/bookmark로 적어도 읽기 후 쓰기 일관성을 확보한다([D1 설명](https://developers.cloudflare.com/d1/best-practices/read-replication/)).

추가 스키마 후보는 `class_run_seats`, `ops_grants`, `ops_device_connections`, `ops_latest_state`, `ops_commands`, `ops_command_receipts`, `ops_audit`, `classroom_report_jobs`, `classroom_report_deliveries`, `classroom_job_outbox`다. 기존 auth/session/access/usage 테이블과 동일 정보를 다시 소유하지 않는다. `usage_jobs`는 과금 원장이므로 보고서 작업 큐로 전용하지 않는다. 구현 전 기존 schema와 비교해 필요한 테이블만 추가한다. migration 번호는 착수 당시 다음 번호로 정하고 적용된 파일은 수정하지 않는다. `schema.sql` fresh 설치와 migration 누적 결과를 비교한다.

조회는 수업별 한 번의 명단+최신 상태 join, command는 `(class_run_id, seat_id, state, expires_at)` 인덱스, scope/고유키를 필수화한다. 기존 보드의 학생별 KV 조회와 누적 roster scan을 새 코드로 복제하지 않는다. 상태·명령 기록은 요금 `usage_log`에 넣지 않는다. 고빈도 정상 신호는 latest row에 합치고 단계/오류/조치 전이만 audit에 남긴다. 목적·보존 기간은 기존 정책과 별도로 운영자가 확정하기 전 production 수집을 켜지 않는다.

DO/WebSocket은 P0 선행 조건이 아니다. 100명 실측에서 polling 목표를 넘거나 동시 강사·반 수 증가로 DB가 병목이면 수업별 DO Hibernation+WS를 도입하고 HTTPS fallback을 유지한다. 전달 채널만 바뀌며 아래 idempotency/epoch/receipt 계약은 동일하다. 기존 KV 상태와 새 원장 사이에 양방향 정본을 만들지 않는다. [WS hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)과 [Queues at-least-once](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)를 참고하되 새 서비스는 필요가 측정될 때만 추가한다.

### API와 사건의 경계

아래 경로는 **제안 계약**이다. 기존 routes/forwarder/registry 안에 추가하고 새로운 인증 서버나 root API namespace를 만들지 않는다.

| 경로·역할 | 입력/출력 핵심 | 실패 계약 |
|---|---|---|
| `POST /admin/cohorts/:cohort/classroom/runs/:run/pairings` 강사 | 명단 좌석·revision → 1회 pairing ticket | 타 수업/권한 없음 거부, ticket/학생 token 로그 금지 |
| `POST /v1/classroom/ops/connect` 앱 | pairing ticket·무작위 instance → 좁은 grant·epoch·protocol capabilities | ticket 재사용/만료/서명/배정 불일치 거부 |
| `POST /v1/classroom/ops/sync` 앱 | sequence·bounded observations·receipts → ack cursor·본인 명령·poll_after_ms | body/배치 상한, 권한·revocation·schema 실패, 저장 실패면 ack 안 함 |
| `GET /admin/cohorts/:cohort/classroom/runs/:run/status` 강사 | run snapshot/last-seen/revision/source freshness | no-store, 타 scope 거부, 부분 데이터 explicit |
| `POST .../runs/:run/commands` 강사 | targets·action·expected_revision·idempotency key | 202 queued, 409 revision/payload 충돌, 제한량 초과 429 |
| `GET .../runs/:run/commands/:id` 강사 | 각 대상 상태·receipt·기한 | 모든 대상 완료 전 bulk 성공 금지 |
| `POST .../runs/:run/report-batches` 강사 | roster/input/policy revision·dry_run → batch ID | 정책 미비는 대상별 hold; 실행권한 없음은 전체 거부 |
| `POST .../report-batches/:id/approve` 검수 권한 | report/recipient/template/policy hash와 승인 범위 | 변경된 입력/수신자 409, 승인자/범위 audit |
| `POST .../report-batches/:id/deliver` 발송 권한 | 승인 revision·idempotency key | live account 미설정/승인 만료 차단, dry-run은 외부 send 0 |

`...`는 위와 같은 `/admin/cohorts/:cohort/classroom` prefix다. 별도 runner claim/result도 이 Service의 job별 capability 경계를 사용하고 Chalk는 forwarding만 한다. command receipt는 `/ops/sync`를 통해 반환하며 실제 action 성공과 observation fresh 상태를 각각 노출한다.

관측 envelope는 `schema_version, event_id, class_run_id, activity_id, app_instance_id, boot_id, seq, observed_at, kind, bounded_payload`다. 서버가 identity·received_at을 추가한다. 종류는 activation/step/runtime/error/upload/command_result로 allowlist, raw prompt/stack/filename을 허용하지 않는다. actor는 human/AI/tool/operator/system/unknown을 보존한다. `(grant_id, boot_id, seq)` unique와 payload hash로 재전송을 대조하며 같은 seq의 다른 payload는 격리한다. ack는 highest **contiguous** seq와 missing ranges, 최신 상태는 단조 revision으로 갱신한다. 역순 수신을 최신으로 덮지 않는다.

로컬 outbox는 수업·학생 단위 분리, 재기동에도 유지, bounded batch(초기 100 events/64KiB 제안), 중요한 전이/receipt는 ack 전 삭제하지 않는다. 정상 heartbeat는 durable event seq를 소비하지 않는 별도 latest-state 샘플이며, 합쳐 보낼 때 durable seq에 구멍을 만들지 않는다. 오래된 정상 heartbeat만 합칠 수 있고 축약 여부를 표시한다. seq gap이 있는 로그를 완전 평가 입력으로 승격하지 않는다. 큐 상한에 닿으면 원본을 조용히 버리지 않고 관측 중단/누락 범위와 현장 조치를 알린다.

### 명령·초기화의 정확성

허용 action의 서버·클라이언트 schema를 공유하고 버전으로 고정한다. 임의 shell, URL 다운로드 후 실행, 임의 VS Code command, 파일 경로는 받지 않는다. 새 명령을 모르는 앱은 `unsupported`로 답한다.

| 조치 | 전제·보존 | 성공 근거 |
|---|---|---|
| `refresh_connection` | 현재 activity/회차 유지. 재발급은 기존 발급 권한·범위·예산 한도 재검사. 토큰은 해당 기기에만 전달하고 원장에 기록하지 않음 | 새 profile 검증과 runtime probe 완료; 발급만으로 성공 아님 |
| `retry_diagnostics` | 허용된 메타데이터만. 원문·shell 없음 | bounded probe 결과 코드와 발생 시각 |
| `restart_preview` | 기존 해당 activity preview만 재연결. 파일 변경 없음 | 같은 artifact revision의 로컬 HTTP/preview 상태 확인 |
| `cancel_current_run` | 본인 runtime abort와 pending tool 종료 확인. 이미 일어난 외부 효과는 되돌리지 않음 | abort 요청/실제 종료를 분리. 종료 미확인이면 다음 실행 차단 |
| `reset_runtime` | 1명씩 기본. 입력 동결→현재 작업 중지 확인→대화·draft·활동 binding·스풀 durable 보존→새 execution generation 생성→동일 파일로 runtime 재연결 | 보존 manifest와 이전/새 generation·profile probe. 저장/중지 실패는 실행 거부 |
| `retry_evidence_upload` | 해당 학생·회차의 유효한 수집 grant, immutable snapshot만 | 서버의 검증된 manifest receipt |
| `pause_new_runs` / `resume_new_runs` | 회차 운영 권한. 서버 admission + 앱 tool admission에 적용; 진행 중 요청은 별도 취소 선택 | 서버 적용 revision과 기기별 적용/미지원/미확인 구분 |

`reset_runtime`은 `clearHistory`/워크스페이스 삭제/자격 초기화/PC 재부팅이 아니다. 현재 `clearHistory()`는 되돌릴 수 없는 대화 삭제이므로 호출 금지. reset은 원래 대화·관찰 원본을 보존하고 새 실행 문맥으로 연결한다. 선택한 snapshot으로 파일을 되돌리는 기능은 #673의 별도 검증을 통과하기 전 명령 목록에 넣지 않는다. `hasActiveStream()`만 확인하고 외부 프로세스가 끝났다고 간주하지 않는다.

command envelope: `schema_version, command_id, idempotency_key, payload_hash, cohort/profile/class_run/seat/activity, device_registration_id, app_instance_id, expected_state_revision, connection_epoch, action, bounded_args, issued_by, reason_code, created_at, expires_at`. 서버는 인증 토큰에서 identity/scope를 채우며 클라이언트의 지정값은 권한을 확대하지 못한다. pending 명령은 유효 capability를 가진 대상 기기만 수신한다.

- `queued → leased → accepted → running → succeeded|failed|rejected|expired|cancelled|outcome_unknown`. HTTP 202는 queued일 뿐이다. 중간 상태와 최종 receipt를 구분한다.
- enqueue와 감사는 같은 DB transaction/batch에, 고유 idempotency key의 같은 payload는 기존 명령 반환, 다른 payload는 409. 강사 동시 조치에는 expected revision CAS와 회차·activity당 변경 명령 1개 lease를 적용한다.
- claim에는 lease generation을, 결과에는 command/epoch/generation을 포함한다. TTL 기본 120초, 실행 시간 상한은 action별. 다음 수업·다음 로그인에서 옛 명령은 실행하지 않는다. 클라이언트 시계 대신 Service가 준 deadline과 monotonic 경과 시간을 사용하며 실행 직전 서버에 재검증한다.
- 클라이언트는 실행 전에 로컬 영속 receipt journal을 기록한다. crash가 `실행 후 ack 전`에 나면 먼저 postcondition을 조회한다. 결과가 불명확하면 `outcome_unknown`으로 보류하고 destructive action을 자동 재실행하지 않는다. 네트워크에서 정확히 한 번 실행을 보장한다고 쓰지 않는다.
- 전송 취소는 실행 중 효과를 철회하지 않는다. offline·미지원·거절·만료는 각각 terminal reason, 상태 표시만 삭제하여 성공으로 바꾸지 않는다. 앱 종료 중에는 처리 중 reset receipt를 다음 시작 시 복구한다.
- 회차 pause의 즉시성을 기존 KV kill switch만으로 약속하지 않는다. 신규 operations 활성 회차의 chat/messages admission은 새 D1 control revision을 확인하고 SDK 로컬 tool admission도 짧은 실행 grant를 재검사한다. 확인 불가면 **새 외부/변경 실행만 제한**, 로컬 파일 열기·저장·Stop·내보내기는 유지한다. 이미 실행 중/구버전 앱의 미적용 범위를 명시한다.

### 수업 마무리: 수집·평가·발송

`수업 마무리` 한 번으로 같은 batch_id의 전체 흐름을 시작한다. 기본값은 **수집→초안 생성→검수 대기**다. 수신자·동의·평가·템플릿의 revision이 미리 승인돼 있으면 승인된 범위에서 발송까지 자동 진행할 수 있게 설계한다. 원클릭은 검수·권한을 생략한다는 뜻이 아니다. 이번 작업은 설계뿐이며 실제 로그 수집 권한·수신자·발송 승인을 생성하지 않는다.

1. **명단 고정:** 배치 입력은 class_run 명단 snapshot. 갤러리 카드/최근 로그 목록을 수신자 명단으로 사용하지 않는다. 같은 보호자에게 형제 2명이어도 child/report 단위는 별도다. 테스트 계정 제외는 운영자가 명시한 명단 기준이다.
2. **수집 승인:** `collect` 권한, 해당 회차·학생·목적·고지 version·유효기간과 필요한 보호자 동의 증빙을 Service가 확인한다. `analytics.upload_session_logs=true` 하나를 동의로 간주하지 않는다. 수집 불가 학생도 배치에 남기되 `consent_missing`으로 제외 사유를 표시한다. 기존 수동 경로는 계속 작동한다.
3. **회수:** 학생 기기에 본인 회차만 `retry_evidence_upload` 요청. 수업 중이면 immutable snapshot revision, 종료면 spool flush·seal 후 manifest. 급히 manifest를 쓰고 이후 로그를 잘라내지 않는다. 활성 파일이 변하면 새 revision, 같은 경로 덮어쓰기 snapshot을 평가 입력으로 사용하지 않는다. 원본 파일을 열어 실행하거나 HTML을 직접 렌더하지 않는다.
4. **완결 검증:** 서버가 허용 파일·owner/class run·size·sha256·event seq/누락을 확인한 후 manifest receipt를 발행한다. 파일 PUT 200이나 manifest 존재만으로 complete가 아니다. 기존 API와 다른 versioned envelope를 써 old upload 호환을 유지한다. legacy 로그에 seq가 없으면 만들어내지 않고 sequence_unavailable로 표시한다. 파일 무결성 verified와 행동 관측 coverage는 별도다. 검증된 legacy adapter는 기존 hash/turn 단위 검수로 처리하되 완전 수집 주장을 하지 않는다. snapshot→manifest→receipt→job enqueue 간 DB outbox로 재조정하며 R2 고아/DB 고아를 탐지한다.
5. **오프라인 회복:** 로컬 outbox를 다음 실행에서 재개. 수업 종료 후에도 유효한 **upload-only collection grant**가 있는 동안만 본인 지정 snapshot 업로드를 허용한다(기본 제안 종료 후 24시간, 운영 정책 확정 전 비활성). 학습 token 만료를 우회해 새 AI 실행/타 학생 원문을 허용하지 않는다. late arrival은 새 입력 revision이며 이미 승인/발송한 보고서를 조용히 바꾸지 않는다.
6. **평가:** `student + class_run + input_manifest_digest + capability_model/rubric/evaluator/renderer_revision`로 job 고유키. 신규 작업은 MC-17/19의 공통 코어·6개 후보 모델·근거 중심 서술이 기본이다. 기존 HAIN7 7축 보고서는 legacy 선택 모드로 격리해 기존 rubric·28 marker review·fingerprint·지면 QA를 유지한다. 7→6 점수 합산/이름 교체는 금지. 프롬프트만 수집된 경우 관측 한계를 표시하며 수량·길이로 능력을 평가하지 않는다.
7. **실행기:** P0/P1 파일럿은 관리자의 Mac에서 실행하는 제한된 batch runner가 Service에서 lease를 받아 처리한다. 기존 `packages/measurement`와 보고서 엔진을 호출하며 새 채점기를 복제하지 않는다. Python/폰트/PDF 실행을 일반 Workers JS 안에 넣지 않는다. runner는 1~2 동시 job, 메모리/시간/크기 한도, 원문 임시파일 제한, job별 권한·receipt·heartbeat를 가진다. Mac이 꺼지면 `runner_offline`이며 작업은 D1에 남는다. 무인 반복 운영이 필요하면 같은 worker interface를 별도 container/queue consumer로 옮긴다.
8. **검수:** `missing/partial/quarantined/draft/review_required/approved`를 구분한다. 로그 누락은 0점이 아니다. checksum 오류·아동 동의 미비·다른 학생 혼입·근거 ID 불일치·필수 review 누락·PDF 지면 실패는 개별 격리하고 나머지 학생을 계속 처리한다. 공통 코어가 제공하지 않는 서술 평가 모델은 기본 OFF; 운영자가 evaluator version/호출 한도를 정한 후 검수 가능한 초안만 생성한다.
9. **수신자:** 운영 원본 명단을 별도 승인된 recipient store로 가져온다. prompt/모델/갤러리에서 이메일·전화·보호자를 추론하지 않는다. 분석 JSON/PDF와 연락처를 분리. 검수자는 학생-보호자 매핑·보고서 hash·수신자 revision·채널·템플릿·만료·예상 과금을 확인한 batch approval을 남긴다. 이후 하나가 바뀌면 승인을 무효화한다.
10. **발송:** 기존 [delivery design](../../skills/hain7-report/references/delivery-options.md)의 adapter 경계를 따른다. 첫 채널은 확인된 발신 계정의 이메일, QR은 같은 보호된 링크의 현장 전달 수단, Kakao/SMS는 계정·템플릿 등록 후 후속. 특정 업체 가입/유료 사용은 이 설계로 승인하지 않는다. 서버가 recipient authorization을 확인하는 opaque·짧은 만료 링크, private R2, no-store, 재발급/철회·접근 감사. bearer 링크만으로 보호자 신원을 증명하지 않는다.
11. **전달 원장:** `(report_digest, recipient_revision, channel, template_revision)` unique, outbox commit 후 send. provider idempotency가 없고 timeout이면 `send_unknown`으로 조회/운영 확인 후 재개하며 새 메시지를 무조건 재발송하지 않는다. `provider_accepted/delivered/bounced/opened_unknown`을 분리한다. 이메일 수락을 실제 열람으로 표시하지 않는다. 재시도/DLQ/수동 replay는 동일 logical delivery key를 유지한다.

권한 철회·삭제는 metadata, 보고서, source snapshot, mirror, 임시 runner cache, link/grant의 연결 관계를 따라 추적한다. 기존 `studio-logs/` 90일·로컬 업로드 후 3일·미업로드 cap 정책을 임의 변경하지 않는다. 신규 상태/audit/report의 보존 기간과 삭제 담당은 배포 전 운영 결정으로 남기고, 삭제/철회가 늦은 outbox로 재생성되지 않게 tombstone을 둔다. 기존 R2→Lab mirror는 별도 receipt 없이는 도착 보증이 없으므로 **보고서 입력 정본은 검증된 R2 snapshot 한 곳**으로 고정한다.

### 비용 모델과 잠정 성능 목표

가격은 2026-09-18 공식 문서 조회이며 USD·세금 별도다. 아래는 관제 증가분 모델이며 현 계정 요금·다른 서비스 사용량·실측 CPU/DB는 확인하지 않았다.

| 2시간 수업 | 30명 | 100명 | 산식/전제 |
|---|---:|---:|---|
| App sync 5초 | 43,200 요청 | 144,000 요청 | N × 7,200 / 5; legacy heartbeat 중복 전송 제외 |
| 45초 상태 저장 상한(변화 추가) | 4,800회 | 16,000회 | N × 160; 인덱스 쓰기/상태 전이는 별도 |
| 강사 1명 보드 10초 | 720회 | 720회 | Chalk+Service 전달 시 Worker invocation 2회 가능 |
| 보드 join row read 근사 | 21,600행 | 72,000행 | 매번 N행. 쿼리 plan·인덱스에 따라 달라짐 |
| 월 20회 sync | 864,000 요청 | 2,880,000 요청 | 학생 요청만; model/chat/retry 미포함 |
| 학생당 압축 로그 2MB, 90일 보존 정상상태 | 3.6GB | 12GB | 20회/월×3개월. PDF·기존 파일·미러 별도 |

[Workers](https://developers.cloudflare.com/workers/platform/pricing/) Paid 기본 월 $5에 1,000만 요청/3,000만 CPU-ms, 초과 요청 $0.30/백만·CPU $0.02/백만 ms. 100명 시나리오에서 sync handler 평균 5ms라면 월 1,440만 CPU-ms, 20ms라면 5,760만으로 CPU 포함량을 넘는다. 따라서 “무료”나 “월 $5 확정”으로 말하지 않는다. Free 일 10만 요청은 100명 5초 polling 한 수업만으로 넘는다.

[D1](https://developers.cloudflare.com/d1/platform/pricing/) Paid 포함량은 월 read 250억/write 5천만행·5GB, 초과 $0.001/백만 read·$1/백만 write·$0.75/GB-month. 5초마다 모든 heartbeat를 새 row에 append하지 않는다. [R2](https://developers.cloudflare.com/r2/pricing/) Standard 저장 $0.015/GB-month, 10GB-month 무료 기준 위 12GB는 저장 증가분 약 $0.03/월(다른 사용량/요청 별도)이다. 로그 10MB라면 60GB로 약 $0.75/월이며 보존기간을 줄여 계산하지 않는다.

평가비는 `학생수 × (입력토큰×입력단가 + 출력토큰×출력단가) + 제한된 재시도`, 발송비는 `성공/요청 건수에 대한 provider 요금 + 실패 대체 채널`로 별도 표시한다. 평가·발송 provider/model이 확정되지 않아 금액을 추정하지 않는다. 결정론적 전송·정규화·중복판정·기존 채점에는 LLM을 호출하지 않는다. 입력 digest 캐시, 학생별 증분 처리, retry 상한, 배치 예상비 상한 초과 보류를 둔다. 전체 화면 스트림은 이 비용표에 포함하지 않는다.

잠정 인수 목표(측정 전 SLA 아님): 30명 파일럿/100명 합성 부하, online 오류/단계 보드 반영 p95 15초, 명령 접수 p95 10초, heartbeat stale 판정 3×45초+15초=150초 이내. 런타임 복구 완료 시간은 실제 abort/재연결 소요와 함께 측정한다. 기존 채팅 p95 지연 증가 5% 이하와 명령 중복 부작용/타 학생 노출/파일 손실 0을 gate로 둔다. 무신호는 실패 원인으로 단정하지 않는다. idle 경보는 현재 수업 데이터로 재보정하고 alert 분/정상 학생·시간, 잘못된 현장 호출 수를 측정한다.

### 추가 설계 기준 · 복구와 코칭의 분리 (2026-09-18 보강)

사용자 지시로 추가한 기준이다. 근거 문서는 금고의 `HypeProof_Studio_UIUX_Design_Philosophy.docx` §11~15·18이며 저장소에 복제하지 않는다. 그 문서의 GlobalBuddy·6주 과정·고정된 도움 순서는 **예시**이고 제품 정책이 아니다. 완료 조건은 선택한 커리큘럼(확정 lesson version)의 계약을 따르며 이 절은 단계·주차·과제를 하드코딩하지 않는다. 기존 Product Intent의 최소 개입·적응형 도움과 함께 적용하고, R0~R7 순서와 범위(학생 작업실 전체 개편 아님)는 그대로다.

| 기준 | 계약 | 인수 |
|---|---|---|
| 기술 복구 ≠ 학습 코칭 | 토큰·연결·실행 오류는 위 명령 계약으로 원격 복구한다. 강사는 학생의 답·선택 이유·결과물을 대신 완성하지 않는다. 학습 지원 조치는 `질문 보내기`와 `확인할 지점 표시` 두 가지이며 학생 파일·대화·입력을 바꾸지 않는다. 복구 조치는 질문·힌트 단계를 전제로 하지 않고 즉시 실행할 수 있다. | AT-35 |
| 개입이 필요한 상황을 찾는 화면 | 좌석 행은 현재 과제·단계, 도움 요청, 기술 오류, 강사가 확인할 근거를 보여준다. 빨간색은 **확인된 기술 장애**(신선한 신호의 blocking error, 거부된 토큰, 실패한 명령)에만 쓴다. 근거 부족·느린 진행·조용함은 실패나 낮은 능력으로 표시하지 않는다. 학생 원문은 기존 `classroom_shares` 공유 권한이 있는 상세 화면에서만 연다. 인원 집계는 운영 수치이며 학생 평가 지표처럼 표현하지 않는다. | AT-18, AT-36, DT-07 |
| 관측 근거의 출처 보존 | 기존 관측 envelope의 `actor`를 `student/ai/teacher/external_user/tool/system/unknown`으로 읽고, 근거 성격 `source_state`(`real/simulated/self_reported/unverified`)와 변경 전후 digest(`artifact_before/after`), 강사 확인 상태(`unreviewed/confirmed/disputed`)를 **같은 이벤트 계약의 확장**으로 둔다. 새 저장소를 만들지 않는다. 로그 도착은 학습 완료가 아니고, 근거 검토(confirmed)는 발송 승인이 아니다. 미지정 출처는 `unverified`이지 `real`이 아니다. | AT-36 |
| 근거 부족 표시 | 근거가 없으면 0점·미달이 아니라 `아직 충분히 보지 못함`이다. 공통 측정 코어의 `unobserved`를 그대로 쓴다. | AT-29, AT-37 |
| 일괄 평가지 = 관찰·성장 보고서 | 기본 구성은 `관찰된 행동 → 실제 근거 → 판단이 바뀐 과정 → 다음 실험`이다. 단일 수업은 그 수업의 관찰만 서술하고, 누적 회차의 근거가 있을 때만 성장 패턴을 말한다. 점수·순위·AI 의존도 추정치를 전면에 두지 않는다(방법/세부 데이터로 접는다). 공통 측정 코어와 legacy HAIN7 보고서 호환, 수집→초안→검수→승인된 발송 흐름은 그대로다. | AT-29, AT-38 |
| 학생 화면 최소 개입 | 학생 작업 중 평가 팝업을 추가하지 않는다. 이미 남긴 판단 근거를 다시 입력하게 하지 않는다. 강사의 질문·확인 지점은 작업 문맥을 가리지 않는 알림으로 전달하고 학생이 닫거나 나중에 볼 수 있다. | AT-35 |

코칭 조치의 계약: `send_question`(질문 1개, 최대 300자)과 `mark_checkpoint`(확정 lesson의 step id 또는 자유 활동, 선택적 짧은 메모)는 명령 원장의 같은 멱등·lease·receipt 계약을 쓰되 capability는 복구와 분리한 `coach`다. 본문은 `scrubSecrets`를 거쳐 저장되고 학생 기기에만 전달된다. 영수증의 `succeeded`는 **학생 화면에 표시됨**을 뜻하며 읽음·이해·수행을 뜻하지 않는다. 정답·수정안·완성 코드를 보내는 조치는 계약에 없다.

### 검토 반영으로 확정한 계약 (2026-09-19)

[독립 검토의 결함 F1~F7과 미완 기능](../testing/classroom-admin.md#remote-classroom-review-20260919)을 코드로 고치며 아래를 확정했다. 새 요구사항 체계가 아니라 위 ADM/AT 계약의 구체화다.

| 영역 | 확정한 계약 | 인수 |
|---|---|---|
| 수집 귀속 (F1) | spool의 신원은 `session.meta.json.user={u,c,p}`에만 있다. App은 `freezeSnapshot`으로 복사본을 동결하며 u·c·p가 이 연결의 학생과 다르거나 없으면 아무것도 보내지 않고, 수업 창(시작 30분 전~동결 시각) 밖 이벤트를 제외한다. manifest `hps-classroom-snapshot/2`의 `binding`(회차·batch·좌석·spool session·학생·활동(course/version)·동의 범위·이벤트 extent)을 Service가 grant·batch·동의·보유 바이트와 대조한다. 불일치·신원 없음·회차 귀속 없는 레거시(`/1`에서 spool session id≠회차)는 `quarantined`이며 평가 입력이 되지 않는다. 검증된 binding은 `classroom_snapshot_bindings`(migration 0018, additive)에 snapshot과 함께 남는다. | AT-19/23/26/27 |
| 연결 해제 뒤 실행 (F2) | sync 응답은 연결이 끝났으면 pause·proceed·새 명령을 통째로 버린다. host는 연결 generation으로 재연결 이전 응답을 무효화하고, `CommandRunner.close()`는 실행 직전에도 다시 확인한다. 실행 중이던 작업에는 중지를 **요청**하며, 상태 변경 작업의 결과는 `outcome_unknown(connection_closed)`이다 — 중지됨·실패로 단정하지 않는다. | AT-21/23/24 |
| 발송 단위 (F3) | delivery key = 회차·batch·job·학생·초안 digest·수신자 ref·수신자 revision·채널·문안·live/dry. 보고서 내용은 신원이 아니다. 형제자매는 각 1건, 같은 메시지 재시도는 0건, 다른 회차의 같은 recipient_ref·정정된 주소는 별개. 확정 실패(`failed`)만 같은 key로 재시도하고 `send_unknown`은 재발송하지 않는다. | AT-31 |
| App 관측 (F4) | 단계는 수업 패널의 명시적 학생 행동(`채팅에 과제 넣기`=진행 중, `이 단계를 마쳤어요`=제출·자기보고)만 신호가 된다. runtime 준비·오류·SDK fallback·해소는 실제 턴 완료 경로에서, 산출물 변경은 before/after digest로 발행한다. 클릭 수·토큰 수·AI의 ‘완료’로 추정하지 않는다. 앱은 보고 가능한 신호를 capability(`observe_step/runtime/evidence`)로 선언하고 보드는 미선언을 `확인 불가`로 표시한다. | AT-15/17/18/36 |
| 만료 뒤 업로드 (F5) | 관측·명령 수명과 upload-only 수명을 분리한다. 정상 만료는 자격을 지우지 않고, **이 grant로 이미 동결된** 복사본만 수업 종료 뒤 24시간 안에 재개한다. sync·명령·pause·새 동의·새 batch 대상은 되살아나지 않는다. 다른 grant의 복사본, 철회, 좌석·사용자 변경(공유 PC), Service 거부는 재개하지 않는다. | AT-28 |
| 근거 대조 (F6) | 인용은 `event_id` 또는 레거시 `locator{line,turn_id}`가 가리키는 사건의 **디코딩된** 원문에 있어야 한다. actor/source_state는 사건에서 읽어 초안에 기록하며 초안이 바꿔 적을 수 없다. AI·강사·가상 사례만으로는 `observed`가 될 수 없다(맥락 인용은 가능). | AT-29/36/37 |
| 손상·경계 (F7) | 깨진 JSON/비객체 행은 `damaged`(개수 기록), 선언된 시작·끝 없는 연속 꼬리는 `range_unknown`, 선언된 마지막 사건과 Service가 가진 마지막 행이 다르면 격리. `complete`는 선언된 extent와 일치할 때만이다. 레거시 `sequence_unavailable`은 유지. | AT-27/29 |
| 평가기 | 새 채점기를 만들지 않는다. 공통 측정 코어의 역량 정의(observe/insufficient)가 rubric(`capability-definitions@<definition_revision>`)이고, 코어의 근거 카탈로그에서 모델이 quote_id를 **선택**만 한다. Service 안에서 평가하므로 학생 기록이 운영자 PC로 내려오지 않는다. `HPS_CLASSROOM_EVALUATOR` 미설정(기본)은 `evaluator_not_configured` 상태이며 빈 초안을 평가 결과로 저장하지 않는다. legacy 7축은 기존 HAIN7 엔진을 `--legacy-replay`로 그대로 실행하는 별도 adapter이고 7→6 변환·점수·band를 옮기지 않는다. | AT-29/30/38 |
| 자동 연결 | `POST …/report-batches/:id/advance` 한 번이 한 단위(검증된 receipt→중복 없는 job→1건 claim→평가→검수 대기)를 수행한다. Chalk의 `수업 마무리`가 끝날 때까지 호출한다. job_key·lease로 재클릭·재시작·두 창의 중복은 0이고, provider 일시 장애는 큐 복귀(최대 3회) 뒤 가시적 실패다. 승인·발송은 절대 자동이 아니다. | AT-29/30 |
| 읽기 화면·PDF | 보호 링크는 사람에게 HTML을 준다(`?format=json`은 도구용). `composeReport()` 출력만 렌더한다. 스크립트 없음·`default-src 'none'`·전 문자열 escape. 인용마다 화자·실제/가상·도움 여부, 근거 없음은 `아직 충분히 보지 못함` 한 번. PDF는 같은 페이지의 print stylesheet다(`scripts/classroom-report-pdf.mjs`, 운영자 PC). | AT-31/37 |
| 메일 공급자 | 아래 ‘발송 공급자 선택 근거’. | AT-31 |
| 평가 큐 (후속 검토) | job의 evaluator/rubric 고정은 덮어쓰지 않는다. 평가기가 (재)설정되면 **한 번도 평가되지 않은** 기본 모델 대기 작업만 `superseded`로 닫고 같은 검증 입력에 현재 버전의 새 job을 만든다(job_key가 버전을 포함 → 반복해도 중복 0, 감사 기록). 초안이 있는 job은 어떤 버전이 만들었든 재평가·덮어쓰기하지 않는다. claim은 호출자가 **지금 실행할 수 있는** 작업만 고르므로(Service: 현재 evaluator·rubric / runner: 선언한 service·legacy·local) 실행 불가 작업이 뒤 학생을 막지 않는다. 일시 장애는 그 작업만 30초→2분→10분 쉬고(`classroom_report_job_attempts`, migration 0019) 3회째에 가시적 실패. | AT-29/30 |
| 강사 reviewed | 기존 근거 확인 경로(`ops_event_reviews`)를 **학생이 submitted로 표시한 단계 사건**에도 허용한다. 기기가 보고한 status는 그대로 두고 `step.review`를 옆에 붙인다. `coach` capability, `expected_revision` CAS(두 강사 동시 확인은 한쪽만 성공), 다음 단계는 다시 ‘확인 전’. 확인은 점수·수업 완료·발송 승인이 아니다. | AT-17/35/36 |
| 링크 열람자 확인 | 링크는 ‘메일을 가진 사람’만 증명한다. 실제 주소로 나가는 보고서는 운영자가 수신자와 미리 정해 명단과 함께 가져온 확인 값(`phone_last4`·`birth_mmdd`·`passphrase`)을 추가로 요구한다. salt + Service secret 키의 HMAC만 저장(migration 0020), 값의 revision은 발송 승인 범위에 포함, 값 없는 수신자는 live 발송 제외(dry-run은 가능). GET은 질문만 하고 POST로 답하며 5회 실패 시 링크를 영구 잠근다. 낮은 엔트로피 값이므로 **본인 인증이 아니라 전달된 링크를 막는 2차 요소**다. | AT-31 |
| 보존 자동 실행 | 기존 일일 cron(`0 17 * * *`)에 연결. `HPS_CLASSROOM_RETENTION_DAYS` 미설정(기본)=무동작, 잘못된 값=끔(보정하지 않음), 기간만 설정=dry-run 보고, `HPS_CLASSROOM_RETENTION=enforce`까지 있어야 삭제. `classroom_erasure_log`(migration 0021)에 진행을 남긴다. 보존 실행은 **새 삭제만** 시작하고, 중단된 삭제를 이어서 끝내는 일은 아래 ‘요청된 삭제의 복구’가 맡는다. tick당 상한. | AT-28 |
| 철회·보존 | tombstone → 링크 폐기 → job `withdrawn` → 대기 outbox 취소 → R2 snapshot·초안 삭제 순. 내용 없는 기록(항목 상태·job 행·전달 원장·감사)은 남긴다. 이미 수신함에 도착한 사본은 회수했다고 말하지 않는다. 보존 기간은 기본값이 없고 운영자가 `POST /admin/classroom/erasures`에 명시한다(dry_run, 기한 전 거부). | AT-28 |
| 결과 저장과 삭제의 순서 (2026-09-20 재검토) | R2와 D1은 한 트랜잭션이 아니다. 평가 결과는 **D1 한 문장**이 확정한다: lease 세대가 살아 있고 그 학생의 tombstone이 없을 때만. 본문은 lease 세대별 키(`draft.g<n>.json`)에 쓰므로 거부된 쓰기를 되돌려도 다른 세대가 확정한 초안을 지우거나 덮어쓰지 못한다. 저장 전 확인은 비용 절감일 뿐 보증이 아니며, 확정이 거부되면 방금 쓴 본문을 같은 요청에서 삭제한다. 철회된 학생의 leased 작업은 `withdrawn`으로 닫혀 다시 평가·전달되지 않는다. 삭제 원장은 `started`(요청 기록, 열람 불가) → `done`(내용 삭제, 이후 결과는 D1이 거부) → `settled`(이미 진행 중이던 쓰기가 도착할 수 있는 창 `2×(lease+provider timeout)`이 지난 뒤 재확인, 남은 객체를 지우고 개수만 감사 기록)이다. 쓰기 직후 프로세스가 죽어 보상 삭제를 못 한 경우를 `settled` 재확인이 닫는다. | AT-28~30 |
| 요청된 삭제의 복구 ≠ 보존 만기 삭제 | **복구**(`runClassroomErasureRecovery`)는 이미 요청된 삭제(`started`·`done`)만 끝내며 보존 설정이 필요 없다. 15분 tick마다 실행되고 기록된 사유(철회는 철회로)를 유지한다. 재시도 간격 15분→1시간→6시간→이후 24시간, 12회 뒤에는 스스로 멈추고 `retry_limit`과 감사 1건을 남기며 운영자가 원인 해소 후 같은 요청을 반복한다(`GET /admin/classroom/erasures`로 상태·다음 시도 확인). **보존**(`runClassroomRetention`)만 새 삭제를 시작하고, 원장에 이미 있는 학생은 고르지 않는다. 보존 OFF·기한 전이어도 철회는 완결되고, 보존 OFF에서는 아무리 오래된 회차도 새로 지워지지 않는다. 학생의 철회 요청은 저장소 장애 때 `202 erasure=pending`으로 답한다(철회 자체는 기록됨, 삭제는 자동 재시도). | AT-28 |
| 평가 입력·산문 가드 (2026-09-20) | 평가 1회가 보내는 학생·AI 원문은 총 60,000자 이하다. 넘는 기록은 **앞에서부터** 예산만큼만 읽고 초안을 `partial · input_truncated`로 표시하며 감사 기록에 사용/전체 사건 수를 남긴다(조용한 절단·분할 호출 없음). 평가기가 쓴 문장(claim·변화·다음 실험)에 점수·순위·백분위·등급·레벨·AI 의존도 수치가 있으면 `quarantined · grade_language`로 저장하지 않는다. 학생이 한 일의 일부인 숫자(390px, 3단계)는 해당하지 않고, 인용문은 기록 원문이라 검사하지 않는다. | AT-29~30 |
| 실기에서 나온 App 계약 (2026-09-20) | 수업의 보통 순서는 ‘토큰 먼저, 좌석 연결은 나중’이다. 연결이 시작될 때 App이 토큰을 한 번 확인해 보고하므로 연결 전에 끝난 검증도 보드에 `token_verified`로 나타난다(폴링 아님, 토큰 없으면 보고 없음). 상태를 바꾸는 강사 조치는 학생에게 내부 식별자가 아니라 읽을 수 있는 이름으로 알린다(‘AI 세션 다시 시작 (대화와 파일은 그대로)’). | AT-19~24 |
| 강의에 귀속된 학생 초대 (2026-09-21) | authoring의 `versions/:version/participants`도 일반 토큰 발급과 같은 발급 원장·해당 학생 연결 세대 갱신을 거친다. 강의 binding은 유지하고 다른 학생의 세대는 바꾸지 않는다. ops OFF면 기존 응답/발급을 유지하며, 저장 장애로 세대 갱신에 실패하면 발급을 막지 않고 `ops.epoch_advanced=false`를 반환한다. | AT-15/23/32 |
| 늦게 도착한 보고서 입력 (2026-09-21) | 같은 배치·학생에게 검증된 입력이 생겼으면 기존 `missing` placeholder는 현재 검수 목록·집계에서 제외한다. 원장의 과거 행은 보존하고 다른 학생의 누락은 계속 표시한다. 이미 존재하는 입력 revision별 초안은 삭제하지 않는다. | AT-27/29 |
| 학생 화면 통합 (2026-09-21, main #1170/#1178) | 학생 화면은 main의 ‘현재 과제 중심’ 구조를 따른다(과제 머리말·근거 서랍·완료 게이트·real/simulated 표시는 그 요구가 소유). 관제 단계 신호는 그 위에 얹는다: 화면의 **유일한 Primary**(현재 단계 시작)가 `in_progress` 자기보고를 함께 보내고, `이 단계를 마쳤어요`는 현재 단계 안내 아래의 조용한 버튼이다(Primary 추가 금지, SX-01·SX-04). 자기보고는 `강사 확인 전` 상태이며 완료 게이트(학습 사건 기반)와 별개다 — 한쪽이 다른 쪽을 대신 충족시키지 않는다. F4 행의 옛 버튼 이름 `채팅에 과제 넣기`는 이 구조로 대체됐다. | AT-17, AT-24 |
| 토큰 확인 근거 (2026-09-21) | ‘앱이 발급분을 확인함’은 입장 단계가 아니라 **근거**다. `activation` 슬롯(최신 단계 1개)과 분리된 `token_check` 슬롯에 확인된 jti·연결(grant)·앱 프로세스(boot)를 함께 저장한다. 이후 단계(`class_entered`·`runtime_ready`)는 근거를 지우지 않는다. 재발급 후에는 앱이 새 토큰을 보고할 때까지 `other_token`, 앱의 `token_rejected`·더 새로운 boot·새 연결·좌석 변경은 근거 없이(`unknown`) 시작한다. 늦게 온 재전송과 더 오래된 boot의 sync는 최신 근거를 바꾸거나 지우지 못한다. 슬롯 도입 전 행은 단계가 `token_verified`인 동안만 기존 값을 읽는다. schema 변경 없음(`state_json`). | AT-15, AT-23 |
| 기록 순번·범위 계약 (2026-09-21) | **App:** `events.jsonl` 한 파일(세션)마다 1부터 시작하는 `seq`를 쓰기 큐 안에서 할당하고 재사용하지 않는다. 실패한 append의 번호는 버린다(구멍이 보인다). 찢어진 줄은 다음 사건과 붙지 않게 격리한다. 앱 재시작·신원 교체·수동 봉인은 새 세션(새 1번)이며 이전 파일을 이어 쓰는 척하지 않는다. snapshot은 같은 큐 안에서 파일과 카운터를 함께 읽고, 개행 없는 꼬리(쓰는 중)는 복사하지 않는다. freezer는 **시작을 증명할 수 있을 때만** `first_seq/last_seq`를 선언한다(1번에서 시작하거나, 수업 창이 제외한 바로 앞 줄이 `first-1`). 추가로 spool 카운터 `session_last_seq`와, 수업 창 안에 있지만 이 복사본에 없는 같은 학생의 다른 세션 수 `other_sessions_in_window`를 선언한다. 확인 못 한 값은 생략한다. **Service:** `complete` = 연속 + 선언된 시작·끝 일치 + `session_last_seq`=마지막 seq + `other_sessions_in_window`=0. 카운터가 더 크면 `gaps`(`tail_missing`), 다른 세션이 있으면 `range_unknown`(`other_session_not_included`), 선언이 없으면 `range_unknown`(`extent_not_declared`). 사유는 seal 응답·감사 기록의 `coverage_reason`. seq 없는 기록은 빌드와 무관하게 `sequence_unavailable`이며 화면은 이를 ‘구형 기록’이라 부르지 않는다. 기존 기록·기존 App은 계속 수용한다(`complete`가 되지 않을 뿐). **한계:** 재시작 전 세션을 합쳐 올리지 않는다 — 선언만 한다. | AT-27, AT-29 |
| 강사 중지의 학생 표시 (2026-09-21) | 중지는 그 턴의 abort 신호로 판정한다(런타임이 죽으며 던진 오류의 모양이 아니라). 강사 명령에 의한 중지는 `streamStopped{by:instructor}`로 알리고 화면은 누가 멈췄는지와 대화·파일이 그대로임을 말한다. 연결 오류 배너·오류 신고 버튼을 띄우지 않으며 보드에도 장애로 보고하지 않는다. | AT-21 |

<a id="remote-management-acceptance-20260921"></a>

#### 원격관리 인수 계약 · 2026-09-21 (제안 · 구현 아님)

사용자가 요구한 핵심은 보고서 서비스가 아니라 **원격관리**다: 강사가 한 화면에서 수강생(개별·그룹·전체)을 고르고, 상태를 파악하고, 회수·배포·복구를 실행하고, **대상별로 실제 적용됐는지**까지 확인한다. 아래는 기존 ADM-01~14·명령 원장·Chalk `/manage` 위에서의 인수 기준이며 별도 관제 제품·인증·문서 체계를 만들지 않는다. 현재 구현과의 대조는 [테스트 문서의 매핑 표](../testing/classroom-admin.md#remote-management-map-20260921)가 소유한다. 범위 밖(현재 미확정): OS 화면 공유, 임의 셸, 프로세스 강제 종료. 앱 설치·업데이트와 PC 전체 제어는 사용자 확인 중이다.

| 흐름 | 인수 기준 (모두 대상별로 증명) | 근거 요구 |
|---|---|---|
| RM-1 선택·상태 | 개별·그룹·전체를 같은 선택 모델로 고른다. 선택 요약은 대상 수·전달 가능 수·전달 불가 사유를 실행 전에 보여 준다. 좌석마다 연결·토큰(발급/앱 확인)·단계(자기보고/강사 확인)·오류 원인·마지막 신호 시각. 무신호는 `확인 불가`이지 정상·실패가 아니다 | ADM-02/09, AT-15~18, AT-42 |
| RM-2 대상 회수 | 회수 종류(수업 기록 / 학생 프롬프트 / 승인된 결과물)와 대상을 고른다. 동의·철회·수업 경계는 대상 선택보다 우선한다. 비선택 학생에게는 요청·명령·저장이 0 | ADM-03/06/13/14, AT-26~28, AT-43 |
| RM-3 대상 배포 | 배포물은 **버전이 있는 서버 보관 객체**(수업 프롬프트 / 공지·자료 / 수업 설정)이고 원장에는 id·revision만 남는다. 완료 = 그 기기가 **그 revision을 적용했다고 보고**한 것. `send_question` 표시나 토큰 발급은 배포 완료가 아니다. 비선택 학생의 적용 revision은 변하지 않는다 | ADM-10/11, AT-44 · [U2 계약](#remote-management-u2-20260921) |
| RM-4 원인별 복구 | 보드가 보여 준 원인(토큰·연결·runtime·preview·업로드)마다 허용 목록의 조치 하나가 1순위로 제시된다. 복구는 대화·입력·파일을 보존한다. 재설치·PC 제어는 포함하지 않는다 | ADM-10, AT-19~23, AT-40 |
| RM-5 대상별 결과 | 모든 실행은 대상별로 `접수 → 기기 수신 → 적용` 또는 `실패`/`미확인`으로 끝난다. 기존 원장 상태에 대응: queued=접수, **leased=서버가 그 기기에 배정(기기 수신 확인 전)**, accepted·running=기기 수신(기기가 보낸 receipt가 있을 때만), succeeded(+result code)=적용, failed·rejected·unsupported=실패, not_connected·expired·cancelled=전달 안 됨, outcome_unknown=미확인. `모두 성공`은 전 대상 적용일 때만 | ADM-10, AT-20/21, AT-41 |

**경계 조건(세 실행 흐름 공통).** 오프라인: 전달되지 않았음을 즉시 표시하고, 재접속 시 적용할지(배포)·버릴지(복구 명령)는 종류별로 정한다 — 조용히 성공 처리하지 않는다. 만료: 실행 전 만료는 `실행되지 않음`, 실행 후 영수증 없음은 `미확인`. 재접속·재발급·기기 교체: 이전 연결 세대 앞으로 나간 요청은 새 연결에 전달되지 않는다. 중복 요청: 같은 idempotency key는 같은 결과, 같은 배포 revision의 재요청은 새 적용을 만들지 않는다. 부분 실패: 대상별로 남고 실패 대상만 다시 고를 수 있다. 수업 경계: 다른 회차·좌석이 바뀐 학생에게는 아무것도 전달·회수되지 않는다. 종료된 회차는 둘로 나눈다 — **종료 전에 이미 요청·승인된 업로드**는 유예 시간(`upload_until`, 종료 뒤 24시간) 안에 계속 받고, **종료된 회차에 대한 새 요청**(새 회수·새 배포·새 명령)은 거부한다(`run_ended`).

<a id="remote-management-u1-20260921"></a>

#### U1 — 공통 대상 선택과 선택한 학생의 수업 기록 회수 · 2026-09-21 (구현)

RM-1의 선택 모델과 RM-2 중 ‘수업 기록’만 다룬다. (인수 ID 정정 2026-09-21: 이 절의 선택 모델 = **AT-42**, 선택 회수 = **AT-43**. 작성 당시 AT-37/38로 적었으나 그 번호는 2026-09-18의 다른 인수 조건이 먼저 쓰고 있었다 — [정정 원장](../testing/classroom-admin.md#at-id-ledger-20260921).) 배포·PC 제어·평가 확장은 포함하지 않는다. 기존 인증(`collect` capability)·명령 원장·snapshot 경로·동의 모델을 그대로 쓴다.

| 항목 | 계약 | 검증 |
|---|---|---|
| 선택 모델 | `/manage`에서 개별(좌석 ‘선택’)·전체·상태 묶음(도움 필요/연결됨/미연결)·해제. 저장 그룹 없음. 선택은 만든 시점의 명단 revision에 묶이며 revision이 바뀌면 비운다. 요약은 실행 전에 대상 수·명단 차수·연결됨/연결 없음·좌석 목록을 보여 준다. 선택이 비면 어떤 조치도 나가지 않으며 새 조치의 기본값은 전체가 아니다. `collect`만 있고 `command`가 없는 강사도 선택과 회수를 쓴다(`/status.collection{enabled,held}`) | AT-42 |
| 요청의 두 종류 | `targets` 생략 = 기존 ‘수업 마무리’(명단 전체 · mode `finish` · 평가로 이어질 수 있음). `targets` 명시 = 그 좌석만 · mode `collect_only`. 빈 배열·중복·형식 오류·이번 회차에 없는 좌석·알 수 없는 필드(`target`, `seats` 등)·`targets`+`finish`·`targets` 없는 `collect_only`는 **거부**하며 어떤 경우에도 전체로 넓히지 않는다 | AT-43 |
| 비선택 학생 | 배치 명단에 `not_selected` 메타데이터 행만 남는다. 동의 조회 결과에 따른 동작·명령·업로드 문(`not_requested`)·R2 객체·평가 입력 모두 0 | AT-43 |
| 선택은 동의를 덮지 않는다 | 선택한 좌석도 동의 없음·보호자 동의 전·철회·기기 연결 없음이면 그 사유로 배치에 남고 요청되지 않는다. 고지 버전·목적·업로드 유예는 기존과 같다 | AT-26, AT-43 |
| 회수만 한다 | `collect_only` 배치는 seal에서 평가 입력(outbox)을 만들지 않고, 보고서·발송 라우트는 `409 collect_only_batch`. Chalk의 선택 회수는 `/advance`를 부르지 않으며 평가·발송 UI를 열지 않는다 | AT-43 |
| 불변 범위와 멱등 | migration 0022 `classroom_collect_scopes`(additive): scope·mode·좌석·정규화 요청 해시(scope, mode, 정렬된 좌석, 목적, 고지, dry-run, 명단 revision)를 한 번 기록. 같은 key + 같은 요청 = 같은 결과(응답 유실·경합 더블클릭 포함, 명단이 이후 바뀌었어도). 같은 key + 다른 대상/목적/고지/모드/dry-run = `409 idempotency_conflict` | AT-43 |
| 범위 조회는 fail-closed | scope 행이 **정상 조회에서 없을 때만** 0022 이전 배치(명단 전체·finish)로 읽는다. 조회 예외·파싱 불가·모르는 scope/mode·해시 없음은 이전 배치로 승격하지 않고 `503 scope_unavailable/scope_invalid` — seal·reports·delivery·배치 조회·멱등 재생이 같은 계약. 아무것도 봉인·큐잉되지 않는다 | AT-43 |
| 커밋 경계의 원자성 | 읽기(명단·동의)와 쓰기 사이의 좌석 교체·회차 종료·flag 끔·동의 철회·tombstone을 **조건부 batch 한 트랜잭션**으로 막는다: 배치 INSERT가 전제 조건 전체(명단 revision, 모든 좌석의 revision·학생, `ops_collect`, 선택 회수는 회차 미종료, 요청 대상 동의 유효, tombstone 없음)를 갖고 나머지 쓰기는 그 행이 있을 때만 존재한다. 어긋나면 배치·scope·item·명령·target 0건, `409 revision_conflict/run_ended/changed_during_request` 또는 `403 ops_collect_disabled`. 재조회 한 번으로 대체하지 않는다 | AT-43 |
| 확인은 본 것에만 유효 (2026-09-21 보완) | 미리 확인 요청이 **나가기 전에** 회차·명단 revision·좌석·좌석별 학생·연결 여부·회수 권한을 고정하고 요청마다 선택 세대(ticket)를 붙인다. 선택·명단·연결·권한 변경, 취소, 더 새로운 요청, 연결 해제는 세대를 올리며 **늦게 도착한 응답은 확인 화면을 열지 못한다**(화면만 지우는 것으로는 진행 중인 응답을 막지 못한다). 응답 자체의 revision·좌석·학생도 요청과 대조한다. 확정 시 현재 화면의 선택·명단과 다시 대조하고, 명단이 바뀌면 행을 그리기 전에 선택을 비워 체크박스와 실제 선택이 어긋나지 않는다. 이전 요청의 종료가 새 요청의 버튼 상태를 정하지 않으며, 진행 중인 요청이 다음 미리 확인을 잠그지 않는다. 확정 응답이 역순으로 오면 최신 확정이 결과 영역을 갖고, 접수된 이전 확정은 이름을 밝혀 알린다(중복 생성 0) | AT-42 |
| 대상별 결과와 재선택 (2026-09-21 보완 2) | 아래 ‘회수 생명주기’ 표가 정본이다. 선택 좌석의 상태는 **Service가** 회수 item × 기기 요청 × 업로드 유예에서 정하고(`collectStatus`) 화면은 그것을 말로 옮길 뿐이다. 화면은 **현재 수집 결과와 과거 기기 요청 결과를 나란히** 보여 주고, 관측 시각과 ‘더 바뀔 수 있는가’를 밝힌다. `결과 확정`은 바뀔 수 있는 대상이 하나도 없을 때만 쓴다. 재선택은 새 요청을 보내지 않으며, 누르는 순간 최신 배치와 현재 보드를 다시 읽어 그사이 검증됨·전송 중·철회·좌석 교체된 대상을 뺀다. 수업이 끝났으면 재선택은 비활성이고 이유를 말한다 | AT-42, AT-43 |
| 유지되는 제한 | `reset_runtime` 1명 제한, 위험 조치 확인, 기존 ‘수업 마무리’(명시적 별도 동작, 기본 미리 확인) | 기존 AT |

##### 회수 생명주기 — 선택 좌석 하나의 상태 (위에서 아래로 첫 일치)

세 가지 사실 중 어느 하나만으로는 상태를 말할 수 없다: **회수 item**(Service가 가진 것), **기기 요청**(명령이 어떻게 끝났는가), **업로드 유예**(이 배치가 아직 받을 수 있는가). 저장된 파일이 있다는 사실(`일부 파일만 도착`)은 **지금 전송 중이라는 증거가 아니다** — 실행 중인 명령, 또는 **요청이 끝난 뒤에** 도착한 바이트만이 그 증거다.

**시간 순서 (2026-09-21 보완 3).** ‘meta 도착 → 기기가 실패 보고’와 ‘실패 보고 → 새 파일 도착’은 둘 다 ‘최근 바이트 + failed 요청’으로 보이지만 뜻이 반대다. 앞은 그 시도가 그렇게 끝난 것이고, 뒤만 재개된 전송이다. 비교하는 두 시각은 같은 시계(Service가 받은 시각)다: item `updated_at` = 이 좌석의 업로드 PUT을 Service가 마지막으로 받은 시각(새 파일이든 같은 파일의 재전송이든 — 재개하는 기기는 가진 파일을 다시 보내는 것으로 시작하므로 재전송도 활동으로 기록한다), 요청 `updated_at` = 종료 보고를 받은 시각. 바이트가 종료 보고보다 **엄격히 뒤**이고 90초 안일 때만 재개된 전송이다. **같은 시각, 어느 한쪽 시각이 없거나 읽을 수 없는 경우는 순서를 증명하지 못하므로 ‘진행 중’으로 만들지 않고** 요청이 끝난 결과(재전송 대기·최종 거부·전달 안 됨·결과 미확인)를 그대로 말한다.

| # | 회수 item | 기기 요청 | 유예 | 상태 | 진행 중 | 재선택 | 더 바뀔 수 있음 | 뜻 |
|---|---|---|---|---|---|---|---|---|
| 1 | verified | 무엇이든 | 무관 | 서버 검증됨 | – | – | – | 그 전에 실패한 명령은 이력이지 상태가 아니다(나란히 표시) |
| 2 | 동의 없음·보호자 동의 전·철회 | – | 무관 | 제외 | – | – | – | 다시 요청해도 달라지지 않는다. 검증 뒤 철회하면 여기로 온다 |
| 3 | quarantined | – | 무관 | 격리 | – | – | – | 사람이 먼저 본다 |
| 4 | 그 밖의 미검증 | 무엇이든 | **종료** | 업로드 유예 종료 | – | 가능(새 요청이 허용될 때만) | – | 이 배치로는 더 받을 수 없다. Service도 바이트를 거부한다 |
| 5 | not_connected | 없음 | 열림 | 전달 안 됨 | – | 가능 | – | 명령 자체가 만들어지지 않았다 |
| 6 | incomplete | 무엇이든 | 열림 | 최종 거부 | – | 가능 | 예 | Service가 불완전으로 판정. 유예 안의 새 revision은 받는다 |
| 7 | requested/uploading | 없음·queued·leased | 열림 | 기기 수신 확인 전 | 예 | – | 예 | 서버 접수·배정일 뿐 기기 receipt가 없다 |
| 8 | requested/uploading | accepted·running | 열림 | 전송·검증 진행 중 | 예 | – | 예 | 기기가 실행 중 |
| 9 | uploading — 바이트가 **요청 종료 보고보다 뒤**에, 90초 안에 도착 | 종료된 상태(failed·rejected·expired·cancelled·unsupported·not_connected·outcome_unknown) | 열림 | 전송·검증 진행 중 | 예 | – | 예 | 실패 → 새 파일: 재개된 전송. 조용해지면 아래 11~14행으로 돌아간다 |
| 9′ | uploading — 바이트가 종료 보고보다 **앞**이거나 같은 시각이거나 시각을 알 수 없음 | 위와 같음 | 열림 | (9행 아님 → 11~14행) | – | 가능 | 예 | 파일 → 실패: 첫 1초부터 실패다. 90초를 기다려 실패가 되는 것이 아니다 |
| 10 | requested/uploading | succeeded | 열림 | 5분 안: 전송·검증 진행 중 / 넘으면 결과 미확인 | 예/– | –/가능 | 예 | ‘보냈다’는 보고는 검증이 아니다 |
| 11 | requested/uploading | outcome_unknown | 열림 | 결과 미확인 | – | 가능 | 예 | 성공으로도 실패로도 세지 않는다 |
| 12 | requested/uploading | failed · `offline_pending` | 열림 | 재전송 대기 | – | 가능 | 예 | 기기가 동결 사본을 보관하고 앱 재시작·재연결 때 이어 보낸다. 전송 중도 최종 거부도 아니다 |
| 13 | requested/uploading | failed · 그 밖의 코드(`upload_refused`·`verify_failed`·`nothing_recorded` 등) | 열림 | 최종 거부 | – | 가능 | 예 | 기기가 이 요청을 포기했다. 일부 파일이 도착했어도 ‘전송 중’이 아니다 |
| 14 | requested/uploading | rejected·unsupported·expired·cancelled·not_connected | 열림 | 전달 안 됨 | – | 가능 | 예 | 명령이 실행되기 전에 끝났다 |
| 15 | 이 빌드가 모르는 상태 | – | 열림 | 결과 미확인 | – | – | 예 | 추측하지 않고 재선택에도 넣지 않는다 |

‘더 바뀔 수 있음’이 있는 대상이 남아 있으면 화면은 확정이라 하지 않고 다시 관측한다: 진행 중 대상이 있으면 3초(명령 TTL로 한정), 진행 중은 없지만 바뀔 수 있으면 5→10→20→40→60초로 늦추다가 10분 동안 변화가 없으면 멈추고 그렇게 말한다. ‘회수 결과 새로 확인’과 보드의 ‘현황 새로 확인’은 언제나 배치를 다시 읽고, 숨겨진 탭은 관측하지 않는다. **유예**(이미 요청된 전송을 받는 시간, 배치별)와 **새 요청 가능 여부**(회차가 열려 있고 회수가 켜져 있는가)는 별개의 사실로 표시한다. 호환: `status`를 보내지 않는 이전 Service에서는 ‘구분 불가’로 표시하고 재선택을 제공하지 않는다. schema 변경 없음(배치 조회에 `observed_at`·`upload_open`·`new_request_allowed`·`new_request_blocked_by`·item `seat_revision`·`status`·요청 `updated_at` 추가).


<a id="remote-management-u2-20260921"></a>

#### U2 — 공지·자료의 대상 배포 · 2026-09-21 (설계 계약 · 구현 아님 · 같은 날 보완 1회)

상태: **설계만.** 제품 코드·migration 파일·실행 없음. RM-3·RM-5와 ADM-10/11의 구체화이고 인수는 [AT-44](../testing/classroom-admin.md#remote-management-u2-plan-20260921)다. Intent 연결은 #1165(`docs/intents/remote-classroom-operations.md`, 브랜치 `docs/751-classroom-ops-intent`)의 **INT-CO-04 — 2026-09-21 개정 제안, owner 승인 전**이다. 이 절은 그 제안이 승인됐다고 전제하지 않으며, 승인 전에는 구현·합성 검증까지만 가능하고 운영 활성화는 하지 않는다. 그 문서를 이 브랜치에 복제하지 않는다. 범위: **평문 공지(`notice`)와 자료(`material` = 본문 + 허용된 HTTPS 링크)**. 수업 프롬프트·수업 설정은 U3이고 아래 ‘U3와의 연결’만 정한다. 새 제품·인증 체계·상주 프로세스·WebSocket·화면 스트리밍을 만들지 않는다. 사용자 참고 DOCX는 UI 원칙의 참고일 뿐 그 예시를 정책으로 옮기지 않았다.

**보완 이력.** 첫 계약(`17aef2b`)을 독립 검토가 읽고 **미구현 계약의 공백** 일곱 가지를 짚었다(재현된 제품 결함이 아니다 — 코드가 없다): 배포 강사의 권한 철회 경계, 기존 자료를 잃지 않는 기기 쪽 커밋, 배포 실행과 카드의 단위 불일치, 미반영 파일의 복구와 receipt·ack 결속, sync 조건의 충돌, D1 한도 안의 원자성과 비용, 공통 확정 UI의 남는 안내. 이 절은 그 보완본이며 바뀐 결정은 각 소절에 ‘(보완)’으로 표시했다.

##### 이름과 권한 — `ops_delivery`와 섞지 않는다

| 말 | 뜻 (고정) | 식별자 |
|---|---|---|
| **발송**(delivery) | 검수·승인된 **보고서**를 수업 뒤 **수신자(보호자 등)**에게 보낸다. 기존 의미 그대로 | run flag `ops_delivery` · issuer capability `deliver` · `classroom_report_deliveries` — **변경 없음** |
| **배포**(distribution) | 수업 중 강사가 **고른 학생의 Studio 보관함**에 공지·자료를 넣는다 | run flag **`ops_distribute`**(신규, 기본 OFF) · issuer capability **`distribute`**(신규) · App 선언 capability **`distribution_inbox`** · 테이블 접두 `classroom_content_*` / `classroom_distribution*` |

- `distribute`는 `OPS_CAPABILITIES`에 추가되는 **독립** 권한이다. 기존 issuer 토큰은 어떤 조합(`observe`·`coach`·`collect`·`command`·`deliver`·`manage` 포함)을 갖고 있어도 배포할 수 없다 — 새로 발급한 토큰의 `scope.ops`에 `distribute`가 명시돼야 한다(`admin.ts`의 기존 `scope.ops` 검증이 목록 밖 값을 이미 거부하므로 발급 경로는 그대로 쓴다). 인증은 기존 `authorizeIssuerForOps(c, cohort, 'distribute')` 하나이고, 그 위에 아래 ‘배포 권한의 철회 경계’의 D1 fence가 얹힌다.
- `ops_distribute`는 `OPS_FLAGS`에 추가되는 회차 flag이고 `class_run_ops.flags_json`에서 요청마다 D1 primary로 읽는다(끄면 다음 요청부터 새 콘텐츠·새 배포·새 제안이 멈춘다 — receipt 정산과 회수 전달은 아래 sync 조건 표대로 계속된다). 전역 `HPS_CLASSROOM_OPS`가 꺼져 있으면 경로 자체가 404다. 구버전 Service는 이 flag 이름을 400으로 거부하고(`PUT …/runs/:run`의 기존 검증), 구버전 Chalk는 이 flag를 보내지 않으므로 OFF로 남는다.
- `/status`는 `collection{enabled,held}`와 같은 모양으로 `distribution{enabled,held,link_hosts_configured}`를 주고, 좌석마다 `distribution_inbox: declared | not_declared | unknown(연결 없음)`을 준다. Chalk는 `held && enabled`일 때만 배포 조치를 보인다.
- `send_question`·`mark_checkpoint`(`coach`)는 그대로 둔다. 질문 표시는 배포가 아니고, 배포는 질문을 대신하지 않는다.

##### 배포 권한의 철회 경계 — D1 fence (보완 1)

**첫 계약의 문장 ‘요청 시작 1회 검사, 창은 요청 1회’는 틀렸다.** 현재 코드에서 issuer 폐기는 KV 기록이고(`revokeToken`, `/admin/tokens/revoke`의 주석대로 다른 위치에 1분가량 늦을 수 있다) D1에서 닫히는 것은 `revokeOpsGrantsForIssuer`가 닫는 **그 issuer가 발급한 학생 연결뿐**이다. 배포한 강사 A와 학생 연결을 발급한 강사 B가 다르면 A의 폐기는 B의 연결을 닫지 않으므로, A가 이미 걸어 둔 배포는 계속 전달된다. KV 호출 지점은 세 곳이고 D1에 닿는 것은 하나뿐이다: `POST /admin/tokens/revoke`(D1 연동 있음) · `POST /admin/issuers`의 `revoke_jti` 재범위화(KV만) · `POST …/session/close`의 `jti`(KV만). 기존 인증 체계는 그대로 두고 **배포에 한해** D1에서 확정되는 경계를 하나 추가한다.

- **fence 테이블** `ops_issuer_fences(issuer_jti PK, state 'revoked'|'lifted', reason, recorded_by, revision, created_at, updated_at)` — 폐기된 issuer jti의 D1 기록(같은 migration). 새 인증 저장소가 아니라 폐기 사실의 primary 사본이며 토큰·scope를 담지 않는다. 지금은 배포만 이것을 읽는다(회수·명령의 기존 경계를 조용히 바꾸지 않는다).
- **enqueue에 연결.** `POST …/contents`·`POST …/distributions`·revoke/retire의 첫 조건부 INSERT/UPDATE guard에 `NOT EXISTS (SELECT 1 FROM ops_issuer_fences f WHERE f.issuer_jti=?요청 jti AND f.state='revoked')`가 들어간다. 권한을 읽은(KV 검증 통과) 뒤 폐기가 커밋되면 그 요청은 0건 기록으로 `403 issuer_revoked`다. D1은 쓰기를 직렬 처리하므로 ‘fence 커밋’과 ‘배포 커밋’ 사이에 틈이 없다: fence가 먼저면 guard가 막고, 배포가 먼저면 아래 sweep이 잡는다.
- **offer에 연결.** fence를 기록하는 **같은 batch**가 그 jti의 열린 배포를 닫는다(sweep): `classroom_distributions.revoked_at/revoked_by='system'/revoke_reason='issuer_revoked'`, 아직 반영되지 않은 대상(`accepted`·`offered`·`received`)은 `revoked`. sync의 제안 조건은 `d.revoked_at IS NULL`이므로 **학생 연결을 누가 발급했든** 그 배포는 다음 sync부터 실리지 않는다. 문장 수는 대상 수와 무관하다(UPDATE 2개 + fence 1개 + 감사 1개).
- **기존 경로와의 순서·부분 실패·재시도.**

| 경로 | 순서 | 부분 실패 | 재시도 |
|---|---|---|---|
| `POST /admin/tokens/revoke` | KV 폐기 → **D1 batch 1개**(기존 `revokeOpsGrantsForIssuer` UPDATE + fence upsert + sweep) → 그 뒤에만 `ok:true` | D1 실패 = 기존처럼 `500 {ok:false, kv_revoked:true}` — 폐기 **미완료**로 응답한다. 그동안 KV가 아직 닿지 않은 위치에서는 그 토큰의 새 배포가 접수될 수 있고, 대기 중 배포도 계속 실린다(이것을 막았다고 쓰지 않는다) | 같은 요청 반복 — fence upsert·sweep·grant UPDATE 모두 멱등 |
| `POST /admin/issuers` + `revoke_jti`(재범위화) | 새 토큰 서명(메모리) → **D1 fence**(+ 새 scope에 그 cohort의 `distribute`가 **없을 때만** sweep) → KV 폐기 → 감사 → 토큰 반환 | D1 실패 = `500`, KV 폐기 안 함, 새 토큰 **반환 안 함**(아무것도 바뀌지 않음). KV 실패 = fence는 선 상태 — 옛 토큰은 배포만 못 하고, `500 kv_revoke_failed`로 알린다 | 같은 `revoke_jti`로 다시 호출(fence 멱등, 새 토큰은 새로 서명) |
| `POST …/session/close` + `jti` | 기존 종료 처리 → D1 fence + sweep → KV 폐기 | D1 실패 = 종료는 성립(기존 동작 불변), 응답에 `distribute_fenced:false`. 회차가 끝났으므로 새 배포·제안은 어차피 `run_ended`로 막힌다 | close 재호출 또는 `/tokens/revoke` |
| `DELETE /admin/tokens/revoke/:jti`(un-revoke) | KV 삭제 → D1 fence `lifted`(revision+1) | fence 해제 실패 = 토큰은 되살아났으나 배포는 계속 막힘(닫힌 쪽으로 실패) · `500`으로 알림 | 반복. **sweep으로 닫힌 배포는 되살아나지 않는다** — 다시 보내려면 강사가 새로 배포한다(같은 revision은 기기에서 중복 카드를 만들지 않는다) |
| issuer 토큰 발급 | 변화 없음 — 새 jti는 fence에 없으므로 허용. 자연 만료(`exp`)는 폐기가 아니며 만료 전 접수된 배포는 회차 종료까지 유효 | — | — |
| 학습 토큰 재발급 | 변화 없음 — 학생 쪽 `connection_epoch`만 오른다(아래 재연결 표) | — | — |

- **주장하지 않는 것.** ① KV 재조회나 성공 응답만으로 철회가 원자적이라고 쓰지 않는다 — 원자적인 것은 **D1 batch가 커밋된 뒤**의 enqueue 거부와 제안 중단이다. ② **이미 기기에 보낸 sync 응답은 회수할 수 없다.** sweep 전에 나간 항목을 기기가 저장했다면 그 기기의 다음 receipt에 Service는 `recorded:false, reason:'revoked'`와 회수 tombstone으로 답하고 기기는 카드를 내린다. 그 기기가 다시 sync하지 않으면 카드는 남아 있고 Service는 그것을 `회수 확인 불가`로 표시한다(삭제 완료로 세지 않는다). ③ 폐기 **전에** 이미 반영된 자료는 그대로 둔다 — 그때의 권한으로 정당하게 간 것이다. 내리려면 `distribute`를 가진 다른 강사가 그 자료를 회수(retire)한다(자료는 작성자가 아니라 회차에 속한다).

##### 강사의 실제 흐름 (Chalk `/manage`, U1의 선택을 그대로 쓴다)

1. **선택** — U1의 공통 선택(개별·전체·상태 묶음). 새 배포의 대상 기본값은 **빈 선택**이며 선택이 비면 ‘보내기’는 비활성이다. 직전 배포의 대상을 기본값으로 되살리지 않는다.
2. **작성** — 종류(공지/자료)·제목·본문·링크. ‘저장’은 **불변 revision**을 만든다(아래 `POST …/contents`). 기존 자료를 고치면 같은 object의 다음 revision이다. 저장만으로는 어떤 학생에게도 아무것도 가지 않는다.
3. **미리 확인** (`dry_run`) — 한 화면에 ① 내용(제목·본문·링크 그대로)과 `object · revision · hash 앞 8자` ② 대상 좌석과 좌석별 예정: `지금 전달 가능` / `미연결 — 회차가 끝나기 전에 다시 연결되면 전달` / `이 앱은 보관함을 지원하지 않음` / `이미 같은 revision이 이 기기 보관함에 있음(예상)` / `더 새 revision이 이미 있음(보내지 않음)` ③ 만료(기본 = 회차 종료 시각) ④ 영향: `학생의 과제·입력·대화·파일은 바뀌지 않습니다. 비선택 N명에게는 아무것도 가지 않습니다.` 확인 화면의 Primary는 ‘N명에게 보내기’ 하나(DT-07).
4. **확정** — U1의 **선택 세대(ticket) 검증을 그대로 재사용**한다: 요청 전에 회차·명단 revision·좌석·좌석별 학생·연결·권한(`distribution.held/enabled`)을 고정하고, 선택·명단·연결·권한 변경/취소/더 새로운 요청/연결 해제는 세대를 올리며, 늦게 도착한 미리 확인 응답은 확인 화면을 열지 못한다. 확정 시 현재 화면의 선택·명단·`content_hash`와 다시 대조한다. 새 검증 장치를 만들지 않고 `pickTicket`·`selectionKeyNow()` 계열을 조치 종류에 무관한 공통 함수로 쓴다. **(보완 7)** 공통 함수로 옮길 때 확인 단계의 안내(`확인만 했습니다. 아래에서 요청해야 기기에 전달됩니다.`)는 **확정이 접수되는 순간 확정 뒤의 말로 바뀌고**, 결과 영역이 최종 상태를 말하는 동안 그와 모순되는 과거 안내는 화면에 남지 않는다. 회수(U1)와 배포가 같은 규칙을 쓴다 — 실제 Mac의 U1 선택 회수에서 ‘서버 검증됨 · 결과 확정’ 옆에 이 안내가 남아 있던 것이 관측됐다(U1 기능 인수와는 별개의 문구 후속).
5. **대상별 결과** — 아래 ‘대상 상태’ 표의 말로 좌석마다 **전달 증거**와 **현재 보관함 상태**를 나란히 표시하고 관측 시각과 ‘더 바뀔 수 있는가’를 밝힌다. 재관측: 확정 뒤 2분 동안 또는 최근 30초 안에 변화가 있었으면 3초, 그 밖에는 5→10→20→40→60초, 10분 무변화 시 정지(수동 새로 확인, 숨겨진 탭은 관측 안 함). 오프라인 대상이 회차 끝까지 열려 있어도 3초 관측이 이어지지 않는다. **‘실패·미확인만 다시 선택’**은 새 요청을 보내지 않고, 누르는 순간 최신 결과와 보드를 다시 읽어 그사이 반영됨·좌석 교체·철회된 대상을 뺀 뒤 선택만 채운다. 반영된 학생은 다시 실행하지 않는다.
6. **이전 배포물 다시 찾기** — 같은 화면의 ‘보낸 자료’ 목록(`GET …/contents`, 최신순 50개씩): 제목·종류·최신 revision·회수 여부·배포 횟수·마지막 배포 시각(**결과 집계는 목록에 싣지 않는다** — 대상 원장을 훑게 되기 때문이다). 항목을 열면 revision별 내용과 그 revision의 배포 실행들, 실행을 열면 대상별 결과(그때 한 번 집계)가 나온다. 결과를 다시 열어도 아무것도 재전송되지 않는다.

##### 서버 저장 — 불변 콘텐츠와 배포 실행을 나눈다 (additive migration 1개)

착수 시점의 다음 번호(현재 기준 `0023-classroom-distribution.sql`). 기존 테이블은 건드리지 않는다. `worker/schema.sql`에 같은 정의를 넣고 기존 D1 리허설(0011→…)에 포함한다. `*_at`은 unix ms.

| 테이블 | 열 (핵심) | 불변성·키 |
|---|---|---|
| `classroom_content_objects` — 자료 머리 | `object_id` PK · `class_run_id` · `cohort_id` · `kind` · `latest_revision` · **`event_seq`** · `retired_at` · `retired_by` · `retire_seq` · `created_by` · `created_at` | `kind`는 생성 뒤 불변. `latest_revision`은 **object마다** 따로 오른다(전역 revision 없음), revision 생성은 CAS. `event_seq`는 **이 자료에 일어난 배포·회수 사건의 순번**(보완 3) — 배포 확정·배포 회수·자료 회수가 같은 batch 안에서 1씩 올린다 |
| `classroom_content_revisions` — 불변 내용 | `object_id` · `revision`(1부터) · `class_run_id` · `kind` · `title` · `payload_json`(kind별 검증된 본문: notice/material = `{body, links:[{label,url}]}`) · `content_hash` · `schema`=`hps-classroom-content/1` · `created_by` · `issuer_jti` · `created_at` · `idempotency_key` | PK(`object_id`,`revision`) · UNIQUE(`class_run_id`,`idempotency_key`). 제품 경로에 UPDATE·DELETE 없음. `content_hash` = SHA-256(`[schema, kind, title, body, [[label,url]…]]`의 정규 JSON) |
| `classroom_distributions` — 배포 실행 1건 | `id` · `class_run_id` · `cohort_id` · `object_id` · `revision` · `content_hash` · **`seq`**(확정 때의 `event_seq`) · `roster_revision` · `targets_json` · `request_hash` · `idempotency_key` · `expires_at` · `created_by` · `issuer_jti` · `created_at` · `revoked_at` · `revoked_by` · `revoke_reason` · **`revoke_seq`** · `row_revision` | UNIQUE(`class_run_id`,`idempotency_key`). 대상·내용·만료는 생성 뒤 불변. 바뀌는 것은 회수(`revoked_*`, `row_revision` CAS)뿐 |
| `classroom_distribution_targets` — 대상 결속과 결과 | `distribution_id` · `class_run_id` · `seat_id` · `seat_revision` · `student_id` · `object_id` · `revision` · **`state`**(전달 증거) · **`card_state`**(현재 보관함 상태) · `result_code` · `device_generation` · `device_registration_id` · `grant_id` · `connection_epoch` · `offer_key` · `offers` · `next_offer_at` · `first_offered_at` · `received_at` · `reflected_at` · `withdraw_seq` · `withdraw_offers` · `withdraw_acked_at` · **`pending`**(0/1: Service가 이 대상에게 실을 것이 있음) · `updated_at` | PK(`distribution_id`,`seat_id`) · **부분 인덱스** `(class_run_id, seat_id) WHERE pending=1`(idle sync가 훑는 행 0) · INDEX(`class_run_id`,`student_id`,`object_id`)(대체·같은 revision·회수 coverage 조회). 최종 전이는 기존 `ops_audit`. 본문 없음 |
| `ops_issuer_fences` — 폐기된 issuer의 D1 기록 | 위 ‘철회 경계’ | PK(`issuer_jti`) |

여러 자료가 한 회차에 공존한다(object가 다르면 서로의 revision·`event_seq`·결과에 영향이 없다). 같은 자료의 수정은 새 revision이고, 이전 revision 행과 그 배포 결과는 그대로 남는다. 보존 기간·만기 삭제는 새로 정하지 않는다(아래 ‘미결’). 철회·보존 정리(`classroom_erasure`)가 이 테이블을 다루는 방식은 구현 단계에서 기존 원장에 **추가**로 연결한다 — 학생 식별자(`student_id`)를 가진 것은 targets뿐이고 학생이 쓴 내용은 어디에도 없다.

##### API — 기존 강사 prefix와 기존 App sync를 확장한다

강사(`/admin/cohorts/:cohort/classroom/runs/:run` 아래, `distribute` + `ops_distribute`, 모두 `no-store`, 모르는 필드는 **거부**). `instructor-auth.ts`의 issuer 허용 경로 정규식과 Chalk forwarder에 `contents`·`distributions` 하위 경로를 추가한다.

| 경로 | 요청 | 응답·실패 |
|---|---|---|
| `POST …/contents` | `{idempotency_key, kind, title, body, links?, object_id?, expected_latest_revision?}` — `object_id` 없음 = 새 자료(rev 1), 있음 = 다음 revision(`expected_latest_revision` 필수) | `201 {object_id, revision, content_hash, kind, title, created_at}` · 같은 key+같은 내용 `200` 같은 결과 · 같은 key+다른 내용 `409 idempotency_conflict` · `409 revision_conflict`(다른 강사가 먼저 고침, 입력은 화면에 유지) · `409 object_retired` · `409 run_ended` · `403 issuer_revoked` · `400 content_invalid{field}` · `400 link_host_not_allowed` · `429 content_limit` · 저장 실패 `503 storage`(아무것도 만들어지지 않음) |
| `GET …/contents?cursor=` | — | 자료 머리 + 최신 revision 메타 + 배포 횟수·마지막 배포 시각, 50개씩. 본문·결과 집계 없음 |
| `GET …/contents/:object/revisions/:rev` | — | 그 revision의 내용(작성 강사 화면용) |
| `POST …/distributions` | `{idempotency_key, object_id, revision, content_hash, targets[], expected_roster_revision, expires?:{at}, dry_run}` | `dry_run:true` → `200` 대상별 예정만, **쓰기 0**, key 소모 없음 · 확정 `201` 배포 view · 같은 key+같은 요청 `200` 같은 결과(응답 유실·더블클릭·이후 명단이 바뀌었어도) · 같은 key+다른 내용/대상/만료/revision `409 idempotency_conflict` · 아래 ‘원자성’의 `409`/`403` · 빈 대상·중복·형식 오류·회차 밖 좌석·모르는 필드(`target`,`seats`,`all` 등) `400/404` — **어떤 경우에도 전체로 넓히지 않는다** |
| `GET …/distributions?object_id=&cursor=` · `GET …/distributions/:id` | — | 실행 목록(50개씩, 집계 없음) · 실행 1건의 대상별 `state·card_state·status·result_code·시각·can_change·reselectable` + `observed_at`·`new_request_allowed`·`new_request_blocked_by`. 조회는 먼저 **그 실행의** 기한 지난 대상을 정산한다(타이머 없음 — 기존 `settleOverdue` 방식, PK 접두로 한정) |
| `POST …/distributions/:id/revoke` | `{expected_row_revision}` | **배포 1건의 회수**(아래 ‘배포와 카드의 단위’). 이미 회수됐으면 같은 결과. 회차가 끝난 뒤에도 가능 |
| `POST …/contents/:object/retire` | `{expected_latest_revision}` | **자료 전체의 회수**: 머리에 `retired_at`·`retire_seq`, 그 object의 열린 배포 전부 회수, 이후 그 object의 새 revision·새 배포 `409 object_retired`. 조건부 batch 한 번 |

App(`POST /v1/classroom/ops/sync`, 기존 자격·4초 제한·single-flight·backoff 그대로). **학생용 콘텐츠 조회 API는 만들지 않는다** — 내용은 자격이 확인된 그 sync 응답으로만 나간다. 블록이 오가는 조건은 아래 ‘sync 조건과 한도’ 표 하나가 정본이다.

```jsonc
// 요청에 추가 (보낼 receipt가 없으면 생략)
"distribution": { "receipts": [ { "offer_key": "…32hex", "distribution_id": "…", "object_id": "…", "revision": 2,
    "content_hash": "…64hex", "seq": 7,
    "stage": "received | reflected | failed | superseded | withdrawn", "result_code": "", "observed_at": 0 } ] }   // ≤ 6
// 응답에 추가 (말할 것이 없거나 · 미선언이거나 · 교환이 실패하면 블록 자체가 없다 — 없음은 ‘소식 없음’이지 성공이 아니다)
"distribution": {
  "items": [ { "offer_key": "…", "distribution_id": "…", "seq": 7, "object_id": "…", "revision": 2, "kind": "notice",
      "schema": "hps-classroom-content/1", "title": "…", "body": "…", "links": [ { "label": "…", "url": "https://…" } ],
      "content_hash": "…", "from": "instructor", "issued_at": 0,
      "expires_at": 0, "apply_within_ms": 30000 } ],                           // ≤ 2개 그리고 ≤ 24 KiB
  "withdraw": [ { "object_id": "…", "seq": 9, "reason": "revoked | retired | issuer_revoked" } ],   // ≤ 10
  "receipt_acks": [ { "offer_key": "…", "stage": "reflected", "recorded": true, "reason": "" } ], // 받은 receipt 수만큼
  "more": false }                                                               // true면 1초 뒤 다시
```

##### 대상의 정체성, 커밋 경계의 원자성, 멱등 — D1 한도 안에서 (보완 6)

- **대상 = `(class_run_id, seat_id, seat_revision, student_id)`** 의 명시적 집합이다. 연결(grant)·epoch·기기는 대상의 일부가 **아니다** — 그것은 전달 시점마다 다시 검사하는 자격이다. 선택은 요청의 `targets`에 적힌 좌석뿐이며 ‘현재 필터’ 같은 서버 쪽 해석은 없다.
- **문장 수가 대상 수에 비례하지 않는 조건부 batch 한 트랜잭션.** [D1 한도](https://developers.cloudflare.com/d1/platform/limits/)(2026-09-21 확인분: Worker 호출당 쿼리 Free 50 / Paid 1,000, 문장당 bound parameter 100, SQL 100 KB, batch 포함 30초)에서 200석도 **한 batch**로 끝나야 한다. 대상을 좌석마다 한 문장으로 펼치거나 큰 `VALUES`에 바인딩하지 않는다. 읽은 좌석을 `[[seat_id, seat_revision, student_id], …]`의 **JSON 문자열 하나**(`?targets`, 식별자 상한 128자 × 200석 ≈ 최악 60 KB, 보통 수 KB — bound 값 1개)로 묶어 `json_each`로 푼다:

| # | 문장 (모두 같은 `db.batch`) | bound 수(대략) |
|---|---|---|
| 1 | `INSERT INTO classroom_distributions(…, seq) SELECT …, (SELECT event_seq+1 FROM classroom_content_objects WHERE object_id=?) WHERE <guard>` | ≤ 25 |
| 2 | `INSERT INTO classroom_distribution_targets(…) SELECT ?id, ?run, json_extract(j.value,'$[0]'), json_extract(j.value,'$[1]'), json_extract(j.value,'$[2]'), …, CASE WHEN <같은 학생·같은 object의 더 높은 revision이 유효> THEN 'superseded' ELSE 'accepted' END, … FROM json_each(?targets) j WHERE EXISTS(<1의 행>)` | ≤ 12 |
| 3 | `UPDATE classroom_distribution_targets SET state='superseded', pending=0 … WHERE class_run_id=? AND object_id=? AND revision<? AND state IN ('accepted','offered','received') AND student_id IN (SELECT json_extract(value,'$[2]') FROM json_each(?targets)) AND EXISTS(<1의 행>)` | ≤ 8 |
| 4 | `UPDATE classroom_content_objects SET event_seq=event_seq+1 WHERE object_id=? AND EXISTS(<1의 행>)` | ≤ 3 |
| 5 | `INSERT INTO ops_audit … SELECT … WHERE EXISTS(<1의 행>)` | ≤ 8 |

  확정 1회의 전체 쿼리 = 사전 읽기(회차 1 · 멱등 조회 1 · 활성 좌석 1 · revision 1 · 분당 횟수 1) + 위 5 + 결과 view 2 = **≤ 12**, 30석이든 200석이든 같다. 여러 transaction으로 나누지 않으며, 나눠야만 한다면 전 대상 원자성을 주장하지 않는다. sweep·revoke·retire도 같은 모양(UPDATE … WHERE 집합)이라 문장 수가 고정이다. (관찰: 기존 U1 `report-batches`는 item·target을 좌석마다 한 문장으로 넣는다 — 큰 회차에서 Free 한도와 부딪칠 수 있는지는 이 설계의 범위 밖이며 U2는 그 모양을 따라 하지 않는다.)
- guard: ① 회차 존재 + `roster_revision` 일치 ② `json_extract(flags_json,'$.ops_distribute')=1` ③ 회차 미종료(`ends_at>now` 그리고 `sessions.ended_at IS NULL`) ④ **요청한 모든 좌석**이 `replaced_at IS NULL`이고 `seat_revision`·`student_id`가 읽은 값과 같음(`NOT EXISTS (… json_each(?targets) … NOT EXISTS (class_run_seats …))` — 고유 인덱스 probe N회) ⑤ 그 `(object_id, revision)` 행이 있고 `content_hash`가 같으며 object가 `retired_at IS NULL` ⑥ `expires_at`이 `now`보다 뒤이고 회차 종료 시각 이하 ⑦ **요청 jti에 `revoked` fence 없음**. 어긋나면 배포·대상·감사 **0건**이고 새로 읽어 `409 revision_conflict / run_ended / changed_during_request / object_retired / content_mismatch` 또는 `403 ops_distribute_disabled / issuer_revoked`. 재조회 한 번으로 대체하지 않는다. `POST …/contents`도 같은 방식이다(머리 CAS + revision INSERT + 회차·flag·fence guard).
- `request_hash` = SHA-256(정규화한 `[object_id, revision, content_hash, 정렬된 targets, expires_at, roster_revision]`). 같은 key + 같은 hash = 기존 결과 재생, 같은 key + 다른 hash = `409`. 배포 행을 **정상 조회에서** 읽지 못하면(조회 예외·손상) 재생·결과 조회·전달 모두 `503`으로 닫는다 — 서버 오류를 ‘전체 대상’이나 ‘이전 revision 성공’으로 읽지 않는다.
- **같은 revision의 재배포는 새 적용을 만들지 않는다 — 단, 아래 조건이 모두 참일 때만**(보완 3). 그 참가자가 **지금 연결된 그 기기**(`device_registration_id`)에서 같은 `(object, revision, hash)`를 `reflected`했고, 그 뒤 그 참가자·그 자료에 회수 tombstone이 나간 적이 없으며(`withdraw_seq` 없음), 자료가 회수(retire)되지 않았다. 이 판정은 **확정 때가 아니라 제안하려는 순간**에 한다(확정 때는 오프라인이라 기기를 모를 수 있다) — 참이면 본문을 싣지 않고 그 대상을 `no_change`·`card_state='present'`로 닫는다. 더 새 revision이 이미 유효하면 확정 때 `superseded`다(되돌리려면 옛 내용으로 새 revision을 만든다).

##### 대상 상태 — 전달 증거(`state`)와 현재 보관함 상태(`card_state`)를 나눈다 (보완 3)

과거 실행이 남긴 **수신·반영 증거**와 그 자료가 **지금 그 기기 보관함에 있는가**는 다른 사실이다. 회수는 앞의 것을 지우지 않는다. Service가 둘에서 화면 말(`status`)·`can_change`·`reselectable`을 계산해 주고 Chalk는 옮길 뿐이다(U1 `collectStatus`와 같은 자리). 기기가 보고할 수 있는 단계는 `received·reflected·failed·superseded·withdrawn`뿐이다. `state`는 같은 `device_generation` 안에서 앞으로만 간다.

| `state` (전달 증거) | 화면의 말 (RM-5 공통 어휘) | 누가 아는 사실인가 | 더 바뀔 수 있음 | 재선택 |
|---|---|---|---|---|
| `accepted` | 접수 — 아직 어떤 기기에도 보내지 않음(미연결이면 `다시 연결되면 전달`) | Service: 의도가 기록됨 | 예 | – |
| `offered` | 수신 확인 전 — 서버가 응답에 실었음 | Service만. 기기가 받았다는 증거가 아니다(HTTP 200 포함) | 예 | – |
| `received` | 기기 수신 — 보관함 반영 확인 전 | 기기 receipt: 받은 내용의 hash를 다시 계산해 일치 | 예 | – |
| `reflected` | **보관함 반영**(= 이 흐름의 ‘적용’) | 기기 receipt: 아래 ‘적용의 정의’ | – | – |
| `no_change` | 이미 같은 revision이 이 기기에 반영돼 있음 | Service(위 조건) | – | – |
| `failed` | 실패 · 사유(`hash_mismatch`·`store_failed`·`inbox_full`·`schema`·`unsupported_kind`·`hash_conflict`·`apply_deadline`) | 기기 receipt | – | 가능 |
| `unsupported` | 이 앱은 보관함을 지원하지 않음 | Service: 자격 있는 기기가 `distribution_inbox`를 선언하지 않음 | 새 기기 세대면 예 | 가능(앱 교체 뒤) |
| `superseded` | 더 새 revision으로 대체됨 | Service 또는 기기 receipt | – | – |
| `revoked` | 회수됨 — 반영 전에 멈춤(`revoked`·`retired`·`issuer_revoked`) | Service | – | – |
| `expired` | 전달 안 됨 · 만료 | Service: 만료까지 **한 번도** 싣지 못함 | – | 회차가 열려 있을 때만 |
| `unconfirmed` | **미확인** — `기기에 도착했을 수 있으나 반영 보고가 없습니다. 성공으로 세지 않습니다. 다시 보내도 같은 revision은 중복 카드를 만들지 않습니다.` | Service: 한 번 이상 실었으나 만료까지 최종 receipt 없음 | 예(늦은 `reflected`만) | 가능 |
| `target_changed` | 대상 변경 — 좌석 주인이 바뀜/좌석에서 빠짐 | Service | – | 새 명단에서 다시 선택 |
| (모르는 값) | 결과 미확인 — 추측하지 않음 | – | 예 | – |

| `card_state` (현재 보관함) | 화면의 말 | 뜻 |
|---|---|---|
| `none` | – | 이 실행으로 이 기기에 카드가 생긴 적 없음 |
| `present` | 보관함에 있음 | `reflected`/`no_change`이고 회수되지 않음 |
| `covered` | 회수됨 — 같은 자료가 다른 배포로 유지됨(그 실행 표시) | 이 실행은 회수됐으나 같은 참가자·같은 자료의 **다른 유효 배포**가 카드를 받치고 있어 기기에 tombstone을 보내지 않음 |
| `withdraw_pending` | 회수 요청 — 기기 확인 전 | tombstone을 실을 차례이거나 실었으나 `withdrawn` receipt 없음 |
| `withdrawn` | 기기 보관함에서 회수됨 | 기기 receipt `withdrawn` |
| `detached` | 좌석이 바뀌어 학생 화면에 더 나타나지 않음(기기에 파일은 남아 있을 수 있음) | 대상이 `target_changed`가 됐고 그 전에 카드가 있었음. 회수 완료로 세지 않는다 |
| `withdraw_unconfirmed` | **회수 확인 불가** — `이 기기가 다시 연결되지 않아 카드가 남아 있을 수 있습니다. 이미 본 내용은 되돌릴 수 없습니다.` | 그 기기의 연결이 폐기·만료돼 tombstone을 전할 길이 없음. **원격 삭제 완료로 세지 않는다** |

`모두 반영`은 전 대상이 `reflected`·`no_change`일 때만 쓴다. **회수의 ‘서버 검증됨’, 배포의 ‘보관함 반영’, 복구의 결과 코드는 같은 단계 어휘(접수 → 수신 확인 전 → 기기 수신 → 적용 / 실패 / 미확인 / 만료·대상 변경) 위의 서로 다른 사실**이며 한 ‘성공’ 숫자로 합치지 않는다(AT-41). 비선택 학생은 targets 행 자체가 없다: 제안 0 · 콘텐츠 읽기 0 · 보관함 파일 변화 0.

##### 배포와 카드의 단위 — 실행별 회수, 자료 전체 회수, 사건 순번 (보완 3)

기기의 카드는 **자료(object) 하나에 한 장**이고 배포·회수는 **실행(distribution) 단위**다. 둘을 잇는 것은 두 가지다.

- **coverage — 카드를 내릴지는 Service가 정한다.** 한 참가자의 한 자료에 대해 *유효한 배포* = 회수되지 않았고(`revoked_at IS NULL`), 자료가 retire되지 않았고, 그 참가자의 대상이 `reflected`·`no_change`이거나 아직 열려 있는(`accepted`·`offered`·`received`) 실행. `…/distributions/:id/revoke`는 같은 batch에서 그 실행의 미반영 대상을 `revoked`로 닫고, 반영된 대상은 **다른 유효한 배포가 없을 때만** `card_state='withdraw_pending'`(+`withdraw_seq`, `pending=1`), 있으면 `covered`로 둔다(한 UPDATE의 `CASE WHEN EXISTS(…)`). 그래서 **D1(v1) 반영 → D2(같은 v1 `no_change` 또는 v2 `reflected`) → D1 회수**에서 D2가 받치는 카드는 내려가지 않는다. `…/contents/:object/retire`는 coverage를 보지 않고 그 자료의 모든 유효 카드를 `withdraw_pending`으로 만든다.
- **사건 순번 `seq` — 늦게 온 것이 이기지 못하게 한다.** 자료마다 `event_seq`가 배포 확정·실행 회수·자료 회수 때 1씩 오르고(같은 batch), 제안 항목은 그 실행의 `seq`를, tombstone은 회수 사건의 `seq`를 싣는다. 기기의 index는 자료마다 **마지막으로 적용한 `seq`**를 갖고 규칙은 하나다: **들어온 사건의 `seq`가 가진 `seq`보다 클 때만** 적용한다(제안은 추가로 `revision ≥ 가진 revision`). 서버가 더 낮은 revision의 확정을 `superseded`로 닫으므로 `seq` 순서와 revision 순서는 어긋나지 않는다.

| 경우 | 결과 |
|---|---|
| D1(v1, seq 1) 반영 → D2(v1) 확정 → D1 회수(seq 3) | D2는 제안 순간 `no_change`·`present`. D1은 `covered` — tombstone 없음. 뒤에 D2도 회수(seq 4)되면 그때 tombstone(seq 4 > 1) |
| D1(v1, seq 1) 반영 → D2(v2, seq 2) 반영 → D1의 늦은 회수(seq 3) | D2가 유효 → D1 `covered`, tombstone 없음, 카드는 v2 그대로 |
| D1 회수가 먼저 커밋돼 tombstone(seq 3)이 대기 중일 때 D2(seq 4) 확정 | 두 사건 모두 기기로 간다. 어느 순서로 도착해도 끝은 같다: tombstone 먼저면 내렸다가 seq 4 제안으로 다시 생기고, 제안이 먼저면 seq 3 tombstone은 `seq` 비교로 버려진다(ack `stale`) |
| 회수 뒤 늦은 제안(이미 나간 응답, seq 1) | 기기가 tombstone(seq 3)을 갖고 있으면 저장하지 않음. 아직 못 받았으면 저장될 수 있고, 그 receipt에 Service가 `recorded:false, reason:'revoked'` + tombstone으로 답해 다음 sync에 내려간다 — 그 사이 보이는 시간이 이 경계다 |
| retire 뒤 늦은 제안 | 위와 같다. 이후 그 자료의 새 배포·새 revision은 `409 object_retired` |
| 같은 자료의 동시 배포·회수(강사 둘) | D1의 직렬 쓰기가 `event_seq`로 순서를 정한다. 회수는 `row_revision` CAS — 진 쪽은 `409`로 다시 읽는다 |

##### 오프라인·재연결 — 의도는 참가자에 묶이고, 연결은 매번 다시 검사한다

배포 의도는 **같은 회차의 같은 참가자**(`seat_revision`·`student_id`)에 결속되고 기본 만료는 **회차 종료**(`class_run_ops.ends_at`, 강사가 더 이르게만 줄일 수 있다)다. 옛 연결의 명령을 새 grant/epoch에 복사하지 않는다 — 대상 행은 참가자에 묶여 있고, sync마다 아래 ‘sync 조건과 한도’의 제안 조건을 **모두** 새로 확인한 뒤에만 싣는다. 싣는 순간 `grant_id`·`connection_epoch`·`device_registration_id`·`offer_key`를 그 제안의 증거로 대상 행에 적는다. 좌석 lease는 지금 `ops_commands`가 켜져 있거나 receipt가 있을 때만 `commandExchange` 안에서 잡히므로, 구현은 lease 확보를 공통 함수로 빼 `ops_distribute`만 켜진 회차에서도 owner 창이 정해지게 한다(명령 전달 조건은 바꾸지 않는다).

| 사건 | 연결에 일어나는 일 (기존 동작) | 아직 반영되지 않은 의도 | 이미 반영된 보관함 |
|---|---|---|---|
| 일시 단절 → 같은 앱 재접속 | 같은 grant·epoch·기기 세대 → **같은 `offer_key`** | **허용** — 다음 sync에서 다시 싣는다(backoff). 기기는 `object·revision·hash·seq`로 중복 제거 | 그대로 |
| 앱 재시작(같은 기기, 새 `boot_id`) | 같은 grant(`resume()`) → 같은 `offer_key` | **허용** — 위와 같다. 미전송 receipt는 디스크 저널에서 재전송. **재시작 전에 받아 두기만 한 미반영 파일은 스스로 승격하지 않는다**(아래 보관함) | 디스크에서 복구돼 카드가 다시 보인다 |
| 같은 기기의 다른 창이 lease owner가 됨 | 같은 grant·epoch, lease 세대만 +1 | **허용** — 보관함·저널은 같은 디스크라 새 owner 창이 이어서 보고한다. `offer_key` 불변, 두 창의 동시 쓰기는 보관함 잠금이 막는다 | 그대로 |
| 학습 토큰 재발급(같은 학생·좌석) | 같은 grant, `connection_epoch`+1 → **새 `offer_key`** | **허용** — 같은 참가자다. 옛 key의 receipt는 `stale_offer`로 거부되고 현재 epoch로 다시 싣는다. 이미 가진 항목이면 기기는 다시 쓰지 않고 새 key로 `reflected`를 보고한다 | 그대로(같은 학생) |
| 기기 교체(같은 학생이 새 1회용 코드로 연결) | 옛 grant `revoked: device_replaced`, 새 grant·새 `device_registration_id` | **허용** — 새 기기에 싣는다. 옛 기기의 늦은 receipt는 거부(grant 불일치) | 새 기기 보관함은 비어 있다. 의도가 아직 유효(미회수·미만료·회차 열림)하면 Service가 그 대상을 `device_generation`+1·`accepted`·`card_state='none'`으로 **되돌려 새 기기에 다시 싣고** 감사에 `target_rebound_device`를 남긴다(이전 세대의 반영 시각은 감사에 남는다). 옛 기기는 최종 거부를 받으면 그 회차 보관함을 **숨긴다** |
| 좌석의 학생 교체(a→b) | `seat_revision`+1, a의 grant는 `seat_replaced`로 거부 | **거부** — a의 대상은 `target_changed`. b에게는 **아무것도 가지 않는다**(b는 대상이 아니다) | a의 기기는 최종 거부를 받고 그 회차 보관함을 숨긴다 |
| 같은 학생이 다른 좌석으로 이동 | 옛 좌석 행 교체, 새 좌석·새 연결 | **거부** — 옛 좌석 대상은 `target_changed`. 자동 이관하지 않는다(명시적 선택 집합). 강사가 새 좌석을 다시 선택 | 보관함은 좌석·학생 단위라 새 좌석은 빈 보관함으로 시작한다. 옛 좌석의 카드는 더 나타나지 않고 그 대상의 `card_state`는 `detached` |
| 강사가 연결 해제 / 학생 연결을 발급한 issuer 폐기 | grant `revoked` | **거부** — 새 연결이 생기기 전에는 실을 곳이 없다. 같은 참가자가 다시 연결되면 ‘기기 교체’와 같다 | 최종 거부 → 숨김. 대기 중이던 회수는 `withdraw_unconfirmed` |
| **배포한** 강사의 issuer 폐기·재범위화 | 학생 연결은 그대로(다른 강사가 발급했을 수 있다) | **거부** — D1 sweep으로 그 강사의 열린 배포가 `revoked`(위 ‘철회 경계’) | 그대로. 이미 나간 응답의 경계는 위에 적었다 |
| 회차 종료(강사 종료·시각 경과) | sync는 grant 만료(`ends_at`+1h 상한)까지 계속되나 poll 60초 | **거부** — 새 콘텐츠·새 배포·새 제안 없음(`run_ended`). 한 번도 못 실은 대상은 `expired`, 실었던 대상은 늦은 receipt만 받고 그 밖에는 `unconfirmed` | 읽기는 계속 가능(로컬, ‘끝난 수업의 자료’ 표시). 회수 tombstone은 grant가 살아 있는 동안 전달된다 |
| 새 회차 | 새 `class_run_id`·새 연결 | **거부** — 의도는 회차에 묶여 있다 | 작업 화면·진입 화면은 **현재 회차 보관함만** 보인다. 지난 회차 자료는 나타나지 않는다 |

##### sync 조건과 한도 — 세 가지 흐름을 따로 정한다 (보완 5)

첫 계약의 ‘flag가 켜져 있을 때만 블록’과 ‘꺼져 있어도 receipt 기록’, ‘종료 뒤 늦은 reflected만’과 ‘회수의 withdrawn 확인’은 서로 부딪쳤다. 블록 하나 안에 **조건이 다른 세 흐름**이 있다. 공통 전제: 기존 sync 검사(자격 서명 · grant `active`·미만료 · `seat_live` · `ops_observe`)를 통과했고, 이 `(grant, app_instance, boot)`가 `distribution_inbox`를 선언했으며, 좌석 lease의 **owner 창**이다. 전제가 깨지면 셋 다 없다.

| 조건 | ① 새 내용 제안(`items`) | ② 과거 receipt 정산·ack | ③ 회수 tombstone 전달(`withdraw`) |
|---|---|---|---|
| `ops_distribute` ON · 회차 진행 중 | **예** — `target.seat_revision·student_id = grant의 값` · 배포 미회수 · 자료 미retire · `now < expires_at` · `state ∈ {accepted, offered, received}` · `next_offer_at ≤ now` | 예 | 예 |
| `ops_distribute` OFF | 아니오 | **예** — 이미 나간 제안의 증거다. 끄는 것은 rollback이지 증거 폐기가 아니다 | **예** — 회수는 안전 조치라 rollback 중에도 나간다 |
| 회차 종료 뒤(grant는 유효) | 아니오 | 예 — `first_offered_at < 종료 시각`인 제안의 `received`·`reflected`·`failed`·`superseded`와 모든 `withdrawn` | 예(grant 만료까지) |
| 배포가 자체 `expires_at`을 넘김 | 아니오 | 예 — 만료 전에 실었던 것의 늦은 receipt만 | 예 |
| 배포 회수·자료 retire·배포 강사 fence | 아니오 | receipt는 **기록하지 않고** `recorded:false, reason:'revoked'` + tombstone으로 답한다. `withdrawn` receipt는 기록 | 예 |
| 좌석 교체·참가자 불일치 | 아니오(`target_changed`) | 도달 불가 — 그 자격의 sync는 `403 seat_replaced` | 도달 불가 |
| grant 폐기·만료 | **sync 자체가 401/403** — 셋 다 없다. 대기 중이던 회수는 `withdraw_unconfirmed`, 미반영 대상은 만료 때 `expired`/`unconfirmed` | | |
| lease owner가 아닌 창 | 아니오 | 아니오 — 그 창은 보내지 않는다(저널은 공유 디스크, owner 창이 보낸다) | 아니오 |
| 배포 교환 중 예외 | 블록 없음 · 관측/명령/채팅은 계속 | 기기는 저널을 지우지 않는다 | — |

블록은 위 전제 아래 **말할 것(①②③ 중 하나)이 있을 때만** 응답에 있다. flag가 꺼져 있고 말할 것이 없으면 기존 응답과 바이트까지 같다.

| 유한해야 하는 것 | 한도 | 넘으면 |
|---|---|---|
| 회차당 자료(object) / 자료당 revision | 50 / 20 | `429 content_limit` — 기존 자료·수업 불변 |
| 회차당 배포 실행 / 분당 | 200 / 20 | `429 rate_limited` |
| 배포 1건의 대상 | `MAX_SEATS`(200) | `400` |
| sync 응답 `items` | 2개 그리고 24 KiB | 나머지는 `more:true` → 1초 뒤 |
| sync 응답 `withdraw` | 10 | `more:true` |
| sync 요청 `receipts` (= 응답 `receipt_acks`) | 6 — receipt마다 조회 1 + 갱신 1이라 호출당 쿼리 예산을 지키기 위한 값 | 나머지는 다음 sync. 7개 이상이면 `400`이 아니라 앞의 6개만 처리하고 `more:true` |
| 같은 기기 세대에 대한 제안 재시도 | 5→10→20→60초로 10회, 이후 5분에 1회, 만료까지(2시간 수업 기준 ≤ 34회) | 멈춤 · `수신 확인 전` 유지 → 만료 시 `unconfirmed` |
| tombstone 재시도 | 같은 간격 | grant 만료 시 `withdraw_unconfirmed` |
| 기기 receipt 저널 | 200건 | 가득 차면 **새 항목을 받지 않는다**(`failed: journal_full`은 다음 기회에 보고) — 기존 카드·채팅 불변 |
| 목록 page | 자료·배포 50, 대상 200(한 page) | cursor |
| 기기 보관함 | 회차당 50 object · 1 MiB, 전체 5 MiB | `failed: inbox_full` — **조용히 밀어내지 않는다** |
| sync 1회의 U2 문장 수 | 대기 없음 0(기존 grant 조회의 subquery 1개) · 최악 ≤ 18(제안 조회 1 + 제안 기록 1 + receipt 6×2 + tombstone 조회 1·기록 1 + 정산 2) | 기존 경로와 합쳐 호출당 ≤ 45를 시험에서 센다 |

부분 결과(`more:true`), 미확인, `offered`는 어느 집계에서도 성공이 아니다.

##### 기기 보관함 — 저장·표시·‘적용’의 정의

- **위치와 결속.** `globalStorageUri/classroom-inbox/<cohort>/<class_run>/<seat>.<student>/`(식별자는 기존 `safe()` 방식으로 정규화) — 대상과 같은 단위(회차·좌석·학생)다. 화면에 보이는 보관함은 **지금 유효하거나 정상 만료된 마지막 연결**이 증명한 그 단위 하나뿐이며, 연결이 없으면(최종 거부 뒤 포함) 아무것도 보이지 않는다. 학생 workspace·대화·초안·spool 밖이며 보관함 코드는 이 디렉터리 밖에 **쓰지 않는다**.
- **파일 계약 (보완 2) — 가진 자료를 잃지 않는 커밋.** 첫 계약의 `item-<object>.json` 덮어쓰기는 ‘v2로 덮은 뒤 index rename 실패 → index는 v1인데 파일은 v2 → reconciler가 v1 카드까지 제거’가 가능했다. 바꾼다:

```
rev/<object>.<revision>.<hash 앞 16자>.json   불변. 한 번 쓰면 덮어쓰지 않는다(tmp → rename, 이미 있으면 hash 검증 뒤 재사용)
index.json      유일한 가변 파일. {schema:'hps-classroom-inbox/2', index_revision, objects:{<object>:{revision, content_hash, seq,
                file, kind, title, reflected_at, tombstone?:{seq, reason}, sources:[{offer_key, reflected_acked}]}}}
journal.json    보낼 receipt (offer_key, stage, …) — 보내기 전에 기록, ack 뒤에만 삭제
index.lock      O_EXCL로 만드는 잠금(pid·boot·시각, 10초 지나면 stale) — 같은 기기의 두 창(각자 extension host)을 직렬화
quarantine/     hash가 맞지 않는 수신물
```

  한 항목의 적용 순서 — **모든 `await` 뒤에 연결 세대·학생 신원·`apply_within_ms`를 다시 검사**하고 어긋나면 그 자리에서 멈춘다(그때까지 쓴 것은 참조되지 않는 rev 파일뿐이라 무해하다): ① 검증·hash 재계산 → 저널 `received` ② rev 파일 쓰기(불변) ③ 잠금 획득 → index를 **다시 읽어** 순수 reducer로 판정(`seq`·revision·tombstone) → 새 index를 tmp에 쓰고 rename(`index_revision`+1) → 잠금 해제 ④ `readInbox()`로 디스크에서 다시 읽어 pointer → rev 파일 → hash 재검증 ⑤ 저널 `reflected` ⑥ index가 더는 가리키지 않는 옛 rev 파일 정리(**index commit이 성공한 뒤에만**, 가리키는 파일은 절대 지우지 않는다). 같은 object의 쓰기는 host 안에서 object별 큐로 직렬화하고, 창 사이는 잠금과 `index_revision` 재확인(CAS)으로 막는다.

| 중단 지점 (v1이 이미 있고 v2를 적용하는 중) | 디스크 | 재시작 뒤 | 거짓 `reflected` |
|---|---|---|---|
| rev 파일 tmp 쓰는 중 | index=v1, v1 파일 온전, tmp 조각 | tmp 삭제. **v1 카드 그대로.** v2는 다시 제안될 때 적용 | 0 — 저널에 `received`뿐 |
| rev 파일 rename 뒤, index 전 | index=v1, v1·v2 파일 | 참조되지 않는 v2 파일은 **승격하지 않고 지운다**(아래). v1 카드 그대로 | 0 |
| index tmp 쓰는 중 / rename 실패 | index=v1(rename은 전부 아니면 전무) | 위와 같다. rename이 거부되면(Windows에서 다른 프로세스가 파일을 열고 있을 때의 `EPERM`/`EBUSY` 등) 50→100→200ms 3회 뒤 `failed: store_failed`, **index 불변·v1 카드 유지** | 0 |
| index rename 뒤, 저널 `reflected` 전 | index=v2 | reconciler가 index의 `sources[].reflected_acked=false`를 보고 v2를 재검증한 뒤 저널에 `reflected`를 만든다 | 0 — 반영은 사실이다 |
| 저널 `reflected` 뒤, 전송·ack 전 | index=v2, 저널 보유 | 저널 재전송. ack가 오면 `reflected_acked=true` | 0 |
| v2 반영 뒤 **늦은 v1 writer**(지연된 응답·다른 창) | — | ③에서 다시 읽은 index의 `seq`/revision이 더 크다 → 쓰지 않고 `superseded` | 0 |
| 회수 뒤 늦은 writer | — | index의 tombstone `seq`가 더 크다 → 쓰지 않음 · 저널 `superseded`(`result_code: withdrawn_newer`) | 0 |
| index가 가리키는 rev 파일이 없거나 hash가 다름(디스크 손상) | — | 그 항목만 ‘읽을 수 없는 자료 — 강사에게 다시 요청하세요’로 표시하고 저널 `failed: store_corrupt`. **다른 카드는 건드리지 않는다** | 0 |

  Windows의 rename-over-existing 동작, 보안 프로그램의 파일 점유, 한글 사용자 폴더 경로는 **실기 NOT RUN**이며 위 재시도·실패 규칙은 그 환경에서 확인하기 전까지 설계일 뿐이다.
- **미반영 파일은 스스로 승격하지 않는다 (보완 4).** 첫 계약의 ‘index에 없는 항목 파일은 검증해 index에 올린다’를 버린다 — 상대 시간(`expires_in_ms`)만 가진 파일은 재시작하면 monotonic 원점을 잃고, 그사이 회차가 끝났거나 회수됐을 수 있다. **이미 `reflected`된 자료를 다시 여는 것**은 로컬 읽기이고 새 검증이 필요 없다. **미반영 항목을 새로 적용하는 것**은 언제나 *방금 받은 sync 응답*(= Service가 그 순간의 자격·만료·회수 여부를 확인했다는 증거)에서만 시작하고, 받은 시점부터 monotonic으로 `apply_within_ms`(30초) 안에 index commit까지 끝나야 한다. 넘기거나(`failed: apply_deadline`), 연결 세대가 바뀌거나, 재시작하면 그 시도는 버려지고 reconciler는 **참조되지 않는 rev 파일을 전부 지운다** — 다시 필요하면 Service가 다시 싣는다(≤ 12 KiB). 기기 시계(`Date.now()`)는 어떤 판정에도 쓰지 않고, 표시용 시각은 응답의 `server_time`을 쓴다.
- **오프라인 기기에 대한 경계.** 제안이 나간 뒤 회수·폐기가 있었고 그 기기가 그 사실을 모른 채 오프라인이면 즉시 막을 방법은 없다. 보장하는 것은 상한이다: 그 기기가 적용을 끝낼 수 있는 시간은 응답을 받은 뒤 **30초**이고, 그 뒤에는 새 sync 응답 없이는 아무것도 새로 나타나지 않는다. 이미 나타난 카드는 다음 sync에서 tombstone을 받아 내려가며, 다시 sync하지 않는 기기는 Service에서 `withdraw_unconfirmed`로 남는다.
- **receipt와 ack의 결속 (보완 4).** `offer_key` = SHA-256(`distribution_id · seat_id · device_generation · grant_id · connection_epoch · object_id · revision · content_hash`)의 앞 32자 — Service가 제안 때 계산해 대상 행에 적는다. 같은 grant·epoch·기기 세대의 재전달은 같은 key(멱등)이고 그 셋 중 하나라도 바뀌면 다른 key다. receipt는 `offer_key`와 풀어 쓴 필드를 함께 보내고 Service는 **현재 대상 행의 `offer_key`와 같고** 풀어 쓴 필드가 일치할 때만 기록한다(아니면 `recorded:false, reason:'stale_offer'`). ack는 `(offer_key, stage)`를 되돌려 주며 기기는 **정확히 그 쌍**의 저널 항목만 지운다 — 옛 연결의 늦은 ack가 새 저널을 지우지 못한다. `recorded:false`의 사유가 최종(`stale_offer`·`revoked`·`target_changed`·`expired`)이면 그 저널 항목을 내리고, 그 밖(`storage` 등)이면 보관한다. 구분: **같은 기기의 새 boot·lease owner 변경**은 key가 그대로라 이어서 보고하고, **토큰 재발급**은 epoch가 바뀌어 새 key로 다시 실리며, **기기 교체**는 `device_generation`이 올라 옛 기기의 receipt가 전부 `stale_offer`다.
- **서로 다른 증거.** ① 접수(Service) ② 제안/수신 확인 전(Service) ③ 기기 수신 = 받은 항목의 schema가 유효하고 다시 계산한 hash가 `content_hash`와 같으며 이 순간에도 같은 연결 세대·같은 학생임 → `received` ④ 저장 = 위 ②③ 단계(기기 내부, 단독 보고 없음) ⑤ **보관함 반영 = 적용**: index commit 뒤 host가 **카드 목록이 쓰는 바로 그 읽기 경로**(`readInbox()`)로 디스크에서 다시 읽어 hash를 재검증했고, 그 항목이 현재 `(학생, 회차)`의 표시 목록에 들어 있음 → `reflected` ⑥ 실제 열람(학생이 카드를 펼침)은 **수집하지 않는다** — 기기 안에서만 ‘새 자료’ 표시를 끄는 데 쓴다.
- **완료로 세지 않는 것.** sync HTTP 200, `offered`, 알림(toast) 호출, webview로의 `postMessage` 호출. 알림은 ‘강사가 자료를 보냈습니다 · 보관함에서 열기’ 한 줄의 편의일 뿐이고 실패해도 결과에 영향이 없다. 반대로 **webview가 닫혀 있어도** 반영은 성립한다(사이드바를 접은 학생을 영원히 ‘실패’로 두지 않기 위해). 그래서 화면의 말은 ‘읽음’이 아니라 ‘보관함 반영’이고, 열람·이해·학습 완료를 뜻하지 않는다고 결과 영역에 적는다.
- **카드가 실제로 보이는 경로(인수에서 증명할 것).** host → webview `inboxState{run, student, inbox_generation, items[]}`. webview는 mount·다시 보일 때 `inboxRequest`를 보내고 host는 **항상 디스크에서** 답한다(메모리 목록을 정본으로 두지 않는다 — 지금의 `coachingNotes` 배열·`showInformationMessage` 방식은 재시작에 사라지므로 쓰지 않는다). 반영 직후에도 같은 메시지를 민다.
  - **작업 중 화면**(`ChatPanel.tsx` 코치 rail, ‘이번 단계 안내’ 아래): `<details>` ‘강사가 보낸 공지·자료 (N)’ — 기본 닫힘, 새 항목은 **글자**로 `새 자료 1개`(색만으로 표시하지 않음), 항목마다 `강사가 보냄 · 공지|자료 · 받은 시각 · 수정됨(rev N)`과 본문. SX-06이 rail에 허용한 ‘강사 메시지’ 유형이며 메시지 스트림·canvas·evidence drawer에 넣지 않는다(SX-05·SX-13). Primary를 추가하지 않는다(SX-04). 모달·자동 펼침·자동 스크롤 없음.
  - **‘이어서 하기’ 진입 화면**(`StartPage.tsx` 연결된 활동 카드): Primary ‘이어서 하기’ 아래의 조용한 텍스트 줄 `강사가 보낸 공지·자료 N개`를 펼치면 같은 목록. 두 번째 Primary·숫자 배지 강조 없음(SX-02/04).
  - 두 화면은 같은 host 읽기 경로·같은 메시지를 쓴다. 키보드만으로 펼치기·링크 조치가 되고 포커스가 보이며, 200% 확대·390px에서 본문이 가로로 넘치지 않는다(DES-02/03/06, DT-02/04).
- **재시작 reconciler의 순서.** ① 잠금 ② index 읽기 — 읽을 수 없으면 보관함을 비어 있는 것으로 표시하고 파일은 `quarantine/`으로 옮긴다(지우지 않는다) ③ tmp·참조되지 않는 rev 파일 삭제 ④ index의 각 pointer 재검증(위 ‘디스크 손상’ 행) ⑤ 저널 읽기: `received`만 있고 index에 없는 항목은 저널에서 내린다(보고할 반영이 없다 — 다시 실리면 새로 시작), index에 있고 `reflected_acked=false`인 source는 저널에 `reflected`가 없으면 만든다 ⑥ 잠금 해제 ⑦ 그 뒤에야 sync가 저널을 보낸다.
- **끝난 renderer의 callback.** webview에서 오는 `inboxRequest`·`inboxOpen`·`inboxLink`는 `{run, student, inbox_generation}`을 싣고, host는 답하기 직전에 현재 연결 세대·현재 검증된 학생 신원·현재 회차와 다시 대조한다. 어긋나면 빈 상태로 답하고 아무것도 열지 않는다. sync 응답도 기존 연결 generation 검사를 그대로 거친다: 연결이 끝났거나 바뀐 뒤 도착한 `items`·`withdraw`·`receipt_acks`는 **적용하지 않고 버린다**(U1·F2와 같은 규칙).
- **권한 철회 뒤의 캐시 (보완 4·5).** 최종 거부(`ops_grant_revoked`·`seat_replaced`·`device_replaced`)를 받은 기기는 그 연결의 회차 보관함을 **숨긴다**(삭제하지 않는다): 그 기기는 이제 회수를 통보받을 길이 없으므로 강사 소유 내용을 계속 보여 주는 쪽이 더 위험하다. 미반영 항목은 위 규칙대로 어차피 새로 나타나지 않는다. **정상 만료**(수업이 끝남)는 최종 거부가 아니며 카드는 ‘끝난 수업의 자료’로 계속 열린다. 다른 학생의 토큰이 확인된 공용 PC에서는 목록 자체가 비어 있다(디렉터리가 좌석·학생별이고 host가 연결의 학생과 현재 검증된 토큰의 학생을 대조한다).

##### 순서·회수·종료 (요약 — 단위와 순번의 규칙은 위 두 소절이 정본)

| 경우 | 기기 | Service / 강사 화면 |
|---|---|---|
| v2 반영 뒤 **늦은 v1** | index의 `seq`·revision이 더 크다 → 저장하지 않고 `superseded`. 카드는 v2 한 장 | v1 대상 `superseded`. 확정 시점에 이미 아는 경우는 제안조차 하지 않는다 |
| 같은 revision 재전달(응답 유실·재시작) | hash가 같으면 다시 쓰지 않고 `reflected`를 다시 보고 | 같은 `(offer_key, stage)`의 재보고는 `recorded`(멱등). 상태·시각 불변 |
| 같은 revision인데 hash가 다름 | 저장하지 않음. 가진 것을 유지하고 받은 것은 격리 · `failed: hash_conflict` | 불변 revision 위반 — 감사에 남기고 자동 재시도하지 않는다 |
| 저장 뒤 receipt 유실 | 저널이 보관, 다음 sync(재시작 포함)에 재전송 | 만료까지 못 받으면 `unconfirmed`(성공으로 세지 않음). 늦은 `reflected`는 반영 |
| 저장 실패(디스크·권한·용량·rename 거부) | index 불변·**기존 카드 유지** · `failed: store_failed`/`inbox_full` | 실패 — 재선택 대상 |
| 적용 도중 중단(어느 경계든) | 위 중단 지점 표 | 그동안 `offered`/`received`로 보이고, 다시 실려 끝난 뒤에야 `reflected` |
| 실행 회수 — 반영 전 | 받지 않는다 | 대상 `revoked` |
| 실행 회수 — 반영 뒤 | 다른 유효 배포가 없을 때만 tombstone → 본문을 지우고 `강사가 회수한 자료입니다` → `withdrawn` receipt. **학생의 초안·대화·파일은 건드리지 않는다**(학생이 옮겨 적은 글은 학생의 것이다) | `card_state`: `covered` 또는 `withdraw_pending` → `withdrawn` / 기기가 돌아오지 않으면 `withdraw_unconfirmed`. `state`의 반영 증거는 그대로 남는다. 화면은 `이미 본 내용은 되돌릴 수 없습니다`를 함께 말한다 |
| 자료 전체 회수(retire) | 그 자료의 카드가 내려간다 | 그 자료의 모든 실행 회수 + 새 revision·배포 거부 |
| 회차 종료 뒤 | 새 항목 없음. 반영돼 있던 카드는 로컬에서 계속 열린다 | 새 콘텐츠·배포 `409 run_ended`, 결과 조회·‘보낸 자료’·회수는 계속 가능 |

##### 내용과 학생 통제

- **평문만.** 제목 ≤ 80자, 본문 ≤ 2,000자(UTF-8 ≤ 8 KiB), 제어문자 거부, 저장 전 기존 `scrubSecrets`. 기기와 Chalk 모두 `textContent` + `white-space: pre-wrap`으로 그린다 — `MarkdownText`·`innerHTML`을 쓰지 않으므로 HTML·script·마크다운은 **글자로 보일 뿐 실행·해석되지 않는다.** 셸 명령·파일 경로도 데이터다: 보관함은 어떤 문자열도 명령·경로·URL로 **자동 해석하지 않는다**.
- **링크.** ≤ 5개, `label` ≤ 60자, `https:`만, userinfo·IP 리터럴·`localhost`·`.local`·443 외 포트 거부, URL ≤ 500자, host는 Service 설정 `HPS_CLASSROOM_LINK_HOSTS`(쉼표 목록, **기본 빈 값 = 모든 링크 거부**)에 있어야 한다. 기기는 링크를 `이름 + 주소 글자`로 보여 주고 학생이 누른 **‘브라우저에서 열기’/‘주소 복사’**에서만 기존 `openExternal` 경로(https 재검사)를 쓴다. 자동 열기·미리 가져오기·다운로드·AI 호출·프롬프트 자동 삽입은 없다. 화면과 결과 어디에도 링크 배포를 ‘파일 전달/다운로드 완료’로 쓰지 않는다 — 말은 `링크가 보관함에 반영됨`이다.
- **덮어쓰지 않는다.** 기존 미션·단계·입력창·대화·workspace 파일·spool에 쓰지 않는다. 강사 출처(`강사가 보냄`)를 항상 표시하고 학생 작업물·현재 미션이 화면의 중심에 남는다(Mission header·canvas 불변). 학생은 카드를 접어 둘 수 있고 읽기를 강요받지 않는다(모달·차단 0).
- 본문은 Service의 `classroom_content_revisions`와 대상 기기의 보관함에만 있다. 보드·감사·대상 원장에는 id·revision·hash뿐이다.

##### U3와의 연결 — 지금 막아 두지 않을 것

- **프롬프트**는 같은 object/revision 모델의 `kind:'prompt'`다. 학생은 카드에서 **보고**, ‘초안에 가져오기’를 직접 눌렀을 때만 입력 초안에 들어간다(자동 전송·자동 삽입 없음). ‘보관함 반영’은 ‘사용함’이 아니다. 그래서 `kind`는 열거형 TEXT, 내용은 kind별 검증기를 가진 `payload_json`이다.
- **수업 설정**은 `kind:'setting'`, payload = 승인된 `{module, version, settings{허용 목록 키}}` 참조다. 실행 중인 turn은 고정하고 **다음 경계**에서 App과 Service가 **같은 effective revision**을 적용한다. 참가자별 effective 값은 회차·참가자에 묶인 `classroom_distribution_targets`(유효한 배포의 coverage 규칙 그대로)에서 읽으며, `modules.ts`의 profile/cohort 전역 pin을 바꾸는 것으로 학생별 배포를 대신하지 않는다. receipt `stage`와 `state`가 TEXT이고 앞으로만 가는 규칙이라 `reflected` 뒤에 `applied_at_boundary` 같은 단계를 **추가**할 수 있다.
- 수업 텍스트는 권한이 아니다. 어떤 kind의 payload도 새 도구 접근·더 비싼 모델·권한 상승을 만들 수 없고, 설정 검증기는 profile이 이미 허용한 범위 안의 값만 받는다(ADM-11).
- U2 구현은 `notice`·`material` 외의 kind를 `400 content_invalid{kind}`로 거부하고, 모르는 kind를 받은 기기는 저장하지 않고 `failed: unsupported_kind`로 답한다.

##### 비용 — 기존 sync와 U2 증가분, 그리고 실측 계획 (보완 6)

기존 HTTPS sync(4초 제한·single-flight·5→10→20→60초 backoff)와 기존 outbox/저널 방식을 그대로 쓴다. 새 연결·daemon·스트리밍 없음. 아래는 **소스를 읽어 센 문장 수와 산술 모델**이며 실측이 아니다. D1의 과금·한도 단위는 반환 행이 아니라 **훑은 행(`rows_read`)과 쓴 행(`rows_written`, 인덱스 갱신 포함)**이다([가격](https://developers.cloudflare.com/d1/platform/pricing/) · [한도](https://developers.cloudflare.com/d1/platform/limits/), 2026-09-21 확인분). **이 계정이 Free인지 Paid인지는 확인하지 않았다** — ‘포함량 대비 무시할 크기’라고 쓰지 않는다. Free라면 일 읽기 500만·쓰기 10만·호출당 50쿼리를 넘는 순간 쿼리가 거부된다.

| 구간 | 기존 (U2와 무관, 현재 소스) | U2 증가분 |
|---|---|---|
| idle sync 1회 | 읽기 4문장(grant·기기·최신 상태·control) + 45초마다 쓰기 batch 1(2문장). `ops_commands` ON이면 lease 조회, 정산 UPDATE 3, lease 갱신/배정, 대기 명령 조회로 +6 안팎 | **문장 +0, 쓰기 0.** grant 조회에 subquery 1개(부분 인덱스 `pending=1` probe — 대기가 없으면 훑는 행 0~1) |
| 수업 2시간의 sync 수 | 30석 43,200 · 100석 144,000 · 200석 288,000 (기존 비용표의 5초 polling 전제) | 위 probe만큼: ≤ 43,200 · 144,000 · 288,000행 읽기(대기 없을 때의 상한 가정 1행/회) |
| 배포 확정 1회 | — | ≤ 12쿼리. 쓰기 ≈ 1 + 대상 N×4(행 1 + PK·부분·학생 인덱스 3) + 머리 1 + 감사 2 → 30석 ≈ 125행, 100석 ≈ 405행, 200석 ≈ 805행. guard의 좌석 probe N행 읽기 |
| 대상 1명의 정상 전달 | — | 제안 기록 1회·`received` 1회·`reflected` 1회, 각 ≈ 3행(행 + 바뀌는 인덱스) + 감사 2 ≈ **11행 쓰기** → 확정분 포함 대상당 ≈ 15행 |
| 대상 1명의 최악(만료까지 무응답) | — | 제안 ≤ 34회 × ≈ 2행 ≈ 68행 + 정산 3행. 본문 재전송 ≤ 34 × 12 KiB |
| 재접속 폭주(전 좌석이 동시에 돌아옴) | 좌석당 sync 1회 | 좌석당 대기 항목 ≤ 2개/응답, 1초 간격으로 소진. 좌석당 추가 문장 ≤ 18/회 |
| 강사 결과 관측 | — | 실행 1건 조회 = 대상 N행 읽기(PK 접두) + 정산 UPDATE 2. 실행당 관측 상한 ≈ 52회(2분×3초 + backoff→10분 정지) → 30석 ≈ 1,560행 · 100석 ≈ 5,200행 · 200석 ≈ 10,400행 읽기/실행/강사 |
| ‘보낸 자료’ 목록 | — | page당 ≤ 50행(자료 머리) + 배포 횟수 집계(실행 테이블, 자료당 ≤ 200행). 대상 원장은 훑지 않는다 |

전 좌석 대상 배포 10건, 2시간, 강사 1명의 **증가분 합(모델)**:

| | 30석 | 100석 | 200석 |
|---|---:|---:|---:|
| 쓰기 — 전원 정상 | ≈ 4,500행 | ≈ 15,000행 | ≈ 30,000행 |
| 쓰기 — 전원 최악(무응답) | ≈ 22,500행 | ≈ 75,000행 | ≈ 150,000행 |
| 읽기 — probe + 확정 + 관측 | ≈ 60,000행 | ≈ 200,000행 | ≈ 395,000행 |
| 본문 전송 — 정상 / 최악 | ≤ 3.5 / 120 MiB | ≤ 11.7 / 400 MiB | ≤ 23.4 / 800 MiB |

최악 쓰기는 Free의 일 10만 행을 100석 한 수업으로 위협하고 200석에서는 넘는다 — 그래서 재시도 상한을 위 표처럼 두었고, **실측 전에는 어느 plan에서도 ‘된다’고 쓰지 않는다.**

**측정 계획과 허용 한도(구현 단위 3·4의 종료 조건).** 시험 harness가 D1 응답의 `meta.rows_read`·`meta.rows_written`과 호출당 문장 수를 경로별로 합산해 기록한다. 허용 한도: ① idle sync의 U2 증가분 `rows_written = 0`, `rows_read ≤ 1`, 문장 +0 ② 확정 1회 ≤ 12쿼리·문장당 bound ≤ 30·200석에서도 batch 1개 ③ 대상 1명의 정상 전달 `rows_written ≤ 20` ④ sync 1회 전체 문장 ≤ 45 ⑤ 30/100/200석 합성에서 위 모델 대비 +25% 이내, 넘으면 인덱스·문장을 고치고 모델을 고친다. 실행 층은 **로컬 workerd의 D1**이다(Node SQLite의 값은 인덱스 계수가 달라 참고만). **운영 D1의 latency·쿼터·직렬 처리 대기·30초 batch 한도는 staging에서 실행하기 전까지 NOT RUN**이고, 로컬 결과를 운영 실측이라고 부르지 않는다.

**장애 격리.** sync 안의 배포 교환은 기존 `commandExchange`처럼 try/catch로 감싸 실패 시 블록만 빠지고 관측·명령·채팅은 계속된다. 기기의 보관함 I/O 오류는 채팅·수업 패널을 막지 않는다. Service가 죽어 있어도 이미 반영된 카드는 로컬에서 열린다. 오래된 데이터의 **시간 기준 삭제는 정하지 않았다**(아래).

##### 재사용 지점과 구현 때의 소유 파일 (지금은 어느 것도 수정하지 않았다)

| 층 | 재사용 | 새로 만들/고칠 파일 |
|---|---|---|
| Service | `authorizeIssuerForOps` · `parseFlags`/`OPS_FLAGS`/`OPS_CAPABILITIES` · U1 조건부 batch guard · `settleOverdue`식 lazy 정산 · `ops_audit` · `scrubSecrets` · sync의 grant·seat_live·lease 검사 · `sha256Hex`·`canonicalPayload` · `budget-views.ts`의 revision guard 모양(참고) | 신규 `worker/src/lib/classroom-distribution.ts`(순수: 검증·정규화·hash·상태 전이·status·`offer_key`) · 신규 `worker/src/routes/classroom-distribution.ts` · `worker/migrations/0023-classroom-distribution.sql` + `worker/schema.sql` · 수정 `worker/src/lib/classroom-ops.ts`(flag·capability 목록) · `worker/src/routes/classroom-ops.ts`(sync 블록, `/status`, lease 공통화, fence·sweep 함수) · **`worker/src/routes/admin.ts`(폐기·재범위화·un-revoke·session close의 세 호출 지점)** · `worker/src/lib/instructor-auth.ts`(경로) · route mount |
| App | `ClassroomOpsHost`의 연결 generation·`globalStorageUri`·저널 패턴 · `startOpsSync` deps · 기존 `openExternal` 가드 · `protocol.ts` 메시지 계약 | 신규 `extensions/hypeproof-chat/src/classroomInbox.ts`(순수 reducer: `seq`·revision·tombstone·저널) · 수정 `classroomOps.ts`(sync 본문/응답 타입, capability) · `classroomOpsHost.ts`(보관함 adapter·잠금·저널·reconciler) · `chatPanelProvider.ts`·`startPage.ts`·`protocol.ts` · webview `ChatPanel.tsx`·`StartPage.tsx`(+ 작은 `InstructorInbox.tsx`) |
| Chalk | `/manage`의 공통 선택·`pickTicket`/`selectionKeyNow`·재관측 cadence·`element()`/`text()` 안전 렌더 · 기존 forwarder | 수정 `chalk/src/ui/manage.html`(작성·미리 확인·결과·보낸 자료, 확정 뒤 안내 정리) · forwarder 경로 |
| 시험 | 기존 fixture(합성 강사 A/B·학생·30석), `mac-demo*.mjs`, D1 리허설 | 신규 `worker/test/classroom-ops-distribution.test.mjs` · `extensions/hypeproof-chat/test/classroom-inbox.test.mjs` · `e2e/classroom/ops-distribution.mjs` · `mac-demo*.mjs` 확장 |

##### 미결 결정과 권고 (조사로 정할 수 없는 것만)

| 결정 | 선택지 | 권고와 근거 | 미정이어도 가능한 일 |
|---|---|---|---|
| INT-CO-04 승인과 ‘적용’의 뜻 | 승인 / 수정 / 보류 (owner) | 승인 시 ‘적용 = 보관함 반영(열람 아님)’을 함께 확인. 이 절은 제안 문구와 충돌하지 않아 Intent 추가 수정은 준비하지 않았다 | 구현·합성·로컬 실기 |
| 허용 링크 host 목록 | 빈 값 유지 / 운영 도메인만 / 교육 자료 도메인 추가 | **빈 값으로 시작**하고 첫 수업 전 운영자가 목록을 정한다 — 임의 도메인을 기본값으로 박지 않는다 | 공지·본문만 있는 자료 |
| 열람(펼침) 사실의 수집 | 수집 안 함 / 고지 뒤 수집 | **수집 안 함.** 읽음 표시는 감시로 읽히고 열람은 이해의 증거가 아니다. 바꾸려면 수집 고지 문안에 포함해야 한다 | 전부 |
| 보관함·서버 콘텐츠의 시간 기준 보존 | 기존 보존 결정(목적별 일수)에 포함 / 별도 | 기존 ‘보존 일수’ 결정에 **항목으로 추가**해 함께 정한다. 그때까지 기기는 용량 한도만 있고, 가득 차면 실패로 알린다. 권고: 끝난 회차 보관함부터 오래된 순으로 비우기 | 단일·소수 회차 시험 |
| 배포 권한을 누구에게 줄지 | 강사 전원 / 지정 강사 | 회차를 맡은 강사에게만 명시 발급(`distribute`). 운영 승인 사항 | 합성 issuer |
| Cloudflare plan과 D1 예산 | Free / Paid (계정 사실 — 미확인) | 운영 전 운영자가 확인. Free라면 위 최악 쓰기 모델이 일 한도를 넘으므로 100석 이상 회차에서 `ops_distribute`를 켜지 않거나 Paid 전환이 선행 | 로컬 workerd 실측 |
| 운영 활성화(`ops_distribute` ON, production migration) | — | U1과 같은 순서: additive migration → flag OFF 호환 배포 → 성인 canary 회차 | — |

#### 발송 공급자 선택 근거

저장소에 재사용할 메일 공급자 설정이 없었다(`scripts/notify`의 SMTP는 운영자 알림용). Worker는 HTTP만 쓸 수 있고, 전달 원장은 메시지별 idempotency key를 이미 갖고 있으며, 전달/반송은 **서명된** 사건으로 받아야 한다.

| 후보 | HTTP API | 발송 idempotency key | 서명된 webhook | 판단 |
|---|---|---|---|---|
| Resend | 예 | `Idempotency-Key` 헤더, 24시간 | Svix HMAC-SHA256(`svix-id/timestamp/signature`) | **채택** — 원장의 key·unknown 조정과 그대로 맞는다 |
| Amazon SES | 예(SigV4) | 없음 | SNS 인증서 서명 | Worker에서 검증·서명 구현 부담이 크고 중복 방지를 직접 져야 함 |
| SendGrid | 예 | 없음 | ECDSA 서명 | 발송 중복 방지가 공급자 쪽에 없음 |
| Postmark | 예 | 없음 | 서명 없음(Basic auth/IP) | 서명 검증 요건 미충족 |
| Gmail API(기존 [delivery-options](../../skills/hain7-report/references/delivery-options.md)의 파일럿 1순위) | 예(OAuth) | 없음 | 없음 | 전달/반송 사건을 받을 수 없어 `provider_accepted` 이후를 확인할 수 없음 |

Resend 항목은 2026-09-19 공식 문서(idempotency keys, verify webhooks, event types)에서 확인했고 Svix 공개 테스트 벡터로 서명 검증을 시험했다. 다른 후보의 칸은 작성자의 기존 지식이며 같은 날 재확인하지 않았다 — 채택을 바꿀 때는 다시 확인한다. 비용·보존(공급자의 본문/주소 보관 기간, 국외 처리)·발신 도메인 SPF/DKIM/DMARC는 계정 개설 시 운영자가 확인할 항목이다. 열람·클릭 추적은 읽지 않으며 켜지 않는 것을 전제로 한다.

### 이번 인수 범위와 후속 범위 (2026-09-20)

**이번 인수 = 관제 + 단일 회차 보고서.** 회차 명단·입장·단계·오류 관측, 원격 복구와 질문형 코칭, 강사 확인, 동의 기반 회수, 그 **한 회차**의 관찰 보고서 초안·검수·승인, 링크(열람자 확인 포함) 메일 발송과 전달 원장, 철회·보존 정리.

**후속 범위 — 이번 인수의 합격 조건이 아니다.** 아래는 코드가 없고, 이번 PR 묶음의 완료 여부와 분리해 순서를 정한다.

| 항목 | 지금 상태 | 선행 조건 |
|---|---|---|
| 누적 회차 ‘최근 반복된 패턴’ 본문 | 누적 근거가 2회 이상이면 절 제목과 “검수자가 작성” 안내만 나온다. 자동 서술 없음 | 회차 간 근거 연결 규칙, 누적 서술의 검수 절차 |
| PDF 메일 첨부 | 링크만 보낸다. PDF는 같은 페이지의 print 렌더(`scripts/classroom-report-pdf.mjs`)로 운영자가 만들 수 있다 | 첨부의 보존·회수 불가 문제에 대한 운영 결정, Worker에서의 렌더 방식 |
| Kakao 알림톡·SMS | 없음. 채널은 `email`만 허용 | 사업자 채널·발신번호 승인, 공급자 계약([delivery-options](../../skills/hain7-report/references/delivery-options.md)) |
| 교실 QR 전달 | 없음 | 대면 전달 시 열람자 확인 방식 |
| 링크 열람자의 본인 **인증** | 없음(위 열람자 확인은 2차 요소) | 보호자 계정/인증 수단 결정 |

### 구현·운영 결정 경계

지금 확정 가능한 설계는 기존 Chalk 확장, App 안의 제한 실행기, Service 권한·D1 명령 원장, 증거 보존형 reset, 배치별 검수·전달 상태다. 구현 순서·소유 파일·출시/롤백은 [기존 E5 실행 계획](../plan/learning-agent-experience-epics.md#remote-classroom-delivery)을 따른다. 테스트는 [AT-15~34](../testing/classroom-admin.md#remote-classroom-tests)로 연결한다.

파일럿 전 운영자가 정할 값: 실제 수업 인원/동시 반 수·학교망, 허용 복구 action, 수집 목적/고지·동의·보존, 수신자 정본/발신 계정, 신규 6모델 평가 출력의 검수자, 자동 발송 승인 정책, 원격 화면 도구 필요 여부. 이 값이 미정이어도 합성 계정의 관제·명령·dry-run 구현은 진행할 수 있다. 실수업 수집·발송·권한 변경·production migration 활성화만 해당 gate에서 멈춘다.
