// cr-publish (#1393) — a local Service for the Publish for User Test routes. Synthetic
// identities and SQLite (schema.sql, which carries migration 0032) or a passed local
// workerd D1 binding; an in-memory R2 with the conditional put the participant record uses.
// The real Service router (src/index.ts) answers every request, the test origin included.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from "./index.mjs";

export const CR_PROFILE = "canary-sdk-contract";
export const OTHER_PROFILE = "homepage-practice-s1";
export const TEST_ORIGIN = "http://{project}.test.invalid:8799";

export function sqliteBinding(db) {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          return stmt;
        },
        async first() {
          return db.prepare(sql).get(...args) ?? null;
        },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async all() {
          return { success: true, results: db.prepare(sql).all(...args) };
        },
      };
      return stmt;
    },
  };
}

/** In-memory R2 with `onlyIf: { etagDoesNotMatch: "*" }` (put only when absent → null otherwise). */
export function memoryR2() {
  const map = new Map();
  const toBytes = (v) => (v instanceof Uint8Array ? new Uint8Array(v) : v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new TextEncoder().encode(String(v)));
  return {
    map,
    async get(key) {
      const v = map.get(key);
      if (!v) return null;
      return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), text: async () => new TextDecoder().decode(v) };
    },
    async put(key, value, options) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && map.has(key)) return null;
      map.set(key, toBytes(value));
      return { key };
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...map.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false };
    },
  };
}

export async function localCurriculum({ switchOn = true, testOrigin = TEST_ORIGIN, binding, environment = "development" } = {}) {
  const app = await bootApp();
  const { getProfile } = await import("../../src/profiles/index.ts");
  const { issue, issueIssuer } = await import("../../src/lib/tokens.ts");
  const { setRoster } = await import("../../src/lib/kv.ts");
  const profile = getProfile(CR_PROFILE);
  const other = getProfile(OTHER_PROFILE);
  const original = { profile: profile.curriculum_runtime, other: other.curriculum_runtime };
  const setSwitch = (on, p = profile) => {
    p.curriculum_runtime = { enabled: on };
  };
  setSwitch(switchOn);
  setSwitch(switchOn, other);
  let db = null;
  if (!binding) {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  }
  const r2 = memoryR2();
  const env = createMockEnv({
    withSession: false,
    withRoster: false,
    environment,
    env: { HPS_DB: binding ?? sqliteBinding(db), HPS_TRACES: r2, ...(testOrigin ? { HPS_TEST_ORIGIN: testOrigin } : {}) },
  });
  const cohort = profile.session.cohort_id;
  const otherCohort = other.session.cohort_id;
  await setRoster(env.HPS_KV, cohort, ["cr-a", "cr-b", "cr-c"]);
  await setRoster(env.HPS_KV, otherCohort, ["hp-a"]);
  const student = async (u = "cr-a", p = profile.id, c = cohort) => (await issue({ u, c, p }, 2, TEST_SECRET)).token;
  const issuer = async (c = cohort, p = profile.id) => (await issueIssuer({ issuer: "director-a", scopes: [{ cohort: c, profiles: [p] }] }, 2, TEST_SECRET)).token;

  async function raw(url, { method = "GET", token, body, headers = {} } = {}) {
    const init = { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await app.fetch(new Request(url, init), env, makeCtx());
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, bytes, json };
  }
  const api = (path, opts) => raw("https://service.test" + path, opts);

  /** A published file set the way the App sends it: sorted list, R4 digest, base64 bytes. */
  async function fileSet(files, entry = "index.html") {
    const { digestOf } = await import("../../src/lib/measurement-core/local-record.ts");
    const out = Object.entries(files).map(([path, content]) => {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, data: bytes.toString("base64") };
    });
    const list = out.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { id: await digestOf(list), body: { entry_html: entry, files: out } };
  }
  async function upload(projectId, files, token, extra = {}) {
    const set = await fileSet(files, extra.entry ?? "index.html");
    const r = await api(`/v1/curriculum/projects/${projectId}/versions/${encodeURIComponent(extra.digest ?? set.id)}`, { method: "PUT", token, body: { ...set.body, ...(extra.body ?? {}) } });
    return { ...r, id: set.id };
  }
  /** GET on the test origin of a share URL (the Request carries the share URL's host). */
  const open = (url, opts = {}) => raw(url, opts);

  const restore = () => {
    if (original.profile === undefined) delete profile.curriculum_runtime;
    else profile.curriculum_runtime = original.profile;
    if (original.other === undefined) delete other.curriculum_runtime;
    else other.curriculum_runtime = original.other;
  };
  return { app, env, db, r2, profile, other, cohort, otherCohort, student, issuer, api, raw, open, fileSet, upload, setSwitch, close: () => { restore(); db?.close(); } };
}
