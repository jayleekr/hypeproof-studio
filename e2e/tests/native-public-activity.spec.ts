// Final candidate against an approved synthetic public credential. Never seeds
// a credential into SecretStorage or changes cohorts/sessions/admin settings.
import {test,expect} from '@playwright/test';
import {launchApp,closeApp,startFrame,chatFrame} from '../fixtures/app';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
test('public Service activity creates and revises a synthetic file',async()=>{
 test.skip(process.env.HPS_PUBLIC_ACTIVITY!=='1','approved public acceptance runner only');
 test.setTimeout(240000);
 const ctx=await launchApp({preseedToken:false,stayOnStart:true});
 const out=process.env.HPS_NATIVE_EVIDENCE_DIR!,trial=process.env.HPS_NATIVE_MANAGED==='1';
 try{
  const start=await startFrame(ctx.win);
  await start.getByRole('button',{name:trial?'AI 체험하기':'수업에 참여하기',exact:true}).click();
  await start.getByLabel(trial?'체험 참여 코드':'수업 참여 코드',{exact:true}).fill(ctx.token);
  await start.getByRole('button',{name:'코드 확인하기',exact:true}).click();
  await start.getByRole('button',{name:'이 활동 시작하기',exact:true}).click();
  const chat=await chatFrame(ctx.win);
  await expect(chat.getByLabel('현재 활동')).toContainText(trial?'AI 체험':'수업');
  expect(existsSync(join(ctx.wsDir,'index.html'))).toBe(false);
  await chat.getByRole('combobox',{name:'대화 모델'}).selectOption('hypeproof-fast');
  const turns=[];
  for(const [file,content] of [['public-first.md','SYNTHETIC_FIRST'],['public-revised.md','SYNTHETIC_REVISED']]){
   const prompt=`합성 앱 인수 검사입니다. ${file} 파일에 ${content} 한 줄만 저장해 주세요. 다른 파일은 읽거나 바꾸지 마세요. 셸·네트워크·브라우저는 사용하지 마세요.`;
   const input=chat.getByRole('textbox',{name:/보낼 메시지/});await input.fill(prompt);await input.press('Enter');
   await expect(chat.locator('.hps-btn-stop')).toBeVisible();await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:100000});
   await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
   await expect.poll(()=>existsSync(join(ctx.wsDir,file))).toBe(true);
   expect(readFileSync(join(ctx.wsDir,file),'utf8').trim()).toBe(content);
   turns.push({prompt,response:await chat.locator('.hps-msg-assistant').last().innerText(),tools:await chat.locator('.hps-tool-label').allTextContents()});
  }
  expect(readFileSync(join(ctx.wsDir,'public-first.md'),'utf8').trim()).toBe('SYNTHETIC_FIRST');
  await ctx.win.screenshot({path:join(out,'public-activity.png')});
  writeFileSync(join(out,'public-activity.json'),JSON.stringify({status:'PASS',kind:trial?'trial':'classroom',synthetic:true,created:true,revised:true,originalPreserved:true,turns},null,2));
 }finally{await closeApp(ctx);}
});
