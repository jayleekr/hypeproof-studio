import { test, expect } from '@playwright/test';
import { launchApp, closeApp, startFrame, chatFrame, runCommand } from '../fixtures/app';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('trial entry: real explorer, settings, folder cancellation, disconnect and reconnect', async () => {
  const ctx = await launchApp({ preseedToken: true, stayOnStart: true, simpleFileDialog: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const marker = join(ctx.wsDir, 'preserved.txt');
    writeFileSync(marker, 'synthetic existing work');
    let start = await startFrame(ctx.win);
    await start.getByRole('button', { name: '파일', exact: true }).click();
    await expect(ctx.win.locator('.explorer-viewlet')).toBeVisible();
    await start.getByRole('button', { name: '설정', exact: true }).click();
    await expect(ctx.win.locator('.settings-editor')).toBeVisible();
    await ctx.win.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).click();
    await start.getByRole('button', { name: /작업 폴더 열기/ }).click();
    const picker = ctx.win.locator('.quick-input-widget');
    await expect(picker).toBeVisible();
    await ctx.win.screenshot({ path: join(out, 'folder-picker.png') });
    await ctx.win.keyboard.press('Escape');
    await expect(picker).not.toBeVisible();
    expect(readFileSync(marker, 'utf8')).toBe('synthetic existing work');

    await start.getByRole('button', { name: /^(?:이어서 하기|수업 시작하기)$/ }).click();
    const chat = await chatFrame(ctx.win);
    await expect(chat.getByRole('textbox', { name: '코치에게 보낼 메시지' })).toBeVisible();
    await chat.getByRole('button', { name: '수업 연결', exact: true }).click();
    start = await startFrame(ctx.win);
    await start.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect(start.getByRole('button', { name: '수업에 참여하기', exact: true })).toBeVisible();
    // Reveal the existing disconnected conversation without changing its connection.
    await runCommand(ctx.win, 'HypeProof Chat: Focus');
    await chat.getByRole('button', { name: /시작 화면 열기/ }).click();
    await expect(start.getByRole('button', { name: '수업에 참여하기', exact: true })).toBeVisible();
    if (await start.getByRole('button', { name: '수업에 참여하기', exact: true }).isVisible()) await start.getByRole('button', { name: '수업에 참여하기', exact: true }).click();
    await start.getByLabel('수업 참여 코드', { exact: true }).fill(ctx.token);
    await start.getByRole('button', { name: /^(?:코드 확인하기|수업 확인하기)$/ }).click();
    await expect(start.locator('.studio-course')).toBeVisible();
    await start.getByRole('button', { name: /^(?:이어서 하기|수업 시작하기)$/ }).click();
    await expect(chat.getByRole('textbox', { name: '코치에게 보낼 메시지' })).toBeVisible();
    expect(readFileSync(marker, 'utf8')).toBe('synthetic existing work');
    await ctx.win.screenshot({ path: join(out, 'entry-reconnected.png') });
    writeFileSync(join(out, 'entry-controls.json'), JSON.stringify({ status: 'PASS', scope: 'actual Mac; synthetic credential; VS Code simple folder dialog cancellation', explorer: true, settings: true, folder_cancel_preserves_workspace: true, disconnect_reconnect: true, files_preserved: true }));
  } finally { await closeApp(ctx); }
});

