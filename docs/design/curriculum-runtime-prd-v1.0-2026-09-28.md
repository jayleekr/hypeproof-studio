> Preserved source · received 2026-09-29 as `HypeProof_Studio_Curriculum_Runtime_PRD_v1.0.md` (sha256 203edac0074c766b006f4e8f543152a6499f230f351bf101dffcf6f5b33ff6bf) · owner: jayleekr.
> Everything below this quote block is the PRD verbatim. Do not edit it; fix the derived documents instead: [intent INT-CR](../intents/curriculum-runtime.md), [requirements CR](../requirements/curriculum-runtime.md), [verification CR-T](../testing/curriculum-runtime.md), [plan](../plan/curriculum-runtime.md). Where a derived document departs from this text (for example the P0-5 retry/fallback rewrite, intent decision D2), the derived document says so.

# HypeProof Studio Curriculum Runtime
## Product & Engineering Requirements — AI for Good v5

**Version:** 1.0  
**Date:** 2026-09-28  
**Audience:** HypeProof Studio engineering / product / curriculum team  
**Primary execution target:** Opus 5.5 coding session against the Studio repository  
**Current product premise:** Studio is a VS Code fork. Most generated artifacts are HTML and render immediately in the embedded browser.

---

# 1. Intent

HypeProof Studio should become the **runtime that executes the AI for Good curriculum**, not another generic coding IDE and not another general-purpose AI browser.

The six-week learning loop is:

> **Problem → Hypothesis → Build → Test → Evidence → Decision → Product Change → Deck Change**

The product must make this loop cheap, fast, repeatable, and visible.

A student should be able to complete the course with **one HypeProof account**. HypeProof should absorb model/API complexity, product preview, user testing, evidence capture, and weekly artifact preparation so that class time is used for judgment rather than setup.

## 1.1 Product outcome

By the beginning of each team's 20-minute directing session, Studio should already have prepared a **Weekly Review Pack** containing:

1. Last week's hypothesis.
2. What was actually tested.
3. Raw evidence collected.
4. AI-generated interpretation clearly separated from facts.
5. What changed in the product.
6. Metrics and user-test results.
7. Draft changes to the relevant IR deck slides.
8. The one or two decisions the director and team need to make now.
9. A proposed next experiment.

The 20-minute session is therefore a **decision session**, not a generation session.

## 1.2 Product thesis

- **HTML-first stays.** Products, review packs, dashboards, and deck slides can share one runtime.
- **The embedded browser becomes an Experiment Browser.** It previews, verifies, tests, captures, and produces evidence.
- **HypeProof owns the learning loop, not the model.** Models are swappable capability providers.
- **Skills encode curriculum quality.** Students should not need to become prompt engineers to execute the course correctly.
- **Venture Memory is the durable asset.** HypeProof remembers what a team believed, tested, observed, changed, and learned.
- **AI-generated content is never treated as evidence by default.** Evidence must point to a real source.

---

# 2. Current State and Core Problem

## 2.1 Current Studio strengths

Studio already has three properties that should be preserved:

1. VS Code-based workspace and file system.
2. AI-assisted creation/editing.
3. HTML artifacts rendered immediately in an embedded browser.

This is already a strong base for a curriculum runtime. The missing layer is not another editor. The missing layer is **experiment execution and learning-state management**.

## 2.2 Current gaps exposed by curriculum v5

The current curriculum requires students to build quickly, show products to real people, observe usage, compare alternatives, collect evidence, update a deck, and explain what changed over six weeks.

Current Studio testing already exposed the critical gaps:

- Student-built apps cannot safely call frontier AI without exposing keys.
- Shared data across devices is limited.
- Students cannot publish a simple external test link as a native Studio flow.
- Product usage is not captured as curriculum evidence.
- Camera/microphone availability is limited in preview.
- The coach/model does not reliably know how to use HypeProof-native infrastructure.

