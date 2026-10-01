# Curriculum Runtime run record — `cr-memory` (#1395)

Status: run record, 2026-10-02. Item `cr-memory`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). Decisions and deviations: [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-memory). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

## Claims

| | Rows | Why |
|---|---|---|
| Claimed | CR-36, CR-37, CR-38, CR-40, CR-41, CR-42, CR-75, CR-76, CR-77, CR-78, CR-82 | Every positive and negative control of their CR-T rows ran (below); CR-36 and CR-78 also in the app. CR-82's student path is the Service review route only: the App shows a promotion but has no promote control in this slice (plan, deviations) |
| Re-run, as the plan asks | CR-39 | CR-T80 re-run by this item: the cr-publish records are read and revised in place, no table beside them |
| Claimed with a recorded deviation, accepted by the round-2 reviewer (acceptance lens) | CR-79 | Revisions, their decision and their evidence are recorded in the Hypothesis document (Venture Memory, D1) with references into the measurement-core record, not as a `decision_revised` learning event (plan, deviations). Every CR-T74 control ran |
| Partial, remainder named | CR-35 | Stored and linked: Project and Problem, Stakeholders, Hypotheses, Experiments, Observations and EvidenceItems (by reference), Decisions, ProductVersions, Metrics, DeckSlides (8). Not in this read: WeeklyReviews (their pack is `cr-review`'s design, recon R9) and AIUsage (per-project attribution is `cr-gateway`'s, CR-34); the memory read names both as `not_in_this_read` |
| Partial, remainder named | CR-02 | Memory surfaces only: the twelve routes, the command and the three webview messages are off with the switch off and reachable with it on, in the Worker and in the app. CR-T02's `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1, as for the earlier items |

So the PR says `Refs #1395`. The set the completion record names is exactly this table: claimed CR-36, CR-37, CR-38, CR-40, CR-41, CR-42, CR-75, CR-76, CR-77, CR-78, CR-79 (deviation accepted), CR-82; CR-39 re-run; CR-02 and CR-35 partial.

## What was run

