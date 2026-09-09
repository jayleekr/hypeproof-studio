import {useState,useEffect} from 'react';
import type {ChatConfig,WebviewMessage} from '../../src/protocol';
const stateLabels:Record<string,string>={ready:'사용 가능',ended:'이용 기간 종료',paused:'일시정지',review_required:'사용량 확인 필요',exhausted:'남은 자원 부족',not_configured:'이용 한도 설정 대기',external_unknown:'외부 공급자 사용량 미확인'};
const meterLabels:Record<string,string>={'tokens:input':'입력 토큰','tokens:output':'출력 토큰','tokens:cache_read':'캐시 읽기 토큰','tokens:cache_write':'캐시 쓰기 토큰','tokens:cache_write:5m':'5분 캐시 토큰','tokens:cache_write:1h':'1시간 캐시 토큰','requests:count':'요청 수','browser:seconds':'브라우저 초','computer:seconds':'컴퓨터 초','execution:seconds':'실행 초','storage:byte-seconds':'저장 byte·초'};
const unit=(m:string)=>m.startsWith('currency:')?m.split(':')[1]+' 정산 기준':meterLabels[m]??m;
const amount=(n:number,m:string)=>m.startsWith('currency:')?(n/1000000).toLocaleString('en-US',{maximumFractionDigits:6}):n.toLocaleString('en-US');
export function AccessControl({config,streaming,post}:{config:ChatConfig;streaming:boolean;post:(m:WebviewMessage)=>void}){
 const [note,setNote]=useState(''),[expanded,setExpanded]=useState(false);const a=config.access,view=a?.view,choice=view?.choices.find(c=>c.id===a?.selected);
 useEffect(()=>{if(view?.required&&!a?.selected)setExpanded(true);},[view?.required,a?.selected]);
 if(!a)return null;
 return <details className="hps-access" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
  <summary>이용권 · 사용량 {choice?'· '+choice.label:a.status==='unknown'?'· 미확인':''}{choice&&<small className="hps-access-summary">{stateLabels[choice.state]??'미확인'}{choice.resources[0]?' · '+unit(choice.resources[0].meter)+' '+amount(choice.resources[0].remaining,choice.resources[0].meter)+' 남음':''}</small>}</summary>
  {a.status==='unknown'&&<p role="status">이용권과 사용량을 확인하지 못했습니다. 이전 잔액으로 실행 가능 여부를 판단하지 않습니다.</p>}
  {view?.configured===false&&<p>현재 연결은 수업·체험의 기본 이용 정책을 적용합니다. 별도 이용권 조회는 아직 제공되지 않습니다.</p>}
  {view?.configured&&view.choices.length===0&&<p>{view.required?'사용 가능한 이용권이 없습니다. 운영자에게 연결을 확인해 주세요.':'별도 이용권이 배정되지 않았습니다. 현재 수업·체험 정책을 적용합니다.'}</p>}
  {!!view?.choices.length&&<>
   <label>이번 작업의 이용권 <select aria-label="이번 작업의 이용권" value={a.selected??''} disabled={streaming} onChange={e=>post({type:'selectFunding',id:e.target.value})}>
    <option value="" disabled>직접 선택해 주세요</option>{view.choices.map(c=><option key={c.id} value={c.id} disabled={!c.active}>{c.label} · {c.source_kind==='account'?'개인 이용':'수업·기관 지원'}{!c.available?' · '+(stateLabels[c.state]??'미확인'):''}</option>)}
   </select></label>
   <p className="hps-access-muted">이번 작업에 선택한 이용권을 사용합니다.</p>
  </>}
  {choice&&<>
   {config.profile?.model_selection?.choices.some(c=>c.alias===config.model&&!choice.allowed.models.includes(c.id))&&<p role="status">선택한 모델은 이 이용권에 포함되지 않습니다. 모델을 직접 변경해 주세요.</p>}
   <p><strong>{stateLabels[choice.state]??'상태 미확인'}</strong> · {new Date(choice.ends_at).toLocaleDateString()}까지</p>
   {choice.resources.map(r=><div className="hps-access-resource" key={r.meter}><strong>{unit(r.meter)} · {amount(r.remaining,r.meter)} 남음</strong>
    <span>{r.shared?'수업·기관과 함께 쓰는 한도':'본인 사용 상한'} · 확인된 내 사용 {amount(r.spent,r.meter)}</span>
    <span>내 예약 {amount(r.held,r.meter)} · 미확인 {r.unresolved}건{r.overrun>0?' · 초과 '+amount(r.overrun,r.meter):''}</span></div>)}
   {choice.resources.some(r=>r.meter.startsWith('currency:'))&&<p className="hps-access-muted">AI 사용을 계산하는 정산 기준이며, 학생이 결제할 금액이나 현금 잔액이 아닙니다.</p>}
   <p className="hps-access-muted">모델·Effort·도구에 따라 사용량이 달라집니다. 응답이 끊기면 비용을 확인할 때까지 예약이 남을 수 있습니다.</p>
   <p>한도에 도달해도 중지, 기존 파일과 결과 열람·내보내기는 계속할 수 있습니다.</p>
   {choice.pending_request&&<p role="status">{choice.pending_request.state==='pending'?'추가 사용 요청 · 강사 검토 대기':'요청 처리 · '+choice.pending_request.resolution}</p>}
   {choice.can_request&&choice.pending_request?.state!=='pending'&&<form onSubmit={e=>{e.preventDefault();post({type:'requestBudget',note});setNote('');}}><label>추가 사용이 필요한 이유<input value={note} onChange={e=>setNote(e.target.value)} maxLength={280} required placeholder="예: 마지막 검증을 마무리하고 싶어요"/></label><button type="submit">강사에게 추가 사용 요청</button></form>}
  </>}
  {view&&<small>확인 시각 {new Date(view.as_of).toLocaleString()}{view.truncated?' · 일부 이용권만 표시':''}</small>}
  {a.notice&&<p role="status">{a.notice}</p>}<button type="button" onClick={()=>post({type:'refreshAccess'})}>사용량 새로고침</button>
 </details>;
}
