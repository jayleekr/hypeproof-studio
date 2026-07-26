// 작업 폴더를 헤더로 넘기는 경로 — 앱 없이, 밀리초.
//
// 왜 이 파일이 있나. 앱은 #428 이래 시스템 프롬프트에 `<env>` 블록으로 작업 폴더를
// 붙여 왔는데, 워커가 클라이언트 `system` 을 통째로 교체해서(주입 방지 설계) **세 번의
// 수정이 전부 무력**이었다. 코치는 SDK 경로에서 자기 작업 폴더를 한 번도 받은 적이
// 없고, 매 턴 `/app/workdir`·`/Users/workspace/`·`~/Desktop/HypeProof Studio/workspace/`
// 를 지어내다 실패하고 `pwd` 로 복구하느라 한 턴에 34~164초를 태웠다(2026-07-27 실측).
//
// 같은 실패가 반복되지 않게 하려면 **전달 자체를 검사**해야 한다. "함수가 올바른
// 문자열을 만든다"는 이미 통과하고 있었고 그게 아무것도 보장하지 않았다.
//
// 형식은 벤더 SDK 가 정한다 (bridge.mjs 실물 확인):
//   ANTHROPIC_CUSTOM_HEADERS 를 `\n` 으로 나누고 각 줄을 첫 `:` 에서 가른다.
// 따라서 값 안에 개행이 들어가면 그 줄부터 헤더가 깨진다 — 파일 목록이 정확히 그 위험이다.
//
// Run: node --experimental-strip-types test/workspace-header.smoke.mjs

import assert from "node:assert/strict";

const { buildSdkGatewayEnv } = await import("../src/sdkCoachHelpers.ts");

const base = { PATH: "/usr/bin", HOME: "/Users/student" };
const gw = (extra) =>
  buildSdkGatewayEnv(base, { proxyUrl: "https://api.hypeproof-ai.xyz/v1", token: "t", ...extra });

/** SDK(bridge.mjs)와 같은 방식으로 되파싱 — 우리가 만든 값이 실제로 읽히는지 본다. */
const parse = (raw) => {
  const out = {};
  for (const line of (raw ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i >= 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

// ─── 양성 대조군 — 경로가 SDK 파싱을 통과해 그대로 복원된다 ──────────────────
{
  const env = gw({ workspace: "/Users/student/HypeProofClinic" });
  const h = parse(env.ANTHROPIC_CUSTOM_HEADERS);
  assert.equal(decodeURIComponent(h["x-hps-workspace"]), "/Users/student/HypeProofClinic");
  console.log("✓ 양성 — 작업 폴더 경로가 헤더로 실려 원형 그대로 복원된다");
}

// ─── 한글 폴더명 — 인코딩 없이 넣으면 헤더가 던진다 ─────────────────────────
{
  const env = gw({ workspace: "/Users/학생/보아치과 홈페이지" });
  const raw = env.ANTHROPIC_CUSTOM_HEADERS;
  // 헤더 값은 바이트 안전해야 한다 — 비ASCII 가 남아 있으면 안 된다.
  assert.ok(!/[^\x00-\x7F]/.test(raw), "헤더 값에 비ASCII 가 남으면 안 된다");
  const h = parse(raw);
  assert.equal(decodeURIComponent(h["x-hps-workspace"]), "/Users/학생/보아치과 홈페이지");
  console.log("✓ 한글 폴더명 — 인코딩되어 실리고 복원된다");
}

// ─── 파일 목록 — 구분자가 헤더를 깨지 않아야 한다 (가장 위험한 지점) ────────
{
  const files = ["index.html", "shared.css", "sub/about.html"];
  const env = gw({ workspace: "/w", workspaceFiles: files });
  const raw = env.ANTHROPIC_CUSTOM_HEADERS;
  // 줄 수가 정확히 2 여야 한다 — 목록의 개행이 새 줄로 새면 헤더가 하나 더 생긴다.
  assert.equal(raw.split("\n").length, 2, `줄이 새면 안 된다:\n${raw}`);
  const h = parse(raw);
  assert.deepEqual(decodeURIComponent(h["x-hps-workspace-files"]).split("\n"), files);
  console.log("✓ 파일 목록 — 개행이 새지 않고 목록이 그대로 복원된다");
}

// ─── 음성 대조군 — 없으면 헤더를 만들지 않는다 ───────────────────────────────
{
  assert.equal(gw({}).ANTHROPIC_CUSTOM_HEADERS, undefined, "아무것도 없으면 헤더 없음");
  assert.equal(gw({ workspace: "   " }).ANTHROPIC_CUSTOM_HEADERS, undefined, "공백 경로는 무시");
  assert.equal(gw({ workspaceFiles: [] }).ANTHROPIC_CUSTOM_HEADERS, undefined, "빈 목록은 무시");
  console.log("✓ 음성 — 값이 없으면 빈 헤더를 만들지 않는다");
}

// ─── 기존 CUSTOM_HEADERS 를 지우지 않는다 ────────────────────────────────────
{
  const env = buildSdkGatewayEnv(
    { ...base, ANTHROPIC_CUSTOM_HEADERS: "x-existing: keep" },
    { proxyUrl: "https://x/v1", token: "t", workspace: "/w" },
  );
  const h = parse(env.ANTHROPIC_CUSTOM_HEADERS);
  assert.equal(h["x-existing"], "keep", "기존 헤더가 살아 있어야 한다");
  assert.equal(decodeURIComponent(h["x-hps-workspace"]), "/w");
  console.log("✓ 기존 ANTHROPIC_CUSTOM_HEADERS 와 공존한다");
}

// ─── 게이트웨이 라우팅은 그대로 (회귀 방지) ──────────────────────────────────
{
  const env = gw({ workspace: "/w" });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "t");
  assert.ok(env.ANTHROPIC_BASE_URL);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "로컬 API 키는 여전히 제거된다");
  console.log("✓ 게이트웨이 라우팅·키 스크럽 회귀 없음");
}

console.log("\n✓ workspace-header smoke 통과");
