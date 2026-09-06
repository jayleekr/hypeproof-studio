// Chalk must remain a forwarding surface for authoring, including reads.
import assert from 'node:assert/strict';
import '../../worker/test/harness/loader.mjs';
const { default: chalk } = await import('../src/index.ts');
const path='/admin/cohorts/test-cohort/authoring/course-1';
const env={HPS_SIGNING_SECRET:'test-secret-0123456789abcdef',ENVIRONMENT:'dev',HPS_SERVICE_ORIGIN:'https://service.test'};
const original=globalThis.fetch;
let calls=[];
globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({revision:1},{status:200});};
try {
 for(const [method,suffix] of [['GET',''],['PUT',''],['GET','/versions/m2026.09.06-1'],['PUT','/versions/m2026.09.06-1']]) {
  const body=method==='PUT'?JSON.stringify({expected_revision:0}):undefined;
  const r=await chalk.fetch(new Request('https://chalk.test'+path+suffix,{method,body,headers:{authorization:'Bearer fixture','content-type':'application/json','cf-access-authenticated-user-email':'forged@example.test'}}),env,{});
  assert.equal(r.status,200);const call=calls.at(-1);assert.equal(call.url,'https://service.test'+path+suffix);assert.equal(call.init.method,method);
  assert.equal(call.init.headers.get('authorization'),'Bearer fixture');assert.equal(call.init.headers.get('cf-access-authenticated-user-email'),null);
  if(body)assert.equal(new TextDecoder().decode(call.init.body),body);
 }
 const count=calls.length;
 for(const method of ['DELETE','POST'])assert.equal((await chalk.fetch(new Request('https://chalk.test'+path,{method,headers:{authorization:'Bearer fixture'}}),env,{})).status,404);
 assert.equal((await chalk.fetch(new Request('https://chalk.test'+path,{headers:{authorization:'Basic ignored'}}),env,{})).status,401);
 assert.equal(calls.length,count);
 globalThis.fetch=async()=>Response.json({error:'owner denied'},{status:404});
 assert.equal((await chalk.fetch(new Request('https://chalk.test'+path,{headers:{authorization:'Bearer fixture'}}),env,{})).status,404);
 console.log('PASS authoring forward: GET/PUT, draft/version, header filtering, method restriction, Service verdict preserved');
} finally {globalThis.fetch=original;}
