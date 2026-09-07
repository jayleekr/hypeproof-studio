import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import {localClassroom} from '../../worker/test/harness/classroom.mjs';
const f=await localClassroom();const {default:chalk}=await import('../src/index.ts');const savedFetch=globalThis.fetch;const calls=[];
const env={...f.env,HPS_SERVICE_ORIGIN:'https://service.test'};
globalThis.fetch=async(url,init)=>{calls.push({url,init});return f.app.fetch(new Request(url,init),f.env,{waitUntil(){}});};
const base=`/admin/cohorts/${f.cohort}/classroom/shares`;
async function request(path,method='GET',body,token=f.teacherToken){return chalk.fetch(new Request('https://chalk.test'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','cf-access-authenticated-user-email':'forged@example.test','x-hps-operator-secret':'not-forwarded'},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil(){}});}
try{
 for(const file of ['manage','sharing']){
  const r=await request('/'+file);assert.equal(r.status,200);const html=await r.text();assert.match(html,/lang="ko"/);const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];assert.ok(script);new Script(script);
  assert.ok(!/localStorage|sessionStorage|\.innerHTML\s*=|insertAdjacentHTML|document\.cookie/.test(script));assert.match(script,/textContent/);assert.match(script,/AbortController/);assert.match(html,/focus-visible/);assert.match(html,/role="status"/);
 }
 const student='/v1/classroom/shares';const body={id:'forward-share',recipient_id:'teacher-a',kind:'help',consent:true,duration_minutes:60,content:{prompt:'내가 선택한 질문'}};
 assert.equal((await request(student,'POST',body,f.studentToken)).status,201);
 for(const {init} of calls){assert.equal(init.headers.get('cf-access-authenticated-user-email'),null);assert.equal(init.headers.get('x-hps-operator-secret'),null);}
 const listing=await request(base);assert.equal(listing.status,200);assert.equal(listing.headers.get('cache-control'),'no-store');assert.ok(!(await listing.text()).includes('내가 선택한 질문'));
 const detail=await request(base+'/forward-share');assert.equal(detail.status,200);assert.ok((await detail.text()).includes('내가 선택한 질문'));
 assert.equal((await request(base+'/forward-share','GET',undefined,await f.teacher('teacher-b'))).status,404);
 assert.equal((await request(base+'/forward-share','PUT',{expected_revision:1,status:'answered',feedback:'확인할 위치',next_action:'미리보기 확인'})).status,200);
 assert.equal((await request(student+'/forward-share/confirm','POST',{expected_revision:2},f.studentToken)).status,200);
 assert.equal((await request(student+'/forward-share','DELETE',undefined,f.studentToken)).status,200);
 assert.equal((await request(base+'/forward-share')).status,404);
 const before=calls.length;assert.equal((await request('/v1/classroom/not-allowed','POST',{},f.studentToken)).status,404);assert.equal(calls.length,before);
 const noAuth=await chalk.fetch(new Request('https://chalk.test'+base),env,{});assert.equal(noAuth.status,401);
 // Existing metadata board and raw-log operator gate remain separate.
 const manage=readFileSync(new URL('../src/ui/manage.html',import.meta.url),'utf8');assert.ok(!manage.includes('/logs/'));assert.match(manage,/classroom\/shares/);
 console.log('PASS classroom surface: pages, syntax, private tokens, safe rendering, forwarding allowlist, header stripping, selected sharing, feedback, confirmation, withdrawal');
}finally{globalThis.fetch=savedFetch;f.close();}
