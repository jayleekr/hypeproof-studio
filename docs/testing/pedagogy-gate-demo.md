# 교육 원칙 관문 시연 절차

대상: 관문(#1114)이 **통과·차단·해소**를 실제 저작 화면에서 어떻게 보이는지 시연할 때.
자료: #1116 의 데모용 복제 픽스처.

```bash
npm --prefix e2e run demo:pedagogy
```

출력: `e2e/test-results/pedagogy-gate/` 에 스크린샷 8장(4겹 × 390/1280px)과 `summary.json`.
(이 디렉토리는 `e2e/.gitignore` 로 커밋되지 않는다 — 실행 산출물이지 자산이 아니다.)

## ⚠️ 이 러너만 쓴다

**시연에 다른 e2e 스크립트를 섞지 않는다.** 같은 `e2e/` 트리에 운영 API 를 **하드코딩한**
스크립트가 있다 — `e2e/unified-release/public.mjs:10` 이 `https://api.hypeproof-ai.xyz/v1` 을
상수로 들고 있고 `artifact.mjs` 도 그 값을 검사한다. 릴리스 인수용이며 시연과 무관하다.
"e2e 돌리자"가 그쪽으로 가는 것이 이 시연에서 가장 그럴듯한 사고다.

**운영 도메인에서는 시연하지 않는다.** 이유는 셋이 겹치기 때문이다:

1. **지우개가 없다.** 코드·마이그레이션 전체에 `DELETE FROM authoring*` / `DROP TABLE` 이
   0건이고, 저작 라우터에 `.delete()` 핸들러도 없다. ADR 0004 가 그렇게 설계했다 —
   *"Preserve the two D1 tables for recovery/export ... Destructive data cleanup is a
   separate decision."* 지우려면 사람이 운영 DB 에 직접 SQL 을 쳐야 한다.
2. **확정본은 불변이다.** 버전 키는 한 번 쓰이고 갱신되지 않는다.
3. **데모 표시가 봉투 바깥에만 있으면 레코드에 안 남는다.** 그래서 픽스처가
   `course_id` 에 `demo-` 접두사를, `title` 에 `[데모]` 를 달고 있고
   `worker/test/lesson-pedagogy-demo.test.mjs` 가 그것을 강제한다.

## 격리는 설정이 아니라 구조다

러너는 Chalk Worker 를 **이 프로세스 안에서** 부팅해 ephemeral `127.0.0.1` 포트 뒤에 두고,
Service 는 메모리 SQLite 하네스(`worker/test/harness/dental-authoring.mjs`)를 쓴다.
origin 이 실행 중에 `server.address().port` 로 계산되므로 **환경변수로 운영을 가리킬 수 없다.**
wrangler 를 쓰지 않고, 운영 도메인으로 나가는 요청이 없다.

러너 체인이 `process.env` 에서 읽는 것은 `HPS_BROWSER_CHANNEL` ·
`HPS_PEDAGOGY_DEMO_OUT` 뿐이다. 어느 것도 대상이나 자격을 바꾸지 않는다.

### `.dev.vars` 와 접점이 없다

- **이 경로는 `worker/.dev.vars` 를 읽지 않는다.** 러너도, `dental-authoring.mjs` 도,
  `worker/test/harness/index.mjs` 도 그 파일·dotenv·`process.env.HPS_SIGNING_SECRET` 을
  참조하지 않는다.
- 서명 비밀은 하네스의 상수 `TEST_SECRET`(`worker/test/harness/index.mjs`)이고
  `createMockEnv` 가 그 값을 기본으로 쓴다. 저장소에 커밋된 테스트 리터럴이며 운영 비밀이
  아니다. **프로세스 안에서 발급하고 프로세스 안에서 검증하므로 값이 무엇이든 무관하다.**
- 따라서 `worker/.dev.vars` 의 서명 비밀이 운영과 같든 다르든 **이 시연에 영향이 없다.**
- **`chalk/README.md` 의 "worker/.dev.vars 를 chalk 로 복사하라" 절차를 하지 않는다.**
  그 안내는 `wrangler dev` 로 Chalk 를 띄우는 경우를 위한 것이고 이 러너는 wrangler 를
  쓰지 않는다. 습관적으로 복사하면 운영 비밀을 한 곳 더 만드는 것뿐이다.

## 네 겹 — 각각 무엇을 보이나

같은 수업 하나가 세 단계로 나온다. **①과 ②는 서로 다른 층에서 막힌 것이고, 그 구분이
시연의 논점이다.** 둘 다 "막혔다"로 뭉뚱그리면 부정확하다.

| 겹 | 어디서 막히나 | 화면 문구 | 스크린샷 |
|---|---|---|---|
| ① | **저작 화면 선검사** — 서버 요청이 나가지 않는다 | `목표를 작성하고 초안을 저장해주세요.` | `layer1-client-precheck-*.png` |
| ② | **Service 관문 (HTTP 422)** | `HTTP 422: 수업 설계가 교육 원칙 검사를 통과하지 못했습니다` | `layer2-pedagogy-gate-422-*.png` |
| ③ | 막히지 않음 — 확정 성공 | `강의가 확정되었습니다. 커리큘럼을 저장했습니다. 수업을 시작하기 전에 학생 조건으로 리허설하세요.` | `layer3-frozen-*.png` |
| ④ | 통과했어도 남는 경고 | 확정 응답의 `pedagogy` — `step_evidence` 경고 6건 + `duration_consistency` 미확인 1건 | `layer4-remaining-warnings-*.png` |

러너가 ①에서 **확정 요청이 서버로 나가지 않았음**을, ②에서 **실제로 나갔음**을 각각
`local.calls` 로 확인한다. 화면 문구가 같으면 실패한다 — 두 겹이 구분되지 않는 시연을
만들지 않기 위해서다.

### 지금 화면에 보이지 않는 것

**②에서 `remedy` 목록이 화면에 닿지 않는다.** `chalk/src/ui/authoring.html` 의 `call()` 이
실패 응답에서 `j.error` 문자열만 뽑아 던지므로 `findings` 가 버려진다. 즉 **"관문이 막는다"는
화면으로 보이고 "관문이 다음 행동을 지목한다"는 보이지 않는다.**

`remedy` 까지 보이려면 저작 화면 수정이 필요하다(별도 결정). 그때 이 러너를 다시 돌려
②를 재촬영하면 된다 — 나머지 겹은 그대로다.

그동안 `remedy` 와 정본 조항을 사람이 읽을 형태로 보려면:

```bash
npm --prefix worker run demo:pedagogy-report
```

## 시료

`worker/test/fixtures/lesson-pedagogy/` 의 `*.demo.json`.

| 픽스처 | 쓰임 | 비고 |
|---|---|---|
| `dental-field-cuesheet` | ① | **원문 충실본.** 완료 기준·선행 조건·목표가 원 자료에 없어 그대로 비웠다 |
| `dental-field-cuesheet-gate` | ② | ⚠️ **구성물이다.** 위 원문에 목표와 완료 기준을 채우고 **선행 조건만 다시 비웠다.** 선검사와 형태 검증을 통과해 관문까지 도달하는 유일한 모양이라서다. 원 자료의 주장이 아니다 |
| `dental-field-cuesheet-resolved` | ③④ | 관문이 이름을 부른 칸만 채운 판. 증거물은 일부러 안 채웠다 — 원문이 지목하지 않은 산출물을 지어내지 않는다 |
| `dental-formal` · `sk-family-runbook` | 통과 사례 | 러너에는 안 쓰고 `demo:pedagogy-report` 에서 보인다 |

세 겹이 같은 강의라 픽스처의 `course_id` 가 겹친다(해소본은 차단본과 같은 강의여야 하고
테스트가 그것을 고정한다). 저작 API 는 같은 id 재생성을 409 로 막으므로 — 기존 강의를
보호하는 정상 동작이다 — **러너가 `-l1`/`-l2`/`-l3` 꼬리표를 붙여** 세 번을 각각 다른
강의로 만든다. `demo-` 접두사는 앞에 그대로 남는다.

## 이 자료의 성격

**데모용 복제다. 운영 데이터도 실적도 아니다.** 참가자가 무엇을 만들었는지에 대한 기록이
아니며, 산출물은 *설계상 만들기로 한 것*이다. 치과 회차는 실측 입력이 0건이다. 저작 귀속은
전부 `unverified` 이고 출처 경로·원본 리비전을 픽스처에 병기했다. 어느 쪽도 "실제 진행한
수업의 정본"이라고 단정하지 않는다.
