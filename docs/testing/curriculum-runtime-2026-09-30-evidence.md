# Curriculum Runtime run record — `cr-browser` (#1391)

Status: run record, 2026-09-30. Item `cr-browser`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer (plan, "What done means").

No real-device run was made: no Studio app run with this branch reached a CR surface, no reference-Mac timing, no phone. (Until 2026-10-01: the section "Finish" records the in-app runs and supersedes the requirement status and NOT RUN list of the sections before it.)

## What was run

- Code: branch `feat/cr-browser` off `origin/main` `9d73f0f5`. Implementation commits `57cd4216` (core), `46f34b6e` (App wiring), `1b171f50` (Worker switch), `5ce034f4` (fixture and real-Chromium run), `fee58eca` (widened controls), then the review-round-1, round-2 and round-3 fix commits (sections "Review round 1", "Review round 2", "Review round 3"). The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15 (Darwin 24.6.0), Node 24.4.1 locally (CI pins Node 22). Chromium 148.0.7778.96 (Playwright build, full browser in new-headless mode). HypeProof Studio 0.1.51 (`d4db9049`) copies with injected extension builds. The screen was locked for every app run.
- Evidence classes (MC-38): **synthetic** = mock CDP channel or real Chromium without the Studio app; **live-host** = none in this record.

## Gates (exit codes)

| Gate | Exit |
|---|---|
| `packages/measurement` `npm test` | 0 |
| `worker` `npm test` (includes `cr-switch.test.mjs`, `cr-traceability.test.mjs`, `cr-recon.test.mjs`) | 0 |
| `worker` `test:authoring:d1` · `test:classroom:d1` · `test:native-trial:d1` · `test:classroom-ops:d1` | 0 · 0 · 0 · 0 |
| `worker` `npm run typecheck` | 0 |
| `chalk` `npm test` · `npm run typecheck` | 0 · 0 |
| `worker` `npm run validate-profiles` · `bash worker/scripts/cohort-harness/test/run.sh` | 0 · 0 |
| `extensions/hypeproof-chat` `npm run typecheck` · `npm test` (with webview deps) | 0 · 0 |
| `webview-ui` `tsc --noEmit` | 0 |
| `python3 scripts/next-work.py --check` (`HYPEPROOF_HARNESS=~/.cache/hypeproof/harness`) | 0 |
| `python3 scripts/check-registry.py` | 0 |
| `hype-align` `align.py check --doc curriculum-runtime` (Lab not checked) | 0 |
| `e2e` `npm run test:cr-browser` (real Chromium) | round 0: 0 · 0 · 0 (32/32 each); after review round 1: 0 · 0 · 0 (43/43 each); after review round 2: 0 (52/52); after review round 3: see "Review round 3" (55/55) |

## Results per CR-T row

"Unit/smoke" rows run in CI (`npm test`). "Real Chromium" is `e2e/curriculum-runtime/experiment-browser.real.mjs`: real engine and Studio's own `serveStatic` + live-reload, not the Studio app.

