// Voluntary, recipient-scoped sharing. No access to historical session-log bodies.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, verify, type TokenPayload } from '../lib/tokens';
import { authorizeIssuerForCohort, type IssuerAuthz } from '../lib/instructor-auth';
import { getProfile } from '../profiles';
import { profileServesCohort } from '../lib/cohort-binding';
import { getActiveSession, getRoster, isTokenRevoked } from '../lib/kv';
import { scrubSecrets } from '../lib/scrub-secrets';
import { isMinorCohort } from '../lib/moderation';
import { opsEnabled } from './classroom-ops';
import { NOT_FENCED } from '../lib/classroom-distribution-store';

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
 if(!profile||!(await profileServesCohort(c.env,profile,p)).ok)return c.json({error:'profile/cohort mismatch'},403);
 // Child sharing needs a separate verified-guardian-consent contract.
 if(isMinorCohort(profile))return c.json({error:'sharing unavailable for this profile'},403);
 const roster=await getRoster(c.env.HPS_KV,p.c);
 if(!roster?.users.includes(p.u))return c.json({error:'not in roster'},403);
 c.set('student',p);return next();
});
// #751 native help — who may receive this learner's help request NOW. Derived only from records the Service wrote: the active
// class session of the token's cohort/profile, this learner's live seat in that class run, the seat's active operations
// connection and the instructor who issued its pairing (not KV-revoked, not D1-fenced). The learner never names an instructor
// and never receives an instructor credential. Anything unreadable is `unknown`, never "no instructor".
type Assignment={recipient_id:string;class_run_id:string;seat_id:string;grant_id:string;class_ends_at:string;expires_cap:number};
async function helpAssignment(env:Env,p:TokenPayload):Promise<Assignment|{reason:string}>{
 if(!opsEnabled(env))return{reason:'ops_disabled'};
 const session=await getActiveSession(env.HPS_KV,p.c);
 if(!session||session.profile_id!==p.p||Date.parse(session.ends_at)<=Date.now()||Date.parse(session.starts_at)>Date.now())return{reason:'no_active_class'};
 try{
  const g=await env.HPS_DB.prepare(`SELECT g.id,g.seat_id,g.issuer_id,g.issuer_jti FROM ops_grants g JOIN class_run_ops o ON o.class_run_id=g.class_run_id AND o.cohort_id=g.cohort_id AND o.profile_id=g.profile_id
 JOIN class_run_seats s ON s.class_run_id=g.class_run_id AND s.seat_id=g.seat_id AND s.seat_revision=g.seat_revision AND s.student_id=g.student_id AND s.replaced_at IS NULL
 WHERE g.class_run_id=? AND g.cohort_id=? AND g.profile_id=? AND g.student_id=? AND g.kind='connection' AND g.state='active' AND g.expires_at>? ORDER BY g.created_at DESC LIMIT 1`).bind(session.session_id,p.c,p.p,p.u,Date.now()).first<{id:string;seat_id:string;issuer_id:string|null;issuer_jti:string|null}>();
  if(!g)return{reason:'not_connected'};
  if(!g.issuer_id||!idOK(g.issuer_id))return{reason:'no_instructor'};
  if(g.issuer_jti){
   if(await isTokenRevoked(env.HPS_KV,g.issuer_jti))return{reason:'instructor_revoked'};
   const open=await env.HPS_DB.prepare('SELECT 1 AS ok WHERE '+NOT_FENCED).bind(g.issuer_jti).first<{ok:number}>();
   if(!open)return{reason:'instructor_revoked'};
  }
  return{recipient_id:g.issuer_id,class_run_id:session.session_id,seat_id:g.seat_id,grant_id:g.id,class_ends_at:session.ends_at,expires_cap:p.exp};
 }catch(err){console.error('help assignment unreadable:',err);return{reason:'unknown'};}
}
/**
 * The assignment a write may be made under, evaluated BY the write (the conditional INSERT below), not by an earlier read:
 * between helpAssignment and the INSERT the connection can be revoked, the seat handed to someone else, a newer connection
 * made, the issuer D1-fenced or the class ended in D1 — reproduced 2026-09-22 (Codex native-help-service-review: revoked
 * after the check, 201 and a stored row). Binds: grant id, class run, cohort, profile, learner, now(ms), recipient, now(ms), now(ms).
 * Not covered by this statement, and so re-read just before it (not atomic with the write): the KV active session (which
 * class is "now") and the KV revocation of the issuer token. D1 `sessions.ended_at` and `class_run_ops.ends_at` are the write-time
 * class fence; the D1 issuer fence is the write-time instructor fence.
 */
