# JY dev review — instructor mode

Procedure for reviewing instructor-mode changes locally before merge.
Do not use the production server (`api.hypeproof-ai.xyz`) for this check.

## Setup

1. Start local worker:

   ```sh
   cd worker
   wrangler dev --local
   # listening on http://localhost:8787
   ```

2. Open HypeProof Studio Dev in isolated mode (see `docs/dev/studio-dev.md`).

3. In VS Code settings, set:

   ```json
   "hypeproofChat.proxyUrl": "http://localhost:8787/v1"
   ```

## Issuer token

Mint a short-lived issuer token against the local worker. The worker must have
`HPS_SIGNING_SECRET` set in `.dev.vars` (never committed).

```sh
curl -su admin:$LOCAL_ADMIN_PW http://localhost:8787/admin/issuers \
  -X POST -H 'Content-Type: application/json' \
  -d '{"issuer":"jy-review","scopes":[{"cohort":"<COHORT>"}],"ttl":3600}'
```

Paste the returned token into Studio Dev's token field.

## Checks

1. Whoami returns `role: issuer`: `GET http://localhost:8787/admin/chalk/whoami`
2. Instructor brief returns non-empty text: `GET http://localhost:8787/admin/chalk/instructor-brief`
3. Instructor chat panel opens in the extension (top strip visible).
4. Student token → panel does **not** open.
