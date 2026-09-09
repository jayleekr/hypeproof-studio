// Manual controlled live-provider probe. Never invoked by CI or default tests.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
assert.equal(process.env.HPS_BUDGET_LIVE,'1','explicit HPS_BUDGET_LIVE=1 required');
assert(process.env.HPS_BUDGET_DEV_VARS,'explicit private dev vars file required');
const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const {budgetFixture}=await import(root+'/e2e/access-budgets/fixture.mjs');
const {buildSdkQueryOptions}=await import(root+'/extensions/hypeproof-chat/src/sdkCoachHelpers.ts');
const {query}=await import(root+'/extensions/hypeproof-chat/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const vars=Object.fromEntries(readFileSync(process.env.HPS_BUDGET_DEV_VARS,'utf8').split('\n').filter(l=>!l.trim().startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
assert(vars.ANTHROPIC_API_KEY&&vars.ANTHROPIC_PROXY_SECRET);
const liveFetch=globalThis.fetch,dir=mkdtempSync(tmpdir()+'/hps-live-budget-');
let observed;
const f=await budgetFixture({sdk:true,providerResponse:async({body,init,index})=>{
 if(index!==1)return Response.json({type:'error',error:{type:'invalid_request_error',message:'single controlled provider call only'}},{status:400});
 assert(body.max_tokens<=256,'actual output bound enforced before provider');
 const headers=new Headers(init.headers);headers.set('x-api-key',vars.ANTHROPIC_API_KEY);headers.set('X-Sediment-Proxy-Secret',vars.ANTHROPIC_PROXY_SECRET);
 const r=await liveFetch('https://hypeproof-sediment.fly.dev/proxy/anthropic/v1/messages',{...init,headers,signal:AbortSignal.timeout(20000)});
 observed={status:r.status,requested_model:body.model,max_tokens:body.max_tokens,protocol:'anthropic-messages',stream:body.stream};
 return r;
}});
let run;const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();run?.close();},35000);
try{
 const options=buildSdkQueryOptions({systemPrompt:'Internal contract test.',model:'claude-sonnet-4-6',permittedTools:[],permittedMcpTools:[],permittedAgentTools:[],permissionMode:'default',maxTurns:1},{proxyUrl:f.serviceOrigin+'/v1',token:f.token,fundingSource:f.contract.contract_id,turnId:'controlled-live-sdk',baseEnv:{PATH:process.env.PATH,HOME:dir,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'256'},cwd:dir,configDir:dir+'/config'});
 run=query({prompt:'내부 연결 확인입니다. 도구를 쓰지 말고 확인했다고 한 문장만 답하세요.',options:{...options,abortController:controller,canUseTool:async()=>({behavior:'deny',message:'no tools in contract probe'})}});
 let result;for await(const m of run)if(m.type==='result')result={subtype:m.subtype,is_error:m.is_error};
 assert.equal(result?.subtype,'success');
 for(let i=0;i<50;i++){if(f.db.prepare('SELECT COUNT(*) n FROM usage_attempt_costs WHERE evidence_version=0').get().n===0)break;await new Promise(r=>setTimeout(r,10));}
 const a=f.db.prepare('SELECT execution_state,pricing_state,evidence_version FROM usage_attempt_costs').all();
 const receipts=f.db.prepare('SELECT document FROM usage_cost_evidence').all().map(r=>JSON.parse(r.document));
 const report={schema:'hps-controlled-live-sdk/1',checked_at:new Date().toISOString(),sdk_version:'0.3.207',pass:true,result,provider:observed,attempts:a,receipts:receipts.map(r=>({returned_model:r.returned_model,service_tier:r.service_tier,region:r.region,execution:r.execution,complete:r.complete,meters:r.meters,issues:r.issues})),pricing:'synthetic fixture; no monetary cost or invoice validation claimed',state:'isolated local SQLite; no production contract or class changes'};
 if(process.env.HPS_BUDGET_EVIDENCE)writeFileSync(process.env.HPS_BUDGET_EVIDENCE,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{clearTimeout(timer);run?.close();await f.close();rmSync(dir,{recursive:true,force:true});}
