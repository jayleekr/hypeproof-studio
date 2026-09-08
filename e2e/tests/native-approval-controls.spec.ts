import { test, expect } from '@playwright/test';
import { launchApp, closeApp, chatFrame } from '../fixtures/app';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const normalizedCommand = (command: string, root: string) => command.split(root + '/').join('').trim();
assert.equal(normalizedCommand('mv source target', '/synthetic'), 'mv source target');
assert.equal(normalizedCommand('mv /synthetic/source /synthetic/target', '/synthetic'), 'mv source target');
assert.notEqual(normalizedCommand('mv /outside/source /synthetic/target', '/synthetic'), 'mv source target');
assert.notEqual(normalizedCommand('mv source target && pwd', '/synthetic'), 'mv source target');

test('real shell: automatic safe action, strong approval, repeated strong cancellation', async () => {
  test.setTimeout(300000);
  const ctx = await launchApp({ preseedToken: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const chat = await chatFrame(ctx.win);
    const input = chat.getByRole('textbox', { name: '코치에게 보낼 메시지' });
    const stop = chat.locator('.hps-btn-stop');
    const dialog = ctx.win.locator('.monaco-dialog-box');
    writeFileSync(join(ctx.wsDir, 'shell-source.txt'), 'synthetic move approval marker');
    const cases = [
      { command: 'mkdir -p shell-one', path: 'shell-one', choice: null, present: ['shell-one', 'shell-source.txt'], absent: ['shell-moved.txt'] },
      { command: 'mv shell-source.txt shell-moved.txt', path: 'move-once', choice: '실행', present: ['shell-moved.txt'], absent: ['shell-source.txt'] },
      { command: 'mv shell-moved.txt shell-source.txt', path: 'move-cancelled', choice: 'Escape', present: ['shell-moved.txt'], absent: ['shell-source.txt'] },
    ];
    for (const c of cases) {
      await input.fill(`합성 승인 UI 검사야. 현재 작업 폴더에서 Bash 도구로 정확히 ${c.command} 명령 한 번만 실행해줘. 이미 현재 작업 폴더에 있으니 cd나 추가 명령을 붙이지 말아줘. 다른 도구는 쓰지 말아줘. 승인을 거절하면 재시도나 우회 없이 멈춰줘. 결과만 짧게 알려줘.`);
      await input.press('Enter');
      await expect(stop).toBeVisible();
      if (c.choice) {
        await expect(dialog).toBeVisible({ timeout: 90000 });
        writeFileSync(join(out, c.path + '-dialog.html'), await dialog.evaluate(el => el.outerHTML));
        const displayedCommand = await dialog.locator('#monaco-dialog-message-detail').innerText();
        expect(normalizedCommand(displayedCommand, ctx.wsDir)).toBe(c.command);
        await expect(dialog).toContainText('되돌리기 어려운 명령');
        await expect(dialog).not.toContainText('항상 허용');
        await ctx.win.screenshot({ path: join(out, c.path + '-approval.png') });
        if (c.choice === 'Escape') await ctx.win.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: c.choice, exact: true }).click();
      }
      await expect.poll(async () => {
        if (!c.choice) expect(await dialog.count()).toBe(0);
        return await stop.count();
      }, { timeout: 90000 }).toBe(0);
      for (const name of c.present) expect(existsSync(join(ctx.wsDir, name))).toBe(true);
      for (const name of c.absent) expect(existsSync(join(ctx.wsDir, name))).toBe(false);
    }
    writeFileSync(join(out, 'shell-approval-transcript.txt'), await chat.locator('.hps-messages').innerText());
    writeFileSync(join(out, 'shell-approval-results.json'), JSON.stringify({ status: 'PASS', scope: 'actual Mac, real SDK Bash, synthetic workspace', cases }));
  } finally { await closeApp(ctx); }
});

