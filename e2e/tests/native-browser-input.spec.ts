import { test, expect } from '@playwright/test';
import { launchApp, closeApp, chatFrame } from '../fixtures/app';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('browser input: cancellation preserves the form; approval changes only the synthetic value', async () => {
  test.setTimeout(240000);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><title>합성 입력 검사</title><label>연습 문구 <input id="value" aria-label="연습 문구"></label></html>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://trial-form.invalid:${(server.address() as { port: number }).port}/`;
  const ctx = await launchApp({ preseedToken: true, hostResolverRules: 'MAP trial-form.invalid 127.0.0.1' });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const chat = await chatFrame(ctx.win), input = chat.getByRole('textbox', { name: '코치에게 보낼 메시지' });
    const dialog = ctx.win.locator('.monaco-dialog-box'), stop = chat.locator('.hps-btn-stop');
    await input.fill(`합성 브라우저 승인 검사야. browser_open 도구로 ${url} 주소를 한 번 열어줘. 셸, 네트워크 우회, 파일 수정, 다른 URL은 사용하지 마.`);
    await input.press('Enter');
    await expect(stop).toBeVisible();
    await expect(dialog).toBeVisible({ timeout: 90000 });
    await expect(dialog).toContainText(url);
    await dialog.getByRole('button', { name: '열기', exact: true }).click();
    await expect(stop).toHaveCount(0, { timeout: 90000 });
    const value = () => ctx.app.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(w => w.getURL() === url);
      if (!page) return null;
      return page.executeJavaScript('document.querySelector("#value")?.value ?? null');
    }, url);
    await expect.poll(value).toBe('');
    for (const approve of [false, true]) {
      const text = approve ? 'synthetic-allowed' : 'synthetic-denied';
      await input.fill(`browser_read로 현재 연습 문구 입력칸의 ref를 확인한 뒤 browser_type으로 ${text}를 입력해줘. submit은 false야. 승인 창에서 ${approve ? '입력을 허용' : '취소'}할 거야. 취소하면 우회하거나 재시도하지 말고 멈춰줘. 이외의 도구는 사용하지 마.`);
      await input.press('Enter');
      await expect(stop).toBeVisible();
      await expect(dialog).toBeVisible({ timeout: 90000 });
      await expect(dialog).toContainText('코치가 페이지에 입력하려고 해요');
      await ctx.win.screenshot({ path: join(out, `browser-type-${approve ? 'allow' : 'deny'}.png`) });
      if (approve) await dialog.getByRole('button', { name: '입력', exact: true }).click();
      else await ctx.win.keyboard.press('Escape');
      await expect(stop).toHaveCount(0, { timeout: 90000 });
      await expect.poll(value).toBe(approve ? text : '');
    }
    writeFileSync(join(out, 'browser-input-transcript.txt'), await chat.locator('.hps-messages').innerText());
    writeFileSync(join(out, 'browser-input-results.json'), JSON.stringify({ status: 'PASS', scope: 'actual Mac + SDK + local fixture reached through app-only reserved hostname mapping', cancellation_preserved_empty_value: true, approval_value: await value(), submission: false }));
  } finally {
    try { const chat = await chatFrame(ctx.win); writeFileSync(join(out, 'browser-input-transcript.txt'), await chat.locator('.hps-messages').innerText({ timeout: 3000 })); } catch { /* preserve the original failure */ }
    await closeApp(ctx); await new Promise<void>(r => server.close(() => r()));
  }
});
