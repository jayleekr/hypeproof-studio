# Curriculum Runtime verification contract

Status: **CR-T01 runs in CI** (worker `npm test`, `worker/test/cr-recon.test.mjs`; its PASS is recorded with `cr-recon`'s completion, not here). **CR-T02–T80: NOT RUN except the `cr-browser` runs recorded in [curriculum-runtime-2026-09-30-evidence.md](curriculum-runtime-2026-09-30-evidence.md)** (its CI smokes, a synthetic real-Chromium run, and in-app Playwright runs of CR-T02 switch on/off, CR-T07, CR-T08, CR-T09, CR-T10 and CR-T63 on 2026-10-01; the `cr-verify` runs in [curriculum-runtime-2026-10-01-evidence.md](curriculum-runtime-2026-10-01-evidence.md); the `cr-publish` runs in [curriculum-runtime-2026-10-02-evidence.md](curriculum-runtime-2026-10-02-evidence.md); whether a row is claimed is decided by the slice's completion record, not here). 2026-09-29, runs added 2026-09-30 and 2026-10-01. Owner: jayleekr.
Intent: [INT-CR-00–09](../intents/curriculum-runtime.md) · requirements: [CR-01–84](../requirements/curriculum-runtime.md) · plan: [curriculum-runtime](../plan/curriculum-runtime.md). Layer and command canon: [05-testing-requirements](../dev/05-testing-requirements.md). Judgment discipline: [.claude/rules/verification.md](../../.claude/rules/verification.md) — open the target before writing a verdict rule, run the controls before the real run, and rule out the instrument before blaming the product.

This document **defines** checks. A check written here is not a check that ran. Every row starts NOT RUN; run records go to a separate evidence file (`docs/testing/curriculum-runtime-<date>-evidence.md`) with commit, environment, evidence class (live-host / captured-replay / synthetic, MC-38), expected and observed, PASS / FAIL / NOT RUN / BLOCKED. Passing unit tests of an existing feature is not a PASS for a CR row. File names below are proposals; the implementing PR fixes them after reading the code it tests.

Every row has a positive control (a sample that must pass, to catch an instrument that is too strict) and a negative control (a planted defect that must fail, to catch an instrument that is too lenient). If a control misbehaves in a run, every verdict of that run is void.

## Layers

| Layer | What it measures | Command (existing pattern) |
|---|---|---|
| unit | Pure helpers: validators, contracts, gates, patch scoping, planted-answer checks | `cd worker && node --experimental-strip-types test/<name>.test.mjs` · `cd extensions/hypeproof-chat && node --experimental-strip-types test/<name>.smoke.mjs` |
| worker D1 | Service routes and tables on local workerd/D1 (publish, events, gateway, memory, review cache) | `cd worker && npm run test:<suite>:d1` (pattern of `test:classroom-ops:d1`) |
| extension smoke | `BrowserControl` / CDP against a fixture page, element capture, tool contracts | `cd extensions/hypeproof-chat && npm test` (pattern of `browser-control-helpers.smoke.mjs`, `live-server.smoke.mjs`) |
| Playwright e2e | Real Electron app, webview, commands, screens, mobile emulation for the published runtime | `cd e2e && npm test` · one spec: `npx playwright test tests/<name>.spec.ts` (pattern of `09-preview.spec.ts`) |
| real-Mac | Installed or dev-host Studio on a reference Mac; timings; the end-to-end loop | `node e2e/classroom/<name>.mjs` (pattern of `mac-devhost.mjs`, `g4-journey.mjs`) |
| real phone | A physical phone opening a published link | manual, recorded in the evidence file |
| doc check | Registry and recon documents | `cd worker && node --experimental-strip-types test/cr-traceability.test.mjs` (registry trace) · `cd worker && node --experimental-strip-types test/cr-recon.test.mjs` (CR-T01, the recon map); both run in `npm test` |

The registry trace itself (every CR row has a CR-T that lists it, every CR-T is referenced, every reuse ID resolves) is `worker/test/cr-traceability.test.mjs`. It is a gate on these documents, not a CR-T row.

## A. Reconnaissance and cross-cutting

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T01 | doc check | The recon map covers the ten PRD §13 areas, each entry names a path and symbol that exist at the map's commit, and the gap matrix has one verdict (reuse / extend / new) per CR row. | The committed map passes on its own commit. | A map entry with a non-existent path, a missing area, or a CR row absent from the matrix fails. | CR-01 |
| CR-T02 | Playwright e2e + worker D1 | With the switch off, no CR command, panel, tool or worker route is reachable and the existing preview and HTML generation specs stay green; with it on, the CR surfaces appear. The check walks a switch-off inventory of CR commands, panels, MCP tools and worker routes; every implementation item adds its own surfaces to it. The inventory also lists CR-02's one exception as a conditional surface (`CR_SURFACES.switchOffWhileStored`: the delete command for stored browser-result bytes), checked to be gated on exactly "the signed-in person has bytes stored": hidden with nothing stored, shown while bytes are stored whatever the switch says, and deleting only that person's bytes. | `09-preview.spec.ts` and the HTML generation specs pass with the switch off; with it on, every inventory entry is reachable; the delete command is hidden before anything is stored, shown with the switch off once bytes are stored, and hidden again after the delete. | A fixture build that registers a CR command regardless of the switch is caught; a CR worker route that answers with the switch off, instead of answering as an unknown route does, is caught; a delete command shown with nothing stored, or gated on anything but the bytes-stored key, is caught. | CR-02 |
| CR-T03 | unit | Browser-tool and verify-runner modules import no provider SDK and exchange plain data; the same tool call runs through the SDK and proxy coach adapters. | The same five-call script gives identical tool results through both adapters. | A planted `@anthropic-ai/sdk` import in the runner module is reported. | CR-03 |

