# Curriculum Runtime run record — `cr-publish` (#1393)

Status: run record, 2026-10-02. Item `cr-publish`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

No physical phone was used. CR-T20's real-phone half is NOT RUN, so CR-20 is not claimed.

## What was run

- Code: branch `feat/cr-publish` off `origin/main` `9e0854af`. The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0). Node 22.23.1 for the gates (as `pr-ci.yml`), Node 24.4.1 for the ad-hoc runs. HypeProof Studio 0.1.51 copy with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked.
- Evidence classes (MC-38): **synthetic** = unit, smoke and worker layers (real Service router over SQLite or local workerd D1, in-memory R2); **synthetic (real browser)** = `e2e/curriculum-runtime/publish-runtime.real.mjs`, Playwright's Chromium emulating a 390 × 844 phone against the real Service router over real HTTP; **live-host (app) / synthetic (Service, model)** = `e2e/curriculum-runtime/publish-app.spec.ts` in the Studio app with `app-service.mjs publish`.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (publish surfaces) | worker `cr-publish.test.mjs`, `cr-switch.test.mjs`; extension `cr-switch.smoke.mjs`, `cr-publish.smoke.mjs`; in-app `publish-app.spec.ts` | PARTIAL (publish surfaces only; CR-02 not claimed) | Off: all nine `/v1/curriculum/*` routes, called with the real ids of a live project and with no token, answer exactly as an unknown route; a live link of a switched-off project answers exactly as an unknown path of its test origin; the command is absent from the palette and no panel appears in the app; the App session sends nothing. On: every route answers, the command opens the panel. A planted route that ignores the switch is caught; M5 (switch check removed) turns the suite red. The `09-preview.spec.ts` switch-off half stays BLOCKED by pre-existing F1 |
| CR-T11 (published-origin cases) | worker `cr-publish.test.mjs` (App session + real Service), extension `cr-publish.smoke.mjs` | PASS | Positive: an agent action on the project's own test origin is allowed; runner steps on it run and pass. Negative: another team's project origin is refused with "범위 밖이라 거절" and no CDP call reaches it; an external origin is refused. M14 (a foreign origin admitted) is caught |
| CR-T17 | worker `cr-publish.test.mjs` (Service half and App session); extension `cr-publish.smoke.mjs`, `publish-panel.smoke.mjs`; in-app `publish-app.spec.ts` | PASS | Positive: same bytes → same version id (second upload 200, `created: false`); a Supabase anon key publishes; in the app the publish action read "검증됨" after an all-pass test of `sha256:7187b0db…` and published it. Negative: a changed file under an existing id → 409, nothing written, the stored bytes unchanged; `.env`, `.npmrc`, a dot-file in a directory, `node_modules`, `../`, absolute and backslash paths refused; an unreferenced file and a referenced dot-file never in the set; a referenced symlink out of the root refuses the set before any request; one planted key per `LLMProvider` (Gemini, Anthropic, OpenAI, GLM), a Supabase service key, a student token and an issuer token bare and as `HYPEPROOF_TOKEN = "…"` refuse the publish in the App before any request and on direct upload to the Worker (422, nothing stored); a forged app token passes the App's decode and is refused by the Worker's signature check; a student of another team gets 404 and nothing is recorded (accepted once the director adds them). Not verified before any test, for another version's report, for a fail, and after a file change (app: `needs_recheck`). M3, M8, M11, M12, M13b, M16, M18 caught |
| CR-T18 | `publish-runtime.real.mjs`, `test-qr.smoke.mjs`, worker, in-app | PASS (emulated phone) | The App's QR, decoded by jsQR from its rendered pixels in Chromium, equals the share URL (37 × 37 modules); that URL opens at 390 px (scroll width 390) with the kiosk heading and no login; the only redirect stays on the test origin. Negative: a link variant that redirects to a login page fails the same check (viewport, overflow, login screen, no heading); another link's code and an empty grid do not decode to the URL; M15 caught. In the app the panel showed the URL and its QR and the URL served the product. A real phone: NOT RUN |
| CR-T19 | worker `cr-publish.test.mjs`, `publish-runtime.real.mjs` | PASS (event case left to cr-evidence) | Live link 200; after revocation the share URL, the entry path and an asset answer 410 with 0 bytes and `no-store`, also from the open tab's own origin; an expired link the same; a link without an expiry → 400 `expiry_required`; past, non-numeric and over-90-day expiries refused; another team's revoke → 404 and the link keeps serving. M2, M10 caught. The case "an event with a still-valid session token after revocation" needs the events route, which cr-evidence adds |
| CR-T20 | `publish-runtime.real.mjs`, in-app | PARTIAL (synthetic) | Publish (API) 11–15 ms and open-to-render 97–110 ms on the emulated phone; in the app the one publish action took 76 ms and 127 ms (two runs, local Service). The timing instrument records ≥ 10 s as a miss with its slowest phase (planted 11.9 s upload → "upload 11900ms"). Real Mac → real phone, sample size and p50/p95: NOT RUN |
| CR-T21 | worker `cr-publish.test.mjs` | PASS | Opening the v0 link creates the session key `sessions/published/<id>` on the experiment's record task carrying project, experiment, version, link and channel; the session token names that link and session. A session claiming another version is refused and writes nothing (control: the experiment's own version is accepted). M7 caught; M4 caught here too |
| CR-T22 | worker `cr-publish.test.mjs`, `publish-runtime.real.mjs` | PASS | After v1 is published the v0 experiment's link and a pinned demo link keep serving v0, and new sessions stay attributed to v0; a new experiment on v1 serves v1 (positive control of the instrument). Planting the running experiment onto v1 turns the check red; M1 caught |
| CR-T60 (pseudonym half) | worker `cr-publish.test.mjs` (the shipped snippet bytes in a VM), `publish-runtime.real.mjs` | PASS (event-schema half left to cr-evidence) | Two sessions of one browser in a `repeated_use` experiment share one random `pp-…` pseudonym with different session ids (also in Chromium); a second experiment gets another; an undeclared experiment never shares; a new link or an expired one never reuses the old pseudonym; the snippet reads no device attribute and is under 2 KB. Planted UA-derived, always-stored, browser-wide and link-blind variants are each caught |
| CR-T61 | worker (served policy), `publish-runtime.real.mjs` | PASS | Undeclared: `Permissions-Policy: camera=(), microphone=()`, `featurePolicy.allowsFeature` false for both, `getUserMedia` → `NotAllowedError` even after the automation granted both permissions to the context. Declared camera: `camera=(self)`, allowed by policy, permission state `prompt` (the browser's own prompt), microphone still denied. No CR automation source calls `Browser.grantPermissions`/`setPermission`; a planted call is caught. M9 caught |
| CR-T68 | worker `cr-publish.test.mjs` | PASS | Two labelled links attribute 2 and 1 sessions to their own channels; an unlabelled link counts as unlabelled; a session with no recorded link is "unknown", never guessed; a session claiming another experiment, by link or by claim, is refused and writes nothing; revoking one channel's link leaves the other serving. The read is labelled `usage_observation` and the panel says "연 횟수예요. 원한다는 뜻은 아니에요." |
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

## In-app runs

`GATE=idle HPS_APP_PATH=<prepared copy> bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts` on this branch's build: 6 passed, 2 failed in 1.9 min. Passed: the three `app-layer.spec.ts` tests (cr-browser), both `publish-app.spec.ts` tests, and `verify-app.spec.ts`'s switch-off test. Failed: `verify-app.spec.ts`'s two switch-on tests, the first criterion of a run `not_verified` ("콘솔 기록이 너무 많거나 늦게 읽기 시작해…"). The same config on an app copy with the `origin/main` `9e0854af` build injected fails the same two tests the same way (4 passed, 2 failed, 1.7 min), so this is pre-existing and not changed here (plan: finding under `cr-publish`). `publish-app.spec.ts` re-runs "같은 조건으로 다시 테스트" when the first run is not verified, and reads "검증됨" only from an all-pass report on the same version.

## Gates (Node 22.23.1)

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

- CR-T20 real Mac → real phone (no phone); CR-20 not claimed.
- CR-T19's event-after-revocation case and CR-T60's event-schema half: no events route until cr-evidence.
- The `09-preview.spec.ts` switch-off baseline of CR-T02 (BLOCKED by pre-existing F1, unchanged).
- The by-hand phone path through ngrok and `scripts/dev-stack.sh` in [curriculum-runtime-dev.md](curriculum-runtime-dev.md#cr-publish--publish-for-user-test-1393): written from the scripts, not executed.
- Production: migration 0032, the test domain's DNS and route, and any deploy (Jay's decisions 5 and 11).
