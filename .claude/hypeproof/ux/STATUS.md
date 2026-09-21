# STATUS — 2026-09-21 (2차)

다음 세션이 **제일 먼저** 읽는 문서. 그다음 `MASTER_PROMPT.md` (v4).

---

## 0. 지금 상태

- **PR #1218 은 머지됐다** → `main` 의 `f44cce3`. ADR 0010 **1단계 완료**.
- **PR #1221 이 열려 있고 CI 18개가 전부 초록이다.** 브랜치
  `feat/adr0010-step2-gate-split`, 추적 이슈 **#1220**. ADR 0010 **2·3단계**.
  https://github.com/jayleekr/hypeproof-studio/pull/1221
- 초록 중에 **`start-page-browser` 도 있다** — 로컬에 playwright 가 없어 못 돌린
  `e2e/trial-ux` 를 CI 가 돌렸고 통과했다. `start-page.yml` path 필터에
  `worker/src/profiles/**` 가 있어서 이 PR 로 트리거된다.
- 리뷰어 요청까지 끝났다. **머지는 사람이 한다.**

```
c42fc59  docs(sx): 이 문서
d58c3ad  fix(adr,worker): 적대적 검토가 확인한 3건 수리
bb2fba3  docs(adr): 2·3단계 구현 기록과 4단계가 실제로 막힌 지점
473e6ae  feat(worker): 평가할 수 없는 코호트를 이름 대고 거절한다 (3단계)
9ec3bb8  feat(worker): 세션 게이트와 체험 좌석 발급에 각자의 플래그 (2단계)
```

---

## 1. 이 브랜치가 한 일

`observation.enabled` 가 겸하던 네 가지 중 **남은 둘**을 떼어냈다.

| 무엇 | 전 | 후 | 읽는 곳 |
|---|---|---|---|
| 수업 전에 프로필을 읽을 수 있나 | `record` | `session.requires_open_session` | `GET /v1/profile` **만** |
| 개인 체험 좌석을 발급할 수 있나 | `observation.enabled` | `trial.individual` | `admin/tokens/issue` **와** `gateChatRequest` |
| 코호트 모델이 평가 공급자가 아닐 때 | `502 assessment_failed` | `409 assessment_provider_mismatch` | `observations/assess` |

둘 다 **오늘 `true` 이던 딱 그 두 프로필**(`canary-sdk-contract`, `studio-native-trial`)
에만 선언했다. 그래서 서빙 스냅샷 36칸이 그대로다. 두 필드 모두 **응답 본문에 나가지
않는다** — 출하된 앱은 존재조차 모른다.

### ADR 이 안 적어 둔 것 셋 (전부 실측)

1. **읽는 곳이 다섯 번째로 있었다.** `lib/chat-gate.ts` 가 발급된 native_trial 좌석에
   세션을 줄지를 같은 플래그로 정한다. 발급 쪽만 옮겼으면 **발급은 되는데 영원히 403**
   인 좌석이 만들어진다. 한 커밋에서 같이 옮겼다.
2. **클론 사슬이 한 칸 더 길다.** `studio-gpt-practice` 가 `studio-native-trial` 을
   spread 하고(`studio-gpt-practice.ts:7`), `studio-model-practice` 가 그걸 또 한다.
   `trial` 은 둘 다 덮지 않는 키라 **발급 대상이 2개→4개로 소리 없이 늘 뻔했다.**
   `studio-gpt-practice` 에 `{ individual: false }` 를 명시했고, 집합을 못 박는 테스트를 넣었다.
3. **scope 없는 observation 블록은 절대 안 보낸다.** scope 는 세션에서 나오므로, 게이트를
   안 타는 기록 좌석엔 scope 가 없다. 그런데 출하된 v0.1.56 은 블록의 **존재만** 보고
   채팅 기록 버킷을 `sha256(token)` 으로 돌린다 — 학생 대화가 화면에서 사라지고 토큰을
   재발급할 때마다 또 사라진다. 블록과 배너를 **한 번 결정해서 두 번 읽는** 구조로 바꿨다.

### 3단계는 **거절**이고 대체가 아니다