test('real browser: open once, remember origin, reuse origin, refuse another origin', async () => {
  test.setTimeout(300000);
  const received: string[][] = [[], []];
  const servers = received.map(requests => createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><title>합성 브라우저 승인 검사</title><h1>로컬 연습 페이지</h1></html>');
  }));
  for (const server of servers) await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origins = servers.map(server => 'http://127.0.0.1:' + (server.address() as { port: number }).port);
  const aliases = origins.map((origin, i) => origin.replace('127.0.0.1', `trial-${i}.invalid`));
  const ctx = await launchApp({ preseedToken: true, hostResolverRules: 'MAP trial-0.invalid 127.0.0.1, MAP trial-1.invalid 127.0.0.1' });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const chat = await chatFrame(ctx.win), input = chat.getByRole('textbox', { name: '코치에게 보낼 메시지' });
    const dialog = ctx.win.locator('.monaco-dialog-box'), stop = chat.locator('.hps-btn-stop');
    writeFileSync(join(ctx.wsDir, 'index.html'), '<!doctype html><html><title>로컬 시료</title><h1>synthetic local preview marker</h1></html>');
    const cases = [
      { url: origins[0] + '/local', choice: null },
      { url: aliases[0] + '/first', choice: '열기' },
      { url: aliases[0] + '/remember', choice: `이 사이트는 항상 허용 (${aliases[0]})` },
      { url: aliases[0] + '/reuse', choice: null },
      { url: aliases[1] + '/denied', choice: 'Escape' },
    ];
    for (const [i, c] of cases.entries()) {
      await input.fill(`합성 브라우저 승인 검사야. browser_open 도구로 ${c.url} 주소를 한 번 열어줘. 셸, 네트워크 우회, 파일 수정은 하지 말아줘. ${i === 0 ? '첫 요청은 Studio가 실제 라이브 미리보기 주소로 교정하는 동작도 확인해줘.' : '다른 URL은 쓰지 말아줘.'} 승인을 거절하면 다른 도구로 우회하거나 재시도하지 말고 멈춰줘.`);
      await input.press('Enter');
      await expect(stop).toBeVisible();
      if (c.choice) {
        await expect(dialog).toBeVisible({ timeout: 90000 });
        await expect(dialog).toContainText(c.url);
        await ctx.win.screenshot({ path: join(out, `browser-${i}-approval.png`) });
        if (c.choice === 'Escape') await ctx.win.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: c.choice, exact: true }).click();
      }
      await expect.poll(async () => {
        if (!c.choice) expect(await dialog.count()).toBe(0);
        return await stop.count();
      }, { timeout: 90000 }).toBe(0);
      writeFileSync(join(out, 'browser-approval-transcript.txt'), await chat.locator('.hps-messages').innerText());
      const urls = () => ctx.app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.getURL()));
      writeFileSync(join(out, `browser-${i}-state.json`), JSON.stringify({ received, urls: await urls() }));
      if (i === 0) {
        const actual = (await urls()).find(u => /^http:\/\/127\.0\.0\.1:/.test(u))!;
        expect(actual).toBeTruthy(); expect(actual).not.toBe(c.url);
        const page = await fetch(actual, { signal: AbortSignal.timeout(5000) });
        expect(page.status).toBe(200); expect(await page.text()).toContain('synthetic local preview marker');
        expect(received[0]).toHaveLength(0);
      } else if (i === cases.length - 1) { expect(received[1]).toHaveLength(0); expect(await urls()).not.toContain(c.url); }
      else { await expect.poll(() => received[0]).toContain(new URL(c.url).pathname); await expect.poll(urls).toContain(c.url); }
    }
    writeFileSync(join(out, 'browser-approval-transcript.txt'), await chat.locator('.hps-messages').innerText());
    writeFileSync(join(out, 'browser-approval-results.json'), JSON.stringify({ status: 'PASS', scope: 'actual Mac, real SDK browser_open; reserved nonloopback aliases routed to two fixture loopback servers by app-only host resolver rules', cases, received }));
  } finally {
    await closeApp(ctx);
    for (const server of servers) await new Promise<void>(r => server.close(() => r()));
  }
});