- Code: branch `feat/cr-memory` off `origin/main` `34d42b3b`; Service commit `91c8c64a`, App commit `81b0055f`, review fixes in the commit after `100c3fb7` (round 1). The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15.7.4. Node 24.4.1. HypeProof Studio 0.1.51 copy (from `/Applications`) with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked (gate passed on the first attempt, 2026-10-02 05:55 KST; re-run with the round-1 fixes injected, gate passed, 2 passed in 16.7 s, 2026-10-02 about 06:20 KST).
- Evidence classes (MC-38): **synthetic** = unit, smoke and worker layers (the real Service router over SQLite, or local workerd D1 and R2 with `--d1`); **live-host (app) / synthetic (Service)** = `e2e/curriculum-runtime/memory-app.spec.ts` in the Studio app with `app-service.mjs publish`.
- No real phone or real classroom run; none is named by these rows.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (memory surfaces) | worker `cr-memory.test.mjs`, `cr-publish.test.mjs` (its router-wide walk covers the twelve new routes), `cr-switch.test.mjs`; extension `cr-switch.smoke.mjs`; in-app `memory-app.spec.ts` | PARTIAL (CR-02 partial) | Off: every memory route with real ids, with a student, a director and no token, answers exactly as an unknown route (status, body, headers); the command is absent from the palette in the app (control: an existing command is found) and no panel appears. On: the memory read answers a member and an in-scope director, the director list answers. A planted route that ignores the switch is caught; M10 caught |
| CR-T35 | worker `cr-memory.test.mjs` (SQLite and local workerd D1/R2) | PASS | The Week 1 → 2 fixture round-trips hypothesis → experiment → evidence item → decision (resulting v1, slides 2–3) → version → slide revisions; artifacts of v0 and v1 validate as CR-42 artifacts and v1's cites the decision's evidence; every evidence item maps onto the CR-40 contract. By reference: the D1 rows hold the `ev:` reference and not the evidence statement. Negative: the store inventory over `schema.sql` and every migration finds no evidence or observation table; planted `cr_evidence_items` and `cr_observations` are caught |
| CR-T36 | in-app `memory-app.spec.ts`; worker `cr-memory.test.mjs` (Service half); extension `cr-memory.smoke.mjs` (App unit) | PASS | In the app: publish, a team decision recorded in the panel ("근거가 연결되지 않았어요" shown), a chat message; close; `User/workspaceStorage` (the chat history and the remembered Project) deleted (control: it existed, and the chat showed the message before); reopen: the chat is empty and the panel shows the same hypothesis, experiment, decision and version ids and texts (`memory-result.json`, 2 passed in 21.4 s). Service: two reads equal, zero outbound calls; deleting the experiment's data changes the read (a computed view, not a snapshot), and the decision's evidence then reads `missing`. Negative: the real `MemorySession` and a planted copy of the same source file that also turns chat messages into decisions are both run through the before/after comparison with and without a chat; the real one is equal, the planted one is caught (smoke). The spec's own controls are that the chat existed before the deletion and is gone after it; the earlier string-only "leaky" check in the spec and the smoke was a tautology and is removed. The memory session's code reads no history or workspaceState; a lost decision changes the digest |
| CR-T37 | worker `cr-memory.test.mjs` | PASS | A director whose issuer scope covers the cohort and profile lists the team and walks hypothesis → evidence → decision → version. Negative: another cohort's director, the right cohort with another profile, and a student of another team get the unknown-route 404 on the read and the diff; another cohort's director lists nothing; a director cannot write a decision. M9 caught |
| CR-T38 | worker `cr-memory.test.mjs`; extension `cr-memory.smoke.mjs` (render) | PASS | A student decision with two evidence refs and slides 2–3 is stored with actor student and its member. Negative: a missing item, a missing draft, another project's experiment and a non-`ev:` ref → 409; a missing author → 400; an AI decision is `ai_suggestion` in the read, in the timeline and in the panel ("AI 제안 (팀 결정 아님)"); a decision with no evidence is shown and marked. The instrument catches a hidden no-evidence decision, a missing mark and an AI decision shown as the team's; through the real panel, an answer mislabelling the AI suggestion is drawn as "팀 결정" (so the render check would catch it). An assumed item in `evidence_refs`, alone or also in `assumption_refs` → 409 `evidence_ref_is_assumption`; a team decision citing an unreviewed AI draft item → 409 `evidence_ref_not_reviewed` (controls: an AI suggestion may cite it; after the student's review the team may). M5, M6, N9, N10 caught |
| CR-T39 | worker `cr-memory.test.mjs` | PASS | `created_by` (CR-40) is the author of the item's first revision: an AI item the student accepted stays `system`, now reviewed (`pending_review` false), and the item the student did not touch stays `system` and `pending_review` (control: a student-authored draft's items are the student's); N4 and N7 (round 2) caught. The PRD §10.2–10.4 samples validate. Negative: each sample with any one required field removed is refused by name; an observed item with empty `source_refs`, slide 9, and an artifact with no, empty, non-HTML or escaping `entry_html` are refused (controls: an assumption with no source, slides 1 and 8, a null `resulting_version_id` validate) |
| CR-T70 | worker `cr-memory.test.mjs`; extension `cr-memory.smoke.mjs` | PASS | A stakeholder with user and payer (observed, with resolvable evidence) and beneficiary (no evidence) shows user/payer observed, beneficiary assumed, and the payer-and-user overlap; a hypothesis and an experiment name it. Negative: no role or an empty role list → 400 `missing:roles`; an observed role with no refs → 400; an observed role with a dangling ref → 409; an observed role over only an assumed or only an interpreted item → 409 `observed_role_without_observed_evidence` (control: one observed item among them is accepted); an unknown stakeholder → 409; another Project's stakeholder → 409 `stakeholder_unresolved` on a new hypothesis, on naming an experiment's stakeholder and at an experiment's start (control: this Project's stakeholder at the start is accepted); after the experiment's data is deleted (CR-69) the roles resting on it read `unsupported` and the experiment's stakeholder can no longer be set. Pure: the role's confidence is derived (observed over a reviewed observed item, assumed over assumptions or an unreviewed AI item, unsupported when nothing resolves). Store race: with the deletion's close interleaved before the write, the stakeholder write refuses and the closed record stays closed; a planted unguarded write reopens it and is caught. The panel draws an unsupported role as "(근거를 찾을 수 없어요)". M8, N5, N6, N7, N8, N13, N14, S5 caught |
| CR-T71 | worker `cr-memory.test.mjs` | PASS | Three real `task_complete` events → value 3 with three `event:` refs, `source_state` real; one simulated and one self-reported input are labelled in `not_counted` and not in the value. Negative: a planted value counting the simulated input is caught; only simulated inputs or an experiment of another project → `unsupported`, no value; an impact metric with no stakeholder → refused (pure and route); a metric over another project's experiment → 409. An `evidence_only` metric carries each cited item's confidence and the panel draws it as "숫자 없이 근거 N개 (확인한 것 1, 해석 1)", not "근거가 되는 실제 기록이 없어요". M3, N17, S2 caught |
| CR-T72 | worker `cr-memory.test.mjs` | PASS | v0 → v1: `help.html` added, `index.html` modified, the decision with both evidence refs resolving; reversed arguments still compare older → newer. Negative: another project's version → 409 `cross_project` (route) and refused (pure, both versions handed in); a newer version with no recorded decision → `no_recorded_decision`, no reason field; an AI suggestion linked to the newer version still reads `no_recorded_decision` with no decisions. M7, N11 caught |
| CR-T73 | worker `cr-memory.test.mjs` | PASS | The Week 1 → 2 timeline holds every entry kind (hypothesis, its revision, experiment, versions, evidence items, the decision, an AI suggestion, slide revisions), is time-ordered, every entry opens its stored record, and the read makes zero outbound calls. The App opens every entry of the same real read from the answer (`timelineRecord`, the panel's path), and in the app a timeline entry opens to its record with no entry left without one (`memory-app.spec.ts`). Negative: a planted entry with no record, one per kind (decision, hypothesis revision, experiment, evidence item, slide revision, product version), is caught on the Service and in the App; an AI suggestion relabelled as a decision is caught; the panel draws a dangling entry as "이 기록을 찾을 수 없어요" (render). M5, N12, N18, S1, S4 caught |
| CR-T74 | worker `cr-memory.test.mjs`; extension `cr-memory.smoke.mjs` (sentence) | PASS | A hypothesis revised with the team's decision shows before, after, the decision and its two evidence items; every earlier statement kept. Negative: a revision with no decision → `reason_not_recorded` and the sentence "왜 바뀌었는지는 기록되지 않았어요."; a revision citing evidence but no team decision → `reason_not_recorded` (evidence still listed); a stale revision → 409; an AI suggestion as the reason → 409; the revision check catches a rewritten first revision and an in-place replacement. M4, M12, N1 caught |
| CR-T77 | worker `cr-memory.test.mjs` | PASS | Two observed, one interpreted and two assumed items listed by confidence, each assumption with the decision and slides citing it; the student's promotion citing two real participant sessions moves one assumption to observed (`observed_later`, the promoting revision named), its earlier revisions readable with the same statement. Negative: a dangling `assumption_refs` entry and one pointing at an observed item → 409 by name (control: an assumed one is accepted); a promotion with no sources, with an evidence-item ref, an `ai:` or `skill:` statement as its only basis → 400; a session that does not exist → 422; a changed statement or a non-assumption → 400; an edit and a promotion of one item in one batch → 400 `duplicate_item_action`; a promotion citing a note marked simulated, or a real note together with a self-reported one → 422 `promotion_source_not_real` (control: a real note is accepted); no refused promotion wrote a revision; a different document at a stored revision → `revision_exists`; an AI-authored revision that turns an assumption into an observation leaves it assumed (control: the student's own does not). M1, M2, M11, N2, N3 caught |
| CR-T80 (re-run) | worker `cr-memory.test.mjs`; `cr-publish.test.mjs` | PASS | The §10.1 sample validates and every field removed is refused; the additive `stakeholder_id` validates. The memory read returns the experiment and hypothesis cr-publish stored, the hypothesis revised in place (one row each in D1). Negative: an unresolved hypothesis at start → 409; a planted `cr_hypothesis_revisions` table beside the storage is caught |

