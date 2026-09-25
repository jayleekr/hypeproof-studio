// #751 U3 — AT-45/46, the learner device's pure rules: importing a prompt into the draft, the turn preflight, what a
// refused turn becomes, and the inbox's handling of the two new kinds. Every rule is checked against a wrong
// implementation of itself (negative control): if the wrong one also passed, the check would prove nothing.
import assert from "node:assert/strict";
const D = await import("../webview-ui/src/draftImport.ts");
const L = await import("../src/lessonBinding.ts");
const I = await import("../src/classroomInbox.ts");
const S = await import("../../../worker/src/lib/classroom-distribution.ts");
const { validActivityDraft } = await import("../src/activityDraft.ts");
let n = 0; const ok = (name) => { n++; console.log("PASS " + name); };

// ── P2/P3: import appends to the CURRENT draft, never replaces, never exceeds; undo only while untouched ──
{
  const cases = [["", "본문", "본문"], ["내 글", "본문", "내 글\n\n본문"], ["내 글\n", "본문", "내 글\n\n본문"], ["내 글\n\n", "본문", "내 글\n\n본문"], ["  들여쓴 글  ", "본문", "  들여쓴 글  \n\n본문"]];
  const check = (impl) => cases.every(([draft, body, want]) => { const r = impl(draft, body); return r.ok && r.draft === want && r.draft.startsWith(draft); });
  assert.equal(check(D.importIntoDraft), true, "the learner's text is kept exactly as typed; the prompt goes after it");
  assert.equal(check((_d, body) => ({ ok: true, draft: body })), false, "NEGATIVE CONTROL: an implementation that REPLACES the draft fails the same cases");
  assert.equal(check((d, body) => ({ ok: true, draft: (d.trim() ? d.trim() + "\n\n" : "") + body })), false, "NEGATIVE CONTROL: one that 'tidies' the learner's text fails too");
  assert.deepEqual(D.importIntoDraft("x".repeat(D.DRAFT_MAX_CHARS - 3), "본문입니다"), { ok: false, reason: "too_long" }); assert.deepEqual(D.importIntoDraft("글", ""), { ok: false, reason: "empty" });
  // typed between drawing the card and pressing: ChatPanel applies importIntoDraft to the draft at application time
  const drawnWith = "처음 글", typedMeanwhile = "처음 글 그리고 방금 친 글"; assert.equal(D.importIntoDraft(typedMeanwhile, "본문").draft, "처음 글 그리고 방금 친 글\n\n본문"); assert.notEqual(D.importIntoDraft(drawnWith, "본문").draft, D.importIntoDraft(typedMeanwhile, "본문").draft);
  const last = { before: "내 글", after: "내 글\n\n본문", object_id: "o", revision: 1 };
  assert.equal(D.canUndoImport("내 글\n\n본문", last), true); assert.equal(D.canUndoImport("내 글\n\n본문!", last), false, "one keystroke later it is the learner's text"); assert.equal(D.canUndoImport("내 글", null), false);
  const refs = D.addImportRef(D.addImportRef([], { object_id: "obj-aaaaaaaa", revision: 1, hash16: "a".repeat(16) }), { object_id: "obj-aaaaaaaa", revision: 1, hash16: "a".repeat(16) }); assert.equal(refs.length, 1);
  assert.equal(D.addImportRef(Array.from({ length: 9 }, (_, i) => ({ object_id: "obj-" + i, revision: 1, hash16: "b".repeat(16) })), { object_id: "obj-new", revision: 2, hash16: "c".repeat(16) }).length, 8);
  assert.deepEqual(D.dropImportRef(refs, { object_id: "obj-aaaaaaaa", revision: 1 }), []);
  assert.equal(validActivityDraft({ text: "t", images: [], queued: null, imports: refs }), true); assert.equal(validActivityDraft({ text: "t", images: [], queued: null }), true, "older drafts stay valid");
  assert.equal(validActivityDraft({ text: "t", images: [], queued: null, imports: [{ object_id: "obj-aaaaaaaa", revision: 1, hash16: "a".repeat(16), body: "본문" }] }), false, "a reference carries no body");
  ok("prompt import: appends to the current draft, never replaces or tidies it, bounded, undo only while untouched, bodiless refs");
}

