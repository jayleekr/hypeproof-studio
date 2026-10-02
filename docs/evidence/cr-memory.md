# cr-memory evidence report

Status: evidence for the `cr-memory` completion record (CR-02, CR-35–CR-42, CR-75–CR-79, CR-82). 2026-10-02. Owner: jayleekr.
Item: `cr-memory`, issue [#1395](https://github.com/jayleekr/hypeproof-studio/issues/1395), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1450](https://github.com/jayleekr/hypeproof-studio/pull/1450), squash-merged as `ab1caeba19b9a39727a9d6603fa23cc2e29fe5d7`. The implementation's run record with all review rounds is [curriculum-runtime-2026-10-02-memory.md](../testing/curriculum-runtime-2026-10-02-memory.md); decisions and deviations are in the [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-memory). This report re-runs the round 3 controls at the merge commit and plants 19 defects against them.

What the PR does not claim, and this report does not either (claim table in the run record): CR-02 is partial (memory surfaces only; the `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1). CR-35 is partial: WeeklyReviews (`cr-review`) and AIUsage (`cr-gateway`) are named in the memory read's `not_in_this_read`. CR-79 is claimed with the recorded deviation (revisions stored in the Hypothesis document, not as a `decision_revised` learning event), accepted by the round 2 acceptance reviewer. CR-39 is a re-run of CR-T80, not a new record. CR-82's student path is the Service review route; the App has no promote control in this slice.

## Completion boundary

This report preserves the recorder's test evidence. Whether `align.py record cr-memory` wrote a completion is stated in the "Ledger record" section at the end; a refusal is reported there with its cause, never replaced by a hand-written completion.

## Verdict

PASS at `ab1caeba` for every round 3 control below: the worker suite on SQLite and on local workerd D1 (24 of 24 checks each), the extension smoke (5 of 5), the supporting suites, and 19 of 19 planted defects caught with the unmutated tree green. Evidence classes (MC-38): **synthetic** (the real Service router over SQLite, or local workerd D1 and R2 with `--d1`; extension smoke). No real phone, no real model, no production host. The in-app `memory-app.spec.ts` (the in-app half of CR-T02, CR-T36 and CR-T73) was not re-run by the recorder (see NOT RUN).

## Reviewers

| Label | Role |
|---|---|
| `cr-memory:review:acceptance:r3` | independent review, acceptance lens, round 3 (PR #1450) |
| `cr-memory:review:adversarial:r3` | independent review, adversarial lens, round 3 (PR #1450) |
| `cr-memory:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 (PR #1450); proposed as `reviewed_by` for the ledger completion |

The recorder is a record-only agent that did not write the implementation.

## Environment

2026-10-02, Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0), Node v24.4.1. Worktree `chore/record-cr-memory` cut from `origin/main` = `ab1caeba19b9a39727a9d6603fa23cc2e29fe5d7`; `npm ci` in `packages/measurement`, `worker`, `extensions/hypeproof-chat` and its `webview-ui` (all exit 0). No tracked file changed while the tests ran (`git status --short` empty after the mutation run and after the last test).

## Positive controls (unmutated tree)

| Command (from the worktree root) | Result |
|---|---|
| `cd worker && node --experimental-strip-types --experimental-sqlite --no-warnings test/cr-memory.test.mjs` | exit 0, 24 checks ✅, 0 ❌, `cr-memory (worker SQLite): OK` |
| `cd worker && npm run test:cr-memory:d1` (local workerd D1 and R2) | exit 0 in 11 s, 24 checks ✅, 0 ❌, `cr-memory (worker local workerd D1): OK` |
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/cr-memory.smoke.mjs` | exit 0, `5 cr-memory smoke checks passed` |

The round 3 controls this record names, each with its positive and negative case inside the same check (names as printed, green on SQLite and on D1):

| Round 3 control | Check | Negative / positive inside it |
|---|---|---|
| CR-T02 mixed-scope director | "CR-T02 switch OFF: every memory route, with real ids and a student, a director or no token, answers as an unknown route; ON they answer" | an issuer covering the CR-off profile and another profile: memory and diff answer as an unknown route, the director list is empty; control: the same director reads it and lists it once the switch is on |
| CR-T37 same cohort, other profile; revoked token | "CR-T37: a director in scope lists the team and walks hypothesis → evidence → decision → version; another cohort's director, another profile's, a student of another team: refused" | the right cohort with another profile lists nothing; a revoked director token gets 401; control: the same token reads before revocation |
| CR memory writes (new) | "CR memory writes: a non-member cannot link a decision's version or name an experiment's stakeholder; another Project's decision, experiment or stakeholder and a dangling ev: ref are refused on every route that takes one" | non-member version link and experiment stakeholder → 404; another Project's decision on slides and revisions, a dangling `ev:` ref on revisions and on an `evidence_items` metric, another Project's `experiment_id` on decisions and stakeholder on metrics → refused; each with a member control that is accepted |
| CR-T74 route negatives and pure `beliefChanges` | "CR-T74: a hypothesis revised after a decision shows before, after, the decision and its evidence; …" and "CR-T74 (unit): a belief change reads 'recorded' only on the team's decision and evidence it may rest on; …" | an assumption-only or unreviewed-AI-only reason and a dangling ref are refused on the route; pure: an assumption, an unreviewed AI item, an unreal record or an AI suggestion is never the reason |
| SX-46 `sources_real` | "SX-46 sources_real: an observation resting on a simulated, self-reported or unknown note is listed but supports no observed role and no team decision, on the same rule as promotion" | pure, plus route-level checks for an observed role and a team decision; real-note controls accepted |
| CR-35 store race | "CR-35 store race: a director's member change never erases a problem revision written after the route read the Project; a planted whole-doc write does" | `setMembers` against a problem revision; the planted whole-document write is the instrument and erases it |
| CR-T77 additions; CR-T70 single role; CR-35 slides | "CR-T77: …", "CR-T77 negatives: …", "CR-T70: …", "CR-35 writes: …" | a slide citing an item is listed; an AI suggestion's slides and version not counted; a rejected item not listed; an interpreted item refused in `assumption_refs`; an unknown note refused for promotion; a single-role stakeholder has `payer_and_user` false; slides 0 and 9 refused, 8 accepted |
| CR-40 `created_by` | "CR-40 created_by: an AI item stays the system's after the student accepts it (a review, recorded as review state, not authorship); a student's own item is the student's" | an accepted AI item stays `system`; control: the student's own item is `student` |
| Panel, unreal record | smoke "panel render: every decision drawn with its actor and no-evidence mark, …" | an item on an unreal record is marked "실제로 본 기록이 아니에요" in the panel and is not offered as a piece of evidence in the decision form |

The other checks of the same run, also green on both backends: CR-T39 (PRD §10.2–10.4 samples), CR-T02 inventory, CR-T80 (re-run by cr-memory), CR-T35, CR-T36 (Service half), CR-T38, CR-T70 (unit), CR-75 store race, CR-T71 and its route half, CR-T72, CR-T73. Smoke, also green: the memory session, CR-T36 (App unit), the CR-79 sentence, CR-78 (App).

Supporting runs at the same tree (exit codes): `worker` `test/cr-publish.test.mjs` 0 (22 checks ✅, `cr-publish (worker SQLite): OK`) · `worker` `test/cr-switch.test.mjs` 0 (`cr-switch (CR-T02 Worker half): OK`) · `worker` `test/cr-evidence.test.mjs` 0 (`cr-evidence: all checks passed`) · `extensions/hypeproof-chat` `test/cr-switch.smoke.mjs` 0 (`12 cr-switch checks passed`) · `python3 scripts/next-work.py --check` 0 · `python3 scripts/check-registry.py` 0 (`check-registry: OK`) · `node --experimental-strip-types worker/test/cr-traceability.test.mjs` 0 (`84 requirements · 80 tests · 52 reuse IDs resolved · both directions agree`). Full `npm test` of `worker` and `extensions/hypeproof-chat` was not re-run by the recorder.

## Negative controls: 19 planted defects

Scratch runner `mut-memory.py` (in the session scratch directory, not committed): each defect planted alone by exact-anchor replacement (anchor count checked to be 1), the owning suite run (`worker/test/cr-memory.test.mjs` on SQLite, or `extensions/hypeproof-chat/test/cr-memory.smoke.mjs`), the file restored before the next plant. The baseline run before the plants was green for both suites. The review-round labels from the run record are given in brackets.

| | Planted defect | File | Result (first failing check) |
|---|---|---|---|
| — | none (positive control) | — | GREEN (rc 0), both suites |
| P1 | the director memory read without the Project profile's switch check [R4] | `routes/curriculum.ts` | RED: CR-T02 switch OFF, `mixed scope: …/memory` |
| P2 | the director list without the scope check [R5] | `routes/curriculum.ts` | RED: CR-T37, "the right cohort, another profile: lists none of this profile's teams" |
| P3 | a revoked director token reads memory [R15] | `routes/curriculum.ts` | RED: CR-T37 |
| P4 | membership dropped on the decision version link [R7] | `routes/curriculum.ts` | RED: CR memory writes, "non-member: decision version link" |
| P5 | another Project's decision accepted on a slide [R24] | `routes/curriculum.ts` | RED: CR memory writes, "slide: another Project's decision" |
| P6 | another Project's decision accepted on a hypothesis revision [R25] | `routes/curriculum.ts` | RED: CR memory writes, "revision: another Project's decision" |
| P7 | another Project's stakeholder accepted on a metric [R13] | `routes/curriculum.ts` | RED: CR memory writes, "metric: another Project's stakeholder" |
| P8 | a dangling `ev:` ref accepted on an `evidence_items` metric [R26] | `routes/curriculum.ts` | RED: CR memory writes, "metric: dangling ev: ref" |
| P9 | another Project's `experiment_id` accepted on a decision [R28] | `lib/curriculum/memory.ts` | RED: CR memory writes |
| P10 | `payer_and_user` with `\|\|` [R12] | `lib/curriculum/memory.ts` | RED: CR-T70, "one role only: never read as payer and user" |
| P11 | a rejected draft item listed as evidence [R11] | `lib/curriculum/memory.ts` | RED: CR-T77 |
| P12 | `assumption_refs` accept an interpreted item [R21] | `lib/curriculum/memory.ts` | RED: CR-T77 negatives |
| P13 | `created_by` taken from the latest revision's author (acceptance counted as authorship) [N7 r2] | `lib/curriculum/memory.ts` | RED: CR-40 created_by, "accepted: reviewed, still written by the system" |
| P14 | `sources_real` always true (an item on a simulated note counts) [N3, N4 r2] | `lib/curriculum/memory.ts` | RED: SX-46 sources_real |
| P15 | slide 9 accepted [R48] | `lib/curriculum/venture.ts` | RED: CR-35 writes, "slide 9" |
| P16 | slide 0 accepted | `lib/curriculum/venture.ts` | RED: CR-35 writes, "slide 0" |
| P17 | `setMembers` writes the Project it was handed (erases a problem revision) [N5 r2] | `lib/curriculum/store.ts` | RED: CR-35 store race |
| P18 | the panel offers an item on an unreal record as evidence [S6] | `webview-ui/src/MemoryPanel.tsx` | RED: smoke, "an item on an unreal record is not a pickable piece of evidence" |
| P19 | the panel does not mark an item on an unreal record [S7] | `webview-ui/src/MemoryPanel.tsx` | RED: smoke, the "실제로 본 기록이 아니에요" match |

All 19 RED, the unmutated control GREEN, `git status --short` empty afterwards. P1's first anchor matched three places and was not planted on that pass (the runner refuses any anchor count other than 1); it was re-anchored to the director branch of `memoryReader` and run alone, RED. The pre-implementation red (on `origin/main` `34d42b3b` the suite stops with `ERR_MODULE_NOT_FOUND` for `memory.ts`) and the M1–M12, N1–N19, S1–S7 and R* plants are the implementer's, recorded in the run record; this report does not re-run them beyond the 19 above.

## Test IDs named in the record

CR-T02 (PARTIAL: Worker and extension halves re-run; in-app half and the `09-preview.spec.ts` baseline not), CR-T35, CR-T36 (Service half and App unit re-run; in-app half not re-run), CR-T37, CR-T38, CR-T39, CR-T70, CR-T71, CR-T72, CR-T73 (Service and App halves re-run; in-app half not re-run), CR-T74, CR-T77, CR-T80.

## NOT RUN

- The in-app `e2e/curriculum-runtime/memory-app.spec.ts` (CR-T02, CR-T36 and CR-T73 in the app) at `ab1caeba`: not re-run by the recorder (app-layer runs go through the idle gate); the run record has it green on the review tree (2 passed in 16.7 s and 21.4 s).
- `09-preview.spec.ts` switch-off baseline for CR-T02 (BLOCKED by pre-existing F1).
- A real phone or a real classroom; none is named by these rows.
- Migration 0034 on production D1, any production R2, Worker route or host (Jay's deploy decision, with 0032 and 0033).
- Any real model.
- GitHub was not read by the recorder (the API budget belongs to the shipping agent); main CI at `ab1caeba` is not re-read here.

## Follow-ups carried from the run record (not changed here)

- R29: a participant event with no session id is counted into a metric result (surviving plant, not in the round 2 findings).
- `closeExperimentAfterDeletion` and `finishExperimentDeletion` (cr-evidence) still write the experiment row without a revision guard.
- The `addHypothesis` race path is covered only by review.

## Ledger record

`align.py record cr-memory --commit ab1caeba19b9a39727a9d6603fa23cc2e29fe5d7 --pr 1450 --tests CR-T02,CR-T35,CR-T36,CR-T37,CR-T38,CR-T39,CR-T70,CR-T71,CR-T72,CR-T73,CR-T74,CR-T77,CR-T80 --evidence docs/evidence/cr-memory.md --reviewed-by cr-memory:review:regression-conventions:r3` (Harness `align-main` at `44e6bbba`, this report staged) exited 1 with `refused: cr-memory depends on work that is not complete: cr-evidence; record or re-record it first`. No completion was written and the ledger is unchanged.

The cause is upstream of this item and was not changed here: `align.py next --doc curriculum-runtime` at `ab1caeba` names `cr-recon` as REOPENED (`completion no longer holds (changed since recorded: docs/requirements/curriculum-runtime.md)`), and the chain `cr-browser` → `cr-verify` → `cr-publish` → `cr-evidence` waits on it, each without a completion (see [cr-browser.md](cr-browser.md), [cr-verify.md](cr-verify.md), [cr-publish.md](cr-publish.md) and [cr-evidence.md](cr-evidence.md), "Completion boundary"). `cr-browser` has open claims of its own (app-layer CR-T runs NOT RUN, CR-59/60 to move to `cr-e2e` per decision 9), so re-recording `cr-recon` alone would not unblock this record, and recording those items is their own record work, not this one's. `align.py check --doc curriculum-runtime` at the same tree exited 1 with `BROKEN cr-recon` only; no link of `cr-memory` is broken. Once the chain is recorded, this report is the evidence to cite for this item's record, with the command above; CR-T02 carries a PARTIAL result and CR-35 is partial, as the claim table says.