The implementation goal is therefore not “add more AI.” It is to create the missing **Curriculum Runtime** around the existing AI builder.

---

# 3. What We Are Building

Studio should be organized around six student-visible stages:

```text
Research → Think → Build → Test → Evidence → Deck
```

Underneath, five platform capabilities execute those stages:

```text
                          HYPEPROOF STUDIO

        Student Workspace / Curriculum UI / Director Review
                              │
                              ▼
                    ┌────────────────────┐
                    │ Experiment Browser │
                    │ Preview            │
                    │ Element → AI       │
                    │ AI Verify          │
                    │ User Test          │
                    │ Evidence Capture   │
                    └──────────┬─────────┘
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
  AI Gateway              Publish Runtime        Evidence Engine
  model routing           test links / QR        events / notes
  student-app AI          immutable versions     traceable facts
       └───────────────────────┼───────────────────────┘
                               ▼
                         Venture Memory
  problem → hypothesis → experiment → evidence → decision → version → deck
                               │
                               ▼
                      Curriculum Skill Runtime
                               │
                               ▼
                   Weekly Review / IR Deck / Demo
```

## 3.1 Important naming decision

Do **not** position the embedded browser as a generic “AI Browser.”

Use the product concept **Experiment Browser**:

> The place where the student's product is rendered, operated by AI, tested by humans, observed, and converted into evidence.

This keeps the feature tied to the curriculum instead of competing with general browser agents.

---

# 4. Curriculum-to-Product Traceability

| Week | Curriculum question | Required product behavior |
|---|---|---|
| Week 1 | 누구의 어떤 어려움인가? | Build v0 quickly, preview, publish, observe 3 real users, store first hypothesis |
| Week 2 | 무엇이 나아지나? AI가 틀리면? | AI Verify, repeated testing, failure/safety review, reuse/session evidence |
| Week 3 | 누가 돈을 내고 무엇이 바뀌나? | Stakeholder model, payer/user distinction, impact metric, interview/channel experiments |
| Week 4 | 이미 있는 도움과 무엇이 다른가? | Alternative-comparison experiment, version diff, user comparison testing |
| Week 5 | 어디까지 확인했나? | Fact/assumption register, metrics, deck updates, weekly synthesis |
| Week 6 | 무엇을 만들고 무엇을 배웠나? | Stable demo, version/evidence timeline, final deck, “belief changed because…” story |

The runtime must support this sequence without requiring students to manually assemble data from multiple external services.

---

# 5. Design Principles

## 5.1 Preserve HTML-first

Do not rebuild Studio around a proprietary visual format.

HTML should remain the common execution format for:

- product prototypes,
- test pages,
- weekly review packs,
- evidence dashboards,
- IR deck slides,
- demo pages.

This lets one embedded browser support all artifacts.

## 5.2 Build is not Done

Every meaningful product iteration should be able to follow:

```text
Build → Verify → Human Test → Evidence → Decision → Next Version
```

AI should not mark a change complete because the source code looks valid.

## 5.3 Evidence and interpretation are separate data types

The system must distinguish:

- **Observed** — directly measured, recorded, or sourced.
- **Interpreted** — an explanation derived from evidence.
- **Assumed** — not yet verified.

Any generated Weekly Review or Deck content should preserve that distinction.

## 5.4 Model choice is a platform responsibility

Curriculum features request capabilities such as:

- `text.fast`
- `reasoning.high`
- `coding`
- `vision`
- `research.grounded`
- `browser.agent`
- `image.generate`
- `speech.transcribe`

A gateway maps those capabilities to concrete models/providers. Curriculum logic must not hardcode model-specific APIs.

## 5.5 Skills, not giant prompts

Core curriculum behavior must be packaged as versioned skills with structured inputs and outputs. This reduces variance, generation time, and prompt drift.

## 5.6 Director latency is a product constraint

