# 24h Stability Sprint Progress — 2026-05-20

Epic: [#44](https://github.com/jayleekr/hypeproof-studio/issues/44) "24h Stability Hardening Sprint (D-6 for 2026-05-26)"

## Tier 1 — COMPLETE ✅

| # | Title | PR | Merged | Surface |
|---|---|---|---|---|
| #45 | S-02 Smoke heartbeat cron | #53 | 10:30 UTC | KV `heartbeat:last/fail_streak/alert` |
| #47 | S-12 Cohort kill-switch | #54 | 10:33 UTC | POST/DELETE `/admin/cohorts/:id/pause` |
| #46 | S-01 Session token revoke | #55 | 10:39 UTC | POST/DELETE/GET `/admin/tokens/revoke[d]` |
| #48 | S-04 Webview banner | #56 | 10:44 UTC | ErrorBoundary + ErrorBanner |

Elapsed real time: ~75 min.

## Live ops surface (combined effect)

```
                                ┌─────────────────────────────┐
                                │ Cron Trigger (every 15 min) │  ← #45
                                │ → heartbeat:last / :alert   │
                                └──────────────┬──────────────┘
                                               ↓
       ┌─────────────────────────────────────────────────────────────┐
       │                  api.hypeproof-ai.xyz                       │
       │                                                             │
       │  ┌──────────────────────────────────────────────────────┐   │
       │  │ Auth → token revoke check (#46) → cohort pause (#47) │   │
       │  │ → roster → upstream                                  │   │
       │  └──────────────────────────────────────────────────────┘   │
       └─────────────────────────────────────────────────────────────┘
                                               ↓
       ┌─────────────────────────────────────────────────────────────┐
       │  Studio.app webview                                         │
       │  ┌──────────────────────────────────────────────────────┐   │
       │  │  ChatErrorBoundary  (render-time crashes)            │   │
       │  │   └─ ChatPanel                                       │   │
       │  │       └─ ErrorBanner (SSE drops, retry, dismiss)     │   │  ← #48
       │  └──────────────────────────────────────────────────────┘   │
       └─────────────────────────────────────────────────────────────┘
```

## Operator quick-reference

| Threat | Action | API |
|---|---|---|
| Single token leaked | Revoke that jti | `POST /admin/tokens/revoke {jti, cohort, user, exp, reason}` |
| Cohort-wide problem | Pause cohort | `POST /admin/cohorts/:id/pause {reason?}` |
| Resume cohort | Unpause | `DELETE /admin/cohorts/:id/pause` |
| Status check | Poll heartbeat slot | `wrangler kv key get heartbeat:last --binding HPS_KV --remote` |
| Watch live | tail | `wrangler tail --format pretty` |
| Session-mid SSE drop | (no action — user sees "다시 보내기" button) | — |
| React crash in webview | (no action — user sees "다시 열기" button) | — |

## Tier 2 — D-1까지 (4 items, ~7.5h estimate)

- [ ] #49 S-07 Structured error + request-id
- [ ] #50 S-09 Admin /stats endpoint
- [ ] #51 S-05 Provider health probe (depends ✅ #45)
- [ ] #52 S-06 D1 nightly backup → R2

These are observability + post-mortem readiness, not D-day blockers.

## Next deploy step

`worker/wrangler.toml` now has `[triggers] crons = ["*/15 * * * *"]` — this needs a `wrangler deploy` from `worker/` to take effect in production (Jay/재형, per `worker/DEPLOY.md`).

The webview changes need a Studio `.app` rebuild for production rollout — but the existing v0.1.0 already-installed builds will continue to work; the banner improvements only land in v0.1.1 which we cut after rehearsal.
