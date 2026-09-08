import { test, expect } from '@playwright/test';
import { launchApp, closeApp, startFrame, chatFrame } from '../fixtures/app';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('entry becomes the conversation; real Markdown response and file preview retain the conversation', async () => {
  test.setTimeout(300000);
  const ctx = await launchApp({ preseedToken: true, stayOnStart: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isFocusable()))).toBe(true);
    const start = await startFrame(ctx.win);
    await expect(start.locator('.studio-course')).toContainText('내 삶에 AI 더하기');
    await start.getByRole('button', { name: '수업 시작하기' }).click();
    const chat = await chatFrame(ctx.win);
    const input = chat.getByRole('textbox', { name: '코치에게 보낼 메시지' });
    await expect(input).toBeFocused();
    await expect(start.locator('.studio-start')).toHaveCount(0);
    const width = (await chat.locator('.hps-shell').boundingBox())!.width;
    expect(width).toBeGreaterThan(await ctx.win.evaluate(() => innerWidth * 0.7));
    await ctx.win.screenshot({ path: join(out, 'conversation-canvas.png') });
    const before = readdirSync(ctx.wsDir).sort();
    await input.fill('UI 렌더링 검사용 합성 응답이야. 도구나 파일을 사용하지 말고 아래 문장을 코드 블록 없이 그대로 답해줘.\n\n지금 **구체적인 일**을 골라주세요.\n\n- AI: 목차 초안\n- 나: 최종 판단');
    await expect(chat.locator('.hps-img-strip')).toHaveCount(0);
    await input.press('Enter');
    await expect(chat.locator('.hps-btn-stop')).toBeVisible();
    await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 120000 });
    await expect(chat.locator('.hps-prose strong')).toContainText('구체적인 일');
    await expect(chat.locator('.hps-prose li')).toHaveCount(2);
    await expect(chat.locator('.hps-tool-label').filter({ hasText: '고쳤어요' })).toHaveCount(0);
    expect(readdirSync(ctx.wsDir).sort()).toEqual(before);
    await ctx.win.screenshot({ path: join(out, 'real-markdown-no-file-change.png') });
    await input.fill('별도 합성 파일·화면 검사야. 현재 작업 폴더에 index.html을 Write 도구로 만들어줘. 본문 제목은 "synthetic life preview"이고 배경은 밝은 크림색으로 해줘. 다른 파일이나 외부 서비스는 사용하지 마. 실제 학생 제작 증거는 아니야.');
    await expect(chat.locator('.hps-img-strip')).toHaveCount(0);
    await input.press('Enter');
    await expect(chat.locator('.hps-btn-stop')).toBeVisible();
    await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 120000 });
    await expect.poll(() => existsSync(join(ctx.wsDir, 'index.html'))).toBe(true);
    expect(readFileSync(join(ctx.wsDir, 'index.html'), 'utf8')).toContain('synthetic life preview');
    const urls = () => ctx.app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.getURL()).filter(url => /^http:\/\/127\.0\.0\.1:/.test(url)));
    await expect.poll(async () => (await urls()).length).toBeGreaterThan(0);
    const preview = (await urls())[0];
    const response = await fetch(preview); expect(response.status).toBe(200);
    expect(await response.text()).toContain('synthetic life preview');
    await expect(input).toBeVisible();
    await expect(chat.locator('.hps-msg-images')).toHaveCount(0);
    await expect(chat.locator('.hps-tool-label').filter({ hasText: /Write\(.*index.html/ })).toBeVisible();
    await ctx.win.screenshot({ path: join(out, 'conversation-and-artifact.png') });
    await input.fill('연결 화면을 다녀와도 유지할 초안');
    await chat.getByRole('button', { name: '수업 연결', exact: true }).click();
    const reconnect = await startFrame(ctx.win);
    await reconnect.getByRole('button', { name: /계속 작업하기/ }).click();
    await expect(input).toHaveValue('연결 화면을 다녀와도 유지할 초안');
    writeFileSync(join(out, 'presentation-transcript.txt'), await chat.locator('.hps-messages').innerText());
    writeFileSync(join(out, 'presentation-results.json'), JSON.stringify({ status: 'PASS', scope: 'actual Mac + real SDK; synthetic rendering sample and local file', conversation_width: width, markdown: true, text_only_preserved_files: true, local_preview: preview, draft_preserved: true }));
  } finally { await closeApp(ctx); }
});

test('delegation concern remains the purpose after the learner names a presentation task', async () => {
  test.setTimeout(300000);
  const ctx = await launchApp({ preseedToken: true, stayOnStart: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  try {
    expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isFocusable()))).toBe(true);
    const start = await startFrame(ctx.win);
    await start.getByRole('button', { name: '수업 시작하기' }).click();
    const chat = await chatFrame(ctx.win), input = chat.getByRole('textbox', { name: '코치에게 보낼 메시지' });
    for (const text of ['AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어', '피피티 만드는 일이야', '고객사에 발표할 가상의 예약관리 서비스 소개 PPT야']) {
      await input.fill(text);
      await expect(chat.locator('.hps-img-strip')).toHaveCount(0);
      await input.press('Enter');
      await expect(chat.locator('.hps-btn-stop')).toBeVisible();
      await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 120000 });
    }
    await ctx.win.screenshot({ path: join(out, 'delegation-purpose.png') });
    writeFileSync(join(out, 'delegation-transcript.txt'), await chat.locator('.hps-messages').innerText());
    // This test proves the real conversation completed. Semantic acceptance is
    // reviewed from the transcript, never inferred from a green transport test.
    writeFileSync(join(out, 'delegation-results.json'), JSON.stringify({ transport: 'PASS', semantic_review: 'PENDING', scope: 'synthetic multi-turn participant; no human learning claim' }));
  } finally { await closeApp(ctx); }
});
