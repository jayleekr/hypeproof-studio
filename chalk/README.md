# Chalk — the instructor surface

Its own Cloudflare Worker (`hypeproof-chalk`, `chalk.hypeproof-ai.xyz`), Surface layer, tag prefix `c*`. Plan: `docs/plan/vessel-and-modules.md` §1–§2, task F in `docs/plan/dag.yaml`. Registry entry: `products.yaml` → `chalk`. Exit plan: `docs/exit/chalk.md`.

## What lives here

| Route | What | Auth |
|---|---|---|
| `GET /console` | instructor session console (#352) | page is public; its API calls carry the issuer Bearer |
| `GET /issuer` | self-service student-token mint page | same |
| `GET /board` | instructor live board page (#674) — every seat, one row each, 10 s polling | page is public; its API calls carry the issuer Bearer |
| `GET /admin/cohorts/:id/state` | read-only cohort state the console renders | instructor issuer Bearer, any scope on the cohort |
| `GET /admin/cohorts/:id/board` | live board JSON — seat verdicts + the thresholds that produced them | instructor issuer Bearer, any scope on the cohort |
| `GET /admin/cohorts/:id/logs` | studio-logs arrival check + roster diff (#680) | instructor issuer Bearer, or operator |
| `GET /admin/cohorts/:id/logs/:seat` | per-session rows for one seat: ids, bytes, times | instructor issuer Bearer, or operator |
| `GET /admin/cohorts/:id/logs/:seat/:day/:session/:file` | **retrieval** — the raw session file | **operator only** (Cloudflare Access, or `x-hps-operator-secret`) |
| `* /admin/*` (instructor writes) | session open/close, roster append, token mint — **forwarded** to the Service | Bearer only; Basic refused |
| `GET /health` | `{ ok, service, version }` — the `c*` tag via `HPS_CHALK_VERSION` | none |

The split rule (task F): **Chalk owns what instructors read; the Service owns what the participant gate reads — and therefore every write to it, and every token signature.** Chalk verifies tokens with the Service's own verifier (`src/shared.ts` re-exports `worker/src/lib/instructor-auth.ts` + `tokens.ts`; `test/instructor-auth-drift.test.mjs` proves both workers give identical verdicts). Chalk never mints, never writes KV, has no admin password, no cron.

### studio-logs read path (#680, plan task I)

`studio-logs/` in R2 was write-only until this landed: nothing read or listed it, and confirming whether the 2026-08-22 logs had arrived took twelve days of dashboard-squinting. Three read-only capabilities, no deletion — that is explicitly out of scope and the drift lock asserts this worker contains no R2 `put` or `delete`.

**The roster is cumulative.** `cohort:sk-biopharm-2026-a:roster` held **340** handles on 2026-09-03 — every batch ever minted for the cohort, plus probes. An unscoped diff names 317 seats as missing, which is noise. Scope to one class with `?seat_prefix=`, and read `roster_scope` in the response to see which scope was applied:

```
GET /admin/cohorts/sk-biopharm-2026-a/logs?day=2026-08-22&seat_prefix=SK34-CM6YPX-
  -> uploaded 9 / 15,  missing: -01 -11 -12 -13 -14 -15
```

**Why retrieval is operator-only.** `events.jsonl` carries participant question text verbatim (`docs/session-log-consent.ko.md`), and the 2026-08-22 cohort is a minors cohort. The listing half is metadata — seat ids, counts, timestamps, bytes — and keeps the ordinary instructor gate. The retrieval half is not metadata, so it takes a different credential: Cloudflare Access, or a **dedicated** `HPS_LOGS_OPERATOR_SECRET` in the `x-hps-operator-secret` header. Not the Service's `HPS_ADMIN_PASSWORD` (too broadly held), not an instructor token, and not the `Authorization` slot that already means "instructor token" on this worker. Unset ⇒ retrieval returns 503, fail closed. Retrieval also re-checks the cohort's `analytics.upload_session_logs` opt-in, so withdrawing consent closes the read door too, not only the write door. Full reasoning: the header of `src/routes/logs-admin.ts`.

Deliberately left in the Service: the operator surface (`/` admin SPA, `/admin/stats`, cohorts list/detail/usage, reports, issuer minting and lineage — all admin Basic / CF Access) and every instructor write. Operator tools that read cohort state with Basic auth use `GET /admin/cohorts/:id` on the Service.

## Deploy

```
git tag c0.1.0 && git push origin c0.1.0     # .github/workflows/deploy-chalk.yml
```

The workflow tests, typechecks, deploys from `chalk/` only, verifies `/health` reports the tag, and asserts the Service's `GET /v1/health` version is the same before and after. It never touches `worker/`.

**First rollout order: Chalk first, then the Service.** The Service (from the same commit) turns `/console` and `/issuer` into redirects to `HPS_CHALK_ORIGIN`; if it ships first, instructors are redirected to a hostname that does not exist yet.

One-time setup:

```
cd chalk
npx wrangler secret put HPS_SIGNING_SECRET     # the SAME value as the Service — one HMAC key, two verifiers
```

Optionally, and only if session-log retrieval should be reachable without Cloudflare Access:

```
npx wrangler secret put HPS_LOGS_OPERATOR_SECRET   # NOT the Service's admin password. >=16 chars.
```

Leaving it unset is the safe default — retrieval then requires Cloudflare Access and 503s otherwise. `HPS_CHALK_VERSION` is injected per deploy; `HPS_SERVICE_ORIGIN` is a var in `wrangler.toml`.

## Local dev

```
cd worker && npx wrangler dev --env dev                       # Service on :8787 (env.dev redirects /console → :8788)
cd chalk  && cp ../worker/.dev.vars .dev.vars && npx wrangler dev --env dev --port 8788
```

Only `HPS_SIGNING_SECRET` from `.dev.vars` is read here.

## Test

```
cd worker && npm ci      # shared auth module; the drift lock boots the Service app in-process
cd chalk  && npm ci && npm test && npm run typecheck
```

`test/deploy-isolation.test.mjs` and `test/instructor-auth-drift.test.mjs` are the two task-F controls; `test/board-contract.test.mjs` is the registry drift lock (both `/state` and `/board`); `test/board-threshold.test.mjs` is task G's calibration replay.

## The live board (task G, #674)

Read `docs/plan/vessel-and-modules.md` §4 before changing a column. Four rules, none negotiable:

1. **Every roster row is always rendered.** A quiet seat is the one you most want to see, and a "recent N rows" panel is exactly where it disappears. On 2026-08-22 two roster seats made *zero* calls all day and appear nowhere in `usage_log`.
2. **First column is time-since-last-turn**, ahead of any performance number.
3. **Readable in two seconds**, on a phone, while walking the room.
4. **Zero prompt text.** Latency, counts, error class, elapsed time, an artifact-changed boolean. Nothing a participant wrote. PIPA Art. 22-2 (verified guardian consent under 14) is why this surface is shippable for minor cohorts at all — metadata only is the entire licence. A "recent question preview" column will be the most tempting feature here and it crosses that line.

**The thresholds live here, not in the client** (spec §1). They are derived from the labelled 2026-08-22 session, documented with their distribution at the top of `src/lib/board-verdict.ts`, served in the `/board` response, and replayed by `test/board-threshold.test.mjs` — which runs the *production* SQL against a real SQLite loaded with the real rows, checks both controls, and then perturbs each threshold to prove a control can actually break.

Two honest gaps, both rendered as **unknown** and announced in `degraded[]`, never as a false negative:

| Column | Blocked on | Reads |
|---|---|---|
| `failures_*` | task B live in production, then set `HPS_ERROR_SIGNAL_FROM` | `null` until a non-2xx row exists or the var covers the window |
| `heartbeat` | task E in a Studio release the seats actually run | `unknown` until a ping arrives |

The seat set is the one thing §4 did not settle: `cohort:<id>:roster` is **cumulative** (340 ids in production). Pass `?seat_prefix=SK34-CM6YPX-` for the full batch — that is rule 1 in full. Without it the board shows only seats observed this session and says so.

## Course drafts

`/authoring` (linked from `/console`) imports `hps-authoring-batch/1` or an exported single course, edits teaching fields and ordered steps, and saves through the existing Service authoring contract (ADR 0004). Paste the instructor token and scope IDs; credentials stay in memory. A frozen version is inactive and unverified. A 409 preserves the local form; export before explicitly reloading the saved copy. GitHub request preparation is not receipt.

Removal: remove the page route/import and console link; retain Service drafts and versions for export/recovery. No migration or participant-gate change is part of this Surface slice. Browser check: `npm --prefix e2e run test:chalk-authoring`.
