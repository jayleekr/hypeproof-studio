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
async function connectReview() {
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
    if(await evaluate('!!document.querySelector(".local-review")')) return {evaluate,send};
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
  id=(await service.import(raw,'codex',project)).task.id;
 }
 app=await electron.launch({executablePath:appPath+'/Contents/MacOS/HypeProof Studio',args:['--user-data-dir='+userDir,'--extensions-dir='+userDir+'/extensions','--disable-workspace-trust','--disable-updates','--skip-welcome','--skip-release-notes','--remote-debugging-port='+port,project],env:{...process.env,HPS_TEST_E2E:'1'},timeout:30000});
 const win=await app.firstWindow();await win.waitForTimeout(4000);
 await win.keyboard.press('Meta+Shift+P');await win.keyboard.type('HypeProof: My task reviews');await win.keyboard.press('Enter');
 const {evaluate}=await connectReview();
 const waitFor=async expression=>{for(let i=0;i<50;i++){if(await evaluate(expression))return;await win.waitForTimeout(100);}throw Error('Unmet UI assertion: '+expression);};
 await waitFor('document.querySelector("h1")?.textContent === "My task reviews"');
 if(id) {
  await waitFor('document.querySelectorAll("nav button").length > 0');
  await evaluate('document.querySelector("nav button").click()');
  await waitFor('document.querySelectorAll(".capability").length===6');
  const body=await evaluate('document.body.textContent');assert.match(body,/captured-replay/);assert.match(body,/Insufficient evidence/);
  await evaluate(`(()=>{const el=document.querySelector('section textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Automated acceptance: preserve the real task evidence and mark limits');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save and confirm purpose').click()`);
  await waitFor(`document.body.textContent.includes('Purpose: confirmed')`);
  await evaluate(`(()=>{const el=document.querySelector('.capability textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Automated review-path test, not Jay acceptance. See the first user message.');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('.capability button').click()`);
  await waitFor(`document.body.textContent.includes('Human review: correct')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview submission').click()`);
  await waitFor(`!!document.querySelector('.submission-preview')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm local submission').click()`);
  await waitFor(`!!document.querySelector('.receipt')`);
  const saved=await new LocalReviewService(storage).card(id);assert.equal(saved.receipts.length,1);assert.equal(saved.reviews.length,1);
  await win.screenshot({path:out+'/review-receipt.png'});
  writeFileSync(out+'/result.json',JSON.stringify({status:'PASS',sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),hashes,app:appPath,userDir,storage,task:id,receipt:saved.receipts[0],source:'real Codex task captured replay',actor:'automated acceptance; NOT Jay human review',import:'service adapter; file-picker path separately observed',public_release:'NOT RUN'},null,2));
 }
 console.log(JSON.stringify({status:'PASS',userDir,storage,task:id,scope:id?'actual Mac six-capability UI, edits, preview, durable receipt':'actual Mac review command and empty state'}));
 if(process.env.HPS_REVIEW_KEEP_OPEN==='1') { console.log('Human review app left open'); app.process().unref(); }
} finally { for(const s of sockets)s.close();if(app && process.env.HPS_REVIEW_KEEP_OPEN!=='1') {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});} }
