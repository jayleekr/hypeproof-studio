import "./harness/loader.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { createMockEnv, TEST_SECRET } from "./harness/index.mjs";
const { issue, verify } = await import("../src/lib/tokens.ts");
const {
  createNativeGrant,
  startNativeGrant,
  readNativeGrant,
  reserveNativeRequest,
  finishNativeRequest,
} = await import("../src/lib/native-trial-grants.ts");
const compatibilityDate = readFileSync(
  new URL("../wrangler.toml", import.meta.url),
  "utf8",
).match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
const mf = new Miniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("local trial test")}}',
  compatibilityDate,
  d1Databases: ["HPS_DB"],
});
try {
  const db = await mf.getD1Database("HPS_DB");
  const sql = readFileSync(
    new URL("../migrations/0004-native-trials.sql", import.meta.url),
    "utf8",
  ).replace(/^--.*$/gm, "");
  // Keep trigger BEGIN/END together; ordinary schema statements are separate.
  const triggers = [...sql.matchAll(/CREATE TRIGGER[\s\S]*?END;/g)].map(
    (m) => m[0],
  );
  const statements = [
    ...sql
      .replace(/CREATE TRIGGER[\s\S]*?END;/g, "")
      .split(";")
      .filter((x) => x.trim()),
    ...triggers,
  ];
  for (let repeat = 0; repeat < 2; repeat++)
    for (const statement of statements) await db.prepare(statement).run();
  const env = createMockEnv({ env: { HPS_DB: db } }),
    p = await verify(
      (
        await issue(
          {
            u: "synthetic-d1",
            c: "studio-native-trial",
            p: "studio-native-trial",
            native_trial: true,
          },
          24,
          TEST_SECRET,
        )
      ).token,
      TEST_SECRET,
    );
  await createNativeGrant(env, p, "synthetic-owner");
  await Promise.all([startNativeGrant(env, p), startNativeGrant(env, p)]);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      reserveNativeRequest(env, p, "concurrent-" + i),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await readNativeGrant(env, p)).requests_used, 1);
  const id = "concurrent-" + results.indexOf(true);
  await Promise.all([
    finishNativeRequest(env, id, false),
    finishNativeRequest(env, id, false),
  ]);
  assert.equal((await readNativeGrant(env, p)).lease_id, null);
  assert.equal(await reserveNativeRequest(env, p, id), false);
  const next = await verify(
    (
      await issue(
        { u: p.u, c: p.c, p: p.p, native_trial: true },
        24,
        TEST_SECRET,
      )
    ).token,
    TEST_SECRET,
  );
  await createNativeGrant(env, next, "synthetic-owner");
  assert.equal(await readNativeGrant(env, p), null);
  assert.equal((await readNativeGrant(env, next)).requests_used, 1);
  console.log(
    "PASS actual local workerd/D1: migration twice, concurrent activation, eight atomic reservations, failed settlement, duplicate prevention, reissue preserves allowance",
  );
} finally {
  await mf.dispose();
}
