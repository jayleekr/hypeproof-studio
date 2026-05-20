# 24h Stability Sprint — COMPLETE — 2026-05-20

Epic: [#44](https://github.com/jayleekr/hypeproof-studio/issues/44) (closed)

8 PRs, ~70 min real time. All Tier 1 + Tier 2 items shipped.

## Merged PRs

| # | Title | PR | Tier |
|---|---|---|---|
| #45 | S-02 Smoke heartbeat cron | [#53](https://github.com/jayleekr/hypeproof-studio/pull/53) | 1 |
| #46 | S-01 Session token revocation | [#55](https://github.com/jayleekr/hypeproof-studio/pull/55) | 1 |
| #47 | S-12 Cohort kill-switch | [#54](https://github.com/jayleekr/hypeproof-studio/pull/54) | 1 |
| #48 | S-04 Webview SSE error boundary | [#56](https://github.com/jayleekr/hypeproof-studio/pull/56) | 1 |
| #50 | S-09 Admin /stats endpoint | [#57](https://github.com/jayleekr/hypeproof-studio/pull/57) | 2 |
| #51 | S-05 Provider health probe | [#58](https://github.com/jayleekr/hypeproof-studio/pull/58) | 2 |
| #49 | S-07 Structured error + request-id | [#59](https://github.com/jayleekr/hypeproof-studio/pull/59) | 2 |
| #52 | S-06 D1 nightly backup → R2 | [#60](https://github.com/jayleekr/hypeproof-studio/pull/60) | 2 |

## Operator surface during 보아치과 티저 세션 (2026-05-26)

```
┌─────────────────────────────────────────────────────────────────────┐
│   Cron triggers                                                     │
│     */15 * * * *  → heartbeat → KV heartbeat:{last,alert}     #45   │
│     0 17 * * *    → D1 → R2 backup (14d retention)            #52   │
└─────────────────────────────────────────────────────────────────────┘
              ↓                                       ↑
┌─────────────────────────────────────────────────────────────────────┐
│   api.hypeproof-ai.xyz                                              │
│                                                                     │
│   Auth path                                                         │
│     verify(token)                                                   │
│     → if revoked(jti)  → 401 type:auth code:revoked          #46    │
│     → if cohort_paused → 503 type:cohort_paused              #47    │
│     → roster + session window checks                                │
│                                                                     │
│   Operator endpoints (admin Basic)                                  │
│     POST   /admin/tokens/revoke {jti, cohort, user, exp}     #46    │
│     POST   /admin/cohorts/:id/pause {reason?}                #47    │
│     DELETE /admin/cohorts/:id/pause                          #47    │
│     GET    /admin/stats                                       #50   │
│     GET    /v1/health/deep                                    #51   │
│                                                                     │
│   Every response: x-request-id header                         #49   │
│   Every onError JSON: {error:{type, message, request_id}}     #49   │
└─────────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────────┐
│   Studio.app webview                                                │
│     <ChatErrorBoundary>                                       #48   │
│       <ChatPanel>                                                   │
│         + ErrorBanner (다시 보내기 / 닫기 + ID:<8char>)      #48 #49 │
└─────────────────────────────────────────────────────────────────────┘
```

## Deploy gate

Two distinct rollouts required:

### Worker (immediate)
```bash
cd worker
npx wrangler deploy
# activates: heartbeat cron, D1 backup cron, admin endpoints, /v1/health/deep, request-id middleware
```

Smoke after deploy:
```bash
curl -fsS https://api.hypeproof-ai.xyz/v1/health -i | grep -i x-request-id      # request_id middleware live
curl -fsS https://api.hypeproof-ai.xyz/v1/health/deep -H "Authorization: Basic $AUTH" | jq .   # deep probe
npx wrangler kv key get heartbeat:last --binding HPS_KV --remote               # wait 15min, should be populated
```

### Studio.app (next build)
Tier 1 #48 webview changes + Tier 2 #49 request_id banner ship in v0.1.1, cut after the 5/23 rehearsal. v0.1.0 (already in operator hands) keeps working — it just doesn't have the new banner. Banner is *additive*, not a behavior change.

## Deferred (post-D-day sprint)

- Per-token rate limit (Durable Object migration needed)
- Profile content lint (no direct D-day impact)
- Token issuance hardening (depends on this S-01)
- #42 cold-launch UX (worked around via pre-DM'd tokens)
