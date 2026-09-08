// Captures actual React output with synthetic host events, and official web pages.
// These are visual research artifacts, not end-to-end agent execution tests.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
const require=createRequire(path.join(process.env.HPS_CAPTURE_DEPS_ROOT || root,'e2e/package.json'));
const {chromium}=require('@playwright/test');
const dist=path.join(root,'extensions/hypeproof-chat/webview-ui/dist'),out=path.join(here,'screenshots');
await fs.mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{try{
 const name=new URL(req.url,'http://local').pathname.slice(1)||'index.html';
 const p=path.resolve(dist,name);if(!p.startsWith(dist+path.sep))throw Error('outside');
 const body=await fs.readFile(p);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);
}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch(),records=[];
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
async function shot(page,id,metadata){
 const file=id+'.png';await page.screenshot({path:path.join(out,file)});
 records.push({id,file,capturedAt:new Date().toISOString(),viewport:page.viewportSize(),...metadata,
 sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(out,file))).digest('hex')});
}
try{
 const page=await browser.newPage({viewport:{width:480,height:900},deviceScaleFactor:1});
 page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 await page.addInitScript(()=>{window.captureMessages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.captureMessages.push(m),getState:()=>undefined,setState:()=>{}});});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.captureMessages.some(x=>x.type==='ready'));
 const emit=msg=>page.evaluate(async data=>{window.dispatchEvent(new MessageEvent('message',{data}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));},msg);
 const ux={coach:{naming_mode:'fixed',fallback_name:'코치',naming_prompt_md:'',personality_prompt_md:''},
 suggestions:{initial:[],follow_up:[]},hints:{short_input:{enabled:false,min_chars:10,message_md:''},roll_input_button:{enabled:false,label:'',probe_md:''}},retry_button:{enabled:true,show_counter:false}};
 const config={proxyUrl:'http://127.0.0.1:1/v1',model:'synthetic-no-model',hasToken:true,coach:{name:'코치',personality:'',configured:true},
 profile:{profile_id:'synthetic-adult-comparison',display_name:'합성 홈페이지 수업',language:'ko',series_index:1,series_total:1,
 game:{template_tier:'website'},welcome:{greeting_md:'수정하고 검수해 보세요.',example_prompts:[]},publishing:{enabled:false,strategy:'local_only'},preview:{type:'live_server',auto_start:false},
 ux,input:{image_paste:true},sdk_tools:{read:true,write:true,browser:true},
 lesson:{version:'synthetic-v1',content:{title:'홈페이지 수정과 검수',duration_minutes:45,objective:'변경 이유와 검수 근거를 설명한다.',prerequisites:'합성 HTML 예제',starter:'index.html',steps:[{id:'verify',title:'진료시간 수정과 확인',instructions:'진료시간을 수정하고 모바일에서 확인하세요.',hint:'390px에서 버튼이 보이는지 확인하세요.',acceptance:'수정 전후 화면과 확인한 동작을 제출한다.'}]}}}};
 await emit({type:'config',config});
 const history=[{id:'u1',role:'user',content:'진료시간을 오후 6시로 수정하고, 모바일에서 예약 버튼이 보이는지 확인해줘.',createdAt:1},
 {id:'a1',role:'assistant',content:'진료시간과 모바일 배치를 살펴보겠습니다. 변경 후 확인한 범위를 알려드릴게요.',createdAt:2},
 {id:'t1',role:'tool',content:'',createdAt:3,tool:{icon:'🔧',label:'Read(index.html)',state:'done'}},
 {id:'t2',role:'tool',content:'',createdAt:4,tool:{icon:'🔧',label:'Edit(index.html)',state:'done'}},
 {id:'t3',role:'tool',content:'',createdAt:5,tool:{icon:'🔧',label:'mcp__hypeproof__browser_screenshot({})',state:'done'}},
 {id:'a2',role:'assistant',content:'진료시간을 오후 6시로 수정했습니다. 예약 버튼의 실제 전송 동작은 아직 확인하지 않았습니다.',createdAt:6}];
 await emit({type:'history',messages:history});await page.locator('textarea').waitFor();
 await shot(page,'studio-react-completed-480',{kind:'react-fixture',sourceCommit,state:'completed; synthetic messages, no tools actually executed',errors:[...errors]});
 await page.locator('.hps-lesson > summary').click();
 await shot(page,'studio-react-lesson-480',{kind:'react-fixture',sourceCommit,state:'lesson expanded'});
 await page.locator('.hps-lesson > summary').click();
 await emit({type:'streamStart',streamId:'synthetic-s2',messageId:'a3'});
 await emit({type:'toolLog',id:'t4',icon:'🔧',label:'mcp__hypeproof__browser_read({})',state:'running'});
 await page.locator('textarea').fill('예약 버튼 색상도 바꿔줘.');await page.locator('textarea').press('Enter');
 await page.getByText('다음에 보낼 메시지',{exact:true}).waitFor();
 await shot(page,'studio-react-running-queue-480',{kind:'react-fixture',sourceCommit,state:'running with queued follow-up'});
 await emit({type:'streamError',error:'서버에 연결할 수 없습니다. 연결 상태를 확인한 뒤 다시 시도하세요.',requestId:'synthetic-request'});
 await shot(page,'studio-react-error-480',{kind:'react-fixture',sourceCommit,state:'error after tool activity'});
 records.push({id:'studio-react-inspection',kind:'render-observation',errors,
 metrics:await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,
 textSize:getComputedStyle(document.querySelector('.hps-msg-body')).fontSize,
 headerButtonSize:getComputedStyle(document.querySelector('.hps-header button')).fontSize,
 toolLabelSize:getComputedStyle(document.querySelector('.hps-tool-label')).fontSize}))});
 await page.close();
 for(const entry of [
  ['cursor-browser-docs','https://cursor.com/docs/agent/browser','Browser','Native integration'],
  ['cursor-review-docs','https://cursor.com/docs/agent/agent-review','Agent Review',null],
  ['vscode-browser-docs','https://code.visualstudio.com/docs/agents/run/browser-tools','Use browser tools with agents','Add browser elements to chat'],
  ['cascade-docs','https://docs.windsurf.com/windsurf/cascade/cascade','Cascade',null],
  ['replit-testing-docs','https://docs.replit.com/replitai/app-testing','App Testing','Take over'],
 ]){
  const [id,url,heading,section]=entry,p=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  try{
   const response=await p.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
   await p.getByRole('heading',{name:heading,exact:false}).first().waitFor({timeout:15000});
   await p.waitForTimeout(1500);
   if(section){const h=p.getByRole('heading',{name:section,exact:false}).first();if(await h.count())await h.scrollIntoViewIfNeeded();}
   await shot(p,id,{kind:'official-page',requestedUrl:url,resolvedUrl:p.url(),httpStatus:response.status(),scope:'Official documentation captured in a browser; vendor screenshots are not our authenticated product execution'});
   records.push({id:id+'-images',images:await p.locator('img').evaluateAll(imgs=>imgs.filter(i=>i.width>250||i.naturalWidth>600).map(i=>({alt:i.alt,src:i.currentSrc,width:i.naturalWidth,height:i.naturalHeight})).slice(0,8))});
  }catch(e){records.push({id,requestedUrl:url,status:'BLOCKED',reason:e.message});}
  finally{await p.close();}
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
await fs.writeFile(path.join(here,'web-capture.json'),JSON.stringify(records,null,2)+'\n');
console.log(JSON.stringify(records,null,2));
