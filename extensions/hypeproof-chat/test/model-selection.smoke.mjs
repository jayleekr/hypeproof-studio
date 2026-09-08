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
