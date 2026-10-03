# cr-evidence evidence report

Status: evidence for the `cr-evidence` completion record (CR-02, CR-23–CR-28, CR-65, CR-67, CR-69, CR-70, CR-72, CR-74). 2026-10-02. Owner: jayleekr.
Item: `cr-evidence`, issue [#1394](https://github.com/jayleekr/hypeproof-studio/issues/1394), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1444](https://github.com/jayleekr/hypeproof-studio/pull/1444), squash-merged as `03f66650e818bf50667774245d6978d282abc8ce`. The implementation's run record with all review rounds is [curriculum-runtime-2026-10-02-evidence-capture.md](../testing/curriculum-runtime-2026-10-02-evidence-capture.md); this report re-runs the review round 3 controls and its 23 planted defects at the merge commit.

What the PR does not claim, and this report does not either (claim table in the run record): CR-02 is partial (evidence surfaces only; the `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1). CR-70 is claimed with its enforcement half (team ceilings on calls) left to `cr-gateway` (CR-34), which re-checks it.

## Completion boundary

This report preserves the recorder's test evidence; it does not mark `cr-evidence` complete in the ledger. `align.py record cr-evidence --commit 03f66650e818bf50667774245d6978d282abc8ce --pr 1444 --tests CR-T02,CR-T23,CR-T24,CR-T25,CR-T26,CR-T27,CR-T28,CR-T60,CR-T62,CR-T64,CR-T65,CR-T67,CR-T69 --evidence docs/evidence/cr-evidence.md --reviewed-by cr-evidence:review:regression-conventions:r3` (Harness `align-main` at `44e6bbba`, report staged) exited 1 with `refused: cr-evidence depends on work that is not complete: cr-publish; record or re-record it first`. The cause is upstream of this item and was not changed here: `align.py next --doc curriculum-runtime` at `03f66650` names `cr-recon` as REOPENED (`completion no longer holds (changed since recorded: docs/requirements/curriculum-runtime.md)`), and the chain `cr-browser` → `cr-verify` → `cr-publish` waits on it, each without a completion (see [cr-browser.md](cr-browser.md), [cr-verify.md](cr-verify.md) and [cr-publish.md](cr-publish.md), "Completion boundary"). `cr-browser` has open claims of its own (app-layer CR-T runs NOT RUN), so re-recording `cr-recon` alone would not unblock this record. `align.py check --doc curriculum-runtime` at the same tree exited 1 with `BROKEN cr-recon` only; no link of `cr-evidence` is broken. Once the chain is recorded, this report is the evidence to cite for this item's record; CR-T02 carries a PARTIAL result, as the claim table says.

## Verdict

PASS at `03f66650` for every round 3 control below: the worker suite on SQLite and on local workerd D1 (36 of 36 checks each), the extension smoke, the real-Chromium runtime checks, and 23 of 23 planted defects caught with the unmutated tree green. Evidence classes (MC-38): **synthetic** (worker over SQLite or local workerd D1 and R2; extension smoke), **synthetic (real browser)** (`evidence-runtime.real.mjs`, Playwright Chromium emulating a phone against the real Service router over HTTP). No real phone, no real model, no production host. The in-app `evidence-app.spec.ts` was not re-run by the recorder (see NOT RUN).

## Reviewers

| Label | Role |
|---|---|
| `cr-evidence:review:acceptance:r3` | independent review, acceptance lens, round 3 (PR #1444) |
| `cr-evidence:review:adversarial:r3` | independent review, adversarial lens, round 3 (PR #1444) |
| `cr-evidence:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 (PR #1444); proposed as `reviewed_by` for the ledger completion |

The recorder is a record-only agent that did not write the implementation.

## Environment

2026-10-02, Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0), Node v24.4.1. Worktree `chore/record-cr-evidence` cut from `origin/main` = `03f66650e818bf50667774245d6978d282abc8ce`; `npm ci` in `packages/measurement`, `worker`, `extensions/hypeproof-chat`, its `webview-ui` and `e2e` (all exit 0). No tracked file changed while the tests ran (`git status --short` empty after the mutation run and after the last test).

## Positive controls (unmutated tree)

| Command (from the worktree root) | Result |
|---|---|
| `cd worker && node --experimental-strip-types --experimental-sqlite --no-warnings test/cr-evidence.test.mjs` | exit 0, 36 checks ✅, 0 ❌, `cr-evidence: all checks passed` |
| `cd worker && npm run test:cr-evidence:d1` (local workerd D1 and R2) | exit 0 in 74 s, 36 checks ✅, 0 ❌, `cr-evidence: all checks passed` |
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/cr-evidence.smoke.mjs` | exit 0, `cr-evidence smoke: 4 passed` |
| `cd e2e && npm run test:cr-evidence` (`curriculum-runtime/evidence-runtime.real.mjs`, real Chromium) | exit 0, 4 of 4 ✅: CR-T23 (browser), CR-T62 (browser), CR-T67 (browser), CR-T19 (events after revocation, browser) |

The round 3 controls in the worker suite, each with its positive and negative case inside the same check (names as printed, green on SQLite and on D1):

| Round 3 control | Check |
|---|---|
| CR-69 races, session erase: a batch fired at `deleteSession`'s `observations/` and `gaps/` listings returns 409 `session_deleted` and leaves no key; a draft citing `event:<sid>/e<seq>` returns 422. Control: a live session's batch is stored | "CR-69 races, session erase: a batch landing after the erase scanned observations or gaps is removed and refused (409 session_deleted); a draft citing its event is refused" |
| CR-69 races, experiment delete: a batch fired at the drafts listing and a note fired at the observations listing are both refused and leave nothing (PROBE B and R1); a note, draft or review that reads the experiment before the delete and writes after it returns 409 `experiment_data_deleted` and leaves no key; after the delete a note or draft returns 409 with zero R2 puts. Control: a note on an undeleted experiment returns 201 | "CR-69 races, experiment delete: a batch or note landing while the record is scanned is refused and leaves nothing; a note, draft or review that started before the delete and lands after it is removed with 409 experiment_data_deleted; after it, they are refused and write nothing" |
| Decision 6 sweep races: after a no-link sweep the row is forgotten and the next tick does not list it; a note posted right before `forgetExperimentRecords` keeps the row, and the experiment is deleted at +31 d (R2); a new link after the sweep records a participant (R4); refs from both deletions resolve `deleted` (P2); an injected storage failure leaves the experiment pending and the next tick deletes it | "decision 6, sweep races: a note written while a no-link sweep runs keeps the experiment due and is deleted later; a swept row is forgotten and not listed again; a new link after the sweep records participants; an earlier deletion's references stay 'deleted'; a deletion that failed half-way is due again" |
| CR-69 at the record: a batch fired during `deleteTask`'s observation scan is refused and leaves no key, and no `tasks/` key remains; a session key written after `deleteTask` is taken back (`experiment_data_deleted`); a tombstoned task can be deleted again; a task that never existed still gives `unknown_task` | "CR-69 at the record: deleteTask closes the record before it scans (a batch landing during its observation scan removes itself; a session linked during the delete is taken back); it removes the task key and can run again" |
| Extended CR-T25: `note:note-<random>` and `event:<real session>/e999`, both `unresolved_source_ref` | "CR-T25: a draft whose three observed statements cite real events and notes validates; three planted fabrications (missing, other project's, deleted) are refused, exactly three" |
| Extended CR-T64: an interpretation per session (only the erased session's is removed), the pseudonym key, a draft citing only the note that the experiment delete removes (`receipt.removed.drafts >= 1`, `drafts/` empty), and no `tasks/` key | "CR-T64: deleting a session or an experiment's test data removes events, notes and derived drafts with a receipt; another team gets 404 and nothing is removed" |
| Extended CR-T62: the retroactive `raw_input_allowed` switch and the refusal of email/phone/name fields | "CR-T62: typed text is kept only for a declared field; an undeclared experiment keeps the fact of the input, not its content" |
| Extended CR-T62 labels: blank names and fields | "CR-T62 labels: a task or milestone label is stored only when the experiment declared it; an undeclared one keeps the event without its name (counted in the evidence read); a page passing typed text as a label stores none of it" |
| Extended page paths: the landing view | "page paths: a page_view path is stored only when it names one of the version's files; any other path is stored without it" |
| `cr-evidence.smoke.mjs`: the unnamed line renders only when `unnamed > 0` | "panel: four sections, claims that open on click, 확인 필요 for a dead source, returns labelled per device and 'not measured' when undeclared, the unnamed-events line only when there are some" |

The other checks of the same run, also green on both backends: CR-T02 inventory and switch OFF, CR-T23 and its negative, CR-T60 schema half and Service side, CR-T24, CR-T26, CR-T27 (Service half and the App view against the real Service), CR-T28, CR-T65, CR-T67, CR-T69, decision 6 (period, manual records, not swept early), rate limits, the per-session rate window, store inventory (SX-48), the R2 conditional put, redelivery, the runtime draft at class size, the deleted session's token, the earlier CR-69 races check, CR-65 on the Service, and the snippet size.

Supporting runs at the same tree (exit codes): `worker` `test/cr-publish.test.mjs` 0 (22 checks ✅, `cr-publish (worker SQLite): OK`) · `worker` `test/cr-switch.test.mjs` 0 (`cr-switch (CR-T02 Worker half): OK`) · `extensions/hypeproof-chat` `test/cr-switch.smoke.mjs` 0 (`12 cr-switch checks passed`) · `python3 scripts/next-work.py --check` 0 · `python3 scripts/check-registry.py` 0 · `node --experimental-strip-types worker/test/cr-traceability.test.mjs` 0 (`84 requirements · 80 tests · 52 reuse IDs resolved · both directions agree`). Full `npm test` of `worker` and `extensions/hypeproof-chat` was not re-run by the recorder.

## Negative controls: 23 planted defects

Scratch runner `mut.py` (the round 3 script `r4mut/mut.py`, pointed at this worktree, relabelled with the run record's T1–T23, plus the T23 panel plant): each defect planted alone by exact-anchor replacement (anchor count checked to be 1), `worker/test/cr-evidence.test.mjs` run on SQLite (T23: `extensions/hypeproof-chat/test/cr-evidence.smoke.mjs`), the file restored before the next plant. The reviewers' labels are given where the run record names them.

| Planted defect | File | Result (first failing checks) |
|---|---|---|
| none (positive control) | — | GREEN (rc 0), see above |
| T1 the session key removed last in `deleteSession` | `local-record.ts` | RED: CR-T27 (Service half), CR-T64, deleted session, CR-69 races, CR-69 races session erase |
| T2 `deleteTask` keeps the task key | `local-record.ts` | RED: CR-T64; CR-69 at the record |
| T3 `deleteTask` removes sessions after its scans | `local-record.ts` | RED: CR-T64; decision 6; sweep races; CR-69 at the record |
| T4 `linkSessionKey` without its post-write check | `local-record.ts` | RED: CR-69 at the record |
| T5 `deletedMeanwhile` never fires (X1/M9) | `curriculum.ts` | RED: CR-69 races, experiment delete |
| T6 no pre-check on the notes route (X2/X18) | `curriculum.ts` | RED: CR-69 races, experiment delete |
| T7 no pre-check on the drafts route (X2/X18) | `curriculum.ts` | RED: CR-69 races, experiment delete |
| T8 the experiment closed after `deleteTask` (the old close-after-delete order) | `retention.ts` | RED: CR-69 races, experiment delete |
| T9 a missing `note:` or `event:` reference resolves `ok` (X22) | `local-record.ts` | RED: CR-T25; CR-69 races, session erase |
| T10 drafts survive `deleteTask` (X8) | `local-record.ts` | RED: CR-T64; CR-69 races, experiment delete |
| T11 interpretations survive a session erase (X9) | `local-record.ts` | RED: CR-T64 |
| T12 the pseudonym key kept on a session erase | `local-record.ts` | RED: CR-T64 |
| T13 the no-link sweep does not forget its row (M4, forget not called) | `retention.ts` | RED: decision 6, sweep races |
| T14 the row forgotten unconditionally | `store.ts` | RED: decision 6, sweep races |
| T15 the links route does not re-create the task | `curriculum.ts` | RED: decision 6, sweep races |
| T16 a tombstone overwritten, not merged | `local-record.ts` | RED: decision 6, sweep races |
| T17 a pending deletion never due | `store.ts` | RED: decision 6, sweep races |
| T18 no last-record move on a note | `curriculum.ts` | RED: decision 6 manual records, not swept early, sweep races |
| T19 raw input kept after the admin turned it off | `participant-record.ts` | RED: CR-T62 |
| T20 an identity-like raw-input field accepted | `venture.ts` | RED: CR-T62 |
| T21 a blank task name refuses the batch | `participant-record.ts` | RED: CR-T62 labels |
| T22 the root path dropped | `participant-record.ts` | RED: page paths |
| T23 the unnamed line always rendered (panel) | `webview-ui/src/EvidencePanel.tsx` | RED: smoke `AssertionError: one session has unnamed events` |

All 23 RED, the unmutated control GREEN, `git status --short` empty afterwards. The saved output next to the round 3 script (`r4mut/mut.out`) predates the script's current content: it names a different B plant ("deleteTask no early session removal") and a U plant the script no longer has (W, T3 here, is in its place), and shows B, T (T4 here) and U green. The run record's 23 of 23 does not rest on that file. At `03f66650` the current script catches all 23, T4 included, so that output does not describe this commit.

## NOT RUN

- A real phone (CR-T23's browser half is Chromium emulating one).
- The in-app `evidence-app.spec.ts` (CR-T27 in the app, CR-T02 in the app) at `03f66650`: not re-run by the recorder; the run record has it green on the review round 3 tree (2 passed in 12.6 s).
- `09-preview.spec.ts` switch-off baseline for CR-T02 (BLOCKED by pre-existing F1).
- Production R2's conditional put, migrations 0032/0033 and the daily sweep in production (no deploy; Jay's decision).
- An AI-written draft from a coach tool (the route accepts `author: ai`; the tool is `cr-skills`').
- Any real model, any production host, D1 migration or route.
- GitHub was not read by the recorder (the API budget belongs to the shipping agent); main CI at `03f66650` is not re-read here.
