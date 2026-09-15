# HypeProof measurement package

Codex and Claude Code → local observer → compact immutable event deltas → member server → evidence review. Version 0.3.0 captures execution evidence without sending whole transcripts or running a model. Existing historical snapshot readers and `results` remain compatible.

## Connect once

Node 22+ is required:

```bash
cd packages/measurement
npm ci
npm pack
npm install -g ./hypeproof-measurement-0.3.0.tgz
hypeproof-measure projects --project /absolute/path/to/project
```

Create a scoped connection at https://hypeproof-ai.xyz/members/studio/measurement.
Store its token privately and pass it on stdin:

```bash
hypeproof-measure connect --token-stdin --project /absolute/path/to/project < /private/path/connection-token
hypeproof-measure install-service
hypeproof-measure status
```

Repeat `--project` for unrelated repositories. Registered Git worktrees sharing an authorized repository's common directory are included under that project's granted hash; unrelated directories are excluded. Exact selected roots keep their own hash. Discovery includes all available Codex dates and Claude project/subagent directories, bounded at 5,000 candidates and 10,000 directories. A limit produces an explicit error, not a silently shortened history.

The existing macOS LaunchAgent runs one cycle every 30 seconds after the prior cycle finishes, survives terminal exit, and starts at login. Other platforms can run `watch` under their existing supervisor. No additional watcher, host hook, model call, or Windows service is installed. Tokens expire after 30 days; rotate via `connect`. Another owner's outstanding records remain isolated.

## Use

```bash
hypeproof-measure sync                       # one bounded cycle
hypeproof-measure status                     # counters, backlog, errors; no credentials
hypeproof-measure observations               # online capture sessions/coverage
hypeproof-measure observations --id UUID      # online captured task/activity detail
hypeproof-measure results                    # saved review/results list
hypeproof-measure results --id SNAPSHOT_UUID  # verified frozen review source + result
hypeproof-measure records                    # historical imported snapshot receipts
hypeproof-measure stop                       # stop service and pause collection
```

`observations` and `results` only read the server. They remain available while capture is paused. Offline or revoked access fails explicitly; no stale-result fallback or review write occurs. Open the member page to select a task, freeze its review source, review the evidence, and record an interpretation. Receipt acceptance proves transfer, not task success, independent human behavior, capability or improvement.

## Local preprocessing and privacy

The observer retains bounded, redacted visible-message excerpts (1,000 characters), model conditions, explicit turn lifecycle, paired tool call/results, and project-relative artifact references. Hidden reasoning is omitted completely. Full commands, environments, stdout/stderr, file contents and patch bodies remain local. Only their safe structural metadata or content digests may transfer. Known-secret redaction is not an anonymity guarantee; visible messages can still contain personal information. Artifact references describe the recorded operation, not proof that a file currently exists or has that version.

Tool status uses explicit structured exit codes/interruption/error fields. Missing execution codes stay `unknown`; assistant claims of success never become a passed test. Background results bind to the original call/task/model when the host supplies a linkage. Human-role input stays `human-unconfirmed`; Codex fork boundaries omit inherited parent content, and Claude sidechain records remain delegated. Unsupported host records, malformed complete lines, hidden content and deliberately clipped excerpts have separate coverage counters (`excerpted` differs from skipped `oversized` records). Known host bookkeeping is counted as intentionally omitted.

## Incremental transport and recovery

`hps-observer-delta/1` sends consecutive complete-line byte ranges with source hashes, stable event IDs, generation, sequence, predecessor digest and per-delta coverage. The exact portable contract and synthetic fixture are `src/observer-contract.mjs` and `test/fixtures/observer-delta.json`.

- Each delta contains at most 250 events and 512KiB. Raw source files are capped at 1GiB; a line over 2MiB is omitted with an explicit oversized count; a line buffer over 16MiB fails visibly.
- A cycle reads at most 64MiB of source ranges, at most 32MiB per source, and queues at most 50 deltas minus existing pending observer batches. Remaining sources are counted as deferred and resume next cycle. Cycles alternate recent-source priority with a persisted round-robin cursor for fair historical backfill; a 20-second capture budget is checked between sources.
- Only appended complete lines are normalized. Partial tails wait for completion. An unchanged, fully scanned source requires no transcript content reads; discovery caches unchanged headers. File metadata and directory listings are still inspected.
- Checkpoints persist task/model, pending calls, generation and source offset. Each immutable outbox record contains its checkpoint for crash recovery. Checkpoint advancement follows the durable queue write; upload order is per source/generation/sequence.
- Inode changes, truncation, same-size rewrites, changed prefix or changed checkpoint-tail anchor start a new generation. This is append-log integrity checking, not a continuous whole-file audit: an in-place middle rewrite that preserves checked boundaries while appending can require an explicit rescan.
- More than 500 unresolved calls fails explicitly. A task may remain unassigned when its host supplies no reliable task boundary; no task intent is invented.
- SHA-256 digests bind canonical delta contents; matching `accepted-observer` receipts complete upload. Conflicts/offline errors retain the queue. New deltas are not downloaded back as duplicate full snapshots.

Version 0.2.x queued snapshots still upload to their original endpoint; accepted historical snapshots still import into the separate inbox with receipt/digest checks. Original transcripts are never overwritten. HTTP410 `session_deleted` durably suppresses all future capture for that owner's host/project/session before removing pending records. Only `snapshot_deleted` skips a historical download race; other errors remain visible. Existing local inbox/export/original copies are not purged by server deletion.

## Validation

`npm test` covers append-only bytes, unchanged cycles, retries, checkpoint crash recovery, partial lines, malformed coverage, reset generations, fork/sidechain provenance, background calls, model binding, redaction, artifact bounds, real HTTP receipts, deletion suppression, historical compatibility and read-only results. No real private transcript is used in the committed fixtures.
