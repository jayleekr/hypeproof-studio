// REQ-D1–D6 preview suite (#90).
//
// Strategy: pre-seed chat history via the hps-test-state.json backdoor so a
// canned assistant turn with HTML already exists. That lets us exercise the
// preview path (▶Run, sandbox, panel reuse, save-to-workspace, previewReady
// handshake) without depending on a live LLM round-trip.
//
// Two preview paths ship (`revealBuilt` in chatPanelProvider.ts). A cohort whose
// profile says `preview.type: "live_server"` (the dev-stack default, sk-biopharm)
// gets the workspace served on 127.0.0.1 in a native browser tab (REQ-N1); every
// other cohort, and a live server that fails to start, gets the sandboxed srcdoc
// webview (`#frame`). Until 2026-10-01 this spec only looked for `#frame`, so on a
// live-server cohort it measured a path the product never takes there and failed on
// the unchanged tree too (recon F1). Each check now finds which path opened and
// asserts that path's contract. REQ-D3 and REQ-D6 belong to the webview path;
// studio-requirements.md §N says REQ-N1 replaces REQ-D3 for live_server cohorts.
// Which path is expected is read from the served profile's `preview.type`, so a
// webview cohort that wrongly takes the live path (skipping REQ-D3/D6) fails.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import {
  type AppContext,
  closeApp,
  launchApp,
  openChatContainer,
  previewFrame,
  runCommand,
} from "../fixtures/app";
import { TOKEN_FILE } from "../fixtures/global-setup";

/** The canned game sets this title once its script runs; a browser tab is labelled by its page title. */
const LOADED_TITLE = "preview-test-loaded";
const liveTabs = (win: Page) => win.locator(".tabs-container .tab", { hasText: LOADED_TITLE });

/**
 * Which preview opened: a native browser tab showing the canned game (live_server,
 * REQ-N1) or the sandboxed webview iframe. Neither within the timeout fails the check.
 */
async function openedPreview(win: Page): Promise<"live" | "iframe"> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if ((await liveTabs(win).count()) > 0) return "live";
    const outer = win.locator("iframe.webview.ready");
    for (let i = 0; i < (await outer.count()); i++) {
      const inner = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      if ((await inner.locator("#frame").count().catch(() => 0)) > 0) return "iframe";
    }
    await win.waitForTimeout(250);
  }
  throw new Error(`no preview opened: neither a browser tab titled "${LOADED_TITLE}" nor a webview with #frame`);
}

/** The path the served profile picks: `preview.type: "live_server"` → live, anything else → iframe. */
async function expectedPreview(): Promise<"live" | "iframe"> {
  const proxy = process.env.HPS_E2E_PROXY_URL?.trim() || "http://localhost:8787/v1";
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const res = await fetch(`${proxy.replace(/\/$/, "")}/profile`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`profile not served (${res.status}): cannot tell which preview path is expected`);
  const profile = (await res.json()) as { preview?: { type?: unknown } };
  return profile.preview?.type === "live_server" ? "live" : "iframe";
}

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
  const opened = await openedPreview(ctx.win);
  expect(opened, "the preview path the served profile's preview.type picks").toBe(await expectedPreview());

  if (opened === "live") {
    // REQ-D1 on the live-server path: the canned game itself is what the tab shows
    // (its script ran and set the title), served from the saved workspace file.
    await expect(liveTabs(ctx.win)).toHaveCount(1);
    expect(fs.readFileSync(path.join(ctx.wsDir, "index.html"), "utf8")).toContain("REQ-D preview test game");
    test.info().annotations.push({ type: "path", description: "live_server: REQ-D3/D6 are the webview path's; REQ-N1 replaces REQ-D3 here" });
    return;
  }

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
  const opened = await openedPreview(ctx.win);
  expect(opened, "the preview path the served profile's preview.type picks").toBe(await expectedPreview());
  await ctx.win.waitForTimeout(800);

  if (opened === "live") {
    // The live-server path reuses its browser tab (startLivePreview: same URL → reload).
    await expect(liveTabs(ctx.win)).toHaveCount(1);
    await runCommand(ctx.win, "HypeProof Chat: Run Last Code in Preview");
    await ctx.win.waitForTimeout(1500);
    await expect(liveTabs(ctx.win)).toHaveCount(1);
    return;
  }

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
