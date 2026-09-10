import {test,expect} from '@playwright/test';
import {launchApp,closeApp,startFrame,chatFrame} from '../fixtures/app';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';

test('actual folder switch A to B to A preserves drafts and rejects a shared root',async()=>{
 test.setTimeout(process.env.HPS_UNIFIED_LIVE==='1'?300000:120000);
 const live=process.env.HPS_UNIFIED_LIVE==='1',managed=process.env.HPS_NATIVE_MANAGED==='1',turns:any[]=[];
 let ctx=await launchApp({preseedToken:false,stayOnStart:true,simpleFileDialog:true,persistentTestSecrets:true});
 const out=process.env.HPS_NATIVE_EVIDENCE_DIR!;
 const storage=await ctx.app.evaluate(({app,safeStorage})=>({name:app.getName(),encrypted:safeStorage.isEncryptionAvailable()}));
 console.log('Synthetic storage:',storage);expect(storage.encrypted).toBe(true);
 const second=join(ctx.userDataDir,'activity-b');mkdirSync(second);
 const alternate=readFileSync(process.env.HPS_E2E_TOKEN_FILE+'.alternate','utf8').trim();
 const pick=async(root:string)=>{
  const start=await startFrame(ctx.win);await start.getByRole('button',{name:'다른 작업 폴더 선택',exact:true}).click();
  const dialog=ctx.win.locator('.quick-input-widget');await dialog.locator('input.input').fill(root+'/');
  await dialog.getByRole('button',{name:'이 활동의 작업 폴더 선택',exact:true}).click();
 };
 const connect=async(token:string)=>{
  const start=await startFrame(ctx.win);
  if(await start.getByRole('button',{name:'다른 활동 선택',exact:true}).count())await start.getByRole('button',{name:'다른 활동 선택',exact:true}).click();
  await start.getByRole('button',{name:managed?'AI 체험하기':'수업에 참여하기',exact:true}).click();
  await start.getByLabel(managed?'체험 참여 코드':'수업 참여 코드',{exact:true}).fill(token);
  await start.getByRole('button',{name:'코드 확인하기',exact:true}).click();
  await expect(start.getByRole('button',{name:'이 활동 시작하기',exact:true})).toBeVisible();
 };
 const begin=async()=>{const start=await startFrame(ctx.win);await start.getByRole('button',{name:'이 활동 시작하기',exact:true}).click();};
 const turn=async(chat:Awaited<ReturnType<typeof chatFrame>>,root:string,marker:string)=>{
  await chat.getByRole('combobox',{name:'대화 모델'}).selectOption('hypeproof-fast');
  const prompt=`합성 릴리스 검사입니다. 이 폴더에 acceptance.md 파일을 만들고 내용은 ${marker} 한 줄만 넣어 주세요. 다른 파일을 읽거나 바꾸지 말고, 셸·브라우저·네트워크 도구도 사용하지 마세요.`;
  const input=chat.getByRole('textbox',{name:/보낼 메시지/});await input.fill(prompt);await input.press('Enter');
  await expect(chat.locator('.hps-btn-stop')).toBeVisible();await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:100000});
  await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
  await expect.poll(()=>existsSync(join(root,'acceptance.md'))).toBe(true);
  expect(readFileSync(join(root,'acceptance.md'),'utf8').trim()).toBe(marker);
  turns.push({prompt,reply:await chat.locator('.hps-msg-assistant').last().innerText(),tools:await chat.locator('.hps-tool-label').allTextContents()});
 };
 try{
  writeFileSync(join(ctx.wsDir,'original-a.txt'),'synthetic activity A');
  writeFileSync(join(second,'original-b.txt'),'synthetic activity B');
  await connect(ctx.token);await pick(ctx.wsDir);await begin();
  let chat=await chatFrame(ctx.win);
  await expect(chat.getByLabel('현재 활동')).toContainText(process.env.HPS_NATIVE_MANAGED==='1'?'AI 체험':'수업');
  if(live)await turn(chat,ctx.wsDir,'SYNTHETIC_ACTIVITY_A_ONLY');
  await chat.getByRole('textbox',{name:/보낼 메시지/}).fill('A에서 작성 중인 합성 초안');
  await chat.getByRole('textbox',{name:/보낼 메시지/}).evaluate(input=>{
    const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
    const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
    const data=new DataTransfer();data.items.add(new File([bytes],'synthetic.png',{type:'image/png'}));
    input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  });
  await expect(chat.locator('.hps-attachment')).toHaveCount(1);
  await chat.getByRole('button',{name:'활동 변경',exact:true}).click();
  await connect(alternate);await pick(ctx.wsDir);await begin();
  const blocked=await startFrame(ctx.win);await expect(blocked.getByRole('alert')).toContainText('다른 활동');
  await ctx.win.screenshot({path:join(out,'shared-root-blocked.png')});
  await pick(second);
  const oldViews=await ctx.win.locator('iframe.webview').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('name')));
  await begin();
  await expect.poll(async()=>ctx.win.locator('iframe.webview').evaluateAll((nodes,old)=>nodes.filter(n=>old.includes(n.getAttribute('name'))).length,oldViews)).toBe(0);
  await expect.poll(()=>ctx.win.title()).toContain('activity-b');
  // A real window reload restores B's binding; no test token is preseeded.
  const bStart=await startFrame(ctx.win);