test('folder selection actually opens the selected practice workspace and preserves both folders', async () => {
  const ctx = await launchApp({ preseedToken: true, stayOnStart: true, simpleFileDialog: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const second = join(ctx.userDataDir, 'second-workspace');
    mkdirSync(second);
    writeFileSync(join(ctx.wsDir, 'original.txt'), 'synthetic original');
    writeFileSync(join(second, 'second.txt'), 'synthetic second');
    const start = await startFrame(ctx.win);
    await start.getByRole('button', { name: /작업 폴더 열기/ }).click();
    const picker = ctx.win.locator('.quick-input-widget');
    await picker.locator('input.input').fill(second + '/');
    await picker.getByRole('button', { name: '작업 폴더 열기', exact: true }).click();
    await expect.poll(async () => ctx.win.title()).toContain('second-workspace');
    const reopened = await startFrame(ctx.win);
    await expect(reopened.locator('.studio-bottom')).toContainText('second-workspace');
    expect(readFileSync(join(ctx.wsDir, 'original.txt'), 'utf8')).toBe('synthetic original');
    expect(readFileSync(join(second, 'second.txt'), 'utf8')).toBe('synthetic second');
    await ctx.win.screenshot({ path: join(out, 'selected-workspace.png') });
    writeFileSync(join(out, 'folder-selection.json'), JSON.stringify({ status: 'PASS', scope: 'actual Mac; VS Code simple folder dialog', selected_workspace_opened: true, original_preserved: true, selected_preserved: true }));
  } finally { await closeApp(ctx); }
});

test('Run opens a real native preview; viewport buttons change the actual iframe width', async () => {
  const html = '<!doctype html><html lang="ko"><meta charset="utf-8"><title>합성 화면 검수</title><style>body{margin:0;background:#f7f5ec;color:#203b2c;font:20px system-ui;padding:16px;box-sizing:border-box}</style><h1>합성 홈페이지</h1><p>실제 학생 결과물이 아닌 미리보기 조작 시료입니다.</p></html>';
  const ctx = await launchApp({ preseedToken: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    const chat = await chatFrame(ctx.win);
    const input = chat.getByRole('textbox', { name: '코치에게 보낼 메시지' });
    await input.fill('UI 기능 검사용 합성 시료야. 파일이나 도구를 사용하지 말고 아래 HTML을 html 코드 블록 하나로 그대로 답해줘. 실제 학습자 결과물은 아니야.\n' + html);
    await input.press('Enter');
    await expect(chat.locator('.hps-btn-stop')).toBeVisible();
    await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 90000 });
    console.log('preview: actual chat response complete');
    await chat.locator('.hps-msg-run').click();
    console.log('preview: Run clicked');
    const nativeUrls = () => ctx.app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.getURL()).filter(u => /^http:\/\/(127\.0\.0\.1|localhost):/.test(u)));
    await expect.poll(nativeUrls).not.toHaveLength(0);
    const url = (await nativeUrls())[0];
    console.log('preview: native URL located', url);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('합성 홈페이지');
    console.log('preview: local content independently verified');
    await runCommand(ctx.win, 'HypeProof: 미리보기 화면 크기');
    console.log('preview: viewport command invoked');
    const viewportId = () => ctx.app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().includes('/__hp_viewport?'))?.id ?? null);
    await expect.poll(viewportId).not.toBeNull();
    const id = (await viewportId())!;
    console.log('preview: viewport WebContents found', id);
    const inspect = () => ctx.app.evaluate(async ({ webContents }, id) => {
      const w = webContents.fromId(id)!;
      return w.executeJavaScript(`({url:location.href, width:document.getElementById('site')?.contentWindow.innerWidth, text:document.getElementById('site')?.contentDocument.body.innerText})`);
    }, id);
    await expect.poll(async () => (await inspect()).width).toBe(390);
    const clickWidth = async (width: number) => ctx.app.evaluate(async ({ webContents }, { id, width }) => {
      const w = webContents.fromId(id)!;
      // Dispatch actual pointer events to the existing page, without replacing handlers.
      const rect = await w.executeJavaScript(`(()=>{const r=document.querySelector('[data-width="${width}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      w.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
      w.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
    }, { id, width });
    const capture = async (name: string) => {
      const png = await ctx.app.evaluate(async ({ webContents }, id) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const shot = await Promise.race([webContents.fromId(id)!.capturePage(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('native preview capture timed out; run with HPS_QUIET_NO_HIDE=1')), 10000); })]);
          return shot.toPNG().toString('base64');
        } finally { clearTimeout(timer); }
      }, id);
      writeFileSync(join(out, name), Buffer.from(png, 'base64'));
    };
    console.log('preview: measured 390');
    await capture('native-preview-390.png');
    console.log('preview: captured 390');
    await clickWidth(1280);
    await expect.poll(async () => (await inspect()).width).toBe(1280);
    await capture('native-preview-1280.png');
    await clickWidth(390);
    await expect.poll(async () => (await inspect()).width).toBe(390);
    await ctx.app.evaluate(async ({ webContents }, id) => {
      const w = webContents.fromId(id)!;
      const rect = await w.executeJavaScript(`(()=>{const r=document.getElementById('original').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      w.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
      w.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
    }, id);
    await expect.poll(() => ctx.app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id)).not.toContain('/__hp_viewport');
    expect(readFileSync(join(ctx.wsDir, 'index.html'), 'utf8')).toContain('합성 홈페이지');
    writeFileSync(join(out, 'native-preview.json'), JSON.stringify({ status: 'PASS', source: 'synthetic HTML returned through actual model chat; not an independently created student artifact', url, widths: [390, 1280, 390], original_navigation: true, public_deployment: false }));
  } finally { await closeApp(ctx); }
});
