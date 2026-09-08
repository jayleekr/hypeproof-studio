import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
test("real SDK Write denial is not an execution or human asset gain", async () => {
  test.skip(process.env.HPS_NATIVE_LIVE !== "1");
  test.setTimeout(180000);
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코치" },
    requireWriteApproval: true,
  });
  const output = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const chat = await chatFrame(ctx.win),
      input = chat.locator(".hps-input textarea").first();
    await input.fill(
      "합성 도구 거절 테스트야. 현재 작업 폴더에 denied.md라는 파일을 Write 도구로 실제 저장하려고 해줘. 내용은 테스트 한 줄이야. 나는 승인 창에서 거절할 것이니 거절되면 다른 도구로 우회하거나 재시도하지 말고 실제 저장되지 않았다고 설명해줘. 셸과 브라우저는 쓰지 마.",
    );
    await input.press("Enter");
    await expect(chat.locator(".hps-btn-stop")).toBeVisible();
    const dialog = ctx.win
      .locator(".monaco-dialog-box")
      .filter({ hasText: "코치가 파일을 저장하려고 해요" });
    await expect(dialog).toBeVisible({ timeout: 90000 });
    await ctx.win.screenshot({ path: join(output, "denial-dialog.png") });
    await dialog
      .locator(".monaco-button")
      .filter({ hasText: /^(Cancel|취소)$/ })
      .click();
    await expect(chat.locator(".hps-btn-stop")).toHaveCount(0, {
      timeout: 60000,
    });
    expect(existsSync(join(ctx.wsDir, "denied.md"))).toBe(false);
    const panel = chat.locator(".hps-native-observation");
    await panel.locator("summary").first().click();
    await panel.getByRole("button", { name: "이 작업의 기록 확인" }).click();
    await expect(panel).toContainText("denied");
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "관찰 받기", exact: true }).click();
    await expect(panel.locator("article")).toHaveCount(7, { timeout: 70000 });
    const batch = JSON.parse(
      readFileSync(join(output, "observation-input.json"), "utf8"),
    );
    expect(
      batch.events.some(
        (e: { kind: string; outcome: string; actor: string }) =>
          e.kind === "approval" && e.outcome === "denied" && e.actor === "user",
      ),
    ).toBe(true);
    expect(
      batch.events.some((e: { kind: string }) => e.kind === "artifact"),
    ).toBe(false);
    writeFileSync(
      join(output, "denial-transcript.txt"),
      await chat.locator(".hps-messages").innerText(),
    );
    await ctx.win.screenshot({ path: join(output, "denied.png") });
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify({
        mode: "actual Electron and API; synthetic driver",
        denial: "PASS",
        file_absent: true,
        human_validation: "NOT_RUN",
      }),
    );
  } finally {
    await closeApp(ctx);
  }
});
