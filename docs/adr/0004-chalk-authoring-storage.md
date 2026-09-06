# Chalk authoring storage and frozen versions

Status: implemented API slice; activation and UI remain planned.

## Layer and contract

Authoring content is Module data. The Service owns HTTP authorization and D1
writes; Chalk forwards these endpoints using its existing shared allowlist.
No App changes or participant chat-gate changes are needed for this slice.

One authoring HTTP JSON contract under
`/admin/cohorts/:cohort/authoring/:course`:

| Method/path | Body | Response |
|---|---|---|
| GET base | none | course_id, profile_id, revision, content, updated_at |
| PUT base | expected_revision, request_id, profile_id, content | saved draft |
| GET base/versions/:version | none | module, source_revision, rehearsal:not_run, activated:false |
| PUT base/versions/:version | expected_revision | frozen document; no activation |

Course IDs are caller-selected URL-safe IDs (1–128 chars). The instructor token
must be scoped to the cohort and selected registry profile. Course ownership is
the signed instructor identity (`u`), not a credential's rotating JTI. Other
owners receive 404 to avoid disclosing content. Profile scope is checked for
both drafts and old versions. There is no admin bypass on these endpoints.

## Content and compatibility

`worker/src/lib/session-design.ts` defines `hps-session-design/1`: title,
audience, duration_minutes, objective, prerequisites, starter reference, and
ordered steps (id/title/instructions/hint/acceptance). Unknown schema or fields
are rejected. Draft text may be incomplete; freezing requires core fields and
at least one complete step. This slice saves starter references, not uploaded
projects. It neither grants tools nor pins a profile.

Frozen documents reuse `hps-module/1`, kind `session-design`, with an m* version
and checksum from the existing module builder. The existing generic module
validator remains envelope-only for session-design; the authoring API validates
its content. A frozen document is not a successful rehearsal or an active class.
Existing clients and existing curriculum pins are unaffected.

## Atomicity and retries

D1 is used for mutable drafts because the existing KV pin is eventually
consistent and cannot provide compare-and-swap editing semantics. Creation is
an insert-if-absent; update is a single conditional UPDATE by owner and revision.
Freeze is INSERT SELECT conditioned on the source revision at write time, so a
concurrent edit cannot freeze stale bytes. A version key is never updated.

The most recent request ID/hash is recorded. An identical immediate retry
returns the saved draft without advancing revision. Reuse with different bytes
conflicts. A delayed retry after a newer edit returns a revision conflict; it
does not overwrite the newer edit. Clients must retain their local text on 409
and explicitly reconcile, not automatically resubmit against the new revision.
Requests are bounded to 128 KiB; no credential field is part of the schema.

## Drift lock and execution

`worker/test/authoring.test.mjs` exercises the real Service app with signed
credentials and SQLite running the production SQL. `worker/test/authoring-d1.test.mjs`
checks the same path on local workerd/D1. `chalk/test/authoring-forward.test.mjs`
locks forwarding, header filtering, and propagated Service errors. These tests
are in package scripts; the D1 test is an explicit PR CI step.

## Migration and exit

Fresh databases use `worker/schema.sql`. Existing databases apply
`worker/migrations/0002-chalk-authoring.sql` explicitly after staging verification.
This change does not apply a remote migration or deploy. Apply the additive
migration before deploying code; the existing production migration gates remain.

To remove the feature, unmount the authoring router and remove its allowlist
entry. Preserve the two D1 tables for recovery/export; no deletion is required.
Existing sessions, module pins, tokens, and Chalk board continue unchanged.
Removing the forwarding test/CI step and the new validator then removes the
code. Destructive data cleanup is a separate decision.
