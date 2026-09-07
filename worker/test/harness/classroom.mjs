// Synthetic classroom fixture: real HTTP routing, token verifier and SQLite.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp,createMockEnv,makeCtx,TEST_SECRET } from './index.mjs';
export async function localClassroom(){
 const app=await bootApp();const {issue,issueIssuer}=await import('../../src/lib/tokens.ts');
 const {setRoster,startSession}=await import('../../src/lib/kv.ts');
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(readFileSync(new URL('../../schema.sql',import.meta.url),'utf8'));
 const migration=readFileSync(new URL('../../migrations/0003-classroom-sharing.sql',import.meta.url),'utf8');db.exec(migration);db.exec(migration);
 let failure='';
 const binding={prepare(sql){let args=[];const q=()=>{if(failure&&sql.includes(failure))throw Error('injected storage failure');return db.prepare(sql);};return{bind(...a){args=a;return this;},async first(){return q().get(...args)??null;},async run(){const r=q().run(...args);return{success:true,meta:{changes:Number(r.changes)}};},async all(){return{success:true,results:q().all(...args)};}};}};
 const env=createMockEnv({withSession:false,withRoster:false,environment:'dev',env:{HPS_DB:binding}});
 const cohort='boah-dental-2026-a',profile='boah-dental-director-copyclone-2026-s1';
 await setRoster(env.HPS_KV,cohort,['student-a','student-b']);
 await startSession(env.HPS_KV,cohort,{session_id:'classroom-test-session',profile_id:profile,starts_at:new Date(Date.now()-60000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 const teacher=async(name='teacher-a',profiles=[profile],c=cohort)=>(await issueIssuer({issuer:name,scopes:[{cohort:c,profiles}]},1,TEST_SECRET)).token;
 const student=async(name='student-a',p=profile,c=cohort)=>(await issue({u:name,c,p},2,TEST_SECRET)).token;
 const teacherToken=await teacher(),studentToken=await student();
 async function request(path,method='GET',body,token=teacherToken){const r=await app.fetch(new Request('https://service.test'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,makeCtx());const raw=await r.text();let json;try{json=JSON.parse(raw);}catch{}return{status:r.status,json,raw,headers:r.headers};}
 return{app,env,db,cohort,profile,teacher,student,teacherToken,studentToken,request,fail:s=>{failure=s;},close:()=>db.close()};
}
