# Change-impact onboarding

> 작성일 2026-09-08 · 상태: 활성 · 구현 이슈 #763

`config/traceability.json`은 이 저장소의 정본 위치·고정 ID·상위 연결을 등록한다. 공통 엔진과
실행 정책은 [hypeproof-harness](https://github.com/jayleekr/hypeproof-harness/issues/120)에 있다.
제품 내용은 이 저장소에 유지하며 공유 규칙을 복사하지 않는다.

- 철학·Mission 변경뿐 아니라 Intent·REQ·Design·Test·Validation 변경도 검토를 시작한다.
- 하네스는 main의 커밋을 고정해 등록 내용과 연결의 변경을 비교한다.
- PR에는 graph 영향 미리보기를 게시하고, main 채택 후 필요한 검토 이슈를 이 저장소에 발행한다.
- AI 권고는 승인이나 검증 증거가 아니다. source 원문과 AI 설명은 cross-repo issue에 복사하지 않는다.
- `owner: null`은 책임자 미지정이다. 임의로 멤버를 지명하지 않고 onboarding 리뷰에서 위임을 정한다.
- 기존 문서에 Intent/REQ/Design이 섞인 곳은 현재 정본을 참조한다. 빠진 단계를 충족했다고 주장하지 않는다.
- 초기 manifest는 전체 제품 범위를 포괄하지 않는다. 미등록 활성 경로의 변경은 mapping review로 드러낸다.

## 활성화 순서

이 consumer PR과 다른 consumer manifest가 먼저 merge되고, Harness 엔진 PR이 merge되면
중앙 스케줄이 실행된다. 이번 변경은 앱/웹 UI나 배포 설정을 바꾸지 않는다.
운영 token 권한은 하네스에서 확인하며 consumer에 새로운 API secret을 복사하지 않는다.

## 확인

하네스의 `tests/change_impact`는 snapshot/graph/issue/review 권한을 검증한다.
실제 세 manifest를 함께 로딩해 파일·절·연결을 확인해야 한다. JSON 파싱만으로 전체
등록이 유효하다고 판단하지 않는다. 빌드나 기존 기능 검증을 대체하지 않는다.
