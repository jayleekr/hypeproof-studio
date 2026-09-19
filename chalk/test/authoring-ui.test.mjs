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

// #748 — 수업 기능 좁히기 picker. 모델 picker 와 같은 자리, 같은 모양이지만
// "기본값" 이 없다: 좁히기는 목록 하나로 끝난다.
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
// 강사에게 좁히기 전용 규칙이 화면에 적혀 있어야 한다 — "여기서 권한이 늘지 않는다".
assert.match(authoring, /줄이기만/, 'instructor copy says the selection only narrows');
assert.match(authoring, /새 권한이 생기지는 않습니다/, 'instructor copy says no new grant appears here');
assert.match(authoring, /브라우저는 실행 경로와 무관하게 하나로 묶여 있습니다/, 'instructor copy explains the single browser key');
// 체크박스는 이름을 textContent 로 붙인다 — 서버 문자열을 HTML 로 렌더하지 않는다.
assert.match(authoring, /label\.append\(input,document\.createTextNode\(f\.label\)\)/, 'feature labels render as text, never HTML');
assert.doesNotMatch(authoring, /feature-allowed'\)\.innerHTML/, 'the feature list is never built by innerHTML');

const learn = await page('/learn');
assert.match(learn, /c\.assistant\?\.display_name/, 'learn page reads the optional block');
assert.match(learn, /'이 수업의 AI 이름: '\+c\.assistant\.display_name\+' \(AI 도우미\)'/, 'learn page renders the name through textContent with the AI notice');
assert.doesNotMatch(learn, /innerHTML/, 'lesson text is never rendered as HTML');

console.log('PASS authoring ui: AI name round-trips, feature narrowing is opt-in and omitted when inheriting, learn page renders via textContent');

// #1036 — 저장 때 **화면이 모르는 단계 키를 버리지 않는다**.
// step() 이 5개 칸만 그리고 content() 가 그 칸들로만 단계를 다시 만들던 탓에, 제목만
// 고쳐 저장해도 steps[].help 가 조용히 사라졌다. 앞으로 단계에 칸을 넓힐 때마다(금지 항목·
// 시간·증거물) 같은 경로로 데이터가 사라지므로 칸을 넓히기 전에 이것이 먼저다.
// 실제 왕복은 e2e/chalk-authoring/step-key-preservation.mjs 가 브라우저→저장소로 확인한다.
// 여기서는 그 장치가 화면에 실제로 실려 있는지를 정적으로 고정한다.
assert.match(authoring, /const stepOrigin=new WeakMap\(\);/,
  '원본 단계 객체를 fieldset 에 묶어 두는 장치가 있어야 한다');
assert.match(authoring, /f\.className='step';stepOrigin\.set\(f,data\);/,
  'step() 이 그리는 순간 원본을 묶는다 — 나중에 묶으면 import 경로에서 놓친다');
assert.match(authoring, /\{\.\.\.\(stepOrigin\.get\(f\)\?\?\{\}\),\.\.\.Object\.fromEntries\(\[\.\.\.f\.querySelectorAll\('\[data-field\]'\)\]/,
  'content() 는 원본 위에 그린 칸을 덮어써야 한다 — 그린 칸만으로 다시 만들면 안 된다');
assert.match(authoring, /if\(data\.help\)\{const n=document\.createElement\('p'\);n\.className='step-note';/,
  '도움 방식이 있는 단계에 읽기 전용 표시를 낸다');
assert.match(authoring, /도움 방식 설정 있음 — 이 화면에서는 편집할 수 없고 저장 시 유지됩니다/,
  '표시 문구는 편집 불가와 보존을 함께 말한다');
// WeakMap 이어야 하는 이유: 단계를 지우면 그 키도 함께 사라지고, 순서 변경은 같은
// element 를 옮기는 것이라 원본이 다른 단계로 옮겨붙지 않는다. 배열 인덱스로 묶으면 둘 다 깨진다.
assert.ok(!/stepOrigin\s*=\s*\[\]/.test(authoring), '원본을 인덱스 배열로 들고 있으면 순서 변경에서 어긋난다');
console.log('authoring-ui: 모르는 단계 키 보존 장치 정적 락 통과 (#1036)');

// #1114 관문 — 확정 판정을 **화면에 그리는** 부분의 정적 락.
// Service 가 계산한 목록을 옮겨 그릴 뿐이고 여기서 판정하지 않는다. 그 경계를 테스트가
// 지킨다: 새 fetch·새 라우트·상태 쓰기가 없어야 하고, 서버 문자열은 textContent 로만
// 들어가야 한다(이 화면은 어디서도 innerHTML 을 쓰지 않는다).
assert.match(authoring, /<div id="verdict" role="status" aria-live="polite" hidden><\/div><\/fieldset>/,
  '판정 표시 자리는 접힌 "버전 정보" 바깥, 확정 버튼 아래에 있어야 한다 — 펼쳐야 보이면 안 된다');
assert.match(authoring, /err\.status=r\.status;err\.body=j;throw err;/,
  'call() 이 실패 응답의 구조화된 본문을 에러에 실어야 화면이 판정을 그릴 수 있다');
assert.match(authoring, /if\(Array\.isArray\(e\.body\?\.findings\)\)renderVerdict\(e\.body\.findings,true\)/,
  '확정이 막히면 판정 목록 전체를 그린다 — 막은 항목만이 아니라 함께 온 것까지');
assert.match(authoring, /renderVerdict\(d\.pedagogy,false\);\}\);/,
  '경고만 있어 확정된 경우에도 판정을 그린다');
assert.match(authoring, /무엇을 채우면 열리나 — \$\{f\.remedy\}/,
  'remedy 가 화면 문구로 나와야 한다 — 이 작업의 목적이다');
assert.match(authoring, /확정을 멈췄습니다 — 먼저 채울 것이/, '차단 문구는 강사가 읽을 말이어야 한다');
assert.match(authoring, /확정했습니다 — 다음에 채우면 좋을 것이/, '성공 문구도 마찬가지');
assert.match(authoring, /확인하지 못한 항목 —/, 'skip 은 통과가 아니라 미확인으로 따로 보인다');
assert.match(authoring, /const VERDICT_LABEL=\{fail:'막힘',warn:'권고'\}/,
  'severity 키를 그대로 노출하지 않고 읽을 말로 옮긴다');
assert.match(authoring, /clearVerdict\(\);try\{await fn\(\)/,
  '다른 동작을 시작하면 이전 판정을 지운다 — 남은 판정이 현재 상태로 읽히면 안 된다');
// 계층 경계: 판정을 그리는 코드가 새 요청을 만들지 않는다.
const verdictFn = authoring.slice(authoring.indexOf('function renderVerdict'), authoring.indexOf("async function call(path"));
for (const forbidden of ['fetch(', 'localStorage', 'sessionStorage', 'innerHTML']) {
  assert.ok(!verdictFn.includes(forbidden), `renderVerdict 는 ${forbidden} 을 쓰지 않는다 — 그리기만 한다`);
}
console.log('authoring-ui: 관문 판정 렌더링 정적 락 통과 — 그리기만 하고 판정하지 않는다');
// #1130 — **관문이 필수로 만든 칸은 접힌 곳 안에 있으면 안 된다.**
//
// 이 시험이 있는 이유: 선수 조건이 `<details>` 안에 있어서 강사가 펼치지 않으면 확정이
// 422 로 막히는데 화면은 그 칸이 어디 있는지 알려주지 않았다. **사람보다 기계가 먼저
// 걸렸다** — e2e/chalk-authoring/simple.mjs 가 정확히 그 함정에 빠졌고(#1128 에서 수정),
// 원인을 찾던 중 대조군이 오염돼 맞는 가설을 한 번 기각할 뻔했다. 오염된 이유가 우연이
// 아니라 화면 구조 자체였다.
//
// **문구가 아니라 구조를 본다.** summary 텍스트에 기대면 문구를 고칠 때마다 깨진다.
// 대신 그 칸 앞의 `<details>`/`</details>` 를 세어 중첩 깊이를 구한다 — 원인을 찾을 때
// 실제로 쓴 계산과 같다.
const detailsDepthAt = (html, needle) => {
  const i = html.indexOf(needle);
  assert.ok(i > 0, `${needle} 를 찾지 못했다`);
  const before = html.slice(0, i);
  return (before.match(/<details\b/g) ?? []).length - (before.match(/<\/details>/g) ?? []).length;
};
// 관문이 확정의 필수 조건으로 요구하는 칸. 여기 더할 때는 관문도 함께 본다.
for (const field of ['id="prerequisites"']) {
  assert.equal(detailsDepthAt(authoring, field), 0,
    `${field} 는 접힌 영역 밖에 있어야 한다 — 관문이 필수로 만든 칸이다`);
}
// 대조군: 접힌 채로 두는 것이 맞는 선택 설정은 실제로 접혀 있어야 한다.
// (이 줄이 없으면 위 검사는 "details 가 아예 없다"로도 통과한다.)
assert.ok(detailsDepthAt(authoring, 'id="assistant_name"') > 0,
  '선택 설정은 접힌 채로 둔다 — 대조군이 없으면 위 검사가 헛돈다');
// #1012 RUN-01 — 리허설 상태는 **서버가 말하는 것**이어야 한다. 예전에는 이 화면이
// `리허설 미실행` 이라는 글자를 두 곳에 직접 들고 있었고, 서버가 무엇을 주든 그대로
// 찍었다(화면이 판정을 지어냈다). 그 문구를 아무 시험도 잡고 있지 않아서 거짓말이
// 오래 남을 수 있었다 — 그래서 여기서 잠근다.
{
  // 1) 두 자리 모두 서버 값을 읽는다.
  assert.match(authoring, /\$\('delivery-status'\)\.textContent=[^;]*\+rehearsalLabel\(d\.rehearsal\);/,
    '참여 코드 발급 줄이 서버의 rehearsal 을 읽는다');
  assert.match(authoring, /status\('불변 버전을 저장했습니다\. '\+rehearsalLabel\(d\.rehearsal\)\+' · 수업 비활성'\);/,
    '확정 줄이 서버의 rehearsal 을 읽는다');

  // 2) 판정 글자는 **표 하나**에만 있다. 표 밖에 같은 글자가 또 있으면 그게 거짓말이
  //    시작되는 자리다(옛 하드코딩이 정확히 그 모양이었다).
  const labelTable = /const REHEARSAL_LABEL=\{[^}]*\};/.exec(authoring);
  assert.ok(labelTable, '리허설 표시 문구는 한 표에 모아 둔다');
  const outside = authoring.replace(labelTable[0], '');
  assert.ok(!/'리허설 (미실행|통과|실패)'/.test(outside),
    '표 밖에 리허설 판정 문구가 하드코딩돼 있으면 안 된다');

  // 3) 모르는 값·없는 값을 **통과로도 미실행으로도** 읽지 않는다. 관문·준비 점검이
  //    쓰는 말과 같은 문법이어야 강사가 같은 것으로 읽는다.
  assert.match(authoring, /const rehearsalLabel=v=>REHEARSAL_LABEL\[v\]\?\?'리허설 상태 미확인';/,
    '모르는 상태는 미확인이다 — 빈칸을 통과로 읽지 않는다');
}

console.log('authoring-ui: 필수 칸이 접힌 곳 밖에 있다 (#1130) · 리허설 표시는 서버 값이다 (#1012)');
