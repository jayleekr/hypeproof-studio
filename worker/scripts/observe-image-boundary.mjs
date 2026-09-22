// #811 — observe the image boundary on a RUNNING worker, not a mock.
//
// The unit and integration suites already pin this behaviour, but both run the
// route inside the test harness. This script drives a live `wrangler dev` the
// way the Agent SDK CLI does, and reads the evidence off the wire:
//
//   1. a stub Anthropic upstream records the body the WORKER actually sent
//   2. the worker's own `x-hps-images-filtered` response header is read back
//
// So the claim being checked is "the participant's image did not leave the
// worker", not "a function returned the right array".
//
// ── Why a stub upstream ─────────────────────────────────────────────────────
//
// The route needs ANTHROPIC_API_KEY set or it refuses before the filter runs,
// and a real upstream call would spend real allowance to prove a local point.
// `env.ANTHROPIC_PROXY_URL` already exists for the sediment indirection
// (worker/src/lib/anthropic.ts), so pointing it at this stub is the supported
// way to see the outbound body — no new production code path.
//
// ── Run ─────────────────────────────────────────────────────────────────────
//
//   cd worker
//   npx wrangler dev --local --port 8787 \
//     --var ANTHROPIC_PROXY_URL:http://127.0.0.1:8899/v1/messages
//   # ...then, with a student token for an agent-sdk child cohort:
//   node scripts/observe-image-boundary.mjs --token "$HPS_TOKEN"
//
// Exits non-zero when an assertion fails. Every assertion names what it read.

import http from "node:http";
import process from "node:process";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const TOKEN = args.token ?? process.env.HPS_TOKEN;
const WORKER = (args.worker ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const UPSTREAM_PORT = Number(args["upstream-port"] ?? 8899);
const MODEL = args.model ?? "hypeproof-default";

if (!TOKEN) {
  console.error("usage: node scripts/observe-image-boundary.mjs --token <student token>");
  process.exit(2);
}

const PASTED = "PASTEDBYPARTICIPANT";
const SHOT = "COACHSCREENSHOT";

// ── stub upstream ───────────────────────────────────────────────────────────
const received = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_observe",
        type: "message",
        role: "assistant",
        model: "claude-observe",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
  });
});
await new Promise((r) => stub.listen(UPSTREAM_PORT, "127.0.0.1", r));

const fail = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) fail.push(label);
};

async function turn(label, messages) {
  received.length = 0;
  const res = await fetch(`${WORKER}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 256, messages }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    console.log(`\n[${label}] worker returned ${res.status}`);
    console.log(text.slice(0, 400));
    return { res, sent: null };
  }
  const sent = received[0]?.body ?? null;
  return { res, sent };
}

const img = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

console.log(`worker   ${WORKER}`);
console.log(`upstream stub on 127.0.0.1:${UPSTREAM_PORT}\n`);

// ── 1. PLANTED ANSWER — a pasted image and a coach screenshot in one turn ───
console.log("[1] 참가자가 붙인 이미지 + 코치 tool_result 스크린샷");
{
  const { res, sent } = await turn("planted", [
    { role: "user", content: [{ type: "text", text: "이것 좀 봐" }, img(PASTED)] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [img(SHOT)] }] },
  ]);
  if (sent) {
    check(!sent.includes(PASTED), "참가자 이미지가 상류로 가지 않았다", "upstream body에 없음");
    check(sent.includes(SHOT), "코치 스크린샷은 상류로 갔다", "브라우저 루프 무사");
    check(
      res.headers.get("x-hps-images-filtered") === "user_dropped=1",
      "제거가 헤더로 공지됐다",
      `x-hps-images-filtered: ${res.headers.get("x-hps-images-filtered")}`,
    );
  } else {
    check(false, "상류 요청을 관측했다", "worker가 200을 내지 않았다 — 위 응답 참조");
  }
}

// ── 2. CONTROL — 이미지 없는 턴은 조용하다 ─────────────────────────────────
console.log("\n[2] 대조군 — 이미지 없는 평범한 턴");
{
  const { res, sent } = await turn("control", [{ role: "user", content: "안녕 코치" }]);
  if (sent) {
    check(res.headers.get("x-hps-images-filtered") === null, "헤더가 붙지 않았다", "정상 턴은 조용하다");
    check(sent.includes("안녕 코치"), "본문은 그대로 상류에 도달했다");
  } else {
    check(false, "상류 요청을 관측했다", "worker가 200을 내지 않았다");
  }
}

// ── 3. CAPS — tool_result 안 상한은 걸리되 스크린샷은 남는다 ───────────────
console.log("\n[3] 상한 — tool_result 안 이미지 5장");
{
  const many = Array.from({ length: 5 }, (_, i) => img(`SHOT${i}`));
  const { res, sent } = await turn("caps", [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: many }] },
  ]);
  if (sent) {
    const kept = [0, 1, 2, 3, 4].filter((i) => sent.includes(`SHOT${i}`));
    check(kept.length === 4, "턴당 4장 상한이 걸렸다", `남은 것: ${kept.map((i) => "SHOT" + i).join(",")}`);
    check(
      res.headers.get("x-hps-images-filtered") === "tool_result_capped=1",
      "상한도 공지된다",
      `x-hps-images-filtered: ${res.headers.get("x-hps-images-filtered")}`,
    );
  } else {
    check(false, "상류 요청을 관측했다", "worker가 200을 내지 않았다");
  }
}

stub.close();
console.log(
  fail.length === 0
    ? "\n관측 결과: 모두 통과. 이것은 실행 중인 worker가 실제로 상류에 보낸 본문을 읽은 것이다."
    : `\n관측 결과: ${fail.length}건 실패 — ${fail.join(" · ")}`,
);
process.exit(fail.length === 0 ? 0 : 1);