const HELP_WRITE_GUARD=`EXISTS (SELECT 1 FROM ops_grants g JOIN class_run_ops o ON o.class_run_id=g.class_run_id AND o.cohort_id=g.cohort_id AND o.profile_id=g.profile_id
 JOIN class_run_seats s ON s.class_run_id=g.class_run_id AND s.seat_id=g.seat_id AND s.seat_revision=g.seat_revision AND s.student_id=g.student_id AND s.replaced_at IS NULL
 WHERE g.id=? AND g.class_run_id=? AND g.cohort_id=? AND g.profile_id=? AND g.student_id=? AND g.kind='connection' AND g.state='active' AND g.expires_at>? AND g.issuer_id=?
 AND o.ends_at>? AND NOT EXISTS (SELECT 1 FROM sessions z WHERE z.id=o.class_run_id AND z.ended_at IS NOT NULL)
 AND (g.issuer_jti IS NULL OR NOT EXISTS (SELECT 1 FROM ops_issuer_fences f WHERE f.issuer_jti=g.issuer_jti AND f.state='revoked'))
 AND NOT EXISTS (SELECT 1 FROM ops_grants n WHERE n.class_run_id=g.class_run_id AND n.cohort_id=g.cohort_id AND n.profile_id=g.profile_id AND n.student_id=g.student_id AND n.kind='connection' AND n.state='active' AND n.expires_at>? AND n.created_at>g.created_at))`;

/**
 * Consent to a native help request is consent to an END TIME the learner saw, not to a duration counted from whenever the
 * POST happens to arrive (a request sent 5 minutes after the preview used to be stored 5 minutes longer than shown). The
 * Service issues that end time with the preview — now + duration, capped by the learning token — and signs it together with
 * who, which class, which connection, which instructor and which request id. The POST must carry it back; the stored expiry is
 * that end time, cut shorter (never longer) by the token presented at write time. The signature is the Service's, so a client
 * cannot pick a later time; an end time already past refuses the request before anything is written.
 */