await bStart.getByRole('button',{name:'이어서 하기',exact:true}).click();
  chat=await chatFrame(ctx.win);
  await expect(chat.getByRole('textbox',{name:/보낼 메시지/})).toHaveValue('');
  await expect(chat.locator('.hps-attachment')).toHaveCount(0);
  if(live)await turn(chat,second,'SYNTHETIC_ACTIVITY_B_ONLY');
  await chat.getByRole('textbox',{name:/보낼 메시지/}).fill('B에서 작성 중인 합성 초안');
  await ctx.win.screenshot({path:join(out,'activity-b.png')});
  await chat.getByRole('button',{name:'활동 변경',exact:true}).click();
  const list=await startFrame(ctx.win);const saved=list.getByRole('navigation',{name:'저장된 활동'}).getByRole('button');
  await expect(saved).toHaveCount(2);await saved.filter({hasText:ctx.wsDir}).click();
  const bViews=await ctx.win.locator('iframe.webview').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('name')));await begin();
  await expect.poll(async()=>ctx.win.locator('iframe.webview').evaluateAll((nodes,old)=>nodes.filter(n=>old.includes(n.getAttribute('name'))).length,bViews)).toBe(0);
  await expect.poll(()=>ctx.win.title()).not.toContain('activity-b');
  const aStart=await startFrame(ctx.win);await aStart.getByRole('button',{name:'이어서 하기',exact:true}).click();
  chat=await chatFrame(ctx.win);await expect(chat.getByRole('textbox',{name:/보낼 메시지/})).toHaveValue('A에서 작성 중인 합성 초안');
  expect(readFileSync(join(ctx.wsDir,'original-a.txt'),'utf8')).toBe('synthetic activity A');
  expect(readFileSync(join(second,'original-b.txt'),'utf8')).toBe('synthetic activity B');
  expect(existsSync(join(ctx.wsDir,'index.html'))).toBe(false);expect(existsSync(join(second,'index.html'))).toBe(false);
  if(!live)expect(existsSync(join(out,'api-evidence.json'))).toBe(false);
  else {
    const calls=JSON.parse(readFileSync(join(out,'api-evidence.json'),'utf8')).calls;
    expect(calls.length).toBeGreaterThan(1);expect(calls.length).toBeLessThanOrEqual(8);
    const b=calls.filter((c:any)=>JSON.stringify(c.request).includes('SYNTHETIC_ACTIVITY_B_ONLY'));
    expect(b.length).toBeGreaterThan(0);for(const call of b)expect(JSON.stringify(call.request)).not.toContain('SYNTHETIC_ACTIVITY_A_ONLY');
    for(const call of calls)expect(call.status).toBe(200);
    writeFileSync(join(out,'unified-live-turns.json'),JSON.stringify({synthetic:true,turns,payload_isolation:true},null,2));
  }
  await expect(chat.locator('.hps-attachment')).toHaveCount(1);
  const userDataDir=ctx.userDataDir;await ctx.app.close();
  ctx=await launchApp({reuseUserDataDir:userDataDir,preseedToken:false,stayOnStart:true,persistentTestSecrets:true,simpleFileDialog:true});
  const restart=await startFrame(ctx.win);await restart.getByRole('button',{name:'이어서 하기',exact:true}).click();
  chat=await chatFrame(ctx.win);
  await expect(chat.getByRole('textbox',{name:/보낼 메시지/})).toHaveValue('A에서 작성 중인 합성 초안');
  await expect(chat.locator('.hps-attachment')).toHaveCount(1);
  await ctx.win.screenshot({path:join(out,'activity-a-restored.png')});
  writeFileSync(join(out,'unified-switch.json'),JSON.stringify({status:'PASS',synthetic:true,real_folder_reload:true,draft_round_trip:true,attachment_round_trip:true,process_restart:true,encrypted_storage:storage.encrypted,shared_root_blocked:true,original_files_preserved:true,live_model:live,model_calls:live?JSON.parse(readFileSync(join(out,'api-evidence.json'),'utf8')).calls.length:0,public_release:false},null,2));
 }catch(error){await ctx.win.screenshot({path:join(out,"failure.png"),timeout:3000}).catch(()=>{});throw error;}finally{await closeApp(ctx);}
});
