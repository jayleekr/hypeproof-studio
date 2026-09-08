import {test,expect} from '@playwright/test';
import {launchApp,closeApp,chatFrame,startFrame} from '../fixtures/app';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
test('individual codes isolate history and observation in the same actual workspace',async()=>{
 test.setTimeout(180000);
 const ctx=await launchApp({preseedToken:true,preseedCoach:{name:'코치'}}),out=process.env.HPS_NATIVE_EVIDENCE_DIR!;
 try{
  let chat=await chatFrame(ctx.win);const input=chat.locator('.hps-input textarea').first();
  await input.fill('합성 첫 사용자 테스트야. SYNTHETIC-ALPHA-744를 짧게 확인해줘. 도구는 사용하지 마.');await input.press('Enter');
  await expect(chat.locator('.hps-btn-stop')).toBeVisible();await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:90000});
  const original=await chat.locator('.hps-messages').innerText();expect(original).toContain('SYNTHETIC-ALPHA-744');
  const connect=async(code:string)=>{await (await chatFrame(ctx.win)).getByRole('button',{name:'수업 연결',exact:true}).click();const entry=await startFrame(ctx.win);await entry.getByRole('button',{name:'다른 수업에 연결'}).click();await entry.getByLabel('수업 참여 코드',{exact:true}).fill(code);await entry.getByRole('button',{name:'수업 확인하기'}).click();await expect(entry.locator('.studio-course')).toBeVisible();await entry.getByRole('button',{name:'수업 시작하기'}).click();};
  await connect(readFileSync(process.env.HPS_E2E_TOKEN_FILE+'.alternate','utf8').trim());
  chat=await chatFrame(ctx.win);await expect(chat.locator('.hps-messages')).not.toContainText('SYNTHETIC-ALPHA-744');
  let panel=chat.locator('.hps-native-observation');await panel.locator('summary').first().click();await panel.getByRole('button',{name:'이 작업의 기록 확인'}).click();await expect(panel).toContainText('0건');
  await ctx.win.screenshot({path:join(out,'other-person.png')});
  await connect(ctx.token);chat=await chatFrame(ctx.win);await expect(chat.locator('.hps-messages')).toContainText('SYNTHETIC-ALPHA-744');
  panel=chat.locator('.hps-native-observation');if(await panel.getAttribute('open')===null)await panel.locator('summary').first().click();await panel.getByRole('button',{name:'이 작업의 기록 확인'}).click();await expect(panel).toContainText('SYNTHETIC-ALPHA-744');
  await ctx.win.screenshot({path:join(out,'original-person-restored.png')});
  writeFileSync(join(out,'identity-result.json'),JSON.stringify({status:'PASS',mode:'actual App, real API, synthetic users',other_person_history_empty:true,other_person_observation_empty:true,original_restored:true}));
 }finally{await closeApp(ctx);}
});
