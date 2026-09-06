# L1~L5 강사용 결과물과 실행 검사

모든 레벨의 강사용 예제 결과물을 작성했다. 학습자가 Studio에서 수행했다는 기록은 아니다.

| 레벨 | 결과물 | 실행 검사 |
|---|---|---|
| L1 판단 | [review.md](review.md) | 정상 A·의도적 오류 B의 모바일 폭·글자·시간표 위치 비교 |
| L2 수정 | [site/index.html](site/index.html), [change-log.md](change-log.md) | 시간·공지·FAQ 변경, 새 날짜 변경, 원본 복귀 |
| L3 운영 | 테스트의 버전·응답 해시 기록 | 로컬 HTTP 반영, 링크 오류 감지, 정상 버전 복구 |
| L4 제작 | [site/careers.html](site/careers.html), [page-brief.md](page-brief.md) | 5개 요구사항·페이지 왕복·390px/1280px 검수 |
| L5 통합 관리 | [ownership-map.md](ownership-map.md), [operating-playbook.md](operating-playbook.md), [incident-log.md](incident-log.md), [handoff.md](handoff.md) | 손상 백업 거부·별도 디렉터리 복원·HTTP 확인; 도메인 접근 상실은 탁상 시나리오 |

## 반복 실행

```bash
npm --prefix e2e ci
cd e2e
npx playwright install --with-deps chromium
npm run test:dental-reference
```

출력은 e2e/test-results/dental-reference/report.json과 화면 캡처 5개다.
서버는 127.0.0.1 임의 포트에서만 실행하고 종료 시 닫는다. 백업·복원 임시 폴더도 정리한다.
테스트의 버전 전환은 loopback 연습 게시 시뮬레이션이며 GitHub Pages나 클라우드 운영 배포가 아니다.
검사는 생성된 HTML을 실제 브라우저와 HTTP로 읽고 확인한다. 학생의 작업 능력을 채점하지 않는다.

## 환경과 남은 확인

현재 작업 환경에 Studio 데스크톱 실행 파일이 없으며 로컬 Chromium 다운로드도 시간 초과/502로 실패했다.
로컬 실행은 브라우저 시작 전 중단됐고 검사 통과로 기록하지 않았다.
GitHub의 dental-reference workflow가 Chromium 검사를 실행하고 보고서·스크린샷을 14일 보관한다. 실행 결과는 PR의 해당 workflow를 확인한다.

실제 학생 Studio 완주에 필요한 것은 실행 중인 Studio 기기, 허가된 연습 코호트·학생 세션, 연습 저장소·호스팅의 접근 권한이다.
그 환경에서 generated/l1.md부터 l5.md까지 강사가 진행하고 요청문·실제 응답·화면·실습 결과를 관측해야 한다.
실제 도메인·계정·클라우드 백업은 확인되지 않았다. 접근이나 소유 정보를 추정하지 않는다.

기존 PR #706 authoring API와 #708 강의 생성에 이어지는 검사이며, 이 PR은 #708 브랜치에 쌓인다.
