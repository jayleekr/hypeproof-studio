// 시험 파일이 실제로 도는지 — `package.json` 의 `scripts.test` 체인과 디스크를 **대조**한다 (#1203).
//
// 왜 있나
// -------
// 2026-09-21, #1187 의 새 스위트를 만들고 `npm test` 를 돌렸더니 **exit 0** 이었다.
// 그런데 그 스위트는 **돌지 않았다** — 체인에 등록을 안 했기 때문이다. 로그에서
// suite 이름을 찾다가 알았다. 초록인데 아무것도 안 본 상태였고, 그 초록을 그대로
// 믿었다면 "시험이 통과한다" 고 보고했을 것이다.
//
// 이 저장소는 같은 형태를 여러 번 겪었다. `harness/dental-authoring.mjs` 의 주석이
// 마이그레이션 목록에 대해 똑같이 경고한다 — *"새 파일을 만들고 여기 등록하지 않으면
// 시험이 옛 스키마로 돌면서 **통과한다.** 초록인데 아무것도 안 본 상태다."*
// **문제를 알면서 주석만 달아 둔 것**이 지금까지의 대응이었다.
//
// 무엇을 하나
// -----------
// 손으로 적은 목록을 없애지 않는다. **대조**한다. 이 방향은 새로 만든 것이 아니라
// `route-registry.test.mjs` 의 `KNOWN_UNMAPPED` 를 그대로 옮긴 것이다 — 이 저장소에서
// 이미 도는 형태이고, **여섯 목록 중 유일하게 양방향으로 잠겨 있던 것**이다.
//
//   디스크의 `test/*.test.mjs`  ↔  `scripts.test` 가 실제로 실행하는 파일
//
// 어느 쪽에도 없으면 실패("등록해라"). 양쪽에 다 있으면 실패("목록에서 지워라").
// 체인이 없는 파일을 가리켜도 실패("유령"). **미등록이 초록이 아니라 빨강이 된다.**
//
// 자동 등록이 아니다. 자동 등록은 "등록 안 해도 되게" 만드는 것이라 다른 문제로
// 바꾸는 것이다. 여기서는 등록을 **강제**한다.
//
// 이 파일 자신도 체인에 있어야 한다
// ---------------------------------
// 아래 §4 가 그것을 단언한다. **잠금 장치가 자기 병에 걸리는 것**이 이 저장소에서
// 반복된 모양이다 — 체인에 없는 이 파일은 아무것도 잠그지 않는다.
//
// Run: node --experimental-strip-types test/test-chain-registry.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, '..');

// 후보 집합은 **이름으로** 정한다: `test/*.test.mjs`.
// 이미 서 있는 명명 규약이고, 파일을 만들며 이름을 정하는 것이 유일한 등록 행위가
// 된다. 체인에 있는 비-`.test.mjs` 는 `smoke.mjs` 하나뿐인데, 이름을 바꾸라고
// 강요하면 채택 비용만 오른다 — 허용 항목으로 둔다(§3 이 이 예외 자체를 잠근다).
const SUFFIX = '.test.mjs';
const CHAIN_EXTRAS = ['smoke.mjs'];

