// #384 — verify image attach works in the installed app: simulate a paste AND
// a drag-drop of an image onto the chat input, assert a thumbnail appears.
// Run:
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" HPS_QUIET=0 \
//     npx playwright test image-attach --reporter=line

import { test, expect, type FrameLocator } from "@playwright/test";
import { launchApp, closeApp, chatFrame, openChatContainer, type AppContext } from "../fixtures/app.ts";
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function chatCf(win: import("@playwright/test").Page, timeoutMs = 40_000): Promise<FrameLocator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await win.locator("iframe.webview.ready").count();
    for (let i = 0; i < n; i++) {
      const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      try { if ((await fl.locator(".hps-shell").count()) > 0) return fl; } catch { /* next */ }
    }
    if (Date.now() > deadline) throw new Error("chat frame not found");
    await openChatContainer(win).catch(() => undefined);
    await win.waitForTimeout(2_000);
  }
}

// 1x1 PNG (base64) — injected as a File into paste/drop events.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SECOND_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAIElEQVR4AezQoQ0AAADCMML/R/MBQSA3PVVrjLFC/XkCAAD//3Nn3qIAAAAGSURBVAMAEzgAFbNrw9wAAAAASUVORK5CYII=';

test("image attach — paste and drag-drop both surface a thumbnail", async () => {
  test.setTimeout(300_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    const cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });

    // Sanity: this cohort must have image paste enabled (else the handlers early-return).
    const pasteEnabled = await cf.locator(".hps-input textarea").first().getAttribute("placeholder");
    expect(pasteEnabled ?? "", "placeholder hints image paste is enabled").toMatch(/이미지|⌘V|드래그/);

    // ── DROP path (new #384) — panel-wide drop zone (.hps-shell) ─────────
    await cf.locator(".hps-shell").first().evaluate((el, b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, PNG_B64);
    await expect(cf.locator(".hps-attachment img"), "drop → thumbnail appears").toHaveCount(1, { timeout: 15_000 });

    // ── PASTE path ───────────────────────────────────────────────────────
    await cf.locator(".hps-input textarea").first().evaluate((el, b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "shot2.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt } as ClipboardEventInit));
    }, SECOND_PNG_B64);
    await expect(cf.locator(".hps-attachment img"), "paste → second thumbnail appears").toHaveCount(2, { timeout: 15_000 });
    await expect.poll(() => cf.locator('.hps-attachment img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0))).toEqual([true, true]);
    const sources = await cf.locator('.hps-attachment img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).src));
    expect(sources[0]).not.toBe(sources[1]);
    const draft = cf.locator('.hps-input textarea').first();
    await draft.fill('이미지를 지워도 유지할 합성 초안');
    if (process.env.HPS_NATIVE_EVIDENCE_DIR) await ctx.win.screenshot({ path: join(process.env.HPS_NATIVE_EVIDENCE_DIR, 'attached-images.png') });
    const remove = cf.getByRole('button', { name: '이미지 제거', exact: true }).first();
    const bounds = await remove.boundingBox();
    expect(bounds).not.toBeNull();
    // Synthetic file drag events also reach VS Code's outer drag shield.
    // A real pointer move ends that shield before clicking, as in a user's
    // drag/drop → move to remove sequence. Never bypass hit testing or invoke
    // the React handler directly.
    const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
    await ctx.win.mouse.move(1, 1);
    await ctx.win.mouse.move(point.x, point.y);
    await remove.click();
    await expect(cf.locator('.hps-attachment img')).toHaveCount(1);
    await expect(cf.locator('.hps-attachment img')).toHaveAttribute('src', sources[1]);
    await cf.getByRole('button', { name: '이미지 제거', exact: true }).press('Enter');
    await expect(cf.locator('.hps-attachment img')).toHaveCount(0);
    await expect(draft).toHaveValue('이미지를 지워도 유지할 합성 초안');
    if (process.env.HPS_NATIVE_EVIDENCE_DIR) writeFileSync(join(process.env.HPS_NATIVE_EVIDENCE_DIR, 'image-controls.json'), JSON.stringify({ status: 'PASS', scope: 'actual Electron webview; synthetic ClipboardEvent/DragEvent; OS clipboard untouched', decoded_images: 2, selected_image_removed: true, keyboard_remove: true, draft_preserved: true }));

    // eslint-disable-next-line no-console
    console.log("image attach OK — drop + paste both produced a thumbnail");
  } finally {
    await closeApp(ctx);
  }
});
