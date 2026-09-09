import './loader.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT, PROFILE } from './index.mjs';
const { issue, issueIssuer } = await import('../../src/lib/tokens.ts');

export const syntheticPlan = (revision='synthetic-plan-1') => ({
  schema:'hps-access-plan/1',revision,sku:'synthetic-included',label:'Synthetic included class',
  source:{repository:'jayleekr/hypeprooflab',path:'web/src/lib/pricing.ts',commit:'a'.repeat(40),pricing_version:'synthetic-only',content_sha256:'b'.repeat(64)},
  publication:'synthetic',approval_ref:null,mode:'included',sale:{currency:'USD',minor_units:100},
  policy:{timezone:'Asia/Seoul',renewal:'calendar',overage:'deny',rollover:'none',grace:'none'},
  allowed:{models:['gpt-5.6-luna','claude-sonnet-4-6'],efforts:['low','medium'],features:[],runtimes:['proxy','agent-sdk']},
  included:[{meter:'currency:USD:micro',amount:100}],
});
export const syntheticEvent = (id='contract-class', kind='cohort', subject=COHORT) => ({
  schema:'hps-access-event/1',event_id:id+'-v1',contract_id:id,source_version:1,verification_ref:'synthetic-server-verified-snapshot',
  subject:{kind,id:subject},payer:{kind:'sponsor',id:'synthetic-payer'},plan_revision:'synthetic-plan-1',
  period:{id:id+'-period-1',starts_at:Date.now()-100000,ends_at:Date.now()+3600000},state:'active',
});
export function sqliteBinding(db) {
  return { prepare(sql) {
    let args=[];
    const stmt={bind(...a){args=a;return stmt;},
      _run(){const r=db.prepare(sql).run(...args);return{success:true,results:[],meta:{changes:Number(r.changes)}};},
      async run(){return stmt._run();},async first(){return db.prepare(sql).get(...args)??null;},
      async all(){return{success:true,results:db.prepare(sql).all(...args)};}};
    return stmt;
  },async batch(statements){db.exec('BEGIN');try{const r=statements.map(s=>s._run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
export async function accessHarness(binding) {
  const db=binding?null:new DatabaseSync(':memory:');
  if(db)db.exec(readFileSync(new URL('../../schema.sql',import.meta.url),'utf8'));
  const env=createMockEnv({adminPassword:'synthetic-admin',env:{HPS_ACCESS_CONTRACTS:'enabled',ENVIRONMENT:'dev'}});
  env.HPS_ADMIN_PASSWORD='synthetic-admin';env.HPS_DB=binding??sqliteBinding(db);
  const app=await bootApp();
  const admin='Basic '+Buffer.from('test:synthetic-admin').toString('base64');
  const student='Bearer '+(await issue({u:'kid01',c:COHORT,p:PROFILE},1,TEST_SECRET)).token;
  const instructor='Bearer '+(await issueIssuer({issuer:'synthetic-teacher',scopes:[{cohort:COHORT,profiles:[PROFILE]}]},1,TEST_SECRET)).token;
  await env.HPS_KV.put(`cohort:${COHORT}:roster`,JSON.stringify({users:['kid01','kid02']}));
  async function request(path,{method='GET',body,auth=admin,headers={}}={}) {
    const ctx=makeCtx(),r=await app.fetch(new Request('https://synthetic.test'+path,{method,headers:{authorization:auth,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,ctx);
    const text=await r.text();await ctx.settle();let json;try{json=JSON.parse(text);}catch{json=null;}return{status:r.status,text,json,headers:r.headers};
  }
  return{env,db,request,admin,student,instructor,cohort:COHORT,profile:PROFILE,close(){db?.close();}};
}
