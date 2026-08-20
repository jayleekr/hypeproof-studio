# tests/load — 교실 부하 하네스 (23-way)

23명이 동시에 코치를 부르는 교실을 재현하고, **한 아이가 겪는 지연**을 잰다.
`tests/rehearsal/` 와 같은 무의존성 스타일 (Node 22+, 외부 패키지 0).

부하 발생기는 **Node async worker** 다. LLM 에이전트를 부하 발생기로 쓰지
않는다 — 비결정적이고 배리어 시각을 못 맞추며, 자기 생각시간을 교실 지연으로
착각해 기록한다.

---

## 먼저 읽을 것 — 이 하네스가 무엇을 때리는가

**프로덕션 경로는 `/v1/messages` (Agent SDK 게이트웨이)다. `/v1/chat/completions`
가 아니다.**

두 SK 아동 프로필 모두 `coach_runtime: "agent-sdk"` 를 선언한다:

- `worker/src/profiles/sk-biopharm-kids-s1.ts:61` (초3·4)
- `worker/src/profiles/sk-biopharm-kids-2026-grade-5-6-s1.ts:67` (초5·6)

프로덕션 토큰으로 직접 확인한 값 (2026-08-19):

```
token probe: 200 · profile=sk-biopharm-kids-2026-grade-3-4-s1
             · coach_runtime=agent-sdk · minor_cohort=true
```

⚠ 두 프로필 파일 안의 주석에는 **"미성년은 워커가 proxy 로 고정한다"** 는
문장이 아직 남아 있다 (grade-5-6 파일 `sdk_tools` 위 주석). 코드와 어긋나는
낡은 주석이다 — `routes/chat.ts:270` 은 프로필이 `agent-sdk` 면 그대로
`agent-sdk` 를 내려준다. 미성년이라고 proxy 로 강등하는 코드는 없다.
이 주석을 믿고 proxy 경로만 부하시험하면 **실제로 쓰이지 않는 경로를 재게 된다.**

`LOAD_PATH=chat` 으로 프록시 경로도 같은 스크립트로 잴 수 있다 (두 런타임
직접 비교용). 기본값은 `messages`.

---

## 빠른 실행

```bash
cd tests/load

# 0. 계측기 대조군 — 앱도 토큰도 세션도 필요 없다. 밀리초.
node --test selftest.mjs

# 1. 양성대조군 (1명). 이게 통과 못 하면 하네스가 고장난 것이다.
LOAD_WORKERS=1 LOAD_TURNS=8 node run.mjs

# 2. 리포트 + 판정 (exit 0 = PASS, 1 = FAIL)
node report.mjs runs/<run-id>.jsonl

# 3. 23-way 동시 버스트 — 사람 승인 후에만
LOAD_WORKERS=23 LOAD_ARRIVAL=burst LOAD_TURNS=8 node run.mjs
```

---

## 환경변수

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `LOAD_WORKERS` | `1` | 가상 학생 수 |
| `LOAD_TURNS` | `8` | 학생당 턴 수 |
| `LOAD_ARRIVAL` | `burst` | `burst` / `barrier` / `stagger` |
| `LOAD_PATH` | `messages` | `messages`(SDK, 프로덕션) / `chat`(프록시) |
| `LOAD_SEED` | `20260819` | 시드. 같은 시드 = 같은 게스트 선택·같은 think-time |
| `LOAD_THINK_MIN_MS` / `MAX_MS` | `30000` / `90000` | 아이 속도 think-time |
| `LOAD_STAGGER_MS` | `20000` | `stagger` 모드 시작 분산 폭 |
| `LOAD_MAX_TOKENS` | `16384` | 워커가 어차피 16384 로 클램프 (`translate.ts:514`) |
| `LOAD_TURN_TIMEOUT_MS` | `300000` | 턴 하드 타임아웃. 치과 max 가 278s 였으므로 60s 로 자르면 재려던 꼬리를 자른다 |
| `LOAD_COHORT` | `sk-biopharm-2026-a` | |
| `LOAD_WORKER_ORIGIN` | `https://api.hypeproof-ai.xyz` | |
| `LOAD_FORCE_SPLIT` | (미설정) | `1` 이면 13/10 분할 강행 — **세션과 다른 프로필은 403 난다.** 아래 참조 |
| `HPS_ADMIN_PASSWORD` | `worker/.dev.vars` 에서 읽음 | 값은 절대 출력하지 않는다 (길이만) |

### 도착 모드

- **`burst`** — 전원이 t=0 에 1턴을 동시 발사, 이후 각자 think-time 으로 흩어진다.
  강사의 "다들 지금 보내보세요". 교실의 진짜 최악 케이스이고 Poisson 도착으로는
  절대 안 나온다.
