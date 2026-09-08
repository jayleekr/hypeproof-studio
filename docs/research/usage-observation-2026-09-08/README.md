# 사용량 관측 — 2026-09-08

REQ-L5 / #800의 첫 읽기 구현 검증이다. 실제 Admin HTML과 Service 라우팅을
합성 SQLite 기록에 연결했다. 전체 사용량/원가/예산 정산 또는 배포 검증은 아니다.
소스·증거 파일 해시는 [manifest](manifest.json)에 보존했다.

- [390px](usage-390.png), [1280px](usage-1280.png), [키보드로 이동한 표](usage-390-scrolled.png)
- [조회 실패](usage-unavailable.png), [빈 기록](usage-empty.png)
- [브라우저 실행 로그](browser.txt), [CLI·기존 비용 포함 계약 실행 로그](usage-report.txt)

에이전트가 위 다섯 화면을 직접 열어 검수했다. 처음 좁은 표에서 모델 이름이 여러 줄로
눌린 것을 보고 표 최소 너비와 가로 이동 안내를 추가한 뒤 브라우저 검사를 재실행했다.
문자열 escape 대조군의 HTML 모양 학생 ID는 그대로 텍스트로 보이며 실행되지 않는다.
원래 합성 4행의 저장값은 입력 607·출력 27·캐시 읽기 340·쓰기 54다. 오류 2행 중 1행에
토큰이 있고, 다른 코호트의 큰 값은 합계에 들어가지 않는다. 빈 조회와 실패에도 원가를
0으로 확정하지 않는다. UI의 모든 네트워크 동작은 GET이었다.

Worker 전체 테스트/typecheck 후 CLI 결과 파서 변경은 usage-report와 usage-log-status를
다시 실행했다. 실제 공급자 청구/미보고량, 운영 D1, 강사/학생 예산 화면과 수업 파일럿은
미실행이다. [상세 계약과 후속 단계](../../design/usage-observation-audit.md)를 따른다.
