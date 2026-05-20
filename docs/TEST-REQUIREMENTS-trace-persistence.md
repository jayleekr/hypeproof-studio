# Test requirements — #9 trace persistence

Living spec for what the trace surface (D1 schema + R2 + `/v1/trace/event` +
chat.ts hook + security helpers) must be tested for. **Implemented** =
covered in `worker/test/smoke.mjs` today. **Pending** = a real gap to close.

Scope is the cumulative #9 stack on `main` (PRs #29, #30, #31, #32). The
score module is out of scope; this file covers only the persistence layer
it depends on.

## Conventions
- Test framework: the existing `worker/test/smoke.mjs` (node
  `--experimental-strip-types`, scripted hooks for `.html`/`.md` text
  imports). Mock D1/R2/KV via inline objects — no live bindings.
- Each test case must (a) be deterministic, (b) clean up its own state,
  (c) cite the test family below in its `console.log("✓ …")` line.

---

## 1. Unit — `worker/src/lib/storage.ts`

### 1.1 `newId()` and `turnBodyKey()`
- [x] returns a v4 uuid (regex match)
- [x] `turnBodyKey("t-1", 3)` === `"turns/t-1/3.json"`

### 1.2 D1 insert shapes (mock `prepare().bind().run()`)
- [x] `createTrial` binds `[id, session_id, cohort_id, user_id, profile_id, task_label]`,
  defaults `task_label` to `null`
- [x] `endTrial` runs an `UPDATE trials SET ended_at` with `[trial_id]`
- [x] `recordTurn(persistBody=false)` writes no R2, binds `body_ref = null`
- [x] `recordTurn(persistBody=true, body=…)` writes the JSON body to
  `turns/{trial_id}/{turn_idx}.json` with `application/json` metadata; D1
  binds `body_ref = <that key>`
- [x] `recordValidation` defaults `turn_id` to `null`, `errors_found/fixed` to `0`
- [x] `recordHumanAction` defaults `turn_id` to `null`, binds `kind` and
  nullable `diff_chars`

### 1.3 Security helpers (#9d)
- [x] `isUuid` — accepts v4 UUID; rejects bare strings, path traversal
  (`../etc/passwd`), 36+ chars, empty
- [x] `verifyTrialOwnership` — true on (correct user, correct cohort);
  false on wrong user / wrong cohort / missing trial; short-circuits
  without DB read on non-UUID input
- [x] `recordTurnIfOwned` — owned → `INSERT INTO turns` fires; not owned
  → silent skip (returns false, no INSERT)

### 1.4 chat-hook helpers (#9c)
- [x] `extractTrialHeaders` — both headers required; non-numeric /
  negative / `turn_idx > 9999` rejected; non-UUID `trial_id` rejected
  (path-traversal defense); oversized id rejected; valid pair parsed
- [x] `lastUserMessageText` — `""` on malformed / null / no-user-yet;
  picks the **last** user message when multiple; concatenates `text`
  parts when `content` is an array (OpenAI vision-style)

---

## 2. Integration — `POST /v1/trace/event`

Drives the real `trace` Hono router via `trace.fetch(req, env, ctx)` with
a mocked env (KV/D1/R2) and a real signed token issued via `issue()`.

### 2.1 Auth gates
- [x] 401 — missing bearer token
- [x] 401 — malformed / unsignable token
- [ ] 401 — token-cohort vs profile-cohort mismatch  *(pending — exercised
  in chat.ts smoke today, not yet replicated for trace)*
- [x] 403 — no active session for the cohort
- [x] 403 — empty roster (user not registered)
- [ ] 403 — session window closed (`isSessionLive` false)  *(pending)*
- [ ] 403 — session profile_id ≠ token profile  *(pending)*

### 2.2 Payload validation (`parseEvent`)
- [x] 400 — unknown event `type`
- [x] 400 — `validationRun` outcome not in {pass,fail,partial,error}
- [x] 400 — `humanAction` kind not in {accept,reject,edit,replace}
- [x] 400 — `trial_id` not a UUID (any non-create event)
- [x] 400 — `turn_id` provided but not a UUID
- [x] 400 — `trialStart.task_label` > 256 chars
- [x] 413 — body exceeds 8 KB cap

### 2.3 Ownership (#9d F#1 / F#2)
- [x] 403 — `humanAction` against a `trial_id` not in this user's trials
  (with `type: "trial_ownership"`)
- [x] 403 — cohort mismatch (trial owned by another cohort)
- [x] 200 — owned trial: ownership SELECT happens **before** the INSERT;
  `INSERT INTO human_actions` fired (fire-and-forget)
- [ ] 403 — `validationRun` ownership failure  *(pending — currently
  covered only via `humanAction`; both share the dispatch path, low risk)*
- [ ] 403 — `trialEnd` ownership failure  *(pending — same)*

