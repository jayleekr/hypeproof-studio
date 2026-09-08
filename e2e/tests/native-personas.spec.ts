import { test, expect } from '@playwright/test';
import { launchApp, closeApp, startFrame, chatFrame } from '../fixtures/app';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const suite=JSON.parse(readFileSync(new URL('../personas/trial-personas.json',import.meta.url),'utf8'));
const codex=process.env.HPS_CODEX_REHEARSAL==='1';
const selected=process.env.HPS_PERSONA_IDS?.split(',');

for(const persona of suite.personas.filter((p:any)=>!selected||selected.includes(p.id))) {
 test(`${persona.id}: ${persona.name}`, async()=>{
  test.setTimeout(300000);
  const ctx=await launchApp({preseedToken:true,stayOnStart:true});
  const out=join(process.env.HPS_NATIVE_EVIDENCE_DIR!,persona.id);mkdirSync(out,{recursive:true});
  const record:any={id:persona.id,persona:persona.name,requirements:persona.requirements,acceptance:persona.acceptance,
    backend:codex?'Codex ChatGPT / GPT practice':'Anthropic API / native trial',synthetic:true,transport:'RUNNING',semantic_review:'PENDING',turns:[]};
  try{
   expect(await ctx.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isFocusable()))).toBe(true);
   const start=await startFrame(ctx.win);await start.getByRole('button',{name:'수업 시작하기'}).click();
   const chat=await chatFrame(ctx.win), input=chat.getByRole('textbox',{name:/보낼 메시지/});
   const selector=chat.getByRole('combobox',{name:'대화 모델'});
   await selector.selectOption(codex?(persona.model??'gpt-5.6-luna'):'hypeproof-fast');
   record.model=await selector.inputValue();
   const upstreamCount=()=>{const path=join(process.env.HPS_NATIVE_EVIDENCE_DIR!,'api-evidence.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')).calls.length:0;};
   const fault=async(value:string)=>{
    const response=await fetch(process.env.HPS_E2E_PROXY_URL!.replace(/\/v1\/?$/, '')+'/__test/fault',{method:'POST',headers:{authorization:'Bearer '+ctx.token},body:value});
    expect(response.status).toBe(204);
   };
   for(let index=0;index<persona.turns.length;index++){
    const prompt=persona.turns[index];
    const beforeCalls=upstreamCount();
    if(persona.fault)await fault('503');
    await input.fill(prompt);await expect(chat.locator('.hps-attachments')).toHaveCount(0);
    const began=Date.now();await input.press('Enter');
    // A controlled error may finish before the busy element is observed.
    if(!persona.fault)await expect(chat.locator('.hps-btn-stop')).toBeVisible();
    await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:120000});
    if(persona.fault){
     await expect(chat.locator('.hps-error-banner')).toBeVisible();
     await ctx.win.screenshot({path:join(out,'controlled-503.png')});
     expect(upstreamCount()).toBe(beforeCalls);
     record.failed_upstream_calls=0;
     record.failed_attempt=await chat.locator('.hps-messages').innerText();
     await fault('none');await chat.getByRole('button',{name:'다시 보내기',exact:true}).click();
     await expect(chat.locator('.hps-btn-stop')).toBeVisible();
     await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:120000});
    }
    record.turns.push({prompt,elapsed_ms:Date.now()-began,screen:await chat.locator('.hps-messages').innerText()});
    await ctx.win.screenshot({path:join(out,`turn-${index+1}.png`)});
    await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
    if(persona.fault){expect(upstreamCount()-beforeCalls).toBe(1);expect(await chat.locator('.hps-msg-user').filter({hasText:prompt}).count()).toBe(1);record.retry_upstream_calls=1;}
    if(persona.artifact){
     const run=chat.locator('.hps-msg-run').last();
     await expect(run).toBeVisible();await run.click();
     await expect.poll(()=>existsSync(join(ctx.wsDir,'index.html'))).toBe(true);
     await expect.poll(()=>readFileSync(join(ctx.wsDir,'index.html'),'utf8')).toContain(index===0?'18:00':'19:00');
     const html=readFileSync(join(ctx.wsDir,'index.html'),'utf8');
     writeFileSync(join(out,`version-${index+1}.html`),html);
     expect(html).toContain('봄빛');expect(html).toContain('계절의 꽃을 전합니다');expect(html).toContain('10:00');
     expect(html).toContain(index===0?'18:00':'19:00');
     const getUrls=()=>ctx.app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>w.getURL()).filter(u=>/^http:\/\/127\.0\.0\.1:/.test(u)));
     await expect.poll(getUrls).not.toHaveLength(0);const urls=await getUrls();const res=await fetch(urls[0]);expect(res.status).toBe(200);
     expect(await res.text()).toContain(index===0?'18:00':'19:00');
     record.turns[index].local_url=urls[0];
     await ctx.win.screenshot({path:join(out,`preview-${index+1}.png`)});
    }
   }
   record.transport='PASS';
  }catch(error){record.transport='FAIL';record.error=error instanceof Error?error.message:String(error);throw error;}
  finally{writeFileSync(join(out,'result.json'),JSON.stringify(record,null,2));await closeApp(ctx);}
 });
}
