# 치과 홈페이지 강의 제작 자동화

신규 **강사 페르소나 1명 + 수강생 페르소나 5명 + 레벨별 120분 강의 5개**.
원본은 [program.json](program.json), 읽기용 전체 개요와 강의는 [generated/README.md](generated/README.md)에 있다.
김서연은 설계를 위한 가상 강사이며, 실제 강사 인터뷰나 학습자 관측 결과가 아니다.

사용자가 제공한 Dental Digital Ownership Program 제안서의 Reviewer → Editor → Operator → Builder → Owner 정의를 사용했다.
7회 제안서를 요청에 맞춰 새 5강으로 설계했으며 과거 보아치과 실습 큐시트는 변경하지 않았다.
철학의 원문은 [seven-assets](../../seven-assets.md)를 따른다. 각 강의에서 판단·의도·검수·위임·반복·소유를 직접 수행할 과제로 연결한다.

## 자동화 범위

1. 강사가 program.json에서 페르소나, 목표, 단계별 발화·실습·완료 기준을 작성한다.
2. 생성기가 5개 레벨·120분 구성·독립 과제·제출 증거·Service 콘텐츠 스키마를 검증한다.
3. 강의 개요, 5개 강의 진행안, 초안 배치 JSON, 기능 요청 목록을 생성한다.
4. 로컬 실행에서 가상 강사 토큰으로 실제 Service authoring 라우트를 호출해 5개 초안을 저장하고 다시 읽어 비교한다.
5. 같은 배치를 재실행해 추가 revision 없이 이어지는지 확인한다.
6. 실제 강사는 자료를 검토하고 학생 기기 리허설을 진행한다. 이 단계는 자동 통과시키지 않는다.

이는 모델을 호출해 수강생의 행동을 흉내 내는 에이전트가 아니다. 이번에 작성한 강의 원본을 재현 가능하게 패키징·검증·저장하는 자동화다.
기존 강의 문장을 수정하려면 원본을 바꾸고 재생성한다. 생성물은 직접 편집하지 않는다.

## 실행

저장소 루트에서 Node 22 이상과 worker 의존성을 준비한 뒤:

```bash
npm --prefix worker run courses:dental
npm --prefix worker run demo:dental-authoring
npm --prefix worker run test:dental-authoring
```

- `courses:dental`: 생성된 문서 8개를 갱신. 네트워크 호출 없음.
- `demo:dental-authoring`: 생성 후 실제 Service 라우트 + 메모리 SQLite에서 초안 5개를 생성·재열기·재실행. 종료 시 DB를 닫는다. 영구 보존물은 생성된 초안 JSON이다.
- `test:dental-authoring`: 생성물 일치, 잘못된 레벨·시간·증거, 중단 재개, 응답 유실, 기존 초안 보호, 다른 강사 거부, 잘못된 성공 응답 등의 대조군.

`worker/scripts/dental-authoring.mjs`의 `importDrafts`는 선택한 HTTPS Service origin, 코호트, 프로필, 강사 토큰과 전송 함수를 받는다. 생성물에 자격증명을 쓰지 않는다.
현재 실행은 로컬 전송 함수를 사용한다. 운영 endpoint로 등록하거나 학생 세션을 여는 명령은 실행하지 않았다.
초안 저장 API와 강의 생성·예제 검사는 #706 → #708 → #710 순서로 main에 통합됐다.

## 저장·재시도 계약

배치 전체를 먼저 검증하고 강의별로 순서대로 저장한다. 배치 전체 트랜잭션은 아니다.
같은 ID와 같은 콘텐츠는 다시 읽어 확인하고 건너뛴다. 저장 후 응답이 유실돼도 재실행 시 기존 초안을 찾는다.
내용이 달라진 기존 초안이나 다른 강사의 소유라면 중단한다. 자동 덮어쓰기·확정 버전 생성·수업 활성화는 없다.
같은 코호트에서 다른 강사가 복제하려면 새로운 course_id가 필요하다. 기존 초안의 실제 편집은 revision을 사용하는 authoring API와 Chalk `/authoring` 화면에서 수행한다.

## 실습 파일

- [starter/index.html](starter/index.html): 가상 병원 홈페이지. L1~L4 시작점.
- [starter/reference-b.html](starter/reference-b.html): L1 비교 시안. 의도적인 1100px 고정 폭·11px 글자·첫 화면 아래 시간표.
- [starter/operating-cards.md](starter/operating-cards.md): L5 가상 운영 정보와 장애 2건.

브라우저 미리보기와 배포 기능은 수강생 환경에서 사전 확인해야 한다.
L3의 실제 연습 배포가 불가능하면 모의 파일 복구만 진행하며 배포·복구 실기를 통과로 기록하지 않는다.
L5는 2시간으로 운영 전문가를 인증하지 않는다. 자기 환경에서 소유·접근·복구 증거를 추가 확인한다.

## 기능 요청 창구의 첫 데이터

[generated/feature-requests.json](generated/feature-requests.json)은 강의 ID와 연결된 5개 설계 요청이다.
실제 수강생 장애 티켓으로 간주하지 않는다. 설계 요청 목록은 파일 기반이다. Chalk `/authoring`은 GitHub 이슈 작성 초안 링크를 제공하며, 내부 접수·처리 상태 UI나 자동 제출은 구현하지 않았다.
추가 렌더러·Plugin·MCP는 이 강의의 선수 조건이 아니다. 기본 HTML로 해결하지 못하는 구체적 작업이 확인되면 지원·권한·학생 환경을 검토한다.

## 초기 생성기 실행 기록 — 2026-09-06

- 생성: 5개 스키마 유효 초안, 강의당 120분, 총 600분.
- 로컬 Service/SQLite: 강사 소유 초안 5개 저장·재열기 일치, 재실행 5개 모두 revision 1 유지.
- 자동화 대조군: 10개 검사 통과.
- Worker 전체 회귀 검사·타입 검사 통과, 문서 검사 100/100.
- 확정 버전 0개, 운영 쓰기 0건. 학습자 점수는 미기록.
- 이 생성기 실행에서는 학생 Studio UI·실제 강사 강의 진행·학생 기기 배포 리허설을 실행하지 않았다.

후속 [실제 Mac Studio 합성 리허설 기록](studio-run-2026-09-06.md)은 생성기/강사용 예제 검사와 분리한다. 실제 치과의사의 학습 효과·독립 수행 평가가 아니며, 공개 배포·복구는 승인된 연습 대상이 없어 BLOCKED다.

## L1~L5 결과물과 브라우저 검사

[reference/README.md](reference/README.md)에 모든 레벨의 강사용 예제와 반복 실행 방법이 있다.
이 검사는 HTML 결과물과 loopback 게시·복구를 검증한다. 학생 Studio에서의 학습 완주 여부와 구분한다.