// ── the turn preflight: adopt a profile only when the Service serves exactly the switched binding ──
{
  const token = { key: "token:" + "a".repeat(16), seq: 0, source: "token", object_id: null, revision: null, enforced: true };
  const K2 = "2".repeat(32), sw = { state: "switched", key: K2, seq: 1, object_id: "obj-aaaaaaaa", revision: 1, content_hash: "h".repeat(64), lesson: { course_id: "c", version: "v2", sha256: "b".repeat(64) } };
  assert.deepEqual(L.planPreflight({ ...token, enforced: false }, sw, null), { action: "proceed" }, "no enforcement: nothing to do");
  assert.deepEqual(L.planPreflight(undefined, { state: "none" }, null), { action: "proceed" });
  assert.deepEqual(L.planPreflight(token, { state: "none" }, null), { action: "proceed" });
  assert.deepEqual(L.planPreflight(token, { state: "failed", reason: "network", final: false }, null), { action: "proceed" }, "a switch that failed leaves the turn exactly as it was");
  assert.deepEqual(L.planPreflight(token, sw, null), { action: "adopt", expectKey: K2, lessonSha: "b".repeat(64), confirm: true });
  assert.deepEqual(L.planPreflight({ ...token, key: K2 }, sw, null), { action: "proceed" }, "already on it (a replayed switch)");
  assert.deepEqual(L.planPreflight(token, { state: "failed", reason: "not_owner", final: false }, K2), { action: "adopt", expectKey: K2, lessonSha: null, confirm: false }, "another window of this learner switched");
  // Found on the real Mac run (2026-09-21): a profile cached BEFORE the Service enforced bindings made the app send no key,
  // never switch and never close a turn. It looks again only when its own inbox holds a setting — and never otherwise.
  assert.equal(L.shouldRecheckEnforcement(undefined, true), true, "cached before enforcement + a setting in the inbox: look again");
  assert.equal(L.shouldRecheckEnforcement({ ...token, enforced: false }, true), true);
  assert.equal(L.shouldRecheckEnforcement(undefined, false), false, "nothing was sent to this learner: no extra profile read, ever");
  assert.equal(L.shouldRecheckEnforcement(token, true), false, "already enforced: the ordinary preflight handles it");
  { const wrong = (cached) => !cached?.enforced; /* negative control: re-reading on EVERY turn of a non-enforcing Service */ assert.equal(wrong(undefined), true); assert.notEqual(wrong(undefined), L.shouldRecheckEnforcement(undefined, false), "the control is caught: it would cost every default-OFF turn a profile read"); }
  assert.deepEqual(L.planPreflight(token, { ...sw, lesson: "base" }, null).lessonSha, null);
  const plan = L.planPreflight(token, sw, null);
  assert.equal(L.candidateMatches(plan, { lesson_binding: { ...token, key: K2 }, lesson: { sha256: "b".repeat(64) } }), true);
  for (const c of [null, {}, { lesson_binding: token, lesson: { sha256: "b".repeat(64) } }, { lesson_binding: { ...token, key: K2 }, lesson: { sha256: "c".repeat(64) } }]) assert.equal(L.candidateMatches(plan, c), false, "not adopted: " + JSON.stringify(c));
  assert.equal(((p, c) => !!c)(plan, { lesson_binding: token }), true, "NEGATIVE CONTROL: 'any profile that came back' would adopt a profile of the OLD binding");
  const payload = (o) => Buffer.from(JSON.stringify(o)).toString("base64url") + ".sig";
  assert.equal(L.tokenLessonSha(payload({ u: "s", lesson: { course_id: "c", version: "v1", sha256: "a".repeat(64) } })), "a".repeat(64)); assert.equal(L.tokenLessonSha(payload({ u: "s" })), null); assert.equal(L.tokenLessonSha("garbage"), null);
  ok("preflight: a failed switch changes nothing; a profile is adopted only for the exact switched key and lesson hash");
}

