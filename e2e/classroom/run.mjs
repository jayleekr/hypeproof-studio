// Browser -> actual Chalk forwarding/board -> actual Service auth + SQLite.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {localClassroom} from '../../worker/test/harness/classroom.mjs';
const local=await localClassroom();const {default:chalk}=await import('../../chalk/src/index.ts');
const realFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>String(url).startsWith('https://service.test')?local.app.fetch(new Request(url,init),local.env,{waitUntil(){}}):realFetch(url,init);
const server=createServer(async(req,res)=>{try{const parts=[];for await(const p of req)parts.push(p);const body=Buffer.concat(parts);const r=await chalk.fetch(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined}),{...local.env,HPS_SERVICE_ORIGIN:'https://service.test'},{});res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(500).end();}});
let browser;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch();const student=await browser.newPage();const teacher=await browser.newPage();const errors=[];for(const p of [student,teacher])p.on('pageerror',e=>errors.push(e.message));
 await student.goto(origin+'/sharing');assert.equal(await student.locator('#consent').isChecked(),false);
 await student.locator('#token').fill(local.studentToken);await student.locator('#login button').first().click();await student.getByText('공유 중인 기록이 없습니다.').waitFor();await student.locator('#status').filter({hasText:'연결됨'}).waitFor();
 assert.equal(await student.locator('#token').inputValue(),'');
 await student.locator('#recipient').fill('teacher-a');await student.locator('#prompt').fill('합성 질문 <img src=x onerror="window.injected=true">');await student.locator('#verification').fill('390px에서 버튼 위치를 확인했습니다.');
 await student.locator('#submit').click();assert.equal(local.db.prepare('SELECT count(*) n FROM classroom_shares').get().n,0,'unchecked consent must not create');
 await student.locator('#consent').check();await student.locator('#submit').click();await student.locator('#records article').waitFor();
 await teacher.goto(origin+'/manage');await teacher.locator('#token').fill(local.teacherToken);await teacher.locator('#cohort').fill(local.cohort);await teacher.locator('#prefix').fill('student-');await teacher.locator('#connect button').first().click();await teacher.locator('#shares .share').waitFor();await teacher.locator('#status').filter({hasText:'연결됨'}).waitFor();assert.equal(await teacher.locator('#seats .seat').count(),2);assert.equal(await teacher.locator('#seats').getByText('연결·활동 확인 불가',{exact:true}).count(),2);assert.doesNotMatch(await teacher.locator('#degraded').innerText(),/failures|heartbeat/);
 assert.equal(await teacher.locator('#token').inputValue(),'');assert.equal(await teacher.locator('#shares').getByText('합성 질문',{exact:false}).count(),0,'list is metadata only');
 await teacher.getByRole('button',{name:'공유 기록 열기'}).click();await teacher.locator('#detail').waitFor();assert.match(await teacher.locator('#content').innerText(),/합성 질문/);assert.equal(await teacher.evaluate(()=>window.injected),undefined);
 await teacher.locator('#review-state').selectOption('answered');await teacher.locator('#feedback-text').fill('긴한국어검수내용'.repeat(80));await teacher.locator('#next-action').fill('다른 화면 너비에서도 확인하세요.');await teacher.getByRole('button',{name:'피드백 저장'}).click();await teacher.locator('#detail-status').filter({hasText:'저장했습니다'}).waitFor();
 const luminance=rgb=>rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);
 for(const p of [student,teacher]){const colors=await p.locator('input').first().evaluate(e=>{const s=getComputedStyle(e);return {border:s.borderTopColor,background:s.backgroundColor};});const a=luminance(colors.border),b=luminance(colors.background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3,'DT-02 control boundary contrast >=3:1');}
 const out=process.env.HPS_CLASSROOM_OUT||'test-results/classroom';mkdirSync(out,{recursive:true});
 for(const p of [student,teacher])for(const width of [375,390,768,1280,1440]){await p.setViewportSize({width,height:900});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:out+'/'+(p===student?'student':'teacher')+'-'+width+'.png',fullPage:true});}
 await student.locator('#refresh').click();await student.getByRole('button',{name:'내가 확인했고 해결됐어요'}).waitFor();await student.getByRole('button',{name:'누가 열람했는지 확인'}).click();await student.locator('#records').getByText(/teacher-a ·/).waitFor();
 await student.getByRole('button',{name:'내가 확인했고 해결됐어요'}).focus();await student.keyboard.press('Enter');await student.locator('#records').getByText(/상태 해결 확인/).waitFor();
 await student.getByRole('button',{name:'공유 철회·삭제'}).click();await student.getByText('공유 중인 기록이 없습니다.').waitFor();assert.equal(local.db.prepare('SELECT count(*) n FROM classroom_share_audit').get().n,0);
 await teacher.locator('#refresh').click();await teacher.locator('#shares').getByText(/공유된 기록이 없습니다/).waitFor();assert.equal(await teacher.locator('#detail').isHidden(),true);
 await teacher.locator('#disconnect').click();await teacher.locator('#token').fill('invalid');await teacher.locator('#connect button').first().click();await teacher.locator('#status').filter({hasText:'인증이 거부됐습니다'}).waitFor();
 for(const p of [student,teacher])assert.equal(await p.evaluate(()=>localStorage.length+sessionStorage.length),0);
 assert.deepEqual(errors,[]);console.log('PASS classroom browser: consent negative, share, metadata list, audited detail, escaped HTML, feedback, student-only confirmation, withdrawal cascade, 5 widths, keyboard confirmation, invalid auth, no credential storage');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));globalThis.fetch=realFetch;local.close();}
