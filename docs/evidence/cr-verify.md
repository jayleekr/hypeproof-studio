# cr-verify evidence report

Status: evidence for the `cr-verify` completion record (CR-12–CR-16, CR-76 view of CR-81; CR-T15, CR-T16, CR-T76). 2026-10-01. Owner: jayleekr.
Item: `cr-verify`, issue [#1392](https://github.com/jayleekr/hypeproof-studio/issues/1392), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1437](https://github.com/jayleekr/hypeproof-studio/pull/1437), squash-merged as `74eb2309f8807d4185798f3601ff84c8b2d6f6e9`. The implementation's run record with all review rounds is [curriculum-runtime-2026-10-01-evidence.md](../testing/curriculum-runtime-2026-10-01-evidence.md); this report re-runs the review round 3 controls at the merge commit.

What the PR does not claim, and this report does not either: CR-15's vision half (no vision step; CR-15 partial), CR-61 (CR-T57 with a real provider NOT RUN), and CR-02 (CR-T02 switch-off regressions BLOCKED by pre-existing F1). The PR says `Refs #1392`.

## Completion boundary

This report preserves the recorder's test evidence; it does not mark `cr-verify` complete in the ledger. `align.py record cr-verify --commit 74eb2309f8807d4185798f3601ff84c8b2d6f6e9 --pr 1437 --tests CR-T15,CR-T16,CR-T76 --evidence docs/evidence/cr-verify.md --reviewed-by cr-verify:review:regression-conventions:r3` exited 1 with `refused: cr-verify depends on work that is not complete: cr-browser; record or re-record it first`. `cr-browser` has no completion (see [cr-browser.md](cr-browser.md), "Completion boundary"), and `cr-recon`'s completion is reopened by the requirement edit (`align.py check`: `completion no longer holds (changed since recorded: docs/requirements/curriculum-runtime.md)`). At `74eb2309`, CR-T01 (`worker/test/cr-recon.test.mjs`) exits 0 on the recorded verdict and reports six deviations of the tree from the recorded map (CR-59/CR-60 ownership after decision 9) to be recorded in `docs/plan/curriculum-runtime.md`. Re-recording `cr-recon`, then recording `cr-browser`, comes before this item's record can be written; this report is the evidence to cite then.

## Verdict

PASS at `74eb2309` for the eight round 3 controls below (CR-T15 DOM half, CR-T16, CR-T76 and the CR-81 lifecycle cases they carry). Evidence class (MC-38): **synthetic** (unit and smoke layers: scripted CDP page, real `NativeObservationRecorder`, real `VerifyPanel` render). No in-app run, no real model, no real device or phone in this report.

## Reviewers

| Label | Role |
|---|---|
| `cr-verify:review:acceptance:r3` | independent review, acceptance lens, round 3 (PR #1437) |
| `cr-verify:review:adversarial:r3` | independent review, adversarial lens, round 3 (PR #1437) |
| `cr-verify:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 (PR #1437); proposed as `reviewed_by` for the ledger completion |

The recorder is a record-only agent that did not write the implementation.

## Environment

2026-10-01, Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0), Node v24.4.1. Worktree `chore/record-cr-verify` cut from `origin/main` = `74eb2309f8807d4185798f3601ff84c8b2d6f6e9`, no local change while the tests ran (`npm ci` in `packages/measurement`, `worker`, `extensions/hypeproof-chat` and its `webview-ui`).

## Positive controls (unmutated tree)

| Command (from the worktree root) | Result |
|---|---|
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/cr-verify.smoke.mjs` | exit 0, `40 cr-verify checks passed` |
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/verify-panel.smoke.mjs` | exit 0, `7 verify panel checks passed` |
| `cd worker && node --experimental-strip-types --no-warnings --test test/cr-verify.test.mjs` | exit 0, `tests 22 pass 22 fail 0` |

The eight round 3 rows and the checks that carry them, each with its positive control inside the same check:

| Row | Check (as printed) | Control in the check |
|---|---|---|
| CR-T15: a step target past the snapshot cap gives not_verified | smoke "CR-T15: a step target past the snapshot's line cap is not verified, never fail" | a short page without the button gives fail |
| CR-T15/CR-81: 100 logs then an error gives not_verified for both `no_errors` and the text-only plan | smoke "CR-T15/CR-81: no_errors on a page whose event log dropped records is not verified, never pass" | 10 logs: `no_errors` fails, the text-only plan is a warning |
| CR-81, CR-16: run A fails, run B passes with the same words on one version | smoke "CR-81, CR-16: an earlier fail on this version that a later run with the same words passed is shown with its fix action and re-tested": `view.held` shows A as fail with `test_ref`, `fix(A)` is accepted, the re-test re-runs A's plan (fail) | no earlier fail: verified and `held` empty |
| CR-T76 negative extended | smoke "CR-T76 negative: a later start with fewer criteria never hides an earlier warning or not-verified result": the earlier warning or not_verified stays open and the re-test re-runs it | a later pass of the same words clears it |
| `plan_untestable` | smoke "a plan with no steps that only expects an absence is refused (plan_untestable); a step or a positive expectation is accepted": three vacuous zero-step plans refused with nothing recorded | a positive expectation or a reload step accepted |
| `text` word start | smoke "a text expectation matches from a word start: '완료' does not match '미완료'" (also 'complete' does not match 'incomplete') | '주문 완료되었어요', '완료', '(완료)' pass |
| re-test recorder lifecycle | smoke "a re-test holds its recorder until it ends and then lets it go (host release)": `retestActive` from the click, `release()` once at the end; source assertions `retestHeld`, `retestHolds`, `retestRelease` each red on their own planted removal inside the check | the unplanted provider source matches all three |
| verify-panel held fail row | panel "CR-T76 UI positive: an earlier fail on this version that the latest report does not hold is shown with its fix request": one held fail row with exactly one fix button | same report with nothing held: no fail row, no fix button |

Supporting runs at the same tree (exit codes): `extensions/hypeproof-chat` `test/cr-switch.smoke.mjs` 0 (`12 cr-switch checks passed`) · `test/cr-provider-neutral.smoke.mjs` 0 (`5 provider-neutral checks passed`) · `worker` `test/cr-switch.test.mjs` 0 · `python3 scripts/next-work.py --check` 0 · `python3 scripts/check-registry.py` 0. Full `npm test` of `worker` and `extensions/hypeproof-chat` was not re-run by the recorder.

## Negative controls: 13 planted defects

Scratch runner `rec-verify/mutate.py`: each defect planted alone by exact-anchor replacement (anchor count checked to be 1), the affected suites run, the file restored before the next; `git status` clean afterwards.

| Planted defect | File | Result |
|---|---|---|
| M1 runner truncation guard removed (step target past cap) | `verifyRunner.ts` | smoke RED |
| M2 `droppedRecords`/`recordsPartial` carry removed | `verifyRunner.ts` | smoke RED · unit green |
| M3 the view's `held` always empty | `verifySession.ts` | smoke RED · panel green (it renders a given view) |
| M4 the re-test ignores held results | `verifySession.ts` | smoke RED |
| M5 the panel's held block removed | `VerifyPanel.tsx` | panel RED |
| M6 carry limited to fail and non_reproducible | `verification.ts` | smoke RED · unit green |
| M7 `plan_untestable` refusal removed | `verification.ts` | smoke RED · unit green |
| M8 `text` matched by substring (word start check removed) | `verification.ts` | smoke RED · unit green |
| M9 host guard `retestHeld` removed | `chatPanelProvider.ts` | smoke RED |
| M10 host guard `retestHolds` removed | `chatPanelProvider.ts` | smoke RED |
| M11 host guard `retestRelease` removed | `chatPanelProvider.ts` | smoke RED |
| M12 the session never calls `release()` | `verifySession.ts` | smoke RED |
| M13 `retestActive` never true | `verifySession.ts` | smoke RED |
| none (control) | — | smoke GREEN · panel GREEN · unit GREEN |

All 13 RED in at least one suite, the unmutated control all green. The worker unit suite does not catch M2, M6, M7 or M8; those round 3 cases are carried by the extension smoke only (reported, not changed here).

## NOT RUN

- In-app `verify-app.spec.ts` / `app-layer.spec.ts` at `74eb2309`: not re-run by the recorder. The in-app rows of the run record stand on `ed2acfb5` (review round 2); round 3 is covered by the smoke and unit layers only.
- CR-T57 with a real provider (CR-61), a vision judgment step (CR-15 vision half), CR-T02's switch-off regressions (BLOCKED by pre-existing F1): as in the run record.
- Any real device or phone; any real model.
- GitHub was not read by the recorder (the API budget belongs to the shipping agent); main CI at `74eb2309` is not re-read here.
