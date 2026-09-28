// #747 feature A — the authoring form carries the lesson-level AI display name
// and the student lesson page shows it. Static lock on the served HTML: the
// field must round-trip through content()/render() and be omitted when blank,
// so a draft never stores an ambiguous empty name (the Service rejects one).
import assert from 'node:assert/strict';
import '../../worker/test/harness/loader.mjs';
const { default: chalk } = await import('../src/index.ts');
const env = { HPS_SIGNING_SECRET: 'test-secret-0123456789abcdef', ENVIRONMENT: 'dev', HPS_SERVICE_ORIGIN: 'https://service.test' };
const page = async (path) => { const r = await chalk.fetch(new Request('https://chalk.test' + path), env, {}); assert.equal(r.status, 200, path); return r.text(); };

const authoring = await page('/authoring');
assert.match(authoring, /<input id="assistant_name" maxlength="40"/, 'authoring form exposes the AI name field, bounded like the Service');
assert.match(authoring, /const name=\$\('assistant_name'\)\.value\.replace\(\/\[\\u200B-\\u200D\\uFEFF\]\/g,''\)\.trim\(\);/, 'content() strips pasted zero-width characters and trims the name');
assert.match(authoring, /\.\.\.\(name\?\{assistant:\{display_name:name\}\}:\{\}\)/, 'content() omits the block when blank instead of sending an empty name');
assert.match(authoring, /\$\('assistant_name'\)\.value=c\.assistant\?\.display_name\?\?''/, 'render() restores the saved name and clears it for old-schema drafts');
assert.match(authoring, /도구 권한·모델·AI 고지를 바꾸지 않습니다/, 'instructor copy states the name grants nothing');
assert.match(authoring, /학생이 지은 이름 대신 이 이름이 고정됩니다/, 'instructor copy states a lesson name replaces student self-naming');
assert.match(authoring, /이 Service 버전은 수업별 AI 이름을 아직 받지 않습니다/, 'old-Service 400 is explained when the AI name field is filled');

