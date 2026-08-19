// Probe (dev): kids-quest 프로필로 실제 앱에서 세상 띄우기 → 미리보기 → 두 번째 턴까지 관측.
import { test } from "@playwright/test";
import * as fs from "node:fs";
import type { Page } from "@playwright/test";
import { launchApp, closeApp } from "../fixtures/app.ts";

async function findChat(win: Page) {
  const outers = win.locator("iframe.webview.ready");
  const n = await outers.count();
  for (let i = 0; i < n; i++) {
    const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
    try { if ((await fl.locator(".hps-shell").count()) > 0) return { fl, i, n }; } catch { /* not ready */ }
  }
  return null;
}
async function findPreview(win: Page) {
  const n = await win.locator("iframe.webview.ready").count();
  for (let i = 0; i < n; i++) {
    const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
    try { if ((await fl.locator("#frame").count()) > 0) return { fl, i, n }; } catch { /* */ }
  }
  return null;
}

test("kids-quest probe", async () => {
  test.skip(process.env.HPS_KQ_PROBE !== "1", "dev probe — set HPS_KQ_PROBE=1 (needs a kids-quest session + LLM)");
  test.setTimeout(500_000);
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "별이", personality: "" } });
  const { win } = ctx;
  const notes: string[] = [];
  const dump = (s: string) => { notes.push(`[${new Date().toISOString()}] ${s}`); console.log(s); };
  const readAssistant = async () => {
    const c = await findChat(win); if (!c) return { text: "", frames: -1, idx: -1 };
    const a = c.fl.locator(".hps-msg-assistant").last();
    const text = (await a.count()) ? ((await a.textContent()) ?? "") : "";
    return { text, frames: c.n, idx: c.i };
  };
  try {
    let c = await findChat(win);
    for (let i = 0; i < 20 && !c; i++) { await win.waitForTimeout(1500); c = await findChat(win); }
    if (!c) throw new Error("chat frame not found");
    const ta = c.fl.locator(".hps-input textarea").first();
    await ta.waitFor({ state: "visible", timeout: 15_000 });
    await ta.fill("🐕 초코 세상에 가볼래"); await ta.press("Enter");
    const t0 = Date.now(); let last = "";
    while (Date.now() - t0 < 160_000) {
      const r = await readAssistant();
      if (r.text !== last) { last = r.text; dump(`T1 assistant(frames=${r.frames}, idx=${r.idx}) len=${r.text.length}: ${r.text.slice(0, 200).replace(/\n/g, " ⏎ ")}`); }
      const pv = await findPreview(win);
      if (pv) {
        const inner = await pv.fl.locator("#frame").evaluate((f: HTMLIFrameElement) => (f.getAttribute("srcdoc") ?? "").slice(0, 200000)).catch(() => "");
        if (inner) {
          const world = /const WORLD=\{([^}]*)\}/.exec(inner)?.[1]?.replace(/\s+/g, " ") ?? "-";
          const guest = /GUEST_NAME='([^']*)'/.exec(inner)?.[1];
          dump(`PREVIEW srcdoc len=${inner.length} guest=${guest} WORLD{${world.slice(0, 120)}}`);
          break;
        }
      }
      await win.waitForTimeout(2500);
    }
    await win.waitForTimeout(6000);
    dump("T1 final: " + (await readAssistant()).text.slice(0, 500).replace(/\n/g, " ⏎ "));
    { const c1 = await findChat(win); const sh = c1 ? ((await c1.fl.locator(".hps-shell").textContent()) ?? "") : ""; dump("T1 shell has 미리보기 열었어요: " + /미리보기를 열었어요/.test(sh) + " | Write/Edit: " + /Write\(|Edit\(/.test(sh)); }
    c = await findChat(win); if (!c) throw new Error("chat frame lost");
    const ta2 = c.fl.locator(".hps-input textarea").first();
    await ta2.fill("해봤는데 불덩이만 떨어져서 바로 끝났어"); await ta2.press("Enter");
    const t1 = Date.now(); let last2 = "";
    while (Date.now() - t1 < 60_000) {
      const r = await readAssistant();
      if (r.text !== last2 && r.text !== last) { last2 = r.text; dump(`T2 assistant len=${r.text.length}: ${r.text.slice(0, 300).replace(/\n/g, " ⏎ ")}`); }
      if (last2.length > 20 && !/생각하는 중/.test(last2)) break;
      await win.waitForTimeout(2000);
    }
    c = await findChat(win); if (!c) throw new Error("chat frame lost 2");
    const ta3 = c.fl.locator(".hps-input textarea").first();
    await ta3.fill("초코가 뜨거운 게 문제야. 딸기 아이스크림이 떨어지게 하고 해를 구름으로 가려줘"); await ta3.press("Enter");
    const t2 = Date.now(); let last3 = ""; let seenPreview2 = false;
    while (Date.now() - t2 < 160_000) {
      const r = await readAssistant();
      if (r.text !== last3 && r.text !== last2) { last3 = r.text; dump(`T3 assistant len=${r.text.length}: ${r.text.slice(0, 200).replace(/\n/g, " ⏎ ")}`); }
      const pv = await findPreview(win);
      if (pv) {
        const inner = await pv.fl.locator("#frame").evaluate((f: HTMLIFrameElement) => (f.getAttribute("srcdoc") ?? "")).catch(() => "");
        if (inner && /ITEM_A='[^']+'/.test(inner)) {
          const world = /const WORLD=\{([^}]*)\}/.exec(inner)?.[1]?.replace(/\s+/g, " ") ?? "-";
          dump(`PREVIEW2 ITEM_A=${/ITEM_A='([^']*)'/.exec(inner)?.[1]} WORLD{${world.slice(0, 120)}}`);
          seenPreview2 = true; break;
        }
      }
      await win.waitForTimeout(2500);
    }
    dump("T3 done, preview2=" + seenPreview2);
    { const c1 = await findChat(win); const sh = c1 ? ((await c1.fl.locator(".hps-shell").textContent()) ?? "") : ""; const n = (sh.match(/미리보기를 열었어요/g) ?? []).length; dump("T3 shell 미리보기 열었어요 count: " + n + " | 실행 버튼/주소 언급: " + /▶ 실행|127\.0\.0\.1|실행 버튼/.test(sh)); }
    // T4 — ask for the guest's verdict without having played: coach must not invent a result
    c = await findChat(win); if (!c) throw new Error("chat frame lost 3");
    const ta4 = c.fl.locator(".hps-input textarea").first();
    await ta4.fill("초코야 어때? 됐어?"); await ta4.press("Enter");
    const t3 = Date.now(); let last4 = "";
    while (Date.now() - t3 < 60_000) {
      const r = await readAssistant();
      if (r.text !== last4 && r.text !== last3) { last4 = r.text; dump(`T4 assistant len=${r.text.length}: ${r.text.slice(0, 300).replace(/\n/g, " ⏎ ")}`); }
      if (last4.length > 20 && !/생각하는 중/.test(last4)) break;
      await win.waitForTimeout(2000);
    }
    const notice = await c.fl.locator(".hps-shell").textContent().catch(() => "");
    dump("shell has 결과 notice: " + /친구가 해봤어요|게스트 결과/.test(notice ?? ""));
    try {
      const idx = fs.readFileSync(`${ctx.wsDir}/index.html`, "utf8");
      fs.writeFileSync("test-results/kq-probe-index.html", idx);
      dump(`ws index.html len=${idx.length} ITEM_A=${/ITEM_A='([^']*)'/.exec(idx)?.[1]} WORLD{${(/const WORLD=\{([^}]*)\}/.exec(idx)?.[1] ?? "-").replace(/\s+/g, " ").slice(0, 120)}}`);
      dump("ws files: " + fs.readdirSync(ctx.wsDir).join(", "));
    } catch (e) { dump("ws read failed: " + String(e).slice(0, 100)); }
    const tabsInfo = await win.evaluate(() => Array.from(document.querySelectorAll(".tab")).map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 40)));
    dump("editor tabs: " + JSON.stringify(tabsInfo));
  } finally {
    fs.writeFileSync("test-results/kq-probe.log", notes.join("\n"));
    await closeApp(ctx);
  }
});
