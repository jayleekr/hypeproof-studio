# Local task review slice (#1020)

Owner: Jay. Parent: Product Intent's visible human judgment and useful work first;
#1020's adopted six-capability model. This is a bounded implementation of
MC-07, MC-21–25, MC-27–32, MC-34–35 in the proposed #1025 contract, not completion
of all three hosts or the Jay longitudinal dogfood acceptance.

## REQ-STUDIO-LOCAL-REVIEW

The Studio start page exposes **내 작업 검토**, opening **My task reviews**. A person explicitly selects one Claude Code or Codex
JSONL message transcript for the open project and confirms import. Collection is
off on first launch; no background scanner or host hook is installed. Different
projects and mixed-session transcripts are rejected, and transcript contents never execute or grant access.

A private file-backed record survives restart. The card shows source messages,
source digest and host, purpose and its confirmation state, all six capabilities,
missing tool/artifact/verification coverage, review history and local receipts.
Manual review works without AI or additional credentials. Unassessed capabilities
remain insufficient evidence; clicking confirmation does not establish growth.

A person can edit/confirm purpose and confirm/correct/dispute/exclude/hold each
capability, without changing observations. Before submission, the exact payload,
optional message inclusion, exclusions, destination and digest are visible.
Acceptance follows durable write and independent read-back verification. Repeated
submission returns the same receipt; edits require a fresh preview. Later
submissions are revisions. Broken storage or corrupted receipts show an error.
Deletion covers the local task and its copies, leaving host originals intact.

Known secret patterns are removed before persistence. Original transcripts are
not copied wholesale. Retention is local, no remote transmission, no automatic
expiry; the inherited 256 MiB limit is provisional and never evicts records.

## Admission and scope

App placement is required for local filesystem access and installed Studio UI.
The host adapters feed the existing hps-observation/1 contract and shared
hps-local-record/1 implementation from #1047. They do not duplicate auth or the
core, and do not extract the sessionSpool turn-pinning mechanisms. Shared React
bridge and webview renderer remain authoritative. Remove the command, adapter and
panel to stop import; the local store remains readable through the core.

Captured replay is distinct from a live host hook, real tool execution and human
acceptance. Tools, artifacts, hidden reasoning, approvals and subsequent messages
are deliberately outside this first message-import slice. Cross-host continuation,
automatic analysis, next-task improvement follow-up and all-OS release remain
later slices. #1020 stays open.

## Validation contract

- `extensions/hypeproof-chat/test/local-record-file.smoke.mjs`: durable reopen,
  atomic create races, directory permissions, traversal denial.
- `extensions/hypeproof-chat/test/local-review.smoke.mjs`: both formats, project
  mismatch, safe message extraction, manual review history, exclusion, repeated
  receipts, revision, competing writer, corruption and delete; synthetic actors.
- `e2e/local-review/mac.mjs`: real installed Mac shell containing exact candidate
  bundles, command entry, card, edit/confirm, preview and receipt after restart.
  Automated UI actions are never reported as Jay's human acceptance.
- Existing core tests preserve legacy seven-key records and validated references.

Execution evidence is recorded separately after each run. Public App release and
human dogfood are not inferred from a development extension or a local test copy.

## Session observation and improvement (#1049)

The person can discover recent sessions for the open project on demand: Claude's
matching project directory and Codex's last seven calendar days, limited to 30
matching results and 1,000 candidate files. Discovery returns metadata, not message
text. Explicit file selection remains available. Both paths check project identity,
reject symlink files and require import confirmation. No LLM polling is involved.

Selected files up to 1 GiB are read sequentially over the initial byte range. The
snapshot digest identifies that byte range. An unfinished final JSONL row is omitted
with a visible limitation; malformed interior rows fail. Only the latest 500 eligible
visible messages are included per snapshot. Sessions exceeding the core limit of
10,000 visible messages fail explicitly instead of silently dropping newer work. Oversized messages and unsupported data
remain excluded and disclosed. Earlier stored observations remain preserved.

Reimporting a changed session updates its existing task with a new interpretation
revision and invalidates any submission preview. Prior evidence, human reviews and
receipts remain unchanged. Deleted sessions cannot return through a newer snapshot.
The observation summary shows message counts and recorded model/reasoning changes;
counts are activity descriptions, not ability, success, time-on-task or growth.
Model definitions render from the interpretation's recorded version.

A reviewer sees each capability's criterion and counterexample and may select up
to ten stored messages when writing an interpretation. The host validates every
selected reference belongs to that task and persists references in the review note.
This is human interpretation, not an automatic semantic assessment. Neither quoted
AI claims nor choosing evidence establishes independent human performance.

One chosen next action is saved through the existing core improvement API. Another
task in the same project may record tried/not-tried/unknown and an observed result.
The action and follow-up survive restart. They are local records and are explicitly
not included in the current submission payload. A tried action without an observed
result stays unconfirmed. Same-task or foreign-project follow-up is rejected.

Research criteria, counterexamples, rater agreement, comparability and learning
validation are assigned to Bongho and Minhan in #1049. This provisional product
slice does not claim their acceptance or a validated capability measure.

Additional regression: `extensions/hypeproof-chat/test/local-session-observation.smoke.mjs`.

The file adapter tracks key lengths while holding its writer lock to avoid rescanning
the full store for every observation. The optional core storage usage hook preserves
the existing capacity calculation. Record and receipt reads still read the durable
file; they never return cached content. The index is discarded on lock release.
