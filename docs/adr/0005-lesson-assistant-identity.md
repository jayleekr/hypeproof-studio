# Lesson-level AI display name through the existing coach contract

Status: Proposed (feature A of [#746](https://github.com/jayleekr/hypeproof-studio/issues/746), epic E1 [#747](https://github.com/jayleekr/hypeproof-studio/issues/747)).
Design input (on the unmerged docs branch, PR [#753](https://github.com/jayleekr/hypeproof-studio/pull/753), pinned at `293d4b5`):
[design §"수업별 AI 정체성"](https://github.com/jayleekr/hypeproof-studio/blob/293d4b54b5bc418ab3b6e0adbd788386c08a7319/docs/design/learning-agent-experience.md)
and [requirements AE-07/AE-08](https://github.com/jayleekr/hypeproof-studio/blob/293d4b54b5bc418ab3b6e0adbd788386c08a7319/docs/requirements/learning-agent-experience.md).
Until #753 merges, the two rows this ADR serves are quoted here:

> **AE-07** 강사가 수업의 AI 표시 이름·역할 소개·말투·학생 이름 변경 허용 방식을 저장하고
> 학생 조건에서 미리 본다. 채팅·첫 안내·승인·오류·도움 공유의 AI 표시가 같은 수업 설정을 따른다.
>
> **AE-08** 이름 변경은 기능 권한을 바꾸지 않는다. AI 표시를 유지하며 수업 A의 이름/학생 별명이
> B에 누출되지 않는다. 이전 세션 기록은 당시 정체성을 보존한다.

This ADR records the minimal schema and compatibility decision for the first
slice only: a **fixed** AI display name on a frozen lesson. Role intro, tone,
candidate lists, student aliases per lesson, and model selection are later
slices and are not decided here.

## Decision

1. **Schema.** `hps-session-design/1` gains one optional object,
   `assistant: { display_name: string }`. The schema id does not change. The
   validator moves from "exact keys" to "required keys present, only allowed keys"
   so the block may be absent. When present it must be exactly `{ display_name }`.
   The name is 1..40 UTF-16 code units, trimmed, well-formed (no lone surrogate),
   with no control, format, or bidi characters (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`, plus
   the blank-rendering Hangul filler and braille blank), no stack of three or
   more combining marks, and at least one readable glyph after quotes are
   removed. Chalk strips pasted zero-width characters before sending and omits
   the block when the field is blank. Markup characters are accepted because
   every renderer escapes text (React in Studio, `textContent` in Chalk).
2. **Projection, not a new key.** `GET /v1/profile` projects the frozen lesson's
   name onto the existing `ux.coach` contract: `naming_mode: "fixed"` and
   `fallback_name: <display_name>`. No other `ux`, policy, model, or tool field
   changes. The Service is the single mapping point from lesson content to the
   identity the App displays.
3. **Model-facing name.** The shared chat gate appends one sentence naming the AI
   to the lesson instruction on both runtimes (`/v1/chat/completions` and
   `/v1/messages`). Quotes are removed from the spoken form. The sentence states
   that the name is display-only and changes no grant. On such a seat both
   routes ignore the client's `x-hps-coach-name` / `x-hps-coach-personality`
   headers, so a participant cannot re-title the AI or attach a personality and
   the prompt never claims the student chose the name.
4. **Client.** The Studio extension types the optional field. The header keeps
   one row at 390px by ellipsizing a long name, with the full name in the
   `title` attribute; message labels and the start page already follow the
   fixed-name precedence (`resolveCoach`, REQ-F2, #140).

## Why this shape

- A frozen version is bytes plus a sha256 in the signed token, so a name set
  before freezing stays with that version even after the draft is renamed. This
  is the acceptance "frozen version keeps its name when draft changes" for free.
- Projecting onto `ux.coach` makes the name reach **every** app version through
  one precedence rule. A new top-level key would have shown "코치" on older apps
  and the lesson name on newer ones for the same seat.
- The `fixed` override also settles "stored alias isolation": a student's stored
  name from a `user_names_it` cohort never wins over a lesson-fixed identity
  (existing rule; new positive control in `resolve-coach.smoke.mjs`, and a
  Service check on the kids cohort in `authoring.test.mjs`).
- Keeping the schema id avoids touching the Chalk import/export format, the
  Studio type, and all existing frozen documents.

## Compatibility

| Pair | Behavior |
|---|---|
| Old frozen lesson (no block) + new Service | Validates unchanged; served `ux.coach` is the compiled profile's; no identity sentence in the prompt; client coach headers honored as before. |
| New lesson (block) + new Service + old App | App ignores the unknown `lesson.content.assistant` key and shows the lesson name through `ux.coach` fixed precedence. |
| New Chalk + old Service | `PUT` draft returns `400 invalid session-design fields`; Chalk keeps the edit and, when the AI-name field is filled, explains that this Service does not accept the field yet. **Deploy the Service before Chalk.** |
| Old Chalk (stale tab) + new Service | The field is not shown; saving an existing named draft from the old page drops the block (the old page only serializes the fields it knows). Reload `/authoring` after a Chalk deploy. |
| Named frozen version + Service rolled back below this change | Every read re-validates with the old exact-keys rule, so `readLesson` returns null: `409 lesson_unavailable` for every seat delivered from that version and for new participant delivery. **Rollback floor** recorded in `worker/DEPLOY.md`. |
| Credential without a lesson | Unchanged. |
| Kids `user_names_it` cohort + lesson with a name | Served as fixed for that seat; the naming card is skipped and the student's stored alias is not used. The compiled profile is untouched. Per-lesson student aliases are a later slice. |

Removal: deleting the block from a new draft and freezing a new version restores
the profile rule for seats delivered from that version. Existing frozen versions
are immutable by design.

## Non-goals of this slice

- Approval-modal copy, degraded-runtime notice, observation-panel copy and the
  AI-disclosure sentence still use the generic "코치" wording (AE-07 "표시 일관성"
  follow-up in E1).
- No role intro, tone, `pick_from_list` candidates, or per-lesson student alias.
- No stable assistant id for history (AE-08 "당시 정체성"), no model selection.
- Older messages in an open panel take the current name (pre-existing behavior).
- Name is never a permission: `sdk_tools`, `browser_*`, `model` and the disclosure
  are locked unchanged by `worker/test/authoring.test.mjs`.

## Verification

- Service: `npm run test:authoring` — AE-07/08 checks: frozen name survives a
  draft rename; two lessons keep separate names and an old-schema lesson leaves
  `ux.coach` untouched; block validation incl. invisible/bidi/malformed/quote-only
  names, length, extra keys, and policy smuggling; kids `user_names_it` cohort
  served fixed; proxy route ignores participant coach headers on a named seat and
  honors them on a legacy seat. `npm test` unchanged.
- Chalk: `chalk/test/authoring-ui.test.mjs` locks the field round-trip, the
  zero-width strip, the old-Service hint, and the `textContent` rendering on `/learn`.
- Studio: `test/resolve-coach.smoke.mjs` lesson-projected positive/negative
  controls; `npm run typecheck`; webview build.
- Real Studio screen, 390/1280px, zoom, keyboard, and failure-preserves-identity
  are verified separately by the Codex acceptance record for feature A. They are
  NOT RUN here. A machine-checkable anchor for that run: give the synthetic
  lesson in `e2e/lesson-studio/mac.mjs` an `assistant.display_name` and assert
  `.hps-coach-name` (and the first assistant `.hps-msg-role` after a turn).
