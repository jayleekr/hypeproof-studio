import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dist=path.join(repo,'extensions/hypeproof-chat/webview-ui/dist');
const out=path.join(repo,'e2e/test-results/start-page');await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try {const url=new URL(req.url,'http://local');const name=url.pathname==='/'?'index.html':url.pathname.slice(1);if(name.includes('..'))throw Error();let body=await fs.readFile(path.join(dist,name));if(name==='index.html')body=Buffer.from(body.toString().replace('<html','<html data-surface="start"'));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
try {
 const p=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>{window.sent.push(m);if(m.type==='startReady')setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'startState',state:{checking:false,version:'test'}}})),0);},getState:()=>undefined,setState:()=>{throw Error('credential state persistence forbidden');}});});
 await p.goto(`http://127.0.0.1:${server.address().port}`);await p.getByRole('heading',{name:'내 수업에 연결하기'}).waitFor();
 assert.equal(await p.getByText('나비',{exact:true}).count(),0);assert.equal(await p.locator('#course-code').getAttribute('type'),'password');
 const submit=p.getByRole('button',{name:'수업 확인하기'});assert.equal(await submit.isDisabled(),true);
 await p.locator('#course-code').fill('synthetic-not-a-secret');await submit.click();assert.equal(await p.locator('#course-code').inputValue(),'');
 assert.equal(await p.locator('#course-code').isDisabled(),true);assert.equal(await p.evaluate(()=>window.sent.filter(m=>m.type==='connectCourse').length),1);
 const state=async s=>p.evaluate(s=>window.dispatchEvent(new MessageEvent('message',{data:{type:'startState',state:{version:'test',checking:false,...s}}})),s);
 await state({error:'인증에 실패했습니다. 참여 코드를 다시 확인하세요.'});await p.getByRole('alert').waitFor();assert.equal(await p.locator('#course-code').isDisabled(),false);
 const profile={id:'adult-test',name:'성인 홈페이지 제작 실습',coach:'코치',series:'1 / 5',workspace:'~/Practice'};
 await state({profile});await p.getByRole('heading',{name:'이 수업으로 시작할까요?'}).waitFor();assert.equal(await p.getByText(profile.name,{exact:true}).count(),1);
 await p.getByRole('button',{name:'다른 수업에 연결'}).click();await p.locator('#course-code').fill('second-attempt');await p.getByRole('button',{name:'수업 확인하기'}).click();
 await state({profile,error:'서버에 연결할 수 없습니다.'});await p.getByText('기존 수업 연결은 유지됩니다.').waitFor();await p.getByRole('button',{name:'기존 수업으로 돌아가기'}).click();
 await p.getByRole('button',{name:'수업 시작하기'}).click();assert.equal(await p.evaluate(()=>window.sent.at(-1).type),'beginCourse');
 await state({profile:{...profile,id:'kids-test',name:'어린이 만들기 수업',coach:'직접 이름 짓는 코치'}});await p.getByText('어린이 만들기 수업',{exact:true}).waitFor();
 await p.getByRole('button',{name:'연결 해제',exact:true}).click();assert.equal(await p.evaluate(()=>window.sent.at(-1).type),'disconnectCourse');
 await state({});
 for(const width of [390,768,1280]){await p.setViewportSize({width,height:900});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.join(out,`start-${width}.png`),fullPage:true});}
 const storage=await p.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}));assert.deepEqual(storage,{local:0,session:0});assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({scope:'built React UI with controlled host messages; real Mac auth evidence recorded separately',pass:true,widths:[390,768,1280],controls:['disconnected neutral state','password and no persistence','pending and retry','adult and child profiles','failed switch retains prior course','begin action'],errors},null,2));
 console.log('PASS start-page browser controls: empty/pending/error/retry/course switch; 390/768/1280; no credential persistence');
} finally {await browser.close();await new Promise(r=>server.close(r));}