// #748 — the lesson feature-narrowing picker. Same place and same shape as the model
// picker, but with no "default": narrowing is nothing more than the one list.
assert.match(authoring, /<button id="features-load" type="button">/, 'authoring form can fetch the cohort feature catalogue');
assert.match(authoring, /<select id="feature-mode"><option value="inherit">/, 'default mode is inherit — no narrowing unless the instructor asks');
assert.match(
  authoring,
  /lessonFeatures=mode==='narrow'\?\{allowed:\[\.\.\.\$\('feature-allowed'\)\.querySelectorAll\('input:checked'\)\]\.map\(x=>x\.value\)\}:undefined;/,
  'inherit sends no features block at all, so an untouched lesson keeps the cohort default',
);
assert.match(
  authoring,
  /\.\.\.\(lessonFeatures\?\{features:lessonFeatures\}:\{\}\)/,
  'content() omits the block when inheriting instead of sending an empty selection',
);
assert.match(
  authoring,
  /lessonFeatures=c\.features\?\{allowed:\[\.\.\.c\.features\.allowed\]\}:undefined;/,
  'render() restores a saved narrowing and clears it for old-schema drafts',
);
// The narrowing-only rule has to be written on the screen for the instructor — "no grant grows here".
assert.match(authoring, /줄이기만/, 'instructor copy says the selection only narrows');
assert.match(authoring, /새 권한이 생기지는 않습니다/, 'instructor copy says no new grant appears here');
assert.match(authoring, /브라우저는 실행 경로와 무관하게 하나로 묶여 있습니다/, 'instructor copy explains the single browser key');
// The checkbox attaches its name as textContent — a server string is never rendered as HTML.
assert.match(authoring, /label\.append\(input,document\.createTextNode\(f\.label\)\)/, 'feature labels render as text, never HTML');
assert.doesNotMatch(authoring, /feature-allowed'\)\.innerHTML/, 'the feature list is never built by innerHTML');

// #1036 (SX-56) — the authoring form does not silently drop keys it does not know.
// content() rebuilds the whole body from the DOM. So a key the form has no field for
// disappeared on the next save — steps[].help already did, and the learning block was
// about to go the same way. render() holds on to the unrecognized keys of the draft it
// opened and content() lays them back down.
// It **only preserves** — a learning editing UI is not in the scope of this change.
assert.match(
  authoring,
  /const formKeys=\['schema',\.\.\.fields,'steps','assistant','model','features'\];/,
  'the form declares which top-level keys it owns, so everything else is an unknown key to preserve',
);
assert.match(
  authoring,
  /const stepFormKeys=\['id','title','instructions','hint','acceptance','help','ui'\];/,
  'the form declares which step keys it owns — since G2 help and ui have their own controls; evidence/gate are still only preserved',
);
// #751 G2 — per-step help choices and work surface are EDITED here (not only preserved), and the controls say what they are.
assert.match(authoring, /function stepTeachingValue\(f\)\{/, 'help/ui are produced from the step controls');
assert.match(authoring, /\.\.\.\(on\.length\?\{help:\{default:on\.includes\(def\)\?def:on\[0\],allowed:on\}\}:\{\}\)/, 'no help block when no mode is chosen; the default is always one of the allowed modes');
assert.match(authoring, /지원 전 값 유지: /, 'a ui value this Studio cannot draw is kept and named, never dropped');
assert.match(authoring, /도움 방식은 AI가 돕는 방법이며 도구 권한을 바꾸지 않습니다/, 'the copy says help grants nothing');
// #751 G2 — candidate → rehearsal → confirmation. Freezing is not confirmation and issuing a code is not readiness.
assert.match(authoring, /<button id="freeze" disabled>저장한 초안을 리허설 후보로 고정<\/button>/);
assert.doesNotMatch(authoring, /강의가 확정되었습니다/, 'freezing no longer claims the course is confirmed');
assert.match(authoring, /\$\('confirm-go'\)\.disabled=busy\|\|readiness\?\.state!=='passed'/, 'confirmation is offered only on a passed rehearsal');
assert.match(authoring, /리허설 중 — 코드를 발급했고 Studio의 결과를 기다립니다 \(준비 완료 아님\)/);
assert.doesNotMatch(authoring, /readiness-detail'\)\.innerHTML|impact-view'\)\.innerHTML/, 'server text is never rendered as HTML');
assert.match(
  authoring,
  /function carry\(c\)\{carriedTop=Object\.fromEntries\(Object\.entries\(c\)\.filter\(\(\[k\]\)=>!formKeys\.includes\(k\)\)\);/,
  'render() keeps the loaded draft’s unknown top-level keys (learning among them)',
);
assert.match(
  authoring,
  /carriedStep=new Map\(\(c\.steps\|\|\[\]\)\.map\(s=>\[s\.id,Object\.fromEntries\(Object\.entries\(s\)\.filter\(\(\[k\]\)=>!stepFormKeys\.includes\(k\)\)\)\]\)\);/,
  'unknown step keys are kept per step id, so reordering or deleting a step moves its extras with it',
);
assert.match(authoring, /function render\(c\)\{carry\(c\);/, 'every render path refreshes what is preserved');
assert.match(
  authoring,
  /return \{\.\.\.carriedTop,schema:'hps-session-design\/1',/,
  'content() spreads preserved keys FIRST so the form’s own fields still win',
);
assert.match(
  authoring,
  /return \{\.\.\.carriedStep\.get\(own\.id\),\.\.\.own,\.\.\.stepTeachingValue\(f\)\};/,
  'a step’s preserved keys are restored under the values the form produced (text fields, then help/ui controls)',
);

const learn = await page('/learn');
assert.match(learn, /c\.assistant\?\.display_name/, 'learn page reads the optional block');
assert.match(learn, /'이 수업의 AI 이름: '\+c\.assistant\.display_name\+' \(AI 도우미\)'/, 'learn page renders the name through textContent with the AI notice');
assert.doesNotMatch(learn, /innerHTML/, 'lesson text is never rendered as HTML');

console.log('PASS authoring ui: AI name round-trips, feature narrowing is opt-in and omitted when inheriting, unknown keys survive a save, learn page renders via textContent');
