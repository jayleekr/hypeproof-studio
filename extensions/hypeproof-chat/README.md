# hypeproof-chat

Built-in chat panel for HypeProof Studio. React webview ↔ extension host via `postMessage`.

## Quick start (standalone dev)

```bash
cd extensions/hypeproof-chat
npm install
cd webview-ui && npm install && cd ..
npm run build
# Open this folder in VS Code, press F5 → Extension Development Host
```

## Layout

```
src/                    extension host (Node)
  extension.ts          activate(), commands, secret storage
  chatPanelProvider.ts  webview registration, history, streaming
  proxyClient.ts        OpenAI-compatible SSE fetch
  protocol.ts           SHARED message types (imported by both sides)
webview-ui/             React + Vite (sandboxed iframe)
  src/App.tsx           state + host bridge
  src/ChatPanel.tsx     UI
  src/vscode.ts         acquireVsCodeApi wrapper
```

See [.claude/rules/extension-dev.md](../../.claude/rules/extension-dev.md) for the design rules (no `vscode` imports from webview, all model calls via Proxy, modal approval pattern).

## Settings

- `hypeproofChat.proxyUrl` — base URL of HypeProof Proxy (default `http://localhost:8787/v1`)
- `hypeproofChat.model` — model id passed through
- `hypeproofChat.requireApprovalFor` — list of action kinds that show a modal before executing

## Workshop token

Set via command palette → "HypeProof Chat: Set Workshop Token". Stored in VS Code SecretStorage (encrypted at rest).
