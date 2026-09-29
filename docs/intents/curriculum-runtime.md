# Curriculum Runtime — Product Intent

Status: proposed contract, not implemented and not used in a class. 2026-09-29.
Owner: jayleekr. Source: *HypeProof Studio Curriculum Runtime — Product & Engineering Requirements, AI for Good v5*, v1.0, 2026-09-28 (the PRD; §-numbers below refer to it), preserved verbatim at [docs/design/curriculum-runtime-prd-v1.0-2026-09-28.md](../design/curriculum-runtime-prd-v1.0-2026-09-28.md) and not edited by the documents derived from it.
Epic: [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388).
Parent: [Product Intent](../PRODUCT-INTENT.md) (Useful work first, Human judgment stays visible, Evidence over claims, Capability models are hypotheses). Sibling intents are referenced, not copied: [INT-SX-00–10](studio-learning-experience.md) owns what the student screen shows during work; [INT-MC-01–03](measurement-core.md) owns observation, evidence and interpretation. Lab [PHILOSOPHY.md](https://github.com/jayleekr/hypeprooflab/blob/main/PHILOSOPHY.md) and [MISSION.md](https://github.com/jayleekr/hypeprooflab/blob/main/MISSION.md) keep ownership of the learning philosophy and child-safety decisions.

## Product Intent

**HypeProof Studio becomes the runtime that executes the AI for Good v5 six-week curriculum loop — Problem → Hypothesis → Build → Test → Evidence → Decision → Product Change → Deck Change — with one HypeProof account, so that class time is spent on judgment instead of setup.**

It is not a generic coding IDE and not a general-purpose AI browser (PRD §1). The missing layer is experiment execution and learning-state management around the existing AI builder, not another editor (PRD §2.1).

## Problem this intent answers

Studio already has a VS Code workspace, AI-assisted editing and HTML artifacts that render immediately in an embedded browser. Curriculum v5 asks students to build fast, put the product in front of real people, observe usage, compare alternatives, collect evidence, update a deck and explain what changed across six weeks. Earlier Studio trials exposed the gaps (PRD §2.2): student-built apps cannot call frontier AI without exposing keys; students cannot publish an external test link natively; product usage is not captured as curriculum evidence; the coach does not reliably use HypeProof-native infrastructure.

## Intents

| ID | Intent | How success is observed | PRD source |
|---|---|---|---|
| INT-CR-00 | Studio executes the curriculum loop end to end instead of leaving students to assemble it from external services. | One kiosk-practice team completes the Week 1 → Week 2 loop of CR-71 inside Studio, with every step leaving a record that the next step reads. | §1, §4, §14 |
| INT-CR-01 | The 20-minute directing session is a decision session, not a generation session. A Weekly Review Pack (hypothesis, what was tested, raw evidence, interpretation kept apart from facts, product change, metrics and test results, draft deck changes, the one or two decisions needed, a proposed next experiment) is ready before the director opens it. | The director opens the latest valid pack without waiting for a model call and records a decision and next experiment from it. | §1.1 |
| INT-CR-02 | HTML-first stays. Product prototypes, test pages, review packs, evidence dashboards, deck slides and demo pages share one HTML runtime and one embedded browser. Existing HTML creation and preview flows keep working. | New behaviour ships behind a switch; the existing preview and HTML generation regressions stay green with the switch off. | §1.2, §5.1, §15 Rule 5 |
| INT-CR-03 | Build is not Done. Every meaningful iteration can go Build → Verify → Human Test → Evidence → Decision → Next Version; AI does not mark a change complete because the source looks valid. | A change reaches "verified" only through a verification report bound to that artifact version, and reaches "tested with people" only through a published immutable version. | §5.2, §6 P0-2, P0-3 |
| INT-CR-04 | Evidence and interpretation are separate data types. Observed, Interpreted and Assumed are stored and shown apart. AI-generated content is never evidence by default; evidence points to a real source. | Every observed statement opens its source sessions or notes; a claim with no resolvable source is refused, not softened. | §1.2, §5.3, §6 P0-4 |
| INT-CR-05 | Model choice is a platform responsibility. Curriculum features ask for capabilities (`text.fast`, `reasoning.high`, `coding`, `vision`, `research.grounded`, `browser.agent`, `image.generate`, `speech.transcribe`); a policy maps them to models. Students need no provider account or key. | No provider key appears in student code; curriculum code names capabilities, never model IDs; a failed mapped model surfaces as an explicit error (see decision D2). | §1.2, §5.4, §6 P0-5 |
| INT-CR-06 | Skills, not giant prompts. Curriculum behaviour is packaged as versioned skills with declared inputs, outputs, validation and write-back targets, so students do not have to become prompt engineers. | A skill whose output fails its schema writes nothing; skill outputs carry skill id and version. | §1.2, §5.5, §6 P0-7 |
| INT-CR-07 | Director latency is a product constraint. Review artifacts are prepared or cached before the session; latency targets are curriculum requirements. | The §11 targets are measured on a recorded reference machine and reported with their misses. | §5.6, §11 |
| INT-CR-08 | Venture Memory is the durable asset. HypeProof remembers what a team believed, tested, observed, changed and learned, as structured state rather than a pile of chats and files. | Reopening a project reconstructs the learning state without reading chat history; a director can walk hypothesis → evidence → decision → version. | §1.2, §6 P0-6, §16 |
| INT-CR-09 | Minimal collection by default, because the curriculum involves minors and real external participants: anonymous participant IDs, no provider keys in student code, no microphone or camera without explicit permission, no raw participant input retained unless the experiment needs it, a visible indicator while AI or browser automation runs, expiring and revocable test links, a delete path for test data, and admin-level budget and data controls. Interfaces must not make later policy controls impossible. | Each item has a requirement row with a negative control (CR-65–70, CR-19, CR-29, CR-25). | §12 |

## Decisions carried into this intent

### D1. "Experiment Browser", not "AI Browser" (PRD §3.1)

The embedded browser is positioned as the **Experiment Browser**: the place where the student's product is rendered, operated by AI, tested by humans, observed, and converted into evidence. It is not a generic AI browser and does not compete with general browser agents. Consequences carried into the requirements:

- Automation acts on the student's own artifact origins (local preview and published test versions), not on arbitrary external sites (CR-11). General web browsing, general external-site computer use and an unrestricted autonomous agent are PRD non-goals (§8, §9, §15 "DO NOT IMPLEMENT YET"). Isolated Computer Use stays governed by AE-23.
- Student-facing copy does not call the feature "AI 브라우저". The Korean label is owned by the learning-experience copy rules and is not fixed here.

### D2. MU-02 stays; the PRD P0-5 "retry/fallback policy" is rewritten (Jay, 2026-09-29)

[MU-02](../requirements/model-access-usage.md) sends only permitted models and never substitutes another provider automatically. The PRD's "retry/fallback policy" must-have is replaced by:

- The capability → model mapping is fixed by policy. Changing it is a policy revision, not a runtime decision.
- A same-provider retry of the mapped model is allowed for transient upstream failure before any output reached the caller. Every attempt is admitted and metered (AB-06, AB-07); after partial output or an external effect there is no silent retry (AE-30).
- Substitution to another provider — or to any model the policy did not map — never happens automatically (MU-02, AB-05, AE-33).
- Failure surfaces as an explicit, typed error to the skill or student app.

MU-02 also says "one upstream call per user request" on the model-practice route it governs. That route keeps its single-call rule; the same-provider retry above applies to the Curriculum Runtime gateway only. See CR-32.

### D3. Registry placement (Jay, 2026-09-29)

The PRD enters the Studio ledger as a new requirement document with prefix `CR-` and intents `INT-CR-*`. Where an existing ID already governs a behaviour — review validity (AE-05/18/37), publish (WEB-07/08) and error inspection (WEB-06), evidence and the single store (SX-17–24, SX-44–48, MC-*), model use and budgets (MU-*, AB-*, HC-*, AE-25–33) — the CR row references it and states only the curriculum-specific delta. In particular **SX-48 binds every CR evidence and memory row: no second store, no second scorer.**

## First user and first scene

The first scene is the PRD §14 loop on a simple kiosk-practice app, run by Jay and staff before any student pilot. A student pilot with minors waits for the Lab child-safety decisions (guardian consent, instructor-mediated path) and for the defaults that CR-19 (link expiry), CR-67 (raw-input retention) and CR-65 (returning-session linkage) leave open.

1. The student builds v0 HTML and sees it in the Experiment Browser.
2. The student selects a rendered element and asks for an edit ("이 버튼이 왜 안 돼?").
3. The student writes three observable acceptance criteria and presses "Test my product"; AI Verify exercises the app and records a report bound to that version.
4. The student publishes the verified version; a participant opens the link on a phone; Studio records an anonymous session and events.
5. The student adds an observation note; the Evidence skill drafts Observation / Interpretation / Assumption separately; the student edits the interpretation.
6. Venture Memory holds the hypothesis, experiment, evidence and decision; the student produces v1.
7. The Weekly Review shows v0 → test → evidence → decision → v1, and the Deck Builder proposes changes to the affected slides only.

## Success and failure of the first version

Success: CR-71 passes as a script and once on a real Mac with a real phone, every CR-T row it relies on has run, and the director's decision in step 7 was written from the review screen without a model wait.

Revisit the design if: students still assemble evidence by hand outside Studio; AI verdicts or AI summaries show up as evidence; the director waits for generation in class; a new store or scorer appears beside the measurement core; a model or provider changes without a policy revision; published test links cannot be revoked; participant data is kept that the experiment did not need.

## Scope

P0 = PRD P0-1..P0-9 plus the §14 end-to-end loop. P1 items in PRD §8 (model comparison lab, routing optimisation, rich shared backend, recording, cohort analytics, PPT export, visual regression, live collaboration, external-site computer use, A/B templates) are not in scope unless existing code makes them nearly free. PRD §9 non-goals hold.

## Derived contracts

[Requirements CR-01–81](../requirements/curriculum-runtime.md) → [plan, DAG and gap matrix](../plan/curriculum-runtime.md) → [verification CR-T01–T76](../testing/curriculum-runtime.md). Registry entries: `config/requirement-work.json` (work items `cr-*`), `config/traceability.json` (`ST-INT-CR`, `ST-REQ-CR`, `ST-DES-CR`, `ST-TEST-CR`; the preserved PRD is a source of `ST-INT-CR`).
