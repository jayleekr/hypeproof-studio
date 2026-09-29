# Automatic host session synchronization (#1049)

Owner: Jay. Parent: visible human judgment and portable evidence in Product Intent,
ST-REQ-LOCAL-REVIEW and MC host adapters. Authorized2026-09-15: automate export/import
between existing Codex/Claude Code sessions and the internal member server.

## REQ-STUDIO-SESSION-SYNC

SS-01: An installable Node package exposes the existing common measurement core,
Codex/Claude transcript adapters and a CLI, without requiring the Studio binary.
SS-02: One explicit connection selects project roots and a member server token.
Only server-granted canonical project hashes may be captured. Registered Git worktrees sharing the selected repository common directory are included under its grant; unrelated roots require explicit inclusion. Existing host credentials and notification hooks are unchanged.
SS-03: A deterministic supervisor observes file changes every30seconds without
model calls. On macOS installation survives terminal exit and restarts at login.
Stopping disables further capture; it does not destroy host transcripts.
SS-04: The local observer emits bounded redacted visible-message excerpts, model conditions, explicit lifecycle, tool call/result metadata and relative artifact references. Full tool input/output, patch contents and hidden reasoning are excluded. Captured execution metadata is not independent human judgment.
SS-05: Failed uploads remain in an outbox across restart. Only a matching server
receipt advances delivery; retries are idempotent. Prior snapshots remain immutable.
SS-06: Authorized server snapshots import into a separate local inbox. Digest and
receipt checks precede persistence/cursor advancement; no downloaded content executes.
SS-07: Error, pending count, last completed cycle and project scopes are visible
without printing credentials. Connection revocation/expiry is enforced server-side.
SS-08: Automatic collection creates unreviewed evidence only. It cannot assert
human review, task success, ability, learning or growth. Legacy7data and six-model
interpretations remain distinct. Existing manual-app reviews do not silently upload.
SS-09: `hypeproof-measure results` reads the server workbench using the stored
connection. An optional snapshot UUID reads its receipt, draft, result, revision,
history and actions; the snapshot digest is verified. Results remain server-provided
JSON with review/hold states intact. No model runs, accepted-review writes, or
offline-cache fallback occur. Only the authenticated browser can submit a review.
SS-10: Only HTTP410 `session_deleted` from snapshot or observer ingestion suppresses that
namespace/host/project/session. Persist suppression before removing queued uploads;
later files, retries and restarts cannot recreate the deleted server session.
Only HTTP410 `snapshot_deleted` during a download race skips that snapshot and
allows page cursor advancement. Other errors retain pending work/cursor state.
HTTP status and bounded error code remain distinct; credentials never appear in
CLI output. Original host transcripts are never deleted or edited.

## Placement and validation

Filesystem access belongs to the local package; member identity, immutable accepted
records and connection lifecycle belong to the existing Lab member server. The
package bundles core/parser/store from their canonical source paths, without a new
scorer or authentication implementation.

`packages/measurement/test/sync.test.mjs` uses both host schemas, a real HTTP listener
and real local storage. Tests cover offline retry/restart, duplicate delivery,
source updates, project isolation, malformed records/receipts, cursor recovery,
pause and bounded redaction. CI builds/tests/packs the standalone package.
The same suite covers server-deletion suppression across restart, failed suppression
writes, specific versus unrelated 410 responses, cursor recovery, and the installed
CLI's read-only results list/detail behavior with synthetic records.

Production API acceptance and actual supervisor behavior are separate from these
local tests. Record actual results on the delivery PR; do not mark human improvement
or full historical capture complete. Parser/discovery limits are in the package README.

## Incremental observer — 0.3.0

SS-11: New automatic capture uses `hps-observer-delta/1`, not repeated full-session message windows. Consecutive complete-line source ranges, stable event identity, generation, sequence and predecessor digest provide idempotent reconstruction. The server stores normalized events once; task review explicitly freezes a review source. No automatic scoring occurs.
SS-12: Persist each delta and recoverable checkpoint atomically in the local outbox before advancing the source journal. Partial lines wait; malformed complete lines increment explicit coverage. Detect truncation, replacement, same-size rewrite and changed source boundaries as new generations. Document the limit of boundary checks for arbitrary middle rewrites.
SS-13: Bind tasks/models/calls to their observed source context, retain pending background calls through restart, and distinguish delegated versus unconfirmed human-role input. Never use hidden reasoning or assistant success prose as execution proof. Unknown status remains unknown.
SS-14: Changed sources read only appended complete ranges. Unchanged sources skip content reads using cached discovery and checkpoints. Bound cycles, records and payloads explicitly; expose deferred sources rather than silently dropping backlog. Historical v1 queue/receipt/results compatibility remains intact; new observation events are not downloaded back as repeated transcripts.

The portable schema and fixture are `packages/measurement/src/observer-contract.mjs` and `packages/measurement/test/fixtures/observer-delta.json`. Tests are `observer.test.mjs`, `observer-sync.test.mjs`, and historical parser/results tests in `sync.test.mjs`. Local/synthetic execution and real server deployment are reported separately.
