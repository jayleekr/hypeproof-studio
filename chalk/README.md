# Chalk — the instructor surface

Its own Cloudflare Worker (`hypeproof-chalk`, `chalk.hypeproof-ai.xyz`), Surface layer, tag prefix `c*`. Plan: `docs/plan/vessel-and-modules.md` §1–§2, task F in `docs/plan/dag.yaml`. Registry entry: `products.yaml` → `chalk`. Exit plan: `docs/exit/chalk.md`.

## What lives here

| Route | What | Auth |
|---|---|---|
| `GET /console` | instructor session console (#352) | page is public; its API calls carry the issuer Bearer |
| `GET /issuer` | self-service student-token mint page | same |
| `GET /admin/cohorts/:id/state` | read-only cohort state the console renders | instructor issuer Bearer, any scope on the cohort |
| `* /admin/*` (instructor writes) | session open/close, roster append, token mint — **forwarded** to the Service | Bearer only; Basic refused |
| `GET /health` | `{ ok, service, version }` — the `c*` tag via `HPS_CHALK_VERSION` | none |

The split rule (task F): **Chalk owns what instructors read; the Service owns what the participant gate reads — and therefore every write to it, and every token signature.** Chalk verifies tokens with the Service's own verifier (`src/shared.ts` re-exports `worker/src/lib/instructor-auth.ts` + `tokens.ts`; `test/instructor-auth-drift.test.mjs` proves both workers give identical verdicts). Chalk never mints, never writes KV, has no admin password, no cron.

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

No other secret. `HPS_CHALK_VERSION` is injected per deploy; `HPS_SERVICE_ORIGIN` is a var in `wrangler.toml`.

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

`test/deploy-isolation.test.mjs` and `test/instructor-auth-drift.test.mjs` are the two task-F controls; `test/board-contract.test.mjs` is the registry drift lock (task G extends it with `/board`).
