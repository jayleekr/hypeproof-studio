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

- Code: branch `feat/cr-evidence` off `origin/main` `efb27f40`; implementation commits `5734c43b`, `3bffa7c7`, `c008bd51`, and the review-round-1 fixes in the commit after `dd523fe2` (section below). The submitted SHA is the branch head that carries this file.
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
| CR-T60 (schema half; re-check) | worker `cr-evidence.test.mjs`; `cr-publish.test.mjs` pseudonym half re-run | PASS | The participant schema fields have no identity name; a schema with `email` or `name` added is caught. Snippet: one browser's two sessions in a declared experiment share one pseudonym on their session links, an undeclared experiment gets two, no pseudonym appears in two projects; the validator refuses a stored event with `name`. Service (review round 1, what the Service itself enforces): an undeclared experiment stores a fresh Service-made pseudonym per session whatever the page sends (two opens sending the same value store two different ones); a declared experiment's pseudonym is refused (404) in a second experiment of the same project and nothing is stored. Not checked by the Service: reuse across projects (each project has its own origin) |
| CR-T62 | worker `cr-evidence.test.mjs`; `evidence-runtime.real.mjs` | PASS | Declared `memo`: the typed text is stored. Undeclared: the input event is kept without content, also when the page sends a value anyway; in Chromium a planted snippet sending undeclared values is caught (dropped). A builder that keeps every value is caught by the same verdict; a cohort that forbids raw-input declarations refuses the start (403). M2 caught. Labels (review round 1): a page sending typed text as a milestone or task label (`이름 입력: 김민수 010-…`, `주문 메모: 땅콩 …`) stores none of it, in an experiment without label declarations and in one declaring only `주문하기`; the declared label is stored; a keep-every-label builder is caught; a duplicate label declaration is refused (400). R4 caught |
| CR-T64 | worker `cr-evidence.test.mjs`; App session against the real Service | PASS | Session erase: receipt `participant_session_deleted` with its counts, events and the draft citing it gone, the link counter 3 → 2, the reference now `deleted`. Experiment: receipt `experiment_test_data_deleted`, no event, note, session or draft left, links revoked (410), the Experiment closed. Negative: another team's student → 404 for both deletes and every raw hash unchanged. M3, M6 caught |
| CR-T65 | worker `cr-evidence.test.mjs` | PASS | The admin (gate credential) sets a team ceiling `requests:count 500` and a 14-day retention (revision 1); a later link without an expiry gets the 7-day default; `student_deletion: false` refuses a student's delete of the experiment and of a session (403 `deletion_reserved`) while an in-scope director deletes both, with receipts naming `deleted_by: director` (review round 1); a director whose scope does not cover the cohort gets 404. Negative: a student token, a director (issuer) token, no credential and a wrong password → 401 and nothing changed; a second write at revision 0 → 409; an unknown meter → 400 |
| CR-T67 | worker `cr-evidence.test.mjs` (SQLite and local workerd D1 and R2); `evidence-runtime.real.mjs` (browser half) | PASS | One pseudonym's three sessions over two days → return count 2, intervals one day each, citing the three sessions, labelled per device; the runtime's observed item cites the three. Negative: undeclared → `not_measured`; a second experiment of the same project opening the same pseudonym is refused and is not a return here; through the drafts route (review round 1), a return statement citing only a note (422 `return_without_sessions`), one session for a count of 4 or no stated count (422 `return_count_mismatch`), and two devices counted as one (422 `return_sessions_not_one_device`) are refused, the right statement (three sessions, `return_count` 2) is stored; the count written inside the statement's text is not parsed; twenty sessions opened at the same time through the route all appear (19 returns); the old `linkSession` path under the same load keeps fewer than 20 (caught), the per-session keys keep 20. M4 caught |
| CR-T69 | worker `cr-evidence.test.mjs` | PASS | v1 against an outside alternative: per-variant sessions, tasks and notes, each citing only its own records; every event carries its variant. Negative: a link without a variant and a link to the alternative refused; a note without a variant refused; an event of a session with no variant refused; a claim citing one variant flagged `unsupported`, both `supported`; publishing v2 leaves both pinned variants and the link serving v1. M5 caught |
| Decision 6 | worker `cr-evidence.test.mjs` | PASS | 29 days after the last link ended: kept; 31 days: deleted once; a cohort's 7 days honoured; a live link keeps the experiment. Review round 1: an experiment with no link and only a quote is kept 29 days after its last record and deleted at 31 (the quote then resolves `deleted`), on a Service with no test origin; the sweep runs without a test origin and, on a D1 without the migrations, issues only the `sqlite_master` read |
| R6 / rate limits | worker `cr-evidence.test.mjs` | PASS | Twenty concurrent conditional puts of one key keep exactly one, on the in-memory R2 and on local workerd R2. Event batches and session opens past the link's window → 429 and nothing written; the window rolls over; an event past the per-session limit → 413. Review round 1: a session past its own window (60 batches a minute) → 429 while another session of the link → 204; the same batch sent twice → 204 twice and one stored event, different content under one id → 409 `conflicting_event`, the strict comparison would call the redelivery a conflict (caught); in the snippet, a lost events response does not hold back the visit's later click and task, and a permanent refusal drops only its batch (the next event is stored); a deleted session's token reopens nothing (404) and its events get 409 `session_deleted`; 120 sessions of one task give a stored runtime draft whose statements each cite at most 50 sessions and together all 120 (the single 120-reference statement is refused 400), and thirty labels over 120 sessions give 60 statements that pass the validator |

