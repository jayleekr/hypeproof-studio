# Curriculum Runtime run record — `cr-publish` (#1393)

Status: run record, 2026-10-02. Item `cr-publish`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

## Claims (after review round 2)

The slice can claim only part of its rows, so its PR says `Refs #1393`, not `Closes`.

| | Rows | Why |
|---|---|---|
| Claimed | CR-11, CR-17, CR-21, CR-22, CR-39, CR-73 | Every positive and negative control of their CR-T rows ran (below) |
| Partial, remainder named | CR-02 | Publish surfaces only. CR-T02's `09-preview.spec.ts` switch-off baseline (the existing HTML creation and preview flows behave as before) is BLOCKED by pre-existing F1 |
| | CR-18 | Emulated phone only (390 px, real Chromium, in the app). The work item's positive control also needs one real phone; no phone was used, and the dev phone path through ngrok was not executed |
| | CR-19 | Every case except CR-T19's "a participant event with a still-valid session token after revocation is refused": no events route exists until `cr-evidence`. The only participant write so far, the session open, is refused (410, nothing written or counted) with a token issued while the link was live |
| | CR-65 | The pseudonym half (CR-T60) ran. CR-T23 (six participant event kinds; an event carrying a name or e-mail field is refused) and CR-T60's event-schema half belong to `cr-evidence`; the pseudonym does not reach the Service yet (the snippet sends only the session token) |
| | CR-66 | Published runtime by runs (CR-T61). Experiment Browser half by static inspection of the shipped base app only, not a run |
| Not claimed | CR-20, CR-64 | Both rest on CR-T20, whose real Mac → real phone half with sample size and p50/p95 is NOT RUN. The synthetic timings below are PARTIAL and claim nothing |

Review round 1 (2026-10-02) changed the session path, the test origin, the App's Project resolution and the scan; every row below was re-run on the round-1 head, and the new controls are listed under "Review round 1". Review round 2 changed the 410's `Clear-Site-Data`, the start of a test, the test-origin match, the scan's URL rule and the App's team Project; its controls are under "Review round 2", and the worker, smoke and real-Chromium rows were re-run on the round-2 head.

## What was run

