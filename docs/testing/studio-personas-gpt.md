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
의미는 저장된 원문을 사람이 검토해 PASS/FAIL과 근거를 남긴다. 오류 없는 응답만으로
제품 의도 충족을 선언하지 않는다. T25의 실제 사람 파일럿은 별도다.

## 비용과 인증

1. `npm --prefix worker run test:gpt-practice`: 네트워크 없이 정상·실패 대조군을 실행한다.
2. 로컬 GPT 실습은 공식 `codex app-server`의 ChatGPT 로그인을 재사용한다.
   설치된 CLI의 `codex login status`, 실제 `account/read`, `model/list`와 응답으로 확인한다.
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
기존 `scripts/test-native-trial-laptop.sh`가 확장 코드를 빌드·복사하고 자체 Service(8787)를
종료한다. 사용 중인 Service가 8787에 있으면 실행을 중단한다. 로그에 토큰을 출력하지 않는다.

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

현재 실행 중. 완료된 명령과 실제 Mac 관측 결과는 이 작업의 결과 보고서에 추가한다.
공개 OpenAI API, 다른 OS, 실제 사람의 학습 효과는 실행하지 않은 상태다.
