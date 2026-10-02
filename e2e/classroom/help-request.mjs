// #1409: real HelpRequest React UI in Chromium; host messages captured at the existing bridge.
// Host identity/concurrency behavior is tested by classroom-help-host.smoke.mjs. No real App claim.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = await build({stdin:{contents:`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HelpRequest} from './src/HelpRequest';
const root=createRoot(document.getElementById('root'));
window.messages=[];
window.draw=(view)=>root.render(<HelpRequest view={view} post={m=>window.messages.push(m)}/>);
`,resolveDir:path.join(repo,'extensions/hypeproof-chat/webview-ui'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const browser = await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<html lang="ko"><body><div id="root"></div></body></html>');
 await page.addScriptTag({content:built.outputFiles[0].text});
 const key='c|p|synthetic|run';
 const view={generation:1,draft_key:key,seat:'A1',availability:{state:'unknown'},draft:{question:'QUESTION',turnId:null,duration:30,updated_at:1},turns:[],current:[],history:[],refresh:{state:'ok',at:1},note:null};
 const envelope=(id,state)=>({request_id:id,state,recipient_id:'teacher',seat_id:'A1',content:{question:'QUESTION'},truncated:[],consent_expires_at:4000000000});
 await page.evaluate(v=>window.draw(v),{...view,envelope:envelope('preview-one','prepared')});
 await page.locator('details > summary').click();
 assert.equal(await page.locator('[data-help-send]').isDisabled(),true,'consent is never pre-ticked');
 await page.locator('[data-help-cancel]').click();
 assert.deepEqual(await page.evaluate(()=>window.messages.find(m=>m.type==='helpCancel')),{type:'helpCancel',key,requestId:'preview-one'});
 await page.evaluate(v=>window.draw(v),{...view,envelope:envelope('unknown-two','unknown')});
 await page.locator('[data-help-discard]').click();
 assert.deepEqual(await page.evaluate(()=>window.messages.find(m=>m.type==='helpDiscard')),{type:'helpDiscard',key,requestId:'unknown-two'});
 await page.evaluate(v=>window.draw(v),{...view,envelope:envelope('preview-three','prepared')});
 await page.locator('[data-help-consent]').check();
 await page.locator('[data-help-send]').click();
 assert.deepEqual(await page.evaluate(()=>window.messages.find(m=>m.type==='helpSend')),{type:'helpSend',key,requestId:'preview-three',consent:true});
 console.log('PASS help UI: cancel/discard/send carry exactly the displayed request ID; send requires consent');
} finally { await browser.close(); }