// 체인에 **일부러 넣지 않은** 파일 → 이유.
//
// `KNOWN_UNMAPPED` 와 같은 규약이다: 여기에 줄을 더하는 것은 "이 시험은 `npm test`
// 로 돌리지 않는다" 는 결정을 PR 에 적는 것이고, 리뷰어가 그 결정을 볼 수 있어야 한다.
// **이 목록은 줄어들기만 해야 한다.**
//
// 🔴 로 시작하는 이유는 **괜찮은 예외가 아니라 미해결 부채**다. 둘을 같은 모양으로
// 담으면 읽는 사람이 구분하지 못한다. §5 가 그것들을 따로 세어 로그에 찍는다.
export const NOT_IN_CHAIN = {
  // ── 괜찮은 예외: CI 가 별도 단계로 돈다 ──────────────────────────────────
  // miniflare/workerd 를 띄우므로 `worker / test` 잡이 아니라 자기 단계에서 돈다.
  // (`.github/workflows/pr-ci.yml` 에서 npm script 이름으로 호출된다.)
  'authoring-d1.test.mjs': 'pr-ci.yml 이 별도 단계로 돈다 — `npm run test:authoring:d1` (miniflare D1)',
  'classroom-d1.test.mjs': 'pr-ci.yml 이 별도 단계로 돈다 — `npm run test:classroom:d1` (miniflare D1)',
  'native-trial-d1.test.mjs': 'pr-ci.yml 이 별도 단계로 돈다 — `npm run test:native-trial:d1` (miniflare D1)',

  // ── 🔴 미해결 부채: #1203 의 첫 수확 ────────────────────────────────────
  // 아래 여섯은 **어디서도 안 돈다.** 체인에도 없고 어떤 워크플로도 부르지 않는다.
  // 일부러 뺐다는 표시가 파일 어디에도 없다(헤더를 전부 열어 확인했다).
  // 여기 적는 것은 **돌게 만드는 것이 아니라 보이게 만드는 것**이다 — 실제로
  // 돌릴지 지울지는 이 PR 의 범위가 아니고 #1203 에서 따로 결정한다.
  'access-contracts-d1.test.mjs': '🔴 어디서도 안 돈다 — npm script(`test:access:d1`)는 있으나 어떤 워크플로도 부르지 않는다. 돌릴지 지울지 결정 필요 (#1203 첫 수확)',
  'budget-admission-d1.test.mjs': '🔴 어디서도 안 돈다 — npm script(`test:budgets:d1`)는 있으나 어떤 워크플로도 부르지 않는다. 돌릴지 지울지 결정 필요 (#1203 첫 수확)',
  'budget-surfaces-d1.test.mjs': '🔴 어디서도 안 돈다 — npm script(`test:budget-surfaces:d1`)는 있으나 어떤 워크플로도 부르지 않는다. 돌릴지 지울지 결정 필요 (#1203 첫 수확)',
  'request-settings-d1.test.mjs': '🔴 어디서도 안 돈다 — npm script(`test:effort:d1`)는 있으나 어떤 워크플로도 부르지 않는다. 돌릴지 지울지 결정 필요 (#1203 첫 수확)',
  'usage-costs-d1.test.mjs': '🔴 어디서도 안 돈다 — npm script(`test:costs:d1`)는 있으나 어떤 워크플로도 부르지 않는다. 돌릴지 지울지 결정 필요 (#1203 첫 수확)',
  'scrub-secrets.test.mjs': '🔴 어디서도 안 돈다 — **npm script 조차 없다.** 내용은 게이트웨이 자격증명 스크러빙(epic #431)이고, 코치가 셸을 돌리는 지금 tool_result 가 흘리는 것이 다음 턴 프롬프트와 로그에 들어간다. 돌릴지 결정 필요 (#1203 첫 수확)',
};

const DEBT = '🔴';

/**
 * `scripts.test` 가 **실제로 실행하는** 파일 집합.
 *
 * 체인은 `node … test/x.mjs` 와 `npm run test:y` 가 섞여 있고 `test:y` 가 다시 다른
 * 스크립트를 부를 수 있다. **펼치지 않고 `scripts.test` 문자열만 훑으면** `npm run`
 * 뒤에 숨은 파일이 전부 "체인에 없다" 로 잡혀 이 시험이 거짓 빨강을 낸다.
 */
export function chainedFiles(scripts, entry = 'test') {
  const out = new Set();
  const walk = (name, seen) => {
    if (seen.has(name) || !scripts[name]) return;
    seen.add(name);
    for (const part of scripts[name].split('&&')) {
      const step = part.trim();
      const run = /^npm run ([\w:.-]+)$/.exec(step);
      if (run && scripts[run[1]]) { walk(run[1], seen); continue; }
      for (const m of step.matchAll(/(?:^|\s)(test\/[\w./-]+\.mjs)(?=$|\s)/g)) out.add(m[1]);
    }
  };
  walk(entry, new Set());
  return out;
}

