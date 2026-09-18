import assert from 'node:assert/strict';
const {parseRehearsalUri,classifyRedeemFailure,readRedeemedToken,parseFailureMessage,REJECTED_URI_PARAMS,redeemRehearsalTicket}=await import('../src/rehearsalEntryHelpers.ts');

const TICKET='abcdefghijklmnop0123_-AZ';

// 양성 대조 — 계약대로 생긴 링크는 교환권을 낸다.
const ok=parseRehearsalUri({path:'/rehearse',query:`ticket=${TICKET}`});
assert.deepEqual(ok,{ok:true,ticket:TICKET});

// 음성 대조 — 좌표·자격증명을 URL 로 나르는 링크는 열지 않는다 (ARC-02/ARC-03).
// 조용히 무시하면 보내는 쪽이 통한다고 믿고 계속 보낸다.
for(const name of REJECTED_URI_PARAMS){
  const r=parseRehearsalUri({path:'/rehearse',query:`ticket=${TICKET}&${name}=x`});
  assert.equal(r.ok,false,`${name} 이 통과했다`);
  assert.equal(r.reason,'forbidden_param');
  assert.equal(r.detail,name);
}
// 좌표를 읽어 내보내는 경로가 아예 없어야 한다.
assert.equal(ok.cohort,undefined);assert.equal(ok.course,undefined);assert.equal(ok.sha256,undefined);

// 음성 대조 — 교환권이 없거나 모양이 아니면 Service 에 내보지도 않는다.
assert.equal(parseRehearsalUri({path:'/rehearse',query:''}).reason,'missing_ticket');
assert.equal(parseRehearsalUri({path:'/rehearse',query:'ticket=short'}).reason,'malformed_ticket');
assert.equal(parseRehearsalUri({path:'/other',query:`ticket=${TICKET}`}).reason,'wrong_path');
for(const bad of ['missing_ticket','malformed_ticket','wrong_path','forbidden_param'])
  assert.match(parseFailureMessage({ok:false,reason:bad}),/리허설 링크|열 수 없습니다/);

// 두 번째 클릭은 실수가 아니라 정상 행동이다 — 그때 무슨 말이 뜨는지 고정한다.
const used=classifyRedeemFailure(409,JSON.stringify({error:'already_used'}));
assert.equal(used.code,'already_used');
assert.match(used.friendly,/이미 사용했습니다/);
assert.match(used.friendly,/다시 받아/);           // 다음 행동이 함께 있어야 한다
assert.equal(classifyRedeemFailure(410,JSON.stringify({error:'ticket_expired'})).code,'expired');
assert.equal(classifyRedeemFailure(409,JSON.stringify({error:'sha256_mismatch'})).code,'content_changed');
// 엔드포인트가 아직 없는 배포를 '링크가 틀렸다' 로 읽지 않는다.
assert.equal(classifyRedeemFailure(404,'').code,'unsupported');
assert.equal(classifyRedeemFailure(404,JSON.stringify({error:'not_found'})).code,'not_found');
assert.equal(classifyRedeemFailure(500,'boom').code,'server');
for(const s of [409,410,404,500]) assert(classifyRedeemFailure(s,'').friendly.length>10);

// 교환권은 본문에만 싣는다 — URL 에 두지 않는다 (TUX-SP-01).
let seen;
const okRes=await redeemRehearsalTicket({proxyUrl:'https://synthetic.invalid/v1',ticket:TICKET,
  fetchImpl:async(u,init)=>{seen={u,init};return{ok:true,status:200,json:async()=>({token:'student-token'})};}});
assert.deepEqual(okRes,{ok:true,token:'student-token'});
assert.equal(seen.u,'https://synthetic.invalid/v1/rehearsal/redeem');
assert(!seen.u.includes(TICKET),'교환권이 URL 에 실렸다');
assert.equal(JSON.parse(seen.init.body).ticket,TICKET);

// 서버에 닿지 못한 것을 교환권 탓으로 읽지 않는다.
const net=await redeemRehearsalTicket({proxyUrl:'https://synthetic.invalid/v1',ticket:TICKET,
  fetchImpl:async()=>{throw new Error('offline');}});
assert.equal(net.ok,false);assert.equal(net.failure.code,'network');

// 200 인데 자격이 없으면 성공으로 치지 않는다.
const empty=await redeemRehearsalTicket({proxyUrl:'https://synthetic.invalid/v1',ticket:TICKET,
  fetchImpl:async()=>({ok:true,status:200,json:async()=>({})})});
assert.equal(empty.ok,false);assert.equal(empty.failure.code,'server');
assert.equal(readRedeemedToken({token:''}),undefined);
assert.equal(readRedeemedToken(undefined),undefined);

console.log('PASS rehearsal link carries only a ticket, rejects coordinates/credentials in the URL, and names the second click');
