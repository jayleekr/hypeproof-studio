# Curriculum Runtime — delivery plan

Status: active plan, no work item started. 2026-09-29. Owner: jayleekr. Epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Intent: [INT-CR-00–09](../intents/curriculum-runtime.md) · requirements: [CR-01–71](../requirements/curriculum-runtime.md) · verification: [CR-T01–T66](../testing/curriculum-runtime.md) · ledger: [`config/requirement-work.json`](../../config/requirement-work.json) (work items `cr-*`) · execution index: [requirements-activation](requirements-activation.md#curriculum-runtime).

This document owns the order of the Curriculum Runtime work and what "done" means for each step. The ledger's `depends_on` is the machine-readable copy of the DAG below; if they disagree, the ledger wins and this page is fixed. Work availability (ready / claimed / in review / dependency) comes from `python3 scripts/next-work.py`, never from this page.

## Phases → work items

PRD §13 phases, in PRD §16 priority order, one work item and one execution issue each. Each implementation item is one slice: issue → worktree off `origin/main` → PR → merge → evidence.

| PRD phase | Work item | Issue | Kind | Requirements | Depends on | Earliest week |
|---|---|---|---|---|---|---|
| Phase 0 — reconnaissance | `cr-recon` | [#1390](https://github.com/jayleekr/hypeproof-studio/issues/1390) | design | CR-01 | — | W1 |
| Phase 1 — Experiment Browser | `cr-browser` | [#1391](https://github.com/jayleekr/hypeproof-studio/issues/1391) | implementation | CR-02–11, CR-59, CR-60, CR-68 | `cr-recon` | W1 |
| Phase 1 — AI Verify | `cr-verify` | [#1392](https://github.com/jayleekr/hypeproof-studio/issues/1392) | implementation | CR-03, CR-12–16, CR-61 | `cr-browser` | W2 |
| Phase 2 — Publish | `cr-publish` | [#1393](https://github.com/jayleekr/hypeproof-studio/issues/1393) | implementation | CR-17–22, CR-64–66 | `cr-verify` | W1 |
| Phase 2 — Evidence | `cr-evidence` | [#1394](https://github.com/jayleekr/hypeproof-studio/issues/1394) | implementation | CR-23–28, CR-65, CR-67, CR-69, CR-70 | `cr-publish` | W1 |
| Phase 3 — Venture Memory | `cr-memory` | [#1395](https://github.com/jayleekr/hypeproof-studio/issues/1395) | implementation | CR-35–42 | `cr-evidence` | W1 |
| Phase 3 — Curriculum Skills | `cr-skills` | [#1396](https://github.com/jayleekr/hypeproof-studio/issues/1396) | implementation | CR-43–47 | `cr-memory` | W1 |
| Phase 4 — AI Gateway | `cr-gateway` | [#1397](https://github.com/jayleekr/hypeproof-studio/issues/1397) | implementation | CR-29–34, CR-70 | `cr-memory` | W2 |
| Phase 5 — Weekly Review + Director | `cr-review` | [#1398](https://github.com/jayleekr/hypeproof-studio/issues/1398) | implementation | CR-48–53, CR-62 | `cr-skills` | W2 |
| Phase 6 — Deck lifecycle | `cr-deck` | [#1399](https://github.com/jayleekr/hypeproof-studio/issues/1399) | implementation | CR-54–58, CR-63 | `cr-review` | W2 |
| §14 — end-to-end loop | `cr-e2e` | [#1400](https://github.com/jayleekr/hypeproof-studio/issues/1400) | validation | CR-71, CR-02 | `cr-deck` | W1 |

Rows shared by two items (CR-02, CR-03, CR-65, CR-70) are established by the first item and re-checked by the second; the second does not re-implement them. §11 targets and §12 rows sit in the item whose code they constrain; there is no separate performance or safety slice.

## Dependency DAG

```mermaid
graph LR
  recon[cr-recon] --> browser[cr-browser] --> verify[cr-verify] --> publish[cr-publish] --> evidence[cr-evidence] --> memory[cr-memory]
  memory --> skills[cr-skills] --> review[cr-review] --> deck[cr-deck] --> e2e[cr-e2e]
  memory --> gateway[cr-gateway]
```

- The spine follows PRD §16: Experiment Browser → Publish / User Test → Evidence → Venture Memory → Curriculum Skills → Weekly Review + Deck → AI Gateway optimisation.
- `cr-gateway` starts once `cr-memory` is complete and runs in parallel with `cr-skills`, `cr-review` and `cr-deck`. Its attribution dimensions (project, skill) need memory entities; nothing on the spine needs the gateway.
- `cr-e2e` depends on `cr-deck` only. PRD §14 makes the Week 1 → Week 2 loop the first milestone, "not completion of every P0 feature"; the loop does not call the student-app gateway.

## Ranking rule for the next slice

When more than one item is ready, order by: (1) dependency order; (2) priority (all CR rows are P0); (3) the earliest curriculum week among the item's requirements (the Weeks column of the requirements). The Harness `hype-align` skill applies this rule; this page only states it.

## Gap matrix — provisional, to be confirmed by `cr-recon`

Built from the 2026-09-29 reading of Studio `origin/main` (b95093fc). It is a lead, not a verdict: `cr-recon` (CR-01) confirms or corrects each line with exact paths and symbols and replaces this table.

| PRD item | Maturity today | Reuse (verified to exist) | New work |
|---|---|---|---|
| P0-1 Experiment Browser | Partial, strong base | `extensions/hypeproof-chat/src/browserControl.ts` (`BrowserControl.execute`: navigate, read with `[ref=eN]` snapshot, screenshot, click, type, back, forward, dialog; `loadInPinnedTab`), `cdpSession.ts`, `browserControlHelpers.ts` (`buildAxSnapshot`), `browserMcp.ts` (`mcp__hypeproof__browser_{open,screenshot,read,click,type}`, `live_preview_start`), `nativeBrowser.ts` (`capturePageContext`), `liveServer.ts`, `previewProvider.ts`, ADR 0002; upstream `vscodium-base/vscode/src/vs/workbench/contrib/browserView/electron-browser/{features,tools}` via patches only | Console, runtime and network capture (no `Runtime.consoleAPICalled` / `exceptionThrown` / `Network.loadingFailed` handling exists); select, scroll, hover, reload; element → coach context; binding results to an artifact version; origin scope for the runner |
| P0-2 AI Verify | None | `criterion_set` / `test_observed` / `retest_confirmed` in `worker/src/lib/measurement-core/learning-events.ts`; AE-05/18/37 review validity (#557); `webview-ui/src/EvidenceDrawer.tsx` | "Test my product" action; criteria runner; `hps-verification/1` report |
| P0-3 Publish | Minimal | `galleryPublish.ts` → Lab `POST /api/gallery/publish` (Supabase storage); WEB-07/08/09; work item `publish-recovery` (#1018) | Immutable content-addressed test versions, QR, expiry and revocation, anonymous participant sessions, experiment attribution |
| P0-4 Evidence | Partial | `learning-events.ts` (eight kinds, `evidence_refs`, `source_state`), `measurement-core/{evidence,interpretation,legacy-observation}.ts` (`hps-observation/1`, `teacher_state`), `nativeObservationRecorder.ts`, `sessionSpool.ts`, `evidenceSnapshot.ts`; SX-17–24, SX-44–48, MC-* | Participant events from published pages, five manual record kinds, Observed / Interpreted / Assumed drafts with `source_refs`. SX-48: extend, never fork |
| P0-5 AI Gateway | Strong for the coach | `worker/src/routes/chat.ts` (`/v1/chat/completions`), `routes/messages.ts` (`/v1/messages`), `env.ts` (`LLMProvider`: gemini, anthropic, openai, glm), `lib/{budgets,budget-admission,usage-costs,model-usage,access-contracts,lesson-model-policy,model-caps}.ts`, `routes/access.ts` | CORS endpoint and app tokens for student apps, capability vocabulary and policy mapping, hard credit ceiling for app calls, curriculum attribution dimensions, mock adapter |
| P0-6 Venture Memory | Minimal | Learning-event log, `worker/src/lib/session-design.ts` (`hps-session-design/1`), `localReviewService.ts`, `localRecordFile.ts` | Project / Hypothesis / Experiment / ProductVersion / Decision / Metric / DeckSlide entities and traversal |
| P0-7 Curriculum Skills | None | Session-design steps, `worker/src/lib/lesson-help-mode.ts`, `worker/src/prompts/`; SDK coach runs with `settingSources: []` (`sdkCoachHelpers.ts`) | Skill contract, registry, loader decision, seven skills |
| P0-8 Weekly Review | Similar feature exists | `worker/src/lib/classroom-{evaluator,report,report-html}.ts` (`hps-classroom-report-draft/1`, `next_experiment`) | Per-team pack, staleness by source digest, "Prepare Weekly Review", section regeneration, director decision write-back, four-team overview |
| P0-9 HTML Deck | None | HTML preview runtime | Eight-slide state, patch proposals with accept / reject, evidence refs, unsupported-number flags, change view |

## Existing work that CR items build on

CR rows reference these requirements instead of restating them. Their work items keep ownership; a CR PR that also satisfies part of them says so in its body and leaves their completion to their own items. Owners below are read from the ledger, not assumed.

| Reused requirement | Owning work item | CR items that build on it |
|---|---|---|
| AE-05, AE-18, AE-19, AE-37, WEB-06 | `review-validity` [#557](https://github.com/jayleekr/hypeproof-studio/issues/557) | `cr-browser`, `cr-verify` |
| AE-02 | `context` [#555](https://github.com/jayleekr/hypeproof-studio/issues/555) | `cr-browser` |
| AE-23 | `computer-use` [#752](https://github.com/jayleekr/hypeproof-studio/issues/752) | `cr-browser` |
| WEB-04 | `acceptance-chalk-authoring` [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) | `cr-browser`, `cr-publish` |
| WEB-07, WEB-08 | `publish-recovery` [#1018](https://github.com/jayleekr/hypeproof-studio/issues/1018) | `cr-publish` |
| SX-14, SX-15, SX-17, SX-19–22, SX-24, SX-44–48 | `sx-p1-evidence-capture` [#1172](https://github.com/jayleekr/hypeproof-studio/issues/1172) | `cr-verify`, `cr-evidence`, `cr-memory`, `cr-review`, `cr-deck` |
| SX-32 | `sx-p3-change-record` [#1174](https://github.com/jayleekr/hypeproof-studio/issues/1174) | `cr-evidence` |
| SX-38 | `sx-p4-instructor-evidence` [#1175](https://github.com/jayleekr/hypeproof-studio/issues/1175) | `cr-memory`, `cr-review` |
| SX-56, SX-58 | `sx-p0-curriculum-first` [#1171](https://github.com/jayleekr/hypeproof-studio/issues/1171) | `cr-skills`, `cr-deck` |
| HC-04 | `candidate-contract` [#852](https://github.com/jayleekr/hypeproof-studio/issues/852) | `cr-verify` |
| MC-09, MC-14, MC-15, MC-22, MC-31 | `measurement-core-dogfood` [#1020](https://github.com/jayleekr/hypeproof-studio/issues/1020) | `cr-browser`, `cr-verify`, `cr-evidence`, `cr-memory` |
| AE-25, AE-28, AE-30, AE-33 | `model-routing` [#1009](https://github.com/jayleekr/hypeproof-studio/issues/1009) | `cr-gateway` |
| MU-01, MU-02, MU-03, MU-05, MU-08 | `acceptance-model-access-usage` [#830](https://github.com/jayleekr/hypeproof-studio/issues/830) | `cr-gateway` |
| AB-03–08, AB-15 | `acceptance-access-budget-settlement` [#857](https://github.com/jayleekr/hypeproof-studio/issues/857) | `cr-gateway`, `cr-skills`, `cr-evidence` |
| VO-37 | `voice-898` [#898](https://github.com/jayleekr/hypeproof-studio/issues/898) | `cr-publish` |

## Member catalog feature IDs (planned)

`feature_ids` on the `cr-*` items name member-catalog features that the Lab resync will add: `experiment-browser`, `ai-verify`, `user-test-publish`, `evidence-capture`, `venture-memory`, `curriculum-skills`, `weekly-review`, `ir-deck`. The gateway maps to the existing `models-usage` and `budget-settlement`. Until Lab adds them, the Lab work sync reports the `cr-*` items as unassigned; that is expected and is fixed on the Lab side, not by removing items here.

## Decisions still open

These block a default value, not the design. Ask Jay when the slice reaches them; do not pick a value in code.

- Default expiry of a published test link (CR-19). Until decided, publishing requires an explicit expiry.
- Default retention period for declared raw participant input (CR-67).
- Consent path for minor cohorts and external participants who are minors (Lab MISSION child-safety decision).
- Any breaking change to a stored schema (`hps-observation/1`, `hps-session-design/1`, usage ledgers).

## What "done" means

- A work item is complete only with a `completion` record in the ledger that pins the requirement, verification and implementation inputs (see [requirements-activation](requirements-activation.md) "완료와 재개"), reviewed by someone other than the implementer, with every targeted CR-T row run and its evidence class stated. A merged PR without test evidence is not completion.
- Synthetic or captured-replay passes are not the real-device run; CR-71 needs one live-host run on a real Mac with a real phone.
- The first milestone is CR-71. If that loop is not reliable, richer model options or templates are premature (PRD §14).
