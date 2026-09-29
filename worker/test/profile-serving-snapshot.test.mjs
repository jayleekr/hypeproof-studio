// What every registered cohort's seat is actually served on `GET /v1/profile`.
// Run: node --experimental-strip-types --experimental-sqlite test/profile-serving-snapshot.test.mjs
// Rewrite the baseline: SNAPSHOT_UPDATE=1 node --experimental-strip-types --experimental-sqlite …
//
// ## Why this exists
//
// ADR 0010 splits `observation.enabled`, which today silently carries four separate
// switches. The 2026-09-20 sweep measured what rides along with it:
//
//   /v1/profile session gating   7 of 9 profiles flip 200 → 403
//   chat-history storage key     existing students lose their past conversations
//   individual-trial minting     kids cohorts become mintable
//   assessment model routing     GPT/GLM cohorts 502 on every assess
//
// Of those four, this snapshot can only SEE the ones that reach `/v1/profile`:
// session gating (200 -> 403) and the served observation block. The chat-history
// key and individual-trial minting are decided elsewhere and need their own
// evidence in the ADR steps that move them — do not read a green diff here as
// covering them.
//
// None of that is visible from a unit test of the helper. It is only visible in the
// **route response**, which is what the client actually builds its behaviour from.
// P1's whole feature shipped unreachable because nothing looked there
// (judge-P1-2026-09-20.md F-1), and the repair for it missed a third `/1` literal
// for the same reason.
//
// So the migration gets a baseline: every profile, the response fields that decide
// client behaviour, pinned to a committed file. Each ADR step re-runs this and the
// diff is the evidence that nothing moved except what was meant to.
//
// This is a snapshot, which means it is only as good as the review of its diff.
// It is deliberately NARROW — the handful of fields that change client behaviour,
// not the whole response — so that a diff is short enough to actually read.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
// Static, and before the registry import: this registers the `.md` loader and the
// extensionless-specifier hook the profile modules need.
import { localAuthoring } from './harness/dental-authoring.mjs';
import { TEST_SECRET } from './harness/index.mjs';

const { listProfiles } = await import('../src/profiles/index.ts');
const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');

const BASELINE = new URL('./fixtures/profile-serving-baseline.json', import.meta.url);

/**
 * The fields a client's behaviour actually branches on.
 *
 * `status` first, because the loudest finding was not a field at all — it was
 * 200 becoming 403 for seats that could previously read their profile before
 * class opened.
 */
function shape(status, json) {
  if (status !== 200) return { status, error: json?.error?.code ?? null };
  return {
    status,
    // `assess` is here because the client gates the observation results panel on
    // it (SX-59). A field the snapshot does not read is a field it cannot guard:
    // adding one and leaving `shape()` alone would let the panel appear or vanish
    // for a cohort with a green diff.
    observation: json.observation
      ? {
          format: json.observation.format,
          scope_kind: typeof json.observation.scope,
          assess: json.observation.assess ?? null,
        }
      : null,
    // The banner is appended to the greeting, so its presence is a length change
    // a human would never notice in a diff of the whole response.
    //
    // Matched on the **whole banner sentence**, not a substring. The first version
    // of this line looked for '지원하지 않습니다' and reported the banner as present on
    // studio-gpt-practice and studio-model-practice, which have observation switched
    // OFF — their own welcome copy happens to end '…브라우저 검수는 이 연결에서
    // 지원하지 않습니다.' Two unrelated sentences, one shared phrase.
    update_banner: String(json.welcome?.greeting_md ?? '').includes('이 앱 버전은 작업 관찰 화면을 지원하지 않습니다'),
    sdk_tools: json.sdk_tools ?? null,
    coach_runtime: json.coach_runtime ?? null,
    activity_kind: json.activity_kind ?? null,
  };
}

/** One seat on one cohort, asked the way the extension asks. */
async function serve(profileId, { clientFormat, openSession }) {
  const local = await localAuthoring({ profileId });
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'snapshot');
  if (openSession) {
    local.db
      .prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run('snap', local.cohort, local.profileId,
        new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());
    await setRoster(local.env.HPS_KV, local.cohort, ['student']);
    await startSession(local.env.HPS_KV, local.cohort, {
      session_id: 'snap', profile_id: local.profileId,
      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: new Date(Date.now() + 3600000).toISOString(),
    });
  }
  const { token } = await issue({ u: 'student', c: local.cohort, p: local.profileId }, 1, TEST_SECRET);
  const res = await local.fetcher(local.origin + '/v1/profile', {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + token,
      ...(clientFormat ? { 'x-hps-observation-format': clientFormat } : {}),
    },
  });
  return shape(res.status, await res.json().catch(() => null));
}

// Two client generations and two session states. The session axis is the one that
// matters for ADR 0010 step 2: a seat that can read its profile before class opens
// must keep being able to.
const AXES = [
  { key: 'new-client,session-open', clientFormat: 'hps-observation/2', openSession: true },
  { key: 'new-client,no-session', clientFormat: 'hps-observation/2', openSession: false },
  { key: 'old-client,session-open', clientFormat: 'hps-observation/1', openSession: true },
  { key: 'no-header,no-session', clientFormat: null, openSession: false },
];

const profiles = listProfiles().map((p) => p.id).sort();
assert.ok(profiles.length >= 9, `프로필을 ${profiles.length}개만 읽었다 — 레지스트리 import 가 깨졌다`);

const current = {};
for (const id of profiles) {
  current[id] = {};
  for (const axis of AXES) {
    current[id][axis.key] = await serve(id, axis);
  }
}

if (process.env.SNAPSHOT_UPDATE === '1' || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`profile-serving-snapshot: baseline written — ${profiles.length} profiles × ${AXES.length} axes`);
} else {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const drift = [];
  for (const id of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    for (const axis of AXES) {
      const a = JSON.stringify(baseline[id]?.[axis.key] ?? null);
      const b = JSON.stringify(current[id]?.[axis.key] ?? null);
      if (a !== b) drift.push(`${id} [${axis.key}]\n      was: ${a}\n      now: ${b}`);
    }
  }
  assert.deepEqual(
    drift,
    [],
    'What a seat is served changed. If that was the point of this commit, re-run with ' +
      'SNAPSHOT_UPDATE=1 and **read the diff** before committing it:\n  ' + drift.join('\n  '),
  );
  console.log(`profile-serving-snapshot: OK — ${profiles.length} profiles × ${AXES.length} axes unchanged`);
}