ADR 은 둘 다 허용했지만(`고르거나 … 거절한다`) 앞쪽 가지는 존재하지 않는다.
`native-assessment.ts` 는 분기 없이 Anthropic 으로 보낸다. GPT 코호트에 Claude 모델 id 를
주는 건 라우팅이 아니라 **그 코호트 학생 원문과 코치가 만든 파일 본문을 프로필에 없는
공급자로 보내는 일**이다. 어느 코호트를 자기가 안 쓴 공급자로 평가할지는 사람이 정한다.

**ADR 증거표 정정: 502 는 원래 도달 불가능했다.** 모델 키가 Anthropic 이 아닌 프로필은
`studio-gpt-practice`(gpt-5.6-luna)·`studio-model-practice`(glm-5.2) 둘뿐이고 **둘 다
assess 가 꺼져 있어** 한 줄 위 404 에서 멈춘다. 이번 변경은 4단계가 열 구멍을 **미리**
막은 것이지 지금 나는 고장을 고친 게 아니다.

---

## 2. 게이트 상태 (`d58c3ad` 기준)

```
worker  npm test           0 fail (exit 0)
worker  tsc                0
ext     npm test / tsc     0 fail / 0
webview npm run build      0
프로필 서빙 스냅샷          9 프로필 × 4 축 = 36칸 불변
심은 결함                  8개 심어 8개 잡힘, 전부 의도한 테스트에서만
적대적 검토                18건 보고 → 반증 우선 3중 검증 → 3건 확인 → 3건 수리 완료
```

심은 결함 8종: 게이트가 다시 record 를 읽음 / 게이트가 새 플래그를 무시 / scope 없는
블록을 보냄 / assess 모델을 코호트 공급자로 해석 / 발급 검사가 legacy 로 폴백 /
`studio-gpt-practice` 가 상속 차단을 그만둠 / 채팅 게이트를 안 옮김 /
**발급 라우트가 세션 게이트 플래그를 읽음**(마지막 둘은 적대적 검토가 찾아준 것).

### 적대적 검토에서 확인된 3건 — 전부 고쳤다 (`d58c3ad`)

- **HIGH** — ADR 의 "4단계 막힘" 절이 **이 브랜치가 방금 불가능하게 만든 피해**를 적고
  있었다. 자세한 건 §3.
- **MEDIUM** — 발급 라우트 테스트가 `trial.individual` 과 `session.requires_open_session`
  을 **구분하지 못했다**. 오늘 네 플래그가 같은 두 프로필에서 참이라 그렇다. 두 조건을
  맞바꿔도 워커 스위트 전체가 초록이었다. 분리 케이스 둘을 넣고 다시 심어 확인했다.
- **LOW** — `473e6ae` 본문이 `native-assessment.ts:196` 을 인용하는데 그건 **부모 트리의
  줄 번호**다. 같은 커밋이 위에 17줄을 넣어서 자기 트리에선 :213 이다. 코드 주석은
  심볼로 인용하고 있어 멀쩡하다.

---

## 3. **4단계는 프로필 한 줄이 아니다** — 이번에 실측으로 드러났다

`record: true` 기본값이 Jay 가 원한 것이다. ADR 이 적은 대로 프로필만 고치면
**아무 일도 안 일어난다.** 이 브랜치 head 에서 잰 값:

```
step4 kids, class OPEN  -> {"status":200,"observation":null,"banner":false}
step4 kids, class SHUT  -> {"status":200,"observation":null,"banner":false}
today canary, class OPEN -> {"status":200,"observation":{...,"scope":"52e5a079…"}}
```

scope 는 세션 게이트 **안**에서 만들어지고, 2단계 이후 그 게이트는
`native_trial || requires_open_session` 이다. 둘 다 선언 안 한 코호트는 scope 가 없고,
2단계의 가드가 블록 전체를 뺀다. **즉 `record` 혼자서는 죽은 설정이다** — 이 ADR 이
없애려던 "설정은 맞는데 동작이 없는" 모양이 옮겨간 것이다.

**그래서 4단계의 첫 질문은 워커 질문이고, 실수가 아니라 진짜 결정이다:**
수업 세션을 요구하지 않는 코호트의 관측 scope 는 어디서 오나?

