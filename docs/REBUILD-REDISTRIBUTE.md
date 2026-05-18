# Rebuild & Redistribute — production endpoint migration

Formal procedure for re-cutting HypeProof Studio and getting it to the
operators after a **production endpoint change**. Triggered the first time by
the `api.hypeproof.ai → api.hypeproof-ai.xyz` migration: `hypeproof.ai` was
never a zone in our Cloudflare account; the real, live zone is
`hypeproof-ai.xyz`. The Worker now runs at `https://api.hypeproof-ai.xyz/v1`.

This guide is the canonical "a shipped default changed, everyone needs a new
build" runbook. It does **not** duplicate build mechanics — those live in
[.claude/rules/build-pipeline.md](../.claude/rules/build-pipeline.md) and
[../worker/DEPLOY.md](../worker/DEPLOY.md). It adds only the migration-specific
delta and the redistribution gate.

## 0. Who runs this

The maintainer (build host = Mac arm64). Operators do **not** rebuild — they
receive a new `.app` / installer.

## 1. Interim unblock (no rebuild) — do this first

Operators already holding an old build point at the dead `api.hypeproof.ai`.
Until the new build ships, they can keep working by overriding the proxy URL:

- VS Code Settings → search `hypeproofChat.proxyUrl`
- Set to: `https://api.hypeproof-ai.xyz/v1`
- Reload window

Announce this in the operator group chat the moment the Worker is live
(health check below). It buys time; it is not the fix.

## 2. Verify the endpoint is live

```bash
curl -s https://api.hypeproof-ai.xyz/v1/health
# expect: {"ok":true,"service":"hypeproof-studio-api",...,"env":"production"}
```

If this is not 200, stop — fix the Worker (`worker/DEPLOY.md`) before rebuilding.

## 3. Confirm the corrected default is in source

Every shipped default must read `api.hypeproof-ai.xyz`:

```bash
grep -rn 'api\.hypeproof\.ai' \
  extensions/hypeproof-chat/package.json \
  extensions/hypeproof-chat/src/ \
  && echo "STALE default present — abort" || echo "clean"
```

`extensions/hypeproof-chat/package.json` (`contributes.configuration` default)
and `src/chatPanelProvider.ts` fallbacks must all be `.xyz`.

## 4. Rebuild

Prerequisites and full mechanics: **build-pipeline.md**. Migration-specific
order:

1. Submodule present on the build host: `git submodule update --init vscodium-base`
2. Build + inject the extension so the corrected default is baked in:
   `bash scripts/inject-builtin-extensions.sh`
3. Confirm the bake: `grep -o 'https://api\.hypeproof[^"]*' extensions/hypeproof-chat/dist/extension.js | sort -u` → only `.xyz`
4. Full Studio build (1–2 h, gated — confirm disk/intent):
   `bash scripts/run-build.sh logs/build-$(date +%Y%m%d-%H%M%S).log`
5. Branding verify: `bash scripts/verify-branding.sh` exits 0

## 5. Redistribute

Follow [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) "Cut" + "Dogfood". The
migration-specific acceptance gate:

- [ ] Fresh install of the new build, no settings override, defaults to
      `api.hypeproof-ai.xyz` (operators must **clear** any interim
      `hypeproofChat.proxyUrl` override so they test the real default)
- [ ] token register → first message streams a reply (end-to-end Gemini path)
- [ ] all operators confirmed migrated in the group chat

Until that last box is checked, the migration is not done — operators on the
old build (or stale override) are still broken.

## 6. Leave the interim bridge documented

Keep §1 in place for the next endpoint change. Do not hard-pin operators to a
manual override as the steady state — the shipped default is the contract.