If a director has to spend 5–10 minutes waiting for summaries, slide generation, or evidence synthesis, the curriculum breaks operationally.

The product must prepare or cache review artifacts before the session.

---

# 6. P0 Feature Set — Required for a Real Curriculum Pilot

The P0 scope is intentionally narrow. These features are required because they directly enable the v5 learning loop.

## P0-1. Experiment Browser Foundation

### Intent

Turn the current embedded HTML preview into an AI-observable and AI-controllable runtime.

### Must have

**Browser observation**
- current URL / route
- accessible DOM or semantic tree
- screenshot
- selected element context
- console output
- runtime errors
- network request failures
- current viewport

**Browser actions**
- navigate
- click
- type
- select
- scroll
- hover
- reload
- screenshot

**Element → AI**

A student can select a rendered element and ask:

- “이 버튼이 왜 안 돼?”
- “이걸 어르신이 보기 쉽게 바꿔줘.”
- “이 부분만 더 간단하게 해줘.”

The agent receives:
- stable element reference,
- DOM snippet,
- computed/relevant style context,
- screenshot,
- source mapping if available.

### Acceptance criteria

- Agent can execute a five-step interaction flow in a generated HTML app.
- Agent can detect and report runtime/console failure during that flow.
- Student can select a rendered element without manually finding its source code.
- Browser result is attached to the current artifact/product version.

---

## P0-2. AI Verify

### Intent

Give every product iteration a structured verification step before human testing.

### User flow

```text
[Test my product]
       ↓
Define / infer acceptance criteria
       ↓
Agent exercises the app in Experiment Browser
       ↓
Pass / Fail / Warning + evidence
       ↓
[Fix and re-test]
```

### Verification result schema

```json
{
  "artifact_version_id": "...",
  "criteria": [
    {"text": "User can complete an order", "status": "pass"},
    {"text": "CTA is visible on mobile", "status": "fail"}
  ],
  "runtime_errors": [],
  "network_errors": [],
  "screenshots": [],
  "tested_at": "..."
}
```

### Constraint

Prefer DOM/accessibility automation. Use vision/computer-use only when visual interpretation is necessary.

### Acceptance criteria

- Test outcome is reproducible against a specific version.
- Pass/fail decisions reference observable behavior.
- A failed test can be used as structured context for a fix.

---

## P0-3. Publish for User Test

### Intent

Allow students to test with real users without configuring hosting, domains, analytics, or accounts.

### User flow

```text
[Publish for User Test]
        ↓
Immutable test version created
        ↓
Share URL + QR code
        ↓
Participant opens from phone
        ↓
Anonymous session created
        ↓
Events + manual observations return to Studio
```

### Must have

- one-click publish from chosen product version,
- public test link with no participant HypeProof login,
- QR code,
- immutable test version,
- disable/revoke link,
- configurable expiration,
- mobile-friendly runtime.

### Acceptance criteria

- A second device can open the published product in under one minute from the student's action.
- Test traffic is attributed to a project, experiment, and product version.
- Publishing a new version never mutates an experiment already in progress.

---

## P0-4. Evidence Capture

### Intent

Turn user testing into traceable evidence, not just analytics numbers.

### Minimum raw records

**Automatic**
- session start
- page view
- click
- task start
- task complete
- custom milestone

**Manual**
- observer note
- interview note
- quote / paraphrase
- anomaly
- external source

### Evidence draft format

```text
OBSERVATION
2 of 3 users stopped for more than 10 seconds at option selection.

INTERPRETATION
Option selection appears to be a larger friction point than menu discovery.

ASSUMPTION NOT YET VERIFIED
Voice input will reduce this friction.

NEXT EXPERIMENT
Reduce option selection from three steps to one and retest with the same task.
```

### Rules

- AI may summarize evidence; it may not invent it.
- Every observed statement must retain source references.
- Students can reject/edit interpretations without mutating raw records.

### Acceptance criteria

