# Curriculum Runtime run record — `cr-skills` (#1396)

Status: run record, 2026-10-02. Item `cr-skills`, epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388). Row definitions: [curriculum-runtime.md](curriculum-runtime.md). Decisions and deviations: [plan](../plan/curriculum-runtime.md#deviations-and-decisions-recorded-by-cr-skills). No row here is a completion; completion needs the ledger record and a reviewer other than the implementer.

## Claims

| | Rows | Why |
|---|---|---|
| Claimed | CR-43, CR-44, CR-45, CR-46, CR-47 | Every positive and negative control of CR-T40–T44 ran (below), on SQLite and on local workerd D1 and R2; CR-45's request metadata also in the app. The rule readings each row leaves open (riskiest assumption, files tied to evidence, leading questions, unchecked claims, AI failure handling) are stated in the plan's deviations |
| Partial, remainder named | CR-02 | Skill surfaces only: the three routes, the command and the two webview messages are off with the switch off and reachable with it on, in the Worker and in the app. CR-T02's `09-preview.spec.ts` switch-off baseline stays BLOCKED by pre-existing F1, as for the earlier items; it was not re-run here |

So the PR says `Refs #1396`. The set the completion record names is exactly this table: claimed CR-43, CR-44, CR-45, CR-46, CR-47; CR-02 partial.

## What was run

- Code: branch `feat/cr-skills` off `origin/main` `8d2138e4`; Service commit `a485e15a`, App commit `10573b50`. The submitted SHA is the branch head that carries this file.
- Machine: Apple M3 Pro, macOS 15.7.4. Node 24.4.1 for the development runs, Node 22 (as `pr-ci.yml`) for the gates. HypeProof Studio 0.1.51 copy (from `/Applications`) with this branch's extension and webview injected, prepared with `scripts/prep-test-app.sh` (LSUIElement=1), run through `GATE=idle scripts/e2e-quiet.sh` with the screen unlocked (gate passed on the first attempt both times; 2 passed in 15.7 s at 07:55 KST and, re-built and re-injected after the planted-defect runs, 2 passed in 13.0 s at 07:57 KST).
- Evidence classes (MC-38): **synthetic** = unit, smoke and worker layers (the real Service router over SQLite, or local workerd D1 and R2 with `--d1`; the model is a planted answer); **live-host (app) / synthetic (Service and model)** = `e2e/curriculum-runtime/skills-app.spec.ts` in the Studio app with `app-service.mjs publish`, whose scripted model answers a skill prompt from the prompt alone.
- No real model answered a skill. The rows test the contract, the gate and the transport, not a model's judgement. No real phone or classroom run; none is named by these rows.

## Results

| Row | Layer and file | Result | Controls |
|---|---|---|---|
| CR-T02 (skill surfaces) | worker `cr-skills.test.mjs`, `cr-switch.test.mjs`; extension `cr-switch.smoke.mjs`, `cr-skills.smoke.mjs`; in-app `skills-app.spec.ts` | PARTIAL (CR-02 partial) | Off: each of the three routes, with real ids, with a student, a director and no token, answers exactly as an unknown route (status, body, headers), and a complete valid run writes nothing; the command is absent from the palette in the app (control: an existing command is found) and no panel appears; the session makes no Service or model call. On: the registry and a prepare answer a member; a director gets the unknown route (members only). A planted route that ignores the switch is caught; K13, K18, K19 caught |
| CR-T40 | worker `cr-skills.test.mjs`; extension `cr-skills.smoke.mjs` | PASS | The seven bundled skills load, each with the eight fields; none refused. Negative: the Experiment contract with any one of the eight fields removed (`output_schema` first) is not loaded and is refused by name; `allowed_tools` naming `Bash` or `Write`, a model id as the capability, an unknown rule or target, empty instructions are refused. A workspace holding `.hypeproof/skills/evil/` and `.claude/settings.json` / `settings.local.json` allow-rules: the registry is the bundle, the registry module reads no file, the forced workspace contract is refused for its tool, and the SDK coach built for a switch-on cohort with that workspace as `cwd` has `settingSources: []` and no effective allow-rule; the same check over planted options that read project settings (or omit the field) finds the three planted rules. A planted warning loader loads the incomplete skill the check refuses. K1, K2, K16 caught |
| CR-T41 | worker `cr-skills.test.mjs` (SQLite and local workerd D1/R2; App session against the real router) | PASS | Valid Evidence output → 201, exactly one new R2 key (the draft revision), no Venture Memory row changed; the stored draft is `author: ai`, every item `draft`, `skill: "evidence@1.0.0"`; the student's review revision drops the tag. Experiment and Deck Builder outputs → 200, `written: []`, nothing changed. Negative: an observation without references, an extra key, no items → 422 `invalid_output` naming the problem; a reference to a record that does not exist → 422 `unresolved_source_refs`; a missing experiment id → 422 `invalid_input`; another Project's experiment → 409; the store is unchanged after every refusal; a planted extra write shows in the same diff. End to end, the App's `SkillSession` with a planted model stores the draft, then a planted bad answer is refused with its problem and stores nothing, and a non-JSON answer is never posted. K3, K4, K15 caught |
| CR-T42 | worker `cr-skills.test.mjs`; extension `cr-skills.smoke.mjs`; in-app `skills-app.spec.ts` | PASS | The v5 file validates and each week is the PRD §4 row word for word; no week question in `worker/src`, `extensions/hypeproof-chat/src` or `webview-ui/src`. Outputs carry `skill@version` (the answer and the stored draft). The coach route answers a skill request with `x-hps-skill` and `x-hps-capability` and the lesson policy's model, and logs one `skill_request` line; in the app the Experiment run sent `experiment@1.0.0` / `reasoning.high` and no model, and was answered with the same two and `claude-sonnet-4-6` (`skills-result.json`). Negative: a week question planted in extension source is caught by the scan, and so is the heading on the pre-change tree (`MemoryPanel.tsx` "어디까지 확인했나?"); invalid curriculum data (unknown skill, missing question, out of order) is refused; a body naming a model, a model id as the capability (`claude-…`, `gpt-…`), an undeclared capability and an unknown skill or version are refused before any upstream call; with the switch off the headers record nothing. In the app a planted answer with an uncountable criterion is refused ("아무것도 저장하지 않았어요", `not_countable`). K11, K12, K17 caught |
| CR-T43 | worker `cr-skills.test.mjs` | PASS | Planted-answer fixture (a v1 whose `app.js` calls `hypeproof.ai` without failure handling; observed, interpreted, open and confirmed assumptions, an unreviewed AI item; a team decision on slides 2–3 and an AI suggestion on 5). Experiment picks the open assumption with countable criteria (and states a new one when none is open); Evidence is a valid AI draft; Product Builder's plan touches `index.html` and `style.css` citing selected evidence; Deck Builder patches slides 2 and 3 only. Negative: a change to `admin.js` (not in the version), one citing unselected evidence, one with no evidence, one resting on an assumption or an unreviewed AI item, an "add" of an existing file; a patch to slide 5, a duplicate slide, a patch without evidence, a patch driven by an AI suggestion; an observed or confirmed assumption, a skipped open one, an uncountable criterion; an observation without references and an item carrying a review state: each caught by name. K7, K8 caught |
| CR-T44 | worker `cr-skills.test.mjs` | PASS | Interview output with four open questions (Korean and English) and a verbatim note quote passes; five more ordinary open questions pass the detector. The Critic output listing slide 3 and 4 and the student's claim c1 as weak, slide 4 and c1 as missing tests, and the three AI failure cases with "missing" passes; with a criterion naming c1 it need not list c1 as a missing test; a product with no AI needs no AI review. Demo Coach with a flow and Q&A whose claims cite reviewed evidence (and an answer "아직 확인하지 못했어요" with no claim) passes. Negative: six planted leading questions (`않나요`, `죠`, `좋지 않아요`, `얼마나 만족`, English, `동의하시나요`) each caught; a closed statement caught; a quote not in the notes and a quote with no notes caught; a Critic output that does not list c1 or slide 4 as a missing test fails; one not listing slide 3 as weak fails; an unknown claim id fails; the unavailable case marked "present" for the unhandled `app.js` fails, as do a missing case and no review; the detector reads a `.catch` as handled; a Q&A claim on an assumption, with no evidence, on an unreviewed AI item, and a flow claim on a missing item are each caught. K5, K6, K9, K10, K14 caught |

## Controls red on the pre-implementation tree

- On `origin/main` `8d2138e4` with this branch's two test files copied in, `worker/test/cr-skills.test.mjs` exits 1 before any case (`ERR_MODULE_NOT_FOUND` for `worker/src/skills/curriculum/contract.ts`) and `extensions/hypeproof-chat/test/cr-skills.smoke.mjs` exits 1 (`ERR_MODULE_NOT_FOUND` for `src/skillSession.ts`). The CR-T42 scan finds one hard-coded week question there: `webview-ui/src/MemoryPanel.tsx:102`.
- Planted defects, each applied to this branch's working tree, the relevant suite run, then restored; the baseline with nothing planted is all green. Every one turned the suite red:

| | Defect planted | Turned red |
|---|---|---|
| K1 | the loader warns and loads a skill with a missing field | CR-T40 |
| K2 | a contract may name `Bash` or `Write` | CR-T40 |
| K3 | the output gate is skipped before write-back | CR-T41 |
| K4 | an undeclared target is written (Deck Builder patches stored as slide revisions) | CR-T41 |
| K5 | the Critic contract drops `critic_lists_missing_tests` | CR-T44 |
| K6 | the leading-question detector accepts everything | CR-T44 |
| K7 | Deck Builder may patch any slide | CR-T43 |
| K8 | Product Builder paths are not checked against the version | CR-T43 |
| K9 | Demo Coach claims are not checked | CR-T44 |
| K10 | an unhandled AI failure need not be named | CR-T44 |
| K11 | the Week 5 question hard-coded again in the memory panel | CR-T42 |
| K12 | the coach route accepts a model id as the capability | CR-T42 |
| K13 | the registry route skips the switch | CR-T02 |
| K14 | an Interview quote not in the notes is accepted | CR-T44 |
| K15 | the Evidence draft is stored without its skill tag | CR-T41 |
| K16 | the SDK coach reads project settings | CR-T40 (App) |
| K17 | the App names a model on the skill request | CR-T42 (App) |
| K18 | the skills command handler skips the switch | CR-T02 (App) |
| K19 | the App lists skills with the switch off | CR-T02 (App) |

## NOT RUN

- A real model answering any skill (every answer here is planted or scripted).
- `09-preview.spec.ts` as CR-T02's switch-off baseline (BLOCKED by F1, pre-existing; not re-run).
- Real Mac with the dev host (`studio-dev.py`) by hand; the dev-host rows in [curriculum-runtime-dev.md](curriculum-runtime-dev.md#cr-skills--curriculum-skills-1396) were written from the code and these runs.
