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

## Review round 2 (2026-10-02)

Findings of the second review applied on the same branch (plan, "Review round 2"). Controls added to `cr-evidence.test.mjs`:

- Decision 6, not swept early: an experiment with no link and no record is not due at +400 days, stays `running` and still issues a link; with the link revoked 25 days back, a note written now keeps the experiment at +6 days and it is deleted (and closed) at +31; a draft and a draft review each move the last record (backdated record with nothing after it: due, the control). The notes-only experiment is deleted at +31 days and left `running`, still taking notes and a link.
- CR-T62 labels: an undeclared task start, task start and milestone are all stored without a name (no typed text in the events or the evidence read); the evidence read counts them (`unnamed` 3, and 2 in the experiment declaring `주문하기`); a start and a finish with an undeclared name both come out of `participantEvents` nameless.
- CR-T67: in an undeclared experiment a statement of zero returns (`basis`, `return_count: 0`) → 422 `return_not_measured`; the same session cited without a return claim → 201.
- CR-69 races: the student's session delete landing inside the batch's first event write → 409 `session_deleted` and no event or assignment of that session left; an observation stored with no task under the experiment's scope (present, the control) is removed by the experiment delete; the participant path refuses the same write (`session_not_open`).
- CR-65 on the Service: same link, the device's second session is a return (control); after revoking it, the same pseudonym on a new link gets a fresh one and the return count stays 1.
- Page paths: `/app.js` (a published file) is kept; a made-up path is stored without it.
- CR-T25 adds a sibling experiment's session (`foreign_source_ref`); CR-T28 rejects one item and checks it is absent from `review_input`; CR-T64 checks no `pseudonyms/` key is left; snippet size checks both halves under 2,048 bytes (event half 2,045).

Planted defects for the round, each applied alone, `cr-evidence.test.mjs` run, source restored (16 of 16 caught):

| | Plant | Red |
|---|---|---|
| S1 | an experiment with no link and no record is due | decision 6, not swept early |
| S2 | the end time from the link only | decision 6, not swept early |
| S3 | the sweep always closes | decision 6, manual records |
| S4 | no last-record move on a note | decision 6, manual records; not swept early |
| S5 | no last-record move on a draft | decision 6, not swept early |
| S6 | no last-record move on a draft review | decision 6, not swept early |
| S7 | an undeclared-label event dropped | CR-T62 labels |
| S8 | the repeated-use declaration ignored for return statements | CR-T67 |
| S9 | no re-check after a participant batch's writes | CR-69 races |
| S10 | no scope sweep in `deleteTask` | CR-69 races |
| S11 | no linked-session check before a participant batch | CR-69 races |
| S12 | rejected items kept in the review input | CR-T28 |
| S13 | a sibling experiment's session resolves | CR-T25 |
| S14 | pseudonym index keys kept on delete | CR-T64 |
| S15 | a pseudonym accepted from another link | CR-65 on the Service |
| S16 | any page path kept | page paths |

### Gates for review round 2 (exit codes, on the review-round-2 commit's tree)

