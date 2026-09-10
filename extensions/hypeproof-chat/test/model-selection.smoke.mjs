import assert from 'node:assert/strict';
import {availableModelSelection,selectedModel,modelSelectionScope,selectedEffort,observedEffortResult} from '../src/modelSelection.ts';
const choices=[{alias:'hypeproof-default',id:'sonnet',label:'Sonnet'},{alias:'hypeproof-fast',id:'haiku',label:'Haiku'}];
const profile={profile_id:'course',coach_runtime:'agent-sdk',lesson:{sha256:'version-a'},model_selection:{source:'lesson',runtime:'agent-sdk',provider:'anthropic',default:'hypeproof-default',choices}};
const selection=availableModelSelection(profile,'proxy');assert.equal(selection,profile.model_selection);
const saved={scope:modelSelectionScope(profile),alias:'hypeproof-fast'};
assert.equal(selectedModel(profile,selection,saved,'hypeproof-default'),'hypeproof-fast');
assert.equal(selectedModel(profile,selection,undefined,'hypeproof-fast'),'hypeproof-default','new frozen lesson starts at instructor default');
assert.equal(selectedModel({...profile,lesson:{sha256:'version-b'}},selection,saved,'hypeproof-fast'),'hypeproof-default','new lesson does not inherit a previous choice');
assert.equal(selectedModel(profile,selection,{...saved,alias:'hypeproof-strong'},'hypeproof-strong'),'hypeproof-default');
const fixed={...selection,choices:[choices[0]]};assert.equal(selectedModel(profile,fixed,saved,'hypeproof-fast'),'hypeproof-default');
assert.equal(availableModelSelection({...profile,minor_cohort:true},'agent-sdk'),undefined,'minor runtime gate cannot be widened by model selection');
assert.equal(availableModelSelection(null,'proxy'),undefined);
assert.equal(availableModelSelection({profile_id:'old'},'proxy'),undefined);
assert.equal(availableModelSelection({...profile,coach_runtime:'proxy',model_selection:{...selection,source:'profile',runtime:'proxy'}},'agent-sdk'),undefined,'unsupported machine override does not advertise the wrong catalogue');
console.log('PASS model selection: scoped choice, fixed default, forbidden alias, old Service, runtime mismatch');

const effortSelection={...selection,choices:[{...choices[0],effort:{default:'medium',allowed:['low','medium','high']}},choices[1]]};
const savedEffort={scope:modelSelectionScope(profile),model:'hypeproof-default',value:'high'};
assert.equal(selectedEffort(profile,effortSelection,'hypeproof-default',savedEffort).value,'high');
assert.equal(selectedEffort(profile,effortSelection,'hypeproof-fast',savedEffort),undefined);
assert.equal(selectedEffort({...profile,lesson:{sha256:'new'}},effortSelection,'hypeproof-default',savedEffort).value,'medium');
assert.equal(selectedEffort(profile,effortSelection,'hypeproof-default',{...savedEffort,value:'max'}).value,'medium');
console.log('PASS effort: persisted selection never crosses model, course version, or allowed range');

const recorded={request_id:'request',model:'claude-sonnet-5',requested:'low',applied:'low',reason:'selected',status:200,created_at:'2026-09-08'};
assert.equal(observedEffortResult({requests:[recorded],truncated:false}).state,'observed');
for(const data of [null,{}, {requests:[],truncated:false},{requests:[{...recorded,applied:'max'}],truncated:false},{requests:[recorded]},{requests:[{...recorded,status:'200'}],truncated:false}])
 assert.equal(observedEffortResult(data).state,'unknown');

// Reuse the Service's existing participant/session scope for the opted-in trial.
const firstStudent={...profile,observation:{scope:'student-a-session'}};
const otherStudent={...profile,observation:{scope:'student-b-session'}};
assert.notEqual(modelSelectionScope(firstStudent),modelSelectionScope(otherStudent));
assert.equal(selectedModel(otherStudent,selection,{scope:modelSelectionScope(firstStudent),alias:'hypeproof-fast'},'hypeproof-default'),'hypeproof-default');

