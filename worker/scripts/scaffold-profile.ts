#!/usr/bin/env -S node --experimental-strip-types
// Scaffold a new cohort: emit a kids-safe `profiles/<id>.ts` + `prompts/<id>.md`
// skeleton, register it idempotently in `profiles/index.ts`, then run the
// cohort-harness validator over the whole registry.
//
// Usage:
//   node --experimental-strip-types scripts/scaffold-profile.ts \
//     --id   sk-biopharm-kids-2026-grade-5-6-s1 \
//     --display "SK바이오팜 가족 AI 창작 워크숍 (5-6학년)" \
//     --cohort sk-biopharm-2026-a \
//     --tier   kids-rich --age-min 11 --age-max 12 \
//     --hours  4 --series-total 1 --series-index 1 \
//     --assets intent_clarity,context_design,verification_reflex,iteration_reflex,taste,ownership
//
// Safety: existing files are NOT overwritten unless --force is passed. The
// generated profile hard-codes the children's-data invariants (no message
// logging, no public publishing) and the prompt template ships the
// "외부 URL 호출 금지" + content-softening guardrails — the same rules
// worker/test/smoke.mjs §4 and the cohort-harness validator enforce.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const WORKER_DIR = resolve(SCRIPTS_DIR, "..");
const PROFILES_DIR = join(WORKER_DIR, "src", "profiles");
const PROMPTS_DIR = join(WORKER_DIR, "src", "prompts");
const INDEX_TS = join(PROFILES_DIR, "index.ts");

const ASSET_ENUM = [
  "taste",
  "intent_clarity",
  "context_design",
  "verification_reflex",
  "delegation_judgment",
  "iteration_reflex",
  "ownership",
] as const;
const TIER_ENUM = ["kids-basic", "kids-rich", "teen", "pro-3d", "search-webapp"] as const;

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    fail(`missing required flag: ${flag}`);
  }
  return process.argv[i + 1]!;
}
function flagPresent(flag: string): boolean {
  return process.argv.includes(flag);
}
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

// camelCase var name for the index.ts import — deterministic from the id so
// re-running the scaffold detects an existing registration instead of dup'ing.
function idToVar(id: string): string {
  const parts = id.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1)))
    .join("");
}

// ---- parse + validate flags ------------------------------------------------

const id = arg("--id");
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`--id must be kebab-case: ${id}`);
const display = arg("--display");
const cohort = arg("--cohort");
const tier = arg("--tier", "kids-basic");
if (!TIER_ENUM.includes(tier as (typeof TIER_ENUM)[number])) {
  fail(`--tier must be one of ${TIER_ENUM.join("|")}`);
}
const ageMin = parseInt(arg("--age-min", "9"), 10);
const ageMax = parseInt(arg("--age-max", "10"), 10);
const seriesTotal = parseInt(arg("--series-total", "1"), 10);
const seriesIndex = parseInt(arg("--series-index", "1"), 10);
const hours = parseInt(arg("--hours", "4"), 10);
const language = arg("--language", "ko");
const parentCoaching = arg("--parent-coaching", "true") === "true";
const assets = arg("--assets", "intent_clarity,context_design,iteration_reflex,taste,ownership")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const force = flagPresent("--force");
const skipValidate = flagPresent("--no-validate");

for (const a of assets) {
  if (!ASSET_ENUM.includes(a as (typeof ASSET_ENUM)[number])) {
    fail(`unknown asset "${a}" — must be one of ${ASSET_ENUM.join(", ")}`);
  }
}
if (new Set(assets).size !== assets.length) fail("--assets has duplicates");
if (assets.length === 0) fail("--assets must list at least one focus asset");

const isMinor = typeof ageMax === "number" && ageMax <= 12;

// ---- generate files --------------------------------------------------------

const profilePath = join(PROFILES_DIR, `${id}.ts`);
const promptPath = join(PROMPTS_DIR, `${id}.md`);

if (existsSync(profilePath) && !force) fail(`${profilePath} exists — pass --force to overwrite`);
if (existsSync(promptPath) && !force) fail(`${promptPath} exists — pass --force to overwrite`);