## B. Experiment Browser

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T04 | extension smoke | Observation on a fixture page returns URL, route, semantic snapshot with refs, screenshot and viewport, tagged with document generation. | Fixture with known title, route and three buttons yields those refs and the set viewport. | A planted observation with the viewport or document generation removed is an explicit error, not a partial result. (Stale-ref rejection is AE-18's check.) | CR-04 |
| CR-T05 | extension smoke | Console, uncaught exception and failed request of the fixture are captured per document generation. | A fixture that logs one `console.error`, throws once and fetches a 404 yields exactly three records. | A clean fixture yields zero records; records from the previous document are not attributed to the new one. | CR-05 |
| CR-T06 | extension smoke | `select`, `scroll`, `hover`, `reload` join the existing actions; every action returns the resulting observation. | Each action changes a fixture DOM state the next observation shows. | An unknown action name returns an explicit error; an action result with the resulting observation stripped fails the contract; `select`, `scroll` and `hover` on a ref from before a reload are not executed. | CR-06 |
| CR-T07 | Playwright e2e | An agent-driven five-step flow on the kiosk-practice fixture app reaches the final state using CR-06 actions only. | Unmodified fixture: five steps succeed, final order screen shown. | Planted disabled button at step 4: the flow reports failure at step 4, not success. | CR-07 |
| CR-T08 | Playwright e2e | A console error raised during step 3 of the flow is reported with the step index. The step index is the Nth agent action of the current request, the opening navigate counted; a record from an earlier request carries no step. | Planted error at flow step 3 is reported once, at the index of the action that raised it (in the App flow, which opens with a navigate: 4). | The unmodified fixture reports no failure (no false positive); an earlier request's error is never reported at a step of the current request. | CR-05, CR-08 |
| CR-T09 | Playwright e2e | Selecting a rendered element produces a context payload with ref, bounded DOM snippet, computed style subset, element screenshot and source mapping or "unmapped"; the student can remove it before sending. | Selecting the order button yields its ref and a mapping to the file that defines it. | A payload whose ref differs from the selected element fails; an inline-generated element yields "unmapped", never a guessed file. | CR-09 |
| CR-T10 | unit | Every browser result carries artifact version ID and file-set digest; after a file change older results are labelled with their version. | Result taken on v0 stays readable and labelled v0 after v1. | A result without an artifact version is refused. | CR-10 |
| CR-T11 | extension smoke | The runner and agent browser actions may act on the local preview and the project's published origins only. | Agent browser actions on the live-server origin run (`cr-browser`); runner steps on the live-server origin run (`cr-verify`); runner steps and agent browser actions on a published test origin of the same project run (`cr-publish`). | An agent browser action or runner step navigating to an external origin is refused with a reason; one navigating to a published test origin of another project is refused (`cr-publish`). | CR-11 |

## C. AI Verify

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T12 | Playwright e2e | "Test my product" accepts 1–5 criteria; student-written criteria are stored with the student actor; AI-proposed criteria wait for confirmation. | Three typed criteria start a run and appear as `criterion_set` with student text. | Zero or six criteria are refused; an unconfirmed AI-proposed criterion does not start a run and is never stored as the student's. | CR-12 |
| CR-T13 | unit | The verification report validator and its persistence through existing learning events. | A report with the PRD §6 fields plus `steps` validates and round-trips through `criterion_set` / `test_observed`. | Missing `artifact_version_id`, `tested_at` or `steps` is refused; a store-inventory check catches any new table or KV namespace. | CR-13 |
| CR-T14 | Playwright e2e | Same criteria, same version, same viewport give the same verdicts; a criterion whose verdict differs between such runs is reported as non-reproducible. (Stale marking after a change is AE-37's check.) | Two runs on v0 give identical per-criterion verdicts. | A planted flaky fixture (a button that fails on alternate loads) makes the two runs disagree; the criterion is reported non-reproducible, not pass. | CR-14 |
| CR-T15 | unit | Each verdict cites steps and an observation; vision is used only for criteria marked visual and is labelled. | A pass citing a snapshot ref and a fail citing a console record validate. | A verdict with no cited observation is downgraded to "not verified"; an unlabelled vision verdict is refused. | CR-15 |
| CR-T16 | Playwright e2e | A failed criterion becomes a fix request that references the report, criterion ID and version, and the re-test runs that criterion ID on the fixed version. | Criterion 2 fails; the fix request carries report, criterion 2 and v0; the re-test of criterion 2 on v1 passes and `retest_confirmed` appears for criterion 2. | A planted fix request with the report reference removed is refused, not sent to the coach as free text. (Retest rules are SX-15's check.) | CR-16 |
| CR-T76 | unit + Playwright e2e | "Verified" is shown only for a version with an all-pass `hps-verification/1` report bound to it. | A version whose report has three passes shows verified; one whose report has a fail shows the fail. | A version with no report, a version whose only report is bound to another version, and a version after a coach message saying "완료했어요" all show not verified. | CR-81 |

## D. Publish for User Test

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T17 | worker D1 + Playwright e2e | Publish creates a content-addressed immutable test version; the publish action shows the chosen version's verified state (CR-81). | Publishing the same bytes twice returns the same version ID; the publish action for a version with an all-pass report bound to it shows verified; a file carrying a Supabase anon key publishes. | An attempt to replace a file behind a published version is refused; the publish action for a version with no report bound to it shows not verified; a workspace `.env`, any other dot-file, a file neither reachable from the entry HTML nor in the confirmed manifest, and a symlink the entry HTML references that resolves outside the workspace root are never uploaded or served; a file carrying a provider key refuses the publish before any upload, with one planted key per `LLMProvider` value (Gemini `AIza…`, Anthropic `sk-ant-…`, OpenAI `sk-…`, GLM `<id>.<secret>`), one Supabase service key, one student token and one issuer token (the format `issue()` / `issueIssuer()` sign, planted bare and as a `…_TOKEN = "…"` assignment), and the Worker refuses the same upload sent directly; a student token of another team uploading into this project gets 404 and nothing is recorded for the project. | CR-17 |
| CR-T18 | Playwright e2e | The share URL and QR open the product at 390 px with no login (mobile emulation). | The decoded QR equals the share URL and renders without a login screen. | A link variant that redirects to login fails. | CR-18 |
| CR-T19 | worker D1 | Revoked and expired links answer 410 with no content; live links answer 200. | Before expiry and before revocation the link serves the version. | After revocation the link, including any cached path, serves no content; while no default expiry is set, a publish without an explicit expiry is refused; a participant event sent with a still-valid session token after its link was revoked or expired is refused and writes nothing; a student token of another team revoking the link gets 404 and the link keeps serving. | CR-19 |
| CR-T20 | real-Mac + real phone | Publish action to published version under 10 s; publish action to first render on a second device under 60 s. | Recorded timings on the reference Mac and phone with sample size and p50/p95. | A planted slow upload shows as a recorded miss with its cause, not as a pass. | CR-20, CR-64 |
| CR-T21 | worker D1 | Every participant session record created on link open carries project, experiment and version (events inherit them from their session; CR-T23 checks that). | Opening the published v0 link creates a session record with the three IDs of its experiment. | A session whose version is not the experiment's is refused. | CR-21 |
| CR-T22 | worker D1 | Publishing v1 while an experiment on v0 runs leaves the experiment on v0. | Participants of the running experiment keep getting v0 and their sessions stay attributed to v0; a Week 6 demo pinned to v0 keeps showing v0. | A link of the running experiment that starts serving v1 fails. | CR-22 |
| CR-T68 | worker D1 | Several channel-labelled links of one experiment attribute their sessions to their own channel. | Two links of one experiment labelled with two channels attribute each session to its link's channel. | A session claiming an experiment other than its link's is refused; a session with no recorded link is "unknown channel"; after revoking one channel's link the other still serves. | CR-73 |

## E. Evidence Capture

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T23 | worker D1 | Six participant event kinds under an anonymous session ID with `source_state` real, stored through the existing learning-event store. | One scripted participant session produces all six kinds with a random session ID, a participant pseudonym and no identity fields; every event carries its session's project, experiment, version and channel. | Events for a revoked version are refused; an event carrying a name or e-mail field is refused; the store inventory shows no new evidence table. | CR-23, CR-65 |
| CR-T24 | unit | Five manual record kinds with kind-specific provenance and `source_state`; KO/EN text kept verbatim. | An interview note with speaker, date and situation validates; mixed Korean/English text round-trips unchanged. | A record without provenance or `source_state` is refused. | CR-24 |
| CR-T25 | unit | Evidence drafts keep the four sections as separate types and refuse unresolvable observed statements (planted answers). | A draft whose three observed statements cite real event and note IDs validates. | Three planted fabricated statements (missing ID, other project's ID, deleted ID) are refused — exactly three. | CR-25 |
| CR-T26 | unit | Accept / edit / reject creates interpretation revisions; raw record bytes are unchanged. | Editing an interpretation adds a revision; raw record hashes are identical before and after. | A code path that rewrites a raw note during an edit is caught by the hash comparison. | CR-26 |
| CR-T27 | Playwright e2e | Clicking an observed claim opens its source sessions and notes. | Clicking the "2 of 3 paused" claim opens the three session records it cites. | A claim whose reference no longer resolves shows "needs review"; a claim citing a participant session of another project's experiment does not open it; the experiment's evidence route answers 404 to a student token of another team and to a director whose scope does not cover the project's cohort. | CR-27 |
| CR-T28 | unit | The review input builder reads evidence items, not chat history. | A project with evidence items yields review claims citing them. | A project with only chat history yields "no evidence recorded" and no claims. | CR-28 |
| CR-T67 | worker D1 | Returning sessions of a declared repeated-use experiment give return counts and intervals as observed items citing the sessions. | One pseudonym's three sessions over two days yield return count 2 and both intervals, each citing the three session records. | An undeclared experiment shows "not measured", not 0; sessions from two experiments are never merged; a return count citing no sessions is refused; twenty sessions of one experiment linked concurrently that do not all appear in its session record and return counts fail (today's unserialized `linkSession` keeps one of twenty). | CR-72 |
| CR-T69 | worker D1 + unit | A comparison experiment attributes every record to one variant and reports per variant. | A fixture with v1 and one outside alternative (observed through notes) yields per-variant results under the same criteria, each citing its own records. | An event without a variant is refused; a comparison claim citing one variant is flagged unsupported; publishing v2 leaves both variants' pinned versions unchanged. | CR-74 |

## F. HypeProof AI Gateway

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T29 | worker D1 + unit | The student-app endpoint with an app-scoped token and origin-bound CORS; the generated app bundle carries no provider key. | The kiosk-practice app calls `text.fast` from its published origin and gets an answer; its own app token, bound to its project and origin, passes the publish scan. | A provider key planted in a bundle is found by the scan, which runs at publish before upload, so no served test version carries it, with one planted key per `LLMProvider` value (Gemini, Anthropic, OpenAI, GLM), plus a student token, an issuer token and an app token bound to another project, each of which refuses the publish; the same token from another origin or app is refused; the app token sent to any student route in recon R8's inventory is refused (`/v1/profile`, `/v1/access/*`, `/v1/logs/*`, `/v1/trace/*`, `/v1/classroom/*` including the rehearsal report and the ops `lesson-binding` learner token, `/v1/lesson-turns/*`, `/v1/worlds/*`, `/v1/observations/*`, `/v1/request-settings/*`, `/v1/activity`, `/v1/chat/completions`, `/v1/messages` and `/v1/messages/count_tokens`, and the Lab gallery publish through `/v1/profile`); a token with an unknown role is refused by the same routes; a source check fails on any call site of the `verify` imported from `lib/tokens.ts` in `worker/src` (not `crypto.subtle.verify`) that neither calls the student allow-list helper nor is on a path recon R8 names (issuer or admin, optional auth, or deferring to `gateChatRequest`). | CR-29 |
| CR-T30 | unit | Capability requests map to the policy's model with the mapping revision recorded; model IDs and unmapped capabilities are explicit errors. | `text.fast` resolves to the policy model and the call record names the policy revision. | A request naming a model ID is refused; `image.generate` with no mapping returns an explicit error, not a silent text answer. | CR-30 |
| CR-T31 | unit | One normalised request through a recorded real-adapter fixture and a mock adapter gives the same normalised shape, for a plain, a streaming, a schema-constrained, an image and an audio request. | Both adapters return the same fields for the plain request, the same normalised stream events ending in one terminal event for the streaming request, and schema-valid output for a `reason({ input, schema })` request; an image request through the CR-29 snippet's `hypeproof.ai.vision({ image, prompt })` and an audio request through its `hypeproof.ai.transcribe({ audio })` each return the normalised shape, or, where the policy maps no model to `vision` or `speech.transcribe`, the same explicit unmapped-capability error through both adapters. | An adapter returning a provider-specific shape fails the contract; a schema-constrained response that does not validate is an explicit typed error, never passed through; a streaming request to an adapter without streaming is an explicit error, not a silently buffered answer; an image or audio request whose media is dropped and answered as a text-only request fails. | CR-30, CR-31 |
| CR-T32 | unit | Retry policy: one same-model retry for a transient failure before output, every attempt metered; no other provider; typed error. | A 503 before any output is retried once on the same model and both attempts are metered. | After partial stream output there is no retry; with the mapped provider down, a spy records zero calls to any other provider and the caller gets a typed error. | CR-32 |
| CR-T33 | worker D1 | Hard ceiling with atomic reservation; predictable 429. | Requests up to the ceiling succeed. | The next request gets 429 with a reason code and no upstream call; 20 concurrent requests at the edge do not overshoot; an unconfigured ceiling blocks. | CR-33 |
| CR-T34 | worker D1 | Usage rows carry organisation, cohort, team, student, project, skill, capability and provider/model on existing ledgers. | A call issued by a registered skill (cr-skills) produces one row with all eight dimensions. | The same attempt counted in two ledgers fails; a missing dimension recorded as a guess instead of unknown fails. | CR-34 |
| CR-T75 | worker D1 | Per-app-token and per-participant-session rate limits on the student-app endpoint. | Requests under the limit from two participant sessions of one app succeed. | A burst of limit + 5 from one session gets 429 `rate_limited` after the limit, a spy sees no upstream call for the throttled requests, the team ceiling reservation is unchanged, and the other session still succeeds; 100 fabricated session IDs on one app token stop at the app-token limit. | CR-80 |
| CR-T79 | unit + worker D1 | For an AI feature the coach and Product Builder generate `hypeproof.ai.*` capability calls; the extended scan catches provider SDKs, provider endpoints and model IDs. | Asked on the kiosk fixture for an AI feature ("메뉴 추천 기능 넣어줘"), the coach generates code that calls `hypeproof.ai.generate` with a capability, the scan passes, and the published version's call reaches the student-app endpoint and gets an answer. | Planted generated code with a provider SDK import (`@anthropic-ai/sdk`, `openai`), a provider API URL, or a model ID in place of a capability is each caught by the scan and reported with file and line. | CR-84 |

## G. Venture Memory

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T35 | worker D1 | Memory entities and links; observations and evidence items by reference into the existing store. | A project with hypothesis → experiment → evidence → decision → version → slide round-trips. | A store-inventory check catches a duplicated evidence or observation table. | CR-35 |
| CR-T36 | Playwright e2e | Reopening a project reconstructs learning state without chat history. | Close, delete chat history, reopen: the same hypotheses, experiments, decisions and versions appear. | A reconstruction that changes when chat history is removed fails. | CR-36 |
| CR-T37 | worker D1 | Director traversal hypothesis → evidence → decision → version within scope. | A director reads the chain for a directed team. | A director reading another cohort's team is refused. | CR-37 |
| CR-T38 | unit | Decisions link evidence and affected slides and record their actor. | A student decision with two evidence refs and slides 2–3 validates. | A dangling evidence ref is refused; an AI-actor decision is never rendered as the team's decision; a decision with no evidence linked that is hidden, or shown without its no-evidence marking, fails. | CR-38 |
| CR-T39 | unit | Validators for the Evidence item, Decision and Artifact contracts of PRD §10 (the Experiment contract is CR-T80). | The three PRD §10.2–10.4 samples validate. | Each sample with one required field removed is refused; an observed evidence item with empty `source_refs`, a slide number 9 and an artifact without `entry_html` are refused. | CR-40, CR-41, CR-42 |
| CR-T80 | unit + worker D1 | The Experiment contract of PRD §10.1 and where its record is first created: starting a test from the publish action creates the Experiment record, naming a stored Hypothesis, in the storage Venture Memory extends. Run by `cr-publish`, re-run by `cr-memory`. | The PRD §10.1 sample validates; starting a test on v0′ in a project with no hypothesis stores the student's hypothesis and one Experiment record whose `hypothesis_id`, `project_id` and `product_version_id` resolve; `cr-memory` reads the same two records without copying them. | The §10.1 sample with any one required field removed is refused; an experiment whose `hypothesis_id` does not resolve is refused; a store-inventory check catches an experiment or hypothesis table beside the Venture Memory storage. | CR-39 |
| CR-T70 | unit | Stakeholder roles (user, payer, beneficiary) with evidence refs. | A stakeholder holding user and payer roles with evidence refs validates and shows both roles. | A stakeholder with no role is refused; a role marked observed with no evidence refs is refused. | CR-75 |
| CR-T71 | unit | Metric definitions and values with sources and `source_state`. | An impact metric computed from three real events shows its value with the three source refs. | A value with no source is shown unsupported; a simulated input counted into a real result fails; an impact metric with no stakeholder is refused. | CR-76 |
| CR-T72 | unit | Product version diff with the decision and evidence behind the newer version. | The v0 → v1 diff lists the changed files and the decision with its evidence. | A diff across two projects is refused; a version with no recorded decision shows "no recorded decision", not a reason. | CR-77 |
| CR-T73 | unit | Project timeline built from stored records without model calls. | The Week 1 → 2 fixture yields a time-ordered timeline whose every entry opens its record, with zero model calls. | A planted entry with no record fails; an AI-actor suggestion shown as a decision fails. | CR-78 |
| CR-T74 | unit | "Belief changed because…" assembled only from hypothesis revisions and their linked decisions and evidence. | A hypothesis revised after a decision shows the before and after statements with the decision and evidence cited. | A revision with no linked decision shows "reason not recorded"; an update that overwrites the earlier statement fails the revision check. | CR-79 |
| CR-T77 | unit | The fact/assumption register lists evidence items by confidence with their status; `assumption_refs` resolve to assumed items; an assumption becomes observed only through a sourced revision. | A project with two observed, one interpreted and two assumed items lists all five by confidence; after a student-accepted revision citing two real session records, one assumption shows a later observed revision and its earlier revision stays readable. | A Decision whose `assumption_refs` entry is dangling or points at an observed item is refused; a promotion whose only basis is an AI or skill statement, with no resolvable `source_refs`, is refused; an update that overwrites an assumption's statement fails. | CR-82 |

## H. Curriculum Skills

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T40 | unit | The skill loader requires the eight contract fields and cannot be used to widen tool permissions. | The Experiment skill with all eight fields loads. | A skill missing `output schema` is not loaded; a workspace settings file adding an allow-rule has no effect. | CR-43 |
| CR-T41 | unit | Output validation gates write-back to the declared targets. | Valid Evidence skill output writes only its declared targets. | Invalid output writes nothing and returns an explicit error. | CR-44 |
| CR-T42 | unit | Curriculum v5 and the skill registry are data; outputs and gateway calls carry skill ID and version. | The v5 data file validates and a skill output carries `skill@version`. | A week string planted in extension source is caught by the scan. | CR-45 |
| CR-T43 | unit | First four skills against fixtures with planted answers. | Product Builder's plan touches only files tied to the fixture evidence; Deck Builder patches only the affected slides. | Planted out-of-scope file changes and unaffected-slide edits are each caught. | CR-46 |
| CR-T44 | unit | Interview, Critic and Demo Coach against fixtures with planted answers. | Interview output for the fixture has only open questions; Demo Coach output has a demo flow and Q&A. | Planted leading questions, planted weak claims, a planted product whose AI failure has no handling, and one planted unsupported demo or Q&A claim are each caught; a Critic output that does not list the planted claim no verification criterion or experiment checks as a missing test fails. | CR-47 |

## I. Weekly Review Pack

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T45 | unit | The pack builder emits ten sections with source links for factual claims and interpretation apart. | The Week 2 fixture yields ten sections, each factual claim linked; with no slide patch pending, "deck slides affected" names the decisions' slides and says "no proposal". | A factual claim without a source link fails; a "deck slides affected" section left empty instead of saying "no proposal" fails. | CR-48 |
| CR-T46 | worker D1 | Staleness by input digest and section-only regeneration. | Changing one evidence item marks only the sections that read it stale; regeneration calls the model once per stale section. | Regenerating an unchanged section, or presenting a stale pack as current, fails. | CR-49 |
| CR-T47 | worker D1 | Opening the latest valid pack makes zero model calls. | A spy on every model-call path the pack builder can reach (the existing coach route, and the gateway once `cr-gateway` has landed) records zero calls when the pack opens. | A stale pack opens with its stale marking and still makes zero calls; any call fails. | CR-50 |
| CR-T48 | Playwright e2e | The director records decision and next experiment on the review screen and both write back to memory. | After reopening, the Decision (director actor, evidence linked) and the Experiment draft exist. | A decision stored without a director actor, or missing after reopen, fails. | CR-51, CR-52 |
| CR-T49 | worker D1 | Four-team overview with fresh / stale / missing and no model calls. | Four fixture teams show their three states correctly. | A team from another cohort appears, or a model call occurs, and fails. | CR-53 |

## J. HTML IR Deck Runtime

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T50 | unit + Playwright e2e | Eight-slide v5 state rendered to HTML in the embedded browser. | The fixture deck renders the eight titles verbatim from state. | Editing the rendered HTML does not change the state; the next render restores it. | CR-54 |
| CR-T51 | unit | Slide claims carry observed / interpreted / assumed labels no stronger than their evidence; unsupported and simulated numbers are flagged (planted answers). | Numbers with evidence refs are not flagged; a claim citing only observed items shows observed and a claim citing none shows assumed. | Four planted numbers without refs yield exactly four flags; a simulated-source number is labelled simulated; a claim labelled observed that cites no item, or an interpreted or assumed one, fails. | CR-55 |
| CR-T52 | unit | Patches are per affected slide; accept and reject behave per slide; pending patches reach the Weekly Review Pack. | Accepting slide 2's patch changes only slide 2; a pack prepared while the slide 2 patch is pending lists it under "deck slides affected" with its evidence refs. | A rejected patch leaves the state byte-identical; a patch touching an unaffected slide fails; a pack prepared while a patch is pending that leaves it out of "deck slides affected" fails; a proposal created or decided after the pack was prepared that does not mark that section stale fails. | CR-56 |
| CR-T53 | unit | The Week 2 fixture result yields patch proposals for slides 2 and 3 only. | Proposals exist for slides 2 and 3. | Any proposal for slides 1 or 4–8 fails. | CR-57 |
| CR-T54 | Playwright e2e | The change view shows changed claims with the evidence that caused each. | After accepting the Week 2 patches, each changed claim shows its evidence. | A changed claim without linked evidence is shown as unsupported, not justified. | CR-58 |

## K. Performance

Timing rows record the machine, app build, sample size, p50, p95, max and failures. Provider latency is separated from Studio processing. A miss is a recorded finding, not a failed build.

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T55 | real-Mac | Preview refresh after save, 30 samples. | p50 under 2 s on the reference Mac. | A planted 3 s delay in the refresh path is reported as a miss. | CR-59 |
| CR-T56 | extension smoke + real-Mac | Element capture to context, 30 samples. | p50 under 1 s of local processing. | A planted full-page screenshot in place of an element crop is reported as a miss. | CR-60 |
| CR-T57 | real-Mac | Five-step AI Verify on the kiosk fixture, 10 runs. | Typical run under 60 s. | Runs over 60 s are listed with cause (provider vs Studio). | CR-61 |
| CR-T58 | worker D1 | Full review regeneration against a recorded provider with normal latency, 10 runs. | Under 30 s. | A recorded slow provider shows as a provider-caused miss, not a Studio pass. | CR-62 |
| CR-T59 | worker D1 | Single slide patch proposal against a recorded provider, 10 runs. | Under 20 s. | A proposal regenerating all eight slides is flagged even when fast. | CR-63 |

## L. Privacy and youth safety

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T60 | unit | The participant event schema has no identity fields; session IDs are random; the participant pseudonym is random, scoped to one experiment on one device, and links sessions only when the experiment declares repeated-use measurement. | Two sessions from the same browser in a declared experiment share one pseudonym and have different session IDs; the same browser in a second experiment gets an unrelated pseudonym. | A schema change adding `email` or `name` fails the schema check; a pseudonym computed from user agent or IP fails; two sessions of an undeclared experiment carrying the same pseudonym fail; a session opened after the experiment's link expired or was revoked that reuses the earlier pseudonym fails. | CR-65 |
| CR-T61 | Playwright e2e | The published runtime denies microphone and camera unless the experiment declares them; automation never grants them. | A declared experiment shows the browser's own permission prompt. | An undeclared experiment's page calling `getUserMedia` is denied; an automation step that grants a device permission fails. | CR-66 |
| CR-T62 | worker D1 | Typed participant input is not retained by default. | An experiment declaring raw-input retention stores the typed text. | Typed text stored for an undeclared experiment fails. | CR-67 |
| CR-T63 | Playwright e2e | The automation indicator is visible while agent browser tools or the runner act and disappears after. | Indicator shown during an agent browser-tool step (`cr-browser`) and during a verify run (`cr-verify`), and gone after each ends. | An agent browser-tool step or a runner step with no visible indicator fails. | CR-68 |
| CR-T64 | worker D1 | Deleting an experiment's or session's test data propagates and leaves a receipt. | Events, notes and derived drafts are removed and a receipt is issued. | A derived draft still citing a deleted record fails; a student token of another team deleting the experiment or one of its sessions gets 404 and nothing is removed. | CR-69 |
| CR-T65 | worker D1 | Admin budget and data controls with authorisation. | An admin sets a team ceiling and a cohort retention policy. | A non-admin attempting either is refused. | CR-70 |
| CR-T78 | worker D1 | Student-app gateway calls keep no raw input unless the experiment declares it; deletion reaches gateway usage and trace rows. | An experiment declaring raw-input retention keeps the body of its app call; an undeclared experiment's call keeps counts, sizes, latency and attribution only. | With the cohort's `log_user_messages` on, an undeclared experiment's app call that stores a request or response body, or writes an R2 turn body, fails; after a participant session is deleted, a usage or trace row still carrying its session key fails, and the receipt counts the rows it deleted or changed. | CR-83 |

## M. End-to-end

| ID | Layer | What it checks | Positive control | Negative control | Targets |
|---|---|---|---|---|---|
| CR-T66 | real-Mac + real phone (scripted run plus one live run) | The fifteen steps of CR-71 (PRD §14) on the kiosk-practice app, each step reading the previous step's record, as listed in the §14 procedure below. | Scripted run: all fifteen steps pass on the dev host. Live run: one real Mac and one real phone complete the loop; evidence class live-host. | A planted break between steps 8 and 10 (events not reaching the Evidence skill) stops the loop at step 10; a live-run step satisfied only by synthetic data is recorded as NOT RUN, not PASS. | CR-71 |

### §14 procedure (CR-T66)

Both runs follow CR-71's fifteen steps in this order. A step passes only when it produces the record in the third column and the next step reads that record through the product's own API or store, not through a variable the script kept or a fixture standing in for it.

| Step | Action | Record the next step reads | Rows exercised |
|---|---|---|---|
| 1 | Open or build v0 of the kiosk-practice HTML app. | Artifact version v0 with its file-set digest. | CR-42 |
| 2 | v0 runs in the Experiment Browser. | An observation bound to v0: URL, snapshot, screenshot, viewport, document generation. | CR-04, CR-10 |
| 3 | Select one rendered element and request an AI edit. | The element context payload the student approved, and the edited artifact version v0′ (new digest). | CR-09 |
| 4 | Define three observable acceptance criteria. | Three `criterion_set` events with the student actor, on v0′. | CR-12 |
| 5 | AI Verify runs the criteria. | An `hps-verification/1` report bound to v0′, with per-criterion verdicts and steps. | CR-13, CR-15, CR-81 |
| 6 | Publish the verified version and start the test: the student states the hypothesis it tests (the project has none yet) and the experiment's question, method and success criteria. | A test version keyed by v0′'s digest, its share URL and QR code, and an Experiment record pinned to it whose `hypothesis_id` names the Hypothesis record stored with it. | CR-17, CR-18, CR-22, CR-39 |
| 7 | A participant opens the link from a phone. | First render on the phone and a participant session start. | CR-18, CR-20 |
| 8 | Studio records the anonymous session and events. | Participant events with session ID, pseudonym, project, experiment and version, `source_state` real. | CR-21, CR-23, CR-65 |
| 9 | Add one manual observation. | An observer note with its provenance and `source_state`. | CR-24 |
| 10 | The Evidence skill drafts Observation / Interpretation / Assumption. | A draft whose observed statements cite the step 8 events and the step 9 note. | CR-25, CR-46 |
| 11 | Accept or edit the interpretation. | An interpretation revision, with raw record hashes unchanged. | CR-26 |
| 12 | Venture Memory stores hypothesis, experiment, evidence and decision. | The step 6 Hypothesis and Experiment records linked to the EvidenceItems of steps 10–11 and to a Decision that cites them; no second hypothesis or experiment record is created. | CR-35, CR-38, CR-39 |
| 13 | Produce v1. | Product version v1, named by the decision's `resulting_version_id`. | CR-41 |
| 14 | The Weekly Review shows v0 → test → evidence → decision → v1. | A cached pack whose claims link to the records of steps 5–13. | CR-48, CR-50 |
| 15 | The Deck Builder proposes changes to the relevant slides only. | Slide patch proposals with evidence refs, for the affected slides only. | CR-56, CR-57 |

Scripted run: `node e2e/classroom/cr-e2e.mjs` on the dev host (the name is a proposal; `cr-e2e` fixes it). Steps 7–8 use a second browser context in Playwright mobile emulation at 390 px, so their evidence class is synthetic. The script prints one line per step with the record ID it read.

Live run, real-phone step (steps 6–8):

- Device: any phone the tester holds, with no HypeProof app and no login. Record the phone model, OS version and browser version.
- Network: the phone uses mobile data, not the Mac's Wi-Fi, so a link that only works on the local network cannot pass.
- Opening: scan the QR code shown in Studio with the phone's camera app and open the link it offers. If scanning fails, record why and type the share URL instead; the QR half of CR-18 is then FAIL or NOT RUN, not PASS.
- Timing: measure from the publish action in Studio to first render on the phone (CR-20) and from the publish action to the published version being ready (CR-64).
- Task: the phone user completes the kiosk task once (choose a menu item, pick an option, reach the order screen). Nothing typed on the phone is expected to be kept unless the experiment declared it (CR-67).
- Evidence file (`docs/testing/curriculum-runtime-<date>-evidence.md`): Studio commit and build, Mac model and macOS version, phone model / OS / browser, network, both timings, the participant session ID and pseudonym as Studio recorded them, phone screenshots of the first render and of the final screen, the result of each of the fifteen steps with its evidence class, and every step NOT RUN with its reason.

## Coverage

One line per requirement. It must equal the union of the Targets column above; the registry trace test fails otherwise.

| Requirement | Verified by |
|---|---|
| CR-01 | CR-T01 |
| CR-02 | CR-T02 |
| CR-03 | CR-T03 |
| CR-04 | CR-T04 |
| CR-05 | CR-T05, CR-T08 |
| CR-06 | CR-T06 |
| CR-07 | CR-T07 |
| CR-08 | CR-T08 |
| CR-09 | CR-T09 |
| CR-10 | CR-T10 |
| CR-11 | CR-T11 |
| CR-12 | CR-T12 |
| CR-13 | CR-T13 |
| CR-14 | CR-T14 |
| CR-15 | CR-T15 |
| CR-16 | CR-T16 |
| CR-17 | CR-T17 |
| CR-18 | CR-T18 |
| CR-19 | CR-T19 |
| CR-20 | CR-T20 |
| CR-21 | CR-T21 |
| CR-22 | CR-T22 |
| CR-23 | CR-T23 |
| CR-24 | CR-T24 |
| CR-25 | CR-T25 |
| CR-26 | CR-T26 |
| CR-27 | CR-T27 |
| CR-28 | CR-T28 |
| CR-29 | CR-T29 |
| CR-30 | CR-T30, CR-T31 |
| CR-31 | CR-T31 |
| CR-32 | CR-T32 |
| CR-33 | CR-T33 |
| CR-34 | CR-T34 |
| CR-35 | CR-T35 |
| CR-36 | CR-T36 |
| CR-37 | CR-T37 |
| CR-38 | CR-T38 |
| CR-39 | CR-T80 |
| CR-40 | CR-T39 |
| CR-41 | CR-T39 |
| CR-42 | CR-T39 |
| CR-43 | CR-T40 |
| CR-44 | CR-T41 |
| CR-45 | CR-T42 |
| CR-46 | CR-T43 |
| CR-47 | CR-T44 |
| CR-48 | CR-T45 |
| CR-49 | CR-T46 |
| CR-50 | CR-T47 |
| CR-51 | CR-T48 |
| CR-52 | CR-T48 |
| CR-53 | CR-T49 |
| CR-54 | CR-T50 |
| CR-55 | CR-T51 |
| CR-56 | CR-T52 |
| CR-57 | CR-T53 |
| CR-58 | CR-T54 |
| CR-59 | CR-T55 |
| CR-60 | CR-T56 |
| CR-61 | CR-T57 |
| CR-62 | CR-T58 |
| CR-63 | CR-T59 |
| CR-64 | CR-T20 |
| CR-65 | CR-T23, CR-T60 |
| CR-66 | CR-T61 |
| CR-67 | CR-T62 |
| CR-68 | CR-T63 |
| CR-69 | CR-T64 |
| CR-70 | CR-T65 |
| CR-71 | CR-T66 |
| CR-72 | CR-T67 |
| CR-73 | CR-T68 |
| CR-74 | CR-T69 |
| CR-75 | CR-T70 |
| CR-76 | CR-T71 |
| CR-77 | CR-T72 |
| CR-78 | CR-T73 |
| CR-79 | CR-T74 |
| CR-80 | CR-T75 |
| CR-81 | CR-T76 |
| CR-82 | CR-T77 |
| CR-83 | CR-T78 |
| CR-84 | CR-T79 |

## Run status

All rows NOT RUN as of 2026-09-29. The registry trace (`worker/test/cr-traceability.test.mjs`) runs in `worker` `npm test`; its passing means the documents agree with each other, not that any CR row is implemented.
