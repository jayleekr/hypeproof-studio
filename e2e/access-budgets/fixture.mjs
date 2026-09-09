import '../../worker/test/harness/loader.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {accessHarness,syntheticPlan,syntheticEvent} from '../../worker/test/harness/access.mjs';
import {syntheticPrice,nativeRaw,openaiRaw} from '../../worker/test/harness/usage-costs.mjs';
import {makeCtx,TEST_SECRET} from '../../worker/test/harness/index.mjs';
const {default:service}=await import('../../worker/src/index.ts');
const {default:chalk}=await import('../../chalk/src/index.ts');
const {issue,issueIssuer}=await import('../../worker/src/lib/tokens.ts');
export async function budgetFixture({sdk=false,providerResponse}={}){
 const h=await accessHarness(),cohort=sdk==='read'?'boah-dental-2026-a':sdk?'canary-internal':'studio-model-practice',profile=sdk==='read'?'boah-dental-director-copyclone-2026-s1':sdk?'canary-sdk-contract':cohort,issuer='synthetic-teacher';
 const roster=['student-a','student-b'];
 await h.env.HPS_KV.put(`cohort:${cohort}:roster`,JSON.stringify({users:roster}));
 const session={session_id:'synthetic-budget-session',profile_id:profile,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()};
 await h.env.HPS_KV.put(`cohort:${cohort}:active_session`,JSON.stringify(session));
 h.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(cohort,'합성 예산 검증');
 h.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run(session.session_id,cohort,profile,session.starts_at,session.ends_at);
 Object.assign(h.env,{OPENAI_API_KEY:'synthetic-no-live-key',ANTHROPIC_API_KEY:'synthetic-no-live-key',HPS_USAGE_REGION:'global'});
 const plan={...syntheticPlan(),label:'수업에 포함된 AI 이용',included:[{meter:'currency:USD:micro',amount:1000000}]};
 if(sdk==='read')plan.allowed.features=['read'];
 const contract=syntheticEvent('synthetic-class','cohort',cohort),prices=[syntheticPrice(),syntheticPrice('synthetic-openai','openai-chat')];
 for(const p of prices)p.bounds['tokens:output']=20000;
 const api=async(path,method='GET',body,auth=h.admin)=>{const r=await h.request(path,{method,body,auth});assert(r.status>=200&&r.status<300,r.text);return r.json;};
 await api('/admin/access/plans','POST',plan);await api('/admin/access/events','POST',contract);
 for(const p of prices)await api('/admin/access/usage/prices','POST',p);
 const root=await api('/admin/access/budgets','POST',{period_id:contract.period.id,max_concurrent:10,subject_concurrency:2,price_revisions:prices.map(p=>p.revision),exposure_ref:'synthetic-visual-exposure'});
 await api('/admin/access/cohorts/'+cohort+'/policy','PUT',{expected_revision:0,required:true,allow_personal:false});
 await api('/admin/access/budget-delegations','PUT',{account_id:root.account_id,issuer_id:issuer,cohort_id:cohort,expected_revision:0,active:true,max_concurrent:10,limits:{'currency:USD:micro':1000000}});
 const token=(await issue({u:roster[0],c:cohort,p:profile},1,TEST_SECRET)).token;
 const teacher=(await issueIssuer({issuer,scopes:[{cohort,profiles:[profile]}]},1,TEST_SECRET)).token;
 const otherTeacher=(await issueIssuer({issuer:'other-instructor',scopes:[{cohort:'other-class',profiles:[profile]}]},1,TEST_SECRET)).token;
 const upstream=[],requests=[],realFetch=globalThis.fetch;
 const serviceFetch=async request=>{const ctx=makeCtx(),r=await service.fetch(request,h.env,ctx);requests.push({path:new URL(request.url).pathname,status:r.status});const response=new Response(r.body,r);response.done=()=>ctx.settle();return response;};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin==='https://service.synthetic')return serviceFetch(new Request(input,init));
  if(['api.openai.com','api.anthropic.com'].includes(url.hostname)){
   const body=JSON.parse(init.body),isOpenAI=url.hostname==='api.openai.com';
   if(url.pathname.endsWith('/count_tokens'))return Response.json({input_tokens:10});
   upstream.push({provider:isOpenAI?'openai':'anthropic',model:body.model,request_state:h.db.prepare("SELECT COUNT(*) n FROM usage_attempt_costs WHERE execution_state='sent'").get().n});
   assert(upstream.at(-1).request_state>0,'must reserve before provider');
   if(providerResponse){const response=await providerResponse({body,url,init,index:upstream.length});if(response)return response;}
   if(!body.stream)return isOpenAI?Response.json({model:body.model,service_tier:'default',choices:[{message:{content:'합성 응답: 예산 예약과 정산을 확인했습니다.'},finish_reason:'stop'}],usage:openaiRaw}):Response.json({model:body.model,content:[{type:'text',text:'합성 응답'}],usage:nativeRaw});
   const data=isOpenAI?[
    {id:'synthetic',model:body.model,service_tier:'default',choices:[{index:0,delta:{role:'assistant',content:'합성 응답: 예산 예약과 정산을 확인했습니다.'},finish_reason:null}]},
    {id:'synthetic',model:body.model,service_tier:'default',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:openaiRaw},
   ].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n':
    'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:body.model,content:[],usage:{...nativeRaw,output_tokens:0}}})+'\n\n'+
    'event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+'\n\n'+
    'event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'합성 응답: 예산 예약과 정산을 확인했습니다.'}})+'\n\n'+
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'+
    'event: message_delta\ndata: '+JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}})+'\n\n'+
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
   return new Response(data,{headers:{'content-type':'text/event-stream'}});
  }
  return realFetch(input,init);
 };
 const chalkEnv={HPS_SIGNING_SECRET:TEST_SECRET,ENVIRONMENT:'dev',HPS_SERVICE_ORIGIN:'https://service.synthetic'};
 const start=async handler=>{const server=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const r=await handler(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined}));res.writeHead(r.status,Object.fromEntries(r.headers));if(r.body){const reader=r.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;res.write(Buffer.from(value));}}res.end();await r.done?.();}catch(error){console.error('synthetic HTTP failure',error);res.writeHead(500);res.end('synthetic failure');}});server.listen(0,'127.0.0.1');await once(server,'listening');return{server,origin:'http://127.0.0.1:'+server.address().port};};
 const serviceServer=await start(serviceFetch),chalkServer=await start(r=>chalk.fetch(r,chalkEnv,{}));
 return{...h,cohort,profile,token,teacher,otherTeacher,root,contract,api,upstream,requests,serviceOrigin:serviceServer.origin,chalkOrigin:chalkServer.origin,
  async close(){for(const {server}of [serviceServer,chalkServer]){server.closeAllConnections();await new Promise(r=>server.close(r));}globalThis.fetch=realFetch;h.close();}};
}
