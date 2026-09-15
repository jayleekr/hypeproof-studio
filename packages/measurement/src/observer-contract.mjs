/** hps-observer-delta/1. No raw tool input/output or hidden reasoning is transmitted. */
export const OBSERVER_FORMAT = 'hps-observer-delta/1';
export const OBSERVER_LIMITS = { bytes: 512 * 1024, events: 250, message: 1000 };
export const OBSERVER_KINDS = ['message','tool_call','tool_result','artifact','lifecycle','condition'];
export const OBSERVER_ACTORS = ['human-unconfirmed','ai','delegated','host','unknown'];
/**
 * Delta = {format,host:'codex'|'claude-code',project:sha256hex,session:string,
 * generation:sha256hex,sequence:positive integer,previous_digest:'sha256:'+hex|null,
 * source:{from:integer,to:integer,size:integer,pending_bytes:integer,
 *         reset_reason:null|'new-source'|'truncated'|'rewritten'},
 * events:Event[],coverage:{records:integer,eligible:integer,omitted:integer,
 *   hidden:integer,malformed:integer,unsupported:integer,oversized:integer,excerpted:integer,redacted:integer},
 * digest:'sha256:'+hex}
 * digest hashes canonical JSON of every above field except digest.
 * Each delta source range is consecutive complete JSONL lines, [from,to).
 * Event = {id:sha256hex,task:string,at:ISO8601|null,kind,actor,model:string|null,
 *   source:{line:positive integer,from:integer,to:integer,hash:'sha256:'+hex},
 *   message?:{text:string<=1000},
 *   tool?:{call_id:string,name:string,category:string,
 *     status:'requested'|'running'|'success'|'failure'|'interrupted'|'unknown',
 *     exit_code:integer|null,interrupted:boolean|null},
 *   artifact?:{path:relative-path,digest:'sha256:'+hex|null,
 *     operation:'read'|'write'|'edit'|'unknown'},
 *   lifecycle?:{state:'started'|'completed'|'aborted'},
 *   condition?:{reasoning:string|null}}
 * Kind-specific field only. IDs derive from generation + source line + event index.
 * Missing execution codes stay null/unknown; tool protocol success is not task success.
 * Model binds at observation time. Human-role text is never independently confirmed.
 */

export function validateObserverDelta(d){
 const fail=()=>{throw Error('invalid_observer_delta')};
 const obj=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!(k in v)))fail()};
 const text=(v,max)=>{if(typeof v!=='string'||!v.length||v.length>max)fail()};
 const integer=v=>{if(!Number.isSafeInteger(v)||v<0)fail()};
 const hex=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail()};
 const digest=v=>{if(typeof v!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v))fail()};
 obj(d,['format','host','project','session','generation','sequence','previous_digest','source','events','coverage','digest']);
 if(d.format!==OBSERVER_FORMAT||!['codex','claude-code'].includes(d.host))fail();hex(d.project);hex(d.generation);text(d.session,200);integer(d.sequence);if(d.sequence<1)fail();digest(d.digest);if(d.previous_digest!==null)digest(d.previous_digest);if((d.sequence===1)!==(d.previous_digest===null))fail();
 obj(d.source,['from','to','size','pending_bytes','reset_reason']);for(const k of ['from','to','size','pending_bytes'])integer(d.source[k]);if(d.source.to<=d.source.from||d.source.to>d.source.size||d.source.pending_bytes!==d.source.size-d.source.to||![null,'new-source','truncated','rewritten'].includes(d.source.reset_reason))fail();
 obj(d.coverage,['records','eligible','omitted','hidden','malformed','unsupported','oversized','excerpted','redacted']);for(const v of Object.values(d.coverage))integer(v);
 if(!Array.isArray(d.events)||d.events.length>OBSERVER_LIMITS.events||d.coverage.eligible!==d.events.length||Buffer.byteLength(JSON.stringify(d))>OBSERVER_LIMITS.bytes)fail();
 const ids=new Set();for(const e of d.events){const payload={message:'message',tool_call:'tool',tool_result:'tool',artifact:'artifact',lifecycle:'lifecycle',condition:'condition'}[e?.kind];if(!payload)fail();obj(e,['id','task','at','kind','actor','model','source',payload]);hex(e.id);if(ids.has(e.id))fail();ids.add(e.id);text(e.task,200);if(!OBSERVER_ACTORS.includes(e.actor))fail();if(e.at!==null&&(typeof e.at!=='string'||!Number.isFinite(Date.parse(e.at))))fail();if(e.model!==null)text(e.model,200);
  obj(e.source,['line','from','to','hash']);for(const k of ['line','from','to'])integer(e.source[k]);if(e.source.line<1||e.source.from<d.source.from||e.source.to>d.source.to||e.source.to<=e.source.from)fail();digest(e.source.hash);
  if(payload==='message'){obj(e.message,['text']);if(typeof e.message.text!=='string'||e.message.text.length>OBSERVER_LIMITS.message)fail()}
  if(payload==='tool'){obj(e.tool,['call_id','name','category','status','exit_code','interrupted']);text(e.tool.call_id,200);text(e.tool.name,200);if(!['shell','file-change','read','other'].includes(e.tool.category)||!['requested','running','success','failure','interrupted','unknown'].includes(e.tool.status))fail();if(e.tool.exit_code!==null&&!Number.isSafeInteger(e.tool.exit_code))fail();if(e.tool.interrupted!==null&&typeof e.tool.interrupted!=='boolean')fail();}
  if(payload==='artifact'){obj(e.artifact,['path','digest','operation']);text(e.artifact.path,300);if(e.artifact.path.startsWith('/')||e.artifact.path.includes('\\')||e.artifact.path.split('/').includes('..')||!['read','write','edit','unknown'].includes(e.artifact.operation))fail();if(e.artifact.digest!==null)digest(e.artifact.digest)}
  if(payload==='lifecycle'){obj(e.lifecycle,['state']);if(!['started','completed','aborted'].includes(e.lifecycle.state))fail()}
  if(payload==='condition'){obj(e.condition,['reasoning']);if(e.condition.reasoning!==null)text(e.condition.reasoning,50)}
 }
 return d;
}
