// Actual browser UI -> Chalk HTTP -> Service routing/SQLite. No live classroom.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { localAuthoring } from '../../worker/test/harness/dental-authoring.mjs';
const models=process.env.HPS_CHALK_MODEL_SELECTION==='1';
const local=await localAuthoring(models?{profileId:'studio-native-trial'}:{});
const {default:chalk}=await import('../../chalk/src/index.ts');
const {TEST_SECRET}=await import('../../worker/test/harness/index.mjs');
const env={HPS_SIGNING_SECRET:TEST_SECRET,ENVIRONMENT:'dev',HPS_SERVICE_ORIGIN:local.origin};
const realFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url).startsWith(local.origin)?local.fetcher(url,options):realFetch(url,options);
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const r=await chalk.fetch(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined}),env,{});res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(500);res.end('test server failure');}});
let browser;
try {
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});
 page.on('dialog',d=>d.accept());const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const connect=async(p,token=local.token)=>{await p.goto(origin+'/authoring');await p.locator('#token').fill(token);await p.locator('#cohort').fill(local.cohort);await p.locator('#profile').fill(local.profileId);};
 const wait=async(text)=>{await page.locator('#status').filter({hasText:text}).waitFor();};
 await page.goto(origin+'/start');
 await page.getByRole('heading',{name:'첫 강의 준비하기'}).waitFor();
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const guideOut=process.env.HPS_CHALK_AUTHORING_OUT||'test-results/chalk-authoring';mkdirSync(guideOut,{recursive:true});
  await page.screenshot({path:guideOut+'/instructor-start-'+width+'.png',fullPage:true});
 }
 await page.getByRole('navigation').getByRole('link',{name:'수업 작성',exact:true}).click();
 assert.ok(page.url().endsWith('/authoring'));
 await page.setViewportSize({width:390,height:844});
 await connect(page);await page.locator('#import').setInputFiles(new URL('../../docs/curriculum/dental-ownership/generated/drafts.json',import.meta.url).pathname);await wait('강의를 선택한 뒤');await page.locator('#courses').selectOption('0');
 await page.locator('#title').fill('합성 강사 수정 제목');await page.locator('#assistant_name').fill('제작 파트너');
 if(models){await page.locator('#models-load').click();await page.locator('#models-status').filter({hasText:'사용 가능한 모델 9개'}).waitFor();await page.locator('#model-mode').selectOption('choice');await page.locator('#model-default').selectOption('claude-sonnet-5');await page.locator('#effort-mode').selectOption('choice');await page.locator('#effort-default').selectOption('low');await page.locator('#effort-allowed input[value=high]').uncheck();for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const out=process.env.HPS_CHALK_AUTHORING_OUT||'test-results/chalk-authoring';mkdirSync(out,{recursive:true});await page.locator('#models-load').locator('..').screenshot({path:out+'/model-choice-'+width+'.png'});await page.locator('#effort-fields').screenshot({path:out+'/effort-choice-'+width+'.png'});}}
 await page.locator('#save').click();await wait('저장했습니다. revision 1');
 await page.locator('#version').fill('m2026.09.06-1');await page.locator('#freeze').click();await wait('불변 버전을 저장');assert.match(await page.locator('#version-view').innerText(),/합성 강사 수정 제목/);assert.match(await page.locator('#version-view').innerText(),/제작 파트너/);
 await page.reload();await page.locator('#token').fill(local.token);await page.locator('#cohort').fill(local.cohort);await page.locator('#profile').fill(local.profileId);await page.locator('#course').fill('dental-ownership-l1');await page.locator('#load').click();await wait('revision 1');assert.equal(await page.locator('#title').inputValue(),'합성 강사 수정 제목');assert.equal(await page.locator('#assistant_name').inputValue(),'제작 파트너');
 if(models){assert.equal(await page.locator('#model-mode').inputValue(),'choice');await page.locator('#models-load').click();await page.locator('#models-status').filter({hasText:'사용 가능한 모델 9개'}).waitFor();assert.equal(await page.locator('#model-default').inputValue(),'claude-sonnet-5');assert.equal(await page.locator('#effort-mode').inputValue(),'choice');assert.equal(await page.locator('#effort-default').inputValue(),'low');assert.equal(await page.locator('#effort-allowed input[value=high]').isChecked(),false);}
 // Real instructor delivery -> signed student credential -> student UI, using production SQLite routes.
 const {setRoster,startSession}=await import('../../worker/src/lib/kv.ts');
 await setRoster(local.env.HPS_KV,local.cohort,['synthetic-student']);
 await startSession(local.env.HPS_KV,local.cohort,{session_id:'synthetic-lesson',profile_id:local.profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 await page.locator('#version').fill('m2026.09.06-1');await page.locator('#student').fill('synthetic-student');await page.locator('#hours').fill('1');await page.locator('#deliver').click();await wait('참여 코드를 발급');
 const lessonToken=await page.locator('#student-token').inputValue();assert.ok(lessonToken);
 const learner=await browser.newPage();await learner.goto(origin+'/learn');await learner.locator('#token').fill(lessonToken);await learner.locator('#open').click();await learner.locator('#status').filter({hasText:'지정한 버전을 열었습니다'}).waitFor();
 assert.match(await learner.locator('#lesson').innerText(),/합성 강사 수정 제목/);
 assert.equal(await learner.locator('#token').inputValue(),'');
 for(const width of [375,390,768,1280,1440]){await learner.setViewportSize({width,height:900});assert.ok(await learner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const out=process.env.HPS_CHALK_AUTHORING_OUT||'test-results/chalk-authoring';mkdirSync(out,{recursive:true});await learner.screenshot({path:out+'/student-lesson-'+width+'.png',fullPage:true});}
 await learner.locator('summary').first().focus();await learner.keyboard.press('Enter');assert.equal(await learner.locator('details').first().getAttribute('open'),'');
 await learner.locator('#token').fill('invalid');assert.equal(await learner.locator('#lesson').isHidden(),true);await learner.locator('#open').click();await learner.locator('#status').filter({hasText:'HTTP 401'}).waitFor();
 assert.equal(await learner.evaluate(()=>localStorage.length+sessionStorage.length),0);
 await learner.close();await page.locator('#clear-student').click();
 // Concurrent editor advances revision; original tab must preserve unsaved work on 409.
 const second=await browser.newPage();await connect(second);await second.locator('#course').fill('dental-ownership-l1');await second.locator('#load').click();await second.locator('#status').filter({hasText:'revision 1'}).waitFor();await second.locator('#title').fill('다른 편집 revision 2');await second.locator('#assistant_name').fill('초안 전용 새 이름');
 if(models){await second.locator('#models-load').click();await second.locator('#models-status').filter({hasText:'사용 가능한 모델 9개'}).waitFor();await second.locator('#model-mode').selectOption('fixed');await second.locator('#model-default').selectOption('claude-opus-5');await second.locator('#effort-mode').selectOption('fixed');await second.locator('#effort-default').selectOption('medium');}
 await second.locator('#save').click();await second.locator('#status').filter({hasText:'revision 2'}).waitFor();
 await page.locator('#title').fill('충돌 후 보존할 내용');await page.locator('#assistant_name').fill('충돌 뒤 남아야 할 이름');await page.locator('#save').click();await wait('HTTP 409');assert.equal(await page.locator('#title').inputValue(),'충돌 후 보존할 내용');assert.equal(await page.locator('#assistant_name').inputValue(),'충돌 뒤 남아야 할 이름');assert.equal(await page.locator('#freeze').isDisabled(),true);
 await page.locator('#version').fill('m2026.09.06-1');await page.locator('#version-load').click();await wait('불변 버전을 확인');assert.match(await page.locator('#version-view').innerText(),/합성 강사 수정 제목/);assert.match(await page.locator('#version-view').innerText(),/제작 파트너/);assert.equal(await page.locator('#title').inputValue(),'충돌 후 보존할 내용');assert.equal(await page.locator('#assistant_name').inputValue(),'충돌 뒤 남아야 할 이름');
 if(models){const frozen=JSON.parse(await page.locator('#version-view').innerText());assert.equal(frozen.module.content.model.default,'claude-sonnet-5');assert.equal(frozen.module.content.model.allowed.length,9);assert.equal(frozen.module.content.model.binding.choices[0].id,'claude-sonnet-5');assert.deepEqual(frozen.module.content.model.effort,{default:'low',allowed:['low','medium']});assert.equal(frozen.module.content.model.binding.effort.revision,'hps-effort/1');console.log('PASS Chalk model choice save/reopen/freeze; later fixed-model draft preserves original version');}
 // Authentication failure must not overwrite the form or be called an expiry.
 await page.locator('#token').fill('invalid');await page.locator('#load').click();await wait('HTTP 401');assert.equal(await page.locator('#title').inputValue(),'충돌 후 보존할 내용');assert.equal(await page.locator('#assistant_name').inputValue(),'충돌 뒤 남아야 할 이름');
 const {issue}=await import('../../worker/src/lib/tokens.ts');const student=(await issue({u:'synthetic-student',c:local.cohort,p:local.profileId},1,TEST_SECRET)).token;await page.locator('#token').fill(student);await page.locator('#load').click();await wait('HTTP 403');assert.equal(await page.locator('#title').inputValue(),'충돌 후 보존할 내용');assert.equal(await page.locator('#assistant_name').inputValue(),'충돌 뒤 남아야 할 이름');
 await page.locator('#need').fill('390px 화면 검수');await page.locator('#request').click();assert.match(await page.locator('#request-status').innerText(),/미접수/);const href=await page.locator('#request-link').getAttribute('href');assert.ok(!href.includes(student));assert.equal(new URL(href).hostname,'github.com');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const out=process.env.HPS_CHALK_AUTHORING_OUT||'test-results/chalk-authoring';mkdirSync(out,{recursive:true});await page.locator('#forget').click();await page.screenshot({path:out+'/authoring-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS Chalk browser: import/edit/save/reopen/freeze, immutable version + AI name, concurrent 409 name/edit preservation, 401/403 preservation, request draft, mobile, no token storage');
} finally {if(browser)await browser.close();await new Promise(r=>server.close(r));globalThis.fetch=realFetch;local.close();}
