# 새 cohort 추가하기

HypeProof Studio의 핵심 추상화: **cohort마다 다른 UX**를 코드 수정 없이 profile 파일로 정의.

새 cohort = 새 파일 1개. 코드 0줄. 검증된 패턴.

## 어떤 cohort들이 가능한가

지금까지 검증된 분기:
- **SK바이오팜 자녀 (3-4학년, 8주×4회)** — 1회차 profile 작동 중
- **치과** — 시뮬레이션 가능 (의료 종사자, 성인, 다른 페르소나)
- **기업 AX 임원** — 시뮬레이션 가능 (formal tone, business case prompts)
- **강사 양성 / 컴피티션** — Verify 모드 (HYROX 프레임)

각 cohort = 별도 `profile_id`. 같은 cohort라도 회차마다 별도 profile.

## 절차

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
  essences_focus: [1..16],         // 강조할 essence 번호
  session: {
    cohort_id: "<cohort-id>",      // 같은 cohort의 다른 profile들과 일치
    series_total: 4,
    series_index: 1,
    hours: 8,
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
- `essences_focus: [2, 7, 8]`
- suggestions: 짧은 vs 자세한 대비 강조
- short_input hint enabled
- retry_button: enabled but show_counter false

### Load week (s2) 추천 설정 (HYROX 제안서 §03 참조)
- `essences_focus: [3, 4, 5, 11]`
- suggestions: 도전 강도 ↑ ("더 어렵게", "약점 찾기")
- retry_button.show_counter: **true** ← 만족 유예 essence 명시화
- coach revisit_on_entry: **true** (역할 부여 essence 5)

### Mastery week (s3)
- `essences_focus: [9, 10, 12, 13]`
- mcp_tools_enabled: 일부 허용 (file_write 등)
- "다중 모델" — 다른 model alias 활용 유도
- retry counter 강조 ("이번이 7번째 도전!")

### Transcendence week (s4)
- `essences_focus: [1, 14, 15, 16]`
- suggestions: "지금 만든 거 다시 처음 봤다고 상상" 같은 reflection chips
- system prompt: meta 톤 (배운 걸 의심하는 자세)

## 보안 / 가드레일

새 profile 작성 시 반드시 :
1. `analytics.log_user_messages`는 PII 동의 없이 절대 true 금지 (자녀 cohort는 false 고정)
2. `sandbox.execute_shell: true` 는 워크숍 환경 신뢰도 확인 후만
3. `publishing.strategy: "per_user_github_pages"`는 자녀 cohort에서 부모 동의 + 본명 노출 X 룰 필요
4. system prompt에 "외부 URL 호출 금지" 룰 포함

## Validation

새 profile 작성 후:
1. `npm run test` (worker smoke + e2e test) → 회귀 0
2. 로컬 wrangler dev에서 token 발급 → 채팅 → 코치 응답 → ▶ Run 흐름 직접 검증
3. 첫 cohort 회차 dry-run (2-3명 dogfood) → 실제 prompt 데이터로 system prompt tune

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| 401 "unknown profile" | profile id 오타 또는 registry 미등록 | `profiles/index.ts` REGISTRY 추가 |
| 401 "token cohort/profile mismatch" | token `c`와 profile.session.cohort_id 불일치 | 토큰 재발급 또는 profile 수정 |
| 코치 이름이 default로 보임 | `ux.coach.naming_mode = "fixed"` 또는 globalState 비어있음 | 명령 팔레트에서 "HypeProof Chat: 코치 이름 다시 짓기" |
| Suggestion chips 안 보임 | `ux.suggestions.initial` 빈 배열 | profile 채움 |
| 응답 톤이 안 맞음 | system prompt + coach personality 충돌 | system prompt 우선; 충돌 시 prompt에서 명시 |