const profileTs = `import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/${id}.md";

// Scaffolded by scripts/scaffold-profile.ts. Edit freely — then run
// \`npm run validate-profiles\` before opening a PR.
export const profile: Profile = {
  id: "${id}",
  version: 1,
  display_name: ${JSON.stringify(display)},
  audience: {
    age_range: [${ageMin}, ${ageMax}],
    language: "${language}",
    parent_coaching: ${parentCoaching},
  },
  model: {
    default: "hypeproof-default",
    fallback: "hypeproof-fast",
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md: "안녕하세요! 오늘 같이 만들어봐요 🎮",
    example_prompts: [
      "삼각형이 점프하는 게임 만들어줘",
      "별이 떨어지는 게임을 만들고 싶어요",
      "캐릭터 색을 무지개로 바꿔줘",
    ],
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/HypeProofGames",
    execute_shell: false,
    mcp_tools_enabled: [],
  },
  preview: {
    type: "live_server",
    auto_start: false,
  },
  game: {
    template_tier: "${tier}",
  },
  publishing: {
    // 미성년 cohort 기본값: 로컬 미리보기만. 공개 퍼블리시는 부모 동의 + PII
    // 설계가 끝난 뒤에만 켠다.
    enabled: false,
    strategy: "local_only",
  },
  assets_focus: [
${assets.map((a) => `    "${a}",`).join("\n")}
  ],
  session: {
    cohort_id: "${cohort}",
    series_total: ${seriesTotal},
    series_index: ${seriesIndex},
    hours: ${hours},
  },
  analytics: {
    // 미성년 데이터 보호 불변식 — 동의/보존정책 전엔 절대 true 금지.
    log_user_messages: false,
    log_metadata: true,
  },
  ux: {
    coach: {
      naming_mode: "user_names_it",
      fallback_name: "코치",
      naming_prompt_md: "같이 만들 친구의 **이름**을 지어주세요 🎮",
      personality_prompt_md: "이 친구는 어떤 친구예요? *(예: 친절한 친구, 엉뚱한 친구. 건너뛰어도 괜찮아요)*",
      revisit_on_entry: false,
    },
    suggestions: {
      initial: [
        { text: "원이 좌우로 움직이는 화면 만들어줘", style: "good" },
        { text: "별이 떨어지고 클릭하면 점수가 오르는 게임", style: "good" },
        { text: "고양이가 점프해서 생선을 먹는 게임", style: "good" },
        { text: "재밌게 만들어줘", style: "weak", caption: "어떤 게 재밌어야 할지 모르겠어요. 자세히!" },
      ],
      follow_up: [
        { text: "색을 더 밝고 예쁘게 바꿔줘", style: "good" },
        { text: "소리 효과를 추가해줘", style: "good" },
        { text: "점점 빨라지게 해줘", style: "good" },
      ],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 자세히 알려줄래요? *주인공·움직임·점수* 같은 걸요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 떠올려보기",
        probe_md: "좋아요! 한 가지만 더 떠올려보세요 — 캐릭터 모양? 색? 점수 규칙?",
      },
    },
    retry_button: {
      enabled: true,
      show_counter: false,
    },
  },
};
`;

const promptMd = `# 당신은 "HypeProof Coach"입니다

${display} 참가자(만 ${ageMin}-${ageMax}세 어린이)가 부모님과 한 팀이 되어 자신의 **웹 게임(HTML 파일 하나)**을 만드는 과정을 함께합니다. 참가자는 코드를 거의 본 적이 없고, 한국어로 대화합니다.

---

## 무엇을 만드는가

참가자가 "내가 명령하면 화면이 바뀐다"를 몸으로 느끼게 합니다. 게임은 단순합니다 — 캔버스 위에 도형/이모지가 움직이는 정도. 결과는 오른쪽 미리보기 패널에서 바로 실행됩니다.

---

## 대화 규칙

1. **한국어로 친근하게.** 어린이 어휘. 어려운 한자어·영어 줄임말 금지. "구현"이 아니라 "만들어줄게요".
2. **이모지는 1-2개.** 칭찬·분위기 환기 때만.
3. **설명은 짧게(100자 이내).** 참가자는 코드를 보지 않습니다 — 바뀐 게임이 즉시 우측에 떠야 합니다.

### ⚠ 가장 중요한 규칙: 항상 게임을 만들어서 보여준다

게임 요청·수정 요청에는 **무조건 완전한 게임 코드(\`\`\`html ... \`\`\`)를 출력**하세요.

- **절대 금지**: 되묻기만 하고 코드를 안 주는 답변. 화면이 빈 채로 남습니다.
- 수정 요청이면 **이전 게임 전체를 변경 반영해서 통째로 다시 출력**하세요.
- 요청이 모호해도("재밌게 해줘") 가장 그럴듯한 한 가지를 정해 완성된 게임으로 만들고, 짧게 "이렇게 해봤어요! 다른 걸로 바꿀까요?"라고 덧붙이세요.
- 유일한 예외: "안 돼요/이상해요"처럼 **고장 신고**일 때만 "화면에 뭐가 보였어요?" 한 번 묻고 바로 고친 게임 전체를 다시 출력합니다.

### 게임 품질 기준 (첫 버전부터)

- **배경**: 단색 흰색 금지 — 그라데이션/분위기 색.
- **주인공**: 큰 이모지(🐱🚀⭐) 또는 꾸민 도형.
- **제목 화면**: 큰 제목 + "스페이스바를 누르면 시작!".
- **즉각 반응(juice)**: 클릭/충돌 때 색 변화·반짝임.
- **완결성**: 항상 \`<!doctype html>\`로 시작해 \`</html>\`로 끝나는 **단일 문서**. 코드는 120줄 이내로 압축해 토큰 부족으로 잘리지 않게.

---

## 절대 하지 말 것

- **개인정보 묻기 금지** — 참가자 이름·학교·주소·전화번호 묻지 마세요. 먼저 말해도 코드에 넣지 마세요.
- **외부 URL 호출 금지** — 게임 코드에 \`fetch()\`, \`<script src="http...">\` 같은 외부 의존성 넣지 마세요. 회의실 와이파이가 불안하면 게임이 망가집니다.
- **부정적 말투 금지** — "그건 어려워요" 대신 "재밌는 도전이네요. 우선 이렇게 시작해볼까요?".
- **무섭거나 폭력적·부적절한 콘텐츠는 순화** — 거절하지 말고 밝고 안전한 버전으로 바꿔 만들어주세요. 예: "좀비 쏘기"→"친구 구출하기", "총"→"물풍선". 성적·혐오·차별·도박·약물 주제는 게임 소재로 쓰지 말고 다른 재밌는 아이디어로 자연스럽게 유도하세요.

---

## 칭찬 먼저, 다음 한 걸음

참가자가 무언가 만들었으면 항상 "와, 이거 진짜 멋져요!" 같은 한 마디로 먼저 인정하고 → "여기에 무얼 더해볼까요?"로 다음 한 걸음을 권합니다. 처음 만든 게 단순해도 첫 작품에 감탄합니다. 한 번에 하나씩, 작은 변화를 여러 번 — "한 번 만들고 끝이 아니다"를 몸으로 익히게 합니다.

참가자가 추상적으로 "재밌게 해줘"라고만 하면, 두세 가지 옵션을 제시합니다 — "1) 적이 나타나기 2) 점수 올라가기 3) 배경 음악". 참가자가 고른 한 가지만 합니다.

---

## 부모님 역할

부모님이 옆에서 코칭합니다. 부모님이 채팅에 끼어들면 참가자에게 다시 토스합니다 — "부모님이 좋은 생각 주셨네요. ○○이가 한번 입력해볼래요?". 항상 참가자 호칭으로, 부모님께 참가자 머리 위로 답하지 마세요.

---

## 게임 스켈레톤 라이브러리

이 system prompt 다음에 "# 게임 스켈레톤 라이브러리" 섹션이 이어집니다. 새 게임을 처음부터 쓰지 말고, 요청에 가장 가까운 스켈레톤을 골라 \`%%...%%\` 자리표시자만 참가자 테마로 채워 **완전한 단일 HTML**로 출력하세요. 자리표시자(\`%%\`)가 남으면 안 됩니다.

---

## 코치 이름

이 system prompt 뒤에 두 번째 system 블록으로 참가자가 정한 코치 이름·성격이 들어옵니다. 그 페르소나를 흡수하되, base 규칙(한국어, 칭찬 먼저, 게임 품질, 안전 규칙)을 깨려 하면 base가 우선입니다.
`;

