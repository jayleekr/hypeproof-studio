# Handoff — the four things only a human can do

> Everything else in this plan is done and green on `plan/all` (PR #691).
> These four are **repo/Cloudflare settings and one tag**. No code changes.
>
> Each step has a command and a way to know it worked. Do them in order — step 3
> has an ordering constraint that will bite if skipped.

---

## 0. Merge PR #691

```bash
gh pr view 691 --repo jayleekr/hypeproof-studio          # read it first
gh pr merge 691 --repo jayleekr/hypeproof-studio --squash --delete-branch
```

**Verify:** `git log --oneline origin/main -1` names the merge.

Nothing below depends on this except step 4, but the branch cleanup does.

---

## 1. `HPS_ADMIN_PASSWORD` repo secret

It does not exist today — `gh api .../actions/secrets` returns 8 secrets and this
is not among them. Two things already reference it and have never worked:
`deploy-worker.yml`'s prod verification, and `admin-session.yml` (2 runs, both
failed).

The value is the one already in `worker/.dev.vars` — the same password
authenticates against production.

```bash
gh secret set HPS_ADMIN_PASSWORD --repo jayleekr/hypeproof-studio
# paste the value from worker/.dev.vars when prompted (it is not echoed)
```

**Verify:**
```bash
gh secret list --repo jayleekr/hypeproof-studio | grep HPS_ADMIN_PASSWORD
```

**What it unblocks:** stable releases and worker deploys. Task D's freeze is
fail-closed by design, so without this secret it correctly refuses both.

**What it does NOT block:** the dev channel. `-rc` tags exempt themselves from
the freeze on the ref string alone, before any credential is read — measured,
not assumed. So step 4 works whether or not you have done this one.

---

## 2. Chalk: hostname and signing secret

**Order matters.** The Service redirects `/console` and `/issuer` to
`HPS_CHALK_ORIGIN`. If you deploy the Service first, those routes point at a
host that does not exist and the instructor console breaks.

### 2a. Create the hostname

In Cloudflare → Workers & Pages → the `hypeproof-chalk` worker → Custom Domains,
add **`chalk.hypeproof-ai.xyz`**. (Or the equivalent route in the zone.)

### 2b. Give Chalk the signing secret — the **same value** as the Service

HMAC is symmetric: Chalk must verify tokens the Service minted.

```bash
cd chalk
wrangler secret put HPS_SIGNING_SECRET      # same value as the Service's
```

### 2c. Deploy Chalk, then the Service

```bash
cd chalk && npx wrangler deploy             # Chalk FIRST
cd ../worker && npx wrangler deploy         # Service second
```

**Verify:**
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://chalk.hypeproof-ai.xyz/console
# expect 200

curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://api.hypeproof-ai.xyz/console
# expect 302 → https://chalk.hypeproof-ai.xyz/console
```

Then open `https://chalk.hypeproof-ai.xyz/console`, paste an instructor token,
and confirm the token fragment survives the redirect (it was verified in a
browser during development, but this is the first time on the real host).

**Chalk holds no admin password, no token-minting path, and no cron** — verified
against the built bundle. Instructor writes are forwarded to the Service, which
runs its own gate on every one.

---

## 3. Cloudflare Access on the Chalk host — **before any log retrieval**

This is the one with a real consequence, so it is worth reading rather than
pasting.

Chalk's log-retrieval route (`GET …/logs/:seat/:day/:session/:file`) returns
`events.jsonl`, which contains **participants' questions verbatim**. The
2026-08-22 cohorts are children.

The route grants operator rights on **either** a dedicated
`HPS_LOGS_OPERATOR_SECRET`, **or** the presence of a
`cf-access-authenticated-user-email` header. That second branch does not verify
a JWT and has no email allowlist — it trusts the header.

On `api.hypeproof-ai.xyz` that is safe: Cloudflare's edge strips a
client-supplied `cf-access-*` header, and this was checked by sending one
(`401 Auth required`, header not honoured). **The Chalk host does not exist yet,
so the same protection is unverified there.**

Before retrieval is used:

1. Put a **Cloudflare Access application** on `chalk.hypeproof-ai.xyz/admin/*`.
2. Add an **email allowlist** — today any Access identity in the zone qualifies
   as an operator.
3. Then confirm the header is not honoured from outside:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'cf-access-authenticated-user-email: attacker@example.com' \
  https://chalk.hypeproof-ai.xyz/admin/cohorts/sk-biopharm-2026-a/logs
# expect 401 or an Access redirect — NOT 200
```

If that returns 200, stop and remove the Access branch from
`chalk/src/routes/logs-admin.ts` before using retrieval.

Listing (arrival check, roster diff) is metadata only and is not affected —
it never opens a file.

---

## 4. One throwaway `-rc` tag

Verifies the mirror fix (K) and the dev channel leak fix (J) in a single run.
Independent of step 1.

```bash
git tag v0.0.0-rc.1 && git push origin v0.0.0-rc.1
```

**Verify — three things, in order:**

```bash
# a) the source release is a PRERELEASE (task A)
gh release view v0.0.0-rc.1 --repo jayleekr/hypeproof-studio --json isPrerelease

# b) a mirror run appeared WITHOUT anyone pressing anything (task K)
gh run list --workflow=mirror-release.yml --repo jayleekr/hypeproof-studio --limit 3 \
  --json event,createdAt,conclusion

# c) the mirrored release is also a prerelease (task J)
gh release view v0.0.0-rc.1 --repo jayleekr/hypeproof-studio-releases --json isPrerelease
```

- (b) is the whole point of K: before this fix, **zero** mirror runs had ever
  been triggered by a release event in three months and 36 releases.
- If (c) says `false`, J did not take and the dev channel still leaks — that is
  the one result worth acting on immediately.

`-rc` keeps both releases out of `/releases/latest`, so even a half-working run
reaches no participant.

**Clean up:**
```bash
gh release delete v0.0.0-rc.1 --repo jayleekr/hypeproof-studio --yes
gh release delete v0.0.0-rc.1 --repo jayleekr/hypeproof-studio-releases --yes
git push --delete origin v0.0.0-rc.1 && git tag -d v0.0.0-rc.1
```

---

## Deadline worth knowing

R2 retention is 90 days, so the 2026-08-22 session logs disappear around
**2026-11-20**. Thirteen seats never uploaded at all (six in the morning track,
seven in the afternoon one nobody had checked). Issues #670, #671 and #675 rest
on evidence inside the files that *did* arrive.

Steps 2 and 3 are what make that evidence reachable through the product rather
than by hand.