// ── a refused turn ends from the Service's record, never from a guess, and is never re-sent ──
{
  assert.deepEqual(["not_started", "dispatched", "completed", "failed", "unknown", null].map(L.refusedTurnEnding), ["restore_input", "partial", "partial", "partial", "unknown", "unknown"]);
  assert.notEqual(((s) => (s === "completed" ? "partial" : "restore_input"))("dispatched"), L.refusedTurnEnding("dispatched"), "NEGATIVE CONTROL: 'restore unless it completed' would hand a partially executed turn back as if nothing ran");
  assert.match(L.REFUSAL_COPY.partial, /자동으로 다시 보내지 않습니다/); assert.match(L.REFUSAL_COPY.unknown, /자동으로 다시 보내지 않습니다/); assert.match(L.REFUSAL_COPY.restore_input, /그대로 돌려/);
  // observed on the pinned Agent SDK: a gateway 403 ends the turn at once as this text — the Service tags its message
  assert.equal(L.bindingRefusalCode(new Error("Claude Code returned an error result: Failed to authenticate. API Error: 403 수업 설정이 바뀌었습니다. 다시 보내 주세요. [hps:lesson_binding_changed]")), "lesson_binding_changed");
  assert.equal(L.bindingRefusalCode({ code: "lesson_turn_closed" }), "lesson_turn_closed"); assert.equal(L.bindingRefusalCode({ kind: "lesson_binding_unknown" }), "lesson_binding_unknown");
  for (const e of [new Error("API Error: 403 forbidden"), new Error("API Error: 401"), { code: "expired" }, null, new Error("[hps:something_else]")]) assert.equal(L.bindingRefusalCode(e), null, "an ordinary failure is not a binding refusal");
  const calls = []; const fetchImpl = (status, body) => async (url, init) => { calls.push([String(url), init?.method ?? "GET"]); return new Response(JSON.stringify(body), { status }); };
  assert.equal(await L.fetchTurnState({ proxyUrl: "https://svc.test/v1/", token: "t", turnId: "turn-1", fetchImpl: fetchImpl(200, { state: "not_started" }) }), "not_started"); assert.equal(calls[0][0], "https://svc.test/v1/lesson-turns/turn-1");
  assert.equal(await L.fetchTurnState({ proxyUrl: "https://svc.test/v1", token: "t", turnId: "t", fetchImpl: fetchImpl(503, {}) }), null); assert.equal(await L.fetchTurnState({ proxyUrl: "https://svc.test/v1", token: "t", turnId: "t", fetchImpl: fetchImpl(200, { state: "applied" }) }), null, "an unknown word is not a state");
  assert.equal(await L.fetchTurnState({ proxyUrl: "https://svc.test/v1", token: "t", turnId: "t", fetchImpl: async () => { throw new Error("offline"); } }), null);
  let tries = 0; assert.equal(await L.closeTurn({ proxyUrl: "https://svc.test/v1", token: "t", turnId: "t", outcome: "completed", sleep: async () => {}, fetchImpl: async () => { tries++; return tries < 3 ? new Response("{}", { status: 503 }) : new Response("{}", { status: 200 }); } }), true); assert.equal(tries, 3);
  tries = 0; assert.equal(await L.closeTurn({ proxyUrl: "https://svc.test/v1", token: "t", turnId: "t", outcome: "failed", sleep: async () => {}, fetchImpl: async () => { tries++; throw new Error("offline"); } }), false); assert.equal(tries, 3, "bounded: a turn nobody could close is bounded by the Service");
  ok("refused turn: restore only on the Service's 'nothing dispatched'; partial/unknown are never re-sent; the SDK's text form is recognised; close is bounded");
}