## Review round 1 (2026-10-02)

Findings of the first review applied on the same branch (deviations recorded in the [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-evidence)): a director delete path when students may not delete; automatic deletion of experiments with no link, gated on the tables; return counts checked where drafts are stored; task and milestone labels kept only when declared; idempotent redelivery and a snippet that retries only transient refusals; a per-session event window; the runtime draft within the validator's bounds; the Service, not the snippet, enforcing CR-65's pseudonym rules; a deleted session that cannot be reopened; `author` required on drafts. The controls are in the rows above.

Planted defects for the round, each applied alone, `cr-evidence.test.mjs` run, source restored (13 of 13 caught):

| | Plant | Red |
|---|---|---|
| R1 | the director delete refused like a student's | CR-T65 |
| R2 | the due-for-deletion query back to an inner join on links | decision 6, manual records |
| R3 | the return check not called when a draft is saved | CR-T67 |
| R4 | undeclared labels kept | CR-T62 labels |
| R5 | strict comparison on redelivery | redelivery |
| R6 | the runtime draft not split | runtime draft at class size |
| R7 | the page's pseudonym kept in an undeclared experiment | CR-T60 server side |
| R8 | no tombstone check on a session open | deleted session |
| R9 | no per-session window | per-session rate window |
| R10 | the snippet retrying every 409 | redelivery |
| R11 | the draft author defaulted to the student | CR-T25 |
| R12 | the pseudonym index never refusing | CR-T60 server side, CR-T67 |
| R13 | the sweep gated on a test origin again | decision 6, decision 6 manual records |

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

## Gates for review round 1 (exit codes, on the review-round-1 commit)

| Command | Exit |
|---|---|
| `worker`: `npm test` | 0 |
| `worker`: `node … test/cr-evidence.test.mjs`, `test:cr-evidence:d1`, `test:cr-publish:d1` | 0, 0, 0 |
| `worker`: `npm run typecheck` | 0 |
| `extensions/hypeproof-chat`: `npm run typecheck`, `webview-ui` `tsc --noEmit`, `npm run build` | 0, 0, 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 at `test:instructor-render` only, the same environment cause as above; every smoke (127), `test:classroom-ops:review` and `test:chalk-tools` passed |
| `e2e`: `npm run test:cr-publish`, `npm run test:cr-evidence` | 0, 0 |
| in-app `evidence-app` (gated) | 0: 2 passed in 13.0 s (the publish form now fills "기록할 과제 이름" with `주문`; the prepared copy with this commit's extension and webview injected) |
| `python3 scripts/next-work.py --check`; `python3 scripts/check-registry.py`; `node --experimental-strip-types worker/test/cr-traceability.test.mjs` | 0, 0, 0 |
| Harness `align.py check --doc curriculum-runtime` | 1: `BROKEN cr-recon` only, as above |

`cr-publish.test.mjs`'s constant-cost bound for one visit moved from 8 to 11 R2 calls: the open now also reads the erased-session tombstone and writes the pseudonym's index key (a conditional put). The call count is still the same at the 1st and the 500th session.

## NOT RUN

- A real phone (CR-T23's browser half is Chromium emulating one).
- Production R2's conditional put, migrations 0032/0033 and the daily sweep in production (no deploy; Jay's decision).
- An AI-written draft from a coach tool (the route accepts `author: ai`; the tool is cr-skills').
- `verify-app.spec.ts` and `app-layer.spec.ts` were not re-run (no change to their paths); `09-preview.spec.ts` stays BLOCKED by F1.
