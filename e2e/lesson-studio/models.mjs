import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';

export async function prepareModels(local) {
 const cases={};
 const catalogueResponse=await local.fetcher(local.origin+'/admin/cohorts/'+local.cohort+'/authoring/model-choice/models/'+local.profileId,{headers:{authorization:'Bearer '+local.token}});
 assert.equal(catalogueResponse.status,200);const catalogue=await catalogueResponse.json();
 for(const mode of ['choice','fixed']){
  const content={schema:'hps-session-design/1',title:'모델 선택 · 가상 꽃집',audience:'성인 합성 사용자',duration_minutes:60,objective:'같은 대화를 유지하며 모델을 선택한다',prerequisites:'',starter:'빈 연습 폴더',steps:[{id:'one',title:'소개',instructions:'가상 꽃집을 소개하세요.',hint:'',acceptance:'앞서 제공한 이름 유지'}],assistant:{display_name:'제작 파트너'},model:{default:'hypeproof-default',allowed:mode==='fixed'?['hypeproof-default']:catalogue.choices.map(c=>c.alias)}};
  const base='/admin/cohorts/'+local.cohort+'/authoring/model-'+mode;
  const call=async(path,method,body)=>{const r=await local.fetcher(local.origin+path,{method,headers:{authorization:'Bearer '+local.token,'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;};
  await call(base,'PUT',{profile_id:local.profileId,expected_revision:0,request_id:'create-'+mode,content});
  const frozen=await call(base+'/versions/m2026.09.08-1','PUT',{expected_revision:1});
  cases[mode]={...await call(base+'/versions/m2026.09.08-1/participants','POST',{user:'synthetic-lesson-student',hours:1}),policy:frozen.module.content.model};
 }
 return cases;
}

export async function verifyModels({app,window,findContext,cases,out,live,upstream,gatewayCalls,setZoom}) {
 const checks=[];
 const save=(status,error)=>writeFileSync(out+'/model-selection-result.json',JSON.stringify({status,checks,error,scope:'actual Mac + local Service + synthetic lessons',live_model_requested:live,not_run:['Windows','screen reader speech','human learning','cross-provider transfer'],visual_review:'PENDING'},null,2));
 const record=(id,data)=>{checks.push({id,...data});save('IN_PROGRESS');};
 const wait=async(fn,label,ms=20000)=>{const until=Date.now()+ms;while(Date.now()<until){const x=await fn();if(x)return x;await window.waitForTimeout(200);}throw Error('Timed out: '+label);};
 const frame=s=>wait(()=>findContext(s),'frame '+s);
 const shot=async name=>{await window.waitForTimeout(500);const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));writeFileSync(out+'/'+name+'.png',Buffer.from(png,'base64'));};
 const fill=(c,s,v)=>c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(v)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 const choose=async(c,alias)=>{await fill(c,'select[aria-label="대화 모델"]',alias);await wait(()=>c.evaluate(`document.querySelector('select[aria-label="대화 모델"]').value===${JSON.stringify(alias)}`),'selected '+alias);await window.waitForTimeout(200);};
 const input='.hps-input textarea';
 try {
  const entry=await frame('.studio-course');await entry.evaluate("document.querySelector('.studio-primary').click()");
  let chat=await frame('.hps-model-selection');
  const initial=await chat.evaluate("({selected:document.querySelector('select[aria-label=\"대화 모델\"]').value,options:[...document.querySelector('select[aria-label=\"대화 모델\"]').options].map(x=>x.textContent),name:document.querySelector('.hps-coach-name').textContent})");
  assert.equal(initial.selected,'hypeproof-default');assert.equal(initial.options.length,cases.choice.policy.binding.choices.length);assert.equal(initial.name,'제작 파트너');record('selection',initial);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1800,height:1000}));await window.waitForTimeout(300);
  for(const width of [390,1280]){
   // The actual editor window has a 400px minimum. Use Studio's real zoom
   // setting for 390 CSS px; never bypass its minimum or emulate the webview.
   const factor=width===390?2:1;
   setZoom(factor);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-factor)<0.01,'viewport zoom');await window.waitForTimeout(300);
   for(let n=0;n<4;n++){const current=await chat.evaluate('innerWidth');if(current===width)break;await app.evaluate(({BrowserWindow},delta)=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({width:w.getBounds().width+delta});},Math.round((width-current)*factor));await window.waitForTimeout(200);}
   const metrics=await chat.evaluate("({width:innerWidth,document_width:document.documentElement.scrollWidth,select_right:document.querySelector('.hps-model-selection select').getBoundingClientRect().right})");assert.equal(metrics.width,width);assert.equal(metrics.document_width,width);assert.ok(metrics.select_right<=width);record('width-'+width,{...metrics,zoom:factor});await shot('model-'+width);
  }
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();});
  await chat.evaluate("window.focus();document.querySelector('.hps-model-selection select').focus();window.modelKeys=[];document.addEventListener('keydown',e=>window.modelKeys.push({key:e.key,target:e.target.tagName}));document.addEventListener('change',e=>window.modelKeys.push({change:e.target.value}));");
  await window.keyboard.press('ArrowDown');await window.waitForTimeout(250);
  record('keyboard-events',await chat.evaluate("({focus:document.hasFocus(),active:document.activeElement.tagName,events:window.modelKeys,value:document.querySelector('.hps-model-selection select').value})"));
  await wait(()=>chat.evaluate("document.querySelector('.hps-model-selection select').value==='hypeproof-fast'"),'keyboard choice');
  const {result:axObject}=await chat.send('Runtime.evaluate',{expression:"document.querySelector('.hps-model-selection select')",contextId:chat.contextId,returnByValue:false});
  const {node:axNode}=await chat.send('DOM.describeNode',{objectId:axObject.objectId});
  const ax=(await chat.send('Accessibility.getPartialAXTree',{backendNodeId:axNode.backendNodeId,fetchRelatives:false})).nodes[0];
  await chat.send('Runtime.releaseObject',{objectId:axObject.objectId});
  assert.equal(ax.name.value,'대화 모델');assert.equal(ax.ignored,false);record('keyboard-and-accessible-name',{role:ax.role.value,name:ax.name.value,selected:'hypeproof-fast'});await shot('model-keyboard-selection');
  await choose(chat,'hypeproof-default');
  setZoom(2);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-2)<0.01,'200% zoom');await window.waitForTimeout(500);
  const enlarged=await chat.evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,right:document.querySelector('.hps-model-selection select').getBoundingClientRect().right,bottom:document.querySelector('.hps-model-selection select').getBoundingClientRect().bottom,height:innerHeight})");assert.equal(enlarged.scroll,enlarged.width);assert.ok(enlarged.right<=enlarged.width);assert.ok(enlarged.bottom<=enlarged.height);record('zoom-200',enlarged);await shot('model-zoom-200');
  setZoom(1);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-1)<0.01,'normal zoom');await window.waitForTimeout(300);
  await fill(chat,input,'아직 보내지 않은 초안');await choose(chat,'hypeproof-fast');assert.equal(await chat.evaluate("document.querySelector('.hps-input textarea').value"),'아직 보내지 않은 초안');await choose(chat,'hypeproof-default');record('draft-preserved',{pass:true});
  if(live){
   const send=async(prompt,expected,switchDuring,requestedAlias)=>{
    const apiStart=upstream.length,gateStart=gatewayCalls.length;
    await fill(chat,input,prompt);await chat.evaluate("document.querySelector('.hps-input textarea').focus()");
    await chat.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await chat.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await wait(()=>chat.evaluate("!!document.querySelector('.hps-btn-stop')"),'turn started');
    if(switchDuring){await fill(chat,input,'진행 중 작성한 초안');await choose(chat,switchDuring);assert.ok((await chat.evaluate("document.querySelector('.hps-model-selection').textContent")).includes('다음 요청'));}
    await wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'turn complete',150000);
    assert.equal(await chat.evaluate("!!document.querySelector('.hps-error-banner')"),false);
    await wait(()=>upstream.slice(apiStart).every(c=>c.status!==null),'all started provider requests settled',95000);
    const calls=upstream.slice(apiStart).filter(c=>c.path==='/v1/messages');
    const gateway=gatewayCalls.slice(gateStart).filter(c=>!c.path.includes('count_tokens'));
    assert.ok(calls.length>0&&calls.every(c=>c.status===200&&c.model===expected),'every upstream call must use the captured turn model');
    const alias=requestedAlias??(expected==='claude-haiku-4-5'?'hypeproof-fast':'hypeproof-default');
    assert.ok(gateway.length>0&&gateway.every(c=>c.requested_model===alias),'gateway must receive the selected alias throughout the turn');
    if(switchDuring)assert.equal(await chat.evaluate("document.querySelector('.hps-input textarea').value"),'진행 중 작성한 초안');
    record('actual-turn',{expected_model:expected,upstream:calls,gateway});
   };
   await send('가상 꽃집 이름은 민트플라워입니다. 도구를 쓰지 말고 이 이름을 포함해 짧은 소개 한 문장만 답해 주세요.','claude-sonnet-4-6','hypeproof-fast');
   await send('앞서 알려준 가상 꽃집 이름을 그대로 사용해 더 짧게 소개해 주세요. 도구는 쓰지 마세요.','claude-haiku-4-5');
   assert.ok((await chat.evaluate("[...document.querySelectorAll('.hps-msg-assistant .hps-msg-body')].at(-1).textContent")).includes('민트플라워'));await shot('model-switched-conversation');
   for(const choice of cases.choice.policy.binding.choices.filter(c=>!['hypeproof-default','hypeproof-fast'].includes(c.alias))){
    await choose(chat,choice.alias);
    await send('앞서 알려준 꽃집 이름만 답해 주세요. 도구는 쓰지 마세요.',choice.id,undefined,choice.alias);
    assert.ok((await chat.evaluate("[...document.querySelectorAll('.hps-msg-assistant .hps-msg-body')].at(-1).textContent")).includes('민트플라워'));
    if(choice.id==='claude-sonnet-5'||choice.id==='claude-opus-5')await shot(choice.id);
   }
  }
  if(!live)await choose(chat,'hypeproof-fast');
  // Reconnect to a distinct frozen fixed-model lesson through the real onboarding form.
  await chat.evaluate("document.querySelector('.hps-actions button[title=\"연결된 수업 확인 및 변경\"]').click()");
  const start=await frame('.studio-start');await start.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='다른 수업에 연결').click()");await wait(()=>start.evaluate("!!document.querySelector('#course-code')"),'code input');
  await fill(start,'#course-code',cases.fixed.token);await wait(()=>start.evaluate("!document.querySelector('form button[type=submit]').disabled"),'submit code');await start.evaluate("document.querySelector('form button[type=submit]').click()");await wait(()=>start.evaluate("!!document.querySelector('.studio-course')"),'fixed lesson');await start.evaluate("document.querySelector('.studio-primary').click()");
  chat=await frame('.hps-model-selection');await wait(()=>chat.evaluate("document.querySelector('.hps-model-selection select').disabled"),'fixed model');
  assert.equal(await chat.evaluate("document.querySelector('.hps-model-selection select').value"),'hypeproof-default');record('fixed-lesson',{pass:true,previous_choice_not_inherited:true});await shot('model-fixed');
  save('PASS_EXECUTED_CASES');console.log('PASS native model selection: choice, draft, next request, fixed lesson; see recorded execution scope');
 } catch(e){await shot('model-failure').catch(()=>{});save('FAIL',e.message);throw e;}
}
