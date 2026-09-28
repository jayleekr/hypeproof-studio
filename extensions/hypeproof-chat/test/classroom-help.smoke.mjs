// #751 native help — the device-side decisions (src/classroomHelp.ts) under plain Node, with positive and negative controls.
import assert from "node:assert/strict";
import * as H from "../src/classroomHelp.ts";

const tok = (o) => Buffer.from(JSON.stringify(o)).toString("base64url") + ".sig";
const conn = { grant_id: "grant-1", class_run_id: "run-a", seat_id: "A1", student: { u: "learner-1", c: "cohort-x", p: "profile-y" } };
const me = tok({ u: "learner-1", c: "cohort-x", p: "profile-y" });
let n = 0; const ok = (name) => { n++; console.log("PASS " + name); };

// binding: the token's learner must be the connection's learner
const b = H.bindingOf(me, conn);
assert.deepEqual(b, { u: "learner-1", c: "cohort-x", p: "profile-y", run: "run-a", grant: "grant-1", seat: "A1" });
assert.equal(H.bindingOf(tok({ u: "learner-2", c: "cohort-x", p: "profile-y" }), conn), null, "another learner signed in → no binding");
assert.equal(H.bindingOf(tok({ u: "learner-1", c: "cohort-x", p: "other" }), conn), null, "another profile → no binding");
assert.equal(H.bindingOf(me, null), null); assert.equal(H.bindingOf("garbage", conn), null);
assert.deepEqual(H.tokenLearner(tok({ u: "학생", c: "c", p: "p" })), { u: "학생", c: "c", p: "p" }, "UTF-8 ids decode");
ok("binding requires the same learner in the token and the live connection");

// keys: drafts per learner-in-class, envelopes additionally per connection
assert.equal(H.draftKey(b), "cohort-x|profile-y|learner-1|run-a"); assert.equal(H.sendKey(b), "cohort-x|profile-y|learner-1|run-a|grant-1");
assert.notEqual(H.draftKey({ ...b, run: "run-b" }), H.draftKey(b)); assert.notEqual(H.sendKey({ ...b, grant: "grant-2" }), H.sendKey(b));
ok("a draft never crosses learner or class; a prepared request never crosses a connection");

// content: own question alone; a turn only when picked; exact, trimmed, clamped
assert.deepEqual(H.buildContent("  막혔어요  ", null), { content: { question: "막혔어요" }, truncated: [] });
assert.deepEqual(H.buildContent("", null).content, {}, "nothing selected → nothing to send");
const history = [
  { id: "u0", role: "user", content: "수업 전 질문", createdAt: 500 },
  { id: "u1", role: "user", content: "버튼 만들어 줘", createdAt: 1000 }, { id: "t1", role: "tool", content: "🔧 Write(index.html)", createdAt: 1001 }, { id: "a1", role: "assistant", content: "만들었어요", createdAt: 1002 }, { id: "a1b", role: "assistant", content: "확인해 보세요", createdAt: 1003 },
  { id: "u2", role: "user", content: "색 바꿔 줘", createdAt: 2000 }, { id: "a2", role: "assistant", content: "바꿨어요", createdAt: 2001 },
];
assert.deepEqual(H.turnsOf(history, 900).map((t) => t.id), ["u2", "u1"], "only this class's learner messages, newest first");
assert.deepEqual(H.turnContent(history, "u1", 900), { prompt: "버튼 만들어 줘", response: "만들었어요\n\n확인해 보세요" }, "tool lines are not attached");
assert.equal(H.turnContent(history, "u0", 900), null, "a turn from before the class cannot be picked"); assert.equal(H.turnContent(history, "a1", 900), null, "an AI message is not a turn id");
assert.equal(H.turnsSince({ connected_at: 900, run: { starts_at: 100 } }), 900, "only messages since this window's connection");
assert.equal(H.turnsSince({ connected_at: 50, run: { starts_at: 100 } }), 100, "and never from before the class");
assert.equal(H.turnsSince({ run: { starts_at: 100 } }), Infinity, "unknown connection time → no turn is offered");
assert.deepEqual(H.turnsOf(history, H.turnsSince(null)), [], "no connection → nothing offered");
const long = H.buildContent("q", { prompt: "p", response: "x".repeat(9000) }); assert.equal(long.content.response.length, 8000); assert.deepEqual(long.truncated, ["response"]);
ok("the learner's own question can go alone; a picked turn is its message + the AI answer; long text is clamped and said so");