const CONSENT_V='help-consent-v1';
const b64u=(bytes:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const consentKey=(secret:string)=>crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const consentText=(p:TokenPayload,o:{run:string;grant:string;recipient:string;id:string;duration:number;expires_at:number})=>[CONSENT_V,p.c,p.p,p.u,o.run,o.grant,o.recipient,o.id,o.duration,o.expires_at].join('|');
async function consentProof(env:Env,p:TokenPayload,o:Parameters<typeof consentText>[1]):Promise<string>{
 return b64u(await crypto.subtle.sign('HMAC',await consentKey(env.HPS_SIGNING_SECRET),new TextEncoder().encode(consentText(p,o))));
}
async function consentValid(env:Env,p:TokenPayload,o:Parameters<typeof consentText>[1],proof:unknown):Promise<boolean>{
 if(typeof proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(proof))return false;
 const bin=atob(proof.replace(/-/g,'+').replace(/_/g,'/')+'='),sig=Uint8Array.from(bin,ch=>ch.charCodeAt(0));
 return crypto.subtle.verify('HMAC',await consentKey(env.HPS_SIGNING_SECRET),sig,new TextEncoder().encode(consentText(p,o)));
}
const durationOK=(d:unknown):d is number=>Number.isInteger(d)&&(d as number)>=5&&(d as number)<=1440;
classroomStudent.get('/help-recipient',async c=>{
 const p=c.get('student'),a=await helpAssignment(c.env,p);
 if('reason' in a)return c.json({available:false,reason:a.reason},a.reason==='unknown'?503:200);
 // With a request id and a duration, also the signed end time the preview shows and the POST must return (see above).
 const q=c.req.query(),duration=q.duration_minutes===undefined?undefined:Number(q.duration_minutes);
 if(q.request_id===undefined&&duration===undefined)return c.json({available:true,...a});
 if(!idOK(q.request_id)||!durationOK(duration))return c.json({error:'request_id and duration_minutes (5–1440) required together'},400);
 const expires_at=Math.min(p.exp,now()+duration*60),o={run:a.class_run_id,grant:a.grant_id,recipient:a.recipient_id,id:q.request_id,duration,expires_at};
 return c.json({available:true,...a,consent:{request_id:o.id,duration_minutes:duration,expires_at,proof:await consentProof(c.env,p,o)}});
});
// Without `session_id`: this learner's unexpired history (every class), kept so an old share can still be withdrawn. With it:
// only that class — the current help queue never labels an earlier class's request as this lesson's.
classroomStudent.get('/shares',async c=>{
 const p=c.get('student'),sid=c.req.query('session_id');if(sid!==undefined&&!idOK(sid))return c.json({error:'invalid session_id'},400);
 const rows=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE cohort_id=? AND student_id=? AND profile_id=? AND expires_at>?'+(sid===undefined?'':' AND session_id=?')+' ORDER BY created_at DESC LIMIT 100').bind(p.c,p.u,p.p,now(),...(sid===undefined?[]:[sid])).all<Row>();
 return c.json({shares:(rows.results??[]).map(studentView),limit:100,filter:{session_id:sid??null}});
});
classroomStudent.post('/shares',async c=>{
 const p=c.get('student'),b=await json(c);
 if(!b||!idOK(b.id)||!idOK(b.recipient_id)||!['help','submission'].includes(b.kind)||b.consent!==true||!Number.isInteger(b.duration_minutes)||b.duration_minutes<5||b.duration_minutes>1440)return c.json({error:'id, recipient, kind, consent and duration (5–1440 minutes) required'},400);
 // `question` = the learner's own words to the instructor, so help can be asked without sharing any conversation. Stored only
 // when sent: a request without it keeps the exact stored shape it had before (its retry still matches).
 const keys=['question','prompt','response','tool_summary','artifact_url','verification'];
 if(!b.content||typeof b.content!=='object'||Array.isArray(b.content)||Object.keys(b.content).some(k=>!keys.includes(k)))return c.json({error:'select supported content fields'},400);
 const content:Record<string,string>={};
 for(const k of keys){if(k==='question'&&b.content.question===undefined)continue;const value=b.content[k]??'';if(typeof value!=='string'||value.length>8000)return c.json({error:'invalid or excessive field'},400);content[k]=scrubSecrets(value);}
 if(!Object.values(content).some(v=>v.trim()))return c.json({error:'select content to share'},400);
 if(content.artifact_url){try{const url=new URL(content.artifact_url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}catch{return c.json({error:'artifact must be an http(s) URL without credentials'},400);}}
 if((b.class_run_id!==undefined&&!idOK(b.class_run_id))||(b.grant_id!==undefined&&!idOK(b.grant_id)))return c.json({error:'invalid class or connection id'},400);
 // A native request names its class and connection and carries the Service-signed end time the learner consented to. The
 // web page (no class named) keeps its contract: it shows a duration, and the stored end is counted from arrival.
 const native=b.class_run_id!==undefined;let consentEnd:number|null=null;
 if(native){
  const e=b.consent_envelope;
  if(b.grant_id===undefined||!e||typeof e!=='object'||!Number.isInteger(e.expires_at))return c.json({error:'a native request needs its connection and the consent envelope from the preview',reason:'consent_required'},400);
  if(!(await consentValid(c.env,p,{run:b.class_run_id,grant:b.grant_id,recipient:b.recipient_id,id:b.id,duration:b.duration_minutes,expires_at:e.expires_at},e.proof)))return c.json({error:'the consent envelope does not match this request',reason:'consent_invalid'},400);
  if(e.expires_at<=now())return c.json({error:'the time the learner agreed to has passed; preview again',reason:'consent_expired'},409);
  consentEnd=e.expires_at;
 }
 const session=await getActiveSession(c.env.HPS_KV,p.c);
 if(!session||session.profile_id!==p.p||Date.parse(session.ends_at)<=Date.now()||Date.parse(session.starts_at)>Date.now())return c.json({error:'active matching class required to share',reason:'no_active_class'},403);
 // The class the learner consented for must still be the class now; checked before anything is read or written.
 if(native&&b.class_run_id!==session.session_id)return c.json({error:'the class changed; review the request again',reason:'class_changed'},409);
 // Recipient: where the Service knows this learner's class assignment (operations on and a run for this session), only the
 // assigned instructor. A native request (it names its class) always needs that assignment. A class without operations keeps
 // the earlier web behaviour: the recipient is syntax-checked only, and teacher reads stay recipient- and scope-bound.
 let hasRun=native,a:Assignment|null=null;
 if(!hasRun&&opsEnabled(c.env)){try{hasRun=!!(await c.env.HPS_DB.prepare('SELECT 1 AS ok FROM class_run_ops WHERE class_run_id=? AND cohort_id=?').bind(session.session_id,p.c).first());}catch{hasRun=true;}}
 const refuse=(x:Assignment|{reason:string})=>{
  if('reason' in x)return c.json({error:'no instructor is assigned to this learner in this class',reason:x.reason},x.reason==='unknown'?503:403);
  if(x.recipient_id!==b.recipient_id)return c.json({error:'recipient is not the instructor assigned to this class',reason:'recipient_not_assigned'},409);
  if(b.grant_id!==undefined&&x.grant_id!==b.grant_id)return c.json({error:'the class connection changed; review the request again',reason:'connection_changed'},409);
  return null;
 };
 if(hasRun){const x=await helpAssignment(c.env,p),no=refuse(x);if(no)return no;a=x as Assignment;}
 const contentJson=JSON.stringify(content);
 // A retried id is the same request only with the same consent envelope: learner, class, recipient, kind, exact content and the
 // expiry that was granted (native: the signed end time, or the token's end if that came first; web: the duration counted from
 // creation, capped by the token). Anything else is a conflict, so a retry can neither widen the granted expiry nor pass an earlier class's record off
 // as this class's request. A retry returns the stored row as it is; it never rewrites it.
 const same=(prior:Row)=>prior.cohort_id===p.c&&prior.student_id===p.u&&prior.profile_id===p.p&&prior.session_id===session.session_id&&prior.recipient_id===b.recipient_id&&prior.kind===b.kind&&prior.content_json===contentJson&&prior.expires_at>now()
  &&(consentEnd!==null?prior.expires_at===consentEnd||(prior.expires_at<consentEnd&&prior.expires_at===p.exp):prior.expires_at===Math.min(p.exp,prior.created_at+b.duration_minutes*60));
 const conflict=(prior:Row)=>c.json({error:'request ID conflict',reason:prior.student_id===p.u&&prior.session_id!==session.session_id?'class_changed':'request_id_conflict'},409);
 const prior=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE id=?').bind(b.id).first<Row>();
 if(prior)return same(prior)?c.json(studentView(prior)):conflict(prior);
 const stamp=now(),expires=Math.min(p.exp,consentEnd??stamp+b.duration_minutes*60);
 const count=await c.env.HPS_DB.prepare('SELECT count(*) AS n FROM classroom_shares WHERE cohort_id=? AND student_id=? AND expires_at>?').bind(p.c,p.u,stamp).first<{n:number}>();
 if((count?.n??0)>=100)return c.json({error:'active share limit reached; withdraw old shares'},429);
 const values=[b.id,p.c,p.p,p.u,b.recipient_id,session.session_id,b.kind,contentJson,stamp,expires];
 if(!a){
  const saved=await c.env.HPS_DB.prepare(`INSERT INTO classroom_shares(id,cohort_id,profile_id,student_id,recipient_id,session_id,kind,content_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *`).bind(...values).first<Row>();
  if(!saved)return c.json({error:'request ID conflict; reload'},409);
  return c.json(studentView(saved),201);
 }
 // The assignment is re-evaluated by the INSERT itself. No row = the assignment changed in between (or the id was taken):
 // nothing was written, and the answer says which.
 const at=Date.now(),saved=await c.env.HPS_DB.prepare(`INSERT INTO classroom_shares(id,cohort_id,profile_id,student_id,recipient_id,session_id,kind,content_json,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${HELP_WRITE_GUARD} ON CONFLICT(id) DO NOTHING RETURNING *`)
  .bind(...values,a.grant_id,session.session_id,p.c,p.p,p.u,at,a.recipient_id,at,at).first<Row>();
 if(saved)return c.json(studentView(saved),201);
 const raced=await c.env.HPS_DB.prepare('SELECT * FROM classroom_shares WHERE id=?').bind(b.id).first<Row>();
 if(raced)return same(raced)?c.json(studentView(raced)):conflict(raced);
 const now2=await helpAssignment(c.env,p),no=refuse(now2);if(no)return no;
 const run=await c.env.HPS_DB.prepare('SELECT o.ends_at,z.ended_at FROM class_run_ops o LEFT JOIN sessions z ON z.id=o.class_run_id WHERE o.class_run_id=?').bind(session.session_id).first<{ends_at:number;ended_at:string|null}>();
 if(!run||run.ended_at||run.ends_at<=Date.now())return c.json({error:'this class has ended',reason:'no_active_class'},403);
 return c.json({error:'the class assignment changed while the request was being saved; review it again',reason:'connection_changed'},409);
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
// The instructor scope is applied in SQL, before the page limit: rows outside it must neither fill a page (and starve an
// allowed request behind them) nor be counted. `has_more`/`next_cursor` say whether older matching rows exist; the list alone
// never proves completeness. `counts` covers every authorized row matching the filters (not only this page); `status=open`
// narrows only the page to rows still awaiting the instructor, so a help list is not buried behind answered rows.
const cursorOK=(s:string)=>/^\d{1,12}:[a-zA-Z0-9_-]{1,128}$/.test(s);
classroomTeacher.get(root,async c=>{
 const a=c.get('teacher'),q=c.req.query(),size=q.limit===undefined?100:Number(q.limit);
 if(!Number.isInteger(size)||size<1||size>100||(q.session_id!==undefined&&!idOK(q.session_id))||(q.kind!==undefined&&!['help','submission'].includes(q.kind))||(q.status!==undefined&&q.status!=='open')||(q.before!==undefined&&!cursorOK(q.before)))return c.json({error:'invalid session_id, kind, status, before or limit'},400);
 let where='cohort_id=? AND recipient_id=? AND expires_at>? AND profile_id IN (SELECT value FROM json_each(?))';const args:unknown[]=[c.req.param('cohort'),a.payload.u,now(),JSON.stringify(a.scope.profiles??[])];
 if(q.session_id!==undefined){where+=' AND session_id=?';args.push(q.session_id);}
 if(q.kind!==undefined){where+=' AND kind=?';args.push(q.kind);}
 let page=where+(q.status==='open'?" AND status IN ('received','reviewing')":'');const pageArgs=[...args];
 if(q.before!==undefined){const i=q.before.indexOf(':'),at=Number(q.before.slice(0,i)),id=q.before.slice(i+1);page+=' AND (created_at<? OR (created_at=? AND id<?))';pageArgs.push(at,at,id);}
 const [rows,counts]=await Promise.all([
  c.env.HPS_DB.prepare(`SELECT * FROM classroom_shares WHERE ${page} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...pageArgs,size+1).all<Row>(),
  c.env.HPS_DB.prepare(`SELECT count(*) AS matched, coalesce(sum(status IN ('received','reviewing')),0) AS open, coalesce(sum(status='answered'),0) AS answered FROM classroom_shares WHERE ${where}`).bind(...args).first<{matched:number;open:number;answered:number}>()]);
 const list=rows.results??[],more=list.length>size,shown=list.slice(0,size),last=shown[shown.length-1];
 return c.json({recipient_id:a.payload.u,shares:shown.map(metadata),limit:size,has_more:more,next_cursor:more&&last?last.created_at+':'+last.id:null,filter:{session_id:q.session_id??null,kind:q.kind??null,status:q.status??null},counts:{matched:Number(counts?.matched??0),open:Number(counts?.open??0),answered:Number(counts?.answered??0)}});
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
