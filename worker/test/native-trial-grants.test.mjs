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