| Command | Exit |
|---|---|
| `worker`: `npm test` | 0 |
| `worker`: `node … test/cr-evidence.test.mjs`, `test:cr-evidence:d1`, `test:cr-publish:d1` | 0, 0 (67 s, it waited for sockets to drain; 8,171 in TIME_WAIT after), 0 |
| `worker`: `npx tsc --noEmit` | 0 |
| `extensions/hypeproof-chat`: `tsc --noEmit`, `webview-ui` `tsc --noEmit`, `npm run build` | 0, 0, 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 at `test:instructor-render` only, the environment cause above (`/Users/jaylee/node_modules/react` 19.1.0); the same bundle with `react`/`react-dom` aliased to the webview's copy: 14 of 14 passed. Every smoke, `test:classroom-ops:review` and `test:chalk-tools` passed |
| `e2e`: `npm run test:cr-evidence`, `npm run test:cr-publish` (Chromium) | 0, 0 |
| in-app `evidence-app` (gated, idle, screen unlocked; the prepared copy with this tree's extension and webview injected) | 0: 2 passed in 12.7 s |
| `python3 scripts/next-work.py --check`; `python3 scripts/check-registry.py`; `node --experimental-strip-types worker/test/cr-traceability.test.mjs` | 0, 0, 0 |
| Harness `align.py check --doc curriculum-runtime` | 1: `BROKEN cr-recon` only, as above |

## Review round 3 (2026-10-02)

Findings of the third review applied on the same branch. The common cause: a deletion scanned the record while it still took writes, so a write landing between the scan and the end of the deletion outlived it. A deletion now refuses writes before it scans:

- `deleteSession` writes its tombstone and removes the session key first, then scans; it also removes the session's pseudonym index key when no other live session of the task carries it.
- Deleting an experiment (the student's action and the sweep, one function `deleteExperimentData`) closes it first (`data_deleted_at` and an additive `data_deletion_pending`, links revoked), then runs `deleteTask`, then clears the pending mark. A deletion that fails half-way stays pending and is due on the next tick.
- `deleteTask` writes its tombstone and removes the task and its session keys before the scans; `linkSessionKey` takes back a session key written after the task was removed (`experiment_data_deleted` at the open). A task with a tombstone can be deleted again. Tombstones merge, so a second deletion keeps the first one's keys.
- Notes, drafts and reviews move the last-record time before they write, and catch a task lost to the deletion. The no-link sweep forgets its row only when `last_record_at` is not later than what it acted on. The links route re-creates the record task the no-link sweep removed.
- Minor: blank task names and blank input fields are kept like undeclared ones; the link's root path is stored as its entry page; turning `raw_input_allowed` off stops collection for running experiments; an identity-like field cannot be declared as raw input; the panel line uses the publish panel's term ("기록할 과제 이름에 없는 이름 N개는 이름 없이 기록했어요").

Controls added to `cr-evidence.test.mjs`: the two session-erase windows (a batch landing at the erase's observation and gap listings: 409 `session_deleted`, no key, a draft citing the event 422; a live session's batch stored, the control); the experiment-delete windows (a batch at the drafts listing and a note at the observation listing refused with nothing left; a note, a draft and a review that read the experiment before the delete and write after it: 409 `experiment_data_deleted` and nothing left; after the delete a note and a draft are refused with zero R2 puts; an undeleted experiment takes a note, the control); the sweep races (the no-link row forgotten and not listed again; a note written right before the sweep forgets the row keeps it due, deleted 30 days later; a new link after the sweep records a participant; both deletions' note references stay `deleted`; an injected storage failure leaves the experiment pending and the next tick deletes it); the record-level deletion (a batch landing during `deleteTask`'s scan refused, a session key written after the delete taken back, a never-created task still `unknown_task`). CR-T25 adds a made-up `note:` and `event:` reference (both `unresolved_source_ref`); CR-T64 adds an interpretation per session (only the erased one goes), the pseudonym key, a draft citing only the note removed by the experiment delete, and no `tasks/` key left; CR-T62 adds the retroactive raw-input switch and identity-like declarations; CR-T62 labels adds blank names and fields; page paths adds the landing view. `cr-evidence.smoke.mjs` checks the panel line renders only when a session has unnamed events.

Planted defects for the round, each applied alone, `cr-evidence.test.mjs` (or the smoke) run, source restored (23 of 23 caught):

| | Plant | Red |
|---|---|---|
| T1 | the session key removed last in `deleteSession` | CR-69 races, session erase (and four more) |
| T2 | `deleteTask` keeps the task key | CR-T64; CR-69 at the record |
| T3 | `deleteTask` removes sessions after its scans | CR-69 at the record (and three more) |
| T4 | `linkSessionKey` without its post-write check | CR-69 at the record |
| T5 | `deletedMeanwhile` never fires | CR-69 races, experiment delete |
| T6 | no pre-check on the notes route | CR-69 races, experiment delete |
| T7 | no pre-check on the drafts route | CR-69 races, experiment delete |
| T8 | the experiment closed after `deleteTask` (the old order) | CR-69 races, experiment delete |
| T9 | a missing `note:` or `event:` reference resolves | CR-T25; session erase |
| T10 | drafts survive `deleteTask` | CR-T64; experiment delete |
| T11 | interpretations survive a session erase | CR-T64 |
| T12 | the pseudonym key kept on a session erase | CR-T64 |
| T13 | the no-link sweep does not forget its row | sweep races |
| T14 | the row forgotten unconditionally | sweep races |
| T15 | the links route does not re-create the task | sweep races |
| T16 | a tombstone overwritten, not merged | sweep races |
| T17 | a pending deletion never due | sweep races |
| T18 | no last-record move on a note | decision 6 (three tests) |
| T19 | raw input kept after the admin turned it off | CR-T62 |
| T20 | an identity-like raw-input field accepted | CR-T62 |
| T21 | a blank task name refuses the batch | CR-T62 labels |
| T22 | the root path dropped | page paths |
| T23 | the unnamed line always rendered (panel) | `cr-evidence.smoke.mjs` |

Residual, not fixed: if `deleteSession` fails after removing the session key, a retry of the same DELETE answers 404 (the session is no longer linked); what is left is removed by the experiment's deletion or its 30-day sweep. A session open racing the no-link sweep's `deleteTask` between the links route's re-creation and the sweep's removal answers 404 at the open until the student publishes the link again.

### Gates for review round 3 (exit codes, on the review-round-3 tree)

| Command | Exit |
|---|---|
| `worker`: `npm test` | 0 |
| `worker`: `node … test/cr-evidence.test.mjs`, `test:cr-evidence:d1`, `test:cr-publish:d1` | 0, 0 (73 s), 0 |
| `worker`: `npx tsc --noEmit`; `npm run validate-profiles` | 0, 0 |
| `packages/measurement`: `npm test` | 0 |
| `extensions/hypeproof-chat`: `tsc --noEmit`, `webview-ui` `tsc --noEmit`, `vite build` | 0, 0, 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 at `test:instructor-render` only (0 of 14), the environment cause recorded in round 2 (`/Users/jaylee/node_modules/react` 19.1.0); every smoke, `test:classroom-ops:review` and `test:chalk-tools` passed. The first run also caught a real defect, `venture.ts` importing `learning-events` without its `.ts` extension (an extension smoke loads it under Node), fixed before the rerun |
| `e2e`: `npm run test:cr-evidence`, `npm run test:cr-publish` (Chromium) | 0, 0 |
| in-app `evidence-app` (gated, idle, screen unlocked; the prepared copy with this tree's extension and webview injected) | 0: 2 passed in 12.6 s |
| `python3 scripts/next-work.py --check`; `python3 scripts/check-registry.py`; `node --experimental-strip-types worker/test/cr-traceability.test.mjs` | 0, 0, 0 |

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
