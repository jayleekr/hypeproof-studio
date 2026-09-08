// Real installed Mac shell + development extension + local Service/SQLite.
// Synthetic lessons. Navigation makes no model claim; the opt-in identity/live
// cases record their real provider requests separately.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,readFileSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {localAuthoring} from '../../worker/test/harness/dental-authoring.mjs';
import {prepareIdentity,verifyIdentity} from './identity.mjs';
import {surfaceAcceptance} from './surfaces.mjs';
const surfaces=process.env.HPS_LESSON_SURFACES==='1';
const identity=surfaces||process.env.HPS_LESSON_IDENTITY==='1';
const live=process.env.HPS_LESSON_LIVE==='1';
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
if(process.env.HPS_LESSON_EXPECT_SHA)assert.equal(sourceSha,process.env.HPS_LESSON_EXPECT_SHA,'candidate SHA differs from the handoff');
if(process.env.HPS_LESSON_PRODUCT_SHA){
 const changed=execFileSync('git',['diff',process.env.HPS_LESSON_PRODUCT_SHA,'--','worker/src','chalk/src','extensions/hypeproof-chat/src','extensions/hypeproof-chat/webview-ui/src'],{cwd:sourceRoot,encoding:'utf8'});
 assert.equal(changed,'','product sources differ from the submitted implementation');
}
if(process.env.HPS_LESSON_BUNDLED_EXTENSION==='1'){
 const appRoot=process.env.HPS_APP_PATH.split('/Contents/MacOS/')[0];
 for(const file of ['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css']){
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  assert.equal(hash(appRoot+'/Contents/Resources/app/extensions/hypeproof-chat/'+file),hash(resolve(sourceRoot,'extensions/hypeproof-chat/'+file)),'test app must contain the current '+file);
 }
}
const local=await localAuthoring({profileId:surfaces?'studio-native-trial':'homepage-practice-s1'});
// The navigation fixture only creates authoring tables. A real model turn also
// records usage; use the repository's fresh schema, never a made-up table.
if(live){
 local.db.exec(readFileSync(resolve(sourceRoot,'worker/schema.sql'),'utf8'));
 local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort,'Synthetic acceptance');
 local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run('synthetic-lesson',local.cohort,local.profileId,new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3600000).toISOString());
}
if(live){
 assert.ok(process.env.ANTHROPIC_API_KEY,'live acceptance requires the existing dev Anthropic key');
 Object.assign(local.env,{LLM_PROVIDER:'anthropic',ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,OPENAI_API_KEY:undefined,ANTHROPIC_PROXY_URL:undefined});
}
const {setRoster,startSession}=await import('../../worker/src/lib/kv.ts');
await setRoster(local.env.HPS_KV,local.cohort,['synthetic-lesson-student']);
await startSession(local.env.HPS_KV,local.cohort,{session_id:'synthetic-lesson',profile_id:local.profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
const base=local.origin+'/admin/cohorts/'+local.cohort+'/authoring/synthetic-lesson';
async function call(url,method,body){const r=await local.fetcher(url,{method,headers:{authorization:'Bearer '+local.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();}
await call(base,'PUT',{profile_id:local.profileId,expected_revision:0,request_id:'synthetic-create',content:{schema:'hps-session-design/1',title:'합성 홈페이지 강의',audience:'성인 합성 사용자',duration_minutes:60,objective:'화면을 검수하고 수정 이유를 설명한다',prerequisites:'',starter:'빈 연습 폴더에서 시작',steps:[{id:'create',title:'홈페이지 첫 화면',instructions:'가상 꽃집 홈페이지를 만들어 주세요.',hint:'위치와 진료정보 대신 꽃집 소개와 영업시간을 구분하세요.',acceptance:'390px와 1280px에서 확인'}]}});
await call(base+'/versions/m2026.09.07-1','PUT',{expected_revision:1});
const invite=await call(base+'/versions/m2026.09.07-1/participants','POST',{user:'synthetic-lesson-student',hours:1});
const cases=identity?await prepareIdentity(local):null;
const originalFetch=globalThis.fetch,upstream=[];
if(live)globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.origin!=='https://api.anthropic.com')return originalFetch(input,init);
 assert.ok(upstream.length<(surfaces?20:8),'live acceptance request budget exhausted');
 const r=await originalFetch(input,{...init,signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(90000)])});
 upstream.push({origin:url.origin,path:url.pathname,status:r.status,request_id:r.headers.get('request-id')});
 writeFileSync(out+'/api-evidence.json',JSON.stringify({real_upstream:true,calls:upstream},null,2));return r;
};
let fault='none';const gatewayCalls=[];
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const x of req)chunks.push(x);const body=Buffer.concat(chunks);
 if(/^\/v1\/(messages|chat\/completions)/.test(req.url)){gatewayCalls.push({path:req.url.split('?')[0],fault});writeFileSync(out+'/gateway-evidence.json',JSON.stringify({calls:gatewayCalls},null,2));}
 if(fault!=='none'&&/^\/v1\/(messages|chat\/completions)/.test(req.url)){
  if(fault==='stall'){const timer=setTimeout(()=>res.end(),20000);res.on('close',()=>clearTimeout(timer));return;}
  const status=Number(fault);res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:status===400?'invalid_request_error':'api_error',message:'synthetic acceptance failure '+status}}));return;
 }
 const r=await local.fetcher(local.origin+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined});res.writeHead(r.status,Object.fromEntries(r.headers));if(r.body)for await(const chunk of r.body)res.write(chunk);res.end();}catch{if(!res.headersSent)res.writeHead(500);res.end();}});
