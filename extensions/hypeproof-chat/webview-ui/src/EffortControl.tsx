import type { ChatConfig, CourseEffort, WebviewMessage } from '../../src/protocol';

const labels: Record<CourseEffort,string> = {low:'Low',medium:'Medium',high:'High'};
export function EffortControl({config,post}:{config:ChatConfig;post:(m:WebviewMessage)=>void}) {
  const policy = config.effort;
  const result = config.effortResult;
  return <div className="hps-effort">
    {policy && <label>Effort <select aria-label="Effort" value={policy.value} disabled={policy.allowed.length===1}
      onChange={e=>post({type:'selectEffort',value:e.target.value as CourseEffort})}
      onKeyDown={e=>{
        if(e.altKey||e.ctrlKey||e.metaKey||!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
        const current=policy.allowed.indexOf(policy.value);
        const next=e.key==='Home'?0:e.key==='End'?policy.allowed.length-1:Math.max(0,Math.min(policy.allowed.length-1,current+(e.key==='ArrowDown'?1:-1)));
        e.preventDefault();e.stopPropagation();post({type:'selectEffort',value:policy.allowed[next]});
      }}>{policy.allowed.map(v=><option key={v} value={v}>{labels[v]}</option>)}</select></label>}
    {config.effortNotice && <small role="status">{config.effortNotice}</small>}
    {(policy||result) && <details><summary>Effort 설정 확인</summary>
      {policy && <p>{policy.allowed.length===1?'강사가 정한 처리 수준입니다.':'수업에서 허용한 범위 안에서 다음 요청부터 바뀝니다.'} 모델마다 속도와 사용량이 다릅니다.</p>}
      {result?.state==='loading' && <p>이번 요청의 적용 기록을 확인 중입니다.</p>}
      {result?.state==='unknown' && <p>적용 기록 미확인 — 기록이 늦거나 연결되지 않았을 수 있습니다.</p>}
      {result?.state==='observed' && <>
        <p>서버에서 확인된 요청별 전송 설정입니다. 응답 내용의 정확성을 뜻하지 않습니다.</p>
        <ul>{result.requests.map(r=><li key={r.request_id}>
          {config.profile?.model_selection?.choices.find(c=>c.id===r.model)?.label??r.model}: 요청 {r.requested?labels[r.requested]:'수업 기본값'} → 적용 {r.applied?labels[r.applied]:'처리 수준 미지원'}
          {r.reason==='course_default'?' · 수업 기본값':''}{r.status>=400?' · 요청 실패':''}
        </li>)}</ul>
        {result.truncated && <p>처음 100개 요청만 표시합니다.</p>}
      </>}
      {result && <button type="button" onClick={()=>post({type:'refreshEffort'})}>적용 기록 다시 확인</button>}
    </details>}
  </div>;
}
