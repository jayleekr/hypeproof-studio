// REQ-C3 history persistence after panel reload (#92).
//
// We use the hps-test-state.json history backdoor to pre-seed turns, then
// open the chat panel and assert they appear. For the reload case, we close
// and re-launch the app pointing at the SAME user-data-dir + workspace, so
// workspaceState (sqlite-backed) survives. For the workspace-isolation case,
// we launch a fresh user-data-dir + different wsDir and assert no history
// leaks across.
//
// The 200-turn HISTORY_MAX clamp is tested via clampHistory unit
// (extensions/hypeproof-chat/test/show-intent.smoke.mjs) — appending 1 more
// turn from e2e would need an LLM round-trip, too flaky.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";
import { chatFrame, openChatContainer, type SeedHistoryTurn } from "../fixtures/app";

interface ReusableCtx {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
  wsDir: string;
}

function makeTurns(n: number): SeedHistoryTurn[] {
  const base = Date.now() - n * 1000;
  return Array.from({ length: n }, (_, i) => ({
    id: `seed-${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: i % 2 === 0 ? `질문 ${i / 2 + 1}` : `답변 ${(i - 1) / 2 + 1}`,
    createdAt: base + i * 1000,
  }));
}

async function launchAt(opts: {
  userDataDir?: string;
  wsDir?: string;
  seedHistory?: SeedHistoryTurn[];
}): Promise<ReusableCtx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-hist-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });

  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify({
      "hypeproofChat.proxyUrl": "http://localhost:8787/v1",
      "workbench.startupEditor": "none",
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
    }),
  );

  const testState: Record<string, unknown> = {
    token,
    coach: { name: "코디", personality: "" },
  };
  if (opts.seedHistory) testState.history = opts.seedHistory;
  fs.writeFileSync(path.join(userDir, "hps-test-state.json"), JSON.stringify(testState));

  const wsDir = opts.wsDir ?? path.join(userDataDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const app = await electron.launch({
    executablePath: APP_BINARY,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      "--disable-workspace-trust",
      "--password-store=basic",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      wsDir,
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HPS_TEST_TOKEN: token,
      HPS_TEST_COACH_NAME: "코디",
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });

  return { app, win, userDataDir, wsDir };
}

async function teardown(ctx: ReusableCtx, removeUserData = true) {
  try { await ctx.app.close(); } catch { /* ignore */ }
  if (removeUserData) {
    try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function visibleMessages(win: Page): Promise<string[]> {
  const frame = await chatFrame(win);
  await frame.locator("[data-role='user'], [data-role='assistant'], .message").first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  // The webview renders messages — be tolerant about exact DOM. Capture all
  // text and filter by what we seeded.
  const text = (await frame.locator("body").innerText().catch(() => "")) ?? "";
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

test("REQ-C3: seeded history visible on first open (3 turns each side)", async () => {
  const seed = makeTurns(6);
  const ctx = await launchAt({ seedHistory: seed });
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(1500); // hydration
    const visible = await visibleMessages(ctx.win);
    const joined = visible.join("\n");
    for (let i = 1; i <= 3; i++) {
      expect(joined).toContain(`질문 ${i}`);
      expect(joined).toContain(`답변 ${i}`);
    }
  } finally {
    await teardown(ctx);
  }
});

test("REQ-C3: history survives close/reopen of the same workspace", async () => {
  const seed = makeTurns(6);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-hist-keep-"));
  const wsDir = path.join(tmpDir, "ws");

  // 1) First launch with seed
  let ctx = await launchAt({ userDataDir: tmpDir, wsDir, seedHistory: seed });
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(1500);
    const v1 = (await visibleMessages(ctx.win)).join("\n");
    expect(v1).toContain("질문 1");
  } finally {
    await teardown(ctx, false); // keep user-data-dir!
  }

  // 2) Re-launch SAME user-data-dir + wsDir. No seed this time — the prior
  //    workspaceState should still hold the 6 turns.
  // Clear the test-state JSON so the backdoor doesn't re-seed.
  fs.writeFileSync(
    path.join(tmpDir, "User", "hps-test-state.json"),
    JSON.stringify({
      token: fs.readFileSync(TOKEN_FILE, "utf8").trim(),
      coach: { name: "코디", personality: "" },
    }),
  );

  ctx = await launchAt({ userDataDir: tmpDir, wsDir }); // no seedHistory
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(1500);
    const v2 = (await visibleMessages(ctx.win)).join("\n");
    for (let i = 1; i <= 3; i++) {
      expect(v2).toContain(`질문 ${i}`);
      expect(v2).toContain(`답변 ${i}`);
    }
  } finally {
    await teardown(ctx);
  }
});

test("REQ-C3: fresh workspace has empty history (no leak across workspaces)", async () => {
  // Launch A with seeded history, then launch B with a different user-data-dir
  // and confirm B sees no seeded turns.
  const a = await launchAt({ seedHistory: makeTurns(4) });
  await teardown(a);

  // B: fresh user-data-dir, no seed
  const b = await launchAt({});
  try {
    await openChatContainer(b.win);
    await b.win.waitForTimeout(1500);
    const visible = (await visibleMessages(b.win)).join("\n");
    expect(visible).not.toContain("질문 1");
    expect(visible).not.toContain("답변 1");
  } finally {
    await teardown(b);
  }
});
