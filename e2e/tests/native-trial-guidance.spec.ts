import { test, expect } from '@playwright/test';
import { launchApp, closeApp, startFrame, chatFrame } from '../fixtures/app';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// Transport/file assertions are automatic; conversational acceptance is reviewed
// from the actual turns, never inferred from question marks or a keyword score.
const cases = [
  { id: 'still-unsure', turns: [
    '해야 할 일은 있는데 어디서 시작할지 모르겠어',
    '그것도 잘 모르겠어. 요즘 뭔가 바꾸고 싶다는 생각만 들어',
    '퇴근하고 나면 시간을 그냥 보내는 것 같아',
    '계획을 못 세우는 건지 너무 피곤한 건지도 잘 모르겠어',
    '지금은 계획을 짜기보다 어디서 시간이 사라지는지 알고 싶어',
    '오늘 저녁에 부담 없이 관찰할 것 한 가지만 제안해줘. 채팅으로만 알려줘',
  ] },
  { id: 'task-name-is-not-purpose', turns: [
    'AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어',
    'PPT 만드는 일이야. 뭘 맡겨도 되는지는 여전히 모르겠어',
  ] },
  { id: 'clear-request', turns: [
    '이 공지를 한 문장으로 줄여줘: 이번 주 정기 회의는 금요일 오후 3시에 시작합니다. 회의실은 기존과 같습니다. 준비 자료는 따로 없습니다.',
  ] },
  { id: 'skip-and-change', turns: [
    '요즘 뭘 해볼지 모르겠어',
    '질문은 그만하고 오늘 저녁 가볍게 해볼 활동 한 가지를 가정을 적어서 추천해줘. 파일은 필요 없어',
    '그건 됐고 이 문장을 짧게 줄여줘: 약속 장소에 도착하면 나에게 문자를 보내 주세요.',
  ] },
];

function filesAt(root: string, dir = root): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    // Host settings/session metadata are not user artifacts.
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(result, filesAt(root, path));
    else result[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return result;
}

for (const scenario of cases) test(scenario.id, async () => {
  test.setTimeout(300000);
  const ctx = await launchApp({ preseedToken: true, stayOnStart: true });
  const out = join(process.env.HPS_NATIVE_EVIDENCE_DIR!, scenario.id);
  mkdirSync(out, { recursive: true });
  const record: any = { synthetic: true, semantic_review: 'PENDING', transport: 'RUNNING', turns: [] };
  try {
    await (await startFrame(ctx.win)).getByRole('button', { name: '수업 시작하기' }).click();
    const chat = await chatFrame(ctx.win);
    record.model = process.env.HPS_GUIDANCE_MODEL || 'claude-opus-5';
    await chat.getByRole('combobox', { name: '대화 모델' }).selectOption(record.model);
    const input = chat.getByRole('textbox', { name: /보낼 메시지/ });
    record.files_before = filesAt(ctx.wsDir);
    for (const prompt of scenario.turns) {
      const before = await chat.locator('.hps-tool-label').count();
      await input.fill(prompt);
      await input.press('Enter');
      await expect(chat.locator('.hps-btn-stop')).toBeVisible();
      await expect(chat.locator('.hps-btn-stop')).toHaveCount(0, { timeout: 120000 });
      await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
      const reply = await chat.locator('.hps-msg-assistant').last().innerText();
      expect(reply.length).toBeGreaterThan(0);
      record.turns.push({ prompt, reply, tools: (await chat.locator('.hps-tool-label').allTextContents()).slice(before) });
      record.files_after = filesAt(ctx.wsDir);
      await ctx.win.screenshot({ path: join(out, `turn-${record.turns.length}.png`) });
      expect(record.files_after).toEqual(record.files_before);
    }
    record.transport = 'PASS';
  } catch (error) {
    record.transport = 'FAIL';
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeFileSync(join(out, 'result.json'), JSON.stringify(record, null, 2));
    await closeApp(ctx);
  }
});
