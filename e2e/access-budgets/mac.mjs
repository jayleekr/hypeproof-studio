import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,unlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {_electron as electron} from '@playwright/test';
import {budgetFixture} from './fixture.mjs';
const {budgetSubjectKey}=await import('../../worker/src/lib/budgets.ts');
const out=process.env.HPS_BUDGET_EVIDENCE_DIR||'/tmp/hps-856-evidence';mkdirSync(out,{recursive:true});
if(process.env.HPS_BUDGET_BUNDLED==='1'){for(const f of ['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css']){const candidate=process.env.HPS_APP_PATH.split('/Contents/MacOS/')[0]+'/Contents/Resources/app/extensions/hypeproof-chat/'+f;assert.equal(createHash('sha256').update(readFileSync(candidate)).digest('hex'),createHash('sha256').update(readFileSync(new URL('../../extensions/hypeproof-chat/'+f,import.meta.url))).digest('hex'),'candidate bundle '+f);}}
const h=await budgetFixture(),userDir=realpathSync(mkdtempSync(tmpdir()+'/hps-budget-mac-'));mkdirSync(userDir+'/User');mkdirSync(userDir+'/ws');
writeFileSync(userDir+'/ws/keep.txt','Existing work must survive a budget denial.');
const settings={"hypeproofChat.proxyUrl":h.serviceOrigin+'/v1',"workbench.startupEditor":"none","update.mode":"none","telemetry.telemetryLevel":"off","window.dialogStyle":"custom"};
writeFileSync(userDir+'/User/settings.json',JSON.stringify(settings));writeFileSync(userDir+'/User/hps-test-state.json',JSON.stringify({token:h.token,coach:{name:'AI 작업 파트너',personality:''}}),{mode:0o600});
let app,window;const sockets=[],checks=[];const port=9356;
const report=(pass,error)=>writeFileSync(out+'/mac-result.json',JSON.stringify({pass,error,checks,environment:'actual Mac shell with hash-verified candidate extension when HPS_BUDGET_BUNDLED=1; local Service/HMAC/SQLite; synthetic provider SSE',live_provider:false,upstream:h.upstream,source_files:['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css'].map(f=>({path:f,sha256:createHash('sha256').update(readFileSync(new URL('../../extensions/hypeproof-chat/'+f,import.meta.url))).digest('hex')}))},null,2));
try{
 const appEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD)/.test(key)));
 app=await electron.launch({executablePath:process.env.HPS_APP_PATH||'/Applications/HypeProof Studio.app/Contents/MacOS/HypeProof Studio',args:['--user-data-dir='+userDir,'--extensions-dir='+userDir+'/extensions',...(process.env.HPS_BUDGET_BUNDLED==='1'?[]:['--extensionDevelopmentPath='+resolve('extensions/hypeproof-chat')]),'--disable-workspace-trust','--use-inmemory-secretstorage','--disable-updates','--skip-welcome','--skip-release-notes','--remote-debugging-port='+port,'--folder-uri',pathToFileURL(userDir+'/ws').href],env:{...appEnv,HPS_TEST_E2E:'1'},timeout:30000});
 window=await app.firstWindow();await app.evaluate(({app,BrowserWindow})=>{app.dock?.hide();for(const w of BrowserWindow.getAllWindows()){w.setPosition(-4000,-4000);w.showInactive();}});
 const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await window.waitForTimeout(200);}throw Error('Timed out: '+label);};
 const shot=async name=>{const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));writeFileSync(out+'/'+name+'.png',Buffer.from(png,'base64'));};
 async function contexts(){const targets=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).filter(x=>x.type==='iframe'&&x.url.includes('hypeproof-chat'));const result=[];
  for(const target of targets){const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result);}};const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,[r,j]);ws.send(JSON.stringify({id:n,method,params}));});await send('Page.enable');const {frameTree}=await send('Page.getFrameTree');for(const f of [frameTree,...(frameTree.childFrames||[])]){const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:f.frame.id,worldName:'budget-observer'});result.push({send,evaluate:async expression=>(await send('Runtime.evaluate',{expression,contextId:executionContextId,returnByValue:true,awaitPromise:true})).result?.value});}}
  return result;
 }
 let chat;
 await wait(async()=>{for(const c of await contexts()){if(await c.evaluate("!!document.querySelector('.hps-access')")){chat=c;return true;}await c.evaluate("document.querySelector('.studio-primary')?.click()");}return false;},'access panel',30000);
 const fill=(selector,value)=>chat.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 await wait(()=>chat.evaluate("!!document.querySelector('.hps-access select')"),'funding choices');
 assert.equal(await chat.evaluate("document.querySelector('.hps-access select').value"),'');assert.equal(h.upstream.length,0);checks.push({id:'no-automatic-source',pass:true});
 await fill('.hps-input textarea','아직 보내지 않은 초안');await fill('.hps-access select',h.contract.contract_id);await wait(()=>chat.evaluate("document.querySelector('.hps-access select').value==='synthetic-class'"),'selected funding');
 assert.equal(await chat.evaluate("document.querySelector('.hps-input textarea').value"),'아직 보내지 않은 초안');
 await fill('select[aria-label="대화 모델"]','gpt-5.6-luna');await wait(()=>chat.evaluate("document.querySelector('select[aria-label=\"대화 모델\"]').value==='gpt-5.6-luna'"),'explicit entitled model');
 checks.push({id:'explicit-model-selection',model:'gpt-5.6-luna'});
 assert(await chat.evaluate("document.querySelector('.hps-access').open"),'source selection preserves the expanded usage panel');
 const setZoom=async factor=>{writeFileSync(userDir+'/User/settings.json',JSON.stringify({...settings,'window.zoomLevel':Math.log(factor)/Math.log(1.2)}));await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-factor)<.01,'actual app zoom');};
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1800,height:1000}));
 for(const width of [390,1280]){const factor=width===390?2:1;await setZoom(factor);await window.waitForTimeout(400);for(let n=0;n<5;n++){const current=await chat.evaluate('innerWidth');if(current===width)break;await app.evaluate(({BrowserWindow},delta)=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({width:w.getBounds().width+delta});},Math.round((width-current)*factor));await window.waitForTimeout(300);}const metric=await chat.evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,input_bottom:document.querySelector('.hps-input textarea').getBoundingClientRect().bottom,height:innerHeight})");assert.equal(metric.width,width);assert.equal(metric.scroll,width);assert(metric.input_bottom<=metric.height);checks.push({id:'actual-width-'+width,zoom:factor,...metric});await shot('mac-access-'+width);}
 await setZoom(1);
 await fill('.hps-input textarea','합성 예산 연결 확인');await chat.evaluate("document.querySelector('.hps-btn-send').click()");
 await wait(()=>h.upstream.length===1,'one paid attempt');await wait(()=>h.db.prepare("SELECT pricing_state FROM usage_attempt_costs LIMIT 1").get()?.pricing_state==='priced','settlement');
 await wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'turn finished');await wait(()=>chat.evaluate("document.querySelector('.hps-messages').textContent.includes('합성 응답')"),'visible response');
 const used=h.db.prepare('SELECT SUM(amount_micro) n FROM usage_attempt_costs').get().n;
 assert(used>0);checks.push({id:'actual-app-source-dispatch-settlement',used,attempts:h.upstream.length});
 const subject=await budgetSubjectKey(h.env,{u:'student-a',c:h.cohort,p:h.profile,v:2,iat:0,exp:0});
 await h.api('/admin/access/budgets/children','POST',{id:'student-exhausted',parent_id:h.root.account_id,expected_parent_revision:1,kind:'cap',scope_kind:'subject',scope_id:subject,max_concurrent:1,limits:{'currency:USD:micro':used}});
 await chat.evaluate("[...document.querySelectorAll('.hps-access button')].find(b=>b.textContent.includes('새로고침')).click()");await wait(()=>chat.evaluate("document.querySelector('.hps-access').textContent.includes('남은 자원 부족')"),'exhausted view');
 await fill('.hps-input textarea','한도를 넘은 합성 요청');await chat.evaluate("document.querySelector('.hps-btn-send').click()");await wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'denied request ends');await window.waitForTimeout(1000);assert.equal(h.upstream.length,1,'denial never dispatches or falls back');
 assert.equal(readFileSync(userDir+'/ws/keep.txt','utf8'),'Existing work must survive a budget denial.');assert(await chat.evaluate("!document.querySelector('.hps-input textarea').disabled"));checks.push({id:'exhaustion-no-fallback-files-and-composer-retained',pass:true});
 await shot('mac-access-exhausted');report(true);console.log('PASS actual Mac: funding selection, draft preservation, 390/1280/200% layout, synthetic dispatch/settlement and exhausted budget preserves files');
}catch(error){if(app){try{const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));writeFileSync(out+'/mac-failure.png',Buffer.from(png,'base64'));}catch{}}report(false,String(error));throw error;
}finally{for(const ws of sockets)ws.close();if(app)await app.close();await h.close();unlinkSync(userDir+'/User/hps-test-state.json');}
