# cr-skills evidence report

Status: evidence for the `cr-skills` completion record (CR-02, CR-43–CR-47). 2026-10-02. Owner: jayleekr.
Item: `cr-skills`, issue [#1396](https://github.com/jayleekr/hypeproof-studio/issues/1396), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Delivered by PR [#1454](https://github.com/jayleekr/hypeproof-studio/pull/1454), squash-merged as `c7d388fcc458319f6d74b5664dcaaef83377c27a`. The implementation's run record with all review rounds is [curriculum-runtime-2026-10-02-skills.md](../testing/curriculum-runtime-2026-10-02-skills.md); decisions and deviations are in the [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-skills). This report re-runs the review round 3 controls at the merge commit and plants 27 defects against them.

What the PR does not claim, and this report does not either (claim table in the run record): CR-02 is partial (skill surfaces only; the `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1). CR-43–CR-47 are claimed with the rule readings and residuals the plan records (an in-version `edit` citing a selected item for an unrelated change; a label-shaped present-tense assertion in `step` or `show`; a provider SDK file counts as handled when it has any `catch`; a call whose caller holds the `.catch` reads as unhandled). CR-T43's canonical row wording was not narrowed; that is left to Jay (open question in PR #1454). No real model answered a skill: the rows test the contract, the gate and the transport, not a model's judgement.

## Completion boundary

This report preserves the recorder's test evidence. Whether `align.py record cr-skills` wrote a completion is stated in the "Ledger record" section at the end; a refusal is reported there with its cause, never replaced by a hand-written completion.

## Verdict

PASS at `c7d388fc` for every round 3 control below: the worker suite on SQLite and on local workerd D1 and R2 (23 of 23 checks each), the extension smoke (8 of 8), the supporting suites, and 27 of 27 planted defects caught with the unmutated tree green. Evidence classes (MC-38): **synthetic** (the real Service router over SQLite, or local workerd D1 and R2 with `--d1`; planted model answers; extension smoke). No real model, no real phone, no production host. The in-app `skills-app.spec.ts` was not re-run by the recorder (see NOT RUN).

## Reviewers

| Label | Role |
|---|---|
| `cr-skills:review:acceptance:r3` | independent review, acceptance lens, round 3 (PR #1454) |
| `cr-skills:review:adversarial:r3` | independent review, adversarial lens, round 3 (PR #1454) |
| `cr-skills:review:regression-conventions:r3` | independent review, regression and conventions lens, round 3 (PR #1454); proposed as `reviewed_by` for the ledger completion |

The recorder is a record-only agent that did not write the implementation.

## Environment

2026-10-02, Apple M3 Pro, macOS 15.7.4 (Darwin 24.6.0), Node v24.4.1. Worktree `chore/record-cr-skills` cut from `origin/main` = `c7d388fcc458319f6d74b5664dcaaef83377c27a`; `npm ci` in `packages/measurement`, `worker`, `extensions/hypeproof-chat` and its `webview-ui` (all exit 0). No tracked file changed while the tests ran (`git status --short` empty after the mutation run and after the last test).

## Positive controls (unmutated tree)

| Command (from the worktree root) | Result |
|---|---|
| `cd worker && node --experimental-strip-types --experimental-sqlite --no-warnings test/cr-skills.test.mjs` | exit 0, 23 checks ✅, 0 ❌, `cr-skills (worker SQLite): OK` |
| `cd worker && npm run test:cr-skills:d1` (local workerd D1 and R2) | exit 0, 23 checks ✅, 0 ❌, `cr-skills (worker local workerd D1): OK` |
| `cd extensions/hypeproof-chat && node --experimental-strip-types --no-warnings test/cr-skills.smoke.mjs` | exit 0, `8 cr-skills checks passed` |

The round 3 controls this record names, each with its negative and positive case inside the same check (names as printed, green on SQLite and on D1):

| Round 3 control | Check | Negative / positive inside it |
|---|---|---|
| CR-T44 Demo Coach probes | "CR-T44 negative: planted leading questions, fabricated answers, weak claims, an unchecked claim, an unhandled AI failure and an unsupported demo or Q&A claim are each caught" | The review's four probes are caught as `claim_not_cited_statement` or `answer_not_claims`: the unrelated claim ("이 앱으로 학생들 성적이 올랐다" citing o1), the contradiction ("옵션에서 멈춘 사람은 없었다" citing o1), the overclaim reusing numbers ("3명 중 3명…", "세 명 중 세 명…" citing o1), and the answer that adds a result ("옵션 단계가 많았고, 바꾼 뒤로 매출이 크게 늘었어요" beside a claim on i1). Controls (positive check "CR-T44 positive: …"): the same statement with only its ending changed ("세 명 중 두 명이 옵션에서 멈췄어요" / "…멈췄습니다" for o1's "…멈췄다"; "옵션 단계가 많아요" for i1's "옵션 단계가 많다"), and the claims' statements as the whole answer |
| CR-T44 quantities | same check, plus the `quantitiesIn` unit cases in it | In `show`/`step`, caught as `unsupported_quantity`: `3/3` ("3명 중 3명이 멈추던 화면" beside o1), "수백", "수십", "백여", "열에 아홉", "많은", "Hundreds", "Dozens", "Thousands", "삼분의 이" (beside o2). `quantitiesIn` unit cases: "수십 명이 썼어요" → `수십`, "전원이 통과" → `전원`, "dozens of users" → `dozens`, "삼분의 이" → `2/3`, "많은 학생이" → `많`. Controls: "3명 중 2명" and "삼분의 이" beside o1 (whose statement is "세 명 중 두 명…") pass |
| CR-T44 Critic AI review | same check | A destructured AI product (`const { ai } = window.hypeproof; ai.chat(…).then(show)`) with no handler: the review is required (`case_missing:wrong`), "present" is caught, and a full review of it is not refused. An unrelated `try { JSON.parse(x) } catch {}` beside an unhandled `hypeproof.ai.chat(p).then(show)`: `unhandled` is `["app.js"]` and "present" is caught (`unhandled_failure_not_named:app.js`). A product with no detected call: the full review is accepted, a partial one is refused (`case_missing`). An unread source with no review: still refused (`sources_not_read:late.js`). The detector reads `hypeproof?.ai`, `hypeproof['ai']`, an `openai` SDK import and `api.cohere.ai`, and does not read "Powered by hypeproof.ai" in HTML text as a call. Controls: the call inside `try`; an inline `<script>` call with `.catch` |
| CR-T43 Product Builder adds | "CR-T43 negative: planted out-of-scope file changes and unaffected-slide edits are each caught, as are weak experiments and invalid evidence drafts" | `admin.js` added with no edit that uses it → `add_not_used:admin.js`; `../../worker/src/index.ts`, `/etc/hosts`, `js/../../x.js`, `https://evil.test/x.js` → `path_outside_version`. Control (positive check "CR-T43 positive: …"): `js/options.js` added and loaded by the in-version `index.html` edit passes |
| CR-T44 Interview | "CR-T44 negative: …" and "CR-T44 positive: …" | 18 more leading questions, each with a counterpart in the other language (presupposed benefits and comparisons: "기존 키오스크보다 나은가요", "더 편한가요", "덕분에", "절약해 주었나요", "추천하시겠어요", "what do you like", "so much better", "thanks to this app", "save you", "why would you recommend", …) → `leading_question`; nominal-style answers as note fields ("가격 비쌈", "다시 안 씀", "버튼 찾기 힘듦", "혼자 주문 불가") and a past-tense result ("결제 어려웠던 점") → `not_a_label`; the same in `questions[].purpose` → `purpose_not_a_label`. Controls: "어떤 점이 더 불편했나요?", "What do you do when you get stuck?", "What would you like to change?" stay open; "불편한 점", "첫 느낌", "이름", "실제 경험" stay labels |
| App smoke | `cr-skills.smoke.mjs`, "panel: the week's question is the served data, results and refusals are drawn as such, nothing is shown with the switch off" | Every new refusal code (`claim_not_cited_statement`, `answer_not_claims`, `show_asserts`, `add_not_used`, `path_outside_version`, `purpose_not_a_label`) has its own Korean line; the retired codes (`product_has_no_ai`, `claim_quantity_not_in_evidence`, `show_without_claim`) fall to the generic line; the demo flow shows each claim under its step ("주장: …") |

The other checks of the same run, also green on both backends: CR-T40 positive and both negatives, CR-T42 (positive, negative, request metadata, coach route), CR-T43 positive, CR-T44 positive, the schema validator, CR-T41 (positive, three negatives, prepare, guards), the skill-tag check, CR-45 run state, the AI failure review on the route, the CR-T41/CR-T42 end-to-end `SkillSession` run, CR-T02 inventory and CR-T02 switch OFF. Smoke, also green: the session checks, CR-T40 (App), the host's skill request, the helpers.

Supporting runs at the same tree (exit codes): `worker` `test/cr-switch.test.mjs` 0 (`cr-switch (CR-T02 Worker half): OK`) · `worker` `test/cr-memory.test.mjs` 0 (`cr-memory (worker SQLite): OK`) · `worker` `test/cr-evidence.test.mjs` 0 (`cr-evidence: all checks passed`) · `extensions/hypeproof-chat` `test/cr-switch.smoke.mjs` 0 (`12 cr-switch checks passed`) · `python3 scripts/next-work.py --check` 0 · `python3 scripts/check-registry.py` 0 (`check-registry: OK`) · `node --experimental-strip-types worker/test/cr-traceability.test.mjs` 0 (`84 requirements · 80 tests · 52 reuse IDs resolved · both directions agree`). Full `npm test` of `worker` and `extensions/hypeproof-chat` was not re-run by the recorder.

## Negative controls: 27 planted defects

Scratch runner `mut-skills.py` (in the session scratch directory, not committed): each defect planted alone by exact-anchor replacement (anchor count checked to be 1), the owning suite run (`worker/test/cr-skills.test.mjs` on SQLite, or `extensions/hypeproof-chat/test/cr-skills.smoke.mjs`), the file restored before the next plant. The baseline before the plants and the run after them were green for both suites. D1–D25 are in `worker/src/skills/curriculum/rules.ts`; D26–D27 in `extensions/hypeproof-chat/src/skillView.ts`. The round 3 plant they correspond to in the run record is given in brackets where there is one.

| | Planted defect | Result (failing check, assertion) |
|---|---|---|
| — | none (positive control) | GREEN (rc 0), both suites |
| D1 | a claim's text is not compared with the cited statement (the first cited statement is taken) [P1] | RED: CR-T44 negative, expected `claim_not_cited_statement`, got only quantity problems |
| D2 | Q&A answer sentences not checked against the claims [P2] | RED: CR-T44 negative, expected `qa[0].answer: answer_not_claims` |
| D3 | the "N 중 M" / "M of N" ratio pairing dropped [P6] | RED: CR-T44 negative, expected `flow[0].show: unsupported_quantity:3/3` |
| D4 | "분의" fractions dropped [P6] | RED: CR-T44 negative, expected `unsupported_quantity:2/3` ("삼분의 이") |
| D5 | "열에 아홉" native ratios dropped [P6] | RED: CR-T44 negative, expected `unsupported_quantity:9/10` |
| D6 | Korean magnitudes and approximate amounts dropped [P7] | RED: CR-T44 negative, expected `unsupported_quantity:수백` |
| D7 | English magnitudes dropped | RED: CR-T44 negative, expected `unsupported_quantity:hundreds` |
| D8 | "전원" dropped from the share words | RED: CR-T44 negative, `quantitiesIn` unit case "전원이 통과 -> 전원" |
| D9 | destructured `{ ai } = window.hypeproof` not detected [P4] | RED: CR-T44 negative, the destructured product |
| D10 | optional chaining `hypeproof?.ai` not detected | RED: CR-T44 negative, `await window.hypeproof?.ai.chat(p)` |
| D11 | bracket access `hypeproof['ai']` not detected | RED: CR-T44 negative, `window.hypeproof['ai'].chat(p)` |
| D12 | provider SDK imports not detected | RED: CR-T44 negative, `import OpenAI from 'openai'; …` |
| D13 | Cohere hosts dropped from the provider list | RED: CR-T44 negative, `fetch('https://api.cohere.ai/v1/chat', {})` |
| D14 | HTML prose scanned as script [P14] | RED: CR-T44 negative, "page prose is not a call" |
| D15 | any `catch` in the file counts as handling [P5] | RED: CR-T44 negative, the unrelated `try { JSON.parse }` case (`unhandled` deep-equal) |
| D16 | the `product_has_no_ai` refusal restored [P3] | RED: CR-T44 negative, "a review of a product with no detected call is not refused" |
| D17 | a partial review of a no-call product accepted | RED: CR-T44 negative, expected `case_missing:wrong` |
| D18 | an unread source with no review accepted | RED: CR-T44 negative, expected `sources_not_read:late.js` |
| D19 | an added file need not be used by an edit [P11/P12] | RED: CR-T43 negative, expected `add_not_used:admin.js` |
| D20 | added paths not confined to the version folder [P11/P12] | RED: CR-T43 negative, expected `path_outside_version` for `../../worker/src/index.ts`, got only `add_not_used` |
| D21 | presupposed Korean comparisons ("…보다 나은가요") not leading [P8] | RED: CR-T44 negative, expected `leading_question` |
| D22 | English "thanks to … / save you" not leading [P8] | RED: CR-T44 negative, expected `leading_question` |
| D23 | nominal-style answers read as labels [P9] | RED: CR-T44 negative, expected `note_fields[1]: not_a_label` |
| D24 | a past-tense result in a note field read as a label [P10] | RED: CR-T44 negative, expected `note_fields[1]: not_a_label` |
| D25 | `questions[].purpose` not checked [P15] | RED: CR-T44 negative, expected `questions[0].purpose: purpose_not_a_label` |
| D26 | App: the demo flow drops its claim lines [A1] | RED: smoke, panel/result lines deep-equal |
| D27 | App: a new refusal code without its Korean line [A2] | RED: smoke, `claim_not_cited_statement` |

All 27 RED, the unmutated control GREEN, `git status --short` empty afterwards. The pre-implementation red (on `origin/main` `8d2138e4` both suites stop with `ERR_MODULE_NOT_FOUND`) and the K1–K19, R1–R12, P1–P15 and A1–A3 plants are the implementer's, recorded in the run record; this report does not re-run them beyond the 27 above.

## Test IDs named in the record

CR-T02 (PARTIAL: Worker and extension halves re-run; in-app half and the `09-preview.spec.ts` baseline not), CR-T40, CR-T41, CR-T42 (Worker and extension re-run; in-app half not re-run), CR-T43, CR-T44.

## NOT RUN

- The in-app `e2e/curriculum-runtime/skills-app.spec.ts` (CR-T02 off; CR-T02 on and CR-T42 in the app) at `c7d388fc`: not re-run by the recorder (app-layer runs go through the idle gate). It last passed at the round 1 head `6b2aa616`; for the App changes of review rounds 2 and 3 the run record has it NOT RUN (waiting for idle window), and those changes rest on `cr-skills.smoke.mjs`, re-run here.
- `09-preview.spec.ts` switch-off baseline for CR-T02 (BLOCKED by pre-existing F1).
- A real model answering any skill; a real phone or classroom; the dev host by hand.
- Any production D1, R2, Worker route or host.
- GitHub was not read by the recorder (the API budget belongs to the shipping agent); main CI at `c7d388fc` is not re-read here.

## Follow-ups carried from the run record (not changed here)

- The residual readings in the plan's `cr-skills` deviations (listed at the top of this report).
- CR-T43's canonical row wording ("files tied to the fixture evidence") versus the rule's narrower reading: Jay's decision.
- The extension's `npm test` fails at `test:instructor-render` inside a worktree under `$HOME` (`react` 19 resolved from `~/node_modules`; environmental, pre-existing).

## Ledger record

`align.py record cr-skills --commit c7d388fcc458319f6d74b5664dcaaef83377c27a --pr 1454 --tests CR-T02,CR-T40,CR-T41,CR-T42,CR-T43,CR-T44 --evidence docs/evidence/cr-skills.md --reviewed-by cr-skills:review:regression-conventions:r3` (Harness `align-main` at `44e6bbba`, this report staged) exited 1 with `refused: cr-skills depends on work that is not complete: cr-memory; record or re-record it first`. No completion was written and the ledger is unchanged.

The cause is upstream of this item and was not changed here: `align.py next --doc curriculum-runtime` at `c7d388fc` names `cr-recon` as REOPENED (`completion no longer holds (changed since recorded: docs/requirements/curriculum-runtime.md)`), and the chain `cr-browser` → `cr-verify` → `cr-publish` → `cr-evidence` → `cr-memory` waits on it, each without a completion (see [cr-memory.md](cr-memory.md), "Ledger record", and the earlier reports it names). `cr-browser` has open claims of its own (app-layer CR-T runs NOT RUN, CR-59/60 to move to `cr-e2e` per decision 9), so re-recording `cr-recon` alone would not unblock this record, and recording those items is their own record work, not this one's. `align.py check --doc curriculum-runtime` at the same tree exited 1 with `BROKEN cr-recon` only; no link of `cr-skills` is broken. Once the chain is recorded, this report is the evidence to cite for this item's record, with the command above; CR-T02 carries a PARTIAL result and CR-02 is partial, as the claim table says.
