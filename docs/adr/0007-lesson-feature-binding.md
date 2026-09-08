# A lesson narrows the features its seat may use, and says where that is not a boundary

Status: Proposed (first unit of E2 [#748](https://github.com/jayleekr/hypeproof-studio/issues/748), epic [#746](https://github.com/jayleekr/hypeproof-studio/issues/746)).
Sibling of [ADR-0005](0005-lesson-assistant-identity.md) (a lesson's AI name) and
[ADR-0006](0006-lesson-model-policy.md) (a lesson's model set). Same house pattern:
a lesson may only **narrow** what the compiled profile already grants, the Service
enforces by rewriting the profile, and no app has to learn a new key.

The rows this ADR serves, quoted so a main checkout can read them:

> **AE-09** 역할·담당 수업·확정 버전·단계·대상·행위로 실행 허용 여부를 계산한다. 단계 전이는
> Service가 검증한다. 학생 승인/강사 문구/위조 step ID/조작된 클라이언트 요청은 상위 deny를 확장하지 못한다.
>
> **AE-10** 강사는 플랫폼 허용 카탈로그 안에서 기능·교수 전략을 선택한다. … 콘텐츠 자체는 권한을 부여하지 않는다.
>
> **AE-11** 학생 권한·독립 자격으로 리허설하고 콘텐츠 해시·정책 revision·앱/SDK 호환 범위에 증거를 귀속한다.
>
> **AE-12** 새 수업 기능을 모르는 앱은 해당 기능을 차단하고 해결 방법을 표시한다.
>
> **AE-36** 시연/힌트/함께 수정/직접 수행을 허용된 수업 범위 안에서 선택하고 다음 실행에 반영한다.

## Today, in one sentence

A seat's permissions are one compiled cohort profile chosen by the token's profile
id — never per-student, never per-step, and per-role only in the two-value sense
`student | issuer` — and a frozen lesson may narrow exactly two things: the AI's
display name and the model set.

Everything else in this ADR follows from what that sentence does *not* say.

## Audited facts that decide the contract

- **`sdk_tools` is not enforced by the Service on `/v1/messages`.** The upstream body
  is `{ ...raw, model, messages, system, max_tokens, … }` and `tools` is not in the
  override list, so the client's declared tools pass through. The route's own header
  says so and calls server-side tool policy a later phase, deliberately out of that
  slice. The real gate is the app's `canUseTool`. Six of seven registered profiles
  run that route.
- **On `/v1/chat/completions` the Service does enforce**: it assembles the tool list
  itself, injecting web search and the browser tools only when the profile allows.
- **`/v1/profile` does not run the chat gate for an ordinary lesson seat.** The gate
  is invoked only for native-trial and observation seats, and even then its rewritten
  profile is discarded. A narrowing applied only in the gate would therefore be
  invisible in the served capability flags.
- **The app already reads the exact keys a narrowing would touch** — `sdk_tools.*`
  and `tools.web_search` — through `permittedToolsFor`. It does not need to learn
  anything new to honour a narrowing.
- **`browser` has two spellings for the same capability**, one per runtime
  (`browser_control.enabled` on the proxy route, `sdk_tools.browser` on the SDK
  route); the code already records that they are the same thing seen twice.
- **Rehearsal does not exist.** `rehearsal: "not_run"` and `activated: false` are
  string literals in the authoring responses with no table, no producer and no
  execution path.
- **The four help modes exist nowhere** — not in the profile, the session design, the
  token, D1, or the client protocol. The client's verdict vocabulary is
  allow / ask / deny.

## Decision

### 1. One optional block, the third of its kind

```ts
features?: { allowed: FeatureKey[] }
type FeatureKey = "read" | "write" | "shell" | "subagents" | "browser" | "web_search"
```

The catalogue is closed and **derived from the compiled profile** — it is AE-10's
"플랫폼 허용 카탈로그", made of flags that already exist and nothing else. `browser` is
one catalogue key covering both runtime spellings, so an instructor never has to know
which route her class runs.

Rules: 0..6 entries (an empty array is the legitimate "chat only" narrowing), no
duplicates, every entry a catalogue key, and `allowed ⊆ granted(profile)`. Absent →
the compiled profile applies unchanged.

Because a lesson can only remove, the issuer scope gains no field and the
participation token keeps its documented promise to carry no runtime capability.

Validated in the three places ADR-0006 established: at save, again at freeze (the
draft's profile id is mutable), and again on every read, so a profile whose grant
later shrinks fails closed rather than continuing to serve the wider set.

### 2. Enforced by rewriting the profile — at **two** call sites

One pure `narrowProfileForLesson(profile, lessonContent)`, called from:

- **the shared chat gate**, folded into the same return spread that already carries
  the model and the system prompt. This makes the narrowing take effect on
  `/v1/chat/completions` with no edit to the translator: the web-search tool and the
  browser tools simply stop being injected.
- **the `/v1/profile` serializer**, immediately before the response literal. This one
  is easy to miss and load-bearing: that route does not use the gate for an ordinary
  lesson seat, so without it the block is inert on every SDK seat. The repo has this
  exact defect on record once already — a profile said `shell: true` and the API
  served four keys, found by probing production after a deploy.

### 3. A projection, not a new key

The served response gains **no top-level key an app must learn**. `sdk_tools.write`
simply arrives `false`; `tools.web_search` simply arrives `false`. Every Studio build
since the SDK runtime landed already reads those keys, so every app version honours
the narrowing with no update and no capability negotiation. The instructor-facing
`features` block lives inside `lesson.content`, which old apps already ignore.

## Where this is not a boundary — say it, do not paper over it

**On `/v1/messages` this narrowing is an availability narrowing, not a Service
boundary.** The route forwards the client's `tools`, so a modified — or simply
older — client that declares Bash on a shell-narrowed seat still reaches the upstream
with it. That covers almost the whole fleet.

This is the same trap ADR-0006 fell into and had to be corrected for: claiming a
tighter contract than the routes enforce. So the first slice states it plainly and
**ships a negative-control test that asserts today's passthrough**, so this ADR cannot
silently become wrong.

Until something changes, AE-09's "조작된 클라이언트 요청은 상위 deny를 확장하지 못한다" is
**UNMET on the SDK route** and the requirement row must say so.

### Amendment, 2026-09-08 — the follow-up this section named does not close it

The paragraph here originally said the closing move was to intersect the request's
`tools` with the seat's granted names, and deferred that to a follow-up PR. That was
wrong, and it was wrong in the direction this ADR exists to prevent: it named a
mechanism that would have let a later PR claim Service enforcement it does not have.

**On this route the Service never executes a tool.** The route's own header says so —
"tools are DEFINED here but EXECUTED client-side by the SDK". Removing a name from the
`tools` array only changes what the model is told it may propose. A modified client
executes locally and never asks the Service at all, so the intersection is invisible to
exactly the adversary AE-09 describes.

What the intersection would actually buy is narrower and worth naming honestly: a
**stale** client — an older build, or one holding a cached profile from before a
narrowing — declares the un-narrowed set, and filtering stops the model proposing tools
that seat should no longer use. That is robustness against our own rollout lag, not a
boundary. It also carries a failure mode of its own: stripping a declaration while an
earlier `tool_use` for it sits in the conversation may make the upstream reject the
request, which is reachable by an ordinary student whose instructor narrows a lesson
mid-course.

So the honest statement of this route, replacing the deferral:

- The Service enforces exactly four things on an agent-sdk seat — the trust gate
  (token, revocation, profile, session, roster, cohort pause), system-prompt
  replacement, the model clamp, and `max_tokens`/effort normalisation.
- Tool policy and input filtering on this route are **client-integrity** properties,
  not Service boundaries. They hold for the client we ship and fail with it.
- A cohort that needs a Service-enforced tool or image boundary has one option today:
  run the proxy route, where the worker composes the upstream tool array and filters
  image blocks itself.

That last point has a consequence nobody had written down: both registered child
cohorts (`sk-biopharm-kids-s1`, `sk-biopharm-kids-2026-grade-5-6-s1`) set
`coach_runtime: "agent-sdk"`, so they are on the route with neither enforcement. That
follows from the 2026-08-11 decision to let a minor cohort opt into the file-capable
runtime, and it is not by itself a mistake — the children's curriculum needs those
tools. It does mean "the Service enforces tool and image policy for child seats" is not
true today. Tracked in #811 for the image half.

## What each row gets

| Row | Verdict | Why |
|---|---|---|
| AE-09 | PARTIAL | Two of six inputs become real — 확정 버전 already is, and 행위 becomes computable and genuinely enforced on the proxy route. 역할 and 담당 수업 are not expressible as a narrowing at all (see below). Step transition is not Service-verifiable. |
| AE-10 | PARTIAL | The 기능 half is fully served by the derived catalogue. 교수 전략 is not — see AE-36. |
| AE-11 | UNMET | Rehearsal is a hard-coded literal. It needs a record, a student-condition credential, and an attribution of policy revision and app/SDK compatibility — three mechanisms, none of them a narrowing. |
| AE-12 | PARTIAL | The projection removes the hazard for this block by construction: an old app cannot fail to honour a narrowing it never had to learn. A general capability handshake, and the split between "setting missing", "policy refused" and "runtime absent", is separate. |
| AE-36 | UNMET | The four help modes have no representation at any layer. They need a per-step slot, a per-seat mutable state store, and a runtime carrier. |

**Not expressible as a narrowing, needs new authority — do not fake it.** AE-09's
역할 and 담당 수업: the issuer scope has no course dimension, ownership is a single
owner id compared to the signed subject, and the drafts primary key means a second
instructor cannot even hold the same course. A co-instructor or teaching-assistant
model requires either an appended optional token field — appended, because the
canonicalization forbids reordering — or a new assignment table, plus revisiting the
role checks scattered across the routes. That is its own unit.

## Compatibility

| Pair | Behavior |
|---|---|
| Old frozen lesson (no block) + new Service | Optional key absent; the compiled profile applies unchanged. |
| New lesson (block) + new Service + old App | The narrowing lands on keys the app already reads, so it is honoured with no app change. |
| New Chalk + old Service | Draft save returns `400 invalid session-design fields`; the edit is preserved. **Service before Chalk.** |
| Narrowed lesson frozen + Service rolled back | Every read re-validates, so those seats get `409 lesson_unavailable`. A second **rollback floor** row, alongside the one ADR-0006 added. |
| Credential with no lesson | Unchanged. |

## Verification the slice must carry

- Positive control: a lesson narrowing to `{read}` on a profile granting read/write/shell
  serves `sdk_tools.write === false` and `shell === false`, and the proxy route stops
  injecting web search and the browser tools.
- Negative controls: an alias outside the profile's grant refused at save and at
  freeze; an already-frozen widening lesson refused on read; an empty `allowed`
  accepted as the legitimate chat-only narrowing.
- **The passthrough control**, asserting today's truth: on `/v1/messages` a
  shell-narrowed seat's request that declares Bash still reaches the upstream
  unchanged. Per the amendment above this is not a control waiting for a closure —
  it is there so the route cannot start touching `tools` without this test failing
  first and forcing a fresh judgment about what the requirement row may claim.
- The `/v1/profile` call site gets its own test. The gate-only version of this change
  would pass every gate test and still ship inert.

## Sequencing

Docs-only, so it can land against main today. The **implementation** must branch after
the model-policy slice merges: every touchpoint is a line that slice just rewrote —
the gate's single return spread, the schema's optional-key list and its validator
branch, the three validation sites, and the `/v1/profile` serializer. Landing them in
parallel would conflict in all four files, which is how this epic already produced one
duplicate pair of PRs.