- Clicking an observed claim reveals its source sessions/notes.
- Weekly Review consumes structured evidence, not free-form chat history alone.

---

## P0-5. HypeProof AI Gateway

### Intent

Students use HypeProof's AI capabilities without creating provider accounts or handling provider API keys.

### Architecture

```text
Student / Skill / Student App
            ↓
     Capability Request
            ↓
    HypeProof AI Gateway
            ↓
   Policy + Cost + Router
            ↓
      Provider Adapter
```

### Must have

- server-side provider credentials,
- normalized provider adapter interface,
- capability-based routing,
- streaming support where useful,
- structured output support,
- usage/cost attribution,
- rate/budget controls,
- retry/fallback policy,
- student-app safe endpoint.

### Student application interface — conceptual

```ts
hypeproof.ai.generate({ capability: "text.fast", input })
hypeproof.ai.reason({ input, schema })
hypeproof.ai.vision({ image, prompt })
hypeproof.ai.transcribe({ audio })
```

### Usage accounting

Track by:
- organization
- cohort
- team
- student
- project
- skill
- capability
- provider/model

### Acceptance criteria

- A generated student app can make an AI call without a provider key in browser code.
- The same normalized request can be routed to at least two adapters or one real + one mock adapter.
- A hard credit ceiling blocks excess requests predictably.

---

## P0-6. Venture Memory

### Intent

Persist the course as structured learning state rather than a pile of chats and files.

### Minimal entity model

```text
Project
 ├─ Problem
 ├─ Stakeholders
 ├─ Hypotheses[]
 ├─ Experiments[]
 ├─ Observations[]
 ├─ EvidenceItems[]
 ├─ Decisions[]
 ├─ ProductVersions[]
 ├─ Metrics[]
 ├─ DeckSlides[8]
 ├─ WeeklyReviews[]
 └─ AIUsage[]
```

### Critical relationship

```text
Hypothesis
   ↓ tested by
Experiment
   ↓ produces
Evidence
   ↓ changes
Decision
   ↓ creates
Product Version
   ↓ updates
Deck
```

### Acceptance criteria

- Reopening a project reconstructs the team's learning state without reading chat history.
- Director can traverse hypothesis → evidence → decision → version.
- Every important decision can be linked to evidence and affected deck slides.

---

## P0-7. Curriculum Skills

### Intent

Standardize the curriculum and reduce generation latency/variance.

### Initial skill set

| Skill | Responsibility | Structured output |
|---|---|---|
| Interview | Prepare non-leading questions and structure notes | interview plan / findings |
| Experiment | Pick risky assumption and define a minimum test | hypothesis / procedure / success criteria |
| Evidence | Separate observation / interpretation / assumption | evidence items |
| Product Builder | Modify only what the current evidence requires | product change plan |
| Critic | Find weak claims, missing evidence, safety issues | critique / missing tests |
| Deck Builder | Update only affected slides | slide patches + evidence refs |
| Demo Coach | Prepare demo and Q&A | demo flow / claim checks |

### Skill contract

Each skill should declare:

```text
intent
required context
allowed tools
preferred capability
input schema
output schema
validation rules
write-back targets
```

### Suggested filesystem shape

```text
.hypeproof/
  curriculum/v5.yaml
  skills/
    interview/SKILL.md
    experiment/SKILL.md
    evidence/SKILL.md
    product/SKILL.md
    critic/SKILL.md
    deck/SKILL.md
    demo/SKILL.md
  templates/
    experiment/
    weekly-review/
    deck/
  project/state.json
```

Reuse existing Studio conventions if equivalents already exist. Do not create a parallel plugin framework unnecessarily.

---

## P0-8. Weekly Review Pack

### Intent

Make the team's 20-minute director session immediately usable.

### Required sections

