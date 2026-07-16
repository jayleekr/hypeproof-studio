# HypeProof Studio — operator runbook

Short, copy-pasteable commands for the most common workshop-time interventions.
Audience: instructors and the on-call operator. Assumes you have a worker
**admin password** OR an **issuer token with `can_start_session` scope** (#167).

---

## start-session

> Student banner says **"수업이 아직 시작 전이에요"** → cohort has no active
> session. Open one.

### Option 1 — issuer token (preferred, no admin password needed)

Each instructor was given a long-lived issuer token (see Discord
`#hypeproof-studio` channel pinned). If yours includes
`can_start_session: true` in its scope, you can open the session yourself:

```bash
TOKEN='<your-issuer-token>'
NOW=$(date -u +%FT%TZ)
END=$(date -u -v+2H +%FT%TZ)   # 2-hour window (max 4h per token policy)

curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/cohorts/<COHORT_ID>/session \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"profile_id\":\"<PROFILE_ID>\",\"starts_at\":\"$NOW\",\"ends_at\":\"$END\"}"
```

Replace `<COHORT_ID>` (e.g. `boah-dental-2026-a`) and `<PROFILE_ID>`
(e.g. `boah-dental-teaser-2026-s1`). The cohort + profile must match your
token's scope or the worker returns 403 with a clear message.

End the session early (e.g. workshop wrapped before window closes):

```bash
curl -fsS -X DELETE https://api.hypeproof-ai.xyz/admin/cohorts/<COHORT_ID>/session \
  -H "Authorization: Bearer $TOKEN"
```

### Option 2 — admin password fallback

If issuer tokens are down (rotated secret, expired) and you have the admin
password, the same endpoint accepts HTTP Basic:

```bash
NOW=$(date -u +%FT%TZ); END=$(date -u -v+2H +%FT%TZ)

curl -fsS -u ":$HPS_ADMIN_PASSWORD" \
  -X POST https://api.hypeproof-ai.xyz/admin/cohorts/<COHORT_ID>/session \
  -H 'content-type: application/json' \
  -d "{\"profile_id\":\"<PROFILE_ID>\",\"starts_at\":\"$NOW\",\"ends_at\":\"$END\"}"
```

### Verify

```bash
curl -fsS https://api.hypeproof-ai.xyz/admin/cohorts | jq '.cohorts[] | select(.id=="<COHORT_ID>")'
```

`session.starts_at` and `session.ends_at` should reflect the values you set.

---

## mint-student-token

> A student needs a token but yours was never issued / lost. Use your issuer
> token to mint a fresh one:

```bash
TOKEN='<your-issuer-token>'

curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/tokens/issue \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"u":"<student-handle>","c":"<COHORT_ID>","p":"<PROFILE_ID>","hours":6}'
```

Response includes `token` — give it to the student, they paste into Studio's
token prompt (▷ Settings → Token).

---

## pause-cohort (emergency stop)

> Hard 503 every chat request. Use only when an active session needs to halt
> immediately (model misbehaving, safety incident, mass-mistake). Requires
> admin password — issuer tokens do not have this scope by design.

```bash
curl -fsS -u ":$HPS_ADMIN_PASSWORD" \
  -X POST https://api.hypeproof-ai.xyz/admin/cohorts/<COHORT_ID>/pause \
  -H 'content-type: application/json' \
  -d '{"reason":"<one-line reason>"}'

# Unpause:
curl -fsS -u ":$HPS_ADMIN_PASSWORD" \
  -X DELETE https://api.hypeproof-ai.xyz/admin/cohorts/<COHORT_ID>/pause
```

---

## revoke a departing/compromised member's issuers (#313)

> A member leaves, or an admin-tier minter token (`can_issue_issuers`) leaks.
> Revoking the minter blocks any FURTHER mints immediately, but the instructor
> issuers it already signed stay valid until their own expiry (≤90 days). Find
> that lineage and revoke each live one. Admin password (or CF Access) only —
> a Bearer minter cannot enumerate other operators' issuers.

```bash
MINTER='<member-handle>'   # the `minted_by` value, e.g. the departing member

# 1. Revoke the minter itself so it can mint nothing new.
#    (jti + exp from your records or the /admin/issuers row below.)
curl -fsS -u ":$HPS_ADMIN_PASSWORD" \
  -X POST https://api.hypeproof-ai.xyz/admin/tokens/revoke \
  -H 'content-type: application/json' \
  -d '{"jti":"<minter-jti>","reason":"member offboarding"}'

# 2. List every issuer that minter created. `revoked`/`expired` rows need no
#    action — only live ones do.
curl -fsS -u ":$HPS_ADMIN_PASSWORD" \
  "https://api.hypeproof-ai.xyz/admin/issuers?minted_by=$MINTER" | jq .

# 3. Revoke each still-live jti from that list (repeat per jti). `exp` (unix
#    seconds) sets the revocation TTL so it outlives the token.
curl -fsS -u ":$HPS_ADMIN_PASSWORD" \
  -X POST https://api.hypeproof-ai.xyz/admin/tokens/revoke \
  -H 'content-type: application/json' \
  -d '{"jti":"<lineage-jti>","exp":<exp>,"reason":"minter revoke cascade"}'

# 4. Re-run step 2 to confirm every row now shows a non-null `revoked`.
```

There is no one-shot cascade endpoint by design — a bulk revoke on a stale
`minted_by` match is high blast-radius, so the operator reviews the list before
killing each token. See [#313](https://github.com/jayleekr/hypeproof-studio/issues/313).

---

## I lost everything

- Issuer token: ask Jay to mint a fresh one via
  `worker/scripts/issue-issuer-token.ts` (see commit history for prior
  arguments).
- Admin password: rotate via `wrangler secret put HPS_ADMIN_PASSWORD` —
  requires `wrangler login` against the Cloudflare account.
- Both gone simultaneously: see [#164](https://github.com/jayleekr/hypeproof-studio/issues/164)
  recovery path. The long-term answer is CF Access policy on `/admin/*`.

---

Related: [#165](https://github.com/jayleekr/hypeproof-studio/issues/165) (UX context for why this doc exists), [#167](https://github.com/jayleekr/hypeproof-studio/issues/167) (issuer session control).
