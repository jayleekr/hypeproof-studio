# Age verification & intended-user gating — design note (#320 item 8)

> **Status:** Living design note. Companion to [studio-requirements.md](./studio-requirements.md) §O
> and the Phase-0 licensing review recorded as the **2026-07-13 licensing comment on #282**.
> **Owner:** Jay (legal flow-down: PIPA / parental consent documents are Jay-gated).

## What this note argues

Anthropic's guide for organizations serving minors through the API (Help Center,
2026-03-16; reviewed in the #282 licensing comment) requires, among other
implementation items, that the organization ensures **only intended users** can
access the product — commonly framed as an "age verification" expectation. This
note documents why HypeProof Studio's **enrollment → roster → token** gating
satisfies that requirement, and where the residual gaps are.

Key context from the #282 Phase-0 review (2026-07-13):

- The 18+ restriction applies to the **Consumer** ToS (claude.ai direct signup)
  only. API-based products MAY serve minors, provided the organization
  implements the minors-guide items (AI disclosure, content moderation,
  monitoring/reporting, safety education, ToS flow-down, and intended-user
  gating — tracked as the #320 checklist).
- There is no pre-approval/registration/whitelisting step; the obligation is on
  us to implement and be able to evidence these controls.

## Why "verify the user's age" is the wrong frame for this product

HypeProof Studio is **not an open consumer service**. There is no public
signup, no anonymous access, and no path from the open internet to a model
response. Age verification in the consumer sense (ID checks, age gates) exists
to sort an *unknown* population into age bands. Our population is *known before
the product is ever opened*: every participant is enrolled by name in a
specific workshop cohort by the operating team, and the cohort itself carries
the age band.

The compliance question therefore reduces to: **can anyone other than the
enrolled, age-known participants reach the model?** The gating chain below is
designed so the answer is no.

## The gating chain

Every LLM-serving request (`POST /v1/chat/completions` and `POST /v1/messages`)
passes the shared trust gate `worker/src/lib/chat-gate.ts` — the two routes
cannot drift (REQ-M9). In order:

1. **Enrollment (offline, identity-known).** Participants register for a
   specific workshop (e.g. SK바이오팜 가족 워크숍) through the client
   organization. For minors' cohorts, enrollment is mediated by
   parents/guardians — the SK kids workshops are family workshops where the
   accompanying parent registers the child (`audience.parent_coaching: true`).
   Parental/school consent documentation is the PIPA work item on the #320
   checklist (Jay-gated), layered on this same enrollment step.
2. **Roster (server-side allowlist).** The enrolled names become a per-cohort
   roster in Workers KV, writable only by admin/issuer-authenticated flows.
   A signed token whose user is not on the roster is rejected (403
   `not_in_roster`) — possession of a leaked token is not sufficient.
3. **Token (HMAC v2, per-participant, short-lived).** Tokens are minted per
   participant by instructors holding issuer tokens (or by the admin path),
   bind `user + cohort + profile` into the signature, expire in hours, and are
   individually revocable (jti + KV revocation, S-01). Issuer tokens cannot
   chat. There is no self-service token mint.
4. **Session window (time-boxing).** Even a valid, rostered token only works
   while an instructor has explicitly opened the cohort's session, and only
   inside its start/end window. Outside workshop hours the product serves no
   model traffic at all.
5. **Cohort profile (age-band binding).** The token's profile must match the
   active session's profile. The profile carries the age band
   (`audience.age_range`) and the `minor_cohort` flag (#320, REQ-O1), which
   activates the minors-only gateway moderation layer
   (`worker/src/lib/moderation.ts`) and is exposed to the client via
   `/v1/profile` for minor-specific UX (AI disclosure).
6. **Kill switch.** Any cohort can be paused instantly (S-12), and individual
   tokens revoked, if a device or token is suspected compromised.

Properties worth stating explicitly:

- **The classroom Anthropic key never leaves the worker** (REQ-M10/M13). A
  participant cannot bypass the gate by talking to Anthropic directly with our
  credentials; local ambient keys are scrubbed on the SDK path.
- **Fail-closed for minors.** A cohort is treated as a minors cohort if it is
  flagged `minor_cohort: true` **or** its `age_range` upper bound is under 18 —
  forgetting the flag cannot silently disable minor protections (project
  minor-safety invariant). Minors' cohorts also never gain write/exec
  capability by default (REQ-M1/M3, sandbox defaults).

## Why this satisfies "only intended users"

The intended users of a given cohort are exactly the people the operating team
enrolled — a closed, named, age-known list. The chain above enforces that set
end-to-end with per-request server-side checks, which is *stronger* than
consumer-style age verification:

| Consumer age gate | HypeProof gating |
|---|---|
| Self-asserted birthdate, verified once at signup | Identity known at enrollment (mediated by employer/school/parents), re-checked per request against the roster |
| One global product surface for all ages | Per-cohort profile: age band, model policy, tool policy, moderation posture bound to the token |
| Account lives indefinitely | Access exists only inside instructor-opened session windows; tokens expire in hours |
| Enforcement at the account layer | Enforcement at every model request (shared gate, both routes) |

An unenrolled person would need a validly signed token for a rostered user of
a currently-open session — i.e., an HMAC forgery or a secret leak — not a
false birthday.

## Residual gaps (tracked, not hidden)

- **In-room device sharing.** During a family workshop a parent and child share
  a machine by design (`parent_coaching`). Mitigation: minors-cohort defaults
  (chat-only sandbox, moderation layer) apply to the *device*, regardless of
  who types. This is the conservative direction — adults at a kids workshop get
  the kids posture, never the reverse.
- **Token forwarding out of the room.** A participant could hand their token to
  an outsider during the session window. Mitigations: hours-scale expiry,
  session windows, per-token revocation, per-user usage accounting
  (anomaly-visible), cohort pause. Accepted residual risk — equivalent to a
  consumer sharing a logged-in account, and shorter-lived.
- **Consent documentation (PIPA).** The legal paper trail (parent/school
  consent forms, Usage Policy flow-down in the workshop terms) is a separate
  #320 checklist item owned by Jay; this note covers the technical gating only.

## Related

- #282 — 2026-07-13 licensing comment (Phase-0 conclusion: no Anthropic
  contact required; minors-guide items are ours to implement)
- #320 — compliance implementation checklist (this note is item 8)
- [studio-requirements.md](./studio-requirements.md) — §O (minors safety &
  compliance), §M (Agent SDK gateway trust model)
- `worker/src/lib/chat-gate.ts` — the shared trust gate
- `worker/src/lib/moderation.ts` — minors-only gateway moderation (#320 item 2)
