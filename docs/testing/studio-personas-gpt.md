# 실사용 흐름 페르소나와 GPT 실습

관련: [#828](https://github.com/jayleekr/hypeproof-studio/issues/828),
[NAT-03](../requirements/studio-native-trial.md), [REQ-M36/M39](../studio-requirements.md).
기존 Product Intent를 유지한다. 다음 행동에 정보가 충분하면 바로 실행하고,
부족할 때만 필요한 질문을 한다. 별도 Intent 설문을 통과 조건으로 만들지 않는다.

## 페르소나와 판정

모두 합성 성인 사용자다. 실제 강사나 가족의 성향·능력을 추정한 기록이 아니다.
입력과 기대 행동은 [JSON](../../e2e/personas/trial-personas.json)으로 재사용한다.

| ID | 상황 | 확인할 행동 |
|---|---|---|
| P1 | 시작이 막막함 | 필요한 질문 하나 → 실제 2시간 집안일 순서표 |
| P2 | 원하는 비교가 명확함 | 재질문 없이 표 → 선택할 질문 하나 |
| P3 | PPT 위임이 불안함 | 실제 목차와 사람에게 남길 사실·약속 판단 |
| P4 | 홈페이지를 처음 만듦 | 실제 HTML Run → 영업 종료시간만 수정 → 파일/URL 재확인 |
| P5 | 질문 건너뛰기·목표 변경 | 가정을 밝힌 비교 → 새 공지 한 문장, 핵심 정보 보존 |
| P6 | 서버 오류와 재시도 | 503 표시, 실패 시 upstream 0회, 재시도 1회와 메시지 중복 없음 |

자동 검사는 인증된 실제 UI 조작, 전송 종료, 오류 표시, 파일과 URL을 확인한다.
의미는 저장된 원문을 검토하고 검토 주체를 밝혀 PASS/FAIL과 근거를 남긴다. 오류 없는 응답만으로
제품 의도 충족을 선언하지 않는다. T25의 실제 사람 파일럿은 별도다.

## 비용과 인증

1. `npm --prefix worker run test:gpt-practice`: 네트워크 없이 정상·실패 대조군을 실행한다.
2. 로컬 GPT 실습은 공식 `codex app-server`의 ChatGPT 로그인을 재사용한다.
   설치된 CLI의 `codex login status`, 실제 `account/read`, `model/list`와 응답으로 확인한다.
   앱·플러그인·기존 MCP 도구는 이 자식 프로세스에서 끄고, 실제 도구 목록이 비어 있는지 확인한다.
   인증 파일과 토큰을 읽거나 Service에 복사하지 않는다. 로그인은 사용자가 공식 CLI에서 한다.
3. Service는 기존 참여 코드·성인 프로필·roster·1시간 세션을 검사한다.
   `studio-gpt-practice`는 별도 일반 실습 코호트다. 기존 native trial grant는 사용하지 않는다.
4. 실행당 최대 24회, 동시 생성 1개, 요청당 60초, 입력 100KB/출력 24KB로 제한한다.
   `api-evidence.json`에 실제 모델·입력/출력/캐시 토큰·완료/실패를 남긴다.
   이는 금액 상한이 아니다. ChatGPT 구독 사용량 제한이 적용되며 API 무료·무제한을 뜻하지 않는다.
5. 기존 Claude 비교 검사는 제한된 대표 페르소나와 `hypeproof-fast`를 사용한다.
   실패를 조사하기 전 자동 재실행으로 호출량을 늘리지 않는다.

공식 문서: [Codex 인증](https://learn.chatgpt.com/docs/auth),
[App Server](https://learn.chatgpt.com/docs/app-server).
이 개발용 연결은 공개 Worker에 배포되지 않는다. 공개 GPT 경로에는 OpenAI API 키가
별도로 필요하며, 구독 연결 검증을 API 검증으로 기록하지 않는다.

## 실제 Mac 실행

설치된 앱의 사본과 별도 user-data/workspace를 사용한다. 전체 앱 빌드는 하지 않는다.
기존 `scripts/test-native-trial-laptop.sh`가 확장 코드를 빌드·복사하고 자체 Service를
종료한다. 기본 포트 8787이 사용 중이면 실행을 중단하며 `HPS_NATIVE_PORT=8788`처럼
비어 있는 별도 포트를 지정할 수 있다. 다른 프로세스를 종료하지 않는다. 로그에 토큰을 출력하지 않는다.

```bash
HPS_NATIVE_PERSONAS=1 HPS_CODEX_REHEARSAL=1 HPS_NATIVE_FAULTS=1 \
HPS_QUIET_NO_HIDE=1 HPS_APP_PATH='/path/to/HypeProof Studio.app' \
bash scripts/test-native-trial-laptop.sh
```

이미 현재 확장 번들을 넣은 사본은 `HPS_NATIVE_REUSE_DIR`로 지정한다. 스크립트가
현재 번들과 해시를 대조한다. 선택 실행은 `HPS_PERSONA_IDS=P1,P3`을 추가한다.
Claude native 비교는 `HPS_CODEX_REHEARSAL`을 빼고 `HPS_NATIVE_MANAGED=1`을 사용한다.
HTML Run 중심 P4는 GPT proxy 기능 검사이며 Claude 파일 도구 동등성 검사가 아니다.

증거는 `e2e/test-results/native-trial/<UTC>/`의 환경, 연결 확인, 사용량, 페르소나별
원문·화면·HTML에 남긴다. 자동 결과의 `semantic_review: PENDING`은 실제 검토 후
별도 보고서에 판정한다. 전체 화면 대신 격리된 앱 창만 캡처한다.

## 실행 결과

2026-09-08 Mac arm64, Node 24.4.1, Codex CLI 0.153.4에서 실행했다.
앱은 공개 v0.1.55(`189bc956`)의 별도 사본에 현재 확장 번들을 넣었다.
GPT 전체 실행 코드는 `2493c968651d960a56005d33cf971de47bb7ef78`,
Claude 비교는 `5ee63ea`, 포트 분리 재검사는 `7e2d639`다.
환경 JSON에 실제 Service 소스 및 확장 번들의 SHA-256을 남겼다.
이 초기 6개 실행은 원본 설치본 검증으로 분류하지 않는다. 공개 v0.1.56 원본의 추가 검증은 아래에 구분했다.

| 검사 | 결과 | 실제 근거 |
|---|---|---|
| GPT P1 막막한 시작 | PASS | 질문 하나 → 합계 2시간 순서표와 이동 시간 가정 |
| GPT P2 명확한 비교 | PASS | 추가 접수 없이 비교표·선택 질문, UI/실제 호출 모두 Terra |
| GPT P3 위임 불안 | PASS | 과제·주제를 각각 한 번에 하나씩 질문, 실제 목차와 사용자 사실/약속 판단 |
| GPT P4 첫 홈페이지·수정 | PASS | 실제 Run, 파일 두 버전, URL 200, 종료 시간만 수정 |
| GPT P5 건너뛰기·목표 변경 | PASS | 가정 명시 → 비교 → 새 공지 한 문장, 3시/개인 컵 보존 |
| GPT P6 오류·재시도 | PASS | 503 화면, 실패 upstream 0회, 재시도 1회·메시지 중복 없음 |
| Claude P1/P3 비교 | PASS | 실제 Agent SDK와 Haiku 응답, 두 흐름 원문 검토 |
| 별도 포트 8788 P6 | PASS | 다른 Service를 보존하면서 오류·재시도 동일 동작 |
| GPT Sol | NOT RUN (실제 생성) | 모델 목록·Service 라우팅 대조 검사는 통과. 실제 생성은 Luna/Terra만 실행 |
| 공개 OpenAI API | BLOCKED | 이 Mac의 기존 설정에 OpenAI API 키가 없음. 구독 연결은 별도 인증 방식 |
| Windows·실제 사람 T25 | NOT RUN | 이번 Mac 합성 실험으로 대신하지 않음 |

의미 판정은 구현 에이전트가 저장된 원문과 실제 화면·파일을 읽어 수행했다.
사람 참가자의 평가나 학습 효과를 입증하는 연구가 아니다. 자동 전송 결과의
`semantic_review: PENDING` 원본은 보존하고, 별도 `review.json`에 근거를 기록했다.

첫 전체 실행에서는 UI 6개가 통과했지만 P3가 주제와 청중을 한꺼번에 요구했고,
P4가 불필요한 복사·붙여넣기를 안내했다. 코칭 문구와 Run 안내를 수정한 뒤
같은 페르소나를 재실행했다. 초기 결과를 소급해 통과로 바꾸지 않았다.
GPT 프로필을 `/v1/messages`에 보내면 500이 나던 문제도 409로 수정하고
인증·다른 공급자·기존 모델 핀 대조군으로 확인했다.

P4의 최종 URL은 실행 당시 `http://127.0.0.1:65242/`였다. 테스트 종료 후 서버를
정리했으므로 상시 접속 주소가 아니다. 생성된 HTML 파일은 보존했다.
`version-1.html`에서 `18:00` 한 곳을 `19:00`으로 바꾸면 `version-2.html`과 완전히 같다.
파일 SHA-256은 각각 `0ba6dc1d7add30a5680b41df854fcdf01bfeca1df947bbe618a2f9f7ae533a5e`,
`f264f50bcf2f9b26e5c9eadd79b053716a543e750a7baf8d600182ad2385f6da`다.
공개 호스팅·DNS·운영 사이트는 바꾸지 않았다.

### 사용량

최종 GPT 6개 실행은 11회 생성, 입력 97,691/출력 2,337토큰(총 100,028)이었다.
입력 중 캐시 읽기는 35,328토큰이다. 같은 페르소나의 직전 실행 입력 총량
146,632에서 외부 도구를 끈 실행은 약 33% 줄었다. 생성 내용 차이가 있는 두 실행의
관측 비교이며 고정 벤치마크나 청구 금액 절감률은 아니다.

수정 전·후 및 포트 검사까지 앱 GPT 생성은 총 36회, 기록된 총량은 431,059토큰이다.
별도 CLI 연결 확인의 실제 생성 1회(9,768토큰)도 있었다. GPT API 키 호출은 0회다.
Claude는 Haiku로 사용자 5턴에 upstream `/v1/messages` 10회를 사용했다.
기존 trial grant도 10회/40회, 종료 시 busy=0으로 기록됐다. Claude 청구 토큰·금액은
이 fixture에서 측정하지 않았으므로 비용 0이나 추정 금액으로 보고하지 않는다.

### 공개 원본 앱·배포 추가 검증 (#831)

[#829](https://github.com/jayleekr/hypeproof-studio/pull/829)는 CI 17개 통과 후
`78f322102462c344b7ec1c9f60c686af79cfbed9`로 머지했다.
[Service 배포](https://github.com/jayleekr/hypeproof-studio/actions/runs/34277612112)는
운영 세션 보호를 유지하고 production 검증과 SDK canary 계약까지 성공했다.
운영 health의 버전은 `w0.0.0-dev+78f3221`, Cloudflare 버전은
`1fef6446-45f0-48cd-82b4-ba1c857c7577`이다. 이 canary 검증 호출은 위 로컬 Claude 10회와 별도다.

기존 공개 [v0.1.56](https://github.com/jayleekr/hypeproof-studio-releases/releases/tag/v0.1.56)을
내려받아 원본 그대로 실행했다. 새 전체 앱 빌드는 하지 않았다.
Mac ZIP의 SHA-256 `96d4cb31c3845370dc5ba8794a0bfd7682063579b0549bc94b4c19cfb9ad9526`은
소스 릴리스와 공개 미러의 값에 일치했다. 앱 코드 SHA는 `f5939d9cf6bbf42588eacd370e2faf9cde7c53bc`다.

- `20260908T205548Z`: 공개 원본 P2 모델 선택 PASS. P4 파일/URL은 성공했지만
  캡처에는 이전 18:00이 남아 **화면 완료 증거는 무효**로 판단했다.
- `20260908T205934Z`: 검사 코드 `6f49b02`에서 실제 native WebContents의 DOM이
  기대 종료 시간이 될 때까지 기다리게 바꾸고 P4를 재실행했다. 기존 `hasClosingTime`
  정상/오류 대조군을 먼저 실행했다. 화면은 18:00→19:00으로 실제 갱신되었고
  `preview_text`, 최종 PNG, 파일, 독립 URL을 대조해 **PASS**로 확인했다.

제품의 파일 감시 reload는 150ms 지연된다. 파일/새 HTTP 응답을 확인한 직후의
캡처를 화면 완료로 잘못 간주한 것이 원인이며, 이 재검증에는 앱 제품 코드를 수정하지 않았다.
추가 원본 앱 검사는 GPT 생성 5회/48,763토큰이고, 전체 앱 검사 누적은 41회다.
기존 CLI 확인 1회는 별도다. 원본 결과와 무효 판정 근거를 삭제하거나 덮어쓰지 않았다.

운영 시크릿 이름 목록에서도 OpenAI API 키 부재를 확인했다. 공개 GPT API 인수는
[#830](https://github.com/jayleekr/hypeproof-studio/issues/830)에서 키 연결을 기다린다.
이 공개 앱 검사의 GPT upstream 역시 로컬 Codex 구독 연결이므로 공개 API 검증은 아니다.

### 재현 기록

`e2e/test-results/native-trial/` 및 Mac의
`~/Library/Application Support/HypeProof/rehearsals/issue-828/`에 보존했다.
토큰과 계정 설정은 이 디렉터리에 포함하지 않았다.

| 실행 디렉터리 | 용도 |
|---|---|
| `20260908T204008Z` | P1 예비 실행 |
| `20260908T204038Z` | 최초 6개, P3/P4 안내 문제 발견 |
| `20260908T204242Z` | 코칭 수정 후 6개 재실행 |
| `20260908T204611Z` | 외부 도구 제거 후 최종 GPT 6개 |
| `20260908T204833Z` | 실제 Claude P1/P3 |
| `20260908T204955Z` | 별도 포트에서 실제 GPT P6 |
| `20260908T205548Z` | 공개 v0.1.56 P2 및 P4 초기 검사(화면 증거 무효) |
| `20260908T205934Z` | DOM 완료 검사를 보강한 공개 v0.1.56 P4 재검증 |

각 폴더의 `environment.json`, `api-evidence.json`, 페르소나별 `result.json`, PNG,
P4 HTML을 확인한다. GPT 폴더의 `connection.json`은 인증 방식·모델 목록만 보존한다.
인증 파일이나 구독 토큰을 저장한 것이 아니다.

개발 검증: Worker 전체 테스트·typecheck, GPT 프로토콜 정상/오류 대조 10개,
기존 native trial 권한 검사, 프로필 검사, 확장 typecheck를 실행했다.
프로필 검사에는 기존 아동 프로필 관련 경고가 남아 있으며 이번 성인 실습의 실패가 아니다.
반복 전체 검사 중 roster 부정 검사를 profile 조회에 적용한 테스트 오류가 있어,
실제 실행 gate에서 403/upstream 0회를 확인하도록 고친 뒤 다시 실행했다.

요구사항 추적은 기존 NAT-03/T04와 REQ-M36/M39를 확장했다.
새 `ST-TEST-GPT-PRACTICE`는 기존 코치 실행기 도메인의 등록된 소유자와 부모 요구사항을
따르며, 다른 도메인의 미지정 소유권 부채는 그대로 두었다.