- `/v1/profile` 에서 활성 세션을 **실패하지 않게** 조회 — 수업 중엔 블록, 밖에선 없음.
  `/observations/context` 와 같은 출처라 어긋나지 않는다. 대신 roster·폐기·일시정지
  검사를 **안 거친** 좌석에 scope 를 준다.
- 기록 코호트를 `requires_open_session` 뒤에 두기 — 2단계가 없앤 수업 전 403 을
  바로 그 코호트들에 되돌린다.
- 세션 없는 scope 공식 — **즉시 기각**. `/observations/context` 와 달라져서 이벤트가 전부
  떨어진다.

그 결정을 한 다음에야 **출하된 빌드 쪽 위험 둘**이 따라온다 (둘 다 여전히 참):

1. **v0.1.56 은 `observation.assess` 를 안 읽는다.** 확장 트리 전체에서 0회.
   `ChatPanel.tsx:590` 이 `format === 'hps-observation/1'` **만** 보고 관측 결과 패널을
   그린다. → **#1218 이 고친 SX-59 는 이미 깔린 빌드에선 무효다.** 다음 빌드에선 맞다.
2. **블록을 보내는 순간 채팅 기록 버킷이 옮겨간다** (`chatPanelProvider.ts:660`, `:2951`).
   다음 수업 첫 화면에서 지난 대화가 통째로 빈다.

5단계(`enabled` 제거)는 이 전부와 무관하게 열려 있다.

---

## 4. **검증하지 않은 것** — 이름으로 적는다

| 안 한 것 | 왜 중요한가 |
|---|---|
| **실기 증거 0** | 앱을 한 번도 안 띄웠다. 전부 라우트 응답 아니면 정적 단언이다. 새 409 의 한국어 문구는 화면에서 본 적이 없다 |
| **실제 provider 호출 0** | 거절 경로만 쟀다. 성공 경로가 무엇을 내는지는 이 브랜치가 아무 말도 안 한다 |
| **출하 빌드 주장은 `git show v0.1.56:…` 에서 읽은 것** | 출하된 소스는 맞지만, 실제로 깔린 앱을 이 워커에 물려 본 적은 없다 |
| **`e2e/trial-ux` 로컬 미실행** | 로컬에 playwright 없음. **CI 에서는 돌았고 통과했다** (`start-page-browser`). path 필터의 `worker/src/profiles/**` 가 이 PR 에 걸린다. 즉 이 줄은 "내가 안 봤다"이지 "아무도 안 봤다"가 아니다 |
| **워커의 한국어 `message` 는 어느 빌드도 안 쓴다** | 앱이 자기 문장을 만들고 코드만 괄호에 넣는다. 학생은 `(assessment_provider_mismatch)` 를 날것으로 본다. 이건 이 브랜치가 만든 게 아니라 502 때도 같았다 |

`ST-VAL-ACTIVITY-CANDIDATE` · `ST-VAL-UNIFIED-ENTRY` 를 **`unknown`** 으로 올리고
followup 을 **#1217** 로 달아 둔 이유가 이것이다.

---

## 5. hype-pr 기록 — 다음에 또 걸릴 함정

PR 은 냈다. 여기 남기는 건 **다음 사람이 같은 데서 안 멈추도록**이다.

**함정 셋 (이번에 실제로 걸린 것):**

- **`HTTP unknown` 은 토큰 문제만이 아니다.** 이번엔 GitHub **2차 레이트 리밋**이었다.
  같은 호출이 다음 시도에서 `HTTP 403` 으로 바뀌어서야 알았다. `gh api rate_limit` 은
  2차 리밋에 **면제라서 `remaining: 5000` 을 그대로 보여준다** — 믿지 말고
  `gh api repos/<owner>/<repo>/contents` 를 직접 찔러라.
- **`inspect` 한 번이 Lab 저장소까지 훑는다.** 적대적 검토에 `gh` 를 금지시켜도
  inspect·prepare 자체가 리밋을 태운다. PR 낼 계획이면 **검토와 PR 사이에 여유**를 둬라.
  2차 리밋은 **1차 리셋(다음 정시)보다 훨씬 빨리 풀렸다** — 07:06 에 막혀서 07:17 에 풀렸다.
  한 시간 기다리지 말고 `contents` 를 2분마다 찔러 보는 게 맞다.