- Code: branch `feat/cr-publish` off `origin/main` `9e0854af`. The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0). Node 22.23.1 for the gates (as `pr-ci.yml`), Node 24.4.1 for the ad-hoc runs. HypeProof Studio 0.1.51 copy with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked.
- Evidence classes (MC-38): **synthetic** = unit, smoke and worker layers (real Service router over SQLite or local workerd D1, in-memory R2); **synthetic (real browser)** = `e2e/curriculum-runtime/publish-runtime.real.mjs`, Playwright's Chromium emulating a 390 × 844 phone against the real Service router over real HTTP; **live-host (app) / synthetic (Service, model)** = `e2e/curriculum-runtime/publish-app.spec.ts` in the Studio app with `app-service.mjs publish`.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (publish surfaces) | worker `cr-publish.test.mjs`, `cr-switch.test.mjs`; extension `cr-switch.smoke.mjs`, `cr-publish.smoke.mjs`; in-app `publish-app.spec.ts` | PARTIAL (publish surfaces only; CR-02 partial, not claimed) | Off: all nine `/v1/curriculum/*` routes, called with the real ids of a live project and with no token, answer exactly as an unknown route; a live link of a switched-off project answers exactly as an unknown path of its test origin; the command is absent from the palette and no panel appears in the app; the App session sends nothing. On: every route answers, the command opens the panel. A planted route that ignores the switch is caught; M5 (switch check removed) turns the suite red. The `09-preview.spec.ts` switch-off half stays BLOCKED by pre-existing F1 |
| CR-T11 (published-origin cases) | worker `cr-publish.test.mjs` (App session + real Service), extension `cr-publish.smoke.mjs` | PASS | Positive: an agent action on the project's own test origin is allowed; runner steps on it run and pass. Negative: another team's project origin is refused with "범위 밖이라 거절" and no CDP call reaches it; an external origin is refused. M14 (a foreign origin admitted) is caught. After a restart (review round 1): a fresh App with a remembered Project allows its published origin before the publish panel is opened, and a sign-in as another student drops it; read before the owner is refreshed (the pre-fix wiring) the list is empty |
| CR-T17 | worker `cr-publish.test.mjs` (Service half and App session); extension `cr-publish.smoke.mjs`, `publish-panel.smoke.mjs`; in-app `publish-app.spec.ts` | PASS | Positive: same bytes → same version id (second upload 200, `created: false`); a Supabase anon key publishes; in the app the publish action read "검증됨" after an all-pass test of `sha256:7187b0db…` and published it. Negative: a changed file under an existing id → 409, nothing written, the stored bytes unchanged; `.env`, `.npmrc`, a dot-file in a directory, `node_modules`, `../`, absolute and backslash paths refused; an unreferenced file and a referenced dot-file never in the set; a referenced symlink out of the root refuses the set before any request; one planted key per `LLMProvider` (Gemini, Anthropic, OpenAI, GLM), a Supabase service key, a student token and an issuer token bare and as `HYPEPROOF_TOKEN = "…"` refuse the publish in the App before any request and on direct upload to the Worker (422, nothing stored); a forged app token passes the App's decode and is refused by the Worker's signature check; a student of another team gets 404 and nothing is recorded (accepted once the director adds them). Not verified before any test, for another version's report, for a fail, and after a file change (app: `needs_recheck`). M3, M8, M11, M12, M13b, M16, M18 caught |
| CR-T18 | `publish-runtime.real.mjs`, `test-qr.smoke.mjs`, worker, in-app | PARTIAL (emulated phone; CR-18 partial) | The App's QR, decoded by jsQR from its rendered pixels in Chromium, equals the share URL (37 × 37 modules); that URL opens at 390 px (scroll width 390) with the kiosk heading and no login; the only redirect stays on the test origin. Negative: a link variant that redirects to a login page fails the same check (viewport, overflow, login screen, no heading); another link's code and an empty grid do not decode to the URL; M15 caught. In the app the panel showed the URL and its QR and the URL served the product. A real phone: NOT RUN |
| CR-T19 | worker `cr-publish.test.mjs`, `publish-runtime.real.mjs` | PARTIAL (event case left to cr-evidence; CR-19 partial) | Live link 200; after revocation the share URL, the entry path and an asset answer 410 with 0 bytes, `no-store` and `Clear-Site-Data: "cache"` (round 2: `"storage"` dropped, see below), also from the open tab's own origin; an expired link the same; a revoked link opens no session, also with a session token issued while it was live (round 2: 410, no R2 key written, nothing counted). Sibling links (round 2, real Chromium): in one tab, a live repeated-use link of a project, then a revoked Week-1 link of the same project (410), then the live link again keep the same session id and pseudonym; the round-1 410 (`"cache", "storage"`) planted on another project's origin gives a new session id and a new pseudonym on the way back — caught. Cache case (review round 1): a fetch carrying `Service-Worker: script` is answered 404 with no body, so in Chromium a published PWA's cache-first `sw.js` fails to register (`sw-refused:TypeError`), never controls the page, and after revocation both a reload and a new tab get the 410 and no product. Planted pre-fix behaviour (header ignored, no Clear-Site-Data) on another origin: the worker registers, controls the page, and after revocation serves the product with `fromServiceWorker: true` on reload and in a new tab — caught; a link without an expiry → 400 `expiry_required`; past, non-numeric and over-90-day expiries refused; another team's revoke → 404 and the link keeps serving. M2, M10 caught. The case "an event with a still-valid session token after revocation" needs the events route, which cr-evidence adds |
| CR-T20 (CR-20 and CR-64 not claimed) | `publish-runtime.real.mjs`, in-app | PARTIAL (synthetic) | Publish (API) 11–15 ms and open-to-render 97–110 ms on the emulated phone; in the app the one publish action took 76 ms and 127 ms (two runs, local Service). The timing instrument records ≥ 10 s as a miss with its slowest phase (planted 11.9 s upload → "upload 11900ms"). Real Mac → real phone, sample size and p50/p95: NOT RUN |
| CR-T21 | worker `cr-publish.test.mjs` (VM + real Service), `publish-runtime.real.mjs` | PASS | Opening the v0 link (the entry page, then the snippet's one `POST /l/:link/__hp/session`) creates the session key `sessions/published/<id>` on the experiment's record task carrying project, experiment, version, link and channel; the session token names that link and session. One visit is one session (review round 1): an entry-page fetch that runs no script (a link-preview bot) writes nothing and counts nothing; opening the same session again answers 204 and counts once; a forged token or another link's token → 403, nothing written. In Chromium at 390 px, home → menu → home by a link → reload in one tab keeps one session id and one pseudonym and counts 1; the pre-fix snippet planted on another link counts 3 sessions for the same walk (4 session ids) — caught. In the VM the shipped snippet bytes open the session exactly once per tab and retry a refused (429) open with the same session on the next page load; a snippet that adopts every candidate, and one that marks a refused open as done, are each caught. Open cost: one visit makes the same R2 calls at the 1st and the 500th session of a project (no list; at most 8 calls), the task document is not rewritten, and the per-channel read makes no R2 call; the pre-fix `linkSession` path, run beside it at N = 500, makes over 500 R2 reads and a list — caught. A link at its bound (5000 sessions) still serves its pages and answers the open with 429. A session claiming another version is refused and writes nothing (control: the experiment's own version is accepted). M7 caught; M4 caught here too |
| CR-T22 | worker `cr-publish.test.mjs`, `publish-runtime.real.mjs` | PASS | After v1 is published the v0 experiment's link and a pinned demo link keep serving v0, and new sessions stay attributed to v0; a new experiment on v1 serves v1 (positive control of the instrument). Planting the running experiment onto v1 turns the check red; M1 caught |
| CR-T60 (pseudonym half) | worker `cr-publish.test.mjs` (the shipped snippet bytes in a VM), `publish-runtime.real.mjs` | PASS for the pseudonym half (event-schema half left to cr-evidence; CR-65 partial) | Two sessions of one browser in a `repeated_use` experiment share one random `pp-…` pseudonym with different session ids (also in Chromium); a second experiment gets another; an undeclared experiment never shares; a new link or an expired one never reuses the old pseudonym; the snippet reads no device attribute and is under 2 KB. Planted UA-derived, always-stored, browser-wide and link-blind variants are each caught |
| CR-T61 | worker (served policy), `publish-runtime.real.mjs`; static inspection of the shipped base app | PASS (published runtime); Experiment Browser half by inspection only (CR-66 partial) | Undeclared: `Permissions-Policy: camera=(), microphone=()`, `featurePolicy.allowsFeature` false for both, `getUserMedia` → `NotAllowedError` even after the automation granted both permissions to the context. Declared camera: `camera=(self)`, allowed by policy, permission state `prompt` (the browser's own prompt), microphone still denied. No CR automation source calls `Browser.grantPermissions`/`setPermission`; a planted call is caught. M9 caught. The publish box now lets the student declare camera, microphone and repeated use (nothing declared by default, `publish-panel.smoke.mjs`); a declaration sent by the App session reaches the served `camera=(self)` (worker "App project" test). Experiment Browser (static inspection, not a run): HypeProof Studio 0.1.51 `out/main.js`, `browserView/electron-main/browserSession.js`, allows only `pointerLock`, `notifications` and `clipboard-sanitized-write` in both `setPermissionRequestHandler` and `setPermissionCheckHandler`, so camera and microphone requests from the live preview are denied |
| CR-T68 | worker `cr-publish.test.mjs` | PASS | Two labelled links attribute 2 and 1 sessions to their own channels; an unlabelled link counts as unlabelled. The route reads the per-link counters (`cr_test_links.sessions_opened`, one indexed query), which equal the record's own reading of the session keys; a session with no recorded link is "unknown" in the record's reading, never guessed, and never appears in the route's counts (only links open published sessions); a session claiming another experiment, by link or by claim, is refused and writes nothing; revoking one channel's link leaves the other serving. The read is labelled `usage_observation` and the panel says "연 횟수예요. 원한다는 뜻은 아니에요." |
| CR-T80 | worker `cr-publish.test.mjs` (SQLite and `--d1` local workerd D1) | PASS | The PRD §10.1 sample validates; each of the nine fields removed is refused by name; starting a test in a project with none stores the student's open hypothesis and one Experiment whose `hypothesis_id`, `project_id` and `product_version_id` resolve. An unknown or another project's `hypothesis_id` → 409, a missing field → 400, an unknown version → 409, and none of them stores an experiment or an orphan hypothesis. The store inventory finds experiment/hypothesis tables only as `cr_experiments`/`cr_hypotheses`; a planted `student_experiments` is caught. M6 caught |

## Controls red on the pre-change tree and on planted defects

On `origin/main` `9e0854af` with only the new test files copied in: `worker/test/cr-publish.test.mjs`, `cr-publish.smoke.mjs`, `test-qr.smoke.mjs` fail (`ERR_MODULE_NOT_FOUND`: no curriculum routes, no publish modules), `publish-panel.smoke.mjs` fails (no `PublishPanel`), `cr-switch.smoke.mjs` fails (no `publishTestVersion` handler).

Each defect below was planted alone in the implementation, the named suite run, and the file restored (`pub-mutate.py`, scratch): 18 planted, 18 caught. M13 alone (the version-walk skip check removed) was not caught because the on-disk check before reading still refuses the symlink; with both removed (M13b) the smoke is red.

| Plant | Caught by |
|---|---|
| M1 link serves the newest version | CR-T22 |
| M2 revoked link still serves | CR-T19 |
| M3 no Gemini pattern | CR-T17 scan |
| M4 channel not recorded | CR-T21 attribution |
| M5 switch not checked on student routes | CR-T02 |
| M6 hypothesis not resolved | CR-T80 |
| M7 session version not checked | CR-T21 |
| M8 changed bytes accepted under an existing id | CR-T17 upload |
| M9 devices always allowed | CR-T61 Service half |
| M10 expiry optional | CR-T19 |
| M11 cross-team upload allowed | CR-T17 upload |
| M12 dot-files kept in the set | CR-T17 set (smoke) |
| M13b symlink and real-path checks removed | CR-T17 set (smoke) |
| M14 foreign test origin admitted | CR-T11 (smoke) |
| M15 QR of another URL | CR-T18 (QR smoke) |
| M16 panel shows 검증됨 for any reported state | CR-T17 UI (panel smoke) |
| M17 command handler ungated | CR-T02 (switch smoke) |
| M18 scan after the first request | CR-T17 App half |

## Review round 1 (2026-10-02)

Fixes: no service worker on a test origin and `Clear-Site-Data` on 410 (CR-19); one visit = one session, opened by the snippet after the page runs (CR-21, CR-73); a constant-cost open (`LocalRecord.linkSessionKey`, a per-link D1 counter that bounds and indexes sessions, no task rewrite, no quota scan); the App never forks or orphans the Project (only a definite answer creates one; `GET /projects` adopts a team Project); the published origin is known after a restart (`CrProjectMemory`, refreshed at activation and on token change); switch-off answers carry the unknown route's headers (no router-wide `no-store`); the director route checks the scope's profiles and the served profile; the scan lets JavaScript expressions through and still refuses literals; a forged token's refusal names its real line; the App uses "참여 코드"/"강사용 코드" and has Korean words for every refusal code; the publish box declares devices and repeated use; `idx_cr_test_links_project`; `test:cr-publish:d1` in `pr-ci.yml`.

Each defect below was planted alone, `worker/test/cr-publish.test.mjs` run, and the file restored (`mutate.py`, scratch): 15 planted, 14 caught, 1 equivalent.

| Plant | Caught by |
|---|---|
| N1 the `Service-Worker` header ignored | CR-T19 |
| N2 no `Clear-Site-Data` on 410 | CR-T19 |
| N3 the open path back to `linkSession` (task append + quota scan) | CR-T21, CR-T68, scale |
| N4 a session recorded on the entry GET | CR-T21, CR-T68, scale |
| N5 revoked-token check removed | guards |
| N6 roster check removed | guards |
| N7 test-origin port ignored | guards |
| N8 director scope's profiles ignored | guards |
| N9 router-wide `no-store` restored | CR-T02 (headers) |
| N10 App: any project-read failure creates a new Project | App project |
| N11 scan expression skip removed | CR-T17 scan precision |
| N12 channel counts read from every session key | CR-T68, scale |
| N13 signature hit at line 0 | CR-T17 scan precision |
| N14 the open's early "already open" check removed | not caught: equivalent (the `ifAbsent` write and the counter release keep the open idempotent; the check saves a D1 write) |
| N15 a bad session token accepted | CR-T21 |

In `publish-runtime.real.mjs` the pre-fix test origin and the pre-fix snippet are planted on their own origins in the same run (above, CR-T19 and CR-T21); `cr-switch.test.mjs` plants a header-only difference; `cr-publish.smoke.mjs` reads the published origins before the host refreshes the owner (the pre-fix wiring) and gets none.

## Review round 2 (2026-10-02)

Fixes:

- `Clear-Site-Data: "cache"` only on a 410. Every link of a project shares its origin, so `"storage"` ended a live sibling link's visit session and its repeated-use pseudonym (CR-65, CR-73). The no-service-worker rule still covers CR-19's cache case.
- Starting a test checks the test origin and every reference (hypothesis, version, variants, the per-project bound) before any write. It then creates the record task, under the experiment id chosen there, before any D1 row. The task is written outside the review quota (`LocalRecord.createTask(..., { quota: "none" })`), so a start costs the same however many sessions the project holds. Tasks are bounded by 200 experiments per Project, and a hypothesis stored by a start whose experiment insert then fails is deleted. A retried start reuses an open hypothesis with the same statement and answers a running experiment with the same fields and no link yet (200, `reused: true`).
- Links per experiment are bounded (20). With 5000 sessions per link, this bounds an experiment's session keys.
- A failure after the session key's write no longer releases the reservation. It is released only when the key is absent.
- In dedicated mode a test origin's label must be a project label (`prj-<16 hex>`). A template whose suffix covers the Service's host can then never take the API's requests.
- The scan's `url_credentials` rule runs in linear time: no scheme character may precede the scheme, and every part is bounded.
- The App prefers the team Project the director assigned over a remembered solo one when the list answers. A failed list keeps the remembered one.
- The real-Chromium suite runs in CI (`pr-ci.yml` job `cr-publish / real Chromium`).
- The per-channel counter is documented as a bound and index over the record's session keys, not a second store of evidence. Deletion (cr-evidence) must recompute it.

Each defect below was planted alone and the named suite was run. The file was then restored (`mut.py`, scratch). 18 were planted and 17 caught; 1 is equivalent.

| Plant | Caught by |
|---|---|
| E `isMember` ignores the cohort | guards (same user id in another cohort → 404) |
| D the student-route role allow-list removed | guards (an issuer token whose user is on the roster → 404) |
| Q `publishedOrigins()` ignores the switch | `cr-publish.smoke.mjs` (switch off with a remembered origin → none) |
| I `releaseSession` not called on a duplicate open | guards (two concurrent opens of one session count 1) |
| V1 `"storage"` restored in `Clear-Site-Data` | CR-T19 |
| V2 the start's task created under the review quota | scale (start cost after 500 sessions) |
| V3 no test-origin check before the start | test origin (3 retries with no origin leave nothing) |
| V4 a retried start not reused | start |
| V5 an open hypothesis not reused | start |
| V6 the round-1 `url_credentials` pattern | CR-T17 scan cost (320 KB runs under 1 s) |
| V7 any DNS label taken as a test origin | test origin (`{project}.hypeproof-ai.xyz` vs `api.`) |
| V8 no link bound | start |
| V9 no experiment bound | start |
| V10 a remembered solo Project kept over the team's | App project |
| V11b a thrown experiment insert keeps its hypothesis | start (D1 fails on the insert) |
| V12 the D1 rows written before the task | start (R2 fails once during the start) |
| V13 a still-valid session token accepted after revocation | CR-T19 |
| V11 the `!created.ok` branch keeps its hypothesis | not caught: equivalent. Every refusal `createExperiment` can return is checked before any write, so the branch is unreachable without a concurrent delete |

The scale test also shows the pre-fix start cost directly. At N = 500 sessions, a review-quota `createTask` makes over 500 R2 reads and a list. The fixed start makes the same R2 calls before and after the 500 sessions, with no list.

## In-app runs

Review round 1: this round's build (extension and webview, `phase("resolve"` present in the injected `dist/extension.js`) injected into the same prepared copy, `GATE=idle … npx playwright test -c curriculum-runtime/playwright.config.ts publish-app`: 2 passed in 16.4 s (switch off: the command is not reachable; switch on: verified only after an all-pass test of this version, one action publishes, the link serves). The other CR specs were not re-run this round.

First submission:

`GATE=idle HPS_APP_PATH=<prepared copy> bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts` on this branch's build: 6 passed, 2 failed in 1.9 min. Passed: the three `app-layer.spec.ts` tests (cr-browser), both `publish-app.spec.ts` tests, and `verify-app.spec.ts`'s switch-off test. Failed: `verify-app.spec.ts`'s two switch-on tests, the first criterion of a run `not_verified` ("콘솔 기록이 너무 많거나 늦게 읽기 시작해…"). The same config on an app copy with the `origin/main` `9e0854af` build injected fails the same two tests the same way (4 passed, 2 failed, 1.7 min), so this is pre-existing and not changed here (plan: finding under `cr-publish`). `publish-app.spec.ts` re-runs "같은 조건으로 다시 테스트" when the first run is not verified, and reads "검증됨" only from an all-pass report on the same version.

## Gates after review round 2 (Node 22.23.1)

| Command | Exit |
|---|---|
| `worker`: `npm test`, `typecheck`, `validate-profiles` | 0 each |
| `worker`: `test:authoring:d1`, `test:classroom:d1`, `test:native-trial:d1`, `test:classroom-ops:d1`, `test:cr-publish:d1` | 0 each |
| `packages/measurement`: `npm test` | 0 (`LocalRecord.createTask` gained an optional `quota`) |
| `extensions/hypeproof-chat`: `typecheck` | 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 at `test:instructor-render` only, the same environment cause as in round 1 (a stray `react` in `/Users/jaylee/node_modules`); every smoke, `test:classroom-ops:review` and `test:chalk-tools` passed |
| `webview-ui`: `vite build` | 0 |
| `e2e`: `npm run test:cr-publish` (real Chromium, now also the CR-T19 sibling-link case; a new `pr-ci.yml` job runs it) | 0 |
| `scripts/next-work.py --check`, `scripts/check-registry.py` | 0 each |
| hype-align `check --doc curriculum-runtime` | 1: the same pre-existing `cr-recon` stale completion; nothing for `cr-publish` |

## Gates after review round 1 (Node 22.23.1)

| Command | Exit |
|---|---|
| `worker`: `npm test`, `typecheck`, `validate-profiles` | 0 each |
| `worker`: `test:authoring:d1`, `test:classroom:d1`, `test:native-trial:d1`, `test:classroom-ops:d1`, `test:cr-publish:d1` | 0 each |
| `extensions/hypeproof-chat`: `typecheck` | 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 at `test:instructor-render` only, the same environment cause as below (a stray `react` in `/Users/jaylee/node_modules`); every smoke, `test:classroom-ops:review` and `test:chalk-tools` passed |
| `webview-ui`: `vite build` | 0 |
| `packages/measurement`: `npm test` | 0 |
| `e2e`: `npm run test:cr-publish` (real Chromium; CR-T18, CR-T20 synthetic, CR-T61, CR-T60, CR-T22, CR-T19 incl. service worker, CR-T21 one visit) | 0 |
| `scripts/next-work.py --check`, `scripts/check-registry.py` | 0 each |
| hype-align `check --doc curriculum-runtime` | 1: the same pre-existing `cr-recon` stale completion as below; nothing for `cr-publish` |

## Gates (Node 22.23.1), first submission

| Command | Exit |
|---|---|
| `packages/measurement`: `npm test` | 0 |
| `worker`: `npm test` (includes `cr-publish.test.mjs`, `cr-switch.test.mjs`, `route-registry.test.mjs`, `cr-traceability.test.mjs`) | 0 (first run 1: `classroom-ops-commands.test.mjs` AT-33 needs every migration in its fresh-equals-cumulative list; 0032 added, re-run 0) |
| `worker`: `test:authoring:d1`, `test:classroom:d1`, `test:native-trial:d1`, `test:classroom-ops:d1`, `test:cr-publish:d1` | 0 each |
| `worker`: `typecheck`, `validate-profiles`; cohort-harness self-test | 0 each |
| `chalk`: `npm test`, `typecheck` | 0 each |
| `extensions/hypeproof-chat`: `typecheck` | 0 |
| `extensions/hypeproof-chat`: `npm test` | 1 locally, at the last step `test:instructor-render` only (every smoke before it passed). It bundles `react` from `/Users/jaylee/node_modules` (a stray copy above this checkout) next to the webview's own; the same sources from a checkout under `/private/tmp` pass 14 of 14. Environment, not code; CI has no such directory |
| `webview-ui`: `vite build` | 0 |
| `e2e`: `npm run test:cr-publish` | 0 |
| `scripts/next-work.py --check`, `scripts/check-registry.py` | 0 each |
| hype-align `check --doc curriculum-runtime` | 1: `cr-recon` completion stale (`docs/requirements/curriculum-runtime.md` changed since recorded); identical on `origin/main` `9e0854af`; no break for `cr-publish` |

## NOT RUN

- CR-T20 real Mac → real phone (no phone); CR-20 and CR-64 not claimed. The real-phone half of CR-18's positive control, so CR-18 is partial.
- CR-T19's event-after-revocation case, CR-T23 (participant event kinds; an identity field is refused) and CR-T60's event-schema half: no events route until cr-evidence, which owns them. CR-19 and CR-65 are partial.
- The Experiment Browser half of CR-T61: inspected, not run. CR-66 is partial.
- In-app Playwright (`publish-app.spec.ts`) was not re-run in round 2. Round 2 changed no webview code, and the App change (team Project) is covered by the worker "App project" test against the real Service.
- The `09-preview.spec.ts` switch-off baseline of CR-T02 (BLOCKED by pre-existing F1, unchanged).
- The by-hand phone path through ngrok and `scripts/dev-stack.sh` in [curriculum-runtime-dev.md](curriculum-runtime-dev.md#cr-publish--publish-for-user-test-1393): written from the scripts, not executed.
- Production: migration 0032, the test domain's DNS and route, and any deploy (Jay's decisions 5 and 11).
