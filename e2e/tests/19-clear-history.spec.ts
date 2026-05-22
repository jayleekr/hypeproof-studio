// REQ-C4 Clear conversation command (#89 epic).
//
// Seed history via the test backdoor → assert messages visible → run the
// HypeProof Chat: Clear Conversation command → assert messages gone +
// workspaceState cleared.

import { test, expect } from "@playwright/test";
import { chatFrame, closeApp, launchApp, runCommand, type SeedHistoryTurn } from "../fixtures/app";

const seed: SeedHistoryTurn[] = [
  { id: "h-u-1", role: "user", content: "테스트 메시지 1", createdAt: 1 },
  { id: "h-a-1", role: "assistant", content: "테스트 응답 1", createdAt: 2 },
  { id: "h-u-2", role: "user", content: "테스트 메시지 2", createdAt: 3 },
  { id: "h-a-2", role: "assistant", content: "테스트 응답 2", createdAt: 4 },
];

test("REQ-C4: Clear Conversation command empties the panel + workspaceState", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디" },
    preseedHistory: seed,
  });
  try {
    const cf = await chatFrame(ctx.win);

    // Wait for seeded history to render
    await ctx.win.waitForTimeout(1_500);
    await expect(cf.locator("body")).toContainText("테스트 메시지 1", { timeout: 10_000 });
    await expect(cf.locator("body")).toContainText("테스트 응답 2");

    // Run clear command
    await runCommand(ctx.win, "HypeProof Chat: Clear Conversation");

    // Messages should disappear; the empty-state greeting (welcome) takes over.
    // Poll because the command runs async and the postHistory[] arrives shortly.
    await expect.poll(
      async () => (await cf.locator("body").innerText().catch(() => "")) ?? "",
      { timeout: 10_000, intervals: [200, 200, 500, 500] },
    ).not.toContain("테스트 메시지 1");

    await expect(cf.locator("body")).not.toContainText("테스트 응답 2");
  } finally {
    await closeApp(ctx);
  }
});
