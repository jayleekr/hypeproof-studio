# cr-publish evidence report

Status: evidence for the `cr-publish` completion record (CR-02, CR-11, CR-17–CR-22, CR-39, CR-64–CR-66, CR-73). 2026-10-02. Owner: jayleekr.
Item: `cr-publish`, issue [#1393](https://github.com/jayleekr/hypeproof-studio/issues/1393), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1440](https://github.com/jayleekr/hypeproof-studio/pull/1440), squash-merged as `f5d5d745651f5cf0e943660b2ce85def1ad0024d`. The implementation's run record with all review rounds is [curriculum-runtime-2026-10-02-evidence.md](../testing/curriculum-runtime-2026-10-02-evidence.md); this report re-runs the review round 3 controls at the merge commit.

What the PR does not claim, and this report does not either (claim table in the run record): CR-02 partial (publish surfaces only; the `09-preview.spec.ts` switch-off baseline BLOCKED by pre-existing F1), CR-18 partial (emulated phone, no real phone), CR-19 partial (the "event with a still-valid session token after revocation" case needs `cr-evidence`'s events route), CR-65 partial (CR-T60 pseudonym half only), CR-66 partial (Experiment Browser half by static inspection), CR-20 and CR-64 not claimed (CR-T20's real Mac → phone half NOT RUN). The PR says `Refs #1393`.

## Completion boundary

This report preserves the recorder's test evidence; it does not mark `cr-publish` complete in the ledger. `align.py record cr-publish --commit f5d5d745651f5cf0e943660b2ce85def1ad0024d --pr 1440 --tests CR-T02,CR-T11,CR-T17,CR-T18,CR-T19,CR-T20,CR-T21,CR-T22,CR-T60,CR-T61,CR-T68,CR-T80 --evidence docs/evidence/cr-publish.md --reviewed-by cr-publish:review:regression-conventions:r3` exited 1 with `refused: cr-publish depends on work that is not complete: cr-verify; record or re-record it first`. The cause is upstream of this item: `align.py next --doc curriculum-runtime` at `f5d5d745` names `cr-recon` as REOPENED (`completion no longer holds (changed since recorded: docs/requirements/curriculum-runtime.md)`), `cr-browser` waits on it and has no completion (see [cr-browser.md](cr-browser.md), "Completion boundary"), and `cr-verify` waits on `cr-browser` (see [cr-verify.md](cr-verify.md), "Completion boundary"). Re-recording `cr-recon`, then recording `cr-browser` and `cr-verify`, comes before this item's record can be written; this report is the evidence to cite then. Two of the test IDs above (CR-T20, and CR-T02 for its F1-blocked half) carry PARTIAL results, as the claim table says.

## Verdict

PASS at `f5d5d745` for every round 3 control below: the worker suite on SQLite and on local workerd D1, 17 of 17 planted defects caught, the real-Chromium runtime checks, and the in-app publish spec. Evidence classes (MC-38): **synthetic** (worker over SQLite or local workerd D1 with in-memory R2; extension smokes), **synthetic (real browser)** (`publish-runtime.real.mjs`, Playwright Chromium emulating a 390 × 844 phone against the real Service router over HTTP), **live-host (app) / synthetic (Service, model)** (`publish-app.spec.ts` in a HypeProof Studio 0.1.51 copy with this commit's extension and webview injected, local `app-service.mjs`). No real phone, no real model, no production host.

## Reviewers

| Label | Role |
|---|---|
| `cr-publish:review:acceptance:r3` | independent review, acceptance lens, round 3 (PR #1440) |
| `cr-publish:review:adversarial:r3` | independent review, adversarial lens, round 3 (PR #1440) |
| `cr-publish:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 (PR #1440); proposed as `reviewed_by` for the ledger completion |

The recorder is a record-only agent that did not write the implementation.

## Environment

2026-10-02, Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0), Node v24.4.1. Worktree `chore/record-cr-publish` cut from `origin/main` = `f5d5d745651f5cf0e943660b2ce85def1ad0024d`; `npm ci` in `packages/measurement`, `worker`, `extensions/hypeproof-chat`, its `webview-ui` and `e2e`. No tracked file changed while the tests ran (`git status --short` empty after the mutation run and after the build).

## Positive controls (unmutated tree)

| Command (from the worktree root) | Result |
|---|---|
| `cd worker && node --experimental-strip-types --experimental-sqlite --no-warnings test/cr-publish.test.mjs` | exit 0, 22 checks ✅, 0 ❌, `cr-publish (worker SQLite): OK` |
| `cd worker && node --experimental-strip-types --experimental-sqlite --no-warnings test/cr-publish.test.mjs --d1` | exit 0, 22 checks ✅, 0 ❌, `cr-publish (worker local workerd D1): OK` |
| `cd e2e && npm run test:cr-publish` (`curriculum-runtime/publish-runtime.real.mjs`, real Chromium) | exit 0, all 9 checks ✅ |
| `GATE=idle HPS_APP_PATH=<prepared copy> bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts publish-app` (from `e2e/`) | exit 0, `2 passed (18.5s)`, first attempt behind the idle gate |

The round 3 rows in the worker suite, each with its positive and negative case inside the same check (names as printed, both on SQLite and on D1):

| Row | Check |
|---|---|
| CR-T21, CR-T22 variant links through the routes | "CR-T21: opening the v0 link creates one participant session record carrying project, experiment and version; a fetch that runs no script opens none; …" · "CR-T22: publishing v1 while the v0 experiment runs leaves its link, its sessions and a pinned demo on v0" |
| CR-T68 two experiments in one Project, grouped project counts | "CR-T68: two channel-labelled links attribute their sessions to their own channel; a mismatched claim is refused; no link = unknown channel; …" |
| CR-T80 another Project's version and variant version refused | "CR-T80: the PRD §10.1 sample validates; any one field removed is refused; starting a test stores the hypothesis and one Experiment whose ids resolve …" |
| start: declarations retry, 3 concurrent starts, 30 concurrent link creates, version and Project caps | "start: a storage failure while starting leaves no experiment and no hypothesis; a retried start reuses its hypothesis and experiment; a new run after …" |
| CR-T02 switch OFF before migration 0032, malformed digest | "CR-T02 switch OFF before migration 0032: the director's team route answers as an unknown route without reading D1; a malformed version id is a 400" |
| App project: solo live link stays visible, revoke gives 410, then the panel moves | "App project: a transient failure aborts instead of creating a second Project; a switch-off answer keeps the remembered id; a teammate adopts the team's Project; a solo Project with a live link is kept until its links are off; a declared device reaches the served policy" |
| CR-T17 scan cost: `eyJ-` runs and the many-hits case | "CR-T17 scan cost: a few hundred KB of dotted or kebab-case runs scans in linear time; a URL with credentials is still refused" |

The other checks of the same run, also green on both backends: CR-T02 inventory and switch OFF, CR-T17 scan / upload / App half / scan precision, CR-T18/CR-T61 Service half, CR-T19, CR-T60 pseudonym, test origin, CR-T11 published-origin cases, CR-18/CR-20 scale, guards, CR-64 timing instrument.

Real Chromium (`publish-runtime.real.mjs`): CR-T18 (the QR decoded by jsQR equals the share URL; 390 px, scroll width 390, no login, kiosk heading), CR-T20 synthetic (publish 11 ms, open-to-render 66 ms on the emulated phone; claims nothing), CR-T61 (undeclared camera and microphone denied, `getUserMedia` → `NotAllowedError`), CR-T60 browser (two declared sessions share one pseudonym; another experiment and an undeclared one differ), CR-T22 browser (the v0 link after a v1 publish does not show v1), CR-T19 browser (410, 0 bytes, `no-store` on every path), CR-T19 service worker (registration refused; the planted pre-fix origin serves from the worker after revocation, caught), CR-T19 sibling links (session and pseudonym kept; the planted `"storage"` wipe changes both, caught), CR-T21 one visit (1 session, counted 1; the planted pre-fix snippet makes 4 sessions, counted 3, caught).

In-app (`publish-app.spec.ts`): "CR-T02 in-app, switch off: the publish command is not reachable" and "CR-T17/CR-T18 in-app: verified only after an all-pass test of this version; one action publishes and the link serves". The app copy is `/Applications/HypeProof Studio.app` 0.1.51 copied to scratch, `extensions/hypeproof-chat/{dist,webview-ui/dist,media,package.json}` from this commit's `npm run build` injected (`phase("resolve"` present in the injected `dist/extension.js`), prepared with `scripts/prep-test-app.sh` (LSUIElement=1).

Supporting runs at the same tree (exit codes): `extensions/hypeproof-chat` `test/cr-publish.smoke.mjs` 0 (`6 cr-publish smoke checks passed`) · `test/test-qr.smoke.mjs` 0 · `test/publish-panel.smoke.mjs` 0 (`8 publish panel checks passed`) · `test/cr-switch.smoke.mjs` 0 (`12 cr-switch checks passed`) · `worker` `test/cr-switch.test.mjs` 0 · `python3 scripts/next-work.py --check` 0 · `python3 scripts/check-registry.py` 0. Full `npm test` of `worker` and `extensions/hypeproof-chat` was not re-run by the recorder.

## Negative controls: 17 planted defects

Scratch runner `r3-mut.py` (the round 3 script, pointed at this worktree): each defect planted alone by exact-anchor replacement (anchor count checked to be 1), `worker/test/cr-publish.test.mjs` run on SQLite or with `--d1`, the files restored before the next plant.

| Planted defect | File | Backend | Result |
|---|---|---|---|
| none (positive control) | — | SQLite | GREEN (rc 0) |
| A1 a variant link serves the base version | `curriculum-test-origin.ts` | SQLite | RED: CR-T22 |
| A5 channel counts read across the Project | `store.ts` | SQLite | RED: CR-T68 |
| A10 session attribution names the experiment's base version | `participant-record.ts` | SQLite | RED: CR-T21, CR-T22 |
| A22 declarations left out of the start key | `curriculum.ts` | SQLite | RED: start |
| A23 open start key not cleared by a link | `store.ts` | SQLite | RED: start |
| A28 another Project's version accepted | `store.ts` | SQLite | RED: CR-T80 |
| A31 session token not bound to its link | `session-token.ts` | SQLite | RED: CR-T21 |
| R3-1 (`M1`) members route reads D1 before the switch | `curriculum.ts` | SQLite | RED: CR-T02 before migration 0032 |
| R3-2 (`M2`) version digest decoded twice | `curriculum.ts` | SQLite | RED: CR-T02 before migration 0032 |
| R3-3 (`M3`) solo Project with live links left for the team | `publishSession.ts` | SQLite | RED: App project |
| R3-4 (`M5`) token shape may start inside a run | `publish-scan.ts` | SQLite | RED: CR-T17 scan cost |
| R3-5 (`M6`) line number rescans the text per hit | `publish-scan.ts` | SQLite | RED: CR-T17 scan cost |
| R3-6 (`M7`) no version bound per Project | `store.ts`, `curriculum.ts` | SQLite | RED: start |
| R3-7 (`M8`) no Project bound per creator | `store.ts` | SQLite | RED: start |
| none (positive control) | — | D1 | GREEN (rc 0) |
| C1 link bound as check-then-insert | `store.ts`, `curriculum.ts` | D1 | RED: start (30 concurrent link creates) |
| C2 open start key index not unique | migration 0032, `schema.sql` | D1 | RED: start (3 concurrent starts) |
| C3 open statement index not unique | migration 0032, `schema.sql` | D1 | RED: start |

All 17 RED, both unmutated controls GREEN. Difference from the round 3 run: there R3-6 and R3-7 were caught on D1 only; at `f5d5d745` they are caught on SQLite as well (the start check fails with `TypeError: Cannot read properties of undefined (reading 'code')`: the cap refusal it expects never comes).

The script also carries one earlier-round plant outside the 17, `A29` (links issued on an experiment that is not running: the `experiment_not_running` guard removed). It survives at `f5d5d745`, as it did in the round 3 run: no check issues a link on a closed experiment. Reported as a test gap, not changed here.

## NOT RUN

- A real phone (CR-18, CR-T20's Mac → phone half with sample size and p50/p95; CR-20 and CR-64 stay unclaimed), and the dev phone path through ngrok.
- `09-preview.spec.ts` switch-off baseline for CR-T02 (BLOCKED by pre-existing F1).
- CR-T23 and CR-T60's event-schema half, and CR-T19's events-route case: `cr-evidence`.
- The other in-app CR specs (`app-layer.spec.ts`, `verify-app.spec.ts`) at `f5d5d745`.
- Any real model, any production host, D1 migration or route.
- GitHub was not read by the recorder (the API budget belongs to the shipping agent); main CI at `f5d5d745` is not re-read here.