- **`barrier`** — **매 턴**을 전원 동기화. 지속적 최악 케이스.
- **`stagger`** — 시드 난수로 시작만 분산. 완만한 대조군.

---

## 1인 양성대조군 실측 (2026-08-19, 프로덕션)

`runs/positive-control-1p-v3.jsonl` · 8 대화턴 → **13 요청** (툴 루프 때문에 늘어남)

```
turns=13 ok=13 failed=0 (product=0 operator=0) http429=0
usage observed 13/13
TTFT   p50=4923  p95=7389  max=7389   (n=11 — 순수 tool_use 라운드 2개는 텍스트가 없어 null)
turn   p50=6909  p95=64212 max=64212
  heavy p50=7077  max=64212
  light p50=5750  max=8602
input=29  cache_read=200507  cache_create=16690  output=4839
cache_read / input-side = 92.3%
peak RPM 5 · peak billable ITPM 8291 · peak OTPM 4000
ms/output-token 중앙값 73.67 @ 동시성 1
```

**하네스 배관은 검증됐다** — 13/13 이 200, usage 13/13 관측, 캐시 92.3% (치과
80~94% 대와 일치), 학습자 노출 오류 0.

**그런데 임계값 3개가 동시성 1에서 이미 깨진다.** 규칙 6대로 계측기부터 배제했다:

| 항목 | 실측 | 한도 | 계측기인가? |
|---|---|---|---|
| TTFT p95 | 7,389ms | 3,000ms | **아니다.** curl 로 독립 확인 — 사소한 요청("안녕", max_tokens 64)에서도 first byte 가 **1.77 / 1.94 / 3.03초**. 게이트웨이 자체의 바닥이 ~2-3초다 |
| 턴 p95 | 64,212ms | 25,000ms | **아니다.** 출력 3,767토큰 Write 턴 1개. 3767 × 17ms ≈ 64s — **확정 사실인 "17ms/출력토큰 + 1.5초" 모델과 정확히 일치** |
| 턴 p99 | 64,212ms | 60,000ms | 위와 같은 턴 |
| cache 비율 | 92.3% | 80% | **계측기였다 → 고쳤다.** 아래 참조 |

### 고친 계측기 오류 1건 (거짓 제품 결함으로 보고할 뻔함)

첫 툴 런에서 캐시 비율이 **42.7%** 로 나왔다. "프롬프트 캐싱이 깨졌다"고 보고하기
직전에, 하네스가 `cache_control` 브레이크포인트를 **안 보내고 있다**는 것을 확인했다.
워커는 시스템 프리픽스와 마지막 tool 에만 표시하고(`translate.ts:500,605`) 히스토리는
표시하지 않는다 — 그건 **클라이언트(Agent SDK)의 몫**이고, `messages.ts:152` 가
클라이언트 블록의 `cache_control` 을 그대로 통과시킨다. SDK 처럼 마지막 메시지의
마지막 블록에 브레이크포인트를 달자 **42.7% → 92.3%**, uncached input 이 요청당
**1~3토큰**으로 떨어졌다.

⇒ 규칙 6이 실제로 작동했다. 안 했으면 멀쩡한 캐싱을 고치러 갔을 것이다.

### ⚠ 1인 런으로는 p95/p99 를 판정할 수 없다

nearest-rank 백분위는 `n < 1/(1-p)` 이면 **max 로 붕괴한다**. n=13 에서 "p95" 는
그냥 제일 느린 샘플이다. 리포터가 이제 그 사실을 각 체크에 주석으로 붙인다:

```
[FAIL] turn total p95 (ms)  64212 (limit 25000)  — n=13 < 20: p95 == max here, not a real tail
```

**즉 1인 대조군의 역할은 "임계값 통과 확인"이 아니라 "배관·계측 검증"이다.**
진짜 꼬리는 23명 × 8턴 ≈ 300요청에서만 의미가 생긴다.

---

## 판정 기준 (`config.mjs` 의 `THRESHOLDS` — 런 전에 고정, 통과시키려고 움직이지 말 것)

| 항목 | 한도 | 근거 |
|---|---|---|
| TTFT p95 (23 동시버스트) | ≤ 3.0s | 첫 **글자**가 뜨는 시각. message_start 는 아이 화면에 아무것도 아니다 |
| 턴 완료 p95 | ≤ 25s | |
| 턴 완료 p99 | ≤ 60s | 치과가 211s 로 실패했던 자리 |
| 학습자 노출 non-200 | 0% | 운영자 상태(403 session_*) 는 **제외**하고 센다 |
| cache_read / 입력측 합 | ≥ 80% | 치과 실측 80~94% |
| peak billable ITPM | ≤ 2,000,000 | Scale 한도 10M 의 20% |