1. Last week's hypothesis.
2. Experiment run.
3. Observed evidence.
4. Interpretation.
5. Product/version change.
6. Metrics.
7. Deck slides affected.
8. Unresolved assumptions.
9. Director decision needed.
10. Suggested next experiment.

### Generation strategy

- Do not generate the whole pack for the first time when the director opens it.
- Mark a pack stale when source state changes.
- Allow a student to explicitly run **Prepare Weekly Review** before class.
- Cache the latest valid pack.
- Regenerate only stale sections where possible.
- Always show source links for factual claims.

### Acceptance criteria

- Director opens the latest valid review without waiting for a model call.
- Director can write the final decision and next experiment directly from the review screen.
- That decision writes back to Venture Memory.

---

## P0-9. HTML IR Deck Runtime

### Intent

Use the existing HTML pipeline instead of building a presentation editor too early.

### v5 deck structure

1. 문제·기회
2. 제공 가치
3. 해결 원리 — AI / Human / Safety
4. 수익 구조와 임팩트
5. 현장·고객 접근
6. 기존 도움과 대안
7. 재무·임팩트 지표
8. 현재 성과와 다음 계획

### Required behavior

- Store structured slide state separately from rendered HTML.
- Render slides in the embedded browser.
- Every factual claim may have evidence refs.
- Deck Builder proposes a patch only for affected slides.
- Student accepts/rejects slide changes.
- Unsupported numbers are flagged.
- Export can be added later; HTML is the first-class runtime.

### Acceptance criteria

- A Week 2 result can propose changes to slides 2–3 without rewriting all eight slides.
- The deck can show which claims changed and what evidence caused the change.

---

# 7. Browser Capability: What to Reuse from the Market

This section is research guidance, not a requirement to copy other products.

## 7.1 VS Code — closest architectural reference

Current VS Code browser-agent tooling already supports the core pattern we need: an agent can modify code, open a running app in the integrated browser, read page content, take screenshots, inspect console errors, interact with elements, run focused Playwright code, and verify the result. The browser can also pass selected page elements and screenshots into agent context.

**Implication:** Because Studio is a VS Code fork, inspect upstream browser/agent primitives before building a separate browser-control stack.

## 7.2 Cursor — tight visual editing loop

Cursor Browser exposes navigation, click/type/scroll, screenshots, console and network traffic. Design Mode lets a user select rendered elements, draw on the page, or speak an instruction; element identity plus screenshot context are passed to the agent.

**Implication:** `Element → AI` is a proven interaction. HypeProof should add the curriculum-specific layer that Cursor does not need: experiment → evidence → decision.

## 7.3 Replit — self-testing after build

Replit Agent can use a real browser to test an app it has built and automatically fix discovered issues.

**Implication:** Build completion and behavioral verification should be separate stages in Studio.

## 7.4 Lovable — preview, share, browser test

Lovable uses a live preview, device-size testing, preview sharing, and browser testing that can click through flows, capture screenshots, inspect console/network behavior, and verify multiple screen sizes.

**Implication:** Publish/share and browser verification should be native product actions, not manual infrastructure steps for students.

## 7.5 v0 — sandbox as real runtime

v0 runs each project in an isolated sandbox containing the filesystem, dev server, terminal, and agent tools. The preview is backed by the actual runtime instead of a purely static mock.

**Implication:** Long term, HypeProof's Experiment Browser should be attached to the same runtime that executes generated code, API routes, and tests. For the first curriculum pilot, preserve the existing HTML runtime and evolve only where curriculum requirements demand it.

---

# 8. P1 Features — Valuable, Not Blocking the First Pilot

- Model comparison lab for students.
- Automatic routing optimization based on quality / latency / cost.
- Rich shared backend / collections UI.
- Screen/session recording with explicit consent.
- Cohort-level director analytics.
- Full PPT export.
- Advanced visual regression.
- Multi-user live collaboration.
- General external-site computer use.
- Rich experiment templates for A/B and longitudinal testing.

