import { test, expect } from '@playwright/test';
import { launchApp, closeApp, startFrame, chatFrame } from '../fixtures/app';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('unified entry: choose without execution, authenticate existing code, start chat', async () => {
  const ctx = await launchApp({ preseedToken: false, stayOnStart: true });
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  const kind = process.env.HPS_NATIVE_MANAGED === '1' ? 'trial' : 'classroom';
  try {
    const original = join(ctx.wsDir, 'original.txt');
    writeFileSync(original, 'synthetic original');
    const start = await startFrame(ctx.win);
    await expect(start.getByRole('heading', { name: '어떻게 시작할까요?' })).toBeVisible();
    await start.getByRole('button', { name: 'AI 체험하기', exact: true }).click();
    await expect(start.getByLabel('체험 참여 코드', { exact: true })).toBeVisible();
    await expect(start.getByRole('button', { name: '코드 확인하기' })).toBeDisabled();
    await start.getByRole('button', { name: '시작 방법 다시 선택' }).click();
    await start.getByRole('button', { name: '수업에 참여하기', exact: true }).click();
    await start.getByLabel('수업 참여 코드', { exact: true }).fill('synthetic-invalid');
    await start.getByRole('button', { name: '코드 확인하기' }).click();
    await expect(start.getByRole('alert')).toBeVisible();
    await start.getByLabel('수업 참여 코드', { exact: true }).fill(ctx.token);
    await start.getByRole('button', { name: '코드 확인하기' }).click();
    await expect(start.locator('.studio-verified')).toHaveText(kind === 'trial' ? 'AI 체험' : '수업');
    await expect(start.locator('input[type=password]')).toHaveCount(0);
    await expect(start.getByRole('heading', { name: '이 활동으로 시작할까요?' })).toBeVisible();
    await start.getByRole('button', { name: '선택 취소', exact: true }).click();
    await expect(start.locator('.studio-course')).toHaveCount(0);
    await start.getByLabel('수업 참여 코드', { exact: true }).fill(ctx.token);
    await start.getByRole('button', { name: '코드 확인하기' }).click();
    await expect(start.locator('.studio-course')).toBeVisible();
    await ctx.win.screenshot({ path: join(out, 'unified-connected.png') });
    await start.getByRole('button', { name: '이어서 하기' }).click();
    const chat = await chatFrame(ctx.win);
    await expect(chat.getByRole('textbox', { name: /보낼 메시지/ })).toBeVisible();
    expect(existsSync(join(ctx.wsDir, 'index.html'))).toBe(false);
    expect(readFileSync(original, 'utf8')).toBe('synthetic original');
    expect(existsSync(join(out, 'api-evidence.json'))).toBe(false);
    await ctx.win.screenshot({ path: join(out, 'unified-chat.png') });
    writeFileSync(join(out, 'unified-entry.json'), JSON.stringify({ status: 'PASS', kind,
      scope: 'actual Mac App with local injected extension and synthetic Service; no model request',
      invalid_code_rejected: true, candidate_cancelled_before_commit: true, authenticated_kind_overrides_entry_choice: true,
      original_preserved: true, index_html_created: false, public_release: false }, null, 2));
  } finally { await closeApp(ctx); }
});
