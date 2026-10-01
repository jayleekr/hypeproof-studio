# Curriculum Runtime run record — `cr-evidence` (#1394)

Status: run record, 2026-10-02. Item `cr-evidence`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). Decisions and deviations: [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-evidence). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

## Claims

| | Rows | Why |
|---|---|---|
| Claimed | CR-23, CR-24, CR-25, CR-26, CR-27, CR-28, CR-65, CR-67, CR-69, CR-72, CR-74 | Every positive and negative control of their CR-T rows ran (below). CR-65: the event-schema half (CR-T23, CR-T60 schema) left by `cr-publish` ran here |
| Claimed, re-checked by `cr-gateway` | CR-70 | The admin sets team ceilings and cohort data controls; a non-admin is refused (CR-T65). Enforcing a team ceiling on calls is `cr-gateway`'s (CR-34), which re-checks CR-70 |
| Partial, remainder named | CR-02 | Evidence surfaces only: the Worker routes, the test-origin events route, the admin controls, the command and the five webview messages are off with the switch off and reachable with it on, in the Worker and in the app. CR-T02's `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1, as for the earlier items |

So the PR says `Refs #1394` unless the shipping agent treats CR-02 as the cross-item row `cr-e2e` closes.

## What was run

- Code: branch `feat/cr-evidence` off `origin/main` `efb27f40`; implementation commits `5734c43b`, `3bffa7c7`, `c008bd51`. The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15.7.4. Node 24.4.1. HypeProof Studio 0.1.51 copy with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked.
- Evidence classes (MC-38): **synthetic** = unit, smoke and worker layers (the real Service router over SQLite, or local workerd D1 and R2 with `--d1`); **synthetic (real browser)** = `e2e/curriculum-runtime/evidence-runtime.real.mjs`, Playwright's Chromium as a 390 × 844 phone against the real Service router over real HTTP; **live-host (app) / synthetic (Service, participants)** = `e2e/curriculum-runtime/evidence-app.spec.ts` in the Studio app with `app-service.mjs publish`, participants scripted through the published runtime.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (evidence surfaces) | worker `cr-evidence.test.mjs`, `cr-publish.test.mjs` (the router-wide walk now covers the six new routes), `cr-switch.test.mjs` (admin routes compared with an unknown admin path, with and without the admin credential); extension `cr-switch.smoke.mjs`; in-app `evidence-app.spec.ts` | PARTIAL (CR-02 partial) | Off: every evidence route with real ids and with no token answers exactly as an unknown route; the events route of a live link answers exactly as an unknown path of its origin; the admin controls answer as an unknown admin path; the command is absent from the palette in the app and no panel appears. On: all answer; the command is in the palette and opens the panel. Planted route and header variants are caught (existing instruments); M7 caught |
| CR-T23 | worker `cr-evidence.test.mjs` (both snippets run in a VM against the real Service); `evidence-runtime.real.mjs` | PASS | One scripted visit records session_start, page_view, click, task_start, task_complete, milestone (and input) under one random `ps-…` session and one `pp-…` pseudonym, `source_state` real, each event with project, experiment, version and channel, no identity key, a click without its element's text; a second page of the visit adds a page_view and no second session_start. In Chromium the same on the kiosk fixture. Negative: a name, e-mail or nested phone field → 400 `identity_field`; forged and other-link tokens → 403; a session not opened yet → 409; after revocation a still-valid token → 410, nothing written; in Chromium a planted page adding an e-mail field stores nothing; the instrument catches a planted identity key, a missing kind and a wrong attribution. Store inventory: no evidence/event/note/draft/session table, no new KV namespace or bucket; planted ones caught. M1, M8 caught |
| CR-T24 | worker `cr-evidence.test.mjs`; extension `cr-evidence.smoke.mjs` | PASS | An interview note with speaker, date and situation validates and round-trips Korean/English verbatim through the route; all five kinds validate (an external source with its locator). Negative: no provenance, a two-part provenance, no source state, an external source without a locator → refused by name; the one validator refuses the stored event with `source_state` removed; the App form names what is missing and sends nothing |
| CR-T25 | worker `cr-evidence.test.mjs` | PASS | A draft with three observed statements citing a session set, an event and a note (plus interpretation, assumption, next experiment) is stored with the four sections typed. Negative: three planted statements (a missing session, another project's session, a deleted session) → 422 naming exactly those three; an observed statement with no reference refused; an AI-authored item marked reviewed refused. The runtime's own items all cite records. M3, M9 caught |
| CR-T26 | worker `cr-evidence.test.mjs` | PASS | accept / edit / reject → revision 2 superseding 1; revision 1 kept with its text; sha256 of every raw event, note and session key identical before and after. Negative: editing an observed statement refused; a stale revision → 409; a planted rewrite of the raw note is caught by the hash comparison, which names that key |
| CR-T27 | in-app `evidence-app.spec.ts`; worker `cr-evidence.test.mjs` (Service half and the App session against the real Service); extension `cr-evidence.smoke.mjs` | PASS | In the app: three participant visits through the published runtime, "기록에서 초안 만들기", the claim "'주문'을(를) 시작한 세션 3개 중 1개가 끝까지 마쳤어요." shows no sources until clicked, then exactly its three sessions (`ok`). Negative in the app: one cited session key removed behind the record's back → the claim shows "확인 필요" and that source reads "확인 필요 · 이 근거를 더 이상 찾을 수 없어요" (state `missing`), nothing of the session. Service: another team's student and a director whose scope does not cover the cohort get the unknown-route 404; an in-scope director reads; a draft citing a deleted session is removed with it; a foreign reference reads 확인 필요 in the view. M3, M6 caught. In-app run 2026-10-02: 2 passed in 12.7 s (`e2e/test-results/cr-app/evidence-result.json`) |
| CR-T28 | worker `cr-evidence.test.mjs` | PASS | A project with sessions and a note yields claims each citing records, the note among them. Negative: chat history alone → `no_evidence_recorded`, no claims; a chat-reading builder is told apart |
| CR-T60 (schema half; re-check) | worker `cr-evidence.test.mjs`; `cr-publish.test.mjs` pseudonym half re-run | PASS | The participant schema fields have no identity name; a schema with `email` or `name` added is caught. Server side: one browser's two sessions in a declared experiment share one pseudonym on their session links, an undeclared experiment gets two, no pseudonym appears in both experiments; the validator refuses a stored event with `name` |
| CR-T62 | worker `cr-evidence.test.mjs`; `evidence-runtime.real.mjs` | PASS | Declared `memo`: the typed text is stored. Undeclared: the input event is kept without content, also when the page sends a value anyway; in Chromium a planted snippet sending undeclared values is caught (dropped). A builder that keeps every value is caught by the same verdict; a cohort that forbids raw-input declarations refuses the start (403). M2 caught |
| CR-T64 | worker `cr-evidence.test.mjs`; App session against the real Service | PASS | Session erase: receipt `participant_session_deleted` with its counts, events and the draft citing it gone, the link counter 3 → 2, the reference now `deleted`. Experiment: receipt `experiment_test_data_deleted`, no event, note, session or draft left, links revoked (410), the Experiment closed. Negative: another team's student → 404 for both deletes and every raw hash unchanged. M3, M6 caught |
| CR-T65 | worker `cr-evidence.test.mjs` | PASS | The admin (gate credential) sets a team ceiling `requests:count 500` and a 14-day retention (revision 1); a later link without an expiry gets the 7-day default; `student_deletion: false` refuses a student's delete. Negative: a student token, a director (issuer) token, no credential and a wrong password → 401 and nothing changed; a second write at revision 0 → 409; an unknown meter → 400 |
| CR-T67 | worker `cr-evidence.test.mjs` (SQLite and local workerd D1 and R2); `evidence-runtime.real.mjs` (browser half) | PASS | One pseudonym's three sessions over two days → return count 2, intervals one day each, citing the three sessions, labelled per device; the runtime's observed item cites the three. Negative: undeclared → `not_measured`; a second experiment's session with the same pseudonym is not a return here; a return count with no sessions or a mismatched count refused; twenty sessions opened at the same time through the route all appear (19 returns); the old `linkSession` path under the same load keeps fewer than 20 (caught), the per-session keys keep 20. M4 caught |
| CR-T69 | worker `cr-evidence.test.mjs` | PASS | v1 against an outside alternative: per-variant sessions, tasks and notes, each citing only its own records; every event carries its variant. Negative: a link without a variant and a link to the alternative refused; a note without a variant refused; an event of a session with no variant refused; a claim citing one variant flagged `unsupported`, both `supported`; publishing v2 leaves both pinned variants and the link serving v1. M5 caught |
| Decision 6 | worker `cr-evidence.test.mjs` | PASS | 29 days after the last link ended: kept; 31 days: deleted once; a cohort's 7 days honoured; a live link keeps the experiment; no test origin → the sweep does nothing |
| R6 / rate limits | worker `cr-evidence.test.mjs` | PASS | Twenty concurrent conditional puts of one key keep exactly one, on the in-memory R2 and on local workerd R2. Event batches and session opens past the link's window → 429 and nothing written; the window rolls over; an event past the per-session limit → 413 |

## Pre-change tree (`efb27f40`)

`worker/test/cr-evidence.test.mjs` does not load there (`src/routes/curriculum-admin.ts` absent). A probe of the same controls through the pre-change router: the events route 404, notes 404, evidence 404, drafts 404, experiment delete 404, admin controls 404, a link without a variant in a comparison experiment 201 (accepted), the validator refuses a participant kind (`invalid_kind`), and the core exports neither `reviewInput` nor `identityFieldProblems`. Every control above was therefore red before this change.

## Planted defects in the implementation

Each applied alone to the source, `cr-evidence.test.mjs` run, source restored (9 of 9 caught):

| | Plant | Red |
|---|---|---|
| M1 | identity check removed | CR-T23 negative |
| M2 | every typed value kept | CR-T62 |
| M3 | deleted references resolve | CR-T25, CR-T27 (App), CR-T64 |
| M4 | returns ignore the declaration | CR-T67 |
| M5 | events without a variant accepted | CR-T69 |
| M6 | session erase keeps drafts | CR-T27 (both), CR-T64 |
| M7 | admin controls ignore the switch | CR-T02 |
| M8 | a revoked link still takes events | CR-T23 negative |
| M9 | an observed statement without references accepted | CR-T25 |

## Gates (exit codes, on `c008bd51`)

| Command | Exit |
|---|---|
| `worker`: `npm test` | 0 |
| `worker`: `test:authoring:d1`, `test:classroom:d1`, `test:native-trial:d1`, `test:classroom-ops:d1`, `test:cr-publish:d1`, `test:cr-evidence:d1` | 0 each |
| `worker`: `npm run typecheck` | 0 |
| `worker`: `npm run validate-profiles`; `worker/scripts/cohort-harness/test/run.sh` | 0, 0 |
| `chalk`: `npm test`, `npm run typecheck` | 0, 0 |
| `packages/measurement`: `npm test` | 0 (32 pass) |
| `extensions/hypeproof-chat`: `npm run typecheck` | 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 at the last step `test:instructor-render` only (14 render checks), the environment cause recorded by cr-publish: a stray `react` in `/Users/jaylee/node_modules` bundled beside the webview's own. Every smoke (127), `test:classroom-ops:review` and `test:chalk-tools` passed |
| `e2e`: `npm run test:cr-publish`, `npm run test:cr-evidence` | 0, 0 |
| in-app `evidence-app`, `publish-app` (gated) | 2 passed, 2 passed |
| `python3 scripts/next-work.py --check`; `python3 scripts/check-registry.py`; `node --experimental-strip-types worker/test/cr-traceability.test.mjs` | 0, 0, 0 |
| Harness `align.py check --doc curriculum-runtime` | 1: `BROKEN cr-recon` (its completion pins `docs/requirements/curriculum-runtime.md`, changed since it was recorded). The same break on `origin/main` `efb27f40`; not this item's, and no link of `cr-evidence` is broken |

## NOT RUN

- A real phone (CR-T23's browser half is Chromium emulating one).
- Production R2's conditional put, migrations 0032/0033 and the daily sweep in production (no deploy; Jay's decision).
- An AI-written draft from a coach tool (the route accepts `author: ai`; the tool is cr-skills').
- `verify-app.spec.ts` and `app-layer.spec.ts` were not re-run (no change to their paths); `09-preview.spec.ts` stays BLOCKED by F1.
