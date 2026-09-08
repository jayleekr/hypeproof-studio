import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexLocalClient } from '../../scripts/lib/codex-local-client.mjs';
import { codexRehearsalResponse, validateCodexRequest } from './harness/codex-rehearsal.mjs';

const body = { model:'gpt-5.6-luna', messages:[{role:'user',content:'합성 요청'}], stream:true };
function protocol({account='chatgpt', turn='success', holdThread=false, externalTools=false}={}) {
 const requests=[];let send,held;
 const client=new CodexLocalClient({listMcpNames:()=>['synthetic-server'],spawnProcess(_exe,args,options){
  assert(args.includes('forced_login_method="chatgpt"'));
  assert(args.includes('features.apps=false'));assert(args.includes('features.plugins=false'));
  assert(args.includes('mcp_servers.synthetic-server={command="false",enabled=false}'));assert(args.includes('mcp_servers={}'));assert(args.includes('features.code_mode_host=false'));
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY'])assert.equal(options.env[key],undefined);
  const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();
  send=m=>proc.stdout.write(JSON.stringify(m)+'\n');
  proc.stdin=new Writable({write(chunk,_enc,done){
   const m=JSON.parse(chunk);requests.push(m);
   queueMicrotask(()=>{
    if(m.id===undefined)return;
    const reply=result=>send({id:m.id,result});
    if(m.method==='initialize')reply({});
    else if(m.method==='account/read')reply({account:account?{type:account}:null});
    else if(m.method==='mcpServerStatus/list')reply({data:externalTools?[{tools:{unexpected:{}}}]:[]});
    else if(m.method==='model/list')reply({data:[{model:'gpt-5.6-luna',displayName:'Luna'}]});
    else if(m.method==='thread/start'){
     assert.equal(m.params.ephemeral,true);assert.equal(m.params.sandbox,'read-only');
     if(holdThread)held=()=>reply({thread:{id:'thread-1'}});else reply({thread:{id:'thread-1'}});
    }else if(m.method==='turn/start'){
     reply({turn:{id:'turn-1'}});
     const event=(method,extra)=>send({method,params:{threadId:'thread-1',...extra}});
     if(turn==='hold')return;
     if(turn==='tool'){event('item/started',{item:{type:'commandExecution'}});return;}
     event('item/agentMessage/delta',{delta:'실제 프로토콜 대조 응답'});
     event('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:40,outputTokens:8,totalTokens:48,cachedInputTokens:20}}});
     event('turn/completed',{turn:{id:'turn-1',status:turn==='error'?'failed':'completed'}});
     event('item/agentMessage/delta',{delta:'이후 이벤트는 무시'});
    }else reply({});
   });done();
  }});return proc;
 }});
 return {client,requests,release:()=>held(),send:(...args)=>send(...args)};
}
for(const mode of ['success','error','tool'])test('App Server protocol: '+mode,async()=>{
 const {client,requests}=protocol({turn:mode});try{
  await client.connect();const deltas=[];
  const result=client.complete({...body,onDelta:x=>deltas.push(x)});
  if(mode==='success'){
   const r=await result;assert.equal(r.text,'실제 프로토콜 대조 응답');assert.equal(r.usage.totalTokens,48);assert.equal(r.auth,'chatgpt');
   assert.deepEqual(deltas,['실제 프로토콜 대조 응답']);assert(!requests.some(x=>x.method==='turn/interrupt'));
  }else {await assert.rejects(result,mode==='tool'?/tool_not_supported/:/turn_failed/);assert(requests.some(x=>x.method==='turn/interrupt'));}
  assert(requests.some(x=>x.method==='thread/unsubscribe'));
 }finally{client.close();}
});
test('reject unauthenticated/API-key account and unavailable model',async()=>{
 for(const account of [null,'apiKey']){const {client}=protocol({account});try{await assert.rejects(client.connect(),/chatgpt_login_required/);}finally{client.close();}}
 const {client}=protocol();try{await client.connect();await assert.rejects(client.complete({...body,model:'unknown'}),/model_unavailable/);}finally{client.close();}
});
test('one active request, including pending thread creation; cancellation before turn avoids generation',async()=>{
 const p=protocol({holdThread:true});try{
  await p.client.connect();const abort=new AbortController();const first=p.client.complete({...body,signal:abort.signal});
  await assert.rejects(p.client.complete(body),/codex_busy/);abort.abort();p.release();
  await assert.rejects(first,/cancelled/);assert(!p.requests.some(x=>x.method==='turn/start'));assert.equal(p.client.busy,false);
 }finally{p.client.close();}
});
test('cancel running turn interrupts own thread; output limit fails explicitly',async()=>{
 const p=protocol({turn:'hold'});try{
  await p.client.connect();const abort=new AbortController();const first=p.client.complete({...body,signal:abort.signal});
  await new Promise(r=>setImmediate(r));abort.abort();await assert.rejects(first,/cancelled/);
  assert(p.requests.some(x=>x.method==='turn/interrupt'));
 }finally{p.client.close();}
 const q=protocol();try{await q.client.connect();await assert.rejects(q.client.complete({...body,maxOutputBytes:2}),/output_limit/);}finally{q.client.close();}
});
test('adapter validates unsupported shapes before any model call',()=>{
 validateCodexRequest(body);
 for(const invalid of [{...body,messages:[]},{...body,stream:false},{...body,tools:[{}]},
  {...body,messages:[{role:'tool',content:'x'}]}, {...body,messages:[{role:'user',content:[{}]}]},
  {...body,messages:[{role:'user',content:'x'.repeat(100001)}]}])assert.throws(()=>validateCodexRequest(invalid),/codex_/);
});
test('adapter success emits content, actual usage and DONE; error never completes',async()=>{
 const records=[];const mock={async complete({onDelta}){onDelta('테스트');return {model:body.model,usage:{inputTokens:4,outputTokens:3,totalTokens:7}};}};
 const response=codexRehearsalResponse(mock,body,{record:r=>records.push(r)});const text=await response.text();
 assert.match(text,/테스트/);assert.match(text,/"total_tokens":7/);assert.match(text,/\[DONE\]/);assert.equal(records[0].status,'completed');
 const errors=[];const fail=codexRehearsalResponse({async complete(){throw Error('codex_turn_failed');}},body,{record:r=>errors.push(r)});
 await assert.rejects(fail.text(),/interrupted/);assert.equal(errors[0].status,'failed');assert.equal(errors[0].usage,null);
});
test('adapter consumer cancellation reaches provider',async()=>{
 let signal;const records=[];
 const response=codexRehearsalResponse({complete(args){signal=args.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('codex_cancelled')),{once:true}));}},body,{record:r=>records.push(r)});
 await response.body.cancel();await new Promise(r=>setImmediate(r));assert.equal(signal.aborted,true);assert.equal(records[0].status,'failed');
});

test('unexpected connected external tools block generation before a thread starts',async()=>{
 const p=protocol({externalTools:true});try{await assert.rejects(p.client.connect(),/tools_not_disabled/);assert(!p.requests.some(x=>x.method==='thread/start'));}finally{p.client.close();}
});
