// Voluntary, recipient-scoped sharing. No access to historical session-log bodies.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, verify, type TokenPayload } from '../lib/tokens';
import { authorizeIssuerForCohort, type IssuerAuthz } from '../lib/instructor-auth';
import { getProfile } from '../profiles';
import { getActiveSession, getRoster, isTokenRevoked } from '../lib/kv';
import { scrubSecrets } from '../lib/scrub-secrets';
import { isMinorCohort } from '../lib/moderation';

type Row = {id:string;cohort_id:string;profile_id:string;student_id:string;recipient_id:string;session_id:string;kind:string;content_json:string;revision:number;status:string;feedback:string;next_action:string;created_at:number;expires_at:number};
type StudentEnv = {Bindings:Env;Variables:{student:TokenPayload}};
type TeacherEnv = {Bindings:Env;Variables:{teacher:IssuerAuthz}};
const idOK=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
const now=()=>Math.floor(Date.now()/1000);
const metadata=(r:Row)=>({id:r.id,student_id:r.student_id,recipient_id:r.recipient_id,profile_id:r.profile_id,session_id:r.session_id,kind:r.kind,revision:r.revision,status:r.status,created_at:r.created_at,expires_at:r.expires_at});
const studentView=(r:Row)=>({...metadata(r),content:JSON.parse(r.content_json),feedback:r.feedback,next_action:r.next_action});
const limit=bodyLimit({maxSize:32*1024,onError:c=>c.json({error:'share too large'},413)});
const json=async(c:any)=>{try{return await c.req.json();}catch{return null;}};

