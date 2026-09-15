import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { canonicalJson, redactDeep, validateObservation } from './core.mjs';
import { FileRecordStorage, recentLocalSessions, parseLocalTranscriptFile } from './adapters.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const digestOf = value => 'sha256:' + hash(canonicalJson(value));
export const projectId = async path => hash(await realpath(path));
const MAX_BODY=1536*1024;
const MAX_STORE=256*1024*1024;
const safeCode=e=>/^[a-z_0-9]{1,100}$/.test(e?.message||'')?e.message:'sync_operation_failed';
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
    const payload={batch:{...clean.batch,scope:project,program:'hypeproof-measure/0.2.1',events},models:clean.models.slice(-100),conditions,exclusions,evidence:'captured-replay',interpretation_status:'unreviewed'};
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
  constructor({root=resolve(homedir(),'.hypeproof','measurement'),home=homedir(),fetch:fetcher=globalThis.fetch,now=()=>Date.now()}={}) {
    this.store=new FileRecordStorage(resolve(root,'records'));this.home=home;this.fetch=fetcher;this.now=now;
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
    if(!response.ok)throw Error('server_'+response.status);
    const declared=Number(response.headers.get('content-length'));
    if(declared>3*1024*1024)throw Error('server_response_too_large');
    const reader=response.body.getReader();let bytes=0;const chunks=[];
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>3*1024*1024){await reader.cancel();throw Error('server_response_too_large');}chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async tick() {
    return this.store.exclusive(async()=>{
      const config=await this.read('config');if(!config?.enabled)return {state:'disconnected'};
      const prefix=config.namespace+'/';const issues=[];let queued=0,uploaded=0,downloaded=0,unchanged=0;
      const error=(where,e)=>issues.push({where,code:safeCode(e)});
      const underQuota=async bytes=>{if((await this.store.usageBytes())*3+bytes>MAX_STORE)throw Error('local_storage_limit');};
      // Each source is independent. One malformed file never blocks another project/host.
      for(const project of config.projects) {
        let sources;try{sources=await recentLocalSessions(this.home,project.path,this.now(),{all:true});}catch(e){error(project.id,e);continue;}
        for(const source of sources) {
          const scanKey='scan/'+prefix+hash(source.path);
          const mark={bytes:source.bytes,modified:source.modified};
          if(canonicalJson(await this.read(scanKey))===canonicalJson(mark)){unchanged++;continue;}
          try {
            const parsed=await parseLocalTranscriptFile(source.path,source.host);
            if(await realpath(parsed.project)!==project.path||parsed.batch.session!==source.session)throw Error('project_or_session_mismatch');
            for(const snapshot of makeSnapshots(parsed,project.id)) {
              const id=hash(snapshot.host+'\n'+snapshot.project+'\n'+snapshot.session+'\n'+snapshot.digest);
              const queueKey='outbox/'+prefix+id;
              if(await this.read('receipts/'+prefix+id)||await this.read(queueKey))continue;
              await underQuota(Buffer.byteLength(JSON.stringify(snapshot))*2);
              await this.write(queueKey,snapshot);queued++;
            }
            // Advance only after every immutable queue record is durable.
            await this.write(scanKey,mark);
          }catch(e){error(source.host+':'+hash(source.session).slice(0,12),e);}
        }
      }
      let attempted=0,disabledPending=0;
      for(const key of await this.store.list('outbox/'+prefix)) {
        try {
          const snapshot=await this.read(key);
          if(!config.projects.some(p=>p.id===snapshot.project)){disabledPending++;continue;}
          if(attempted===50)break;
          attempted++;
          const result=await this.request(config,'/api/measurement/snapshots',snapshot);
          if(result.receipt?.state!=='accepted-server'||result.receipt.digest!==snapshot.digest||typeof result.receipt.id!=='string')throw Error('invalid_server_receipt');
          const receiptKey=key.replace('outbox/','receipts/');
          await this.write(receiptKey,result.receipt);
          if(canonicalJson(await this.read(receiptKey))!==canonicalJson(result.receipt))throw Error('receipt_write_failed');
          await this.store.remove(key);uploaded++;
        }catch(e){error('upload',e);break;}
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
            const record=await this.request(config,'/api/measurement/snapshots?id='+encodeURIComponent(item.id));
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
      const status={state:issues.length?'attention':'connected',at:new Date(this.now()).toISOString(),queued,uploaded,downloaded,unchanged,pending:(await this.store.list('outbox/'+prefix)).length,issues};
      await this.write('status',status);return status;
    });
  }
  async status(){const c=await this.read('config');const keys=await this.store.list('outbox/');return {configured:!!c,enabled:c?.enabled||false,server:c?.server,projects:c?.projects,isolated_pending:keys.filter(k=>!c||!k.startsWith('outbox/'+c.namespace+'/')).length,last:await this.read('status')};}
  async pause(){return this.store.exclusive(async()=>{const c=await this.read('config');if(c)await this.write('config',{...c,enabled:false});return {enabled:false};});}
  async records(){const c=await this.read('config');const rows=[];if(c)for(const key of await this.store.list('inbox/'+c.namespace+'/'))rows.push(await this.read(key));return rows;}
}