/**
 * 판정 자체는 **순수 함수**다 — 앱도 디스크도 없이 대조군을 돌릴 수 있다(§6).
 * 실기기 런 전에 대조군을 돌리라는 규율(.claude/rules/verification.md §2)이 여기 적용된다.
 */
export function violations({ candidates, chained, notInChain, extras = [], exists = () => true }) {
  const bad = { unregistered: [], claimedButChained: [], staleExemption: [], ghost: [], strayExtra: [] };
  for (const f of candidates) {
    const inChain = chained.has('test/' + f);
    const exempt = Object.prototype.hasOwnProperty.call(notInChain, f);
    if (!inChain && !exempt) bad.unregistered.push(f);
    if (inChain && exempt) bad.claimedButChained.push(f);
  }
  // 목록에 적혀 있는데 파일이 사라진 경우 — 이유만 남고 대상이 없는 상태.
  for (const f of Object.keys(notInChain)) if (!candidates.includes(f)) bad.staleExemption.push(f);
  // 체인이 가리키는데 디스크에 없는 파일.
  for (const p of chained) if (!exists(p)) bad.ghost.push(p);
  // 후보 규약 밖인데 체인에 있는 것 — 허용 항목으로 명시한 것만 통과.
  for (const p of chained) {
    const base = p.slice('test/'.length);
    if (!base.endsWith(SUFFIX) && !extras.includes(base) && !base.includes('/')) bad.strayExtra.push(base);
  }
  return bad;
}

// ── §6 먼저: 계측기 자체 검증 (대조군) ──────────────────────────────────────
// 디스크를 읽기 **전에** 돌린다. 여기서 깨지면 아래 판정은 볼 필요가 없다.
{
  const base = { candidates: ['a.test.mjs'], chained: new Set(['test/a.test.mjs']), notInChain: {} };
  assert.deepEqual(violations(base), { unregistered: [], claimedButChained: [], staleExemption: [], ghost: [], strayExtra: [] },
    '양성 대조군: 등록된 파일 하나는 아무 위반도 아니다');

  // 음성 대조군 넷 — 각 단언이 실제로 무언가를 잡는가.
  assert.deepEqual(violations({ ...base, chained: new Set() }).unregistered, ['a.test.mjs'],
    '체인에서 빠지면 잡는다');
  assert.deepEqual(violations({ ...base, notInChain: { 'a.test.mjs': '이유' } }).claimedButChained, ['a.test.mjs'],
    '이중 등록(체인에도 있고 예외 목록에도 있음)을 잡는다');
  assert.deepEqual(violations({ ...base, notInChain: { 'gone.test.mjs': '이유' } }).staleExemption, ['gone.test.mjs'],
    '사라진 파일의 예외가 남아 있으면 잡는다');
  assert.deepEqual(violations({ ...base, exists: () => false }).ghost, ['test/a.test.mjs'],
    '체인이 없는 파일을 가리키면 잡는다');
  assert.deepEqual(violations({ candidates: [], chained: new Set(['test/odd.mjs']), notInChain: {} }).strayExtra, ['odd.mjs'],
    '규약 밖 파일이 허용 목록 없이 체인에 있으면 잡는다');

  // 체인 펼치기 자체의 대조군 — `npm run` 간접을 안 따라가면 아래가 비어 버린다.
  const scripts = { test: 'node test/a.test.mjs && npm run sub', sub: 'npm run deep', deep: 'node --test test/b.test.mjs' };
  assert.deepEqual([...chainedFiles(scripts)].sort(), ['test/a.test.mjs', 'test/b.test.mjs'],
    'npm run 간접을 끝까지 따라간다 (안 따라가면 b 를 미등록으로 오판한다)');
  assert.deepEqual([...chainedFiles({ test: 'npm run self', self: 'npm run self' })], [],
    '순환 참조에 빠지지 않는다');
}
console.log('  ok  §6 계측기 자체 검증 — 양성 1 · 음성 5 · 체인 펼치기 2');