// ── inbox: the two new kinds, the setting state, and hash parity with the Service ──
{
  const base = { offer_key: "a".repeat(32), distribution_id: "dist-aaaaaaaa", seq: 1, object_id: "obj-aaaaaaaa", revision: 1, schema: I.CONTENT_SCHEMA, title: "제목", body: "본문", links: [], content_hash: "0".repeat(64), issued_at: 1, expires_at: 2, apply_within_ms: 1000 };
  const ref = { course_id: "course", version: "m2026.09.18-2", sha256: "b".repeat(64) };
  assert.equal(I.validateItem({ ...base, kind: "prompt" }).ok, true); assert.equal(I.validateItem({ ...base, kind: "prompt", links: [{ label: "a", url: "https://x.example.org/" }] }).ok, false); assert.equal(I.validateItem({ ...base, kind: "prompt", lesson: ref }).ok, false);
  assert.deepEqual(I.validateItem({ ...base, kind: "setting", lesson: ref }).value.lesson, ref); assert.equal(I.validateItem({ ...base, kind: "setting", lesson: "base" }).value.lesson, "base");
  for (const bad of [{ kind: "setting" }, { kind: "setting", lesson: { ...ref, tools: ["Bash"] } }, { kind: "setting", lesson: { ...ref, sha256: "short" } }, { kind: "notice", lesson: ref }]) assert.equal(I.validateItem({ ...base, ...bad }).ok, false, JSON.stringify(bad));
  assert.deepEqual(I.validateItem({ ...base, kind: "video" }), { ok: false, code: "unsupported_kind" });
  for (const c of [{ kind: "notice", title: "제목", body: "본문", links: [] }, { kind: "prompt", title: "제목", body: "본문", links: [] }, { kind: "setting", title: "제목", body: "본문", links: [], lesson: ref }, { kind: "setting", title: "제목", body: "본문", links: [], lesson: "base" }]) assert.equal(I.contentCanonical(c), S.contentCanonical(c), "device and Service hash the same bytes: " + c.kind);
  assert.deepEqual([S.KIND_CLIENT_CAPABILITY.prompt, S.KIND_CLIENT_CAPABILITY.setting], [I.INBOX_PROMPT_CAPABILITY, I.LESSON_BINDING_CAPABILITY]);
  const item = I.validateItem({ ...base, kind: "setting", lesson: ref }).value;
  let index = I.applyOffer(I.emptyIndex(), item, "rev.json", 10, 100);
  assert.deepEqual(I.pendingSetting(index), { state: "pending", offer_key: item.offer_key, distribution_id: item.distribution_id, content_hash: item.content_hash, lesson: ref, object_id: item.object_id, revision: 1 }, "arrival is PENDING — never switched on arrival"); assert.equal(I.boundSetting(index), null);
  index = I.markSettingBound(index, { object_id: item.object_id, revision: 1, content_hash: item.content_hash, key: "k".repeat(32), seq: 1 }); assert.equal(I.pendingSetting(index), null); assert.deepEqual(I.boundSetting(index), { key: "k".repeat(32), seq: 1 });
  const again = I.applyOffer(index, { ...item, offer_key: "c".repeat(32) }, "rev.json", 10, 200); assert.equal(again.objects[item.object_id].setting.state, "bound", "a re-offer of the bound revision (new login generation) stays bound"); assert.equal(again.objects[item.object_id].setting.offer_key, "c".repeat(32));
  const v2 = I.applyOffer(index, { ...item, revision: 2, seq: 2, content_hash: "1".repeat(64), offer_key: "d".repeat(32) }, "rev2.json", 10, 300); assert.equal(I.pendingSetting(v2).revision, 2, "a newer revision is pending again");
  assert.equal(I.markSettingBound(v2, { object_id: item.object_id, revision: 1, content_hash: item.content_hash, key: "z".repeat(32), seq: 9 }), v2, "a late confirmation of the OLD revision marks nothing");
  const gone = I.applyWithdraw(index, { withdraw_key: "w".repeat(32), object_id: item.object_id, seq: 5, revision: 1, reason: "revoked" }, 400); assert.equal(I.pendingSetting(gone), null); assert.equal(I.boundSetting(gone), null, "a withdrawn card carries no binding note (the Service's binding is NOT undone by this)");
  ok("inbox: prompt and setting kinds validate strictly, hash exactly as the Service does, and a setting is pending until this device switched");
}
console.log(`\n${n} passed`);
