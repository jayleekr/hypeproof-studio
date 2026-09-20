// #996 H-21 — 라우트 파일이 레지스트리에 **조용히 빠지지 않게** 한다.
//
// 왜 있나: 2026-09-11 `/v1/messages` 의 오디오 거절이 계량 좌석에서만 돌던 구멍(#901
// REQ-R3)을 고치다가, 그 라우트 파일이 `config/traceability.json` 의 어느 노드에도 없다는
// 것이 드러났다. 매핑이 없으면 그 파일만 바꾼 PR 은 change-impact 에서 "영향 노드 없음"
// 으로 지나간다. 구멍이 오래 남은 이유 중 하나다.
//
// 이 테스트가 요구하는 것은 **매핑이 아니라 결정**이다. 모든 라우트는 둘 중 하나여야 한다:
//   (a) 레지스트리 노드의 source 로 등록돼 있거나
//   (b) 아래 KNOWN_UNMAPPED 에 **이유와 함께** 적혀 있거나.
// 새 라우트를 추가하면서 둘 다 안 하면 여기서 실패한다 — 사각지대가 리뷰에 **보이게** 된다.
//
// KNOWN_UNMAPPED 는 줄어들기만 해야 한다. 여기에 줄을 더하는 것은 "이 라우트는 추적하지
// 않는다" 는 결정을 PR 에 적는 것이고, 그 결정은 리뷰어가 볼 수 있어야 한다.
//
// Run: node --experimental-strip-types test/route-registry.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const ROUTES_DIR = 'worker/src/routes';

/**
 * 레지스트리에 없는 라우트와 **왜 아직 없는지**. 2026-09-13 측정 근거는 #996.
 * 각 이유는 "테스트가 있는가 / 그 테스트가 레지스트리 노드인가" 로 나눴다 —
 * 요구·시험 부모 없이 구현 노드를 만들면 owner·부모를 발명하는 것이라 하지 않았다.
 */
export const KNOWN_UNMAPPED = {
  'admin.ts': '레지스트리 테스트 노드 10여 개가 /admin 을 호출하지만 대부분 픽스처 준비 호출이다 — 전부 부모로 달면 admin 변경마다 무관한 노드가 깨어난다. 관리 기능 자체의 요구 노드 결정 필요 (#996)',
  'authoring.ts': '/admin 아래 하위 라우터(admin.ts:137). authoring.test.mjs 가 호출하지만 그 테스트가 레지스트리에 없다 (#996)',
  'classroom.ts': 'classroom.test.mjs · classroom-d1.test.mjs 가 호출하지만 둘 다 레지스트리에 없고 대응 요구 노드도 없다 (#996)',
  'logs.ts': 'logs-upload.test.mjs 가 호출하지만 레지스트리에 없다. 업로드 허용 목록 계약의 요구 노드 결정 필요 (#996)',
  'native-trials.ts': '/admin 아래 하위 라우터(admin.ts:140). native-trial-grants.test.mjs 가 호출하지만 레지스트리에 없다 (#996)',
  'observations.ts': 'native-trial.test.mjs 등이 호출하지만 레지스트리에 없다 (#996)',
  'rehearsal.ts': '/v1/rehearsal/redeem (#1189 C-2). rehearsal-redeem.test.mjs 가 전수로 호출하지만 그 테스트가 레지스트리에 없고, 저작·리허설 계열의 구현 노드가 아직 없다 — 요구(ST-REQ-CHALK-AUTHORING)와 시험(ST-TEST-CHALK-AUTHORING)의 source 는 둘 다 문서다. 부모와 owner 를 발명하지 않고 결정만 남긴다 (#996 과 같은 형태)',
  'report.ts': 'report-flow.smoke.mjs 가 호출하지만 레지스트리에 없다 (#996)',
  'trace.ts': 'liveness-trace.test.mjs 가 호출하지만 레지스트리에 없다 (#996)',
};

function registrySources(registry) {
  return new Set(registry.nodes.flatMap(n => (n.sources ?? []).map(s => s.path)));
}

