# 새 cohort 추가하기

HypeProof Studio의 핵심 추상화: **cohort마다 다른 UX**를 코드 수정 없이 profile 파일로 정의.

새 cohort = 새 파일 1개. 코드 0줄. 검증된 패턴.

## 어떤 cohort들이 가능한가

지금까지 검증된 분기:
- **SK바이오팜 가족 (v126, 4시간 단발 · 2트랙)** — 초3·4 `kids-basic` + 초5·6 `kids-rich`,
  같은 `cohort_id`(`sk-biopharm-2026-a`)를 공유하고 `profile_id`로만 갈라짐 → [단발 2-트랙 패턴](#단발-2-트랙-패턴-v126-sk바이오팜)
- **보아치과 (성인 · 2트랙)** — 같은 `cohort_id`(`boah-dental-2026-a`) 안에서 *다른 커리큘럼*을
  병렬 트랙으로: 직원 검색엔진(`...teaser...`, `search-webapp` tier) + 원장 웹사이트 카피클론
  (`...director-copyclone...`, `website` tier + `input.image_paste`). 둘 다 `series_total:1, series_index:1`.
  한 cohort가 *동일 레슨 2연령*(SK)이 아니라 *다른 커리큘럼 2역할*도 담을 수 있음을 보여주는 예.
- **치과(기타)** — 추가 페르소나 시뮬레이션 가능 (의료 종사자, 성인)
- **기업 AX 임원** — 시뮬레이션 가능 (formal tone, business case prompts)
- **강사 양성 / 컴피티션** — Verify 모드 (HYROX 프레임)

각 cohort = 별도 `profile_id`. 같은 cohort라도 회차/트랙마다 별도 profile.

## 절차

### 0. 빠른 시작: scaffold (권장)

손으로 빈 파일을 만들지 말고 scaffolder로 **kids 안전 기본값**(message 로깅 OFF,
공개 퍼블리시 OFF, "외부 URL 호출 금지" 가드레일 포함) 스켈레톤을 생성하세요. prompt+profile을
만들고 `index.ts`에 **멱등** 등록까지 합니다(이미 있으면 `--force` 필요):

```bash
cd worker
npm run scaffold-profile -- \
  --id sk-biopharm-kids-2026-grade-5-6-s1 \
  --display "SK바이오팜 가족 AI 창작 워크숍 (5-6학년)" \
  --cohort sk-biopharm-2026-a \
  --tier kids-rich --age-min 11 --age-max 12 \
  --hours 4 --series-total 1 --series-index 1 \
  --assets intent_clarity,context_design,verification_reflex,iteration_reflex,taste,ownership
```

그다음 생성된 `prompts/<id>.md`·`profiles/<id>.ts`를 다듬고(아래 1–2단계), `npm run validate-profiles`
로 검증합니다. 처음부터 손으로 쓰려면 1단계부터 진행하세요.

### 1. 시스템 프롬프트 작성 (`worker/src/prompts/<profile-id>.md`)

전체 markdown. 페르소나, 행동 규칙, 절대 금지 사항, 안전 룰. 1회차 prompt가 모델로:
- `worker/src/prompts/sk-biopharm-kids-s1.md`

길이 가이드: 2000-5000자. 너무 짧으면 AI가 어긋남, 너무 길면 캐시 비용↑.

### 2. Profile 모듈 작성 (`worker/src/profiles/<profile-id>.ts`)

```ts
import type { Profile } from "./types";
// @ts-ignore — text import (wrangler.toml rule)
import systemPromptMd from "../prompts/<profile-id>.md";

export const profile: Profile = {
  id: "<profile-id>",
  version: 1,
  display_name: "...",
  audience: { age_range: [..], language: "ko"|"en", parent_coaching: bool },
  model: { default: "hypeproof-fast"|"default"|"strong", fallback: ... },
  system_prompt: systemPromptMd as unknown as string,
  welcome: { greeting_md: "...", example_prompts: [...] },
  sandbox: {
    file_write: bool,
    workspace_root: "~/HypeProofGames",
    execute_shell: bool,
    mcp_tools_enabled: [...],     // 1회차 [], 후속 회차에서 확장
  },
  preview: { type: "iframe"|"live_server", auto_start: bool },
  publishing: { enabled: bool, strategy: "per_user_github_pages"|"shared_repo"|"local_only", ... },
  assets_focus: [                  // 강조할 7 AI Native Assets
    "intent_clarity",
    "context_design"
  ],
  essences_focus: [..],            // deprecated v0.1 compatibility bridge only
  session: {
    cohort_id: "<cohort-id>",      // 같은 cohort의 다른 profile/트랙과 일치
    series_total: 1,               // 단발이면 1. 시리즈면 회차 수 (같은 cohort면 값 일치)
    series_index: 1,
    hours: 4,
  },
  analytics: { log_user_messages: bool, log_metadata: bool },
  ux: {
    coach: {
      naming_mode: "user_names_it" | "fixed" | "pick_from_list",
      fallback_name: "코치",
      naming_prompt_md: "...",
      personality_prompt_md: "...",
      revisit_on_entry: bool,
    },
    suggestions: {
      initial: [
        { text: "...", style: "good" },
        { text: "...", style: "weak", caption: "왜 안 좋은지" },
      ],
      follow_up: [...]
    },
    hints: {
      short_input: { enabled, min_chars, message_md },
      roll_input_button: { enabled, label, probe_md },
    },
    retry_button: { enabled, show_counter, counter_toast_md? },
  },
};
```

### 3. Registry 등록 (`worker/src/profiles/index.ts`)

```ts
import { profile as myNewCohort } from "./<profile-id>";

const REGISTRY: Profile[] = [
  skBiopharmKidsS1,
  myNewCohort,        // ← 추가
];
```

### 4. Deploy

```bash
cd worker
npx wrangler deploy   # or wrangler dev for local
```

### 5. Worker admin에 cohort + roster 생성

브라우저로 `https://api.hypeproof-ai.xyz/admin` (또는 dev: localhost:8787) → Cloudflare Access 인증.

- Roster 입력 (예: `["수강생01", "수강생02", ...]`)
- "Start class" — 회차 profile 선택, 시간 창 설정

### 6. Token 발급 + 배포

각 참가자에게:
```bash
HPS_SIGNING_SECRET=<secret> node --experimental-strip-types worker/scripts/issue-token.ts \
  --user "수강생01" --cohort "<cohort-id>" --profile "<profile-id>" --hours 168
```

토큰을 카톡/메일로 전달 → 참가자가 앱에서 Set Token.

## 회차 간 progression 패턴

같은 cohort의 회차 (s1, s2, s3, s4)는:
- `session.cohort_id` 동일
- `session.series_index` 다름 (1, 2, 3, 4)
- 다른 profile_id (예: `sk-biopharm-kids-2026-grade-3-4-s2`)
- `ux.coach.revisit_on_entry: true`로 두면 자녀가 매 회차 코치 이름 다시 짓기 권유받음

### Foundation week (s1) 추천 설정
- `assets_focus: ["intent_clarity", "context_design", "iteration_reflex"]`
- suggestions: 짧은 vs 자세한 대비 강조
- short_input hint enabled
- retry_button: enabled but show_counter false

### Load week (s2) 추천 설정 (HYROX 제안서 §03 참조)
- `assets_focus: ["delegation_judgment", "verification_reflex", "iteration_reflex"]`
- suggestions: 도전 강도 ↑ ("더 어렵게", "약점 찾기")
- retry_button.show_counter: **true** ← Iteration reflex를 눈에 보이게 함
- coach revisit_on_entry: **true** (역할 부여)

### Mastery week (s3)
- `assets_focus: ["verification_reflex", "delegation_judgment", "taste"]`
- mcp_tools_enabled: 일부 허용 (file_write 등)
- "다중 모델" — 다른 model alias 활용 유도
- retry counter 강조 ("이번이 7번째 도전!")

### Transcendence week (s4)
- `assets_focus: ["taste", "ownership"]`
- suggestions: "지금 만든 거 다시 처음 봤다고 상상" 같은 reflection chips
- system prompt: meta 톤 (배운 걸 의심하는 자세)

## 단발 2-트랙 패턴 (v126 SK바이오팜)

연령대만 다른 **단발(single-session)** 워크숍을 두 트랙으로 운영할 때의 패턴.
SK바이오팜 v126이 모델: 초3·4 / 초5·6이 **같은 7단계·두 레슨**(Context Engineering /
Feedback Loop)을 지나되 "운전법"만 다르다.

| | 초3·4 (`...grade-3-4-s1`) | 초5·6 (`...grade-5-6-s1`) |
|---|---|---|
| `game.template_tier` | `kids-basic` | `kids-rich` |
| `audience.age_range` | `[8, 10]` | `[11, 12]` |
| `session` | `series_total: 1, hours: 4` | `series_total: 1, hours: 4` |
| `session.cohort_id` | `sk-biopharm-2026-a` | `sk-biopharm-2026-a` (**동일**) |
| `assets_focus` | intent_clarity, context_design, iteration_reflex, taste, ownership | + **verification_reflex** (규칙·검증·밸런싱) |
| `retry_button.show_counter` | `false` (자연 발견) | `true` (반복=성장 신호 가시화) |
| prompt 운영 | 짧은 문장 여러 번, 캐릭터·장면 중심, 부모 타이핑 보조 허용 | 규칙·점수·난이도, 직접 검증·공정성, 부모는 질문만 |

핵심 규칙:
- **같은 `cohort_id`**, 다른 `profile_id`. 두 트랙은 하나의 cohort 안에서 profile로만 갈라진다.
  admin "Start class"에서 회차마다 해당 트랙 profile을 선택한다. 토큰은
  `--profile <트랙 id> --cohort sk-biopharm-2026-a`로 발급.
- 같은 cohort의 모든 profile은 **`series_total`이 일치**해야 한다 (validator가 강제).
- v126 자산 매핑: ContextEngineering = `intent_clarity` + `context_design`,
  FeedbackLoop = `iteration_reflex` + `verification_reflex`, 와우·소유 = `taste` + `ownership`.
- 미성년 트랙이므로 **`log_user_messages: false` · `publishing.enabled: false`** 고정(아래 가드레일).

## 보안 / 가드레일

새 profile 작성 시 반드시 :
1. `analytics.log_user_messages`는 PII 동의 없이 절대 true 금지 (자녀 cohort는 false 고정)
2. `sandbox.execute_shell: true` 는 워크숍 환경 신뢰도 확인 후만
3. `publishing.strategy: "per_user_github_pages"`는 자녀 cohort에서 부모 동의 + 본명 노출 X 룰 필요
4. system prompt에 "외부 URL 호출 금지" 룰 포함
5. `input.image_paste`는 **default OFF** — 성인 cohort가 스크린샷 주입(website-copyclone 류)을
   필요로 할 때만 `true`. 자녀 cohort는 절대 켜지 말 것(임의 이미지가 LLM으로 전송됨). 끄면 웹뷰
   paste가 텍스트 전용으로 동작하고 워커도 image 블록을 server-side로 strip한다(이중 방어).

## Validation

새 profile 작성 후, 순서대로:

1. **`npm run validate-profiles`** — registry를 JSON으로 덤프해
   ([`scripts/dump-profiles.ts`](../worker/scripts/dump-profiles.ts)) studio-local cohort 검증기
   (`worker/scripts/cohort-harness/validate.py`)에 먹인다. 7자산 enum·prompt↔profile 정합·
   미성년 가드레일(log_user_messages, 공개 퍼블리시, "외부 URL 호출 금지")을 데이터로 검증.
   FAIL이면 비0 종료 → PR CI(`worker / validate-profiles`)가 막는다.
   > 검증기는 **studio 소유**(`worker/scripts/cohort-harness/` — validate.py + rules.yaml). 규칙을
   > 바꾸려면 `rules.yaml`을 직접 고친다(파이썬 불필요). cohort 개념은 studio 단독이라 harness로
   > vendor하지 않는다. 자체 테스트: `bash worker/scripts/cohort-harness/test/run.sh`.
2. **`npm run typecheck`** — profile이 `Profile` 타입과 정합.
3. **`npm test`** (worker smoke) → 회귀 0. smoke §4가 모든 cohort의 미성년 불변식을 재확인한다.
4. **`bash scripts/preview-profile.sh --profile <id>`** — 로컬 wrangler dev에 토큰을 발급해
   `GET /v1/profile`로 greeting·chips·coach 계약을 점검한다. 앱에 직접 붙여 채팅 →
   ▶ Run 흐름까지 수동 검증해야 할 때만 `--print-token`을 추가한다.
5. 첫 cohort dry-run (2-3명 dogfood) → 실제 데이터로 system prompt tune.

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| 401 "unknown profile" | profile id 오타 또는 registry 미등록 | `profiles/index.ts` REGISTRY 추가 |
| 401 "token cohort/profile mismatch" | token `c`와 profile.session.cohort_id 불일치 | 토큰 재발급 또는 profile 수정 |
| 코치 이름이 default로 보임 | `ux.coach.naming_mode = "fixed"` 또는 globalState 비어있음 | 명령 팔레트에서 "HypeProof Chat: 코치 이름 다시 짓기" |
| Suggestion chips 안 보임 | `ux.suggestions.initial` 빈 배열 | profile 채움 |
| 응답 톤이 안 맞음 | system prompt + coach personality 충돌 | system prompt 우선; 충돌 시 prompt에서 명시 |
