---
name: hype-cohort-from-vault
description: Translate a curriculum doc from the HypeProof curriculum vault (JinyongShin/hypeproof_kids_edu) into a worker cohort profile + system prompt — pick the file, map curriculum behaviors to 7 AI Native Assets focus, rewrite ts profile + md prompt, run typecheck + smoke, hand off to /hype-open-pr. Use when a new vault curriculum (or a vN→vN+1 update) needs to land on the live cohort.
user_invocable: true
triggers:
  - "hype-cohort-from-vault"
  - "vault to cohort"
  - "sync cohort from vault"
  - "update cohort profile from vault"
  - "커리큘럼 적용"
  - "볼트에서 코호트"
  - "프로필 업데이트"
argument_hint: "[cohort id, e.g. boah-dental-teaser-2026-s1 — optional, will list if omitted]"
---

# hype-cohort-from-vault

Curriculum lives in `JinyongShin/hypeproof_kids_edu`
(`kids_edu_vault/wiki/specs/...`); the worker speaks in
`worker/src/profiles/<cohort>.ts` + `worker/src/prompts/<cohort>.md`. This
skill is the deterministic bridge between the two — read the vault doc,
encode the curriculum's *behaviors* (not its prose) into the profile, ship a
PR.

Source of truth precedence: **vault wins on content**, **`docs/seven-assets.md`
wins on asset definitions**, **`worker/src/profiles/types.ts` wins on schema**.

## Preconditions

- `gh` authenticated and able to read `JinyongShin/hypeproof_kids_edu`.
- On `main`, clean tree, in sync with origin. If not, `git pull --ff-only` /
  commit/stash first.
- `worker/` deps installed (`cd worker && npm install` once).
- The vault PR you're sourcing from is **merged** (don't translate a draft
  curriculum into prod profile).

## Flow

### 1. Pick the cohort + curriculum doc
- If argument is a cohort id, use it. Else list cohorts:
  `ls worker/src/profiles/*.ts` → strip `index.ts` / `types.ts`.
- For each cohort, find candidate vault docs:
  ```
  gh api repos/JinyongShin/hypeproof_kids_edu/git/trees/HEAD?recursive=1 \
    --jq '.tree[].path' | grep specs/.*\.md$
  ```
  Match cohort id ↔ doc by shared slug (e.g. `boah-dental` ↔
  `track-b/dental-supersearch-curriculum-v4.md`). If ambiguous, ask the user.

### 2. Fetch the curriculum content
```
gh api repos/JinyongShin/hypeproof_kids_edu/contents/<path> \
  --jq .content | base64 -d > /tmp/vault-curriculum.md
```
Read it fully. Identify:
- **One-line definition** (what the participant produces, who they ARE in the session).
- **Block-by-block flow** (durations, gates, transitions).
- **Game / pedagogical devices** (e.g. "원장님을 이겨라", PASS/더 확인/위험,
  HYROX framing). These become coach-mode in the prompt.
- **Behavioral axes** (e.g. 7 AI Native Assets, 4원칙). Each axis maps to one
  or more AI Native Assets — see §3.
- **Outputs / artifacts** (what gets saved at session end — drives
  `welcome.example_prompts` + `ux.suggestions.initial` shape).
- **Audience / role context** (e.g. dental hygienist vs grade-3 kid) —
  drives tone, hint copy, weak-chip examples.

### 3. Map behavioral axes → AI Native Assets (the judgment call)
Open `docs/seven-assets.md`. For each behavioral axis in the curriculum,
pick the best-fit asset key(s). Document the mapping in a comment block at the
top of the .ts file:

```ts
// 7 AI Native Assets focus:
//   intent_clarity      → user must state the decision / object before asking AI
//   context_design      → user must provide role, audience, and constraints
//   ...
```

Rules:
- Prefer one primary asset per axis; use multiple only when the curriculum
  explicitly trains more than one behavior in the same block.
- If every axis maps to the same asset, revisit the mapping; the curriculum may
  need more precise behavioral labels.
- `assets_focus` array = the union of mapped asset keys in canonical order:
  `taste`, `intent_clarity`, `context_design`, `verification_reflex`,
  `delegation_judgment`, `iteration_reflex`, `ownership`.

Always show the proposed mapping to the user before writing it — a wrong asset
mapping propagates into UX captions and measurement.

