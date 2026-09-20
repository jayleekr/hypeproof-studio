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
  /const stepFormKeys=\['id','title','instructions','hint','acceptance'\];/,
  'the form declares which step keys it owns — help/ui/evidence/gate are not among them',
);
assert.match(
  authoring,
  /function carry\(c\)\{carriedTop=Object\.fromEntries\(Object\.entries\(c\)\.filter\(\(\[k\]\)=>!formKeys\.includes\(k\)\)\);/,
  'render() keeps the loaded draft’s unknown top-level keys (learning among them)',
);
assert.match(
  authoring,
  /stepOrigin\.set\(f,Object\.fromEntries\(Object\.entries\(data\)\.filter\(\(\[k\]\)=>!stepFormKeys\.includes\(k\)\)\)\);/,
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
  /return \{\.\.\.\(stepOrigin\.get\(f\)\?\?\{\}\),\.\.\.own\};/,
  'a step’s preserved keys are restored under the values the form produced',
);

const learn = await page('/learn');
assert.match(learn, /c\.assistant\?\.display_name/, 'learn page reads the optional block');
assert.match(learn, /'이 수업의 AI 이름: '\+c\.assistant\.display_name\+' \(AI 도우미\)'/, 'learn page renders the name through textContent with the AI notice');
assert.doesNotMatch(learn, /innerHTML/, 'lesson text is never rendered as HTML');

console.log('PASS authoring ui: AI name round-trips, feature narrowing is opt-in and omitted when inheriting, unknown keys survive a save, learn page renders via textContent');

// #1036 — 저장 때 **화면이 모르는 단계 키를 버리지 않는다**.
// step() 이 5개 칸만 그리고 content() 가 그 칸들로만 단계를 다시 만들던 탓에, 제목만
// 고쳐 저장해도 steps[].help 가 조용히 사라졌다. 앞으로 단계에 칸을 넓힐 때마다(금지 항목·
// 시간·증거물) 같은 경로로 데이터가 사라지므로 칸을 넓히기 전에 이것이 먼저다.
// 실제 왕복은 e2e/chalk-authoring/step-key-preservation.mjs 가 브라우저→저장소로 확인한다.
// 여기서는 그 장치가 화면에 실제로 실려 있는지를 정적으로 고정한다.
assert.match(authoring, /const stepOrigin=new WeakMap\(\);/,
  '원본 단계 객체를 fieldset 에 묶어 두는 장치가 있어야 한다');
assert.match(authoring, /f\.className='step';stepOrigin\.set\(f,Object\.fromEntries\(/,
  'step() 이 그리는 순간 미확인 키를 묶는다 — 나중에 묶으면 import 경로에서 놓친다');
assert.match(authoring, /const own=Object\.fromEntries\(\[\.\.\.f\.querySelectorAll\('\[data-field\]'\)\]/,
  'content() 는 그린 칸을 own 으로 모은 뒤 보관분 위에 덮어쓴다 — 그린 칸만으로 다시 만들면 안 된다');
assert.match(authoring, /if\(data\.help\)\{const n=document\.createElement\('p'\);n\.className='step-note';/,
  '도움 방식이 있는 단계에 읽기 전용 표시를 낸다');
assert.match(authoring, /도움 방식 설정 있음 — 이 화면에서는 편집할 수 없고 저장 시 유지됩니다/,
  '표시 문구는 편집 불가와 보존을 함께 말한다');
// WeakMap 이어야 하는 이유: 단계를 지우면 그 키도 함께 사라지고, 순서 변경은 같은
// element 를 옮기는 것이라 원본이 다른 단계로 옮겨붙지 않는다. 배열 인덱스로 묶으면 둘 다 깨진다.
assert.ok(!/stepOrigin\s*=\s*\[\]/.test(authoring), '원본을 인덱스 배열로 들고 있으면 순서 변경에서 어긋난다');
// 음성 대조군 — 단계 보관을 **id 로 색인**하면 아이가 단계 id 를 고치는 순간 보관분을 잃는다.
// 그건 이 이슈가 고치려는 사고의 다른 입구라, 그 구현으로 되돌아가면 여기서 빨개진다.
assert.ok(!/carriedStep/.test(authoring), '단계 보관을 id 로 색인하지 않는다 — 요소로 색인한다');
console.log('authoring-ui: 모르는 단계 키 보존 장치 정적 락 통과 (#1036)');
