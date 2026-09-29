import "./harness/loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  createMockEnv,
  bootApp,
  makeCtx,
  TEST_SECRET,
} from "./harness/index.mjs";
const { issue, issueIssuer, verify } = await import("../src/lib/tokens.ts");
const {
  createNativeGrant,
  startNativeGrant,
  readNativeGrant,
  reserveNativeRequest,
  finishNativeRequest,
} = await import("../src/lib/native-trial-grants.ts");
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    readFileSync(
      new URL("../migrations/0004-native-trials.sql", import.meta.url),
      "utf8",
    ),
  );
  const binding = {
    prepare(sql) {
      let values = [];
      return {
        bind(...v) {
          values = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) ?? null;
        },
        async run() {
          const r = db.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async all() {
          return { success: true, results: db.prepare(sql).all(...values) };
        },
      };
    },
  };
  return {
    db,
    env: createMockEnv({
      withSession: false,
      withRoster: false,
      env: { HPS_DB: binding },
    }),
  };
}
async function credential() {
  return (
    await issue(
      {
        u: "synthetic-person",
        c: "studio-native-trial",
        p: "studio-native-trial",
        native_trial: true,
      },
      24,
      TEST_SECRET,
    )
  ).token;
}
test("real SQLite: independent first start, fixed expiry, owner identity, concurrent reservations and duplicate release", async () => {
  const { db, env } = fixture();
  try {
    const p = await verify(await credential(), TEST_SECRET);
    await createNativeGrant(env, p, "synthetic-instructor");
    assert.equal((await readNativeGrant(env, p)).started_at, null);
    const now = Date.now();
    const starts = await Promise.all([
      startNativeGrant(env, p, now),
      startNativeGrant(env, p, now + 100),
    ]);
    assert.deepEqual(starts[0], starts[1]);
    assert.equal(
      await readNativeGrant(env, { ...p, u: "other" }),
      undefined ?? null,
    );
    assert.deepEqual(
      await Promise.all([
        reserveNativeRequest(env, p, "r1"),
        reserveNativeRequest(env, p, "r2"),
      ]),
      [true, false],
    );
    assert.equal((await readNativeGrant(env, p)).requests_used, 1);
    await finishNativeRequest(env, "r1", false);
    await finishNativeRequest(env, "r1", true);
    assert.equal(
      db
        .prepare("SELECT status FROM native_trial_requests WHERE id=?")
        .get("r1").status,
      "failed",
    );
    assert.equal(await reserveNativeRequest(env, p, "r1"), false);
    assert.equal((await readNativeGrant(env, p)).requests_used, 1);
    assert.equal(await reserveNativeRequest(env, p, "r3"), true);
    await finishNativeRequest(env, "r3", true);
    db.prepare("UPDATE native_trials SET request_limit=requests_used").run();
    assert.equal(await reserveNativeRequest(env, p, "r4"), false);
    assert.equal(await startNativeGrant(env, p, now + 3600001), null);
    db.prepare("UPDATE native_trials SET revoked=1").run();
    assert.equal(await startNativeGrant(env, p, now), null);
  } finally {
    db.close();
  }
});
test("existing issuer mint route creates only scoped registered individual grants; no cohort session required", async () => {
  const { db, env } = fixture();
  try {
    const app = await bootApp(),
      id = "studio-native-trial";
    await env.HPS_KV.put(
      `cohort:${id}:roster`,
      JSON.stringify({
        users: ["synthetic-person"],
        updated_at: new Date().toISOString(),
      }),
    );
    const issuer = (
      await issueIssuer(
        {
          issuer: "synthetic-instructor",
          scopes: [
            {
              cohort: id,
              profiles: [id],
              max_hours: 24,
              can_start_session: true,
              max_session_hours: 1,
            },
          ],
        },
        48,
        TEST_SECRET,
      )
    ).token;
    const mint = async (body, token = issuer) =>
      app.fetch(
        new Request("https://test/admin/tokens/issue", {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            u: "synthetic-person",
            c: id,
            p: id,
            hours: 24,
            native_trial: true,
            ...body,
          }),
        }),
        env,
        makeCtx(),
      );
    assert.equal((await mint({ u: "outsider" })).status, 403);
    const r = await mint({});
    assert.equal(r.status, 200);
    const issued = await r.json();
    assert.equal(issued.trial_limits.request_limit, 40);
    const p = await verify(issued.token, TEST_SECRET);
    assert.equal(p.native_trial, true);
    assert.equal(
      (await readNativeGrant(env, p)).owner_id,
      "synthetic-instructor",
    );
    const context = await app.fetch(
      new Request("https://test/v1/observations/context", {
        headers: { authorization: "Bearer " + issued.token },
      }),
      env,
      makeCtx(),
    );
    assert.equal(context.status, 200);
    assert.equal((await context.json()).session, p.jti);
    const bad = (
      await issueIssuer(
        { issuer: "other", scopes: [{ cohort: id, profiles: [id] }] },
        48,
        TEST_SECRET,
      )
    ).token;
    assert.equal((await mint({}, bad)).status, 403);
  } finally {
    db.close();
  }
});
test("reissue preserves the same time and allowance and rejects the old credential", async () => {
  const { db, env } = fixture();
  try {
    const first = await verify(await credential(), TEST_SECRET);
    await createNativeGrant(env, first, "owner");
    await startNativeGrant(env, first);
    await reserveNativeRequest(env, first, "first");
    await finishNativeRequest(env, "first", true);
    const before = await readNativeGrant(env, first),
      next = await verify(await credential(), TEST_SECRET);
    await createNativeGrant(env, next, "owner");
    assert.equal(await readNativeGrant(env, first), null);
    const after = await readNativeGrant(env, next);
    assert.equal(after.requests_used, before.requests_used);
    assert.equal(after.expires_at, before.expires_at);
    assert.equal(after.id, before.id);
    await assert.rejects(
      createNativeGrant(
        env,
        await verify(await credential(), TEST_SECRET),
        "other-owner",
      ),
    );
  } finally {
    db.close();
  }
});
test("runtime middleware holds concurrency through stream completion and bounds retries and input", async () => {
  const { Hono } = await import("hono");
  const { nativeTrialBudget } = await import(
    "../src/middleware/native-trial-budget.ts"
  );
  const { db, env } = fixture();
  try {
    const token = await credential(),
      p = await verify(token, TEST_SECRET);
    await createNativeGrant(env, p, "owner");
    await env.HPS_KV.put(
      "cohort:studio-native-trial:roster",
      JSON.stringify({ users: [p.u], updated_at: new Date().toISOString() }),
    );
    const app = new Hono();
    app.use("/v1/messages", nativeTrialBudget);
    let calls = 0;
    app.post("/v1/messages", (c) => {
      calls++;
      return new Response("data: done\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const request = (id, body = "{}") =>
      app.fetch(
        new Request("https://test/v1/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "x-hps-trial-request-id": id,
          },
          body,
        }),
        env,
        makeCtx(),
      );
    const id = "11111111-1111-4111-8111-111111111111",
      id2 = "22222222-2222-4222-8222-222222222222";
    const first = await request(id);
    assert.equal(first.status, 200);
    const concurrent = await request(id2);
    assert.equal(concurrent.status, 429);
    assert.equal((await concurrent.json()).error.code, "trial_busy");
    assert.equal(calls, 1);
    await first.text();
    assert.equal((await readNativeGrant(env, p)).lease_id, null);
    const duplicate = await request(id);
    assert.equal(duplicate.status, 409);
    assert.equal(calls, 1);
    const second = await request(id2);
    assert.equal(second.status, 200);
    await second.body.cancel();
    assert.equal((await readNativeGrant(env, p)).lease_id, null);
    assert.equal(
      (
        await request(
          "33333333-3333-4333-8333-333333333333",
          "x".repeat(200001),
        )
      ).status,
      413,
    );
    assert.equal((await readNativeGrant(env, p)).requests_used, 2);
  } finally {
    db.close();
  }
});

test('crash recovery preserves spend and only releases an expired reservation',async()=>{
 const {db,env}=fixture();try{
  const p=await verify(await credential(),TEST_SECRET);await createNativeGrant(env,p,'owner');const now=Date.now();await startNativeGrant(env,p,now);
  assert.equal(await reserveNativeRequest(env,p,'orphan',now),true);
  assert.equal(await reserveNativeRequest(env,p,'early',now+119999),false);
  assert.equal(await reserveNativeRequest(env,p,'replacement',now+120001),true);
  assert.equal((await readNativeGrant(env,p)).requests_used,2);
  assert.equal(db.prepare('SELECT status FROM native_trial_requests WHERE id=?').get('orphan').status,'failed');
  await finishNativeRequest(env,'orphan',true);assert.equal((await readNativeGrant(env,p)).lease_id,'replacement');
 }finally{db.close();}
});

test('instructor status and revocation stay owner-scoped and block subsequent API access',async()=>{
 const {db,env}=fixture();try{
  const app=await bootApp(),id='studio-native-trial',p=await verify(await credential(),TEST_SECRET);await createNativeGrant(env,p,'owner');
  await env.HPS_KV.put(`cohort:${id}:roster`,JSON.stringify({users:[p.u],updated_at:new Date().toISOString()}));
  const scoped=async owner=>(await issueIssuer({issuer:owner,scopes:[{cohort:id,profiles:[id],can_start_session:true,max_session_hours:1}]},2,TEST_SECRET)).token;
  const owner=await scoped('owner'),other=await scoped('other');
  const call=(method,token)=>app.fetch(new Request(`https://test/admin/cohorts/${id}/native-trials/${p.u}`,{method,headers:{authorization:'Bearer '+token}}),env,makeCtx());
  assert.equal((await call('GET',other)).status,404);
  const state=await call('GET',owner);assert.equal(state.status,200);assert.equal((await state.json()).remaining_requests,40);
  assert.equal((await call('DELETE',owner)).status,200);assert.equal((await readNativeGrant(env,p)).revoked,1);
  assert.equal(await startNativeGrant(env,p),null);assert.equal(await reserveNativeRequest(env,p,'revoked'),false);
 }finally{db.close();}
});

test('record scope survives credential rotation and separates users',async()=>{
 const {nativeObservationScope}=await import('../src/lib/native-observation-scope.ts');
 const p=await verify(await credential(),TEST_SECRET),session={session_id:'fixed-grant',profile_id:p.p,starts_at:new Date().toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()};
 assert.equal(await nativeObservationScope(p,session),await nativeObservationScope({...p,jti:'rotated'},session));
 assert.notEqual(await nativeObservationScope(p,session),await nativeObservationScope({...p,u:'other'},session));
 assert.notEqual(await nativeObservationScope(p,session),await nativeObservationScope(p,{...session,session_id:'new-grant'}));
});

// US-05: activity is authenticated presentation metadata, independent of App choice.
test('profile labels an authorized native grant as trial without creating another grant', async () => {
 const {db,env}=fixture();
 try {
  await env.HPS_KV.put('cohort:studio-native-trial:roster',JSON.stringify({users:['synthetic-person']}));
  const token=await credential();await createNativeGrant(env,await verify(token,TEST_SECRET),'synthetic-instructor');
  const app=await bootApp();
  const response=await app.fetch(new Request('https://test/v1/profile',{headers:{authorization:'Bearer '+token}}),env,makeCtx());
  assert.equal(response.status,200);assert.equal((await response.json()).activity_kind,'trial');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_trials').get().n,1);
  assert.equal(db.prepare('SELECT requests_used FROM native_trials').get().requests_used,0);
 } finally {db.close();}
});

// ---------------------------------------------------------------------------
// ADR 0010 step 2 — who may be minted an individual trial seat
// ---------------------------------------------------------------------------
//
// Until now the answer was `observation.enabled`, and NOTHING tested it: the
// string 'profile does not support individual trials' appeared exactly once in
// the repository, in the source. So the mintable set could be widened — by a
// default, by a `??` fallback, by a profile inheriting a block through
// structuredClone — and every suite would stay green. The refusal side is the
// side that matters here, so it gets the assertions.

const { listProfiles, getProfile } = await import('../src/profiles/index.ts');

test('exactly two profiles may mint an individual trial seat', async () => {
  // A set assertion, not a per-profile one, because the failure mode is a
  // profile JOINING the set without anyone writing a line about it. Three of
  // the nine profiles are built by spreading another one
  // (studio-gpt-practice spreads studio-native-trial, studio-model-practice
  // spreads studio-gpt-practice, homepage-practice spreads the dental cohort),
  // so a `trial` block placed on a base profile is inherited in silence — the
  // same trap ADR 0010 documents for `observation`.
  //
  // If this list is meant to change, change it here and say why in the commit.
  assert.deepEqual(
    listProfiles().filter((p) => p.trial?.individual === true).map((p) => p.id).sort(),
    ['canary-sdk-contract', 'studio-native-trial'],
  );
  // And the minors are on the other side of it, named rather than implied.
  for (const id of ['sk-biopharm-kids-2026-grade-3-4-s1', 'sk-biopharm-kids-2026-grade-5-6-s1'])
    assert.notEqual(getProfile(id)?.trial?.individual, true, `${id} 가 개인 체험 발급 대상이 됐다`);
});

test('the mint route refuses a cohort that does not declare trial.individual', async () => {
  const { db, env } = fixture();
  try {
    const app = await bootApp();
    // Scoped, authorized, session-capable issuer — everything the route asks
    // for EXCEPT the profile's own declaration. Without this the test could
    // pass on an unrelated 403 and prove nothing.
    const kids = { profile: 'sk-biopharm-kids-2026-grade-3-4-s1', cohort: 'sk-biopharm-2026-a' };
    const issuer = (await issueIssuer({
      issuer: 'synthetic-instructor',
      scopes: [{ cohort: kids.cohort, profiles: [kids.profile], max_hours: 24, can_start_session: true, max_session_hours: 1 }],
    }, 48, TEST_SECRET)).token;
    const mint = (body) => app.fetch(new Request('https://test/admin/tokens/issue', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env, makeCtx());

    const refused = await mint({ u: 'synthetic-person', c: kids.cohort, p: kids.profile, hours: 1, native_trial: true });
    assert.equal(refused.status, 400, `아이 코호트에 개인 체험 좌석이 발급됐다 — ${refused.status}`);
    assert.equal((await refused.json()).error, 'profile does not support individual trials');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_trials').get().n, 0, '거절했는데 grant 행이 생겼다');

    // The hazard the ADR is actually about, made measurable: turning observation
    // ON for this cohort must not hand it an admin capability. It used to —
    // `observation.enabled` WAS the mint condition — and a `trial?.individual ??
    // observation?.enabled` fallback would quietly bring that back while every
    // other assertion in this file stayed green.
    const child = getProfile(kids.profile);
    const childObservation = child.observation;
    child.observation = { enabled: true, record: true, assess: false };
    try {
      const stillRefused = await mint({ u: 'synthetic-person', c: kids.cohort, p: kids.profile, hours: 1, native_trial: true });
      assert.equal(stillRefused.status, 400, '관측을 켰더니 아이 코호트가 개인 체험 발급 대상이 됐다');
      assert.equal((await stillRefused.json()).error, 'profile does not support individual trials');
    } finally { child.observation = childObservation; }

    // And the field this test is NAMED after, pinned.
    //
    // Everything above is also satisfied by a route that reads
    // `session.requires_open_session`: all four flags (record, assess,
    // trial.individual, requires_open_session) are true on exactly the same two
    // profiles today, so on the shipped registry they are indistinguishable.
    // The /v1/profile cases next door set them apart with the canary; this is
    // the same move for the mint route. Without it, swapping the two conditions
    // ships green — and then the day a class cohort declares
    // `requires_open_session` (which is what the field is FOR) that cohort
    // becomes mintable as a personal, out-of-class, minor-facing seat.
    const childSession = child.session;
    child.session = { ...childSession, requires_open_session: true };
    try {
      const wrongField = await mint({ u: 'synthetic-person', c: kids.cohort, p: kids.profile, hours: 1, native_trial: true });
      assert.equal(wrongField.status, 400, '세션 게이트 플래그가 체험 좌석 발급을 열었다 — 두 조건이 뒤바뀌었다');
      assert.equal((await wrongField.json()).error, 'profile does not support individual trials');
    } finally { child.session = childSession; }

    // The mirror: the declaration alone is what opens it, with the session flag
    // absent. Otherwise the two cases above pass against a route that refuses
    // every kids seat for some unrelated reason.
    const childTrial = child.trial;
    child.trial = { individual: true };
    try {
      await env.HPS_KV.put(`cohort:${kids.cohort}:roster`, JSON.stringify({ users: ['synthetic-person'] }));
      const minted = await mint({ u: 'synthetic-person', c: kids.cohort, p: kids.profile, hours: 1, native_trial: true });
      assert.equal(minted.status, 200, `trial.individual 을 켰는데 발급되지 않았다 — ${await minted.text()}`);
    } finally {
      child.trial = childTrial;
      await env.HPS_KV.delete(`cohort:${kids.cohort}:roster`);
    }

    // Positive control on the same route and the same issuer shape: an ordinary
    // classroom seat on that cohort still mints. Otherwise this test would also
    // pass against a route that refused everything.
    const ordinary = await mint({ u: 'synthetic-person', c: kids.cohort, p: kids.profile, hours: 1 });
    assert.equal(ordinary.status, 200, `일반 좌석까지 막혔다 — ${await ordinary.text()}`);
  } finally { db.close(); }
});

test('the chat gate refuses a seat whose profile stopped declaring trial.individual', async () => {
  // The runtime twin of the check above. They read the same field because a
  // seat that mints and then never gets a session is unrecoverable from the
  // student's side: `startNativeGrant` is what starts the one-hour window.
  const { db, env } = fixture();
  const profile = getProfile('studio-native-trial');
  const original = profile.trial;
  try {
    await env.HPS_KV.put('cohort:studio-native-trial:roster', JSON.stringify({ users: ['synthetic-person'] }));
    const token = await credential();
    await createNativeGrant(env, await verify(token, TEST_SECRET), 'synthetic-instructor');
    const app = await bootApp();
    const ask = () => app.fetch(new Request('https://test/v1/profile', { headers: { authorization: 'Bearer ' + token } }), env, makeCtx());

    assert.equal((await ask()).status, 200, '선언이 살아 있는데 좌석이 막혔다');

    profile.trial = { individual: false };
    const refused = await ask();
    assert.equal(refused.status, 403, `선언을 껐는데 좌석이 계속 열렸다 — ${refused.status}`);
    assert.equal((await refused.json()).error.type, 'session_inactive');
  } finally { profile.trial = original; db.close(); }
});
