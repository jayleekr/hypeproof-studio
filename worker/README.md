# worker/ — HypeProof Studio API (Cloudflare Worker)

OpenAI-compatible chat proxy + cohort/roster/session admin. Hosts:

- `POST /v1/chat/completions` — main hot path (HMAC-token gated, profile-scoped system prompt, prompt-cached)
- `GET  /v1/health`
- `GET  /admin/cohorts`, `/admin/cohorts/:id`, `/admin/cohorts/:id/usage`, `/admin/profiles`
- `POST /admin/cohorts/:id/roster`
- `POST /admin/cohorts/:id/session`, `DELETE` same
- `GET  /` — admin SPA (vanilla HTML, no build)

See [DEPLOY.md](./DEPLOY.md) for one-time setup + recurring deploy.

## Layout

```
worker/
├── wrangler.toml             # Cloudflare config (KV/D1/Analytics bindings)
├── schema.sql                # D1 schema
├── src/
│   ├── index.ts              # Hono router
│   ├── env.ts                # bindings type
│   ├── routes/
│   │   ├── chat.ts           # /v1/* — main proxy
│   │   └── admin.ts          # /admin/* — cohort mgmt
│   ├── lib/
│   │   ├── tokens.ts         # HMAC v2 issue/verify (Web Crypto)
│   │   ├── translate.ts      # OpenAI → Anthropic
│   │   ├── anthropic.ts      # streaming fetch wrapper
│   │   ├── sse.ts            # SSE transformer (Anthropic → OpenAI)
│   │   ├── kv.ts             # roster/session helpers
│   │   └── analytics.ts      # log to Workers Analytics + D1
│   ├── profiles/
│   │   ├── types.ts          # Profile shape, model alias map
│   │   ├── index.ts          # registry
│   │   └── sk-biopharm-kids-s1.ts
│   ├── prompts/
│   │   └── sk-biopharm-kids-s1.md
│   └── ui/
│       └── admin.html        # vanilla SPA
├── scripts/
│   └── issue-token.ts        # CLI: mint v2 tokens
└── DEPLOY.md                 # setup runbook
```

## Adding a new cohort (1 file changes typical)

1. Create `src/prompts/<cohort>-<session>.md` — full Korean/English system prompt with persona + safety rules
2. Create `src/profiles/<cohort>-<session>.ts` — import the MD, fill in `Profile` fields
3. Register in `src/profiles/index.ts` (append to REGISTRY)
4. `wrangler deploy`

That's it. No route changes, no schema changes.

## Token model

HMAC-SHA256 v2 payload: `{ u, c, p, iat, exp, v:2 }`.

- `u` = user id, cohort-local (e.g. `kid01`)
- `c` = cohort id (matches `profile.session.cohort_id`)
- `p` = profile id (selects system prompt + sandbox)
- `iat` / `exp` = unix seconds (typically `exp = iat + 168h` for an 8-week series)

Access check on every request:
1. Verify HMAC against `HPS_SIGNING_SECRET`
2. Confirm token cohort == profile cohort
3. Look up `cohort:<c>:active_session` in KV — must exist + within `starts_at..ends_at`
4. Look up `cohort:<c>:roster` — token's `u` must be in `users[]`
5. Confirm `session.profile_id == token.p` — token can't be used for a different session

Rotate `HPS_SIGNING_SECRET` → all outstanding tokens invalidated immediately.

## Local dev

```bash
cd worker
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars
echo "HPS_SIGNING_SECRET=$(openssl rand -hex 32)" >> .dev.vars
echo "HPS_ADMIN_PASSWORD=dev" >> .dev.vars
npx wrangler dev
# → http://localhost:8787
```

Issue a local token:
```bash
HPS_SIGNING_SECRET=<same as .dev.vars>  \
  node --experimental-strip-types scripts/issue-token.ts \
  --user smoke --cohort sk-biopharm-2026-a --profile sk-biopharm-kids-2026-grade-3-4-s1 --hours 1
```

Open `http://localhost:8787/` (admin password `dev`) → add `smoke` to roster → start class → curl chat completions.
