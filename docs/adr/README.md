# Studio Architecture Decision Records

This directory records decisions that explain why Studio is structured the way
it is. ADRs are short and stable. They are not meeting notes. A new ADR is
required when a PR changes architecture boundaries, release topology, auth
contracts, preview safety policy, or the docs source-of-truth model.

## Index

| ADR | Status | Decision |
|---|---|---|
| `0001-source-owned-dev-docs.md` | Accepted | Keep dev docs in product repos and publish through `hypeprooflab`. |
| `0002-native-browser-via-webcontentsview.md` | Proposed | Build the education native browser on Electron `WebContentsView` (core patch + CDP), not a cmux/WKWebView port. |
| `0003-agent-sdk-coach-runtime.md` | Proposed | Adopt the Claude Agent SDK as the coach runtime; keep the fork and embed the SDK coach; retire the provider-proxy plumbing. |
| [0004-chalk-authoring-storage.md](0004-chalk-authoring-storage.md) | Accepted | Service-owned drafts and frozen session-design documents. |
| [0005-lesson-assistant-identity.md](0005-lesson-assistant-identity.md) | Proposed | A frozen lesson's fixed AI display name travels through the existing `ux.coach` contract; no new profile key, no capability change. |
| [0006-lesson-model-policy.md](0006-lesson-model-policy.md) | Proposed | A frozen lesson may narrow the models it allows within what the profile already grants; both existing clamps enforce it unchanged, and the app is told the seat's set. |