### 2.4 Happy paths
- [x] 200 `trialStart` — returns `{ ok: true, trial_id: <uuid> }`; `INSERT
  INTO trials` recorded
- [ ] 200 `trialEnd` — `UPDATE trials SET ended_at` fired in waitUntil
  *(pending — currently only `humanAction` exercises the dispatch tail)*
- [ ] 200 `validationRun` — `INSERT INTO validations` fired  *(pending)*

---

## 3. Hot-path regression — `chat.ts` hook (#9c)

These are integration tests against the full `chat` router; they require
mocking the upstream LLM via `globalThis.fetch` (mirror the
`callGeminiResilient` pattern at smoke.mjs:223).

- [ ] **Latency unchanged when no trial headers** — request without
  `x-hps-trial-id` produces a response identical (status, headers, body)
  to today's behavior; no `recordTurn*` calls observed.  *(pending)*
- [ ] **Non-stream + valid trial headers** — response succeeds; `waitUntil`
  fires `recordTurnIfOwned` with `prompt_chars = lastUserPromptText.length`,
  `response_chars = text.length`, and (if `log_user_messages=true`) writes
  the body to R2.  *(pending)*
- [ ] **Stream + valid trial headers** — `onUsage` (synthetic) triggers
  `recordTurnIfOwned` with `response_chars = 0`, no R2 body, model label
  matches.  *(pending)*
- [ ] **Fail-soft** — recordTurn rejects (mock D1 throws); chat response
  still completes normally; error logged to `console.error`, not surfaced
  to client.  *(pending)*
- [ ] **Ownership skip** — trial header present but ownership SELECT
  returns null → recordTurn is **not** called; chat response unaffected.
  *(pending)*

> The lack of these tests is logged in #33 (review item A#11) — they
> require booting the chat Hono with a substantial mocked env. Helper
> unit tests (#9c) cover the boundary correctly; this gap is a
> regression-confidence ceiling, not a correctness gap today.

---

## 4. Consent gating (children's-data invariant)

The single, load-bearing safety property: kids' messages MUST NOT reach R2
unless the cohort profile explicitly opts in via
`profile.analytics.log_user_messages = true`.

- [x] `recordTurn(persistBody=false)` makes zero R2 writes (unit, mocked R2)
- [x] `recordTurn(persistBody=true)` writes exactly one R2 object at the
  canonical key
- [ ] **Profile snapshot test** — every profile registered in
  `worker/src/profiles/index.ts` is asserted to have
  `analytics.log_user_messages === false` unless an allowlist (currently
  empty) opts the cohort in. Catches a regression where a future profile
  accidentally enables body persistence.  *(pending — add a registry-iter
  test)*
- [ ] **Chat.ts gate wired** — non-stream path with
  `log_user_messages=false` calls `recordTurnIfOwned({})` (no body); with
  `log_user_messages=true` calls `recordTurnIfOwned({persistBody:true, body:…})`.
  *(pending — see §3 fail-soft test)*

---

## 5. Idempotency (review A#2 fix)

- [ ] `recordTurn` called twice with same `(trial_id, turn_idx)` and
  differing dynamic fields → the latest call's values are persisted (test
  via two mock dbCalls, then assert the second `bind(...)` shape; with a
  real D1 in `wrangler dev`, assert via SELECT post-write).  *(pending —
  smoke can verify the SQL contains `ON CONFLICT (trial_id, turn_idx)`)*
- [ ] `body_ref` preserved when the second call has no body (COALESCE
  semantics).  *(pending — same)*

---

## 6. Cost / DoS guards (review F#6 — open, see #33)

Not implementable in unit tests today (requires a rate-limit layer that
doesn't exist yet). Listed here so the test file lands alongside the
implementation:

- [ ] Per-(cohort,user,session) cap on `trialStart` writes
- [ ] Per-`trial_id` cap on `validationRun` + `humanAction` events
- [ ] Soft KV-counter rate limit on `/v1/trace/event`

---

## Implementation order (for the pending items)

1. §2.4 happy paths (`trialEnd`, `validationRun`) — completes endpoint
   dispatch coverage; ~30 lines in smoke.mjs.
2. §4 profile-snapshot test — closes the kids-data invariant; ~15 lines.
3. §5 idempotency SQL assertion — protects the ON CONFLICT behaviour;
   ~10 lines.
4. §3 chat.ts integration suite — the genuine ceiling, needs mocked
   upstream fetch. Land as a single new block in smoke.mjs once a real
   regression argues for it; otherwise leave as A#11 in #33.
5. §2.1 / §2.3 pending auth + ownership edge cases — small, low-risk;
   land alongside (1).
6. §6 cost guards — only after the rate-limit code lands.

Today's coverage answers most of `#9`'s real risk surface (security,
schema correctness, R2 gating). The remaining gaps are convenience and
regression-confidence, not correctness.
