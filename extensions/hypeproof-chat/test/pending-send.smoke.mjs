import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const bundle=await build({entryPoints:[new URL('../src/chatPanelProvider.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false});
const vscode={workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
const module={exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:id=>id==='vscode'?vscode:require(id),console,Buffer,process,setTimeout,clearTimeout,AbortSignal,URL,TextEncoder,TextDecoder});
const proto=module.exports.ChatPanelProvider.prototype;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function host(){return {pendingSends:0,activeStreams:new Map(),hasActiveStream:proto.hasActiveStream,handleSend:proto.handleSend,post:async()=>{}};}
// Pause the actual send before profile/stream creation. Both submit routes must
// own the connection immediately; an exception must release that ownership.
for(const type of ['sendMessage','retryMessage']){
 const h=host(),auth=deferred();h.context={secrets:{get:()=>auth.promise}};
 assert.equal(h.hasActiveStream(),false);
 const pending=proto.handleMessage.call(h,{type,text:'여행 계획을 정리해줘',prompt:'여행 계획을 정리해줘',history:[]});
 assert.equal(h.activeStreams.size,0);assert.equal(h.hasActiveStream(),true,'accepted send locks before credential read completes');
 auth.reject(new Error('synthetic storage failure'));
 await assert.rejects(pending,/synthetic storage failure/);
 assert.equal(h.hasActiveStream(),false,'early failure releases the connection');
}
// A counter, not a boolean: one rejected pending send cannot unlock another.
{
 const h=host(),first=deferred(),second=deferred();let reads=0;
 h.context={secrets:{get:()=>++reads===1?first.promise:second.promise}};
 const a=proto.handleSend.call(h,'정리해줘',[]),b=proto.handleSend.call(h,'계획해줘',[]);
 first.reject(new Error('first'));await assert.rejects(a,/first/);
 assert.equal(h.hasActiveStream(),true);second.reject(new Error('second'));await assert.rejects(b,/second/);
 assert.equal(h.hasActiveStream(),false);
}
// Even a no-model response remains bound until its history write finishes.
{
 const h=host(),save=deferred();h.cachedProfile={worlds:[{id:'synthetic',emoji:'',guest:'테스트',chip:'테스트'}]};
 h.coachDisplayName=()=> '코치';h.appendHistory=()=>save.promise;
 const pending=proto.handleSend.call(h,'다른 친구도 있어?',[]);
 assert.equal(h.activeStreams.size,0);assert.equal(h.hasActiveStream(),true,'history persistence still owns activity');
 save.resolve();await pending;assert.equal(h.hasActiveStream(),false);
}
// The inverse ordering: preparation already owns the connection, so no send
// reaches secrets or history. No provider call is needed by these controls.
{
 const h=host();h.connectionChanging=true;h.context={secrets:{get:()=>assert.fail('must not read credentials')}};
 await proto.handleMessage.call(h,{type:'sendMessage',text:'정리해줘',history:[]});
 assert.equal(h.hasActiveStream(),false);
}
// Funding selection observes the same pre-stream boundary as activity switching.
{
 const h=host(),auth=deferred();h.context={secrets:{get:()=>auth.promise}};
 h.accessState={selected:'a',view:{choices:[{id:'a',active:true},{id:'b',active:true}]}};
 h.loadAccess=async()=>{};h.postConfig=async()=>{};
 const pending=proto.handleSend.call(h,'일정 정리',[]);
 await proto.handleMessage.call(h,{type:'selectFunding',id:'b'});
 assert.equal(h.accessState.selected,'a','pending authentication must retain the original funding source');
 auth.reject(new Error('synthetic'));await assert.rejects(pending,/synthetic/);
 await proto.handleMessage.call(h,{type:'selectFunding',id:'b'});
 assert.equal(h.accessState.selected,'b','idle choice is available again');
}
console.log('PASS pending send: authentication wait, retry, overlapping failures, history persistence and connection preparation');
