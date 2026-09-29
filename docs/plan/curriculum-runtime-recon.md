# Curriculum Runtime reconnaissance — architecture map, gap matrix, decisions

Status: active, the `cr-recon` output (CR-01, issue [#1390](https://github.com/jayleekr/hypeproof-studio/issues/1390), epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388)). 2026-09-29. Owner: jayleekr.
Read at: Studio `origin/main` `cc3785260e92315dcc4bc31410b7cc79713f604e`. Upstream pins: `vscodium@59e579274e3a32fbb93bd10b38bfe071da043cce` (the `vscodium-base` submodule pointer), `vscode@1.116.0` (commit `560a9dba96f961efea7b1612916f89e5d5d4d679`, from that commit's `upstream/stable.json`). Probed app: HypeProof Studio 0.1.51 (`d4db90498fce6c337823a4ce73cbe79c5e688b05`), as installed and with the `origin/main` extension injected (§8; the two differ, F8).
Parent: [plan](curriculum-runtime.md) · [requirements CR-01–84](../requirements/curriculum-runtime.md) · [verification CR-T01–T80](../testing/curriculum-runtime.md) · [PRD v1.0](../design/curriculum-runtime-prd-v1.0-2026-09-28.md) §13 Phase 0, §15.

This page is the reconnaissance PRD §13 Phase 0 and §15 Rule 1 ask for. Every map and matrix row names a path and a symbol; `worker/test/cr-recon.test.mjs` (CR-T01) checks that each exists with the symbol outside comments, that the ten areas are present and titled after their PRD items, that every CR row has exactly one verdict, and that the item named for a row cites it in the ledger. A path written `vscode@1.116.0:…` or `vscodium@59e5792…:…` is outside this repository; the test checks it only when `HPS_VSCODE_SRC` (a VS Code checkout whose `HEAD` is 1.116.0) / `HPS_VSCODIUM_SRC` point at a checkout, and otherwise lists it as not checked. A `lab:` path is in hypeprooflab and is checked only with `HPS_LAB`.

Where this page and a later slice disagree, the later slice records the deviation in the [plan](curriculum-runtime.md) and says why; this page is the recon as read on its commit and is not rewritten per slice (editing it reopens `cr-recon`'s completion). That includes a slice renaming or removing a symbol named here: it writes the rename in the plan and leaves this page alone.

How CR-T01 treats such a rename depends on where it runs. The "recorded state" means this page and the test's frozen control inputs (`worker/test/fixtures/cr-recon/frozen-inputs.json`) are byte-identical to the ones `cr-recon`'s completion pins.

- **Before the record lands on `main`.** Until then there is no completion, so the verdict reads the tree it runs on. A rename of any mapped symbol, in any PR, fails worker `npm test`. The record arrives with the first commit of `cr-browser`'s branch (the recording protocol), so this window lasts from this item's merge to `cr-browser`'s merge. A PR that must rename a mapped symbol in that window waits, or the shipping agent lands the record in its own PR first.
- **After the record, in a clone that has the completion's commit.** The verdict reads the page, the ledger, the testing contract and every mapped file at that commit, so a later rename or ledger edit can neither fail it nor reopen `cr-recon`. This tree's divergence from the map is printed as information.
- **After the record, in a clone without that commit.** This is every CI run, because `pr-ci.yml` checks out at depth 1. The verdict is not re-run in CI at all. The pins hold the page and the frozen inputs to what was verified: editing either returns CR-T01 to reading the tree, as before the record.

In every case the negative controls run on the page plus the frozen inputs, and paths and symbols resolve against the page's own entries. The resolver is tested on a temporary directory. No later state of the ledger, the testing contract or a mapped file reaches them, so they cannot turn red because of one.

## 1. Architecture map

### A1 · Embedded browser and webview, upstream VS Code version

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M1.1 | `vscodium@59e579274e3a32fbb93bd10b38bfe071da043cce:upstream/stable.json` | `560a9dba96f961efea7b1612916f89e5d5d4d679` | The pinned VS Code base (`tag` 1.116.0 at that commit). The only Studio-owned VS Code patch at this pin is `patches/user/60-webview-allow-microphone.patch`; nothing patches `browserView`. |
| M1.2 | `extensions/hypeproof-chat/src/vscode.proposed.browser.d.ts` | `startCDPSession` | The `browser` proposed API: `window.openBrowserTab`, `browserTabs`, `activeBrowserTab`, `BrowserTab.startCDPSession()` → a raw CDP message channel. The integrated browser is an Electron WebContentsView in an editor tab. |
| M1.3 | `scripts/apply-product-overrides.sh` | `extensionEnabledApiProposals` | Enables `browser` for `hypeproof.hypeproof-chat` only (product.json). A development extension needs `--enable-proposed-api <id>`. |
| M1.4 | `extensions/hypeproof-chat/src/nativeBrowser.ts` | `openBrowser` | Opens a tab (`openBrowserTab`, `ViewColumn.Beside`). `capturePageContext` attaches a CDP session per call and returns URL, title, JPEG, `innerText`, AX node count. |
| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts` | `CdpSession` | `Target.attachToTarget({flatten:true})` handshake, then every command carries the `sessionId`. Responses are matched by `id`; **events are dropped** (no subscriber). |
| M1.6 | `extensions/hypeproof-chat/src/previewProvider.ts` | `PreviewProvider` | The older srcdoc webview preview (sandboxed iframe, `enableScripts`), still used for single-HTML chat output. |
| M1.7 | `docs/adr/0002-native-browser-via-webcontentsview.md` | `WebContentsView` | Why the native browser replaced the webview iframe for real sites. |
| M1.8 | `extensions/hypeproof-chat/src/nativeBrowser.ts` | `registerPreviewViewport` | `__hp_viewport` width-controlled iframe: the shipped shell ignores CDP emulation (confirmed by the probe, §8). |

### A2 · Upstream browser-agent features inherited, unused or removed

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M2.1 | `vscode@1.116.0:src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts` | `BrowserChatAgentToolsContribution` | Registers open/read/screenshot/navigate/click/drag/hover/type/runPlaywrightCode/handleDialog as `ILanguageModelToolsService` tools **only when `workbench.browser.enableChatTools` is true**; otherwise only the non-agentic open tool. |
| M2.2 | `vscode@1.116.0:src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts` | `workbench.browser.enableChatTools` | Default `false`, experimental. The same file holds "Add Element to Chat" and "Add Console Logs to Chat", which attach to the built-in chat widget (`IChatWidgetService`), not to an extension webview. |
| M2.3 | `vscode@1.116.0:src/vs/platform/browserView/electron-main/browserView.ts` | `getConsoleLogs` | Upstream console capture: a main-process string buffer `[level] message`, cleared on navigation, no source location, no exceptions or network failures, not exposed to extensions. |
| M2.4 | `vscode@1.116.0:src/vs/workbench/contrib/browserView/electron-browser/tools/readBrowserTool.ts` | `IPlaywrightService` | The upstream read tool summarises pages tracked by the Playwright service (pages the built-in agent opened). |
| M2.5 | `vscode@1.116.0:src/vs/platform/browserView/common/cdp/proxy.ts` | `sendCommand` | The CDP proxy behind `startCDPSession`: routes page-session commands without a method allowlist and forwards every non-`Target.*` event, tagged with the session id. |
| M2.6 | `vscodium@59e579274e3a32fbb93bd10b38bfe071da043cce:patches/51-ext-copilot-remove-it.patch` | `compileCopilotExtensionBuildTask` | The built-in chat agent that would consume M2.1 tools is removed in this fork; Studio's coach is the `hypeproof-chat` webview (SDK or proxy runtime). |
| M2.7 | `extensions/hypeproof-chat/src/browserMcp.ts` | `buildHypeproofMcpServer` | Studio's own agent browser tools for the SDK coach: `mcp__hypeproof__browser_{open,screenshot,read,click,type}`, `live_preview_start`. |
| M2.8 | `worker/src/lib/browser-tools.ts` | `BROWSER_TOOLS` | Studio's own tools for the proxy coach (`browser_navigate`, `browser_read`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_back`, `browser_forward`, `browser_dialog`), injected by the worker when `browser_control.enabled`. |

### A3 · HTML artifact creation, serving, reload and persistence

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M3.1 | `extensions/hypeproof-chat/src/chatPanelProvider.ts` | `extractRenderableHtml` | Pulls the HTML fence out of a coach reply; `revealBuilt` writes it to the workspace and reveals it. |
| M3.2 | `extensions/hypeproof-chat/src/liveServer.ts` | `LiveServer` | Serves the workspace root on `http://127.0.0.1:<listen(0)>/`; `currentUrl()` is the only source of the preview origin; a file watcher pushes `reload` over SSE. |
| M3.3 | `extensions/hypeproof-chat/src/liveServerHelpers.ts` | `injectLiveReload` | Injects the SSE client into every served HTML file; `serveStatic` / `resolveWithinRoot` confine paths to the root. The same injection point can carry a page snippet. |
| M3.4 | `extensions/hypeproof-chat/src/previewRecovery.ts` | `recoverLearnerPreview` | Restores a dead preview without touching files (#751). |
| M3.5 | `extensions/hypeproof-chat/src/sessionSpool.ts` | `SessionSpool` | Per-session JSONL spool; each written artifact is snapshotted once by its **single-file** sha256 (`artifact_snapshot`). |
| M3.6 | `worker/src/lib/measurement-core/legacy-observation.ts` | `LEGACY_OBSERVATION_KINDS` | `artifact` observation events carry the sha256 of one file; learning events reference them through `artifact_before` / `artifact_after`. There is no multi-file (file-set) digest anywhere today. |
| M3.7 | `extensions/hypeproof-chat/src/heartbeat.ts` | `buildArtifactChangedEvent` | Liveness signal that an artifact changed (hash only). |

### A4 · Model and provider invocation

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M4.1 | `worker/src/routes/chat.ts` | `chat` | `/v1/chat/completions` (proxy coach), `/v1/profile`, `/v1/health`. Composes the upstream tool array itself (web search, `BROWSER_TOOLS`). |
| M4.2 | `worker/src/routes/messages.ts` | `messages` | `/v1/messages` passthrough for the Agent SDK coach; tools are declared client-side and gated by `canUseTool`. |
| M4.3 | `worker/src/env.ts` | `resolveProvider` | `LLMProvider` = gemini, anthropic, openai, glm; provider keys are Worker secrets (`providerKey`). |
| M4.4 | `worker/src/lib/anthropic.ts` | `callAnthropicResilient` | Same-model retry, deliberately no model fallback. |
| M4.5 | `worker/src/lib/gemini.ts` | `callGeminiResilient` | Retries and then **falls back to `gemini-2.5-flash`**: a model substitution CR-32 forbids on capability calls. |
| M4.6 | `worker/src/lib/translate.ts` | `translate` | OpenAI-shaped request → Anthropic request; system blocks from the profile prompt, contracts and `resolveSkills`. |
| M4.7 | `worker/src/lib/lesson-model-policy.ts` | `modelBinding` | Which model a lesson may use (aliases → ids); the existing "policy" a capability map extends. |
| M4.8 | `extensions/hypeproof-chat/src/proxyClient.ts` | `proxyChat` | Proxy runtime client; the browser tool loop runs in `chatPanelProvider` around it. |
| M4.9 | `extensions/hypeproof-chat/src/sdkCoach.ts` | `runSdkCoach` | Agent SDK runtime; `buildSdkQueryOptions` (sdkCoachHelpers) pins `settingSources: []`. |

### A5 · Server/client credential boundary

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M5.1 | `worker/src/lib/tokens.ts` | `verify` | HMAC-signed student and issuer tokens (`issue`, `issueIssuer`, `TokenPayload`, `IssuerScope`). |
| M5.2 | `worker/src/middleware/signing-secret.ts` | `signingSecretGuard` | Fails closed on token routes when the signing secret is missing or weak. |
| M5.3 | `worker/src/lib/chat-gate.ts` | `gateChatRequest` | Token → session → profile → lesson binding; every student route starts here. |
| M5.4 | `extensions/hypeproof-chat/src/extension.ts` | `TOKEN_KEY` | The student token lives in VS Code SecretStorage; nothing provider-side reaches the client. |
| M5.5 | `extensions/hypeproof-chat/src/sdkCoachHelpers.ts` | `buildSdkGatewayEnv` | The SDK CLI talks to the Worker (`ANTHROPIC_BASE_URL` = worker, `ANTHROPIC_AUTH_TOKEN` = student token) with an isolated config dir (`sdkConfigDirFor`). |
| M5.6 | `worker/src/routes/access.ts` | `access` | Access contracts, seats and budget choice for a token (AB-*). |

### A6 · Project and workspace persistence

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M6.1 | `worker/src/lib/measurement-core/local-record.ts` | `LocalRecord` | `hps-local-record/1`: tasks (with `project`, purpose, curriculum week), linked sessions per host, appended observation batches, interpretations with revisions, reviews, improvements, deletion with a receipt, over an injected `StoragePort`. |
| M6.2 | `extensions/hypeproof-chat/src/localRecordFile.ts` | `FileRecordStorage` | The App-side `StoragePort` (fsync'd files, 0700). No Service-side port exists. |
| M6.3 | `extensions/hypeproof-chat/src/chatPanelProvider.ts` | `persistObservation` | The App's `hps-observation` batch lives in `workspaceState`; the Worker validates and assesses but stores no observation batch (`worker/src/routes/observations.ts`). |
| M6.4 | `worker/src/lib/session-design.ts` | `validateSessionDesign` | `hps-session-design/1`: a versioned JSON document with one validator; the convention new CR records follow. |
| M6.5 | `worker/schema.sql` | `authoring_versions` | D1 is the Service's durable store (`HPS_DB`); immutable versions keyed by id are an existing pattern. |
| M6.6 | `worker/src/lib/storage.ts` | `recordTurn` | Turn bodies to R2 `HPS_TRACES` only when `analytics.log_user_messages` is true. |
| M6.7 | `worker/src/routes/classroom-collect.ts` | `classroomCollectApp` | Consent-gated upload of a learner's session record to R2 (`classroom-snapshots/…`) with a D1 index; the one Service-side copy of learner evidence today. |

### A7 · Publish and preview infrastructure

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M7.1 | `extensions/hypeproof-chat/src/galleryPublish.ts` | `publishWorld` | One single-file HTML → Lab `POST /api/gallery/publish` with the student token; gated by `galleryPublishAllowed` (`publishing.strategy` = `hypeproof_gallery`). |
| M7.2 | `lab:web/src/app/api/gallery/publish/route.ts` | `verifyStudentToken` | Lab verifies the token with the Worker, stores the HTML in private Supabase storage, one DB row per upload; never overwrites. |
| M7.3 | `lab:web/src/app/api/gallery/raw/[id]/route.ts` | `SANDBOX_CSP` | Served only inside a sandboxed iframe with `connect-src 'none'` (opaque origin, no storage, no network). |
| M7.4 | `worker/src/routes/classroom-delivery.ts` | `classroomReportLinks` | Expiring, revocable report links (`classroom_report_links`) with their own CSP page renderer: the link-lifecycle pattern to reuse. |
| M7.5 | `worker/src/lib/classroom-report-html.ts` | `REPORT_PAGE_CSP` | A Service-rendered HTML page with a locked CSP. |
| M7.6 | `worker/src/skills/index.ts` | `publish-homepage` | The coach's current "publish" skill (`worker/src/skills/publish-homepage.md`: GitHub Pages or a Cloudflare quick tunnel), which asks students to hold external accounts. |

### A8 · Tests, Playwright, screenshot, console and debug integration

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M8.1 | `.github/workflows/pr-ci.yml` | `extension-test` | CI runs worker `npm test` + four D1 suites, extension smokes (with webview deps), chalk, measurement, typechecks. No Electron e2e in CI. |
| M8.2 | `worker/test/harness/miniflare.mjs` | `createMiniflare` | Local workerd + D1 for `test:*:d1` suites; `--experimental-sqlite` suites run inside `npm test`. |
| M8.3 | `extensions/hypeproof-chat/test/cdp-session.smoke.mjs` | `CdpSession` | Pure smoke over a mock CDP channel (the pattern for new CDP code). |
| M8.4 | `e2e/fixtures/app.ts` | `launchApp` | Playwright Electron launch with quiet mode, seeded token/history, `hostResolverRules`; `ctx.app.evaluate` reaches the main process. |
| M8.5 | `e2e/fixtures/global-setup.ts` | `HPS_APP_PATH` | Drives any app copy; preflight needs a local Worker and `/tmp/hps-token.txt` (`scripts/dev-stack.sh`). |
| M8.6 | `e2e/classroom/mac-devhost.mjs` | `reinject` | Real-Mac host: copy the app, inject the current build, run against a local Service. |
| M8.7 | `e2e/curriculum-runtime/cdp-probe.mjs` | `HPS_CR_PROBE_NEGATIVE` | This recon's probe (§8): a test-only development extension drives the `browser` API and records CDP events, with planted answers, a negative-control mode and a controlled tab layout (`HPS_CR_PROBE_LAYOUT`). |

### A9 · Skill, plugin and custom-mode abstractions

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M9.1 | `worker/src/skills/index.ts` | `resolveSkills` | Worker-bundled Markdown skills declared on a profile (`skills: [...]`), appended to the cached system prefix. Unknown names are dropped with `console.warn`; no contract, schema or version. |
| M9.2 | `worker/src/profiles/types.ts` | `sdk_tools` | Per-profile tool grants (read/write/shell/subagents/browser); `browser_control`, `input.page_context`, `observation`, `publishing`, `skills` are all profile fields served by `/v1/profile`. |
| M9.3 | `worker/src/lib/lesson-feature-policy.ts` | `FEATURE_KEYS` | A frozen lesson can only narrow features; enforced server-side on the proxy route, client-side on the SDK route. |
| M9.4 | `worker/src/lib/lesson-help-mode.ts` | `resolveHelpMode` | The custom-mode abstraction: demonstrate / hint / co_edit / independent per step. |
| M9.5 | `extensions/hypeproof-chat/src/sdkCoachHelpers.ts` | `settingSources` | The SDK coach never reads workspace settings, so workspace files cannot add allow-rules. |
| M9.6 | `extensions/hypeproof-chat/src/sdkCoachHelpers.ts` | `buildSubagentDefinitions` | The two built-in subagents (code reviewer, researcher) when `sdk_tools.subagents` is granted. |
| M9.7 | `worker/src/prompts/_browser-control-contract-sdk.md` | `browser_read` | Prompt contracts appended per runtime (browser, preview, gallery publish). |

### A10 · Telemetry and usage accounting

| Entry | Path | Symbol | Role and data flow |
|---|---|---|---|
| M10.1 | `worker/src/lib/analytics.ts` | `persistUsage` | One `usage_log` row per upstream call (cohort, user, model, tokens, status); `logChat` writes Analytics Engine (`HPS_ANALYTICS`). |
| M10.2 | `worker/src/lib/model-usage.ts` | `reserveModelRequest` | `model_usage_requests`: atomic per-user reservation (MU-03). |
| M10.3 | `worker/src/lib/budget-admission.ts` | `reserveBudgetAttempt` | Budget admission before dispatch (AB-06); `budgetErrorResponse` for typed refusals. |
| M10.4 | `worker/src/lib/usage-costs.ts` | `registerUsageAttempt` | Priced attempts and cost evidence (AB-07/08). |
| M10.5 | `worker/schema.sql` | `usage_log` | The usage ledgers CR-34 extends: `usage_log`, `model_usage_requests`, `usage_attempt_costs`, the budget tables. |
| M10.6 | `worker/src/cron/heartbeat.ts` | `runHeartbeat` | Service health heartbeat; the App side is `startHeartbeat` (heartbeat.ts). |
| M10.7 | `worker/src/routes/trace.ts` | `trace` | Client trace ingest; `logs` (routes/logs.ts) takes session log uploads. |
| M10.8 | `vscodium@59e579274e3a32fbb93bd10b38bfe071da043cce:patches/00-telemetry-disable.patch` | `TelemetryConfiguration.OFF` | VS Code telemetry is off in the fork; Studio's own accounting is the Service ledgers above. |

## 2. Decisions

### R1 · How the Experiment Browser observes and acts

**Decision.** Extend the extension's CDP path (`CdpSession` + `BrowserControl` over `BrowserTab.startCDPSession`). Do not drive the upstream `browserView` agent tools and do not patch `vscodium-base`. The adapter boundary is `BrowserControl.execute(call) → BrowserToolResult`: plain data in and out, reached by the proxy loop (`chatPanelProvider`) and by the SDK MCP server (`BrowserMcpHost.inspect`), later exposable as the `browser.agent` capability without change (CR-03).

Why, with evidence (§8): the probe opened a page through the same API and received `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Network.responseReceived` (404) and `Network.loadingFailed` events on the flat session, attributed them to the right document across two reloads, performed hover, scroll, select and reload, and ran an element pick (F8 qualifies wheel scroll and the pick for the `origin/main` build). The upstream tools are registered only behind `workbench.browser.enableChatTools` (default off; the probe saw only `open_browser_page`), feed the removed built-in chat agent, keep console logs as untyped strings in the main process, and would add a second, unscoped browser agent next to the coach's `canUseTool` gate. Keep `workbench.browser.enableChatTools` off.

What `cr-browser` builds on this path: `CdpSession` gains an event subscription (it drops events today); console, exception and failed-request records are buffered per document; attribution rules are in the `cr-browser` notes (§7).

### R2 · How element context reaches the hypeproof-chat coach

**Decision.** Element picking uses the CDP inspector (`Overlay.setInspectMode` `searchForNode` → `Overlay.inspectNodeRequested`) on the pinned preview tab. The payload is built from `backendNodeId`: the AX `[ref=eN]` the snapshot gives the same node, `DOM.getOuterHTML` (bounded), a computed-style subset (`CSS.getComputedStyleForNode`), an element crop (`Page.captureScreenshot` with the border-box clip), and a source mapping (the page URL path resolved with `resolveWithinRoot`, then the element located by id or text in that file; otherwise `"unmapped"`). It rides the existing page-context conduit (`pendingPageImage` in `chatPanelProvider` for the image, the user text block for the rest), shown to the student as a removable attachment before sending. No new transport.

Evidence (§8), on a browser tab that was the visible (active) tab of its editor group:

- **Stock 0.1.51 extension, unlocked:** 13 of 13 runs. The pick returned the same node as the AX ref, the outer HTML and the planted background colour. Inspect mode did not trigger the page's own click handler. A PNG crop came back, with 26–40 ms of local processing including the crop. That was at 714 px beside another editor and at 1434 px full width (n=1 per run, not a CR-60 timing).
- **Earlier probe revisions, recorded as runs of an app copy with the `origin/main` extension injected:** the same, at 714 px unlocked with a crop in 41–54 ms (the version before the overlay step), and at 414 px locked without a crop (the first committed revision). The crop needs a composited frame (F7). The 714 px unlocked runs cannot be reproduced with that build today (F8).
- **`origin/main` extension injected, unlocked** (the build `cr-browser` extends): the pick held in 8 of 10 runs and the crop in 6 of 10. When it came, the crop took 2.0–3.0 s (F8).

R2 therefore stands on the stock build. `cr-browser` must establish it on its own build before relying on it.

Condition: the tab must be the visible tab of its group. On a covered tab, `document.visibilityState` still reads `visible`, and picking is unreliable in two ways:

- **Covered right after opening.** The stock extension opens a "HypeProof Studio" editor at startup, after the first probe revision's tab, and so covered it. That tab lost the first inspect-mode click and answered later ones (6 of 6 diagnostic runs, locked and unlocked). This is what failed that revision on the stock app.
- **Opened with `background: true` and never shown.** No click was answered (0 of 2 in each of 21 runs).

A tab that was shown and then covered did answer the pick (19 of 21 runs; the 2 misses were runs where the visible-tab pick failed too, F8). It produced no screenshot in 18 of 21 runs.

A student can only click a tab they see. A pick that Studio starts itself (a command, or a coach request while the tab may be covered) must first reveal the pinned tab. It must judge coverage from the editor's tab state, not from page visibility. `cr-browser` owes that check in both the beside and the full-width layout (§7).

### R3 · The CR switch (CR-02)

**Decision.** One profile field, served like `browser_control`: `curriculum_runtime: { enabled: boolean }` on `Profile` (`worker/src/profiles/types.ts`), absent = off, served by `/v1/profile` (`chat.ts`), read into `ResolvedProfile` (`protocol.ts`) and passed through `accessProfile` (`accessClient.ts`). The extension mirrors it with `setContext("hypeproof-chat.curriculumRuntimeEnabled", …)` next to the existing `hypeproof-chat.pageContextEnabled`, gates every CR command in `package.json` with `enablement` and `menus.commandPalette` `when`, and re-checks the served profile inside each command handler (a command can be executed without its menu). New MCP/proxy browser tools are added to `MCP_BROWSER_TOOLS` / `BROWSER_TOOLS` only when the switch is on. Every CR Worker route checks the served profile and, when off, answers exactly as `app.notFound` in `worker/src/index.ts` does: 404 with `makeErrorBody(c, "not_found", "endpoint not found", { path })`. Public participant routes resolve their link's project to its cohort profile and answer the same 404 when that profile has the switch off. Flag name: **`curriculum_runtime.enabled`**. No setting, environment variable or build flag.

### R4 · Artifact version and file-set digest (CR-10, CR-13, CR-17, CR-42, CR-77)

**Decision.** An artifact version is the sha256 of the canonical JSON of the sorted list `[{path, sha256, bytes}]` of the version's **published file set**, computed with `canonicalJson` / `digestOf` from `local-record.ts`. The digest covers exactly that set, so the version that is verified is the version that is served.

The published file set is not the workspace. The live-server root is `workspaceFolders[0]` (`extension.ts`, `startLivePreview` in `chatPanelProvider.ts`), the student's whole workspace. It can hold `.env` and `.npmrc`, keys pasted into a script, and unrelated personal files, and a version is public once published (§6). So the set is:

- the entry HTML and every file it reaches through static references (`src`, `href`, CSS `url()`, `import`), each resolved with `resolveWithinRoot`;
- plus files the student adds to an explicit manifest in the publish panel, for references that cannot be resolved statically. The panel lists the whole set before anything is uploaded.
- It never includes a dot-file or dot-directory, `node_modules`, or anything outside the root, whatever the manifest says.

`resolveWithinRoot` (`liveServerHelpers.ts`) is lexical only: `path.resolve` and a prefix check, with no `realpath` or `lstat`. A symlink inside the workspace therefore resolves "within the root" while its content lives outside it, and the SDK coach, which has a shell tool, can create one. So every file of the set is also checked on disk: a symlink (`lstat`) refuses the publish, and so does a file whose `realpath` leaves the root's `realpath`. The check runs when the set is built and again just before each file is read for upload.

Before upload, every file passes a publish scan for secrets, and the set passes a per-file and per-set size cap (values are policy). A hit or an oversize file refuses the publish and names the file; nothing is uploaded. The Worker repeats the same rules on receipt (§6).

The MC-30 patterns (`SECRET_PATTERNS` in `local-record.ts`) are not enough for this scan. They cover private keys, `sk-ant-`, `sk-` / `sk-proj-`, GitHub tokens, AWS access keys and bearer headers. They miss two of the four `LLMProvider` key formats (`worker/src/env.ts`): Gemini (`AIza` followed by 35 characters, the key Google AI Studio hands a student) and GLM (an id and a secret joined by a dot). They also miss Supabase service keys (a JWT whose payload role is `service_role`, and `sb_secret_` keys). The publish scan therefore uses its own list, a superset of `SECRET_PATTERNS` that has at least one pattern for every `LLMProvider` value and for Supabase service keys. `cr-publish` pins each pattern against a sample of the real format. If it adds these patterns to `SECRET_PATTERNS` itself, that is an MC-30 change and the PR says so.

Each file's sha256 is the one `artifact` observation events already carry, so AE-37's per-file binding keeps working. The version id is new because no multi-file digest exists (M3.6). This corrects the wording "the artifact file-set digest that AE-37 (#557) uses", which was in the `cr-browser` work item's `design_delta` (ledger and `requirements-activation.md`), not in the plan: AE-37 binds single files. This change fixes that packet.

### R5 · Venture Memory storage (CR-35, CR-39)

**Decision.** Venture Memory is Service-side, in D1 (`HPS_DB`), because a director traverses it from another device (CR-37) and opens packs there (CR-50). Each entity (Project, Hypothesis, Experiment, Decision, ProductVersion, DeckSlide, Stakeholder, Metric, WeeklyReview) is a versioned JSON document with one validator in one module (the `hps-session-design/1` convention), stored in new D1 tables through a migration, holding structure and references only: evidence and observations are referenced by event and batch id into the measurement-core record (R6), never copied (SX-48). `cr-publish` creates the first rows (Project, Hypothesis, Experiment, CR-39); `cr-memory` extends the same tables. Applying the migration in production is Jay's decision (§9).

**Ownership.** Every Venture Memory record and every test version belongs to one Project, and the Project says who may act on it. Today's student token names a cohort (`c`) and a student (`u`); the cohort roster (`getRoster`, `lib/kv.ts`) is a flat list of students with no team, so the team is new data. The Project record holds `cohort_id`, `profile_id` and `members`, the student ids of its team; each member must be on that cohort's roster. A Project created from a student token starts with that student as its only member. Members are then set by an issuer scoped to the Project's cohort, the director who forms the teams (the same `IssuerScope` CR-37 uses); students cannot add members.

Every route that takes a student token resolves its target (version, experiment, link, session, draft) to its Project. It serves the request only when the token's `c` is the Project's cohort and its `u` is a member. Otherwise it answers 404, the same answer as for an id that does not exist, so a guessed id reveals nothing. A director issuer reads a Project only when its `IssuerScope` covers the Project's cohort (CR-37). This covers reading participant evidence, revoking links, deleting experiments and sessions, writing notes and drafts, and uploading versions (§6).

### R6 · Where participant evidence lives (CR-23–28, CR-65–69, CR-72, CR-74)

**Decision.** Participant evidence is `hps-observation/2` events validated by the one validator (`validateObservation`) inside the measurement-core `LocalRecord`, instantiated on the Service host with a `StoragePort` over the existing R2 binding `HPS_TRACES` (prefix `curriculum/<cohort>/<project>/`); no new KV namespace, no evidence table, no validator copy, no scorer. One Experiment ↔ one `LocalRecord` task (same id; `project` = project id). Participant sessions are `linkSession(task, {host: "published", session_id})`; automatic events are appended batches whose `scope` is the experiment; manual records use the existing `external_feedback_received` kind (source state and `provenance {who, when, where}` are already required); evidence drafts are `hps-interpretation/1` saved with `saveInterpretation` (references must resolve, MC-15) and revised with `validateReinterpretation` (MC-22); accept/edit/reject is `reviewFinding`; deleting an experiment is `deleteTask` with its receipt (MC-31). Deleting one participant session is new code: `LocalRecord` has no per-session erase (`deleteTask` is its only deletion), and CR-69 asks for both. The session erase removes that session's `sessions/published/<id>` key, every event recorded in that session, and the interpretations that cite those events. Like `deleteTask`, it writes a keys-only tombstone so later reinterpretation refuses the deleted evidence, and it returns the same `removed` / `not_covered` report. The App reads this record through Worker routes; it is not copied into the App's `workspaceState`. `cr-evidence` confirms the port's atomic `ifAbsent` write on R2 before relying on it and records any deviation in the plan.

The record was built for one writer on the App. On the Service many participants write to one experiment at once, and two of its paths do not survive that:

- **Lost links.** `linkSession` writes the per-session key `sessions/<host>/<id>` atomically (`ifAbsent`). It then calls `saveTask`, an unguarded read-modify-write of `tasks/<id>` (`#write(…, false)`). Concurrent links lose sessions from `task.sessions` even when `ifAbsent` is atomic. A scratch reproduction, with an async port whose `ifAbsent` is atomic, linked 20 sessions concurrently and kept 1. CR-72's return counts read those sessions.
- **Whole-store scans.** A port without `usageBytes` makes `usage()` read every key on every write, so each participant event costs reads in proportion to the whole store (47 reads for one link on a 22-key store in the same reproduction).

The Service host therefore needs two things:

1. **One writer per experiment.** Either a Durable Object per experiment that owns its `LocalRecord`, or a compare-and-swap write on `tasks/<id>` (an R2 conditional put on the etag, or a D1 version column) with a bounded retry. Alternatively, derive an experiment's linked sessions from the atomic `sessions/published/*` keys (`taskForSession`) instead of the `task.sessions` array.
2. **A cheap usage count.** A port that implements `usageBytes` from a maintained counter instead of a scan.

`cr-evidence` picks the option, records it in the plan, and adds the concurrent-link negative control to its tests (CR-T67).

### R7 · Skill loader (CR-43–47)

**Decision.** Extend the Worker skill registry (`worker/src/skills/index.ts`), which profiles already declare, instead of reading `.hypeproof/skills/` from the student workspace. A curriculum skill is a bundled pair `<name>.md` + `<name>.contract.json` (the eight PRD §6 contract fields, `skill@version`), validated at load; a missing field refuses the skill (today's `resolveSkills` only warns, which CR-43 forbids for curriculum skills). The curriculum (`v5`) is a bundled data file next to it (SX-56). The SDK coach keeps `settingSources: []`; nothing in the workspace is a skill source, so a workspace file cannot widen tools. Skill output validation and write-back run on the Worker.

### R8 · AI Gateway (CR-29–34, CR-80, CR-83, CR-84)

**Decision.** Adapt the existing stack: a `/v1/app/*` route family beside `chat.ts`, app-scoped tokens (below) bound to project + published origin, admission through `reserveBudgetAttempt` and `reserveModelRequest` (keys widened to app token and participant session), ledgers `usage_log` / `model_usage_requests` / budget tables with the eight attribution columns (unknown stays `unknown`), a capability → model policy table that extends `modelBinding`, and adapters over the single-call `callAnthropic` / `callOpenAI` / `callGemini` plus a mock.

**App tokens are not student tokens.** They are embedded in public pages, so any participant can read one. `verify` (tokens.ts) signs over the role but does not check its value, and no student route accepts only students. The inventory below lists every caller of `verify(` and `gateChatRequest(` in `worker/src` at the recorded commit (`grep -rn -E '\bverify\(|gateChatRequest\('`), and how each treats the role:

| Caller | Routes | Role handling today |
|---|---|---|
| `gateChatRequest` (`lib/chat-gate.ts`) | `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/observations/{context,validate,assess}`, `/v1/request-settings/:turn`, `/v1/activity` (chat.ts), and the account and native-trial paths inside `/v1/profile`; `nativeTrialBudget` (`middleware/native-trial-budget.ts`) calls it for native-trial tokens | issuer refused, anything else a student |
| `authenticateToken` (`routes/chat.ts`) | `/v1/profile`, `/v1/lesson-turns/:turn`, `/v1/lesson-turns/:turn/close`; through `/v1/profile`, the Lab's `verifyStudentToken` (gallery publish, log mirror) | issuer refused, anything else a student |
| `routes/access.ts` | `/v1/access`, `/v1/access/requests` | issuer refused |
| `routes/logs.ts` | `PUT /v1/logs/:sessionId/:filename` | issuer refused |
| `routes/classroom.ts` (`classroomStudent`) | `/v1/classroom/help-recipient`, `/v1/classroom/shares*` | issuer refused |
| `routes/rehearsal-report.ts` | `/v1/classroom/rehearsal/report` | issuer refused; also needs rehearsal claims |
| `lib/lesson-binding-activate.ts` | `learner_token` in the body of `/v1/classroom/ops/lesson-binding` (after the ops credential) | issuer refused |
| `routes/trace.ts` | `/v1/trace/event` | **no role check at all** (F9) |
| `routes/report.ts` | `/v1/report` | optional token, any role; only a hash of its `jti` is stored |
| `lib/instructor-auth.ts`, `routes/admin.ts` | issuer and admin paths | require `role === "issuer"` |

So a token from today's `issue` with any role other than `issuer` is a full student credential on every student route, and `/v1/trace/event` accepts any role. An app token that carried the student's `u`, `c` and `p` would pass trace's profile, session and roster gates and could write `trialStart` and heartbeat events as that student to the instructor board. The decision:

- An app token carries a distinct role (`app`) and its project and origin binding.
- In the same change, the student-route check becomes one helper in `tokens.ts` (for example `requireStudent(payload)`: `role === undefined || role === "student"`, else a typed `wrong_role` refusal). Every student route in the table calls it right after `verify`, `/v1/trace/event` included. The issuer deny-lists go away, and so does trace's missing check.
- `/v1/report` stays open to any token or none, because it stores only a `jti` hash. It is listed so that the inventory stays complete.
- CR-T29 keeps the inventory mechanical. A source check lists every `verify(` call site in `worker/src` outside `tokens.ts`. Each one must be followed by the helper, or be on a named issuer, admin or optional-auth path (`instructor-auth.ts`, `admin.ts`, `report.ts`). A new route that verifies a token without the helper fails it.
- A separate signing secret or token prefix for app tokens is defense in depth that `cr-gateway` may add. It is not a substitute for the allow-list.

**Retry.** `callAnthropicResilient` is not reused as-is. It makes up to three upstream calls (`MAX_ATTEMPTS = 3`) under one admission and one metering, which is why `chat.ts` calls plain `callAnthropic` whenever budget admission (`executionAccess`) or model practice (`multi`) is active. A capability retry is a loop around the single-call adapter in which each attempt is admitted (`reserveBudgetAttempt`) and metered (`registerUsageAttempt`) on its own. It is bounded by policy and happens only before any output reached the caller. `callGeminiResilient`'s fallback to `gemini-2.5-flash` is not used on capability calls (CR-32).

MU-02 says one upstream call per user request. Whether a policy-bounded, per-attempt-admitted retry of an app request fits that is Jay's decision (§9). Until he decides, the policy bound defaults to 0 retries, which is MU-02 as written. CR-T32 exercises the mechanism with an explicit bound of 1.

### R9 · Weekly Review Pack (CR-48–53, CR-62)

**Decision.** Follow `classroom-report.ts` (`validateDraft`, `composeReport`, `draftKey` in R2), `classroom-evaluator.ts` (`evaluateInput`) and `classroom-report-html.ts` (`renderReportHtml`, `REPORT_PAGE_CSP`): a per-team pack draft keyed by an input digest (Venture Memory revisions + measurement-core record digests), sections regenerated independently, opened from storage with no model call. Director authority reuses issuer tokens and `IssuerScope` (SX-38).

### R10 · HTML deck (CR-54–58, CR-63)

**Decision.** Slide state is eight DeckSlide documents in Venture Memory (R5); rendering is a pure function to HTML files written under a deck folder that `LiveServer` serves in the Experiment Browser, so editing rendered HTML never feeds back into state. Patch proposals are Venture Memory documents with `evidence_refs`; no presentation editor.

### R11 · Automation indicator (CR-68)

**Decision.** Two layers: the existing tool-log line in the chat panel (`browserToolLogLine`, `running` → `done`) and a page-level outline drawn by the CDP inspector overlay (`Overlay.highlightRect` around the viewport) for the duration of each agent or runner step, cleared with `Overlay.hideHighlight`. The probe showed the overlay leaves the page's DOM and AX tree unchanged (the verdicts read those). It does reach CDP screenshots. With the screen unlocked, a `Page.captureScreenshot` taken while the outline was drawn differed from one taken just before it in 16 of 16 runs where both came back (§8). So the runner clears the outline before an evidence screenshot and redraws it after. `cr-browser` owes that check and the Playwright check that a student sees the indicator (CR-T63).

## 3. PRD §15 Phase 1 MVP: reuse or new

| MVP requirement (PRD §15 Rule 2) | Reuse | New code |
|---|---|---|
| Current preview URL / route | `LiveServer.currentUrl`, `BrowserTab.url` | route = URL path relative to the live-server root |
| Semantic DOM / accessibility snapshot | `buildAxSnapshot`, `BrowserControl.read` | document generation (main-frame `loaderId`) and viewport in the same result |
| Screenshot | `Page.captureScreenshot` in `BrowserControl` | element crop (R2) |
| Console / runtime errors | — (`CdpSession` drops events) | event subscription, per-document buffer, step index |
| click / type | `BrowserControl.execute` | — |
| scroll / hover / select / reload | — | four actions (probe-verified CDP calls) |
| Element → AI | page-context conduit (`pendingPageImage`) | inspect-mode pick and payload (R2) |
| "Test my product" action | — | command + webview entry behind R3 |
| 1–5 observable criteria | `criterion_set` learning events, SX-14 actor rules | count limits, confirmation of AI proposals |
| Execute criteria against the app | `BrowserControl.execute` | runner (DOM/AX first) |
| Persisted report against the version | `test_observed` / `retest_confirmed`, artifact refs | `hps-verification/1` view, file-set digest (R4) |

## 4. Gap matrix

One row per CR requirement. Verdict: **reuse** (existing code satisfies it once wired behind the switch), **extend** (existing code is changed), **new** (new code attached at the named path). The item is the work item that establishes the row; shared rows are re-checked by later items as the [plan](curriculum-runtime.md) says.

| CR | Verdict | Relies on | Symbol | Item | Note |
|---|---|---|---|---|---|
| CR-01 | new | `worker/test/cr-traceability.test.mjs` | `parseRequirements` | `cr-recon` | This page; CR-T01 is `worker/test/cr-recon.test.mjs`. |
| CR-02 | extend | `extensions/hypeproof-chat/src/chatPanelProvider.ts` | `pageContextEnabled` | `cr-browser` | R3; each later item adds its surfaces to the CR-T02 inventory. |
| CR-03 | extend | `extensions/hypeproof-chat/src/browserMcp.ts` | `BrowserMcpHost` | `cr-browser` | Plain-data results already; add the provider-import scan. |
| CR-04 | extend | `extensions/hypeproof-chat/src/browserControl.ts` | `read` | `cr-browser` | One observation: URL, route, snapshot, screenshot, viewport, document generation. |
| CR-05 | new | `extensions/hypeproof-chat/src/cdpSession.ts` | `onDidReceiveMessage` | `cr-browser` | Events are dropped today; probe-proven delivery. |
| CR-06 | extend | `extensions/hypeproof-chat/src/browserControl.ts` | `execute` | `cr-browser` | select, scroll, hover, reload. |
| CR-07 | extend | `extensions/hypeproof-chat/src/browserControl.ts` | `execute` | `cr-browser` | Needs the kiosk-practice fixture. |
| CR-08 | new | `extensions/hypeproof-chat/src/cdpSession.ts` | `CdpSession` | `cr-browser` | Records carry the step index. |
| CR-09 | new | `extensions/hypeproof-chat/src/nativeBrowser.ts` | `capturePageContext` | `cr-browser` | R2. |
| CR-10 | extend | `worker/src/lib/measurement-core/learning-events.ts` | `ARTIFACT_REF_KEYS` | `cr-browser` | R4 file-set digest. |
| CR-11 | extend | `extensions/hypeproof-chat/src/browserControlHelpers.ts` | `safeNavigateUrl` | `cr-browser` | Today any http(s)/file URL passes; add origin scope. |
| CR-12 | new | `worker/src/lib/measurement-core/learning-events.ts` | `criterion_set` | `cr-verify` | 1–5 limit and AI-proposal confirmation are new. |
| CR-13 | new | `worker/src/lib/measurement-core/learning-events.ts` | `test_observed` | `cr-verify` | `hps-verification/1` is a view over events. |
| CR-14 | extend | `worker/src/lib/measurement-core/learning-events.ts` | `gates` | `cr-verify` | Viewport is fixed by `__hp_viewport`, not CDP emulation (§8). |
| CR-15 | new | `worker/src/lib/measurement-core/interpretation.ts` | `EvidenceRef` | `cr-verify` | Verdict cites step + observation. |
| CR-16 | extend | `worker/src/lib/measurement-core/learning-events.ts` | `change_requested` | `cr-verify` | Fix request = `change_requested` with refs. |
| CR-81 | new | `extensions/hypeproof-chat/src/learningStateHelpers.ts` | `learningState` | `cr-verify` | "verified" derived from an all-pass report on the exact version. |
| CR-61 | new | `e2e/classroom/mac-devhost.mjs` | `reinject` | `cr-verify` | Real-Mac timing. |
| CR-17 | new | `extensions/hypeproof-chat/src/galleryPublish.ts` | `publishWorld` | `cr-publish` | §6; the one publish module, Service-hosted test versions; only R4's published file set (no symlink, nothing whose real path leaves the root), scanned for every `LLMProvider` key format and capped before upload; uploads only into a Project the token's student is a member of (R5). |
| CR-18 | new | `worker/src/index.ts` | `app.route` | `cr-publish` | Public share route on the test origin; QR generated client-side. |
| CR-19 | new | `worker/src/routes/classroom-delivery.ts` | `classroomReportLinks` | `cr-publish` | Link lifecycle pattern; 410, `no-store`. |
| CR-20 | new | `e2e/fixtures/app.ts` | `launchApp` | `cr-publish` | Timing on real Mac + phone. |
| CR-21 | new | `worker/src/lib/measurement-core/legacy-observation.ts` | `ObservationBatch` | `cr-publish` | Session record = batch scope + context. |
| CR-22 | new | `worker/schema.sql` | `authoring_versions` | `cr-publish` | Experiments pin a version id. |
| CR-39 | new | `worker/src/lib/session-design.ts` | `validateSessionDesign` | `cr-publish` | R5 record convention. |
| CR-64 | new | `extensions/hypeproof-chat/src/galleryPublish.ts` | `publishWorld` | `cr-publish` | Timing target. |
| CR-65 | new | `extensions/hypeproof-chat/src/liveServerHelpers.ts` | `injectLiveReload` | `cr-publish` | Snippet injection point; pseudonym in the test origin's storage. |
| CR-66 | new | `worker/src/lib/classroom-report-html.ts` | `REPORT_PAGE_CSP` | `cr-publish` | `Permissions-Policy` + CSP on served test versions. |
| CR-73 | new | `worker/src/routes/classroom-delivery.ts` | `classroomReportLinks` | `cr-publish` | Several labelled links per experiment. |
| CR-23 | extend | `worker/src/lib/measurement-core/legacy-observation.ts` | `validateObservation` | `cr-evidence` | R6. |
| CR-24 | extend | `worker/src/lib/measurement-core/learning-events.ts` | `external_feedback_received` | `cr-evidence` | Provenance and source state exist; the five record kinds need a field of their own (`source_kind`'s six values do not map one to one). |
| CR-25 | extend | `worker/src/lib/measurement-core/interpretation.ts` | `validateInterpretation` | `cr-evidence` | References must resolve. |
| CR-26 | extend | `worker/src/lib/measurement-core/interpretation.ts` | `validateReinterpretation` | `cr-evidence` | Revisions exist (MC-22); add the raw-hash check. |
| CR-27 | extend | `extensions/hypeproof-chat/webview-ui/src/EvidenceDrawer.tsx` | `EvidenceDrawer` | `cr-evidence` | Source opening for participant evidence. |
| CR-28 | extend | `worker/src/lib/classroom-report-input.ts` | `readReportInput` | `cr-evidence` | Review input from structured evidence. |
| CR-67 | new | `worker/src/lib/measurement-core/local-record.ts` | `redactDeep` | `cr-evidence` | Interaction facts, not content. |
| CR-69 | extend | `worker/src/lib/measurement-core/local-record.ts` | `deleteTask` | `cr-evidence` | Experiment deletion and its report exist (`deleteTask`, MC-31); the per-session erase is new code (R6). |
| CR-70 | extend | `worker/src/lib/budgets.ts` | `BudgetMutationGuard` | `cr-evidence` | Admin authority pattern (AB-04). |
| CR-72 | new | `worker/src/lib/measurement-core/local-record.ts` | `linkSession` | `cr-evidence` | Return counts from linked sessions; concurrent links need one writer per experiment (R6). |
| CR-74 | new | `worker/src/lib/measurement-core/legacy-observation.ts` | `ObservationEvent` | `cr-evidence` | One variant per record. |
| CR-35 | new | `worker/schema.sql` | `authoring_versions` | `cr-memory` | R5; new tables through a migration, following the immutable versioned-row pattern. |
| CR-36 | new | `worker/src/lib/session-design.ts` | `SessionDesign` | `cr-memory` | Reopen from records only. |
| CR-37 | extend | `worker/src/lib/tokens.ts` | `IssuerScope` | `cr-memory` | Director scope = issuer scope (SX-38). |
| CR-38 | new | `worker/src/lib/measurement-core/learning-events.ts` | `decision_revised` | `cr-memory` | Decision links evidence and slides. |
| CR-40 | extend | `worker/src/lib/measurement-core/interpretation.ts` | `EvidenceRef` | `cr-memory` | Evidence item contract. |
| CR-41 | new | `worker/src/lib/session-design.ts` | `validateSessionDesign` | `cr-memory` | Decision contract. |
| CR-42 | new | `worker/src/lib/session-design.ts` | `validateSessionDesign` | `cr-memory` | Artifact contract; version id from R4. |
| CR-75 | new | `worker/src/lib/measurement-core/interpretation.ts` | `EvidenceRef` | `cr-memory` | Stakeholder roles with refs. |
| CR-76 | new | `worker/src/lib/measurement-core/learning-events.ts` | `SOURCE_STATES` | `cr-memory` | Metric values keep source state. |
| CR-77 | extend | `extensions/hypeproof-chat/src/learningStateHelpers.ts` | `learningState` | `cr-memory` | SX-16 before/after → two versions. |
| CR-78 | new | `worker/src/lib/measurement-core/local-record.ts` | `records` | `cr-memory` | Timeline from records, no model call. |
| CR-79 | extend | `worker/src/lib/measurement-core/learning-events.ts` | `decision_revised` | `cr-memory` | Hypothesis revisions. |
| CR-82 | new | `worker/src/lib/measurement-core/interpretation.ts` | `validateReinterpretation` | `cr-memory` | Register and sourced promotion. |
| CR-43 | extend | `worker/src/skills/index.ts` | `resolveSkills` | `cr-skills` | R7. |
| CR-44 | new | `worker/src/skills/index.ts` | `isKnownSkill` | `cr-skills` | Output validation before write-back. |
| CR-45 | extend | `worker/src/lib/session-design.ts` | `SessionDesign` | `cr-skills` | Curriculum as data (SX-56). |
| CR-46 | new | `worker/src/skills/index.ts` | `SKILLS` | `cr-skills` | Four skills. |
| CR-47 | new | `worker/src/skills/index.ts` | `SKILLS` | `cr-skills` | Three skills. |
| CR-29 | extend | `worker/src/routes/chat.ts` | `chat` | `cr-gateway` | R8; app tokens get their own role, and every student route, `/v1/trace/event` included, moves to one role allow-list helper. |
| CR-30 | extend | `worker/src/lib/lesson-model-policy.ts` | `modelBinding` | `cr-gateway` | Capability → model. |
| CR-31 | extend | `worker/src/env.ts` | `resolveProvider` | `cr-gateway` | Normalised adapters + mock. |
| CR-32 | new | `worker/src/lib/anthropic.ts` | `callAnthropic` | `cr-gateway` | R8: a retry loop around the single-call adapter, each attempt admitted and metered; neither `callAnthropicResilient` (three calls per admission) nor `callGeminiResilient` (model fallback). Retry bound defaults to 0 until Jay rules on MU-02 (§9). |
| CR-33 | extend | `worker/src/lib/budget-admission.ts` | `reserveBudgetAttempt` | `cr-gateway` | 429 with reason. |
| CR-34 | extend | `worker/src/lib/analytics.ts` | `persistUsage` | `cr-gateway` | Eight dimensions. |
| CR-80 | extend | `worker/src/lib/model-usage.ts` | `reserveModelRequest` | `cr-gateway` | App-token and session keys. |
| CR-83 | extend | `worker/src/lib/storage.ts` | `recordTurn` | `cr-gateway` | No body for undeclared app calls. |
| CR-84 | extend | `worker/src/lib/translate.ts` | `buildAnthropicSystemBlocks` | `cr-gateway` | Coach contract + scan. |
| CR-48 | extend | `worker/src/lib/classroom-report.ts` | `composeReport` | `cr-review` | R9. |
| CR-49 | extend | `worker/src/lib/classroom-report.ts` | `draftKey` | `cr-review` | Digest-keyed cache. |
| CR-50 | extend | `worker/src/lib/classroom-report-html.ts` | `renderReportHtml` | `cr-review` | Open without generation. |
| CR-51 | new | `worker/src/lib/tokens.ts` | `issueIssuer` | `cr-review` | Director actor. |
| CR-52 | new | `worker/src/lib/measurement-core/local-record.ts` | `chooseImprovement` | `cr-review` | Decision + next experiment write-back. |
| CR-53 | extend | `worker/src/routes/classroom-reports.ts` | `classroomReportsRunner` | `cr-review` | Four-team overview. |
| CR-62 | new | `worker/src/lib/classroom-evaluator.ts` | `evaluateInput` | `cr-review` | Regeneration timing. |
| CR-54 | new | `extensions/hypeproof-chat/src/liveServer.ts` | `LiveServer` | `cr-deck` | R10. |
| CR-55 | new | `worker/src/lib/measurement-core/learning-events.ts` | `SOURCE_STATES` | `cr-deck` | Claim labels and flags. |
| CR-56 | new | `worker/src/lib/measurement-core/learning-events.ts` | `LEARNING_EVENT_KEYS` | `cr-deck` | Patches carry `evidence_refs`. |
| CR-57 | new | `worker/src/lib/measurement-core/learning-events.ts` | `LEARNING_EVENT_KEYS` | `cr-deck` | Week 2 fixture → slides 2–3. |
| CR-58 | new | `extensions/hypeproof-chat/webview-ui/src/EvidenceDrawer.tsx` | `EvidenceDrawer` | `cr-deck` | Change view. |
| CR-63 | new | `worker/src/lib/translate.ts` | `translate` | `cr-deck` | Slide patch timing. |
| CR-59 | reuse | `extensions/hypeproof-chat/src/liveServer.ts` | `reload` | `cr-browser` | Measure only. |
| CR-60 | new | `extensions/hypeproof-chat/src/nativeBrowser.ts` | `capturePageContext` | `cr-browser` | Timing of R2. |
| CR-68 | extend | `extensions/hypeproof-chat/src/chatPanelHelpers.ts` | `browserToolLogLine` | `cr-browser` | R11. |
| CR-71 | new | `e2e/classroom/g4-journey.mjs` | `journey` | `cr-e2e` | Pattern for the §14 script. |

## 5. Verification strategy per slice

Layers are the testing contract's. "CI" = `.github/workflows/pr-ci.yml` (worker `npm test` and its D1 steps, extension smokes, typechecks); a new D1 suite either runs inside worker `npm test` under `--experimental-sqlite` or gets its own step in `pr-ci.yml`. "Local" = Playwright Electron e2e against an app copy via `HPS_APP_PATH` with `scripts/dev-stack.sh`. "Real" = a reference Mac and a real phone, recorded in an evidence file.

| Item | CI | Local (`HPS_APP_PATH`) | Real Mac / phone |
|---|---|---|---|
| `cr-recon` | CR-T01 (`worker/test/cr-recon.test.mjs`) | `e2e/curriculum-runtime/cdp-probe.mjs` (evidence, §8) | — |
| `cr-browser` | CR-T02 (Worker half), CR-T03, CR-T04, CR-T05, CR-T06, CR-T10, CR-T11 (smokes over a mock CDP channel and unit tests) | CR-T02 (app half), CR-T07, CR-T08, CR-T09, CR-T63 | CR-T55, CR-T56 |
| `cr-verify` | CR-T02 (Worker half, verify routes), CR-T03 (runner re-check), CR-T11 (runner cases), CR-T13, CR-T15, CR-T76 (unit half) | CR-T02 (app half), CR-T12, CR-T14, CR-T16, CR-T63 (runner case), CR-T76 (app half) | CR-T57 |
| `cr-publish` | CR-T02 (Worker half), CR-T11 (published-origin cases), CR-T17 (Worker half), CR-T19, CR-T21, CR-T22, CR-T60 (pseudonym), CR-T68, CR-T80 | CR-T02 (app half), CR-T17 (app half), CR-T18 (390 px mobile emulation), CR-T61 | CR-T20 |
| `cr-evidence` | CR-T02 (Worker half), CR-T23, CR-T24, CR-T25, CR-T26, CR-T28, CR-T60 (re-check), CR-T62, CR-T64, CR-T65, CR-T67, CR-T69 | CR-T02 (app half), CR-T27 | — |
| `cr-memory` | CR-T02 (Worker half), CR-T35, CR-T37, CR-T38, CR-T39, CR-T70–T74, CR-T77, CR-T80 (re-run) | CR-T02 (app half), CR-T36 | — |
| `cr-skills` | CR-T02, CR-T40–T44 | CR-T02 (skill commands) | — |
| `cr-gateway` | CR-T02 (Worker half), CR-T29–T34, CR-T65 (re-check), CR-T75, CR-T78, CR-T79 (scan half) | CR-T79 (coach half, recorded provider) | — |
| `cr-review` | CR-T02 (Worker half), CR-T45, CR-T46, CR-T47, CR-T49 | CR-T02 (app half), CR-T48 | CR-T58 (recorded provider) |
| `cr-deck` | CR-T02 (Worker half), CR-T50 (unit half), CR-T51, CR-T52, CR-T53 | CR-T02 (app half), CR-T50 (render half), CR-T54 | CR-T59 (recorded provider) |
| `cr-e2e` | — | CR-T02 (full inventory), CR-T66 (scripted run) | CR-T66 (live run) |

The switch-off baseline (`e2e/tests/09-preview.spec.ts`) is not green on the probed app: see finding F1 (§9). `cr-browser` re-baselines it on the pre-change tree before using it as a control.

## 6. Interface proposal — Publish for User Test + Evidence Capture (PRD §15 item 8)

Types are proposals for `cr-publish` and `cr-evidence`; names may change, fields may not be dropped.

**Test origin.** Test versions are served by the Service on a dedicated origin per project, `https://<project-slug>.<test-domain>/`, never on `api.hypeproof-ai.xyz` (its `/admin` uses Basic auth, which a browser attaches to same-origin requests that student JS could make) and never on `hypeproof-ai.xyz` (member cookies, same site). The Lab gallery's sandboxed opaque origin cannot hold the participant pseudonym (CR-65) and has `connect-src 'none'`, so it cannot carry events or gateway calls. Choosing the domain is open (§9). Local and e2e runs use `http://<project-slug>.test.invalid:<port>` mapped with `hostResolverRules`, as `native-browser-input.spec.ts` already does.

**Records (Venture Memory, D1, R5).**

```ts
type Project = { schema: "hps-venture/1"; kind: "project"; id: string; cohort_id: string; profile_id: string;
  members: string[] /* student ids on the cohort roster; the team (R5 "Ownership") */; title: string; created_at: number };
type ProductVersion = { schema: "hps-venture/1"; kind: "product_version"; id: string /* R4 digest */; project_id: string;
  files: { path: string; sha256: string; bytes: number }[] /* R4 published set only */; entry_html: string;
  manifest_added?: string[] /* files the student added beyond static reach */; verification_report?: string; created_at: number };
type Hypothesis = { schema: "hps-venture/1"; kind: "hypothesis"; id: string; project_id: string; statement: string;
  status: "open" | "supported" | "refuted" | "revised"; revision: number; created_at: number };
type Experiment = { schema: "hps-venture/1"; kind: "experiment"; id: string; project_id: string; week: number;
  hypothesis_id: string; question: string; method: string; success_criteria: string[]; product_version_id: string;
  status: "draft" | "running" | "closed";
  declarations?: { repeated_use?: true; raw_input?: { fields: string[] }; devices?: ("microphone" | "camera")[];
                   variants?: { id: string; product_version_id?: string; alternative?: string }[] } };
type TestLink = { id: string /* random, the URL token */; experiment_id: string; variant_id?: string; channel?: string;
  expires_at: number /* required until Jay sets a default */; revoked_at?: number };
```

**Worker routes (all behind `curriculum_runtime.enabled`, R3).**

"Member" means R5's ownership rule. The student token (after R8's allow-list helper) must name the Project's cohort and a student in its `members`; the route resolves its target to that Project first. Anything else, including a target id that does not exist, answers 404 and writes nothing.

| Route | Auth | Does |
|---|---|---|
| `POST /v1/curriculum/projects` | student token | Creates a Project in the token's cohort and profile, with that student as its only member. |
| `PUT /v1/curriculum/projects/:id/members` | issuer whose `IssuerScope` covers the Project's cohort | Sets the team; every member must be on the cohort roster. Students cannot call it. |
| `PUT /v1/curriculum/projects/:id/versions/:digest` | member | Upload R4's published file set (multipart manifest + files) into that Project. Before storing anything, the Worker re-applies R4's rules: no dot-file or dot-directory, no path outside the set, per-file and per-set size caps, and R4's publish scan (every `LLMProvider` key format, Supabase service keys). A hit refuses the whole upload and names the file; so does a recomputed digest that differs. Idempotent for identical bytes (CR-17). Files go to R2 under `test-versions/<digest>/` (content-addressed, shared by identical bytes); the ProductVersion record is the Project's. |
| `POST /v1/curriculum/experiments` | member of the named Project | Creates Hypothesis (when none) + Experiment pinned to one of the Project's versions, whose verification state the response reports (CR-81, CR-39, CR-22). |
| `POST /v1/curriculum/experiments/:id/links` | member | Issues a `TestLink` (expiry required, channel, variant) and returns the share URL; the QR is drawn client-side (CR-18, CR-19, CR-73). |
| `POST /v1/curriculum/links/:id/revoke` | member | Revokes; later requests get 410 with no body (CR-19). |
| `GET <test-origin>/l/:link/*` | none | Serves the pinned files with `Cache-Control: no-store`, CSP (`connect-src 'self' <api origin>`), `Permissions-Policy: camera=(), microphone=()` unless declared (CR-66), and the injected participant snippet; 410 when revoked or expired. The entry page carries a server-issued session token (HMAC over link id, a server-chosen `session_id` and an expiry of hours, not days, and never later than the link's own expiry) that the snippet sends with every event. |
| `POST <test-origin>/l/:link/events` | link + the session token from page load | Appends participant events to the experiment's measurement-core task (R6): `session_start`, `page_view`, `click`, `task_start`, `task_complete`, `milestone`, with `session_id`, `pseudonym`, `source_state: "real"`, inherited project / experiment / version / channel / variant. It refuses identity fields, events for revoked versions, and events whose session token is missing, forged, expired or bound to another link (CR-23, CR-21, CR-65). It also refuses every event once the link is revoked or past its expiry, whatever the session token's own expiry: the link's state is read on each event, not only at page load. Rate limits per link and per session token (policy values, CR-70) answer 429 `rate_limited` and write nothing. A link holder can still produce events through real page loads: `real` means "recorded from a served session", not "a genuine participant". The evidence view shows per-session counts and flags bursts from one link, so a reviewer can see such a flood. |
| `POST /v1/curriculum/experiments/:id/notes` | member | Manual records as `external_feedback_received` with provenance and `source_state` (CR-24). |
| `GET /v1/curriculum/experiments/:id/evidence` | member, or a director issuer whose scope covers the Project's cohort (CR-37) | Events, notes, drafts and review states for the experiment; each claim opens its source ids (CR-27). |
| `POST /v1/curriculum/experiments/:id/drafts` | member | Stores an Observed / Interpreted / Assumed / Next draft as `hps-interpretation/1`; unresolved references refused (CR-25, CR-26). |
| `DELETE /v1/curriculum/experiments/:id` · `DELETE …/sessions/:sid` | member | `deleteTask` for the experiment; the new per-session erase (R6) for one session. Each returns its deletion report (CR-69). |

**Participant snippet.** Injected like `injectLiveReload`, under 2 KB, no framework: creates `pseudonym` in `localStorage` under a per-experiment key (random, never derived from device data; fresh per session unless `repeated_use` is declared), takes the `session_id` and session token the served page carries (one per load), posts `session_start` and `page_view`, listens for clicks and records the element's role and a stable path (never typed text), and exposes `window.hypeproof.test.task(name, "start" | "complete")` and `window.hypeproof.test.milestone(name)` for the student's app.

**Studio side.** `galleryPublish.ts` stays the one publish module: `publishWorld` for the Lab gallery (WEB-07/08, #1018) and a new `publishTestVersion` beside it that shares token handling and error wording. The publish panel shows the version's verification state (CR-81), the published file set with any manifest additions (R4), the share URL, the QR and the expiry. Evidence panels read through the routes above.

## 7. Per-slice implementation notes

### `cr-browser`

- Add an event API to `CdpSession` (listener set; dispatch messages without `id` whose `sessionId` is the attached one) instead of a second session class; keep `send` unchanged so `browserControl.ts` and `nativeBrowser.ts` keep working.
- Enable `Page`, `Runtime`, `Network`, `Log` once per attach. Seed the current document from `Page.getFrameTree` **before** `Runtime.enable`: enabling replays the attach-time document's console messages, which precede any `Page.frameNavigated` (probe).
- Document generation = main-frame `loaderId` (`Page.frameNavigated` / frame tree). Console and exceptions attribute through `executionContextId` → `Runtime.executionContextCreated` (`auxData.isDefault`, `frameId`); network through `loaderId` / `requestId`.
- Failed requests = `Network.loadingFailed` with `canceled` false plus `Network.responseReceived` with status ≥ 400 (a 404 is not a loading failure). Drop `canceled` loads (`net::ERR_ABORTED` on reload) and requests seen only before `Network.enable`.
- Clear refs on every new document, not only on navigate/back/forward: the live server's SSE reload creates a new document too. CDP itself refuses a stale backend node after reload ("Could not compute box model"); map that to AE-18's rejection instead of a generic error.
- `select`: `DOM.resolveNode` + `Runtime.callFunctionOn` setting `value` and dispatching `input` + `change` (native popups are not reachable by input events). `scroll`: `Input.dispatchMouseEvent` `mouseWheel` is the user-like path but needs composited frames (F7), and it never scrolled with the `origin/main` build (F8); `scrollIntoView` / `scrollBy` through `Runtime.callFunctionOn` worked in every run. `hover`: `mouseMoved` to the box centre. `reload`: `Page.reload` then wait for a new `loaderId`.
- Viewport: read `innerWidth/innerHeight` or `Page.getLayoutMetrics`; `Emulation.setDeviceMetricsOverride` is ignored by the shipped shell. Fixed widths come from `__hp_viewport`.
- Element pick (R2): reveal the pinned tab before entering inspect mode for any pick Studio starts itself. On a covered tab the first inspect-mode click is lost, and `document.visibilityState` still reads `visible`. Check it in both layouts, beside the chat editor and full width (the probe's `HPS_CR_PROBE_LAYOUT=beside|full`). The negative control is a pick started while another editor covers the tab: it either reveals the tab first or refuses with a reason; it never waits silently.
- First, F8. Run `e2e/curriculum-runtime/cdp-probe.mjs` on an app with this branch's build injected, in both layouts, unlocked. Find why the `origin/main` build starves the browser tab (wheel 0 of 10, crop 2–3 s against 26–40 ms on stock) before building R2, CR-T09 or CR-T56 on it. The pick, crop and wheel verdicts need every run of at least ten to pass on the shipped build. The stock build's 13 of 13 does not carry over.
- Owed from the recon (§8): the committed probe revision was run with the screen unlocked only. Its locked-screen behaviour is the first revision's (exit 3, composited checks NOT RUN).
- Scope (CR-11): allow only the `LiveServer.currentUrl()` origin for agent actions (published origins arrive with `cr-publish`); refuse with a reason before any CDP call.
- Fixture: add the kiosk-practice app as an e2e fixture (Korean copy, five steps, one planted console error mode) and reuse it in `cr-verify` and `cr-e2e`.
- `probe`: `e2e/curriculum-runtime/cdp-probe.mjs` is a starting point for the Playwright specs, not a spec; copy what is needed instead of editing it.

### `cr-verify`

- The report is computed from `criterion_set` / `test_observed` events plus artifact refs; do not add a report store. `artifact_after` must name an `artifact` event's sha256 in the same batch (`ARTIFACT_REF_KEYS`), so record the R4 version as an `artifact` event whose sha256 is the version digest, then reference it.
- Keep AI-proposed criteria as `adopted_from` drafts until the student confirms (SX-14, HC-04).
- Runner steps reuse `BrowserControl.execute`; the automation indicator wraps each step (R11).

### `cr-publish`

- Implement §6 routes, records and the test origin; the dedicated production domain is open (§9), so ship with the host configurable and tested on `*.test.invalid`.
- The published file set is R4's, not the live-server root: static reach from the entry HTML plus the confirmed manifest, never a dot-file, never a symlink or a file whose real path leaves the root, R4's publish scan and size caps before upload, and again in the Worker. Negative controls (CR-T17): a workspace `.env`, a dot-file, a file neither reachable nor in the manifest, and a symlink the entry HTML references that points outside the root are never uploaded or served. A file carrying a key of any `LLMProvider` format (one planted per provider: Gemini, Anthropic, OpenAI, GLM) or a Supabase service key refuses the publish before any upload. A member of one team uploading into another team's Project gets 404, and nothing is recorded for that Project.
- Projects and teams are R5's ownership rule; every route in §6 marked "member" resolves its target to a Project before doing anything. The cross-team negative controls live in CR-T17 (upload), CR-T19 (revoke), CR-T27 (evidence read) and CR-T64 (deletion).
- The Lab gallery route is not extended for test versions (§6 "Test origin"); `publishTestVersion` lives beside `publishWorld`.
- New route files must be mapped in `config/traceability.json` or listed in `KNOWN_UNMAPPED` (`worker/test/route-registry.test.mjs`); prefer a node.
- Migrations add Venture Memory tables (R5); do not apply them in production.

### `cr-evidence`

- Implement the Service `StoragePort` over `HPS_TRACES` (R6); verify atomic `ifAbsent` semantics on R2 first and record the result.
- Serialize writers per experiment, or derive linked sessions from the per-session keys (R6), and give the port a `usageBytes` that does not scan the store. Negative control (CR-T67): twenty participant sessions of one experiment linked concurrently must all appear in its session record and return counts. Today's unserialized `linkSession` keeps one of twenty and must fail that control on the pre-change tree.
- The events route takes the session token issued with the served page, and rate-limits per link and per session (§6). Negative control: an event with no, a forged or another link's session token is refused and writes nothing. So is an event carrying a still-valid session token after its link was revoked or expired (CR-T19).
- The per-session erase is new code beside `deleteTask` (R6); CR-T64 covers both, and a non-member deleting either gets 404 with nothing removed.
- Participant event kinds extend the observation vocabulary through `legacy-observation.ts` / `learning-events.ts` (one validator); run SX-T53's store inventory as the negative control.

### `cr-memory`

- Extend the `cr-publish` tables in place and re-run CR-T80; references into R6 only.

### `cr-skills`

- R7: contracts next to the Markdown in `worker/src/skills/`; refuse, never warn, on a curriculum skill with a missing field.

### `cr-gateway`

- R8; do not route capability calls through `callGeminiResilient` or `callAnthropicResilient`. A capability retry admits (`reserveBudgetAttempt`) and meters (`registerUsageAttempt`) every attempt, stops once output reached the caller, and defaults to a bound of 0 until Jay rules on MU-02 (§9).
- App tokens carry role `app`. Every student route in R8's inventory moves from `role === "issuer"` refusal (or, for `/v1/trace/event`, no check) to one allow-list helper, `role === undefined || role === "student"`, in the same change. Negative control (CR-T29): an app token is refused by every route in the inventory. That is `/v1/profile`, `/v1/access/*`, `/v1/logs/*`, `/v1/trace/*`, `/v1/classroom/*` (rehearsal report and the ops `lesson-binding` learner token included), `/v1/lesson-turns/*`, `/v1/observations/*`, `/v1/request-settings/*`, `/v1/activity`, `/v1/chat/completions` and `/v1/messages` (with `count_tokens`), and, through `/v1/profile`, the Lab gallery publish. A token with an unknown role is refused by all of them. The source check fails on a `verify(` call site that neither calls the helper nor is on a named issuer, admin or optional-auth path.
- The bundle scan is R4's publish scan, not `SECRET_PATTERNS` alone; CR-T29 plants one key per `LLMProvider` value.

### `cr-review`

- R9; spy on `callAnthropic`, `callOpenAI`, `callGemini` (and the gateway once it exists) for CR-T47.

### `cr-deck`

- R10; render under the workspace so the existing live server and Experiment Browser show it.

### `cr-e2e`

- Script under `e2e/classroom/` with the kiosk fixture; the switch-off walk reads the inventory every item added.

## 8. Evidence of this reconnaissance

Commands (2026-09-29, macOS arm64, Node 24.4.1):

| Command | Result |
|---|---|
| `cd worker && node --experimental-strip-types test/cr-recon.test.mjs` | CR-T01, verdict read at this tree (no `cr-recon` completion yet): 10 areas titled after their PRD Phase 0 items, 73 map entries, 84 matrix rows, 11 decisions resolve; the frozen control inputs equal the projection of this tree's inputs. 18 planted defects each reported exactly once on the frozen inputs, plus 14 resolver and comment-stripping controls on a temporary directory. The 10 external entries are unchecked without checkouts. |
| the same with `HPS_VSCODE_SRC=<vscodium-base/vscode, HEAD 560a9dba> HPS_VSCODIUM_SRC=<vscodium-base git> HPS_LAB=<hypeprooflab worktree>` | Same result with 0 external entries unchecked. |
| CR-T01 read modes, in a scratch clone of this branch before and after a simulated record (a `cr-recon` completion naming the clone's head and pinning the requirement document and every verification input, this page and the frozen control inputs included), and in a `--depth 1` clone of the recorded state, which lacks the recorded commit as `pr-ci.yml`'s checkout does. Each case is one later edit to the working tree, reverted before the next. | 25 of 25 cases as intended. **No completion:** clean passes; renaming `browserToolLogLine` or `SKILLS` fails (the window before the record, header). **Full clone, recorded:** the verdict is read at the recorded commit. Clean passes, and so do each of these later edits, printed as divergence: `browserToolLogLine` renamed, CR-47 dropped from `cr-skills` in the ledger, CR-T44 retargeted away from CR-47, `cdpSession.ts` moved, `verify` renamed in `tokens.ts`, `SKILLS` renamed. Editing the page (plus a rename) fails, and so does tampering with the frozen inputs: either breaks a pin, so the tree is checked again. **Depth 1, recorded:** the verdict is NOT RE-RUN and the 32 controls run. Clean passes, and so do each of these, printed as divergence: `browserToolLogLine` renamed, CR-47 dropped from `cr-skills`, CR-12 dropped from `cr-verify`, CR-T44 retargeted, `CdpSession` renamed, `cdpSession.ts` moved, `verify` renamed in `tokens.ts`, `SKILLS` renamed. Four cases fail as they should: the page edited plus `SKILLS` renamed, the frozen inputs tampered, and the checker mutated twice (duplicate rows not counted, the placeholder test disabled), each caught by a control. Before this revision the depth-1 cases for the ledger edit, the retarget, the move, the `verify` rename and the `SKILLS` rename failed (review r2); only a benign rename had been tried at depth 1. |
| `extensions/hypeproof-chat`: each of `test/browser-control-helpers`, `browser-mcp`, `browser-safety-helpers`, `browser-tool-log`, `cdp-session`, `live-preview-url`, `live-server`, `preview-artifacts`, `preview-html` `.smoke.mjs` | 9 of 9 exit 0. |
| First probe revision (`f4c3f153` and before), `HPS_APP_PATH=<app copy recorded as carrying the origin/main extension; since deleted>`, screen unlocked, 06:24Z (twice) | Not reproducible with that build today (F8). exit 0, 13 of 13 expectations, with the probe as it stood before the overlay step and the locked-screen split were added. Planted page: exactly 1 `console.error`, 1 exception, 1 HTTP 404, 1 refused connection per document, for each of two consecutive documents; clean page 0; hover, wheel scroll (0 → 600), select (`b`), reload (new document) work; the pick returns the AX-ref node with snippet, style and a PNG crop and does not click the product. |
| First revision, `HPS_CR_PROBE_NEGATIVE=1`, unlocked, 06:24Z | exit 1: the two exact-count checks fail on one unlisted planted error (the instrument is not lenient). |
| First revision, same app copy, screen locked, 06:43Z (twice); negative 06:44Z | exit 3: 14 of 14 runnable expectations (adds DOM-level scroll and the overlay DOM/AX check), wheel scroll and crop NOT RUN; negative exit 1. |
| First revision on the stock installed app (`/Applications`, 0.1.51), locked, run by the reviewer (twice) | exit 1: the pick timed out. The browser tab was a background tab behind the stock "HypeProof Studio" startup editor (R2). |
| Scratch diagnostic copy of the probe, stock app, 07:02–07:24Z | Tab covered by the startup editor right after opening: first pick click lost, later clicks answered, 6 of 6 runs (4 locked, 2 unlocked), whichever pointer path came first. The tab as the visible tab of its group at 1434 px (locked, twice) and at 714 px (locked, twice): first click answered. Width is not the factor. |
| This revision (layout controlled), stock app, `HPS_CR_PROBE_LAYOUT=beside` and `=full`, screen unlocked, 07:22–07:23Z and 07:25–07:26Z (twice each), plus 07:31Z, 07:32Z (stock extension in the app copy) and 07:48Z (beside) | exit 0, all 17 expectations (adds the visible-tab precondition): 714 px beside and 1434 px full, wheel scroll 0 → 600, pick with crop in 26–40 ms. With each `=1` negative run below, 13 of 13 visible-tab picks. |
| This revision, `HPS_CR_PROBE_NEGATIVE=1`, stock, 07:23Z and 07:26Z · `HPS_CR_PROBE_NEGATIVE=covered`, stock, 07:23Z, 07:27Z and 07:48Z | exit 1: the two exact-count checks fail · exit 1: the visible-tab precondition fails (and the crop, from a covered tab). |
| This revision, app copy with the `origin/main` extension injected, both layouts, unlocked, 07:28–07:35Z (10 runs, plus both negatives) | exit 1 in every run: wheel scroll never moved the page (0 of 10); pick 8 of 10; crop 6 of 10 and 2.0–3.0 s when it came. Swapping the stock extension into the same copy: exit 0 (F8). |
| F8 timing check, same injected build, 07:45–07:47Z: the old flow (tab opened at once, no settle wait) twice, the committed flow twice | Wheel scroll 0 of 4 in both flows (414 px in the old flow, 714 px in the committed one), so the settle wait is not the cause. |
| `HPS_APP_PATH=<app copy> npx playwright test tests/09-preview.spec.ts` (with `scripts/dev-stack.sh`) | 1 passed, 2 failed (F1). |

How symbols were located: by reading each named file at the recorded commit (`grep -n` for exports and call sites, then the surrounding code), the upstream files in the local VS Code 1.116.0 source prepared under the main checkout's `vscodium-base/vscode` (read at its git `HEAD`, because the prepared tree is patched), the pinned submodule with `git -C vscodium-base show 59e57927:<path>`, and the Lab routes in a hypeprooflab worktree. `worker/test/cr-recon.test.mjs` re-locates every in-repository entry mechanically, one word-bounded match outside comments per file, at the commit the map is true on (header). It proves that the named symbol occurs in that file, not that it is the declaration the role column describes. That part is the reviewer's reading. External entries are checked only when their checkouts are supplied, so CI does not check them.

Probe observations recorded as facts for later slices: `Runtime.enable` replays earlier console messages of the attach-time document; a reload drops in-flight requests as `canceled` `net::ERR_ABORTED`; port 9 is a Chromium-restricted port (`net::ERR_UNSAFE_PORT`), so the probe plants a refused connection on a freed port instead; `Emulation.setDeviceMetricsOverride` leaves `innerWidth` at the window width; the only upstream LM browser tool registered is `open_browser_page`; the overlay outline leaves DOM and AX counts unchanged; `document.visibilityState` reads `visible` on a covered tab; `BrowserTab.title` reads `<page title> (<url>)`, while the editor tab's label is the page title alone. So a browser tab is found in `window.tabGroups` by its page title, not by `BrowserTab.title`.

Open PRs of the reused requirements' owners (#557, #1018, #1172, #1020, #1009) were **not read**: GitHub API use belongs to the single shipping agent in this delivery. Remote branches were listed instead (`git for-each-ref refs/remotes/origin`); none names a browser console, publish-test or gateway change, but branch names prove nothing about open PRs (squash merges leave branches behind). So the negative control "a gap called new while an open PR already implements it is recorded as a finding" is unverified. The shipping agent checks the open PRs before merging this item. It writes the result into `docs/evidence/cr-recon.md` at record time: each PR's state, and each matrix row it contradicts, recorded as a finding against this page. The record must not be made without that section; until it exists, this item's negative control is unmet.

Not inspected: Chalk (`chalk/`), `packages/measurement` beyond its CI job, Windows, the real-phone path, production configuration, and the Lab gallery DB schema.

## 9. Findings and open decisions

Findings (pre-existing, not changed here):

- **F1.** `e2e/tests/09-preview.spec.ts` on app 0.1.51 with the `origin/main` extension: REQ-D5 passed; REQ-D1/D3/D6 failed (`#frame` never attached in the preview webview) and REQ-D4 failed (the command-palette input stayed hidden; the page snapshot shows the unified "AI와 작업" editor tab in front). Whether the instrument or the product is wrong is not yet separated (verification.md rule 6); CR-T02 names this spec as its baseline.
- **F2.** `callGeminiResilient` substitutes `gemini-2.5-flash` after a failure; fine for the kids route that uses it today, forbidden for CR capability calls.
- **F3.** `resolveSkills` drops an unknown skill with a warning; curriculum skills need a refusal.
- **F4.** `BrowserControl` clears refs on navigate/back/forward only; live-server reloads create new documents without clearing them (CDP then refuses the stale node).
- **F5.** The Worker stores no observation batch; the measurement-core record exists only on the App until R6.
- **F6.** New Worker route files fail `worker/test/route-registry.test.mjs` unless mapped or listed.
- **F7.** While the macOS screen is locked the integrated browser produces no composited frames: `Page.captureScreenshot` times out and `mouseWheel` input does not scroll, while CDP console/network events, AX reads, hover, select, reload, DOM-level scrolling and inspect-mode picking on a visible tab (R2) keep working (probe, locked vs unlocked runs above). `scripts/e2e-quiet.sh` starts suites only when the screen is locked, so screenshot- and wheel-dependent CR checks (CR-T09 crop, CR-T56, any screenshot evidence) cannot pass there; run them unlocked in quiet mode, and implement `scroll` so it does not depend on compositing where the verdict does not need it.
- **F8.** With the `origin/main` hypeproof-chat build in the app, the integrated browser tab behaves as if it is starved of composited frames even when the screen is unlocked:
  - CDP `mouseWheel` never scrolled (0 of 10 runs);
  - the inspect-mode pick got no event in 2 of 10;
  - the crop timed out in 2 more, and when it came it took 2.0–3.0 s.

  The stock 0.1.51 build in the same app copy passed 13 of 13 runs with 26–40 ms crops. Opening the tab at once instead of after the startup editors settle changed nothing (wheel 0 of 2). The earlier revision's unlocked runs at 06:22–06:24Z scrolled and cropped normally at 714 px. They are recorded as runs of an injected copy, but that copy is gone and the layout it produced does not match what the same build produces now, so they neither confirm nor refute F8. The `origin/main` extension registers no browser-tab hook (`onDidOpenBrowserTab`, `startCDPSession` outside `CdpSession`), so the cause is indirect; its startup editor competing for the compositor is the first candidate. DOM-level scroll, console and network capture, AX reads, hover, select and reload were unaffected. This is pre-existing and is `cr-browser`'s first task (§7), because R2's element crop, CR-60's timing and CR-T09 / CR-T56 depend on it.

- **F9.** `/v1/trace/event` (`routes/trace.ts`) verifies the token and never checks its role. Today it is safe by accident: the only other role is `issuer`, and `issueIssuer` signs `p: "__issuer__"`, so an issuer token stops at the profile step (400 `unknown profile`). A token with any other role that carries a student's `u`, `c` and `p` passes trace's profile, session and roster gates. It can then create trials and write heartbeats as that student on the instructor board. R8's allow-list helper closes this in `cr-gateway`, in the same change that introduces app tokens.

Open decisions for Jay (they block a default or a production step, not the design):

- The dedicated test-version domain and its wildcard route (§6). Until decided, the host is configuration and tests use `*.test.invalid`.
- Applying the Venture Memory migrations (R5) and deploying the Worker routes to production.
- The defaults already listed in the [plan](curriculum-runtime.md#decisions-still-open): link expiry, raw-input retention, returning-session linkage for minors, minor consent path.
- **Participant evidence on the Service (R6) deviates from MC-31's initial policy.** MC-31's policy is local storage only, no remote transfer, no automatic expiry, with location and retention set by Jay. R6 stores minors' participant events in R2 `hps-traces`, which has no lifecycle rule in `wrangler.toml`. Jay decides two things. First, whether Service-side storage of participant event records is accepted for this curriculum. Second, their retention and expiry default for minor cohorts; this is separate from the declared raw-input retention above, which covers raw input only. Until then `cr-evidence` builds the store behind the switch. No cohort gets the switch for real participants, and nothing claims an automatic expiry.
- **Capability retry and MU-02 (R8).** MU-02 allows one upstream call per user request. Jay decides whether a policy-bounded retry of an app capability call fits MU-02, with each attempt admitted and metered and only before any output reached the caller. Until then the policy bound is 0 retries; CR-T32 tests the mechanism with an explicit bound of 1.
