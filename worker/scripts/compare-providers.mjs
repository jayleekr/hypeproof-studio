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
 * ## 케이스 포맷
 *
 * 단일턴 (짧은 형태):
 *     [{ "id": "첫인사", "text": "안녕" }]
 *
 * 멀티턴 — **"여기만 바꿔줘" 같은 수정 요청은 이 형태로만 잴 수 있다.**
 * 전체를 다시 뱉는지 그 부분만 고치는지가 비용과 품질을 가른다 (hypeprooflab#549):
 *     [{ "id": "부분수정", "turns": [
 *          { "user": "이 화면처럼 만들어줘", "images": ["./target.png"] },
 *          { "user": "헤더 색만 남색으로 바꿔줘" }
 *        ] }]
 *
 * 이미지는 로컬 경로다. `input.image_paste: true` 인 프로필(copyclone 등)은 스크린샷이
 * **전제**라, 텍스트만으로 재면 실제 수업과 다른 조건을 재게 된다.
 *
 * ## 실행
 *
 *     # 직접 모드 — 로컬에 두 벤더 키가 있을 때
 *     GLM_API_KEY=... HYPE_ANTHROPIC_KEY=... \
 *       node worker/scripts/compare-providers.mjs <프로필-id> [케이스.json]
 *
 *     # 워커 모드 — raw 키를 로컬에 두지 않고 배포된 워커를 거친다.
 *     # 키는 워커 시크릿 뒤에 있고, 이쪽은 코호트 토큰만 있으면 된다.
 *     WORKER_URL=https://api.hypeproof-ai.xyz \
 *     WORKER_TOKEN_A=<프로필A 토큰> WORKER_TOKEN_B=<프로필B 토큰> \
 *       node worker/scripts/compare-providers.mjs --via-worker [케이스.json]
 *
 * 워커 모드는 **프로필 두 개**를 비교한다 (하나는 `model.provider: "glm"` 을 핀한 것).
 * 벤더를 직접 고르는 게 아니라 "이 프로필 대 저 프로필" 이므로, 두 프로필이
 * provider 말고는 같아야 결과가 의미를 갖는다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "..", "src", "prompts");

const argv = process.argv.slice(2);
const viaWorker = argv.includes("--via-worker");
const positional = argv.filter((a) => !a.startsWith("--"));

// 1M 토큰당 USD. 단가가 바뀌면 여기만 고친다.
const PRICE = {
  "glm-5.2": { in: 1.4, out: 4.4, cached: 0.26 },
  "claude-sonnet-4-6": { in: 2.0, out: 10.0, cached: 0.2 },
};

const DEFAULT_CASES = [
  { id: "첫인사", text: "안녕" },
  { id: "막연한요청", text: "재밌는 게임 만들어줘" },
  { id: "떠넘김", text: "안돼 그냥 니가 다 해줘" },
  { id: "검증질문", text: "만들었는데 잘 되는지 어떻게 알아?" },
];

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** 케이스를 턴 배열로 정규화한다. 단일턴 형태를 계속 받는다. */
function toTurns(c) {
  if (Array.isArray(c.turns)) return c.turns;
  return [{ user: c.text, images: c.images }];
}

/** 로컬 이미지를 Anthropic content 블록으로. 프로필이 스크린샷을 전제하면 이게 조건이다. */
function imageBlock(path) {
  const ext = extname(path).toLowerCase();
  const media_type = MIME[ext];
  if (!media_type) throw new Error(`지원하지 않는 이미지 형식: ${path} (${Object.keys(MIME).join(", ")})`);
  return {
    type: "image",
    source: { type: "base64", media_type, data: readFileSync(path).toString("base64") },
  };
}

function userContent(turn, forWorker) {
  if (!turn.images?.length) return turn.user;
  if (forWorker) {
    // OpenAI 스키마 (워커의 /v1/chat 입력)
    return [
      { type: "text", text: turn.user },
      ...turn.images.map((p) => ({
        type: "image_url",
        image_url: { url: `data:${MIME[extname(p).toLowerCase()]};base64,${readFileSync(p).toString("base64")}` },
      })),
    ];
  }
  return [{ type: "text", text: turn.user }, ...turn.images.map(imageBlock)];
}

// ── 직접 모드 ────────────────────────────────────────────────────────────────

