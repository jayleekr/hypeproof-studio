import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {localAuthoring} from '../../worker/test/harness/dental-authoring.mjs';
const local=await localAuthoring();
const {default:chalk}=await import('../../chalk/src/index.ts');
const {TEST_SECRET}=await import('../../worker/test/harness/index.mjs');
const env={...local.env,HPS_SIGNING_SECRET:TEST_SECRET,ENVIRONMENT:'dev',HPS_SERVICE_ORIGIN:local.origin};
const realFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url).startsWith(local.origin)?local.fetcher(url,options):realFetch(url,options);
const preview=process.argv.includes('--preview');
const server=createServer(async(req,res)=>{try{
 const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
 const r=await chalk.fetch(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined}),env,{});
 res.writeHead(r.status,Object.fromEntries(r.headers));
 if(preview&&req.url==='/authoring'){
 let html=await r.text();html=html.replace('<nav>',`<aside style="padding:12px;background:#f4e8cb;border-radius:8px">로컬 체험판 · 실제 운영 서버와 연결되지 않습니다. 종료하면 테스트 강의는 사라집니다. <button id="trial-connect">테스트 강사로 연결</button></aside><nav>`);
 html=html.replace('</html>',`<script>document.getElementById('trial-connect').onclick=()=>{document.getElementById('token').value=${JSON.stringify(local.token)};document.getElementById('connect').click();};</script></html>`);res.end(html);
 }else res.end(Buffer.from(await r.arrayBuffer()));
 }catch(e){res.writeHead(500);res.end('Local preview failure');console.error(e.message);}});
server.listen(preview?8896:0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
if(preview){console.log('PREVIEW '+origin+'/authoring');}
else{
 let browser;
 try{
 browser=await chromium.launch(process.env.HPS_BROWSER_CHANNEL ? {channel:process.env.HPS_BROWSER_CHANNEL} : {});const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(origin+'/authoring');await page.locator('#token').fill(local.token);await page.locator('#connect').click();
 await page.locator('#connection-status').filter({hasText:'연결되었습니다'}).waitFor();
 assert.equal(await page.locator('#profile').inputValue(),local.profileId);
 assert.equal(await page.locator('#cohort').isVisible(),false);
 await page.locator('#new').click();await page.locator('#title').fill('AI 창업 첫 수업');
 await page.locator('#starter').fill('사용자 인터뷰 질문 예시와 빈 관찰 노트');await page.locator('#audience').fill('초등 고학년');await page.locator('#objective').fill('사용자의 문제를 정의하고 결과를 직접 검증한다.');
 await page.locator('.step [data-field=title]').fill('사용자의 문제 확인');await page.locator('.step [data-field=instructions]').fill('사용자 한 명에게 불편한 점을 묻고 해결하려는 문제를 한 문장으로 적는다.');await page.locator('.step [data-field=acceptance]').fill('관찰한 사실과 자신의 추측을 나누어 설명한다.');
 const id=await page.locator('#course').inputValue();assert.match(id,/^course-[a-f0-9-]+$/);
 // Clearing the visible setting must unbind the hidden target without discarding edits.
 await page.locator('#setting').selectOption('');assert.equal(await page.locator('#cohort').inputValue(),'');assert.equal(await page.locator('#profile').inputValue(),'');assert.equal(await page.locator('#save').isEnabled(),false);assert.equal(await page.locator('#title').inputValue(),'AI 창업 첫 수업');
 await page.locator('#new').click();await page.locator('#status').filter({hasText:'먼저 수업 설정을 선택하세요.'}).waitFor();assert.equal(await page.locator('#course').inputValue(),id);
 // Selecting the same server-verified setting restores the binding and keeps the draft.
 await page.locator('#setting').selectOption('0');assert.equal(await page.locator('#cohort').inputValue(),local.cohort);assert.equal(await page.locator('#profile').inputValue(),local.profileId);assert.equal(await page.locator('#title').inputValue(),'AI 창업 첫 수업');assert.equal(await page.locator('#save').isEnabled(),true);
 await page.locator('#save').click();await page.locator('#status').filter({hasText:'revision 1'}).waitFor();
 await page.locator('#freeze').click();await page.locator('#completion').filter({hasText:'강의가 확정되었습니다'}).waitFor();
 assert.match(await page.locator('#version').inputValue(),/^m\d{4}\.\d{2}\.\d{2}-1$/);
 const firstVersion=await page.locator('#version').inputValue();
 await page.locator('#title').fill('수정한 강의');await page.locator('#save').click();await page.locator('#status').filter({hasText:'revision 2'}).waitFor();await page.locator('#freeze').click();await page.locator('#completion').filter({hasText:'강의가 확정되었습니다'}).waitFor();assert.notEqual(await page.locator('#version').inputValue(),firstVersion);
 mkdirSync('test-results/chalk-simple',{recursive:true});
 for(const width of [1280,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'test-results/chalk-simple/authoring-'+width+'.png',fullPage:true});}
 // Reload and reopen with existing escape hatch; automatic IDs must remain recoverable.
 await page.reload();await page.locator('#token').fill(local.token);await page.locator('#connect').click();await page.locator('#connection-status').filter({hasText:'연결되었습니다'}).waitFor();await page.getByText('저장한 강의 열기 · 파일 가져오기',{exact:true}).click();await page.locator('#course').fill(id);await page.locator('#load').click();await page.locator('#status').filter({hasText:'revision 2'}).waitFor();assert.equal(await page.locator('#title').inputValue(),'수정한 강의');
 // Syntactically valid but forged credential must never produce trusted choices.
 const forged=local.token.slice(0,-10)+'AAAAAAAAAA';await page.locator('#token').fill(forged);await page.locator('#connect').click();await page.locator('#status').filter({hasText:'HTTP 401'}).waitFor();assert.equal(await page.locator('#setting-label').isVisible(),false);assert.equal(await page.locator('#cohort').inputValue(),'');assert.equal(await page.locator('#title').inputValue(),'수정한 강의');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);
 console.log('PASS: verified settings, cleared-setting target removal and edit preservation, automatic IDs, real SQLite save/freeze/reopen, fresh versions, forged token denial, mobile layout, no credential storage');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));globalThis.fetch=realFetch;local.close();}
}
