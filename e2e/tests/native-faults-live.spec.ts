import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
async function fault(mode: string) {
  const token = readFileSync(process.env.HPS_E2E_TOKEN_FILE!, "utf8").trim();
  const r = await fetch("http://127.0.0.1:8787/__test/fault", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: mode,
  });
  expect(r.status).toBe(204);
}
for (const mode of ["401", "429", "503", "timeout", "old-service", "old-client"].filter(m=>!process.env.HPS_NATIVE_CASE||m===process.env.HPS_NATIVE_CASE))
  test("actual Studio handles synthetic gateway " + mode, async () => {
    test.setTimeout(90000);
    await fault(mode);
    const ctx = await launchApp({
      preseedToken: true,
      preseedCoach: { name: "코치" },
      sdkStallTimeoutMs: 8000,
    });
    try {
      const chat = await chatFrame(ctx.win);
      if (mode === "old-client") {
        await expect(chat.locator("body")).toContainText("이 앱 버전은 작업 관찰 화면을 지원하지 않습니다.");
        await expect(chat.locator(".hps-native-observation")).toHaveCount(0);
      } else if (mode === "old-service") {
        await expect(chat.locator("body")).toContainText(
          "현재 연결은 작업 관찰을 지원하지 않습니다.",
        );
        await expect(chat.locator(".hps-native-observation")).toHaveCount(0);
      } else {
        const input = chat.locator(".hps-input textarea").first();
        await input.fill("합성 오류 테스트. 요청 실패를 성공으로 설명하지 마.");
        await input.press("Enter");
        await expect(chat.locator(".hps-btn-stop")).toBeVisible();
        if (mode === "timeout") {
          await chat.locator(".hps-btn-stop").click();
        }
        await expect(chat.locator(".hps-btn-stop")).toHaveCount(0, {
          timeout: 35000,
        });
        if (mode !== "timeout")
          await expect(chat.locator(".hps-error-banner")).toBeVisible({
            timeout: 10000,
          });
        if (mode === "429" || mode === "503")
          await expect(chat.locator(".hps-error-banner")).toContainText(mode);
        await expect(
          chat.locator(".hps-native-observation article"),
        ).toHaveCount(0);
      }
      await ctx.win.screenshot({
        path: join(process.env.HPS_NATIVE_EVIDENCE_DIR!, mode + ".png"),
      });
      writeFileSync(
        join(process.env.HPS_NATIVE_EVIDENCE_DIR!, mode + ".txt"),
        await chat.locator("body").innerText(),
      );
    } finally {
      await closeApp(ctx);
      await fault("none");
    }
  });
