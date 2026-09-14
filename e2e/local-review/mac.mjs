// Actual installed Mac shell with exact candidate bundles. UI interactions are
// automated acceptance, not Jay's human judgment or a public binary release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { LocalReviewService } from '../../extensions/hypeproof-chat/src/localReviewService.ts';
const root=resolve(new URL('../..',import.meta.url).pathname);
const appPath=process.env.HPS_REVIEW_APP;
assert.ok(appPath,'Set HPS_REVIEW_APP to the candidate .app containing current bundles');
const out=resolve(process.env.HPS_REVIEW_EVIDENCE || '/tmp/hps-1020-mac-evidence');mkdirSync(out,{recursive:true});
const hashes={};
for(const file of ['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css']) {
 const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
 hashes[file]=hash(root+'/extensions/hypeproof-chat/'+file);
 assert.equal(hash(appPath+'/Contents/Resources/app/extensions/hypeproof-chat/'+file),hashes[file],'Candidate bundle mismatch: '+file);
}
const userDir=process.env.HPS_REVIEW_USER_DIR || mkdtempSync(tmpdir()+'/hps-local-review-accept-');
mkdirSync(userDir+'/User',{recursive:true});
const project=process.env.HPS_REVIEW_PROJECT || '/Users/jaylee/CodeWorkspace/hypeproof-studio';
writeFileSync(userDir+'/User/settings.json',JSON.stringify({'workbench.startupEditor':'none','window.dialogStyle':'custom','update.mode':'none','telemetry.telemetryLevel':'off','files.simpleDialog.enable':true}));
const port=Number(process.env.HPS_REVIEW_PORT || 9366);
const sockets=[];
let app;
async function connectReview(selector=".local-review") {
 for(let attempt=0;attempt<30;attempt++) {
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for(const target of targets.filter(t=>t.type==='iframe'&&t.url.includes('hypeproof-chat'))) {
   const socket=new WebSocket(target.webSocketDebuggerUrl);sockets.push(socket);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
   let id=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result);}};
   const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,[r,j]);socket.send(JSON.stringify({id:n,method,params}));});
   const {frameTree}=await send('Page.getFrameTree');
   for(const frame of [frameTree,...frameTree.childFrames||[]]) {
    const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frame.frame.id,worldName:'local-review-acceptance'});
    const evaluate=async expression=>(await send('Runtime.evaluate',{expression,contextId:executionContextId,returnByValue:true,awaitPromise:true})).result?.value;
    if(await evaluate('!!document.querySelector('+JSON.stringify(selector)+')')) return {evaluate,send};
   }
  }
  await new Promise(r=>setTimeout(r,200));
 }
 throw Error('Review webview not found');
}
try {
 const storage=userDir+'/User/globalStorage/hypeproof.hypeproof-chat/local-review-v1';
 const service=new LocalReviewService(storage);
 let id;
 if(process.env.HPS_REVIEW_TRANSCRIPT) {
  const raw=readFileSync(process.env.HPS_REVIEW_TRANSCRIPT,'utf8');
  id='task-'+createHash('sha256').update(raw).digest('hex').slice(0,32);
 }
 const launchOptions={executablePath:appPath+'/Contents/MacOS/HypeProof Studio',args:['--use-inmemory-secretstorage','--user-data-dir='+userDir,'--extensions-dir='+userDir+'/extensions','--disable-workspace-trust','--disable-updates','--skip-welcome','--skip-release-notes','--remote-debugging-port='+port,project],env:{...process.env,HPS_TEST_E2E:'1'},timeout:30000};
 app=await electron.launch(launchOptions);
 let win=await app.firstWindow();await win.waitForTimeout(4000);
 const start=await connectReview('.studio-start');
 await start.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='내 작업 검토').click()`);
 let review; try { review=await connectReview(); } catch(e) { await win.screenshot({path:out+'/failure.png'}); console.log((await win.locator('body').innerText()).slice(-2200)); throw e; } const {evaluate}=review;
 const waitFor=async expression=>{for(let i=0;i<600;i++){if(await evaluate(expression))return;await win.waitForTimeout(100);}await win.screenshot({path:out+'/assertion-failure.png'}); console.log((await evaluate('document.querySelector("[role=alert]")?.textContent')));throw Error('Unmet UI assertion: '+expression);};
 await waitFor('document.querySelector("h1")?.textContent === "My task reviews"');
 if(id) {
  const recentHost = process.env.HPS_REVIEW_RECENT_HOST;
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(recentHost === 'codex' ? '최근 Codex 세션' : recentHost === 'claude-code' ? '최근 Claude 세션' : 'Import Codex task')}).click()`);
  await win.waitForTimeout(600);
  const input=win.locator('.quick-input-widget input');
  await input.fill(recentHost ? (process.env.HPS_REVIEW_SESSION || '') : process.env.HPS_REVIEW_TRANSCRIPT);
  await win.waitForTimeout(800);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
  await win.screenshot({path:out+'/import-dialog.png'});
  await win.getByRole('button',{name:'Import task',exact:true}).click({timeout:10000});
  await waitFor('document.querySelectorAll("nav button").length > 0');
  await waitFor('document.querySelectorAll(".capability").length===6');
  id = (await service.record.records()).tasks[0].id;
  assert.ok(await evaluate(`document.body.textContent.includes('Recorded observations')`));
  const body=await evaluate('document.body.textContent');assert.match(body,/captured-replay/);assert.match(body,/Insufficient evidence/);
  await evaluate(`(()=>{const el=document.querySelector('section textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Automated acceptance: preserve the real task evidence and mark limits');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save and confirm purpose').click()`);
  await waitFor(`document.body.textContent.includes('Purpose: confirmed')`);
  await evaluate(`(()=>{const el=document.querySelector('.capability textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Automated review-path test, not Jay acceptance. See the first user message.');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('.capability input[type=checkbox]').click()`);
  await evaluate(`document.querySelector('.capability button').click()`);
  await waitFor(`document.body.textContent.includes('Human review: correct')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview submission').click()`);
  await waitFor(`!!document.querySelector('.submission-preview')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm local submission').click()`);
  await waitFor(`!!document.querySelector('.receipt')`);
  await evaluate(`(()=>{const section=[...document.querySelectorAll('section')].find(s=>s.querySelector('h2')?.textContent==='다음 작업에서 바꿀 행동 하나');const el=section.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Automated acceptance only: record success criteria before the next task');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='개선 행동 저장').click()`);
  await waitFor(`document.body.textContent.includes('선택됨: Automated acceptance')`);
  const saved=await new LocalReviewService(storage).card(id);
  assert.equal(saved.improvements.length,1);assert.match(saved.reviews[0].note,/Evidence: observations/);assert.equal(saved.receipts.length,1);assert.equal(saved.reviews.length,1);
  await win.screenshot({path:out+'/review-receipt.png'});
  for(const socket of sockets.splice(0)) socket.close();
  await app.close();
  app=await electron.launch(launchOptions);
  win=await app.firstWindow();await win.waitForTimeout(4000);
  const reopenedStart=await connectReview('.studio-start');
  await reopenedStart.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='내 작업 검토').click()`);
  const reopened=await connectReview();
  for(let i=0;i<50 && !(await reopened.evaluate('document.querySelector(\"nav button\")'));i++) await win.waitForTimeout(100);
  await reopened.evaluate('document.querySelector(\"nav button\").click()');
  for(let i=0;i<50 && !(await reopened.evaluate('!!document.querySelector(\".receipt\")'));i++) await win.waitForTimeout(100);
  assert.ok(await reopened.evaluate('!!document.querySelector(\".receipt\")'),'Receipt survives complete App restart');
  assert.ok(await reopened.evaluate(`document.body.textContent.includes('Human review: correct')`),'Human edit survives restart');
  assert.ok(await reopened.evaluate(`document.body.textContent.includes('선택됨: Automated acceptance')`),'Improvement survives restart');
  await win.screenshot({path:out+'/reopened-receipt.png'});
  writeFileSync(out+'/result.json',JSON.stringify({status:'PASS',sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),hashes,app:appPath,userDir,storage,task:id,receipt:saved.receipts[0],source:'real ' + (recentHost || 'codex') + ' task captured replay',actor:'automated acceptance; NOT Jay human review',import:recentHost ? 'project-scoped recent session picker and confirmation' : 'actual file picker and import confirmation',restart:'PASS: complete App restart and restored review/receipt',public_release:'NOT RUN'},null,2));
 }
 console.log(JSON.stringify({status:'PASS',userDir,storage,task:id,scope:id?'actual Mac six-capability UI, edits, preview, durable receipt':'actual Mac review command and empty state'}));
 if(process.env.HPS_REVIEW_KEEP_OPEN==='1') { console.log('Human review app left open'); app.process().unref(); }
} finally { for(const s of sockets)s.close();if(app && process.env.HPS_REVIEW_KEEP_OPEN!=='1') {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});} }
