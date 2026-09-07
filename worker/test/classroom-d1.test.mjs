import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {localClassroom} from './harness/classroom.mjs';
const compatibilityDate=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test")}}',compatibilityDate,d1Databases:['HPS_DB']});
const f=await localClassroom();
try{
 const db=await mf.getD1Database('HPS_DB');
 const sql=readFileSync(new URL('../migrations/0003-classroom-sharing.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'');
 for(let n=0;n<2;n++)for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
 f.env.HPS_DB=db;const base=`/admin/cohorts/${f.cohort}/classroom/shares`;
 const body={id:'d1-share',recipient_id:'teacher-a',kind:'help',consent:true,duration_minutes:60,content:{prompt:'공유한 질문'}};
 assert.equal((await f.request('/v1/classroom/shares','POST',body,f.studentToken)).status,201);
 assert.equal((await f.request(base+'/d1-share')).status,200);
 const update={expected_revision:1,status:'answered',feedback:'확인',next_action:'다시 실행'};
 const responses=await Promise.all([f.request(base+'/d1-share','PUT',update),f.request(base+'/d1-share','PUT',{...update,feedback:'다른 값'})]);
 assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM classroom_share_audit').first()).n,1);
 assert.equal((await f.request('/v1/classroom/shares/d1-share','DELETE',undefined,f.studentToken)).status,200);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM classroom_share_audit').first()).n,0);
 assert.equal((await f.request(base+'/d1-share')).status,404);
 console.log('PASS actual local workerd/D1: idempotent migration, share, audited read, concurrent CAS, delete cascade, access revoked');
}finally{f.close();await mf.dispose();}