판정은 세 값을 낸다: `PASS` / `FAIL` / **`UNKNOWN`**. 못 잰 지표는 조용히
통과시키지 않는다 — 데이터 없음을 성공으로 읽는 것이 이 파일이 막으려는 실패다.

---

## 대조군 (`node --test selftest.mjs`)

계측기 자체를 검증한다. 앱 없이 밀리초에 돈다.

- **양성** — 확실히 좋은 합성 런이 **PASS 해야** 한다. *너무 엄격한* 계측기를 잡는다
  (2026-07-25~27 오판 9건이 전부 이쪽이었다).
- **음성** — ① 불가능한 임계값(TTFT p95 ≤ 1ms)이 완벽한 런에서도 **FAIL** 해야 한다
  (안 그러면 리포터가 판정을 아예 안 하는 것) ② 211s 꼬리가 p99 게이트에 걸려야 한다
  ③ 502 가 non-200 게이트에 걸려야 한다 ④ 캐시 1% 런이 80% 게이트에 걸려야 한다.
- **UNKNOWN** — usage 미관측 런이 PASS 하면 안 된다.
- **운영자 상태** — 403 `session_inactive` 는 product 실패가 아니라 operator 실패로
  분류돼야 한다.
- **심은 정답** — 백분위·슬라이딩윈도우·동시성 겹침은 전부 손으로 계산한 답과 대조한다.

새 채점 로직을 넣으면 대조군도 같이 넣어라. 대조군 없는 채점기는 신뢰하지 않는다.

---

## 측정 정의 (치과 분석과 같은 것을 세야 비교가 된다)

| 지표 | 정의 |
|---|---|
| **TTFT** | 첫 **text delta**. `message_start` 아님 |
| **TTFB** | 첫 SSE 바이트. 참고용으로만 같이 기록 |
| **턴 완료** | 요청 송신 → 스트림 종료 |
| **billable ITPM** | 슬라이딩 60초 창의 `input_tokens + cache_creation_input_tokens` 합. **cache_read 제외**. 요청 **시작** 시각에 귀속 |
| (참고) | `peak_itpm_incl_cache_read` 도 같이 낸다 — 어느 관례로 나온 숫자인지 독자가 구분할 수 있게 |
| **OTPM** | 슬라이딩 60초 창의 `output_tokens` 합. 턴 **완료** 시각에 귀속 |
| **동시성** | 그 턴의 `[start,end)` 와 겹치는 턴 수 (자기 포함) |
| **cache 비율** | `cache_read / (input + cache_read + cache_creation)` |

usage 를 못 읽은 턴은 `null` 로 남긴다. **0 으로 채우지 않는다** — "토큰 0 썼음"은
지어낸 데이터다 (워커도 `enqueueUsageChunk` 에서 같은 규율을 지킨다).

usage 출처 (짐작 아님, 코드 확인):
- `/v1/messages` — Anthropic SSE 원문 통과. `message_start.message.usage` +
  `message_delta.usage.output_tokens` (`lib/sse.ts:266-277`)
- `/v1/chat/completions` — `[DONE]` 직전 합성 청크의 `hps_usage`
  (`lib/sse.ts:459-492`). 네 카운터가 전부 0 이면 **청크 자체가 생략된다**

---

## 툴 루프 — 없으면 교실이 아니라 잡담을 재게 된다

**실측 (2026-08-19, 1인 대조군):** 툴 없이 돌리면 `"그렇게 바꿔줘"` 턴이
**출력 165토큰**에서 끝났다. 프로덕션에서 그 턴은 코치가 `index.html` 을 통째로
Write 하는 턴이고, 실제 kids-quest 스켈레톤은 **11.8~14.0 KB**
(`worker/src/skeletons/kids-quest/*.html`) — 수천 토큰짜리다.

즉 **툴 없는 하네스는 p99 를 만드는 바로 그 턴을 ~25배 싸게 재고 있었다.**

그래서 하네스는 코호트가 실제로 주는 툴(`sdk_tools: {read, write}` →
Agent SDK 이름 `Read`/`Write`/`Edit`, `sdkCoachHelpers.ts:112,261` 확인)을
요청에 실어 보내고, `tool_use` 가 오면 **합성 `tool_result` 로 응답하고 같은 턴을
계속 돈다.** 이것이 프로덕션 동작이다 — 한 "턴"은 요청 1개가 아니다.

