# Mac Studio 치과 L1–L5 합성 리허설 — 2026-09-06/07

이 기록은 실제 Mac의 Studio 채팅 → Service → Agent SDK/LLM → 도구 → 파일/내장 브라우저를 실행한 **합성 페르소나 실험**이다. 관측자가 과제 입력·화면 검사·재시도·승인을 도왔다. 실제 치과의사의 학습 효과나 독립 수행 능력을 측정하지 않았고 점수도 부여하지 않았다. 120분 강의 5개의 과제를 압축 실행했으며 600분 수업을 진행했다는 뜻이 아니다.

관련 이슈: [실행 기록 #719](https://github.com/jayleekr/hypeproof-studio/issues/719), [공개 실습 차단 #718](https://github.com/jayleekr/hypeproof-studio/issues/718).

검토용 화면: [L1 A](studio-evidence-2026-09-06/l1-final-a-390.png) · [L1 B](studio-evidence-2026-09-06/l1-final-b-390.png) · [L2 복원](studio-evidence-2026-09-06/l2-restored-390.png) · [L3 오류](studio-evidence-2026-09-06/l3-broken-390.png) · [L3 복원](studio-evidence-2026-09-06/l3-restored-390.png) · [L4 채용](studio-evidence-2026-09-06/l4-careers-390.png) · [L5 복원](studio-evidence-2026-09-06/l5-restored-careers-390.png) · [명령 승인](studio-evidence-2026-09-06/approval-full-command.png) · [Chalk 작성](studio-evidence-2026-09-06/chalk-live-authoring.png).

## 환경과 실행 경계

- Mac macOS 15.7.4, arm64, Node 24.4.1.
- 설치 앱 `/Applications/HypeProof Studio.app`은 보존. 별도 `/tmp/hps-dental-20260906/HypeProof Studio.app`에 extension 번들만 반영했다. 전체 앱 빌드·새 릴리스 배포는 하지 않았다.
- 앱 shell 0.1.50, shell commit `3ba1a364144a2776f2e9cc28d26cbc16b15b78f8`. 설치 앱 자체가 최신 main 빌드라는 뜻은 아니다.
- 실제 연습 경로 `/private/tmp/hps-dental-20260906/workspace`, 별도 user-data/확장 디렉터리, CDP 9347. 실행 인수에서 workspace를 Chromium 옵션보다 먼저 배치했다.
- 격리된 local workerd/SQLite Service `127.0.0.1:8797`, Chalk `127.0.0.1:8798`. 기존 안전한 모델 설정을 재사용했다. 자격증명·사용자 데이터 디렉터리는 공유 증거에서 제외한다.
- registry의 성인 프로필 `boah-dental-director-copyclone-2026-s1`, 격리된 local `boah-dental-2026-a`에 합성 사용자 1명과 가상 강사 김서연. 아동 기본 프로필은 사용하지 않았다.
- 정상 API로 roster/세션/강사 발급을 진행했다. 스키마 초기화 외 직접 DB 수정은 하지 않았다. 실제 발급 토큰으로 `/v1/profile` 200, 세션 상태 API 200, 열린 세션과 성인 Agent SDK 도구 권한을 확인했다.
- 토큰 입력 자체는 test-state fixture를 사용했다. 일반 사용자 토큰 입력 UI를 검증했다고 보고하지 않는다. 실제 채팅 webview에 연결해 요청·응답·도구 상태를 관측했다.
- Plugin/MCP 추가 설치는 없었다. 제품에 내장된 파일·shell·브라우저 도구를 사용했다. subagent를 사용하지 않았다.
- 프로그램 원본 SHA256 `ab4ede9377427a380eab960d3c2656bedd1746aff54dec18cc7d1a5d350cb18f`.

## 통합한 PR

모든 신규 머지는 해당 최신 head의 CI·리뷰·보호 규칙을 조회한 후 실행했다. strict 상태 검사, 대화 해결, 관리자 포함 보호를 우회하지 않았다. 필수 승인 수는 조회 시 0이었으며 신규 PR에는 모든 활성 비작성자 멤버의 리뷰를 요청했다. 요청을 실제 승인으로 세지 않았다.

| PR | 실제 merge SHA | 처리 |
|---|---|---|
| #704 | `1a1bb732480345a42b5a36c655a3d91d861cc033` | 이미 머지되어 재작업하지 않음 |
| #706 | `78663ce6177a9f74556838eb6086862b2d860cfa` | 강사 소유·revision·불변 버전 API |
| #708 | `c8464151531e16d72f2e635f1cc32a77058f126a` | 페르소나·강의 생성 |
| #710 | `057f51e46713409806a0e7058a38257218bdb7d4` | 강사용 예제·브라우저 검사 |
| #714 | `7213a289c7cb37b4047210af08740d24b76052f7` | test-state fixture workspace 판정 일관성 |
| #716 | `30e8be709fd4ca6b5660a49cc7ba38e2db1aa492` | Chalk 강의 작성 화면 |
| #717 | `b72bf949ccc51db56183d5bfbbf251838d3f3927` | 실제 로컬 미리보기 화면 폭 UI |
| #721 | `8df906d3d4086f554870842911571d818c972efb` | 승인창 전체 명령 표시 |

#708과 #710은 선행 squash 머지 후 base를 main으로 변경하고 main을 통합했다. 선행 변경과 충돌한 파일은 동일 트리인지 확인하고 중복 없이 정리했다. 인계 당시의 초록 CI를 재사용하지 않고 새 head에서 관련 검사와 GitHub CI를 다시 확인했다.

초기 성공 L1/L2는 #714 head `6685e53` 번들, L2 독립 과제/L3는 화면 폭 첫 시도 `d43c426` 번들, L4는 #717 head `fdb6dbc`(main `b72bf94`와 동일 구현)로 실행했다. L5 재실행과 L1 최종 화면 대조군은 #721 head `e201dac`(main `8df906d`와 동일 구현)로 실행했다. 처음부터 모든 레벨을 최종 SHA로 실행한 것으로 표현하지 않는다. 수정한 기능은 해당 코드로 실제 앱에서 다시 실행했다.

## 레벨별 결과

| 강의·페르소나 | 상태 | 실제 수행 및 증거 |
|---|---|---|
| L1 Reviewer 박지훈 | PASS — 도움을 받은 합성 실습 | starter A/B 실제 화면 비교, 위치·정보 순서·모바일 문제 3개, 수정 요청 3건과 확인 기준. `l1-01/02/03/04-response.json`, `workspace/l1/{clinic-context,comparison,review,assessment}.md`, `l1-{a,b}-390.png` |
| L2 Editor 이수진 | PASS — 도움을 받은 합성 실습 | Studio로 화요일 19시·10월 9일 공지·주차 FAQ 수정, 원본 복원, 다른 조건인 10월 16일 공지로 변경. `l2-01/02/03-response.json`, `workspace/l2/`, `l2-restore-evidence.json`, 수정/복원/독립 과제 화면 |
| L3 Operator 최민석 | BLOCKED — 공개 배포·복구 | 로컬 Git/URL 정상·링크 오류·복구·다른 FAQ 변경·복구는 PASS. 승인된 공개 대상이 없어 공개 단계는 미실행. `l3-01/02-response.json`, `l3-commits.txt`, `l3-url-observations.jsonl`, `l3-http/`, `workspace/l3/` |
| L4 Builder 정하린 | PASS — 도움을 받은 로컬 실습 | Studio가 L2 결과를 바탕으로 채용 페이지 제작, 5개 요구사항, 기존 디자인, 홈/시간표/채용 왕복, 390px·1280px. 역할 변경 독립 조건과 주석 가독성 수정도 다시 검사. `l4-01/02-response.json`, `l4-inspection.json`, `l4-careers-{390,1280}.png`, `workspace/l4/` |

| L5 Owner 윤도현 | PASS — 로컬 실기·탁상 대응 | 손상 백업 거부, 정상 백업 무결성, 별도 위치 복원, 복원 페이지 재열기, 장애 A 링크 복구, 운영·소유·인계 문서. 장애 B 도메인 접근 상실은 탁상 대응만 수행. `l5-01/02/03/04-response.json`, `l5-independent-integrity.json`, `workspace/l5/`, `l5-restored-*.png` |

### 화면·보존·복구의 독립 검사

L1 최초 390px 비교는 관측자가 CDP로 폭을 맞춘 도움을 명시했다. A는 문서 폭 390px·18px 글자·시간표 y≈497, B는 문서 폭 1130px·11px 글자·시간표 y≈1081이었다. 강사용 reference 정답은 복사하지 않았다. L1 시작 파일만 제공했고 이후 페이지와 문서는 실제 Studio가 작성했다.

L1 문서의 추가 검수에서 모델이 11px의 원인을 자동 축소로 설명하고 측정하지 않은 스크롤 횟수를 쓴 오류를 발견했다. 정상 API로 합성 세션을 다시 열고 같은 최종 번들의 Studio에서 CSS `font:11px/1.5`를 읽어 설명을 고쳤다. 수정 요청서의 교육용 표시 제거·실제 주소/지도 삽입 요구도 가상 정보와 미확인 표시 유지로 고쳤다. 원본 HTML 두 개의 starter 대비 해시는 불변이다. 추가 검수 화면은 [L1 수정](studio-evidence-2026-09-06/l1-correction-studio.png), 최종 문서는 [비교 설명](studio-evidence-2026-09-06/l1-final-assessment.md)·[수정 요청서](studio-evidence-2026-09-06/l1-final-review.md)다. 초기 문서는 로컬 `l1-before-final-review/`, 수정 요청과 실제 응답은 `l1-03/04`, 추가 관측은 `l1-correction-session.jsonl`로 보존한다. 화면 수치가 맞더라도 모델의 원인 설명과 문서 전체의 일관성은 별도 검수가 필요했다.

L2 복원 시 source와 복원본 SHA256은 `93149908293d9733abbaf7c0d9963673a7d33b84e1ebe0914005c4b356e8e936`. 당시 `http://127.0.0.1:63064/l2/index.html` 응답은 200이었다. 실제 live server가 추가하는 reload 스크립트를 포함한 응답 SHA256은 `628ce893c71ff70a03ad007a2d87c0663fcb13ca00abeddb950aa692a70a8440`. 원본 파일과 주입된 HTTP 응답을 무조건 같은 해시로 비교한 초기 판정기를 고치고 실제 응답으로 재실행했다.

L3는 연습 폴더 안에 별도 Git 저장소를 만들었다. 정상 `45d5977` → 링크 오류 `68aa741` → 복원 `849198e` → FAQ 변경 `0bcd8d8` → 복원 `1f77939`. `#missing` 대상 부재와 `#hours` 이동 복구를 Studio 브라우저에서 확인했다. 별도 HTTP 관측기는 4개 상태를 모두 200으로 수집했다. 첫 복원과 마지막 복원의 응답 SHA256 `1d72768cce35ea66b36820e4dbb5b81a4339766e4f671eaa0beea20c20ca49c1`이 일치했다. 공개 Git 원격이나 호스팅 배포는 만들지 않았다.

L4 검사는 실제 제품의 화면 폭 UI 버튼을 클릭한 뒤 내부 iframe `innerWidth`를 확인했다. 두 폭에서 가로 넘침이 없고 역할/업무/조건/지원/문의 섹션이 존재했다. 관측자가 화면의 흐린 15px 주석을 발견해 수정 요청했고 Studio가 16px·#555로 바꿨다. 역할도 ‘환자 안내 코디네이터(교육용)’로 바꾼 뒤 같은 검사를 재실행했다. 개인정보 수집 폼·인증·결제를 추가하지 않았고 연락처·급여는 미확인 자리표시자로 남겼다.

L5는 Studio가 작성한 `restore.py`로 정상 백업 manifest를 전부 검사한 뒤에만 복원했다. 손상 사본은 exit 5, 대상 파일 없음. 정상 사본은 exit 0. 관측자가 새 별도 대상에 같은 정상/손상 대조군을 재실행해 확인했다. 두 HTML은 L4 원본·backup·site·restored 네 위치에서 byte-identical이었다. 이 스크립트는 이번 신뢰된 두 파일 백업 실습용이며 임의 외부 manifest를 처리하는 제품 기능으로 배포하지 않았다.

L5 운영 문서는 관측자 검수 후 DNS 소유 추정·읽기 권한과 소유권 혼동·해시 비교 범위·실행하지 않은 배포 도구 명칭을 실제 Studio로 수정하고 네 문서를 다시 Read했다. 운영 권한 미확인을 완료로 바꾸지 않았다.

L5 링크 오류는 Studio browser_read/click/screenshot에서 관측했다. 관측자의 독립 HTTP 오류 수집은 이미 복원된 뒤 도착해 실패했으므로 오류 버전의 HTTP 증거로 쓰지 않는다. 복원 페이지는 최종 실제 Studio 폭 UI에서 390/1280과 홈↔채용 이동을 독립 검증했다. L1 A/B도 같은 최종 UI에서 정상/overflow 대조군을 다시 실행했다. `final-preview-check.json`.

기록의 loopback URL은 해당 프로세스가 실행 중일 때만 유효하다. 앱 재시작으로 포트가 달라졌으며 영구 공개 URL이 아니다.

## 발견·수정·재실행

- **#713 → #714:** test-state 파일 감지와 `HPS_TEST_E2E` 환경변수를 workspace 선택 경로에서도 일관되게 사용한다. 정상 코호트 workspace 전환은 유지한다. 초기 다른 workspace 오픈에는 launcher 인수 순서 문제도 있었으므로 원인을 코드 하나로 단정하지 않는다. 잘못된 경로를 발견한 즉시 중지했고 해당 사용자 폴더에 쓰기를 수행하지 않았다. 수정 코드와 올바른 인수로 연습 경로의 실제 Read/Write를 재확인했다.
- **#712 → #716:** Chalk `/authoring`에서 초안 가져오기·편집·저장·다시 열기·revision·불변 버전 확인을 구현했다. 원격 소유권/CAS 판정은 Service에 둔다. 토큰은 화면 메모리에만 둔다. 401/403/409를 구분하고 편집 내용을 보존하는 브라우저 대조군을 실행했다. 실제 local Chalk→Service/D1에서도 5개 강의를 편집/저장/freeze했고 L1을 revision 2로 재열어 revision 1 확정본이 유지됨을 확인했다. `chalk-live-report.json`, `chalk-live-authoring.png`.
- **#715 → #717:** 첫 CDP Emulation 방식은 실제 앱에서 실패했다. 설치 shell이 해당 메서드를 무시하는 구현임을 확인하고, 기존 local live server의 폭 조절 iframe과 Studio 명령/버튼으로 수정했다. 390px/1280px 내부 폭, 정상·overflow 오류 대조군, 링크 왕복, 원본 화면 복귀를 다시 실행했다. `viewport-ui-report.json`, L4 재검사. 외부 URL·경로 이탈·재귀 wrapper는 허용하지 않는다.
- **#720 → #721:** L5 승인창이 240자 넘는 명령 가운데를 생략해 두 번 취소했다. 전체 명령과 줄바꿈을 상세 영역에 표시하도록 바꾸고 기존 시크릿 마스킹·승인 정책을 유지했다. 긴 명령 중간 위험 동작 보존/자격증명 마스킹 대조군, extension 회귀 검사, 실제 앱 승인창 screenshot과 명령 실행을 확인했다. 수정된 코드로 L5 백업·복원을 다시 수행했다. `approval-full-command.{json,png}`.
- L2에서 모델이 Read 전에 Edit를 시도해 도구 오류가 났다. 실제 Read 후 Edit 재시도로 해결된 기록이며 UI 제품 결함으로 세지 않는다.

Chalk 기능 요청 버튼은 강의 문맥을 채운 **GitHub 이슈 작성 초안 링크**다. 내부 접수 큐·처리 상태 UI나 자동 제출이 구현됐다는 뜻은 아니다. 실제 GitHub 제출은 별도 사용자 동작이며 이 브라우저 검사에서 수행하지 않았다. 설계 단계 feature-requests.json도 실제 학생 신고 건수로 세지 않는다.

## 회귀 검사와 증거 범위

main `b72bf94`에서 다음 요청된 6개 명령이 모두 exit 0이었다.

```sh
npm --prefix worker test
npm --prefix worker run typecheck
npm --prefix chalk test
npm --prefix chalk run typecheck
npm --prefix worker run demo:dental-authoring
npm --prefix e2e run test:dental-reference
```

추가로 extension 전체 smoke/typecheck, local workerd/D1, `test:chalk-authoring`, `test:preview-viewport`를 통과했다. 강사용 dental-reference 검사는 예제와 loopback 복구 검사이며 학생 Studio 실행의 대체 증거가 아니다. 실제 Studio 증거는 위 요청/응답/관측/파일/화면이다. 정상·오류 대조군을 거친 판정기만 사용했다.

## 실행 기록 보존

로컬 전체 증거: 저장소 기준 `e2e/test-results/dental-studio-20260906/` (gitignored). `README.md`와 `SHA256SUMS`를 시작점으로 요청/실제 응답, 성공 실행의 observer JSONL, 레벨별 생성 파일, 실제 화면, URL/해시/정상·오류 대조군을 확인한다. 초기 잘못된 workspace 실행 로그, user-data, 발급 토큰, 모델 설정은 공유 증거에서 제외했다. 관측기의 native 승인 횟수 필드는 실제 모달을 모두 세지 않으므로 승인 유무 판단에는 별도 DOM/screenshot과 수동 승인 기록을 사용한다.

검토에 필요한 화면과 기계 판정은 [studio-evidence-2026-09-06](studio-evidence-2026-09-06/environment.json)에 함께 커밋했다. [최종 화면 검사](studio-evidence-2026-09-06/final-preview-check.json), [독립 복원 검사](studio-evidence-2026-09-06/l5-independent-integrity.json), [복원 HTTP](studio-evidence-2026-09-06/l5-restored-http.json), [실제 머지 목록](studio-evidence-2026-09-06/merged-prs.json)을 재확인할 수 있다.

초기 사용자의 untracked `AGENTS.md`는 main의 tracked 파일과 충돌하므로 `preserved/user-AGENTS.md`로 보존했다. 원래 사용자 작업 브랜치와 submodule 변경·다른 untracked 파일은 유지했다. 주 작업 폴더는 main이며 변경은 이슈별 별도 worktree에서 PR로 통합했다.

공개 확인용 로컬 패키지는 `public-practice-candidate.zip`과 `public-practice-candidate/`에 있다. Studio가 제작하고 L5에서 복원 검증한 홈/채용 HTML 두 개, 동일한 정상 복구본, SHA256SUMS, 대상·중단·복구 절차를 포함한다. 제안 대상은 아직 만들지 않은 비운영 `jayleekr/hypeproof-dental-practice-20260906` GitHub Pages다. 이 준비만으로 대상 생성·공개 실행이 승인되거나 완료된 것은 아니다.

## 남은 외부 요건

L3 공개 배포는 **BLOCKED**다. 사용자가 공개 전에 결과물·대상·복구 방법을 준비해 확인받도록 명시했으며 승인된 대상이 아직 없다. 호스팅 요청을 보내지 않았으므로 401/403·배포 장애로 추정하지 않는다. 비운영 정적 연습 대상 승인 후 공개 URL/버전/오류/정상 복원을 독립 검증해야 한다. 실제 병원 사이트·DNS·결제·계정 소유권 변경은 범위 밖이다.

실제 강사/치과의사 수업, 시간 준수·독립 수행 점수, 운영 도메인 접근/소유권 복구, 일반 사용자 토큰 입력 UI, 새 전체 앱 릴리스는 NOT RUN이다. L5 도메인 접근 상실은 탁상 시뮬레이션이다.

세션 종료 API 200, 발급 학생 토큰 revoke, `session: null`을 확인했다. 자신이 만든 앱·관측기·Service·Chalk를 종료하고 CDP/Service/Chalk/미리보기 포트의 listener가 없음을 확인했다. 기존 설치 앱·사용자 파일·다른 세션 프로세스는 정리 대상에서 제외했다.

L1 추가 검수 세션도 정상 close/revoke 후 종료 상태를 확인하고 해당 앱·Service·관측기를 정리했다. 원본 HTML starter 대비 해시 불변을 다시 확인했다.
