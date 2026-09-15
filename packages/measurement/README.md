# HypeProof measurement package

Existing Codex and Claude Code sessions → project-scoped snapshots → HypeProof
member server → verified local inbox. No Studio app, model API key, model polling,
or manual export/import per task. This package bundles the existing shared core,
transcript adapters and durable file store; it does not duplicate measurement logic.

## Install and connect once

Node 22+ is required. From a checkout of hypeproof-studio:

```bash
cd packages/measurement
npm ci
npm pack
npm install -g ./hypeproof-measurement-0.2.2.tgz
hypeproof-measure projects --project /absolute/path/to/project
```

Open https://hypeproof-ai.xyz/members/studio/measurement with your member account.
Create a connection for the displayed project IDs. A connection authorizes automatic
transfer of that project's visible user/assistant messages. Save the token privately,
then supply it on stdin (not a command argument, git file or chat message):

```bash
hypeproof-measure connect --token-stdin --project /absolute/path/to/project < /private/path/connection-token
hypeproof-measure install-service
hypeproof-measure status
```

Repeat `--project` to authorize multiple explicit roots in one connection. Their
SHA-256 canonical paths are the server project IDs. A git worktree is a distinct
root: include it explicitly. Connect verifies server-granted scopes before capture.
Connection tokens expire after 30 days and can be revoked on the member page.
Changing owners isolates the previous outbox; it never transfers those records to
a different account. Adding a project replays previously skipped server history.
Reconnect with a new token to resume outstanding uploads for the same verified owner; no token is printed
by status or stored in a launch command. Files are private to the OS account.

`install-service` uses a macOS LaunchAgent: persists after terminal exit, restarts
on failure, starts again at login. It checks every 30 seconds, captures only changed
files and retries failed delivery. On other Node platforms use `watch` under your
existing process supervisor. This release does not install a Windows service.

```bash
hypeproof-measure sync                 # one cycle; nonzero exit if attention needed
hypeproof-measure records              # received server records, without raw text
hypeproof-measure records --id ID      # explicit full server snapshot and receipt
hypeproof-measure results             # current server review/results list (online)
hypeproof-measure results --id UUID   # snapshot, receipt, draft/result and history
hypeproof-measure stop                 # stop this service and pause capture
```

The server imports snapshots automatically. The daemon also downloads authorized
accepted snapshots into a separate inbox, validates digests and commits its cursor
only after durable writes. It never injects records into prompts or edits original
Codex/Claude transcripts. `records --id` is readable by either coding tool when you
explicitly ask it to interpret your work; transfer does not itself run an evaluator.

Codex and Claude Code can both run `hypeproof-measure results` using the existing
connection. The command reads `/api/measurement/workbench` with that token's server
project scope and returns bounded JSON. A snapshot UUID returns its verified source,
receipt, draft, result, revision, history and actions. Hold and review states are
preserved; the command does not invent a score, activate an evaluator, or write a
review. Human reviews are submitted in the authenticated browser. This explicit
read is available while capture is paused; offline/revoked connections fail visibly
instead of returning stale cached results. Tokens are never included in the output.

When the server refuses ingestion with HTTP 410 `session_deleted`, the package
durably suppresses that owner's host/project/session and removes its pending
uploads. Changed originals and restarts cannot recreate that deleted session.
Suppression does not affect other owners, hosts, projects or sessions, and never
modifies original Codex/Claude transcripts. A download racing with deletion skips
only HTTP 410 `snapshot_deleted` and advances the page cursor; other failures keep
the cursor for retry. Previously downloaded offline inbox copies are not a server
deletion feed. This update does not purge those pre-existing copies.

## Contract and limits

- Data scope: visible user and assistant messages, known-secret redaction, model
  conditions and explicit exclusions. No hidden reasoning, tool output, credentials
  or whole raw transcript upload. Redaction is not an anonymity guarantee.
- Codex subagent copies: explicit `subagent_history_start_ordinal` excludes inherited
  parent rows and model conditions. Delegated user-role input is labelled as automated
  agent input, not direct human behavior. Unknown/missing boundaries are not guessed.
- Discovery: Claude's project directory and Codex's latest seven calendar days.
  More than 1,000 candidate files is an explicit error. All matching sessions within
  that cap are considered, rather than the viewer's 30-result list.
- Parser: initial byte-range snapshot, max1GiB source, latest500 eligible messages,
  max20,000characters/message and10,000visible messages/session. Oversized or corrupt
  sources show errors; incomplete tail is disclosed. This is bounded captured replay,
  not complete real-time event instrumentation. Unobserved history remains unknown.
- At most100model conditions per snapshot; explicit exclusion if truncated.
  Payloads are split below1.5MiB without dropping the selected events.
- Durable outbox → immutable server snapshot → exact digest receipt. Lost responses
  retry the same digest. Changed sources produce new snapshots; earlier snapshots
  remain. No automatic expiry/eviction in this client; conservative256MiB local cap
  stops growth visibly. Raw source paths stay local; message contents may name paths.
- Authentication, authorization and revocation are enforced by the server for each
  request. Credentials do not travel across HTTP redirects.
- Source changes while offline are captured at each successful local poll, not every
  keystroke. Sleep/offline capture gaps and more than500messages between captures
  cannot be reconstructed. The source remains on the original host.
- Imports remain `unreviewed`; `accepted-server` means durable server receipt, not
  human consent to an interpretation, task success, capability score or growth.
  Legacy seven-key data and six-model definitions remain separate.

The old local review app's optional manual submission is independent of this sync
inbox. Historical app reviews/receipts are not silently uploaded by this connector.

## Verification

```bash
npm test
```

Tests use both genuine host file shapes, an HTTP server and private temporary stores:
offline retry/restart, idempotency, changed snapshots, project isolation, invalid
receipts, corrupted import recovery, pause, redaction and chunk bounds.
The production endpoint and actual installed supervisor require separate evidence.

Integration references (checked2026-09-15):
- Codex configuration: https://learn.chatgpt.com/docs/config-file/config-reference
- Claude hooks: https://code.claude.com/docs/en/hooks

This daemon reads the already-supported local transcript adapters. It intentionally
does not overwrite Codex notify or Claude hooks, and works with sessions already open.

Codex ordinal contract: https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/thread_history_materialization.rs