- `Read` 결과는 **실제 스켈레톤 파일 바이트**를 그대로 준다 (지어낸 파일 아님).
  `cat -n` 줄번호 형식까지 맞춘다.
- `Write` 는 가상 워크스페이스에 저장되고, 다음 `Read` 는 **코치가 쓴 내용**을
  돌려준다. 안 그러면 두 번째 빌드 턴에서 컨텍스트가 실제처럼 자라지 않는다.
- 라운드마다 **JSONL 한 줄**을 남긴다 — RPM·동시성은 대화 턴이 아니라 **요청**을
  세야 맞다.
- `LOAD_TOOLS=0` 으로 툴 없는 형태와 비교할 수 있다.
- `LOAD_MAX_TOOL_ROUNDS` (기본 6) 이 폭주를 막는다.

---

## 무엇을 못 재는가 (짐작으로 채우지 말 것)

1. **업스트림 429 를 못 본다.** `callAnthropicResilient` 가 transient 429/5xx 를
   재시도로 흡수한다 (#373, `routes/chat.ts` 및 `messages.ts`). 그래서 `http_429`
   카운터는 **아이 화면에 실제로 뜬 429** 만 센다. 업스트림이 몇 번 429 를 냈는지는
   **워커 로그(`wrangler tail`)에서만** 보인다. 하네스가 429=0 을 냈다고
   "한도에 안 걸렸다"고 결론내면 틀린다 — 재시도 때문에 지연으로 나타났을 수 있다.
2. **`anthropic-ratelimit-*` 헤더는 안 온다.** 워커가 자기 Response 를 새로 만들고
   업스트림 헤더를 통과시키지 않는다. 하네스는 오면 기록하지만, 지금 구현에서는
   **빈 객체가 정상**이다. 비어 있다고 계측 실패로 읽지 말 것.
3. **`count_tokens` 호출이 빠져 있다.** 진짜 SDK 는 컨텍스트 예산을 잡으려고
   `/v1/messages/count_tokens` 를 부른다. 그만큼 **실제 RPM 은 여기서 잰 값보다
   높다.** 여기 숫자는 하한이다.
4. **툴 승인을 항상 통과시킨다.** 프로덕션은 `canUseTool` 승인 게이트를 지나고
   아이/부모가 버튼을 눌러야 한다 — 그 **사람 지연**은 재지 않는다 (재면 안 된다.
   그건 서버 부하가 아니다).
5. **`compact`(컨텍스트 압축)를 재현하지 않는다.** 긴 세션에서 SDK 가 히스토리를
   압축하면 입력토큰 곡선이 달라진다. 8턴 런에서는 안 걸린다.

---

## 함정

**세션이 열려 있어야 한다.** 안 열려 있으면 `403 session_inactive` — 앱 고장이
아니라 운영자 상태다. `run.mjs` 는 시작 전에 세션을 읽고, 없으면 **부하를 걸지 않고
종료**한다 (닫힌 세션에 23명을 쏴서 403 을 제품 실패로 보고하는 사고 방지).

```
skills/hype-session 또는 /console 로 열기 → 끝나면 닫기
```

**`401` 을 만료로 단정하지 마라.** 토큰을 직접 찔러본다 (`run.mjs` 가 자동으로
1번 토큰에 대해 한다):

```
curl -H "Authorization: Bearer <토큰>" https://api.hypeproof-ai.xyz/v1/profile
```

200 이면 토큰은 무죄다.

**roster 등록이 토큰 발급보다 먼저다** (#367). `run.mjs` 가 자동으로
`load-01`…`load-NN` 을 append 한다 (idempotent).

**rehearsal 배너가 먼저 찍힌다.** `tests/rehearsal/helpers/env.mjs` 를 import 하면
`[rehearsal] env: … COHORT = boah-dental-2026-a` 배너가 부작용으로 출력된다.
**이 런의 설정이 아니다.** 바로 아래 하네스 자신의 배너를 믿어라.

**어드민 비밀번호는 절대 출력하지 않는다.** 길이만 찍는다.

---

## 23-way 를 돌리기 위해 사람이 해야 할 일

### ⛔ 막힌 곳: 13/10 분할은 지금 구조로 불가능하다

`lib/chat-gate.ts:159`:

```ts
if (session.profile_id !== profile.id) {
  return 403 session_profile_mismatch  // "이 토큰은 다른 회차용이에요."
}
```

한 코호트에는 **활성 세션이 하나**뿐이고, 그 세션은 **프로필 하나**에 고정된다.
그리고 초3·4 와 초5·6 프로필은 **같은 코호트 `sk-biopharm-2026-a` 를 공유**한다
(`sk-biopharm-kids-s1.ts:93` 주석: "초3·4·초5·6 두 트랙이 공유하는 cohort").

⇒ **두 학년 트랙을 동시에 서비스할 수 없다.** 부하시험만의 문제가 아니라
**실제 워크숍의 문제**다. 두 트랙을 같은 시간에 돌릴 계획이라면 한쪽 전원이
403 을 맞는다.

선택지 (사람이 골라야 함):

| 안 | 내용 | 비용 |
|---|---|---|
| A | 23명 전원을 **열려 있는 세션의 프로필 하나**로 돌린다 | 부하 특성은 정확히 측정됨. 프로필 혼합만 미측정. **코드 변경 0** |
| B | 초5·6 프로필에 **별도 cohort_id** 를 준다 (예: `sk-biopharm-2026-b`) → 코호트 2개, 세션 2개 | 프로필 파일 수정 + 배포. roster/토큰 발급 절차가 두 벌 |
| C | 세션이 **프로필 배열**을 갖도록 워커 수정 | 게이트·콘솔·admin API 변경. 제일 큼 |

기본값은 **A** 다 (`LOAD_FORCE_SPLIT` 미설정 → 전원 세션 프로필). B/C 없이
`LOAD_FORCE_SPLIT=1` 을 켜면 13명이 전부 403 을 맞고, 리포트는 그것을
**operator 오류**로 분류한다 (product 실패로 오보하지 않는다).

### 발사 전 체크리스트

1. **세션을 연다** — 어느 트랙인지 명시 확인 (`skills/hype-session`, 2026-07-18 에
   스크립트 기본값으로 엉뚱한 트랙을 연 사고 있음). `/console` 도 가능.
2. **roster** — `run.mjs` 가 `load-01…load-23` 을 자동 append 한다. 현재 roster 는
   21명이고 상한은 500 (`admin.ts:705`) 이라 여유 있음. 수동으로 하려면:
   ```bash
   curl -u "admin:$PW" -X POST https://api.hypeproof-ai.xyz/admin/cohorts/sk-biopharm-2026-a/roster/append \
     -H 'content-type: application/json' \
     -d '{"users":["load-01","load-02", ...]}'
   ```
3. **토큰** — `run.mjs` 가 12시간짜리로 발급한다 (검증은 길어지므로).
4. **비용 승인** — 23명 × 8턴 = 184턴. heavy 턴이 전체 1/4 이고 최대
   16384 출력토큰까지 간다. 발사 전 예산 확인.
5. **테스트 계정이 실수업 데이터에 섞인다** — `load-*` 유저의 usage 는 실제 코호트
   usage_log 에 들어간다. 분석 시 `user_id LIKE 'load-%'` 로 걸러라.
6. **끝나면 세션을 닫는다.**

### 발사 후

```bash
node report.mjs runs/<run-id>.jsonl        # exit 1 이면 FAIL
LOAD_JSON=1 node report.mjs runs/<id>.jsonl # 원시 지표 JSON
```

`FAIL` 이 뜨면 **순서가 정해져 있다** (verification.md 규칙 6):
1. 계측기가 틀렸나 — `node --test selftest.mjs` 부터 돌린다
2. 운영자 상태인가 — `operator_errors` 가 0 인지 본다
3. 그러고 나서 제품을 의심한다

그리고 계측기를 고쳤으면 **아티팩트를 읽고 판정하지 말고 고친 코드로 다시 돌려라.**

---

## 파일

| 파일 | 역할 |
|---|---|
| `config.mjs` | 임계값 상수 + 런 설정. **런 전에 고정** |
| `tools.mjs` | SDK 툴 정의(Read/Write/Edit) + 가상 워크스페이스. Read 는 **실제 스켈레톤 바이트**를 준다 |
| `rng.mjs` | 시드 PRNG (mulberry32). 재현 가능한 think-time·게스트 선택 |
| `script.mjs` | 큐시트 턴 스크립트. 프롬프트와 확장 소스에서 그대로 옮긴 문구 |
| `client.mjs` | 턴 1회 — SSE 스트리밍, TTFT/usage 계측. HTTP 실패로 throw 하지 않음 |
| `tokens.mjs` | roster append · 토큰 발급 · 토큰 독립 검증 |
| `run.mjs` | 오케스트레이터 (배리어, 히스토리 누적, JSONL) |
| `report.mjs` | 순수 분석 + 판정. CLI 이자 라이브러리 |
| `selftest.mjs` | **대조군.** 앱 없이 계측기를 검증 |
| `runs/*.jsonl` | 런 산출물 (meta 1줄 + turn N줄 + end 1줄) |