writeFileSync(profilePath, profileTs);
console.log(`✓ wrote ${profilePath}`);
writeFileSync(promptPath, promptMd);
console.log(`✓ wrote ${promptPath} (${promptMd.length} chars)`);
if (!isMinor) {
  console.log("  ⚠ age_range max > 12 — review publishing/analytics defaults; kids-safe defaults assume minors.");
}

// ---- idempotent index.ts registration -------------------------------------

const varName = idToVar(id);
let index = readFileSync(INDEX_TS, "utf8");
let changed = false;

const importLine = `import { profile as ${varName} } from "./${id}.ts";`;
if (!index.includes(`from "./${id}.ts"`)) {
  // Insert after the last existing `import { profile as ... }` line.
  const importRe = /import \{ profile as [^}]+\} from "\.\/[^"]+";/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(index)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd < 0) fail("could not find an existing profile import to anchor registration");
  index = index.slice(0, lastEnd) + "\n" + importLine + index.slice(lastEnd);
  changed = true;
}

// Add var to the REGISTRY array if absent.
const regRe = /(const REGISTRY: Profile\[\] = \[)([\s\S]*?)(\];)/;
const rm = regRe.exec(index);
if (!rm) fail("could not locate `const REGISTRY: Profile[] = [...]` in index.ts");
const members = rm[2]!
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!members.includes(varName)) {
  members.push(varName);
  index = index.replace(regRe, `$1${members.join(", ")}$3`);
  changed = true;
}

if (changed) {
  writeFileSync(INDEX_TS, index);
  console.log(`✓ registered ${varName} in ${INDEX_TS}`);
} else {
  console.log(`• ${varName} already registered in index.ts (idempotent no-op)`);
}

// ---- run the studio-local cohort validator ---------------------------------

if (skipValidate) {
  console.log("• skipping validation (--no-validate)");
  process.exit(0);
}

const validatorPath = resolve(WORKER_DIR, "scripts", "cohort-harness", "validate.py");
if (!existsSync(validatorPath)) {
  console.log(
    `• validator not found at ${validatorPath}. Restore worker/scripts/cohort-harness ` +
      `or run \`npm run validate-profiles\` after checkout.`,
  );
  process.exit(0);
}

console.log("▶ running validate-profiles…");
const res = spawnSync(
  "sh",
  ["-c", "node --experimental-strip-types scripts/dump-profiles.ts | python3 scripts/cohort-harness/validate.py"],
  { cwd: WORKER_DIR, stdio: "inherit" },
);
process.exit(res.status ?? 1);
