import {open,realpath,lstat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonicalJson,redactText} from './core.mjs';
import {OBSERVER_FORMAT,OBSERVER_LIMITS,validateObserverDelta} from './observer-contract.mjs';
const exec=promisify(execFile);
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const observerDigest=x=>'sha256:'+sha(canonicalJson(x));
const bounded=(v,max=200)=>typeof v==='string'?v.slice(0,max):null;
const safeId=v=>bounded(v,200)?.replace(/[^a-zA-Z0-9_.:/-]/g,'_')||null;
const emptyCoverage=()=>({records:0,eligible:0,omitted:0,hidden:0,malformed:0,unsupported:0,oversized:0,excerpted:0,redacted:0});
const category=name=>/bash|exec|shell|terminal/i.test(name)?'shell':/write|edit|patch/i.test(name)?'file-change':/read|search|grep|glob/i.test(name)?'read':'other';
function artifact(input,project,operation,roots=[]){
 const path=input?.file_path||input?.path;if(typeof path!=='string')return null;
 const absolute=resolve(project,path),root=[project,...roots].sort((a,b)=>b.length-a.length).find(r=>absolute.startsWith(r+'/'));if(!root)return null;const rel=relative(root,absolute);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.includes('\\')||rel.length>300)return null;
 if(/(?:^|\/)(?:\.env(?:\.|$)|credentials|secrets|id_rsa|id_ed25519)/i.test(rel))return null;
 return {path:redactText(rel).text,digest:typeof input.content==='string'?'sha256:'+sha(input.content):null,operation};
}
function nativePatch(raw,project,roots=[]){
 if(typeof raw!=='string'||!raw.startsWith('*** Begin Patch\n')||!raw.trimEnd().endsWith('*** End Patch'))return [];
 const found=[];for(const line of raw.split('\n')){const m=/^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);if(!m)continue;const a=artifact({path:m[2]},project,m[1]==='Add'?'write':m[1]==='Update'?'edit':'unknown',roots);if(a)found.push(a)}return found;
}
/** Exact host exec wrapper only; never search command stdout for exit-code prose. */
function shellOutputRecords(value){
 const items=Array.isArray(value)?value:[{type:'input_text',text:value}],found=[];
 for(const item of items){if(!['text','input_text','output_text'].includes(item?.type)||typeof item.text!=='string')continue;let v;try{v=JSON.parse(item.text)}catch{continue}
  if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).some(k=>!['chunk_id','wall_time_seconds','output','session_id','exit_code','original_token_count'].includes(k)))continue;
  if(typeof v.chunk_id!=='string'||!Number.isFinite(v.wall_time_seconds)||typeof v.output!=='string'||(!Number.isSafeInteger(v.exit_code)&&!Number.isSafeInteger(v.session_id)))continue;
  found.push({exit_code:Number.isSafeInteger(v.exit_code)?v.exit_code:null,status:Number.isSafeInteger(v.exit_code)?(v.exit_code===0?'success':'failure'):'running',interrupted:null,background:v.session_id});
 }return found;
}
function outcome(value,error){
 let v=value;if(typeof v==='string'){try{v=JSON.parse(v)}catch{v=null}}
 const code=Number.isSafeInteger(v?.exit_code)?v.exit_code:Number.isSafeInteger(v?.exitCode)?v.exitCode:null;
 const interrupted=typeof v?.interrupted==='boolean'?v.interrupted:null;
 return {status:interrupted?'interrupted':code!==null?(code===0?'success':'failure'):error===true?'failure':(v?.status==='running'||v?.backgroundTaskId||v?.isAsync===true)?'running':'unknown',exit_code:code,interrupted};
}
/** Pure local normalization. Raw commands, tool output, patches and thinking never enter events/state. */
export function normalizeRecord(r,state,source,host,project,roots=[]){
 const events=[],coverage=emptyCoverage();coverage.records=1;
 if(r.type==='observer_malformed_record'){coverage.malformed=1;coverage.omitted=1;return {events,coverage};}
 const p=r.payload||{};
 if(host==='claude-code'&&state.sourceSession&&r.sessionId&&r.sessionId!==state.sourceSession)throw Error('mixed_sessions');
 let task=safeId(p.turn_id)||state.task||'unassigned';
 const at=typeof r.timestamp==='string'&&Number.isFinite(Date.parse(r.timestamp))?new Date(r.timestamp).toISOString():null;
 const delegated=state.delegated||r.isSidechain===true||!!r.agentId;
 const emit=(kind,actor,data)=>events.push({id:sha(state.generation+':'+source.line+':'+events.length),task,at,kind,actor,model:state.model||null,source,...data});
 if(host==='codex'&&r.type==='session_meta'){
  if(state.fork!=null&&source.line>1&&Number.isSafeInteger(r.ordinal)&&r.ordinal<state.fork){coverage.omitted++;return {events,coverage};}
  if(state.sourceSession&&p.id!==state.sourceSession)throw Error('mixed_sessions');
  if(p.subagent_history_start_ordinal!=null){if(!Number.isSafeInteger(p.subagent_history_start_ordinal))throw Error('invalid_fork_boundary');state.fork=p.subagent_history_start_ordinal;state.delegated=true;}
  coverage.omitted++;return {events,coverage};
 }
 if(host==='codex'&&state.fork!=null){if(!Number.isSafeInteger(r.ordinal))throw Error('invalid_fork_ordinal');if(r.ordinal<state.fork){coverage.omitted++;return {events,coverage}}}
 if(host==='codex'&&r.type==='turn_context'){
  state.model=bounded(p.model);state.task=safeId(p.turn_id)||state.task;task=state.task||task;
  emit('condition','host',{condition:{reasoning:bounded(p.effort,50)}});
 }else if(host==='codex'&&r.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(p.type)){
  state.task=safeId(p.turn_id)||task;task=state.task;emit('lifecycle','host',{lifecycle:{state:{task_started:'started',task_complete:'completed',turn_aborted:'aborted'}[p.type]}});
 }else{
  if((host==='codex'&&(['world_state','compacted','token_usage_record','inter_agent_communication_metadata'].includes(r.type)||(r.type==='event_msg'&&['token_count','item_completed','agent_message','thread_settings_applied'].includes(p.type))))||(host==='claude-code'&&['mode','worktree-state','bridge-session','file-history-snapshot','system','attachment','atis-latch','last-prompt','file-history-delta','queue-operation','pr-link','ai-title','relocated','cost-state','progress','summary'].includes(r.type))){coverage.omitted++;return {events,coverage};}
  if(host==='claude-code'&&typeof r.message?.model==='string'&&r.message.model!==state.model){state.model=bounded(r.message.model);emit('condition','host',{condition:{reasoning:null}})}
  let role,blocks=[];
  if(host==='codex'&&r.type==='response_item'){
   if(p.type==='reasoning'||p.channel==='analysis'){coverage.hidden++;return {events,coverage}}
   if(p.type==='message'){role=p.role;blocks=p.content||[]}
   else if(['function_call','custom_tool_call'].includes(p.type))blocks=[{type:'tool_use',id:p.call_id,name:p.name,input:p.arguments??p.input}];
   else if(['function_call_output','custom_tool_call_output'].includes(p.type))blocks=[{type:'tool_result',tool_use_id:p.call_id,content:p.output}];
  }else if(host==='claude-code'&&['user','assistant'].includes(r.type)){
   if(r.isMeta){coverage.omitted++;return {events,coverage}}role=r.message?.role;
   blocks=typeof r.message?.content==='string'?[{type:'text',text:r.message.content}]:r.message?.content||[];
   if(role==='user'&&blocks.some(b=>b.type==='text')&&!blocks.some(b=>b.type==='tool_result')){state.task=safeId(r.uuid)||task;task=state.task;}
  }
  for(const b of blocks){
   if(['thinking','reasoning','redacted_thinking'].includes(b.type)){coverage.hidden++;continue}
   if(['text','input_text','output_text'].includes(b.type)&&typeof b.text==='string'&&['user','assistant'].includes(role)){
    if(role==='user'&&/^\s*(# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|<system-reminder>|<skill>)/.test(b.text)){coverage.omitted++;continue}
    const clean=redactText(b.text);coverage.redacted+=clean.exclusions.length;
    if(clean.text.length>OBSERVER_LIMITS.message)coverage.excerpted++;
    emit('message',role==='assistant'?'ai':delegated?'delegated':'human-unconfirmed',{message:{text:clean.text.slice(0,OBSERVER_LIMITS.message)}});
   }else if(b.type==='tool_use'){
    const id=safeId(b.id);if(!id){coverage.unsupported++;continue}const name=safeId(b.name)||'unknown';const rawInput=b.input;let input=b.input;if(typeof input==='string'){try{input=JSON.parse(input)}catch{input=null}}
    const a=artifact(input,project,/write/i.test(name)?'write':/edit|patch/i.test(name)?'edit':'read',roots);const patches=/apply_patch/i.test(name)?nativePatch(rawInput,project,roots):[];
    if(Object.keys(state.calls).length>=500&&!state.calls[id])throw Error('pending_tool_limit');
    state.calls[id]={name,category:category(name),task,model:state.model||null,artifact:a,patches,patchDigest:patches.length?'sha256:'+sha(rawInput):null};
    emit('tool_call','ai',{tool:{call_id:id,name,category:category(name),status:'requested',exit_code:null,interrupted:null}});
   }else if(b.type==='tool_result'){
    let id=safeId(b.tool_use_id);if(!id){coverage.unsupported++;continue}const receiptCallId=id;const receiptCall=state.calls[id];state.background??={};const bg=safeId(r.toolUseResult?.task_id);if(bg&&state.background[bg])id=state.background[bg];const call=state.calls[id];const originalTask=task,originalModel=state.model;
    if(call){task=call.task;state.model=call.model}
    const shell=host==='codex'&&call?.category==='shell'?shellOutputRecords(b.content):[];const status=shell.length?(shell.some(x=>x.status==='running')?{status:'running',exit_code:null,interrupted:null}:shell.find(x=>x.status==='failure')||shell[0]):outcome(r.toolUseResult||b.content,b.is_error);const background=safeId(r.toolUseResult?.backgroundTaskId);if(background)state.background[background]=id;
    for(const outcome of (shell.length?shell:[status]))emit('tool_result','ai',{tool:{call_id:id,name:call?.name||'unknown',category:call?.category||'other',status:outcome.status,exit_code:outcome.exit_code,interrupted:outcome.interrupted}});
    if(status.status!=='failure'&&status.status!=='interrupted')for(const a of [call?.artifact,...(call?.patches||[])].filter(Boolean))emit('artifact','ai',{artifact:a});
    if(status.status!=='running'){delete state.calls[id];if(bg)delete state.background[bg];}
    if(receiptCallId!==id&&receiptCall){task=receiptCall.task;state.model=receiptCall.model;emit('tool_result','ai',{tool:{call_id:receiptCallId,name:receiptCall.name,category:receiptCall.category,status:'unknown',exit_code:null,interrupted:null}});delete state.calls[receiptCallId];}
    task=originalTask;state.model=originalModel;
   }else if(['image','image_url','document','tool_reference'].includes(b.type))coverage.omitted++;else coverage.unsupported++;
  }
 }
 coverage.eligible=events.length;if(!events.length&&!coverage.omitted&&!coverage.hidden)coverage.unsupported++;
 return {events,coverage};
}
async function readRange(handle,from,length){const b=Buffer.alloc(length);const {bytesRead}=await handle.read(b,0,length,from);return b.subarray(0,bytesRead)}
/** Yields durable units. Consumer must persist delta before its returned checkpoint. */
export async function* observeFile(source,checkpoint=null,{maxBytes=32*1024*1024,maxDeltas=20}={}){
 const handle=await open(source.path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const st=await handle.stat();if(!st.isFile()||st.size>1024**3)throw Error('observer_source_limit');
  if(checkpoint&&checkpoint.size===st.size&&checkpoint.modified===st.mtimeMs&&checkpoint.inode===String(st.ino)&&(checkpoint.offset===st.size||checkpoint.scannedTo===st.size))return;
  const prefix=await readRange(handle,0,Math.min(st.size,256));
  let reset=null;
  if(!checkpoint)reset='new-source';else if(st.size<checkpoint.offset)reset='truncated';else if(checkpoint.inode!==String(st.ino)||checkpoint.prefix!==sha(prefix.subarray(0,checkpoint.prefixBytes))||(st.size===checkpoint.size&&st.mtimeMs!==checkpoint.modified))reset='rewritten';
  else if(checkpoint.offset&&checkpoint.anchor!==sha(await readRange(handle,Math.max(0,checkpoint.offset-256),Math.min(256,checkpoint.offset))))reset='rewritten';
  let state=reset?{generation:sha([source.host,source.session,st.dev,st.ino,st.birthtimeMs,sha(prefix),checkpoint?.generation||'',checkpoint?.sequence||0].join(':')),sourceSession:source.parentSession||source.session,createdAt:Date.now(),sequence:0,digest:null,offset:0,line:0,task:'unassigned',model:null,calls:{},background:{},fork:null,delegated:!!source.delegated,prefix:sha(prefix),prefixBytes:prefix.length}:structuredClone(checkpoint);
  const end=Math.min(st.size,state.offset+maxBytes);let pos=state.offset,carry=Buffer.alloc(0),lineStart=pos,events=[],coverage=emptyCoverage(),batchFrom=pos,produced=0;
  const flush=async()=>{
   const body={format:OBSERVER_FORMAT,host:source.host,project:source.project,session:source.session,generation:state.generation,sequence:state.sequence+1,previous_digest:state.digest,source:{from:batchFrom,to:state.offset,size:st.size,pending_bytes:st.size-state.offset,reset_reason:reset},events,coverage};
   const delta=validateObserverDelta({...body,digest:observerDigest(body)});if(Buffer.byteLength(JSON.stringify(delta))>OBSERVER_LIMITS.bytes)throw Error('observer_delta_limit');
   state={...state,sequence:delta.sequence,digest:delta.digest,size:st.size,modified:st.mtimeMs,inode:String(st.ino),anchor:sha(await readRange(handle,Math.max(0,state.offset-256),Math.min(256,state.offset)))};
   const result={delta,checkpoint:structuredClone(state),readBytes:state.offset-batchFrom};batchFrom=state.offset;events=[];coverage=emptyCoverage();reset=null;return result;
  };
  while(pos<end){
   const chunk=await readRange(handle,pos,Math.min(65536,end-pos));if(!chunk.length)break;pos+=chunk.length;carry=Buffer.concat([carry,chunk]);let newline;
   while((newline=carry.indexOf(10))>=0){
    const raw=carry.subarray(0,newline+1);carry=carry.subarray(newline+1);const lineEnd=lineStart+raw.length;
    const before=structuredClone(state);const locator={line:state.line+1,from:lineStart,to:lineEnd,hash:'sha256:'+sha(raw)};
    let normalized;
    if(raw.length>2*1024*1024){normalized={events:[],coverage:{...emptyCoverage(),records:1,oversized:1,omitted:1}}}
    else{let row;try{row=JSON.parse(raw.toString('utf8'))}catch{if(!raw.toString('utf8').trim()){row={type:'blank'}}else row={type:'observer_malformed_record'}};if(!row||typeof row!=='object'||Array.isArray(row))row={type:'observer_malformed_record'};normalized=normalizeRecord(row,state,locator,source.host,source.cwd,source.artifactRoots||[])}
    if(events.length+normalized.events.length>OBSERVER_LIMITS.events||Buffer.byteLength(JSON.stringify([...events,...normalized.events]))>OBSERVER_LIMITS.bytes-16384){state=before;if(state.offset>batchFrom){yield await flush();produced++;if(produced>=maxDeltas)return;} normalized=raw.length>2*1024*1024?normalized:normalizeRecord(JSON.parse(raw.toString('utf8')),state,locator,source.host,source.cwd,source.artifactRoots||[]);}
    if(normalized.events.length>OBSERVER_LIMITS.events)throw Error('observer_record_event_limit');
    events.push(...normalized.events);for(const k of Object.keys(coverage))coverage[k]+=normalized.coverage[k];state.offset=lineEnd;state.line++;lineStart=lineEnd;
   }
   if(carry.length>16*1024*1024)throw Error('observer_line_limit');
  }
  if(state.offset>batchFrom){state.scannedTo=end===st.size?st.size:state.offset;yield await flush();}
 }finally{await handle.close()}
}
async function gitCommon(path){try{const {stdout}=await exec('git',['-C',path,'rev-parse','--path-format=absolute','--git-common-dir'],{maxBuffer:4096});return await realpath(stdout.trim())}catch{return null}}
/** All dates, exact configured projects or registered Git worktrees sharing their common-dir. */
export async function discoverObserverSources(home,projects,{maxFiles=5000,maxDirectories=10000,cache={}}={}){
 const allowed=new Map();for(const p of projects){allowed.set(await realpath(p.path),p);const common=await gitCommon(p.path);if(common){try{const {stdout}=await exec('git',['-C',p.path,'worktree','list','--porcelain'],{maxBuffer:1024*1024});for(const line of stdout.split('\n'))if(line.startsWith('worktree ')){const path=line.slice(9);try{const resolved=await realpath(path);if(!allowed.has(resolved))allowed.set(resolved,p)}catch(e){if(e.code!=='ENOENT')throw e}}}catch{throw Error('observer_worktree_discovery_failed')}}}
 for(const p of projects)allowed.set(await realpath(p.path),p);
 const candidates=[];let directories=0;
 const walk=async(dir,host,depth)=>{if(++directories>maxDirectories)throw Error('observer_directory_limit');let entries;try{if((await lstat(dir)).isSymbolicLink())return;entries=await readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return;throw e}
  for(const e of entries){if(e.isSymbolicLink())continue;const path=join(dir,e.name);if(e.isDirectory()&&depth)await walk(path,host,depth-1);else if(e.isFile()&&e.name.endsWith('.jsonl')){if(candidates.length>=maxFiles)throw Error('observer_discovery_limit');candidates.push({path,host})}}};
 await walk(join(home,'.codex','sessions'),'codex',4);
 for(const path of allowed.keys())await walk(join(home,'.claude','projects',path.replace(/[^a-zA-Z0-9]/g,'-')),'claude-code',3);
 const found=[],seen=new Set();for(const item of candidates){if(seen.has(item.path))continue;seen.add(item.path);const h=await open(item.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await h.stat();const cached=cache[item.path];const reuse=cached&&cached.inode===String(st.ino)&&cached.bytes===st.size&&cached.modified===st.mtimeMs;const data=reuse?Buffer.alloc(0):await readRange(h,0,Math.min(st.size,65536));let session=reuse?cached.session:null,cwd=reuse?cached.cwd:null,delegated=reuse?cached.delegated:false,agentId=reuse?cached.agentId:null;for(const l of data.toString('utf8').split('\n')){let r;try{r=JSON.parse(l)}catch{continue}if(item.host==='codex'&&r.type==='session_meta'){session=r.payload?.id;cwd=r.payload?.cwd;delegated=r.payload?.subagent_history_start_ordinal!=null;break}if(item.host==='claude-code'&&r.sessionId&&r.cwd){session=r.sessionId;cwd=r.cwd;delegated=!!r.isSidechain||!!r.agentId;agentId=safeId(r.agentId);break}}
  if(typeof session!=='string'||typeof cwd!=='string')continue;cache[item.path]={session,cwd,delegated,agentId,inode:String(st.ino),bytes:st.size,modified:st.mtimeMs};let real;try{real=await realpath(cwd)}catch{continue}const p=allowed.get(real);if(p)found.push({...item,parentSession:session,session:item.host==='claude-code'&&delegated?session+':agent:'+(agentId||sha(item.path).slice(0,16)):session,cwd:real,project:p.id,artifactRoots:[...allowed].filter(([,grant])=>grant.id===p.id).map(([path])=>path),delegated,bytes:st.size,modified:st.mtimeMs});
 }finally{await h.close()}}
 return found.sort((a,b)=>b.modified-a.modified||a.path.localeCompare(b.path));
}
