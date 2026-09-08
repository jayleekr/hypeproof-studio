// Feature A cases for the existing actual-app lesson runner. Synthetic lessons,
// real authoring/profile routes. No replacement UI, profile injection, or DOM mocks.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';

export async function prepareIdentity(local){
 const content={schema:'hps-session-design/1',title:'합성 홈페이지 강의',audience:'성인 합성 사용자',duration_minutes:60,objective:'화면을 검수하고 수정 이유를 설명한다',prerequisites:'',starter:'빈 연습 폴더',steps:[{id:'create',title:'홈페이지 첫 화면',instructions:'가상 꽃집 홈페이지를 만들어 주세요.',hint:'영업시간을 구분하세요.',acceptance:'390px와 1280px에서 확인'}]};
 const request=async(path,method='GET',body,token=local.token)=>{
  const r=await local.fetcher(local.origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(r.status,200,method+' '+path+' status');return r.json();
 };
 const cases={};
 for(const [key,name] of Object.entries({a:'제작 파트너',b:'검토 도우미',long:'긴이름'.repeat(13)+'끝',html:'<b>제작</b> & "파트너"',legacy:null})){
  const path='/admin/cohorts/'+local.cohort+'/authoring/identity-'+key;
  const lesson={...content,...(name?{assistant:{display_name:name}}:{})};
  await request(path,'PUT',{profile_id:local.profileId,expected_revision:0,request_id:'identity-'+key,content:lesson});
  await request(path+'/versions/m2026.09.08-1','PUT',{expected_revision:1});
  const invite=await request(path+'/versions/m2026.09.08-1/participants','POST',{user:'synthetic-lesson-student',hours:1});
  if(key==='a')await request(path,'PUT',{profile_id:local.profileId,expected_revision:1,request_id:'identity-rename',content:{...lesson,assistant:{display_name:'초안에서만 바꾼 이름'}}});
  const profile=await request('/v1/profile','GET',undefined,invite.token);
  if(name){assert.equal(profile.ux.coach.naming_mode,'fixed');assert.equal(profile.ux.coach.fallback_name,name);assert.equal(profile.lesson.sha256,invite.lesson.sha256);}
  cases[key]={token:invite.token,name:name||profile.ux.coach.fallback_name,profile};
 }
 for(const item of Object.values(cases))for(const key of ['sdk_tools','coach_runtime','browser','model','models'])assert.deepEqual(item.profile[key],cases.legacy.profile[key],'identity changes '+key);
 return cases;
}

export async function verifyIdentity({app,window,findContext,cases,out,live,setFault,setZoom}){
 const checks=[];
 const problems=[];
 const record=(id,detail)=>{checks.push({id,status:'PASS',...detail});writeFileSync(out+'/identity-result.json',JSON.stringify({status:'IN_PROGRESS',scope:'actual Mac app + local Service/SQLite; synthetic lessons',checks},null,2));};
 const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;do{const result=await fn();if(result)return result;await window.waitForTimeout(250);}while(Date.now()<end);throw Error('Timed out: '+label);};
 const frame=selector=>wait(()=>findContext(selector),'frame '+selector);
 const shot=async name=>{const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));writeFileSync(out+'/'+name+'.png',Buffer.from(png,'base64'));};
 const text=(c,selector)=>c.evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent');
 const click=(c,selector)=>c.evaluate('document.querySelector('+JSON.stringify(selector)+')?.click()');
 const fill=async(c,selector,value)=>c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
 const key=async(c,key,code=key,extra={})=>{await c.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,...extra});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,...extra});};
 const assertName=async(name)=>{
  const c=await frame('.hps-coach-name');await wait(async()=>await text(c,'.hps-coach-name')===name,'resolved header '+name);
  assert.equal(await c.evaluate("document.querySelector('.hps-coach-name').title"),'이 수업의 AI 이름: '+name);
  await click(c,'.hps-coach-name');assert.equal(await c.evaluate("!!document.querySelector('.hps-naming')"),false);
  return c;
 };
 const connect=async(which)=>{
  const chat=await frame('.hps-coach-name');await click(chat,'.hps-actions button[title="연결된 수업 확인 및 변경"]');
  const entry=await frame('.studio-start');
  await entry.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='다른 수업에 연결')?.click()");
  await wait(()=>entry.evaluate("!!document.querySelector('#course-code')"),'course code input');
  await fill(entry,'#course-code',cases[which].token);
  await wait(()=>entry.evaluate("!document.querySelector('form button[type=submit]').disabled"),'code can submit');
  await click(entry,'form button[type=submit]');
  await wait(()=>entry.evaluate("!!document.querySelector('.studio-course')"),'connected course');
  assert.ok((await text(entry,'.studio-course')).includes(cases[which].name));
  // No screenshots during credential entry. React has removed that field here.
  assert.equal(await entry.evaluate("!!document.querySelector('#course-code')"),false);
  await click(entry,'.studio-primary');
  return assertName(cases[which].name);
 };
 try{
  const entry=await frame('.studio-course');
  assert.ok((await text(entry,'.studio-course')).includes(cases.a.name));
  await click(entry,'.studio-primary');
  let chat=await assertName(cases.a.name);
  await shot('a-fixed-name');
  record('A1',{frozen_name:cases.a.name,draft_name:'초안에서만 바꾼 이름',lesson:cases.a.profile.lesson,authoring:'Service API; browser authoring is a separate run'});
  record('A2-header',{name:cases.a.name,stored_alias:'연습 코치',fixed_title:true});
  const composer='.hps-input textarea';
  if(live){
   await fill(chat,composer,'합성 검수입니다. 도구를 사용하지 말고 현재 수업에서 정한 당신의 이름만 한 문장으로 답하세요.');
   await key(chat,'Enter','Enter',{windowsVirtualKeyCode:13});
   await wait(()=>chat.evaluate("!!document.querySelector('.hps-btn-stop')"),'live turn started');
   await wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'live turn finished',120000);
   assert.equal(await chat.evaluate("!!document.querySelector('.hps-error-banner')"),false,'real turn shows error');
   const answer=await text(chat,'.hps-msg-assistant .hps-msg-body');assert.ok(answer?.includes(cases.a.name),'model did not use the lesson name');
   assert.equal(await text(chat,'.hps-msg-assistant .hps-msg-role > span'),cases.a.name);
   await shot('a-live-answer');record('A2-answer',{label:cases.a.name,answer,real_model:true});
  }
  for(const which of ['b','a','a']){chat=await connect(which);await shot('switch-'+which+'-'+checks.length);record('A3-'+which+'-'+checks.length,{name:cases[which].name,model_tools_unchanged:true});}
  chat=await connect('html');assert.equal(await chat.evaluate("document.querySelector('.hps-coach-name').childElementCount"),0);await shot('html-literal-name');record('A5-text',{literal:cases.html.name});
  chat=await connect('long');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1800,height:1000}));
  await window.waitForTimeout(400);
  for(const width of [390,1280]){
   // Resize the real workbench sash, never CSS-edit or emulate the product DOM.
   for(let attempt=0;attempt<4;attempt++){
    const current=await chat.evaluate('innerWidth');if(current===width)break;
    const box=await window.locator('.part.sidebar').boundingBox();assert.ok(box,'native sidebar missing');
    await window.mouse.move(box.x+box.width,box.y+box.height/2);await window.mouse.down();await window.mouse.move(box.x+box.width+width-current,box.y+box.height/2,{steps:12});await window.mouse.up();await window.waitForTimeout(300);
   }
   const metrics=await chat.evaluate(`(()=>{const n=document.querySelector('.hps-coach-name'),a=document.querySelector('.hps-actions'),r=n.getBoundingClientRect(),s=a.getBoundingClientRect();return {width:innerWidth,document_width:document.documentElement.scrollWidth,name:n.textContent,title:n.title,name_width:r.width,actions_right:s.right,overlap:r.right>s.left+1,ellipsized:n.scrollWidth>n.clientWidth};})()`);
   metrics.overflow_elements=await chat.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).slice(0,12)");
   await shot('long-name-'+width);
   assert.equal(metrics.width,width,'native chat viewport differs from requested width');
   const passes=!metrics.overlap&&metrics.actions_right<=metrics.width&&metrics.document_width<=metrics.width;
   if(!passes)problems.push('A5-width-'+width);
   record('A5-width-'+width,{...metrics,status:passes?'PASS':'FAIL'});
  }
  // Use the real Studio setting so the workbench also relayouts. Calling
  // Electron setZoomFactor alone bypasses VS Code's layout state.
  setZoom(2);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-2)<0.01,'Studio 200% zoom setting');await window.waitForTimeout(500);
  const zoom=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  chat=await frame('.hps-coach-name');await chat.evaluate("document.querySelector('.hps-actions button').focus()");await key(chat,'Tab','Tab',{windowsVirtualKeyCode:9});
  const focus=await chat.evaluate("({tag:document.activeElement.tagName,text:document.activeElement.textContent,visible:document.activeElement.getBoundingClientRect().right<=innerWidth})");
  await shot('long-name-zoom-200');assert.equal(focus.tag,'BUTTON');assert.equal(focus.visible,true);record('A5-zoom-keyboard',{zoom,focus,full_name_keyboard_access:'NOT VERIFIED; header is a non-focusable strong element'});
  setZoom(1);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-1)<0.01,'Studio normal zoom setting');
  chat=await connect('legacy');await shot('legacy-default-name');record('A4-legacy',{name:cases.legacy.name,width:await chat.evaluate('innerWidth'),document_width:await chat.evaluate('document.documentElement.scrollWidth')});
  chat=await connect('a');
  if(live)for(const mode of ['400','stall']){
   setFault(mode);const prompt='합성 '+mode+' 검수: 실패 후 이 요청과 수업 이름을 보존해 주세요.';
   await fill(chat,composer,prompt);await key(chat,'Enter','Enter',{windowsVirtualKeyCode:13});
   await wait(()=>chat.evaluate("!!document.querySelector('.hps-btn-stop')"),'fault turn started');
   const unsent='아직 보내지 않은 후속 입력 '+mode;await fill(chat,composer,unsent);
   if(mode==='stall')await click(chat,'.hps-btn-stop');
   await wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'fault turn stopped',45000);
   assert.equal(await text(chat,'.hps-coach-name'),cases.a.name);
   assert.ok((await text(chat,'.hps-messages')).includes(prompt),'submitted input disappeared');
   const draft=await chat.evaluate("document.querySelector('.hps-input textarea').value");assert.equal(draft,unsent,'unsent follow-up input disappeared');
   if(mode==='400')assert.equal(await chat.evaluate("!!document.querySelector('.hps-error-banner')"),true,'failure was not disclosed');
   await shot('failure-'+mode);record('A6-'+mode,{identity_preserved:true,submitted_message_preserved:true,unsent_followup_preserved:true,synthetic_gateway_fault:true});setFault('none');
  }
  writeFileSync(out+'/identity-result.json',JSON.stringify({status:problems.length?'FAIL':'PASS_EXECUTED_CASES',scope:'actual Mac app + local Service/SQLite; synthetic lessons',checks,failures:problems,not_run:['history identity at time of execution','all AI naming surfaces','screen reader','Windows',...(!live?['actual answer','failure and Stop']:[])],visual_review:'PENDING separate screenshot inspection'},null,2));
  if(problems.length)process.exitCode=1;
  console.log(problems.length?'FAIL feature A viewport acceptance; remaining independent cases recorded':'PASS feature A executed checks; screenshot review and unexecuted scope remain separate');
 }catch(error){
  await shot('identity-failure').catch(()=>{});
  writeFileSync(out+'/identity-result.json',JSON.stringify({status:'FAIL',checks,error:error.message,visual_review:'PENDING'},null,2));throw error;
 }
}
