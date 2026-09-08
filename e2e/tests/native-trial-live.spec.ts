// Executed only by the isolated native-trial-live workflow. No production token.
import { test, expect } from '@playwright/test';
import { launchApp, closeApp, chatFrame, startFrame } from '../fixtures/app';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hasClosingTime } from '../native-trial-checks.mjs';

test('native trial: enter code, use real API, create and revise an actual work file', async () => {
  test.skip(process.env.HPS_NATIVE_LIVE !== '1', 'isolated live runner only');
  test.setTimeout(480000);
  let ctx = await launchApp({ preseedToken: false, stayOnStart: true, preseedCoach: { name: '코치' } });
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
          const allowed = /restart to take effect/i.test(copy) ? /^Cancel$/i : /^(저장|읽기|Approve|승인)$/;
          const button = box.locator('.monaco-button').filter({ hasText: allowed }).first();
          if (await button.isVisible().catch(() => false)) await button.click();
        }
      } catch { /* lifecycle transition */ }
      await new Promise(r => setTimeout(r, 350));
    }
  })();
  try {
    const start = await startFrame(ctx.win);
    await start.getByLabel('수업 참여 코드', { exact: true }).fill('synthetic-invalid-code');
    await start.getByRole('button', { name: '수업 확인하기' }).click();
    await expect(start.locator('.studio-error')).toBeVisible();
    await start.getByLabel('수업 참여 코드', { exact: true }).fill(ctx.token);
    await start.getByRole('button', { name: '수업 확인하기' }).click();
    await expect(start.locator('.studio-course')).toContainText('Studio · 내 삶에 AI 더하기');
    await expect(start.locator('input[type=password]')).toHaveCount(0);
    await ctx.win.screenshot({ path: join(output, 'connected.png') });
    await start.getByRole('button', { name: '수업 시작하기' }).click();
    const chat = await chatFrame(ctx.win);
    const input = chat.locator('.hps-input textarea').first();
    await input.waitFor({ state: 'visible', timeout: 60000 });
    await input.fill('가상 꽃집의 직원 인수인계 문서를 만들고 싶어. 대상은 새 직원이고 완료 조건은 영업시간과 주문 확인 절차가 들어가는 것이야. 영업시간은 오전 10시부터 오후 6시까지. 첫 문서는 handover-v1.md로 현재 작업 폴더에 실제 저장하고 다시 읽어 확인해줘. 브라우저, 외부 전송, 셸은 사용하지 말아줘. 파일 쓰기는 승인할게.');
    await input.press('Enter');
    await expect(chat.locator('.hps-btn-stop')).toBeVisible();
    const first = join(ctx.wsDir, 'handover-v1.md');
    await expect.poll(() => existsSync(first), { timeout: 240000, intervals: [1000, 3000] }).toBe(true);
    const before = readFileSync(first, 'utf8');
    expect(hasClosingTime(before, 18)).toBe(true);
    expect(before).toMatch(/10|열/);
    expect(before).toMatch(/주문/);
    writeFileSync(join(output, 'handover-v1.md'), before);
    await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 180000 });
    writeFileSync(join(output, 'initial-transcript.txt'), await chat.locator('.hps-messages').innerText());
    await input.fill('영업시간이 잘못됐어. 오후 7시 마감으로 바꾸고 주문 확인 절차는 유지해줘. 첫 파일은 그대로 두고 handover-v2.md로 저장해줘. 두 파일을 다시 읽어 차이를 확인하고, 실제로 확인한 것만 설명해줘.');
    await input.press('Enter');
    await expect(chat.locator('.hps-btn-stop')).toBeVisible();
    const second = join(ctx.wsDir, 'handover-v2.md');
    await expect.poll(() => existsSync(second), { timeout: 180000, intervals: [1000, 3000] }).toBe(true);
    await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 180000 });
    const after = readFileSync(second, 'utf8');
    writeFileSync(join(output, 'handover-v2.md'), after);
    writeFileSync(join(output, 'revised-transcript.txt'), await chat.locator('.hps-messages').innerText());
    expect(hasClosingTime(after, 19)).toBe(true);
    expect(after).toMatch(/주문/);
    expect(after).not.toEqual(before);
    expect(readFileSync(first, 'utf8')).toEqual(before);
    writeFileSync(join(output, 'handover-v2.md'), after);
    await ctx.win.screenshot({ path: join(output, 'revised.png') });
    if(process.env.HPS_NATIVE_OBSERVATION==='1') {
      const panel=chat.locator('.hps-native-observation');
      await panel.locator('summary').first().click();
      await panel.getByRole('button',{name:'이 작업의 기록 확인',exact:true}).click();
      await expect(panel).toContainText('도움 사용 범위는 확인 전까지 미확인');
      await panel.getByRole('checkbox').check();
      await panel.getByRole('button',{name:'관찰 받기',exact:true}).click();
      await expect(panel.locator('article')).toHaveCount(7,{timeout:70000});
      await ctx.win.screenshot({path:join(output,'observation-results.png')});
      writeFileSync(join(output,'observation-panel.txt'),await panel.innerText());
      await expect(panel.getByRole('button',{name:'업무별 커리큘럼 살펴보기'})).toBeVisible();
      await panel.getByRole('button',{name:'이 작업의 기록 확인',exact:true}).click();
      await expect(panel.locator('article')).toHaveCount(7);
      await panel.getByRole('textbox').fill('합성 실행 정정: 두 파일 비교는 코치가 수행했습니다. 사람이 독립적으로 검수했다고 볼 수 없습니다.');
      await panel.getByRole('button',{name:'정정 기록 남기기'}).click();
      await expect(panel).toContainText('합성 실행 정정');
      await ctx.win.screenshot({path:join(output,'observations.png')});
      const selected=JSON.parse(readFileSync(join(output,'observation-input.json'),'utf8'));
      for(const kind of ['user','coach','tool_request','approval','tool_result','artifact','turn_end'])expect(selected.events.some((e:{kind:string})=>e.kind===kind)).toBe(true);
      expect(selected.events.filter((e:{kind:string;actor:string})=>e.kind==='approval').every((e:{actor:string})=>e.actor==='policy')).toBe(true);
      stopped=true;await approvals;
      const savedDir=ctx.userDataDir;await ctx.app.close();
      ctx=await launchApp({preseedToken:false,stayOnStart:true,preseedCoach:{name:'코치'},reuseUserDataDir:savedDir});
      const entry=await startFrame(ctx.win);
      // Test credentials intentionally use in-memory secret storage. Re-enter the
      // same code after a real process restart, then inspect persisted workspaceState.
      if(await entry.getByRole('button',{name:'다른 수업에 연결'}).isVisible().catch(()=>false))await entry.getByRole('button',{name:'다른 수업에 연결'}).click();
      await entry.getByLabel('수업 참여 코드',{exact:true}).fill(ctx.token);
      await entry.getByRole('button',{name:'수업 확인하기'}).click();
      await expect(entry.locator('.studio-course')).toContainText('Studio · 내 삶에 AI 더하기');
      await entry.getByRole('button',{name:'수업 시작하기'}).click();
      const reopened=await chatFrame(ctx.win),reloadedPanel=reopened.locator('.hps-native-observation');
      await reloadedPanel.locator('summary').first().click();
      await reloadedPanel.getByRole('button',{name:'이 작업의 기록 확인'}).click();
      await expect(reloadedPanel).toContainText('합성 실행 정정');
      await expect(reloadedPanel.locator('article')).toHaveCount(7);
      expect(readFileSync(first,'utf8')).toEqual(before);
      expect(readFileSync(second,'utf8')).toEqual(after);
      await ctx.win.screenshot({path:join(output,'reloaded.png')});
    }
    if (process.env.HPS_NATIVE_UI === '1') {
      const current = await chatFrame(ctx.win);
      const beforeClear = await current.locator('.hps-messages').innerText();
      await current.getByRole('button', { name: '대화 지우기', exact: true }).click();
      const dialog = ctx.win.locator('.monaco-dialog-box').first();
      await expect(dialog).toContainText('작업 파일과 내 작업 돌아보기');
      await ctx.win.screenshot({ path: join(output, 'clear-confirmation.png') });
      await ctx.win.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      expect(await current.locator('.hps-messages').innerText()).toBe(beforeClear);
      await current.getByRole('button', { name: '대화 지우기', exact: true }).click();
      await dialog.getByRole('button', { name: '대화 지우기', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(current.locator('.hps-messages')).not.toContainText('handover-v1.md');
      expect(readFileSync(first, 'utf8')).toEqual(before);
      expect(readFileSync(second, 'utf8')).toEqual(after);
      const panel = current.locator('.hps-native-observation');
      if (await panel.getAttribute('open') === null) await panel.locator('summary').first().click();
      await panel.getByRole('button', { name: '이 작업의 기록 확인' }).click();
      await expect(panel).toContainText('합성 실행 정정');
      await ctx.win.screenshot({ path: join(output, 'clear-complete-files-preserved.png') });
      writeFileSync(join(output, 'ui-host-result.json'), JSON.stringify({
        status: 'PASS', ids: ['TUX-CHAT-08', 'TUX-HOST-01'],
        scope: 'actual Mac confirmation/cancel/clear with synthetic conversation; files and observation preserved',
      }, null, 2));
    }
    const api = JSON.parse(readFileSync(join(output, 'api-evidence.json'), 'utf8'));
    expect(api.calls.some((c: { status: number; path: string; request_id: string }) => c.status === 200 && c.path === '/v1/messages' && c.request_id)).toBe(true);
    writeFileSync(join(output, 'result.json'), JSON.stringify({
      entry: 'actual code entry', app: 'released shell with branch extension', upstream: 'real Anthropic',
      initial_file_created: true, revised_file_created: true, original_preserved: true,
      human_asset_assessment: 'NOT_RUN; synthetic driver behavior is not human learning evidence',
      observation: process.env.HPS_NATIVE_OBSERVATION==='1'?'PASS actual host records, real assessment, UI and correction':'NOT_RUN',
      storage: process.env.HPS_NATIVE_MANAGED==='1'?'local SQLite grants and synthetic memory cohort bindings; no production state':'synthetic memory bindings; no production state',
    }, null, 2));
  } finally {
    stopped = true;
    await approvals;
    await closeApp(ctx);
  }
});