// ─── cross-provider 좌석: 선택지가 provider 를 들고 온다 ─────────────────────
// 2026-09-10 정정. 이 파일의 fixture 는 전부 Anthropic 모양이었고(위 `choices`),
// 그래서 **서버가 실제로 보내는 cross-provider 모양을 한 번도 재지 않았다.**
// `lesson-model-policy.ts` 의 `servedModelSelection` 은 `crossProviderEnabled(profile)` 일 때
// 선택지마다 `provider` 를 싣는데, 클라이언트 타입에는 그 필드가 아예 없었다.
//
// 오늘 깨지는 것은 없다 — 웹뷰는 `alias`/`label` 만 렌더한다. 문제는 타입을 읽은
// 사람이 "서버는 provider 를 보내지 않는다" 고 결론낸다는 것이고, 그러면 선택지에
// 공급자를 표시하려는 다음 변경이 **이미 오고 있는 값을 못 보고** 서버부터 고치려 든다.
{
  const crossChoices = [
    { alias: 'hypeproof-default', id: 'sonnet', label: 'Sonnet', provider: 'anthropic' },
    { alias: 'gpt-5.6-luna', id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai' },
    { alias: 'glm-5.2', id: 'glm-5.2', label: 'GLM 5.2', provider: 'glm' },
  ];
  const cross = {
    profile_id: 'cross', coach_runtime: 'proxy', lesson: { sha256: 'v1' },
    model_selection: { source: 'profile', runtime: 'proxy', provider: 'glm', default: 'hypeproof-default', choices: crossChoices },
  };
  const sel = availableModelSelection(cross, 'proxy');
  assert.equal(sel, cross.model_selection, 'cross-provider 좌석의 카탈로그가 서빙되지 않는다');

  // provider 가 선택 로직을 **방해하지 않는다** — 추가 필드가 alias 해석을 바꾸면 안 된다.
  assert.equal(selectedModel(cross, sel, undefined, 'hypeproof-default'), 'hypeproof-default');
  const savedCross = { scope: modelSelectionScope(cross), alias: 'gpt-5.6-luna' };
  assert.equal(selectedModel(cross, sel, savedCross, 'hypeproof-default'), 'gpt-5.6-luna', 'GPT 선택이 보존되지 않는다');
  // 음성 대조군 — 카탈로그에 없는 alias 는 여전히 기본값으로 떨어진다.
  assert.equal(
    selectedModel(cross, sel, { ...savedCross, alias: 'gpt-9-nonexistent' }, 'hypeproof-default'),
    'hypeproof-default',
  );
  // 그리고 provider 가 실제로 살아서 전달된다.
  assert.equal(sel.choices.find(c => c.alias === 'gpt-5.6-luna').provider, 'openai');
  assert.deepEqual([...new Set(sel.choices.map(c => c.provider))].sort(), ['anthropic', 'glm', 'openai']);
}

// ─── 드리프트 락 — 워커가 보내는 필드가 클라이언트 타입에 다 있는가 ──────────
// 행동 단언은 내가 손으로 적은 fixture 만 덮는다. 워커가 필드를 하나 더 싣기 시작하면
// 그건 못 잡으므로, **워커 소스의 선언과 클라이언트 선언을 직접 대조한다.**
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const policy = readFileSync(join(here, '..', '..', '..', 'worker', 'src', 'lib', 'lesson-model-policy.ts'), 'utf8');
  const m = /export interface ModelChoice \{([^}]*)\}/.exec(policy);
  assert.ok(m, '워커의 ModelChoice 선언을 못 찾았다 — 이 대조의 기준점이 사라졌다');
  const serverFields = [...m[1].matchAll(/(\w+)\??\s*:/g)].map(x => x[1]).sort();
  // 탐침 양성 대조군 — 추출이 실제로 필드를 뽑았다.
  assert.ok(serverFields.includes('alias') && serverFields.includes('label'), `필드 추출 실패: ${serverFields}`);

  const proto = readFileSync(join(here, '..', 'src', 'protocol.ts'), 'utf8');
  const at = proto.indexOf('choices: Array<{');
  assert.ok(at > 0, '클라이언트 choices 선언을 못 찾았다');
  const block = proto.slice(at, proto.indexOf('}>', at));
  for (const f of serverFields) {
    assert.match(
      block, new RegExp(`\\b${f}\\??\\s*:`),
      `워커가 보내는 \`${f}\` 가 클라이언트 타입에 없다 — 서버가 보내는 것은 타입에 있어야 한다`,
    );
  }
}

console.log('PASS cross-provider: 선택지별 provider 가 보존되고 클라이언트 타입이 워커 선언을 따라간다');
