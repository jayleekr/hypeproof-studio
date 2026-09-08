// #749 — 벤더 SDK 가 우리가 부르는 것을 실제로 내보내는지.
//
// 왜 이 파일이 따로 필요한가. browser-mcp / live-preview-url 스모크는
// `createSdkMcpServer` 와 `tool` 을 **가짜로 주입해서** 우리 코드를 검증한다.
// 그건 우리 배선을 재는 데는 맞지만, **진짜 SDK 가 그 이름을 아직 내보내는지는
// 한 번도 확인하지 않는다.** 벤더가 이름을 바꾸면 모든 테스트가 초록인 채로
// `hasFactory` 가 false 가 되고, 브라우저를 받은 코호트는 `console.warn` 한 줄만
// 남기고 **브라우저 없이** 돈다 — #476 이 만든 오진 3건과 같은 계열이고
// REQ-M30 이 금지하는 바로 그 상태(능력 상실이 안 보임)다.
//
// 그래서 여기서는 가짜를 쓰지 않는다. 설치된 패키지를 **실제로 import** 한다.
// 63ms 에 부작용 없이 로드되는 것을 확인하고 넣었다.
//
// Run: node --experimental-strip-types test/sdk-surface-drift.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ─── 진짜 SDK 를 로드한다 (가짜 주입 없음) ──────────────────────────────────
const sdk = await import("@anthropic-ai/claude-agent-sdk");

// ─── 1. 우리가 부르는 것이 실재하는가 ───────────────────────────────────────
{
  // `query` — 모든 턴의 진입점. 없으면 코치가 아예 안 돈다.
  assert.equal(typeof sdk.query, "function", "SDK 가 query 를 내보내지 않는다");

  // `createSdkMcpServer` + `tool` — 이 둘이 sdkCoach 의 `hasFactory` 게이트다.
  // 사라지면 실패가 아니라 **조용한 능력 상실**로 나타난다.
  assert.equal(typeof sdk.createSdkMcpServer, "function", "브라우저 MCP 등록이 조용히 꺼진다");
  assert.equal(typeof sdk.tool, "function", "브라우저 MCP 도구 정의가 조용히 꺼진다");
}

// ─── 2. 프로브가 없음과 있음을 구분하는가 (양성/음성 대조군) ────────────────
// 위 단언들은 프로브가 항상 "function" 을 돌려줘도 통과한다. 실재하지 않는
// 이름으로 한 번 재서, 이 검사가 실제로 무언가를 구분한다는 것을 보인다.
{
  assert.equal(
    typeof sdk.thisExportHasNeverExisted,
    "undefined",
    "없는 export 가 있다고 나온다 — 프로브가 아무것도 재지 못하고 있다",
  );
}

// ─── 3. zod 는 선언되지 않은 전이 의존성이다 ────────────────────────────────
// 브라우저 MCP 경로는 zod 를 요구하는데(`hasFactory && z`), 이 확장은 zod 를
// 직접 선언하지 않는다 — SDK 를 통해 딸려 들어온다(lockfile: dev). npm 트리가
// 바뀌어 사라지면 역시 조용한 능력 상실이다. 의존성 선언을 바꾸는 것은 별도
// 판단(#349 — prod dep 은 vscode-min-prepack 을 깨뜨린다)이라, 여기서는 사실이
// 바뀌는 순간 **알 수 있게만** 해 둔다.
{
  const zod = await import("zod");
  assert.equal(typeof zod.object, "function", "zod 가 사라지면 브라우저 MCP 가 조용히 꺼진다");

  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const declared = pkg.dependencies?.zod ?? pkg.devDependencies?.zod ?? null;
  if (declared === null) {
    // 실패가 아니라 기록이다. 선언하기로 결정하면 이 줄이 사라진다.
    console.log("  (참고: zod 는 직접 선언되지 않은 전이 의존성이다 — 브라우저 MCP 가 여기에 기댄다)");
  }
  // 어느 쪽이든 prod dependencies 에는 없어야 한다: 주입된 확장에는 node_modules
  // 가 없어서 prod dep 하나가 vscode-min-prepack 을 통째로 깨뜨린다 (#349).
  assert.equal(pkg.dependencies?.zod, undefined, "zod 를 prod dependency 로 두면 빌드가 깨진다 (#349)");
  assert.equal(
    pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"],
    undefined,
    "SDK 를 prod dependency 로 두면 빌드가 깨진다 (#349)",
  );
}

// ─── 4. 게이트가 여전히 그 두 이름을 본다 (드리프트 락) ─────────────────────
// SDK 가 이름을 유지해도 우리 게이트가 다른 이름을 보기 시작하면 위 단언들은
// 아무것도 지키지 못한다. 두 쪽을 묶어 둔다.
{
  const coach = readFileSync(join(here, "..", "src", "sdkCoach.ts"), "utf8");
  assert.match(
    coach,
    /typeof sdk\.createSdkMcpServer === "function" && typeof sdk\.tool === "function"/,
    "hasFactory 게이트가 이 테스트가 재는 두 이름을 본다",
  );
  // 그리고 그 게이트가 실패했을 때 조용하지 않아야 한다 — 로그 한 줄이라도 남는다.
  assert.match(coach, /browser MCP tools but the SDK\/zod factory is unavailable/, "게이트 실패가 로그로 남는다");
}

console.log("sdk-surface-drift smoke OK");
