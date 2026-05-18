# Worker deploy — one-time setup + recurring deploys

Cloudflare Worker = HypeProof Studio's proxy + admin UI. Everything in this directory deploys as one Worker.

## Prereqs

- Cloudflare account (any plan, free works for poc; Workers Paid $5/mo if you need >100k req/day or Analytics Engine SQL)
- `wrangler` CLI (installed via `npm install` in this dir)
- Gemini API key (default provider — https://aistudio.google.com/apikey).
  Anthropic key if you switch `LLM_PROVIDER=anthropic` (a peer provider).

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
npx wrangler secret put GEMINI_API_KEY         # default provider (AIza...)
npx wrangler secret put HPS_SIGNING_SECRET     # openssl rand -hex 32
npx wrangler secret put HPS_ADMIN_PASSWORD     # dev fallback only; set Cloudflare Access in prod
# npx wrangler secret put ANTHROPIC_API_KEY    # when LLM_PROVIDER=anthropic in wrangler.toml

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
| Gemini (default) | generous free tier | 2.5 Pro: ~$1.25 in / $10 out per 1M tok |
| Anthropic (peer) | — | Sonnet 4.6: $3 in / $15 out per 1M tok |

No prompt caching on Gemini's OpenAI-compatible endpoint, so the skeleton
library (~few KB) re-sends each turn — fine for free-tier testing volumes.

1회차 estimate (6 kids × 8h × ~50 turns × 800 tokens average):
- 6 × 50 × 1600 = 480k tokens — within Gemini free tier for a single cohort
- Cloudflare: 6 × 50 = 300 req → well inside free tier
