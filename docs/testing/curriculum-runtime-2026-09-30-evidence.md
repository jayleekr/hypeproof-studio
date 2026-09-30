# Curriculum Runtime run record — `cr-browser` (#1391)

Status: run record, 2026-09-30. Item `cr-browser`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer (plan, "What done means").

No real-device run was made: no Studio app run with this branch reached a CR surface, no reference-Mac timing, no phone.

## What was run

- Code: branch `feat/cr-browser` off `origin/main` `9d73f0f5`. Implementation commits `57cd4216` (core), `46f34b6e` (App wiring), `1b171f50` (Worker switch), `5ce034f4` (fixture and real-Chromium run), `fee58eca` (widened controls), then the review-round-1 fix commit (section "Review round 1"). The submitted SHA is the branch head that carries this file.
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
| `e2e` `npm run test:cr-browser` (real Chromium) | round 0: 0 · 0 · 0 (32/32 each); after review round 1: 0 · 0 · 0 (43/43 each) |

## Results per CR-T row

"Unit/smoke" rows run in CI (`npm test`). "Real Chromium" is `e2e/curriculum-runtime/experiment-browser.real.mjs`: real engine and Studio's own `serveStatic` + live-reload, not the Studio app.

| Row | Layer run | Class | Result | What it leaves |
|---|---|---|---|---|
| CR-T02 | Worker half `worker/test/cr-switch.test.mjs`; App unit half `test/cr-switch.smoke.mjs` (context-key value and SDK registration decision included); in-app `09-preview.spec.ts` | synthetic | Worker half PASS, App unit half PASS; **in-app BLOCKED**: the positive control (`09-preview.spec.ts`, switch off) is red on the pre-change build too (below) | in-app walk with the switch on (needs a CR-enabled local cohort) |
| CR-T03 | `test/cr-provider-neutral.smoke.mjs` | synthetic | PASS (modules incl. `crHostWiring.ts` scanned; 5-call parity SDK vs proxy; an external origin refused with the same text by both runtimes) | verify-runner module (`cr-verify`) |
| CR-T04 | `test/experiment-browser.smoke.mjs`; real Chromium | synthetic | PASS | Studio app run |
| CR-T05 | `test/experiment-browser.smoke.mjs`; real Chromium | synthetic | PASS (3 records planted, 0 clean, previous document kept apart, SSE reload = new document; log attached after load: the load-time 404 of `typo.html` recovered, a clean late-attached page reads "확인된 것 없음", never "없음"; an id-less Log entry right after a commit is not put on the new document) | Studio app run |
| CR-T06 | `test/experiment-browser.smoke.mjs`; real Chromium | synthetic | PASS | Studio app run |
| CR-T07 | real Chromium, scripted agent over CR-06 actions, kiosk fixture | synthetic | PASS (5 steps; planted disabled step 4 → failure at 4) | **Playwright e2e in the app NOT RUN** |
| CR-T08 | unit half in the smoke; real Chromium | synthetic | PASS (planted error at step 3 reported once at 3; clean flow none, also with `console.log`/`console.info` on every step; an error the student causes between agent steps carries step `null`) | **Playwright e2e in the app NOT RUN** |
| CR-T09 | `test/element-pick.smoke.mjs`, `test/element-preview.smoke.mjs` (real ChatPanel render); `test/cr-host.smoke.mjs` (queue, send, remove); real Chromium incl. an inspect-mode click | synthetic | PASS (ref = snapshot ref, snippet, style subset, element crop, `index.html:23`; script-generated → `unmapped`, also a script-made clone sharing `#begin`'s text; removed → the next turn carries no element text or crop; sent text = previewed `sentText`; the crop joins a queued page screenshot) | **in-app pick NOT RUN**; F8 unresolved |
| CR-T10 | `test/artifact-version.smoke.mjs` (helpers); `test/cr-host.smoke.mjs` (the recording module the provider calls) | synthetic | helper level PASS (v0 result stored on `LocalRecord`, readable and labelled v0 after v1; no version → refused). Host level: one proxy call, one SDK tool_result and one pick each produce an `hps-browser-result/1` tool_result event through `crHostWiring.ts`; the provider's calls into it are checked by source match, **not by driving `ChatPanelProvider`** | an in-app run that reads the record back |
| CR-T11 | smoke; `test/cr-host.smoke.mjs`; real Chromium | synthetic | `cr-browser` cases PASS: live-server origin runs; external, `file://`, other port, external history entry refused before any CDP call; **indirect escapes** (a link click, a script setting `location`, a form submit, the other origin's paths colliding with `index.html`) refused, nothing observed or recorded, tab back on the preview; the viewport wrapper `/__hp_viewport` refused with a reason; **SDK runtime**: `browser_open` to another origin refused before any tab call (and denied in `canUseTool`, no modal), `browser_screenshot` returns the CR refusal instead of falling back | runner cases (`cr-verify`), published-origin cases (`cr-publish`); the `canUseTool` denial is not driven by a test (`sdkCoach.ts` needs the SDK) |
| CR-T55 | — | — | **NOT RUN** (reference Mac with the app, 30 saves) | all |
| CR-T56 | unit controls in `element-pick.smoke.mjs`; real Chromium n=30 | synthetic | controls PASS; real Chromium p50 17 / 17 / 25 ms (3 runs, n=30 each, M3 Pro) | **reference-Mac app run NOT RUN**; recon F8 measured 2.0–3.0 s crops on the `origin/main` build in the app |
| CR-T63 | unit half in the smoke; real Chromium (outline visible mid-step, evidence screenshot clean, gone after) | synthetic | `cr-browser` case PASS | **Playwright in the app NOT RUN**; runner case (`cr-verify`) |

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
| CR-02–CR-11, CR-68 | synthetic evidence only (rows above); no app-layer PASS |
| **CR-59** (preview refresh p50 < 2 s) | **not met, not claimed.** CR-T55 NOT RUN, and this branch changes nothing on the refresh path |
| **CR-60** (element capture < 1 s) | **not met, not claimed.** Only the headless-Chromium p50 exists; recon F8 measured 2.0–3.0 s crops in the app on `origin/main`, which is evidence against the target there |

The ledger keeps CR-59 and CR-60 on this item's scope (the plan assigns them here); they stay open until CR-T55 and CR-T56 run in the app on the reference Mac.

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

## NOT RUN

- Every CR-T row in the Studio app (Playwright e2e and real Mac): CR-T02 switch-on walk, CR-T07, CR-T08, CR-T09, CR-T63, and the timings CR-T55, CR-T56.
- Recon F8 (the `origin/main` build starving the browser tab: wheel, pick, crop). It needs an unlocked screen; every app run here was locked (F7).
- Any real device or phone.

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
- Step numbers count per `BrowserControl`: a proxy turn starts at 1, the SDK coach's executor counts across turns. Records captured outside an agent step carry step `null`.
- Indirect escapes (CR-11): the load is stopped when the navigation is requested and the tab is taken back to where the step started, but the other origin may already have received the request (the real run saw 2 requests reach it across 3 attempts). Nothing of that page is observed, returned or recorded.
- The viewport-inspection wrapper (`/__hp_viewport`) is out of the agent's scope: the student page is an iframe there, and the main-frame tree, refs and document generation would be the wrapper's. The agent is told to use the preview address instead.
- A log attached after the page loaded (the first CR call of a turn) recovers load-time HTTP errors from the document's Resource Timing (Chromium 109+); load-time network errors without a status (refused connection, DNS) are not recoverable, so such an observation says "확인된 것 없음" and points to `browser_reload`.
- An id-less `Log` entry that arrives within 1 s of a main-frame commit is dropped rather than attributed (it may be the previous document's).
- The artifact version's file set holds static references only (HTML, CSS, JS imports). Files a page loads dynamically (`fetch('menu.json')`, an image `src` built in script) are not in it, so editing only such a file does not produce a new version, and results before and after the edit carry the same version (recon R4's definition; partial coverage of CR-10's "marked as belonging to the earlier version").
- Screenshots and traces are referenced by content digest on the record; the bytes themselves are not stored anywhere, so a digest cannot be resolved to an image later.
- CR-10 persistence needs an observation recorder, which the App builds only when the profile names `observation.format`. The validator now fails a profile with the switch on and no format (`cr_without_observation_format`); a profile that bypassed the validator would still drop browser results silently.
- The page-level indicator is the overlay outline; the chat-panel half is the tool-log line (`browserToolLogLine`, now labelled for the five CR tools). `CrHooks.onIndicator` is not wired in the product.
- The artifact version re-reads the file set on every observation (no cache).
- Browser `Log` warnings other than network and JavaScript ones count as records, so a page that triggers, say, a deprecation warning is not "clean".
- The switch never grants browser tools: a cohort without `browser_control` / `sdk_tools.browser` sees nothing CR. Minors get no CR tool or contract on either runtime (the proxy path now checks `isMinorCohort` too), no element pick (the App checks the tier), and the validator fails a child cohort that sets `curriculum_runtime.enabled` or `browser_control.enabled`.
- Open decisions (plan): none of them is decided here; this slice needs no default from them.
