# Curriculum Runtime run record — `cr-verify` (#1392)

Status: run record, 2026-10-01. Item `cr-verify`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

No real-device run with a real model was made: the in-app runs use a scripted agent, and there is no phone step in this item.

## What was run

- Code: branch `feat/cr-verify` off `origin/main` `351b6fd5`. The submitted SHA is the branch head that carries this file. The in-app rows below were re-run on `ed2acfb5` (review round 2), whose extension and webview build is what the app copy ran; the commit after it changes only this file and the plan doc.
- Machine: Apple M3 Pro, macOS 15 (Darwin 24.6.0), Node 24.4.1. HypeProof Studio 0.1.51 copy with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked.
- Evidence classes (MC-38): **synthetic** = unit and smoke layers (scripted CDP page, real `NativeObservationRecorder`); **live-host (app) / synthetic (model)** = `e2e/curriculum-runtime/verify-app.spec.ts` in the Studio app, Service router in-process, scripted agent as the provider.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (verify surfaces) | worker `cr-switch.test.mjs`, extension `cr-switch.smoke.mjs`, in-app `verify-app.spec.ts` | PARTIAL (verify surfaces only; CR-02 not claimed) | The switch-off half that re-runs `09-preview.spec.ts` and the HTML generation specs is BLOCKED by pre-existing F1 (red on `origin/main` too), as recorded for cr-browser. Off: no `verify_*` tool offered, the command absent from the palette, the session refuses every action without touching the record. On: both tools offered, the command opens the panel. Planted ungated manifest variants and a planted Worker route are caught by the existing instruments |
| CR-T03 (runner re-check) | `cr-provider-neutral.smoke.mjs`, `cr-verify.smoke.mjs` | PASS | The scan now includes the verify modules and reaches `verification.ts`; a planted SDK import in `verifyRunner.ts` is reported; one verify answer is identical through both adapters, a refusal is an error in both |
| CR-T11 (runner cases) | `cr-verify.smoke.mjs`, in-app | PASS | Positive: runner steps on the preview origin run. Negative: a step to `https://example.com/` is not verified with "범위 밖이라 거절", no CDP call goes there, and in the app no web contents ever loaded it |
| CR-T12 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, in-app | PASS | Positive: three typed criteria stored as the student's `criterion_set` and tested one by one. Negative: zero and six refused; an unconfirmed coach proposal starts no run (in the app no run reached the agent); a confirmed one keeps `adopted_from` |
| CR-T13 | `cr-verify.test.mjs` | PASS | The report round-trips through `criterion_set` / `test_observed` on a batch the one validator accepts; missing `artifact_version_id`, `tested_at` or `steps` refused; the store inventory catches four planted stores |
| CR-T14 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, in-app | PASS | Positive: two runs, identical verdicts, and the re-test makes no model call. Negative: the planted flaky page (`?plant=flaky`) gives pass then `non_reproducible`, never pass; three separate "테스트 시작" runs with the same words and plan on the flaky page are compared with each other (by criterion text, not event id) and never read verified |
| CR-T15 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs` | PARTIAL (DOM half; CR-15 not claimed) | Uncited pass and fail become not verified; a `judgment` written into a plan is refused (`plan_judgment`) labelled or not, and a smuggled one decides nothing; on a page where the order never completes, a coach-claimed visual "pass" records nothing and the version is not verified, with a screenshot stored. `element` expectations match headings; `text` expectations never match the snapshot's ref or role tokens. No vision step exists, so a visual criterion stays not verified (CR-15 vision half open) |
| CR-T16 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, in-app | PASS | In the app the fix request carried the failed run, criterion 2 and `sha256:7187b0db…`; after the file fix the re-test ran on `sha256:cc6ceb45…` and criterion 2 is `retest_confirmed`. Requests without report, criterion, version or the student's words are refused and nothing is sent |
| CR-T63 (runner case) | `cr-verify.smoke.mjs`, in-app | PASS | 125 of 214 sampled preview frames carried the outline during the run, the last 5 none; the panel showed "테스트 중". A planted executor whose outline never reaches the page is caught. On `ed2acfb5`: 121 of 212 frames, the last 5 none |
| CR-T76 | `cr-verify.test.mjs`, `cr-verify.smoke.mjs`, `verify-panel.smoke.mjs`, in-app | PASS | "검증됨" for the all-pass version; a fail shows the fail; no report, another version's report, an untested criterion and a coach saying "완료했어요" never show it; after the file change the earlier result is kept and labelled |
| CR-T57 | in-app, Studio half only | PARTIAL | Ten re-tests of the five-step order criterion: median 2.99 s, max 3.04 s on `a6ee4a8f`; median 2.94 s, max 3.00 s on `ed2acfb5`. No model call is in a re-test; the first run's model time with a real provider is NOT RUN, so CR-61 is not claimed |

## Review round 1 fixes (synthetic layers re-run)

The in-app rows were first run on `a6ee4a8f`, before these fixes. They were re-run on `ed2acfb5`, which carries these fixes and the round 2 fixes, through `GATE=idle HPS_APP_PATH=<prepared copy> bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts`: 6 passed (2.2 min), both specs. That includes cr-browser's `app-layer.spec.ts` (3 tests) after this branch moved its helpers into `app-helpers.ts` and gave the outline sampler a URL pattern. The fix request carried `sha256:7187b0db…`, the re-test ran on `sha256:cc6ceb45…` and the fixed criterion is `retest_confirmed`; the flaky page gave pass then `non_reproducible`.

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

## Review round 2 fixes

Each control is a planted defect in a scratch run against the four slice suites (`cr-verify.smoke.mjs`, `verify-panel.smoke.mjs`, `cr-switch.smoke.mjs`, worker `cr-verify.test.mjs`); every one below turns at least one red, and the unplanted code is green.

| Finding | Fix | Planted defect caught |
|---|---|---|
| Pressing "테스트 시작" again was never compared with the earlier run (CR-14), and a later report hid an earlier fail (CR-81) | runs are compared by normalized criterion text (`criterionKey`), plan, version and viewport across every run on the version; `productVerification` keeps a decided fail or `non_reproducible` of any report on the same version open | compare by event id; skip the earlier reports |
| The session's own version check (run ends on another page) was untested | smoke case: navigate to `/b.html` while the entry page changes reads not verified; control with no change passes | `if (false)` in the session check |
| Tab serialisation and the in-chain one-verdict re-check were untested | smoke case: two parallel criteria never overlap on the tab; the same criterion twice gives one test event and a refusal | `fn()` instead of the tab chain; the in-chain re-check removed |
| A failed step and a load-time console error had no test | unit: a failed step with only passing expectations is fail; smoke: zero-step `no_errors` on a page erroring at load fails and cites it | `status = "pass"` on a failed step; the step-0 collect removed |
| Host wiring (turn end, send refusal, `turn_running`, composer lock) was untested | source assertions in `cr-verify.smoke.mjs` and a rendered Send button in `verify-panel.smoke.mjs`, each shown red on its own planted removal | each of the five host guards and three composer guards removed in turn |
| Error records named the executor's step counter | mapped to the runner's step index (a load error is step 0) | the mapping removed |
| A snapshot cut at 200 lines decided absent text | a cut snapshot leaves an absent or missing text/element `not_verified` | the truncation check removed in `evaluate` or in the runner |
| The 20,000-character cap was assumed, and the secret scrub could corrupt the JSON | the result is measured and shortened, or refused by name (`result_too_long`, `result_unreadable`) before anything is written; the criterion stays testable | the length check; the pre-record read-back |
| `fix()` was accepted during a re-test | refused as `busy` while a run acts | the `running` check in `fix()` |
| `criterion_passed`, `running` while the coach acts, and test/result binding were untested | one assertion each | each guard removed |
| Verify calls could write to a recorder replaced mid-turn | the turn's recorder is captured in `handleSend` and used first (source assertion) | the capture removed |

One planted defect survives: removing the read-back after `rec.record` of the result. It is a second guard behind the pre-record read-back of the same scrubbed text, so no input reaches it; kept as defence, not counted as a control.

## Review round 3 fixes

Branch merged with `origin/main` `bc3639d3` first (#1381; `styles.css` kept both blocks). Controls are planted defects run against `cr-verify.smoke.mjs` (40 checks) and `verify-panel.smoke.mjs` (7 checks); each turns its suite red, and the unplanted code is green.

| Finding | Fix | Planted defect caught |
|---|---|---|
| An earlier fail on the version that a later run with the same words passed left a failed state with no failing row and no fix action (CR-81, CR-16) | the view carries the open results the shown report does not hold (`held`), drawn as rows with the fix request; "다시 테스트" re-runs them with their own plans | `held: []` in the view; the panel's held block removed; the re-test ignoring held results |
| A step target past the 200-line snapshot cap was a recorded fail (CR-15) | `not_verified` with "화면 내용이 길어 앞부분만 읽었어요"; control: a short page without the button still fails | the truncation guard in the runner |
| `no_errors` and warning ignored records the page event log dropped (CR-15, CR-81) | dropped or late-attached records of any visited document make `no_errors` undecided and a clean run `not_verified`; controls with 10 logs: fail and warning | the `droppedRecords`/`recordsPartial` carry removed |
| A later start with fewer criteria hid an earlier warning or not-verified result (CR-81) | carried until a later report on the version passes the same words; the CR-T76 subset negative now covers fail, warning and not_verified; control: a later pass clears a not-verified result | the carry limited to fail and non-reproducible |
| A drawer write during a re-test was lost (whole-snapshot persist) | the re-test holds its recorder (`verifyRunRecorder`) and `prepareObservation` hands it to every writer until the re-test releases it | each of the three host guards removed (source assertions); the session's release (behaviour) |
| A zero-step plan with only `no_errors` verified a behavioural criterion | refused as `plan_untestable` with a reason for the coach; controls: a positive expectation or one step is accepted | the refusal removed |
| `text` matched substrings ("완료" in "미완료") | matched from a word start; controls: "주문 완료되었어요", "완료", "(완료)" pass | `includes` restored |
| Stale comments on version artifacts | `learning-events.ts` and `browserResult.ts` now point to `isVersionArtifact` | — |

## Shared files this evidence depends on

`cr-verify.verification_inputs` pins the slice's own implementation and tests. These shared files also carry its controls and are not pinned, so that edits by other slices do not reopen this item (ledger-contract warnings): `worker/test/cr-switch.test.mjs`, `extensions/hypeproof-chat/test/cr-switch.smoke.mjs` and `cr-provider-neutral.smoke.mjs` (CR-T02, CR-T03 for the verify surfaces), `e2e/curriculum-runtime/app-service.mjs` (the scripted verify agent) and `fixtures/kiosk-practice/app.js` (the `?plant=flaky` CR-T14 negative). A change to them should re-run this record's rows.

## Known limitation

The coach writes each plan's expectations, so a plan that does not test what the criterion says can still pass. Only the trivial form (zero steps with only `no_errors` or absent expectations) is refused (`plan_untestable`); no mechanical rule separates the rest from a legitimate absence or no-error criterion. The panel shows each verdict's expectations next to it ("확인한 것") and the steps under it.

## Instrument corrections during the run

Recorded because each was the instrument, not the product (verification rule 6):

- The panel lives in the "AI와 작업" editor tab, which the preview covers; the spec now brings the tab forward before acting, as `send()` does.
- The outline sampler only matched `/index.html`; the runner starts at the preview root, so the sampler takes a URL pattern.
- Typing a proposal's own text again does not confirm it (an unchanged input fires no change). The spec now clears every row first. This matched the product rule; the spec had assumed otherwise.
- A product defect found while diagnosing the run (by reading `post`, which sends to the sidebar view and the editor chat), fixed on this branch: both views would have sent the run's sentence. The panel now sends only for a request id it issued, and the spec asserts the run reached the agent once.

## NOT RUN

- CR-T57 with a real provider (CR-61), and any real-model run of the coach writing plans. CR-61 stays open; the PR says `Refs #1392`, not `Closes`.
- A vision judgment step (CR-15 vision half). CR-15 is partial and not claimed; it stays open with CR-61 under `Refs #1392`.
- Real phone: not part of this item.
- In-app re-run of `verify-app.spec.ts` / `app-layer.spec.ts` and `09-preview.spec.ts` on the review round 3 head (`d710c299`). The extension and webview build was injected into the prepared app copy and the run was queued through `GATE=idle scripts/e2e-quiet.sh` from 21:56 to 22:45 on 2026-10-01; the Mac never had 5 idle minutes, so no app was launched (reason: waiting for idle window). The in-app rows above stand on `ed2acfb5`; round 3 is covered by the smoke and unit layers only.
- CR-T02's switch-off regressions (`09-preview.spec.ts`, HTML generation specs): BLOCKED by pre-existing F1, so CR-02 is not claimed by this item; cr-e2e re-runs the full switch-off inventory.
