# Curriculum Runtime run record — `cr-verify` (#1392)

Status: run record, 2026-10-01. Item `cr-verify`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

No real-device run with a real model was made: the in-app runs use a scripted agent, and there is no phone step in this item.

## What was run

- Code: branch `feat/cr-verify` off `origin/main` `351b6fd5`. The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15 (Darwin 24.6.0), Node 24.4.1. HypeProof Studio 0.1.51 copy with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked.
- Evidence classes (MC-38): **synthetic** = unit and smoke layers (scripted CDP page, real `NativeObservationRecorder`); **live-host (app) / synthetic (model)** = `e2e/curriculum-runtime/verify-app.spec.ts` in the Studio app, Service router in-process, scripted agent as the provider.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (verify surfaces) | worker `cr-switch.test.mjs`, extension `cr-switch.smoke.mjs`, in-app `verify-app.spec.ts` | PASS | Off: no `verify_*` tool offered, the command absent from the palette, the session refuses every action without touching the record. On: both tools offered, the command opens the panel. Planted ungated manifest variants and a planted Worker route are caught by the existing instruments |
| CR-T03 (runner re-check) | `cr-provider-neutral.smoke.mjs`, `cr-verify.smoke.mjs` | PASS | The scan now includes the verify modules and reaches `verification.ts`; a planted SDK import in `verifyRunner.ts` is reported; one verify answer is identical through both adapters, a refusal is an error in both |
| CR-T11 (runner cases) | `cr-verify.smoke.mjs`, in-app | PASS | Positive: runner steps on the preview origin run. Negative: a step to `https://example.com/` is not verified with "범위 밖이라 거절", no CDP call goes there, and in the app no web contents ever loaded it |
| CR-T12 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, in-app | PASS | Positive: three typed criteria stored as the student's `criterion_set` and tested one by one. Negative: zero and six refused; an unconfirmed coach proposal starts no run (in the app no run reached the agent); a confirmed one keeps `adopted_from` |
| CR-T13 | `cr-verify.test.mjs` | PASS | The report round-trips through `criterion_set` / `test_observed` on a batch the one validator accepts; missing `artifact_version_id`, `tested_at` or `steps` refused; the store inventory catches four planted stores |
| CR-T14 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, in-app | PASS | Positive: two runs, identical verdicts, and the re-test makes no model call. Negative: the planted flaky page (`?plant=flaky`) gives pass then `non_reproducible`, never pass |
| CR-T15 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs` | PASS (DOM half) | Uncited pass and fail become not verified; a `judgment` written into a plan is refused (`plan_judgment`) labelled or not, and a smuggled one decides nothing; on a page where the order never completes, a coach-claimed visual "pass" records nothing and the version is not verified, with a screenshot stored. `element` expectations match headings; `text` expectations never match the snapshot's ref or role tokens. No vision step exists, so a visual criterion stays not verified (CR-15 vision half open) |
| CR-T16 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, in-app | PASS | In the app the fix request carried the failed run, criterion 2 and `sha256:7187b0db…`; after the file fix the re-test ran on `sha256:cc6ceb45…` and criterion 2 is `retest_confirmed`. Requests without report, criterion, version or the student's words are refused and nothing is sent |
| CR-T63 (runner case) | `cr-verify.smoke.mjs`, in-app | PASS | 125 of 214 sampled preview frames carried the outline during the run, the last 5 none; the panel showed "테스트 중". A planted executor whose outline never reaches the page is caught |
| CR-T76 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, `verify-panel.smoke.mjs`, in-app | PASS | "검증됨" for the all-pass version; a fail shows the fail; no report, another version's report, an untested criterion and a coach saying "완료했어요" never show it; after the file change the earlier result is kept and labelled |
| CR-T57 | in-app, Studio half only | PARTIAL | Ten re-tests of the five-step order criterion: median 2.99 s, max 3.04 s. No model call is in a re-test; the first run's model time with a real provider is NOT RUN, so CR-61 is not claimed |

## Review round 1 fixes (synthetic layers re-run)

The in-app rows above were run on `a6ee4a8f`, before these fixes; the fixes are covered at the unit and smoke layers, and the in-app spec was not re-run on the fixed head (NOT RUN below).

| Finding | Fix | Control (red on the planted defect) |
|---|---|---|
| A plan-supplied vision judgment set "검증됨" | `parsePlan` refuses `judgment`/`method`; `evaluate` never reads one | M1 plan judgment accepted: both suites red |
| "다시 테스트" dropped untested criteria | the re-test carries every criterion of the latest run | M2 retest keeps the planned subset: smoke red |
| A verdict ending on another page was bound to that page's version | bound to the step-0 entry version; a mid-run file change is not verified | M3 bound to last page, M16 no mid-run check: smoke red |
| `element` never matched headings; `text` matched ref/role tokens | text-role lines match; text reads names and text only | M4, M15: unit red |
| Reproducibility compared different plans; repeated calls overflowed the report | one row per criterion per run; only the same plan is compared; a second call is refused | M5 unit red; M6 smoke red |
| A run never closed; a coach check could be `retest_confirmed` | closes when done, at turn end, on a version change; `retest_confirmed` needs the student's re-test on another version | M7, M8 smoke red; M10 unit red |
| Runs could interleave on the one tab | re-test claims the tab synchronously; one chain per tab; composer and host refuse sends/re-tests meanwhile | M9 retesting claimed late: smoke red |
| Untested guards | switch-off `runTool`, runner-level scope check, `recordChecked` rollback, errors of every visited document | M11, M12, M13, M14: smoke red |

## Instrument corrections during the run

Recorded because each was the instrument, not the product (verification rule 6):

- The panel lives in the "AI와 작업" editor tab, which the preview covers; the spec now brings the tab forward before acting, as `send()` does.
- The outline sampler only matched `/index.html`; the runner starts at the preview root, so the sampler takes a URL pattern.
- Typing a proposal's own text again does not confirm it (an unchanged input fires no change). The spec now clears every row first. This matched the product rule; the spec had assumed otherwise.
- A product defect found while diagnosing the run (by reading `post`, which sends to the sidebar view and the editor chat), fixed on this branch: both views would have sent the run's sentence. The panel now sends only for a request id it issued, and the spec asserts the run reached the agent once.

## NOT RUN

- CR-T57 with a real provider (CR-61), and any real-model run of the coach writing plans. CR-61 stays open; the PR says `Refs #1392`, not `Closes`.
- `verify-app.spec.ts` in the app on the head carrying the review-round-1 fixes.
- A vision judgment step (CR-15 vision half).
- Real phone: not part of this item.
