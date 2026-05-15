# hypeproof-chat extension rules

The bundled chat extension lives at `extensions/hypeproof-chat/` (Phase 4+). Loaded when working in that subtree.

## Architecture

```
extensions/hypeproof-chat/
├── src/extension.ts        # activate(), webview registration, VS Code API surface
├── webview-ui/             # React + Vite app rendered inside the webview
│   ├── src/App.tsx
│   ├── src/ChatPanel.tsx
│   ├── src/proxy.ts        # OpenAI-compatible client → HypeProof Proxy
│   └── vite.config.ts
└── package.json            # extension manifest (activationEvents, contributes)
```

## Boundaries

- **`src/extension.ts`** runs in the extension host (Node). Has VS Code API access. No DOM.
- **`webview-ui/`** runs in a sandboxed iframe. No VS Code API; no Node. Communicates with the host via `postMessage`.
- Bridge contract lives in a shared `types.ts` — keep message shapes there, import from both sides.

## Build

- `npm run build` in `webview-ui/` produces static assets the extension loads.
- Extension itself is bundled with esbuild (per VS Code extension convention).
- During Phase 5 the whole folder gets injected into VS Code source as a built-in extension; until then iterate as a standalone extension (`F5` debug in Extension Development Host).

## Proxy contract

Webview talks to the local HypeProof Proxy (`proxy-poc/proxy.py`). Endpoint is OpenAI-compatible (`/v1/chat/completions`, SSE streaming). Workshop token is supplied via the UI and stored in `secrets` (VS Code SecretStorage API) — never in plaintext settings.

## Things to avoid

- Importing `vscode` from `webview-ui/` — webpack/vite will fail and it's the wrong layer anyway.
- Bundling Node-only deps into the webview.
- Inlining the proxy URL — keep it in extension settings (`contributes.configuration`).
- Calling third-party LLM APIs directly from the webview. All model calls go through the Proxy.

## Manual-approve gates

File write and shell exec must surface a modal before action. The approval handler lives in `src/extension.ts` (it has VS Code API access; the webview only requests). Design pattern: webview sends `{type: "request_action", action: "write_file", payload}`, host shows `vscode.window.showWarningMessage(..., {modal: true}, "Approve", "Deny")`, posts back result.
