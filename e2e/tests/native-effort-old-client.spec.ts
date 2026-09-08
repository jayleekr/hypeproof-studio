import {test,expect} from '@playwright/test';
import {launchApp,closeApp,chatFrame} from '../fixtures/app';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
test('released client without effort headers uses the frozen course default',async()=>{
 test.setTimeout(180000);
 const ctx=await launchApp({preseedToken:true,preseedCoach:{name:'제작 파트너'}}),out=process.env.HPS_NATIVE_EVIDENCE_DIR!;
 try{
  const chat=await chatFrame(ctx.win);
  await expect(chat.getByRole('combobox',{name:'처리 수준',exact:true})).toHaveCount(0);
  const input=chat.locator('.hps-input textarea').first();
  await input.fill('합성 테스트. 도구 없이 민트플라워 이름만 답해 줘.');await input.press('Enter');
  await expect(chat.locator('.hps-btn-stop')).toBeVisible();await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:90000});
  await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
  await expect(chat.locator('.hps-messages')).toContainText('민트플라워');
  const calls=()=>JSON.parse(readFileSync(join(out,'api-evidence.json'),'utf8')).calls;
  await expect.poll(()=>calls().every((c:any)=>c.status!==null),{timeout:95000}).toBe(true);
  expect(calls().length).toBeGreaterThan(0);
  expect(calls().every((c:any)=>c.status===200&&c.model==='claude-sonnet-4-6'&&c.effort==='medium'&&c.requested_effort===null)).toBe(true);
  const png=await ctx.app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(join(out,'old-client.png'),Buffer.from(png,'base64'));
  writeFileSync(join(out,'old-client-result.json'),JSON.stringify({status:'PASS',calls:calls(),scope:'untouched v0.1.56 + new local Service + synthetic frozen effort course',visual_review:'PENDING'},null,2));
 }finally{await closeApp(ctx);}
});
