// Local-only Service fixture. Synthetic identity and SQLite, never production credentials.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './index.mjs';
export async function localAuthoring({profileId: requestedProfile} = {}) {
  const app=await bootApp();
  const {listProfiles}=await import('../../src/profiles/index.ts');
  const {issueIssuer}=await import('../../src/lib/tokens.ts');
  const selected=listProfiles().find(p=>requestedProfile?p.id===requestedProfile:p.id.includes('boah-dental-director-copyclone'));
  const cohort=selected?.session.cohort_id;
  const profileId=selected?.id;
  if(!profileId) throw new Error('Dental profile missing');
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  // 마이그레이션은 파일명으로 명시해서 읽는다 — 새 파일을 만들고 여기 등록하지
  // 않으면 시험이 옛 스키마로 돌면서 **통과한다.** 초록인데 아무것도 안 본 상태다.
  for (const file of ['0002-chalk-authoring.sql','0011-rehearsal-evidence.sql'])
    db.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  const binding={prepare(sql){let args=[];return {
    bind(...a){args=a;return this;},
    async first(){return db.prepare(sql).get(...args)??null;},
    async run(){const r=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},
    async all(){return {success:true,results:db.prepare(sql).all(...args)};}
  };}};
  const env=createMockEnv({withSession:false,withRoster:false,environment:'development',env:{HPS_DB:binding}});
  const credential=async name=>(await issueIssuer({issuer:name,scopes:[{cohort,profiles:[profileId]}]},48,TEST_SECRET)).token;
  const token=await credential('instructor-seoyeon');
  const calls=[];
  const fetcher=async (url,options)=>{calls.push({path:new URL(url).pathname,method:options.method});return app.fetch(new Request(url,options),env,makeCtx());};
  return {origin:'https://local-authoring.test',cohort,profileId,token,fetcher,credential,db,env,calls,close:()=>db.close()};
}
