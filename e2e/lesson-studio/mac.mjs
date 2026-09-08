// Real installed Mac shell + development extension + local Service/SQLite.
// Synthetic only; no model completion is claimed by this navigation check.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {_electron as electron} from '@playwright/test';
import {localAuthoring} from '../../worker/test/harness/dental-authoring.mjs';
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
if(process.env.HPS_LESSON_EXPECT_SHA)assert.equal(sourceSha,process.env.HPS_LESSON_EXPECT_SHA,'candidate SHA differs from the handoff');
if(process.env.HPS_LESSON_BUNDLED_EXTENSION==='1'){
 const appRoot=process.env.HPS_APP_PATH.split('/Contents/MacOS/')[0];
 for(const file of ['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css']){
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  assert.equal(hash(appRoot+'/Contents/Resources/app/extensions/hypeproof-chat/'+file),hash(resolve(sourceRoot,'extensions/hypeproof-chat/'+file)),'test app must contain the current '+file);
 }
}
const local=await localAuthoring({profileId:'homepage-practice-s1'});
const {setRoster,startSession}=await import('../../worker/src/lib/kv.ts');
await setRoster(local.env.HPS_KV,local.cohort,['synthetic-lesson-student']);
await startSession(local.env.HPS_KV,local.cohort,{session_id:'synthetic-lesson',profile_id:local.profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
const base=local.origin+'/admin/cohorts/'+local.cohort+'/authoring/synthetic-lesson';
async function call(url,method,body){const r=await local.fetcher(url,{method,headers:{authorization:'Bearer '+local.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();}
await call(base,'PUT',{profile_id:local.profileId,expected_revision:0,request_id:'synthetic-create',content:{schema:'hps-session-design/1',title:'합성 홈페이지 강의',audience:'성인 합성 사용자',duration_minutes:60,objective:'화면을 검수하고 수정 이유를 설명한다',prerequisites:'',starter:'빈 연습 폴더에서 시작',steps:[{id:'create',title:'홈페이지 첫 화면',instructions:'가상 꽃집 홈페이지를 만들어 주세요.',hint:'위치와 진료정보 대신 꽃집 소개와 영업시간을 구분하세요.',acceptance:'390px와 1280px에서 확인'}]}});
await call(base+'/versions/m2026.09.07-1','PUT',{expected_revision:1});
const invite=await call(base+'/versions/m2026.09.07-1/participants','POST',{user:'synthetic-lesson-student',hours:1});
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const x of req)chunks.push(x);const body=Buffer.concat(chunks);const r=await local.fetcher(local.origin+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined});res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(500).end();}});
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
 writeFileSync(out+'/environment.json',JSON.stringify(manifest,null,2));
}
const userDir=realpathSync(mkdtempSync(tmpdir()+'/hps-lesson-'));mkdirSync(userDir+'/User');mkdirSync(userDir+'/ws');
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const proxy='http://127.0.0.1:'+server.address().port+'/v1';
 writeFileSync(userDir+'/User/settings.json',JSON.stringify({'hypeproofChat.proxyUrl':proxy,'window.dialogStyle':'custom','workbench.startupEditor':'none','update.mode':'none','telemetry.telemetryLevel':'off'}));
 writeFileSync(userDir+'/User/hps-test-state.json',JSON.stringify({token:invite.token,coach:{name:'연습 코치',personality:''}}),{mode:0o600});
 app=await electron.launch({executablePath:process.env.HPS_APP_PATH||'/Applications/HypeProof Studio.app/Contents/MacOS/HypeProof Studio',args:['--user-data-dir='+userDir,'--extensions-dir='+userDir+'/extensions',...(process.env.HPS_LESSON_BUNDLED_EXTENSION==='1'?[]:['--extensionDevelopmentPath='+resolve(sourceRoot,'extensions/hypeproof-chat')]),'--disable-workspace-trust','--use-inmemory-secretstorage','--disable-updates','--skip-welcome','--skip-release-notes','--remote-debugging-port=9347','--folder-uri',pathToFileURL(userDir+'/ws').href],env:{...process.env,HPS_TEST_E2E:'1'},timeout:30000});
 const window=await app.firstWindow();await window.waitForTimeout(5000);
 // Reuse observe's direct OOPIF/CDP approach; inspect every current frame.
 async function targets(){return (await (await fetch('http://127.0.0.1:9347/json/list')).json()).filter(x=>x.type==='iframe'&&x.url.includes('hypeproof-chat'));}
 async function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);sockets.push(ws);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result);}};const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,[r,j]);ws.send(JSON.stringify({id:n,method,params}));});await send('Page.enable');const {frameTree}=await send('Page.getFrameTree');const frames=[frameTree,...(frameTree.childFrames||[])];const contexts=[];for(const f of frames){const x=await send('Page.createIsolatedWorld',{frameId:f.frame.id,worldName:'lesson-observer'});contexts.push(x.executionContextId);}return {send,contexts};}
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
}finally{for(const ws of sockets)ws.close();if(app)await app.close();await new Promise(r=>server.close(r));local.close();unlinkSync(userDir+'/User/hps-test-state.json');}
