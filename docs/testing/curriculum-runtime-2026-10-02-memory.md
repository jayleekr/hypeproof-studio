# Curriculum Runtime run record — `cr-memory` (#1395)

Status: run record, 2026-10-02. Item `cr-memory`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). Decisions and deviations: [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-memory). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

## Claims

| | Rows | Why |
|---|---|---|
| Claimed | CR-36, CR-37, CR-38, CR-40, CR-41, CR-42, CR-75, CR-76, CR-77, CR-78, CR-82 | Every positive and negative control of their CR-T rows ran (below); CR-36 also in the app |
| Re-run, as the plan asks | CR-39 | CR-T80 re-run by this item: the cr-publish records are read and revised in place, no table beside them |
| Claimed with a recorded deviation (reviewer to accept or reject) | CR-79 | Revisions, their decision and their evidence are recorded in the Hypothesis document (Venture Memory, D1) with references into the measurement-core record, not as a `decision_revised` learning event (plan, deviations). Every CR-T74 control ran |
| Partial, remainder named | CR-35 | Stored and linked: Project and Problem, Stakeholders, Hypotheses, Experiments, Observations and EvidenceItems (by reference), Decisions, ProductVersions, Metrics, DeckSlides (8). Not in this read: WeeklyReviews (their pack is `cr-review`'s design, recon R9) and AIUsage (per-project attribution is `cr-gateway`'s, CR-34); the memory read names both as `not_in_this_read` |
| Partial, remainder named | CR-02 | Memory surfaces only: the twelve routes, the command and the three webview messages are off with the switch off and reachable with it on, in the Worker and in the app. CR-T02's `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1, as for the earlier items |

So the PR says `Refs #1395`.

## What was run

