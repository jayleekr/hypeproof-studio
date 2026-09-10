import {test,expect} from '@playwright/test';
import {launchApp,closeApp,startFrame,chatFrame} from '../fixtures/app';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

test('adult model comparison: actual model picker, provider replies and usage receipts',async()=>{
 test.setTimeout(360000);
 test.skip(process.env.HPS_MODEL_REHEARSAL!=='1','requires isolated multi-provider fixture');
 const ctx=await launchApp({preseedToken:true,stayOnStart:true});
 const out=process.env.HPS_NATIVE_EVIDENCE_DIR!;
 const results:any[]=[];
 const receipts=()=>existsSync(join(out,'model-usage.json'))?JSON.parse(readFileSync(join(out,'model-usage.json'),'utf8')):[];
 try {
  const start=await startFrame(ctx.win);await start.getByRole('button',{name: /^(?:이어서 하기|수업 시작하기)$/}).click();
  const chat=await chatFrame(ctx.win),input=chat.getByRole('textbox',{name:/보낼 메시지/});
  const select=chat.getByRole('combobox',{name:'대화 모델'});
  await expect(select.locator('option')).toHaveCount(15);
  for(const model of ['glm-5.2','gemini-3.5-flash','claude-haiku-4-5','gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol']){
   await select.selectOption(model);
   const prompt='합성 연결 검사입니다. 오늘 산책을 시작하기 좋은 짧은 문장 하나를 한국어로 써주세요.';
   const before=receipts().length;
   await input.fill(prompt);await input.press('Enter');
   await expect.poll(()=>receipts().length,{timeout:100000}).toBe(before+1);
   await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:100000});
   const row=receipts().at(-1);expect(row.requested_model).toBe(model);expect(row.state).not.toBe('pending');
   const gpt=model.startsWith('gpt-');
   // Current account's live direct probe established credit_balance_exhausted.
   // Billing-blocked GPT is an observed BLOCKED outcome, never a success reply.
   if(gpt && process.env.HPS_EXPECT_GPT_CREDIT_BLOCK==='1'){
    expect(row.status).toBe(429);await expect(chat.locator('.hps-error-banner')).toBeVisible();
   }else{expect(row.status).toBe(200);expect(row.tokens_in).toBeGreaterThan(0);await expect(chat.locator('.hps-error-banner')).toHaveCount(0);}
   results.push({model,prompt,result:row.status===200?'PASS':'BLOCKED',receipt:row,screen:await chat.locator('.hps-messages').innerText()});
   await ctx.win.screenshot({path:join(out,model+'.png')});
  }
 }finally{writeFileSync(join(out,'model-results.json'),JSON.stringify({synthetic:true,results},null,2));await closeApp(ctx);}
});