Do not pull these into P0 unless existing code makes them nearly free.

---

# 9. Non-Goals

The first Curriculum Runtime is not:

- a general browser competitor,
- a Canva/Figma replacement,
- a Mixpanel/Amplitude replacement,
- a universal AI-model marketplace,
- an unrestricted autonomous computer agent,
- a full school LMS,
- a full cloud IDE rewrite,
- a generic slide-generation product.

A feature belongs in the first pilot only if it materially improves the curriculum loop.

---

# 10. Data Contracts

These are conceptual contracts. Adapt them to existing repository patterns after reconnaissance.

## 10.1 Experiment

```json
{
  "id": "exp_001",
  "project_id": "...",
  "week": 2,
  "hypothesis_id": "hyp_003",
  "question": "Can the user complete the order without help?",
  "method": "task_test",
  "success_criteria": ["3/5 complete", "no critical blocker"],
  "product_version_id": "v7",
  "status": "running"
}
```

## 10.2 Evidence item

```json
{
  "id": "ev_018",
  "type": "observation",
  "source_refs": ["session_17", "note_9"],
  "statement": "2 of 3 users paused at option selection",
  "confidence": "observed",
  "created_by": "student|system",
  "created_at": "..."
}
```

## 10.3 Decision

```json
{
  "id": "dec_007",
  "statement": "Reduce option selection to one step",
  "evidence_refs": ["ev_018", "ev_019"],
  "assumption_refs": ["asm_004"],
  "resulting_version_id": "v8",
  "affected_deck_slides": [2, 3],
  "decided_at": "..."
}
```

## 10.4 Artifact

```json
{
  "artifact_id": "...",
  "type": "product|deck|review|report",
  "schema_version": 1,
  "entry_html": "index.html",
  "project_id": "...",
  "version": 8,
  "source_refs": [],
  "evidence_refs": []
}
```

---

# 11. Performance and Classroom Reliability

Class time is fixed; therefore latency is a curriculum requirement.

| Operation | Initial product target |
|---|---:|
| Local HTML preview refresh | < 2 sec typical |
| Element capture to agent context | < 1 sec local processing |
| Five-step AI Verify | < 60 sec typical |
| Cached Weekly Review open | no model wait |
| Weekly Review full regeneration | target < 30 sec under normal provider conditions |
| Single deck-slide patch | target < 20 sec |
| Publish test version | target < 10 sec |

These are system design targets, not guarantees from external providers. Use caching, partial regeneration, fast-model routing, and precomputation to protect class time.

---

# 12. Privacy and Youth Safety Requirements

Because the curriculum involves minors and real external participants, default data collection must be minimal.

- Anonymous participant IDs by default.
- No provider API keys in student-generated code.
- No microphone/camera activation without explicit permission.
- No raw user-input retention unless required by the experiment.
- Clear indicator when AI/browser automation is active.
- Expiring/revocable user-test links.
- Delete path for test data.
- Explicit separation of AI interpretation from observed evidence.
- Admin-level budget and data controls.

Do not overbuild compliance infrastructure before deployment requirements are known, but do not design interfaces that make later policy controls impossible.

---

# 13. Implementation Sequence

## Phase 0 — Repository reconnaissance

Before changing production code, inspect and report:

1. Embedded browser/webview implementation and upstream VS Code version.
2. Existing browser-agent capabilities inherited from or diverged from VS Code.
3. HTML artifact creation, serving, reload, and persistence flow.
4. Current model/provider invocation path.
5. Server/client credential boundary.
6. Workspace/project persistence model.
7. Existing publish/preview infrastructure.
8. Existing test framework, Playwright/browser automation, screenshot, console, or debug integration.
9. Existing skill/plugin/custom-mode abstractions.
10. Existing telemetry/usage accounting.

**Deliverable:** repo-specific architecture map with exact paths/symbols and a gap matrix against this PRD.

## Phase 1 — Experiment Browser vertical slice

