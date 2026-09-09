import '../../worker/test/harness/loader.mjs';
import assert from 'node:assert/strict';
import {budgetHarness} from '../../worker/test/harness/budgets.mjs';
import {TEST_SECRET} from '../../worker/test/harness/index.mjs';
const {default:chalk}=await import('../src/index.ts');
const h=await budgetHarness(),original=globalThis.fetch,seen=[];
try{
 globalThis.fetch=async(url,init)=>{assert(String(url).startsWith('https://service.synthetic/'));seen.push(new Headers(init.headers));const body=init.body?JSON.parse(Buffer.from(init.body).toString()):undefined;const r=await h.request(new URL(url).pathname,{method:init.method,body,auth:seen.at(-1).get('authorization')});return Response.json(r.json,{status:r.status});};
 const env={HPS_SIGNING_SECRET:TEST_SECRET,ENVIRONMENT:'dev',HPS_SERVICE_ORIGIN:'https://service.synthetic'};
 const request=(path,auth,headers={})=>chalk.fetch(new Request('https://chalk.synthetic'+path,{headers:{authorization:auth,...headers}}),env,{});
 const path='/admin/cohorts/'+h.cohort+'/budgets';
 let r=await request(path,h.instructor,{'cf-access-authenticated-user-email':'forged@synthetic.invalid','x-hps-funding-source':'forged'});assert.equal(r.status,200);assert.equal((await r.json()).budgets[0].can_edit,false);
 assert.equal(seen[0].get('cf-access-authenticated-user-email'),null);assert.equal(seen[0].get('x-hps-funding-source'),null);
 assert.equal((await request(path,h.student)).status,403);assert.equal((await request(path,h.admin)).status,401);
 assert.equal((await request('/admin/access/budget-roots',h.instructor)).status,404);
 assert.equal((await request('/budgets','')).status,200);
 console.log('PASS Chalk budget page and actual Service forwarding: issuer scope is read-only without delegation; forged headers/student/Basic/operator routes denied');
}finally{globalThis.fetch=original;h.close();}
