# Lesson-level AI display name through the existing coach contract

Status: Proposed (feature A of [#746](https://github.com/jayleekr/hypeproof-studio/issues/746), epic E1 [#747](https://github.com/jayleekr/hypeproof-studio/issues/747)).
Design input: [learning-agent-experience](../design/learning-agent-experience.md) §"수업별 AI 정체성",
[requirements](../requirements/learning-agent-experience.md) AE-07/AE-08 and the
"AI 이름·역할 설정의 구체 범위" table. This ADR records the minimal schema and
compatibility decision for the first slice only: a **fixed** AI display name on a
frozen lesson. Role intro, tone, candidate lists, student aliases per lesson, and
model selection are later slices and are not decided here.

## Decision

1. **Schema.** `hps-session-design/1` gains one optional object,
   `assistant: { display_name: string }`. The schema id does not change. The
   validator moves from "exact keys" to "required keys present, only allowed keys"
   so the block may be absent. When present it must be exactly `{ display_name }`
   with a trimmed, single-line string of 1..40 characters and no control
   characters. An empty or whitespace name is rejected; Chalk omits the block
   instead of sending a blank. Markup characters are accepted because every
   renderer escapes text (React in Studio, `textContent` in Chalk).
2. **Projection, not a new key.** `GET /v1/profile` projects the frozen lesson's
   name onto the existing `ux.coach` contract: `naming_mode: "fixed"` and
   `fallback_name: <display_name>`. No other `ux`, policy, model, or tool field
   changes. The Service is the single mapping point from lesson content to the
   identity the App displays.
3. **Model-facing name.** The shared chat gate appends one sentence naming the AI
   to the lesson instruction on both runtimes (`/v1/chat/completions` and
   `/v1/messages`). Quotes are stripped from the name inside that sentence. The
   sentence states that the name is display-only and changes no grant.
4. **Client.** The Studio extension types the optional field and changes no
   rendering rule: the header, per-message label, and start page already follow
   the fixed-name precedence (`resolveCoach`, REQ-F2, #140).

## Why this shape

- A frozen version is bytes plus a sha256 in the signed token, so a name set
  before freezing stays with that version even after the draft is renamed. This
  is the acceptance "frozen version keeps its name when draft changes" for free.
- Projecting onto `ux.coach` makes the name reach **every** app version through
  one precedence rule. A new top-level key would have shown "코치" on older apps
  and the lesson name on newer ones for the same seat.
- The `fixed` override also settles "stored alias isolation": a student's stored
  name from a `user_names_it` cohort never wins over a lesson-fixed identity
  (existing rule; new positive control in `resolve-coach.smoke.mjs`).
- Keeping the schema id avoids touching the Chalk import/export format, the
  Studio type, and all existing frozen documents.

## Compatibility

| Pair | Behavior |
|---|---|
| Old frozen lesson (no block) + new Service | Validates unchanged; served `ux.coach` is the compiled profile's; no identity sentence in the prompt. |
| New lesson (block) + new Service + old App | App ignores the unknown `lesson.content.assistant` key and shows the lesson name through `ux.coach` fixed precedence. |
| New Chalk + old Service | `PUT` draft returns `400 invalid session-design fields`; Chalk shows the error and keeps the edit. No silent drop. |
| Credential without a lesson | Unchanged. |
| Kids `user_names_it` cohort + lesson with a name | Served as fixed for that seat; the naming card is skipped. Per-lesson student aliases are a later slice. |

Removal: deleting the block from a new draft and freezing a new version restores
the profile rule for seats delivered from that version. Existing frozen versions
are immutable by design.

## Non-goals of this slice

- Approval-modal copy, degraded-runtime notice, observation-panel copy and the
  AI-disclosure sentence still use the generic "코치" wording (AE-07 "표시 일관성"
  follow-up in E1).
- No role intro, tone, `pick_from_list` candidates, or per-lesson student alias.
- No stable assistant id for history (AE-08 "당시 정체성"), no model selection.
- Name is never a permission: `sdk_tools`, `browser_*`, `model` and the disclosure
  are locked unchanged by `worker/test/authoring.test.mjs`.

## Verification

- Service: `npm run test:authoring` (three AE-07/08 checks: frozen name survives
  draft rename; two lessons keep separate names and an old-schema lesson leaves
  `ux.coach` untouched; block validation incl. control characters, length, extra
  keys, and policy smuggling). `npm test` unchanged.
- Chalk: `chalk/test/authoring-ui.test.mjs` locks the field round-trip and the
  `textContent` rendering on `/learn`.
- Studio: `test/resolve-coach.smoke.mjs` lesson-projected positive/negative
  controls; `npm run typecheck`.
- Real Studio screen, 390/1280px, zoom, keyboard, and failure-preserves-identity
  are verified separately by the Codex acceptance record for feature A. They are
  NOT RUN here.
