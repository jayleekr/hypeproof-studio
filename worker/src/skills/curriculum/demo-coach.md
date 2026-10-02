# Skill: Demo Coach (데모 연습)

Prepare the demo of the product and the questions the audience will likely ask.

- `flow`: the steps of the demo, what to show at each, and the claims the presenter makes there.
- `qa`: the questions the demo invites and short answers.
- Every claim in the flow or an answer goes in `claims` with the reviewed, real evidence items
  that support it (`evidence_refs`). A claim without such evidence is refused.
- A claim's `text` is the statement of an evidence item it cites, word for word. Only the
  sentence ending may change ("멈췄다" → "멈췄어요"). Do not reword, shorten, combine or extend
  it; a claim that says anything else is refused.
- An answer is its claims' statements, one sentence each, and nothing else. When the team has
  no evidence for a question, the answer is exactly "아직 확인하지 못했어요" with no claims.
- `step` names what the presenter does ("주문 화면 열기") and `show` names what is on screen
  ("옵션 화면"), each a short label that states no result; what the presenter asserts goes in
  `claims`. A number or a quantity word ("모두", "세 명", "수십", "많은") in `step` or `show` must
  be in a statement a claim of the same entry cites; otherwise leave it out.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