- **`gh pr edit --body-file` 은 `hype-pr` 가 붙인 `<!-- hype-pr-prepared:v1 -->` 각주를
  지운다.** 본문을 고칠 일이 있으면 각주를 직접 다시 붙여라 — 내용은 receipt 의
  `report` 에서 그대로 만들 수 있다 (`preparation.summary()` 와 같은 형식).

평가서에서 직접 손댄 판정: `ST-IMP-MODEL-USAGE` · `ST-IMP-OPERATOR-HEALTH-AUTH` ·
`ST-IMP-SX-P0` · `ST-IMP-UNIFIED-ENTRY` 는 `satisfied`,
**`ST-VAL-ACTIVITY-CANDIDATE` · `ST-VAL-UNIFIED-ENTRY` 는 `unknown` → #1217**.
`path_links` 6개는 전부 `implementation` 으로 분류했다 — **이건 receipt 안의 링크지
`config/traceability.json` 에 노드를 넣은 게 아니다.** 두 개를 섞어 말하지 마라.

---

## 6. 다음 작업 — 우선순위 순

### 6a. ADR 0010 4단계 — 먼저 §3 의 결정부터

Jay 가 원한 것이지만 지금 상태로는 프로필 한 줄이 아니다. 세 후보 중 무엇을 고를지가
먼저고, 그다음이 앱 릴리스다. 5단계(`enabled` 제거)는 지금 바로 할 수 있다.

### 6b. 수업 내용이 하나도 없다 — 그릇만 있다 (변동 없음)

`session_design` / `lesson` 키가 `worker/src/profiles/types.ts` 에만 있다. 9개 프로필
어디에도 수업 내용이 없다. **Jay 의 결정이 필요하다**: 미션 문장을 누가 쓰나.

### 6c. Jay 결정 대기

- 6b — 수업 내용 작성 주체
- §3 — 수업 세션을 요구하지 않는 코호트의 관측 scope 출처
- **#1218 의 SX-59 수정이 이미 깔린 빌드에선 무효라는 사실** (§3-1). 다음 빌드를 언제 낼지
- 학생 화면 문구가 초등학생에게 통하나 (`종류로 추리기` · `기대 조건 남기기` ·
  `아직 확인 전` vs `내가 그렇다고 적은 것`)
- 어느 실제 반에 `hps-observation/2` 를 줄 것인가
- SX-T 행들을 위한 앱 빌드 승인 (1~2시간)

### 6d. 남은 문서 표류

- SX-24 (팀 기여) — `/2` 스키마가 머지됐으니 풀렸다
- P2 (경계 회고)
- 테스팅 문서의 층·명령 index 표류 약 30곳
- `worker/test/` 에 **어느 스크립트도 안 부르는 파일이 12개** 있다 (`scrub-secrets.test.mjs`
  포함). 워커 테스트는 `package.json` 에 손으로 나열한다 — 새 파일은 반드시 추가해라

---

## 7. 이 세션이 배운 것

1. **내 가드가 만든 결과를 내 산문이 못 따라갔다.** 2단계에서 "scope 없으면 블록 없음"
   가드를 넣어 놓고, 스무 줄 아래 4단계 절에는 **그 가드가 불가능하게 만든 피해**를
   적었다. 게이트 여덟 개가 전부 초록인 상태였다. 적대적 검토가 잡았다.
   → MASTER_PROMPT v4 §4 의 낱말 표에 **"~하면 ~가 된다"(미래형 인과 주장)** 도 넣을 값이 있다.
2. **집합이 같으면 테스트는 구분하지 못한다.** 오늘 `record`·`assess`·`trial.individual`·
   `requires_open_session` 이 같은 두 프로필에서 참이다. 그래서 조건을 맞바꿔도 초록이었다.
   **합성 코호트로 플래그를 갈라 놓는 케이스**가 그 자리의 유일한 계측기다.
3. **상속은 침묵으로 동의한다.** spread 로 만든 프로필에 새 블록을 넣으면 자식이 가져간다.
   `grep structuredClone src/profiles/*.ts` 30초.
4. **`rate_limit` 엔드포인트는 2차 리밋을 못 본다.** `remaining: 5000` 이 초록 신호가 아니다.