## Controls red on the pre-implementation tree

- On `origin/main` `34d42b3b` with this branch's test file copied in, `worker/test/cr-memory.test.mjs` exits 1 before any case: `ERR_MODULE_NOT_FOUND` for `worker/src/lib/curriculum/memory.ts`.
- Planted defects, each into a scratch copy of the implementation (`origin/main` plus this branch's diff), the suite run after each; the baseline with nothing planted is all green:

| | Defect planted | Turned red |
|---|---|---|
| M1 | `assumption_refs` accept an item whose confidence is observed | CR-T77 negatives |
| M2 | an AI revision promotes an assumption | CR-T77 negatives |
| M3 | a simulated input counted into the metric result | CR-T71 |
| M4 | a belief change with no evidence reads "recorded" | CR-T74 |
| M5 | an AI suggestion shown as a decision in the timeline | CR-T38, CR-T73 |
| M6 | an AI decision shown as the team's | CR-T38 |
| M7 | the diff no longer refuses versions of two projects | CR-T72 |
| M8 | an observed role accepted with no evidence | CR-T70 |
| M9 | the director's scope check dropped | CR-T37 |
| M10 | the memory read answers with the switch off | CR-T02, CR-T37 |
| M11 | a promotion with no sources accepted | CR-T77 negatives |
| M12 | the hypothesis revision check stops comparing earlier revisions | CR-T74 |

Round-1 review fixes, planted the same way (each into the working tree, suite run, file restored; `mutate.py` in the scratch directory). Every one turned the named suite red:

| | Defect planted | Turned red |
|---|---|---|
| N1 | a belief change with evidence but no team decision reads "recorded" | worker (CR-T74) |
| N2 | a promotion citing a simulated note accepted | worker (CR-T77 negatives) |
| N3 | two actions on one item in a batch accepted | worker (CR-T77 negatives) |
| N4 | `created_by` taken from the whole draft's latest author | worker (CR-40) |
| N5 | a role's confidence read from its stored claim and ref count | worker (CR-T70) |
| N6 | an observed role over assumptions only stored | worker (CR-T70) |
| N7 | the stakeholder write without the revision guard | worker (store race) |
| N8 | the stakeholder write on a deleted experiment | worker (CR-T70, store race) |
| N9 | an assumed item accepted in `evidence_refs` | worker (CR-T38) |
| N10 | an unreviewed AI item accepted as a team decision's evidence | worker (CR-T38) |
| N11 | the diff's student filter dropped (an AI suggestion becomes the reason) | worker (CR-T72) |
| N12 | `openRecord` finds every evidence item | worker (CR-T73) |
| N13 | another Project's stakeholder accepted by `ownStakeholder` | worker (CR-T70) |
| N14 | the stakeholder check at an experiment's start dropped | worker (CR-T70) |
| N15 | a slide citing a dangling ref accepted | worker (CR-35 writes) |
| N16 | a second Problem statement replaces the first | worker (CR-35 writes) |
| N17 | `evidence_only` without the cited items' confidence | worker (CR-T71) |
| N18 | the memory read without slide revisions | worker (CR-T73, App open) |
| N19 | a slide naming an AI suggestion accepted | worker (CR-35 writes) |
| S1 | the panel's timeline without its record | smoke (render) |
| S2 | an `evidence_only` metric drawn as "no real records" | smoke (render) |
| S3 | an unreviewed AI item offered as evidence in the decision form | smoke (render) |
| S4 | `timelineRecord` cannot open a slide revision | smoke (CR-78, render) |
| S5 | an unsupported role drawn without its label | smoke (render) |

A planted promotion-statement check removal alone is not caught: the one-action-per-item rule refuses the only batch that could reach it, and the statement check stays as the second guard.

Round-2 review fixes and the round-2 reviewer's surviving plants, planted the same way into this worktree (`mutate.py` in the scratch directory `fix-cr-memory-r2/`, each file restored after its run; log `mut.log`). Every one turned the named suite red:

| | Defect planted | Turned red |
|---|---|---|
| R1 | an AI suggestion accepted as the decision behind a belief change (pure) | worker (CR-T74 unit) |
| R2, R3 | an AI suggestion's slides counted in the register; its version counted in the chain | worker (CR-T77) |
| R4 | the director read without the Project profile's switch check | worker (CR-T02, mixed scope) |
| R5 | the director list without the scope check | worker (CR-T37, same cohort, other profile) |
| R6 | the director list without the switch check | worker (CR-T02, mixed scope) |
| R7, R16 | membership dropped on the decision version link; on naming an experiment's stakeholder | worker (memory writes, non-member) |
| R10, R26 | a dangling `ev:` ref accepted on a hypothesis revision; on an `evidence_items` metric | worker (CR-T74, memory writes) |
| R11 | a rejected draft item listed as evidence | worker (CR-T77) |
| R12 | `payer_and_user` with `||` | worker (CR-T70, one role only) |
| R13 | another Project's stakeholder accepted on a metric | worker (memory writes) |
| R15 | a revoked director token reads memory | worker (CR-T37) |
| R18 | the register ignores a slide's own `evidence_refs` | worker (CR-T77) |
| R21 | `assumption_refs` accept an interpreted item | worker (CR-T77 negatives) |
| R24, R25 | another Project's decision on a slide; on a hypothesis revision | worker (memory writes) |
| R28 | another Project's `experiment_id` on a decision | worker (memory writes) |
| R48 | slide 9 accepted | worker (CR-35 writes) |
| R51 | an observed role over an interpreted item only | worker (CR-T70) |
| N1 (r2) | a hypothesis revision citing only an assumption or an unreviewed AI item accepted | worker (CR-T74) |
| N2 (r2) | a belief change counts any resolving item as what the team saw | worker (CR-T74 unit) |
| N3, N4, N8 (r2) | an item on a simulated note supports an observed role; is accepted as a team decision's evidence; note states not read | worker (SX-46 sources_real) |
| N5 (r2) | `setMembers` writes the Project it was handed (erases a problem revision) | worker (CR-35 store race) |
| N6 (r2) | the promotion's note check fails open on an unknown note | worker (CR-T77 negatives) |
| N7 (r2) | `created_by` counts acceptance as authorship | worker (CR-40) |
| S6, S7 | the panel offers an item on an unreal record as evidence; does not mark it | smoke (render) |

Still surviving, not in the round-2 findings: R29 (a participant event with no session id counted into a metric result). Reported as a follow-up, not changed here.

## NOT RUN

- CR-T02's `09-preview.spec.ts` switch-off baseline in the app: BLOCKED by pre-existing F1 (as recorded by `cr-browser`); not re-run here.
- No real phone, no real classroom; no production D1, R2 or Worker. Migration 0034 is not applied anywhere but local test databases.

## Findings (not changed here)

- `addHypothesis` race: two requests racing on one open statement now answer `open_statement_exists` to the loser (re-checked after the insert is ignored). No test forces that interleaving; the code path is covered only by review.
- `closeExperimentAfterDeletion` and `finishExperimentDeletion` (cr-evidence) still write the experiment row without a revision guard, so a stakeholder set between them can be dropped by `finishExperimentDeletion`'s copy. The new writer refuses on a deleted or pending experiment; guarding the deletion writers is their owner's follow-up.

- `extensions/hypeproof-chat` `npm run test:instructor-render` fails (14 of 14) when run from any worktree under the home directory on this Mac: esbuild resolves `react` for the test file from a stray `~/node_modules/react` (19.1.0) while the components use `webview-ui/node_modules/react` (18.3.1), so two Reacts render ("Objects are not valid as a React child"). The same test passes 14 of 14 on a clean `origin/main` checkout under `/private/tmp` with the same dependencies, and on this branch's code copied there; CI is unaffected. Local environment, not product.
- The script writes its bundle to the fixed path `/tmp/instructor-render.test.cjs`, which concurrent runs on one machine share.
