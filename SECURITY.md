# Security Policy

## Reporting

Do not open a public issue for secrets, auth bypasses, token leaks, or deploy
credential problems.

Send the report directly to the maintainers:

- GitHub: `@jayleekr`
- GitHub: `@JeHyeong2`

Include the affected branch or commit, reproduction steps, and whether any
credential may have been exposed. Never include full secret values.

## Secret Handling

- Do not commit `.env`, `.dev.vars`, private keys, tokens, webhook URLs, or
  Cloudflare credentials.
- HypeProof Studio tokens, issuer tokens, admin passwords, Discord webhooks, and
  Cloudflare Worker secrets must live in approved secret stores only.
- If a secret reaches git, rotate it first, then decide whether history cleanup
  is needed.

## Branch Policy

`main` should only receive changes through PR review and CI. Public users may
open PRs or comments, but only HypeProof members or approved automation may
merge, deploy, or run write-capable automation.