### 4. Rewrite `worker/src/prompts/<cohort>.md` (the system prompt)
Replace the file entirely. The structure should follow:

1. **Identity paragraph** — who the coach is, who the participant is, what
   session this is, length.
2. **One-line definition** — verbatim from vault, in a blockquote.
3. **Block flow** — numbered list mirroring the vault's timing blocks. Tell
   the coach to *follow* the pace without naming the blocks like a teacher.
4. **Behavioral-axis section** — one bullet per axis with: name → AI Native
   Asset → one-line behavioral cue.
5. **운영 원칙** — language (한국어 / English), output-shape guardrails (e.g.
   "AI must not draw clinical conclusions"), source priority, safety
   (file_write scoped to workspace, no shell), success metric.

Tone: directive ("강의하지 마세요. 겪게 하세요."), not flowery. Length: 60–90
lines is the sweet spot — too short loses behavioral cues, too long hits cache
limits.

### 5. Rewrite `worker/src/profiles/<cohort>.ts` (the schema instance)
Update **only** these fields (the schema is shared — don't change shape):

- Header comment block: vault PR ref + mapping table + any schema-fit caveats
  (e.g. `template_tier` placeholder when output shape doesn't have an entry).
- `display_name` if the cohort framing changes.
- `welcome.greeting_md` — short, ends with the session hook.
- `welcome.example_prompts` — three or four real-job examples sourced from
  the curriculum's audience-context section.
- `assets_focus` — canonical-order list from step 3.
- `ux.suggestions.initial` — 3–5 good chips (mirror `example_prompts`'s
  domain) + 1 `weak` chip that illustrates *what bad input looks like* for
  the headline asset (e.g. Intent clarity vague → "치과 관련 질문 답해줘").
  Use `caption` to label the role (위생사/코디/etc.) so the panel renders
  it as audience-targeted.
- `ux.suggestions.follow_up` — one chip per behavioral axis. `caption`
  should cite the asset (e.g. "Intent clarity") so the participant sees the
  learning behavior in context.
- `ux.hints.short_input.message_md` / `roll_input_button.probe_md` —
  rephrase around the curriculum's central object (e.g. "결정" vs
  "캐릭터·움직임").

Do **not** touch: `id`, `version`, `audience`, `model`, `sandbox`,
`preview`, `game.template_tier` (unless you also add a schema entry),
`publishing`, `session`, `analytics`. If any of these need to change,
that's a separate PR — call it out instead of bundling.

### 6. Verify
```
cd worker
npx tsc --noEmit        # must be clean
npm test                # smoke; profiles invariant test exercises both cohorts
```
If `npm test` fails on the profiles invariant (`log_user_messages=false`),
you accidentally touched the privacy bit — revert that field.

### 7. Hand off to /hype-open-pr
Branch convention: `feat/issue-<N>-<short-slug>` (e.g.
`feat/issue-77-dental-supersearch-v4`). Commit message body must include:
- Vault source: `JinyongShin/hypeproof_kids_edu#<PR>` + the doc path.
- Field-by-field changes (the before/after of `assets_focus`,
  `example_prompts`, etc. in a small table).
- `Closes #<N>` if there's an open issue. `Assets: <list>` if chat-panel
  UX shifts.

Then invoke `/hype-open-pr` for the PR body.

### 8. Deploy after merge
PR merge ≠ live. After merge, invoke `/hype-deploy` to push to prod and
close any `ops:` redeploy tracker.

## Guardrails

- Vault PR must be **merged** before translation. Don't ship a profile
  rewrite from a draft curriculum — the wording will shift.
- Never invent asset mappings the curriculum doesn't request. If the vault doc
  trains three assets, list those three; don't pad to all seven.
- Never write the curriculum prose into the profile verbatim. The vault is
  for facilitators; the prompt is for the coach. Translate behaviors, not
  paragraphs.
- The `assets_focus` array is product-visible (UI captions, analytics filters).
  Mapping changes are not cosmetic — surface them in the PR body.
- Leave `essences_focus` alone unless the compatibility bridge is explicitly in
  scope for the PR.
- One cohort per invocation. Two cohorts changing in lockstep is two PRs.
- Don't bump `version` field unless the schema shape changed (it didn't, in
  a curriculum-only update).
- English in code + commits + PR; converse in any language.
