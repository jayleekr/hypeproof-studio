// #751 native help — the REAL host adapter (src/classroomHelpHost.ts, bundled with esbuild, `vscode` stubbed) against a
// synthetic Service and a storage model of VS Code's extension globalState. Only fetch, the Memento and the window's
// token/connection are synthetic; every decision is the shipped code's.
//
// Storage model (VS Code extHostMemento ExtensionGlobalMemento): `get` reads this window's cache; `update(k, v)` sets the key
// in that cache at once and writes the WHOLE object of the extension to shared storage, which then replaces the cache of every
// other window (`propagation` ms later; 0 = the same tick). A window that writes from a stale copy overwrites the others.
//
// What must hold (ADM-05 native help, AT-47):
//   F1   no draw posted after a newer draw or after the learner/connection changed carries the earlier learner's data or notes
//   F1b  a preview / send / confirm / withdraw answer that returns after a swap is never shown to whoever is there now
//   W    a window's write never erases another window's or another learner's draft/envelope read before an await, and an
//        envelope reaches `sending`/`unknown` (and a POST leaves) only for the request id the learner consented to
//   N    "강사에게 보냈습니다" is not kept next to the instructor's answer
// Controls: the normal single-learner flow and an inverted pair of reads for the same learner still draw correctly.
// HELP_HOST_SRC / HELP_SRC point the same checks at another revision (used to record the before-fix failures).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), ext = path.resolve(here, "..");
const require = createRequire(path.join(ext, "package.json"));
const { build } = require("esbuild");
const hostSrc = process.env.HELP_HOST_SRC ?? path.join(ext, "src/classroomHelpHost.ts");
const bundle = (await build({ entryPoints: [hostSrc], bundle: true, platform: "node", format: "cjs", write: false, external: ["vscode"] })).outputFiles[0].text;
const H = await import(process.env.HELP_SRC ?? path.join(ext, "src/classroomHelp.ts"));
const mod = { exports: {} };
let fetchImpl = null;
vm.runInNewContext(bundle, { module: mod, exports: mod.exports, require: (id) => (id === "vscode" ? {} : require(id)), fetch: (...a) => fetchImpl(...a), AbortSignal, Date, console, atob, TextDecoder, Uint8Array, setTimeout, clearTimeout, Response, URL });
const { ClassroomHelpHost } = mod.exports;
const STORE = "hypeproof.classroomHelp.v1";

