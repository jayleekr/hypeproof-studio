// Real pinned Agent SDK/CLI -> actual local Service/SQLite. Provider only is synthetic.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {budgetFixture} from './fixture.mjs';
const {buildSdkQueryOptions}=await import('../../extensions/hypeproof-chat/src/sdkCoachHelpers.ts');
const {query}=await import('../../extensions/hypeproof-chat/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const {budgetBalances}=await import('../../worker/src/lib/budgets.ts');
const {recordCostEvidence}=await import('../../worker/src/lib/usage-costs.ts');
const results=[];
for(const mode of ['chat','retry','read']){
 const dir=mkdtempSync(tmpdir()+'/hps-budget-sdk-'),marker='synthetic-local-file-marker';
 writeFileSync(dir+'/result.txt',marker);
 let toolResultSeen=false,permissionCalls=0;
 const f=await budgetFixture({sdk:mode==='read'?'read':true,providerResponse:({body,index})=>{
  if(mode==='retry'&&index===1)return Response.json({type:'error',error:{type:'rate_limit_error',message:'synthetic retry'}},{status:429});
  if(mode==='read'&&index===1){
   assert.deepEqual(body.tools.map(t=>t.name),['Read']);
   const events=[['message_start',{type:'message_start',message:{id:'synthetic-read',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,service_tier:'standard',inference_geo:'global'}}}],
   ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'read-1',name:'Read',input:{}}}],
   ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({file_path:dir+'/result.txt'})}}],
   ['content_block_stop',{type:'content_block_stop',index:0}],
   ['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}}],['message_stop',{type:'message_stop'}]];
   return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }
  if(mode==='read'&&index===2){toolResultSeen=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'&&JSON.stringify(c.content).includes(marker)));assert(toolResultSeen,'actual CLI Read result must return through next paid attempt');}
 }});
 const controller=new AbortController();let run;
 const timer=setTimeout(()=>{controller.abort();run?.close();},25000);
 try{
  const options=buildSdkQueryOptions({systemPrompt:'Synthetic acceptance',model:'claude-sonnet-4-6',permittedTools:mode==='read'?['Read']:[],permittedMcpTools:[],permittedAgentTools:[],permissionMode:'default',maxTurns:3},
   {proxyUrl:f.serviceOrigin+'/v1',token:f.token,fundingSource:f.contract.contract_id,turnId:'sdk-acceptance-'+mode,baseEnv:{PATH:process.env.PATH,HOME:dir,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},cwd:dir,configDir:dir+'/config'});
  run=query({prompt:'Synthetic local acceptance.',options:{...options,abortController:controller,canUseTool:async(name,input)=>{permissionCalls++;assert.equal(name,'Read');assert.equal(input.file_path,dir+'/result.txt');return{behavior:'allow',updatedInput:input};}}});
  let final;
  for await(const message of run)if(message.type==='result')final=message;
  assert.equal(final?.subtype,'success',JSON.stringify(final));
  // Completion callback may settle just after the CLI consumes message_stop.
  for(let i=0;i<50;i++){if(f.db.prepare('SELECT COUNT(*) n FROM usage_attempt_costs WHERE evidence_version=0').get().n===0)break;await new Promise(r=>setTimeout(r,10));}
  const attempts=f.db.prepare('SELECT * FROM usage_attempt_costs ORDER BY updated_at').all();
  assert.equal(attempts.length,mode==='chat'?1:2);assert.equal(f.upstream.length,attempts.length);
  assert.equal(new Set(attempts.map(a=>a.job_id)).size,1,'retry/tool continuation retain immutable turn funding');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_jobs').get().n,1);
  let balance=(await budgetBalances(f.env,f.root.account_id))[0];
  if(mode==='retry'){
   const unknown=attempts.find(a=>a.pricing_state!=='priced');assert(unknown);assert(balance.held>0,'429 does not imply free');
   const attribution=JSON.parse(unknown.document);
   await recordCostEvidence(f.env,{id:'synthetic-zero-reconciliation',request_id:unknown.request_id,version:unknown.evidence_version+1,source:'provider-reconciliation',source_ref:'synthetic-invoice-verified-zero',execution:'ended',returned_model:attribution.requested_model,service_tier:'standard',region:'global',complete:true,meters:Object.fromEntries(attribution.expected_meters.map(m=>[m,0])),issues:[]});
   balance=(await budgetBalances(f.env,f.root.account_id))[0];assert.equal(balance.held,0);assert.equal(balance.spent,32);
  }
  if(mode==='read')assert(toolResultSeen); // SDK may auto-allow local Read under its default policy; report the observed callback count.
  assert.equal(readFileSync(dir+'/result.txt','utf8'),marker);
  results.push({mode,pass:true,http:f.requests,attempts:attempts.length,jobs:1,spent_micro_synthetic:balance.spent,held:balance.held,permission_calls:permissionCalls});
  console.log('PASS actual pinned Agent SDK/CLI:',mode);
 }finally{clearTimeout(timer);run?.close();await f.close();rmSync(dir,{recursive:true,force:true});}
}
const version=JSON.parse(readFileSync(new URL('../../extensions/hypeproof-chat/node_modules/@anthropic-ai/claude-agent-sdk/package.json',import.meta.url),'utf8')).version;
const report={schema:'hps-sdk-budget-acceptance/1',sdk_version:version,provider:'synthetic',database:'actual Hono/SQLite',pass:true,results};
if(process.env.HPS_BUDGET_EVIDENCE)writeFileSync(process.env.HPS_BUDGET_EVIDENCE,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