| Row | Layer run | Class | Result | What it leaves |
|---|---|---|---|---|
| CR-T02 | Worker half `worker/test/cr-switch.test.mjs`; App unit half `test/cr-switch.smoke.mjs` (context-key value and SDK registration decision included); in-app `09-preview.spec.ts` | synthetic | Worker half PASS, App unit half PASS; **in-app BLOCKED**: the positive control (`09-preview.spec.ts`, switch off) is red on the pre-change build too (below) | in-app walk with the switch on (needs a CR-enabled local cohort) |
| CR-T03 | `test/cr-provider-neutral.smoke.mjs` | synthetic | PASS (modules incl. `crHostWiring.ts` scanned; 5-call parity SDK vs proxy; an external origin refused with the same text by both runtimes) | verify-runner module (`cr-verify`) |
| CR-T04 | `test/experiment-browser.smoke.mjs`; real Chromium | synthetic | PASS (round 3: URL, route, viewport, document generation and artifact version checked in the text the model receives on both runtimes; round 2: every part of one observation comes from one document; a commit during the tree read re-observes it whole; real Chromium, 30 redirects landing 2–12 ms into the observation, no mixed result) | Studio app run |
| CR-T05 | `test/experiment-browser.smoke.mjs`; real Chromium | synthetic | PASS (3 records planted, 0 clean, previous document kept apart, SSE reload = new document; log attached after load: the load-time 404 of `typo.html` recovered, a clean late-attached page reads "확인된 것 없음", never "없음"; an id-less Log entry right after a commit is not put on the new document) | Studio app run |
| CR-T06 | `test/experiment-browser.smoke.mjs`; real Chromium | synthetic | PASS | Studio app run |
| CR-T07 | real Chromium, scripted agent over CR-06 actions, kiosk fixture | synthetic | PASS (5 steps; planted disabled step 4 → failure at 4) | **Playwright e2e in the app NOT RUN** |
| CR-T08 | unit half in the smoke; real Chromium | synthetic | PASS (round 3: the verdict reads the text the model receives, `toMcpToolResult` / `toProxyToolResult`, not the `observation` side field; planted error at step 3 reported once at 3; clean flow none, also with `console.log`/`console.info` on every step; an error the student causes between agent steps carries step `null`) | **Playwright e2e in the app NOT RUN** |
| CR-T09 | `test/element-pick.smoke.mjs`, `test/element-preview.smoke.mjs` (real ChatPanel render); `test/cr-host.smoke.mjs` (queue, send, remove); real Chromium incl. an inspect-mode click | synthetic | PASS (ref = snapshot ref, snippet, style subset, element crop, `index.html:23`; script-generated → `unmapped`, also a script-made clone sharing `#begin`'s text; removed → the next turn carries no element text or crop; sent text = previewed `sentText`; the crop joins a queued page screenshot) | **in-app pick NOT RUN**; F8 unresolved |
| CR-T10 | `test/artifact-version.smoke.mjs` (helpers); `test/cr-host.smoke.mjs` (the recording module the provider calls) | synthetic | helper level PASS (v0 result stored on `LocalRecord`, readable and labelled v0 after v1; no version → refused). Host level: one proxy call, one SDK tool_result and one pick each produce an `hps-browser-result/1` tool_result event through `crHostWiring.ts`; the provider's calls into it are checked by source match, **not by driving `ChatPanelProvider`** | an in-app run that reads the record back |
| CR-T11 | smoke; `test/cr-host.smoke.mjs`; real Chromium | synthetic | `cr-browser` cases PASS: live-server origin runs; external, `file://`, other port, external history entry refused before any CDP call; **indirect escapes** (a link click, a script setting `location`, a form submit, the other origin's paths colliding with `index.html`) refused, nothing observed or recorded, tab back on the preview; the viewport wrapper `/__hp_viewport` refused with a reason; **SDK runtime**: `browser_open` to another origin refused before any tab call (and denied in `canUseTool`, no modal), `browser_screenshot` returns the CR refusal instead of falling back; **round 2**: a target=_blank link and `window.open` off scope are refused and the new window closed; a location change 600 ms after the step returned, and a redirect 600 ms after `browser_navigate` returned, are stopped with the tab kept on the preview and refuse the next call; `browser_navigate` to a page that redirects out 20 ms after load is refused and the tab taken back | runner cases (`cr-verify`), published-origin cases (`cr-publish`); the `canUseTool` denial is not driven by a test (`sdkCoach.ts` needs the SDK) |
| CR-T55 | real Chromium: a fixture copy served by `serveStatic` + live-reload, a file watcher with LiveServer's 150 ms debounce, SSE push; file write → new document at `readyState` complete, n=30 | synthetic | p50 353 / 346.5 / 346.5 ms (3 runs, n=30 each, M3 Pro); control: a planted 3 s delay before the push is reported as a miss (p50 3336 ms, n=3) | **reference-Mac app run NOT RUN** (the Electron watcher and the integrated browser are not in the synthetic path) |
| CR-T56 | unit controls in `element-pick.smoke.mjs`; real Chromium n=30 | synthetic | controls PASS; real Chromium p50 17 / 17 / 25 ms (3 runs, n=30 each, M3 Pro) | **reference-Mac app run NOT RUN**; recon F8 measured 2.0–3.0 s crops on the `origin/main` build in the app |
| CR-T63 | unit half in the smoke (round 2: every executor tool, `browser_navigate`, back and forward included; `Page.navigate` and `Page.navigateToHistoryEntry` count as actions); real Chromium (outline visible mid-step for a hover and a `browser_navigate` step, evidence screenshot clean, gone after) | synthetic | `cr-browser` case PASS | **Playwright in the app NOT RUN**; runner case (`cr-verify`) |

### `09-preview.spec.ts` baseline (switch off)

Local Worker on port 8797 with a dev-only signing secret (no provider key), sk-biopharm kids cohort, the switch absent. Same shell, two injected builds, three runs each:

| Test | `origin/main` build | this branch |
|---|---|---|
| REQ-D1 + D3 + D6 | FAIL 3/3 (`#frame` not attached) | FAIL 3/3 |
| REQ-D4 | FAIL 3/3 | FAIL 3/3 |
| REQ-D5 | PASS 1/3 | PASS 3/3 |

Recon F1 reproduced on the pre-change tree. No test is worse on the branch, but a control that is red on the unchanged tree voids the in-app verdict (testing contract), so CR-T02's in-app half stays BLOCKED until F1 is separated.

## Controls against the pre-implementation tree

Every new test run against the `origin/main` (`9d73f0f5`) sources is red: `cdp-session` (`session.onEvent is not a function`), `experiment-browser`, `artifact-version`, `element-pick`, `cr-switch`, `cr-provider-neutral` (modules absent), `worker/test/cr-switch.test.mjs` (module absent).

Planted defects on this branch, one at a time; each must turn its test red. The first pass found two surviving mutations (the CR-T04 control removed only viewport and generation; the CR-T09 fixture had no markup inside a script). Both controls were widened (`fee58eca`) and the full set re-run:

| Planted defect | Test | Result |
|---|---|---|
| stale-ref generation check removed | experiment-browser | RED |
| origin scope always allows | experiment-browser | RED |
| console records attributed to the current document | experiment-browser | RED |
| screenshot dropped from the required observation parts | experiment-browser | RED |
| indicator never drawn | experiment-browser | RED |
| result accepted without an artifact version | artifact-version | RED |
| symlink followed into the file set | artifact-version | RED |
| script bodies not blanked before source mapping | element-pick | RED |
| full-page capture instead of the element crop | element-pick | RED |
| CR MCP tools granted regardless of the switch | cr-switch (App) | RED |
| CR executor used regardless of the switch | cr-switch (App) | RED |
| provider SDK type import in the runner module | cr-provider-neutral | RED |
| CR proxy tools injected regardless of the switch | cr-switch (Worker) | RED |

The real-Chromium run found three instrument errors before any product verdict, all fixed in the instrument: the fixture's menu buttons are hidden at start (not in the AX tree); the stale-ref control reloaded through the agent, which legitimately hands out fresh refs; the headless shell does not paint the inspector overlay into CDP screenshots, so the run uses full Chromium in new-headless mode.

### Requirement status at this head

| Requirement | Status |
|---|---|
| CR-03, CR-04, CR-05, CR-06, CR-11 | synthetic evidence only (rows above); no app-layer run |
| CR-02, CR-07, CR-08, CR-09, CR-68 | **not met at the layer their CR-T row defines** (Playwright e2e in the app): NOT RUN, and CR-T02's in-app half BLOCKED on F1. Synthetic halves only |
| **CR-10** | **partial, blocked on the stored-schema decision** (plan, "Decisions still open": a breaking change to a stored schema). CR-10 says results persist "as artifact references of the learning events"; this slice stores them as `tool_result` event text tagged `hps-browser-result/1`. Nothing in the product reads a stored result back or labels it by version yet (`readBrowserResultEvent` and `labelByVersion` are called only by tests), and screenshot and trace digests name bytes that are stored nowhere. Not claimed |
| **CR-59** (preview refresh p50 < 2 s) | **not met, not claimed.** Synthetic CR-T55 only (p50 347–353 ms, headless Chromium with Studio's serving code); the app run on the reference Mac is NOT RUN, and this branch changes nothing on the refresh path |
| **CR-60** (element capture < 1 s) | **not met, not claimed.** Only the headless-Chromium p50 exists; recon F8 measured 2.0–3.0 s crops in the app on `origin/main`, which is evidence against the target there |

The ledger keeps CR-59 and CR-60 on this item's scope (the plan assigns them here); they stay open until CR-T55 and CR-T56 run in the app on the reference Mac. Moving them to a follow-up item needs Jay's consent and was not done. (Superseded 2026-10-01: Jay moved both to `cr-e2e`, decision 9; see "Finish" below.)

**Claim for the PR and the ledger.** No requirement of this item is complete. The PR refers to #1391 and does not close it; no `completion` record is written for `cr-browser` until the app-layer rows run and the stored-schema decision is made.

## Review round 1

Fixes for the round-1 review findings. After them every gate in the table above was re-run on the fix commit's tree and exited 0 (`next-work.py --check` and `check-registry.py` included), and the real-Chromium run passed 43/43 three times (CR-T56 headless p50 25 / 25 / 25 ms, n=30 each, M3 Pro). Then every new control was planted one at a time (scratch runner; each defect must turn its test red):

| Planted defect | Test | Result |
|---|---|---|
| action-caused navigation not watched and not re-checked before observing | experiment-browser; real Chromium (3 CR-T11 FAILs) | RED · RED |
| escape refused but the tab not taken back | experiment-browser | RED |
| step number carried past the step | experiment-browser; real Chromium | RED · RED |
| late-attach 404 recovery dropped | experiment-browser; real Chromium | RED · RED |
| late-attach "partial" flag dropped | experiment-browser | RED |
| id-less Log entry attributed to the new document right after a commit | experiment-browser | RED |
| viewport wrapper allowed | experiment-browser | RED |
| `console.log` counted as a failure | experiment-browser | RED |
| an id no markup defines falls back to a text match | element-pick (real Chromium stays green: the live-twins rule also refuses that clone) | RED |
| live same-text twins ignored | element-pick | RED |
| SDK `browser_open` unscoped | cr-host, cr-provider-neutral | RED · RED |
| `browser_screenshot` falls back past a CR refusal | cr-host | RED |
| host open error turned into a success | cr-host | RED |
| context key mirrored as always on | cr-switch (App) | RED |
| SDK server registers CR tools regardless of the grant (call site, and helper) | cr-switch (App) | RED · RED |
| remove does not clear the queue (helper, and provider handler) | cr-host | RED · RED |
| picked element text not sent | cr-host | RED |
| element crop replaces the queued page screenshot | cr-host | RED |
| proxy result recording dropped (helper, and provider call) | cr-host | RED · RED |
| SDK result recording dropped (provider call), or never matched (helper) | cr-host | RED · RED |
| pick capture recording dropped (provider call) | cr-host | RED |
| CR tool log labels missing | browser-tool-log | RED |
| proxy CR tools and contract for a minor cohort with `browser_control` | cr-switch (Worker) | RED |
| validator lets a child cohort turn the switch on | cohort-harness `run.sh` | RED |
| validator lets the switch on without an observation format | cohort-harness `run.sh` | RED |

Not covered by a test: the provider's minor-tier refusal in `pickElement`, its re-entry guard, the preview-origin check in its `artifactVersion` hook (the real run's hook mirrors it), and the `canUseTool` denial in `sdkCoach.ts`.

## Review round 2

Fixes for the round-2 findings: a scope guard that stays on the driven tab's session (steps, the 5 s after them, `browser_navigate` and its redirects, new windows), observations taken from one document with its scope checked at both ends, one minor test for every CR surface, an artifact version that refuses only on its entry, a bounded result record, step `null` for records captured during an observation, and one `ElementPreview` declaration. Every gate in the table above was re-run on the fix commit's tree and exited 0 (extension `npm test` and typecheck, cohort-harness `run.sh` 22/22, worker `cr-switch.test.mjs` included), and the real-Chromium run passed 52/52. Planted defects, one at a time (scratch runner; the real run only where it applies):

| Planted defect | Test | Result |
|---|---|---|
| guard stops enforcing when the step returns | experiment-browser; real Chromium (3 FAILs) | RED · RED |
| new windows ignored | experiment-browser; real Chromium (2 FAILs) | RED · RED |
| committed escape after the step not taken back | experiment-browser | RED |
| observation read once (no end-of-observation document check) | experiment-browser; real Chromium | RED · GREEN (the navigate settle now absorbs the 2–12 ms redirects, so the real run no longer lands one mid-observation) |
| `browser_navigate` without the settle wait | experiment-browser; real Chromium (1 FAIL) | GREEN · RED |
| no outline redraw after `browser_navigate` | experiment-browser (first-tab case); real Chromium | RED · GREEN (with a tab already open the outline drawn before navigating survives it) |
| escape seen during the observation not checked before recording | experiment-browser (a window opened mid-observation) | RED |
| end-of-observation scope check removed | experiment-browser; real Chromium | GREEN · GREEN — redundant by design: a changed URL already forces a re-read, whose first check refuses |
| records captured during an observation carry the last step | experiment-browser | RED |
| exceptions attributed to the current document | experiment-browser | RED |
| a large referenced file refuses the version | artifact-version | RED |
| the file cap refuses instead of marking the set partial | artifact-version | RED |
| result record not bounded | artifact-version | RED |
| App switch ignores the served minor flag | cr-switch (App) | RED |
| Worker CR test ignores `isMinorCohort` | cr-switch (Worker) | RED |
| validator lets a 13–17 cohort switch CR on | cohort-harness `run.sh` | RED |
| element snippet not bounded | element-pick | RED |
| SDK results paired newest first | cr-host | RED |
| `browser_select` allowed without asking | cr-host | RED |
| `pickElement` scope check removed | cr-switch (App) | RED |

## Review round 3

Fixes for the round-3 findings: CR-T04, CR-T05 and CR-T08 verdicts read the text the model receives (`toMcpToolResult` and `toProxyToolResult`, which must agree) instead of the `observation` side field; with the switch on a proxy turn drives the provider's long-lived control and leaves it open (`proxyTurnBrowser`), so the CR-11 guard and a picked element's refs outlive the turn; pick-only refs are `p<backendNodeId>`; the guard closes only windows opened after the step began; the CR adult test adds a lower age bound of 18; a synthetic CR-T55; ledger paths (`worker/src/lib/moderation.ts`, `teen-cr.json`); the requirement claim above. Gates on the fix tree:

| Gate | Exit |
|---|---|
| `packages/measurement` `npm test` | 0 |
| `worker` `npm test` · `test:authoring:d1` · `test:classroom:d1` · `test:native-trial:d1` · `test:classroom-ops:d1` · `typecheck` | 0 · 0 · 0 · 0 · 0 · 0 |
| `chalk` `npm test` · `npm run typecheck` | 0 · 0 |
| `worker` `npm run validate-profiles` · cohort-harness `run.sh` (23/23) | 0 · 0 |
| `extensions/hypeproof-chat` `npm run typecheck` · `npm test` · `webview-ui` `tsc --noEmit` | 0 · 0 · 0 |
| `next-work.py --check` · `check-registry.py` · `hype-align check --item cr-browser` · `--doc curriculum-runtime` | 0 · 0 · 0 · 0 |
| `e2e` real Chromium | 0 · 0 · 0 (55/55 each) |

Planted defects, one at a time (scratch runner; the real run for the model-text ones):

| Planted defect | Test | Result |
|---|---|---|
| step number dropped from the model text | experiment-browser; real Chromium | RED · RED |
| no record line reaches the model | experiment-browser; real Chromium | RED · RED |
| artifact version line dropped from the model text | experiment-browser; real Chromium | RED · RED |
| viewport line dropped from the model text | experiment-browser; real Chromium | RED · RED |
| a duplicated markup id maps to the first element | element-pick | RED |
| `lastInScope` not updated on in-scope navigation | experiment-browser | RED |
| default settle wait 0 | experiment-browser | RED |
| a student's earlier window closed by the guard | experiment-browser | RED |
| the shared control disposed at the end of a proxy turn | cr-host | RED |
| the provider builds a per-turn control with the switch on | cr-host | RED |
| pick-only ref labelled `e<N+1>` | element-pick | RED |
| Worker CR gate ignores the lower age bound | cr-switch (Worker) | RED |
| validator ignores the lower age bound | cohort-harness `run.sh` | RED |

The first full `worker npm test` of round 3 exited 0. On the round-2 tree a reviewer saw one exit 1 from `classroom-ops-delivery.test.mjs` (AT-31: the substring `4821` can occur in a random hex digest); it passed on rerun and is unrelated to this branch, which touches no classroom file.

## Finish (2026-10-01, `feat/cr-browser-finish`)

Two decisions by Jay on 2026-10-01 unblocked the rest: decision 8 allows additive optional keys on `hps-observation/1`, decision 9 moves CR-59 and CR-60 to `cr-e2e`.

- Commits: `b95f28ab` (CR-10 persistence), `d605e440` (09-preview measures the path the cohort takes, recon F1), `62045bb2` (three in-app defects), `d3de6f5a` (in-app spec), `fc9602b6` (ledger), then this record.
- Machine: Apple M3 Pro, macOS 15.7.4, screen unlocked, Node 22.22.1. App: a scratch copy of HypeProof Studio 0.1.51 (`d4db9049`) with the extension and webview built from `fc9602b6` injected (`e2e/classroom/mac-devhost.mjs reinject`, 4 bundle hashes match), marked `LSUIElement` so it never activates. Every app run went through the e2e fixture's quiet mode (off-screen, shown inactive, not focusable, in-memory secret storage) and started only after 5 minutes without keyboard or mouse input.
- Evidence classes (MC-38): **live-host** for the App (the integrated browser, the App's proxy loop, the local record, the command palette); **synthetic** for the account, the session and the model (`e2e/curriculum-runtime/app-service.mjs`: the real Service router over HTTP, a scripted agent as the provider). The rows below prove transport, enforcement and browser behaviour in the App, never a real model's judgement.

### CR-10 under decision 8

Browser results are `tool_result` events tagged `hps-browser-result/1` with the optional keys `artifact_version`, `screenshot_digest` and `trace_digest` (`BROWSER_RESULT_REF_KEYS`). `legacy-observation.ts` accepts them only on a `tool_result`, as sha256 digests, and byte digests only next to the version; records without them read unchanged. The bytes are `blobs/` entries of the same local record (`LocalRecord.putBlob`), and a digest is named only after its bytes were read back. `hypeproof-chat.browserResults` (behind the switch) reads the stored results back and labels each "현재 버전", "이전 버전" or "버전 확인 안 됨". Assessment uploads leave the keys out (`assessmentBatch`), so a Service deployed before decision 8 does not refuse a batch. Unit and D1-free tests: `worker/test/cr-browser-refs.test.mjs`, `extensions/hypeproof-chat/test/cr-host.smoke.mjs`.

### In-app rows (`e2e/curriculum-runtime/app-layer.spec.ts`)

Four consecutive gated runs at the final tree (11:47–11:50), each `2 passed`:

| Row | Positive | Negative control (in the same run) |
|---|---|---|
| CR-T02 (in-app) | switch on: `browser_observe`, `browser_select`, `browser_scroll`, `browser_hover`, `browser_reload` offered; both CR commands in the palette | switch off: none of the five tools and neither command; the existing `browser_navigate` and "HTML 미리보기" still found (instrument control) |
| CR-T07 | five steps reach "주문이 완료되었어요" | planted disabled step 4 stops at 4 |
| CR-T08 | planted console error reported once, at action 4 (flow step 3; the opening navigate is action 1) | clean and chatty (`console.log`/`info`) flows report none |
| CR-T63 | orange outline in 36 of 93 frames sampled during the flow; a tool line was `running` during a step | the last 5 frames after the flow carry no outline; no running tool line after |
| CR-T09 | pick of "주문 시작": chip `index.html:23`, crop attached, the next request starts with exactly the previewed text and carries the image; the pick did not press the button | a script-made element reads "소스 위치: 찾지 못함"; a removed element sends nothing and no image |
| CR-T10 (app) | results read back as "현재 버전 · sha256:04cdec9f…"; 32 `blobs/` entries on the local record | after `index.html` changes the same results read "이전 버전" and none "현재 버전" |

The first gated run (11:45) hid the app after the workbench was ready (`app.hide()`), and every observation failed with `CDP Page.captureScreenshot timed out`: a hidden app's integrated browser paints no frames, like a locked screen (F7). The CR config now sets `HPS_QUIET_NO_HIDE=1`; the window stays off-screen and unfocusable. That run is also the instrument's control: no painting turns CR-T07 red at step 1.

The three product defects the earlier, visible in-app runs found are fixed in `62045bb2`, each with a smoke whose planted revert turns it red (scratch mutation run): the navigating executor kept by the control (`cr-switch`), a same-origin tab driven instead of duplicated (`cr-switch`), step numbers restarting per turn (`experiment-browser`, `cr-host`).

### F1 (09-preview)

`e2e/tests/09-preview.spec.ts` on the same app copy, gated and quiet, against `scripts/dev-stack.sh`: 3 passed (REQ-D1/D3/D6, REQ-D4, REQ-D5). Its planted control (a canned turn without HTML fails both checks with "no preview opened") is in `d605e440`.

### Gates at the final code (exit codes)

`packages/measurement` test 0 · `worker` test 0 · `test:authoring:d1` 0 · `test:classroom:d1` 0 · `test:native-trial:d1` 0 · `test:classroom-ops:d1` 0 · `worker` typecheck 0 · `chalk` test 0 · `chalk` typecheck 0 · `validate-profiles` 0 · cohort-harness self-test 0 · extension typecheck 0 · extension `npm test` 0 · installer smokes 0 · `cr-traceability.test.mjs` 0 · `e2e` `test:cr-browser` (real Chromium) 0 · `next-work.py --check` 0 · `check-registry.py` 0 · `align.py check --doc curriculum-runtime` 0.

### Requirement status at the finish

| Requirement | Status |
|---|---|
| CR-02, CR-07, CR-08, CR-09, CR-68 | in-app rows above pass with their controls (CR-68 through CR-T63) |
| CR-03, CR-04, CR-05, CR-06, CR-11 | synthetic rows (real Chromium) as before; exercised in the App by the CR-T07 flow |
| CR-10 | persisted as artifact references with version and stored bytes, read back and labelled by version in the product; unit and in-app rows pass |
| CR-59, CR-60 | moved to `cr-e2e` (decision 9); not claimed here |

**Claim for the PR.** Every requirement `cr-browser` owns after decision 9 has evidence at the layer its row names; the PR can close #1391. The completion record is written by the record-only PR after merge, with a reviewer other than the implementer.

## NOT RUN

- The timings CR-T55 and CR-T56 in the app (now `cr-e2e`, decision 9).
- Recon F8 on the `origin/main` build (wheel, pick, crop starvation). The in-app CR-T09 pick and crop pass on this branch; no separate F8 measurement was made.
- Any real device or phone.
- A real model behind the in-app rows (the agent is scripted).

## Manual demo procedure (PRD §15)

1. Local Worker (`scripts/dev-stack.sh`) with a cohort whose profile has `browser_control.enabled`, `sdk_tools.browser` and `curriculum_runtime: { enabled: true }` (no shipped profile has it), plus `input.image_paste` so the element crop reaches the coach.
2. Inject this branch's extension into an app copy (e2e/README "Driving a different .app"), point `hypeproofChat.proxyUrl` at the local Worker, paste the token. Screen unlocked.
3. Copy `e2e/curriculum-runtime/fixtures/kiosk-practice/` into the workspace and start the live preview.
4. Ask the coach to "주문 시작부터 주문 완료까지 눌러보고 오류가 있으면 몇 번째 단계였는지 알려줘". Expect an orange outline on the preview during each step and a `running → done` tool line per step; each tool result carries URL, route, viewport, document generation, artifact version and the document's errors.
5. Open `index.html?plant=console-step3`: the coach must name the error and step 3.
6. Ask it to open `https://example.com`: refused with the reason.
7. Click "화면에서 요소 골라 코치에게 묻기" in the chat panel title bar, click the "주문 시작" button in the preview, check the chip (element, `index.html:23`, crop, "코치에게 보낼 내용 보기"), remove it with ✕, pick again, and ask "이 버튼이 왜 안 돼?".
8. Turn the switch off (profile) and reload: the button, the five tools and the contract are gone.

## Known limitations and risks

- Every observation requires a screenshot (CR-04). With the macOS screen locked the integrated browser produces no composited frames (F7), so every CR action result is an error there.
- F8 is unresolved: on the `origin/main` build the recon measured crops of 2.0–3.0 s and missed picks in the app. CR-60's 1 s target in the app is unverified; the synthetic p50 is not evidence for it.
- The element crop reaches the coach only where the cohort has `input.image_paste`; otherwise the chip says no image goes.
- SDK-path result recording pairs each browser `tool_result` with the oldest pending result, which assumes browser tools run one at a time.
- Step numbers count per `BrowserControl`. With the switch on both runtimes drive the provider's long-lived control (round 3), so steps count across turns; with it off a proxy turn has its own control. (Fixed in the finish: both runtimes call `crNewTurn()` at the start of a turn, so steps restart at 1.) Records captured outside an agent step carry step `null`.
- Indirect escapes (CR-11): the load is stopped when the navigation is requested and the tab is taken back to where the step started, but the other origin may already have received the request (the real run saw 2 requests reach it across 3 attempts). Nothing of that page is observed, returned or recorded.
- The CR-11 guard enforces only during an agent step and for 5 s after it (`ESCAPE_TAIL_MS`), on either runtime: since round 3 the proxy turn no longer closes the CDP session at its end (`proxyTurnBrowser`), so the tail and a pending escape outlive the turn. Closing the shared control (the tab changes, the panel is disposed) still ends the guard. The driven tab is also the student's preview, so outside that window their own navigations are not undone; the agent's next call is then refused by the ordinary scope check. A page timer that leaves more than 5 s after the last step is caught that way, not stopped.
- New windows are closed through `Target.getTargets` / `Target.closeTarget` on the page session, and only windows that were not open when the step began (round 3): a window the student opened earlier is left alone. One the student opens during a step or its 5 s tail is indistinguishable from the agent's and is closed. That works on real Chromium (Playwright build); how the Studio shell's integrated browser routes a popup, and whether those calls reach it there, is not verified. The other origin may receive the popup's first request before it is closed.
- The artifact version refuses only on its entry. A referenced file over 5 MB or a symlink is listed unread (`sha256: null`, `skipped`), so a change to a large file that keeps its size does not produce a new version; a set over 200 files is marked `partial`.
- A browser result record is held under 18,000 characters (the recorder keeps 20,000): URL and paths are capped and, past that, listed files and then records are dropped; `file_count` keeps the real count.
- The viewport-inspection wrapper (`/__hp_viewport`) is out of the agent's scope: the student page is an iframe there, and the main-frame tree, refs and document generation would be the wrapper's. The agent is told to use the preview address instead.
- A log attached after the page loaded (the first CR call of a turn) recovers load-time HTTP errors from the document's Resource Timing (Chromium 109+); load-time network errors without a status (refused connection, DNS) are not recoverable, so such an observation says "확인된 것 없음" and points to `browser_reload`.
- An id-less `Log` entry that arrives within 1 s of a main-frame commit is dropped rather than attributed (it may be the previous document's).
- The artifact version's file set holds static references only (HTML, CSS, JS imports). Files a page loads dynamically (`fetch('menu.json')`, an image `src` built in script) are not in it, so editing only such a file does not produce a new version, and results before and after the edit carry the same version (recon R4's definition; partial coverage of CR-10's "marked as belonging to the earlier version").
- Screenshots and traces are referenced by content digest on the record; the bytes themselves are not stored anywhere, so a digest cannot be resolved to an image later. (Fixed in the finish: the bytes are `blobs/` entries of the same local record, `LocalRecord.putBlob`.)
- CR-10 persistence needs an observation recorder, which the App builds only when the profile names `observation.format`. The validator now fails a profile with the switch on and no format (`cr_without_observation_format`); a profile that bypassed the validator would still drop browser results silently.
- The page-level indicator is the overlay outline; the chat-panel half is the tool-log line (`browserToolLogLine`, now labelled for the five CR tools). `CrHooks.onIndicator` is not wired in the product.
- The artifact version re-reads the file set on every observation (no cache).
- Browser `Log` warnings other than network and JavaScript ones count as records, so a page that triggers, say, a deprecation warning is not "clean".
- A picked element with no snapshot ref gets a pick-only label `p<backendNodeId>` (round 3), never `e<N+1>`, so a later snapshot cannot rebind it to another node; after a fresh observation it is refused and the agent re-reads.
- The switch never grants browser tools: a cohort without `browser_control` / `sdk_tools.browser` sees nothing CR. One minor test covers every CR surface (round 2): the Worker serves the switch through `curriculumRuntimeAllowed` (switch on, not `isMinorCohort`, workshop tier), and the App's `isCurriculumRuntimeEnabled` repeats it on the served profile, so a 13–17 workshop-tier cohort gets no CR tool, contract, element pick or executor on either runtime. Round 3: `curriculumRuntimeAllowed` also requires the audience's lower age bound to be at least 18 (unknown counts as minor), so a mixed-age cohort such as [15, 40] is served the switch off; the App has no age range on the served profile and relies on the served switch for that part. It does not require an explicit `minor_cohort: false` (the stricter `crossProviderEnabled` test), since adult profiles leave that flag unset. The validator fails a child cohort that sets `curriculum_runtime.enabled` or `browser_control.enabled`, and any cohort with `minor_cohort`, or an age_range minimum under 18 or missing, that sets `curriculum_runtime.enabled` (`minor_curriculum_runtime`, round 3; the fixture `teen-cr.json` holds a 14–17 and a 15–40 cohort).
- Open decisions (plan): none of them is decided here; this slice needs no default from them.