function unmappedRoutes(routeFiles, sources, known) {
  const silent = [], stale = [];
  for (const f of routeFiles) {
    const mapped = sources.has(`${ROUTES_DIR}/${f}`);
    if (!mapped && !(f in known)) silent.push(f);
    if (mapped && f in known) stale.push(f);
  }
  const missing = Object.keys(known).filter(f => !routeFiles.includes(f));
  return { silent, stale, missing };
}

// ─── §0 계측기부터 — 판정이 실제로 갈리는가 ────────────────────────────────
// 아래 본 단언은 "silent 가 비어 있다" 형태다. 판정기가 항상 빈 배열을 돌려주는 고장이면
// 공짜로 통과한다. 합성 입력으로 세 갈래가 실제로 잡히는지 먼저 증명한다.
{
  const sources = new Set([`${ROUTES_DIR}/chat.ts`]);
  const r = unmappedRoutes(['chat.ts', 'new-route.ts', 'listed.ts'], sources, { 'listed.ts': 'reason' });
  assert.deepEqual(r.silent, ['new-route.ts'], '매핑도 목록도 없는 새 라우트를 못 잡는다 — 계측기가 죽어 있다');
  // 양성 대조군: 매핑된 라우트와 목록에 적힌 라우트는 조용하다.
  assert.ok(!r.silent.includes('chat.ts') && !r.silent.includes('listed.ts'), '정상 라우트를 사각지대로 잡는다');
  // 매핑됐는데 목록에도 남아 있으면 **목록이 낡은 것**이다 — 줄어들어야 할 목록이 안 줄었다.
  assert.deepEqual(unmappedRoutes(['chat.ts'], sources, { 'chat.ts': 'reason' }).stale, ['chat.ts']);
  // 지워진 라우트가 목록에 남아 있는 것도 잡는다.
  assert.deepEqual(unmappedRoutes([], new Set(), { 'gone.ts': 'reason' }).missing, ['gone.ts']);
}

// ─── §1 실제 저장소 ─────────────────────────────────────────────────────────
{
  const registry = JSON.parse(readFileSync(join(root, 'config', 'traceability.json'), 'utf8'));
  const routeFiles = readdirSync(join(root, ROUTES_DIR)).filter(f => f.endsWith('.ts')).sort();
  assert.ok(routeFiles.length >= 10, `라우트 스캔이 너무 적다(${routeFiles.length}) — 경로가 틀렸다`);

  const { silent, stale, missing } = unmappedRoutes(routeFiles, registrySources(registry), KNOWN_UNMAPPED);
  assert.deepEqual(silent, [],
    `레지스트리에도 KNOWN_UNMAPPED 에도 없는 라우트: ${silent.join(', ')}\n` +
    `  → config/traceability.json 의 노드 source 로 등록하거나, 이 파일의 KNOWN_UNMAPPED 에 이유와 함께 적어라.\n` +
    `  둘 다 안 하면 이 라우트를 바꾼 PR 은 change-impact 에서 "영향 노드 없음" 으로 지나간다 (#996).`);
  assert.deepEqual(stale, [], `레지스트리에 등록됐는데 KNOWN_UNMAPPED 에 남아 있다 — 목록에서 지워라: ${stale.join(', ')}`);
  assert.deepEqual(missing, [], `KNOWN_UNMAPPED 에 있는데 라우트 파일이 없다 — 목록에서 지워라: ${missing.join(', ')}`);
  for (const [f, why] of Object.entries(KNOWN_UNMAPPED)) {
    assert.ok(typeof why === 'string' && why.length >= 20, `${f}: 이유 없이 추적에서 뺄 수 없다`);
  }
  const mapped = routeFiles.filter(f => !(f in KNOWN_UNMAPPED));
  console.log(`route-registry: ${mapped.length}/${routeFiles.length} mapped (${mapped.join(', ')}), ${Object.keys(KNOWN_UNMAPPED).length} explicitly unmapped with reasons — OK`);
}
