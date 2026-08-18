#!/usr/bin/env node
/**
 * 같은 프로필·같은 대화로 두 프로바이더를 나란히 재는 하네스.
 *
 * 벤치마크 점수를 내려는 게 아니다. 묻는 것은 하나다 —
 * **이 수업(프로필)에서 이 모델을 쓸 수 있나.**
 * 그래서 벤치마크 문항이 아니라 실제 참가자가 할 법한 말을 넣는다.
 *
 * 왜 있나 (hypeprooflab#545, 2026-08-18):
 *   GLM-5.2 가 단가상 Sonnet 보다 싸서 아이들 수업을 옮기려 했는데, 실제로 재보니
 *   막연한 요청에 되묻지 않고 **코드를 쏟았고**, 검증법을 물었을 때 **시스템 프롬프트의
 *   스켈레톤 라이브러리를 그대로 출력**했다. 그 수업이 가르치는 것이 "또렷하게 요청하기"와
 *   "직접 검증하기" 인데 코치가 대신 다 해버리면 수업이 성립하지 않는다.
 *   단가만 보고 옮겼으면 수업 날 알았을 것이다.
 *
 * 비용도 단가로 추정하지 마라. 같은 실측에서 총비용 차이는 7% 였다 —
 * GLM 이 출력을 훨씬 많이 뱉어서 단가 이득을 스스로 까먹었다.
 *
 * 사용법:
 *   GLM_API_KEY=... HYPE_ANTHROPIC_KEY=... \
 *     node worker/scripts/compare-providers.mjs [프로필-id] [케이스.json]
 *
 * 케이스 파일을 주지 않으면 아래 기본 4장면을 쓴다. 프로필을 바꾸면 그 수업의
 * 시스템 프롬프트로 잰다 — **프로필마다 답이 다르므로 옮길 프로필로 직접 재라.**
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "..", "src", "prompts");

const profileId = process.argv[2] ?? "sk-biopharm-kids-2026-grade-5-6-s1";
const casesPath = process.argv[3];

// 실제 참가자가 할 법한 네 장면. 잘 되는 경우가 아니라 **깨지기 쉬운 경우**를 고른다.
const DEFAULT_CASES = [
  { id: "첫인사", text: "안녕" },
  { id: "막연한요청", text: "재밌는 게임 만들어줘" },
  { id: "떠넘김", text: "안돼 그냥 니가 다 해줘" },
  { id: "검증질문", text: "만들었는데 잘 되는지 어떻게 알아?" },
];

// 1M 토큰당 USD. 단가가 바뀌면 여기만 고친다.
const PRICE = {
  "glm-5.2": { in: 1.4, out: 4.4, cached: 0.26 },
  "claude-sonnet-4-6": { in: 2.0, out: 10.0, cached: 0.2 },
};

const TARGETS = {
  glm: { url: "https://api.z.ai/api/anthropic/v1/messages", model: "glm-5.2", envKey: "GLM_API_KEY" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-6", envKey: "HYPE_ANTHROPIC_KEY" },
};

const system = readFileSync(join(PROMPTS, `${profileId}.md`), "utf-8");
const cases = casesPath ? JSON.parse(readFileSync(casesPath, "utf-8")) : DEFAULT_CASES;

for (const [name, t] of Object.entries(TARGETS)) {
  if (!process.env[t.envKey]) {
    console.error(`${t.envKey} 가 없다 — ${name} 을 잴 수 없다. 두 쪽 다 있어야 비교가 된다.`);
    process.exit(2);
  }
}

async function ask(target, userText) {
  const t = TARGETS[target];
  const started = Date.now();
  const res = await fetch(t.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env[t.envKey],
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: t.model,
      max_tokens: 500,
      // 캐시 지시를 양쪽 다 넣는다 — GLM 은 이게 없으면 캐시가 아예 안 걸린다.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    }),
  });
  const ms = Date.now() - started;
  const json = await res.json();
  if (!res.ok) return { model: t.model, ms, error: `${res.status} ${JSON.stringify(json).slice(0, 200)}` };

  const u = json.usage ?? {};
  const p = PRICE[t.model] ?? { in: 0, out: 0, cached: 0 };
  return {
    model: t.model, ms, usage: u,
    text: (json.content ?? []).map((b) => b.text ?? "").join("").trim(),
    cost: ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out
           + (u.cache_read_input_tokens ?? 0) * p.cached) / 1e6,
  };
}

const totals = {};
console.log(`프로필: ${profileId} · 케이스 ${cases.length}개\n`);

for (const c of cases) {
  const names = Object.keys(TARGETS);
  const results = await Promise.all(names.map((n) => ask(n, c.text)));
  console.log("=".repeat(78));
  console.log(`[${c.id}] 사용자: ${c.text}`);
  console.log("=".repeat(78));
  for (const [i, r] of results.entries()) {
    const label = names[i];
    if (r.error) { console.log(`\n--- ${label}: ERROR ${r.error}`); continue; }
    totals[label] ??= { cost: 0, ms: 0, n: 0 };
    totals[label].cost += r.cost;
    totals[label].ms += r.ms;
    totals[label].n += 1;
    console.log(`\n--- ${label} (${r.model}) · ${r.ms}ms · in ${r.usage.input_tokens}` +
                `/cache ${r.usage.cache_read_input_tokens ?? 0} out ${r.usage.output_tokens}` +
                ` · $${r.cost.toFixed(5)}`);
    console.log(r.text.split("\n").slice(0, 14).join("\n"));
  }
  console.log();
}

console.log("=".repeat(78));
console.log("합계");
for (const [label, t] of Object.entries(totals)) {
  console.log(`  ${label.padEnd(10)} $${t.cost.toFixed(5)} · 평균 ${Math.round(t.ms / t.n)}ms`);
}
console.log("\n숫자만 보지 마라. **응답 내용이 그 수업의 설계를 지키는지**가 판단 기준이다.");
