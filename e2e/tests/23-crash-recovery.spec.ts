// Actual Electron boundary recovery; synthetic crash, real host history reload.
import { test, expect } from '@playwright/test';
import { launchApp, closeApp, chatFrame } from '../fixtures/app';
import { join } from 'node:path';
test('REQ-C7: webview crash → fallback → retry restores actual chat', async () => {
  const prior = process.env.HPS_TEST_CRASH_AFTER_MS;
  process.env.HPS_TEST_CRASH_AFTER_MS = '5000';
  const ctx = await launchApp({preseedToken:true,preseedCoach:{name:'코치'}});
  if (prior === undefined) delete process.env.HPS_TEST_CRASH_AFTER_MS;
  else process.env.HPS_TEST_CRASH_AFTER_MS = prior;
  try {
    const chat = await chatFrame(ctx.win);
    await expect(chat.getByRole('button',{name:'다시 열기',exact:true})).toBeVisible({timeout:20000});
    await expect(chat.locator('.hps-fatal')).toContainText('hps-test: forced webview crash');
    await chat.getByRole('button',{name:'다시 열기',exact:true}).click();
    await expect(chat.locator('.hps-input textarea')).toBeVisible();
    await expect(chat.locator('.hps-fatal')).toHaveCount(0);
    if(process.env.HPS_NATIVE_EVIDENCE_DIR)await ctx.win.screenshot({path:join(process.env.HPS_NATIVE_EVIDENCE_DIR,'crash-recovered.png')});
  } finally {await closeApp(ctx);}
});