- Code: branch `feat/cr-memory` off `origin/main` `34d42b3b`; Service commit `91c8c64a`, App commit `81b0055f`. The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15.7.4. Node 24.4.1. HypeProof Studio 0.1.51 copy (from `/Applications`) with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked (gate passed on the first attempt, 2026-10-02 05:55 KST).
- Evidence classes (MC-38): **synthetic** = unit, smoke and worker layers (the real Service router over SQLite, or local workerd D1 and R2 with `--d1`); **live-host (app) / synthetic (Service)** = `e2e/curriculum-runtime/memory-app.spec.ts` in the Studio app with `app-service.mjs publish`.
- No real phone or real classroom run; none is named by these rows.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (memory surfaces) | worker `cr-memory.test.mjs`, `cr-publish.test.mjs` (its router-wide walk covers the twelve new routes), `cr-switch.test.mjs`; extension `cr-switch.smoke.mjs`; in-app `memory-app.spec.ts` | PARTIAL (CR-02 partial) | Off: every memory route with real ids, with a student, a director and no token, answers exactly as an unknown route (status, body, headers); the command is absent from the palette in the app (control: an existing command is found) and no panel appears. On: the memory read answers a member and an in-scope director, the director list answers. A planted route that ignores the switch is caught; M10 caught |
| CR-T35 | worker `cr-memory.test.mjs` (SQLite and local workerd D1/R2) | PASS | The Week 1 → 2 fixture round-trips hypothesis → experiment → evidence item → decision (resulting v1, slides 2–3) → version → slide revisions; artifacts of v0 and v1 validate as CR-42 artifacts and v1's cites the decision's evidence; every evidence item maps onto the CR-40 contract. By reference: the D1 rows hold the `ev:` reference and not the evidence statement. Negative: the store inventory over `schema.sql` and every migration finds no evidence or observation table; planted `cr_evidence_items` and `cr_observations` are caught |
| CR-T36 | in-app `memory-app.spec.ts`; worker `cr-memory.test.mjs` (Service half); extension `cr-memory.smoke.mjs` (App unit) | PASS | In the app: publish, a team decision recorded in the panel ("근거가 연결되지 않았어요" shown), a chat message; close; `User/workspaceStorage` (the chat history and the remembered Project) deleted (control: it existed, and the chat showed the message before); reopen: the chat is empty and the panel shows the same hypothesis, experiment, decision and version ids and texts (`memory-result.json`, 2 passed in 21.4 s). Service: two reads equal, zero outbound calls; deleting the experiment's data changes the read (a computed view, not a snapshot), and the decision's evidence then reads `missing`. Negative: a reconstruction mixing in the chat is caught (in the spec and the smoke); the memory session's code reads no history or workspaceState (control: the check sees a planted read); a lost decision changes the digest |
| CR-T37 | worker `cr-memory.test.mjs` | PASS | A director whose issuer scope covers the cohort and profile lists the team and walks hypothesis → evidence → decision → version. Negative: another cohort's director, the right cohort with another profile, and a student of another team get the unknown-route 404 on the read and the diff; another cohort's director lists nothing; a director cannot write a decision. M9 caught |
| CR-T38 | worker `cr-memory.test.mjs`; extension `cr-memory.smoke.mjs` (render) | PASS | A student decision with two evidence refs and slides 2–3 is stored with actor student and its member. Negative: a missing item, a missing draft, another project's experiment and a non-`ev:` ref → 409; a missing author → 400; an AI decision is `ai_suggestion` in the read, in the timeline and in the panel ("AI 제안 (팀 결정 아님)"); a decision with no evidence is shown and marked. The instrument catches a hidden no-evidence decision, a missing mark and an AI decision shown as the team's. M5, M6 caught |
| CR-T39 | worker `cr-memory.test.mjs` | PASS | The PRD §10.2–10.4 samples validate. Negative: each sample with any one required field removed is refused by name; an observed item with empty `source_refs`, slide 9, and an artifact with no, empty, non-HTML or escaping `entry_html` are refused (controls: an assumption with no source, slides 1 and 8, a null `resulting_version_id` validate) |
| CR-T70 | worker `cr-memory.test.mjs`; extension `cr-memory.smoke.mjs` | PASS | A stakeholder with user and payer (observed, with resolvable evidence) and beneficiary (no evidence) shows user/payer observed, beneficiary assumed, and the payer-and-user overlap; a hypothesis and an experiment name it. Negative: no role or an empty role list → 400 `missing:roles`; an observed role with no refs → 400; an observed role with a dangling ref → 409; an unknown stakeholder → 409. M8 caught |
| CR-T71 | worker `cr-memory.test.mjs` | PASS | Three real `task_complete` events → value 3 with three `event:` refs, `source_state` real; one simulated and one self-reported input are labelled in `not_counted` and not in the value. Negative: a planted value counting the simulated input is caught; only simulated inputs or an experiment of another project → `unsupported`, no value; an impact metric with no stakeholder → refused (pure and route); a metric over another project's experiment → 409. M3 caught |
| CR-T72 | worker `cr-memory.test.mjs` | PASS | v0 → v1: `help.html` added, `index.html` modified, the decision with both evidence refs resolving; reversed arguments still compare older → newer. Negative: another project's version → 409 `cross_project` (route) and refused (pure, both versions handed in); a newer version with no recorded decision → `no_recorded_decision`, no reason field. M7 caught |
| CR-T73 | worker `cr-memory.test.mjs` | PASS | The Week 1 → 2 timeline holds every entry kind (hypothesis, its revision, experiment, versions, evidence items, the decision, an AI suggestion, slide revisions), is time-ordered, every entry opens its stored record, and the read makes zero outbound calls. Negative: a planted entry with no record and an AI suggestion relabelled as a decision are caught. M5 caught |
| CR-T74 | worker `cr-memory.test.mjs`; extension `cr-memory.smoke.mjs` (sentence) | PASS | A hypothesis revised with the team's decision shows before, after, the decision and its two evidence items; every earlier statement kept. Negative: a revision with no decision → `reason_not_recorded` and the sentence "왜 바뀌었는지는 기록되지 않았어요."; a stale revision → 409; an AI suggestion as the reason → 409; the revision check catches a rewritten first revision and an in-place replacement. M4, M12 caught |
| CR-T77 | worker `cr-memory.test.mjs` | PASS | Two observed, one interpreted and two assumed items listed by confidence, each assumption with the decision and slides citing it; the student's promotion citing two real participant sessions moves one assumption to observed (`observed_later`, the promoting revision named), its earlier revisions readable with the same statement. Negative: a dangling `assumption_refs` entry and one pointing at an observed item → 409 by name (control: an assumed one is accepted); a promotion with no sources, with an evidence-item ref, an `ai:` or `skill:` statement as its only basis → 400; a session that does not exist → 422; a changed statement or a non-assumption → 400; no refused promotion wrote a revision; a different document at a stored revision → `revision_exists`; an AI-authored revision that turns an assumption into an observation leaves it assumed (control: the student's own does not). M1, M2, M11 caught |
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

## NOT RUN

- CR-T02's `09-preview.spec.ts` switch-off baseline in the app: BLOCKED by pre-existing F1 (as recorded by `cr-browser`); not re-run here.
- No real phone, no real classroom; no production D1, R2 or Worker. Migration 0034 is not applied anywhere but local test databases.

## Findings (not changed here)

- `extensions/hypeproof-chat` `npm run test:instructor-render` fails (14 of 14) when run from any worktree under the home directory on this Mac: esbuild resolves `react` for the test file from a stray `~/node_modules/react` (19.1.0) while the components use `webview-ui/node_modules/react` (18.3.1), so two Reacts render ("Objects are not valid as a React child"). The same test passes 14 of 14 on a clean `origin/main` checkout under `/private/tmp` with the same dependencies, and on this branch's code copied there; CI is unaffected. Local environment, not product.
- The script writes its bundle to the fixed path `/tmp/instructor-render.test.cjs`, which concurrent runs on one machine share.
