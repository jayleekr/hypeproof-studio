import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const bundled=await build({entryPoints:[new URL('../src/activityConnections.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};vm.runInNewContext(bundled.outputFiles[0].text,{module,exports:module.exports,require,process,URL});
const {ActivityConnections,ACTIVITY_TOKEN_KEY}=module.exports;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hps-activity-'));
const a=path.join(tmp,'a'),b=path.join(tmp,'b');fs.mkdirSync(a);fs.mkdirSync(b);
const secrets=new Map([[ACTIVITY_TOKEN_KEY,'synthetic-legacy-never-forward']]);
let failStore=false,failState=false;
function context(){const state=new Map();return {globalStorageUri:{fsPath:path.join(tmp,'storage')},workspaceState:{get:(k,d)=>state.has(k)?state.get(k):d,update:async(k,v)=>{if(failState)throw Error('state failure');state.set(k,v);}},secrets:{keys:async()=>[...secrets.keys()],get:async k=>secrets.get(k),store:async(k,v)=>{if(failStore)throw Error('store failure');secrets.set(k,v);},delete:async k=>secrets.delete(k),onDidChange:()=>({dispose(){}})}};}
const profile=(id,name=id)=>({activity_id:id.repeat(64),display_name:name,activity_kind:'trial'});
let origin='https://synthetic.invalid/v1',root=a;
const raw=context(),store=new ActivityConnections(raw,()=>origin,()=>root,async()=>profile('a'));
try{
 await store.initialize();assert.equal(await store.token(),undefined,'legacy credential is never promoted to an unknown origin');
 await store.commit('synthetic-a',profile('a'),a);const first=store.current;
 const other=new ActivityConnections(raw,()=>origin,()=>a,async()=>profile('a'));await other.initialize();
 const undo=await store.commit('synthetic-b',profile('b'),b);
 assert.equal(await other.token(),'synthetic-a','another window keeps its credential');
 assert.equal(await store.token(),'synthetic-b');
 assert.throws(()=>store.acquire(),/작업 폴더/,'cannot execute B in A root');
 root=b;const reopened=new ActivityConnections(context(),()=>origin,()=>b,async()=>profile('b'));await reopened.initialize();
 assert.equal(await reopened.token(),'synthetic-b','destination root resumes after window reload');
 const release=reopened.acquire();assert.throws(()=>store.acquire(),/다른 창/);release();store.acquire()();
 await assert.rejects(()=>store.commit('synthetic-b',profile('b'),a),/다른 활동/);
 assert.throws(()=>store.prepare(a,profile('b'),()=>assert.fail('must not write a starter in another activity')),/다른 활동/);
 await undo();assert.equal(store.current.ref,first.ref,'failed navigation rolls back exact old reference');
 root=a;origin='https://different.invalid/v1';assert.equal(await store.token(),undefined,'changed server gets no saved credential');origin='https://synthetic.invalid/v1';
 failStore=true;await assert.rejects(()=>store.commit('rotation',profile('a'),a),/store failure/);failStore=false;
 assert.equal(await store.token(),'synthetic-a');
 failState=true;await assert.rejects(()=>store.commit('rotation',profile('a'),a),/state failure/);failState=false;
 assert.equal(await store.token(),'synthetic-a');
 await store.commit('rotated-a',profile('a'),a);assert.equal(store.scope,first.id,'credential reissue retains activity identity');
 const list=await store.list();assert.equal(list.length,1);assert.equal(JSON.stringify(list).includes('rotated-a'),false,'catalog never contains credentials');
 // Real child processes contend for one physical folder, including a dead owner.
 const bundlePath=path.join(tmp,'store.cjs');fs.writeFileSync(bundlePath,bundled.outputFiles[0].text);
 const record=store.current, childPath=path.join(tmp,'child.cjs');
 const binding=fs.readdirSync(path.join(tmp,'storage/activity-bindings')).find(f=>f.endsWith('.json')&&JSON.parse(fs.readFileSync(path.join(tmp,'storage/activity-bindings',f),'utf8')).ref===record.ref);
 fs.writeFileSync(path.join(tmp,'storage/activity-bindings',binding+'.lock'),JSON.stringify({pid:2147483647,nonce:'synthetic-dead-owner'}));
 fs.writeFileSync(childPath,`
 const fs=require('node:fs'),path=require('node:path');
 const {ActivityConnections}=require('./store.cjs');
 const record=JSON.parse(fs.readFileSync(path.join(__dirname,'record.json'),'utf8'));
 const raw={globalStorageUri:{fsPath:path.join(__dirname,'storage')},workspaceState:{get:()=>record.ref},secrets:{get:async()=>JSON.stringify(record)}};
 (async()=>{const store=new ActivityConnections(raw,()=>record.service,()=>record.workspace,async()=>{});await store.initialize();
 for(let n=0;n<10;n++) {let release;for(let retry=0;retry<200;retry++){try{release=store.acquire();break;}catch{await new Promise(r=>setTimeout(r,5));}}
 if(!release)throw Error('no progress');
 const critical=path.join(__dirname,'critical');fs.writeFileSync(critical,String(process.pid),{flag:'wx'});
 await new Promise(r=>setTimeout(r,3));fs.unlinkSync(critical);release();}
 })().catch(()=>{process.exitCode=1});`);
 fs.writeFileSync(path.join(tmp,'record.json'),JSON.stringify(record),{mode:0o600});
 await Promise.all([1,2,3,4].map(()=>promisify(execFile)(process.execPath,[childPath])));
 await store.disconnect();const disconnected=new ActivityConnections(raw,()=>origin,()=>a,async()=>profile('a'));await disconnected.initialize();assert.equal(await disconnected.token(),undefined,'disconnect survives restart');
 assert.equal(secrets.get(ACTIVITY_TOKEN_KEY),'synthetic-legacy-never-forward','migration source preserved');
 console.log('PASS activity connections: window isolation, origin, root conflict, rollback, restart, rotation, storage faults and secret-free catalog');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