Implement:

- browser observation bridge,
- browser actions,
- element → AI context,
- screenshot + console/runtime capture,
- `Test my product`,
- acceptance-criteria execution,
- structured verification report persisted against artifact version.

## Phase 2 — Publish + Evidence vertical slice

Implement:

- immutable test version,
- share URL + QR,
- anonymous session,
- minimum events,
- manual observation note,
- evidence draft with source traceability.

## Phase 3 — Venture Memory + Curriculum Skills

Implement the minimum structured state and first four skills:

- Experiment
- Evidence
- Product Builder
- Deck Builder

## Phase 4 — AI Gateway

Implement provider abstraction and safe student-app AI path. If Studio already has a strong multi-provider gateway, adapt it instead of replacing it.

## Phase 5 — Weekly Review + Director mode

Implement cached review packs, decision capture, next-experiment creation, and four-team overview.

## Phase 6 — Deck lifecycle

Complete evidence-aware slide updates and export only after the HTML deck flow is reliable.

---

# 14. First End-to-End Definition of Done

The first meaningful milestone is **one complete Week 1 → Week 2 learning loop**, not completion of every P0 feature.

Use a simple product such as a kiosk-practice app.

The milestone is complete when:

1. Student opens/builds v0 HTML.
2. v0 runs in Experiment Browser.
3. Student selects one rendered element and requests an AI edit.
4. Student defines three observable acceptance criteria.
5. AI Verify executes the flow and records a report.
6. Student publishes the verified version.
7. A participant opens the link from a phone.
8. Studio records an anonymous session and curriculum-relevant events.
9. Student adds one manual observation.
10. Evidence Skill creates Observation / Interpretation / Assumption separately.
11. Student accepts or edits the interpretation.
12. Venture Memory stores the hypothesis, experiment, evidence, and decision.
13. Student produces v1.
14. Weekly Review shows v0 → test → evidence → decision → v1.
15. Deck Builder proposes changes only to relevant slides.

If this flow is reliable, the architecture supports the curriculum. If it is not, adding more model options or richer templates is premature.

---

# 15. Opus 5.5 — First Implementation Mission

Paste this section together with this document and the Studio repository.

