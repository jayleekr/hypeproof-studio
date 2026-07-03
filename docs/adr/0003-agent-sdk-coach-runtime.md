# 0003 — Adopt the Claude Agent SDK as the coach runtime

Status: Proposed

Epic: #282

## Context

The chat coach in `extensions/hypeproof-chat/` is, today, a single-turn
chat-only client talking to `worker/` which proxies three LLM providers through
an OpenAI-compatible shim. It has **no agentic loop, no tool-use, no subagents,
and no MCP** — `mcp_tools_enabled` is a tool allowlist that `translate.ts`
already enforces but that is empty (`[]`) in every current profile, so it is
effectively dormant; the manual-approve gate (`resolveActionApproval`) is
likewise dormant because the model never issues tool actions. The coach emits an HTML blob per turn; the client
string-extracts it and writes `index.html` itself. The gap versus Claude Code is
structural, not incremental: the product is not a weak agent, it is not an agent.

Sustaining this costs us the wrong things. Roughly 800 lines across
`worker/src/lib/{translate,sse,gemini}.ts` plus the `MODEL_MAP` /
`GEMINI_MODEL_MAP` / `OPENAI_MODEL_MAP` tables exist only to hand-marshal
requests, streaming, model aliases, and prompt caching across providers. This is
the highest-churn code in the repo and it re-implements what an agent runtime
ships for free.

What actually differentiates Studio is orthogonal to the runtime: the 7 AI
Native Assets pedagogy, per-cohort profiles and tuned Korean system prompts,
child-safety content sanitization, the workshop token/session operations layer,
the learning-analytics trace schema, the guided coach UX, the skeleton library,
and source trust-tiering. None of these require owning the chat loop or the
provider plumbing.

Bundling Claude Code itself is not a licensable path for a third party (the CLI
and its workflow/orchestration surface are Anthropic's product). The **Claude
Agent SDK** (TypeScript/Python, Anthropic Commercial Terms) is: it exposes the
agentic loop, tool-use, subagents, skills, hooks, MCP, sessions, and permission
modes to embed in our own UI.

## Decision

Adopt the **Claude Agent SDK** as the coach runtime, and **keep the VSCodium
fork** as the delivery vehicle — the SDK-based coach is embedded inside the fork
as the built-in `hypeproof-chat` extension (Phase-5 bundling unchanged). We buy
the engine and keep the pedagogy.

- **Gain (closes the gap):** agentic loop, workspace tool-use, subagents, MCP,
  hooks — reached by configuration, not by re-implementation.
- **Keep (the moat, no pedagogy regression):** `worker/src/profiles/*`,
  `worker/src/prompts/*`, `asset-scorer.ts`, `routes/trace.ts` + `lib/storage.ts`
  analytics, child-safety rules, token/session ops, guided coach UX, skeletons.
  A cohort `Profile` maps to SDK options: `systemPrompt` from `prompts/*.md`,
  `permissionMode`, tool allowlist from the profile's tool policy, model from
  `ModelAlias`. The asset scorer and trace run as post-turn hooks; the
  manual-approve gate becomes a `PreToolUse` hook reusing the existing modal.
  (The profile is the canonical owner of the tool allowlist. The Phase-0/1
  spike derives it client-side from `game.template_tier` + `tools.web_search`;
  Phase 2 should move that policy into the worker profile — folding in
  `mcp_tools_enabled` — so a single server-side field governs both the proxy
  and SDK paths. See #284.)
- **Retire (once the SDK path is default AND no cohort runs the proxy path):**
  `worker/src/lib/{translate,sse,gemini}.ts` and the three model-alias maps.
  Note `translate.ts` is the only place the `mcp_tools_enabled` allowlist is
  enforced today — re-home that check (into the profile→SDK tool policy) before
  deleting it, or a non-empty allowlist on a still-proxied cohort silently stops
  filtering.

Migration is staged behind a feature flag (Phase 0 spike → Phase 1 flagged SDK
coach → Phase 2 real tool-use/subagents → Phase 3 remove the plumbing) so the
live cohort is never broken. Branding is "Powered by Claude Agent SDK", with a
shared classroom key and no per-user claude.ai login. Tracked in epic #282.

## Consequences

The worker's role narrows to what only we can own: token issuance, roster and
session operations, the cohort profile API, analytics/trace, and publishing —
not LLM plumbing. Contributors gain real agent capability (the coach can read
and edit the actual workspace, run the preview, and delegate to subagents)
without our team maintaining an agent. We take on an SDK dependency and its
version cadence, must resolve licensing for shared classroom keys before the
first SDK-backed workshop, and must work around Workflows being CLI-only (via a
subprocess or hand-rolled Node orchestration) if multi-agent orchestration is
needed. The pedagogy, profiles, safety rules, and analytics are preserved
unchanged; this ADR changes the runtime boundary, not the product philosophy.
