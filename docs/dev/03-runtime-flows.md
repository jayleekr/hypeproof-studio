---
title: Studio Runtime Flows
product: studio
doc_type: runtime
status: canonical
owner: core
version: 0.1.4
last_reviewed: 2026-05-22
audience: maintainers
source_paths:
  - extensions/hypeproof-chat/src/chatPanelProvider.ts
  - extensions/hypeproof-chat/src/proxyClient.ts
  - worker/src/routes
quality_gates:
  - runtime-flows-present
  - failure-paths-documented
  - source-paths-exist
---

# Studio Runtime Flows

## First Launch

On first launch the extension activates, creates or opens the workshop
workspace, suppresses the workspace trust modal, focuses the HypeProof chat
container, and tries to load a stored token. If no token exists, `setToken`
prompts the member. If a token exists but `/v1/profile` rejects it, the
extension keeps enough context to explain the failure and asks the member to
re-enter a valid token. The key observable signals are activation logs, profile
request status, panel config messages, and the visible token/profile state in
the chat header.

## Chat And Preview

The member submits a prompt in the webview. The webview posts a typed message to
the extension host. The host validates state, calls the Worker through
`proxyClient.ts`, streams SSE deltas back into the webview, persists bounded
history in workspace state, and watches for generated HTML. When runnable HTML
appears, the preview provider opens or reuses a sandboxed preview panel and
writes the latest artifact to the workspace `index.html`. A failure before SSE
start should become a friendly auth/network message. A failure mid-stream should
show a request id and allow retry.

## Support And Token Issuing

The report-problem flow collects a short description, recent-turn consent, and
optional contact. It hashes local token identity before sending metadata. The
issuer flow stores an issuer token, validates cohort/user/hours input, mints a
student token, and copies it for workshop operation. Both flows must keep raw
secrets out of UI text, logs, and reports. Rate limits should degrade into a
clear retry instruction rather than throwing raw JSON into the member panel.
