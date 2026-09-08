# A lesson narrows the models it allows; the app shows the set and the turn

Status: Proposed (first unit of E7 [#755](https://github.com/jayleekr/hypeproof-studio/issues/755), epic [#746](https://github.com/jayleekr/hypeproof-studio/issues/746)).
Design input (docs branch PR [#753](https://github.com/jayleekr/hypeproof-studio/pull/753), pinned at `293d4b5`):
[design §"멀티모델을 수업의 선택권으로 설계"](https://github.com/jayleekr/hypeproof-studio/blob/293d4b54b5bc418ab3b6e0adbd788386c08a7319/docs/design/learning-agent-experience.md),
[multi-model research](https://github.com/jayleekr/hypeproof-studio/blob/293d4b54b5bc418ab3b6e0adbd788386c08a7319/docs/research/agent-experience-2026-09-08/multi-model.md),
[requirements AE-25..AE-33](https://github.com/jayleekr/hypeproof-studio/blob/293d4b54b5bc418ab3b6e0adbd788386c08a7319/docs/requirements/learning-agent-experience.md).
The rows this ADR serves, quoted so a main checkout can read them:

> **AE-25** 기존 provider/alias/profile 경로를 카탈로그와 연결한다. 기관·수업·단계·학생 배정의 허용 교집합을
> Service에서 집행하고 임의 모델 ID/alias/다른 수업 권한으로 우회할 수 없다. 기존 fast 보조 호출도 명시된 정책·예산으로 관리한다.
>
> **AE-26** 강사가 고정/제한 선택 모드를 수업 버전으로 저장·리허설한다. (고정/제한 선택 P0; 자동/비교 P1)
>
> **AE-27** 학생은 입력창에서 허용 선택과 현재 선택을 확인한다. … 턴의 실제 provider/model, 자동/대체 이유,
> 사용량 또는 미확인을 볼 수 있다. 요청 모델 clamp·동일 ID의 다른 alias를 모델 변경으로 오인시키지 않는다.
>
> **AE-28** 모델×실행기×SDK/Gateway×도구/OS 조합에서 검증한 능력만 선택 가능하다.
>
> **AE-33** 확정 수업의 provider/model 매핑·허용 후보·정책/카탈로그 revision·실행기 범위를 보존한다.
> 모델 교체는 재리허설/새 버전/복귀 경로를 거치고 은퇴·강제 차단 시 조용히 다른 모델로 치환하지 않는다.

This ADR decides the contract only. It is written from an audit of the code as of
`feb1310`; the "What exists today" section is the audit's result and is the reason
the contract is this small.

## What exists today (audited, not assumed)

**Aliases are the entire model vocabulary.** A profile can say `hypeproof-fast`,
`hypeproof-default` or `hypeproof-strong` and nothing else. Raw upstream ids cannot
appear in a profile. Four providers exist (`gemini | anthropic | openai | glm`), each
with its own alias→id map.

| Provider | fast | default | strong |
|---|---|---|---|
| anthropic | claude-haiku-4-5 | claude-sonnet-4-6 | claude-opus-4-7 |
| gemini | gemini-2.5-flash | gemini-3.5-flash | gemini-3.5-flash |
| openai | gpt-4o-mini | gpt-4o | gpt-4o |
| glm | glm-5.2 | glm-5.2 | glm-5.2 |

Three of the four providers collapse two or three aliases onto the same upstream id.
That single fact decides one design rule below.

Other audited facts that constrain the contract:

- **No profile sets `model.provider`.** All seven registered profiles resolve to
  `default: hypeproof-default`, `fallback: hypeproof-fast`, and every request falls
  through to the deployment-level provider. `hypeproof-strong` is never a default or
  fallback anywhere; it exists only in the maps and in a negative-control test.
- **Two clamps already enforce the profile's set.** On `/v1/chat/completions` a
  requested model is matched by alias name against `model.default` and
  `model.fallback`; anything else silently becomes the default. On `/v1/messages` the
  same two aliases are matched by name **or** by mapped id, plus a `claude-*haiku*`
  rule. Neither clamp needs editing for a lesson to narrow the set.
- **`/v1/messages` force-appends `hypeproof-fast`** to the allowed set even when the
  profile lists no fast fallback, for the CLI's auxiliary calls. It is route policy,
  not cohort policy, and it is the one place the served set is wider than the profile
  declares.
- **`/v1/messages` is Anthropic-only** and ignores both `LLM_PROVIDER` and
  `profile.model.provider`. Six of seven profiles run that route.
- **The turn's actual model already ships three ways** and nothing reads two of them:
  the `x-hps-model` response header on both routes, `x-hps-fallback: 1` when a
  substitution occurred (Gemini is the only substituting path in the codebase), and
  the `model` field inside the SSE usage chunk — which the client already parses.
  The usage chunk is suppressed when all token counts are zero, so the header is the
  primary source and the chunk is a join key, not a replacement.
- **The durable record exists.** `usage_log.model` stores the id actually served on
  both routes, including failure rows.
- **Model policy is deliberately compiled, not publishable.** The module layer
  overrides exactly one profile key (`system_prompt`) and its own comment records why
  model, `sdk_tools`, `minor_cohort` and analytics stayed compiled: runtime-loading
  them would route around the cohort harness, which is the review-time safety gate.

## Decision

Three additive pieces. No new schema id, no new store, no new authority.

### 1. The lesson may narrow, never widen

`hps-session-design/1` gains one optional block, the same move ADR-0005 made for
`assistant`:

```ts
model?: { default: ModelAlias; allowed: ModelAlias[] }
```

Validated Service-side at save, at freeze, and on **every read**:

- `allowed` holds 1..2 entries, no duplicates, and `default ∈ allowed`;
- `allowed ⊆ { profile.model.default } ∪ { profile.model.fallback }`.

The narrowing-only rule is what makes this need no new authority. A lesson can never
name an alias the compiled profile does not already grant, so the issuer scope gains
no field, the participation token keeps its promise to carry no runtime capability,
and the cohort harness remains the gate on what a profile may name at all.

### 2. The Service enforces it by narrowing the profile, not by changing a clamp

The shared chat gate already returns a rewritten profile (that is how a frozen
lesson's text and its AI name reach the model). It gains one more field in the same
spread:

```ts
{ ...profile, model: { ...profile.model, default: lessonDefault, fallback: lessonSecond } }
```

Because both clamps read `profile.model.default` and `profile.model.fallback`, both
then enforce the lesson's set **with zero edits to either clamp**. A client sending an
arbitrary id, another alias, or another lesson's grant still falls through to the
served default; only the target of that fallthrough moves.

One carve-out is named rather than silently inherited: `/v1/messages` keeps
force-appending `hypeproof-fast`. It is declared an **auxiliary-call channel**, not a
lesson candidate. Removing it would upgrade every CLI auxiliary call to the default
model, which is the cost reason the route states for having it.

### 3. The app is told the seat's set, and reads the turn from headers it already gets

`GET /v1/profile` gains one additive key, shaped like the existing `module` key:

```ts
model: {
  current: { alias: ModelAlias; id: string; label: string },
  allowed: Array<{ alias: ModelAlias; id: string; label: string }>,
  source: "profile" | "lesson"
}
```

`id` is the resolved upstream id. `label` is Service-owned display text, so the app
never composes a model name from an alias. There is deliberately **no `provider`
field**: the id already discloses the vendor and `x-hps-model` has shipped it since
day one, so a separate key adds a policy decision without adding information.

There is deliberately **no "current turn" here**. This block is the *seat's* allowed
set and default. The *turn's* actual model comes from `x-hps-model`, its substitution
flag from `x-hps-fallback`, and its usage from the chunk the client already parses.
The client work is reading two more headers where it already reads `x-request-id`.

**The app compares `id`, never `alias`.** This is not a style preference: on gemini
and openai the default and strong aliases are the same id, and on GLM all three are,
so an alias-keyed display would announce a model change where nothing changed. This
is AE-27's "동일 ID의 다른 alias를 모델 변경으로 오인시키지 않는다", satisfied by the
shape rather than by a rule someone must remember.

## Compatibility

| Pair | Behavior |
|---|---|
| Old frozen lesson (no block) + new Service | The optional key may be absent, exactly as for `assistant`. Served set is the compiled profile's; `source: "profile"`. |
| New lesson (block) + new Service + old App | The unknown `model` key is dropped at the client's cast, like `module`, which the Service has sent unread since it was added. No render, no crash. |
| New Chalk + old Service | `PUT` draft returns `400 invalid session-design fields`; the edit is preserved. **Deploy the Service before Chalk**, as in ADR-0005. |
| Named-model lesson frozen + Service rolled back below this change | Every read re-validates, the old allowlist rejects the block, and every seat delivered from that version gets `409 lesson_unavailable`. This is a **rollback floor** and takes a second row in the table in `worker/DEPLOY.md`. |
| Client sends an out-of-set model string | Unchanged — both clamps already force the served default silently. Only the target moves. |
| Credential with no lesson | Unchanged. |
| `hypeproofChat.model` setting | Untouched. It stays a free-text string; the server clamp is what makes that harmless, and it continues to. |

## Not in this slice, with the reason from the code

- **A student-facing model picker.** The seat's set has to be served and rendered
  before a choice can mean anything. AE-26's fixed/restricted-choice is the instructor
  half; the picker is the next unit.
- **Auto and compare modes (AE-26 P1, AE-30, AE-31).** They need the candidate set,
  the role assignment, the material sent to each branch and a budget ledger settled
  first. None of those exist.
- **A retirement or substitution ladder (AE-33's second half).** The only automatic
  substitution in the codebase is Gemini's, and the module fallback ladder falls back
  on bytes with no capability notion — so nothing today can silently swap a retired id
  for a live one, which is the behavior AE-33 forbids. This slice freezes the *alias
  set*; the id actually served is already recorded per turn.
- **A per-turn "which parameters were clamped" surface (AE-28's second half).** The
  parameter guard already returns exactly that list and logs it, but surfacing it needs
  a response field the Anthropic-shaped stream does not have. Also worth recording:
  that guard runs on `/v1/messages` only, so `/v1/chat/completions` is **not**
  capability-protected today. Wiring it there changes runtime behavior and is out.
- **Per-step or per-student model mapping.** A session-design step is key-exact, so a
  per-step field is a step-schema change rather than an optional add; and a per-student
  model would be the first runtime capability ever carried on a participation token.
- **Moving model policy into the publishable module layer.** That would route around
  the cohort harness, which is the stated reason it is compiled. A replacement gate
  would have to be designed first.
- **Narrowing `hypeproofChat.model` to an enum or machine scope.** It is the one
  turn-affecting setting that is neither machine-scoped nor in the restricted list, but
  changing that is a behavior change on a shipped app and a requirements edit. The
  server clamp already makes the free-text box harmless. Wording is fixed in this PR;
  the scope decision is separate.
- **Adding `x-hps-fallback` to `/v1/messages`.** There is no model substitution on that
  route to report — the Anthropic path documents that it deliberately has none. The
  header would have no producer. Its absence is the truth, not a gap.
- **The three out-of-band model call paths**, named here so they are not mistaken for
  covered: the cron heartbeat and the cron health check each hard-code ids at tiny
  token budgets, and the native-observation assessor resolves the profile's default
  alias against the Anthropic map and calls Anthropic regardless of the profile's
  provider. They are real spend on real ids that no lesson policy governs.

## Verification this slice must carry

- **Service, in the file that already locks lesson policy smuggling:** positive control
  (a lesson narrows to fast; the served default becomes fast on both routes), negative
  controls (a lesson naming an alias outside the profile's two is rejected at save and
  refused at freeze; an already-frozen widening lesson 409s rather than being honoured).
- **The standing `/v1/messages` clamp lock** gains one case: under a lesson-narrowed
  profile the profile's original default is no longer honoured by name, while
  `hypeproof-fast` still is — the auxiliary carve-out survives narrowing.
- **The existing "client cannot override to a non-fallback model" negative control**
  is re-pointed at a lesson-narrowed profile, so it also proves a lesson cannot be
  escaped with an alias string.
- **A control this repo does not have yet:** that the seat's served set and the turn's
  `x-hps-model` agree. The cheapest form is asserting, where the header's presence is
  already checked, that its value is one of the ids the same seat's profile lists.
- **The client-side label resolution** is a pure function and gets the same
  positive/negative control treatment as the coach-identity resolver, including the
  two-aliases-one-id case.
- Every catalogue row inherits the existing pin discipline: dated evidence per row,
  lock-tested. No new discipline is invented.

## Sequencing

`#759` (feature A) is merged, so everything this contract reuses is on `main`: the
profile serializer, the validator's allowlist form, the chat gate's lesson
application, and ADR-0005 itself.

`#765` (feature B) is open and touches ten files under the Studio extension plus one
line in the requirements doc. Implementation notes for the client half must therefore
name **symbols, not line numbers**, in that subtree, and the AE-27 header reading
belongs in the proxy client, which `#765` does not modify. The requirement rows this
audit found stale (the `/v1/messages` force-append, the runtime-selection wording, and
a settings count) are listed as follow-ups rather than edited here, so a live
acceptance run on `#765` is not disturbed.

## Wording corrected alongside this ADR

The audit found documentation that would make the contract unreadable if left standing.
This PR fixes the provider-count and key-requirement drift, and the one operationally
dangerous line: the deploy guide's live secret command sets the Gemini key while the
Anthropic key — which `/v1/messages` always needs — is commented out as optional. None
of these edits change behavior.