const DIRECT = {
  glm: { url: "https://api.z.ai/api/anthropic/v1/messages", model: "glm-5.2", envKey: "GLM_API_KEY" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-6", envKey: "HYPE_ANTHROPIC_KEY" },
};

async function runDirect(target, turns, system) {
  const t = DIRECT[target];
  const messages = [];
  const perTurn = [];

  for (const turn of turns) {
    messages.push({ role: "user", content: userContent(turn, false) });
    const started = Date.now();
    const res = await fetch(t.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env[t.envKey], "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: t.model,
        max_tokens: 1500,
        // 캐시 지시를 양쪽 다 넣는다 — GLM 은 이게 없으면 캐시가 아예 안 걸려 비용 비교가 왜곡된다.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });
    const ms = Date.now() - started;
    const json = await res.json();
    if (!res.ok) return { model: t.model, error: `${res.status} ${JSON.stringify(json).slice(0, 200)}`, perTurn };

    const text = (json.content ?? []).map((b) => b.text ?? "").join("").trim();
    messages.push({ role: "assistant", content: text });
    perTurn.push({ ms, usage: json.usage ?? {}, text });
  }
  return { model: t.model, perTurn };
}

// ── 워커 모드 ────────────────────────────────────────────────────────────────
//
// 벤더 키가 로컬에 없어도 된다. 워커가 시크릿을 들고 있고, 어느 상류로 나갈지는
// **프로필의 provider 핀**이 정한다. 그래서 여기서는 토큰 두 개(=프로필 두 개)를 비교한다.

async function runWorker(tokenEnv, turns) {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const token = process.env[tokenEnv];
  const messages = [];
  const perTurn = [];

  for (const turn of turns) {
    messages.push({ role: "user", content: userContent(turn, true) });
    const started = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "hypeproof-default", stream: false, messages }),
    });
    const ms = Date.now() - started;
    const json = await res.json();
    if (!res.ok) return { model: tokenEnv, error: `${res.status} ${JSON.stringify(json).slice(0, 200)}`, perTurn };

    const text = json.choices?.[0]?.message?.content ?? "";
    messages.push({ role: "assistant", content: text });
    // 워커는 OpenAI 스키마로 답하므로 usage 이름이 다르다. 비용은 워커 쪽 usage_log 가
    // 정본이고 여기서는 토큰 수만 참고로 찍는다 — 모델 id 를 모르면 단가를 못 곱한다.
    perTurn.push({ ms, usage: json.usage ?? {}, text, model: json.model });
  }
  return { model: perTurn[0]?.model ?? tokenEnv, perTurn };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

let system = "";
let targets;

if (viaWorker) {
  for (const k of ["WORKER_URL", "WORKER_TOKEN_A", "WORKER_TOKEN_B"]) {
    if (!process.env[k]) { console.error(`${k} 가 없다 — 워커 모드는 셋 다 필요하다.`); process.exit(2); }
  }
  targets = [["A", (turns) => runWorker("WORKER_TOKEN_A", turns)], ["B", (turns) => runWorker("WORKER_TOKEN_B", turns)]];
} else {
  const profileId = positional[0] ?? "sk-biopharm-kids-2026-grade-5-6-s1";
  system = readFileSync(join(PROMPTS, `${profileId}.md`), "utf-8");
  for (const t of Object.values(DIRECT)) {
    if (!process.env[t.envKey]) { console.error(`${t.envKey} 가 없다 — 두 쪽 다 있어야 비교가 된다. (--via-worker 도 있다)`); process.exit(2); }
  }
  targets = Object.keys(DIRECT).map((n) => [n, (turns) => runDirect(n, turns, system)]);
  console.log(`프로필: ${profileId}`);
}

const casesPath = viaWorker ? positional[0] : positional[1];
const cases = casesPath ? JSON.parse(readFileSync(casesPath, "utf-8")) : DEFAULT_CASES;
console.log(`모드: ${viaWorker ? "워커 (raw 키 없음)" : "직접"} · 케이스 ${cases.length}개\n`);

const totals = {};

for (const c of cases) {
  const turns = toTurns(c);
  const results = await Promise.all(targets.map(([, run]) => run(turns)));

  console.log("=".repeat(78));
  console.log(`[${c.id}] ${turns.length}턴` + (turns.some((t) => t.images?.length) ? " · 이미지 포함" : ""));
  console.log("=".repeat(78));

  for (const [i, r] of results.entries()) {
    const label = targets[i][0];
    if (r.error) { console.log(`\n--- ${label}: ERROR ${r.error}`); continue; }

    const p = PRICE[r.model];
    let cost = 0;
    totals[label] ??= { cost: 0, ms: 0, out: 0, n: 0 };

    for (const [ti, t] of r.perTurn.entries()) {
      const u = t.usage;
      const inTok = u.input_tokens ?? u.prompt_tokens ?? 0;
      const outTok = u.output_tokens ?? u.completion_tokens ?? 0;
      const cached = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      const turnCost = p ? (inTok * p.in + outTok * p.out + cached * p.cached) / 1e6 : 0;
      cost += turnCost;
      totals[label].out += outTok;

      console.log(`\n--- ${label} (${r.model}) 턴${ti + 1} · ${t.ms}ms · in ${inTok}/cache ${cached} out ${outTok}` +
                  (p ? ` · $${turnCost.toFixed(5)}` : " · (단가 미상)"));
      console.log(t.text.split("\n").slice(0, 14).join("\n"));
    }
    totals[label].cost += cost;
    totals[label].ms += r.perTurn.reduce((a, t) => a + t.ms, 0);
    totals[label].n += r.perTurn.length;
  }
  console.log();
}

console.log("=".repeat(78));
console.log("합계");
for (const [label, t] of Object.entries(totals)) {
  console.log(`  ${label.padEnd(10)} ${t.cost ? "$" + t.cost.toFixed(5) : "(단가 미상)"}` +
              ` · 출력 ${t.out} 토큰 · 평균 ${Math.round(t.ms / t.n)}ms/턴`);
}
console.log("\n숫자만 보지 마라. **응답 내용이 그 수업의 설계를 지키는지**가 판단 기준이다.");
console.log("특히 멀티턴에서는 '수정 요청에 전체를 다시 뱉는가' 를 출력 토큰으로 확인하라.");
