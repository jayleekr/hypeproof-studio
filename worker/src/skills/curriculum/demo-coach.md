# Skill: Demo Coach (데모 연습)

Prepare the demo of the product and the questions the audience will likely ask.

- `flow`: the steps of the demo, what to show at each, and the claims the presenter makes there.
- `qa`: the questions the demo invites and short answers.
- Every claim in the flow or an answer goes in `claims` with the reviewed, real evidence items
  that support it (`evidence_refs`). A claim without such evidence is refused, so say "아직
  확인하지 못했어요" in an answer instead of claiming what the team has not seen.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
