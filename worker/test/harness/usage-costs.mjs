import './loader.mjs';
export const syntheticPrice=(revision='synthetic-price-1',protocol='anthropic-messages')=>({
  schema:'hps-usage-price/1',revision,publication:'synthetic',
  source:{url:'https://example.invalid/synthetic-price-fixture',revision:'synthetic-1',checked_at:Date.now()},
  provider:protocol==='openai-chat'?'openai':protocol==='metered-tool'?'synthetic-sandbox':'anthropic',
  model:protocol==='openai-chat'?'gpt-5.6-luna':protocol==='metered-tool'?'synthetic-browser':'claude-sonnet-4-6',
  protocol,service_tier:protocol==='openai-chat'?'default':'standard',region:'global',starts_at:0,ends_at:4102444800000,
  currency:'USD',rounding:'ceil-per-meter',
  rates:{'tokens:input':{numerator:1,denominator:1},'tokens:output':{numerator:3,denominator:1},'tokens:cache_read':{numerator:1,denominator:10},
    'tokens:cache_write':{numerator:2,denominator:1},'tokens:cache_write:5m':{numerator:2,denominator:1},'tokens:cache_write:1h':{numerator:3,denominator:1},
    'browser:seconds':{numerator:7,denominator:1}},
  bounds:{'tokens:input':10,'tokens:output':10,'tokens:cache_read':10,'tokens:cache_write':10,'tokens:cache_write:5m':10,'tokens:cache_write:1h':10,'browser:seconds':10},fx:null,
});
export const nativeRaw={input_tokens:10,output_tokens:2,cache_read_input_tokens:20,cache_creation_input_tokens:6,
  cache_creation:{ephemeral_5m_input_tokens:4,ephemeral_1h_input_tokens:2},service_tier:'standard',inference_geo:'global'};
export const openaiRaw={prompt_tokens:40,completion_tokens:2,total_tokens:42,prompt_tokens_details:{cached_tokens:20,cache_write_tokens:10},completion_tokens_details:{reasoning_tokens:2}};
export const syntheticAttempt=(contract,price,id='attempt-1',job='job-1')=>({
  request_id:id,job_id:job,subject_key:'cohort:'+contract.subject.id+':kid01',cohort_id:contract.subject.id,user_id:'kid01',session_id:'synthetic-session',
  contract_id:contract.contract_id,period_id:contract.period.id,policy_revision:'synthetic-policy-1',provider:price.provider,requested_model:price.model,
  protocol:price.protocol,price_revision:price.revision,started_at:Date.now(),
  expected_meters:price.protocol==='anthropic-messages'?['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write:5m','tokens:cache_write:1h']:
    price.protocol==='openai-chat'?['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write']:['browser:seconds'],
});
export const syntheticEvidence=(attempt,normalized,version=1)=>({
  id:attempt.request_id+'-e'+version,request_id:attempt.request_id,version,source:'provider-response',source_ref:'synthetic-provider-receipt',
  execution:'ended',returned_model:attempt.requested_model,service_tier:attempt.protocol==='openai-chat'?'default':'standard',region:'global',complete:true,...normalized,
});
