import './loader.mjs';
import {accessHarness,syntheticPlan,syntheticEvent} from './access.mjs';
import {syntheticPrice} from './usage-costs.mjs';
const {publishAccessPlan,applyAccessEvent}=await import('../../src/lib/access-contracts.ts');
const {publishUsagePrice}=await import('../../src/lib/usage-costs.ts');
const {initializeBudget}=await import('../../src/lib/budgets.ts');
const {resolveExecutionAccess}=await import('../../src/lib/budget-admission.ts');
export async function budgetHarness(binding,{amount=1000,slots=100,subjectSlots=10,cohort,planExtra={}}={}){
  const h=await accessHarness(binding);h.env.HPS_USAGE_REGION='global';
  const id=cohort??h.cohort;
  await h.env.HPS_KV.put(`cohort:${id}:roster`,JSON.stringify({users:Array.from({length:30},(_,i)=>'kid'+String(i+1).padStart(2,'0'))}));
  const plan={...syntheticPlan(),included:[{meter:'currency:USD:micro',amount}],...planExtra},contract=syntheticEvent('budget-contract','cohort',id),price=syntheticPrice();
  // Synthetic exposure quote: 10 input + 10 output*3 + 10 cache*.1 +
  // 10 cache5m*2 + 10 cache1h*3 = 91 microUSD. No production unit prices.
  await publishAccessPlan(h.env,plan);await applyAccessEvent(h.env,contract);await publishUsagePrice(h.env,price);
  const root=await initializeBudget(h.env,{period_id:contract.period.id,max_concurrent:slots,subject_concurrency:subjectSlots,price_revisions:[price.revision],exposure_ref:'synthetic-exposure-only'});
  const payload=(user='kid01')=>({u:user,c:id,p:id,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,v:2});
  const access=async(user='kid01')=>resolveExecutionAccess(h.env,payload(user),contract.contract_id);
  const input=(request_id,user='kid01',extra={})=>({request_id,session_id:'synthetic-session',payload:payload(user),provider:price.provider,model:price.model,runtime:'proxy',protocol:price.protocol,body:{model:price.model,max_tokens:10,messages:[{role:'user',content:'synthetic'}]},...extra});
  return{...h,contract,price,plan,root,payload,access,input};
}
