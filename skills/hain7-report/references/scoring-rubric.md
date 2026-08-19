# HAIN7 Studio Signal scoring rubric

Version: `hain7-studio-signal-1.0.0`

Each axis has four markers. Score each marker from observable learner evidence:

- `1`: the complete anchored behavior is clearly visible.
- `0.5`: a partial, vague, or one-off form is visible.
- `0`: the lesson/log shows a reasonable opportunity, but the behavior is not visible.
- `NA`: telemetry is missing or the lesson did not establish a reasonable opportunity.

An axis score is the mean of scorable markers multiplied by 4. Publish it only when at least two markers are scorable. Never replace `NA` with zero. Attach one or more evidence IDs to every 0.5 or 1.

## TA — Taste / 보는 눈

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| TA1 | Quality criteria | Learner states two or more relevant quality criteria or an explicit standard. | One broad adjective such as “재미있게” without an operational detail. |
| TA2 | Alternative comparison | Learner compares at least two options or trade-offs. | Learner rejects/substitutes an option without comparison. |
| TA3 | Reasoned selection | Learner selects/rejects and gives a task-relevant reason. | Choice is visible but reason is absent or generic. |
| TA4 | Criteria applied to final | Final decision/check explicitly returns to earlier criteria. | A final choice is visible, but the criteria link is implicit. |

Child-readable meaning: **더 나은 결과의 기준을 세우고 선택하는 힘.**

## IN — Intent / 의도 세우기

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| IN1 | Goal and audience | Names both what to create and who/what situation it is for. | Names only goal or audience. |
| IN2 | Mechanics/output | Specifies at least two concrete behaviors, mechanics, or output parts. | Gives one concrete behavior/output part. |
| IN3 | Constraints | Specifies at least two boundaries such as time, count, input, safety, or “do not.” | One usable boundary. |
| IN4 | Success condition | Defines a checkable completion/win/success condition. | Uses “완성/잘 되게” without a checkable condition. |

Child-readable meaning: **목표·사용자·성공 조건을 분명하게 만드는 힘.**

## CO — Context / 맥락 주기

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| CO1 | Relevant state/assets | Supplies two or more relevant current-state, file, screen, or asset facts. | Supplies one relevant fact. |
| CO2 | Relevant selection | Distinguishes what should change from what should remain. | Refers to current state but change scope is broad. |
| CO3 | Unneeded/sensitive exclusion | Explicitly excludes unnecessary external access, deletion, personal data, or unrelated scope when relevant. | Mentions a boundary but leaves it ambiguous. |
| CO4 | Context update | Updates context after seeing a result, using the new state accurately. | Says “다시/이제” without a concrete state update. |

Child-readable meaning: **AI가 지금 상황을 제대로 알 수 있게 필요한 정보를 주는 힘.**

## VE — Verify / 확인하기

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| VE1 | Test/preview | Runs or explicitly requests an observable test/preview. | Asks whether it works without a test action. |
| VE2 | Specific defect | Identifies a concrete defect and reproduction condition/location. | Reports only “안 돼/이상해.” |
| VE3 | Recheck after change | Repeats a test after a change and records the result. | Requests a fix but no post-fix check is visible. |
| VE4 | Challenges/independent evidence | Questions an AI claim, asks for cause, or checks with independent evidence. | Generic “확인해줘.” |

Child-readable meaning: **결과를 직접 시험하고 오류를 찾아 다시 확인하는 힘.**

## DE — Delegate / 역할 나누기

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| DE1 | Bounded AI task | Gives AI a clearly bounded task or change area. | Gives a broad creation command. |
| DE2 | Human decision retained | Explicitly keeps a meaningful design/rule/final decision. | Uses first-person preference but delegates the decision. |
| DE3 | Tool/approval boundary | Sets an approval, deletion, external-access, or tool-use boundary when relevant. | Vague “조심해.” |
| DE4 | Stop/reframe | Stops, narrows, or reframes an unsuitable AI direction. | Substitutes an option without defining the new boundary. |

Child-readable meaning: **AI와 내가 맡을 일을 나누고 중요한 결정은 내가 잡는 힘.**

## IT — Iterate / 다시 고치기

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| IT1 | First version | A renderable first artifact/version is visible. | Only a plan or fragment is visible. |
| IT2 | Diagnosed improvement target | Names a concrete flaw or improvement target. | Requests “더 좋게/예쁘게.” |
| IT3 | Controlled change | Changes the target while naming what must stay unchanged. | Requests a change without controlling other conditions. |
| IT4 | Verified improved version | A later artifact version plus post-change test is visible. | A later version exists, but no recheck result is visible. |

Child-readable meaning: **첫 결과에서 문제를 찾아 조건을 지키며 더 나은 버전으로 고치는 힘.**

## OW — Ownership / 내 것으로 만들기

| ID | Marker | 1 anchor | 0.5 anchor |
|---|---|---|---|
| OW1 | Final choice | Learner makes an explicit final decision. | Preference is visible but not finalized. |
| OW2 | Manual adaptation | Learner directly edits, manipulates, or meaningfully adapts the artifact beyond copying AI output. | A manual action exists but its effect is unclear. |
| OW3 | Rationale | Learner explains why the final choice fits the goal/user/criteria. | Gives a generic personal preference. |
| OW4 | Status and responsibility | States final status, remaining issue/trade-off, or next responsibility. | Says only “끝/완료.” |

Child-readable meaning: **AI 결과를 그대로 받지 않고 선택·수정·설명해 내 결과로 만드는 힘.**

## Criterion bands and confidence

Criterion bands describe this session only:

- `3.2–4.0`: 뚜렷하게 관찰됨
- `2.2–3.19`: 성장 중
- `1.2–2.19`: 기초 신호
- `<1.2`: 다음 수업에서 증거 더 보기

Evidence confidence is not reliability:

- `높음`: at least 75% marker coverage, five or more learner turns, and multiple evidence channels including artifact/workflow evidence.
- `보통`: at least 50% marker coverage and a usable interaction trace.
- `낮음`: lower coverage, truncation, or a single evidence channel.

Use confidence to temper language; never inflate a low-confidence score.
