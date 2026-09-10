import {test,expect} from '@playwright/test';
import {launchApp,closeApp,startFrame,chatFrame} from '../fixtures/app';
import {existsSync,readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

for(const legacy of [false,true])test('ambiguous start without file tools: '+(legacy?'existing file':'empty folder'),async()=>{
 test.setTimeout(180000);const ctx=await launchApp({preseedToken:true,stayOnStart:true});const out=join(process.env.HPS_NATIVE_EVIDENCE_DIR!,legacy?'existing':'empty');mkdirSync(out,{recursive:true});
 const seed='<!doctype html><html><body><h1>보존해야 하는 이전 작업</h1></body></html>';
 try{
  if(legacy)writeFileSync(join(ctx.wsDir,'index.html'),seed);
  const start=await startFrame(ctx.win);await start.getByRole('button',{name: /^(?:이어서 하기|수업 시작하기)$/}).click();
  const chat=await chatFrame(ctx.win);await chat.getByRole('combobox',{name:'대화 모델'}).selectOption('claude-opus-5');
  const input=chat.getByRole('textbox',{name:/보낼 메시지/});const prompt='해야 할 일은 있는데 어디서 시작할지 모르겠어';await input.fill(prompt);await input.press('Enter');
  await expect(chat.locator('.hps-btn-stop')).toBeVisible();await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:120000});await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
  const tools=await chat.locator('.hps-tool-label').allTextContents();expect(tools.filter(t=>/^(Read|Write|Edit|Glob|Grep|Bash|mcp__)/.test(t))).toEqual([]);
  const text=await chat.locator('.hps-msg-assistant').last().innerText();expect(text.length).toBeGreaterThan(10);expect(text).not.toMatch(/index\.html|시작용 빈 페이지/);
  if(legacy)expect(readFileSync(join(ctx.wsDir,'index.html'),'utf8')).toBe(seed);else expect(existsSync(join(ctx.wsDir,'index.html'))).toBe(false);
  writeFileSync(join(out,'result.json'),JSON.stringify({synthetic:true,prompt,reply:text,tools,files:readdirSync(ctx.wsDir),result:'PASS'},null,2));await ctx.win.screenshot({path:join(out,'screen.png')});
 }finally{await closeApp(ctx);}
});

test('explicit document then web request chooses its own file format',async()=>{
 test.setTimeout(300000);const ctx=await launchApp({preseedToken:true,stayOnStart:true});const out=join(process.env.HPS_NATIVE_EVIDENCE_DIR!,'formats');mkdirSync(out,{recursive:true});const turns:any[]=[];
 try{
  const start=await startFrame(ctx.win);await start.getByRole('button',{name: /^(?:이어서 하기|수업 시작하기)$/}).click();const chat=await chatFrame(ctx.win);
  await chat.getByRole('combobox',{name:'대화 모델'}).selectOption('hypeproof-fast');const input=chat.getByRole('textbox',{name:/보낼 메시지/});
  for(const [name,prompt] of [['walk.md','오늘 산책 준비물 3개를 짧은 Markdown 문서 walk.md로 저장해줘. 물, 운동화, 모자를 포함해줘.'],['index.html','이제 작은 웹페이지를 만들어줘. 제목은 산책 준비, 물·운동화·모자를 보여주는 index.html 파일을 저장해줘. 배포나 브라우저 열기는 하지마.']]){
   await input.fill(prompt);await input.press('Enter');await expect(chat.locator('.hps-btn-stop')).toBeVisible();await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:120000});await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
   await expect.poll(()=>existsSync(join(ctx.wsDir,name))).toBe(true);const content=readFileSync(join(ctx.wsDir,name),'utf8');for(const item of ['물','운동화','모자'])expect(content).toContain(item);
   if(name==='walk.md')expect(existsSync(join(ctx.wsDir,'index.html'))).toBe(false);
   turns.push({prompt,file:name,content,reply:await chat.locator('.hps-msg-assistant').last().innerText(),tools:await chat.locator('.hps-tool-label').allTextContents()});writeFileSync(join(out,name),content);await ctx.win.screenshot({path:join(out,name+'.png')});
  }
  expect(readFileSync(join(ctx.wsDir,'walk.md'),'utf8')).toBe(turns[0].content);expect(turns.at(-1).tools.some((t:string)=>t.startsWith('Write'))).toBe(true,'tool detector positive control');
 }finally{writeFileSync(join(out,'result.json'),JSON.stringify({synthetic:true,turns},null,2));await closeApp(ctx);}
});
