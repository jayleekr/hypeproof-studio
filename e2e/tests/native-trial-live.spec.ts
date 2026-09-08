// Executed only by the isolated native-trial-live workflow. No production token.
import { test, expect } from '@playwright/test';
import { launchApp, closeApp, chatFrame, startFrame } from '../fixtures/app';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('native trial: enter code, use real API, create and revise an actual work file', async () => {
  test.skip(process.env.HPS_NATIVE_LIVE !== '1', 'isolated live runner only');
  test.setTimeout(480000);
  const ctx = await launchApp({ preseedToken: false, stayOnStart: true, preseedCoach: { name: '코치' } });
  const output = resolve(process.env.HPS_NATIVE_EVIDENCE_DIR || 'test-results/native-trial');
  mkdirSync(output, { recursive: true });
  let stopped = false;
  // Synthetic participant approves this test's requested local file operations.
  // This does not count as evidence of a human's delegation ability.
  const approvals = (async () => {
    while (!stopped) {
      try {
        const box = ctx.win.locator('.monaco-dialog-box').first();
        if (await box.isVisible().catch(() => false)) {
          const copy = (await box.textContent()) || '';
          const allowed = /restart to take effect/i.test(copy) ? /Cancel/i : /Approve|승인|허용/;
          const button = box.locator('.monaco-button').filter({ hasText: allowed }).first();
          if (await button.isVisible().catch(() => false)) await button.click();
        }
      } catch { /* lifecycle transition */ }
      await new Promise(r => setTimeout(r, 350));
    }
  })();
  try {
    const start = await startFrame(ctx.win);
    await start.getByLabel('수업 참여 코드', { exact: true }).fill(ctx.token);
    await start.getByRole('button', { name: '수업 확인하기' }).click();
    await expect(start.locator('.studio-course')).toContainText('Studio · 내 업무로 AI 체험');
    await expect(start.locator('input[type=password]')).toHaveCount(0);
    await ctx.win.screenshot({ path: join(output, 'connected.png') });
    await start.getByRole('button', { name: '수업 시작하기' }).click();
    const chat = await chatFrame(ctx.win);
    const input = chat.locator('.hps-input textarea').first();
    await input.waitFor({ state: 'visible', timeout: 60000 });
    await input.fill('가상 꽃집의 직원 인수인계 문서를 만들고 싶어. 대상은 새 직원이고 완료 조건은 영업시간과 주문 확인 절차가 들어가는 것이야. 영업시간은 오전 10시부터 오후 6시까지. 첫 문서는 handover-v1.md로 현재 작업 폴더에 실제 저장하고 다시 읽어 확인해줘. 브라우저, 외부 전송, 셸은 사용하지 말아줘. 파일 쓰기는 승인할게.');
    await input.press('Enter');
    const first = join(ctx.wsDir, 'handover-v1.md');
    await expect.poll(() => existsSync(first), { timeout: 240000, intervals: [1000, 3000] }).toBe(true);
    const before = readFileSync(first, 'utf8');
    expect(before).toMatch(/10|열/);
    expect(before).toMatch(/주문/);
    writeFileSync(join(output, 'handover-v1.md'), before);
    await expect(input).toBeEnabled({ timeout: 60000 });
    await input.fill('영업시간이 잘못됐어. 오후 7시 마감으로 바꾸고 주문 확인 절차는 유지해줘. 첫 파일은 그대로 두고 handover-v2.md로 저장해줘. 두 파일을 다시 읽어 차이를 확인하고, 실제로 확인한 것만 설명해줘.');
    await input.press('Enter');
    const second = join(ctx.wsDir, 'handover-v2.md');
    await expect.poll(() => existsSync(second), { timeout: 180000, intervals: [1000, 3000] }).toBe(true);
    const after = readFileSync(second, 'utf8');
    expect(after).toMatch(/19|7시|일곱/);
    expect(after).toMatch(/주문/);
    expect(after).not.toEqual(before);
    expect(readFileSync(first, 'utf8')).toEqual(before);
    writeFileSync(join(output, 'handover-v2.md'), after);
    await ctx.win.screenshot({ path: join(output, 'revised.png') });
    const api = JSON.parse(readFileSync(join(output, 'api-evidence.json'), 'utf8'));
    expect(api.calls.some((c: { status: number; path: string }) => c.status === 200 && c.path === '/v1/messages')).toBe(true);
    writeFileSync(join(output, 'result.json'), JSON.stringify({
      entry: 'actual code entry', app: 'released shell with branch extension', upstream: 'real Anthropic',
      initial_file_created: true, revised_file_created: true, original_preserved: true,
      human_asset_assessment: 'NOT IMPLEMENTED; synthetic driver behavior is not human learning evidence',
      storage: 'synthetic in-memory bindings; no production cohort used',
    }, null, 2));
  } finally {
    stopped = true;
    await approvals;
    await closeApp(ctx);
  }
});
