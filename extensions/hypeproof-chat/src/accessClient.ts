import type { ResolvedProfile } from './protocol';
export interface AccessResource {meter:string;limit:number;remaining:number;shared:boolean;spent:number;held:number;overrun:number;unresolved:number}
export interface AccessChoiceView {id:string;label:string;mode:'included'|'byo';source_kind:string;active:boolean;available:boolean;state:string;ends_at:number;can_request:boolean;
  allowed:{models:string[];efforts:string[];features:string[];runtimes:string[]};resources:AccessResource[];pending_request?:{id:string;state:string;note:string;resolution?:string|null}|null}
export interface AccessView {schema:'hps-access-view/1';configured:boolean;required?:boolean;as_of:string;choices:AccessChoiceView[];truncated?:boolean}
export interface AccessState {status:'ready'|'unknown';view?:AccessView;selected?:string;notice?:string}
export const validFundingSource=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
export function parseAccessView(value:unknown):AccessView{
  const v=value as AccessView;
  if(!v||v.schema!=='hps-access-view/1'||typeof v.configured!=='boolean'||typeof v.as_of!=='string'||!Number.isFinite(Date.parse(v.as_of))||!Array.isArray(v.choices)||v.choices.length>100)throw Error('이용권 응답을 확인할 수 없습니다.');
  for(const c of v.choices){
    if(!validFundingSource(c.id)||typeof c.label!=='string'||!['included','byo'].includes(c.mode)||typeof c.active!=='boolean'||typeof c.available!=='boolean'||typeof c.state!=='string'||!Number.isSafeInteger(c.ends_at)||!c.allowed||!['models','efforts','features','runtimes'].every(k=>Array.isArray(c.allowed[k as keyof typeof c.allowed])&&c.allowed[k as keyof typeof c.allowed].every(x=>typeof x==='string'))||!Array.isArray(c.resources))throw Error('이용권 응답을 확인할 수 없습니다.');
    for(const r of c.resources)if(typeof r.meter!=='string'||!['limit','remaining','spent','held','overrun','unresolved'].every(k=>Number.isSafeInteger(r[k as keyof AccessResource])))throw Error('사용량을 확인할 수 없습니다.');
  }
  return v;
}
export async function fetchAccessView(proxyUrl:string,token:string):Promise<AccessView>{
  const r=await fetch(proxyUrl.replace(/\/$/,'')+'/access',{headers:{authorization:'Bearer '+token,'cache-control':'no-store'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('이용권을 확인하지 못했습니다.');return parseAccessView(await r.json());
}
export async function sendBudgetRequest(proxyUrl:string,token:string,source:string,note:string):Promise<void>{
  if(!validFundingSource(source)||!note.trim()||note.length>280)throw Error('요청 사유를 280자 이내로 입력해 주세요.');
  const r=await fetch(proxyUrl.replace(/\/$/,'')+'/access/requests',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({source_id:source,note}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('추가 사용 요청을 보내지 못했습니다.');
}
/** UI/runtime narrowing only; the Service still authenticates every execution. */
export function accessProfile(profile:ResolvedProfile,choice:AccessChoiceView|undefined):ResolvedProfile{
  if(!choice)return profile;const allowed=new Set(choice.allowed.features);
  return{...profile,sdk_tools:profile.sdk_tools?{...profile.sdk_tools,read:!!profile.sdk_tools.read&&allowed.has('read'),write:!!profile.sdk_tools.write&&allowed.has('write'),shell:!!profile.sdk_tools.shell&&allowed.has('shell'),subagents:!!profile.sdk_tools.subagents&&allowed.has('subagents'),browser:!!profile.sdk_tools.browser&&allowed.has('browser')}:undefined,
    tools:{...profile.tools,web_search:false},browser_control:profile.browser_control?{...profile.browser_control,enabled:profile.browser_control.enabled&&allowed.has('browser')}:undefined};
}
