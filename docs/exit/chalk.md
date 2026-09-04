# Exit plan — Chalk (instructor surface)

Admission gate 4 (`docs/plan/vessel-and-modules.md` §5) for the `chalk` entry in `products.yaml`.

Chalk can be removed in one Service deploy plus one Cloudflare deletion, with no participant impact and no data loss, because it owns no state and no writes. Everything it serves is either a page or a read over bindings the Service also holds.

1. **Service side (one `w*` deploy).** Delete the two redirect lines for `/issuer` and `/console` in `worker/src/index.ts` and the `HPS_CHALK_ORIGIN` var. Either re-mount the two pages from `chalk/src/ui/` back under `worker/src/ui/` and re-add `GET /admin/cohorts/:id/state` to `worker/src/routes/admin.ts` (its previous home — the handler body is `chalk/src/routes/state.ts`, the auth helper already lives in `worker/src/lib/instructor-auth.ts`, and `isIssuerAllowedEndpoint` there gets its `GET …/state` line back), or drop them if the instructor surface is being replaced by something else.
2. **Cloudflare.** `wrangler delete` the `hypeproof-chalk` Worker; the `chalk.hypeproof-ai.xyz` custom domain goes with it. The KV namespace and D1 database belong to the Service and are untouched.
3. **Callers.** Repoint the `hype-session` skill (`status` action) and `docs/runthrough-commands.md`; delete `.github/workflows/deploy-chalk.yml` and the two `chalk-*` jobs in `pr-ci.yml`. `tests/load` already reads state through the Service's `GET /admin/cohorts/:id`.
4. **Registry.** Remove the `chalk` entry from `products.yaml` and delete `chalk/`; `scripts/check-registry.py` passes again with no directory left to claim.

Task G added a third page (`GET /board`) and a third read (`GET /admin/cohorts/:id/board`, `chalk/src/routes/board.ts`). They move under step 1 exactly like `/console` and `/state`, and they add nothing to steps 2–4: the board writes nothing, holds no state, and reads only `usage_log` plus the task-E liveness keys the Service already writes. Its one piece of configuration is the optional `HPS_ERROR_SIGNAL_FROM` var, which is deleted with the Worker. The calibration that gives the board its numbers is data, not code — `chalk/test/fixtures/session-2026-08-22.json` is a frozen read-only copy of production rows and survives removal as evidence for whatever replaces it.

Nothing in the participant runtime, the Studio app, or the curriculum knows Chalk exists; the only pointer is the Service's redirect hostname. Instructor links shared on KakaoTalk (`…/console#t=<token>`) keep working across the removal only if step 1 re-mounts the pages on the Service — do it in that form when a cohort is mid-series.