// ── synthetic Service ─────────────────────────────────────────────────────────────────────────────────────────────────────
const tok = (u) => Buffer.from(JSON.stringify({ u, c: "cohort", p: "profile" })).toString("base64url") + ".sig";
const learnerOf = (init) => JSON.parse(Buffer.from(init.headers.authorization.slice(7).split(".")[0], "base64url")).u;
function service() {
  const S = { shares: new Map(), posts: [], holds: [] };
  S.hold = (pred) => { let release, entered; const e = new Promise((r) => (entered = r)); const gate = new Promise((r) => (release = r)); const h = { pred, entered: e, release: (v) => release(v), gate, hit: entered }; S.holds.push(h); return h; };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  S.fetch = async (url, init = {}) => {
    const u = new URL(url), who = learnerOf(init), method = init.method ?? "GET", rest = u.pathname.replace(/^.*\/classroom\//, "");
    const h = S.holds.find((x) => x.pred(rest + u.search, method, who)); let override;
    if (h) { S.holds.splice(S.holds.indexOf(h), 1); h.hit(); override = await h.gate; }
    if (override) return json(override.status, override.body ?? {});
    if (rest === "help-recipient") {
      const a = { available: true, recipient_id: "teacher-a", class_run_id: "run", seat_id: "A1", grant_id: "grant-" + who, class_ends_at: "2099-01-01T00:00:00Z", expires_cap: 4_000_000_000 };
      const id = u.searchParams.get("request_id"), d = Number(u.searchParams.get("duration_minutes"));
      return json(200, id ? { ...a, consent: { request_id: id, duration_minutes: d, expires_at: Math.floor(Date.now() / 1000) + d * 60, proof: "p".repeat(43) } } : a);
    }
    if (rest.startsWith("shares") && method === "GET") return json(200, { shares: [...S.shares.values()].filter((s) => s.owner === who).map(({ owner, ...s }) => s) });
    if (rest === "shares" && method === "POST") {
      const b = JSON.parse(init.body); S.posts.push({ who, id: b.id });
      if (S.shares.has(b.id)) return json(200, S.shares.get(b.id));
      const s = { id: b.id, owner: who, session_id: "run", status: "received", revision: 1, recipient_id: "teacher-a", created_at: 1, expires_at: 4_000_000_000, content: b.content, feedback: "", next_action: "" };
      S.shares.set(b.id, s); return json(201, s);
    }
    const m = /^shares\/([^/]+)(\/confirm)?$/.exec(rest);
    if (m && method === "POST" && m[2]) { const s = S.shares.get(m[1]); if (!s || s.status !== "answered") return json(409, {}); s.status = "resolved"; s.revision++; return json(200, s); }
    if (m && method === "DELETE") return S.shares.delete(m[1]) ? json(200, { withdrawn: true }) : json(404, {});
    return json(404, {});
  };
  S.answer = (id, feedback) => { const s = S.shares.get(id); s.status = "answered"; s.revision++; s.feedback = feedback; s.next_action = "NEXT"; };
  return S;
}

// ── storage model + windows ───────────────────────────────────────────────────────────────────────────────────────────────
function sharedStorage(propagation = 0) {
  const shared = { value: {}, windows: [] };
  shared.window = () => {
    const w = { cache: structuredClone(shared.value), pause: null };
    w.memento = {
      get: (k) => structuredClone(w.cache[k]),
      keys: () => Object.keys(w.cache),
      update: async (k, v) => {
        w.cache[k] = structuredClone(v); const snap = structuredClone(w.cache);
        const apply = () => { shared.value = snap; for (const o of shared.windows) if (o !== w) o.cache = structuredClone(snap); };
        if (propagation) setTimeout(apply, propagation); else apply();
        if (w.pause) { const p = w.pause; w.pause = null; p.hit(); await p.gate; }
      },
    };
    shared.windows.push(w); return w;
  };
  return shared;
}
function win(shared, S, name, who) {
  const w = shared.window(), views = [];
  w.who = who; w.name = name;
  w.host = new ClassroomHelpHost(w.memento, {
    token: async () => tok(w.who()),
    connection: () => ({ grant_id: "grant-" + w.who(), class_run_id: "run", seat_id: "A1", connected_at: 1, student: { u: w.who(), c: "cohort", p: "profile" } }),
    base: () => "https://synthetic.invalid/v1", history: () => [], post: (v) => views.push(structuredClone(v)), log: () => {},
  });
  w.views = views; w.last = () => views.at(-1);
  w.pauseSave = () => { let gate, hit; const entered = new Promise((r) => (hit = r)); const g = new Promise((r) => (gate = r)); w.pause = { gate: g, hit }; return { entered, release: () => gate() }; };
  return w;
}
const dk = (u) => `cohort|profile|${u}|run`, sk = (u) => dk(u) + "|grant-" + u;
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const results = [];
async function check(id, what, fn) {
  const S = service(); fetchImpl = S.fetch;
  try { const detail = await fn(S); results.push({ id, what, status: "PASS", ...(detail ? { detail } : {}) }); console.log("PASS " + id + " " + what); }
  catch (err) { results.push({ id, what, status: "FAIL", error: String(err.message ?? err).slice(0, 600) }); console.log("FAIL " + id + " " + what + "\n     " + String(err.message ?? err).split("\n")[0]); }
}
/** After the first draw for `u` in this window, nothing drawn later may carry another learner's key, text or note. */
function noLeakAfter(w, u, forbidden) {
  const i = w.views.findIndex((v) => v.draft_key === dk(u)); assert.ok(i >= 0, "a draw for " + u + " exists");
  for (const v of w.views.slice(i)) {
    assert.equal(v.draft_key, dk(u), "a later draw is for " + u + ", got " + v.draft_key);
    const txt = JSON.stringify(v); for (const f of forbidden) assert.ok(!txt.includes(f), "a draw after the swap carries " + f + ": " + txt.slice(0, 300));
  }
}
const preview = async (w, u, q, duration = 30) => { await w.host.preview(dk(u), { question: q, turnId: null, duration }); const e = w.last().envelope; assert.ok(e && e.state === "prepared", "preview made"); return e; };

await check("C1", "control: one learner — preview, send, answer, confirm are drawn in order", async (S) => {
  const shared = sharedStorage(), w = win(shared, S, "W1", () => "a");
  await w.host.refresh(); assert.equal(w.last().draft_key, dk("a")); assert.equal(w.last().availability.state, "ready");
  const e = await preview(w, "a", "PRIVATE-A-Q");
  if ("consent_expires_at" in e) assert.ok(e.consent_expires_at > Date.now() / 1000, "the preview carries the Service's signed end");
  await w.host.send(dk("a"), e.request_id, true);
  assert.equal(w.last().envelope, null); assert.deepEqual(w.last().current.map((c) => c.status), ["received"]); assert.match(w.last().note ?? "", /강사에게 보냈습니다/);
  S.answer(e.request_id, "PRIVATE-A-FEEDBACK"); await w.host.refresh();
  assert.equal(w.last().current[0].feedback, "PRIVATE-A-FEEDBACK"); assert.equal(w.last().current[0].can_confirm, true);
  await w.host.confirm(dk("a"), e.request_id, w.last().current[0].revision);
  assert.equal(w.last().current[0].status, "resolved"); assert.match(w.last().note ?? "", /해결됐다고/);
});

await check("N1", "the sent note is gone once the instructor has answered (the answer and '보냈습니다' are never drawn together)", async (S) => {
  const shared = sharedStorage(), w = win(shared, S, "W1", () => "a");
  await w.host.refresh(); const e = await preview(w, "a", "q"); await w.host.send(dk("a"), e.request_id, true);
  assert.match(w.last().note ?? "", /강사에게 보냈습니다/, "positive control: right after sending the note is there");
  await w.host.refresh(); assert.match(w.last().note ?? "", /강사에게 보냈습니다/, "…and stays while the request is still unopened");
  S.answer(e.request_id, "FEEDBACK"); await w.host.refresh();
  assert.equal(w.last().current[0].status, "answered"); assert.equal(w.last().note, null, "note next to an answer: " + w.last().note);
});

await check("F1", "Codex repro: the reconciliation save of learner A finishes after B's draw — A's answer is not drawn again", async (S) => {
  let who = "a"; const shared = sharedStorage(), w = win(shared, S, "W1", () => who);
  S.shares.set("pending-a", { id: "pending-a", owner: "a", session_id: "run", status: "answered", revision: 2, recipient_id: "teacher-a", created_at: 1, expires_at: 4_000_000_000, content: { question: "PRIVATE-A-QUESTION" }, feedback: "PRIVATE-A-FEEDBACK", next_action: "PRIVATE-A-NEXT" });
  const seed = { drafts: { [dk("a")]: { question: "PRIVATE-A-QUESTION", turnId: null, duration: 30, updated_at: Date.now() } }, envelopes: { [sk("a")]: { request_id: "pending-a", draft_key: dk("a"), send_key: sk("a"), recipient_id: "teacher-a", class_run_id: "run", grant_id: "grant-a", seat_id: "A1", duration_minutes: 30, content: { question: "PRIVATE-A-QUESTION" }, prepared_at: Date.now(), expiry_estimate: Date.now() + 1800000, consent_expires_at: Math.floor(Date.now() / 1000) + 1800, consent_proof: "p".repeat(43), class_ends_at: "2099-01-01T00:00:00Z", state: "unknown", truncated: [] } } };
  await w.memento.update(STORE, seed);
  const p = w.pauseSave(), older = w.host.refresh(); await p.entered;
  who = "b"; await w.host.refresh(); assert.equal(w.last().draft_key, dk("b")); assert.equal(w.last().current.length, 0);
  p.release(); await older; await tick();
  noLeakAfter(w, "b", ["PRIVATE-A", dk("a")]);
  return { views: w.views.map((v) => ({ generation: v.generation, key: v.draft_key, feedback: v.current.map((c) => c.feedback) })) };
});

await check("F1-order", "control: two reads for the same learner answer in reverse order — only the newer draw is kept", async (S) => {
  const shared = sharedStorage(), w = win(shared, S, "W1", () => "a");
  await w.host.refresh(); const h = S.hold((rest, m) => rest.startsWith("shares?session_id") && m === "GET");
  const older = w.host.refresh(); await h.entered; S.shares.set("x", { id: "x", owner: "a", session_id: "run", status: "received", revision: 1, recipient_id: "teacher-a", created_at: 1, expires_at: 4_000_000_000, content: { question: "NEW" }, feedback: "", next_action: "" });
  await w.host.refresh(); const newest = w.last(); assert.equal(newest.current.length, 1);
  h.release({ status: 200, body: { shares: [] } }); await older;
  assert.equal(w.last().generation, newest.generation, "the older read was not drawn after the newer one");
  const folded = w.views.reduce((prev, v) => (H.acceptHelp ? H.acceptHelp(prev, v) : v), null); assert.equal(folded.generation, newest.generation);
  const inverted = [newest, { ...w.views[0], generation: newest.generation - 1 }].reduce((prev, v) => (H.acceptHelp ? H.acceptHelp(prev, v) : v), null);
  assert.equal(inverted.generation, newest.generation, "the webview keeps the newer draw if an older one arrives after it");
});

await check("F1-send", "a POST answer that returns after the swap: recorded for A only, never drawn or noted for B", async (S) => {
  let who = "a"; const shared = sharedStorage(), w = win(shared, S, "W1", () => who);
  await w.host.refresh(); const e = await preview(w, "a", "PRIVATE-A-Q");
  const h = S.hold((rest, m) => rest === "shares" && m === "POST"), sending = w.host.send(dk("a"), e.request_id, true); await h.entered;
  who = "b"; await w.host.refresh(); h.release(); await sending; await w.host.refresh(); await tick();
  noLeakAfter(w, "b", ["PRIVATE-A", "강사에게 보냈습니다", dk("a")]);
  const st = w.memento.get(STORE); assert.equal(st.envelopes[sk("a")], undefined, "A's own record says stored (envelope done)");
});

await check("F1-preview", "a preview whose recipient answer returns after the swap writes no envelope and shows nothing of A", async (S) => {
  let who = "a"; const shared = sharedStorage(), w = win(shared, S, "W1", () => who);
  await w.host.refresh(); const h = S.hold((rest) => rest.startsWith("help-recipient"));
  const pv = w.host.preview(dk("a"), { question: "PRIVATE-A-Q", turnId: null, duration: 30 }); await h.entered;
  who = "b"; await w.host.refresh(); h.release(); await pv; await tick();
  noLeakAfter(w, "b", ["PRIVATE-A", dk("a")]);
  assert.equal(w.memento.get(STORE)?.envelopes?.[sk("a")], undefined, "no preview was frozen for a learner who is no longer here");
});

await check("F1-actions", "confirm / withdraw answers that return after the swap are not noted to B", async (S) => {
  let who = "a"; const shared = sharedStorage(), w = win(shared, S, "W1", () => who);
  S.shares.set("s1", { id: "s1", owner: "a", session_id: "run", status: "answered", revision: 2, recipient_id: "teacher-a", created_at: 1, expires_at: 4_000_000_000, content: { question: "PRIVATE-A-Q1" }, feedback: "F", next_action: "N" });
  S.shares.set("s2", { id: "s2", owner: "a", session_id: "run", status: "received", revision: 1, recipient_id: "teacher-a", created_at: 1, expires_at: 4_000_000_000, content: { question: "PRIVATE-A-Q2" }, feedback: "", next_action: "" });
  await w.host.refresh();
  const h1 = S.hold((rest) => rest === "shares/s1/confirm"), c = w.host.confirm(dk("a"), "s1", 2); await h1.entered;
  who = "b"; await w.host.refresh(); h1.release(); await c;
  who = "a"; await w.host.refresh();
  const h2 = S.hold((rest, m) => rest === "shares/s2" && m === "DELETE"), d = w.host.withdraw(dk("a"), "s2"); await h2.entered;
  who = "b"; await w.host.refresh(); h2.release(); await d; await w.host.refresh(); await tick();
  const bViews = w.views.filter((v) => v.draft_key === dk("b"));
  for (const v of bViews) { assert.ok(!/해결됐다고|공유를 철회했습니다/.test(v.note ?? ""), "B was told A's result: " + v.note); assert.ok(!JSON.stringify(v).includes("PRIVATE-A")); }
  assert.equal(w.last().draft_key, dk("b"));
});

await check("W1", "two windows, two learners: a preview in window 1 that awaited the network does not erase learner B's draft written in window 2", async (S) => {
  const shared = sharedStorage(), w1 = win(shared, S, "W1", () => "a"), w2 = win(shared, S, "W2", () => "b");
  await w1.host.refresh(); await w2.host.refresh();
  const h = S.hold((rest, m, who) => rest.startsWith("help-recipient") && who === "a");
  const pv = w1.host.preview(dk("a"), { question: "A-Q", turnId: null, duration: 30 }); await h.entered;
  await w2.host.draft(dk("b"), { question: "PRIVATE-B-DRAFT", turnId: null, duration: 30 });
  h.release(); await pv; await tick();
  assert.equal(shared.value[STORE].drafts[dk("b")]?.question, "PRIVATE-B-DRAFT", "B's draft survived A's preview");
  assert.ok(shared.value[STORE].envelopes[sk("a")], "A's preview was still made");
});

await check("W2", "two windows, same learner: an envelope reaches sending/unknown, and a POST leaves, only for the request the learner consented to", async (S) => {
  const shared = sharedStorage(), w1 = win(shared, S, "W1", () => "a"), w2 = win(shared, S, "W2", () => "a"), consented = new Set();
  await w1.host.refresh(); await w2.host.refresh();
  const e1 = await preview(w1, "a", "FIRST"); consented.add(e1.request_id);
  const h = S.hold((rest, m) => rest === "shares" && m === "POST"), sending = w1.host.send(dk("a"), e1.request_id, true); await h.entered;
  await w2.host.preview(dk("a"), { question: "SECOND (never agreed)", turnId: null, duration: 30 });
  h.release({ status: 503, body: {} }); await sending; await tick();
  const env = shared.value[STORE].envelopes[sk("a")];
  assert.ok(env, "the request with the lost answer is still known"); assert.ok(consented.has(env.request_id) || env.state === "prepared", "an unconsented preview became " + env.state);
  await w2.host.refresh(); if (w2.last().envelope?.state === "unknown") await w2.host.retry(dk("a"));
  for (const p of S.posts) assert.ok(consented.has(p.id), "a POST left for a request nobody consented to: " + p.id);
  return { envelope_after: { id_is_consented: consented.has(env.request_id), state: env.state }, posts: S.posts.length };
});

await check("W3", "two windows, same learner, same draft: the text is last-write-wins, and a draft save never touches the pending request", async (S) => {
  const shared = sharedStorage(), w1 = win(shared, S, "W1", () => "a"), w2 = win(shared, S, "W2", () => "a");
  await w1.host.refresh(); await w2.host.refresh(); const e1 = await preview(w1, "a", "Q");
  const h = S.hold((rest, m) => rest === "shares" && m === "POST"), sending = w1.host.send(dk("a"), e1.request_id, true); await h.entered;
  h.release({ status: 0 }); await sending; // lost answer → unknown
  await w1.host.draft(dk("a"), { question: "typed in window 1", turnId: null, duration: 30 });
  await w2.host.draft(dk("a"), { question: "typed in window 2", turnId: null, duration: 60 });
  const st = shared.value[STORE]; assert.equal(st.drafts[dk("a")].question, "typed in window 2", "same draft: the later save wins (documented)");
  assert.deepEqual([st.envelopes[sk("a")]?.request_id, st.envelopes[sk("a")]?.state], [e1.request_id, "unknown"], "the unknown request and its consented content are untouched");
});

await check("W-residual", "characterisation (not a pass/fail gate): writes from two windows inside the storage propagation delay", async (S) => {
  const shared = sharedStorage(50), w1 = win(shared, S, "W1", () => "a"), w2 = win(shared, S, "W2", () => "b");
  await w1.host.draft(dk("a"), { question: "A", turnId: null, duration: 30 }); await w2.host.draft(dk("b"), { question: "B", turnId: null, duration: 30 });
  await new Promise((r) => setTimeout(r, 120)); const st = shared.value[STORE];
  return { propagation_ms: 50, a_kept: !!st.drafts[dk("a")], b_kept: !!st.drafts[dk("b")], note: "VS Code writes the extension's whole globalState object; two windows writing within the propagation delay are last-write-wins — the host cannot close this, it only never widens it past one tick." };
});

const failed = results.filter((r) => r.status === "FAIL");
if (process.env.HELP_HOST_OUT) writeFileSync(process.env.HELP_HOST_OUT, JSON.stringify({ host_source: path.relative(process.cwd(), hostSrc), results }, null, 2));
console.log(`${results.length - failed.length}/${results.length} native help host checks passed`);
process.exitCode = failed.length ? 1 : 0;
