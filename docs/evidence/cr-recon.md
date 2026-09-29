# cr-recon evidence report

Status: evidence for the `cr-recon` completion record (CR-01, CR-T01). 2026-09-29. Owner: jayleekr.
Item: `cr-recon`, issue [#1390](https://github.com/jayleekr/hypeproof-studio/issues/1390), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1420](https://github.com/jayleekr/hypeproof-studio/pull/1420), squash-merged as `5e82f590c8200b45b26a97809cf8e289c9df0ac7` (single parent `cc3785260e92315dcc4bc31410b7cc79713f604e`, the commit the recon page says it was read at).
Output under test: [curriculum-runtime-recon.md](../plan/curriculum-runtime-recon.md), checked by `worker/test/cr-recon.test.mjs` with its frozen control inputs `worker/test/fixtures/cr-recon/frozen-inputs.json`.

## Verdict

PASS for CR-T01 at `5e82f590`. Evidence class: doc check (CI layer of the testing contract); the verdict was re-run by the recorder at the merge commit, not copied from the PR.

## Reviewers

| Label | Role |
|---|---|
| `cr-recon:review:acceptance:r3` | independent review, acceptance lens, round 3 of PR #1420 |
| `cr-recon:review:adversarial:r3` | independent review, adversarial lens, round 3 of PR #1420 |
| `cr-recon:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 of PR #1420; named as `reviewed_by` in the ledger completion |

The recorder is a record-only agent that did not write the recon.

## Commands and outputs

All runs on 2026-09-29, macOS arm64, Node v24.4.1, in a worktree cut from `origin/main` = `5e82f590c8200b45b26a97809cf8e289c9df0ac7` with no local change, before the record was written (so CR-T01 reads the tree: "cr-recon has no completion yet").

### Positive control

| Command | Result |
|---|---|
| `cd worker && node --experimental-strip-types test/cr-recon.test.mjs` | exit 0. `cr-recon (CR-T01): OK — verdict read at this tree (cr-recon has no completion yet) · 10 areas · 73 map entries · 84 matrix rows · 11 decisions · 34 negative controls each caught, on the frozen inputs and a temp directory · external not checked here: 10` (the three `vscodium@59e5792…` entries, five `vscode@1.116.0` entries, two `lab:` gallery routes). |
| the same with `HPS_VSCODE_SRC=<vscodium-base/vscode, git HEAD 560a9dba96f9>` `HPS_VSCODIUM_SRC=<vscodium-base git holding 59e579274e3a>` `HPS_LAB=<hypeprooflab worktree whose web/src/app/api/gallery equals Lab origin/main 141d41f4>` | exit 0. Same line ending `external not checked here: 0`. The external checkouts were only read (`git show`). |

### Negative controls

Built into CR-T01: 34 planted defects, each reported exactly once, on the page plus the frozen inputs and on a temporary directory (the count is in the positive-control line above).

Run by the recorder on a scratch clone of `5e82f590`, one edit at a time, each reverted before the next; the clean tree passed before and after:

| Planted defect | Result |
|---|---|
| `CdpSession` renamed in `extensions/hypeproof-chat/src/cdpSession.ts` (3 lines changed, counted) | exit 1: ``map M1.5: extensions/hypeproof-chat/src/cdpSession.ts: symbol `CdpSession` not found`` and ``matrix CR-08: … symbol `CdpSession` not found``. |
| CR-47 dropped from `cr-skills` in `config/requirement-work.json` | exit 1: `matrix CR-47: cr-skills does not cite CR-47 in the ledger` and `strategy cr-skills: CR-T44 targets none of the item's requirements`. |
| `extensions/hypeproof-chat/src/liveServer.ts` deleted | exit 1: `map M3.2: … path does not exist`, `matrix CR-54: … path does not exist`, `matrix CR-59: … path does not exist`. |

Instrument check: the first attempt at the rename used BSD `sed -E 's/\bCdpSession\b/…/'`, which matches nothing on macOS, so the file was unchanged and the test passed. The post-record run in the same attempt printed "this tree still matches the recorded map", which exposed it. The rename was redone with `perl -pi` and a line count (3), and the results above are from that run.

### Read modes after a record (simulation)

In a scratch clone of `5e82f590`, a `cr-recon` completion naming `5e82f590` was written with `align.py record` (placeholder report, reviewer `sim-reviewer`) and committed locally, then:

| Case | Result |
|---|---|
| full clone, clean | exit 0, `verdict read at commit 5e82f590c820 (the page and frozen inputs are the ones cr-recon recorded at 5e82f590c820)`, `INFO this tree still matches the recorded map`. |
| full clone, `CdpSession` renamed later | exit 0, verdict read at the commit; INFO lists M1.5 and CR-08 as divergence. |
| full clone, recon page edited plus `CdpSession` renamed | exit 1: the page no longer matches its pin, so the tree is checked again and M1.5 / CR-08 fail. |
| `--depth 1` clone (as `pr-ci.yml` checks out), clean | exit 0, `verdict NOT RE-RUN (this clone lacks 5e82f590c820, where cr-recon was recorded (shallow checkout))`, 34 controls run. |
| `--depth 1`, `CdpSession` renamed later | exit 0, NOT RE-RUN; INFO lists M1.5 and CR-08. |
| `--depth 1`, frozen inputs tampered (`CR-47` → `CR-470`) | exit 1: `worker/test/fixtures/cr-recon/frozen-inputs.json is not the projection of the verdict's inputs …`. |

This matches the three read modes the recon header describes. The real record pins the same page and frozen inputs, so it selects the same modes.

### Ledger state before the record

| Command | Result |
|---|---|
| `align.py check --studio <this worktree> --doc curriculum-runtime` (Harness `44e6bbb`) | exit 0, `chain intact for 11 items`. |
| `align.py next --studio <this worktree> --doc curriculum-runtime` | exit 0, `next is cr-recon (#1390)`; the other 10 `cr-*` items wait on it (offline; issue state not read). |

### How symbols were located

As recorded in the recon, §8: each named file read at the recorded commit (`grep -n` for exports and call sites, then the surrounding code); upstream VS Code files read at the pinned `HEAD` of a local 1.116.0 checkout; the pinned submodule with `git -C vscodium-base show 59e57927:<path>`; the Lab routes in a hypeprooflab worktree. CR-T01 re-locates every entry mechanically (one word-bounded match outside comments per file), which proves the symbol occurs in the file, not that it is the declaration the role column describes; that part is the reviewers' reading.

## Open PRs checked

The recon (§8) left this item's negative control "a gap called new while an open PR already implements it is recorded as a finding" unverified and required this section.

Open-PR check done by the coordinator on 2026-09-29 with gh: none of the open Studio PRs (#1419, #1408, #1406, #1402, #1381, #1306) references #557, #1018, #1172, #1020 or #1009 in title or body, so no reused-requirement owner has in-flight work that contradicts a recon matrix row. PR #1419 edits config/traceability.json (node ownership) and may need a rebase after CR changes.

Findings against the recon from this check: none. Limit: the check read titles and bodies, not diffs, so an open PR that implements a gap without naming one of those issues would not be caught.

## Main CI at the merge commit

Reported by the coordinator for the push of `5e82f590` to `main`: `Requirement work coverage`, `main-guard` and `studio-pr-ci` completed with success. The recorder did not read GitHub (the API budget belongs to the shipping agent), so these are not re-read here.

## Not inspected

- By the recon (§8): Chalk (`chalk/`), `packages/measurement` beyond its CI job, Windows, the real-phone path, production configuration, the Lab gallery DB schema.
- By this record: the CDP probe (`e2e/curriculum-runtime/cdp-probe.mjs`), the app e2e (`e2e/tests/09-preview.spec.ts`, F1) and the extension browser smokes were not re-run; they are the recon's supporting runs, not CR-T01. GitHub was not read.
- Findings F1–F10 and the open decisions stay as the recon records them (§9); F8 and F1 are `cr-browser`'s first tasks.
