import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchApp, startFrame } from '../fixtures/app';
import { APP_BINARY } from '../fixtures/global-setup';

test('HP shell: native chrome hidden, HP navigation accessible, branded empty editor', async () => {
  const ctx = await launchApp({ preseedToken: false });
  try {
    const start = await startFrame(ctx.win);
    await expect(start.getByRole('heading', { name: '내 수업에 연결하기' })).toBeVisible();
    await expect(ctx.win.locator('.part.activitybar')).not.toBeVisible();
    await expect(ctx.win.locator('.part.statusbar')).not.toBeVisible();
    await expect(ctx.win.locator('.part.titlebar')).toHaveCSS('background-color', 'rgb(21, 29, 25)');
    await start.getByRole('button', { name: '파일', exact: true }).click();
    await expect(ctx.win.locator('.explorer-viewlet')).toBeVisible();
    await start.getByRole('button', { name: '설정', exact: true }).click();
    await expect(ctx.win.locator('.settings-editor')).toBeVisible();
    // The current shell opens Settings in a modal editor, not a second tab.
    await ctx.win.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).click();
    await ctx.win.locator('.tabs-container [aria-label^="Close"]').first().click();
    await expect(ctx.win.locator('.editor-group-watermark .letterpress')).toBeVisible();
    const media = path.resolve(path.dirname(APP_BINARY), '../Resources/app/out/media');
    expect(fs.readFileSync(path.join(media, 'letterpress-dark.svg'), 'utf8')).toContain('#90A96A');
    await ctx.win.screenshot({ path: test.info().outputPath('hp-empty-editor.png') });
  } finally { await closeApp(ctx); }
});