```text
You are implementing the first production foundation of HypeProof Studio's Curriculum Runtime.

INTENT
HypeProof Studio is a VS Code fork. Most current outputs are HTML rendered in an embedded browser. Preserve that architecture unless repository evidence shows a concrete blocker.

The product is not trying to become a generic AI browser. The goal is to execute this curriculum loop inside Studio:

Problem → Hypothesis → Build → Test → Evidence → Decision → Product Change → Deck Change.

The immediate engineering mission is to turn the existing HTML preview into an Experiment Browser: a runtime that the student can inspect, the agent can operate, and the system can verify against observable acceptance criteria.

RULE 1 — RECONNAISSANCE BEFORE IMPLEMENTATION
Do not begin by creating a new browser framework, agent framework, artifact framework, or persistence layer.

First inspect the repository and produce a repo-specific architecture map with exact file paths, symbols, extension points, and current data flows for:
1. embedded browser/webview,
2. upstream VS Code browser features inherited or removed,
3. HTML artifact generation/serving/reload,
4. AI/model invocation,
5. credentials and server/client boundaries,
6. project/workspace persistence,
7. browser automation or Playwright,
8. screenshot/console/network/debug plumbing,
9. current skills/plugins/custom modes,
10. test commands and CI.

For each requirement in Phase 1, state whether it can reuse an existing primitive or needs new code.

RULE 2 — IMPLEMENT ONE VERTICAL SLICE
After reconnaissance, implement only the Experiment Browser MVP unless a dependency is strictly necessary.

Required MVP:
- obtain current preview URL/route,
- read a semantic DOM/accessibility-oriented representation,
- capture screenshot,
- capture console/runtime errors,
- execute click/type/scroll/reload,
- select a rendered element and attach its context to an AI request,
- expose a first-class `Test my product` action,
- accept 1–5 observable acceptance criteria,
- execute them against the running app,
- persist a structured verification report against the current artifact/product version.

Verification report must include:
- artifact/version reference,
- criteria,
- pass/fail per criterion,
- browser steps performed,
- runtime/console/network failures if available,
- screenshots where useful,
- timestamp.

RULE 3 — USE THE CHEAPEST RELIABLE BROWSER SIGNAL
Prefer DOM/accessibility-tree operations for navigation and interaction. Use screenshots/vision when layout or visual interpretation is necessary. Do not build the MVP around pixel-only Computer Use.

RULE 4 — MODEL-AGNOSTIC INTERFACES
Browser tools must not depend on one specific model provider. Keep the interface usable by future HypeProof AI Gateway capability routing.

RULE 5 — PRESERVE EXISTING STUDIO UX
Do not break current HTML creation or preview flows. Put new behavior behind a feature flag if needed.

RULE 6 — VERIFY THE IMPLEMENTATION
Source inspection is not sufficient. Run a real HTML app in Studio/its test harness and prove that the agent can execute the acceptance criteria, detect at least one intentional failure, and produce the persisted verification result.

DO NOT IMPLEMENT YET
- full model-routing UI,
- general web browsing,
- complete analytics dashboard,
- PPT export,
- cohort analytics,
- full shared database product,
- unrelated visual redesigns.

FINAL OUTPUT REQUIRED FROM THIS SESSION
1. Repo architecture map.
2. Gap matrix against Phase 1 requirements.
3. Implemented Experiment Browser MVP.
4. Automated tests.
5. Manual demo procedure.
6. Changed-file list.
7. Known limitations and risks.
8. Concrete interface proposal for the next vertical slice: Publish for User Test + Evidence Capture.

If repository reality conflicts with this PRD, preserve the Intent and learning loop, explain the conflict, and adapt the implementation rather than forcing the proposed internal structure.
```

---

# 16. Decision Summary

The main product decision is:

> **Keep the current VS Code + HTML foundation, but turn Preview into the point where Build becomes Test, Test becomes Evidence, and Evidence changes the next version.**

The first moat is not a particular frontier model. The first moat is the **structured six-week venture history and the curriculum-native loop built around it**.

The priority is therefore:

```text
Experiment Browser
      ↓
Publish / User Test
      ↓
Evidence
      ↓
Venture Memory
      ↓
Curriculum Skills
      ↓
Weekly Review + Deck
      ↓
AI Gateway optimization / richer model exposure
```

---

# Appendix A. Source Traceability — AI for Good Curriculum v5

This PRD derives curriculum requirements from the provided `curriculum-v5.html`:

- Program intent, six-week format, first-week product creation: lines 191–214.
- Weekly 240-minute loop and team debrief structure: lines 217–227.
- Week 1 external user observation: lines 233–244.
- Week 2 AI failure/safety and repeated use: lines 246–257.
- Week 3 beneficiary/payer, impact, and channel work: lines 259–269.
- Week 4 alternative comparison: lines 272–282.
- Week 5 metrics and deck preparation: lines 285–295.
- Week 6 demo day: lines 298–309.
- Eight-slide deck: lines 312–324.
- Evidence/numeric rules: lines 380–392.
- Existing Studio test results and identified F1–F6 gaps: lines 395–492.

# Appendix B. External Product Research Used as Reference

Official product documentation reviewed on 2026-09-28:

- VS Code — Browser tools with agents; Integrated browser.
- Cursor — Browser; Design Mode.
- Replit — Agent App Testing.
- Lovable — Browser Testing / Preview & Share.
- v0 — Sandbox; Agentic Features.

These references inform interaction patterns only. HypeProof's differentiator remains the curriculum-specific Evidence → Decision → Learning loop.