let app;const sockets=[];
const out=resolve(process.env.HPS_LESSON_EVIDENCE_DIR||'test-results/lesson-studio');mkdirSync(out,{recursive:true});
// Reuse the existing native manifest; the source checkout can differ from the
// primary launch cwd, but the loaded extension must match it above.
if(process.env.HPS_LESSON_BUNDLED_EXTENSION==='1'){
 execFileSync(process.execPath,[resolve(sourceRoot,'e2e/native-trial-manifest.mjs')],{cwd:sourceRoot,env:{...process.env,HPS_APP_PATH:process.env.HPS_APP_PATH.split('/Contents/MacOS/')[0],HPS_NATIVE_EVIDENCE_DIR:out}});
 const manifest=JSON.parse(readFileSync(out+'/environment.json','utf8'));
 manifest.execution_cwd=process.cwd();
 manifest.lesson_contract_sha256=createHash('sha256').update(readFileSync(resolve(sourceRoot,'worker/src/lib/session-design.ts'))).digest('hex');
 manifest.runner_sha256=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
 manifest.expected_candidate_sha=process.env.HPS_LESSON_EXPECT_SHA||null;
 manifest.submitted_product_sha=process.env.HPS_LESSON_PRODUCT_SHA||null;
 manifest.live_model_requested=live;
 manifest.identity_runner_sha256=createHash('sha256').update(readFileSync(new URL('./identity.mjs',import.meta.url))).digest('hex');
 if(surfaces){
  manifest.surface_runner_sha256=createHash('sha256').update(readFileSync(new URL('./surfaces.mjs',import.meta.url))).digest('hex');
  manifest.sdk_unavailable_fixture=process.env.HPS_LESSON_SDK_UNAVAILABLE==='1';
  const sdk=process.env.HPS_APP_PATH.split('/Contents/MacOS/')[0]+'/Contents/Resources/app/extensions/hypeproof-chat/dist/vendor/node_modules/@anthropic-ai/claude-agent-sdk';
  manifest.bundled_sdk={present:existsSync(sdk+'/sdk.mjs')};
  if(manifest.bundled_sdk.present){manifest.bundled_sdk.version=JSON.parse(readFileSync(sdk+'/package.json','utf8')).version;manifest.bundled_sdk.sha256=createHash('sha256').update(readFileSync(sdk+'/sdk.mjs')).digest('hex');}
  const bare=process.env.HPS_APP_PATH.split('/Contents/MacOS/')[0]+'/Contents/Resources/app/extensions/hypeproof-chat/node_modules/@anthropic-ai/claude-agent-sdk';
  manifest.bare_sdk={present:existsSync(bare+'/sdk.mjs')};
  if(manifest.bare_sdk.present){manifest.bare_sdk.version=JSON.parse(readFileSync(bare+'/package.json','utf8')).version;manifest.bare_sdk.sha256=createHash('sha256').update(readFileSync(bare+'/sdk.mjs')).digest('hex');}
  assert.equal(manifest.bundled_sdk.present,!manifest.sdk_unavailable_fixture,'SDK fixture does not match the actual copied app');
  if(manifest.sdk_unavailable_fixture)assert.equal(manifest.bare_sdk.present,false,'bare SDK fallback must also be absent in this fixture');
 }
 writeFileSync(out+'/environment.json',JSON.stringify(manifest,null,2));
}
const userDir=realpathSync(mkdtempSync(tmpdir()+'/hps-lesson-'));mkdirSync(userDir+'/User');mkdirSync(userDir+'/ws');
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const proxy='http://127.0.0.1:'+server.address().port+'/v1';
 writeFileSync(userDir+'/User/settings.json',JSON.stringify({'hypeproofChat.proxyUrl':proxy,'window.dialogStyle':'custom','workbench.startupEditor':'none','update.mode':'none','telemetry.telemetryLevel':'off',...(surfaces?{'hypeproofChat.requireApprovalFor':['writeFile','executeShell','openBrowser','delegateAgent','browserType']}:{} )}));
 writeFileSync(userDir+'/User/hps-test-state.json',JSON.stringify({token:cases?.a.token||invite.token,coach:{name:'연습 코치',personality:''}}),{mode:0o600});
 const appEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD)/.test(key)));
 app=await electron.launch({executablePath:process.env.HPS_APP_PATH||'/Applications/HypeProof Studio.app/Contents/MacOS/HypeProof Studio',args:['--user-data-dir='+userDir,'--extensions-dir='+userDir+'/extensions',...(process.env.HPS_LESSON_BUNDLED_EXTENSION==='1'?[]:['--extensionDevelopmentPath='+resolve(sourceRoot,'extensions/hypeproof-chat')]),'--disable-workspace-trust','--use-inmemory-secretstorage','--disable-updates','--skip-welcome','--skip-release-notes','--remote-debugging-port=9347','--folder-uri',pathToFileURL(userDir+'/ws').href],env:{...appEnv,HPS_TEST_E2E:'1'},timeout:30000});
 const window=await app.firstWindow();await window.waitForTimeout(5000);
 // Reuse observe's direct OOPIF/CDP approach; inspect every current frame.
 async function targets(){return (await (await fetch('http://127.0.0.1:9347/json/list')).json()).filter(x=>x.type==='iframe'&&x.url.includes('hypeproof-chat'));}
 async function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);sockets.push(ws);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result);}};const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,[r,j]);ws.send(JSON.stringify({id:n,method,params}));});await send('Page.enable');const {frameTree}=await send('Page.getFrameTree');const frames=[frameTree,...(frameTree.childFrames||[])];const contexts=[];for(const f of frames){const x=await send('Page.createIsolatedWorld',{frameId:f.frame.id,worldName:'lesson-observer'});contexts.push(x.executionContextId);}return {send,contexts};}
 async function findContext(selector){for(const t of await targets()){const c=await connect(t);for(const contextId of c.contexts){const evaluate=async expression=>(await c.send('Runtime.evaluate',{expression,contextId,returnByValue:true,awaitPromise:true})).result?.value;if(await evaluate('!!document.querySelector('+JSON.stringify(selector)+')'))return {...c,contextId,evaluate};}}return null;}
 if(identity){
  await verifyIdentity({app,window,findContext,cases,out,live:live&&!surfaces,surfaces:surfaces?surfaceAcceptance({out,workspace:userDir+'/ws',live,degraded:process.env.HPS_LESSON_SDK_UNAVAILABLE==='1',gatewayCalls}):undefined,setFault:mode=>{fault=mode;},setZoom:factor=>{const path=userDir+'/User/settings.json';writeFileSync(path,JSON.stringify({...JSON.parse(readFileSync(path,'utf8')),'window.zoomLevel':Math.log(factor)/Math.log(1.2)}));}});
  if(live)assert.ok(upstream.some(c=>c.status===200),'no successful real provider request was recorded');
 }else{
 let found=false;
 for(let attempt=0;attempt<20&&!found;attempt++){
  for(const t of await targets()){
   const c=await connect(t);
   for(const contextId of c.contexts){const evaluate=async expression=>(await c.send('Runtime.evaluate',{expression,contextId,returnByValue:true})).result?.value;
    const has=await evaluate("!!document.querySelector('.hps-lesson')");
    if(has){assert.match(await evaluate("document.querySelector('.hps-lesson').textContent"),/합성 홈페이지 강의/);await evaluate("document.querySelector('.hps-lesson').open=true;document.querySelector('.hps-lesson button').click()");await window.waitForTimeout(300);const draft=await evaluate("document.querySelector('textarea')?.value");assert.match(draft,/가상 꽃집/);assert.match(draft,/390px와 1280px/);await window.screenshot({path:out+'/mac-lesson.png'});writeFileSync(out+'/result.json',JSON.stringify({pass:true,scope:'actual Mac shell; local Service and signed synthetic token; lesson rendered and task inserted, LLM not run',user_data_dir:userDir,profile:local.profileId,version:invite.lesson.version},null,2));found=true;break;}
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('수업 시작하기'))?.click()");
   }
   if(found)break;
  }
  if(!found)await window.waitForTimeout(1000);
 }
 if(!found){await window.screenshot({path:out+'/mac-unresolved.png'});throw Error('lesson panel not found in actual chat webview');}
 console.log('PASS actual Mac: Service signed lesson -> profile -> chat webview -> task draft; no model execution claimed');
 }
}finally{for(const ws of sockets)ws.close();if(app)await app.close();server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=originalFetch;local.close();unlinkSync(userDir+'/User/hps-test-state.json');}
