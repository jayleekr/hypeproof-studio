import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {nativeRaw,openaiRaw} from './harness/usage-costs.mjs';
const {tapAnthropicStream,transformStream,passThroughOpenAIStream}=await import('../src/lib/sse.ts');
const event=(type,data)=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`;
const native=event('message_start',{message:{model:'claude-sonnet-4-6',usage:{...nativeRaw,output_tokens:0}}})+
  event('message_delta',{usage:{output_tokens:2},delta:{stop_reason:'end_turn'}});
for(const fn of [tapAnthropicStream,(body,onUsage,opts)=>transformStream(body,'claude-sonnet-4-6',onUsage,opts)]){
  for(const complete of [true,false]){
    let raw={},model=null,completed=false,recorded=false;
    const source=new Response(native+(complete?event('message_stop',{}):'')).body;
    const stream=fn(source,()=>{recorded=true;},{onUsageReport:(u,m)=>{raw={...raw,...u};if(m)model=m;},onProtocolComplete:()=>{completed=true;}});
    await new Response(stream).text();assert(recorded);assert.equal(completed,complete);
    assert.equal(model,'claude-sonnet-4-6');assert.deepEqual(raw.cache_creation,nativeRaw.cache_creation);assert.equal(raw.output_tokens,2);assert.equal(raw.service_tier,'standard');
  }
}
let raw={},completed=false;
const openai='data: '+JSON.stringify({model:'gpt-5.6-luna',service_tier:'default',choices:[]})+'\n\ndata: '+JSON.stringify({usage:openaiRaw,choices:[]})+'\n\ndata: [DONE]\n\n';
await new Response(passThroughOpenAIStream(new Response(openai).body,()=>{}, {onUsageReport:u=>{raw={...raw,...u};},onProtocolComplete:()=>{completed=true;}})).text();
assert(completed);assert.equal(raw.service_tier,'default');assert.deepEqual(raw.prompt_tokens_details,openaiRaw.prompt_tokens_details);
console.log('PASS SDK tap/proxy transform/OpenAI pass-through: TTL/tier/model preservation and protocol completion versus premature EOF');
