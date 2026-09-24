# Worker deploy — one-time setup + recurring deploys

Cloudflare Worker = HypeProof Studio's proxy + admin UI. Everything in this directory deploys as one Worker.

## Prereqs

- Cloudflare account (any plan, free works for poc; Workers Paid $5/mo if you need >100k req/day or Analytics Engine SQL)
- `wrangler` CLI (installed via `npm install` in this dir)
- **Anthropic API key — required.** `/v1/messages` (the Agent SDK coach runtime,
  which most profiles use) always calls Anthropic with `ANTHROPIC_API_KEY`,
  regardless of `LLM_PROVIDER` or a profile's provider pin. The native-observation
  assessor does too. A deployment without it cannot serve those paths.
- A key for whichever provider `LLM_PROVIDER` names, for `/v1/chat/completions`:
  Gemini (https://aistudio.google.com/apikey), OpenAI, or GLM. Production sets
  `anthropic`, so the same key covers both routes; `[env.dev]` sets `gemini`.

## One-time setup

```bash
cd worker
npm install

# 1. Log in
npx wrangler login

# 2. Create KV namespace (cohort/session/roster state)
npx wrangler kv:namespace create HPS_KV
npx wrangler kv:namespace create HPS_KV --preview
# → wrangler prints the `id` and `preview_id` — paste both into wrangler.toml

# 3. Create D1 database (usage_log + history)
npx wrangler d1 create hypeproof-studio
# → wrangler prints `database_id` — paste into wrangler.toml

# 4. Apply schema
npx wrangler d1 execute hypeproof-studio --remote --file=schema.sql

# 5. Set secrets (interactive — paste values when prompted)
npx wrangler secret put ANTHROPIC_API_KEY      # REQUIRED — /v1/messages always uses it
npx wrangler secret put HPS_SIGNING_SECRET     # openssl rand -hex 32
npx wrangler secret put HPS_ADMIN_PASSWORD     # dev fallback only; set Cloudflare Access in prod
# The instructor surface (/console, /issuer, cohort state reads) is a SEPARATE
# Worker since plan task F — chalk/ (chalk.hypeproof-ai.xyz, c* tags). It needs
# the SAME HPS_SIGNING_SECRET: see chalk/README.md. Deploy Chalk BEFORE this
# worker on the first rollout (this worker redirects /console there).
# npx wrangler secret put GEMINI_API_KEY       # when LLM_PROVIDER=gemini (AIza...)
# npx wrangler secret put OPENAI_API_KEY        # when LLM_PROVIDER=openai in wrangler.toml
# npx wrangler secret put GLM_API_KEY           # when LLM_PROVIDER=glm (never picked implicitly)

# Bug-report Discord webhook (#64): create a webhook in #hypeproof-studio →
# Integrations → Webhooks, paste the URL. Optional — unset = D1 row only, no
# Discord side-effect.
# npx wrangler secret put DISCORD_REPORT_WEBHOOK_URL

# 6. (Optional) Custom domain
#    In Cloudflare dashboard → Workers → hypeproof-studio-api → Custom Domains
#    Add: api.hypeproof-ai.xyz
#    Then uncomment the `routes = [...]` line in wrangler.toml.
```

## First deploy

```bash
npx wrangler deploy
# → prints public URL like https://hypeproof-studio-api.<your-subdomain>.workers.dev
```

## Smoke test

```bash
# Health (no auth)
curl https://hypeproof-studio-api.<sub>.workers.dev/v1/health

# Issue a token (locally, not in Worker)
HPS_SIGNING_SECRET=<same as Worker secret> \
  node --experimental-strip-types scripts/issue-token.ts \
  --user smoke --cohort sk-biopharm-2026-a --profile sk-biopharm-kids-2026-grade-3-4-s1 --hours 1

# Try chat without active session → expect 403
curl -X POST https://<worker>/v1/chat/completions \
  -H "authorization: Bearer <TOKEN>" \
  -H "content-type: application/json" \
  -d '{"model":"hypeproof-default","stream":false,"max_tokens":50,
       "messages":[{"role":"user","content":"안녕"}]}'

# Set roster + start a class via admin UI:
#   Browser → https://<worker>/   (will prompt for admin password / Cloudflare Access)
#   Add "smoke" to roster of sk-biopharm-2026-a
#   Start class with profile sk-biopharm-kids-2026-grade-3-4-s1, 8h window

# Retry chat → expect streamed reply in Korean
```

## Recurring deploys

```bash
# After editing source code, profiles, or system prompts:
npx wrangler deploy

# Tail live logs:
npx wrangler tail

# Edit / rotate the active key:
npx wrangler secret put GEMINI_API_KEY
```

### Rollback floors

Frozen Chalk lessons are re-validated on every read with the *current*
`validateSessionDesign`. A Service older than the change that introduced a
lesson field cannot read a frozen version carrying it and returns
`409 lesson_unavailable` to every seat delivered from that version.

| Field | Introduced by | Do not roll the Service back below |
|---|---|---|
| `assistant.display_name` (ADR-0005) | #747 feature A | the first deploy that includes it, once any instructor has frozen a named version |
| `model` with Service-produced binding (ADR-0006) | #792 | the first deploy supporting the field, after a model-configured lesson is frozen |

Deploy order for a lesson-schema change: Service first, then Chalk. A newer
Chalk against an older Service fails the draft save with
`400 invalid session-design fields` (the edit is preserved).

## Cloudflare Access (recommended for /admin/*)

`wrangler` can't configure Access — do it once via the Cloudflare dashboard:

1. Zero Trust → Access → Applications → Add → Self-hosted
2. Application name: `HypeProof Studio Admin`
3. Subdomain: `api.hypeproof-ai.xyz`, Path: `/admin/*` and `/`
4. Identity providers: Google OAuth (or email OTP)
5. Policy: Include → Emails → `jaylee@...`
6. Save

After this, `/admin/*` and `/` are gated by Cloudflare login. The Worker still falls back to `HPS_ADMIN_PASSWORD` for `wrangler dev` and curl admin smoke tests.

## Costs (rough estimate)

| | Free tier | Beyond |
|---|---|---|
| Workers req | 100k/day | $0.50 / 1M (Paid plan $5/mo base) |
| KV reads | 100k/day | $0.50 / 1M |
| D1 storage | 5 GB | $0.75 / GB/mo |
| Anthropic (production) | — | Sonnet 4.6: $3 in / $15 out per 1M tok (native prompt caching) |
| Gemini (peer, `[env.dev]`) | generous free tier | pins are 2.5-flash / 3.5-flash; no alias points at 2.5 Pro any more |
| OpenAI (peer) | — | gpt-4o: ~$2.5 in / $10 out per 1M tok (alias map in profiles/types.ts) |
| GLM (peer, explicit only) | — | glm-5.2; all three aliases map to it |

Prompt caching: Anthropic supports it natively (the few-KB skeleton library
becomes cached reads after the first turn → cost ↓ + latency ↓). Gemini's
OpenAI-compatible endpoint does not cache. OpenAI cache behavior is GA but
not auto-applied here — leave as a future tweak per cohort.

1회차 estimate (6 kids × 8h × ~50 turns × 800 tokens average):
- 6 × 50 × 1600 = 480k tokens — at the production pin (Sonnet 4.6) roughly $1.4 in
  / $7 out per cohort before prompt caching, which the skeleton library makes most of
- Cloudflare: 6 × 50 = 300 req → well inside free tier

## Adult model comparison (#841)

Apply the additive `migrations/0006-model-usage.sql` before deploying this feature;
the guarded deploy workflow includes this idempotent step. Existing usage_log and
classes are unchanged. The new hidden studio-model-practice profile stays closed
until HPS_MODEL_PRACTICE_REQUEST_LIMIT is explicitly set (1..10000 attempts per
seat/session). No production number is supplied by this change. It is not a dollar
or token spending cap. OpenAI, GLM, Gemini and Anthropic credentials stay in Worker
Secrets; registering a key does not grant models to existing cohorts.

Rollback: previous Worker source 18281a9 remains compatible with the additive
table. Preserve request evidence; do not drop tables or reset usage during rollback.
Unknown/pending execution requires operator reconciliation before general admission
is enabled; the follow-up budget/role UI is #800.

## Course effort settings (#799)

Apply additive `migrations/0005-request-settings.sql` before deploying the Service.
The worker deploy workflow applies it idempotently. Then deploy Chalk and the App.
`usage_request_settings` contains request-setting metadata only; `usage_log` remains
the usage source. A missing table/write/read yields an unconfirmed UI receipt, never
a successful-settings claim. Rollback keeps all data. Older Service builds do not
accept the new frozen effort schema: stop issuing new effort lessons and restore the
prior lesson/version before using an older Service. This does not change retention,
pricing, raw-content logging or existing students' credentials.

## Remote classroom operations (#751) — staging rehearsal, schema order, flags, recovery

Everything here is OFF until someone turns it on: no `HPS_CLASSROOM_OPS`, no per-run flag, no evaluator, no mail
provider, no retention period. Merging and deploying the code changes nothing a learner or instructor can see.
What each switch means is owned by `docs/requirements/classroom-admin.md`; this section is only the order of operations.

**Facts that shape the procedure (checked 2026-09-20).** Migrations are applied with `wrangler d1 execute --file`, so
there is no `d1_migrations` table: the schema itself is the applied history, read by
`scripts/classroom-ops-d1-check.mjs` (read-only). `deploy-worker.yml` applied 0002–0010 unconditionally and did not
know 0011–0023; it now has an explicit `apply_classroom_ops_schema` input (default off). `wrangler.toml` has no
staging environment — `[env.dev]` declares no D1/KV/R2 of its own and named environments do not inherit bindings, so
**a staging target does not exist yet and must not be improvised by pointing `--env dev` at production ids.**
0011–0023 contain only `CREATE TABLE|INDEX IF NOT EXISTS` (the D1 test asserts this), so order matters only for
readability and every file can be re-applied.

### 0. Staging target (once; needs the Cloudflare account — not done)

```bash
npx wrangler d1 create hypeproof-studio-staging          # note the uuid it prints
npx wrangler r2 bucket create hps-traces-staging
npx wrangler kv namespace create HPS_KV_STAGING
```

The staging pair is already in the repository as **separate files** — `wrangler.staging.toml` here and in `chalk/` —
so a plain `wrangler deploy` can never pick it up and nothing is inherited from production's file. Paste the three ids
printed above over the `REPLACE_WITH_STAGING_*` placeholders in BOTH files, then:

```bash
node scripts/classroom-ops-staging-check.mjs     # exit 2 = a placeholder remains · exit 1 = UNSAFE (something is production's) · 0 = independent
npx wrangler secret put HPS_SIGNING_SECRET -c wrangler.staging.toml    # a NEW value: a staging token must never open production
npx wrangler secret put ADMIN_PASSWORD     -c wrangler.staging.toml
npx wrangler deploy -c wrangler.staging.toml                            # prints the workers.dev URL → chalk's HPS_SERVICE_ORIGIN
(cd ../chalk && npx wrangler secret put HPS_SIGNING_SECRET -c wrangler.staging.toml && npx wrangler deploy -c wrangler.staging.toml)
```

The checker (also run by `npm run test:classroom-ops:review`) refuses any D1/KV/R2/dataset id or name, Worker name, route
or `*_ORIGIN` that production uses, and a Worker/Chalk staging pair that does not share the same staging resources.
Every later command in this section takes `-c wrangler.staging.toml` on staging. Removing staging afterwards is
`wrangler delete -c wrangler.staging.toml` for both Workers plus deleting the three staging resources; production is not involved.
Give staging production's real shape, not `schema.sql` (which already contains this feature): export production's
schema WITHOUT data (`npx wrangler d1 export hypeproof-studio --remote --no-data --output=<outside the repo>/prod-schema.sql`)
and execute that file against staging. Staging then starts exactly where production is, without a single production row.

### 1. Before touching any database — confirm the target and what it already has

```bash
npx wrangler whoami                                        # the account you expect?
node scripts/classroom-ops-d1-check.mjs --database <name> --expect-id <uuid>      # refuses if name→uuid differs
```

Expected before the first rollout: every file `not_applied`. `partial` or `out_of_order` (exit 1) means an earlier
attempt stopped midway: re-apply from the first file listed in `apply_next_in_this_order`; do not hand-edit tables.

### 2. Backup you can actually restore from

```bash
npx wrangler d1 export <name> --remote --output=backup-$(date -u +%Y%m%dT%H%MZ).sql      # keep OUTSIDE the repo
npx wrangler d1 time-travel info <name>                   # note the bookmark printed here in the rollout log
```

The nightly R2 backup (`cron/d1-backup.ts`) is a second copy, not the rollback plan. Because the migrations only ADD
tables, the rollback for a bad rollout is "flags off + previous Worker", not a restore. A restore
(`wrangler d1 time-travel restore <name> --bookmark=<bookmark>`) is for a damaged database only, rewinds EVERY table
including usage and budgets, and is a separate decision with its own confirmation.

### 3. Apply 0011 → 0023, then verify

```bash
for f in 0011-classroom-ops 0012-classroom-ops-commands 0013-classroom-ops-control 0014-classroom-ops-evidence-review \
         0015-classroom-collection 0016-classroom-report-jobs 0017-classroom-delivery 0018-classroom-snapshot-binding \
         0019-classroom-report-attempts 0020-classroom-viewer-check 0021-classroom-erasure-log \
         0022-classroom-collect-scope 0023-classroom-distribution; do
  npx wrangler d1 execute <name> --remote --file=migrations/$f.sql || break
done
node scripts/classroom-ops-d1-check.mjs --database <name> --expect-id <uuid> --require all
```

A migration added after 0023 for this feature goes to the end of both lists (here and in `deploy-worker.yml`); the
checker picks up any `migrations/00NN-*.sql` ≥ 0011 by itself. On production this step is the workflow input
`apply_classroom_ops_schema: true` on ONE deploy, after the staging rehearsal below has passed.

### 4. Deploy with everything off, and prove it is off

Deploy Service, then Chalk (`deploy-chalk.yml`), App last. With no `HPS_CLASSROOM_OPS`:
`curl -s -o /dev/null -w '%{http_code}' -X POST https://<service>/v1/classroom/ops/connect -d '{}'` → `404`;
Chalk `/manage` shows no operations panel; existing chat, board and budgets behave as before (`scripts/verify-prod.sh`).
The 15-minute cron runs erasure recovery on an empty ledger (one SELECT); without the tables it reports
`not_migrated` and does nothing.

### 5. Turn on in this order — one class run at a time, each step reversible by the line in step 6

| # | Switch (where) | Proves before moving on |
|---|---|---|
| 1 | `HPS_CLASSROOM_OPS=enabled` (Worker var; per-run flags still all false) | the routes exist but refuse: the instructor's pairing request for a run answers `403 ops_observe_disabled`, `/connect` answers `403 ticket_invalid` instead of `404 ops_disabled`; nothing else changed |
| 2 | run flag `ops_observe` (instructor's run configuration) | adult 2–3 seats pair, token/step/runtime appear, p95 of existing chat unchanged (AT-25/34) |
| 3 | `ops_commands` | low-risk actions first (`retry_diagnostics`, `send_question`), then one `cancel_current_run`, then one `reset_runtime` with file hashes before/after |
| 4 | `ops_collect` | only after the collection notice/consent decision; adult learners; withdrawal exercised once end to end incl. `GET /admin/classroom/erasures` → `settled` |
| 5 | `ops_reports` + `HPS_CLASSROOM_EVALUATOR=service-anthropic` | the limited model trial in `docs/testing/classroom-admin.md` passed; cost within the stated ceiling |
| 6 | `ops_delivery` + `HPS_DELIVERY_PROVIDER=resend` and its secrets | the limited mail trial passed; first real batch is dry-run, then test recipients only |
| 7 | `HPS_CLASSROOM_RETENTION_DAYS` (dry-run reports for ≥ 1 week) → `HPS_CLASSROOM_RETENTION=enforce` | the dry-run count matches what the operator expects to lose |

### 6. Recovery — stop new work first, keep the ledgers, never drop a table

| Symptom | Do | Do not |
|---|---|---|
| anything wrong with sending | unset `HPS_DELIVERY_PROVIDER` (live sends stop; `send_unknown` rows stay and are settled by webhook or by hand) | re-send a batch to "make sure" |
| evaluation cost or quality | unset `HPS_CLASSROOM_EVALUATOR` (jobs wait as `evaluator_not_configured`; drafts that exist are kept) | delete jobs |
| collection | run flag `ops_collect=false` (no new batch; a learner can still withdraw; pending erasures still finish) | turn off `HPS_CLASSROOM_OPS` to "stop deletion" — recovery of requested erasures is deliberately independent |
| commands misbehave | run flag `ops_commands=false` (queued commands expire; running ones report their own receipt) | assume a cancelled command was undone |
| everything | unset `HPS_CLASSROOM_OPS` (all routes 404, devices disconnect on next sync, chat is unaffected) → if needed deploy the previous Worker: it ignores the new tables | `DROP TABLE`, `time-travel restore` |
| retention deleted too much | `HPS_CLASSROOM_RETENTION` unset immediately; already-started erasures finish (content is unreachable the moment they start) | expect a restore to bring R2 objects back — it cannot |

After any rollback, `GET /admin/classroom/erasures?class_run_id=…` must show no `started` row older than a day with
`needs_operator=false`; a `needs_operator=true` row is a person's task, not a background one.

**Status 2026-09-21:** the staging files, the independence checker and its controls exist; the committed pair reports
`not_provisioned` (exit 2). No Cloudflare command was run, no resource was created, nothing was deployed.
The 2026-09-21 code changes (token evidence slot, spool sequence contract, `coverage_reason`) add **no migration**: they live
in `ops_latest_state.state_json`, the snapshot binding JSON and the audit detail.

**Status 2026-09-20:** steps 1–3 rehearsed on local workerd D1 with the same checker (`npm run test:classroom-ops:d1`:
none → interrupted → all → re-applied, plus a half-created negative control). Steps 0 and 1–6 against a real
Cloudflare staging or production target: NOT RUN — no staging target exists and no account action was taken.

### Viewer-check signing-secret rotation

Recipient viewer-check hashes use `HPS_SIGNING_SECRET`. Rotating this secret also
invalidates existing imported checks: coordinate a fresh recipient import with
new salts/check hashes before reopening report links. Do not enable delivery
with stale checks or treat the rotation as transparent to existing recipients.
