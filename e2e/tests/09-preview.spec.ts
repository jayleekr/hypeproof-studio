// REQ-D1–D6 preview suite (#90).
//
// Strategy: pre-seed chat history via the hps-test-state.json backdoor so a
// canned assistant turn with HTML already exists. That lets us exercise the
// preview path (▶Run, sandbox, panel reuse, save-to-workspace, previewReady
// handshake) without depending on a live LLM round-trip.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AppContext,
  closeApp,
  launchApp,
  openChatContainer,
  previewFrame,
  runCommand,
} from "../fixtures/app";

const CANNED_GAME = `<!doctype html>
<html><head><meta charset="utf-8"><title>preview-test</title></head>
<body style="background:#1b1b2a;color:#fff;font-family:sans-serif">
<h1 id="preview-marker">REQ-D preview test game</h1>
<script>document.title="preview-test-loaded";</script>
</body></html>`;

const CANNED_ASSISTANT_TURN = {
  id: "test-asst-1",
  role: "assistant" as const,
  content: `Here's your game:\n\n\`\`\`html\n${CANNED_GAME}\n\`\`\``,
  createdAt: Date.now(),
};

const CANNED_USER_TURN = {
  id: "test-user-1",
  role: "user" as const,
  content: "게임 만들어줘",
  createdAt: Date.now() - 1000,
};

let ctx: AppContext;

test.afterEach(async () => {
  if (ctx) await closeApp(ctx);
});

test("REQ-D1 + REQ-D3 + REQ-D6: Run Last Code opens preview with sandboxed iframe", async () => {
  ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디", personality: "" },
    preseedHistory: [CANNED_USER_TURN, CANNED_ASSISTANT_TURN],
  });

  await openChatContainer(ctx.win);
  // Allow history to hydrate
  await ctx.win.waitForTimeout(1000);

  // REQ-D1: Run Last Code in Preview
  await runCommand(ctx.win, "HypeProof Chat: Run Last Code in Preview");

  // REQ-D6: previewReady handshake fires + queued HTML flushes
  const frame = await previewFrame(ctx.win);
  // The marker comes from inside the SANDBOXED iframe (srcdoc) — drill in.
  const iframe = frame.locator("#frame");
  await expect(iframe).toBeAttached({ timeout: 10_000 });

  // REQ-D3: sandbox attribute matches the locked-down posture
  const sandbox = await iframe.getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).toContain("allow-pointer-lock");
  expect(sandbox).toContain("allow-modals");
  expect(sandbox).not.toContain("allow-same-origin");
  expect(sandbox).not.toContain("allow-top-navigation");
  expect(sandbox).not.toContain("allow-popups");

  // referrerpolicy = no-referrer (locked down)
  const referrerPolicy = await iframe.getAttribute("referrerpolicy");
  expect(referrerPolicy).toBe("no-referrer");

  // Visible (not hidden by the placeholder branch)
  await expect(iframe).toHaveCSS("display", "block", { timeout: 5_000 });
});

test("REQ-D4: second Run reuses the existing preview panel (no second WebviewPanel)", async () => {
  ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디" },
    preseedHistory: [CANNED_USER_TURN, CANNED_ASSISTANT_TURN],
  });

  await openChatContainer(ctx.win);
  await ctx.win.waitForTimeout(1000);

  // First run — opens preview
  await runCommand(ctx.win, "HypeProof Chat: Run Last Code in Preview");
  await previewFrame(ctx.win); // wait for attach
  await ctx.win.waitForTimeout(800);

  // Count webview iframes before second run
  const beforeCount = await ctx.win.locator("iframe.webview.ready").count();
  expect(beforeCount).toBeGreaterThanOrEqual(2); // chat + preview at minimum

  // Second run — must reuse the panel, not spawn a new one
  await runCommand(ctx.win, "HypeProof Chat: Run Last Code in Preview");
  await ctx.win.waitForTimeout(1500);

  const afterCount = await ctx.win.locator("iframe.webview.ready").count();
  // The webview-host iframe count should NOT grow. Note: VS Code is allowed
  // to lazy-tear-down hidden webviews, so we assert "not greater than", not
  // strict equality.
  expect(afterCount).toBeLessThanOrEqual(beforeCount);
});

test("REQ-D5: saved game lands at workspaceFolder/index.html", async () => {
  ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디" },
    preseedHistory: [CANNED_USER_TURN, CANNED_ASSISTANT_TURN],
  });

  await openChatContainer(ctx.win);
  await ctx.win.waitForTimeout(1000);

  // Send a "show" message so the isShowIntent shortcut fires → preview opens
  // AND saveGameToWorkspace runs. This exercises the same code path as the
  // auto-reveal during streaming (REQ-D2) but without needing the LLM.
  const chat = await import("../fixtures/app").then((m) => m.chatFrame(ctx.win));
  const input = chat.locator("textarea, input[type='text']").first();
  await input.fill("보여줘");
  await ctx.win.keyboard.press("Enter");

  // Wait for index.html to appear in the workspace
  const indexPath = path.join(ctx.wsDir, "index.html");
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf8");
      if (content.includes("REQ-D preview test game")) break;
    }
    await ctx.win.waitForTimeout(300);
  }

  expect(fs.existsSync(indexPath), `index.html should exist at ${indexPath}`).toBe(true);
  const content = fs.readFileSync(indexPath, "utf8");
  expect(content).toContain("REQ-D preview test game");
  // Sanity: it's the canned HTML, not the chat-extension's placeholder
  expect(content).toContain("<!doctype html>");
});
