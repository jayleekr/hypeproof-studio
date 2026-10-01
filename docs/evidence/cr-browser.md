# cr-browser evidence report

Status: evidence for the `cr-browser` completion record (CR-02–CR-11, CR-68; CR-T02–CR-T11, CR-T63). 2026-10-01. Owner: jayleekr.
Item: `cr-browser`, issue [#1391](https://github.com/jayleekr/hypeproof-studio/issues/1391), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1428](https://github.com/jayleekr/hypeproof-studio/pull/1428) (`0d0633ca`, partial) and finished by PR [#1433](https://github.com/jayleekr/hypeproof-studio/pull/1433), squash-merged as `1557e0381a320a6921d8b90fc6e205312f031450`. The implementation's run record with all review rounds is [curriculum-runtime-2026-09-30-evidence.md](../testing/curriculum-runtime-2026-09-30-evidence.md); this report re-runs the final controls at the merge commit.

CR-59 and CR-60 moved to `cr-e2e` (Jay's decision 9) and are not claimed here.

The cr-browser PR edited docs/requirements/curriculum-runtime.md (CR-02/CR-T02 wording, approved by Jay as decision 12), which reopened cr-recon's completion.

## Completion boundary

This report preserves the recorder's test evidence; it does not mark `cr-browser` complete in the ledger. `align.py record` was not written: `cr-recon` was reopened by the requirement edit, and CR-T01 at `1557e038` still has the stale CR-59/CR-60 ownership map from before decision 9. Reconciliation and the corresponding checks must pass before the ledger completion is recorded. The supporting suite exits below are not a substitute for that outstanding CR-T01/recon decision check.

## Verdict

PASS for CR-T02–CR-T11 and CR-T63 at `1557e038`, at the layers listed below. Evidence classes (MC-38): **synthetic** for the unit/smoke suites and real Chromium; **live-host** for the App in the in-app spec (integrated browser, proxy loop, local record, command palette) with a synthetic account, session and scripted agent. No real model, no real device or phone.

## Reviewers

| Label | Role |
|---|---|
| `cr-browser:review:acceptance:r3` | independent review, acceptance lens, round 3 of the finish (PR #1433) |
| `cr-browser:review:adversarial:r3` | independent review, adversarial lens, round 3 of the finish (PR #1433) |
| `cr-browser:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 of the finish (PR #1433); proposed as `reviewed_by` for the pending ledger completion |

The recorder is a record-only agent that did not write the implementation.

## Environment

2026-10-01, Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0), Node v22.22.1. Worktree `chore/record-cr-browser` cut from `origin/main` = `1557e0381a320a6921d8b90fc6e205312f031450`, no local change while the tests ran (`npm ci` in `packages/measurement`, `worker`, `chalk`, `extensions/hypeproof-chat`, its `webview-ui`, `e2e`).

## Positive controls (unmutated tree)

| Command (from the worktree root) | Result |
|---|---|
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/experiment-browser.smoke.mjs` | exit 0, `35 experiment-browser checks passed`, among them "CR-T08: an error the student raises BETWEEN requests is a failure of the next request, not an earlier request's" and its control "CR-T08: an earlier request's error is never reported at a step of the request now running" (still marked 이전 요청) |
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/cr-host.smoke.mjs` | exit 0, `21 cr-host checks passed`: `earlier_request` stored and the history counting through `failuresOf` ("CR-08/CR-10: the stored record keeps the earlier-request mark"), per-owner count/delete on a shared PC with `crBytesOwner` (same person on a reissued token, another student, another cohort, signed out) ("CR-10 shared PC"), the menu and dialog when the count is unknown, context refresh without record I/O ("CR-10 MC-27") |
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/cr-switch.smoke.mjs` | exit 0, `11 cr-switch checks passed`, among them "the delete command is the listed switch-off exception, gated on exactly 'bytes are stored'; planted variants are caught" (`CR_SURFACES.switchOffWhileStored`) |
| `cd worker && node --experimental-strip-types --no-warnings --test test/cr-browser-refs.test.mjs` | exit 0, `pass 16 fail 0`: owner-scoped put/count/delete, shared bytes kept until both owners delete (14), eviction removes owner markers (15), a corrupt review record does not hide the count (16) |

Supporting gates at the same tree (exit codes): `extensions/hypeproof-chat` `npm test` 0 · `worker` `npm test` 0 (includes `cr-switch.test.mjs`, `cr-traceability.test.mjs`, `cr-recon.test.mjs`) · `e2e` `npm run test:cr-browser` (real Chromium) 0, `55/55 passed` · cohort-harness self-test 0 · `next-work.py --check` 0 · `check-registry.py` 0.

## Negative controls: 13 planted defects

Scratch runner `rec-browser/mutate.py` (the finish's `fix-r3/mutate.py` pointed at this worktree): each defect planted alone, the affected suites run, the file restored before the next; `git status` clean afterwards.

| Planted defect | Result |
|---|---|
| between-requests error marked earlier (old rule) | experiment-browser RED |
| `earlier_request` not stored | cr-host RED |
| history counts with its own filter | cr-host RED |
| owner delete ignores owner | cr-browser-refs RED · cr-host RED |
| owner count ignores owner | cr-browser-refs RED · cr-host RED |
| `putBlob` writes no owner marker | cr-browser-refs RED · cr-host RED |
| eviction leaves owner markers | cr-browser-refs RED |
| owner ignores cohort | cr-host RED |
| context refresh reads the record | cr-host RED · cr-switch RED |
| sink stores when signed out | cr-host RED |
| delete command gated on CR switch | cr-switch RED · cr-host RED |
| delete command dropped from inventory | cr-switch RED |
| no context refresh on sign-in | cr-host RED |
| none (control) | experiment-browser GREEN · cr-host GREEN · cr-switch GREEN · cr-browser-refs GREEN |

All 13 RED, the unmutated control all green.

## In-app (`e2e/curriculum-runtime/app-layer.spec.ts`)

Extension and webview built at `1557e038` and injected into a scratch copy of HypeProof Studio 0.1.51 (`dist/extension.js` and `package.json` hashes equal to the build; `scripts/prep-test-app.sh`, `LSUIElement`), then `GATE=idle POLL=15 HPS_APP_PATH=<copy> bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts`, three runs, all started behind the idle gate:

| Run | Result |
|---|---|
| 1 (15:24) | exit 1: `2 passed, 1 failed`. The two CR-T02 tests passed. The switch-on test stopped in `send()` at `[cr:ask] 이 버튼이 왜 안 돼?` with `message did not leave the composer` (draft `""`), after the `[cr:again]` request had been sent: the message-lost instrument failure recorded in finish review round 2, cause still not determined; not a CR-T result |
| 2 (15:25) | exit 0: `3 passed` |
| 3 (15:25) | exit 0: `3 passed` |

What the three tests assert in a passing run:
- "CR-T02 in-app, switch off": none of the five CR tools and neither CR command; the existing `browser_navigate` and "HTML 미리보기" still found (instrument control); the delete command hidden while nothing is stored.
- "CR-T02 exception in-app": the delete command's lifecycle across the switch: hidden before anything is stored, shown after a flow stored bytes (switch on), still shown after a relaunch with the switch off while results and pick are hidden, gone with 0 `blobs/` entries after "지우기".
- "CR-T02/07/08/09/10/63 in-app, switch on": five-step kiosk flow (CR-T07) with the disabled-step-4 control; planted console error reported once at action 4 and, in the following request that does not navigate, read as 이전 요청 (CR-T08); pick of "주문 시작" with crop and `index.html:23`, script-made and removed controls (CR-T09); results read "현재 버전" then "이전 버전" (CR-T10); outline during steps and none after (CR-T63).

The planted in-app control (delete command gated on the CR switch → RED in the exception test) was run in finish review round 3 and not repeated here.

## NOT RUN

- CR-T55 and CR-T56 in the app (now `cr-e2e`, decision 9).
- Recon F8 measured separately on the `origin/main` build.
- Any real device or phone; a real model behind the in-app rows (the agent is scripted).
- GitHub was not read by the recorder (the API budget belongs to the shipping agent); main CI at `1557e038` is not re-read here.