export const classroomStudent=new Hono<StudentEnv>();
classroomStudent.use('*',limit);
classroomStudent.use('*',async(c,next)=>{
 c.header('cache-control','no-store');
 const token=bearer(c.req.header('authorization'));if(!token)return c.json({error:'student Bearer required'},401);
 const p=await verify(token,c.env.HPS_SIGNING_SECRET);
 if(p.role==='issuer')return c.json({error:'student token required'},403);
 if(p.jti&&await isTokenRevoked(c.env.HPS_KV,p.jti))return c.json({error:'token revoked'},401);
 const profile=getProfile(p.p);
 if(!profile||profile.session.cohort_id!==p.c)return c.json({error:'profile/cohort mismatch'},403);
 // Child sharing needs a separate verified-guardian-consent contract.
 if(isMinorCohort(profile))return c.json({error:'sharing unavailable for this profile'},403);
 const roster=await getRoster(c.env.HPS_KV,p.c);
 if(!roster?.users.includes(p.u))return c.json({error:'not in roster'},403);
 c.set('student',p);return next();
});
classroomStudent.get('/shares',async c=>{
 const p=c.get('student');const rows=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE cohort_id=? AND student_id=? AND profile_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100').bind(p.c,p.u,p.p,now()).all<Row>();
 return c.json({shares:(rows.results??[]).map(studentView),limit:100});
});
classroomStudent.post('/shares',async c=>{
 const p=c.get('student'),b=await json(c);
 if(!b||!idOK(b.id)||!idOK(b.recipient_id)||!['help','submission'].includes(b.kind)||b.consent!==true||!Number.isInteger(b.duration_minutes)||b.duration_minutes<5||b.duration_minutes>1440)return c.json({error:'id, recipient, kind, consent and duration (5–1440 minutes) required'},400);
 const keys=['prompt','response','tool_summary','artifact_url','verification'];
 if(!b.content||typeof b.content!=='object'||Array.isArray(b.content)||Object.keys(b.content).some(k=>!keys.includes(k)))return c.json({error:'select supported content fields'},400);
 const content:Record<string,string>={};
 for(const k of keys){const value=b.content[k]??'';if(typeof value!=='string'||value.length>8000)return c.json({error:'invalid or excessive field'},400);content[k]=scrubSecrets(value);}
 if(!Object.values(content).some(v=>v.trim()))return c.json({error:'select content to share'},400);
 if(content.artifact_url){try{const url=new URL(content.artifact_url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}catch{return c.json({error:'artifact must be an http(s) URL without credentials'},400);}}
 const session=await getActiveSession(c.env.HPS_KV,p.c);
 if(!session||session.profile_id!==p.p||Date.parse(session.ends_at)<=Date.now()||Date.parse(session.starts_at)>Date.now())return c.json({error:'active matching class required to share'},403);
 const prior=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE id=?').bind(b.id).first<Row>();
 const contentJson=JSON.stringify(content);
 if(prior){if(prior.cohort_id===p.c&&prior.student_id===p.u&&prior.profile_id===p.p&&prior.recipient_id===b.recipient_id&&prior.kind===b.kind&&prior.content_json===contentJson&&prior.expires_at>now())return c.json(studentView(prior));return c.json({error:'request ID conflict'},409);}
 const stamp=now(),expires=Math.min(p.exp,stamp+b.duration_minutes*60);
 const count=await c.env.HPS_DB.prepare('SELECT count(*) AS n FROM classroom_shares WHERE cohort_id=? AND student_id=? AND expires_at>?').bind(p.c,p.u,stamp).first<{n:number}>();
 if((count?.n??0)>=100)return c.json({error:'active share limit reached; withdraw old shares'},429);
 const saved=await c.env.HPS_DB.prepare(`INSERT INTO classroom_shares(id,cohort_id,profile_id,student_id,recipient_id,session_id,kind,content_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *`).bind(b.id,p.c,p.p,p.u,b.recipient_id,session.session_id,b.kind,contentJson,stamp,expires).first<Row>();
 if(!saved)return c.json({error:'request ID conflict; reload'},409);
 return c.json(studentView(saved),201);
});
classroomStudent.delete('/shares/:id',async c=>{
 const p=c.get('student');const r=await c.env.HPS_DB.prepare('DELETE FROM classroom_shares WHERE id=? AND cohort_id=? AND student_id=? AND profile_id=? RETURNING id').bind(c.req.param('id'),p.c,p.u,p.p).first();
 return r?c.json({withdrawn:true}):c.json({error:'share not found'},404);
});
classroomStudent.post('/shares/:id/confirm',async c=>{
 const p=c.get('student'),b=await json(c);if(!Number.isInteger(b?.expected_revision))return c.json({error:'revision required'},400);
 const r=await c.env.HPS_DB.prepare("UPDATE classroom_shares SET status='resolved',revision=revision+1 WHERE id=? AND cohort_id=? AND student_id=? AND profile_id=? AND revision=? AND status='answered' AND expires_at>? RETURNING *").bind(c.req.param('id'),p.c,p.u,p.p,b.expected_revision,now()).first<Row>();
 return r?c.json(studentView(r)):c.json({error:'share changed, unavailable or not answered'},409);
});

export const classroomTeacher=new Hono<TeacherEnv>();
classroomTeacher.use('/cohorts/:cohort/classroom/*',limit);
classroomTeacher.use('/cohorts/:cohort/classroom/*',async(c,next)=>{
 c.header('cache-control','no-store');const auth=await authorizeIssuerForCohort(c,c.req.param('cohort')!);
 if(auth instanceof Response)return auth;if(!auth)return c.json({error:'instructor Bearer required'},401);
 c.set('teacher',auth);return next();
});
const root='/cohorts/:cohort/classroom/shares';
async function authorized(c:any){
 const a=c.get('teacher') as IssuerAuthz;
 const r=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE id=? AND cohort_id=? AND recipient_id=? AND expires_at>?').bind(c.req.param('id'),c.req.param('cohort'),a.payload.u,now()).first() as Row|null;
 return r&&a.scope.profiles.includes(r.profile_id)?r:null;
}
classroomTeacher.get(root,async c=>{
 const a=c.get('teacher');
 const rows=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE cohort_id=? AND recipient_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100').bind(c.req.param('cohort'),a.payload.u,now()).all<Row>();
 return c.json({recipient_id:a.payload.u,shares:(rows.results??[]).filter(r=>a.scope.profiles.includes(r.profile_id)).map(metadata),limit:100});
});
classroomTeacher.get(root+'/:id',async c=>{
 const r=await authorized(c);if(!r)return c.json({error:'share not found'},404);
 // Fail closed: no content leaves before the view audit is durably recorded.
 await c.env.HPS_DB.prepare('INSERT INTO classroom_share_audit(share_id,actor_id,action,at) VALUES(?,?,?,?)').bind(r.id,c.get('teacher').payload.u,'view',now()).run();
 return c.json(studentView(r));
});
classroomTeacher.put(root+'/:id',async c=>{
 const r=await authorized(c);if(!r)return c.json({error:'share not found'},404);
 const b=await json(c);
 if(!b||!Number.isInteger(b.expected_revision)||!['reviewing','answered'].includes(b.status)||typeof b.feedback!=='string'||b.feedback.length>8000||typeof b.next_action!=='string'||b.next_action.length>2000||!b.next_action.trim()||(b.status==='answered'&&!b.feedback.trim()))return c.json({error:'revision, status, feedback and next action required'},400);
 if(r.status==='resolved')return c.json({error:'resolved share is closed'},409);
 const saved=await c.env.HPS_DB.prepare("UPDATE classroom_shares SET status=?,feedback=?,next_action=?,revision=revision+1 WHERE id=? AND recipient_id=? AND revision=? AND expires_at>? AND status!='resolved' RETURNING *").bind(b.status,scrubSecrets(b.feedback),scrubSecrets(b.next_action),r.id,c.get('teacher').payload.u,b.expected_revision,now()).first<Row>();
 return saved?c.json(studentView(saved)):c.json({error:'revision conflict; preserve edits and reload'},409);
});
classroomStudent.get('/shares/:id/audit',async c=>{
 const p=c.get('student');const r=await c.env.HPS_DB.prepare('SELECT id FROM classroom_shares WHERE id=? AND cohort_id=? AND student_id=? AND profile_id=? AND expires_at>?').bind(c.req.param('id'),p.c,p.u,p.p,now()).first();
 if(!r)return c.json({error:'share not found'},404);
 const audit=await c.env.HPS_DB.prepare('SELECT actor_id,action,at FROM classroom_share_audit WHERE share_id=? ORDER BY id DESC LIMIT 100').bind(c.req.param('id')).all();return c.json({audit:audit.results??[]});
});

export async function purgeExpiredClassroomShares(env:Env){
 // New voluntary data only; existing logs and their retention are untouched.
 return env.HPS_DB.prepare('DELETE FROM classroom_shares WHERE expires_at<=?').bind(now()).run();
}