// ── 실제 대조 ───────────────────────────────────────────────────────────────
const scripts = JSON.parse(readFileSync(join(workerRoot, 'package.json'), 'utf8')).scripts;
const chained = chainedFiles(scripts);
const candidates = readdirSync(join(workerRoot, 'test')).filter(f => f.endsWith(SUFFIX)).sort();
const bad = violations({
  candidates, chained, notInChain: NOT_IN_CHAIN, extras: CHAIN_EXTRAS,
  exists: p => existsSync(join(workerRoot, p)),
});

// §1 — 모든 시험 파일은 체인에 있거나, 이유와 함께 빠져 있다.
assert.deepEqual(bad.unregistered, [],
  `체인에 없고 NOT_IN_CHAIN 에도 없다. package.json 의 scripts.test 에 등록하거나, ` +
  `NOT_IN_CHAIN 에 **이유와 함께** 적어라: ${bad.unregistered.join(', ')}`);
console.log(`  ok  §1 시험 파일 ${candidates.length}개가 전부 체인 또는 이유 있는 예외에 속한다`);

// §2 — 예외 목록이 낡지 않는다. 양방향이라는 것이 이 잠금의 핵심이다.
assert.deepEqual(bad.claimedButChained, [],
  `체인에 등록됐는데 NOT_IN_CHAIN 에 남아 있다 — 목록에서 지워라: ${bad.claimedButChained.join(', ')}`);
assert.deepEqual(bad.staleExemption, [],
  `NOT_IN_CHAIN 에 있는데 파일이 없다 — 목록에서 지워라: ${bad.staleExemption.join(', ')}`);
console.log(`  ok  §2 NOT_IN_CHAIN ${Object.keys(NOT_IN_CHAIN).length}개가 전부 살아 있고 체인과 겹치지 않는다`);

// §3 — 체인이 없는 파일을 가리키지 않고, 규약 밖 항목은 명시된 것뿐이다.
assert.deepEqual(bad.ghost, [], `체인이 없는 파일을 가리킨다: ${bad.ghost.join(', ')}`);
assert.deepEqual(bad.strayExtra, [],
  `${SUFFIX} 규약 밖인데 CHAIN_EXTRAS 에 없다 — 이름을 맞추거나 CHAIN_EXTRAS 에 적어라: ${bad.strayExtra.join(', ')}`);
console.log(`  ok  §3 체인 ${chained.size}개 항목에 유령 없음 · 규약 밖은 명시된 ${CHAIN_EXTRAS.length}개뿐`);

// §4 — 이 파일 자신이 체인에 있다. 없으면 이 잠금은 아무것도 잠그지 않는다.
const self = 'test/' + fileURLToPath(import.meta.url).split('/').pop();
assert.ok(chained.has(self),
  `${self} 자신이 scripts.test 체인에 없다 — 잠금 장치가 자기 병에 걸린 상태다. 등록해라.`);
console.log('  ok  §4 이 잠금 자신이 체인에 등록돼 있다');

// §5 — 부채를 따로 센다. "괜찮은 예외" 와 섞이면 읽는 사람이 구분하지 못한다.
const debt = Object.entries(NOT_IN_CHAIN).filter(([, why]) => why.startsWith(DEBT));
console.log(`  ok  §5 예외 ${Object.keys(NOT_IN_CHAIN).length}개 = 괜찮은 예외 ${Object.keys(NOT_IN_CHAIN).length - debt.length} + ${DEBT} 미해결 부채 ${debt.length}`);
for (const [f, why] of debt) console.log(`        ${DEBT} ${f} — ${why.slice(DEBT.length).trim().split(' —')[0]}`);

console.log(`test-chain-registry: OK (시험 ${candidates.length} · 체인 ${chained.size} · 예외 ${Object.keys(NOT_IN_CHAIN).length} 중 부채 ${debt.length})`);
