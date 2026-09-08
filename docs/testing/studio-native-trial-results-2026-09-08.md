# Native Studio trial implementation and laptop evidence

Issue: #744. PR: #745. This record distinguishes actual Mac/API behavior from synthetic fixtures and human learning validation.

Individual history is also scoped to the authenticated grant, not a shared cohort. Legacy cohort-wide chat is not automatically imported because it has no participant provenance.

The App records user requests, coach output, tool requests, actual approval decisions, tool completion and saved artifacts in existing workspaceState. Each event has an ID, sequence, task, session/program scope and assistance provenance. Automatic policy approvals are not human choices. Missing or truncated records cannot be assessed. Successful Write/Edit callbacks capture workspace-contained file snapshots and SHA-256 values.

Service authenticates through the existing token/profile/roster gates. `/v1/observations/context`, `/validate` and `/assess` are opt-in profile capabilities. The user reviews the exact event set before sending it. A changed event set requires renewed confirmation. The independent assessment has no tools and no automatic retries. Its versioned `observation-rubric` Module supplies interpretation policy and the next curriculum link. Structured output selects immutable source excerpts; Service and App reject fabricated citations, assistant-only human evidence, unsupported independence and numeric scores. VERIFY requires executed tool evidence; ITERATE requires distinct saved versions. These prerequisites establish evidence availability, not psychological validity.

The App displays seven provisional observations, unobserved assets, quoted evidence, saved artifact comparison, correction records and the event count used by the last assessment. A later correction does not silently rewrite the prior interpretation. The existing Lab `/training` curriculum remains reachable without completing an assessment. Older clients receive an update notice in their welcome text; a new App connected to an older Service explains that observation is unavailable.

Individual codes reuse `/admin/tokens/issue` with `native_trial: true`. Register a synthetic or consented participant with the existing scoped issuer flow first. The issuer needs the profile/cohort scope, session authority and sufficient credential lifetime. Code issuance does not start the trial. The first authorized profile/context/chat request starts a fixed one-hour window, capped by credential expiry. Reissue does not reset time, identity or usage, and invalidates the previous credential.

Limits are 40 attempted requests across coaching, token counting and assessment, one active request, 200,000 incoming request bytes, at most 8,192 output tokens per coaching request, and a 60-second provider deadline. Assessment output is capped at 4,096. This is an attempt allowance, not an unlimited key or a currency-denominated budget. Failed attempts remain consumed. Actual token usage uses the existing usage ledger. D1 reservation/settlement triggers prevent concurrent overspend and duplicate settlement. Orphaned reservations may recover after two provider deadlines; consumed allowance is not refunded.

The issuer can inspect or revoke its own grant at `GET`/`DELETE /admin/cohorts/:cohort/native-trials/:user`. These endpoints return lifetime/usage metadata, not credentials or transcripts. Existing administrator authentication can manage administrator-owned grants. No direct production DB edits are needed.

## Executed evidence

All paths below are relative to the worktree's gitignored `e2e/test-results/native-trial/` directory. Credentials are outside that directory, screenshots start after code entry, and traces/videos are disabled.

| Evidence | Result | Scope |
|---|---|---|
| `20260908T060536Z` | PASS | Actual Mac code entry, real provider, first document, intended revision, byte-preserved original |
| `20260908T061718Z` | FAIL | First observation attempt; HTTP 200 but invalid findings; no score/result synthesized |
| `20260908T062823Z` | FAIL | Managed grant/file flow passed; original quote validator rejected a fabricated quotation |
| `20260908T063814Z` | PASS | Managed grant, real coach, real independent assessment, seven App findings, reopen and correction |
| `20260908T064416Z` | PASS | Actual SDK Write denial, no file, host user-denial event, no artifact claim |
| `20260908T064753Z` | PASS / detector failure | 401/429/503/cancel App cases passed; old-Service assertion used a FrameLocator instead of a Locator, then corrected |
| `20260908T065043Z` | PASS | Preserved released App 0.1.51 with new Service; explicit unsupported-observation notice |
| `personas-20260908*` | Mixed, followed by fixes | Eight synthetic API personas; initial verbosity false VERIFY and unobserved-output shape failures were corrected and affected cases rerun |

Original installed `/Applications/HypeProof Studio.app` was not changed by these rehearsals. The primary dirty worktree and the user's normal app process were preserved. The rehearsal uses the released 0.1.51 shell with an injected branch extension, SDK 0.3.207, real Anthropic, local SQLite grants and synthetic cohort bindings. A separate test runs actual local workerd/D1; neither is production Cloudflare evidence.

## Acceptance mapping

These are bounded product checks, not a claim that a human learned the material.

| Tests | Evidence / scope | State |
|---|---|---|
| T01, T05, T06, T15 | Actual code entry, provider IDs, Write/Read callbacks, before/after files and preserved original | PASS |
| T02, T03, T20, T21 | Existing auth/issuer tests, native grant expiry/reissue/revoke, local SQLite + actual workerd/D1 concurrent reservations and settlement; App invalid-code and identity controls | PASS |
| T04 | P1/P2 actual API responses manually inspected: one next question and the user's non-website task | PASS |
| T07 | `20260908T064416Z`: actual denial modal, host denial event, no file | PASS |
| T08 | Actual App 401/429/503/cancel controls; real provider rejects deliberately invalid synthetic credential; no fabricated findings | PASS |
| T09, T10 | Exact App/Service contract lock, role separation, duplicate/reorder/gap/conflict controls and persisted incomplete flag | PASS |
| T11–14, T16–17 | `personas-final-20260908`: all eight actual API controls pass. P6 reuses real Mac tool/artifact evidence. Assistance remains unknown unless the fixture supplies known provenance; no independent human performance is claimed | PASS |
| T18, T23 | `20260908T065746Z`: actual process restart, code re-entry, files/observations/corrections restored. `20260908T070617Z` (rechecked after the late-profile-response guard): switching participants yields empty other-person history/observations and restores the original person's records | PASS |
| T19 | Versioned Module links existing Lab `/training`; HTTP verified and actual App button visible, available before assessment | PASS |
| T22 | Released App 0.1.51 with new Service plus actual new App with an older-profile response contract | PASS |
| T24 | Redaction controls, evidence/log scan and screenshot review; no new export/share endpoint, transcript server storage or automatic upload | PASS |
| T25 | No actual customer pilot or consented learning feedback | NOT_RUN |

The restart test passed, but its first shell wrapper exited 127 because the running script was edited while its child process was executing. The script was syntax-checked and then rerun unchanged through the old-Service case with exit 0. The execution rule is to leave active runner files unchanged. The earlier reload-only attempt did not retain the in-memory test credential; the corrected test re-enters the same code after a full process restart. This does not test macOS Keychain persistence.

All Worker, extension and Chalk suites/typechecks passed. Dental authoring demo and reference browser suites also passed; their L1–L5 results remain example/local simulation evidence. Registry validation and the new D1 migration's repeated application passed. The new D1 control is wired into PR CI.

## Release gates still to record

Final commit, PR review/CI, merge SHA, Worker deployment and App release/install smoke must be recorded here after execution. The trial remains `dashboard_hidden`. No human pilot has been conducted (T25 NOT_RUN), and no learning-effect or independent-ability claim is justified. The unrelated web trial prototype is not a substitute for this native path.