// envelope + sendability
const K = { request_id: "req-1", duration_minutes: 60, expires_at: 1_003_000, proof: "p".repeat(43) };
const A = { recipient_id: "teacher-a", class_run_id: "run-a", seat_id: "A1", grant_id: "grant-1", class_ends_at: "2026-09-22T12:00:00Z", expires_cap: 2_000_000, consent: K };
const draft = { question: "q", turnId: null, duration: 60, updated_at: 0 }, now = 1_000_000_000;
const e = H.makeEnvelope({ binding: b, assignment: A, draft, content: { question: "q" }, truncated: [], now, id: "req-1" });
assert.deepEqual([e.consent_expires_at, e.consent_proof, e.state], [1_003_000, K.proof, "prepared"], "the end shown is the Service-signed one, not now + duration on this device");
assert.deepEqual(H.requestBody(e), { id: "req-1", recipient_id: "teacher-a", kind: "help", consent: true, duration_minutes: 60, class_run_id: "run-a", grant_id: "grant-1", content: { question: "q" }, consent_envelope: { expires_at: 1_003_000, proof: K.proof } });
// negative controls: no signed end, or one signed for another id or duration → nothing to consent to
assert.equal(H.makeEnvelope({ binding: b, assignment: { ...A, consent: undefined }, draft, content: { question: "q" }, truncated: [], now, id: "req-1" }), null);
assert.equal(H.makeEnvelope({ binding: b, assignment: A, draft, content: { question: "q" }, truncated: [], now, id: "req-2" }), null, "a signature for another request id");
assert.equal(H.makeEnvelope({ binding: b, assignment: A, draft: { ...draft, duration: 30 }, content: { question: "q" }, truncated: [], now, id: "req-1" }), null, "a signature for another duration");
assert.equal(H.helpDuration(999), 30, "an unknown duration falls back to the shortest");
assert.equal(H.sendable(e, b, A, now + 1), "ok");
assert.equal(H.sendable(e, { ...b, u: "learner-2" }, A, now), "identity_changed");
assert.equal(H.sendable(e, { ...b, grant: "grant-2" }, A, now), "connection_changed");
assert.equal(H.sendable(e, null, A, now), "identity_changed");
assert.equal(H.sendable(e, b, { ...A, class_run_id: "run-b" }, now), "class_changed");
assert.equal(H.sendable(e, b, { ...A, recipient_id: "teacher-b" }, now), "recipient_changed");
assert.equal(H.sendable(e, b, A, 1_003_000 * 1000 - 1), "ok", "positive control: just before the agreed end");
assert.equal(H.sendable(e, b, A, 1_003_000 * 1000), "stale", "a request is not sent at or after the end the learner agreed to");
assert.equal(H.sendable({ ...e, consent_proof: undefined, consent_expires_at: undefined }, b, A, now), "stale", "an envelope stored before signed ends has nothing sendable");
ok("an envelope is sendable only for the same learner, class, connection and recipient, within its time");

// POST outcomes
for (const [s, r, want] of [[201, undefined, "stored"], [200, undefined, "stored"], [0, undefined, "unknown"], [503, "unknown", "unknown"], [429, undefined, "unknown"], [409, "class_changed", "changed"], [409, "recipient_not_assigned", "changed"], [409, "request_id_conflict", "conflict"], [409, "consent_expired", "expired"], [400, "consent_invalid", "refused"], [403, "instructor_revoked", "changed"], [400, undefined, "refused"]]) assert.equal(H.classifyPost(s, r), want, `${s} ${r}`);
ok("only 200/201 means stored; a lost or 5xx answer is unknown, never sent");

// cards: answered ≠ resolved; feedback only after an answer; history split by stored class
const share = (id, session_id, status, extra = {}) => ({ id, session_id, status, revision: 2, recipient_id: "teacher-a", created_at: 1, expires_at: 2, content: { question: "q", prompt: "", response: "" }, feedback: "draft note", next_action: "next", ...extra });
assert.deepEqual([H.cardOf(share("s", "run-a", "reviewing")).feedback, H.cardOf(share("s", "run-a", "reviewing")).can_confirm], ["", false], "no feedback text is shown before the instructor answered");
const answered = H.cardOf(share("s", "run-a", "answered")); assert.deepEqual([answered.label, answered.can_confirm, answered.feedback], ["강사 답변 도착 · 내 확인 전", true, "draft note"]);
assert.deepEqual(answered.content.map((c) => c.field), ["question"], "empty fields are not drawn");
assert.equal(H.cardOf(share("s", "run-a", "resolved")).can_confirm, false);
const split = H.splitShares([share("new", "run-b", "received"), share("old", "run-a", "answered")], "run-b"); assert.deepEqual([split.current.map((c) => c.id), split.history.map((c) => c.id)], [["new"], ["old"]]);
ok("answered is not resolved; an earlier class's share is history, not this lesson's");

// local retention + draft normalisation
const store = { drafts: { keep: { question: "a", turnId: null, duration: 30, updated_at: 0 }, old: { question: "b", turnId: null, duration: 30, updated_at: 0 }, fresh: { question: "c", turnId: null, duration: 30, updated_at: now } }, envelopes: { "keep|grant-1": { ...e, prepared_at: 0 } } };
const pruned = H.prune(store, now + 1000, "keep"); assert.deepEqual(Object.keys(pruned.drafts).sort(), ["fresh", "keep"]); assert.deepEqual(Object.keys(pruned.envelopes), ["keep|grant-1"]);
assert.deepEqual(H.cleanDraft({ question: 5, turnId: "../x", duration: 45 }, 7), { question: "", turnId: null, duration: 30, updated_at: 7 });
assert.deepEqual(H.cleanDraft({ question: "그대로 ", turnId: "u1", duration: 120 }, 7), { question: "그대로 ", turnId: "u1", duration: 120, updated_at: 7 }, "typed text is kept exactly");
ok("drafts of others expire from the device; the current learner's are kept; malformed drafts become empty, not widened");

console.log(`${n} native help device checks passed`);
