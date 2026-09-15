import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { canonicalJson, redactDeep, validateObservation } from './core.mjs';
import { observeFile,discoverObserverSources } from './observer.mjs';
import { FileRecordStorage, recentLocalSessions, parseLocalTranscriptFile } from './adapters.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const digestOf = value => 'sha256:' + hash(canonicalJson(value));
export const projectId = async path => hash(await realpath(path));
const MAX_BODY=1536*1024;
const MAX_STORE=256*1024*1024;
const safeCode=e=>/^[a-z_0-9]{1,100}$/.test(e?.message||'')?e.message:'sync_operation_failed';
const snapshotId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
/** Only a bounded machine code is retained; never expose an error response body. */
export class SyncHttpError extends Error {
  constructor(status, code = null) { super('server_' + status); this.name = 'SyncHttpError'; this.status = status; this.code = code; }
}
const deletedResponse = (error, code) => error instanceof SyncHttpError && error.status === 410 && error.code === code;
const suppressionKey = (namespace, source) => 'suppressed/' + namespace + '/' + hash(canonicalJson([source.host, source.project, source.session]));
export function validateServer(server) {
  const u=new URL(server);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||
     (u.protocol!=='https:' && !(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw Error('invalid_server_origin');
  return u.origin;
}
export function makeSnapshots(parsed,project) {
  const clean=redactDeep(parsed);
  const conditions=clean.conditions.slice(-100);
  const exclusions=[...clean.exclusions,'Automatic message snapshot; tool execution and artifacts are not captured.'];
  if(clean.conditions.length>100)exclusions.push('Only the latest 100 model conditions are included.');
  const make=events=>{
    const payload={batch:{...clean.batch,scope:project,program:'hypeproof-measure/0.2.2',events},models:clean.models.slice(-100),conditions,exclusions,evidence:'captured-replay',interpretation_status:'unreviewed'};
    return {format:'hps-session-sync/1',host:clean.host,project,session:clean.batch.session,digest:digestOf(payload),payload};
  };
  const chunks=[];let events=[];
  for(const event of clean.batch.events) {
    const trial=make([...events,event]);
    if(Buffer.byteLength(JSON.stringify(trial))>MAX_BODY) {
      if(!events.length)throw Error('snapshot_too_large');
      chunks.push(make(events));events=[event];
    }else events.push(event);
  }
  if(events.length)chunks.push(make(events));
  for(const chunk of chunks)if(Buffer.byteLength(JSON.stringify(chunk))>MAX_BODY)throw Error('snapshot_too_large');
  return chunks;
}
export class SessionSync {
  constructor({root=resolve(homedir(),'.hypeproof','measurement'),home=homedir(),fetch:fetcher=globalThis.fetch,now=()=>Date.now(),discover=discoverObserverSources}={}) {
    this.store=new FileRecordStorage(resolve(root,'records'));this.home=home;this.fetch=fetcher;this.now=now;this.discover=discover;
  }
  async read(key,fallback=null){const raw=await this.store.read(key);return raw===null?fallback:JSON.parse(raw);}
  async write(key,value){await this.store.write(key,JSON.stringify(value));}
  async connect({server='https://hypeproof-ai.xyz',token,projects}) {
    server=validateServer(server);
    if(typeof token!=='string'||token.length<32||token.length>512||/[\r\n\s]/.test(token))throw Error('invalid_connection_token');
    if(!Array.isArray(projects)||!projects.length||projects.length>20)throw Error('select_projects');
    const scopes=[];for(const path of projects){const local=await realpath(path);if(!scopes.some(p=>p.path===local))scopes.push({path:local,id:hash(local)});}
    // Probe before writing credentials. Server enforces membership, expiry and scope.
    const access=await this.request({server,token},'/api/measurement/snapshots?limit=1');
    if(!Array.isArray(access.projects)||scopes.some(p=>!access.projects.includes(p.id)))throw Error('project_not_granted');
    if(typeof access.owner!=='string'||!/^[a-f0-9]{64}$/.test(access.owner))throw Error('invalid_server_owner');
    return this.store.exclusive(async()=>{
      const old=await this.read('config');
      // Verified owner, not rotating credentials, owns queued evidence. Other owners'
      // queues remain isolated on disk and are never rebound to a different identity.
      const namespace=hash(server+'\n'+access.owner);
      const cfg={version:1,server,token,owner:access.owner,namespace,projects:scopes,enabled:true,interval_seconds:30};
      // A scope expansion must replay history previously skipped under a narrower scope.
      if(!old||old.namespace!==namespace||canonicalJson(old.projects)!==canonicalJson(scopes))await this.store.remove('cursor/'+namespace);
      await this.write('config',cfg);return {server,projects:scopes.map(({id,path})=>({id,path})),enabled:true};
    });
  }
  async request(config,path,body) {
    const response=await this.fetch(config.server+path,{method:body?'POST':'GET',redirect:'error',headers:{authorization:'Bearer '+config.token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
    const declared=Number(response.headers.get('content-length'));
    if(declared>3*1024*1024)throw Error('server_response_too_large');
    const reader=response.body.getReader();let bytes=0;const chunks=[];
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>3*1024*1024){await reader.cancel();throw Error('server_response_too_large');}chunks.push(Buffer.from(value));}
    let payload;
    try { payload=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { if(!response.ok)throw new SyncHttpError(response.status);throw Error('invalid_server_json'); }
    if(!response.ok) {
      const code=typeof payload?.error==='string' && /^[a-z_0-9]{1,100}$/.test(payload.error) && !payload.error.includes(config.token) ? payload.error : null;
      throw new SyncHttpError(response.status,code);
    }
    return payload;
  }
  async tick() {
    return this.store.exclusive(async()=>{
      const config=await this.read('config');if(!config?.enabled)return {state:'disconnected'};
      const prefix=config.namespace+'/';const issues=[];let queued=0,uploaded=0,downloaded=0,unchanged=0,suppressed_sources=0,discarded_uploads=0,deleted_snapshots=0;
      const error=(where,e)=>issues.push({where,code:safeCode(e)});
      const underQuota=async bytes=>{if((await this.store.usageBytes())*3+bytes>MAX_STORE)throw Error('local_storage_limit');};
      // Persist immutable deltas before advancing the complete-line checkpoint.
      let sources=[];const cache=await this.read('observer-discovery/'+config.namespace,{});
      try{sources=await this.discover(this.home,config.projects,{cache});await this.write('observer-discovery/'+config.namespace,cache);}catch(e){error('discovery',e);}
      const rotation=await this.read('observer-rotation/'+config.namespace,{round:0,path:''});
      const sorted=[...sources].sort((a,b)=>a.path.localeCompare(b.path));const pivot=sorted.findIndex(s=>s.path>rotation.path);const rotated=pivot<0?sorted:[...sorted.slice(pivot),...sorted.slice(0,pivot)];
      const recent=sources.slice(0,2);sources=rotation.round%2===0?[...recent,...rotated.filter(s=>!recent.some(r=>r.path===s.path))]:rotated;let lastVisited=rotation.path;
      let observed_events=0,source_bytes=0,deferred_sources=0;const blockedCapture=new Set();
      const captureAllowance=Math.max(0,50-(await this.store.list('outbox/'+prefix+'observer/')).length);
      // Discovery has its own file/directory bounds; it cannot consume capture time.
      const captureStarted=Date.now();
      for(const source of sources){
        if(queued>=captureAllowance||source_bytes>=64*1024*1024||Date.now()-captureStarted>=20000){deferred_sources++;continue;}
        lastVisited=source.path;
        if(await this.read(suppressionKey(config.namespace,source))){suppressed_sources++;continue;}
        const sourceHash=hash(source.path),scanKey='observer-scan/'+prefix+sourceHash;let checkpoint=await this.read(scanKey);let changed=false;
        try{
          const pending=await this.store.list('outbox/'+prefix+'observer/'+sourceHash+'/');
          if(pending.length){const recovered=(await this.read(pending.at(-1)))?.checkpoint;if(recovered&&(!checkpoint||recovered.createdAt>checkpoint.createdAt||(recovered.generation===checkpoint.generation&&recovered.sequence>checkpoint.sequence))){await this.write(scanKey,recovered);checkpoint=recovered;}}
          for await(const unit of observeFile(source,checkpoint,{maxBytes:Math.min(32*1024*1024,64*1024*1024-source_bytes),maxDeltas:Math.max(1,captureAllowance-queued)})){
            const {delta,next}= {delta:unit.delta,next:unit.checkpoint};
            const key='outbox/'+prefix+'observer/'+hash(source.path)+'/'+String(next.createdAt).padStart(15,'0')+'-'+delta.generation+'/'+String(delta.sequence).padStart(12,'0');
            if(!await this.read(key)&&!await this.read(key.replace('outbox/','receipts/'))){await underQuota(Buffer.byteLength(JSON.stringify(delta))*2);await this.write(key,{observation:delta,checkpoint:next});queued++;}
            await this.write(scanKey,next);changed=true;observed_events+=delta.events.length;source_bytes+=unit.readBytes;
          }
          if(!changed)unchanged++;
        }catch(e){blockedCapture.add(sourceHash);error(source.host+':'+hash(source.session).slice(0,12),e);}
      }
      await this.write('observer-rotation/'+config.namespace,{round:rotation.round+1,path:lastVisited});
      let attempted=0,disabledPending=0;
      for(const key of await this.store.list('outbox/'+prefix)) {
        let snapshot;
        try {
          const queuedRecord=await this.read(key);snapshot=queuedRecord.observation||queuedRecord;
          if(key.includes('/observer/')&&blockedCapture.has(key.split('/observer/')[1].split('/')[0]))continue;
          if(await this.read(suppressionKey(config.namespace,snapshot))) {await this.store.remove(key);discarded_uploads++;continue;}
          if(!config.projects.some(p=>p.id===snapshot.project)){disabledPending++;continue;}
          if(attempted===50)break;
          attempted++;
          const observer=snapshot.format==='hps-observer-delta/1';
          const result=await this.request(config,observer?'/api/measurement/observations':'/api/measurement/snapshots',snapshot);
          if(result.receipt?.state!==(observer?'accepted-observer':'accepted-server')||result.receipt.digest!==snapshot.digest||typeof result.receipt.id!=='string'||(observer&&(result.receipt.sequence!==snapshot.sequence||!snapshotId(result.receipt.session_id))))throw Error('invalid_server_receipt');
          const receiptKey=key.replace('outbox/','receipts/');
          await this.write(receiptKey,result.receipt);
          if(canonicalJson(await this.read(receiptKey))!==canonicalJson(result.receipt))throw Error('receipt_write_failed');
          await this.store.remove(key);uploaded++;
        }catch(e){
          if(deletedResponse(e,'session_deleted')) {
            // Persist before removing queued evidence, so a crash cannot resurrect it.
            await this.write(suppressionKey(config.namespace,snapshot),{host:snapshot.host,project:snapshot.project,session:snapshot.session,reason:'session_deleted',at:this.now()});
            await this.store.remove(key);discarded_uploads++;continue;
          }
          error('upload',e);break;
        }
      }
      if(disabledPending)issues.push({where:'upload',code:'queued_project_not_enabled',count:disabledPending});
      // Import accepted records into a separate inbox. Never overwrite host transcripts.
      try {
        const cursorKey='cursor/'+config.namespace;
        let cursor=await this.read(cursorKey);
        for(let page=0;page<5;page++) {
          const result=await this.request(config,'/api/measurement/snapshots?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
          if(!Array.isArray(result.snapshots)||result.snapshots.length>100)throw Error('invalid_server_list');
          for(const item of result.snapshots) {
            if(typeof item.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(item.id))throw Error('invalid_snapshot_id');
            if(!config.projects.some(p=>p.id===item.project))continue;
            const key='inbox/'+prefix+item.id;
            if(await this.read(key))continue;
            let record;
            try { record=await this.request(config,'/api/measurement/snapshots?id='+encodeURIComponent(item.id)); }
            catch(e) { if(deletedResponse(e,'snapshot_deleted')) {deleted_snapshots++;continue;}throw e; }
            const s=record.snapshot;
            if(s?.format!=='hps-session-sync/1'||s.digest!==item.digest||digestOf(s.payload)!==s.digest||s.project!==item.project||s.session!==item.session||!['codex','claude-code'].includes(s.host)||s.payload?.interpretation_status!=='unreviewed'||record.receipt?.state!=='accepted-server'||record.receipt.id!==item.id||record.receipt.digest!==s.digest)throw Error('invalid_server_snapshot');
            validateObservation(s.payload.batch);
            await underQuota(Buffer.byteLength(JSON.stringify(record))*2);
            await this.write(key,record);downloaded++;
          }
          // Cursor committed only after all payloads in the page were verified and stored.
          if(result.next_cursor!==null&&typeof result.next_cursor!=='string')throw Error('invalid_server_cursor');
          const next=result.next_cursor || result.snapshots.at(-1)?.id;
          if(next){await this.write(cursorKey,next);cursor=next;}
          if(!result.next_cursor||result.snapshots.length===0)break;
        }
      }catch(e){error('download',e);}
      const status={state:issues.length?'attention':'connected',at:new Date(this.now()).toISOString(),queued,uploaded,downloaded,unchanged,observed_events,source_bytes,deferred_sources,suppressed_sources,discarded_uploads,deleted_snapshots,pending:(await this.store.list('outbox/'+prefix)).length,issues};
      await this.write('status',status);return status;
    });
  }
  async status(){const c=await this.read('config');const keys=await this.store.list('outbox/');return {configured:!!c,enabled:c?.enabled||false,server:c?.server,projects:c?.projects,isolated_pending:keys.filter(k=>!c||!k.startsWith('outbox/'+c.namespace+'/')).length,last:await this.read('status')};}
  async pause(){return this.store.exclusive(async()=>{const c=await this.read('config');if(c)await this.write('config',{...c,enabled:false});return {enabled:false};});}
  async records(){const c=await this.read('config');const rows=[];if(c)for(const key of await this.store.list('inbox/'+c.namespace+'/'))rows.push(await this.read(key));return rows;}
  /** Online, read-only server results. Never runs an evaluator or records a review. */
  async results(id) {
    if(id!==undefined&&!snapshotId(id))throw Error('invalid_snapshot_id');
    const config=await this.read('config');if(!config)throw Error('connect_first');
    const data=await this.request(config,'/api/measurement/workbench'+(id?'?id='+encodeURIComponent(id):''));
    if(id) {
      const s=data?.snapshot,r=data?.receipt;
      if(s?.format!=='hps-session-sync/1'||!['codex','claude-code'].includes(s.host)||r?.id!==id||r.state!=='accepted-server'||r.digest!==s.digest||digestOf(s.payload)!==s.digest||s.payload?.batch?.session!==s.session||s.payload.batch.scope!==s.project||!Array.isArray(data.history)||!Array.isArray(data.actions)||!Number.isSafeInteger(data.revision)||data.revision<0||!('draft' in data)||!('result' in data))throw Error('invalid_server_results');
      validateObservation(s.payload.batch);
      return this.resultOutput(config,{snapshot:s,receipt:r,draft:data.draft,result:data.result,revision:data.revision,history:data.history,actions:data.actions});
    }
    if(!data||!['sessions','assessments','actions','comparisons'].every(key=>Array.isArray(data[key])))throw Error('invalid_server_results');
    if(data.sessions.some(s=>!snapshotId(s?.id)||typeof s.project!=='string'||!['codex','claude-code'].includes(s.host)))throw Error('invalid_server_results');
    return this.resultOutput(config,{sessions:data.sessions,assessments:data.assessments,actions:data.actions,comparisons:data.comparisons});
  }
  async observations(id){if(id!==undefined&&!snapshotId(id))throw Error('invalid_snapshot_id');const config=await this.read('config');if(!config)throw Error('connect_first');return this.resultOutput(config,await this.request(config,'/api/measurement/observations'+(id?'?id='+encodeURIComponent(id):'')));}
  resultOutput(config,data) {
    // Even a server echo or a quoted credential must not print this connection token.
    return JSON.parse(JSON.stringify(data).replaceAll(config.token,'[REDACTED]'));
  }
}
